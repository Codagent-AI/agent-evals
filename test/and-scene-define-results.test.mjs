import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assembleResult, writeResultArtifacts } from '../evals/agent-runner/and-scene-define/lib/result.mjs'
import { compareResults } from '../evals/agent-runner/and-scene-define/lib/comparison.mjs'
import { publishRun, publicationEligibility } from '../evals/agent-runner/and-scene-define/lib/publication.mjs'
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'define-results-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir }
async function json(dir, path, value) { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), JSON.stringify(value)) }
const core = { evaluation_status: 'complete', total: 42, run_id: 'recorded', mode: 'candidate' }
test('results explain all statuses, retain detailed judgments and separate usage', async t => {
  const runDir = await temp(t)
  const score = { total: 42, components: { coverage: { score: 42 } }, coverage: [{ id: 'one', verdict: 'met', citations: ['proposal.md:1'] }], panel_records: [{ family: 'claude', basis: 'decider', targeted_checks: ['check'], decider: { verdict: 'met' } }], gates: [{ passed: false }], leaked_items: ['two'], added_scope: ['extra'] }
  await json(runDir, 'judges/score.json', score)
  await json(runDir, 'discovery/ledger.json', { counts: { discovered: 1 }, items: [{ id: 'one', outcome: 'discovered' }] })
  await json(runDir, 'phases/workflow-metrics.json', { completeness: 'partial', cost: null })
  await writeFile(join(runDir, 'phases/eval-owned-usage.jsonl'), '{"cost":99}\n')
  for (const evaluation_status of ['complete', 'contaminated', 'definition-workflow-failed', 'evaluation-harness-failed']) {
    const outcome = { run_id: core.run_id, mode: core.mode, evaluation_status, owning_phase: 'define-workflow', observed_error: '<script>alert(1)</script>', resumable: true }
    const result = await assembleResult({ runDir, outcome, checkpoint: { series_identity: { rubric: 1 }, candidate: { profiles: {} } } })
    assert.equal(result.evaluation_status, evaluation_status)
    assert.equal(result.observed_error, outcome.observed_error)
    assert.equal(result.resumable, true)
    if (evaluation_status === 'complete') {
      assert.deepEqual(result.panel_records, score.panel_records); assert.equal(result.total, 42)
      assert.equal(result.leaked_count, 1); assert.equal(result.discovery_ledger.counts.discovered, 1)
    } else {
      // A score left by an earlier attempt never leaks into an incomplete result.
      assert.equal(result.total, null); assert.equal(result.components, null)
      assert.deepEqual(result.panel_records, []); assert.deepEqual(result.coverage, []); assert.deepEqual(result.gates, []); assert.deepEqual(result.added_scope, [])
      assert.equal(result.leaked_count, 0); assert.equal(result.discovery_ledger, null)
    }
    assert.equal(result.workflow_metrics.cost, null)
    assert.equal(result.eval_owned_usage[0].cost, 99)
    assert.ok(result.residual_risk)
    await writeResultArtifacts({ runDir, result })
    const html = await readFile(join(runDir, 'report.html'), 'utf8')
    assert.match(html, /&lt;script&gt;/)
    assert.doesNotMatch(html, /<script|<link|src=["']https?:/)
    if (evaluation_status === 'complete') assert.match(html, /targeted_checks/)
  }
})
test('comparison pairs only identical series and lists all changed candidate components', () => {
  const a = { ...core, series_identity: { rubric: 1 }, candidate: { agent_skills_commit: 'a', workflow_hashes: { define: 'x' } }, total: 10, leaked_count: 2 }
  const b = { ...a, candidate: { ...a.candidate, agent_skills_commit: 'b', workflow_hashes: { define: 'y' } } }
  const report = compareResults([a, b, { ...b, series_identity: { rubric: 2 } }])
  assert.equal(report.pairs[0].comparable, true)
  assert.deepEqual(report.pairs[0].candidate_differences.map(x => x.component), ['agent_skills_commit', 'workflow_hashes.define'])
  assert.equal(report.pairs[0].runs[0].leaked_count, 2)
  assert.equal(report.pairs[1].comparable, false)
  assert.match(report.pairs[1].reason, /not comparable/)
  assert.equal(report.pairs[1].runs, undefined)
  assert.deepEqual(report.unscored, [])
})
import { renderReport } from '../evals/agent-runner/and-scene-define/lib/report.mjs'
test('report opens with a readable escaped headline before the full JSON', () => {
  const headline = html => html.slice(html.indexOf('<section class="headline"'), html.indexOf('</section>', html.indexOf('<section class="headline"')))
  const complete = renderReport({ ...core, run_id: 'run<1>', total: 82.5, components: { coverage: { score: 50, points: 60 }, artifact_quality: { score: 20, points: 25 }, fidelity: { score: 12.5, points: 15 } },
    gates: [{ id: 'gate:required-artifact:design', passed: true }, { id: 'gate:openspec-validate', passed: false, reason: '<b>invalid</b>' }], leaked_count: 2,
    discovery_ledger: { counts: { discovered: 3, inferred: 1, missed: 0, 'asked-not-captured': 2, leaked: 2 } }, excluded_graded_contradictions: [{ subject_id: 'INV-001' }] })
  const top = headline(complete)
  for (const text of ['Evaluation status', 'complete', 'Total', '82.5 / 100', 'coverage', '50 / 60', 'artifact_quality', '20 / 25', 'fidelity', '12.5 / 15',
    'gate:required-artifact:design', 'passed', 'gate:openspec-validate', 'failed', '&lt;b&gt;invalid&lt;/b&gt;', 'Leaked items', 'discovered', 'asked-not-captured', 'Excluded graded contradictions']) assert.ok(top.includes(text), text)
  assert.match(complete, /run&lt;1&gt;/); assert.doesNotMatch(complete, /run<1>|<b>invalid/)
  assert.ok(complete.indexOf('<section class="headline"') < complete.indexOf('<pre>'))
  // The score is the outcome; there is no pass/fail verdict to show.
  assert.doesNotMatch(top, /verdict/i)
  const failed = headline(renderReport({ ...core, evaluation_status: 'evaluation-harness-failed', owning_phase: 'gates-and-judging', observed_error: '<script>x</script>', resumable: true, total: null, components: null, gates: [], discovery_ledger: null }))
  for (const text of ['evaluation-harness-failed', 'gates-and-judging', '&lt;script&gt;x&lt;/script&gt;', 'Resumable', 'Not scored']) assert.ok(failed.includes(text), text)
  assert.doesNotMatch(failed, /<script>/)
  const unmeasured = headline(renderReport({ ...core, score_unavailable: 'every graded item leaked, so coverage cannot be measured', total: null, components: {} }))
  assert.ok(unmeasured.includes('Not scored (every graded item leaked, so coverage cannot be measured)'))
})
test('comparison pairs only complete scored runs and lists the others as unscored', () => {
  const scored = { ...core, series_identity: { rubric: 1 }, candidate: { agent_skills_commit: 'a' }, total: 10 }
  const failed = { ...scored, run_id: 'failed', evaluation_status: 'evaluation-harness-failed', total: 99, owning_phase: 'gates-and-judging' }
  const contaminated = { ...scored, run_id: 'contaminated', evaluation_status: 'contaminated', total: null }
  const unscoredComplete = { ...scored, run_id: 'no-total', total: null }
  const other = { ...scored, run_id: 'other', total: 70, candidate: { agent_skills_commit: 'b' } }
  const report = compareResults([scored, failed, contaminated, unscoredComplete, other])
  assert.deepEqual(report.pairs.map(x => x.run_ids), [['recorded', 'other']])
  assert.deepEqual(report.pairs[0].runs.map(x => x.total), [10, 70])
  assert.equal('definition_verdict' in report.pairs[0].runs[0], false)
  assert.deepEqual(report.unscored.map(x => [x.run_id, x.evaluation_status]), [['failed', 'evaluation-harness-failed'], ['contaminated', 'contaminated'], ['no-total', 'complete']])
  assert.ok(report.unscored.every(x => x.reason))
  assert.equal(report.unscored[0].total, undefined)
})
test('INT-008 publication commits only curated files and retries a rejected push with the same commit', async t => {
  const root = await temp(t); const repoDir = join(root, 'repo'); const remote = join(root, 'remote.git'); const runDir = join(root, 'run')
  await mkdir(repoDir); await mkdir(runDir)
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  await writeFile(join(repoDir, 'base'), 'base'); git('add', 'base'); git('commit', '-m', 'chore: initial')
  git('init', '--bare', remote); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main')
  await writeFile(join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await json(runDir, 'result.json', core); await writeFile(join(runDir, 'report.html'), 'report')
  await json(runDir, 'discovery/ledger.json', { items: [] }); await mkdir(join(runDir, 'collected')); await writeFile(join(runDir, 'collected/proposal.md'), 'proposal'); await writeFile(join(runDir, 'conversation.jsonl'), '')
  await writeFile(join(runDir, 'credentials'), 'secret'); await writeFile(join(repoDir, 'unrelated'), 'dirty'); git('add', 'unrelated')
  const before = git('rev-parse', 'HEAD')
  const originalResult = await readFile(join(runDir, 'result.json'), 'utf8')
  const rejectCommit = args => {
    if (args[0] === 'commit') return { ok: false, status: 1, stderr: 'commit rejected' }
    return { ok: true, stdout: git(...args) }
  }
  await assert.rejects(publishRun({ runDir, repoDir, result: core, git: rejectCommit }), /commit rejected/)
  assert.equal(git('rev-parse', 'HEAD'), before)
  assert.equal(JSON.parse(await readFile(join(runDir, 'publication.json'), 'utf8')).stage, 'commit')
  assert.equal(await readFile(join(runDir, 'result.json'), 'utf8'), originalResult)
  await assert.rejects(publishRun({ runDir, repoDir, result: core }), /push/)
  const commit = git('rev-parse', 'HEAD'); assert.equal(git('log', '-1', '--format=%s'), 'chore: record and-scene-define eval recorded')
  const files = git('show', '--pretty=', '--name-only', 'HEAD').split('\n')
  assert.ok(files.every(x => x.startsWith('evals/agent-runner/and-scene-define/results/recorded/')))
  assert.ok(!files.some(x => /credentials|runtime|judges|logs/.test(x)))
  assert.equal(git('diff', '--cached', '--name-only'), 'unrelated')
  await rm(join(remote, 'hooks/pre-receive'))
  const published = await publishRun({ runDir, repoDir, result: core })
  assert.equal(published.commit, commit); assert.equal(git('rev-parse', 'HEAD'), commit)
  assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), commit)
  assert.equal((await publishRun({ runDir, repoDir, result: core })).commit, commit)
  // Lost delivery checkpoint and a later unrelated commit still reuse the result.
  await rm(join(runDir, 'publication.json'))
  git('commit', '-m', 'chore: unrelated change')
  const later = git('rev-parse', 'HEAD')
  assert.equal((await publishRun({ runDir, repoDir, result: core })).commit, commit)
  assert.equal(git('rev-parse', 'HEAD'), later)

  for (const result of [{ ...core, evaluation_status: 'contaminated' }, { ...core, evaluation_status: 'definition-workflow-failed' }, { ...core, evaluation_status: 'evaluation-harness-failed' }, { ...core, mode: 'rescore' }, { ...core, mode: 'calibration' }]) assert.equal((await publishRun({ runDir, repoDir, result })).skipped, true)
})
test('result assembly retains valid usage and reports corrupt or truncated usage lines', async t => {
  const runDir = await temp(t)
  await mkdir(join(runDir, 'phases'))
  await writeFile(join(runDir, 'phases/eval-owned-usage.jsonl'), '{"cost":1}\ninvalid\n{"cost":2}\n{"cost":')
  const result = await assembleResult({ runDir, outcome: core })
  assert.deepEqual(result.eval_owned_usage, [{ cost: 1 }, { cost: 2 }])
  assert.deepEqual(result.eval_owned_usage_errors.map(x => ({ line: x.line, truncated: x.truncated })), [{ line: 2, truncated: false }, { line: 4, truncated: true }])
  assert.ok(result.eval_owned_usage_errors.every(x => x.error))
  await writeResultArtifacts({ runDir, result })
  assert.match(await readFile(join(runDir, 'report.html'), 'utf8'), /eval_owned_usage_errors/)
})
test('a complete score is the result: no verdict field, and it is publishable only with a total', async t => {
  const runDir = await temp(t)
  await json(runDir, 'judges/score.json', { evaluation_status: 'complete', total: 81, components: { coverage: { score: 50, points: 70 } }, gates: [{ id: 'gate:openspec-validate', passed: false }] })
  const result = await assembleResult({ runDir, outcome: { evaluation_status: 'complete', resumable: false }, checkpoint: { kind: 'candidate', run_id: 'scored' } })
  assert.equal(result.total, 81); assert.equal('definition_verdict' in result, false); assert.equal('verdict_unavailable' in result, false)
  // A failed gate is reported and does not stop publication of the score.
  assert.equal(result.gates[0].passed, false)
  assert.equal(publicationEligibility(result), true)
  assert.equal(publicationEligibility({ ...result, total: null, score_unavailable: 'every graded item leaked, so coverage cannot be measured' }), false)
  await writeResultArtifacts({ runDir, result })
  assert.match(await readFile(join(runDir, 'report.html'), 'utf8'), /81 \/ 100/)
})
