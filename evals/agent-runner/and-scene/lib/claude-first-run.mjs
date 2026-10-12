// Claude Code's first-run state for the sandbox home.
//
// An interactive Claude session in a fresh home stops on its theme picker, and
// then on folder-trust and bypass-permissions confirmations, which nobody is
// there to answer. Agent Runner's sandbox forwards Claude's credentials and
// settings but not `~/.claude.json`, where Claude records that those screens
// were completed, so the harness records it before Agent Runner starts.
import { randomBytes } from 'node:crypto'
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export function mergeClaudeFirstRunState(existing, worktreePaths) {
  const state = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}
  state.hasCompletedOnboarding = true
  state.theme ??= 'dark'
  state.bypassPermissionsModeAccepted = true
  const projects = state.projects && typeof state.projects === 'object' && !Array.isArray(state.projects)
    ? { ...state.projects }
    : {}
  for (const path of worktreePaths) {
    projects[path] = {
      ...(projects[path] ?? {}),
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    }
  }
  state.projects = projects
  return state
}

async function notSymlink(path) {
  const stats = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stats?.isSymbolicLink()) throw new Error(`refusing to follow a symbolic link at ${path}`)
  return stats
}

// Keys already present, including any account details Claude wrote, are kept;
// only the first-run markers are added.
export async function seedClaudeFirstRunState({ home, worktree }) {
  if (!home) return
  const path = join(home, '.claude.json')
  await notSymlink(home)
  const stats = await notSymlink(path)
  let existing = {}
  if (stats) {
    try {
      existing = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read Claude first-run state at ${path}: ${error.message}`)
    }
  }
  const paths = new Set([resolve(worktree)])
  paths.add(await realpath(worktree).catch(() => resolve(worktree)))
  const next = mergeClaudeFirstRunState(existing, [...paths])
  // A random suffix, since a restarted container can reuse the PID of a run
  // that crashed and left its temporary file behind.
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  // Exclusive creation never follows a planted link at the temporary path.
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
