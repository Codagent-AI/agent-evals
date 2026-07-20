import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { lstat, readlink, symlink } from 'node:fs/promises'

import { readRunnerState, resolveProjectsDir } from '../evals/agent-runner/and-scene/lib/runner-state.mjs'

// Agent Runner lays out run state as
// <projects>/<encoded-project>/runs/<session-id>/state.json.
async function projects(runs) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-runner-state-'))
  for (const [sessionId, state] of Object.entries(runs)) {
    const sessionDir = join(dir, 'encoded-project', 'runs', sessionId)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify(state))
  }
  return dir
}

test('a recorded run is selected by its exact identifier', async () => {
  const dir = await projects({
    'run-a': { run_id: 'run-a', status: 'completed', started_at: '2026-07-01T00:00:00Z' },
    'run-b': { run_id: 'run-b', status: 'running', started_at: '2026-07-02T00:00:00Z' },
  })

  const state = await readRunnerState(dir, 'run-a')

  assert.equal(state.run_id, 'run-a')
  assert.equal(state.status, 'completed')
})

test('the session directory is reported alongside the state', async () => {
  const dir = await projects({ 'run-a': { run_id: 'run-a', status: 'running' } })

  const state = await readRunnerState(dir, 'run-a')

  assert.equal(state.session_dir, join(dir, 'encoded-project', 'runs', 'run-a'))
})

test('a recorded run that is absent reports null rather than an unrelated run', async () => {
  const dir = await projects({ 'run-b': { run_id: 'run-b', status: 'running' } })

  assert.equal(await readRunnerState(dir, 'run-a'), null)
})

test('discovery without a recorded identifier selects the newest run by timestamp', async () => {
  const dir = await projects({
    'run-old': { run_id: 'run-old', status: 'completed', started_at: '2026-07-01T00:00:00Z' },
    'run-new': { run_id: 'run-new', status: 'running', started_at: '2026-07-05T00:00:00Z' },
    'run-mid': { run_id: 'run-mid', status: 'failed', started_at: '2026-07-03T00:00:00Z' },
  })

  const state = await readRunnerState(dir, null)

  assert.equal(state.run_id, 'run-new')
})

test('discovery ignores runs whose timestamp cannot be validated', async () => {
  const dir = await projects({
    'run-good': { run_id: 'run-good', status: 'running', started_at: '2026-07-01T00:00:00Z' },
    'run-bad': { run_id: 'run-bad', status: 'running', started_at: 'not-a-timestamp' },
  })

  const state = await readRunnerState(dir, null)

  assert.equal(state.run_id, 'run-good')
})

test('an empty projects directory reports null', async () => {
  const dir = await projects({})

  assert.equal(await readRunnerState(dir, null), null)
})

test('a missing projects directory reports null rather than throwing', async () => {
  assert.equal(await readRunnerState('/nonexistent/projects', null), null)
})

test('malformed run state is skipped rather than failing discovery', async () => {
  const dir = await projects({ 'run-good': { run_id: 'run-good', status: 'running', started_at: '2026-07-01T00:00:00Z' } })
  const broken = join(dir, 'encoded-project', 'runs', 'run-broken')
  await mkdir(broken, { recursive: true })
  await writeFile(join(broken, 'state.json'), '{not json')

  const state = await readRunnerState(dir, null)

  assert.equal(state.run_id, 'run-good')
})

// Agent Runner resolves its projects directory from $HOME with no flag or
// environment override, so the persistent run-directory store is linked into
// the ephemeral container home.
async function homes() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-projects-'))
  const runDir = join(dir, 'run')
  const home = join(dir, 'home')
  await mkdir(join(runDir, '.runtime/agent-runner-projects'), { recursive: true })
  await mkdir(home, { recursive: true })
  return { dir, runDir, home, persistent: join(runDir, '.runtime/agent-runner-projects') }
}

test('the persistent projects directory is linked into an empty container home', async () => {
  const { runDir, home, persistent } = await homes()

  const resolved = await resolveProjectsDir({ runDir, home })

  assert.equal(resolved, persistent)
  assert.equal(await readlink(join(home, '.agent-runner/projects')), persistent)
})

test('an existing link to the same run directory is reused', async () => {
  const { runDir, home, persistent } = await homes()
  await mkdir(join(home, '.agent-runner'), { recursive: true })
  await symlink(persistent, join(home, '.agent-runner/projects'))

  const resolved = await resolveProjectsDir({ runDir, home })

  assert.equal(resolved, persistent)
})

test('a real projects directory in the home is never replaced', async () => {
  // Never destroy a genuine user store; read where Agent Runner actually writes.
  const { runDir, home } = await homes()
  const real = join(home, '.agent-runner/projects')
  await mkdir(real, { recursive: true })

  const resolved = await resolveProjectsDir({ runDir, home })

  assert.equal(resolved, real)
  assert.equal((await lstat(real)).isSymbolicLink(), false)
})

test('a link pointing somewhere else is left alone and read from', async () => {
  const { dir, runDir, home } = await homes()
  const foreign = join(dir, 'foreign-projects')
  await mkdir(foreign, { recursive: true })
  await mkdir(join(home, '.agent-runner'), { recursive: true })
  await symlink(foreign, join(home, '.agent-runner/projects'))

  const resolved = await resolveProjectsDir({ runDir, home })

  assert.equal(resolved, join(home, '.agent-runner/projects'))
  assert.equal(await readlink(join(home, '.agent-runner/projects')), foreign)
})

test('an unknown home falls back to the run directory store', async () => {
  const { runDir, persistent } = await homes()

  assert.equal(await resolveProjectsDir({ runDir, home: null }), persistent)
})
