// Agent Runner workflow provenance.
//
// The evaluation does not pin Agent Runner to a predetermined commit; it
// requires a clean worktree and records whichever revision it used, so a run
// stays reproducible without freezing the evaluated product.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { hashFile } from './persistence.mjs'

export const WORKFLOW_RELATIVE_PATH = 'workflows/openspec/implement-change2.yaml'

export const PROVENANCE_FIELDS = ['commit', 'workflow_sha256', 'cli_version']

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
