import assert from 'node:assert/strict'
import { access, lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prepareScript = join(root, 'evals/agent-runner/and-scene/prepare-agent-session-state.sh')

function invokePrepare(home, stateRoot) {
  return spawnSync('bash', [prepareScript, stateRoot], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
}

function prepare(home, stateRoot) {
  const result = invokePrepare(home, stateRoot)
  assert.equal(result.status, 0, result.stdout + result.stderr)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('Codex rollouts and Claude transcripts survive a replacement home without persisting credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-session-state-'))
  const stateRoot = join(dir, 'evaluation-a')
  const firstHome = join(dir, 'home-a')
  const replacementHome = join(dir, 'home-b')
  await mkdir(join(firstHome, '.codex'), { recursive: true })
  await mkdir(join(firstHome, '.claude'), { recursive: true })
  await writeFile(join(firstHome, '.codex/auth.json'), 'codex-credential')
  await writeFile(join(firstHome, '.claude/.credentials.json'), 'claude-credential')

  prepare(firstHome, stateRoot)

  for (const path of [
    '.codex/sessions',
    '.codex/archived_sessions',
    '.codex/memories',
    '.codex/shell_snapshots',
    '.claude/projects',
  ]) {
    assert.equal((await lstat(join(firstHome, path))).isSymbolicLink(), true, path)
  }
  await mkdir(join(firstHome, '.codex/sessions/2026/09/10'), { recursive: true })
  await writeFile(join(firstHome, '.codex/sessions/2026/09/10/rollout.jsonl'), 'codex rollout')
  await mkdir(join(firstHome, '.claude/projects/-workspace-candidate'), { recursive: true })
  await writeFile(join(firstHome, '.claude/projects/-workspace-candidate/session.jsonl'), 'claude transcript')

  prepare(replacementHome, stateRoot)

  assert.equal(
    await readFile(join(replacementHome, '.codex/sessions/2026/09/10/rollout.jsonl'), 'utf8'),
    'codex rollout',
  )
  assert.equal(
    await readFile(join(replacementHome, '.claude/projects/-workspace-candidate/session.jsonl'), 'utf8'),
    'claude transcript',
  )
  assert.equal(await exists(join(stateRoot, 'codex/auth.json')), false)
  assert.equal(await exists(join(stateRoot, 'claude/.credentials.json')), false)
  assert.equal(await readlink(join(replacementHome, '.codex/sessions')), join(stateRoot, 'codex/sessions'))
})

test('a different evaluation receives an isolated empty session store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-session-isolation-'))
  const firstStateRoot = join(dir, 'evaluation-a')
  const secondStateRoot = join(dir, 'evaluation-b')
  const firstHome = join(dir, 'home-a')
  const secondHome = join(dir, 'home-b')

  prepare(firstHome, firstStateRoot)
  await mkdir(join(firstHome, '.codex/sessions/2026/09/10'), { recursive: true })
  await writeFile(join(firstHome, '.codex/sessions/2026/09/10/private.jsonl'), 'private')
  prepare(secondHome, secondStateRoot)

  assert.equal(await exists(join(secondHome, '.codex/sessions/2026/09/10/private.jsonl')), false)
  assert.notEqual(
    await readlink(join(firstHome, '.codex/sessions')),
    await readlink(join(secondHome, '.codex/sessions')),
  )
})

test('recovery refuses a session-state directory redirected outside the evaluation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-session-symlink-'))
  const stateRoot = join(dir, 'evaluation-a')
  const foreign = join(dir, 'foreign')
  const home = join(dir, 'home')
  await mkdir(stateRoot)
  await mkdir(foreign)
  await symlink(foreign, join(stateRoot, 'codex'))

  const result = invokePrepare(home, stateRoot)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not a private directory/i)
  assert.equal(await exists(join(foreign, 'archived_sessions')), false)
})

test('recovery refuses a symlinked ancestor of the session-state directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-session-ancestor-symlink-'))
  const evaluationRoot = join(dir, 'evaluation-a')
  const foreign = join(dir, 'foreign')
  const stateRoot = join(evaluationRoot, '.runtime', 'agent-session-state')
  const home = join(dir, 'home')
  await mkdir(evaluationRoot)
  await mkdir(foreign)
  await symlink(foreign, join(evaluationRoot, '.runtime'))

  const result = invokePrepare(home, stateRoot)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not a private directory/i)
  assert.equal(await exists(join(foreign, 'agent-session-state')), false)
})
