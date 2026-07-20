// The evaluation outcome model.
//
// Execution status and product quality are deliberately independent: a failed
// workflow or harness never becomes a product failure, and a durably recorded
// product verdict survives any later harness failure.

export const EVALUATION_STATUSES = [
  'complete',
  'pending-human-review',
  'implementation-workflow-failed',
  'evaluation-harness-failed',
]

export const PRODUCT_VERDICTS = ['pass', 'fail', 'unavailable']

export const OUTCOME_SCHEMA_VERSION = 1

export function createOutcome() {
  return {
    schema_version: OUTCOME_SCHEMA_VERSION,
    evaluation_status: 'pending-human-review',
    product_verdict: 'unavailable',
    official_score: null,
    automated_subtotal: null,
    verdict_durable: false,
    failed_phase: null,
    failure: null,
    resumable: null,
    cleanup: null,
    history: [],
  }
}

function record(previous, next, event) {
  const history = [...previous.history]
  if (history.length === 0) {
    history.push({
      event: 'created',
      evaluation_status: previous.evaluation_status,
      product_verdict: previous.product_verdict,
    })
  }
  history.push({
    event,
    evaluation_status: next.evaluation_status,
    product_verdict: next.product_verdict,
    phase: next.failed_phase,
    reason: next.failure?.reason ?? null,
  })
  return { ...next, history }
}

// A run with no failure sits at `complete` once its verdict is durable and at
// `pending-human-review` until then.
function settledStatus(outcome) {
  return outcome.verdict_durable ? 'complete' : 'pending-human-review'
}

function failureEvent(previous, event, owner, status) {
  return record(
    previous,
    {
      ...previous,
      evaluation_status: status,
      // A durable verdict is computed from complete required scoring inputs and
      // is never erased by a later failure.
      product_verdict: previous.verdict_durable ? previous.product_verdict : 'unavailable',
      failed_phase: event.phase ?? null,
      resumable: event.resumable ?? null,
      failure: {
        owner,
        phase: event.phase ?? null,
        reason: event.reason ?? null,
        step: event.step ?? null,
        attempt: event.attempt ?? null,
        session: event.session ?? null,
        run_id: event.run_id ?? null,
      },
    },
    event.type,
  )
}

export function applyOutcomeEvent(outcome, event) {
  switch (event?.type) {
    case 'automated-scoring-complete':
      return record(
        outcome,
        {
          ...outcome,
          evaluation_status: settledStatus(outcome),
          automated_subtotal: event.automated_subtotal ?? null,
        },
        event.type,
      )

    case 'product-verdict': {
      if (event.verdict !== 'pass' && event.verdict !== 'fail') {
        throw new Error(`product verdict must be pass or fail, received ${event.verdict}`)
      }
      return record(
        outcome,
        {
          ...outcome,
          evaluation_status: 'complete',
          product_verdict: event.verdict,
          official_score: event.official_score ?? null,
          verdict_durable: true,
          failed_phase: null,
          failure: null,
          resumable: null,
        },
        event.type,
      )
    }

    case 'workflow-failure':
      return failureEvent(outcome, event, 'implementation-workflow', 'implementation-workflow-failed')

    case 'harness-failure':
      return failureEvent(outcome, event, 'evaluation-harness', 'evaluation-harness-failed')

    // Cleanup after a durably written pending handoff is diagnostic: the
    // command still exits successfully and the run stays reviewable.
    case 'handoff-cleanup-failure':
      return record(
        outcome,
        {
          ...outcome,
          evaluation_status: settledStatus(outcome),
          cleanup: { completed: false, phase: event.phase ?? null, error: event.reason ?? null },
        },
        event.type,
      )

    case 'cleanup-complete':
      return record(
        outcome,
        { ...outcome, cleanup: { completed: true, phase: event.phase ?? null, error: null } },
        event.type,
      )

    case 'phase-recovered':
      return record(
        outcome,
        {
          ...outcome,
          evaluation_status: settledStatus(outcome),
          failed_phase: null,
          failure: null,
          resumable: null,
        },
        event.type,
      )

    default:
      throw new Error(`unknown outcome event: ${event?.type}`)
  }
}

export function outcomeLabel(outcome) {
  const verdictAvailable = outcome.product_verdict === 'pass' || outcome.product_verdict === 'fail'
  const label = verdictAvailable ? outcome.product_verdict.toUpperCase() : null

  if (outcome.evaluation_status === 'evaluation-harness-failed' && label) {
    return `${label} — HARNESS FAILURE`
  }
  if (label) return label
  if (outcome.evaluation_status === 'pending-human-review') return 'PENDING HUMAN REVIEW'
  return 'EVALUATION FAILED'
}
