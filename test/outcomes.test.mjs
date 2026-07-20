import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EVALUATION_STATUSES,
  PRODUCT_VERDICTS,
  applyOutcomeEvent,
  createOutcome,
  outcomeLabel,
} from '../evals/agent-runner/and-scene/lib/outcomes.mjs'

const automatedComplete = { type: 'automated-scoring-complete', automated_subtotal: 58 }

function passing(outcome) {
  return applyOutcomeEvent(outcome, {
    type: 'product-verdict',
    verdict: 'pass',
    official_score: 84,
  })
}

test('the approved status and verdict vocabularies are exact', () => {
  assert.deepEqual(EVALUATION_STATUSES, [
    'complete',
    'pending-human-review',
    'implementation-workflow-failed',
    'evaluation-harness-failed',
  ])
  assert.deepEqual(PRODUCT_VERDICTS, ['pass', 'fail', 'unavailable'])
})

test('a new outcome is pending human review with no product verdict', () => {
  const outcome = createOutcome()

  assert.equal(outcome.evaluation_status, 'pending-human-review')
  assert.equal(outcome.product_verdict, 'unavailable')
  assert.equal(outcome.official_score, null)
  assert.deepEqual(outcome.history, [])
})

test('completed automated scoring records the subtotal without an official score', () => {
  const outcome = applyOutcomeEvent(createOutcome(), automatedComplete)

  assert.equal(outcome.evaluation_status, 'pending-human-review')
  assert.equal(outcome.product_verdict, 'unavailable')
  assert.equal(outcome.automated_subtotal, 58)
  assert.equal(outcome.official_score, null)
})

test('a complete pass records the official score and a pass verdict', () => {
  const outcome = passing(applyOutcomeEvent(createOutcome(), automatedComplete))

  assert.equal(outcome.evaluation_status, 'complete')
  assert.equal(outcome.product_verdict, 'pass')
  assert.equal(outcome.official_score, 84)
  assert.equal(outcome.verdict_durable, true)
})

test('a complete fail records the official score and a fail verdict', () => {
  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'product-verdict',
    verdict: 'fail',
    official_score: 41,
  })

  assert.equal(outcome.evaluation_status, 'complete')
  assert.equal(outcome.product_verdict, 'fail')
  assert.equal(outcome.official_score, 41)
})

test('a workflow failure leaves the product verdict unavailable', () => {
  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'workflow-failure',
    phase: 'agent-runner',
    reason: 'implementor exhausted attempts',
    step: 'implement-task',
    run_id: 'run-7',
    resumable: true,
  })

  assert.equal(outcome.evaluation_status, 'implementation-workflow-failed')
  assert.equal(outcome.product_verdict, 'unavailable')
  assert.equal(outcome.failed_phase, 'agent-runner')
  assert.equal(outcome.failure.step, 'implement-task')
  assert.equal(outcome.failure.run_id, 'run-7')
  assert.equal(outcome.resumable, true)
})

test('a recorded workflow failure is not reclassified as a harness failure', () => {
  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'workflow-failure',
    phase: 'agent-runner',
    reason: 'runner exited nonzero',
  })

  assert.equal(outcome.evaluation_status, 'implementation-workflow-failed')
  assert.equal(outcome.failure.owner, 'implementation-workflow')
})

test('a harness failure before a durable verdict leaves the verdict unavailable', () => {
  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'harness-failure',
    phase: 'browser-evaluation',
    reason: 'screenshot capture produced no evidence',
    resumable: true,
  })

  assert.equal(outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(outcome.product_verdict, 'unavailable')
  assert.equal(outcome.failure.owner, 'evaluation-harness')
})

test('a harness failure after a durable pass preserves the pass verdict', () => {
  const outcome = applyOutcomeEvent(passing(createOutcome()), {
    type: 'harness-failure',
    phase: 'cleanup',
    reason: 'candidate server did not stop',
  })

  assert.equal(outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(outcome.product_verdict, 'pass')
  assert.equal(outcome.official_score, 84)
})

test('a harness failure after a durable fail preserves the fail verdict', () => {
  const failed = applyOutcomeEvent(createOutcome(), {
    type: 'product-verdict',
    verdict: 'fail',
    official_score: 41,
  })

  const outcome = applyOutcomeEvent(failed, {
    type: 'harness-failure',
    phase: 'report',
    reason: 'report generation failed',
  })

  assert.equal(outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(outcome.product_verdict, 'fail')
  assert.equal(outcome.official_score, 41)
})

test('cleanup failure after a pending handoff stays pending human review', () => {
  const pending = applyOutcomeEvent(createOutcome(), automatedComplete)

  const outcome = applyOutcomeEvent(pending, {
    type: 'handoff-cleanup-failure',
    phase: 'cleanup',
    reason: 'candidate server did not stop',
  })

  assert.equal(outcome.evaluation_status, 'pending-human-review')
  assert.equal(outcome.product_verdict, 'unavailable')
  assert.equal(outcome.cleanup.error, 'candidate server did not stop')
  assert.equal(outcome.cleanup.completed, false)
})

test('a resumed workflow failure records the transition and clears the failure', () => {
  const failed = applyOutcomeEvent(createOutcome(), {
    type: 'workflow-failure',
    phase: 'agent-runner',
    reason: 'runner exited nonzero',
  })

  const outcome = applyOutcomeEvent(failed, { type: 'phase-recovered', phase: 'agent-runner' })

  assert.equal(outcome.evaluation_status, 'pending-human-review')
  assert.equal(outcome.failed_phase, null)
  assert.equal(outcome.failure, null)
  assert.deepEqual(
    outcome.history.map((entry) => entry.evaluation_status),
    ['pending-human-review', 'implementation-workflow-failed', 'pending-human-review'],
  )
})

test('recovering a harness failure after a durable verdict restores complete', () => {
  const failed = applyOutcomeEvent(passing(createOutcome()), {
    type: 'harness-failure',
    phase: 'cleanup',
    reason: 'candidate server did not stop',
  })

  const outcome = applyOutcomeEvent(failed, { type: 'phase-recovered', phase: 'cleanup' })

  assert.equal(outcome.evaluation_status, 'complete')
  assert.equal(outcome.product_verdict, 'pass')
})

test('an unrecoverable failure keeps the failed status and explains why', () => {
  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'harness-failure',
    phase: 'agent-runner',
    reason: 'checkpoint provenance cannot establish a safe resume point',
    resumable: false,
  })

  assert.equal(outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(outcome.resumable, false)
  assert.match(outcome.failure.reason, /safe resume point/)
})

test('every transition is retained in checkpoint history', () => {
  let outcome = createOutcome()
  outcome = applyOutcomeEvent(outcome, { type: 'workflow-failure', phase: 'agent-runner', reason: 'x' })
  outcome = applyOutcomeEvent(outcome, { type: 'phase-recovered', phase: 'agent-runner' })
  outcome = applyOutcomeEvent(outcome, automatedComplete)
  outcome = passing(outcome)

  assert.equal(outcome.history.length, 5)
  assert.deepEqual(outcome.history.map((entry) => entry.event), [
    'created',
    'workflow-failure',
    'phase-recovered',
    'automated-scoring-complete',
    'product-verdict',
  ])
})

test('applyOutcomeEvent does not mutate the previous outcome', () => {
  const before = createOutcome()

  applyOutcomeEvent(before, automatedComplete)

  assert.equal(before.automated_subtotal, null)
  assert.deepEqual(before.history, [])
})

test('a product verdict must be pass or fail', () => {
  assert.throws(
    () => applyOutcomeEvent(createOutcome(), { type: 'product-verdict', verdict: 'unavailable' }),
    /product verdict/i,
  )
})

test('an unknown event is rejected', () => {
  assert.throws(() => applyOutcomeEvent(createOutcome(), { type: 'nonsense' }), /unknown outcome event/i)
})

test('human-facing labels reflect verdict availability', () => {
  assert.equal(outcomeLabel(passing(createOutcome())), 'PASS')
  assert.equal(
    outcomeLabel(applyOutcomeEvent(createOutcome(), { type: 'product-verdict', verdict: 'fail', official_score: 12 })),
    'FAIL',
  )
  assert.equal(outcomeLabel(createOutcome()), 'PENDING HUMAN REVIEW')
  assert.equal(
    outcomeLabel(applyOutcomeEvent(createOutcome(), { type: 'workflow-failure', phase: 'agent-runner', reason: 'x' })),
    'EVALUATION FAILED',
  )
})

test('a harness failure beside a valid verdict is labelled with both', () => {
  const outcome = applyOutcomeEvent(passing(createOutcome()), {
    type: 'harness-failure',
    phase: 'cleanup',
    reason: 'x',
  })

  assert.equal(outcomeLabel(outcome), 'PASS — HARNESS FAILURE')
})
