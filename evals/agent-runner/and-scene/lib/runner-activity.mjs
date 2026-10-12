// Observable progress of an Agent Runner run, and cleanup before resuming one.
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Large trees that change without the run progressing, or that a build
// rewrites wholesale, are not walked. A Git repository's own metadata is
// represented by the files that move when work is committed.
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage'])
const GIT_ACTIVITY_FILES = ['.git/HEAD', '.git/index', '.git/logs/HEAD', '.git/refs/heads']
const MAX_ENTRIES_PER_ROOT = 200_000

function newestMtime(root, budget) {
  let newest = null
  const pending = [root]
  while (pending.length > 0 && budget.remaining > 0) {
    const path = pending.pop()
    let stats
    try { stats = statSync(path) } catch { continue }
    budget.remaining -= 1
    if (newest === null || stats.mtimeMs > newest) newest = stats.mtimeMs
    if (!stats.isDirectory()) continue
    let entries
    try { entries = readdirSync(path) } catch { continue }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue
      pending.push(join(path, entry))
    }
  }
  return newest
}

// The newest modification time among the run's durable traces: Agent
// Runner's run store, the CLIs' session transcripts, and the candidate
// worktree with its commits. Missing roots are ignored.
export function latestActivityMs({ roots = [], gitWorktrees = [] } = {}) {
  let newest = null
  const consider = (value) => {
    if (Number.isFinite(value) && (newest === null || value > newest)) newest = value
  }
  for (const root of roots) {
    consider(newestMtime(root, { remaining: MAX_ENTRIES_PER_ROOT }))
  }
  for (const worktree of gitWorktrees) {
    for (const file of GIT_ACTIVITY_FILES) {
      consider(newestMtime(join(worktree, file), { remaining: 10_000 }))
    }
  }
  return newest
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function parentPid(procDir, pid) {
  try {
    // The command name is parenthesised and may contain spaces; fields
    // after it are space-separated, starting with the state.
    const stat = readFileSync(join(procDir, String(pid), 'stat'), 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[1])
  } catch {
    return null
  }
}

function environOf(procDir, pid) {
  try {
    return readFileSync(join(procDir, String(pid), 'environ'), 'utf8').split('\0')
  } catch {
    return []
  }
}

function alive(procDir, pid) {
  try {
    statSync(join(procDir, String(pid)))
    return true
  } catch {
    return false
  }
}

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

// TEMPORARY mitigation for Agent Runner issue 259 ("Timed-out or canceled
// agent calls leave the child's detached shell processes running"). When the
// harness ends a stalled run, an agent call's child can outlive Agent Runner
// and keep writing to the candidate worktree. Before a resume, and only then,
// a process is ended when it works inside the worktree and carries the
// resumed run's Agent Runner identity (`AGENT_RUNNER_RUN_ID`, which Runner
// gives every agent attempt). It gets SIGTERM, then SIGKILL if it outlives the
// grace period. Remove this once Agent Runner reaps its agent-call children.
export async function killWorktreeOrphans({
  worktree,
  runId,
  procDir = '/proc',
  selfPid = process.pid,
  kill = (pid, signal) => process.kill(pid, signal),
  platform = process.platform,
  graceMs = 5000,
  sleep = delay,
} = {}) {
  if (platform !== 'linux' || !worktree || !runId) return []
  const root = resolve(worktree)
  const marker = `AGENT_RUNNER_RUN_ID=${runId}`
  const protectedPids = new Set()
  for (let pid = selfPid; Number.isInteger(pid) && pid > 0 && !protectedPids.has(pid);) {
    protectedPids.add(pid)
    pid = parentPid(procDir, pid)
  }
  let entries
  try { entries = readdirSync(procDir) } catch { return [] }
  const targets = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (protectedPids.has(pid)) continue
    let cwd
    try { cwd = readlinkSync(join(procDir, entry, 'cwd')) } catch { continue }
    if (!within(cwd, root)) continue
    if (!environOf(procDir, pid).includes(marker)) continue
    let command = null
    try { command = readFileSync(join(procDir, entry, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200) } catch {}
    targets.push({ pid, cwd, command })
  }
  const ended = []
  for (const target of targets) {
    try {
      kill(target.pid, 'SIGTERM')
      ended.push(target)
    } catch {}
  }
  if (ended.length === 0) return []
  await sleep(graceMs)
  for (const target of ended) {
    if (!alive(procDir, target.pid)) continue
    try { kill(target.pid, 'SIGKILL'); target.killed = true } catch {}
  }
  return ended
}
