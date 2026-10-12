import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, chmod, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { makeTempDir } from './temp-dir.mjs'
import * as baseline from '../evals/agent-runner/and-scene/lib/experiment-baseline.mjs'
import * as comparison from '../evals/agent-runner/and-scene/lib/experiment-comparison.mjs'
import * as request from '../evals/agent-runner/and-scene/lib/eval-request.mjs'
import * as github from '../evals/agent-runner/and-scene/lib/github-read.mjs'
import { formatMarkdown } from '../evals/agent-runner/and-scene/lib/comparison-format.mjs'
import { runExperimentsCommand, parseArgs } from '../evals/agent-runner/and-scene/experiments.mjs'
const suite = resolve('evals/agent-runner/and-scene')
const at = '2026-10-05T12:00:00.000Z'
const sha = digit => digit.repeat(40)
const fence = String.fromCharCode(96).repeat(3)
const block = text => fence + 'eval\n' + text + '\n' + fence
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && !Array.isArray(value) && typeof value === 'object' && target[key] && typeof target[key] === 'object') merge(target[key], value)
    else target[key] = value
  }
  return target
}
function makeResult(patch = {}) {
  return merge({
    schema_version: 8, run_id: 'rep-1', run_kind: 'candidate', mode: 'agent-runner',
    workflow: { provenance: { commit: 'runner-a' }, agent_skills_provenance: { commit: 'skills-a' }, workflow: 'implement-change', workflow_path: 'workflow.yaml', task_level_compliance: 'required', final_validator: 'required', skip_validator: 'false', events: [] },
    candidate_source: { fixture_commit: 'fixture-a' },
    role_configuration: { roles: { implementor: { configured: { cli: 'codex', model: 'model-a', effort: 'high', agent: 'implementor' }, attempts: [{ observed: { model: 'model-a' } }] } } },
    rubrics: { automated: { rubric_id: 'auto', version: '1', sha256: 'hash-a' }, human: { rubric_id: 'human', version: '1', sha256: 'hash-h' } },
    automated_subtotal: { points: 50, possible: 70, complete: true }, score: { gates_passed: true, gates: [{ id: 'build', verdict: 'pass' }] },
    evaluation_status: 'complete', product_verdict: 'pass', official_score: 70,
    human_review: { complete: true, score: { total: 20, possible: 30 }, rubric: { rubric_id: 'human', version: '1', sha256: 'hash-h' }, completed_at: at },
    cost: { usage: { complete: true, token_totals: { input: 60, output: 40, total: 100 }, tokens: { input: 60, output: 40 } }, rows: [{ provider: 'openai', token_totals: { input: 60, output: 40, total: 100 } }], total: { state: 'estimated', complete: true, estimated_api_cost_usd: 2, known_cost_subtotal_usd: 2 } },
    implementation_metrics: { active_duration_ms: 60000 }, failure: null, failed_phase: null, product_failure: null,
  }, patch)
}
function item(id, patch = {}) {
  return baseline.extractRepetition(makeResult(merge({
    schema_version: 9, run_id: id,
    workflow: { provenance: { commit: sha('a') }, agent_skills_provenance: { commit: sha('b') } },
    cost: { rows: [{ agent_role: 'implementor', provider: 'openai', token_totals: { total: 100 }, cost: { amount_usd: 2 } }] },
  }, patch)), { directory: id, addedAt: at, addedBy: 'compare' })
}
function current(items = [item('base-1'), item('base-2')]) {
  return baseline.applySet(baseline.emptyRecord(), items, { source: 'manual', reason: 'test', now: at }).record.current
}
function codes(value) { return value.refusals.map(x => x.code) }
const candidates = () => [item('cand-1'), item('cand-2')]
const admission = (list = candidates(), base = current()) => comparison.admitCohorts({ baseline: base, candidates: list })

test('eval blocks: factory pattern, CRLF, missing and ambiguous', () => {
  assert.equal(request.extractEvalBlock(block('lead = "c:m:h"').replaceAll('\n', '\r\n')).text, 'lead = "c:m:h"')
  assert.deepEqual(codes(request.extractEvalBlock('no block')), ['eval-block-missing'])
  assert.deepEqual(codes(request.extractEvalBlock(block('x = 1') + '\n' + block('y = 2'))), ['eval-block-ambiguous'])
  assert.equal(request.extractEvalBlock(fence + 'eval \t\nx = 1\n' + fence).text, 'x = 1')
})
test('flat TOML supports comments, strings, escapes, booleans and decimal integers', () => {
  const parsed = request.parseTomlSubset('# comment\na = "hash # quote\\" \\\\ \\b \\t \\n \\f \\r \\u0041 \\U0001F600" # comment\nb = \'$(verbatim) \\ # literal\'\nc = true\nd = false\ne = +1_234\nf = -5\ng = 0')
  assert.equal(parsed.settings.a, 'hash # quote" \\ \b \t \n \f \r A 😀')
  assert.equal(parsed.settings.b, '$(verbatim) \\ # literal')
  assert.deepEqual([parsed.settings.c, parsed.settings.d, parsed.settings.e, parsed.settings.f, parsed.settings.g], [true, false, 1234, -5, 0])
  for (const text of ['[roles]', 'x = []', 'x = {}', 'a.b = 1', '"a" = 1', 'x = 1.2', 'x = 2026-01-01', 'x = """multi"""', "x = '''multi'''", 'x = 01', 'x = 1__2', 'x = 0x10', 'x = "bad\\q"', 'x = "\\uD800"', 'x = "\\U00110000"', 'x = 1\nx = 2', 'x = "a" trailing', 'x = 9007199254740993']) {
    const failure = request.parseTomlSubset(text)
    assert.deepEqual(codes(failure), ['eval-block-invalid'], text)
    assert.match(failure.refusals[0].message, /Line [12]/)
  }
})
test('request schema validates without defaults; hashes use sorted keys', () => {
  const valid = { agent_runner_ref: 'feature-x', lead: 'codex:gpt-5.6-sol:high' }
  assert.deepEqual(request.validateRequest(valid).settings, valid)
  assert.equal(request.requestHash({ a: 1, b: 2 }), request.requestHash({ b: 2, a: 1 }))
  for (const [key, value] of Object.entries({ agent_validator_ref: 'main', agent_runner_ref: '', agent_skills_ref: false, fixture_ref: 5, lead: 'codex:model', tester: ':m:h', implementor: true, crosscheck: 'c:m:h:a', skip_validator: 'false', repetitions: true })) assert.deepEqual(codes(request.validateRequest({ [key]: value })), ['eval-block-invalid'], key)
  for (const value of [0, -1, 1.2]) assert.ok(request.validateRequest({ repetitions: value }).refusals)
  assert.ok(request.validateRequest({ repetitions: 2, skip_validator: false, fixture_ref: 'main', crosscheck: 'c:m:h' }).hash)
})
test('compare arguments reject bad, missing and duplicate options; suite-relative defaults', () => {
  const args = parseArgs(['compare', '--eval-issue', 'Codagent-AI/agent-evals#1', 'a', 'b', '--json'])
  assert.equal(args.record, join(suite, 'experiments/baseline.json'))
  assert.equal(args.baselineResults, join(suite, 'results'))
  assert.deepEqual(args.directories, ['a', 'b'])
  for (const argv of [[], ['--eval-issue', 'bad'], ['--eval-issue', 'o/r#0'], ['--eval-issue', 'o/r#1', '--json', '--json'], ['--eval-issue', 'o/r#1', '--record'], ['--eval-issue', 'o/r#1', '--unknown'], ['--eval-issue', 'o/r#1', '--reason', 'why']]) assert.throws(() => parseArgs(['compare', ...argv]))
  assert.deepEqual(parseArgs(['--help']), { help: true })
})
test('admission retains product failures and refuses invalid evidence with every code', () => {
  assert.deepEqual(admission().refusals, [])
  for (const [patch, code] of [
    [{ schema_version: 7 }, 'unsupported-schema'], [{ run_kind: 'reference' }, 'not-candidate'],
    [{ failure: { reason: 'infra' } }, 'infrastructure-failure'], [{ automated_subtotal: null }, 'infrastructure-failure'],
  ]) {
    const output = admission([item('c-1'), item('c-2', patch)])
    assert.ok(codes(output).includes(code))
    assert.ok(codes(output).includes('too-few-repetitions'))
  }
  assert.deepEqual(admission([item('c-1'), item('c-2', { automated_subtotal: null, product_failure: { phase: 'verification', reason: 'build failed' } })]).refusals, [])
  assert.ok(codes(admission([item('c-1')])).includes('too-few-repetitions'))
})
test('lineage overlaps within candidates and baseline; minimum counts independent runs', () => {
  for (const patch of [
    { run_id: 'cand-1' }, { workflow: { events: [{ event: 'imported-completed-run', source_run_id: 'cand-1' }] } },
  ]) assert.ok(codes(admission([item('cand-1'), item('cand-2', patch)])).includes('lineage-overlap'))
  const pairs = [
    [item('x', { workflow: { run_id: 'exec' } }), item('y', { workflow: { run_id: 'exec' } })],
    [item('x', { workflow: { events: [{ event: 'imported-completed-run', source_run_id: 'source' }] } }), item('y', { workflow: { events: [{ event: 'imported-completed-run', source_run_id: 'source' }] } })],
  ]
  for (const pair of pairs) {
    assert.ok(codes(admission(pair)).includes('lineage-overlap'))
    assert.ok(codes(admission(pair)).includes('too-few-repetitions'))
  }
  assert.ok(codes(admission([item('base-1'), item('cand-2')])).includes('lineage-overlap'))
})
test('all candidate identity fields match; fixture/rubric checked on every repetition', () => {
  const patches = [
    { workflow: { provenance: { commit: sha('c') } } }, { workflow: { agent_skills_provenance: { commit: sha('c') } } },
    ...baseline.WORKFLOW_FIELDS.map(field => ({ workflow: { [field]: 'other' } })),
    ...baseline.PROFILE_FIELDS.map(field => ({ role_configuration: { roles: { implementor: { configured: { [field]: 'other' } } } } })),
    { candidate_source: { fixture_commit: 'other' } },
    ...['automated', 'human'].flatMap(r => baseline.RUBRIC_FIELDS.map(f => ({ rubrics: { [r]: { [f]: 'other' } } }))),
  ]
  for (const patch of patches) assert.ok(codes(admission([item('c-1'), item('c-2', patch)])).includes('candidate-identity-mismatch'), JSON.stringify(patch))
  for (const field of ['fixture_commit', ...['automated', 'human'].flatMap(r => baseline.RUBRIC_FIELDS.map(f => 'rubrics.' + r + '.' + f))]) {
    for (const value of ['different', null]) {
      const base = current()
      const keys = field.split('.'); let target = base.reps[1]
      for (const key of keys.slice(0, -1)) target = target[key]
      target[keys.at(-1)] = value
      const result = admission(candidates(), base)
      assert.ok(result.refusals.some(x => x.code === 'not-comparable' && x.message.includes(field)), field)
    }
  }
  const base = current()
  base.reps[1].roles.implementor.configured.model = 'other'
  base.reps[1].mismatch = { reason: 'accepted alias' }
  const result = admission(candidates(), base)
  assert.deepEqual(result.refusals, [])
  assert.equal(result.baseline_mismatches[0].reason, 'accepted alias')
  assert.equal(result.baseline_mismatches[0].fields[0].field, 'roles.implementor.configured.model')
})
test('request checks configured profiles and normalized skip_validator', () => {
  const identity = baseline.identityOf(item('c').entry)
  assert.deepEqual(comparison.checkRequest({ implementor: 'codex:model-a:high', skip_validator: false }, identity), [])
  for (const value of ['false', false, 'true', true]) {
    identity.workflow.skip_validator = value
    assert.deepEqual(comparison.checkRequest({ skip_validator: value === true || value === 'true' }, identity), [])
  }
  identity.workflow.skip_validator = null
  const failures = comparison.checkRequest({ implementor: 'claude:opus:high', tester: 'c:m:h', skip_validator: false }, identity)
  assert.equal(failures.length, 3)
  assert.ok(failures.every(x => x.code === 'request-results-mismatch'))
})
test('planning uses recorded commits; requested role agent remains ancillary', () => {
  const base = baseline.identityOf(item('b').entry), cand = structuredClone(base)
  cand.runner_commit = sha('c'); cand.skills_commit = sha('d')
  cand.roles.implementor.configured.agent = 'new-agent'; cand.workflow.final_validator = 'skip'
  const settings = { agent_runner_ref: 'feature-x', implementor: 'codex:model-a:high' }
  const plan = comparison.planCompares(settings, base, cand)
  assert.deepEqual(plan.map(x => [x.kind, x.base, x.head]), [['primary', 'main', sha('c')], ['ancillary', sha('b'), sha('d')]])
  const compares = [
    { ...plan[0], main_sha: sha('e'), ahead_by: 0, commits: [] },
    { ...plan[1], ahead_by: 2, behind_by: 1 },
    { repo: plan[0].repo, kind: 'main-moved', base: sha('a'), head: sha('f'), ahead_by: 5, behind_by: 0 },
  ]
  let differences = comparison.classifyDifferences(settings, base, cand, compares)
  assert.equal(differences.primary.length, 1)
  assert.equal(differences.primary[0].may_have_merged, true)
  assert.ok(differences.ancillary.some(x => x.field === 'roles.implementor.configured.agent'))
  assert.ok(differences.ancillary.some(x => x.field === 'workflow.final_validator'))
  assert.ok(differences.ancillary.some(x => x.kind === 'main-moved' && x.ahead_by === 5))
  cand.roles.implementor.configured.model = 'new'
  differences = comparison.classifyDifferences({ ...settings, implementor: 'codex:new:high' }, base, cand, compares)
  assert.ok(differences.primary.some(x => x.setting === 'implementor'))
  assert.ok(differences.ancillary.some(x => x.field?.endsWith('.agent')))
  assert.ok(!differences.ancillary.some(x => x.field?.endsWith('.model')))
  assert.ok(comparison.classifyDifferences({}, base, cand, []).ancillary.some(x => x.field === 'roles.implementor.configured.model'))
  assert.equal(comparison.classifyDifferences({ agent_runner_ref: 'main' }, base, cand, [{ ...compares[0], requested_ref: 'main' }]).primary[0].may_have_merged, undefined)
  assert.deepEqual(comparison.planCompares({}, base, base), [])
})
test('bands: worked numbers, one baseline repetition, thresholds, percentages and infinity', () => {
  const run = (kind, a, b) => comparison.band({ kind, base: { ...baseline.stats(a), n: a.length }, cand: { ...baseline.stats(b), n: b.length } })
  assert.equal(run('score', [60, 60], [62, 62]).level, 'same')
  assert.equal(run('score', [60, 60], [67, 67]).direction, 'better')
  assert.equal(run('score', [60, 60], [67, 67]).level, 'clear')
  assert.equal(run('score', [60, 60], [53, 53]).direction, 'worse')
  assert.equal(run('resource', [100, 100], [90, 90]).level, 'leaning')
  assert.equal(run('resource', [100, 100], [85, 85]).level, 'clear')
  assert.equal(run('resource', [10, 10], [10, 10]).level, 'same')
  assert.equal(run('resource', [0], [1, 1]).z_infinite, true)
  assert.equal(run('resource', [0], [1, 1]).level, 'clear')
  assert.equal(run('score', [60], [67, 67]).level, 'leaning')
  for (const [z, expected] of [[1.2799, 'same'], [1.28, 'leaning'], [1.9599, 'leaning'], [1.96, 'clear']]) assert.equal(comparison.band({ kind: 'score', base: { n: 2, mean: 0, stddev: 3 }, cand: { n: 2, mean: z * 3, stddev: 3 } }).level, expected)
})
test('joint completeness, role/provider zero-fill, cost sums, zero baseline percentages', () => {
  const reps = [...current().reps, ...candidates().map(x => x.entry)]
  const costs = Object.fromEntries(reps.map(x => [x.run_id, { complete: true, by_role: { implementor: 2 } }]))
  costs['cand-1'].by_role.crosscheck = 1; reps[2].tokens.by_provider.anthropic = { total: 10 }
  let metrics = comparison.compareMetrics(reps.slice(0, 2), reps.slice(2), costs)
  assert.equal(metrics['cost_role:lead'].baseline.mean, 0)
  assert.equal(metrics['cost_role:lead'].delta_pct, 0)
  assert.equal(metrics['cost_role:crosscheck'].delta_pct, null)
  assert.equal(metrics['tokens_provider:anthropic'].baseline.mean, 0)
  assert.equal(metrics['tokens_provider:anthropic'].candidate.mean, 5)
  assert.equal(comparison.roleCosts({ cost: { total: { complete: true }, rows: [{ agent_role: 'x', cost: { amount_usd: 2 } }, { agent_role: 'x', cost: { amount_usd: 3 } }] } }).by_role.x, 5)
  reps[0].tokens.complete = false; reps[3].tokens.totals = null
  reps[1].cost.complete = false; costs['cand-1'].complete = false; reps[2].active_duration_ms = null
  metrics = comparison.compareMetrics(reps.slice(0, 2), reps.slice(2), costs)
  assert.deepEqual(metrics.tokens_total.missing_run_ids, ['base-1', 'cand-2'])
  assert.deepEqual(metrics['tokens_provider:anthropic'].missing_run_ids, ['base-1', 'cand-2'])
  assert.deepEqual(metrics.estimated_cost_usd.missing_run_ids, ['base-2'])
  assert.deepEqual(metrics['cost_role:lead'].missing_run_ids, ['base-2', 'cand-1'])
  assert.equal(metrics.active_duration_ms.status, 'incomplete')
  assert.equal(metrics.tokens_total.baseline, undefined)
})
test('reliability flags: gates, product failure and strict six-point shortfall', () => {
  const reps = [
    item('gate', { score: { gates: [{ id: 'verification-sample-outline', verdict: 'fail' }] } }).entry,
    item('short', { automated_subtotal: { points: 48.5 } }).entry,
    item('boundary', { automated_subtotal: { points: 49 } }).entry,
    item('failed', { automated_subtotal: null, product_failure: { phase: 'verification', reason: 'build failed', failures: [{ id: 'build' }] } }).entry,
  ]
  const summary = { automated_points: { complete: true, mean: 55 } }
  const flags = comparison.reliabilityFlags(reps, summary)
  assert.equal(flags.items.length, 3)
  assert.equal(flags.items.find(x => x.kind === 'score-shortfall').shortfall, 6.5)
  assert.ok(flags.items.find(x => x.run_id === 'gate').gate_ids.includes('verification-sample-outline'))
  assert.equal(flags.items.find(x => x.run_id === 'failed').phase, 'verification')
  assert.equal(comparison.reliabilityFlags(reps, { automated_points: { complete: false } }).shortfall_check, 'unavailable')
  assert.equal(comparison.reliabilityFlags([reps[2]], summary).items.length, 0)
})
function reportFor(base = current(), list = candidates()) {
  const all = [...base.reps, ...list.map(x => x.entry)]
  return comparison.buildReport({ baseline: base, candidates: list, roleCosts: Object.fromEntries(all.map(x => [x.run_id, { complete: true, by_role: {} }])),
    request: request.validateRequest({}), compares: [], eval_issue: 'o/r#1' })
}
test('median pointers order unscored runs, distinguish reviewed/pending; human scores have no band', () => {
  const base = current(); base.human_review.run_id = 'base-2'
  let report = reportFor(base, [item('a', { official_score: null, human_review: null }), item('b')])
  assert.equal(report.human_review.baseline.is_current_median, false)
  assert.equal(report.human_review.candidate.run_id, 'a')
  assert.equal(report.human_review.candidate.status, 'pending')
  report = reportFor(base, [item('a', { automated_subtotal: null, product_failure: { reason: 'failed' } }), item('b'), item('c')])
  assert.equal(report.human_review.candidate.run_id, 'b')
  assert.equal(report.human_review.candidate.points, 20)
  assert.equal(report.human_review.candidate.official_score, 70)
  assert.equal(report.human_review.candidate.band, undefined)
})
test('Markdown trimming preserves metrics, flags, omitted counts and original JSON', () => {
  const report = reportFor()
  report.differences.primary = [{ repo: 'o/r', requested_ref: 'x', recorded_commit: sha('a'), main_sha: sha('b'), ahead_by: 300, omitted: 280, commits: Array.from({ length: 20 }, () => ({ sha: sha('a'), subject: 'X'.repeat(5000) })) }]
  report.differences.baseline_mismatches = Array.from({ length: 20 }, (_, i) => ({ run_id: 'm' + i, reason: 'Y'.repeat(5000), fields: [{ field: 'roles.tester.configured.model', baseline: 'a', repetition: 'b' }] }))
  const original = JSON.stringify(report), markdown = formatMarkdown(report)
  assert.ok(markdown.length <= 65536)
  assert.match(markdown, /… and 300 more/)
  assert.match(markdown, /… and 15 more/)
  assert.match(markdown, /## Metrics/)
  assert.match(markdown, /## Reliability flags/)
  assert.equal(JSON.stringify(report), original)
  assert.throws(() => formatMarkdown(report, { limit: 10 }), /exceeds/)
  const empty = formatMarkdown(reportFor())
  assert.match(empty, /No primary differences/)
  assert.match(empty, /No ancillary differences/)
  assert.match(empty, /No reliability flags/)
})

// A real executable boundary: unprojected responses include the oversized payload.
function ghStub() {
  const fs = require('node:fs')
  const argv = process.argv.slice(2)
  fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(argv) + '\n')
  const table = JSON.parse(fs.readFileSync(process.env.GH_STUB_TABLE, 'utf8'))
  const response = table.responses[argv[1]]
  if (!response || response.error) {
    process.stderr.write(response?.error ?? 'unexpected API path')
    process.exit(1)
  }
  if (response.invalid) { process.stderr.write('malformed response'); process.stdout.write('{broken'); process.exit(0) }
  let data = response
  const kind = argv[1].includes('/issues/') ? 'issue' : argv[1].endsWith('/commits/main') ? 'main' : 'compare'
  if (argv[0] === 'api' && argv[2] === '--jq' && argv[3] === table.projections[kind]) {
    if (kind === 'issue') data = { body: data.body }
    else if (kind === 'main') data = { sha: data.sha }
    else data = { status: data.status, ahead_by: data.ahead_by, behind_by: data.behind_by, merge_base: data.merge_base_commit.sha,
      commits: data.commits.slice(0, 20).map(x => ({ sha: x.sha, subject: x.commit.message.split('\n')[0] })) }
  }
  process.stdout.write(JSON.stringify(data))
}
const rawCompare = (ahead = 3, base = sha('a')) => ({
  status: ahead ? 'ahead' : 'identical', ahead_by: ahead, behind_by: 0, merge_base_commit: { sha: base },
  commits: Array.from({ length: ahead }, (_, i) => ({ sha: sha(String(i % 10)), commit: { message: 'commit ' + i + '\nbody' } })),
})
async function stub(t, responses) {
  const root = await makeTempDir('experiment-comparison-gh-')
  const table = join(root, 'table.json'), log = join(root, 'argv.jsonl')
  await writeFile(table, JSON.stringify({ projections: github.PROJECTIONS, responses }))
  await writeFile(log, '')
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  await writeFile(join(root, 'gh'), '#!/usr/bin/env node\n(' + ghStub.toString() + ')()\n')
  await chmod(join(root, 'gh'), 0o755)
  const env = { ...process.env, PATH: root + ':' + process.env.PATH, GH_STUB_TABLE: table, GH_STUB_LOG: log }
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, table, log, env, responses, update: () => writeFile(table, JSON.stringify({ projections: github.PROJECTIONS, responses })) }
}
const issuePath = 'repos/Codagent-AI/agent-evals/issues/1'
test('INT-001: projected real gh subprocess reads, >1 MiB response, errors and safe argv', async t => {
  const body = '$(touch forbidden) ' + String.fromCharCode(96) + 'verbatim' + String.fromCharCode(96) + '\n' + block('agent_runner_ref = "feature-x"')
  const huge = rawCompare(300)
  huge.files = [{ patch: 'p'.repeat(2 * 1024 * 1024) }]
  const repo = 'Codagent-AI/agent-runner'
  const responses = {
    [issuePath]: { body }, ['repos/' + repo + '/commits/main']: { sha: sha('e') },
    ['repos/' + repo + '/compare/' + sha('e') + '...' + sha('c')]: huge,
    ['repos/' + repo + '/compare/' + sha('e') + '...' + sha('d')]: rawCompare(0),
    ['repos/' + repo + '/compare/' + sha('e') + '...' + sha('f')]: { error: 'compare denied' },
    ['repos/' + repo + '/compare/' + sha('e') + '...' + sha('b')]: { invalid: true },
  }
  const gh = await stub(t, responses)
  const saved = { PATH: process.env.PATH, GH_STUB_TABLE: process.env.GH_STUB_TABLE, GH_STUB_LOG: process.env.GH_STUB_LOG }
  Object.assign(process.env, { PATH: gh.env.PATH, GH_STUB_TABLE: gh.table, GH_STUB_LOG: gh.log })
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  assert.equal(github.issueBody({ owner: 'Codagent-AI', repo: 'agent-evals', number: 1 }).body, body)
  assert.deepEqual(github.resolveMain(repo, { now: () => new Date(at) }), { ok: true, sha: sha('e'), resolved_at: at })
  const result = github.compare(repo, sha('e'), sha('c'))
  assert.equal(result.ok, true)
  assert.equal(result.ahead_by, 300); assert.equal(result.behind_by, 0)
  assert.equal(result.merge_base, sha('a')); assert.equal(result.commits.length, 20)
  assert.equal(result.commits[0].subject, 'commit 0')
  assert.equal(github.compare(repo, sha('e'), sha('d')).ahead_by, 0)
  assert.match(github.compare(repo, sha('e'), sha('f')).message, /compare denied/)
  assert.equal(github.compare(repo, sha('e'), sha('b')).ok, false)
  const before = await readFile(gh.log, 'utf8')
  assert.equal(github.compare(repo, 'main;echo unsafe', sha('c')).ok, false)
  assert.equal(github.compare('../bad', sha('e'), sha('c')).ok, false)
  assert.equal(await readFile(gh.log, 'utf8'), before)
  for (const argv of before.trim().split('\n').map(JSON.parse)) assert.deepEqual(argv.slice(2, 3), ['--jq'])
  const unprojected = spawnSync('gh', ['api', 'repos/' + repo + '/compare/' + sha('e') + '...' + sha('c')], { env: gh.env, encoding: 'utf8' })
  assert.equal(unprojected.error?.code, 'ENOBUFS')
  assert.equal(github.compare(repo, sha('e'), sha('c'), { exec: () => ({ error: Error('spawn failed'), status: null }) }).message, 'spawn failed')
  process.env.PATH = '/does-not-exist'
  assert.equal(github.resolveMain(repo).ok, false)
})
test('GitHub compare invalid-input errors identify repository and both commits', () => {
  const exec = () => { throw Error('invalid inputs must not call GitHub') }
  for (const [repo, base, head] of [
    ['Codagent-AI/agent-runner', sha('a'), null],
    ['Codagent-AI/agent-runner', 'abc123', sha('b')],
    ['../bad', sha('a'), sha('b')],
  ]) {
    assert.deepEqual(github.compare(repo, base, head, { exec }), {
      ok: false, message: `Invalid repository or commit SHA: ${repo} ${base}...${head}`,
    })
  }
})
test('GitHub compare refuses a null commit entry without throwing', () => {
  const exec = () => ({ status: 0, stdout: JSON.stringify({
    status: 'ahead', ahead_by: 1, behind_by: 0, merge_base: sha('a'), commits: [null],
  }) })
  assert.deepEqual(github.compare('Codagent-AI/agent-runner', sha('a'), sha('b'), { exec }), {
    ok: false, message: 'Invalid compare response',
  })
})
async function writeResult(root, result) {
  const directory = join(root, result.run_id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'result.json'), JSON.stringify(result))
  return directory
}
async function invoke(argv, extra = {}) {
  let output = ''
  const outcome = await runExperimentsCommand({ argv, now: () => new Date(at), stdout: text => { output += text }, write: () => { throw Error('compare attempted a write') }, ...extra })
  return { ...outcome, output }
}
function projectedExec(body = block(''), calls = []) {
  return (command, argv, options) => {
    calls.push(argv)
    assert.equal(command, 'gh'); assert.equal(options.timeout, 60000); assert.equal(options.maxBuffer, 8 * 1024 * 1024)
    let data
    if (argv[1].includes('/issues/')) data = { body }
    else if (argv[1].endsWith('/commits/main')) data = { sha: sha('e') }
    else data = { status: 'ahead', ahead_by: 3, behind_by: 0, merge_base: argv[1].split('/').at(-1).split('...')[0], commits: [{ sha: sha('c'), subject: 'change' }] }
    return { status: 0, stdout: JSON.stringify(data) }
  }
}
async function hashes(root) {
  const entries = {}
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await walk(child)
      else entries[child] = createHash('sha256').update(await readFile(child)).digest('hex')
    }
  }
  await walk(root)
  return entries
}
test('INT-002: published schema-8 files, baseline rereads, admission variants and read-only', async t => {
  const root = await makeTempDir('experiment-comparison-published-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const ids = ['aab6fbe4-c5d1-4ab8-a169-e71500370a30-rep-1', '3938f16c-81f7-4334-9bbd-ad215d88f112-rep-1', '3938f16c-81f7-4334-9bbd-ad215d88f112-rep-2', '19b861fd-0efc-4476-bcc1-b73ef46e86f2-rep-1']
  const dirs = []
  for (const id of ids) {
    const directory = join(root, id)
    await mkdir(directory)
    await writeFile(join(directory, 'result.json'), await readFile(join(suite, 'results', id, 'result.json')))
    dirs.push(directory)
  }
  const record = join(root, 'baseline.json')
  const set = await invoke(['baseline', 'set', dirs[0], '--source', 'manual', '--reason', 'test', '--record', record], { write: undefined })
  assert.equal(set.exitCode, 0)
  const before = await hashes(root), exec = projectedExec()
  const argv = ['compare', '--eval-issue', 'Codagent-AI/agent-evals#1', dirs[1], dirs[2], '--record', record, '--baseline-results', root, '--json']
  const compared = await invoke(argv, { exec })
  assert.equal(compared.exitCode, 0, compared.output)
  const report = JSON.parse(compared.output)
  assert.equal(report.metrics.estimated_cost_usd.status, 'incomplete')
  assert.deepEqual(report.metrics.estimated_cost_usd.missing_run_ids, ids.slice(0, 3))
  for (const [key, metric] of Object.entries(report.metrics).filter(([key]) => key.startsWith('cost_role:'))) {
    assert.equal(metric.status, 'incomplete', key)
    assert.deepEqual(metric.missing_run_ids, ids.slice(0, 3)); assert.equal(metric.baseline, undefined)
  }
  const mismatch = await invoke([...argv, dirs[3]], { exec })
  assert.ok(mismatch.errors.some(x => x.code === 'not-comparable'))
  const duplicate = await invoke([...argv, dirs[1]], { exec })
  assert.ok(duplicate.errors.some(x => x.code === 'lineage-overlap'))
  assert.deepEqual(await hashes(root), before)
  const baselineBytes = await readFile(join(dirs[0], 'result.json'))
  await rm(dirs[0], { recursive: true })
  const removed = await invoke(argv, { exec })
  assert.equal(removed.exitCode, 0)
  assert.deepEqual(JSON.parse(removed.output), report)
  await mkdir(dirs[0])
  await writeFile(join(dirs[0], 'result.json'), baselineBytes)
  assert.deepEqual(await hashes(root), before)
})
async function syntheticSetup(t, { unscored = false } = {}) {
  const root = await makeTempDir('experiment-comparison-synthetic-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = [], cand = []
  for (const id of ['base-1', 'base-2']) base.push(await writeResult(root, makeResult({
    schema_version: 9, run_id: id, workflow: { provenance: { commit: sha('a') }, agent_skills_provenance: { commit: sha('b') } },
    cost: { rows: [{ agent_role: 'lead', cost: { amount_usd: 2 }, provider: 'openai', token_totals: { total: 100 } }] },
  })))
  for (const [i, id] of ['cand-1', 'cand-2', 'cand-3'].entries()) {
    cand.push(await writeResult(root, makeResult({
      schema_version: 9, run_id: id,
      workflow: { provenance: { commit: sha('c') }, agent_skills_provenance: { commit: sha('d') } },
      automated_subtotal: unscored && i === 0 ? null : { points: 57 + i, complete: true, possible: 70 },
      product_failure: unscored && i === 0 ? { phase: 'verification', reason: 'build failed', gate: null, failures: [] } : null,
      human_review: unscored && i === 0 ? null : { complete: true, score: { total: 20, possible: 30 } },
      official_score: unscored && i === 0 ? null : 77 + i,
      score: { gates_passed: i !== 2, gates: [{ id: 'verification-sample-outline', verdict: i === 2 ? 'fail' : 'pass' }] },
      cost: { usage: { token_totals: { total: 50 } }, total: { estimated_api_cost_usd: 1 }, rows: [{ agent_role: 'lead', cost: { amount_usd: 1 }, provider: 'openai', token_totals: { total: 50 } }] },
      implementation_metrics: { active_duration_ms: 30000 },
    })))
  }
  return { root, base, cand, record: join(root, 'baseline.json') }
}
test('INT-003: unscored product failure from files remains counted and qualifies resource bands', async t => {
  const fixture = await syntheticSetup(t, { unscored: true })
  const { root, base, cand, record } = fixture
  assert.equal((await invoke(['baseline', 'set', ...base, '--source', 'manual', '--reason', 'test', '--record', record], { write: undefined })).exitCode, 0)
  const before = await hashes(root)
  const exec = projectedExec(block('agent_runner_ref = "feature-x"'))
  const argv = ['compare', '--eval-issue', 'Codagent-AI/agent-evals#1', ...cand, '--record', record, '--baseline-results', root]
  const markdown = await invoke(argv, { exec }), json = await invoke([...argv, '--json'], { exec })
  assert.equal(markdown.exitCode, 0); assert.equal(json.exitCode, 0)
  const report = JSON.parse(json.output)
  assert.equal(report.candidate.repetitions, 3)
  assert.deepEqual(report.metrics.automated_points, { status: 'incomplete', missing_run_ids: ['cand-1'] })
  assert.equal(report.metrics.estimated_cost_usd.band.level, 'clear')
  assert.equal(report.metrics.estimated_cost_usd.band.direction, 'better')
  assert.equal(report.metrics.estimated_cost_usd.band.includes_product_failures, true)
  assert.equal(report.metrics.tokens_total.status, 'compared'); assert.equal(report.metrics.active_duration_ms.status, 'compared')
  const flag = report.flags.items.find(x => x.run_id === 'cand-1')
  assert.equal(flag.phase, 'verification'); assert.equal(flag.reason, 'build failed')
  assert.match(markdown.output, /incomplete \(missing: cand-1\)/)
  assert.match(markdown.output, /clearly better \(includes product failures\)/)
  assert.match(markdown.output, /verification: build failed/)
  assert.deepEqual(await hashes(root), before)
})
test('E2E-001: real operator CLI journey, JSON parity, all refusals and help', async t => {
  const { root, base, cand, record } = await syntheticSetup(t)
  const runner = 'Codagent-AI/agent-runner', skills = 'Codagent-AI/agent-skills'
  const responses = {
    [issuePath]: { body: block('agent_runner_ref = "feature-x"') },
    ['repos/' + runner + '/commits/main']: { sha: sha('e') },
    ['repos/' + skills + '/commits/main']: { sha: sha('f') },
    ['repos/' + runner + '/compare/' + sha('e') + '...' + sha('c')]: rawCompare(3),
    ['repos/' + skills + '/compare/' + sha('b') + '...' + sha('d')]: rawCompare(2, sha('b')),
  }
  const gh = await stub(t, responses)
  const cli = argv => spawnSync(process.execPath, [join(suite, 'experiments.mjs'), ...argv], { env: gh.env, encoding: 'utf8' })
  const set = cli(['baseline', 'set', ...base, '--source', 'manual', '--reason', 'test', '--record', record])
  assert.equal(set.status, 0, set.stderr)
  const before = await hashes(root)
  const argv = ['compare', '--eval-issue', 'Codagent-AI/agent-evals#1', ...cand, '--record', record, '--baseline-results', root]
  const markdown = cli(argv), json = cli([...argv, '--json'])
  assert.equal(markdown.status, 0, markdown.stderr); assert.equal(json.status, 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.status, 'compared')
  assert.ok(markdown.stdout.length <= 65536)
  for (const heading of ['Experiment comparison', 'Primary differences', 'Ancillary differences', 'Metrics', 'Reliability flags', 'Human review', 'Provenance']) assert.ok(markdown.stdout.includes('# ' + heading))
  for (const commit of report.differences.primary[0].commits) assert.ok(markdown.stdout.includes(commit.sha.slice(0, 8) + ' ' + commit.subject))
  assert.ok(markdown.stdout.includes(skills))
  assert.equal(report.human_review.candidate.run_id, 'cand-2')
  assert.ok(markdown.stdout.includes('Candidate median: cand-2'))
  assert.ok(markdown.stdout.includes('Official score 78; human points 20/30'))
  assert.ok(markdown.stdout.includes('cand-3: gate failure'))
  assert.ok(markdown.stdout.includes('verification-sample-outline'))
  for (const metric of Object.values(report.metrics).filter(x => x.status === 'compared')) {
    const label = metric.band.level === 'same' ? 'same' : (metric.band.level === 'clear' ? 'clearly' : 'leaning') + ' ' + metric.band.direction
    assert.ok(markdown.stdout.includes(label))
  }
  assert.equal(report.provenance.repositories.length, 2)
  for (const repo of report.provenance.repositories) {
    assert.ok(markdown.stdout.includes(repo.main_sha))
    assert.ok(markdown.stdout.includes(repo.resolved_at.slice(0, 10)))
    assert.ok(markdown.stdout.includes(repo.compares[0].range))
  }
  const logged = (await readFile(gh.log, 'utf8')).trim().split('\n').map(JSON.parse)
  for (const repo of [runner, skills]) assert.equal(logged.filter(argv => argv[1] === 'repos/' + repo + '/commits/main').length, 2)
  responses[issuePath].body = block('') + '\n' + block('')
  await gh.update()
  const refused = cli(['compare', '--eval-issue', 'Codagent-AI/agent-evals#1', cand[0], '--record', record, '--baseline-results', root])
  assert.equal(refused.status, 1)
  const errors = refused.stderr.trim().split('\n').map(JSON.parse)
  assert.ok(errors.some(x => x.code === 'too-few-repetitions'))
  assert.ok(errors.some(x => x.code === 'eval-block-ambiguous'))
  assert.match(refused.stdout, /Comparison refused/)
  const jsonRefused = cli(['compare', '--eval-issue', 'Codagent-AI/agent-evals#1', cand[0], '--record', record, '--json'])
  assert.equal(JSON.parse(jsonRefused.stdout).status, 'refused')
  const help = cli(['--help'])
  assert.equal(help.status, 0); assert.match(help.stdout, /compare --eval-issue <owner\/repo#N> <result-dir>/)
  assert.deepEqual(await hashes(root), before)
})
test('CLI refuses a baseline repetition with missing roles as invalid-record', async t => {
  const { root, cand, record } = await syntheticSetup(t)
  const doc = { ...baseline.emptyRecord(), current: current() }
  delete doc.current.reps[0].roles
  await writeFile(record, JSON.stringify(doc))
  const gh = await stub(t, { [issuePath]: { body: block('') } })
  const result = spawnSync(process.execPath, [join(suite, 'experiments.mjs'), 'compare', '--eval-issue', 'Codagent-AI/agent-evals#1', ...cand, '--record', record, '--baseline-results', root, '--json'], { env: gh.env, encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  const errors = result.stderr.trim().split('\n').map(JSON.parse)
  assert.ok(errors.some(x => x.code === 'invalid-record'))
  assert.ok(errors.every(x => x.code !== 'internal-error'))
  assert.equal(JSON.parse(result.stdout).status, 'refused')
})
test('baseline validation rejects malformed repetition identity objects', () => {
  for (const field of ['workflow', 'roles', 'roles.implementor', 'roles.implementor.configured', 'rubrics', 'rubrics.automated', 'rubrics.human']) {
    for (const value of [undefined, null, [], 'invalid']) {
      const doc = { ...baseline.emptyRecord(), current: current() }
      const keys = field.split('.'); let target = doc.current.reps[0]
      for (const key of keys.slice(0, -1)) target = target[key]
      target[keys.at(-1)] = value
      const errorField = field === 'roles.implementor' ? field + '.configured' : field
      assert.throws(() => baseline.validateRecord(doc), { message: `current.reps[0].${errorField}: must be an object` })
    }
  }
})
test('CLI collects independent loading refusals and never compares refused evidence', async t => {
  const root = await makeTempDir('experiment-comparison-refusals-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const record = join(root, 'record.json'), bad = join(root, 'bad')
  await mkdir(bad); await writeFile(join(bad, 'result.json'), '{broken')
  const calls = []
  const exec = projectedExec('no eval block', calls)
  let argv = ['compare', '--eval-issue', 'Codagent-AI/agent-evals#1', join(root, 'missing'), bad, '--record', record, '--json']
  let result = await invoke(argv, { exec })
  assert.equal(result.exitCode, 1)
  for (const code of ['no-current', 'missing-result', 'invalid-result', 'eval-block-missing', 'too-few-repetitions']) assert.ok(result.errors.some(x => x.code === code), code)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(result.output).status, 'refused')
  await writeFile(record, '{broken')
  result = await invoke(argv, { exec })
  assert.ok(result.errors.some(x => x.code === 'invalid-record'))
  await writeFile(record, JSON.stringify({ schema_version: 99 }))
  result = await invoke(argv, { exec })
  assert.ok(result.errors.some(x => x.code === 'invalid-record'))
  await writeFile(record, JSON.stringify(baseline.emptyRecord()))
  result = await invoke(argv, { exec: () => ({ status: 1, stderr: 'issue denied' }) })
  assert.ok(result.errors.some(x => x.code === 'eval-issue-unreadable'))
  const directoryFile = join(root, 'directory-file')
  await mkdir(join(directoryFile, 'result.json'), { recursive: true })
  result = await invoke(['compare', '--eval-issue', 'o/r#1', directoryFile, '--record', record], { exec })
  assert.equal(result.exitCode, 2); assert.equal(result.errors[0].code, 'io-error')
  result = await invoke(['compare', '--eval-issue', 'o/r#1', '--record', root], { exec })
  assert.equal(result.exitCode, 2); assert.equal(result.errors[0].code, 'io-error')
  result = await invoke(['compare', '--json'])
  assert.equal(result.exitCode, 2); assert.match(result.output, /Usage:/)
})
test('CLI resolves main once, sequences merge-base compare and reports compare failures', async t => {
  const { root, base, cand, record } = await syntheticSetup(t)
  await invoke(['baseline', 'set', ...base, '--source', 'manual', '--reason', 'test', '--record', record], { write: undefined })
  const calls = []
  let failure = false, mainFailure = false
  const exec = (command, argv, options) => {
    calls.push(argv)
    if (mainFailure && argv[1].endsWith('/commits/main')) return { status: 1, stderr: 'main denied' }
    if (failure && argv[1].includes('/compare/')) return { status: 1, stderr: 'range denied' }
    const response = projectedExec(block('agent_runner_ref = "feature-x"'))(command, argv, options)
    if (argv[1].includes('/compare/' + sha('e'))) {
      const data = JSON.parse(response.stdout); data.merge_base = sha('f')
      response.stdout = JSON.stringify(data)
    }
    return response
  }
  const argv = ['compare', '--eval-issue', 'Codagent-AI/agent-evals#1', ...cand, '--record', record, '--baseline-results', root, '--json']
  const result = await invoke(argv, { exec })
  assert.equal(result.exitCode, 0)
  assert.ok(result.report.differences.ancillary.some(x => x.kind === 'main-moved' && x.baseline === sha('a') && x.candidate === sha('f')))
  assert.equal(calls.filter(x => x[1] === 'repos/Codagent-AI/agent-runner/commits/main').length, 1)
  assert.ok(calls.some(x => x[1].endsWith('/compare/' + sha('a') + '...' + sha('f'))))
  failure = true
  const refused = await invoke(argv, { exec })
  assert.equal(refused.exitCode, 1)
  assert.ok(refused.errors.every(x => x.code === 'github-compare-failed' && x.message.includes('...')))
  mainFailure = true
  assert.equal((await invoke(argv, { exec })).exitCode, 1)
})
test('current wins over anchor; missing/mismatched baseline files only affect per-role costs', async t => {
  const { root, base, cand, record } = await syntheticSetup(t)
  await invoke(['baseline', 'set', ...base, '--source', 'manual', '--reason', 'test', '--record', record], { write: undefined })
  const doc = JSON.parse(await readFile(record, 'utf8'))
  doc.anchor = { ...structuredClone(doc.current), anchored_at: at, anchor_reason: 'test' }
  doc.anchor.reps[0].fixture_commit = 'different'
  await writeFile(record, JSON.stringify(doc))
  const argv = ['compare', '--eval-issue', 'o/r#1', ...cand, '--record', record, '--baseline-results', root, '--json']
  const result = await invoke(argv, { exec: projectedExec() })
  assert.equal(result.exitCode, 0)
  await rm(base[0], { recursive: true })
  let changed = await invoke(argv, { exec: projectedExec() })
  assert.equal(changed.exitCode, 0)
  assert.deepEqual(changed.report.metrics.estimated_cost_usd, result.report.metrics.estimated_cost_usd)
  assert.deepEqual(changed.report.metrics['cost_role:lead'], { status: 'incomplete', missing_run_ids: ['base-1'] })
  await writeResult(root, makeResult({ run_id: 'base-1' }))
  const path = join(base[0], 'result.json'), raw = JSON.parse(await readFile(path, 'utf8'))
  raw.run_id = 'wrong'
  await writeFile(path, JSON.stringify(raw))
  changed = await invoke(argv, { exec: projectedExec() })
  assert.deepEqual(changed.report.metrics['cost_role:lead'], { status: 'incomplete', missing_run_ids: ['base-1'] })
})
test('CLI carries median review from compatible rescore ancestor without changing official-score rules', async t => {
  const { root, base, cand, record } = await syntheticSetup(t)
  await invoke(['baseline', 'set', ...base, '--source', 'manual', '--reason', 'test', '--record', record], { write: undefined })
  const source = JSON.parse(await readFile(join(cand[1], 'result.json'), 'utf8'))
  source.run_id = 'original'
  await writeResult(root, source)
  const median = structuredClone(source)
  median.run_id = 'cand-2'; median.official_score = null; median.human_review = null
  median.workflow.events = [{ event: 'imported-completed-run', source_run_id: 'original' }]
  await writeResult(root, median)
  const argv = ['compare', '--eval-issue', 'o/r#1', ...cand, '--record', record, '--baseline-results', root, '--json']
  const result = await invoke(argv, { exec: projectedExec() })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.report.human_review.candidate, { run_id: 'cand-2', review_by_hand: true, status: 'complete', official_score: 78, points: 20, possible: 30, carried_from: 'original' })
  source.rubrics.human.sha256 = 'incompatible'
  await writeResult(root, source)
  const pending = await invoke(argv, { exec: projectedExec() })
  assert.equal(pending.exitCode, 0)
  assert.equal(pending.report.human_review.candidate.status, 'pending')
})
test('resource qualifications apply to either better side, never same bands or score bands', () => {
  const base = current(), cand = candidates()
  base.reps[0].failure.product_failure = { reason: 'failed delivery' }
  for (const rep of base.reps) rep.cost.estimated_api_cost_usd = 1
  let report = reportFor(base, cand)
  assert.equal(report.metrics.estimated_cost_usd.band.direction, 'worse')
  assert.equal(report.metrics.estimated_cost_usd.band.includes_product_failures, true)
  assert.equal(report.metrics.tokens_total.band.includes_product_failures, undefined)
  assert.equal(report.metrics.automated_points.band.includes_product_failures, undefined)
  base.reps[0].automated_score.points = null
  report = reportFor(base, cand)
  assert.deepEqual(report.metrics.automated_points, { status: 'incomplete', missing_run_ids: ['base-1'] })
  assert.equal(report.flags.shortfall_check, 'unavailable')
  assert.match(formatMarkdown(report), /Score-shortfall check unavailable/)
})

test('baseline cost read warnings identify missing, corrupt and mismatched evidence without refusing', async t => {
  const { root, base, cand, record } = await syntheticSetup(t)
  await invoke(['baseline', 'set', ...base, '--source', 'manual', '--reason', 'test', '--record', record], { write: undefined })
  const argv = ['compare', '--eval-issue', 'o/r#1', ...cand, '--record', record, '--baseline-results', root, '--json']
  const path = join(base[0], 'result.json')
  for (const variant of ['missing', 'corrupt', 'mismatched', 'unreadable']) {
    await rm(path, { recursive: true, force: true })
    if (variant === 'corrupt') await writeFile(path, '{broken')
    if (variant === 'mismatched') await writeFile(path, JSON.stringify(makeResult({ run_id: 'wrong' })))
    if (variant === 'unreadable') await mkdir(path)
    let diagnostics = ''
    const result = await invoke(argv, { exec: projectedExec(), stderr: text => { diagnostics += text } })
    assert.equal(result.exitCode, 0, variant)
    assert.deepEqual(result.report.metrics['cost_role:lead'], { status: 'incomplete', missing_run_ids: ['base-1'] })
    assert.equal(result.report.metrics.estimated_cost_usd.status, 'compared')
    const warning = JSON.parse(diagnostics.trim())
    assert.equal(warning.code, 'baseline-cost-unreadable')
    assert.equal(warning.run_id, 'base-1')
    assert.match(warning.message, variant === 'missing' ? /ENOENT/ : variant === 'corrupt' ? /JSON|property/i : variant === 'mismatched' ? /run id mismatch.*wrong/ : /EISDIR/)
  }
})

test('Markdown neutralizes mentions, issue references and URLs while JSON retains source text', () => {
  const text = '@org/team fixes #123 o/r#456 https://example.com www.example.com'
  const report = reportFor()
  report.request.settings.agent_runner_ref = text
  report.differences.primary = [{ repo: 'o/r', requested_ref: text, recorded_commit: sha('a'), main_sha: sha('b'), ahead_by: 1, omitted: 0, commits: [{ sha: sha('c'), subject: text }] }]
  const original = JSON.stringify(report)
  const markdown = formatMarkdown(report)
  assert.ok(markdown.includes('@\u200borg/team'))
  assert.ok(markdown.includes('#\u200b123'))
  assert.ok(markdown.includes('o/r#\u200b456'))
  assert.ok(markdown.includes('https:\u200b//example.com'))
  assert.ok(markdown.includes('www.\u200bexample.com'))
  for (const live of ['@org/team', '#123', 'o/r#456', 'https://example.com', 'www.example.com']) assert.ok(!markdown.includes(live), live)
  assert.equal(JSON.stringify(report), original)
})

test('one-repetition baseline uses candidate sample variance as specified', () => {
  const base = { n: 1, mean: 100, stddev: null }
  const cand = { n: 2, mean: 50, stddev: 10 }
  const result = comparison.band({ kind: 'resource', base, cand })
  assert.equal(result.sd, cand.stddev)
  assert.equal(result.se, 10 * Math.sqrt(1 + 1 / 2))
  assert.equal(result.level, 'clear')
})
