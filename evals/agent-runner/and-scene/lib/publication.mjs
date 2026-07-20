// Permanent result publication.
//
// Publication is post-evaluation delivery, not evaluation. It runs only after a
// human review has durably finalized a `complete` pass or product-fail result,
// and everything it does is deliberately narrow:
//
//   * It copies a curated snapshot — never the run directory. Runtime state,
//     cloned repositories, build output, Agent Runner sessions and transcripts,
//     raw model output, logs, screenshots, traces, and raw pricing catalogs stay
//     in the ignored run directory.
//   * It stages and commits the curated files by name, so neither an unrelated
//     dirty working tree nor a stray file sharing the results directory can be
//     swept into a result commit.
//   * It runs an ordinary `git push`. There is no force flag anywhere in this
//     module, and the tests assert that.
//
// It is also independently retryable. The completed product result is already
// durable when publication begins, so a commit or push failure records a stage
// checkpoint, leaves the result untouched, and exits nonzero. Resume picks up at
// the recorded stage: an existing result commit is reused rather than duplicated
// and only the unfinished push is retried.
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readJson, writeJsonAtomic } from './persistence.mjs'
import { runTimed } from './subprocess.mjs'

export const PUBLICATION_SCHEMA_VERSION = 1

// Where a published run lives, relative to the agent-evals working directory.
export const RESULTS_RELATIVE_DIR = 'evals/agent-runner/and-scene/results'

// The whole permanent snapshot. Nothing outside this list is ever copied.
export const CURATED_ARTIFACTS = [
  'result.json',
  'report.html',
  'human-review.json',
  'ambiguity-ledger.json',
  'implementation.diff',
  'artifact-manifest.json',
]

// The approved permanent-record contract is exact: every completed run carries
// all six artifacts, and a partial snapshot is never committed as if complete.
export const REQUIRED_ARTIFACTS = [...CURATED_ARTIFACTS]

export const PUBLICATION_STAGES = ['snapshot', 'commit', 'push', 'published']

export class PublicationError extends Error {
  constructor(message, { stage }) {
    super(message)
    this.name = 'PublicationError'
    this.code = 'publication'
    this.stage = stage
  }
}

export function commitMessage(runId) {
  return `chore: record and-scene eval ${runId}`
}

export function resultsDirFor({ repoDir, runId }) {
  return join(repoDir, RESULTS_RELATIVE_DIR, runId)
}

// The pathspec every read-only status check is limited to. Always POSIX
// separators: it is a Git pathspec, not a filesystem path.
export function pathspecFor(runId) {
  return `${RESULTS_RELATIVE_DIR}/${runId}`
}

// Staging and committing name each curated file individually rather than the
// directory that holds them. A directory pathspec would stage whatever else
// happened to be sitting there, which is exactly the guarantee this module
// exists to make.
export function pathspecsFor(runId, files) {
  return files.map((name) => `${pathspecFor(runId)}/${name}`)
}

// Only a durably finalized product verdict is publishable. Pending reviews,
// workflow and harness failures, and calibration runs are all excluded, and each
// says which rule excluded it.
export function publicationEligibility(result) {
  if (!result) return { publishable: false, reason: 'no result to publish' }
  if (result.mode === 'calibration') {
    return { publishable: false, reason: 'calibration runs are diagnostic and are never published' }
  }
  if (result.evaluation_status !== 'complete') {
    return { publishable: false, reason: `evaluation_status is ${result.evaluation_status}, not complete` }
  }
  if (result.product_verdict !== 'pass' && result.product_verdict !== 'fail') {
    return { publishable: false, reason: `product verdict is ${result.product_verdict}, not pass or fail` }
  }
  return { publishable: true, reason: null }
}

export function defaultGit(args, { cwd } = {}) {
  const timing = runTimed('git', args, { cwd, label: 'git' })
  return { ok: timing.ok, status: timing.status, stdout: timing.stdout, stderr: timing.stderr }
}

function gitError(command, outcome) {
  return `git ${command} failed: ${(outcome.stderr || outcome.stdout || '').trim() || `exit ${outcome.status}`}`
}

export function publicationCheckpointPath(runDir) {
  return join(runDir, 'publication.json')
}

function createPublicationCheckpoint(runId) {
  return {
    schema_version: PUBLICATION_SCHEMA_VERSION,
    run_id: runId,
    stage: 'snapshot',
    commit: null,
    published_files: [],
    absent_files: [],
    error: null,
    completed_at: null,
  }
}

// Copy exactly the curated artifacts into the permanent results directory. A
// missing required artifact raises before anything is staged, and an artifact
// that is neither curated nor present is simply not part of the snapshot.
export async function copySnapshot({ runDir, runId, repoDir }) {
  const destination = resultsDirFor({ repoDir, runId })

  const files = []
  const absent = []
  for (const name of CURATED_ARTIFACTS) {
    const source = join(runDir, name)
    const present = await readable(source)
    if (!present) {
      if (REQUIRED_ARTIFACTS.includes(name)) {
        throw new PublicationError(
          `cannot publish ${runId}: the finalized run has no ${name}`,
          { stage: 'snapshot' },
        )
      }
      absent.push(name)
      continue
    }
    files.push(name)
  }

  // Nothing may survive this copy that the copy does not replace. An entry the
  // snapshot is about to overwrite is fine — that is an ordinary resume — but
  // anything else would remain in the published directory: an uncurated file
  // that was never part of any snapshot, or a curated artifact left by an
  // earlier publication under this run id that this run does not produce. Either
  // way the permanent record would end up describing two different runs, so
  // publication stops before it copies or stages anything.
  //
  // Comparing names is enough. Every entry that survives is rewritten from this
  // run's artifacts, so its previous content cannot reach the commit.
  const existing = await readdir(destination).catch(() => [])
  const stale = existing.filter((name) => !files.includes(name))
  if (stale.length > 0) {
    const uncurated = stale.filter((name) => !CURATED_ARTIFACTS.includes(name))
    const superseded = stale.filter((name) => CURATED_ARTIFACTS.includes(name))
    throw new PublicationError(
      `cannot publish ${runId}: ${destination} contains entries this snapshot does not replace`
      + (uncurated.length > 0 ? `; uncurated: ${uncurated.join(', ')}` : '')
      + (superseded.length > 0
        ? `; from an earlier publication of this run id: ${superseded.join(', ')}`
        : ''),
      { stage: 'snapshot' },
    )
  }

  await mkdir(destination, { recursive: true })
  for (const name of files) {
    await copyFile(join(runDir, name), join(destination, name))
  }
  return { dir: destination, files, absent }
}

async function readable(path) {
  const { access } = await import('node:fs/promises')
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// Is HEAD already this run's result commit? Asked before committing so a lost
// publication checkpoint cannot produce a second commit for the same run.
function headIsResultCommit({ git, repoDir, runId }) {
  const subject = git(['log', '-1', '--format=%s'], { cwd: repoDir })
  if (!subject.ok || subject.stdout.trim() !== commitMessage(runId)) return null
  const status = git(['status', '--porcelain', '--', pathspecFor(runId)], { cwd: repoDir })
  if (!status.ok || status.stdout.trim() !== '') return null
  const head = git(['rev-parse', 'HEAD'], { cwd: repoDir })
  return head.ok ? head.stdout.trim() : null
}

// Publish one finalized run. Returns a skip record for anything not publishable,
// and throws a `PublicationError` after recording its stage checkpoint when the
// commit or push fails.
export async function publishRun({
  runDir,
  runId,
  result,
  repoDir,
  git = defaultGit,
  log = () => {},
}) {
  const eligibility = publicationEligibility(result)
  if (!eligibility.publishable) {
    return { published: false, skipped: true, reason: eligibility.reason, commit: null }
  }

  const checkpointPath = publicationCheckpointPath(runDir)
  let checkpoint = await readJson(checkpointPath, null) ?? createPublicationCheckpoint(runId)

  // A finished publication is a finished publication. Reopening the run — which
  // a paired review or a later resume does routinely — must not stage, commit,
  // or push anything a second time.
  if (checkpoint.stage === 'published') {
    return { published: true, skipped: false, reason: null, commit: checkpoint.commit }
  }
  const save = async (next) => {
    checkpoint = { ...checkpoint, ...next }
    await writeJsonAtomic(checkpointPath, checkpoint)
    return checkpoint
  }

  // Everything before the push is skipped once a commit is already recorded, so
  // resume after a failed push retries only the push.
  if (checkpoint.stage !== 'push' || !checkpoint.commit) {
    let snapshot
    try {
      snapshot = await copySnapshot({ runDir, runId, repoDir })
    } catch (error) {
      await save({ stage: 'snapshot', error: error.message })
      throw error
    }
    await save({
      stage: 'commit',
      published_files: snapshot.files,
      absent_files: snapshot.absent,
      error: null,
    })

    const existing = headIsResultCommit({ git, repoDir, runId })
    if (existing) {
      log(`publication: reusing existing result commit ${existing} for ${runId}`)
      await save({ stage: 'push', commit: existing, error: null })
    } else {
      const pathspecs = pathspecsFor(runId, snapshot.files)
      const staged = git(['add', '--', ...pathspecs], { cwd: repoDir })
      if (!staged.ok) {
        const message = gitError('add', staged)
        await save({ stage: 'commit', error: message })
        throw new PublicationError(message, { stage: 'commit' })
      }
      const committed = git(['commit', '-m', commitMessage(runId), '--', ...pathspecs], { cwd: repoDir })
      if (!committed.ok) {
        const message = gitError('commit', committed)
        await save({ stage: 'commit', error: message })
        throw new PublicationError(message, { stage: 'commit' })
      }
      const head = git(['rev-parse', 'HEAD'], { cwd: repoDir })
      if (!head.ok) {
        const message = gitError('rev-parse', head)
        await save({ stage: 'commit', error: message })
        throw new PublicationError(message, { stage: 'commit' })
      }
      await save({ stage: 'push', commit: head.stdout.trim(), error: null })
      log(`publication: committed ${snapshot.files.length} curated files as ${checkpoint.commit}`)
    }
  }

  // An ordinary push on the current branch's configured upstream. No refspec, no
  // remote override, and no force.
  const pushed = git(['push'], { cwd: repoDir })
  if (!pushed.ok) {
    const message = gitError('push', pushed)
    await save({ stage: 'push', error: message })
    throw new PublicationError(message, { stage: 'push' })
  }

  await save({ stage: 'published', error: null, completed_at: new Date().toISOString() })
  return { published: true, skipped: false, reason: null, commit: checkpoint.commit }
}
