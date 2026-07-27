import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AUTOMATED_PHASES,
  HUMAN_REVIEW_PHASES,
  runPhases,
} from '../evals/agent-runner/and-scene/lib/phases.mjs'
import {
  applyOutcomeEvent,
  createOutcome,
} from '../evals/agent-runner/and-scene/lib/outcomes.mjs'

// Handlers that simply record the order they ran in, with optional failures.
function handlers(phases, { fails = {}, effects = {} } = {}) {
  const order = []
  const map = {}
  for (const phase of phases) {
    map[phase.name] = async (context) => {
      order.push(phase.name)
      effects[phase.name]?.(context)
      if (fails[phase.name]) throw new Error(fails[phase.name])
    }
  }
  return { order, map }
}

const serverUp = { 'candidate-server': (context) => { context.serverRunning = true } }

test('the automated lifecycle runs in the approved order', () => {
  assert.deepEqual(AUTOMATED_PHASES.map((phase) => phase.name), [
    'preflight',
    'agent-runner',
    'delivery-verification',
    'evidence-provenance',
    'source-freeze',
    'verification',
    'candidate-server',
    'browser-evaluation',
    'product-judging',
    'ambiguity-diagnostics',
    'metrics-pricing',
    'pending-result',
    'cleanup',
    'cleanup-result',
  ])
})

test('the human-review lifecycle runs in the approved order', () => {
  assert.deepEqual(HUMAN_REVIEW_PHASES.map((phase) => phase.name), [
    'candidate-server',
    'human-review',
    'official-result',
    'final-report',
    'cleanup',
    'final-artifacts',
    'publication',
  ])
})

test('Agent Runner failures are owned by the implementation workflow', () => {
  const runner = AUTOMATED_PHASES.find((phase) => phase.name === 'agent-runner')

  assert.equal(runner.owner, 'implementation-workflow')
  assert.equal(AUTOMATED_PHASES.find((phase) => phase.name === 'delivery-verification').owner, 'implementation-workflow')
  assert.ok(AUTOMATED_PHASES.filter((phase) => !['agent-runner', 'delivery-verification'].includes(phase.name))
    .every((phase) => phase.owner === 'evaluation-harness'))
})

test('typed missing evidence in evaluator intake remains an implementation-workflow failure', async () => {
  const { map } = handlers(AUTOMATED_PHASES, { effects: serverUp })
  map['evidence-provenance'] = async () => {
    throw Object.assign(new Error('required candidate evidence is missing'), {
      owner: 'implementation-workflow',
      code: 'missing-evidence-role',
    })
  }

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: map,
    outcome: createOutcome(),
  })

  assert.equal(result.outcome.evaluation_status, 'implementation-workflow-failed')
  assert.equal(result.outcome.failure.code, 'missing-evidence-role')
})

test('every browser-dependent phase requires the candidate server', () => {
  const required = AUTOMATED_PHASES.filter((phase) => phase.requiresServer).map((phase) => phase.name)

  assert.deepEqual(required, ['browser-evaluation'])
})

test('a fully successful automated run completes every phase and exits successfully', async () => {
  const { order, map } = handlers(AUTOMATED_PHASES, { effects: serverUp })

  const result = await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: createOutcome() })

  assert.deepEqual(order, AUTOMATED_PHASES.map((phase) => phase.name))
  assert.deepEqual(result.skipped, [])
  assert.equal(result.failed, null)
  assert.equal(result.outcome.evaluation_status, 'pending-human-review')
  assert.equal(result.exitCode, 0)
})

test('each phase begins only after its predecessor completed', async () => {
  const started = []
  const map = Object.fromEntries(AUTOMATED_PHASES.map((phase, index) => [phase.name, async (context) => {
    if (phase.name === 'candidate-server') context.serverRunning = true
    assert.equal(started.length, index, `${phase.name} started out of order`)
    started.push(phase.name)
  }]))

  await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: createOutcome() })

  assert.equal(started.length, AUTOMATED_PHASES.length)
})

test('dependent phases do not run after an earlier phase cannot complete', async () => {
  const { order, map } = handlers(AUTOMATED_PHASES, {
    effects: serverUp,
    fails: { verification: 'build failed' },
  })

  const result = await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: createOutcome() })

  assert.equal(result.failed, 'verification')
  assert.ok(!order.includes('browser-evaluation'))
  assert.ok(!order.includes('product-judging'))
  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
})

test('a conclusive product failure skips browser, judging, and human-dependent work but reports successfully', async () => {
  const { order, map } = handlers(AUTOMATED_PHASES, { effects: serverUp })
  map.verification = async () => {
    order.push('verification')
    return [{
      type: 'conclusive-product-failure',
      phase: 'verification',
      reason: 'candidate build failed reproducibly',
      gate: 'build-succeeds',
    }]
  }

  const result = await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: createOutcome() })

  assert.equal(result.exitCode, 0)
  assert.equal(result.outcome.evaluation_status, 'complete')
  assert.equal(result.outcome.product_verdict, 'fail')
  assert.ok(!order.includes('browser-evaluation'))
  assert.ok(!order.includes('product-judging'))
  assert.ok(order.includes('metrics-pricing'))
  assert.ok(order.includes('pending-result'))
  assert.ok(order.includes('cleanup'))
})

test('a resumed conclusive product failure remains terminal when verification is reused', async () => {
  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'conclusive-product-failure',
    phase: 'verification',
    reason: 'candidate build failed reproducibly',
    gate: 'build-succeeds',
  })
  const { order, map } = handlers(AUTOMATED_PHASES, { effects: serverUp })

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: map,
    outcome,
    isComplete: (name) => name === 'verification',
  })

  assert.equal(result.outcome.product_verdict, 'fail')
  assert.ok(!order.includes('candidate-server'))
  assert.ok(!order.includes('browser-evaluation'))
  assert.ok(!order.includes('product-judging'))
  assert.ok(order.includes('metrics-pricing'))
  assert.ok(order.includes('pending-result'))
})

test('a partially migrated outcome without product_failure remains non-terminal', async () => {
  const outcome = createOutcome()
  delete outcome.product_failure
  const { order, map } = handlers(AUTOMATED_PHASES, { effects: serverUp })

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: map,
    outcome,
  })

  assert.equal(result.exitCode, 0)
  assert.ok(order.includes('verification'))
  assert.ok(order.includes('candidate-server'))
  assert.ok(order.includes('browser-evaluation'))
  assert.ok(order.includes('product-judging'))
})

test('outcome reporting and cleanup still run after an earlier phase fails', async () => {
  const { order, map } = handlers(AUTOMATED_PHASES, {
    effects: serverUp,
    fails: { 'browser-evaluation': 'no evidence' },
  })

  const result = await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: createOutcome() })

  assert.ok(order.includes('pending-result'), order.join(','))
  assert.ok(order.includes('cleanup'), order.join(','))
  assert.ok(result.skipped.includes('product-judging'))
  assert.equal(result.exitCode, 1)
})

test('an Agent Runner failure is classified as an implementation-workflow failure', async () => {
  const { map } = handlers(AUTOMATED_PHASES, {
    effects: serverUp,
    fails: { 'agent-runner': 'runner exited nonzero' },
  })

  const result = await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: createOutcome() })

  assert.equal(result.outcome.evaluation_status, 'implementation-workflow-failed')
  assert.equal(result.outcome.product_verdict, 'unavailable')
})

test('a non-resumable delivery violation remains non-resumable in the outcome', async () => {
  const { map } = handlers(AUTOMATED_PHASES, { effects: serverUp })
  map['delivery-verification'] = async () => {
    const error = new Error('workflow-side-effect-violation: pull request was merged')
    error.resumable = false
    throw error
  }

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: map,
    outcome: createOutcome(),
  })

  assert.equal(result.outcome.evaluation_status, 'implementation-workflow-failed')
  assert.equal(result.outcome.resumable, false)
})

test('a browser phase without a running candidate server is a harness failure', async () => {
  const { order, map } = handlers(AUTOMATED_PHASES)

  const result = await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: createOutcome() })

  assert.equal(result.failed, 'browser-evaluation')
  assert.ok(!order.includes('browser-evaluation'))
  assert.match(result.outcome.failure.reason, /candidate server/i)
  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
})

test('completed phases are skipped on resume without rerunning their work', async () => {
  const { order, map } = handlers(AUTOMATED_PHASES, { effects: serverUp })

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: map,
    outcome: createOutcome(),
    isComplete: (name) => ['verification', 'product-judging'].includes(name),
  })

  assert.ok(!order.includes('verification'))
  assert.ok(!order.includes('product-judging'))
  assert.deepEqual(result.reused, ['verification', 'product-judging'])
  assert.equal(result.failed, null)
})

test('result-writing phases always rerun so a resumed result is never stale', () => {
  for (const name of ['pending-result', 'cleanup-result']) {
    const phase = AUTOMATED_PHASES.find((entry) => entry.name === name)
    // These phases render whatever the run now knows. Reusing a checkpoint would
    // leave result.json describing an earlier session's state.
    assert.equal(phase.alwaysVerify, true, name)
  }
})

test('the candidate server is restarted on resume rather than reused from a checkpoint', async () => {
  // The server is a process-local resource: a durable phase checkpoint from an
  // earlier process says nothing about whether it is running now.
  const { order, map } = handlers(AUTOMATED_PHASES, { effects: serverUp })

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: map,
    outcome: createOutcome(),
    isComplete: (name) => ['candidate-server'].includes(name),
  })

  assert.ok(order.includes('candidate-server'), order.join(','))
  assert.ok(!result.reused.includes('candidate-server'))
  assert.equal(result.failed, null)
  assert.ok(order.includes('browser-evaluation'), order.join(','))
})

test('the Agent Runner phase always re-verifies rather than trusting a checkpoint', async () => {
  const { order, map } = handlers(AUTOMATED_PHASES, { effects: serverUp })

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: map,
    outcome: createOutcome(),
    isComplete: () => true,
  })

  // Resume must consult Agent Runner's own state before acting, so its phase is
  // never short-circuited by an eval-side checkpoint. Delivery evidence is
  // re-ingested against that identity, the candidate server is likewise always
  // re-verified, and result artifacts are rewritten for this session.
  assert.deepEqual(order, [
    'preflight',
    'agent-runner',
    'delivery-verification',
    'evidence-provenance',
    'source-freeze',
    'candidate-server',
    'pending-result',
    'cleanup-result',
  ])
  assert.ok(!result.reused.includes('agent-runner'))
  assert.ok(result.reused.includes('product-judging'))
})

test('cleanup failure after a durable pending result keeps a successful exit', async () => {
  const { map } = handlers(AUTOMATED_PHASES, {
    effects: serverUp,
    fails: { cleanup: 'candidate server did not stop' },
  })

  const result = await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: createOutcome() })

  assert.equal(result.outcome.evaluation_status, 'pending-human-review')
  assert.equal(result.outcome.cleanup.completed, false)
  assert.equal(result.exitCode, 0)
})

test('finalization cleanup failure during human review is a harness failure', async () => {
  const { map } = handlers(HUMAN_REVIEW_PHASES, {
    effects: serverUp,
    fails: { cleanup: 'candidate server did not stop' },
  })

  const result = await runPhases({ phases: HUMAN_REVIEW_PHASES, handlers: map, outcome: createOutcome() })

  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.exitCode, 1)
})

test('a missing handler is a programming error, not a silent skip', async () => {
  await assert.rejects(
    () => runPhases({ phases: AUTOMATED_PHASES, handlers: {}, outcome: createOutcome() }),
    /no handler/i,
  )
})

test('a resumed phase records its recovery transition', async () => {
  const { map } = handlers(AUTOMATED_PHASES, { effects: serverUp })
  const failed = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: handlers(AUTOMATED_PHASES, { effects: serverUp, fails: { 'agent-runner': 'boom' } }).map,
    outcome: createOutcome(),
  })

  const resumed = await runPhases({ phases: AUTOMATED_PHASES, handlers: map, outcome: failed.outcome })

  assert.equal(resumed.outcome.evaluation_status, 'pending-human-review')
  assert.equal(resumed.outcome.failed_phase, null)
  assert.ok(resumed.outcome.history.some((entry) => entry.event === 'phase-recovered'))
})
