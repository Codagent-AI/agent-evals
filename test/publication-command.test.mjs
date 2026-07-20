// Publication as the human-review command performs it: after finalization, from
// the agent-evals working directory, against a disposable repository and remote.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runHumanReview } from '../evals/agent-runner/and-scene/human-review.mjs'
import { assembleResult } from '../evals/agent-runner/and-scene/lib/result.mjs'
import { createCheckpoint, saveCheckpoint } from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'
import { applyOutcomeEvent, createOutcome } from '../evals/agent-runner/and-scene/lib/outcomes.mjs'
import { hashJson, readJson, writeJsonAtomic } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { loadRubrics, rubricCriteria, rubricProvenance } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { scoreProduct } from '../evals/agent-runner/and-scene/lib/scorer.mjs'
import { RESULTS_RELATIVE_DIR } from '../evals/agent-runner/and-scene/lib/publication.mjs'

const rubrics = await loadRubrics()

function git(cwd, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function disposableRepo(dir) {
  const remote = join(dir, 'remote.git')
  const repo = join(dir, 'repo')
  git(dir, 'init', '--bare', '-q', '-b', 'main', remote)
  git(dir, 'clone', '-q', remote, repo)
  await writeFile(join(repo, 'README.md'), 'disposable\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  return { repo, remote }
}

function automatedEvidence(verdict = 'pass') {
  const rows = rubricCriteria(rubrics.automated.rubric)
  const result = (id) => ({ id, verdict, rationale: 'fixture evidence', evidence: ['fixture'] })
  return {
    criteria: rows.filter((row) => row.evaluator === 'deterministic-browser').map(({ id }) => result(id)),
    judges: Object.fromEntries(
      [...new Set(rows.filter(({ job }) => job).map(({ job }) => job))].map((job) => [
        job, rows.filter((row) => row.job === job).map(({ id }) => result(id)),
      ]),
    ),
    gates: rubrics.automated.rubric.gates.map(({ id }) => result(id)),
  }
}

async function pendingRun(root, { name = 'run-1' } = {}) {
  const runDir = join(root, name)
  await mkdir(join(runDir, 'phases'), { recursive: true })
  const evidence = automatedEvidence()
  await writeJsonAtomic(join(runDir, 'phases/browser-evaluation.json'), {
    criteria: evidence.criteria, gates: evidence.gates, bounds_exceeded: [],
  })
  await writeJsonAtomic(join(runDir, 'phases/product-judging.json'), {
    judges: evidence.judges, retries: {}, failed_jobs: [],
  })
  await writeJsonAtomic(join(runDir, 'ambiguity-ledger.json'), { findings: [] })
  await writeFile(join(runDir, 'implementation.diff'), 'diff --git a/App.tsx b/App.tsx\n')

  const score = scoreProduct({
    rubrics, deterministic: evidence.criteria, judges: evidence.judges, gates: evidence.gates,
  })
  const provenance = rubricProvenance(rubrics)
  await saveCheckpoint(join(runDir, 'checkpoint.json'), {
    ...createCheckpoint({
      run_id: name,
      identity: { candidate_identity: 'candidate-abc', rubric_provenance: hashJson(provenance) },
    }),
    candidate_server: { pid: 4242, url: 'http://127.0.0.1:4173/' },
    phases: {},
  })
  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'automated-scoring-complete',
    automated_subtotal: score.automated_subtotal.points,
  })
  await writeJsonAtomic(join(runDir, 'result.json'), assembleResult({
    runId: name, mode: 'agent-runner', outcome, rubrics: provenance, score,
  }))
  return { runDir, name }
}

function scriptedIo(inputs) {
  const remaining = [...inputs]
  return { write: () => {}, ask: () => (remaining.length === 0 ? null : remaining.shift()) }
}

function answers({ rating = 5, tail = ['confirm'] } = {}) {
  return ['yes', ...Array(13).fill(0).flatMap(() => [String(rating), rating <= 3 ? 'noted' : '']), ...tail]
}

function servers() {
  const live = new Set([4242])
  return {
    isProcessAlive: (pid) => live.has(pid),
    candidateServer: {
      probe: async (url) => (url === 'http://127.0.0.1:4173/'
        ? { ok: true, candidate_identity: 'candidate-abc' }
        : { ok: false, error: 'connection refused' }),
      start: async () => ({ pid: 5150, url: 'http://127.0.0.1:4173/' }),
      stop: async () => {},
    },
  }
}

function realGit(fail = () => null) {
  return (args, options = {}) => {
    const failure = fail(args)
    if (failure) return { ok: false, status: 1, stdout: '', stderr: failure }
    const result = spawnSync('git', [
      '-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval',
      '-c', 'commit.gpgsign=false', ...args,
    ], { cwd: options.cwd, encoding: 'utf8' })
    return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

test('a confirmed review publishes the finalized result and pushes it upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-publish-cmd-'))
  const { repo, remote } = await disposableRepo(dir)
  const run = await pendingRun(dir)

  const outcome = await runHumanReview({
    argv: ['--run-dir', run.runDir],
    io: scriptedIo(answers()),
    ...servers(),
    publication: { repoDir: repo, git: realGit() },
  })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  assert.equal(git(remote, 'log', '-1', '--format=%s'), `chore: record and-scene eval ${run.name}`)
  const published = await readJson(join(repo, RESULTS_RELATIVE_DIR, run.name, 'result.json'))
  assert.equal(published.evaluation_status, 'complete')
  assert.equal((await readJson(join(run.runDir, 'publication.json'))).stage, 'published')
})

test('an unconfirmed review publishes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-publish-cmd-'))
  const { repo } = await disposableRepo(dir)
  const run = await pendingRun(dir)
  const before = git(repo, 'rev-parse', 'HEAD')

  const outcome = await runHumanReview({
    argv: ['--run-dir', run.runDir],
    io: scriptedIo(answers({ tail: ['quit'] })),
    ...servers(),
    publication: { repoDir: repo, git: realGit() },
  })

  assert.equal(outcome.exitCode, 0)
  assert.equal((await readJson(join(run.runDir, 'result.json'))).evaluation_status, 'pending-human-review')
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
  assert.equal(await readJson(join(run.runDir, 'publication.json'), null), null)
})

test('a push failure exits nonzero and resume retries publication without re-asking the review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-publish-cmd-'))
  const { repo, remote } = await disposableRepo(dir)
  const run = await pendingRun(dir)

  const failed = await runHumanReview({
    argv: ['--run-dir', run.runDir],
    io: scriptedIo(answers()),
    ...servers(),
    publication: { repoDir: repo, git: realGit((args) => (args[0] === 'push' ? 'network unreachable' : null)) },
  })

  assert.equal(failed.exitCode, 1)
  // The completed product result is untouched by the delivery failure.
  const result = await readJson(join(run.runDir, 'result.json'))
  assert.equal(result.evaluation_status, 'complete')
  assert.equal(result.official_score, 100)
  const checkpoint = await readJson(join(run.runDir, 'publication.json'))
  assert.equal(checkpoint.stage, 'push')
  const commit = git(repo, 'rev-parse', 'HEAD')
  assert.equal(checkpoint.commit, commit)

  // Resume asks no question at all and retries only the unfinished push.
  const asked = []
  const retried = await runHumanReview({
    argv: ['--run-dir', run.runDir],
    io: { write: () => {}, ask: (prompt) => { asked.push(prompt); return null } },
    ...servers(),
    publication: { repoDir: repo, git: realGit() },
  })

  assert.equal(retried.exitCode, 0, JSON.stringify(retried.errors))
  assert.deepEqual(asked, [])
  assert.equal(git(repo, 'rev-parse', 'HEAD'), commit, 'no duplicate result commit')
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2')
  assert.equal(git(remote, 'rev-parse', 'HEAD'), commit)
  assert.equal((await readJson(join(run.runDir, 'publication.json'))).stage, 'published')
  assert.equal(
    (await readFile(join(repo, RESULTS_RELATIVE_DIR, run.name, 'implementation.diff'), 'utf8')),
    'diff --git a/App.tsx b/App.tsx\n',
  )
})

test('without a configured publication target the review finalizes and publishes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-publish-cmd-'))
  const run = await pendingRun(dir)

  const outcome = await runHumanReview({
    argv: ['--run-dir', run.runDir], io: scriptedIo(answers()), ...servers(),
  })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  assert.equal((await readJson(join(run.runDir, 'result.json'))).evaluation_status, 'complete')
  assert.equal(await readJson(join(run.runDir, 'publication.json'), null), null)
})
