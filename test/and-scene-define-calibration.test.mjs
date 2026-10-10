import { makeTempDir } from './temp-dir.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, rm, cp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRubric, checkJudgingInputs } from '../evals/agent-runner/and-scene-define/lib/rubric.mjs'
import { SUITE_ROOT } from '../evals/agent-runner/and-scene-define/lib/files.mjs'
import { accuracy, stability, basisShares, familyDistribution, rescoreDiff, deciderFlips, aggregateCalibration, loadCalibrationSet, allExpected, renderCalibrationMarkdown, CALIBRATION_MODE } from '../evals/agent-runner/and-scene-define/lib/calibration.mjs'
import { runCalibration, parseCalibrateArguments, assertAnchorsReviewed, CALIBRATE_HELP, CALIBRATION_CONCURRENCY, CALIBRATION_JOB_CONCURRENCY } from '../evals/agent-runner/and-scene-define/calibrate.mjs'
import { runDefinitionPanel, rerunDefinitionDecider } from '../evals/agent-runner/and-scene-define/lib/judge-jobs.mjs'
import { publicationEligibility, publishRun } from '../evals/agent-runner/and-scene-define/lib/publication.mjs'
import { parseArguments } from '../evals/agent-runner/and-scene-define/controller.mjs'

const inventory = JSON.parse(await readFile(join(SUITE_ROOT, 'hidden/inventory.json'), 'utf8'))
const realRubric = JSON.parse(await readFile(join(SUITE_ROOT, 'rubric.json'), 'utf8'))
const area = inventory.items.find(x => x.class === 'mandatory').area
const picked = [...inventory.items.filter(x => x.area === area && x.class === 'mandatory').slice(0, 1), ...inventory.items.filter(x => x.area === area && x.class === 'acceptable-alternative').slice(0, 3)]
const [A, B, C, D] = picked.map(x => x.id)
const subset = { ...inventory, items: picked, anchors_review: { reviewer: 'test maintainer', date: '2026-10-06', inventory_version: inventory.inventory_version } }
const rubric = buildRubric(subset)
const QUALITY = rubric.quality.map(x => x.id)

// ---------------------------------------------------------------- pure aggregation

// A scored repeat in the shape of judges/score.json.
function scored(total, verdicts, { votes = {}, bases = {}, gates = true } = {}) {
  const coverage = [A, B, C, D].map(id => ({ id, verdict: verdicts[id] ?? 'met' }))
  const quality = QUALITY.map(id => ({ id, verdict: verdicts[id] ?? 'met' }))
  const results = [...coverage, ...quality].map(x => ({ id: x.id, verdict: x.verdict, basis: bases[x.id] ?? `consensus-${x.verdict}` }))
  const allVotes = results.flatMap(x => (votes[x.id] ?? [x.verdict, x.verdict, x.verdict]).map((verdict, n) => ({ id: x.id, verdict, family: n ? 'codex' : 'claude', model: n ? 'gpt' : 'sonnet', panel_index: n })))
  return { total, components: { coverage: { score: total } }, gates: [{ id: 'gate:openspec-validate', passed: gates }], coverage, quality, fidelity: [],
    panel_records: [{ kind: 'coverage', record: { results: results.filter(x => !x.id.startsWith('quality:')), votes: allVotes.filter(x => !x.id.startsWith('quality:')) } }, { kind: 'quality', record: { results: results.filter(x => x.id.startsWith('quality:')), votes: allVotes.filter(x => x.id.startsWith('quality:')) } }] }
}
const expectations = (variant, expected, extra = {}) => ({ input_id: 'x', variant, expected, removed_items: [], contradicted_items: [], added_scope: [], quality_defects: [], planted_fidelity_contradictions: [], weakened_items: [], collateral_items: [], ...extra })

test('accuracy counts per-item agreement and a confusion matrix across repeats', () => {
  const result = accuracy({ [A]: 'met', [B]: 'missing' }, [scored(90, { [A]: 'met', [B]: 'met' }), scored(90, { [A]: 'met', [B]: 'missing' }), scored(80, { [A]: 'partial', [B]: 'missing' })])
  assert.equal(result.compared, 6); assert.equal(result.agreed, 4); assert.equal(result.agreement_rate, 0.6667)
  assert.equal(result.confusion.met.met, 2); assert.equal(result.confusion.met.partial, 1); assert.equal(result.confusion.missing.met, 1); assert.equal(result.confusion.missing.missing, 2)
  assert.deepEqual(result.items.find(x => x.id === B).judged, ['met', 'missing', 'missing'])
  assert.deepEqual(result.disagreeing_items, [A, B])
  assert.equal(result.by_kind.coverage.compared, 6)
  // Quality and fidelity expectations join coverage when present.
  const merged = allExpected({ expected: { [A]: 'met' }, expected_quality: { [QUALITY[0]]: 'missing' }, expected_fidelity: { 'fidelity:x': 'met' } })
  const withQuality = accuracy(merged, [scored(90, {})])
  assert.equal(withQuality.by_kind.quality.agreed, 0); assert.equal(withQuality.by_kind.coverage.agreed, 1)
})

test('stability reports total spread and every item whose verdict differs across repeats', () => {
  const result = stability([scored(90, {}), scored(84, { [C]: 'partial' }), scored(88, {})])
  assert.deepEqual(result.totals, [90, 84, 88]); assert.equal(result.spread, 6)
  assert.deepEqual(result.differing_items, [{ id: C, verdicts: ['met', 'partial', 'met'] }])
  assert.equal(result.items_differing, 1); assert.equal(result.items_judged, 9)
})

test('basis shares count each settled criterion by its settlement basis', () => {
  const result = basisShares([scored(90, { [B]: 'missing' }, { bases: { [A]: 'majority-met', [B]: 'decider-missing', [C]: 'checked-dissent-met' } })])
  assert.equal(result.total, 9)
  assert.deepEqual(result.counts, { majority: 1, decider: 1, 'checked-dissent': 1, consensus: 6 })
  assert.equal(result.shares.consensus, 0.6667)
})

test('family distributions sit beside the expected distribution and expose leniency', () => {
  // Codex credits met where Claude and the expectation say missing.
  const repeats = [scored(90, { [A]: 'missing' }, { votes: { [A]: ['missing', 'met', 'met'] } })]
  const result = familyDistribution([{ expected: { [A]: 'missing', [B]: 'met' }, repeats }])
  assert.deepEqual(result.expected.counts, { met: 1, partial: 0, missing: 1 })
  assert.deepEqual(result.families.codex.votes_on_expected_items.counts, { met: 4, partial: 0, missing: 0 })
  assert.deepEqual(result.families.claude.votes_on_expected_items.counts, { met: 1, partial: 0, missing: 1 })
  assert.equal(result.families.codex.leniency, 0.5); assert.equal(result.families.claude.leniency, 0)
  assert.equal(result.families.claude.agreement_rate, 1); assert.equal(result.families.codex.agreement_rate, 0.5)
  assert.deepEqual(result.families.codex.models, ['gpt'])
})

test('identical rescore lists every item whose verdict differs', () => {
  const diff = rescoreDiff('reference', scored(90, {}), scored(85, { [B]: 'partial', [QUALITY[1]]: 'missing' }))
  assert.equal(diff.available, true); assert.deepEqual(diff.totals, [90, 85])
  assert.deepEqual(diff.differing_items, [{ id: B, first: 'met', second: 'partial' }, { id: QUALITY[1], first: 'met', second: 'missing' }])
  assert.equal(rescoreDiff('reference', scored(90, {}), undefined).available, false)
})

test('decider flip rate counts re-run rulings that differ from the recorded ruling and names them', () => {
  const run = (b, check) => ({ rulings: [{ id: A, recorded: 'met', rerun: 'met', flipped: false }, { id: B, recorded: 'missing', rerun: b, flipped: b !== 'missing' }], checks: [{ id: C, panel_index: 2, recorded: 'confirmed', rerun: check, flipped: check !== 'confirmed' }] })
  const flips = deciderFlips([{ input_id: 'reference', repeat: 1, job: 'coverage:x', runs: [run('missing', 'confirmed'), run('partial', 'confirmed'), run('missing', 'contradicted')] }])
  assert.equal(flips.comparisons, 9); assert.equal(flips.flips, 2); assert.equal(flips.flip_rate, 0.2222)
  assert.equal(flips.reruns_per_record, 3); assert.equal(flips.criteria_rerun, 3)
  assert.deepEqual(flips.flipped_items.map(x => [x.id, x.kind, x.reruns]), [[B, 'decider', ['missing', 'partial', 'missing']], [C, 'dissent-check', ['confirmed', 'confirmed', 'contradicted']]])
  assert.match(flips.note, /separately from panel spread/)
})

const input = (input_id, exp, repeats) => ({ input_id, expectations: { ...exp, input_id }, input_hash: 'h', repeats })
const allMet = { [A]: 'met', [B]: 'met', [C]: 'met', [D]: 'met' }

test('failures name the input and item: removed mandatory judged met, restructured loss beyond tolerance, spread beyond limit', () => {
  const report = aggregateCalibration({ rubric, inputs: [
    input('reference', expectations('reference', allMet), [scored(95, {}), scored(95, {}), scored(95, {})]),
    // Loses A (weight 2), C and D (1 each) = 4 > tolerance 3.
    input('restructured', expectations('reference', allMet), [scored(90, {}), scored(80, { [A]: 'missing', [C]: 'missing', [D]: 'missing' }), scored(90, {})]),
    input('degraded', expectations('degraded', { ...allMet, [A]: 'missing' }, { removed_items: [A, B] }), [scored(30, { [A]: 'missing' }), scored(31, { [A]: 'met' }), scored(30, { [A]: 'missing' })]),
  ] })
  const codes = report.failures.map(x => [x.code, x.input_id])
  assert.deepEqual(codes, [['restructured-loss-beyond-tolerance', 'restructured'], ['spread-beyond-limit', 'restructured'], ['removed-mandatory-undetected', 'degraded']])
  const removed = report.failures.find(x => x.code === 'removed-mandatory-undetected')
  assert.deepEqual(removed.items, [A]); assert.deepEqual(removed.repeats, [2]); assert.match(removed.message, new RegExp(`degraded.*${A}`))
  const loss = report.failures.find(x => x.code === 'restructured-loss-beyond-tolerance')
  assert.deepEqual(loss.items, [A, C, D]); assert.equal(loss.lost_weight, 4); assert.equal(loss.tolerance, 3)
  assert.equal(report.inputs[1].restructured.versus_reference.difference, 8.3333)
  assert.equal(report.failures.find(x => x.code === 'spread-beyond-limit').spread, 10)
  assert.equal(report.passed, false); assert.equal(report.mode, CALIBRATION_MODE)
  // Within tolerance and limits: no failure.
  const ok = aggregateCalibration({ rubric, inputs: [
    input('reference', expectations('reference', allMet), [scored(95, {}), scored(95, {}), scored(95, {})]),
    input('restructured', expectations('reference', allMet), [scored(92, { [A]: 'partial', [C]: 'missing' }), scored(92, {}), scored(92, {})]),
    input('degraded', expectations('degraded', allMet, { removed_items: [A] }), [scored(30, { [A]: 'missing' }), scored(30, { [A]: 'partial' }), scored(30, { [A]: 'missing' })]),
  ] })
  assert.deepEqual(ok.failures, []); assert.equal(ok.passed, true)
  assert.equal(ok.identical_rescore.input_id, 'reference')
  // Plans get a score only, so calibration proposes no pass threshold.
  assert.equal('threshold' in ok, false)
  assert.doesNotMatch(renderCalibrationMarkdown(ok), /threshold/i)
  assert.match(renderCalibrationMarkdown(ok), /\| degraded \| degraded \|/)
})

// ---------------------------------------------------------------- the committed set

test('the committed calibration set loads without model calls and every input covers all 72 graded items', async () => {
  const set = await loadCalibrationSet(join(SUITE_ROOT, 'calibration'), { rubric: realRubric })
  assert.equal(set.manifest_present, true)
  assert.ok(set.inputs.length >= 4)
  const graded = realRubric.coverage.map(x => x.id).sort()
  assert.equal(graded.length, 72)
  for (const x of set.inputs) {
    assert.deepEqual(Object.keys(x.expectations.expected).sort(), graded, x.input_id)
    for (const name of ['proposal.md', 'design.md', 'test-plan.md']) assert.ok(x.artifacts[name], `${x.input_id} ${name}`)
    assert.ok(Object.keys(x.artifacts).some(p => /^specs\/.+\/spec\.md$/.test(p)))
    assert.ok(!Object.keys(x.artifacts).some(p => p.startsWith('collected/') || p === 'expectations.json'))
    if (x.expectations.expected_fidelity) assert.ok(x.conversation.length)
    assert.ok(['reference', 'degraded'].includes(x.expectations.variant), x.input_id)
    assert.equal('expected_outcome' in x.expectations, false); assert.equal('expected_fail_mark' in x.expectations, false)
  }
  assert.ok(set.inputs.some(x => x.input_id === 'reference' && x.expectations.variant === 'reference'))
  assert.ok(set.inputs.some(x => x.input_id.startsWith('restructured') && x.expectations.variant === 'reference'))
})

test('expectations name each input a reference or a degraded variant and carry no pass/fail outcome', async () => {
  const { validateExpectations } = await import('../evals/agent-runner/and-scene-define/lib/calibration.mjs')
  const ok = { ...expectations('degraded', allMet), input_id: 'degraded' }
  assert.deepEqual(validateExpectations(ok, { rubric, dirName: 'degraded' }), [])
  assert.ok(validateExpectations({ ...ok, variant: 'fail' }, { rubric, dirName: 'degraded' }).some(x => /variant must be reference or degraded/.test(x)))
  assert.ok(validateExpectations({ ...ok, expected_outcome: 'fail' }, { rubric, dirName: 'degraded' }).some(x => /expected_outcome.*no pass\/fail/.test(x)))
  assert.ok(validateExpectations({ ...ok, expected_fail_mark: 'proposed' }, { rubric, dirName: 'degraded' }).some(x => /expected_fail_mark.*no pass\/fail/.test(x)))
})

test('the loader verifies manifest hashes and rejects unlisted or altered files', async t => {
  const dir = await makeTempDir(join(tmpdir(), 'define-calibration-set-')); t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(join(SUITE_ROOT, 'calibration'), dir, { recursive: true })
  await writeFile(join(dir, 'reference/collected/proposal.md'), 'tampered\n')
  await assert.rejects(loadCalibrationSet(dir, { rubric: realRubric }), /reference: manifest hash mismatch for collected\/proposal.md/)
  await cp(join(SUITE_ROOT, 'calibration/reference/collected/proposal.md'), join(dir, 'reference/collected/proposal.md'))
  await writeFile(join(dir, 'reference/collected/extra.md'), 'unlisted\n')
  await assert.rejects(loadCalibrationSet(dir, { rubric: realRubric }), /collected\/extra.md is not in the manifest/)
})

// ---------------------------------------------------------------- decider re-run

const span = { path: 'proposal.md', start_line: 1, end_line: 1, gate: null, exchange: null }
const fileCite = { path: 'proposal.md', start_line: null, end_line: null, gate: null, exchange: null }
const vote = (id, verdict) => ({ id, verdict, rationale: 'The cited commitment decides the requirement.', evidence: ['inspected'], citations: [verdict === 'missing' ? fileCite : span], subject_id: null, added_scope: [] })

test('rerunDefinitionDecider re-runs only the decider on the recorded panel outputs and reports flips', async () => {
  const job = { name: 'coverage:test', kind: 'coverage', criteria: [A, B], inputs: { artifacts: { 'proposal.md': 'One evolving scene.\n' }, gates: [], conversation: [], items: picked.slice(0, 2) } }
  const votes = { [A]: ['met', 'missing', 'missing'], [B]: ['missing', 'missing', 'met'] }
  const panel = [0, 1, 2].map(n => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high', invoke: async req => JSON.stringify({ results: req.criteria.map(id => vote(id, votes[id][n])) }) }))
  const calls = []
  let rerun = 0
  const decider = { family: 'claude', model: 'stub-decider', effort: 'high', invoke: async req => {
    calls.push(req.usage_phase)
    // The decider's rejection of A's met vote is checked and refuted, on every run.
    if (req.audit_stage === 'ruling-dissent-check') return JSON.stringify({ results: req.criteria.map(id => ({ id, classification: 'contradicted', rationale: 'Checked.', evidence: ['source'] })) })
    if (req.audit_stage) return JSON.stringify({ results: req.criteria.map(id => ({ id, classification: req.usage_phase === 'dissent-check-rerun' && rerun === 2 ? 'contradicted' : 'confirmed', rationale: 'Checked.', evidence: ['source'] })) })
    if (req.usage_phase === 'decider-rerun') rerun++
    return JSON.stringify({ results: req.criteria.map(id => vote(id, req.usage_phase === 'decider-rerun' && rerun === 2 ? 'met' : 'missing')) })
  } }
  const outcome = await runDefinitionPanel({ job, panel, decider })
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failure))
  assert.equal(outcome.results.find(x => x.id === A).basis, 'decider-missing')
  assert.equal(outcome.results.find(x => x.id === B).basis, 'checked-dissent-met')
  calls.length = 0
  const before = JSON.stringify(outcome.record)
  const runs = []
  for (let n = 0; n < 3; n++) runs.push(await rerunDefinitionDecider({ job, decider, record: outcome.record }))
  assert.equal(JSON.stringify(outcome.record), before)
  // The second re-run's met overrules the two Codex judges, so it is checked first.
  // Each run then re-runs B's dissent check and the recorded check of A's rejected vote.
  assert.deepEqual(calls, ['decider-rerun', 'dissent-check-rerun', 'dissent-check-rerun', 'decider-rerun', 'overrule-check-rerun',
    'dissent-check-rerun', 'dissent-check-rerun', 'decider-rerun', 'dissent-check-rerun', 'dissent-check-rerun'])
  assert.deepEqual(runs.map(r => r.rulings[0].rerun), ['missing', 'met', 'missing'])
  assert.deepEqual(runs.map(r => r.rulings[0].overrule_check), [null, 'confirmed', null])
  assert.deepEqual(runs.map(r => r.checks[0].rerun), ['confirmed', 'contradicted', 'confirmed'])
  assert.deepEqual(runs.map(r => [r.checks[1].id, r.checks[1].stage, r.checks[1].rerun, r.checks[1].flipped]), Array(3).fill([A, 'ruling-dissent-check', 'contradicted', false]))
  const flips = deciderFlips([{ input_id: 'reference', repeat: 1, job: job.name, runs }])
  assert.equal(flips.flips, 2); assert.deepEqual(flips.flipped_items.map(x => x.id), [A, B])
})

// INT-003: the INV-093 shape re-run. Claude `met`, both Codex judges `partial`;
// the recorded decider ruled `met` and its overrule check did not confirm it,
// so the recorded verdict is the two-vote `partial`. Each re-run ruling that
// overrules is checked, and flips count on the verdict after that check.
test('rerunDefinitionDecider checks each re-run overrule and reports flips on the final verdict', async () => {
  const job = { name: 'coverage:test', kind: 'coverage', criteria: [A], inputs: { artifacts: { 'proposal.md': 'One evolving scene.\n' }, gates: [], conversation: [], items: picked.slice(0, 1) } }
  const panel = ['met', 'partial', 'partial'].map((verdict, n) => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high', invoke: async req => JSON.stringify({ results: req.criteria.map(id => vote(id, verdict)) }) }))
  // Recorded run, then three re-runs: met unconfirmed, met confirmed, partial.
  const rulings = ['met', 'met', 'met', 'partial']
  const checks = ['contradicted', 'insufficient', 'confirmed']
  const calls = []
  const decider = { family: 'claude', model: 'stub-decider', effort: 'high', invoke: async req => {
    calls.push(req.usage_phase)
    if (req.audit_stage) {
      assert.equal(req.audit_stage, 'overrule-check'); assert.equal(req.authority.model, 'stub-decider')
      return JSON.stringify({ results: req.criteria.map(id => ({ id, classification: checks.shift(), rationale: 'Checked.', evidence: ['source'] })) })
    }
    const verdict = rulings.shift()
    return JSON.stringify({ results: req.criteria.map(id => vote(id, verdict)) })
  } }
  const outcome = await runDefinitionPanel({ job, panel, decider })
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failure))
  assert.equal(outcome.results[0].basis, 'majority-partial')
  calls.length = 0
  const runs = []
  for (let n = 0; n < 3; n++) runs.push(await rerunDefinitionDecider({ job, decider, record: outcome.record }))
  assert.deepEqual(calls, ['decider-rerun', 'overrule-check-rerun', 'decider-rerun', 'overrule-check-rerun', 'decider-rerun'])
  assert.deepEqual(runs.map(r => r.rulings[0]), [
    { id: A, recorded: 'partial', rerun: 'partial', flipped: false, recorded_ruling: 'met', rerun_ruling: 'met', overrule_check: 'insufficient' },
    { id: A, recorded: 'partial', rerun: 'met', flipped: true, recorded_ruling: 'met', rerun_ruling: 'met', overrule_check: 'confirmed' },
    { id: A, recorded: 'partial', rerun: 'partial', flipped: false, recorded_ruling: 'met', rerun_ruling: 'partial', overrule_check: null },
  ])
  const flips = deciderFlips([{ input_id: 'restructured-degraded-quality', repeat: 1, job: job.name, runs }])
  assert.equal(flips.flips, 1); assert.equal(flips.comparisons, 3)
  // A re-run still accepts only a complete record under the current protocol.
  await assert.rejects(rerunDefinitionDecider({ job, decider, record: { ...outcome.record, protocol: 'cross-family-panel-v1' } }), /complete panel record/)
  await assert.rejects(rerunDefinitionDecider({ job, decider, record: { ...outcome.record, ok: false } }), /complete panel record/)
})

// ---------------------------------------------------------------- end to end with stub judges

async function suiteFixture(t, { reviewed = true } = {}) {
  const root = await makeTempDir(join(tmpdir(), 'define-calibrate-')); t.after(() => rm(root, { recursive: true, force: true }))
  const suiteRoot = join(root, 'suite')
  await mkdir(join(suiteRoot, 'hidden/reference'), { recursive: true })
  await writeFile(join(suiteRoot, 'hidden/inventory.json'), JSON.stringify(reviewed ? subset : { ...subset, anchors_review: null }))
  await writeFile(join(suiteRoot, 'rubric.json'), JSON.stringify(rubric))
  await writeFile(join(suiteRoot, 'hidden/reference/proposal.md'), 'reference\n')
  await writeFile(join(suiteRoot, 'hidden/simulated-user-policy.md'), 'policy\n')
  const calibrationDir = join(root, 'calibration')
  const write = async (id, exp) => {
    for (const name of ['proposal.md', 'design.md', 'test-plan.md', 'specs/scene/spec.md']) {
      await mkdir(join(calibrationDir, id, 'collected', name, '..'), { recursive: true })
      await writeFile(join(calibrationDir, id, 'collected', name), `CALIBRATION-INPUT ${id}\nCommitment text.\n`)
    }
    await writeFile(join(calibrationDir, id, 'expectations.json'), JSON.stringify({ ...exp, input_id: id, description: `${id} fixture` }))
  }
  await write('reference', expectations('reference', allMet, { expected_quality: Object.fromEntries(QUALITY.map(id => [id, 'met'])) }))
  await write('restructured', expectations('reference', allMet))
  await write('degraded', expectations('degraded', { ...allMet, [A]: 'missing' }, { removed_items: [A] }))
  await mkdir(join(calibrationDir, 'real-candidates')); await writeFile(join(calibrationDir, 'real-candidates/README.md'), 'Empty slot.\n')
  return { root, suiteRoot, calibrationDir, outDir: join(root, 'out') }
}

// Scripted panel: per input, each criterion's three votes (Claude first) may
// depend on the repeat. The decider rules the first vote it sees for the
// recorded run and alternates on re-runs.
function stubJudges() {
  const calls = []
  const counters = new Map()
  const script = {
    reference: { [A]: () => ['met', 'met', 'met'], [B]: () => ['met', 'missing', 'missing'], [C]: () => ['met', 'met', 'missing'], [D]: () => ['missing', 'missing', 'met'] },
    restructured: { [A]: () => ['missing', 'missing', 'missing'], [C]: () => ['missing', 'missing', 'missing'], [D]: () => ['missing', 'missing', 'missing'] },
    degraded: { [A]: r => r === 2 ? ['met', 'met', 'met'] : ['missing', 'missing', 'missing'], [B]: () => ['missing', 'missing', 'missing'], [C]: () => ['missing', 'missing', 'missing'], [D]: () => ['missing', 'missing', 'missing'] },
  }
  const inputOf = prompt => prompt.match(/CALIBRATION-INPUT (\S+?)(\\n|\s)/)[1]
  const panel = [0, 1, 2].map(n => ({ family: n ? 'codex' : 'claude', model: n ? 'stub-codex' : 'stub-claude', effort: 'high', invoke: async req => {
    const id = inputOf(req.prompt)
    const key = `${id}:${req.job}:${n}`
    const repeat = (counters.get(key) ?? 0) + 1; counters.set(key, repeat)
    calls.push({ who: n, input: id, job: req.job, repeat })
    return JSON.stringify({ results: req.criteria.map(c => vote(c, c.startsWith('quality:') ? (id === 'degraded' ? 'missing' : 'met') : (script[id][c]?.(repeat) ?? ['met', 'met', 'met'])[n])) })
  } }))
  let reruns = 0
  const decider = { family: 'claude', model: 'stub-decider', effort: 'high', invoke: async req => {
    calls.push({ who: 'decider', input: inputOf(req.prompt), stage: req.usage_phase })
    // Dissent checks confirm; no overrule check, or check of a vote the ruling rejected, does.
    if (req.audit_stage) return JSON.stringify({ results: req.criteria.map(id => ({ id, classification: req.audit_stage === 'overrule-check' || req.audit_stage === 'ruling-dissent-check' ? 'contradicted' : 'confirmed', rationale: 'Checked.', evidence: ['source'] })) })
    if (req.usage_phase === 'decider-rerun') reruns++
    return JSON.stringify({ results: req.criteria.map(id => vote(id, req.usage_phase === 'decider-rerun' && reruns % 2 === 1 ? 'met' : 'missing')) })
  } }
  return { judges: { panel, decider }, calls }
}
const gateCommand = async () => ({ status: 0, stdout: '', stderr: '' })

test('--calibrate judges each input three independent times through the candidate judging path and reports every diagnostic', async t => {
  const f = await suiteFixture(t)
  const { judges, calls } = stubJudges()
  // The script keys votes to call order, so judge one repeat at a time.
  const { report, exitCode } = await runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, repeats: 3, repoRoot: f.root, concurrency: 1 }, { judges, gateCommand })
  // Each input: one coverage job and one quality job, three panel judges, three repeats, no reuse.
  for (const id of ['reference', 'restructured', 'degraded']) {
    assert.equal(calls.filter(x => x.input === id && x.who !== 'decider').length, 3 * 2 * 3, id)
    assert.deepEqual([...new Set(calls.filter(x => x.input === id && x.who === 0).map(x => x.repeat))], [1, 2, 3])
  }
  assert.equal(report.repeats, 3); assert.equal(report.inputs.length, 3)
  const ref = report.inputs.find(x => x.input_id === 'reference')
  assert.equal(ref.scores.per_repeat.length, 3); assert.equal(ref.stability.spread, 0)
  assert.deepEqual(Object.keys(ref.basis_shares.counts).sort(), ['checked-dissent', 'consensus', 'decider', 'majority'])
  assert.equal(ref.basis_shares.counts.decider, 3); assert.equal(ref.basis_shares.counts['checked-dissent'], 3)
  assert.equal(ref.accuracy.by_kind.quality.agreement_rate, 1)
  // The script's Codex judges withhold credit the expectations give (B, C, D on the reference).
  assert.ok(report.overall.family_distribution.families.codex.leniency < report.overall.family_distribution.families.claude.leniency)
  // Decider re-runs: three per first-repeat record that reached the decider or a dissent check.
  assert.equal(calls.filter(x => x.stage === 'decider-rerun').length, 3)
  // Each re-run repeats D's dissent check and the check of the met vote B's ruling rejected.
  assert.equal(calls.filter(x => x.stage === 'dissent-check-rerun').length, 6)
  // Re-runs 1 and 3 rule met against the two Codex judges' missing. Each overrule
  // is checked before it counts, and neither check confirms, so nothing flips.
  assert.equal(calls.filter(x => x.stage === 'overrule-check-rerun').length, 2)
  assert.equal(report.decider_flips.flips, 0); assert.deepEqual(report.decider_flips.flipped_items, [])
  assert.deepEqual(report.decider_flips.items.find(x => x.id === B && x.kind === 'decider').reruns, ['missing', 'missing', 'missing'])
  assert.equal(report.identical_rescore.input_id, 'reference'); assert.equal(report.identical_rescore.available, true)
  assert.deepEqual(report.identical_rescore.differing_items, [])
  // Scripted failures: restructured loses A, C, D (4 > 3); degraded's removed A met in repeat 2 and spreads.
  assert.deepEqual(report.failures.map(x => [x.code, x.input_id]).sort(), [['removed-mandatory-undetected', 'degraded'], ['restructured-loss-beyond-tolerance', 'restructured'], ['spread-beyond-limit', 'degraded']])
  assert.equal(exitCode, 1)
  const written = JSON.parse(await readFile(join(f.outDir, 'calibration-report.json'), 'utf8'))
  assert.equal(written.mode, 'calibration'); assert.equal(written.published, false)
  assert.match(await readFile(join(f.outDir, 'calibration-report.md'), 'utf8'), /Decider ruling flips/)
  assert.equal(written.usage.ledger, 'phases/eval-owned-usage.jsonl')
  assert.deepEqual((await readdir(join(f.outDir, 'inputs/reference'))).sort(), ['repeat-1', 'repeat-2', 'repeat-3'])
})

// Order-independent panel: every vote depends only on the input, and each call
// waits briefly so concurrently judged repeats overlap.
function steadyJudges({ failOn } = {}) {
  let inFlight = 0; let peak = 0; const started = []
  const inputOf = prompt => {
    const marker = prompt.match(/CALIBRATION-INPUT (\S+?)(\\n|\s)/)
    if (!marker) throw new Error('no CALIBRATION-INPUT marker in the judge prompt')
    return marker[1]
  }
  const answer = async (id, criteria, verdictOf) => {
    inFlight++; peak = Math.max(peak, inFlight); started.push(id)
    try {
      await new Promise(done => setTimeout(done, 5))
      if (id === failOn) throw Object.assign(new Error(`judge down for ${id}`), { retryable: false })
      return JSON.stringify({ results: criteria.map(c => vote(c, verdictOf(c))) })
    } finally { inFlight-- }
  }
  const verdictOf = id => c => c.startsWith('quality:') ? (id === 'degraded' ? 'missing' : 'met') : (id === 'degraded' && c === A ? 'missing' : 'met')
  const panel = [0, 1, 2].map(n => ({ family: n ? 'codex' : 'claude', model: n ? 'stub-codex' : 'stub-claude', effort: 'high', invoke: req => answer(inputOf(req.prompt), req.criteria, verdictOf(inputOf(req.prompt))) }))
  const decider = { family: 'claude', model: 'stub-decider', effort: 'high', invoke: req => answer(inputOf(req.prompt), req.criteria, verdictOf(inputOf(req.prompt))) }
  return { judges: { panel, decider }, stats: { get peak() { return peak }, get inFlight() { return inFlight }, started } }
}

test('calibration judges several repeats at once and reports them in input and repeat order', async t => {
  const sequential = await suiteFixture(t)
  const one = await runCalibration({ suiteRoot: sequential.suiteRoot, calibrationDir: sequential.calibrationDir, outDir: sequential.outDir, repoRoot: sequential.root, concurrency: 1 }, { judges: steadyJudges().judges, gateCommand })
  const f = await suiteFixture(t)
  const { judges, stats } = steadyJudges()
  const many = await runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, repoRoot: f.root, concurrency: 4 }, { judges, gateCommand })
  // Three panel seats per job; more than one job in flight means repeats overlapped.
  assert.ok(stats.peak > 3, `peak in-flight judge calls ${stats.peak}`)
  assert.deepEqual(many.report.inputs.map(x => x.input_id), one.report.inputs.map(x => x.input_id))
  assert.deepEqual(many.report.inputs.map(x => x.scores.per_repeat), one.report.inputs.map(x => x.scores.per_repeat))
  assert.deepEqual(many.report.failures, one.report.failures)
  for (const id of ['reference', 'restructured', 'degraded']) assert.deepEqual((await readdir(join(f.outDir, 'inputs', id))).sort(), ['repeat-1', 'repeat-2', 'repeat-3'])
})

// INT-007 / E2E-006 setup: calibration already judges repeats concurrently, so
// the jobs within each repeat run one at a time while repeats keep their own
// concurrency of six.
test('calibration judges the jobs within a repeat one at a time while repeats keep concurrency 6', async t => {
  assert.equal(CALIBRATION_JOB_CONCURRENCY, 1); assert.equal(CALIBRATION_CONCURRENCY, 6)
  const f = await suiteFixture(t)
  const { judges } = steadyJudges()
  // Each repeat has a coverage and a quality job; with one repeat at a time,
  // more than one job in flight would mean the repeat ran its jobs together.
  const active = new Map(); let peak = 0
  const track = member => ({ ...member, invoke: async req => {
    active.set(req.job, (active.get(req.job) ?? 0) + 1)
    peak = Math.max(peak, [...active.values()].filter(n => n > 0).length)
    try { return await member.invoke(req) } finally { active.set(req.job, active.get(req.job) - 1) }
  } })
  await runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, repoRoot: f.root, concurrency: 1 },
    { judges: { panel: judges.panel.map(track), decider: track(judges.decider) }, gateCommand })
  assert.equal(peak, 1)
  const dry = await runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: join(f.root, 'dry'), repoRoot: f.root, dryRun: true })
  assert.equal(dry.plan.concurrency, CALIBRATION_CONCURRENCY)
})

test('a failed repeat stops new calibration work, lets in-flight repeats finish, and fails the calibration', async t => {
  const f = await suiteFixture(t)
  // Inputs run in set order, so two workers take degraded's first two repeats.
  const { judges, stats } = steadyJudges({ failOn: 'degraded' })
  const lines = []
  await assert.rejects(runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, repoRoot: f.root, concurrency: 2 }, { judges, gateCommand, log: line => lines.push(line) }), /judge down for degraded/)
  // Both concurrent failures are logged, not only the first.
  assert.equal(lines.filter(x => /^calibration failed: degraded repeat \d: .*judge down/.test(x)).length, 2)
  assert.equal(stats.inFlight, 0)
  assert.deepEqual([...new Set(stats.started)], ['degraded'])
  await assert.rejects(readFile(join(f.outDir, 'calibration-report.json')), { code: 'ENOENT' })
})

test('real judging is refused while anchors are unreviewed (HT-003); a dry run makes no calls and writes nothing', async t => {
  const f = await suiteFixture(t, { reviewed: false })
  const { judges, calls } = stubJudges()
  await assert.rejects(runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, repoRoot: f.root }, { judges, gateCommand }), new RegExp(`anchors need maintainer review \\(HT-003\\) for inventory version ${inventory.inventory_version}`))
  assert.equal(calls.length, 0)
  await assert.rejects(readdir(f.outDir), { code: 'ENOENT' })
  assert.throws(() => assertAnchorsReviewed({ inventory_version: 3, anchors_review: { reviewer: 'm', date: '2026-10-06', inventory_version: 2 } }), /HT-003.*version 3/)
  const dry = await runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, dryRun: true, repoRoot: f.root }, { judges, gateCommand })
  assert.equal(dry.dryRun, true); assert.equal(dry.plan.inputs.length, 3); assert.equal(dry.plan.repeats, 3); assert.equal(dry.plan.concurrency, 6)
  assert.equal(calls.length, 0)
  await assert.rejects(readdir(f.outDir), { code: 'ENOENT' })
})

test('calibrate arguments: at least three repeats, host-only default output, one mode', async () => {
  const now = new Date('2026-10-06T12:00:00Z')
  const options = parseCalibrateArguments(['--calibrate'], { now, repoRoot: '/repo' })
  assert.equal(options.repeats, 3); assert.equal(options.outDir, '/repo/artifacts/evals/and-scene-define-calibration/2026-10-06T12-00-00-000Z')
  assert.equal(parseCalibrateArguments(['--calibrate', '--repeats', '5', '--dry-run'], { now }).repeats, 5)
  assert.equal(parseCalibrateArguments(['--calibrate', '--dry-run'], { now }).dryRun, true)
  assert.throws(() => parseCalibrateArguments(['--calibrate', '--repeats', '2']), /at least 3/)
  assert.equal(options.concurrency, 6)
  assert.equal(parseCalibrateArguments(['--calibrate', '--concurrency', '2'], { now }).concurrency, 2)
  assert.throws(() => parseCalibrateArguments(['--calibrate', '--concurrency', '0']), /--concurrency must be an integer of at least 1/)
  // Both the suite help and the calibrate help name every calibration option.
  for (const help of [(await import('../evals/agent-runner/and-scene-define/controller.mjs')).HELP, CALIBRATE_HELP]) assert.match(help, /--concurrency N/)
  assert.throws(() => parseCalibrateArguments(['--calibrate', '--run-agent']), /exactly one mode/)
  assert.throws(() => parseArguments(['--calibrate']), /run\.sh \(calibrate\.mjs\)/)
})

test('calibration output is never published', async t => {
  const f = await suiteFixture(t)
  await assert.rejects(runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: join(f.root, 'evals/agent-runner/and-scene-define/results/cal'), repoRoot: f.root }, { judges: stubJudges().judges, gateCommand }), /never be written under the published results/)
  const report = aggregateCalibration({ rubric, inputs: [input('reference', expectations('reference', allMet), [scored(95, {}), scored(95, {}), scored(95, {})])] })
  assert.equal(publicationEligibility(report), false)
  assert.equal(publicationEligibility({ ...report, evaluation_status: 'complete', total: 95 }), false)
  const git = async () => { throw new Error('publication must not run git for calibration') }
  assert.deepEqual(await publishRun({ runDir: f.root, repoDir: f.root, result: report, git }), { skipped: true, published: false, commit: null })
})

test('candidate runs never require calibration output', async t => {
  // A reviewed suite with no calibration set and no calibration report passes judging-input preflight; no pass threshold is needed.
  const root = await makeTempDir(join(tmpdir(), 'define-no-calibration-')); t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'rubric.json'), JSON.stringify(rubric))
  await checkJudgingInputs({ suiteRoot: root, inventory: subset })
  for (const file of ['controller.mjs', 'lib/preflight.mjs', 'lib/judging.mjs', 'lib/rescore.mjs']) {
    const source = await readFile(join(SUITE_ROOT, file), 'utf8')
    assert.doesNotMatch(source, /^import .*calibrat|calibration-report|(?<![-\w])calibration\//m, file)
  }
})
