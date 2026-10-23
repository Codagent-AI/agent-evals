import { effectiveDefineInvocations, ingestRunnerMetrics } from '../../and-scene-define/lib/runner-metrics.mjs'
// `prefix` is "define/sub:define-change/proposal"; a top-level step has an empty prefix and its own id.
export function topLevelStep(entry) {
  const first = String(entry.prefix ?? '').split('/')[0]
  return (first || entry.step || entry.id || '').replace(/^sub:/, '')
}
// Every evaluated invocation with the role the Runner recorded (lead, crosscheck, implementor, tester, ...).
export function effectiveInvocations(payload) {
  const invoked = (payload?.steps ?? []).filter(step => step.agent_invoked)
  return effectiveDefineInvocations(payload).map((invocation, index) => ({ ...invocation, role: invoked[index].role ?? invoked[index].target_name ?? invocation.role, phase: topLevelStep(invoked[index]) }))
}
export function invocationsThrough(invocations, stepOrder, last) {
  const limit = stepOrder.indexOf(last)
  return invocations.filter(invocation => { const index = stepOrder.indexOf(invocation.phase); return index >= 0 && index <= limit })
}
function summary(attempts, complete) {
  const invoked = attempts.filter(attempt => attempt.invoked_cli)
  const costComplete = complete && invoked.every(attempt => attempt.cost.state === 'available' && attempt.usage.state === 'available' && !Object.values(attempt.usage.completeness ?? {}).includes('partial'))
  const subtotal = invoked.reduce((total, attempt) => total + (attempt.cost.estimated_api_cost_usd ?? 0), 0)
  // A parent step's elapsed time already includes its call_agent children; child time is never added again.
  const timed = attempts.filter(attempt => attempt.kind !== 'agent-call' && attempt.agent_role !== 'crosscheck-child')
  const timeComplete = timed.length > 0 && timed.every(attempt => attempt.duration_ms !== null)
  return { attempts: attempts.map(attempt => attempt.attempt_id), duration_ms: timeComplete ? timed.reduce((total, attempt) => total + attempt.duration_ms, 0) : null,
    cost: { complete: costComplete, total_usd: costComplete ? subtotal : null, known_subtotal_usd: subtotal }, usage: invoked.map(attempt => ({ attempt_id: attempt.attempt_id, ...attempt.usage })) }
}
// Whole-run workflow metrics through `implement`, split by top-level step and role. The Runner's own
// completeness and provenance are kept; totals are never invented.
export function ingestWorkflowMetrics({ text, runId, workflow, path = null, stepOrder = ['define', 'implement'] }) {
  const metrics = ingestRunnerMetrics({ text, runId, workflow, path })
  if (metrics.state !== 'ingested') return { state: metrics.state, reason: metrics.reason ?? null, complete: false, by_step: {}, by_role: {}, total: null, source: metrics.source ?? null }
  const seen = new Set()
  // A resumed run can repeat an attempt record; each attempt counts once.
  const attempts = metrics.attempts.filter(attempt => !seen.has(attempt.attempt_id) && seen.add(attempt.attempt_id))
  const roles = [...new Set(attempts.map(attempt => attempt.agent_role).filter(Boolean))]
  const stages = Object.fromEntries(stepOrder.map(step => [step, summary(attempts.filter(attempt => topLevelStep(attempt) === step), metrics.complete)]))
  const total = summary(attempts.filter(attempt => stepOrder.includes(topLevelStep(attempt))), metrics.complete)
  return { state: 'ingested', complete: metrics.complete, history_complete: metrics.history_complete, source: metrics.source ?? null, active_duration_ms: metrics.active_duration_ms ?? null,
    by_step: stages, by_role: Object.fromEntries(roles.map(role => [role, summary(attempts.filter(attempt => attempt.agent_role === role), metrics.complete)])), total }
}
