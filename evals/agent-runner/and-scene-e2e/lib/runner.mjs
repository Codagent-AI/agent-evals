import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { listRunnerStates, readRunnerState, classifyDefineState } from '../../and-scene-define/lib/runner-state.mjs'
export async function privatePath(path, boundary = dirname(resolve(path))) {
  for (let probe = resolve(path); ; probe = dirname(probe)) {
    const stat = await lstat(probe).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (stat?.isSymbolicLink()) throw new Error(`run path refuses symlink: ${probe}`)
    if (probe === resolve(boundary) || probe === dirname(probe)) break
  }
}
export const projectsDirOf = sandbox => join(sandbox.artifactDir, '.runtime/agent-runner-projects')
// Exactly one Runner run may exist, and it must be the recorded one: a duplicate is never started or adopted.
export async function readRunnerRun({ sandbox, runDir, recordedId, workflowName }) {
  const root = projectsDirOf(sandbox)
  await privatePath(root, runDir)
  const states = await listRunnerStates(root)
  if (states.length > 1) throw new Error('multiple Agent Runner runs found; refusing to select or start a duplicate')
  if (recordedId && states.length && states[0].run_id !== recordedId) throw new Error('Agent Runner run identity mismatch')
  const state = await readRunnerState(root, recordedId)
  if (state && workflowName && state.workflow_name !== workflowName) throw new Error(`unexpected Agent Runner workflow ${state.workflow_name}`)
  return state
}
// A capped stop leaves the cap's step completed and the whole run not completed.
export function classifyRun(state, until) {
  if (until === 'define') return classifyDefineState(state)
  if (!state) return { kind: 'missing', step: null, reason: 'Agent Runner state.json is missing' }
  if (state.last_step === until && state.step_completed && !state.workflow_completed) return { kind: 'capped', step: until }
  const failedEnd = state.audit_summary?.last_run_end
  const step = state.last_step
  if (['failed', 'aborted', 'exhausted'].includes(failedEnd?.outcome) || state.failureReason) return { kind: 'failed', step, reason: failedEnd?.error ?? state.failureReason ?? `Agent Runner ${failedEnd?.outcome}` }
  if (state.workflow_completed) return { kind: 'failed', step, reason: `the workflow passed the ${until} cap` }
  return { kind: 'interrupted', step, reason: `Agent Runner workflow interrupted before ${until} completed` }
}
