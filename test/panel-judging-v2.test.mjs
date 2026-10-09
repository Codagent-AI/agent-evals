// INT-001: cross-family-panel-v2 settlement through the shared panel module.
// Canned seat, decider, audit and check invokers drive runPanelJob and
// runTiebreak over a small verified inventory; every successful record must
// replay through resolveLineCitedRecord, and no failure is ever reused.
import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PANEL_PROTOCOL, resolvePanel, runPanelJob, verifyCachedPanelJob } from '../evals/lib/panel-judging/panel.mjs'
import {
  HarnessMaterialError, LINE_CITED_RESULT_SCHEMA, PANEL_AUDIT_RESULT_SCHEMA, PANEL_CHECK_RESULT_SCHEMA,
  SOURCE_AUDIT_RESULT_SCHEMA, SOURCE_JUDGE_RESULT_SCHEMA, auditState, buildSpanAuditRequest, judgeResultSchemaFor,
  parseLineCitedOutput, resolveLineCitedRecord, runJudgeJob, runTiebreak,
} from '../evals/lib/panel-judging/protocol.mjs'
import { PRODUCT_JUDGE_PROFILE } from '../evals/agent-runner/and-scene/lib/judge-profile.mjs'
import { buildSpanAuditRequest as buildOpinionAuditRequest } from '../evals/agent-runner/and-scene/lib/second-opinion.mjs'

const ID = 'x'
const IMPL = 'export const active = step === previous\nexport const helper = () => active\n'
const TEST = 'test("active state follows the current step")\n'
const MARKER = '[truncated: run-log kept 6 of 900 characters]'
const LOG = `start\n${MARKER}\n`
const INVENTORY = ['logs/run.log', 'src/gone.ts', 'src/impl.ts', 'test/impl.test.ts']

const audit = (classification, extra = {}) => ({ id: ID, classification, rationale: `audit ${classification}`, evidence: ['audit evidence'],
  citations: [], marker: '', scope_repair: [], ...extra })
const ruling = (verdict, extra = {}) => ({ id: ID, verdict, rationale: `decider ${verdict}`, evidence: ['decider evidence'],
  citations: [], search_scope: [], missing_obligation: '', ...extra })
const span = (path, start, end = start) => ({ path, start_line: start, end_line: end })
const seatVote = (verdict, citations = ['src/impl.ts']) => ({ id: ID, verdict, rationale: `seat ${verdict}`, evidence: ['seat evidence'], citations })
const out = (...results) => JSON.stringify({ results })
const stageOf = (next) => next.judge_stage ?? next.audit_stage ?? 'seat'
// The packet section a request carries between its BEGIN and END markers.
const section = (prompt, name) => prompt.split(`# BEGIN ${name}\n`)[1].split(`\n# END ${name}`)[0]

async function sourceTree() {
  const root = await makeTempDir(join(tmpdir(), 'panel-v2-'))
  const files = { 'src/impl.ts': IMPL, 'test/impl.test.ts': TEST, 'logs/run.log': LOG, 'src/unlisted.ts': 'not delivered\n' }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, 'source', path, '..'), { recursive: true })
    await writeFile(join(root, 'source', path), text)
  }
  return root
}

const sourceRequest = (root, { fallback = false } = {}) => ({ schema: SOURCE_JUDGE_RESULT_SCHEMA, job: 'job', criteria: [ID],
  prompt: 'unchanged context', prompt_body: 'unchanged context', rubric_slice: 'x requirement and guidance', cwd: root, audit_cwd: root,
  input_roots: { source: join(root, 'source') }, verified_source_paths: INVENTORY, source_audit: true, panel_line_citations: true,
  requireSourceCitationsFor: fallback ? [ID] : [] })

// Scripted answers per stage, consumed in order; the last one repeats.
function scripted(queues, seen) {
  const used = {}
  return async (next) => {
    const stage = stageOf(next)
    seen.push(next)
    const queue = queues[stage]
    if (!queue) throw new Error(`unexpected ${stage}`)
    const index = Math.min(used[stage] = (used[stage] ?? -1) + 1, queue.length - 1)
    const answer = queue[index]
    return typeof answer === 'function' ? answer(next) : out(...[].concat(answer))
  }
}

// Three audited seats (Claude first) and a scripted decider. `seats[i]` lists
// seat i's source-audit answers in order.
function panelJob(root, { votes = ['pass', 'pass', 'pass'], seats = [], decider = {}, fallback = false, seen = [] }) {
  return {
    job: 'job', criteria: [ID], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: SOURCE_JUDGE_RESULT_SCHEMA,
    buildPrompt: () => sourceRequest(root, { fallback }),
    audit: ({ request, invoke }) => runJudgeJob({ request, invoke }),
    validateCitations: async () => true,
    panel: votes.map((verdict, index) => ({ family: index === 0 ? 'claude' : 'codex', model: `m${index}`, effort: 'medium',
      invoke: scripted({ seat: [typeof verdict === 'string' ? seatVote(verdict) : verdict],
        'source-pass-audit': seats[index] ?? [audit('confirmed')] }, seen) })),
    decider: { model: 'opus', effort: 'medium', invoke: scripted(decider, seen) },
  }
}

// A successful record replays to the same results; a failure is never reused.
function assertReplay(outcome) {
  if (outcome.ok) {
    assert.equal(outcome.record.protocol, 'cross-family-panel-v2')
    assert.deepEqual(verifyCachedPanelJob(outcome.record).results, outcome.results)
  } else {
    assert.throws(() => verifyCachedPanelJob(outcome.record), /predates panel protocol or is incomplete/)
  }
}

function assertHarnessFailure(outcome, code) {
  assert.equal(outcome.ok, false)
  assert.equal(outcome.results, null)
  assert.equal(outcome.failure.code, code)
  assert.equal(outcome.failure.owner, 'evaluation-harness')
  assert.equal(outcome.failure.resumable, false)
  assert.equal(outcome.failure.retryable, false)
  assert.deepEqual(outcome.failure.criteria, [ID])
  assertReplay(outcome)
}

// --- Settlement routing ------------------------------------------------------

test('the active-state route: a confirmed contradiction turns a vote and a Claude-backed majority still goes to the decider', async () => {
  const root = await sourceTree()
  const seen = []
  const outcome = await runPanelJob(panelJob(root, { seen,
    seats: [[audit('confirmed')], [audit('contradicted', { rationale: 'the helper compares the active step with the Previous control',
      citations: ['test/impl.test.ts'] })], [audit('confirmed')]],
    decider: {
      'contradiction-check': [audit('confirmed', { rationale: 'the comparison with previous is confirmed', citations: ['src/impl.ts'] })],
      tiebreak: [ruling('fail', { citations: [span('src/impl.ts', 1)] })],
      'tiebreak-span-audit': [audit('confirmed')],
    } }))
  assert.equal(outcome.ok, true, outcome.record.error)
  assert.equal(outcome.results[0].basis, 'decider-fail')
  assert.equal(outcome.results[0].routed_by, 'confirmed-contradiction')
  // The check reads the vote's citations and the files its audit cited.
  const check = seen.find((next) => next.audit_stage === 'contradiction-check')
  const material = JSON.parse(section(check.prompt, 'STATED CONTRADICTIONS'))[0].material
  assert.deepEqual(material, [{ path: 'src/impl.ts', content: IMPL }, { path: 'test/impl.test.ts', content: TEST }])
  assert.deepEqual(check.schema, judgeResultSchemaFor(PANEL_CHECK_RESULT_SCHEMA, [ID]))
  // The decider sees the audit's stated contradiction and the check's confirmation.
  const decider = seen.find((next) => next.judge_stage === 'tiebreak')
  assert.match(decider.prompt, /The source contradiction was independently confirmed: the helper compares the active step with the Previous control The contradiction check confirmed it: the comparison with previous is confirmed/)
  assert.deepEqual(outcome.record.votes.find((vote) => vote.panel_index === 1).contradiction.citations, ['test/impl.test.ts'])
  assertReplay(outcome)
})

for (const fallback of [false, true]) {
  test(`a contradicted ${fallback ? 'browser-fallback ' : ''}pass whose check cannot decide ${fallback ? 'stays disputed for the decider' : 'stands as a consensus pass'}`, async () => {
    const root = await sourceTree()
    const seen = []
    const outcome = await runPanelJob(panelJob(root, { seen, fallback,
      seats: [[audit('contradicted')]],
      decider: { 'contradiction-check': [audit('insufficient')], tiebreak: [ruling('pass', { citations: [span('src/impl.ts', 1, 2)] })],
        'tiebreak-span-audit': [audit('confirmed')] } }))
    assert.equal(outcome.ok, true, outcome.record.error)
    assert.equal(outcome.results[0].basis, fallback ? 'decider-pass' : 'consensus-pass')
    assert.equal(seen.some((next) => next.judge_stage === 'tiebreak'), fallback)
    assert.equal(outcome.results[0].routed_by, undefined)
    assertReplay(outcome)
  })
}

test('the INV-093 shape settles as a decider ruling on the define scale (the overrule check is slice S3)', () => {
  const votes = ['met', 'partial', 'partial'].map((verdict, index) => ({ ...seatVote(verdict), family: index === 0 ? 'claude' : 'codex', panel_index: index }))
  const met = { id: ID, verdict: 'met', rationale: 'decider met', evidence: ['e'], citations: [] }
  const { results } = resolvePanel({ criteria: [ID], order: ['met', 'partial', 'missing'], votes, rulings: [met] })
  assert.equal(results[0].basis, 'decider-met')
  assert.equal(results[0].routed_by, undefined)
  // The Codex pair alone never settles it; without a ruling there is no result.
  assert.throws(() => resolvePanel({ criteria: [ID], order: ['met', 'partial', 'missing'], votes }), /missing or invalid decider ruling/)
})

// --- Decider fails ----------------------------------------------------------

const deciderSplit = (root, decider, extra = {}) => panelJob(root, { votes: ['fail', 'pass', 'pass'], decider, ...extra })

test('a decider fail citing a counterexample is span-audited as a counterexample and stands when confirmed', async () => {
  const root = await sourceTree()
  const seen = []
  const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('fail', { citations: [span('src/impl.ts', 1)] })],
    'tiebreak-span-audit': [audit('confirmed')] }, { seen }))
  assert.equal(outcome.results[0].basis, 'decider-fail')
  const spanAudit = seen.find((next) => next.audit_stage === 'tiebreak-span-audit')
  assert.deepEqual(JSON.parse(section(spanAudit.prompt, 'LINE-CITED CLAIMS')),
    [{ id: ID, claim: 'counterexample fail', rationale: 'decider fail', quoted_spans: ['src/impl.ts:1-1\n1|export const active = step === previous'] }])
  assert.match(spanAudit.prompt, /counterexample fail: confirmed when the quoted lines show a clause of the requirement unmet/)
  assert.deepEqual(outcome.record.decider.audit_results.map(({ criterion, cycle, part, classification }) => [criterion, cycle, part, classification]),
    [[ID, 'initial', 0, 'confirmed']])
  assert.deepEqual(outcome.record.decider.settlement, { [ID]: { cycles: [{ cycle: 'initial', expected_parts: [0] }], settled_cycle: 'initial' } })
  assertReplay(outcome)
})

test('a decider fail is overturned when a check confirms its audit\'s contradiction, with the audit\'s cited files in the check', async () => {
  const root = await sourceTree()
  const seen = []
  const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('fail', { citations: [span('src/impl.ts', 1)] })],
    'tiebreak-span-audit': [audit('contradicted', { rationale: 'the test proves the active state', citations: ['test/impl.test.ts'] })],
    'contradiction-check': [audit('confirmed', { rationale: 'every clause is met' })] }, { seen }))
  assert.equal(outcome.ok, true, outcome.record.error)
  assert.equal(outcome.results[0].basis, 'decider-pass')
  const decision = outcome.record.decider.decisions[0]
  assert.equal(decision.vote, 'fail')
  assert.match(decision.result.rationale, /confirmed by an independent check that every clause is met/)
  assert.deepEqual(outcome.record.decider.contradiction_checks.map(({ criterion, cycle, part, parts }) => [criterion, cycle, part, parts]),
    [[ID, 'initial', 0, [0]]])
  const check = seen.find((next) => next.audit_stage === 'contradiction-check')
  assert.match(check.prompt, /To confirm the contradiction of a fail, the material\n {2}must meet every clause/)
  const material = JSON.parse(section(check.prompt, 'STATED CONTRADICTIONS'))[0].material
  assert.deepEqual(material, ['src/impl.ts:1-1\n1|export const active = step === previous', { path: 'test/impl.test.ts', content: TEST }])
  assertReplay(outcome)
})

test('a decider fail about absence is audited against its scope files, its obligation and the complete inventory', async () => {
  const root = await sourceTree()
  const seen = []
  const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('fail', { search_scope: ['test/impl.test.ts'],
    missing_obligation: 'a focused test of the active state' })], 'tiebreak-span-audit': [audit('confirmed')] }, { seen }))
  assert.equal(outcome.results[0].basis, 'decider-fail')
  const spanAudit = seen.find((next) => next.audit_stage === 'tiebreak-span-audit')
  assert.deepEqual(JSON.parse(section(spanAudit.prompt, 'LINE-CITED CLAIMS')), [{ id: ID, claim: 'absence fail', rationale: 'decider fail',
    missing_obligation: 'a focused test of the active state', search_scope: ['test/impl.test.ts'],
    scope_files: ['test/impl.test.ts\n1|test("active state follows the current step")\n2|'] }])
  const inventory = section(spanAudit.prompt, 'COMPLETE VERIFIED INVENTORY')
  for (const path of INVENTORY) assert.ok(inventory.split('\n').includes(`- ${path}`), path)
  assert.match(spanAudit.prompt, /absence fail: confirmed when the search scope is where the missing obligation would live/)
  assert.deepEqual(spanAudit.schema, judgeResultSchemaFor(PANEL_AUDIT_RESULT_SCHEMA, [ID]))
  assert.ok(outcome.results[0].evidence.includes('search scope: test/impl.test.ts'))
  assertReplay(outcome)
})

test('a decider fail citing neither a counterexample nor a search scope is retried, then fails the job', async () => {
  const root = await sourceTree()
  const neither = ruling('fail')
  const exhausted = await runPanelJob(deciderSplit(root, { tiebreak: [neither] }))
  assert.equal(exhausted.ok, false)
  assert.equal(exhausted.failure.code, 'judge-output')
  const tries = exhausted.record.decider.attempts.filter(({ stage }) => stage === 'tiebreak')
  assert.equal(tries.length, 3)
  for (const attempt of tries) assert.match(attempt.error, /cites neither a counterexample nor a search scope/)
  assertReplay(exhausted)
  // A scope without its obligation is no better; the next valid answer settles.
  const recovered = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('fail', { search_scope: ['src/impl.ts'] }),
    ruling('fail', { citations: [span('src/impl.ts', 1)] })], 'tiebreak-span-audit': [audit('confirmed')] }))
  assert.equal(recovered.results[0].basis, 'decider-fail')
  assert.deepEqual(recovered.record.decider.attempts.map(({ ok }) => ok), [false, true])
  assertReplay(recovered)
  assert.throws(() => parseLineCitedOutput(out(ruling('fail', { search_scope: ['src/impl.ts'], missing_obligation: ' ' })), [ID], 'job'), /cites neither/)
  // A scope path outside the verified inventory is invalid like a span path.
  const outside = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('fail', { search_scope: ['src/unlisted.ts'], missing_obligation: 'a test' }),
    ruling('fail', { search_scope: ['test/impl.test.ts'], missing_obligation: 'a test' })], 'tiebreak-span-audit': [audit('confirmed')] }))
  assert.match(outside.record.decider.attempts[0].error, /search scope names a path outside the verified neutral source: src\/unlisted.ts/)
  assert.equal(outside.results[0].basis, 'decider-fail')
})

// --- Scope repair --------------------------------------------------------------

const absenceFail = ruling('fail', { search_scope: ['src/impl.ts'], missing_obligation: 'a focused active-state test' })
const inadequate = audit('scope-inadequate', { rationale: 'tests live under test/', scope_repair: ['test/impl.test.ts'] })

for (const [repairAnswer, expected] of [['confirmed', 'decider-fail'], ['insufficient', 'decider-fail'], ['scope-inadequate', 'scope-inadequate']]) {
  test(`an inadequate absence scope gets exactly one repair round, which returns ${repairAnswer}`, async () => {
    const root = await sourceTree()
    const seen = []
    const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [absenceFail],
      'tiebreak-span-audit': [inadequate, repairAnswer === 'scope-inadequate' ? { ...inadequate, scope_repair: [] } : audit(repairAnswer)] }, { seen }))
    const audits = seen.filter((next) => next.audit_stage === 'tiebreak-span-audit')
    assert.equal(audits.length, 2, 'one initial audit and one repair round, never a second')
    assert.equal(seen.filter((next) => next.judge_stage === 'tiebreak-recite').length, 0, 'an absence fail is never re-cited')
    // The repair round sees the named inventory file in full beside the original scope.
    const repaired = JSON.parse(section(audits[1].prompt, 'LINE-CITED CLAIMS'))[0]
    assert.deepEqual(repaired.search_scope, ['src/impl.ts', 'test/impl.test.ts'])
    assert.ok(repaired.scope_files[1].startsWith('test/impl.test.ts\n1|test("active state'))
    if (expected === 'scope-inadequate') {
      assertHarnessFailure(outcome, 'scope-inadequate')
      assert.deepEqual(outcome.record.decider.audit_results.map(({ cycle }) => cycle), ['initial', 'repair'])
      return
    }
    assert.equal(outcome.ok, true, outcome.record.error)
    assert.equal(outcome.results[0].basis, expected)
    const decider = outcome.record.decider
    assert.deepEqual(decider.settlement[ID], { settled_cycle: 'repair', cycles: [{ cycle: 'initial', expected_parts: [0] },
      { cycle: 'repair', expected_parts: [0], scope: ['src/impl.ts', 'test/impl.test.ts'] }] })
    assert.equal(decider.decisions[0].result.evidence.at(-1), repairAnswer === 'confirmed'
      ? 'decider ruling: fail, confirmed by the closed-world span audit' : 'decider ruling: fail; the span audit could not confirm or refute it')
    assertReplay(outcome)
  })
}

test('an invalid scope repair, or scope-inadequate on a ruling that is not an absence fail, is invalid audit output and is retried', async () => {
  const root = await sourceTree()
  const outside = await runPanelJob(deciderSplit(root, { tiebreak: [absenceFail],
    'tiebreak-span-audit': [{ ...inadequate, scope_repair: ['src/unlisted.ts'] }, { ...inadequate, scope_repair: [] }, inadequate, audit('confirmed')] }))
  assert.equal(outside.ok, true, outside.record.error)
  assert.deepEqual(outside.record.decider.audit_attempts.map(({ cycle, ok }) => [cycle, ok]),
    [['initial', false], ['initial', false], ['initial', true], ['repair', true]])
  assert.match(outside.record.decider.audit_attempts[0].error, /scope_repair for x names a path outside the verified inventory: src\/unlisted.ts/)
  assert.match(outside.record.decider.audit_attempts[1].error, /without naming inventory files to repair it/)
  const pass = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('pass', { citations: [span('src/impl.ts', 1, 2)] })],
    'tiebreak-span-audit': [inadequate, audit('confirmed')] }))
  assert.match(pass.record.decider.audit_attempts[0].error, /which only an absence fail has/)
  assert.equal(pass.results[0].basis, 'decider-pass')
})

// --- Re-cite immutability ---------------------------------------------------------

test('a re-cite that tries to change its verdict is retried; the record keeps first and re-cited citations, re-audited', async () => {
  const root = await sourceTree()
  const seen = []
  const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('pass', { citations: [span('src/impl.ts', 1)] })],
    'tiebreak-span-audit': [audit('insufficient', { rationale: 'the consumer is not quoted' }), audit('confirmed')],
    'tiebreak-recite': [ruling('fail', { citations: [span('src/impl.ts', 1)] }), ruling('pass', { citations: [span('src/impl.ts', 1, 2)] })] }, { seen }))
  assert.equal(outcome.ok, true, outcome.record.error)
  assert.equal(outcome.results[0].basis, 'decider-pass')
  const recites = seen.filter((next) => next.judge_stage === 'tiebreak-recite')
  assert.equal(recites.length, 2)
  assert.doesNotMatch(recites[0].prompt, /change your verdict/)
  assert.match(recites[0].prompt, /- x \(your verdict: pass\): the consumer is not quoted/)
  const decider = outcome.record.decider
  assert.match(decider.attempts.find(({ stage, ok }) => stage === 'tiebreak-recite' && !ok).error, /re-cite changed the verdict of x from pass to fail/)
  assert.deepEqual(decider.first_results[0].citations, [span('src/impl.ts', 1)])
  assert.deepEqual(decider.results[0].citations, [span('src/impl.ts', 1, 2)])
  assert.deepEqual(decider.first_spans[ID].map(({ end_line: end }) => end), [1])
  assert.deepEqual(decider.spans[ID].map(({ end_line: end }) => end), [2])
  assert.deepEqual(decider.audit_results.map(({ cycle, classification }) => [cycle, classification]), [['initial', 'insufficient'], ['recite', 'confirmed']])
  assert.equal(decider.settlement[ID].settled_cycle, 'recite')
  assertReplay(outcome)
  // A replayed record whose re-cite changed its verdict is rejected.
  const tampered = structuredClone(outcome.record)
  tampered.decider.first_results[0].verdict = 'fail'
  assert.throws(() => verifyCachedPanelJob(tampered), /changed its verdict on re-cite/)
})

test('a counterexample fail undecided by its audit is re-cited once and must cite its counterexample again', async () => {
  const root = await sourceTree()
  const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('fail', { citations: [span('src/impl.ts', 1)] })],
    'tiebreak-span-audit': [audit('insufficient'), audit('insufficient')],
    'tiebreak-recite': [ruling('fail', { search_scope: ['test/impl.test.ts'], missing_obligation: 'a test' }), ruling('fail', { citations: [span('src/impl.ts', 1, 2)] })] }))
  assert.equal(outcome.ok, true, outcome.record.error)
  assert.match(outcome.record.decider.attempts.find(({ ok }) => !ok).error, /must cite its counterexample's lines/)
  // Still undecided after the re-cite: the fail stands, and no further cycle runs.
  assert.equal(outcome.results[0].basis, 'decider-fail')
  assert.deepEqual(outcome.record.decider.audit_results.map(({ cycle }) => cycle), ['initial', 'recite'])
  assertReplay(outcome)
})

// --- Citations and material -------------------------------------------------

test('a vote citing a path outside the verified inventory shows it to the check as nonexistent', async () => {
  const root = await sourceTree()
  const seen = []
  const outcome = await runPanelJob(panelJob(root, { seen, votes: [seatVote('pass', ['src/impl.ts', 'src/unlisted.ts']), 'pass', 'pass'],
    seats: [[audit('contradicted', { rationale: 'the cited file is not delivered' })]],
    decider: { 'contradiction-check': [audit('contradicted')] } }))
  assert.equal(outcome.results[0].basis, 'consensus-pass')
  const check = seen.find((next) => next.audit_stage === 'contradiction-check')
  assert.deepEqual(JSON.parse(section(check.prompt, 'STATED CONTRADICTIONS'))[0].material,
    [{ path: 'src/impl.ts', content: IMPL }, { path: 'src/unlisted.ts', not_in_inventory: '[not in inventory: src/unlisted.ts]' }])
  assertReplay(outcome)
})

test('an audit citing a path outside the verified inventory is invalid output and is retried', async () => {
  const root = await sourceTree()
  const outcome = await runPanelJob(panelJob(root, {
    seats: [[audit('contradicted', { citations: ['src/unlisted.ts'] }), audit('contradicted', { citations: ['test/impl.test.ts'] })]],
    decider: { 'contradiction-check': [audit('contradicted', { citations: ['src/unlisted.ts'] }), audit('contradicted')] } }))
  assert.equal(outcome.ok, true, outcome.record.error)
  const [failedAudit] = outcome.record.samples[0].audit_attempts
  assert.match(failedAudit.error, /citations for x names a path outside the verified inventory: src\/unlisted.ts/)
  assert.deepEqual(outcome.record.attempts.filter(({ stage }) => stage === 'contradiction-check').map(({ ok }) => ok), [false, true])
  assert.equal(outcome.results[0].basis, 'consensus-pass')
  // A decider span audit citing outside the inventory is retried the same way.
  const decided = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('pass', { citations: [span('src/impl.ts', 1, 2)] })],
    'tiebreak-span-audit': [audit('confirmed', { citations: ['src/unlisted.ts'] }), audit('confirmed', { citations: ['src/impl.ts'] })] }))
  assert.deepEqual(decided.record.decider.audit_attempts.map(({ ok }) => ok), [false, true])
  assert.deepEqual(decided.record.decider.audit_results[0].citations, ['src/impl.ts'])
  assertReplay(decided)
})

test('an inventory file the check cannot read fails the job as missing material naming the criterion', async () => {
  const root = await sourceTree()
  const seen = []
  const outcome = await runPanelJob(panelJob(root, { seen, seats: [[audit('contradicted', { citations: ['src/gone.ts'] })]],
    decider: { 'contradiction-check': [audit('insufficient')] } }))
  assertHarnessFailure(outcome, 'missing-material')
  assert.match(outcome.failure.message, /cannot read neutral source file src\/gone.ts for x/)
  assert.equal(seen.some((next) => next.audit_stage === 'contradiction-check'), false, 'no vote is left standing on an undecided check')
})

test('a check returning missing-material fails the job, and one naming a marker its packet lacks is retried', async () => {
  const root = await sourceTree()
  const outcome = await runPanelJob(panelJob(root, { seats: [[audit('contradicted', { citations: ['logs/run.log'] })]],
    decider: { 'contradiction-check': [audit('missing-material', { marker: '[truncated: other kept 1 of 2 characters]' }),
      audit('missing-material', { marker: MARKER })] } }))
  assertHarnessFailure(outcome, 'missing-material')
  assert.deepEqual(outcome.record.attempts.filter(({ stage }) => stage === 'contradiction-check').map(({ ok }) => ok), [false, true])
  assert.match(outcome.record.attempts.find(({ stage, ok }) => stage === 'contradiction-check' && !ok).error, /without a marker its packet holds/)
  assert.match(outcome.failure.message, /needs missing material \[truncated: run-log kept 6 of 900 characters\]/)
})

test('a seat audit returning missing-material fails the job naming the criterion', async () => {
  const root = await sourceTree()
  const outcome = await runPanelJob(panelJob(root, { votes: [seatVote('pass', ['logs/run.log']), 'pass', 'pass'],
    seats: [[audit('missing-material', { marker: MARKER })]] }))
  assertHarnessFailure(outcome, 'missing-material')
})

// --- Browser fallback -------------------------------------------------------

test('a browser-fallback pass whose check returns missing-material fails the job', async () => {
  const root = await sourceTree()
  const outcome = await runPanelJob(panelJob(root, { fallback: true, seats: [[audit('contradicted', { citations: ['logs/run.log'] })]],
    decider: { 'contradiction-check': [audit('missing-material', { marker: MARKER })] } }))
  assertHarnessFailure(outcome, 'missing-material')
})

for (const cited of [true, false]) {
  test(`a browser-fallback fail ${cited ? 'is reversed when the confirming check cites delivered source' : 'stands when the confirming check cites no delivered source'}`, async () => {
    const root = await sourceTree()
    const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('fail', { citations: [span('src/impl.ts', 1)] })],
      'tiebreak-span-audit': [audit('contradicted', { citations: ['test/impl.test.ts'] })],
      'contradiction-check': [audit('confirmed', { citations: cited ? ['src/impl.ts', 'test/impl.test.ts'] : [] })] }, { fallback: true }))
    assert.equal(outcome.ok, true, outcome.record.error)
    assert.equal(outcome.results[0].basis, cited ? 'decider-pass' : 'decider-fail')
    if (cited) assert.deepEqual(outcome.results[0].citations, ['src/impl.ts', 'test/impl.test.ts'])
    else assert.match(outcome.results[0].evidence.at(-2), /cited no delivered source, so the browser-fallback fail stands/)
    assertReplay(outcome)
  })
}

test('an unconfirmed browser-fallback decider pass still fails after its single re-cite', async () => {
  const root = await sourceTree()
  const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('pass', { citations: [span('src/impl.ts', 1)] })],
    'tiebreak-span-audit': [audit('insufficient')], 'tiebreak-recite': [ruling('pass', { citations: [span('src/impl.ts', 1, 2)] })] }, { fallback: true }))
  assert.equal(outcome.results[0].basis, 'decider-fail')
  assertReplay(outcome)
})

// --- Multi-part audits --------------------------------------------------------

// Two audit parts per ruling, one per quoted span, through the auditClaims hook.
const twoParts = (claim) => [{ ...claim, part: 'a', spans: claim.spans.slice(0, 1) }, { ...claim, part: 'b', spans: claim.spans.slice(1) }]
const twoSpans = [span('src/impl.ts', 1), span('test/impl.test.ts', 1)]

async function partsTiebreak(decider, { verdict = 'pass', fallback = false, citations = twoSpans } = {}) {
  const root = await sourceTree()
  const seen = []
  const outcome = await runTiebreak({ request: sourceRequest(root, { fallback }), criteria: [ID], auditClaims: twoParts,
    invoke: scripted({ tiebreak: [ruling(verdict, { citations })], ...decider }, seen) })
  return { outcome, seen }
}
const replayed = (record, fallbackIds = []) => resolveLineCitedRecord(record, fallbackIds)

test('mixed audit parts leave a pass undecided; the single re-cite re-runs every part as a new cycle', async () => {
  const { outcome, seen } = await partsTiebreak({
    'tiebreak-span-audit': [audit('confirmed'), audit('insufficient'), audit('confirmed'), audit('confirmed')],
    'tiebreak-recite': [ruling('pass', { citations: twoSpans })] })
  assert.equal(outcome.ok, true)
  assert.equal(seen.filter((next) => next.judge_stage === 'tiebreak-recite').length, 1)
  assert.deepEqual(outcome.audit_results.map(({ cycle, part, classification }) => [cycle, part, classification]),
    [['initial', 'a', 'confirmed'], ['initial', 'b', 'insufficient'], ['recite', 'a', 'confirmed'], ['recite', 'b', 'confirmed']])
  assert.deepEqual(outcome.settlement[ID], { settled_cycle: 'recite',
    cycles: [{ cycle: 'initial', expected_parts: ['a', 'b'] }, { cycle: 'recite', expected_parts: ['a', 'b'] }] })
  assert.equal(outcome.decisions[0].result.evidence.at(-1), 'decider ruling: pass, confirmed by the closed-world span audit')
  assert.deepEqual(replayed(outcome), outcome.decisions)
})

test('a pass with two contradicted parts gets one check per part, in a stable order', async () => {
  const { outcome, seen } = await partsTiebreak({
    'tiebreak-span-audit': [audit('contradicted', { rationale: 'part a contradicts' }), audit('contradicted', { rationale: 'part b contradicts' })],
    'contradiction-check': [audit('contradicted'), audit('confirmed', { rationale: 'part b holds' })] })
  const checks = seen.filter((next) => next.audit_stage === 'contradiction-check')
  assert.deepEqual(checks.map((next) => JSON.parse(section(next.prompt, 'STATED CONTRADICTIONS'))[0].stated_contradiction.rationale),
    ['part a contradicts', 'part b contradicts'])
  assert.deepEqual(JSON.parse(section(checks[0].prompt, 'STATED CONTRADICTIONS'))[0].material, ['src/impl.ts:1-1\n1|export const active = step === previous'])
  assert.deepEqual(outcome.contradiction_checks.map(({ cycle, part, classification }) => [cycle, part, classification]),
    [['initial', 'a', 'contradicted'], ['initial', 'b', 'confirmed']])
  assert.equal(outcome.decisions[0].result.verdict, 'fail')
  assert.match(outcome.decisions[0].result.rationale, /part b contradicts \| part b holds/)
  assert.deepEqual(replayed(outcome), outcome.decisions)
})

test('a fail contradicted in one part gets one check with every part\'s material, reversed only when it confirms', async () => {
  for (const check of ['confirmed', 'contradicted']) {
    const { outcome, seen } = await partsTiebreak({
      'tiebreak-span-audit': [audit('confirmed'), audit('contradicted', { rationale: 'the test meets it', citations: ['logs/run.log'] })],
      'contradiction-check': [audit(check)] }, { verdict: 'fail' })
    const checks = seen.filter((next) => next.audit_stage === 'contradiction-check')
    assert.equal(checks.length, 1)
    assert.deepEqual(JSON.parse(section(checks[0].prompt, 'STATED CONTRADICTIONS'))[0].material, [
      'src/impl.ts:1-1\n1|export const active = step === previous',
      'test/impl.test.ts:1-1\n1|test("active state follows the current step")',
      { path: 'logs/run.log', content: LOG }])
    assert.deepEqual(outcome.contradiction_checks.map(({ part, parts }) => [part, parts]), [['b', ['a', 'b']]])
    assert.equal(outcome.decisions[0].result.verdict, check === 'confirmed' ? 'pass' : 'fail')
    assert.deepEqual(replayed(outcome), outcome.decisions)
  }
})

test('a confirmed contradiction reverses a pass even beside a missing-material part, and the record replays', async () => {
  const { outcome } = await partsTiebreak({
    'tiebreak-span-audit': [audit('missing-material', { marker: MARKER }), audit('contradicted')],
    'contradiction-check': [audit('confirmed')] }, { citations: [span('logs/run.log', 2), span('src/impl.ts', 1)] })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.decisions[0].result.verdict, 'fail')
  assert.deepEqual(replayed(outcome), outcome.decisions)
  // Without that confirmation the missing part fails the job, naming the criterion.
  const { outcome: missing } = await partsTiebreak({
    'tiebreak-span-audit': [audit('missing-material', { marker: MARKER }), audit('contradicted')],
    'contradiction-check': [audit('insufficient')] }, { citations: [span('logs/run.log', 2), span('src/impl.ts', 1)] })
  assert.equal(missing.ok, false)
  assert.equal(missing.failure.code, 'missing-material')
  assert.deepEqual(missing.failure.criteria, [ID])
})

// --- Replay of retained records ------------------------------------------------

test('a retained record with an inconclusive initial-cycle check and a confirmed re-cite cycle verifies', async () => {
  const { outcome } = await partsTiebreak({
    'tiebreak-span-audit': [audit('contradicted'), audit('insufficient'), audit('confirmed'), audit('confirmed')],
    'contradiction-check': [audit('insufficient')],
    'tiebreak-recite': [ruling('pass', { citations: twoSpans })] })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.contradiction_checks.map(({ cycle, part, classification }) => [cycle, part, classification]), [['initial', 'a', 'insufficient']])
  assert.equal(outcome.settlement[ID].settled_cycle, 'recite')
  assert.deepEqual(replayed(outcome), outcome.decisions)
  assert.equal(outcome.decisions[0].result.verdict, 'pass')
  // The earlier check is verified against its own cycle and part.
  const moved = structuredClone(outcome)
  moved.contradiction_checks[0].part = 'b'
  assert.throws(() => replayed(moved), /matches no contradicted part of its cycle/)
})

test('a record that would combine cycles, or whose settled cycle lacks a required part, is rejected', async () => {
  const { outcome } = await partsTiebreak({
    'tiebreak-span-audit': [audit('confirmed'), audit('insufficient'), audit('confirmed'), audit('confirmed')],
    'tiebreak-recite': [ruling('pass', { citations: twoSpans })] })
  // Settling on the initial cycle while a re-cite cycle exists.
  const stale = structuredClone(outcome)
  stale.settlement[ID].settled_cycle = 'initial'
  assert.throws(() => replayed(stale), /does not settle on its last audit cycle/)
  // The re-cite cycle lacks part a; only the initial cycle's part a could fill it.
  const mixed = structuredClone(outcome)
  mixed.audit_results = mixed.audit_results.filter(({ cycle, part }) => !(cycle === 'recite' && part === 'a'))
  assert.throws(() => replayed(mixed), /lacks a required part of its recite cycle/)
  // A part recorded under a cycle the settlement does not list.
  const stray = structuredClone(outcome)
  stray.audit_results.push({ ...stray.audit_results[0], cycle: 'repair' })
  assert.throws(() => replayed(stray), /audit part outside its cycles/)
  // An initial cycle that could not have led to its re-cite.
  const premature = structuredClone(outcome)
  premature.audit_results[1].classification = 'confirmed'
  assert.throws(() => replayed(premature), /does not lead to its recite cycle/)
})

test('a panel record whose decider settlement does not verify is re-judged rather than reused', async () => {
  const root = await sourceTree()
  const outcome = await runPanelJob(deciderSplit(root, { tiebreak: [ruling('pass', { citations: [span('src/impl.ts', 1)] })],
    'tiebreak-span-audit': [audit('insufficient'), audit('confirmed')], 'tiebreak-recite': [ruling('pass', { citations: [span('src/impl.ts', 1, 2)] })] }))
  assertReplay(outcome)
  const mixed = structuredClone(outcome.record)
  mixed.decider.audit_results = mixed.decider.audit_results.filter(({ cycle }) => cycle !== 'recite')
  assert.throws(() => verifyCachedPanelJob(mixed), /lacks a required part of its recite cycle/)
  const v1 = { ...structuredClone(outcome.record), protocol: 'cross-family-panel-v1' }
  assert.throws(() => verifyCachedPanelJob(v1), /predates panel protocol/)
  // A rerun under v2 judges the job afresh instead of reusing the stale record.
  let calls = 0
  const options = panelJob(root, { votes: ['pass', 'pass', 'pass'] })
  options.panel = options.panel.map((member) => ({ ...member, invoke: async (next) => { calls++; return member.invoke(next) } }))
  const rejudged = await runPanelJob({ ...options, cache: v1 })
  assert.equal(rejudged.ok, true)
  assert.ok(calls > 0)
  assert.equal(rejudged.record.protocol, 'cross-family-panel-v2')
})

test('auditState settles a cycle from its parts alone and raises known missing material', () => {
  const pass = { id: ID, verdict: 'pass', citations: [span('src/impl.ts', 1)] }
  const record = (parts, checks = [], expected = parts.map(({ part }) => part)) => ({ results: [pass],
    audit_results: parts.map((entry) => ({ ...audit(entry.classification), ...entry, criterion: ID, cycle: 'initial' })),
    contradiction_checks: checks.map((entry) => ({ ...audit(entry.classification), ...entry, criterion: ID, cycle: 'initial' })),
    settlement: { [ID]: { cycles: [{ cycle: 'initial', expected_parts: expected }] } } })
  assert.equal(auditState(record([{ part: 0, classification: 'confirmed' }]), ID).state, 'confirmed')
  assert.equal(auditState(record([{ part: 0, classification: 'confirmed' }, { part: 1, classification: 'insufficient' }]), ID).state, 'undecided')
  assert.equal(auditState(record([{ part: 0, classification: 'contradicted' }], [{ part: 0, classification: 'contradicted' }]), ID).state, 'unconfirmed')
  assert.throws(() => auditState(record([{ part: 0, classification: 'contradicted' }]), ID), /without its contradiction check/)
  assert.throws(() => auditState(record([{ part: 0, classification: 'confirmed' }], [], [0, 1]), ID),
    (error) => error instanceof HarnessMaterialError && error.code === 'missing-material' && /audit part 1 is absent/.test(error.message))
  assert.throws(() => auditState(record([{ part: 0, classification: 'confirmed' }, { part: 1, classification: 'missing-material', marker: MARKER }]), ID),
    (error) => error instanceof HarnessMaterialError && error.criteria.join() === ID)
})

// --- Protocol and schemas -----------------------------------------------------

test('records and profiles name cross-family-panel-v2', () => {
  assert.equal(PANEL_PROTOCOL, 'cross-family-panel-v2')
  assert.equal(PRODUCT_JUDGE_PROFILE.protocol, 'cross-family-panel-v2')
})

// INT-002 (panel half): the panel audit carries required structured citations,
// while the second opinion keeps the unchanged source-audit schema.
test('INT-002: the panel audit request uses PANEL_AUDIT_RESULT_SCHEMA while second opinions keep SOURCE_AUDIT_RESULT_SCHEMA', () => {
  const request = buildSpanAuditRequest({ request: { job: 'job' }, rulings: [{ id: ID, verdict: 'pass', rationale: 'r', citations: [] }], spans: new Map() })
  assert.deepEqual(request.schema, judgeResultSchemaFor(PANEL_AUDIT_RESULT_SCHEMA, [ID]))
  const item = PANEL_AUDIT_RESULT_SCHEMA.properties.results.items
  assert.deepEqual(item.required, ['id', 'classification', 'rationale', 'evidence', 'citations', 'marker', 'scope_repair'])
  assert.deepEqual(item.properties.citations, { type: 'array', maxItems: 24, items: { type: 'string', minLength: 1, maxLength: 500 } })
  assert.deepEqual(item.properties.scope_repair.maxItems, 12)
  assert.deepEqual(item.properties.classification.enum, ['confirmed', 'contradicted', 'insufficient', 'missing-material', 'scope-inadequate'])
  assert.deepEqual(PANEL_CHECK_RESULT_SCHEMA.properties.results.items.properties.classification.enum,
    ['confirmed', 'contradicted', 'insufficient', 'missing-material'])
  assert.deepEqual(SOURCE_AUDIT_RESULT_SCHEMA, { type: 'object', required: ['results'], additionalProperties: false, properties: { results: {
    type: 'array', items: { type: 'object', required: ['id', 'classification', 'rationale', 'evidence'], additionalProperties: false, properties: {
      id: { type: 'string' }, classification: { enum: ['confirmed', 'contradicted', 'insufficient'] }, rationale: { type: 'string', minLength: 1 },
      evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } } } } } })
  const opinion = buildOpinionAuditRequest({ request: { requirement: 'r', criteria: ['demo-supported-navigation'] },
    answer: { mismeasured_step: 's', measurement_fault: 'f' }, spans: [], logSpans: [] })
  assert.equal(opinion.schema, SOURCE_AUDIT_RESULT_SCHEMA)
  const ruled = LINE_CITED_RESULT_SCHEMA.properties.results.items
  assert.ok(ruled.required.includes('search_scope') && ruled.required.includes('missing_obligation'))
  assert.equal(ruled.properties.search_scope.maxItems, 12)
})
