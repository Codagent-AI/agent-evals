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
  const { calls, exec } = executor([0, 2])

  const result = await runCandidateVerification({
    worktree: join(runDir, '.runtime/candidate-worktree'),
    exec,
  })

  assert.equal(result.build.ok, false)
  assert.match(result.build.log, /build failed/)
  assert.equal(result.verification.machine_readable, true)
  assert.equal(result.verification.passed, false)
  assert.deepEqual(calls.map(({ args }) => args), [['ci'], ['run', 'build']])
  assert.equal(result.commands.verification.state, 'skipped')
})
