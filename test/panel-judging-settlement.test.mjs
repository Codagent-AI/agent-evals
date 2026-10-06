import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runPanelJob, resolvePanel, verifyCachedPanelJob, PANEL_PROTOCOL } from '../evals/lib/panel-judging/panel.mjs'

const result = (verdict, extra = {}) => ({ id: 'x', verdict, rationale: 'reason', citations: ['a'], evidence: ['a'], ...extra })
const setup = (votes, extra = {}) => ({
  job: 'job', criteria: ['x'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'],
  buildPrompt: () => ({ job: 'job', criteria: ['x'], prompt: 'unchanged context', schema: {} }), schema: {},
  panel: votes.map((verdict, i) => ({ family: i === 0 ? 'claude' : 'codex', model: `m${i}`, effort: 'medium',
    invoke: async () => JSON.stringify({ results: [result(verdict)] }) })),
  decider: { model: 'opus', effort: 'medium', invoke: async () => { throw new Error('unexpected decider') } },
  validateCitations: async () => true, ...extra,
})
for (const verdict of ['pass', 'fail']) test(`unanimous ${verdict} stands and cache reproduces`, async () => {
  const outcome = await runPanelJob(setup([verdict, verdict, verdict]))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.results[0].basis, `consensus-${verdict}`)
  assert.deepEqual(outcome.results[0].votes.map(v => v.family), ['claude', 'codex', 'codex'])
  assert.deepEqual(verifyCachedPanelJob(outcome.record).results, outcome.results)
  assert.throws(() => verifyCachedPanelJob({ ...outcome.record, protocol: 'dual-sample-majority-v4' }))
  assert.throws(() => verifyCachedPanelJob({ ...outcome.record, results: [result('bad')] }))
})
test('Claude-inclusive majority stands when the dissent lacks validated citations', async () => {
  const outcome = await runPanelJob(setup(['fail', 'fail', 'pass'], { validateCitations: async () => false }))
  assert.equal(outcome.results[0].basis, 'majority-fail')
})
for (const classification of ['confirmed', 'contradicted', 'insufficient']) test(`backed dissent ${classification}`, async () => {
  const outcome = await runPanelJob(setup(['fail', 'fail', 'pass'], {
    decider: { model: 'opus', effort: 'medium', invoke: async request => {
      assert.equal(request.usage_phase, 'dissent-check')
      assert.match(request.prompt, /reason/)
      return JSON.stringify({ results: [{ id: 'x', classification, rationale: 'checked reason', evidence: ['a'] }] })
    } },
  }))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.results[0].basis, classification === 'confirmed' ? 'checked-dissent-pass' : 'majority-fail')
  assert.deepEqual(resolvePanel(outcome.record).results, outcome.results)
})
test('Codex-only majority goes to blind decider and invalid rulings retry', async () => {
  let calls = 0
  const outcome = await runPanelJob(setup(['fail', 'pass', 'pass'], {
    decider: { model: 'opus', effort: 'medium', invoke: async request => {
      calls++
      assert.match(request.prompt, /unchanged context/)
      assert.match(request.prompt, /"label":"A"/)
      assert.doesNotMatch(request.prompt, /m0|m1|m2|claude|codex/)
      return JSON.stringify({ results: [result(calls === 1 ? 'other' : 'pass')] })
    } },
  }))
  assert.equal(calls, 2)
  assert.equal(outcome.results[0].basis, 'decider-pass')
})
test('three-way split decider must pick a panel verdict', async () => {
  const outcome = await runPanelJob({ ...setup(['met', 'partial', 'missing']), verdicts: ['met', 'partial', 'missing'], order: ['met', 'partial', 'missing'],
    decider: { model: 'opus', effort: 'high', invoke: async () => JSON.stringify({ results: [result('partial')] }) } })
  assert.equal(outcome.results[0].basis, 'decider-partial')
})
test('panel starts concurrently with identical prompts', async () => {
  let started = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const prompts = []
  const options = setup(['pass', 'pass', 'pass'])
  options.panel = options.panel.map(member => ({ ...member, invoke: async request => {
    prompts.push(request.prompt)
    if (++started === 3) release()
    await barrier
    return JSON.stringify({ results: [result('pass')] })
  } }))
  const outcome = await runPanelJob(options)
  assert.equal(outcome.ok, true)
  assert.equal(started, 3)
  assert.equal(new Set(prompts).size, 1)
})
test('exhausted judge and decider leave job unobserved; schema failure is not retried', async () => {
  const options = setup(['fail', 'pass', 'pass'])
  const failed = await runPanelJob(options)
  assert.equal(failed.ok, false)
  assert.equal(failed.results, null)
  let calls = 0
  options.panel[0].invoke = async () => { calls++; throw Object.assign(new Error('schema'), { retryable: false }) }
  assert.equal((await runPanelJob(options)).ok, false)
  assert.equal(calls, 1)
})

// INT-010: use real neutral files and the existing closed-world/span mechanics.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJudgeJob, SOURCE_JUDGE_RESULT_SCHEMA } from '../evals/lib/panel-judging/protocol.mjs'

async function sourceSetup(t, votes, behavior = {}) {
  const root = await mkdtemp(join(tmpdir(), 'panel-source-'))
  await mkdir(join(root, 'source'))
  await writeFile(join(root, 'source/a'), 'mechanism\nfocused test\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  const request = { schema: SOURCE_JUDGE_RESULT_SCHEMA, job: 'job', criteria: ['x'], prompt: 'unchanged context', prompt_body: 'unchanged context', rubric_slice: 'x requirement and guidance',
    cwd: root, audit_cwd: root, input_roots: { source: join(root, 'source') }, verified_source_paths: ['a'], source_audit: true, panel_line_citations: true,
    requireSourceCitationsFor: behavior.fallback ? ['x'] : [] }
  const seen = []
  const auditResult = classification => JSON.stringify({ results: [{ id: 'x', classification, rationale: 'stated contradiction or missing proof', evidence: ['a'] }] })
  const options = setup(votes, { buildPrompt: () => request, audit: ({ request, invoke }) => runJudgeJob({ request, invoke }),
    decider: { model: 'opus', effort: 'medium', invoke: async next => {
      seen.push(next)
      if (next.audit_stage === 'contradiction-check') return auditResult(behavior.check ?? 'contradicted')
      if (next.audit_stage === 'tiebreak-span-audit') return auditResult(behavior.spanAudit ?? 'confirmed')
      if (next.audit_stage === 'dissent-check') return auditResult(behavior.dissent ?? 'contradicted')
      return JSON.stringify({ results: [result(behavior.deciderVerdict ?? 'pass', { citations: [{ path: 'a', start_line: 1, end_line: behavior.invalidSpan && seen.filter(r => r.judge_stage === 'tiebreak').length === 1 ? 99 : 2 }] })] })
    } } })
  options.panel = options.panel.map((member, i) => ({ ...member, invoke: async next => next.audit_stage
    ? auditResult(behavior.sourceAudit && i === 0 ? behavior.sourceAudit : 'confirmed')
    : JSON.stringify({ results: [result(votes[i], next.line_citations === 'evidence-view' ? { citations: [] } : {})] }) }))
  return { options, seen }
}
for (const check of ['confirmed', 'contradicted', 'insufficient']) test(`source audit contradiction ${check}`, async t => {
  const { options, seen } = await sourceSetup(t, ['pass', 'pass', 'pass'], { sourceAudit: 'contradicted', check })
  const outcome = await runPanelJob(options)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.results[0].basis, check === 'contradicted' ? 'consensus-pass' : 'decider-pass')
  assert.ok(seen.some(r => r.usage_phase === 'contradiction-check'))
  assert.equal(outcome.results[0].checks[0].classification, check)
})
for (const [spanAudit, check, verdict] of [['confirmed', 'confirmed', 'pass'], ['insufficient', 'contradicted', 'pass'], ['contradicted', 'contradicted', 'pass'], ['contradicted', 'confirmed', 'fail']]) test(`decider span audit ${spanAudit}, check ${check}`, async t => {
  const { options, seen } = await sourceSetup(t, ['fail', 'pass', 'pass'], { spanAudit, check })
  const outcome = await runPanelJob(options)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.results[0].basis, `decider-${verdict}`)
  assert.ok(seen.some(r => r.usage_phase === 'span-audit'))
  assert.equal(seen.filter(r => r.usage_phase === 'decider-recite').length, spanAudit === 'insufficient' ? 1 : 0)
  assert.deepEqual(verifyCachedPanelJob(outcome.record).results, outcome.results)
})
test('unconfirmed browser fallback decider pass fails', async t => {
  const { options } = await sourceSetup(t, ['fail', 'pass', 'pass'], { spanAudit: 'insufficient', fallback: true })
  const outcome = await runPanelJob(options)
  assert.equal(outcome.results[0].basis, 'decider-fail')
})
test('invalid spans retry before auditing', async t => {
  const { options, seen } = await sourceSetup(t, ['fail', 'pass', 'pass'], { invalidSpan: true })
  const outcome = await runPanelJob(options)
  assert.equal(outcome.ok, true)
  assert.equal(seen.filter(r => r.usage_phase === 'decider').length, 2)
})
test('source audit insufficient gets exactly one re-cite and keeps its vote', async t => {
  const { options } = await sourceSetup(t, ['pass', 'pass', 'pass'], { sourceAudit: 'insufficient' })
  const outcome = await runPanelJob(options)
  assert.equal(outcome.results[0].basis, 'consensus-pass')
  assert.equal(outcome.record.samples[0].attempts.length, 2)
  assert.equal(outcome.record.samples[0].audit_attempts.length, 2)
})

test('cache rejects a saved audited ruling that disagrees with its recorded contradiction check', async t => {
  const { options } = await sourceSetup(t, ['fail', 'pass', 'pass'], { spanAudit: 'contradicted', check: 'confirmed' })
  const outcome = await runPanelJob(options)
  const tampered = structuredClone(outcome.record)
  tampered.decider.contradiction_checks[0].classification = 'contradicted'
  assert.throws(() => verifyCachedPanelJob(tampered), /does not reproduce/)
})

test('evidence decider receives line-numbered files inlined without a tools instruction', async t => {
  const { options, seen } = await sourceSetup(t, ['fail', 'pass', 'pass'])
  const build = options.buildPrompt
  options.buildPrompt = () => {
    const request = build()
    return { ...request, source_audit: false, line_citations: 'evidence-view', input_roots: { evidence: request.input_roots.source } }
  }
  const outcome = await runPanelJob(options)
  assert.equal(outcome.ok, true)
  const request = seen.find(r => r.usage_phase === 'decider')
  assert.match(request.prompt, /LINE-NUMBERED UNTRUSTED EVIDENCE/)
  assert.match(request.prompt, /"line":1,"text":"mechanism"/)
  assert.match(request.prompt, /do not use tools/)
  assert.doesNotMatch(request.prompt, /You may read/)
})


test('a confirmed source contradiction supplies a turned fail vote the decider may choose', async t => {
  const { options, seen } = await sourceSetup(t, ['pass', 'pass', 'pass'], {
    sourceAudit: 'contradicted', check: 'confirmed', deciderVerdict: 'fail',
  })
  const outcome = await runPanelJob(options)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.results[0].basis, 'decider-fail')
  assert.match(seen.find(request => request.usage_phase === 'decider').prompt, /"verdict":"fail"/)
})

for (const stage of ['panel', 'audited-panel', 'decider', 'span-audit']) test(`quota metadata survives ${stage} failure`, async t => {
  const error = Object.assign(new Error('subscription quota stopped'), { code: 'claude-quota', resumable: true, retryable: false, owner: 'evaluation-harness' })
  const { options } = await sourceSetup(t, ['fail', 'pass', 'pass'])
  if (stage === 'panel') { options.audit = null; options.panel[0].invoke = async () => { throw error } }
  if (stage === 'audited-panel') options.panel[0].invoke = async () => { throw error }
  if (stage === 'decider') options.decider.invoke = async () => { throw error }
  if (stage === 'span-audit') {
    const invoke = options.decider.invoke
    options.decider.invoke = async request => { if (request.audit_stage) throw error; return invoke(request) }
  }
  const outcome = await runPanelJob(options)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failure.code, 'claude-quota')
  assert.equal(outcome.failure.resumable, true)
  assert.equal(outcome.record.failure.owner, 'evaluation-harness')
  assert.match(outcome.failure.message, /subscription quota stopped/)
})
