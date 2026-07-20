// Reading Agent Runner's persisted run state.
//
// Agent Runner lays run state out as
// <projects>/<encoded-project>/runs/<session-id>/state.json. Filesystem
// iteration order is not a recency guarantee, so a recorded run is always
// selected by its exact identifier and discovery falls back to a validated
// timestamp.
import { lstat, mkdir, readdir, readFile, readlink, stat, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { readJson } from './persistence.mjs'

// Agent Runner resolves its run store as
// $HOME/.agent-runner/projects/<encoded-cwd>/runs/<session-id>, with no CLI
// flag or environment override. To keep run state in the persistent run
// directory across disposable containers, the run-directory store is linked
// into the ephemeral container home.
//
// A foreign store is never replaced or silently accepted. Using it would make
// the disposable container lose the durable run identity on exit and could
// cause a resumed outer harness to launch a duplicate implementation run.
export async function resolveProjectsDir({ runDir, home }) {
  const persistent = join(runDir, '.runtime/agent-runner-projects')
  if (!home) return persistent

  const homeProjects = join(home, '.agent-runner', 'projects')
  let existing
  try {
    existing = await lstat(homeProjects)
  } catch {
    existing = null
  }

  if (!existing) {
    await mkdir(join(home, '.agent-runner'), { recursive: true })
    try {
      await symlink(persistent, homeProjects)
      return persistent
    } catch {
      // A concurrent creator may have installed the exact link. Re-check it;
      // every other outcome is unsafe to continue with.
      const raced = await lstat(homeProjects).catch(() => null)
      if (raced?.isSymbolicLink() && await readlink(homeProjects).catch(() => null) === persistent) {
        return persistent
      }
      throw new Error(`cannot establish persistent Agent Runner projects store at ${homeProjects}`)
    }
  }

  if (existing.isSymbolicLink()) {
    const target = await readlink(homeProjects).catch(() => null)
    if (target === persistent) return persistent
  }
  throw new Error(`cannot establish persistent Agent Runner projects store at ${homeProjects}`)
}

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

async function* sessions(projectsDir) {
  for (const project of await directories(projectsDir)) {
    const runsDir = join(projectsDir, project, 'runs')
    for (const session of await directories(runsDir)) {
      const sessionDir = join(runsDir, session)
      const statePath = join(sessionDir, 'state.json')
      const state = await readJson(statePath, null).catch(() => null)
      if (!state) continue
      const lock = await readLock(sessionDir, session)
      const info = await stat(statePath).catch(() => null)
      yield normalizeState(state, {
        runId: basename(sessionDir),
        sessionDir,
        lock,
        modifiedAtMs: info?.mtimeMs ?? null,
      })
    }
  }
}

async function readLock(sessionDir, runId) {
  const text = await readFile(join(sessionDir, 'lock'), 'utf8').catch(() => null)
  if (text === null) return null
  const pid = Number.parseInt(text.trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? { pid, run_id: runId } : { pid: null, run_id: runId }
}

function currentStep(state) {
  if (typeof state.currentStep === 'string') {
    return { id: state.currentStep || null, completed: false }
  }
  return {
    id: state.currentStep?.stepId ?? null,
    completed: state.currentStep?.completed === true,
  }
}

function normalizeState(state, { runId, sessionDir, lock, modifiedAtMs }) {
  const step = currentStep(state)
  return {
    ...state,
    run_id: runId,
    session_dir: sessionDir,
    workflow_name: state.workflowName ?? null,
    last_step: step.id,
    step_completed: step.completed,
    workflow_completed: state.completed === true,
    lock,
    modified_at_ms: modifiedAtMs,
    steps: step.id ? [step.id] : [],
  }
}

export async function readRunnerState(projectsDir, runId) {
  // A recorded run must resolve to that exact run or to nothing; returning an
  // unrelated run would produce a spurious run-identity mismatch.
  if (runId) {
    for await (const state of sessions(projectsDir)) {
      if (state.run_id === runId) return state
    }
    return null
  }

  let newest = null
  let newestAt = null
  for await (const state of sessions(projectsDir)) {
    const at = state.modified_at_ms
    if (at === null) continue
    if (newestAt === null || at > newestAt) {
      newest = state
      newestAt = at
    }
  }
  return newest
}

// Production waiting is a real poll of Agent Runner's separate lock file. The
// default has no deadline because an active implementation workflow may take
// hours; the outer eval resumes only after Agent Runner releases its lock.
export async function waitForRunnerRun({
  readState,
  runId,
  isProcessAlive,
  intervalMs = 1000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  while (true) {
    const state = await readState(runId)
    if (!state) throw new Error(`cannot verify the status of Agent Runner run ${runId} while waiting`)
    const pid = state.lock?.pid
    if (!Number.isInteger(pid) || !isProcessAlive(pid)) return state
    await sleep(intervalMs)
  }
}
