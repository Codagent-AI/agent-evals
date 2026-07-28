// Provenance-safe import of a completed candidate workflow for evaluator-only
// rescoring. The source run stays read-only; only its verified implementation,
// delivery, and acceptance facts are carried into a fresh evaluation record.
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { loadCheckpoint } from './checkpoint.mjs'
import { hashFile, hashJson, readJson } from './persistence.mjs'
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
  const history = checkWorkflowHistory(delivery.workflow_history ?? [])
  if (!history.ok) {
    throw new Error('rescore source did not complete the full implementation workflow')
  }
}

export async function loadCandidateRescoreSource({ sourceDir }) {
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
  validateDelivery(state, delivery)

  const recordedArtifacts = delivery.acceptance_artifacts ?? []
  if (recordedArtifacts.length === 0) {
    throw new Error('rescore source has no recorded acceptance evidence')
  }
  const artifacts = []
  for (const artifact of recordedArtifacts) {
    const path = sourcePath(root, artifact.path)
    const observed = await hashFile(path)
    if (!observed || observed !== artifact.sha256) {
      throw new Error(`rescore source acceptance evidence hash mismatch: ${artifact.path}`)
    }
    artifacts.push({ ...artifact, path })
  }

  const runner = state.agent_runner ?? state.delivery.runner
  if (!runner?.run_id || !runner?.session_dir) {
    throw new Error('rescore source is missing its completed Agent Runner identity')
  }
  const sessionDir = sourcePath(root, runner.session_dir)
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
        ...(state.delivery.acceptance ?? {}),
        artifacts,
        workflow_history: delivery.workflow_history,
      },
    },
    runner: { ...runner, session_dir: sessionDir },
    role_profiles: state.role_profiles,
    agent_runner_provenance: state.agent_runner_provenance,
    agent_skills_provenance: state.agent_skills_provenance,
    workflow: result.workflow,
    implementation_metrics: result.implementation_metrics ?? null,
    cost: result.cost ?? null,
    pricing: result.pricing ?? null,
  }
}
