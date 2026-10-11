// Provenance-safe import of a completed candidate workflow for evaluator-only
// rescoring. The source run stays read-only; only its verified implementation,
// delivery, and acceptance facts are carried into a fresh evaluation record.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { verifyCandidateDelivery } from './candidate.mjs'
import { loadCheckpoint } from './checkpoint.mjs'
import { hashFile, hashJson, hashString, readJson } from './persistence.mjs'
import { normalizeRoleProfiles } from './profiles.mjs'

const ARTIFACT_ROOT = '/artifacts'

function same(label, left, right) {
  if (left !== right) {
    throw new Error(`rescore source ${label} does not match: ${left ?? null} != ${right ?? null}`)
  }
}

function within(root, path) {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

function sourcePath(sourceDir, recordedPath) {
  if (typeof recordedPath !== 'string' || !recordedPath.startsWith(`${ARTIFACT_ROOT}/`)) {
    throw new Error(`rescore source artifact path is not rooted at ${ARTIFACT_ROOT}: ${recordedPath ?? null}`)
  }
  const path = resolve(sourceDir, recordedPath.slice(`${ARTIFACT_ROOT}/`.length))
  if (!within(sourceDir, path)) {
    throw new Error(`rescore source artifact escapes the source directory: ${recordedPath}`)
  }
  return path
}

function validateDelivery(state, delivery) {
  if (delivery?.verified !== true) throw new Error('rescore source delivery was not verified')
  for (const field of ['fixture_commit', 'branch', 'base_branch', 'final_sha']) {
    same(`delivery ${field}`, state.delivery?.[field], delivery[field])
  }
  for (const field of ['number', 'url', 'state', 'draft', 'base', 'head_branch', 'head_sha']) {
    same(
      `pull request ${field}`,
      state.delivery?.pull_request?.[field],
      delivery.pull_request?.[field],
    )
  }
  if (!/^[a-f0-9]{40}$/i.test(delivery.final_sha ?? '')) {
    throw new Error('rescore source final SHA is missing or invalid')
  }
  if (
    delivery.remote_sha !== delivery.final_sha
    || delivery.pull_request?.head_sha !== delivery.final_sha
    || delivery.pull_request?.state !== 'OPEN'
    || delivery.pull_request?.draft !== true
    || !delivery.pull_request?.base
  ) {
    throw new Error('rescore source does not describe an aligned open draft pull request')
  }
}

// The source's own retained completion record, never its step layout. Results
// written before the harness recorded Agent Runner's completion status carry
// only their own history verdict, which is read as that record.
function sourceCompleted(workflow) {
  if (workflow?.run_completed !== undefined) return workflow.run_completed === true
  return workflow?.history_complete === true
    && (workflow?.missing_steps ?? []).length === 0
    && (workflow?.prohibited_effects ?? []).length === 0
}

// The roles the source ran with: its run-state profiles, or, for a source
// whose run state kept none, the profiles its result configured. A source
// recorded before a role existed keeps only the roles it had; one that
// recorded none at all is refused rather than given operator-supplied ones.
function recordedRoleProfiles(state, result) {
  const usable = (profiles) => {
    const entries = Object.entries(normalizeRoleProfiles(profiles) ?? {})
      .filter(([, profile]) => profile && typeof profile === 'object')
    return entries.length > 0 ? Object.fromEntries(entries) : null
  }
  const configured = Object.fromEntries(
    Object.entries(result?.role_configuration?.roles ?? {})
      .map(([role, entry]) => [role, entry?.configured]),
  )
  const profiles = usable(state.role_profiles) ?? usable(configured)
  if (!profiles) throw new Error('rescore source records no role profiles')
  return profiles
}

function skipValidatorFromWorkflow(workflow) {
  const values = (workflow?.arguments ?? [])
    .filter((argument) => argument.startsWith('skip_validator='))
    .map((argument) => argument.slice('skip_validator='.length))
  if (values.length !== 1 || !['true', 'false'].includes(values[0])) {
    throw new Error('rescore source workflow must contain exactly one valid skip_validator argument')
  }
  return values[0] === 'true'
}

function changeNameFromWorkflow(workflow) {
  const values = (workflow?.arguments ?? [])
    .filter((argument) => argument.startsWith('change_name='))
    .map((argument) => argument.slice('change_name='.length))
  if (values.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values[0] ?? '')) {
    throw new Error('rescore source workflow must contain exactly one valid change_name argument')
  }
  return values[0]
}

const RETAINED_EVIDENCE = 'evidence/candidate/artifacts'
const CANDIDATE_WORKTREE = '.runtime/candidate-worktree'

// Factory runs retain every acceptance artifact under evidence/candidate/ but
// may drop the recorded Runner session under .runtime/. The retained manifest
// is accepted only when it reproduces the manifest hash the source recorded,
// and each retained copy only when its bytes match both the manifest and the
// recorded acceptance hash.
async function retainedSessionEvidence(root, state) {
  const manifest = await readJson(join(root, 'evidence/candidate/manifest.json'), null)
  if (!manifest || !Array.isArray(manifest.artifacts)) {
    throw new Error('rescore source has no retained candidate evidence manifest to restore its Runner session from')
  }
  const { manifest_sha256: recordedSelfHash, ...body } = manifest
  const expected = state.delivery?.acceptance?.manifest_sha256
  if (!expected || recordedSelfHash !== expected || hashJson(body) !== expected) {
    throw new Error('rescore source retained evidence manifest does not match its recorded manifest hash')
  }
  const files = new Map()
  const worktreeFiles = new Map()
  for (const artifact of manifest.artifacts) {
    const namespace = artifact?.origin?.namespace
    if (!['runner-session', 'candidate-worktree'].includes(namespace)) continue
    const relativePath = artifact.origin.relative_path
    if (typeof relativePath !== 'string' || isAbsolute(relativePath)
      || relativePath.split('/').includes('..')
      || (namespace === 'runner-session' && !relativePath.startsWith('output/'))) {
      throw new Error(`rescore source retained evidence has an unsafe path: ${relativePath ?? null}`)
    }
    if (typeof artifact.path !== 'string' || !artifact.path.startsWith(`${RETAINED_EVIDENCE}/`)) {
      throw new Error(`rescore source retained evidence is outside ${RETAINED_EVIDENCE}: ${artifact.path ?? null}`)
    }
    const retained = resolve(root, artifact.path)
    if (!within(join(root, RETAINED_EVIDENCE), retained) || (await lstat(retained)).isSymbolicLink()) {
      throw new Error(`rescore source retained evidence escapes ${RETAINED_EVIDENCE}: ${artifact.path}`)
    }
    const bytes = await readFile(retained)
    if (hashString(bytes) !== artifact.sha256) {
      throw new Error(`rescore source acceptance evidence hash mismatch: ${artifact.path}`)
    }
    const entry = { bytes, sha256: artifact.sha256, retained }
    if (namespace === 'runner-session') files.set(relativePath, entry)
    else worktreeFiles.set(relativePath, entry)
  }
  return { files, worktreeFiles }
}

export async function loadCandidateRescoreSource({ sourceDir, stagingDir = null }) {
  const root = await realpath(resolve(sourceDir))
  const statePath = join(root, 'run-state.json')
  const resultPath = join(root, 'result.json')
  const deliveryPath = join(root, 'phases/delivery-verification.json')
  const [state, result, delivery] = await Promise.all([
    loadCheckpoint(statePath),
    readJson(resultPath),
    readJson(deliveryPath),
  ])

  if (!state || state.run_kind !== 'candidate' || state.delivery?.applicable !== true) {
    throw new Error('rescore source must be a completed candidate run')
  }
  if (
    result?.run_kind !== 'candidate'
    || result.mode !== 'agent-runner'
    || result.workflow?.full_workflow !== true
    || !sourceCompleted(result.workflow)
  ) {
    throw new Error('rescore source did not complete the full implementation workflow')
  }
  same('run id', state.run_id, result.run_id)
  skipValidatorFromWorkflow(result.workflow)
  validateDelivery(state, delivery)
  const changeName = changeNameFromWorkflow(result.workflow)
  const roleProfiles = recordedRoleProfiles(state, result)

  const recordedArtifacts = delivery.acceptance_artifacts ?? []
  if (recordedArtifacts.length === 0) {
    throw new Error('rescore source has no recorded acceptance evidence')
  }
  const runner = state.agent_runner ?? state.delivery.runner
  if (!runner?.run_id || !runner?.session_dir) {
    throw new Error('rescore source is missing its completed Agent Runner identity')
  }
  let sessionDir = sourcePath(root, runner.session_dir)

  // Each recorded artifact in its recorded order, with whether its bytes are
  // still at the recorded path.
  const recorded = []
  for (const artifact of recordedArtifacts) {
    const path = sourcePath(root, artifact.path)
    const observed = await hashFile(path)
    if (observed !== null && observed !== artifact.sha256) {
      throw new Error(`rescore source acceptance evidence hash mismatch: ${artifact.path}`)
    }
    recorded.push({ ...artifact, path, present: observed !== null })
  }
  let artifacts = recorded.map(({ present: _present, ...artifact }) => artifact)

  let sessionReconstruction = null
  if (recorded.some(({ present }) => !present)) {
    if (!stagingDir) {
      throw new Error('rescore source Runner session is missing and no staging directory was given to restore it')
    }
    const { files, worktreeFiles } = await retainedSessionEvidence(root, state)
    const staged = resolve(stagingDir)
    const worktree = join(root, CANDIDATE_WORKTREE)
    const retainedPaths = new Map()
    for (const artifact of recorded) {
      // A referenced candidate-worktree file is re-read from the rescore's own
      // checkout; here its retained copy only has to prove the recorded hash.
      if (!within(sessionDir, artifact.path)) {
        if (artifact.present) continue
        const copy = within(worktree, artifact.path)
          ? worktreeFiles.get(relative(worktree, artifact.path).split(sep).join('/')) : null
        if (!copy || copy.sha256 !== artifact.sha256) {
          throw new Error(`rescore source acceptance evidence is missing and not retained: ${artifact.path}`)
        }
        retainedPaths.set(artifact.path, copy.retained)
        continue
      }
      const relativePath = relative(sessionDir, artifact.path).split(sep).join('/')
      const copy = files.get(relativePath)
      if (copy && copy.sha256 !== artifact.sha256) {
        throw new Error(`rescore source acceptance evidence hash mismatch: ${artifact.path}`)
      }
      if (!copy && !artifact.present) {
        throw new Error(`rescore source acceptance evidence is missing and not retained: ${artifact.path}`)
      }
      if (!copy) files.set(relativePath, { bytes: await readFile(artifact.path), sha256: artifact.sha256 })
    }
    for (const [relativePath, { bytes }] of files) {
      const target = join(staged, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    artifacts = artifacts.map((artifact) => ({ ...artifact,
      path: retainedPaths.get(artifact.path)
        ?? (within(sessionDir, artifact.path) ? join(staged, relative(sessionDir, artifact.path)) : artifact.path) }))
    sessionDir = staged
    sessionReconstruction = { source: RETAINED_EVIDENCE, files: files.size }
  }
  const candidateSource = state.candidate_source
  if (
    !candidateSource?.repository
    || !candidateSource.fixture_commit
    || !candidateSource.branch
    || !candidateSource.base_branch
  ) {
    throw new Error('rescore source candidate provenance is incomplete')
  }

  const coreHashes = {
    run_state: await hashFile(statePath),
    result: await hashFile(resultPath),
    delivery: await hashFile(deliveryPath),
  }
  // The verified hashes the source is identified by.
  const manifestHashes = {
    core: coreHashes,
    acceptance: artifacts.map(({ role, sha256 }) => ({ role, sha256 })),
    final_sha: delivery.final_sha,
  }
  return {
    source_dir: root,
    source_run_id: state.run_id,
    change_name: changeName,
    provenance_sha256: hashJson(manifestHashes),
    manifest_hashes: manifestHashes,
    candidate_source: { ...candidateSource },
    delivery: {
      ...delivery,
      acceptance_artifacts: artifacts,
      acceptance: {
        artifacts,
        workflow_history: delivery.workflow_history,
      },
    },
    runner: { ...runner, session_dir: sessionDir },
    session_reconstruction: sessionReconstruction,
    role_profiles: roleProfiles,
    // The retained completion record stands in for live Runner status.
    run_completed: sourceCompleted(result.workflow),
    agent_runner_provenance: state.agent_runner_provenance,
    agent_skills_provenance: state.agent_skills_provenance,
    workflow: result.workflow,
    implementation_metrics: result.implementation_metrics ?? null,
    cost: result.cost ?? null,
    pricing: result.pricing ?? null,
  }
}

const PULL_REQUEST_IDENTITY = ['number', 'url', 'state', 'draft', 'base', 'head_branch', 'head_sha']

// Live remote state a rescore observes but the source run did not leave behind.
// The source was accepted only with a verified delivery whose remote branch was
// at its final SHA and whose pull request was an open draft, so a branch that
// is now gone or moved, or a pull request now closed, merged, or ready, changed
// after the evaluated workflow finished: typically operator cleanup. Such a
// change says nothing about the workflow, so it is a harness-owned unavailable
// source rather than a side-effect verdict. An archived change is not listed:
// it is read from the recorded final commit itself, so it is the workflow's.
const POST_RUN_STATE_CHANGES = new Set([
  'delete-candidate-branch',
  'remote-branch-moved',
  'close-pull-request',
  'merge-pull-request',
  'mark-ready-for-review',
])

function rescoreSourceUnavailable(violation, recorded) {
  const error = new Error(
    `rescore-source-unavailable: the live candidate branch or pull request no longer matches the retained record `
    + `(branch ${recorded.branch ?? null}, pull request ${recorded.pull_request?.url ?? null}); `
    + `it changed after the source run, so this is not a verdict about the evaluated workflow: `
    + violation.message.replace(/^workflow-side-effect-violation:\s*/, ''),
    { cause: violation },
  )
  error.code = 'rescore-source-unavailable'
  error.owner = 'evaluation-harness'
  error.resumable = false
  error.post_run_change = violation.unexpected_action
  if (violation.remote_sha !== undefined) error.remote_sha = violation.remote_sha
  if (violation.pull_request !== undefined) error.observed_pull_request = violation.pull_request
  return error
}

// Delivery for an imported run goes through the same outcome-based checks as a
// new run, with the source's retained completion status in place of live
// Runner status and its retained or restored session as the session output.
// The observed outcome must still be the delivery the source recorded; the
// hash-verified recorded acceptance evidence is kept rather than rediscovered.
export async function verifyRescoreDelivery({
  imported,
  worktree,
  exec,
  verify = verifyCandidateDelivery,
}) {
  const recorded = imported.delivery
  let observed
  try {
    observed = await verify({
      worktree,
      fixtureCommit: imported.candidate_source.fixture_commit,
      branch: imported.candidate_source.branch,
      expectedBase: imported.candidate_source.base_branch,
      changeName: imported.change_name,
      sessionDir: imported.runner.session_dir,
      runCompleted: imported.run_completed,
      ...(exec ? { exec } : {}),
    })
  } catch (error) {
    if (error?.code === 'workflow-side-effect-violation' && POST_RUN_STATE_CHANGES.has(error.unexpected_action)) {
      throw rescoreSourceUnavailable(error, recorded)
    }
    throw error
  }
  for (const field of ['branch', 'final_sha']) {
    same(`delivery ${field}`, observed?.[field], recorded[field])
  }
  for (const field of PULL_REQUEST_IDENTITY) {
    same(`pull request ${field}`, observed?.pull_request?.[field], recorded.pull_request?.[field])
  }
  return {
    ...recorded,
    verified: true,
    run_status: observed.run_status,
    remote_sha: observed.remote_sha,
    publication_boundary: observed.publication_boundary,
  }
}
