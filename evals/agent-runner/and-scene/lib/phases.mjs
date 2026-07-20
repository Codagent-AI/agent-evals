// The ordered evaluation lifecycle.
//
// Phases run strictly in order; a phase that cannot produce its outputs stops
// its dependents rather than letting them run on fabricated or stale inputs.
// Outcome reporting and cleanup still run so every run ends with a recorded
// result.
import { applyOutcomeEvent } from './outcomes.mjs'

export const AUTOMATED_PHASES = [
  // Resume must consult Agent Runner's own persisted state and run lock before
  // acting, so this phase is never skipped on the strength of an eval-side
  // checkpoint. Re-verification is cheap and resolves to "continue" when the
  // recorded run already reached its boundary.
  { name: 'agent-runner', owner: 'implementation-workflow', alwaysVerify: true },
  { name: 'verification', owner: 'evaluation-harness' },
  // The candidate server is a process-local resource. A durable phase
  // checkpoint from an earlier process proves nothing about whether it is
  // running now, so it is always restarted or health-checked on resume.
  { name: 'candidate-server', owner: 'evaluation-harness', alwaysVerify: true },
  { name: 'browser-evaluation', owner: 'evaluation-harness', requiresServer: true },
  { name: 'product-judging', owner: 'evaluation-harness' },
  { name: 'ambiguity-diagnostics', owner: 'evaluation-harness' },
  { name: 'metrics-pricing', owner: 'evaluation-harness' },
  { name: 'pending-result', owner: 'evaluation-harness', final: true },
  // Cleanup after a durably written pending result is a handoff detail: it is
  // recorded diagnostically and the command still exits successfully.
  { name: 'cleanup', owner: 'evaluation-harness', final: true, cleanup: 'handoff' },
  { name: 'cleanup-result', owner: 'evaluation-harness', final: true },
]

export const HUMAN_REVIEW_PHASES = [
  { name: 'candidate-server', owner: 'evaluation-harness', alwaysVerify: true },
  { name: 'human-review', owner: 'evaluation-harness', requiresServer: true },
  { name: 'official-result', owner: 'evaluation-harness' },
  { name: 'final-report', owner: 'evaluation-harness' },
  // Finalization cleanup is required work: failing it is a harness failure.
  { name: 'cleanup', owner: 'evaluation-harness', final: true, cleanup: 'required' },
  { name: 'final-artifacts', owner: 'evaluation-harness', final: true },
  { name: 'publication', owner: 'evaluation-harness' },
]

function failureEventType(phase) {
  return phase.owner === 'implementation-workflow' ? 'workflow-failure' : 'harness-failure'
}

export async function runPhases({ phases, handlers, outcome, context = {}, isComplete = () => false }) {
  const state = { ...context }
  const completed = []
  const skipped = []
  const reused = []
  let current = outcome
  let failed = null

  for (const phase of phases) {
    if (failed && !phase.final) {
      skipped.push(phase.name)
      continue
    }
    if (!phase.alwaysVerify && isComplete(phase.name)) {
      reused.push(phase.name)
      continue
    }

    const handler = handlers[phase.name]
    if (!handler) throw new Error(`no handler registered for phase ${phase.name}`)

    // The candidate server must be running before every browser-dependent
    // phase; running one without it would produce unusable evidence.
    if (phase.requiresServer && !state.serverRunning) {
      failed = phase.name
      current = applyOutcomeEvent(current, {
        type: 'harness-failure',
        phase: phase.name,
        reason: 'candidate server is not running',
        resumable: true,
      })
      skipped.push(phase.name)
      continue
    }

    try {
      // Result-writing phases render the outcome as it stands when they run.
      state.outcome = current
      // A phase that establishes an outcome fact — a scored subtotal, a product
      // verdict — returns it as events rather than mutating the outcome, so the
      // lifecycle stays the single place the outcome is advanced.
      for (const event of (await handler(state)) ?? []) {
        current = applyOutcomeEvent(current, event)
      }
      completed.push(phase.name)
      if (current.failed_phase === phase.name) {
        current = applyOutcomeEvent(current, { type: 'phase-recovered', phase: phase.name })
      }
      if (phase.cleanup) {
        current = applyOutcomeEvent(current, { type: 'cleanup-complete', phase: phase.name })
      }
    } catch (error) {
      if (phase.cleanup === 'handoff') {
        current = applyOutcomeEvent(current, {
          type: 'handoff-cleanup-failure',
          phase: phase.name,
          reason: error.message,
        })
        continue
      }
      failed = phase.name
      current = applyOutcomeEvent(current, {
        type: failureEventType(phase),
        phase: phase.name,
        reason: error.message,
        resumable: true,
      })
    }
  }

  return { outcome: current, completed, skipped, reused, failed, exitCode: failed ? 1 : 0 }
}
