import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CURATED_ARTIFACTS,
  RESULTS_RELATIVE_DIR,
  copySnapshot,
  publicationEligibility,
  publishRun,
} from '../evals/agent-runner/and-scene/lib/publication.mjs'
import { readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'

function git(cwd, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

// A disposable agent-evals working tree with a real configured upstream, so the
// publication path exercises an ordinary `git push` rather than a stand-in.
async function disposableRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-publish-'))
  const remote = join(dir, 'remote.git')
  const repo = join(dir, 'repo')
  git(dir, 'init', '--bare', '-q', '-b', 'main', remote)
  git(dir, 'clone', '-q', remote, repo)
  await writeFile(join(repo, 'README.md'), 'disposable\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  return { dir, repo, remote }
}

// A finalized run directory: the curated artifacts beside the runtime state,
// logs, and phase records that must never leave it.
async function finalizedRun(root, {
  runId = 'run-1',
  evaluationStatus = 'complete',
  verdict = 'pass',
  mode = 'agent-runner',
  omit = [],
} = {}) {
  const runDir = join(root, runId)
  await mkdir(join(runDir, 'phases'), { recursive: true })
  await mkdir(join(runDir, 'logs'), { recursive: true })
  await mkdir(join(runDir, '.runtime/candidate-worktree'), { recursive: true })
  await mkdir(join(runDir, 'evidence'), { recursive: true })

  const result = { run_id: runId, mode, evaluation_status: evaluationStatus, product_verdict: verdict }
  const contents = {
    'result.json': JSON.stringify(result),
    'report.html': '<!doctype html><title>report</title>',
    'human-review.json': JSON.stringify({ complete: true }),
    'ambiguity-ledger.json': JSON.stringify({ findings: [] }),
    'implementation.diff': 'diff --git a/x b/x\n',
    'artifact-manifest.json': JSON.stringify({ artifacts: [] }),
  }
  for (const [name, body] of Object.entries(contents)) {
    if (omit.includes(name)) continue
    await writeFile(join(runDir, name), body)
  }
  await writeFile(join(runDir, 'phases/score.json'), '{}')
  await writeFile(join(runDir, 'logs/agent-runner.log'), 'raw log\n')
  await writeFile(join(runDir, 'evidence/screenshot.png'), 'binary')
  await writeFile(join(runDir, '.runtime/candidate-worktree/App.tsx'), 'source')
  await writeFile(join(runDir, 'checkpoint.json'), '{}')
  return { runDir, runId, result }
}

// Records every git invocation so the tests can assert what was staged, what was
// committed, and that a push is never given a force flag.
function recordingGit({ fail = () => null, head = 'commit-sha', log = '' } = {}) {
  const calls = []
  return {
    calls,
    git: (args, options = {}) => {
      calls.push({ args, cwd: options.cwd ?? null })
      const failure = fail(args)
      if (failure) return { ok: false, status: 1, stdout: '', stderr: failure }
      if (args[0] === 'rev-parse') return { ok: true, status: 0, stdout: `${head}\n`, stderr: '' }
      if (args[0] === 'log') return { ok: true, status: 0, stdout: `${log}\n`, stderr: '' }
      if (args[0] === 'status') return { ok: true, status: 0, stdout: '', stderr: '' }
      return { ok: true, status: 0, stdout: '', stderr: '' }
    },
  }
}

test('only a finalized complete pass or product-fail run is publishable', () => {
  for (const verdict of ['pass', 'fail']) {
    const eligibility = publicationEligibility({ evaluation_status: 'complete', product_verdict: verdict })
    assert.equal(eligibility.publishable, true, verdict)
  }
  for (const result of [
    { evaluation_status: 'pending-human-review', product_verdict: 'unavailable' },
    { evaluation_status: 'implementation-workflow-failed', product_verdict: 'unavailable' },
    { evaluation_status: 'evaluation-harness-failed', product_verdict: 'unavailable' },
    { evaluation_status: 'complete', product_verdict: 'unavailable' },
    { evaluation_status: 'complete', product_verdict: 'pass', mode: 'calibration' },
  ]) {
    const eligibility = publicationEligibility(result)
    assert.equal(eligibility.publishable, false, JSON.stringify(result))
    assert.ok(eligibility.reason)
  }
})

test('a finalized run publishes exactly the curated snapshot, commits it, and pushes upstream', async () => {
  const { repo, remote, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)

  const outcome = await publishRun({ runDir, runId, result, repoDir: repo })
  assert.equal(outcome.published, true)

  const resultsDir = join(repo, RESULTS_RELATIVE_DIR, runId)
  const published = git(repo, 'ls-tree', '-r', '--name-only', 'HEAD', '--', `${RESULTS_RELATIVE_DIR}/${runId}`)
  assert.deepEqual(
    published.split('\n').sort(),
    CURATED_ARTIFACTS.map((name) => `${RESULTS_RELATIVE_DIR}/${runId}/${name}`).sort(),
  )
  assert.equal(await readFile(join(resultsDir, 'report.html'), 'utf8'), '<!doctype html><title>report</title>')

  assert.equal(git(repo, 'log', '-1', '--format=%s'), `chore: record and-scene eval ${runId}`)
  // The ordinary push reached the configured upstream.
  assert.equal(git(remote, 'log', '-1', '--format=%s'), `chore: record and-scene eval ${runId}`)
})

test('publication never stages unrelated working-tree changes', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)
  await writeFile(join(repo, 'README.md'), 'edited by something else\n')
  await writeFile(join(repo, 'scratch.txt'), 'untracked\n')

  await publishRun({ runDir, runId, result, repoDir: repo })

  const committed = git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)
  assert.deepEqual(
    committed.sort(),
    CURATED_ARTIFACTS.map((name) => `${RESULTS_RELATIVE_DIR}/${runId}/${name}`).sort(),
  )
  // The unrelated edit is still an uncommitted working-tree change.
  assert.match(git(repo, 'status', '--porcelain'), /README\.md/)
  assert.match(git(repo, 'status', '--porcelain'), /scratch\.txt/)
})

test('the permanent snapshot excludes runtime state, logs, evidence, and phase records', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId } = await finalizedRun(dir)

  const snapshot = await copySnapshot({ runDir, runId, repoDir: repo })
  assert.deepEqual([...snapshot.files].sort(), [...CURATED_ARTIFACTS].sort())

  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(join(repo, RESULTS_RELATIVE_DIR, runId))
  assert.deepEqual(entries.sort(), [...CURATED_ARTIFACTS].sort())
  for (const excluded of ['.runtime', 'logs', 'evidence', 'phases', 'checkpoint.json']) {
    assert.ok(!entries.includes(excluded), excluded)
  }
})

test('an incomplete run is never published', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir, {
    runId: 'pending-1', evaluationStatus: 'pending-human-review', verdict: 'unavailable',
  })
  const before = git(repo, 'rev-parse', 'HEAD')

  const { git: spy, calls } = recordingGit()
  const outcome = await publishRun({ runDir, runId, result, repoDir: repo, git: spy })

  assert.equal(outcome.published, false)
  assert.equal(outcome.skipped, true)
  assert.deepEqual(calls, [])
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
  assert.equal(await readJson(join(runDir, 'publication.json'), null), null)
})

test('a commit failure preserves the completed result and records a retryable checkpoint', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)
  const before = git(repo, 'rev-parse', 'HEAD')

  const { git: spy } = recordingGit({ fail: (args) => (args[0] === 'commit' ? 'index.lock exists' : null) })
  await assert.rejects(
    publishRun({ runDir, runId, result, repoDir: repo, git: spy }),
    /index\.lock exists/,
  )

  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
  assert.deepEqual(JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')), result)
  const checkpoint = await readJson(join(runDir, 'publication.json'), null)
  assert.equal(checkpoint.stage, 'commit')
  assert.equal(checkpoint.run_id, runId)
  assert.match(checkpoint.error, /index\.lock exists/)
})

test('a push failure records the commit so resume retries only the push', async () => {
  const { repo, remote, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)

  // The push fails once the commit is already durable locally.
  const failing = (args) => (args[0] === 'push' ? 'remote rejected: network unreachable' : null)
  await assert.rejects(
    publishRun({ runDir, runId, result, repoDir: repo, git: gitWithFailure(repo, failing) }),
    /network unreachable/,
  )

  const commit = git(repo, 'rev-parse', 'HEAD')
  assert.equal(git(repo, 'log', '-1', '--format=%s'), `chore: record and-scene eval ${runId}`)
  const checkpoint = await readJson(join(runDir, 'publication.json'), null)
  assert.equal(checkpoint.stage, 'push')
  assert.equal(checkpoint.commit, commit)

  // Resume retries the push, reuses that exact commit, and adds no second one.
  const outcome = await publishRun({ runDir, runId, result, repoDir: repo })
  assert.equal(outcome.published, true)
  assert.equal(outcome.commit, commit)
  assert.equal(git(repo, 'rev-parse', 'HEAD'), commit)
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2')
  assert.equal(git(remote, 'rev-parse', 'HEAD'), commit)
})

test('publication never force-pushes and always commits a limited pathspec', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)

  const { git: spy, calls } = recordingGit()
  await publishRun({ runDir, runId, result, repoDir: repo, git: spy })

  const push = calls.find(({ args }) => args[0] === 'push')
  assert.deepEqual(push.args, ['push'])
  for (const { args } of calls) {
    for (const forbidden of ['--force', '-f', '--force-with-lease']) {
      assert.ok(!args.includes(forbidden), `${forbidden} in ${args.join(' ')}`)
    }
  }
  // Staging names each curated file, so nothing that merely shares the results
  // directory can ride along.
  const expected = CURATED_ARTIFACTS.map((name) => `${RESULTS_RELATIVE_DIR}/${runId}/${name}`)
  for (const command of ['add', 'commit']) {
    const call = calls.find(({ args }) => args[0] === command)
    assert.ok(call.args.includes('--'), `${command} must be path-limited`)
    const paths = call.args.slice(call.args.indexOf('--') + 1)
    assert.deepEqual(paths.sort(), [...expected].sort(), command)
  }
})

test('a missing required artifact stops publication before any commit', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir, { omit: ['human-review.json'] })
  const before = git(repo, 'rev-parse', 'HEAD')

  const { git: spy, calls } = recordingGit()
  await assert.rejects(
    publishRun({ runDir, runId, result, repoDir: repo, git: spy }),
    /human-review\.json/,
  )
  assert.deepEqual(calls, [])
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
  const checkpoint = await readJson(join(runDir, 'publication.json'), null)
  assert.equal(checkpoint.stage, 'snapshot')
})

test('an uncurated file already in the results directory stops publication', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)
  const before = git(repo, 'rev-parse', 'HEAD')

  // Stale, accidental, or planted — either way it is not part of the curated
  // snapshot, and the directory pathspec would otherwise sweep it into a commit.
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(repo, RESULTS_RELATIVE_DIR, runId), { recursive: true })
  await writeFile(join(repo, RESULTS_RELATIVE_DIR, runId, 'credentials.env'), 'TOKEN=secret\n')

  const { git: spy, calls } = recordingGit()
  await assert.rejects(
    publishRun({ runDir, runId, result, repoDir: repo, git: spy }),
    /credentials\.env/,
  )

  assert.deepEqual(calls, [])
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
  assert.equal((await readJson(join(runDir, 'publication.json'), null)).stage, 'snapshot')
})

test('a stale artifact this run does not produce stops publication', async () => {
  const { repo, dir } = await disposableRepo()
  // This run has no ambiguity ledger, but a previous publication under the same
  // run id left one behind. Copying the curated names would not overwrite it, so
  // the published record would mix two runs.
  const { runDir, runId, result } = await finalizedRun(dir, { omit: ['ambiguity-ledger.json'] })
  const before = git(repo, 'rev-parse', 'HEAD')

  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(repo, RESULTS_RELATIVE_DIR, runId), { recursive: true })
  await writeFile(
    join(repo, RESULTS_RELATIVE_DIR, runId, 'ambiguity-ledger.json'),
    JSON.stringify({ findings: ['from an earlier run'] }),
  )

  const { git: spy, calls } = recordingGit()
  await assert.rejects(
    publishRun({ runDir, runId, result, repoDir: repo, git: spy }),
    /ambiguity-ledger\.json/,
  )

  assert.deepEqual(calls, [])
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
  assert.equal((await readJson(join(runDir, 'publication.json'), null)).stage, 'snapshot')
})

test('a resume republishes over a destination it fully overwrites', async () => {
  const { repo, remote, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)

  // The commit fails once, leaving the copied snapshot behind in the destination.
  const { git: spy } = recordingGit({ fail: (args) => (args[0] === 'commit' ? 'index.lock exists' : null) })
  await assert.rejects(publishRun({ runDir, runId, result, repoDir: repo, git: spy }), /index\.lock/)
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual((await readdir(join(repo, RESULTS_RELATIVE_DIR, runId))).sort(), [...CURATED_ARTIFACTS].sort())

  // Every entry it finds is one this snapshot replaces, so the retry proceeds.
  const outcome = await publishRun({ runDir, runId, result, repoDir: repo })

  assert.equal(outcome.published, true)
  assert.equal(git(remote, 'log', '-1', '--format=%s'), `chore: record and-scene eval ${runId}`)
})

test('an existing result commit is reused rather than duplicated', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)

  await publishRun({ runDir, runId, result, repoDir: repo })
  const commit = git(repo, 'rev-parse', 'HEAD')

  // The publication checkpoint is lost, but the commit is not: republication
  // must find it rather than build a second one.
  await writeFile(join(runDir, 'publication.json'), JSON.stringify({
    schema_version: 1, run_id: runId, stage: 'snapshot', commit: null, error: null,
  }))
  const outcome = await publishRun({ runDir, runId, result, repoDir: repo })

  assert.equal(outcome.published, true)
  assert.equal(outcome.commit, commit)
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2')
})

test('a completed publication is not repeated when the run is reopened', async () => {
  const { repo, dir } = await disposableRepo()
  const { runDir, runId, result } = await finalizedRun(dir)

  await publishRun({ runDir, runId, result, repoDir: repo })
  const commit = git(repo, 'rev-parse', 'HEAD')

  // Unrelated work lands on the branch afterwards, so HEAD is no longer the
  // result commit and there is nothing left to stage for this run.
  await writeFile(join(repo, 'NOTES.md'), 'later work\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'later work')

  const { git: spy, calls } = recordingGit()
  const outcome = await publishRun({ runDir, runId, result, repoDir: repo, git: spy })

  assert.equal(outcome.published, true)
  assert.equal(outcome.commit, commit)
  assert.deepEqual(calls, [], 'a completed publication touches git again for nothing')
})

// A real git adapter with one injected failure, so the commit is genuinely
// durable when the push fails.
function gitWithFailure(repo, fail) {
  return (args, options = {}) => {
    const failure = fail(args)
    if (failure) return { ok: false, status: 1, stdout: '', stderr: failure }
    const result = spawnSync('git', [
      '-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval',
      '-c', 'commit.gpgsign=false', ...args,
    ], { cwd: options.cwd ?? repo, encoding: 'utf8' })
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }
}
