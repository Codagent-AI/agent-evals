import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  compareDiagnosticIdentity,
  compareDiagnostics,
  evaluatorContentManifest,
  normalizeJudgeJobs,
} from '../evals/agent-runner/and-scene/lib/judge-diagnostic.mjs'
import { runProductJudging } from '../evals/agent-runner/and-scene/lib/judge-jobs.mjs'
import { loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'evals/agent-runner/and-scene/judge-diagnostic.mjs')

test('the job list is normalized to sorted unique known scored jobs', () => {
  const known = ['scene-kit', 'verification-tooling', 'testing-evidence']
  assert.deepEqual(normalizeJudgeJobs('verification-tooling, scene-kit,scene-kit', known), ['scene-kit', 'verification-tooling'])
  assert.throws(() => normalizeJudgeJobs('scene-kit,demo', known), /unknown scored judge jobs: demo/)
  assert.throws(() => normalizeJudgeJobs(' , ', known), /names no judge job/)
})

test('the evaluator content hash covers the real evaluator files and excludes published results', async () => {
  const manifest = await evaluatorContentManifest({
    'evals/lib': join(root, 'evals/lib'),
    'evals/agent-runner/and-scene': join(root, 'evals/agent-runner/and-scene'),
  })
  const paths = manifest.files.map(({ path }) => path)
  for (const required of [
    'evals/lib/panel-judging/protocol.mjs',
    'evals/agent-runner/and-scene/controller.mjs',
    'evals/agent-runner/and-scene/automated-rubric.json',
    'evals/agent-runner/and-scene/human-rubric.json',
    'evals/agent-runner/and-scene/fixture-snapshot/snapshot.json',
  ]) assert.ok(paths.includes(required), required)
  assert.ok(!paths.some((path) => path.startsWith('evals/agent-runner/and-scene/results/')))
  assert.deepEqual(paths, [...paths].sort())
  const controller = manifest.files.find(({ path }) => path === 'evals/agent-runner/and-scene/controller.mjs')
  assert.equal(controller.sha256, hashString(await readFile(join(root, 'evals/agent-runner/and-scene/controller.mjs'))))
})

test('an identity comparison names each differing field and the changed evaluator files', () => {
  const recorded = {
    judge_jobs: ['scene-kit'], source: { path: '/a', provenance_sha256: '1' }, expected: { sha256: 'e' },
    evaluator_commit: 'c', evaluator_content_sha256: 'x', evaluator_content_manifest: [{ path: 'evals/lib/p.mjs', sha256: '1' }],
    rubric_sha256: 'r', judge_profiles: { judge_model: 'm' },
  }
  assert.deepEqual(compareDiagnosticIdentity(recorded, structuredClone(recorded)), [])
  const changed = { ...structuredClone(recorded), evaluator_content_sha256: 'y',
    evaluator_content_manifest: [{ path: 'evals/lib/p.mjs', sha256: '2' }], rubric_sha256: 's' }
  const mismatches = compareDiagnosticIdentity(recorded, changed)
  assert.deepEqual(mismatches.map(({ field }) => field), ['evaluator_content_sha256', 'rubric_sha256'])
  assert.match(mismatches[0].message, /changed files: evals\/lib\/p\.mjs/)
})

test('product judging judges only the jobs a diagnostic selects', async () => {
  const rubrics = await loadRubrics()
  const asked = new Set()
  const judging = await runProductJudging({
    rubrics,
    authority: { cli: 'codex', model: 'gpt-6-sol', effort: 'high' },
    sources: ['src/index.ts'],
    jobs: ['verification-tooling'],
    invoke: async (request) => {
      asked.add(request.job)
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass', rationale: 'fixture', evidence: ['fixture'] })) })
    },
  })
  assert.deepEqual([...asked], ['verification-tooling'])
  assert.deepEqual(judging.expected_jobs, ['verification-tooling'])
  assert.deepEqual(Object.keys(judging.judges), ['verification-tooling'])
})

async function diagnosticRun(base, name, { source, expectedSha, status = 'complete', verdicts }) {
  const runDir = join(base, name)
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'diagnostic.json'), JSON.stringify({
    mode: 'judge-diagnostic', judge_jobs: ['scene-kit'], source: { path: `/runs/${source}`, run_id: source },
    expected: { path: '/elsewhere/expected.json', sha256: expectedSha },
  }))
  await writeFile(join(runDir, 'diagnostic-result.json'), JSON.stringify({ mode: 'judge-diagnostic', status, verdicts }))
  return runDir
}

test('the comparison reports verdict, basis and match per criterion and repeat, and refuses an edited expected file', async () => {
  const base = await makeTempDir(join(tmpdir(), 'and-scene-diagnostic-compare-'))
  const expectedPath = join(base, 'expected.json')
  const expectedText = `${JSON.stringify({ 'rep-a': { 'entity-persisting-morph': 'fail' }, 'rep-b': { 'entity-persisting-morph': 'pass' } })}\n`
  await writeFile(expectedPath, expectedText)
  const sha = hashString(expectedText)
  const verdict = (value, basis) => ({ 'entity-persisting-morph': { job: 'scene-kit', verdict: value, basis } })
  const runs = [
    await diagnosticRun(base, 'a-1', { source: 'rep-a', expectedSha: sha, verdicts: verdict('fail', 'consensus-fail') }),
    await diagnosticRun(base, 'a-2', { source: 'rep-a', expectedSha: sha, verdicts: verdict('pass', 'decider-pass') }),
    await diagnosticRun(base, 'b-1', { source: 'rep-b', expectedSha: sha, verdicts: verdict('pass', 'majority-pass') }),
    await diagnosticRun(base, 'b-2', { source: 'rep-b', expectedSha: sha, status: 'unloadable', verdicts: {} }),
  ]

  const report = await compareDiagnostics({ expectedPath, runDirs: runs })
  assert.deepEqual(report.rows.map(({ source, repeat, verdict: v, basis, match }) => [source, repeat, v, basis, match]), [
    ['rep-a', 1, 'fail', 'consensus-fail', true],
    ['rep-a', 2, 'pass', 'decider-pass', false],
    ['rep-b', 1, 'pass', 'majority-pass', true],
    ['rep-b', 2, null, null, false],
  ])
  assert.equal(report.rows[3].status, 'unloadable')
  assert.deepEqual(report.summary, { judged: 3, expected: 4, matched: 2, mismatched: 1, unjudged: 1 })

  const cli = spawnSync(process.execPath, [script, '--expected', expectedPath, ...runs], { encoding: 'utf8' })
  assert.equal(cli.status, 1, cli.stderr)
  assert.match(cli.stdout, /rep-a\t2\tcomplete\tentity-persisting-morph\tpass\tdecider-pass\tfail\tNO/)
  assert.match(cli.stdout, /matched 2, mismatched 1, unjudged 1/)
  const passing = spawnSync(process.execPath, [script, '--expected', expectedPath, runs[0], runs[2]], { encoding: 'utf8' })
  assert.equal(passing.status, 0, passing.stderr)

  await writeFile(expectedPath, expectedText.replace('"fail"', '"pass"'))
  await assert.rejects(compareDiagnostics({ expectedPath, runDirs: runs }), /refusing to report matches against a changed file/)
  const refused = spawnSync(process.execPath, [script, '--expected', expectedPath, ...runs], { encoding: 'utf8' })
  assert.equal(refused.status, 2)
  assert.equal(refused.stdout, '')
  assert.match(refused.stderr, /refusing to report matches/)
})
