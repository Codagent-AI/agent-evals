import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { git, script, temp } from './and-scene-e2e-helpers.mjs'
import { lifecycle, profiles } from './and-scene-e2e-lifecycle-helpers.mjs'
import { runEvaluation } from '../evals/agent-runner/and-scene-e2e/controller.mjs'
import { buildTrace, OUTCOMES } from '../evals/agent-runner/and-scene-e2e/lib/trace.mjs'
import { publishRun, publicationEligibility, RESULTS_RELATIVE_DIR } from '../evals/agent-runner/and-scene-e2e/lib/publication.mjs'
import { publicationEligibility as eligible } from '../evals/agent-runner/and-scene-e2e/lib/outcomes.mjs'
import { compareResults } from '../evals/agent-runner/and-scene-e2e/lib/comparison.mjs'
import { rescoreEvaluation, verifyRetained } from '../evals/agent-runner/and-scene-e2e/lib/rescore.mjs'
import { loadProductInputs } from '../evals/agent-runner/and-scene-e2e/lib/product-rubric.mjs'
import { runTimed } from '../evals/agent-runner/and-scene-define/lib/subprocess.mjs'
import { renderReport } from '../evals/agent-runner/and-scene-e2e/lib/report.mjs'

const product = await loadProductInputs()

// ---- the trace ------------------------------------------------------------------------------------------------
const mini = {
  inventory: { items: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'P'].map((id, n) => ({ id, class: id === 'P' ? 'preference' : n % 2 ? 'acceptable-alternative' : 'mandatory', title: id })) },
  rubric: { criterion_sources: { c1: { owner: 'fixture', inventory: ['A'] }, c2: { owner: 'fixture', inventory: ['B'] }, c3: { owner: 'fixture', inventory: ['B'] }, shared: { owner: 'fixture', inventory: ['D', 'E', 'F'] }, e: { owner: 'eval', reason: 'r', presumes: [] } } },
}
const productScore = verdicts => ({ components: [{ subcomponents: [{ criteria: Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict })) }] }] })
const citation = [{ exchange: '["define.specs","specs",1,1]' }]
const decisions = asked => ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(id => ({ id, asked: asked.includes(id), citations: asked.includes(id) ? citation : [] }))
const cover = verdicts => Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict }))
test('INT-010 the trace gives each item exactly the outcome the table defines', () => {
  const trace = buildTrace({ ...mini, asked: decisions(['A', 'B', 'C', 'G']),
    coverage: cover({ A: 'met', B: 'partial', C: 'missing', D: 'met', E: 'met', F: 'met', G: 'missing' }), product: productScore({ c1: 'pass', c2: 'pass', c3: 'fail', shared: 'fail' }) })
  const by = Object.fromEntries(trace.items.map(item => [item.id, item]))
  assert.equal(by.A.outcome, 'delivered'); assert.deepEqual(by.A.exchange_citations, citation); assert.equal(by.A.product_delivery, 'delivered')
  assert.equal(by.B.outcome, 'partially-delivered'); assert.equal(by.B.product_delivery, 'partly-delivered')
  assert.equal(by.C.outcome, 'discovered-not-defined'); assert.deepEqual(by.C.exchange_citations, citation)
  assert.equal(by.G.outcome, 'discovered-not-defined')
  assert.equal(by.D.outcome, 'defined-not-delivered'); assert.equal(by.E.outcome, 'defined-not-delivered'); assert.equal(by.F.outcome, 'defined-not-delivered')
  for (const id of ['D', 'E', 'F']) assert.deepEqual(by[id].shared_criteria.map(entry => entry.criterion), ['shared'], `the shared failing criterion is named beside ${id}`)
  assert.deepEqual(by.D.shared_criteria[0].shared_with.sort(), ['E', 'F'])
  assert.equal(trace.items.length, 7, 'one row per graded item and no preference'); assert.ok(!by.P)
  assert.equal(trace.counts['defined-not-delivered'], 3); assert.equal(trace.scoring, false)
  for (const outcome of OUTCOMES) assert.ok(outcome in trace.counts)
})
test('INT-010 never-raised and heard-but-unwritten requirements, whatever was built; an item no criterion maps to is not graded', () => {
  const trace = buildTrace({ ...mini, asked: decisions(['C']), coverage: cover({ A: 'missing', B: 'missing', C: 'missing', D: 'met', E: 'met', F: 'met', G: 'met' }), product: productScore({ c1: 'pass', c2: 'pass', c3: 'pass', shared: 'pass' }) })
  const by = Object.fromEntries(trace.items.map(item => [item.id, item]))
  assert.equal(by.A.outcome, 'not-discovered', 'missing coverage follows discovery even though the feature was built')
  assert.equal(by.C.outcome, 'discovered-not-defined'); assert.equal(by.G.outcome, 'not-graded-in-product'); assert.equal(by.G.product_delivery, 'not-graded')
  for (const outcome of ['delivered', 'partially-delivered']) assert.ok(!trace.items.some(item => item.id === 'G' && item.outcome === outcome))
})
test('INT-010 without a product, covered items are delivery-unavailable and none of the four product outcomes appears', () => {
  const trace = buildTrace({ ...mini, asked: decisions(['A']), coverage: cover({ A: 'met', B: 'met', C: 'missing', D: 'met', E: 'partial', F: 'met', G: 'met' }), product: null })
  for (const item of trace.items) { assert.equal(item.product_delivery, 'unavailable'); assert.ok(['delivery-unavailable', 'not-discovered', 'discovered-not-defined'].includes(item.outcome), item.outcome) }
  assert.equal(trace.items.find(item => item.id === 'G').outcome, 'delivery-unavailable')
  assert.equal(trace.items.find(item => item.id === 'C').outcome, 'not-discovered')
})
test('INT-010 an empty mapping never counts as a vacuous pass, and the trace calls no judge', () => {
  const trace = buildTrace({ ...mini, asked: decisions([]), coverage: cover({ G: 'met' }), product: productScore({ c1: 'pass' }) })
  assert.equal(trace.items.find(item => item.id === 'G').product_delivery, 'not-graded')
  assert.equal(typeof buildTrace, 'function'); assert.equal(buildTrace.length <= 1, true)
})

// ---- results, reports, publication ----------------------------------------------------------------------------
const RISK = [/network access/, /publicly reachable/, /writable by the evaluated agent/, /outbound-network allowlist/, /private fixture/, /token that can push to the run's own delivery repository and to no other repository/]
async function publicationWorld(t, options = {}) {
  const f = await lifecycle(t, { depsOverride: { publish: undefined } })
  const origin = join(f.root, 'origin.git'); const repo = join(f.root, 'checkout')
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  execFileSync('git', ['clone', '--quiet', origin, repo]); await writeFile(join(repo, 'README.md'), 'x'); git(repo, ['checkout', '-B', 'main']); git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'init']); git(repo, ['push', '--quiet', '-u', 'origin', 'main'])
  await writeFile(join(repo, 'unrelated-staged.txt'), 'staged'); git(repo, ['add', 'unrelated-staged.txt']); await writeFile(join(repo, 'README.md'), 'modified, unstaged')
  f.options.repoDir = repo; f.harness.humanReview = { eligible: false, reason: 'the product could not be built: test' }
  const calls = []
  f.deps.publish = args => publishRun({ ...args, git: (argv, opts) => { calls.push(argv); return runTimed('git', argv, opts) } })
  return { f, origin, repo, calls }
}
test('INT-010 a complete run is published once: only results/<run-id>/, the required message, an ordinary push, nothing unrelated', async t => {
  const { f, origin, repo, calls } = await publicationWorld(t)
  const { result, exitCode } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'complete', result.observed_error); assert.equal(exitCode, 0)
  assert.equal(result.product_score.human_points, 0); assert.match(result.product.human_review.reason, /could not be built/)
  const message = `chore: record and-scene-e2e eval ${result.run_id}`
  assert.equal(git(repo, ['log', '-1', '--format=%s']), message)
  const files = git(repo, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean)
  const prefix = `${RESULTS_RELATIVE_DIR}/${result.run_id}/`
  assert.ok(files.every(file => file.startsWith(prefix)), files.join(','))
  const names = files.map(file => file.slice(prefix.length)).sort()
  for (const required of ['result.json', 'report.html', 'conversation.jsonl', 'phases/trace.json', 'collected/proposal.md', 'artifact-manifest.json']) assert.ok(names.includes(required), required)
  for (const sentinel of ['run-state.json', '.runtime', 'logs', 'judges', 'sandbox', 'evidence', 'source']) assert.ok(!names.some(name => name === sentinel || name.startsWith(`${sentinel}/`)), sentinel)
  assert.match(git(repo, ['status', '--porcelain']), /A  unrelated-staged\.txt/); assert.match(git(repo, ["status", "--porcelain"]), /M README\.md/)
  assert.equal(git(origin, ['log', '-1', '--format=%s', 'main']), message)
  const pushes = calls.filter(argv => argv[0] === 'push'); assert.deepEqual(pushes, [['push']])
  assert.ok(!calls.flat().some(arg => /^--?(f|force|force-with-lease)\b/.test(arg)))
  assert.equal(await publicationEligibility(result), true)
})
test('INT-010 a rejected push preserves the result and a resume retries only publication with the same commit and no force', async t => {
  const { f, origin, repo, calls } = await publicationWorld(t)
  await mkdir(join(origin, 'hooks'), { recursive: true }); await script(join(origin, 'hooks/pre-receive'), `if [[ ! -e "${origin}/rejected-once" ]]; then touch "${origin}/rejected-once"; echo rejected >&2; exit 1; fi`)
  const first = await runEvaluation(f.options, f.deps)
  assert.equal(first.exitCode, 1); assert.equal(first.result.evaluation_status, 'complete')
  const saved = await readFile(join(f.runDir, 'result.json'), 'utf8'); const checkpoint = JSON.parse(await readFile(join(f.runDir, 'publication.json'), 'utf8'))
  assert.equal(checkpoint.stage, 'push'); assert.ok(checkpoint.commit); assert.equal(checkpoint.resumable, true)
  const starts = f.sandbox.starts.length; const judged = f.judgeCalls.length
  const second = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(second.exitCode, 0)
  assert.equal(git(repo, ['rev-parse', 'HEAD']), checkpoint.commit); assert.equal(git(origin, ['rev-parse', 'main']), checkpoint.commit)
  assert.equal(git(repo, ['log', '--format=%s', '--grep=chore: record and-scene-e2e eval']).split('\n').filter(Boolean).length, 1)
  assert.equal(f.sandbox.starts.length, starts); assert.equal(f.judgeCalls.length, judged); assert.equal(await readFile(join(f.runDir, 'result.json'), 'utf8'), saved)
  assert.ok(!calls.flat().some(arg => /force/.test(arg)))
})
test('INT-010 a failed commit preserves the result and records a retryable checkpoint', async t => {
  const { f, repo } = await publicationWorld(t)
  await mkdir(join(repo, '.git/hooks'), { recursive: true }); const marker = join(f.root, 'hook-ran'); await script(join(repo, '.git/hooks/pre-commit'), `if [[ ! -e "${marker}" ]]; then touch "${marker}"; echo no >&2; exit 1; fi`)
  const first = await runEvaluation(f.options, f.deps)
  assert.equal(first.exitCode, 1); const checkpoint = JSON.parse(await readFile(join(f.runDir, 'publication.json'), 'utf8'))
  assert.equal(checkpoint.stage, 'commit'); assert.equal(checkpoint.resumable, true); assert.equal(JSON.parse(await readFile(join(f.runDir, 'result.json'), 'utf8')).evaluation_status, 'complete')
  const second = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(second.exitCode, 0); assert.equal(git(repo, ['log', '--format=%s', '--grep=chore: record and-scene-e2e eval']).split('\n').filter(Boolean).length, 1)
})
test('INT-010 only complete candidate runs are published; pending, failed, contaminated, rescore, dry-run and calibration runs are not', () => {
  const base = { mode: 'candidate', evaluation_status: 'complete' }
  assert.equal(publicationEligibility(base), true); assert.equal(eligible(base), true)
  for (const status of ['pending-human-review', 'definition-workflow-failed', 'implementation-workflow-failed', 'contaminated', 'evaluation-harness-failed']) { assert.equal(publicationEligibility({ ...base, evaluation_status: status }), false, status); assert.equal(eligible({ ...base, evaluation_status: status }), false, status) }
  for (const mode of ['rescore', 'calibration']) assert.equal(publicationEligibility({ ...base, mode }), false, mode)
  assert.equal(publicationEligibility({ ...base, dry_run: true }), false); assert.equal(eligible({ ...base, rescore: true }), false)
})
test('INT-010 pending, failed and complete results all carry the required sections, the five risk facts and no combined total', async t => {
  for (const scenario of ['pending', 'failed', 'complete']) {
    const f = await lifecycle(t)
    if (scenario === 'failed') { f.harness.plans.implement.push({ type: 'failed' }); f.deps.quota = async () => ({ waited: false }) }
    if (scenario === 'complete') f.harness.humanReview = { eligible: false, reason: 'the product could not be built: test' }
    const { result } = await runEvaluation(f.options, f.deps)
    const expected = { pending: 'pending-human-review', failed: 'implementation-workflow-failed', complete: 'complete' }[scenario]
    assert.equal(result.evaluation_status, expected, result.observed_error)
    for (const pattern of RISK) assert.match(result.residual_risk, pattern, scenario)
    const html = (await readFile(join(f.runDir, 'report.html'), 'utf8')).replaceAll('&#39;', "'")
    for (const pattern of RISK) assert.ok(pattern.test(html), `${scenario}: report lacks ${pattern}`)
    for (const section of ['Evaluation status', 'Scores', 'Gates', 'Requirement trace', 'Audits', 'Residual risk', 'delivery_repository', 'series_identity', 'candidate', 'provenance', 'workflow_metrics', 'eval_owned_usage', 'prohibited_effects']) assert.ok(html.includes(section), `${scenario}: ${section}`)
    assert.ok(!/<script|<link|\ssrc=|\shref=/.test(html), `${scenario}: the report must be self-contained`); assert.ok(!/combined_total|"total_score"/.test(JSON.stringify(result)))
    if (scenario === 'failed') { assert.equal(typeof result.owning_phase, 'string'); assert.equal(typeof result.observed_error, 'string'); assert.equal(result.resumable, true); assert.ok(/Resumable/.test(html)) }
    assert.equal(result.provisional_rubric, true); assert.ok(/provisional/.test(html))
    if (scenario !== 'failed') { assert.equal(result.eval_owned_usage.length, 0); assert.ok(result.workflow_metrics) }
  }
})
test('INT-010 identical verdicts with different asked parts give identical definition and product scores', async t => {
  const totals = []
  for (const asked of [false, true]) {
    const f = await lifecycle(t); f.harness.withExchange()
    const base = f.deps.judges.panel.map(member => member.invoke)
    const patch = invoke => async req => req.job === 'discovery' ? JSON.stringify({ results: req.criteria.map(id => ({ id, asked, rationale: 'r', citations: asked ? [{ path: null, start_line: null, end_line: null, gate: null, exchange: f.harness.exchangeId }] : [] })) }) : invoke(req)
    f.deps.judges = { panel: f.deps.judges.panel.map(member => ({ ...member, invoke: patch(member.invoke) })), decider: { ...f.deps.judges.decider, invoke: patch(f.deps.judges.decider.invoke) } }
    const { result } = await runEvaluation(f.options, f.deps)
    assert.equal(result.evaluation_status, 'pending-human-review', result.observed_error)
    totals.push({ definition: result.definition_score.total, product: result.product_score.automated_score, asked: result.definition_discovery.items.filter(item => item.asked).length })
  }
  assert.equal(totals[0].definition, totals[1].definition); assert.equal(totals[0].product, totals[1].product); assert.notEqual(totals[0].asked, totals[1].asked)
})

// ---- comparison -----------------------------------------------------------------------------------------------
const series = (extra = {}) => ({ product_rubric: { version: '1.0.0' }, ...extra })
const run = (id, candidate, definition, productPoints, { seriesIdentity = series(), status = 'complete', phase = null, trace = {} } = {}) => ({ run_id: id, evaluation_status: status, owning_phase: phase, series_identity: seriesIdentity, candidate, definition_score: status === 'complete' ? { total: definition } : null, product_score: productPoints === null ? { score: null, incomplete: true } : { score: productPoints }, requirement_trace: { counts: { delivered: 5, ...trace } } })
const A = { workflow: { reference: 'openspec:change', hash: 'h1' }, profiles }; const B = { workflow: { reference: 'openspec:change', hash: 'h2' }, profiles }
test('INT-010 compare groups by series and candidate, reports hand-calculated statistics, and classifies only groups of three', () => {
  const results = [run('a1', A, 80, 70), run('a2', A, 82, 72), run('a3', A, 84, 74), run('b1', B, 60, 50), run('b2', B, 61, 52), run('b3', B, 62, 54), run('c1', { ...A, profiles: { ...profiles, lead: { ...profiles.lead, model: 'x' } } }, 90, 90),
    run('other-series', A, 80, 70, { seriesIdentity: series({ product_rubric: { version: '2.0.0' } }) }), run('failed', A, 0, 0, { status: 'implementation-workflow-failed', phase: 'implement-workflow' }), run('incomplete', A, 83, null)]
  const report = compareResults(results)
  const group = id => report.groups.find(entry => entry.run_ids.includes(id))
  const a = group('a1')
  assert.equal(a.scored_repetitions, 4, 'the incomplete-product run still counts for the definition score'); assert.equal(a.label, 'group')
  assert.deepEqual([a.definition.n, a.definition.mean], [4, (80 + 82 + 84 + 83) / 4]); assert.equal(a.definition.worst, 80); assert.equal(a.product.n, 3); assert.equal(a.product.mean, 72); assert.equal(a.product.worst, 70); assert.ok(Math.abs(a.product.stddev - 2) < 1e-9)
  assert.equal(group('c1').label, 'screen'); assert.equal(group('other-series').label, 'screen')
  assert.deepEqual(report.unscored.map(entry => [entry.run_id, entry.evaluation_status, entry.owning_phase]), [['failed', 'implementation-workflow-failed', 'implement-workflow']])
  const pair = report.pairs.find(entry => entry.comparable && entry.candidate_differences.some(difference => difference.component === 'workflow.hash') && entry.classified)
  assert.ok(pair, 'the two three-repetition groups are paired and the differing workflow hash is named')
  assert.equal(pair.product.level, 'clear'); assert.equal(pair.product.direction, 'worse'); assert.ok(pair.product.delta < 0)
  const screen = report.pairs.find(entry => entry.comparable && !entry.classified); assert.ok(screen); assert.equal(screen.product, null); assert.match(screen.reason, /fewer than 3/)
  assert.ok(report.pairs.some(entry => entry.comparable === false && /different series identities/.test(entry.reason)))
  assert.equal(a.mean_trace_counts.delivered, 5)
})
test('INT-010 compare lists every component that differs, and groups of 0, 1 and 2 scored runs are never classified', () => {
  for (const n of [0, 1, 2]) {
    const results = [...Array.from({ length: n }, (_, i) => run(`x${i}`, A, 70, 70)), run('b1', B, 60, 50), run('b2', B, 61, 52), run('b3', B, 62, 54)]
    const report = compareResults(results)
    assert.ok(report.pairs.every(pair => pair.classified !== true), `${n} runs`)
  }
  const report = compareResults([run('1', A, 1, 1), run('2', { ...B, agent_skills_commit: 'x' }, 1, 1)])
  assert.deepEqual(report.pairs[0].candidate_differences.map(difference => difference.component).sort(), ['agent_skills_commit', 'workflow.hash'])
})

// ---- rescore ----------------------------------------------------------------------------------------------------
import { cp } from 'node:fs/promises'
async function retainedRun(t) {
  const f = await lifecycle(t); f.harness.withExchange()
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'pending-human-review', result.observed_error)
  return { f, source: result }
}
function rescoreDeps(f, { fail = null } = {}) {
  const seen = { product: [] }
  const bumped = structuredClone(product); bumped.rubric.version = '2.0.0'
  const evaluate = async args => {
    seen.product.push(args)
    const verdicts = Object.fromEntries(bumped.rubric.components.flatMap(c => c.subcomponents.flatMap(s => s.criteria)).map(id => [id, { verdict: id === fail ? 'fail' : 'pass', basis: 'x', rationale: 'r', citations: [] }]))
    const { scoreProduct } = await import('../evals/agent-runner/and-scene-e2e/lib/scoring.mjs')
    return { build_plan: args.plan, build: { ok: true }, gates: [], score: scoreProduct({ rubric: bumped.rubric, verdicts }), verdicts, human_review: { eligible: true } }
  }
  return { seen, deps: { judges: f.deps.judges, loadInputs: f.deps.loadInputs, gateCommand: f.deps.gateCommand, productInputs: bumped, evaluateProduct: evaluate, evaluatorIdentity: async () => ({ version: 2, product_rubric: { version: '2.0.0' } }) } }
}
test('INT-010 a rescore reruns audits, scoring and the trace from retained evidence with no Runner, sandbox or GitHub, and is never published', async t => {
  const { f, source } = await retainedRun(t)
  const { rm: remove } = await import('node:fs/promises')
  await remove(join(f.runDir, 'sandbox'), { recursive: true, force: true })
  const bin = join(f.root, 'traps'); const log = join(f.root, 'trap.log')
  for (const name of ['docker', 'gh', 'agent-runner']) await script(join(bin, name), `echo ${name} >> "${log}"; exit 1`)
  const oldPath = process.env.PATH; const oldFetch = globalThis.fetch
  process.env.PATH = `${bin}:${oldPath}`; globalThis.fetch = () => { throw new Error('GitHub must not be reached') }
  const judged = f.judgeCalls.length; const starts = f.sandbox.starts.length
  const { seen, deps } = rescoreDeps(f, { fail: 'demo-evolving-scene-structure' }); let published = 0; deps.publish = () => { published++ }
  const target = join(f.root, 'rescored')
  let outcome
  try { outcome = await rescoreEvaluation({ rescoreFrom: f.runDir, runDir: target }, deps) } finally { process.env.PATH = oldPath; globalThis.fetch = oldFetch }
  const { result, exitCode } = outcome
  assert.equal(result.evaluation_status, 'pending-human-review', result.observed_error); assert.equal(exitCode, 0); assert.equal(result.mode, 'rescore'); assert.equal(published, 0)
  await assert.rejects(readFile(log, 'utf8')); assert.equal(f.sandbox.starts.length, starts)
  assert.equal(result.series_identity.product_rubric.version, '2.0.0'); assert.equal(result.original.series_identity.version, 1); assert.deepEqual(result.original.candidate, source.candidate); assert.deepEqual(result.candidate, source.candidate)
  assert.equal(result.product.rubric.version, '2.0.0'); assert.equal(seen.product.length, 1)
  const [call] = seen.product; assert.deepEqual(call.plan, {}); assert.equal(call.bundlePath, join(target, 'source/candidate.bundle')); assert.equal(call.commit, 'c'.repeat(40)); assert.equal(call.rubric.version, '2.0.0')
  assert.ok(f.judgeCalls.length > judged, 'the disclosure audit and definition scoring were rerun')
  for (const name of ['phases/contamination-pass-1.json', 'phases/contamination-pass-2.json']) assert.deepEqual(JSON.parse(await readFile(join(target, name), 'utf8')), JSON.parse(await readFile(join(f.runDir, name), 'utf8')), `${name} reproduces`)
  const rebuilt = JSON.parse(await readFile(join(target, 'phases/trace.json'), 'utf8')); const original = JSON.parse(await readFile(join(f.runDir, 'phases/trace.json'), 'utf8'))
  assert.equal(original.items.find(item => item.id === 'INV-001').outcome, 'delivered'); assert.equal(rebuilt.items.find(item => item.id === 'INV-001').outcome, 'defined-not-delivered', 'the trace is rebuilt from the rescored verdicts')
  assert.equal(await readFile(join(f.runDir, 'result.json'), 'utf8').then(text => JSON.parse(text).mode), 'candidate', 'the source result is untouched')
})
test('INT-010 a rescore refuses a source whose retained inputs no longer match their recorded hashes', async t => {
  const { f } = await retainedRun(t)
  const mutate = async (path, edit) => {
    const copy = join(f.root, `copy-${Math.random().toString(16).slice(2, 8)}`); await cp(f.runDir, copy, { recursive: true })
    const file = join(copy, path); await writeFile(file, edit(await readFile(file, 'utf8').catch(() => '')))
    return copy
  }
  const finalTranscript = (await readdir(join(f.runDir, 'evidence/final/transcripts')))[0]
  for (const path of ['conversation.jsonl', 'evidence/define/runner/audit.log', `evidence/final/transcripts/${finalTranscript}`, 'collected/proposal.md', 'source/candidate.bundle', 'evidence/final/acceptance/000-final-handoff', 'phases/collection.json']) {
    const copy = await mutate(path, text => `${text}tampered`)
    await assert.rejects(rescoreEvaluation({ rescoreFrom: copy, runDir: join(f.root, `out-${Math.random().toString(16).slice(2, 8)}`) }, rescoreDeps(f).deps), error => error.usage === true, path)
  }
  const noPlan = await mutate('phases/product-result.json', text => JSON.stringify({ ...JSON.parse(text), build_plan: null }))
  await assert.rejects(rescoreEvaluation({ rescoreFrom: noPlan, runDir: join(f.root, 'out-noplan') }, rescoreDeps(f).deps), /never got a build plan; resume it instead/)
  await assert.rejects(rescoreEvaluation({ rescoreFrom: f.runDir, runDir: f.runDir }, rescoreDeps(f).deps), /must be new/)
  assert.ok((await verifyRetained(f.runDir)).delivery.ok)
})

// ---- human review --------------------------------------------------------------------------------------------------
import { runHumanReview } from '../evals/agent-runner/and-scene-e2e/human-review.mjs'
const answers = (ratings, { ready = true } = {}) => { const queue = [...(ready ? ['yes'] : [])]; for (const rating of ratings) queue.push(String(rating), rating <= 3 ? 'because' : ''); return queue }
const scripted = (queue, { then = 'confirm' } = {}) => { const asked = []; return { asked, write: () => {}, ask: async prompt => { asked.push(prompt); if (!queue.length) return null; return queue.shift() } } }
async function reviewWorld(t) {
  const { f, source } = await retainedRun(t)
  const published = []
  const common = { runDir: f.runDir, build: async () => f.root, serve: async () => ({ url: 'http://127.0.0.1:1', close: async () => {} }), publish: async args => { published.push(args.result.run_id); return { published: true } }, repoDir: f.root }
  return { f, source, published, common }
}
test('INT-010 a completed review makes the run complete with up to 30 human points, and only then is it published', async t => {
  const { f, published, common } = await reviewWorld(t)
  assert.equal(published.length, 0)
  const outcome = await runHumanReview({ ...common, io: scripted([...answers([5, 5, 5, 5, 5, 5, 5]), 'confirm']) })
  assert.equal(outcome.status, 'complete'); assert.equal(outcome.result.evaluation_status, 'complete')
  assert.equal(outcome.result.product_score.human_points, 30); assert.equal(outcome.result.product_score.score, 100); assert.equal(outcome.result.product_score.automated_score, 70)
  assert.deepEqual(published, [outcome.result.run_id]); assert.equal(JSON.parse(await readFile(join(f.runDir, 'result.json'), 'utf8')).evaluation_status, 'complete')
  assert.equal((await runHumanReview({ ...common, io: scripted([]) })).status, 'already-complete'); assert.equal(published.length, 1)
})
test('INT-010 an interrupted review resumes from the saved answers', async t => {
  const { f, common } = await reviewWorld(t)
  const first = await runHumanReview({ ...common, io: scripted(answers([5, 4, 3])) })
  assert.equal(first.status, 'interrupted'); assert.equal(JSON.parse(await readFile(join(f.runDir, 'human-review/state.json'), 'utf8')).responses.length, 3)
  const io = scripted([...answers([5, 5, 5, 5], { ready: false }), 'confirm'])
  const second = await runHumanReview({ ...common, io })
  assert.equal(second.status, 'complete'); assert.match(io.asked.find(prompt => /Rating/.test(prompt)), /Rating/)
  assert.equal(JSON.parse(await readFile(join(f.runDir, 'human-review/review.json'), 'utf8')).responses.length, 7)
})
test('INT-010 the human floor and the minimum individual rating are reported, never applied: the points still count', async t => {
  const { common } = await reviewWorld(t)
  const outcome = await runHumanReview({ ...common, io: scripted([...answers([1, 2, 2, 2, 2, 2, 2]), 'confirm']) })
  assert.equal(outcome.status, 'complete')
  const review = JSON.parse(await readFile(join(outcome.result.run_directory ?? common.runDir, 'human-review/review.json'), 'utf8'))
  assert.equal(review.floor, 15); assert.equal(review.floor_reached, false); assert.equal(review.min_individual_rating_met, false); assert.ok(review.points > 0 && review.points < 15)
  assert.equal(outcome.result.product_score.human_points, review.points); assert.equal(outcome.result.product_score.score, 70 + review.points)
})
test('INT-010 human review refuses a run that is not pending and honors --no-publish', async t => {
  const { f, published, common } = await reviewWorld(t)
  const done = await runHumanReview({ ...common, noPublish: true, io: scripted([...answers([4, 4, 4, 4, 4, 4, 4]), 'confirm']) })
  assert.equal(done.status, 'complete'); assert.equal(published.length, 0)
  const failed = await lifecycle(t); failed.harness.plans.implement.push({ type: 'failed' }); failed.deps.quota = async () => ({ waited: false }); await runEvaluation(failed.options, failed.deps)
  await assert.rejects(runHumanReview({ ...common, runDir: failed.runDir, io: scripted([]) }), /applies only to a pending run, not implementation-workflow-failed/)
  await rm(join(f.runDir, 'human-review'), { recursive: true, force: true })
})

import { ensureBuild } from '../evals/agent-runner/and-scene-e2e/human-review.mjs'
test('I-51 human review reconstructs the candidate from the bundle and the recorded plan with the remote and runtime deleted', async t => {
  const world = await (async () => {
    const root = await temp(t, 'e2e-rebuild-'); const repo = join(root, 'repo'); await mkdir(repo, { recursive: true })
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]); await writeFile(join(repo, 'README.md'), 'x'); git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'start'])
    git(repo, ['checkout', '--quiet', '-b', 'add-presentation-skill']); await writeFile(join(repo, 'package.json'), JSON.stringify({ devDependencies: { vite: '1' }, scripts: { build: 'vite build' } })); await writeFile(join(repo, 'index.html'), '<html></html>')
    git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'work'])
    const runDir = join(root, 'run'); await mkdir(join(runDir, 'source'), { recursive: true }); git(repo, ['bundle', 'create', join(runDir, 'source/candidate.bundle'), 'main', 'add-presentation-skill'])
    return { root, runDir }
  })()
  const specs = []
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const run = spec => { specs.push(spec); if (spec.network === 'none') { const out = join(spec.mounts[0].source, 'dist'); mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'index.html'), '<html>rebuilt</html>') } return { stdout: '' } }
  const product = { build: { output: 'dist' }, build_plan: { application_root: '.', install: ['npm', 'install'], build: ['npm', 'run', 'build'] } }
  const output = await ensureBuild({ runDir: world.runDir, product, run })
  assert.equal(await readFile(join(output, 'index.html'), 'utf8'), '<html>rebuilt</html>')
  assert.deepEqual(specs.map(spec => spec.network), ['bridge', 'none']); assert.ok(specs.every(spec => spec.mounts.length === 1))
  assert.equal((await ensureBuild({ runDir: world.runDir, product, run })), output, 'a retained build is served again without rebuilding'); assert.equal(specs.length, 2)
})
