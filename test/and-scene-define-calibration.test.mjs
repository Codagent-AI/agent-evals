import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm, cp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRubric, checkJudgingInputs } from '../evals/agent-runner/and-scene-define/lib/rubric.mjs'
import { SUITE_ROOT } from '../evals/agent-runner/and-scene-define/lib/files.mjs'
import { accuracy, stability, basisShares, familyDistribution, rescoreDiff, deciderFlips, proposeThreshold, aggregateCalibration, loadCalibrationSet, allExpected, renderCalibrationMarkdown, CALIBRATION_MODE } from '../evals/agent-runner/and-scene-define/lib/calibration.mjs'
import { runCalibration, parseCalibrateArguments, assertAnchorsReviewed } from '../evals/agent-runner/and-scene-define/calibrate.mjs'
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
const expectations = (outcome, expected, extra = {}) => ({ input_id: 'x', expected_outcome: outcome, expected_fail_mark: outcome === 'fail' ? 'proposed' : null, expected, removed_items: [], contradicted_items: [], added_scope: [], quality_defects: [], planted_fidelity_contradictions: [], weakened_items: [], collateral_items: [], ...extra })

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
    input('reference', expectations('pass', allMet), [scored(95, {}), scored(95, {}), scored(95, {})]),
    // Loses A (weight 2), C and D (1 each) = 4 > tolerance 3.
    input('restructured', expectations('pass', allMet), [scored(90, {}), scored(80, { [A]: 'missing', [C]: 'missing', [D]: 'missing' }), scored(90, {})]),
    input('degraded', expectations('fail', { ...allMet, [A]: 'missing' }, { removed_items: [A, B] }), [scored(30, { [A]: 'missing' }), scored(31, { [A]: 'met' }), scored(30, { [A]: 'missing' })]),
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
    input('reference', expectations('pass', allMet), [scored(95, {}), scored(95, {}), scored(95, {})]),
    input('restructured', expectations('pass', allMet), [scored(92, { [A]: 'partial', [C]: 'missing' }), scored(92, {}), scored(92, {})]),
    input('degraded', expectations('fail', allMet, { removed_items: [A] }), [scored(30, { [A]: 'missing' }), scored(30, { [A]: 'partial' }), scored(30, { [A]: 'missing' })]),
  ] })
  assert.deepEqual(ok.failures, []); assert.equal(ok.passed, true)
  assert.equal(ok.threshold.proposed, 61); assert.equal(ok.identical_rescore.input_id, 'reference')
  assert.match(renderCalibrationMarkdown(ok), /Proposed pass threshold[\s\S]*\*\*61\*\*/)
})

test('threshold is the midpoint between expected-fail and expected-pass scores, or a named failure when they overlap', () => {
  const pass = input('reference', expectations('pass', allMet), [scored(80, {}), scored(78, {}), scored(82, {})])
  const fail = input('degraded', expectations('fail', allMet), [scored(50, {}), scored(60, {}), scored(55, {})])
  // Unmarked variants and gate-failed repeats do not bound the threshold.
  const unmarked = input('unmarked', { ...expectations('fail', allMet), expected_fail_mark: null }, [scored(95, {})])
  const gateFailed = input('gate-failed', expectations('fail', allMet), [scored(99, {}, { gates: false })])
  const separated = proposeThreshold([pass, fail, unmarked, gateFailed])
  assert.equal(separated.separable, true); assert.equal(separated.proposed, 69)
  assert.deepEqual(separated.highest_fail, { input_id: 'degraded', total: 60 }); assert.deepEqual(separated.lowest_pass, { input_id: 'reference', total: 78 })
  const overlapping = input('degraded', expectations('fail', allMet), [scored(79, {}), scored(60, {}), scored(55, {})])
  const report = aggregateCalibration({ rubric, inputs: [pass, overlapping] })
  assert.equal(report.threshold.proposed, null); assert.equal(report.threshold.separable, false)
  const failure = report.failures.find(x => x.code === 'threshold-cannot-separate')
  assert.match(failure.message, /threshold cannot separate.*degraded.*79.*reference.*78/)
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
    if (x.expectations.expected_outcome === 'fail') assert.equal(x.expectations.expected_fail_mark, 'proposed')
  }
  assert.ok(set.inputs.some(x => x.input_id === 'reference' && x.expectations.expected_outcome === 'pass'))
  assert.ok(set.inputs.some(x => x.input_id.startsWith('restructured') && x.expectations.expected_outcome === 'pass'))
})

test('the loader verifies manifest hashes and rejects unlisted or altered files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'define-calibration-set-')); t.after(() => rm(dir, { recursive: true, force: true }))
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
  assert.deepEqual(calls, ['decider-rerun', 'dissent-check-rerun', 'decider-rerun', 'dissent-check-rerun', 'decider-rerun', 'dissent-check-rerun'])
  assert.deepEqual(runs.map(r => r.rulings[0].rerun), ['missing', 'met', 'missing'])
  assert.deepEqual(runs.map(r => r.checks[0].rerun), ['confirmed', 'contradicted', 'confirmed'])
  const flips = deciderFlips([{ input_id: 'reference', repeat: 1, job: job.name, runs }])
  assert.equal(flips.flips, 2); assert.deepEqual(flips.flipped_items.map(x => x.id), [A, B])
})

// ---------------------------------------------------------------- end to end with stub judges

async function suiteFixture(t, { reviewed = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'define-calibrate-')); t.after(() => rm(root, { recursive: true, force: true }))
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
  await write('reference', expectations('pass', allMet, { expected_quality: Object.fromEntries(QUALITY.map(id => [id, 'met'])) }))
  await write('restructured', expectations('pass', allMet))
  await write('degraded', expectations('fail', { ...allMet, [A]: 'missing' }, { removed_items: [A] }))
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
    if (req.audit_stage) return JSON.stringify({ results: req.criteria.map(id => ({ id, classification: 'confirmed', rationale: 'Checked.', evidence: ['source'] })) })
    if (req.usage_phase === 'decider-rerun') reruns++
    return JSON.stringify({ results: req.criteria.map(id => vote(id, req.usage_phase === 'decider-rerun' && reruns % 2 === 1 ? 'met' : 'missing')) })
  } }
  return { judges: { panel, decider }, calls }
}
const gateCommand = async () => ({ status: 0, stdout: '', stderr: '' })

test('--calibrate judges each input three independent times through the candidate judging path and reports every diagnostic', async t => {
  const f = await suiteFixture(t)
  const { judges, calls } = stubJudges()
  const { report, exitCode } = await runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, repeats: 3, repoRoot: f.root }, { judges, gateCommand })
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
  assert.equal(calls.filter(x => x.stage === 'dissent-check-rerun').length, 3)
  assert.equal(report.decider_flips.flips, 2); assert.deepEqual(report.decider_flips.flipped_items.map(x => [x.input_id, x.id]), [['reference', B]])
  assert.equal(report.identical_rescore.input_id, 'reference'); assert.equal(report.identical_rescore.available, true)
  assert.deepEqual(report.identical_rescore.differing_items, [])
  // Scripted failures: restructured loses A, C, D (4 > 3); degraded's removed A met in repeat 2 and spreads.
  assert.deepEqual(report.failures.map(x => [x.code, x.input_id]).sort(), [['removed-mandatory-undetected', 'degraded'], ['restructured-loss-beyond-tolerance', 'restructured'], ['spread-beyond-limit', 'degraded']])
  assert.equal(report.threshold.separable, true)
  assert.ok(report.threshold.proposed > report.threshold.highest_fail.total && report.threshold.proposed < report.threshold.lowest_pass.total)
  assert.equal(exitCode, 1)
  const written = JSON.parse(await readFile(join(f.outDir, 'calibration-report.json'), 'utf8'))
  assert.equal(written.mode, 'calibration'); assert.equal(written.published, false)
  assert.match(await readFile(join(f.outDir, 'calibration-report.md'), 'utf8'), /Decider ruling flips/)
  assert.equal(written.usage.ledger, 'phases/eval-owned-usage.jsonl')
  assert.deepEqual((await readdir(join(f.outDir, 'inputs/reference'))).sort(), ['repeat-1', 'repeat-2', 'repeat-3'])
})

test('real judging is refused while anchors are unreviewed (HT-003); a dry run makes no calls and writes nothing', async t => {
  const f = await suiteFixture(t, { reviewed: false })
  const { judges, calls } = stubJudges()
  await assert.rejects(runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, repoRoot: f.root }, { judges, gateCommand }), new RegExp(`anchors need maintainer review \\(HT-003\\) for inventory version ${inventory.inventory_version}`))
  assert.equal(calls.length, 0)
  await assert.rejects(readdir(f.outDir), { code: 'ENOENT' })
  assert.throws(() => assertAnchorsReviewed({ inventory_version: 3, anchors_review: { reviewer: 'm', date: '2026-10-06', inventory_version: 2 } }), /HT-003.*version 3/)
  const dry = await runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: f.outDir, dryRun: true, repoRoot: f.root }, { judges, gateCommand })
  assert.equal(dry.dryRun, true); assert.equal(dry.plan.inputs.length, 3); assert.equal(dry.plan.repeats, 3)
  assert.equal(calls.length, 0)
  await assert.rejects(readdir(f.outDir), { code: 'ENOENT' })
})

test('calibrate arguments: at least three repeats, host-only default output, one mode', () => {
  const now = new Date('2026-10-06T12:00:00Z')
  const options = parseCalibrateArguments(['--calibrate'], { now, repoRoot: '/repo' })
  assert.equal(options.repeats, 3); assert.equal(options.outDir, '/repo/artifacts/evals/and-scene-define-calibration/2026-10-06T12-00-00-000Z')
  assert.equal(parseCalibrateArguments(['--calibrate', '--repeats', '5', '--dry-run'], { now }).repeats, 5)
  assert.equal(parseCalibrateArguments(['--calibrate', '--dry-run'], { now }).dryRun, true)
  assert.throws(() => parseCalibrateArguments(['--calibrate', '--repeats', '2']), /at least 3/)
  assert.throws(() => parseCalibrateArguments(['--calibrate', '--run-agent']), /exactly one mode/)
  assert.throws(() => parseArguments(['--calibrate']), /run\.sh \(calibrate\.mjs\)/)
})

test('calibration output is never published', async t => {
  const f = await suiteFixture(t)
  await assert.rejects(runCalibration({ suiteRoot: f.suiteRoot, calibrationDir: f.calibrationDir, outDir: join(f.root, 'evals/agent-runner/and-scene-define/results/cal'), repoRoot: f.root }, { judges: stubJudges().judges, gateCommand }), /never be written under the published results/)
  const report = aggregateCalibration({ rubric, inputs: [input('reference', expectations('pass', allMet), [scored(95, {}), scored(95, {}), scored(95, {})])] })
  assert.equal(publicationEligibility(report), false)
  assert.equal(publicationEligibility({ ...report, evaluation_status: 'complete', definition_verdict: 'pass' }), false)
  const git = async () => { throw new Error('publication must not run git for calibration') }
  assert.deepEqual(await publishRun({ runDir: f.root, repoDir: f.root, result: report, git }), { skipped: true, published: false, commit: null })
})

test('candidate runs never require calibration output', async t => {
  // A calibrated, reviewed suite with no calibration set and no calibration report passes judging-input preflight.
  const root = await mkdtemp(join(tmpdir(), 'define-no-calibration-')); t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'rubric.json'), JSON.stringify({ ...rubric, pass_threshold: 70 }))
  await checkJudgingInputs({ suiteRoot: root, inventory: subset })
  for (const file of ['controller.mjs', 'lib/preflight.mjs', 'lib/judging.mjs', 'lib/rescore.mjs']) {
    const source = await readFile(join(SUITE_ROOT, file), 'utf8')
    assert.doesNotMatch(source, /^import .*calibrat|calibration-report|(?<![-\w])calibration\//m, file)
  }
})
