// INT-001 packet cases: compact serialization, batching by whole claim, and
// the non-retryable packet-overflow failure. No criterion is ever settled on
// material the harness silently omitted.
import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runPanelJob, verifyCachedPanelJob, judgeFailure } from '../evals/lib/panel-judging/panel.mjs'
import {
  MAX_AUDIT_PACKET_CHARS, PacketOverflowError, SOURCE_JUDGE_RESULT_SCHEMA,
  batchClaims, buildContradictionCheckRequest, buildSourceAuditRequest, buildSpanAuditRequest,
  buildTiebreakRequest, inventoryListing, lineCitationInventory, runJudgeJob,
} from '../evals/lib/panel-judging/protocol.mjs'

const LIMIT = MAX_AUDIT_PACKET_CHARS

async function tree(files) {
  const root = await makeTempDir(join(tmpdir(), 'panel-packets-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, 'source', path, '..'), { recursive: true })
    await writeFile(join(root, 'source', path), text)
  }
  return root
}

const sourceRequest = (root, criteria, extra = {}) => ({
  schema: SOURCE_JUDGE_RESULT_SCHEMA, job: 'job', criteria, prompt: 'unchanged context', prompt_body: 'unchanged context',
  rubric_slice: criteria.map(id => `- ${id} requirement`).join('\n'), cwd: root, audit_cwd: root,
  input_roots: { source: join(root, 'source') }, verified_source_paths: [], source_audit: true, ...extra,
})
const vote = (id, verdict, extra = {}) => ({ id, verdict, rationale: `${id} reason`, evidence: [id], citations: ['a'], ...extra })
const audited = (criteria, classification = 'confirmed') => JSON.stringify({ results: criteria.map(id => ({ id, classification,
  rationale: `${id} audit`, evidence: [id] })) })
const panel = (byVerdict) => byVerdict.map((verdict, i) => ({ family: i === 0 ? 'claude' : 'codex', model: `m${i}`, effort: 'medium', verdict }))
// The packet section a request carries between its BEGIN and END markers.
const section = (prompt, name) => prompt.split(`# BEGIN ${name}\n`)[1].split(`\n# END ${name}`)[0]

test('batchClaims packs whole claims greedily in their given order', () => {
  const claims = [{ id: 'a', size: 40 }, { id: 'b', size: 40 }, { id: 'c', size: 40 }, { id: 'd', size: 10 }]
  const render = batch => 's'.repeat(10) + batch.map(({ size }) => 'x'.repeat(size)).join('')
  const batches = batchClaims(claims, render, 100)
  assert.deepEqual(batches.map(({ index, criteria }) => ({ index, criteria })),
    [{ index: 0, criteria: ['a', 'b'] }, { index: 1, criteria: ['c', 'd'] }])
  assert.deepEqual(batches[1].claims, [claims[2], claims[3]])
  assert.equal(batches[0].packet, render(claims.slice(0, 2)))
  // The same input always packs the same way.
  assert.deepEqual(batchClaims(claims, render, 100).map(({ criteria }) => criteria), batches.map(({ criteria }) => criteria))
  assert.deepEqual(batchClaims([], render, 100), [])
})

test('batchClaims names a claim too large to fit alone, and every criterion when shared material cannot fit', () => {
  const render = shared => batch => 's'.repeat(shared) + batch.map(({ size }) => 'x'.repeat(size)).join('')
  const claims = [{ id: 'a', size: 40 }, { id: 'big', size: 95 }, { id: 'c', size: 40 }]
  assert.throws(() => batchClaims(claims, render(10), 100), (error) => {
    assert.ok(error instanceof PacketOverflowError)
    assert.equal(error.code, 'packet-overflow')
    assert.equal(error.owner, 'evaluation-harness')
    assert.equal(error.resumable, false)
    assert.equal(error.retryable, false)
    assert.deepEqual(error.criteria, ['big'])
    return true
  })
  // Shared material that cannot fit even beside one claim names them all.
  assert.throws(() => batchClaims(claims.filter(({ id }) => id !== 'big'), render(70), 100),
    (error) => error instanceof PacketOverflowError && error.criteria.join() === 'a,c')
  assert.throws(() => batchClaims([{ id: 'a', size: 1 }, { id: 'c', size: 1 }], render(101), 100),
    (error) => error instanceof PacketOverflowError && error.criteria.join() === 'a,c' && /shared/.test(error.message))
  // The failure keeps its criteria when recorded.
  const failure = judgeFailure(new PacketOverflowError('overflow', ['a']))
  assert.deepEqual(failure, { message: 'overflow', code: 'packet-overflow', resumable: false, retryable: false,
    owner: 'evaluation-harness', criteria: ['a'] })
})

test('audit, check and decider packets are compact and quote evidence as numbered lines', async () => {
  const root = await tree({ a: 'mechanism\nfocused test\n' })
  const request = sourceRequest(root, ['x'])
  const spans = new Map([['x', [{ path: 'a', start_line: 1, end_line: 2,
    lines: [{ line: 1, text: 'mechanism' }, { line: 2, text: 'focused test' }] }]]])
  const span = buildSpanAuditRequest({ request, passes: [{ id: 'x', rationale: 'reason' }], spans })
  const claims = section(span.prompt, 'LINE-CITED CLAIMS')
  assert.equal(claims, JSON.stringify(JSON.parse(claims)))
  // v2 claims name their audit direction; a claim without a verdict is a pass.
  assert.deepEqual(JSON.parse(claims), [{ id: 'x', claim: 'pass', rationale: 'reason', quoted_spans: ['a:1-2\n1|mechanism\n2|focused test'] }])

  const check = buildContradictionCheckRequest({ request, claims: [{ id: 'x', verdict: 'pass', rationale: 'reason',
    contradiction: { rationale: 'c', evidence: ['e'] }, material: spans.get('x') }] })
  const stated = section(check.prompt, 'STATED CONTRADICTIONS')
  assert.equal(stated, JSON.stringify(JSON.parse(stated)))
  assert.deepEqual(JSON.parse(stated)[0].material, ['a:1-2\n1|mechanism\n2|focused test'])

  const audit = await buildSourceAuditRequest({ request, primaryResults: [vote('x', 'pass')] })
  for (const name of ['PRIMARY CLAIMS', 'CLOSED-WORLD SOURCE PACKET']) {
    const packet = section(audit.prompt, name)
    assert.equal(packet, JSON.stringify(JSON.parse(packet)), name)
  }
})

test('an evidence decider inlines each file as one string of numbered lines', async () => {
  const root = await makeTempDir(join(tmpdir(), 'panel-packets-view-'))
  await writeFile(join(root, 'packet.txt'), 'first line\nsecond line')
  const seen = []
  const request = { job: 'job', criteria: ['x'], prompt: 'context', prompt_body: 'context', schema: {},
    line_citations: 'evidence-view', panel_line_citations: true, input_roots: { evidence: root } }
  await runPanelJob({ job: 'job', criteria: ['x'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => request, validateCitations: async () => true,
    panel: panel(['fail', 'pass', 'pass']).map(member => ({ ...member, invoke: async () => JSON.stringify({ results: [vote('x', member.verdict, { citations: [] })] }) })),
    decider: { model: 'opus', effort: 'medium', invoke: async next => {
      seen.push(next)
      if (next.audit_stage) return audited(next.criteria)
      return JSON.stringify({ results: [vote('x', 'pass', { citations: [{ path: 'packet.txt', start_line: 1, end_line: 2 }] })] })
    } } })
  const decider = seen.find(next => next.judge_stage === 'tiebreak')
  const evidence = section(decider.prompt, 'LINE-NUMBERED UNTRUSTED EVIDENCE')
  assert.deepEqual(JSON.parse(evidence), ['packet.txt\n1|first line\n2|second line'])
})

test('a seat source audit too large in total runs in batches of whole criteria and the job is not failed', async () => {
  const size = Math.ceil(LIMIT * 0.6)
  const root = await tree({ a: 'A'.repeat(size), b: 'B'.repeat(size) })
  const audits = []
  const outcome = await runJudgeJob({ request: sourceRequest(root, ['x', 'y']), invoke: async next => {
    if (next.audit_stage === 'source-pass-audit') {
      audits.push(next)
      return audited(next.criteria)
    }
    return JSON.stringify({ results: [vote('x', 'pass', { citations: ['a'] }), vote('y', 'fail', { citations: ['b'] })] })
  } })
  assert.equal(outcome.ok, true)
  assert.deepEqual(audits.map(next => next.criteria), [['x'], ['y']])
  assert.ok(audits[0].prompt.includes('A'.repeat(size)) && !audits[0].prompt.includes('BBBB'))
  assert.ok(audits[1].prompt.includes('B'.repeat(size)) && !audits[1].prompt.includes('AAAA'))
  assert.deepEqual(outcome.results.map(({ id, verdict }) => [id, verdict]), [['x', 'pass'], ['y', 'fail']])
  assert.deepEqual(outcome.audit_results.map(({ id }) => id), ['x', 'y'])
  assert.deepEqual(outcome.audit_attempts.map(({ batch }) => batch), [0, 1])
})

test('a single claim too large for an audit fails the job, non-retryable, naming its criterion', async () => {
  const root = await tree({ a: 'small\n', huge: 'H'.repeat(LIMIT + 1) })
  let primary = 0
  let audits = 0
  const outcome = await runJudgeJob({ request: sourceRequest(root, ['x', 'y']), invoke: async next => {
    if (next.audit_stage) { audits++; return audited(next.criteria) }
    primary++
    return JSON.stringify({ results: [vote('x', 'pass', { citations: ['huge'] }), vote('y', 'pass', { citations: ['a'] })] })
  } })
  assert.equal(outcome.ok, false)
  assert.equal(primary, 1, 'no retry attempt is spent on an overflow')
  assert.equal(audits, 0, 'no criterion is audited, so none is settled insufficient')
  assert.equal(outcome.failure.code, 'packet-overflow')
  assert.deepEqual(outcome.failure.criteria, ['x'])

  // Through the panel, the job's failure names the criterion as a harness failure.
  let deciderCalls = 0
  const job = await runPanelJob({ job: 'job', criteria: ['x', 'y'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => sourceRequest(root, ['x', 'y']), audit: ({ request, invoke }) => runJudgeJob({ request, invoke }),
    panel: panel(['pass', 'pass', 'pass']).map(member => ({ ...member, invoke: async next => next.audit_stage ? audited(next.criteria)
      : JSON.stringify({ results: [vote('x', 'pass', { citations: ['huge'] }), vote('y', 'pass', { citations: ['a'] })] }) })),
    decider: { model: 'opus', effort: 'medium', invoke: async () => { deciderCalls++; throw new Error('unexpected decider') } } })
  assert.equal(job.ok, false)
  assert.equal(job.results, null)
  assert.equal(deciderCalls, 0)
  assert.equal(job.failure.code, 'packet-overflow')
  assert.equal(job.failure.owner, 'evaluation-harness')
  assert.equal(job.failure.resumable, false)
  assert.deepEqual(job.failure.criteria, ['x'])
  assert.throws(() => verifyCachedPanelJob(job.record))
})

// Decider votes for x and y, each about 120,000 characters across three seats,
// beside a shared 100,000-character evidence packet: together they exceed the
// limit, while each criterion fits beside the shared evidence.
test('a decider request too large in total runs in batches of whole criteria and records one decision', async () => {
  const root = await makeTempDir(join(tmpdir(), 'panel-packets-view-'))
  const evidenceText = Array.from({ length: 1000 }, (_, i) => `evidence line ${i} `.padEnd(100, 'e')).join('\n')
  await writeFile(join(root, 'packet.txt'), evidenceText)
  const request = { job: 'job', criteria: ['x', 'y'], prompt: 'context', prompt_body: 'context', schema: {},
    line_citations: 'evidence-view', panel_line_citations: true, input_roots: { evidence: root } }
  const seen = []
  const rationale = id => id.toUpperCase().repeat(40_000)
  const outcome = await runPanelJob({ job: 'job', criteria: ['x', 'y'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => request, validateCitations: async () => true,
    panel: panel(['fail', 'pass', 'pass']).map(member => ({ ...member, invoke: async () => JSON.stringify({ results: ['x', 'y']
      .map(id => vote(id, member.verdict, { rationale: rationale(id), citations: [] })) }) })),
    decider: { model: 'opus', effort: 'medium', invoke: async next => {
      seen.push(next)
      if (next.audit_stage) return audited(next.criteria)
      return JSON.stringify({ results: next.criteria.map(id => vote(id, 'pass', { citations: [{ path: 'packet.txt', start_line: 1, end_line: 2 }] })) })
    } } })
  assert.equal(outcome.ok, true, outcome.record.error)
  const deciders = seen.filter(next => next.judge_stage === 'tiebreak')
  assert.deepEqual(deciders.map(next => next.criteria), [['x'], ['y']])
  for (const [index, next] of deciders.entries()) {
    // Every batch repeats the shared evidence and carries only its own votes.
    assert.ok(next.prompt.includes('1|evidence line 0 '), `batch ${index} lacks the shared evidence`)
    assert.ok(next.prompt.includes(rationale(next.criteria[0])))
    assert.ok(!next.prompt.includes(rationale(index === 0 ? 'y' : 'x').slice(0, 1000)))
  }
  const decider = outcome.record.decider
  assert.deepEqual(decider.criteria, ['x', 'y'])
  assert.deepEqual(decider.results.map(({ id }) => id), ['x', 'y'])
  assert.deepEqual(decider.decisions.map(({ id, vote }) => [id, vote]), [['x', 'pass'], ['y', 'pass']])
  assert.deepEqual(decider.attempts.filter(({ stage }) => stage === 'tiebreak').map(({ batch }) => batch), [0, 1])
  assert.deepEqual(outcome.results.map(({ basis }) => basis), ['decider-pass', 'decider-pass'])
  assert.deepEqual(verifyCachedPanelJob(outcome.record).results, outcome.results)
})

test('shared decider evidence too large to fit fails the job naming every pending criterion', async () => {
  const root = await makeTempDir(join(tmpdir(), 'panel-packets-view-'))
  await writeFile(join(root, 'packet.txt'), 'E'.repeat(LIMIT + 1))
  const request = { job: 'job', criteria: ['x', 'y', 'z'], prompt: 'context', prompt_body: 'context', schema: {},
    line_citations: 'evidence-view', panel_line_citations: true, input_roots: { evidence: root } }
  const seen = []
  const outcome = await runPanelJob({ job: 'job', criteria: ['x', 'y', 'z'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => request, validateCitations: async () => true,
    // z is unanimous, so only x and y are pending for the decider.
    panel: panel(['fail', 'pass', 'pass']).map(member => ({ ...member, invoke: async () => JSON.stringify({ results: [
      vote('x', member.verdict, { citations: [] }), vote('y', member.verdict, { citations: [] }), vote('z', 'pass', { citations: [] })] }) })),
    decider: { model: 'opus', effort: 'medium', invoke: async next => { seen.push(next); throw new Error('unexpected decider') } } })
  assert.equal(outcome.ok, false)
  assert.equal(seen.length, 0)
  assert.equal(outcome.failure.code, 'packet-overflow')
  assert.equal(outcome.failure.resumable, false)
  assert.equal(outcome.failure.retryable, false)
  assert.equal(outcome.failure.owner, 'evaluation-harness')
  assert.deepEqual(outcome.failure.criteria, ['x', 'y'])
})

test('decider passes whose quoted lines are too large together are span-audited in batches', async () => {
  const lines = Array.from({ length: 199 }, (_, i) => `${i}`.padEnd(1000, 'q')).join('\n')
  const root = await tree({ a: lines, b: lines.replaceAll('q', 'r') })
  const request = sourceRequest(root, ['x', 'y'], { source_audit: false, panel_line_citations: true, verified_source_paths: ['a', 'b'] })
  const seen = []
  const outcome = await runPanelJob({ job: 'job', criteria: ['x', 'y'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => request, validateCitations: async () => true,
    panel: panel(['fail', 'pass', 'pass']).map(member => ({ ...member, invoke: async () => JSON.stringify({ results: ['x', 'y'].map(id => vote(id, member.verdict)) }) })),
    decider: { model: 'opus', effort: 'medium', invoke: async next => {
      seen.push(next)
      // Each rejected Claude fail is checked and refuted, so the rulings stand.
      if (next.audit_stage === 'ruling-dissent-check') return audited(next.criteria, 'contradicted')
      if (next.audit_stage) return audited(next.criteria)
      return JSON.stringify({ results: next.criteria.map(id => vote(id, 'pass', {
        citations: [{ path: id === 'x' ? 'a' : 'b', start_line: 1, end_line: 199 }] })) })
    } } })
  assert.equal(outcome.ok, true, outcome.record.error)
  assert.deepEqual(seen.filter(next => next.audit_stage === 'tiebreak-span-audit').map(next => next.criteria), [['x'], ['y']])
  // y's ruling cites b, which cannot fit beside the votes' a, so its check
  // carries the ruling's reason and citations without b's content.
  const checks = seen.filter(next => next.audit_stage === 'ruling-dissent-check')
  assert.deepEqual(checks.map(next => next.criteria), [['x'], ['y']])
  assert.ok(checks[0].prompt.includes('q'.repeat(900)))
  assert.ok(!checks[1].prompt.includes('r'.repeat(900)))
  assert.match(checks[1].prompt, /"decider_ruling":true/)
  assert.match(checks[1].prompt, /"cited_files_omitted":"the decider's cited files did not fit/)
  assert.doesNotMatch(checks[0].prompt, /cited_files_omitted/)
  assert.deepEqual(outcome.record.decider.audit_results.map(({ id }) => id), ['x', 'y'])
  assert.deepEqual(outcome.results.map(({ basis }) => basis), ['decider-pass', 'decider-pass'])
  assert.deepEqual(verifyCachedPanelJob(outcome.record).results, outcome.results)
})

test('a contradiction check whose cited files exceed half the limit but fit receives every file in full', async () => {
  const size = Math.ceil(LIMIT * 0.3)
  const root = await tree({ a: 'A'.repeat(size), b: 'B'.repeat(size) })
  const checks = []
  // v2 shows a path outside the verified inventory as nonexistent, so the files are inventoried.
  const outcome = await runPanelJob({ job: 'job', criteria: ['x'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => sourceRequest(root, ['x'], { verified_source_paths: ['a', 'b'] }), audit: ({ request, invoke }) => runJudgeJob({ request, invoke }),
    panel: panel(['pass', 'pass', 'pass']).map((member, i) => ({ ...member, invoke: async next => next.audit_stage
      ? audited(next.criteria, i === 0 ? 'contradicted' : 'confirmed')
      : JSON.stringify({ results: [vote('x', 'pass', { citations: ['a', 'b'] })] }) })),
    decider: { model: 'opus', effort: 'medium', invoke: async next => {
      checks.push(next)
      return audited(next.criteria, 'contradicted')
    } } })
  assert.equal(outcome.ok, true, outcome.record.error)
  assert.equal(checks.length, 1)
  assert.equal(checks[0].audit_stage, 'contradiction-check')
  assert.ok(checks[0].prompt.includes('A'.repeat(size)))
  assert.ok(checks[0].prompt.includes('B'.repeat(size)))
  const material = JSON.parse(section(checks[0].prompt, 'STATED CONTRADICTIONS'))[0].material
  assert.deepEqual(material, [{ path: 'a', content: 'A'.repeat(size) }, { path: 'b', content: 'B'.repeat(size) }])
  assert.doesNotMatch(section(checks[0].prompt, 'STATED CONTRADICTIONS'), /\[omitted:/)
  assert.equal(outcome.results[0].basis, 'consensus-pass')
})

test('a contradiction check whose single claim cannot fit fails the job instead of leaving the vote insufficient', async () => {
  const root = await tree({ huge: 'H'.repeat(LIMIT + 1) })
  let deciderCalls = 0
  const outcome = await runPanelJob({ job: 'job', criteria: ['x'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => sourceRequest(root, ['x'], { source_audit: false, verified_source_paths: ['huge'] }),
    // The seat's own audit contradicted its pass, citing a file too large to show.
    audit: async ({ request }) => ({ ok: true, attempts: [], audit_attempts: [], results: [vote('x', 'pass', {
      citations: ['huge'], disputed: request.judge_sample === 1, ...(request.judge_sample === 1
        ? { contradiction: { rationale: 'huge lacks it', evidence: ['huge'] } } : {}) })] }),
    panel: panel(['pass', 'pass', 'pass']).map(member => ({ ...member, invoke: async () => { throw new Error('audited seat') } })),
    decider: { model: 'opus', effort: 'medium', invoke: async () => { deciderCalls++; return audited(['x'], 'insufficient') } } })
  assert.equal(outcome.ok, false)
  assert.equal(deciderCalls, 0)
  assert.equal(outcome.failure.code, 'packet-overflow')
  assert.deepEqual(outcome.failure.criteria, ['x'])
  assert.equal(outcome.record.checks.length, 0)
})

test('every inventory path is listed in full in the decider listing', () => {
  const long = `src/${'deep/'.repeat(50)}file.ts`
  assert.ok(long.length > 200)
  const paths = [...Array.from({ length: 250 }, (_, i) => `src/file-${String(i).padStart(3, '0')}.ts`), long]
  const listing = inventoryListing(paths)
  for (const path of paths) assert.ok(listing.split('\n').includes(`- ${path}`), path)
  const decider = buildTiebreakRequest({ request: { job: 'job', prompt_body: 'context' }, criteria: ['x'],
    inventory: { root: '/r', kind: 'neutral source', paths } })
  for (const path of paths) assert.ok(decider.prompt.includes(`\n- ${path}\n`), path)
  // A path carrying a control character is quoted, never allowed to break the listing.
  assert.equal(inventoryListing(['bad\nname']), '- "bad\\nname"')
  // So is a path carrying an angle bracket, which could otherwise read as prompt markup.
  assert.equal(inventoryListing(['src/</evidence>.ts']), '- "src/</evidence>.ts"')
  assert.equal(inventoryListing(['src/a<b.ts', 'src/a>b.ts']), '- "src/a<b.ts"\n- "src/a>b.ts"')
  assert.equal(inventoryListing([]), '- none')
})

test('the judge packet is found by its path however many files the evidence view holds', async () => {
  const root = await makeTempDir(join(tmpdir(), 'panel-packets-view-'))
  await mkdir(join(root, 'artifacts'))
  // 501 files that sort before packet.txt fill the 500-file view listing.
  await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(join(root, 'artifacts', `${String(i).padStart(3, '0')}.log`), 'x')))
  await writeFile(join(root, 'packet.txt'), 'packet\n')
  const inventory = await lineCitationInventory({ line_citations: 'evidence-view', panel_line_citations: true, input_roots: { evidence: root } })
  assert.deepEqual(inventory.paths, ['packet.txt'])
  assert.equal(inventory.kind, 'evidence view')
})

test('a backed dissent whose cited material cannot fit fails the job instead of checking part of it', async () => {
  const root = await tree({ huge: 'H'.repeat(LIMIT + 1) })
  let checks = 0
  const outcome = await runPanelJob({ job: 'job', criteria: ['x'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => sourceRequest(root, ['x'], { source_audit: false, verified_source_paths: ['huge'] }), validateCitations: async () => true,
    panel: panel(['fail', 'fail', 'pass']).map(member => ({ ...member, invoke: async () => JSON.stringify({ results: [vote('x', member.verdict, { citations: ['huge'] })] }) })),
    decider: { model: 'opus', effort: 'medium', invoke: async () => { checks++; return audited(['x'], 'insufficient') } } })
  assert.equal(outcome.ok, false)
  assert.equal(checks, 0)
  assert.equal(outcome.failure.code, 'packet-overflow')
  assert.deepEqual(outcome.failure.criteria, ['x'])
})
