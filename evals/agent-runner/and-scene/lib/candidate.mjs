// Candidate checkout and immutable identity.
//
// Runtime-only eval configuration is excluded through .git/info/exclude before
// Agent Runner starts. The scored diff therefore contains only product changes,
// while cleanliness still covers every other tracked and untracked candidate
// file.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { hashJson, hashString, writeJsonAtomic } from './persistence.mjs'

export const CANDIDATE_SOURCE_MANIFEST_SCHEMA_VERSION = 1
export const EVAL_GIT_EXCLUDES = ['/.agent-runner/config.yaml']

function defaultExec(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

function run(exec, command, args, options, label, { trim = true } = {}) {
  const result = exec(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0 || result.error) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim()
    throw new Error(`${label} failed${detail ? `: ${detail.slice(0, 1000)}` : ''}`)
  }
  const stdout = result.stdout ?? ''
  return trim ? stdout.trim() : stdout
}

async function installEvalExcludes(worktree) {
  const path = join(worktree, '.git/info/exclude')
  await mkdir(dirname(path), { recursive: true })
  const current = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const existing = new Set(current.split('\n'))
  const additions = EVAL_GIT_EXCLUDES.filter((entry) => !existing.has(entry))
  if (additions.length === 0) return
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  await writeFile(path, `${current}${prefix}${additions.join('\n')}\n`)
}

export async function prepareCandidateWorktree({
  repo,
  worktree,
  ref,
  resume,
  exec = defaultExec,
}) {
  if (!repo) throw new Error('candidate repository is required')
  if (!ref) throw new Error('candidate ref is required')

  if (resume) {
    const inside = exec('git', ['-C', worktree, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
    if (inside.status !== 0 || (inside.stdout ?? '').trim() !== 'true') {
      throw new Error(`resume requires the existing candidate worktree at ${worktree}`)
    }
  } else {
    run(exec, 'git', ['clone', '--no-checkout', '--', repo, worktree], {}, 'candidate clone')
    const commit = run(
      exec,
      'git',
      ['-C', worktree, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      {},
      `candidate ref lookup ${ref}`,
    )
    run(exec, 'git', ['-C', worktree, 'checkout', '--detach', commit], {}, `candidate checkout ${ref}`)
  }

  await installEvalExcludes(worktree)
  const commit = run(exec, 'git', ['-C', worktree, 'rev-parse', 'HEAD'], {}, 'candidate commit lookup')
  return { commit, worktree }
}

function parseTrackedFiles(text) {
  if (!text) return []
  return text.split('\n').map((line) => {
    const matched = line.match(/^(\d+)\s+(\S+)\s+([0-9a-f]+)\t(.*)$/)
    if (!matched) throw new Error(`cannot parse tracked source entry: ${line}`)
    return { mode: matched[1], type: matched[2], object: matched[3], path: matched[4] }
  })
}

export async function freezeCandidate({
  repo,
  worktree,
  runDir,
  fixtureRevision,
  exec = defaultExec,
}) {
  const status = run(
    exec,
    'git',
    ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all'],
    {},
    'candidate cleanliness check',
  )
  if (status) throw new Error(`candidate has uncommitted changes:\n${status}`)

  const fixtureCommit = run(
    exec,
    'git',
    ['-C', worktree, 'rev-parse', '--verify', '--end-of-options', `${fixtureRevision}^{commit}`],
    {},
    'fixture commit lookup',
  )
  const producedCommit = run(exec, 'git', ['-C', worktree, 'rev-parse', 'HEAD'], {}, 'produced commit lookup')
  const rawDiff = run(
    exec,
    'git',
    ['-C', worktree, 'diff', '--binary', '--full-index', '--no-ext-diff', fixtureCommit, producedCommit, '--'],
    {},
    'candidate diff capture',
    { trim: false },
  )
  const diff = rawDiff && !rawDiff.endsWith('\n') ? `${rawDiff}\n` : rawDiff
  const diffSha256 = hashString(diff)
  const trackedFiles = parseTrackedFiles(run(
    exec,
    'git',
    ['-C', worktree, 'ls-tree', '-r', '--full-tree', producedCommit],
    {},
    'candidate source manifest',
  ))
  const identityInput = {
    fixture_commit: fixtureCommit,
    produced_commit: producedCommit,
    implementation_diff_sha256: diffSha256,
    tracked_source_sha256: hashJson(trackedFiles),
  }
  const candidateIdentity = hashJson(identityInput)
  const manifest = {
    schema_version: CANDIDATE_SOURCE_MANIFEST_SCHEMA_VERSION,
    repository: repo,
    fixture_revision: fixtureRevision,
    fixture_commit: fixtureCommit,
    produced_commit: producedCommit,
    implementation_diff_sha256: diffSha256,
    tracked_source_sha256: identityInput.tracked_source_sha256,
    candidate_identity: candidateIdentity,
    tracked_files: trackedFiles,
  }

  await writeFile(join(runDir, 'implementation.diff'), diff)
  await writeJsonAtomic(join(runDir, 'candidate-source-manifest.json'), manifest)
  return {
    candidate_identity: candidateIdentity,
    fixture_commit: fixtureCommit,
    produced_commit: producedCommit,
    implementation_diff_sha256: diffSha256,
    source_manifest: 'candidate-source-manifest.json',
  }
}
