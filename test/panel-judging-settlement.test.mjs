import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runPanelJob, rerunDecider, resolvePanel, verifyCachedPanelJob, PANEL_PROTOCOL } from '../evals/lib/panel-judging/panel.mjs'
import { REQUIREMENT_QUESTION_RULE, JUDGE_SCOPE_RULE, buildReciteRequest } from '../evals/lib/panel-judging/protocol.mjs'

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
      // The check asks whether the requirement depends on the fact, not only whether it is accurate.
      assert.ok(request.prompt.includes(REQUIREMENT_QUESTION_RULE))
      assert.match(request.prompt, /Confirm only when both hold/)
      assert.match(request.prompt, /the fact is accurate but the requirement does not depend on it/)
      assert.match(request.prompt, /For a lower verdict, it must show a clause of the requirement unmet; for a higher verdict, every clause the verdict credits met/)
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

test('a failed panel seat reports its own error, not one another seat recovered from', async () => {
  const outcome = await runPanelJob(setup(['pass', 'pass', 'pass'], {
    audit: async ({ request }) => request.judge_sample === 1
      ? { ok: false, results: null, attempts: [{ cycle: 1, attempt: 1, ok: true, error: null }], audit_attempts: [{ cycle: 1, attempt: 1, ok: false, error: 'workspace missing' }] }
      : { ok: true, results: [result('pass')], attempts: [{ cycle: 1, attempt: 1, ok: true, error: null }], audit_attempts: [{ cycle: 1, attempt: 1, ok: false, error: 'recovered on re-cite' }, { cycle: 2, attempt: 1, ok: true, error: null }] },
  }))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failure.message, 'workspace missing')
})

// INT-010: use real neutral files and the existing closed-world/span mechanics.
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJudgeJob, SOURCE_JUDGE_RESULT_SCHEMA } from '../evals/lib/panel-judging/protocol.mjs'

async function sourceSetup(t, votes, behavior = {}) {
  const root = await makeTempDir(join(tmpdir(), 'panel-source-'))
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
  // v2: a check that refutes or cannot decide leaves the vote standing; only a
  // confirmed one turns it and sends the split to the decider.
  assert.equal(outcome.results[0].basis, check === 'confirmed' ? 'decider-pass' : 'consensus-pass')
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
  assert.match(request.prompt, /"a\\n1\|mechanism\\n2\|focused test/)
  assert.match(request.prompt, /do not use tools/)
  assert.doesNotMatch(request.prompt, /You may read/)
})


test('an evidence decider inlines only the packet the panel saw, not other view files', async t => {
  const { MAX_AUDIT_PACKET_CHARS } = await import('../evals/lib/panel-judging/protocol.mjs')
  const { options, seen } = await sourceSetup(t, ['fail', 'pass', 'pass'])
  const build = options.buildPrompt
  const view = join((build()).cwd, 'view')
  await mkdir(join(view, 'candidate'), { recursive: true })
  await writeFile(join(view, 'packet.txt'), 'mechanism\nfocused test\n')
  // Screenshots and raw candidate files sit beside the packet in the view.
  await writeFile(join(view, 'candidate/step-01.png'), 'x'.repeat(MAX_AUDIT_PACKET_CHARS + 1))
  await writeFile(join(view, 'index.json'), '{"secret":"not in the packet"}')
  options.buildPrompt = () => ({ ...build(), source_audit: false, line_citations: 'evidence-view', input_roots: { evidence: view } })
  const decide = options.decider.invoke
  options.decider.invoke = async next => next.judge_stage === 'tiebreak'
    ? (seen.push(next), JSON.stringify({ results: [{ id: 'x', verdict: 'pass', rationale: 'packet proves it', evidence: ['packet'], citations: [{ path: 'packet.txt', start_line: 1, end_line: 2 }] }] }))
    : decide(next)
  const outcome = await runPanelJob(options)
  assert.equal(outcome.ok, true, outcome.record.error)
  const request = seen.find(r => r.judge_stage === 'tiebreak')
  assert.match(request.prompt, /"packet\.txt\\n1\|mechanism/)
  assert.doesNotMatch(request.prompt, /step-01\.png|not in the packet/)
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

const dissentCheck = (classification, seen = []) => ({ model: 'opus', effort: 'medium', invoke: async request => {
  seen.push(request)
  if (request.audit_stage !== 'dissent-check') throw new Error('unexpected decider')
  return JSON.stringify({ results: [{ id: 'x', classification, rationale: 'checked reason', evidence: ['a'] }] })
} })
const citedDissent = (options, citations) => {
  options.panel[2].invoke = async () => JSON.stringify({ results: [result('pass', { citations })] })
  return options
}
const rejectBad = async r => {
  for (const c of r.citations) if (c === 'bad') throw new Error(`source citation is outside the verified inventory: ${c}`)
  return r.citations.length > 0
}

test('an invalid dissent citation is dropped and the remaining valid citation backs the dissent', async () => {
  const seen = []
  const outcome = await runPanelJob(citedDissent(setup(['fail', 'fail', 'pass'], { decider: dissentCheck('confirmed', seen), validateCitations: rejectBad }), ['a', 'bad']))
  assert.equal(outcome.ok, true)
  assert.equal(outcome.results[0].basis, 'checked-dissent-pass')
  assert.deepEqual(outcome.results[0].citations, ['a'])
  const dissent = outcome.record.votes.find(v => v.panel_index === 2)
  assert.equal(dissent.citations_valid, true)
  assert.deepEqual(dissent.dropped_citations, [{ citation: 'bad', reason: 'source citation is outside the verified inventory: bad' }])
  assert.equal(seen.length, 1)
  assert.ok(!seen[0].prompt.includes('"bad"'))
  assert.deepEqual(verifyCachedPanelJob(outcome.record).results, outcome.results)
})

test('a dissent whose every citation is invalid is not backed', async () => {
  const seen = []
  const outcome = await runPanelJob(citedDissent(setup(['fail', 'fail', 'pass'], { decider: dissentCheck('confirmed', seen), validateCitations: rejectBad }), ['bad']))
  assert.equal(outcome.results[0].basis, 'majority-fail')
  assert.equal(seen.length, 0)
  const dissent = outcome.record.votes.find(v => v.panel_index === 2)
  assert.equal(dissent.citations_valid, false)
  assert.equal(dissent.dropped_citations.length, 1)
})

test('a suite per-citation validator decides drops and the kept set must still meet the required kind', async () => {
  const kinds = { span: 'span', file: 'file', bad: null }
  const validateCitation = async c => kinds[c] ?? (() => { throw new Error('citation does not resolve to a collected file') })()
  // Whole-result rule: a higher verdict needs a span.
  const validateCitations = async r => { for (const c of r.citations) await validateCitation(c); if (!r.citations.includes('span')) throw new Error('met/partial must cite an artifact line range'); return true }
  const backed = await runPanelJob(citedDissent(setup(['fail', 'fail', 'pass'], { decider: dissentCheck('confirmed'), validateCitations, validateCitation }), ['file', 'span', 'bad']))
  assert.equal(backed.results[0].basis, 'checked-dissent-pass')
  const vote = backed.record.votes.find(v => v.panel_index === 2)
  assert.deepEqual(vote.citations, ['file', 'span'])
  assert.deepEqual(vote.dropped_citations.map(d => d.citation), ['bad'])
  const unbacked = await runPanelJob(citedDissent(setup(['fail', 'fail', 'pass'], { decider: dissentCheck('confirmed'), validateCitations, validateCitation }), ['file', 'bad']))
  assert.equal(unbacked.results[0].basis, 'majority-fail')
  assert.equal(unbacked.record.votes.find(v => v.panel_index === 2).citations_valid, false)
})

test('a suite scope rule replaces the shared one in the dissent check and decider prompts', async () => {
  const seen = []
  const scoped = setup(['missing', 'missing', 'met'], { verdicts: ['met', 'partial', 'missing'], order: ['met', 'partial', 'missing'],
    buildPrompt: () => ({ prompt: 'definition context', prompt_body: 'definition context', scope_rule: 'DEFINITION RULE' }), decider: dissentCheck('contradicted', seen) })
  scoped.panel = scoped.panel.map((member, i) => ({ ...member, invoke: async () => JSON.stringify({ results: [result(['missing', 'missing', 'met'][i])] }) }))
  const outcome = await runPanelJob(scoped)
  assert.equal(outcome.results[0].basis, 'majority-missing')
  assert.match(seen[0].prompt, /DEFINITION RULE/)
  assert.ok(!seen[0].prompt.includes(JUDGE_SCOPE_RULE))
  const decided = []
  const split = setup(['met', 'partial', 'missing'], { verdicts: ['met', 'partial', 'missing'], order: ['met', 'partial', 'missing'],
    buildPrompt: () => ({ prompt: 'definition context', prompt_body: 'definition context', scope_rule: 'DEFINITION RULE' }),
    decider: { model: 'opus', effort: 'high', invoke: async request => { decided.push(request); return JSON.stringify({ results: [result('partial')] }) } } })
  split.panel = split.panel.map((member, i) => ({ ...member, invoke: async () => JSON.stringify({ results: [result(['met', 'partial', 'missing'][i])] }) }))
  await runPanelJob(split)
  assert.match(decided[0].prompt, /DEFINITION RULE/)
  const shared = []
  await runPanelJob(setup(['fail', 'pass', 'pass'], { decider: { model: 'opus', effort: 'medium', invoke: async request => { shared.push(request); return JSON.stringify({ results: [result('pass')] }) } } }))
  assert.ok(shared[0].prompt.includes(REQUIREMENT_QUESTION_RULE))
})

const disputedVotes = (verdicts, disputedIndex) => verdicts.map((verdict, i) => ({ ...result(verdict), family: i === 0 ? 'claude' : 'codex', panel_index: i,
  ...(i === disputedIndex ? { disputed: true, contradiction: { rationale: 'stated contradiction', evidence: ['a'] } } : {}) }))
const confirmedCheck = index => [{ id: 'x', stage: 'contradiction-check', panel_index: index, classification: 'confirmed', rationale: 'r', evidence: ['a'] }]

test('a confirmed contradiction turns a vote to the opposite end of the job scale', () => {
  const twoWay = resolvePanel({ criteria: ['x'], order: ['pass', 'fail'], votes: disputedVotes(['pass', 'fail', 'fail'], 0), checks: confirmedCheck(0) })
  assert.equal(twoWay.results[0].basis, 'consensus-fail')
  const threeWay = resolvePanel({ criteria: ['x'], order: ['met', 'partial', 'missing'], votes: disputedVotes(['met', 'missing', 'missing'], 0), checks: confirmedCheck(0) })
  assert.equal(threeWay.results[0].basis, 'consensus-missing')
  assert.throws(() => resolvePanel({ criteria: ['x'], order: ['met', 'partial', 'missing'], votes: disputedVotes(['partial', 'missing', 'missing'], 0), checks: confirmedCheck(0) }),
    /contradiction of the middle verdict partial names no corrected verdict/)
})

// v2: a re-cite may replace citations only, and its prompt never invites a verdict change.
test('re-cite asks for the same verdict with better citations', () => {
  const recite = buildReciteRequest({ tiebreakRequest: { job: 'job', prompt_body: 'context' }, claims: [{ id: 'x', verdict: 'pass', audit: { rationale: 'missing clause' } }] })
  assert.match(recite.prompt, /return the same verdict you\ngave/)
  assert.match(recite.prompt, /Only the citations may change/)
  assert.match(recite.prompt, /- x \(your verdict: pass\): missing clause/)
  assert.doesNotMatch(recite.prompt, /change your verdict/)
})

test('definition judging uses a definition scope rule and requirement question, not the implementation scope rule', async () => {
  const { DEFINITION_SCOPE_RULE, jobPrompt, runDefinitionPanel } = await import('../evals/agent-runner/and-scene-define/lib/judge-jobs.mjs')
  assert.ok(!DEFINITION_SCOPE_RULE.includes(JUDGE_SCOPE_RULE))
  assert.doesNotMatch(DEFINITION_SCOPE_RULE, /file deletion|rendering the candidate/)
  assert.match(DEFINITION_SCOPE_RULE, /Judge only what the cited artifacts establish/)
  assert.match(DEFINITION_SCOPE_RULE, /An accurate observation or citation decides nothing by itself/)
  assert.match(DEFINITION_SCOPE_RULE, /must name the part of the item the artifacts do not commit to/)
  const job = { name: 'coverage:a', kind: 'coverage', criteria: ['i1'],
    inputs: { artifacts: { 'spec.md': 'one\ntwo' }, gates: [], items: [{ id: 'i1', statement: 's' }] } }
  assert.ok(jobPrompt(job).startsWith(DEFINITION_SCOPE_RULE))
  const cite = (start, end) => ({ path: 'spec.md', start_line: start, end_line: end, gate: null, exchange: null })
  const vote = (verdict, citations) => JSON.stringify({ results: [{ id: 'i1', verdict, rationale: 'r', evidence: ['e'], citations, subject_id: null, added_scope: [] }] })
  const seen = []
  const outcome = await runDefinitionPanel({ job,
    panel: [['claude', vote('missing', [cite(null, null)])], ['codex', vote('missing', [cite(null, null)])], ['codex', vote('met', [cite(1, 2)])]]
      .map(([family, text], i) => ({ family, model: `m${i}`, effort: 'medium', invoke: async () => text })),
    decider: { family: 'claude', model: 'opus', effort: 'high', invoke: async request => {
      seen.push(request)
      return JSON.stringify({ results: [{ id: 'i1', classification: 'contradicted', rationale: 'checked', evidence: ['e'] }] })
    } } })
  assert.equal(outcome.results[0].basis, 'majority-missing')
  assert.equal(seen[0].audit_stage, 'dissent-check')
  assert.ok(!seen[0].prompt.includes(JUDGE_SCOPE_RULE))
  assert.ok(!seen[0].prompt.includes(REQUIREMENT_QUESTION_RULE))
})
// A real decider answers every criterion its schema and prompt ask for, so the
// batched decider must be scoped to the disputed criteria, not the whole job.
const scopedSchema = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string' } } } } } }
const schemaFollowingDecider = seen => ({ model: 'opus', effort: 'medium', invoke: async request => {
  seen.push(request)
  const ids = request.schema.properties.results.items.properties.id.enum ?? ['x', 'y']
  return JSON.stringify({ results: ids.map(id => result('pass', { id })) })
} })
const partlyDisputed = (extra = {}) => ({ ...setup([], extra), criteria: ['x', 'y'], schema: scopedSchema,
  buildPrompt: () => ({ prompt: 'unchanged context', prompt_body: 'unchanged context' }),
  panel: ['fail', 'pass', 'pass'].map((verdict, i) => ({ family: i === 0 ? 'claude' : 'codex', model: `m${i}`, effort: 'medium',
    invoke: async () => JSON.stringify({ results: [result(verdict), result('pass', { id: 'y' })] }) })), ...extra })
test('a batched decider rules only on the disputed criteria of a partly disputed job', async () => {
  const seen = []
  const outcome = await runPanelJob(partlyDisputed({ decider: schemaFollowingDecider(seen) }))
  assert.equal(outcome.ok, true, outcome.record.error)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].criteria, ['x'])
  assert.deepEqual(seen[0].schema.properties.results.items.properties.id.enum, ['x'])
  assert.match(seen[0].prompt, /Return results for exactly these criterion IDs and no others: x$/m)
  assert.deepEqual(outcome.results.map(r => [r.id, r.basis]), [['x', 'decider-pass'], ['y', 'consensus-pass']])
  const reseen = []
  const rerun = await rerunDecider({ record: outcome.record, decider: schemaFollowingDecider(reseen), buildPrompt: partlyDisputed().buildPrompt, schema: scopedSchema, validateCitations: async () => true })
  assert.deepEqual(rerun.rulings, [{ id: 'x', recorded: 'pass', rerun: 'pass', flipped: false }])
  assert.equal(reseen[0].prompt, seen[0].prompt)
  assert.deepEqual(reseen[0].schema, seen[0].schema)
})
