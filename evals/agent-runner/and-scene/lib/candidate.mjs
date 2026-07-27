// Candidate checkout and immutable identity.
//
// Runtime-only eval configuration is excluded through .git/info/exclude before
// Agent Runner starts. The scored diff therefore contains only product changes,
// while cleanliness still covers every other tracked and untracked candidate
// file.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { hashFile, hashJson, hashString, writeJsonAtomic } from './persistence.mjs'
import {
  EvidenceReadinessError,
  inspectCandidateEvidenceReadiness,
} from './evidence.mjs'
import { checkWorkflowHistory } from './workflow.mjs'

export const CANDIDATE_SOURCE_MANIFEST_SCHEMA_VERSION = 1
export const EVAL_GIT_EXCLUDES = ['/.agent-runner/config.yaml']
const MAX_CANDIDATE_DIFF_BYTES = 64 * 1024 * 1024

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

function repositoryPath(path) {
  return path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
}

// Compare repository identity rather than transport spelling, so the same
// GitHub repository expressed as HTTPS or SSH remains the same source while a
// different host/path cannot be smuggled into a resumed run.
function normalizeRepository(repository) {
  const value = String(repository).trim()
  const scp = value.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/)
  if (scp && !value.includes('://')) {
    return `${scp[1].toLowerCase()}/${repositoryPath(scp[2])}`
  }
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') return resolve(fileURLToPath(url))
    return `${url.host.toLowerCase()}/${repositoryPath(url.pathname)}`
  } catch {
    return resolve(value)
  }
}

function assertSame(label, current, recorded) {
  if (current !== recorded) {
    throw new Error(`${label} ${current} does not match recorded ${label} ${recorded}`)
  }
}

function resolveRemoteDefaultBranch(exec, worktree) {
  const output = run(
    exec,
    'git',
    ['-C', worktree, 'ls-remote', '--symref', 'origin', 'HEAD'],
    {},
    'candidate default base branch lookup',
  )
  const match = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)
  if (!match) {
    throw new Error('candidate repository default base branch could not be resolved from origin/HEAD')
  }
  return match[1]
}

function assertValidatorReadyFixture(exec, worktree, fixtureCommit) {
  const path = '.validator/config.yml'
  const config = exec(
    'git',
    ['-C', worktree, 'show', `${fixtureCommit}:${path}`],
    { encoding: 'utf8' },
  )
  if (config.status !== 0 || config.error || !(config.stdout ?? '').trim()) {
    throw new Error(
      `candidate fixture ${fixtureCommit} is missing required final Validator configuration at ${path}`,
    )
  }
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
  expectedSource = null,
  runId = null,
  kind = runId ? 'candidate' : 'reference',
  exec = defaultExec,
}) {
  if (!repo) throw new Error('candidate repository is required')
  if (!ref) throw new Error('candidate ref is required')
  const repository = normalizeRepository(repo)
  const branch = kind === 'candidate' ? `eval/and-scene/${runId}` : null
  if (kind === 'candidate' && !runId) throw new Error('candidate run identifier is required')

  if (resume) {
    if (!expectedSource?.repository || !expectedSource?.fixture_commit) {
      throw new Error('resume requires recorded candidate repository and fixture provenance')
    }
    assertSame('candidate repository', repository, expectedSource.repository)
    if (branch) assertSame('candidate branch', branch, expectedSource.branch)
    const inside = exec('git', ['-C', worktree, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
    if (inside.status !== 0 || (inside.stdout ?? '').trim() !== 'true') {
      throw new Error(`resume requires the existing candidate worktree at ${worktree}`)
    }
  } else {
    run(exec, 'git', ['clone', '--no-checkout', '--', repo, worktree], {}, 'candidate clone')
  }

  const origin = normalizeRepository(run(
    exec,
    'git',
    ['-C', worktree, 'remote', 'get-url', 'origin'],
    {},
    'candidate origin lookup',
  ))
  assertSame('candidate origin repository', origin, repository)
  const baseBranch = kind === 'candidate'
    ? resolveRemoteDefaultBranch(exec, worktree)
    : null
  if (resume && kind === 'candidate') {
    if (!expectedSource?.base_branch) {
      throw new Error('resume provenance is missing the recorded candidate default base branch')
    }
    assertSame('candidate default base branch', baseBranch, expectedSource.base_branch)
  }

  const fixtureCommit = run(
    exec,
    'git',
    ['-C', worktree, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    {},
    `candidate ref lookup ${ref}`,
  )
  if (resume) {
    assertSame('candidate fixture commit', fixtureCommit, expectedSource.fixture_commit)
  }
  if (kind === 'candidate') {
    assertValidatorReadyFixture(exec, worktree, fixtureCommit)
  }
  if (!resume) {
    if (branch) {
      for (const candidateRef of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
        const collision = exec(
          'git',
          ['-C', worktree, 'show-ref', '--verify', '--quiet', candidateRef],
          { encoding: 'utf8' },
        )
        if (collision.status === 0) {
          throw new Error(`candidate branch collision: ${branch} already exists`)
        }
      }
      run(
        exec,
        'git',
        ['-C', worktree, 'checkout', '-b', branch, fixtureCommit],
        {},
        `candidate branch creation ${branch}`,
      )
    } else {
      run(exec, 'git', ['-C', worktree, 'checkout', '--detach', fixtureCommit], {}, `candidate checkout ${ref}`)
    }
  }

  await installEvalExcludes(worktree)
  const headCommit = run(exec, 'git', ['-C', worktree, 'rev-parse', 'HEAD'], {}, 'candidate commit lookup')
  if (resume) {
    if (branch) {
      const currentBranch = run(
        exec,
        'git',
        ['-C', worktree, 'branch', '--show-current'],
        {},
        'candidate branch lookup',
      )
      assertSame('candidate branch', currentBranch, branch)
    }
    const ancestry = exec(
      'git',
      ['-C', worktree, 'merge-base', '--is-ancestor', fixtureCommit, headCommit],
      { encoding: 'utf8' },
    )
    if (ancestry.status !== 0 || ancestry.error) {
      throw new Error(`candidate HEAD ${headCommit} does not descend from recorded fixture ${fixtureCommit}`)
    }
  }
  return {
    commit: fixtureCommit,
    fixture_commit: fixtureCommit,
    head_commit: headCommit,
    repository,
    worktree,
    branch,
    base_branch: baseBranch,
  }
}

function parseTrackedFiles(text) {
  if (!text) return []
  return text.split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\t')
    const metadata = separator === -1 ? [] : entry.slice(0, separator).split(/\s+/)
    if (metadata.length !== 3) throw new Error(`cannot parse tracked source entry: ${entry}`)
    return {
      mode: metadata[0],
      type: metadata[1],
      object: metadata[2],
      path: entry.slice(separator + 1),
    }
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
    { maxBuffer: MAX_CANDIDATE_DIFF_BYTES },
    'candidate diff capture',
    { trim: false },
  )
  const diff = rawDiff && !rawDiff.endsWith('\n') ? `${rawDiff}\n` : rawDiff
  const diffSha256 = hashString(diff)
  const trackedFiles = parseTrackedFiles(run(
    exec,
    'git',
    ['-C', worktree, 'ls-tree', '-rz', '--full-tree', producedCommit],
    {},
    'candidate source manifest',
    { trim: false },
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

function deliveryError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  error.owner = 'implementation-workflow'
  error.resumable = code !== 'workflow-side-effect-violation'
  Object.assign(error, details)
  return error
}

function normalizePullRequest(raw) {
  if (!raw) return null
  return {
    number: raw.number ?? null,
    url: raw.url ?? null,
    state: raw.state ?? null,
    draft: raw.draft ?? raw.isDraft ?? null,
    base: raw.base ?? raw.baseRefName ?? null,
    head_branch: raw.head_branch ?? raw.headRefName ?? null,
    head_sha: raw.head_sha ?? raw.headRefOid ?? null,
  }
}

export async function inspectDraftPullRequest({ worktree, branch, exec = defaultExec }) {
  const json = run(
    exec,
    'gh',
    [
      'pr', 'list',
      '--head', branch,
      '--state', 'all',
      '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid',
      '--limit', '2',
    ],
    { cwd: worktree },
    'draft pull-request metadata lookup',
  )
  let pulls
  try {
    pulls = JSON.parse(json)
  } catch {
    throw deliveryError('pull-request-metadata-invalid', 'draft pull-request metadata is not valid JSON')
  }
  if (!Array.isArray(pulls) || pulls.length !== 1) {
    throw deliveryError(
      'pull-request-identity-mismatch',
      `expected exactly one pull request for ${branch}, found ${Array.isArray(pulls) ? pulls.length : 0}`,
    )
  }
  return normalizePullRequest(pulls[0])
}

export async function verifyRecordedDeliveryIdentity({
  worktree,
  recorded,
  exec = defaultExec,
  inspectPullRequest = (options) => inspectDraftPullRequest({ ...options, exec }),
}) {
  if (!recorded?.branch) {
    throw new Error('resume provenance is missing the recorded candidate branch')
  }
  if (!recorded?.base_branch) {
    throw new Error('resume provenance is missing the recorded candidate default base branch')
  }
  if (recorded.pull_request && recorded.pull_request.base !== recorded.base_branch) {
    throw new Error(
      `recorded pull request base ${recorded.pull_request.base ?? null} does not match `
      + `recorded candidate default base branch ${recorded.base_branch}`,
    )
  }
  const branch = run(
    exec,
    'git',
    ['-C', worktree, 'branch', '--show-current'],
    {},
    'resume candidate branch lookup',
  )
  if (branch !== recorded.branch) {
    throw new Error(`candidate branch ${branch} does not match recorded candidate branch ${recorded.branch}`)
  }
  if (recorded.final_sha) {
    const head = run(exec, 'git', ['-C', worktree, 'rev-parse', 'HEAD'], {}, 'resume candidate HEAD lookup')
    if (head !== recorded.final_sha) {
      throw new Error(`candidate final SHA ${head} does not match recorded final SHA ${recorded.final_sha}`)
    }
  }
  if (recorded.pull_request) {
    const current = normalizePullRequest(await inspectPullRequest({ worktree, branch }))
    for (const field of ['number', 'url', 'state', 'draft', 'base', 'head_branch', 'head_sha']) {
      if (current?.[field] !== recorded.pull_request[field]) {
        throw new Error(
          `pull request ${field} ${current?.[field] ?? null} does not match recorded `
          + `pull request ${field} ${recorded.pull_request[field] ?? null}`,
        )
      }
    }
  }
  return { verified: true, branch, final_sha: recorded.final_sha ?? null }
}

export async function verifyCandidateDelivery({
  worktree,
  fixtureCommit,
  branch,
  expectedBase,
  changeName,
  sessionDir,
  workflowHistory,
  exec = defaultExec,
  inspectPullRequest = (options) => inspectDraftPullRequest({ ...options, exec }),
}) {
  if (!expectedBase) {
    throw deliveryError(
      'missing-delivery-identity',
      'candidate delivery has no recorded expected base branch',
      { missing_delivery_output: 'candidate-base-branch' },
    )
  }
  const history = checkWorkflowHistory(workflowHistory)
  if (history.prohibited_effects.length > 0) {
    const unexpected = history.prohibited_effects[0]
    throw deliveryError(
      'workflow-side-effect-violation',
      `workflow-side-effect-violation: observed prohibited action ${unexpected.step}`,
      { unexpected_action: unexpected.step, workflow_history: workflowHistory },
    )
  }
  if (history.missing_steps.length > 0) {
    throw deliveryError(
      'incomplete-workflow-history',
      `completed workflow history is missing: ${history.missing_steps.join(', ')}`,
      { missing_delivery_output: history.missing_steps },
    )
  }

  const status = run(
    exec,
    'git',
    ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all'],
    {},
    'candidate delivery cleanliness check',
  )
  if (status) {
    throw deliveryError('dirty-candidate', `candidate delivery has uncommitted changes:\n${status}`)
  }
  const currentBranch = run(
    exec,
    'git',
    ['-C', worktree, 'branch', '--show-current'],
    {},
    'candidate delivery branch lookup',
  )
  if (currentBranch !== branch) {
    throw deliveryError(
      'candidate-branch-mismatch',
      `candidate branch ${currentBranch} does not match recorded candidate branch ${branch}`,
    )
  }
  const finalSha = run(exec, 'git', ['-C', worktree, 'rev-parse', 'HEAD'], {}, 'candidate final HEAD lookup')
  const ancestry = exec(
    'git',
    ['-C', worktree, 'merge-base', '--is-ancestor', fixtureCommit, finalSha],
    { encoding: 'utf8' },
  )
  if (ancestry.status !== 0 || ancestry.error) {
    throw deliveryError(
      'fixture-ancestry-mismatch',
      `candidate final HEAD ${finalSha} does not descend from fixture ${fixtureCommit}`,
    )
  }

  const remote = run(
    exec,
    'git',
    ['-C', worktree, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    {},
    'remote candidate branch lookup',
  )
  const remoteSha = remote.split(/\s+/)[0] || null
  if (remoteSha !== finalSha) {
    throw deliveryError(
      'remote-branch-mismatch',
      `remote candidate branch ${branch} is ${remoteSha ?? 'missing'}, expected ${finalSha}`,
    )
  }

  const changePath = join(worktree, 'openspec', 'changes', changeName)
  if (!(await stat(changePath).catch(() => null))?.isDirectory()) {
    throw deliveryError(
      'workflow-side-effect-violation',
      `workflow-side-effect-violation: OpenSpec change ${changeName} was archived or removed`,
      { unexpected_action: 'archive-change' },
    )
  }

  const pullRequest = normalizePullRequest(await inspectPullRequest({ worktree, branch }))
  if (!pullRequest
    || pullRequest.state !== 'OPEN'
    || pullRequest.draft !== true
    || !pullRequest.base
    || pullRequest.head_branch !== branch
    || pullRequest.head_sha !== finalSha) {
    const prohibited = pullRequest && (pullRequest.state !== 'OPEN' || pullRequest.draft !== true)
    throw deliveryError(
      prohibited ? 'workflow-side-effect-violation' : 'pull-request-identity-mismatch',
      prohibited
        ? 'workflow-side-effect-violation: candidate pull request is closed, merged, or ready for review'
        : 'draft pull request does not match the recorded candidate branch and final HEAD',
      { pull_request: pullRequest },
    )
  }
  if (pullRequest.base !== expectedBase) {
    throw deliveryError(
      'pull-request-base-mismatch',
      `draft pull request base ${pullRequest.base} does not match expected repository base ${expectedBase}`,
      { pull_request: pullRequest },
    )
  }

  let acceptance
  try {
    acceptance = await inspectCandidateEvidenceReadiness({ worktree, sessionDir })
  } catch (error) {
    if (error instanceof EvidenceReadinessError || error.code === 'missing-evidence-role') {
      throw deliveryError(
        'missing-delivery-output',
        error.message,
        { missing_delivery_output: error.missing_roles ?? error.missing_delivery_output },
      )
    }
    error.owner ??= 'evaluation-harness'
    throw error
  }

  return {
    verified: true,
    branch,
    base_branch: expectedBase,
    fixture_commit: fixtureCommit,
    final_sha: finalSha,
    remote_sha: remoteSha,
    pull_request: pullRequest,
    final_validator: workflowHistory
      .filter((entry) => (entry.step ?? entry.id) === 'run-validator')
      .at(-1) ?? null,
    workflow_history: workflowHistory,
    acceptance_artifacts: acceptance.artifacts,
    acceptance_findings: acceptance.findings,
  }
}
