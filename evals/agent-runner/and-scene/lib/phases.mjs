// The ordered evaluation lifecycle.
//
// Phases run strictly in order; a phase that cannot produce its outputs stops
// its dependents rather than letting them run on fabricated or stale inputs.
// Outcome reporting and cleanup still run so every run ends with a recorded
// result.
import { applyOutcomeEvent } from './outcomes.mjs'

export const AUTOMATED_PHASES = [
  { name: 'preflight', owner: 'evaluation-harness', alwaysVerify: true },
  // Resume must consult Agent Runner's own persisted state and run lock before
  // acting, so this phase is never skipped on the strength of an eval-side
  // checkpoint. Re-verification is cheap and resolves to "continue" when the
  // recorded run already completed the full workflow.
  { name: 'agent-runner', owner: 'implementation-workflow', alwaysVerify: true },
  { name: 'delivery-verification', owner: 'implementation-workflow', alwaysVerify: true },
  { name: 'evidence-provenance', owner: 'evaluation-harness', alwaysVerify: true },
  { name: 'source-freeze', owner: 'evaluation-harness', alwaysVerify: true },
  { name: 'verification', owner: 'evaluation-harness' },
  // The candidate server is a process-local resource. A durable phase
  // checkpoint from an earlier process proves nothing about whether it is
  // running now, so it is always restarted or health-checked on resume.
  { name: 'candidate-server', owner: 'evaluation-harness', alwaysVerify: true },
  { name: 'browser-evaluation', owner: 'evaluation-harness', requiresServer: true },
  // The phase itself is revisited so each independently hashed judge unit can
  // be revalidated and reused or rerun on its own.
  { name: 'product-judging', owner: 'evaluation-harness', alwaysVerify: true },
  { name: 'ambiguity-diagnostics', owner: 'evaluation-harness' },
  { name: 'metrics-pricing', owner: 'evaluation-harness' },
  // Always rewritten: the result artifact renders the run as it now stands, so
  // reusing a checkpointed completion would leave `result.json` describing an
  // earlier session and silently omit everything a resume just computed.
  { name: 'pending-result', owner: 'evaluation-harness', final: true, alwaysVerify: true },
  // Cleanup after a durably written pending result is a handoff detail: it is
  // recorded diagnostically and the command still exits successfully.
  { name: 'cleanup', owner: 'evaluation-harness', final: true, cleanup: 'handoff' },
  { name: 'cleanup-result', owner: 'evaluation-harness', final: true, alwaysVerify: true },
]

export const HUMAN_REVIEW_PHASES = [
  { name: 'candidate-server', owner: 'evaluation-harness', alwaysVerify: true },
  { name: 'human-review', owner: 'evaluation-harness', requiresServer: true },
  { name: 'official-result', owner: 'evaluation-harness' },
  { name: 'final-report', owner: 'evaluation-harness' },
  // Finalization cleanup is required work: failing it is a harness failure.
  { name: 'cleanup', owner: 'evaluation-harness', final: true, cleanup: 'required' },
  { name: 'final-artifacts', owner: 'evaluation-harness', final: true },
  // Publication is delivery after evaluation. A failed commit or ordinary push
  // fails the command and remains retryable, but cannot rewrite the already
  // completed product result as a harness failure.
  { name: 'publication', owner: 'evaluation-harness', deliveryOnly: true },
]

function failureEventType(phase, error) {
  const owner = error?.owner ?? phase.owner
  return owner === 'implementation-workflow' ? 'workflow-failure' : 'harness-failure'
}

export async function runPhases({ phases, handlers, outcome, context = {}, isComplete = () => false }) {
  const state = { ...context }
  const completed = []
  const skipped = []
  const reused = []
  let current = outcome
  let failed = null
  // A resumed run may reuse the verification phase that originally established
  // a conclusive build/serve failure. The persisted product-failure evidence is
  // itself the terminal signal; it must not depend on the reused handler
  // emitting the event a second time.
  let productTerminal = outcome.product_failure != null

  for (const phase of phases) {
    if (failed && !phase.final) {
      skipped.push(phase.name)
      continue
    }
    if (
      productTerminal
      && !phase.final
      && phase.name !== 'metrics-pricing'
    ) {
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
        if (event.type === 'conclusive-product-failure') productTerminal = true
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
      if (phase.deliveryOnly) continue
      current = applyOutcomeEvent(current, {
        type: failureEventType(phase, error),
        phase: phase.name,
        reason: error.message,
        code: error.code ?? null,
        step: error.step ?? null,
        attempt: error.attempt ?? null,
        session: error.session ?? null,
        run_id: error.run_id ?? null,
        unexpected_action: error.unexpected_action ?? null,
        missing_delivery_output: error.missing_delivery_output ?? null,
        candidate_branch: error.candidate_branch ?? null,
        pull_request: error.pull_request ?? null,
        final_sha: error.final_sha ?? null,
        resumable: error.resumable ?? true,
      })
    }
  }

  return { outcome: current, completed, skipped, reused, failed, exitCode: failed ? 1 : 0 }
}
