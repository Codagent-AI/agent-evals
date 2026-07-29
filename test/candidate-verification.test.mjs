import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runCandidateVerification } from '../evals/agent-runner/and-scene/lib/candidate-verification.mjs'

function executor(statuses) {
  const calls = []
  const exec = (command, args, options) => {
    calls.push({ command, args, options })
    const status = statuses.shift() ?? 0
    return { status, stdout: status === 0 ? `${args.join(' ')} passed` : '', stderr: status === 0 ? '' : `${args.join(' ')} failed` }
  }
  return { calls, exec }
}

test('candidate verification installs, builds, and runs the repository verifier in order', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-verification-'))
  const worktree = join(runDir, '.runtime/candidate-worktree')
  const { calls, exec } = executor([0, 0, 0])

  const result = await runCandidateVerification({ worktree, exec })

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['npm', ['ci']],
    ['npm', ['run', 'build']],
    ['npm', ['run', 'verify']],
  ])
  assert.ok(calls.every(({ options }) => options.cwd === worktree))
  assert.equal(result.build.ok, true)
  assert.equal(result.verification.machine_readable, true)
  assert.equal(result.verification.passed, true)
  assert.equal(result.verification.artifact, 'phases/verification.json')
  assert.deepEqual(result.timings.map(({ label }) => label), ['install', 'build', 'verification'])
})

test('a candidate command failure is an explicit failed product result, not a thrown harness error', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-verification-'))
  const { calls, exec } = executor([0, 2, 2])

  const result = await runCandidateVerification({
    worktree: join(runDir, '.runtime/candidate-worktree'),
    exec,
  })

  assert.equal(result.build.ok, false)
  assert.match(result.build.log, /build failed/)
  assert.equal(result.verification.machine_readable, false)
  assert.equal(result.verification.passed, null)
  assert.deepEqual(calls.map(({ args }) => args), [
    ['ci'],
    ['run', 'build'],
    ['run', 'build'],
  ])
  assert.equal(result.commands.verification.state, 'skipped')
  assert.equal(result.product_failure.reproducible, true)
})

test('a verifier exit status is retained as its machine-readable product result', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-verification-'))
  const { calls, exec } = executor([0, 0, 2])

  const result = await runCandidateVerification({
    worktree: join(runDir, '.runtime/candidate-worktree'),
    exec,
  })

  assert.equal(result.build.ok, true)
  assert.equal(result.verification.machine_readable, true)
  assert.equal(result.verification.passed, false)
  assert.deepEqual(calls.map(({ args }) => args), [['ci'], ['run', 'build'], ['run', 'verify']])
  assert.equal(result.commands.verification.state, 'complete')
})

test('install and build failures identify the reproducible product-owned stage', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-verification-'))

  const installFailure = await runCandidateVerification({
    worktree: join(runDir, '.runtime/install-failure'),
    exec: executor([2, 2]).exec,
  })
  assert.equal(installFailure.product_failure.stage, 'install')
  assert.equal(installFailure.product_failure.gate, 'verification-build-whole-app')

  const buildFailure = await runCandidateVerification({
    worktree: join(runDir, '.runtime/build-failure'),
    exec: executor([0, 2, 2]).exec,
  })
  assert.equal(buildFailure.product_failure.stage, 'build')
  assert.equal(buildFailure.product_failure.gate, 'verification-build-whole-app')
})

test('a one-off candidate command failure is retried and does not become a conclusive product failure', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-verification-'))
  const { calls, exec } = executor([0, 2, 0, 0])

  const result = await runCandidateVerification({
    worktree: join(runDir, '.runtime/candidate-worktree'),
    exec,
  })

  assert.equal(result.product_failure, null)
  assert.equal(result.build.ok, true)
  assert.equal(result.verification.passed, true)
  assert.deepEqual(calls.map(({ args }) => args), [
    ['ci'],
    ['run', 'build'],
    ['run', 'build'],
    ['run', 'verify'],
  ])
  assert.deepEqual(result.commands.build.attempts.map(({ status }) => status), [2, 0])
})

test('an inability to launch npm is an evaluation-harness failure', async () => {
  await assert.rejects(
    runCandidateVerification({
      worktree: '/candidate',
      exec: () => ({ status: null, error: new Error('spawn npm ENOENT'), stdout: '', stderr: '' }),
    }),
    (error) => (
      error.owner === 'evaluation-harness'
      && error.code === 'candidate-command-launch-failed'
    ),
  )
})

test('repeated infrastructure-shaped npm failures remain harness failures', async () => {
  await assert.rejects(
    runCandidateVerification({
      worktree: '/candidate',
      exec: () => ({
        status: 1,
        stdout: '',
        stderr: 'npm error code EAI_AGAIN\nnpm error request to https://registry.npmjs.org failed',
      }),
    }),
    (error) => (
      error.owner === 'evaluation-harness'
      && error.code === 'candidate-command-infrastructure-failed'
    ),
  )
})

test('bare HTTP status numbers remain candidate failures', async () => {
  const result = await runCandidateVerification({
    worktree: '/candidate',
    exec: () => ({
      status: 1,
      stdout: '',
      stderr: 'assertion failed: expected status 502 but received 500',
    }),
  })

  assert.equal(result.product_failure.stage, 'install')
  assert.equal(result.product_failure.reproducible, true)
})

test('explicit HTTP gateway errors remain infrastructure failures', async () => {
  await assert.rejects(
    runCandidateVerification({
      worktree: '/candidate',
      exec: () => ({
        status: 1,
        stdout: '',
        stderr: 'npm request failed: HTTP/1.1 503 Service Unavailable',
      }),
    }),
    (error) => (
      error.owner === 'evaluation-harness'
      && error.code === 'candidate-command-infrastructure-failed'
    ),
  )
})
