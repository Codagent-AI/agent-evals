// Agent Runner workflow provenance.
//
// The evaluation does not pin Agent Runner to a predetermined commit; it
// requires a clean worktree and records whichever revision it used, so a run
// stays reproducible without freezing the evaluated product.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { hashFile } from './persistence.mjs'

export const WORKFLOW_RELATIVE_PATH = 'workflows/core/implement-change-v1.0.yaml'
export const AGENT_SKILLS_MANIFEST_PATH = '.claude-plugin/marketplace.json'

export const PROVENANCE_FIELDS = ['commit', 'workflow_sha256', 'cli_version']
export const AGENT_SKILLS_PROVENANCE_FIELDS = ['commit', 'manifest_sha256']

function provenanceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function defaultExec(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

export async function readWorkflowProvenance({ agentRunnerDir, exec = defaultExec }) {
  const worktree = exec('git', ['-C', agentRunnerDir, 'rev-parse', '--is-inside-work-tree'])
  if (worktree.status !== 0 || (worktree.stdout ?? '').trim() !== 'true') {
    throw provenanceError(
      'not-a-git-worktree',
      `Agent Runner checkout is not a Git worktree: ${agentRunnerDir}`,
    )
  }

  // `--porcelain` covers staged, unstaged, and untracked entries alike. A
  // failed status command means cleanliness was never established, so it must
  // not be read as an empty (clean) result.
  const status = exec('git', ['-C', agentRunnerDir, 'status', '--porcelain'])
  if (status.status !== 0) {
    throw provenanceError(
      'git-status-failed',
      `Cannot determine Agent Runner checkout status: ${agentRunnerDir}\n${(status.stderr ?? '').trim().slice(0, 500)}`,
    )
  }
  const dirty = (status.stdout ?? '').trim()
  if (dirty) {
    throw provenanceError(
      'dirty-agent-runner-checkout',
      `Agent Runner checkout has uncommitted changes: ${agentRunnerDir}\n${dirty}`,
    )
  }

  const workflowPath = join(agentRunnerDir, WORKFLOW_RELATIVE_PATH)
  const workflowSha256 = await hashFile(workflowPath)
  if (workflowSha256 === null) {
    throw provenanceError('missing-workflow', `Workflow not found: ${workflowPath}`)
  }

  const head = exec('git', ['-C', agentRunnerDir, 'rev-parse', 'HEAD'])
  const commit = head.status === 0 ? (head.stdout ?? '').trim() || null : null

  const version = exec('agent-runner', ['--version'], { cwd: agentRunnerDir })
  const cliVersion = version.status === 0 ? (version.stdout ?? '').trim().split('\n')[0] || null : null

  const provenance = {
    agent_runner_dir: agentRunnerDir,
    commit,
    clean: true,
    workflow_path: workflowPath,
    workflow_relative_path: WORKFLOW_RELATIVE_PATH,
    workflow_sha256: workflowSha256,
    cli_version: cliVersion,
  }
  // Incomplete provenance is recorded as such rather than presented as a
  // reproducible run.
  const complete = PROVENANCE_FIELDS.every((field) => provenance[field] !== null)
  return { ...provenance, complete, reproducible: complete }
}

export function compareProvenance(recorded, current) {
  return PROVENANCE_FIELDS.flatMap((field) => (
    recorded[field] === current[field]
      ? []
      : [{ field, recorded: recorded[field], current: current[field] }]
  ))
}

export async function readAgentSkillsProvenance({ agentSkillsDir, exec = defaultExec }) {
  const worktree = exec('git', ['-C', agentSkillsDir, 'rev-parse', '--is-inside-work-tree'])
  if (worktree.status !== 0 || (worktree.stdout ?? '').trim() !== 'true') {
    throw provenanceError(
      'not-an-agent-skills-git-worktree',
      `Agent Skills checkout is not a Git worktree: ${agentSkillsDir}`,
    )
  }

  const status = exec('git', ['-C', agentSkillsDir, 'status', '--porcelain'])
  if (status.status !== 0) {
    throw provenanceError(
      'agent-skills-git-status-failed',
      `Cannot determine Agent Skills checkout status: ${agentSkillsDir}\n${(status.stderr ?? '').trim().slice(0, 500)}`,
    )
  }
  const dirty = (status.stdout ?? '').trim()
  if (dirty) {
    throw provenanceError(
      'dirty-agent-skills-checkout',
      `Agent Skills checkout has uncommitted changes: ${agentSkillsDir}\n${dirty}`,
    )
  }

  const manifestPath = join(agentSkillsDir, AGENT_SKILLS_MANIFEST_PATH)
  const manifestSha256 = await hashFile(manifestPath)
  if (manifestSha256 === null) {
    throw provenanceError(
      'missing-agent-skills-manifest',
      `Agent Skills plugin manifest not found: ${manifestPath}`,
    )
  }

  const head = exec('git', ['-C', agentSkillsDir, 'rev-parse', 'HEAD'])
  const commit = head.status === 0 ? (head.stdout ?? '').trim() || null : null
  const provenance = {
    agent_skills_dir: agentSkillsDir,
    commit,
    clean: true,
    manifest_path: manifestPath,
    manifest_relative_path: AGENT_SKILLS_MANIFEST_PATH,
    manifest_sha256: manifestSha256,
  }
  const complete = AGENT_SKILLS_PROVENANCE_FIELDS.every((field) => provenance[field] !== null)
  return { ...provenance, complete, reproducible: complete }
}

export function compareAgentSkillsProvenance(recorded, current) {
  return AGENT_SKILLS_PROVENANCE_FIELDS.flatMap((field) => (
    recorded[field] === current[field]
      ? []
      : [{ field, recorded: recorded[field], current: current[field] }]
  ))
}
