import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  VALIDATOR_COMMANDS,
  hideValidatorFromAgents,
} from '../evals/agent-runner/and-scene/lib/validator-availability.mjs'

// A stand-in for the image's globally installed Agent Validator, so the test
// proves the shim wins PATH resolution over a real executable.
async function installedValidator(root) {
  const bin = join(root, 'usr-bin')
  await mkdir(bin, { recursive: true })
  for (const name of VALIDATOR_COMMANDS) {
    await writeFile(join(bin, name), '#!/bin/sh\necho real-validator-ran\n')
    await chmod(join(bin, name), 0o755)
  }
  return bin
}

test('skip-validator agents resolve every validator command to a refusing shim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-validator-hidden-'))
  const realBin = await installedValidator(root)
  const runDir = join(root, 'run')

  const hidden = await hideValidatorFromAgents({
    runDir,
    env: { PATH: `${realBin}:/usr/bin:/bin`, KEEP: 'yes' },
  })

  assert.equal(hidden.env.KEEP, 'yes')
  assert.ok(hidden.env.PATH.endsWith(`:${realBin}:/usr/bin:/bin`))
  for (const name of VALIDATOR_COMMANDS) {
    const resolved = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env: hidden.env })
    assert.equal(resolved.stdout.trim(), join(hidden.shimDir, name))

    const ran = spawnSync('sh', ['-c', `${name} run --uncommitted`], { encoding: 'utf8', env: hidden.env })
    assert.equal(ran.status, 127)
    assert.equal(ran.stdout, '')
    assert.match(ran.stderr, /unavailable.*--skip-validator/s)
  }

  const log = await readFile(join(runDir, hidden.event.blocked_invocations_log), 'utf8')
  assert.match(log, /agent-validator run --uncommitted/)
  assert.match(log, /agent-validate run --uncommitted/)
  assert.deepEqual(hidden.event, {
    event: 'validator-unavailable',
    reason: 'skip-validator',
    mechanism: 'path-shim',
    commands: VALIDATOR_COMMANDS,
    blocked_invocations_log: 'logs/blocked-validator-invocations.log',
  })
})

test('the shim lives outside the candidate worktree and is reusable on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-validator-hidden-'))
  const runDir = join(root, 'run')

  const first = await hideValidatorFromAgents({ runDir, env: { PATH: '/usr/bin:/bin' } })
  const second = await hideValidatorFromAgents({ runDir, env: { PATH: '/usr/bin:/bin' } })

  assert.equal(first.shimDir, second.shimDir)
  assert.ok(!first.shimDir.includes('candidate-worktree'))
  assert.equal(second.env.PATH, `${second.shimDir}:/usr/bin:/bin`)
  assert.ok(((await stat(join(second.shimDir, 'agent-validator'))).mode & 0o111) !== 0)
})

test('an explicit Validator executable override does not reach skip-validator agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-validator-hidden-'))

  const hidden = await hideValidatorFromAgents({
    runDir: join(root, 'run'),
    env: { PATH: '/usr/bin', AGENT_RUNNER_VALIDATOR_EXECUTABLE: '/usr/bin/agent-validator' },
  })

  assert.equal('AGENT_RUNNER_VALIDATOR_EXECUTABLE' in hidden.env, false)
})

test('a PATH that cannot carry the shim fails instead of claiming the validator is hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-validator-hidden-'))
  const realBin = await installedValidator(root)

  await assert.rejects(
    hideValidatorFromAgents({ runDir: join(root, 'run:split'), env: { PATH: `${realBin}:/usr/bin:/bin` } }),
    /could not be hidden from agents/,
  )
})

test('a blocked attempt still reaches the agent transcript when the log is unwritable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-validator-hidden-'))
  const runDir = join(root, 'run')
  const hidden = await hideValidatorFromAgents({ runDir, env: { PATH: '/usr/bin:/bin' } })
  await chmod(join(runDir, 'logs'), 0o500)

  try {
    const ran = spawnSync('sh', ['-c', 'agent-validator review'], { encoding: 'utf8', env: hidden.env })
    assert.equal(ran.status, 127)
    assert.match(ran.stderr, /blocked-validator-invocation: agent-validator review/)
  } finally {
    await chmod(join(runDir, 'logs'), 0o700)
  }
})
