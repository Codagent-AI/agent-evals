import assert from 'node:assert/strict'
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { lstat, readlink, symlink } from 'node:fs/promises'

import {
  readRunnerState,
  resolveProjectsDir,
  waitForRunnerRun,
} from '../evals/agent-runner/and-scene/lib/runner-state.mjs'

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

test('a recorded run is selected by its session-directory identifier and current Agent Runner schema', async () => {
  const dir = await projects({
    'run-a': { workflowName: 'implement-change2', currentStep: { stepId: 'simplify', completed: true } },
    'run-b': { workflowName: 'implement-change2', currentStep: { stepId: 'implement-tasks' } },
  })

  const state = await readRunnerState(dir, 'run-a')

  assert.equal(state.run_id, 'run-a')
  assert.equal(state.workflow_name, 'implement-change2')
  assert.equal(state.last_step, 'simplify')
  assert.equal(state.step_completed, true)
})

test('the session directory is reported alongside the state', async () => {
  const dir = await projects({ 'run-a': { workflowName: 'implement-change2', currentStep: 'plan' } })

  const state = await readRunnerState(dir, 'run-a')

  assert.equal(state.session_dir, join(dir, 'encoded-project', 'runs', 'run-a'))
})

test('a recorded run that is absent reports null rather than an unrelated run', async () => {
  const dir = await projects({ 'run-b': { run_id: 'run-b', status: 'running' } })

  assert.equal(await readRunnerState(dir, 'run-a'), null)
})

test('discovery without a recorded identifier selects the newest session by filesystem timestamp', async () => {
  const dir = await projects({
    'run-old': { workflowName: 'implement-change2', currentStep: 'plan' },
    'run-new': { workflowName: 'implement-change2', currentStep: 'simplify' },
  })
  await utimes(join(dir, 'encoded-project/runs/run-old/state.json'), new Date('2026-07-01'), new Date('2026-07-01'))
  await utimes(join(dir, 'encoded-project/runs/run-new/state.json'), new Date('2026-07-05'), new Date('2026-07-05'))

  const state = await readRunnerState(dir, null)

  assert.equal(state.run_id, 'run-new')
})

test('the separate Agent Runner lock file is normalized onto discovered state', async () => {
  const dir = await projects({
    'run-active': { workflowName: 'implement-change2', currentStep: { stepId: 'implement-tasks' } },
  })
  await writeFile(join(dir, 'encoded-project/runs/run-active/lock'), '4321\n')

  const state = await readRunnerState(dir, 'run-active')

  assert.deepEqual(state.lock, { pid: 4321, run_id: 'run-active' })
})

test('production waiting polls until Agent Runner releases its run lock', async () => {
  let reads = 0
  let sleeps = 0
  const state = await waitForRunnerRun({
    runId: 'run-active',
    readState: async () => {
      reads += 1
      return reads < 3
        ? { run_id: 'run-active', lock: { pid: 4321, run_id: 'run-active' } }
        : { run_id: 'run-active', lock: null, last_step: 'simplify', step_completed: true }
    },
    isProcessAlive: () => true,
    intervalMs: 0,
    sleep: async () => { sleeps += 1 },
  })

  assert.equal(reads, 3)
  assert.equal(sleeps, 2)
  assert.equal(state.step_completed, true)
})

test('an empty projects directory reports null', async () => {
  const dir = await projects({})

  assert.equal(await readRunnerState(dir, null), null)
})

test('a missing projects directory reports null rather than throwing', async () => {
  assert.equal(await readRunnerState('/nonexistent/projects', null), null)
})

test('malformed run state is skipped rather than failing discovery', async () => {
  const dir = await projects({ 'run-good': { workflowName: 'implement-change2', currentStep: 'plan' } })
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

test('a real projects directory fails instead of silently losing durable run state', async () => {
  const { runDir, home } = await homes()
  const real = join(home, '.agent-runner/projects')
  await mkdir(real, { recursive: true })

  await assert.rejects(resolveProjectsDir({ runDir, home }), /persistent Agent Runner projects store/)
  assert.equal((await lstat(real)).isSymbolicLink(), false)
})

test('a link pointing somewhere else fails instead of silently using another run store', async () => {
  const { dir, runDir, home } = await homes()
  const foreign = join(dir, 'foreign-projects')
  await mkdir(foreign, { recursive: true })
  await mkdir(join(home, '.agent-runner'), { recursive: true })
  await symlink(foreign, join(home, '.agent-runner/projects'))

  await assert.rejects(resolveProjectsDir({ runDir, home }), /persistent Agent Runner projects store/)
  assert.equal(await readlink(join(home, '.agent-runner/projects')), foreign)
})

test('an unknown home falls back to the run directory store', async () => {
  const { runDir, persistent } = await homes()

  assert.equal(await resolveProjectsDir({ runDir, home: null }), persistent)
})
