// Provenance-safe import of a completed candidate workflow for evaluator-only
// rescoring. The source run stays read-only; only its verified implementation,
// delivery, and acceptance facts are carried into a fresh evaluation record.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { loadCheckpoint } from './checkpoint.mjs'
import { hashFile, hashJson, hashString, readJson } from './persistence.mjs'
import { normalizeRoleProfiles } from './profiles.mjs'
import { checkWorkflowHistory } from './workflow.mjs'

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

function validateDelivery(state, delivery, { skipValidator }) {
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
  const history = checkWorkflowHistory(delivery.workflow_history ?? [], { skipValidator })
  if (!history.ok) {
    throw new Error('rescore source did not complete the full implementation workflow')
  }
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
    || result.workflow?.history_complete !== true
    || (result.workflow?.missing_steps ?? []).length > 0
    || (result.workflow?.prohibited_effects ?? []).length > 0
  ) {
    throw new Error('rescore source did not complete the full implementation workflow')
  }
  same('run id', state.run_id, result.run_id)
  const skipValidator = skipValidatorFromWorkflow(result.workflow)
  validateDelivery(state, delivery, { skipValidator })
  const changeName = changeNameFromWorkflow(result.workflow)

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
  return {
    source_dir: root,
    source_run_id: state.run_id,
    change_name: changeName,
    provenance_sha256: hashJson({
      core: coreHashes,
      acceptance: artifacts.map(({ role, sha256 }) => ({ role, sha256 })),
      final_sha: delivery.final_sha,
    }),
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
    role_profiles: normalizeRoleProfiles(state.role_profiles),
    agent_runner_provenance: state.agent_runner_provenance,
    agent_skills_provenance: state.agent_skills_provenance,
    workflow: result.workflow,
    implementation_metrics: result.implementation_metrics ?? null,
    cost: result.cost ?? null,
    pricing: result.pricing ?? null,
  }
}
