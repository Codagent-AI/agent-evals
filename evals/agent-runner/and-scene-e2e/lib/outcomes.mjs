export const EVALUATION_STATUSES = ['complete', 'pending-human-review', 'definition-workflow-failed', 'implementation-workflow-failed', 'contaminated', 'evaluation-harness-failed']
// A workflow failure belongs to the stage that was running; anything else is a harness failure.
export function failureOutcome({ phase, reason, workflow = false, defineCompleted = false, resumable = false, step = null, limit = null, window = null, prohibited = [], leaked = null, definition_scored = undefined }) {
  return {
    evaluation_status: workflow ? (defineCompleted ? 'implementation-workflow-failed' : 'definition-workflow-failed') : 'evaluation-harness-failed',
    owning_phase: phase, observed_error: reason, resumable, last_active_step: step,
    ...(limit ? { time_limit_ms: limit } : {}), ...(window ? { stall_window_ms: window } : {}),
    ...(prohibited.length ? { prohibited_effects: prohibited } : {}), ...(leaked ? { leaked_items: leaked } : {}), ...(definition_scored === undefined ? {} : { definition_scored }),
  }
}
export const SCORED_STATUSES = ['complete', 'pending-human-review']
export function publicationEligibility(result) {
  return result?.evaluation_status === 'complete' && !result.dry_run && !result.rescore
}
