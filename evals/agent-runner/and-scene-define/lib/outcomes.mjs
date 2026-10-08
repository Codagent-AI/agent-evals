export const EVALUATION_STATUSES = ['complete', 'definition-workflow-failed', 'contaminated', 'evaluation-harness-failed']
export function failureOutcome({ phase, reason, workflow = false, resumable = false, step = null, timeLimitMs = null }) {
  return { evaluation_status: workflow ? 'definition-workflow-failed' : 'evaluation-harness-failed', owning_phase: phase, observed_error: reason, resumable, last_active_step: step, time_limit_ms: timeLimitMs }
}
