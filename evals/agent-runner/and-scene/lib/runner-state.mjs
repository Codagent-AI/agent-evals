// Reading Agent Runner's persisted run state.
//
// Agent Runner lays run state out as
// <projects>/<encoded-project>/runs/<session-id>/state.json. Filesystem
// iteration order is not a recency guarantee, so a recorded run is always
// selected by its exact identifier and discovery falls back to a validated
// timestamp.
import { readFileSync, readlinkSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, stat, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { readJson } from './persistence.mjs'
import { RUNNER_METRICS_FILENAME } from './runner-metrics.mjs'

// Agent Runner's lock records only a PID. Disposable containers can reuse that
// number for an unrelated process, so existence alone is not proof that the
// process owns the persisted run. Verify the executable before waiting.
export function isAgentRunnerProcessAlive(pid, {
  kill = process.kill,
  readlinkSync: readExecutable = readlinkSync,
  readFileSync: readCommandLine = readFileSync,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    const executable = basename(readExecutable(`/proc/${pid}/exe`))
    if (executable === 'agent-runner') return true

    const argv = readCommandLine(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
    return argv.some((argument) => {
      const name = basename(argument)
      return name === 'agent-runner' || name.startsWith('agent-runner.')
    })
  } catch {
    return false
  }
}

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
      const history = await readWorkflowHistory(sessionDir)
      const info = await stat(statePath).catch(() => null)
      yield normalizeState(state, {
        runId: basename(sessionDir),
        sessionDir,
        lock,
        history,
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

function normalizeState(state, { runId, sessionDir, lock, history, modifiedAtMs }) {
  const step = currentStep(state)
  return {
    ...state,
    run_id: runId,
    session_dir: sessionDir,
    workflow_name: state.workflowName ?? null,
    run_kind: state.runKind ?? null,
    last_step: step.id,
    step_completed: step.completed,
    workflow_completed: state.completed === true,
    lock,
    modified_at_ms: modifiedAtMs,
    history,
    steps: history.length > 0 ? history.map(({ step: id }) => id) : (step.id ? [step.id] : []),
  }
}

function parseAuditStepIdentity(prefix) {
  if (!prefix.startsWith('[') || !prefix.endsWith(']')) return null
  const stepPath = prefix.slice(1, -1)
    .split(',')
    .map((part) => part.trim().replace(/:\d+$/, ''))
    .filter(Boolean)
  return stepPath.length > 0 ? { step: stepPath[0], step_path: stepPath } : null
}

export async function readWorkflowHistory(sessionDir) {
  const text = await readFile(join(sessionDir, 'audit.log'), 'utf8').catch(() => '')
  const history = []
  for (const line of text.split('\n')) {
    const match = line.match(
      /^(\S+)\s+(\[[^\]]+\])\s+(step_start|step_end)(?:\s+(\{.*\}))?$/,
    )
    if (!match) continue
    const identity = parseAuditStepIdentity(match[2])
    if (!identity) continue
    let data = {}
    try {
      data = match[4] ? JSON.parse(match[4]) : {}
    } catch {
      continue
    }
    history.push({
      at: match[1],
      ...identity,
      event: match[3],
      outcome: match[3] === 'step_end' ? (data.outcome ?? null) : null,
      attempt: data.identity?.attempt ?? null,
      error: data.error ?? data.stderr ?? null,
    })
  }
  return history
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
    // Development builds persist detached audits as sibling runs. They are
    // inspectable by exact id, but must never be adopted as the implementation
    // workflow during recovery from the pre-checkpoint crash window.
    if (state.run_kind === 'audit') continue
    const at = state.modified_at_ms
    if (at === null) continue
    if (newestAt === null || at > newestAt) {
      newest = state
      newestAt = at
    }
  }
  return newest
}

const TERMINAL_AUDIT_STATES = new Set(['completed', 'failed'])

export function pendingLinkedAudits(state) {
  const links = state?.audit?.links
  if (!Array.isArray(links)) return []
  return links.filter((link) => !TERMINAL_AUDIT_STATES.has(link?.state))
}

export function hasPendingLinkedAudits(state) {
  return pendingLinkedAudits(state).length > 0
}

export function hasLinkedAudits(state) {
  return Array.isArray(state?.audit?.links) && state.audit.links.length > 0
}

// core:implement-change never auto-launches an audit. Replay needs the
// finalized top-level execution: the only sessions[] entry, or the last
// closed session after resume.
export function selectFinalizedExecutionSession(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null
  const pick = (session) => {
    const id = session?.execution_session_id
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null
  }
  if (sessions.length === 1) return pick(sessions[0])
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    if (sessions[index]?.status === 'closed') {
      const id = pick(sessions[index])
      if (id) return id
    }
  }
  return null
}

export async function readFinalizedExecutionSessionId(sessionDir) {
  if (typeof sessionDir !== 'string' || sessionDir.trim() === '') return null
  const payload = JSON.parse(await readFile(join(sessionDir, RUNNER_METRICS_FILENAME), 'utf8'))
  return selectFinalizedExecutionSession(payload?.sessions)
}

// Production waiting is a real poll of Agent Runner's separate lock file and
// its source-side linked-audit lifecycle. The default has no deadline because
// either workflow may make long-running model calls; the outer eval resumes
// only after the source releases its lock and every linked audit is terminal.
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
    const sourceActive = Number.isInteger(pid) && isProcessAlive(pid)
    if (!sourceActive && !hasPendingLinkedAudits(state)) return state
    await sleep(intervalMs)
  }
}
