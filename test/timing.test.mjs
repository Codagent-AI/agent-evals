import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AUTOMATED_PHASES } from '../evals/agent-runner/and-scene/lib/phases.mjs'
import {
  AUTOMATED_TIMED_PHASES,
  HUMAN_TIMED_PHASES,
  createTimingLedger,
  mergeTimingLedgers,
  recordMachineInterval,
  summarizeMachineTiming,
} from '../evals/agent-runner/and-scene/lib/timing.mjs'

function ledgerWith(intervals, session = 'session-1') {
  return intervals.reduce(
    (ledger, [phase, durationMs]) => recordMachineInterval(ledger, { phase, duration_ms: durationMs, session }),
    createTimingLedger(),
  )
}

test('uninterrupted execution reports implementation, phase, and total durations', () => {
  const ledger = ledgerWith([
    ['verification', 2000],
    ['browser-evaluation', 3000],
    ['product-judging', 5000],
  ])

  const summary = summarizeMachineTiming({ ledger, implementationMs: 60_000 })

  assert.equal(summary.implementation.active_ms, 60_000)
  assert.equal(summary.implementation.state, 'available')
  assert.deepEqual(
    summary.phases.map((entry) => [entry.phase, entry.active_ms]),
    [['verification', 2000], ['browser-evaluation', 3000], ['product-judging', 5000]],
  )
  assert.equal(summary.total_active_machine_ms, 70_000)
})

test('resumed sessions sum their active intervals and exclude the interruption gap', () => {
  const first = ledgerWith([['verification', 2000]], 'session-1')
  const second = ledgerWith([['verification', 1000], ['product-judging', 4000]], 'session-2')

  const summary = summarizeMachineTiming({
    ledger: mergeTimingLedgers(first, second),
    implementationMs: 10_000,
  })

  const verification = summary.phases.find((entry) => entry.phase === 'verification')
  assert.equal(verification.active_ms, 3000)
  assert.equal(verification.interval_count, 2)
  assert.deepEqual(summary.sessions, ['session-1', 'session-2'])
  assert.equal(summary.total_active_machine_ms, 17_000)
})

test('merging preserves prior intervals rather than replacing them', () => {
  const first = ledgerWith([['scoring', 500]], 'session-1')

  const merged = mergeTimingLedgers(first, createTimingLedger())

  assert.equal(merged.intervals.length, 1)
  assert.equal(merged.intervals[0].phase, 'scoring')
})

test('a human-review interval is refused rather than recorded', () => {
  assert.throws(
    () => recordMachineInterval(createTimingLedger(), { phase: 'human-review', duration_ms: 900_000 }),
    /human-review/,
  )
  assert.ok(HUMAN_TIMED_PHASES.includes('human-review'))
})

test('official result assembly is machine work, not excluded human time', () => {
  const ledger = recordMachineInterval(createTimingLedger(), {
    phase: 'official-result',
    duration_ms: 25,
  })

  assert.equal(HUMAN_TIMED_PHASES.includes('official-result'), false)
  assert.equal(ledger.intervals[0].phase, 'official-result')
})

test('pending human review contributes to no reported duration', () => {
  const ledger = ledgerWith([['product-judging', 5000]])

  const summary = summarizeMachineTiming({ ledger, implementationMs: 1000 })

  assert.equal(summary.total_active_machine_ms, 6000)
  assert.equal(summary.human_review_duration_ms, undefined)
  assert.equal(summary.excludes_human_review, true)
  assert.ok(summary.phases.every((entry) => !HUMAN_TIMED_PHASES.includes(entry.phase)))
})

test('an unmeasured implementation duration stays unavailable rather than zero', () => {
  const ledger = ledgerWith([['verification', 2000]])

  const summary = summarizeMachineTiming({ ledger, implementationMs: null })

  assert.equal(summary.implementation.active_ms, null)
  assert.equal(summary.implementation.state, 'unavailable')
  assert.equal(summary.total_active_machine_ms, null)
  assert.equal(summary.automated_phase_active_ms, 2000)
  assert.equal(summary.complete, false)
})

test('a negative or non-finite duration is refused', () => {
  assert.throws(() => recordMachineInterval(createTimingLedger(), { phase: 'scoring', duration_ms: -1 }), /duration/)
  assert.throws(() => recordMachineInterval(createTimingLedger(), { phase: 'scoring', duration_ms: null }), /duration/)
})

test('the timed phases are exactly the automated eval-owned lifecycle phases', () => {
  const expected = AUTOMATED_PHASES
    .filter((phase) => phase.owner === 'evaluation-harness' && !HUMAN_TIMED_PHASES.includes(phase.name))
    .map((phase) => phase.name)

  // Coverage is reported against the names the controller actually records. A
  // separate aspirational vocabulary would report real work as unobserved and
  // file its duration under a name nothing ever emits.
  assert.deepEqual([...AUTOMATED_TIMED_PHASES].sort(), [...new Set(expected)].sort())
})

test('every recordable phase name is one the coverage list knows', () => {
  for (const phase of AUTOMATED_PHASES) {
    if (phase.owner !== 'evaluation-harness' || HUMAN_TIMED_PHASES.includes(phase.name)) continue
    assert.ok(AUTOMATED_TIMED_PHASES.includes(phase.name), `${phase.name} is a timed automated phase`)
  }
})

test('phases that never ran are reported as unobserved, not as zero duration', () => {
  const ledger = ledgerWith([['verification', 2000]])

  const summary = summarizeMachineTiming({ ledger, implementationMs: 1000 })

  assert.ok(summary.unobserved_phases.includes('browser-evaluation'))
  assert.ok(!summary.phases.some((entry) => entry.phase === 'browser-evaluation'))
})
