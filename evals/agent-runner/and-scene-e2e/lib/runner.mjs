import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { listRunnerStates, readRunnerState, classifyDefineState } from '../../../lib/define-run/runner-state.mjs'
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
  // Only the last invocation counts: an earlier failed attempt may have recovered.
  const invocation = state.audit_summary?.invocation_text
  const current = invocation ? (state.history ?? []).filter(event => invocation.includes(event.at)) : state.history ?? []
  const failedEvent = current.filter(event => event.event === 'step_end' && ['failed', 'aborted', 'exhausted'].includes(event.outcome)).sort((a, b) => b.step_path.length - a.step_path.length)[0]
  if (failedEvent || ['failed', 'aborted', 'exhausted'].includes(failedEnd?.outcome) || state.failureReason) return { kind: 'failed', step: failedEvent?.step_path.filter(part => !part.startsWith('sub:')).join('.') ?? step, reason: failedEvent?.error ?? failedEnd?.error ?? state.failureReason ?? `Agent Runner ${failedEnd?.outcome}` }
  if (state.workflow_completed) return { kind: 'failed', step, reason: `the workflow passed the ${until} cap` }
  return { kind: 'interrupted', step, reason: `Agent Runner workflow interrupted before ${until} completed` }
}
