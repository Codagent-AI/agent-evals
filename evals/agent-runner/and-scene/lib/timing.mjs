// Active machine timing.
//
// The ledger records *measured durations*, never start/end wall-clock stamps.
// That is the whole design: a duration cannot silently absorb the hours an eval
// sat stopped, or the days a result waited on a human reviewer. Time that was
// never measured is simply never recorded, so no subtraction step has to be
// trusted to remove it afterwards.
//
// Human review is not timed at all. Not recorded and reported as excluded —
// recorded, because a stored reviewer duration invites someone to add it to a
// "total" later, and the total is meant to describe machine work only.
import { AUTOMATED_PHASES } from './phases.mjs'

export const HUMAN_TIMED_PHASES = ['human-review', 'official-result']

// Derived from the lifecycle rather than written out separately. The controller
// records intervals under each phase's own name, so an independent vocabulary
// here would silently report finished work as unobserved while filing its
// duration under a name nothing ever emits. The spec's categories — install,
// build, verification, browser evaluation, judging, scoring, reporting — are
// covered by whichever lifecycle phase currently performs them.
export const AUTOMATED_TIMED_PHASES = [...new Set(
  AUTOMATED_PHASES
    .filter((phase) => phase.owner === 'evaluation-harness' && !HUMAN_TIMED_PHASES.includes(phase.name))
    .map((phase) => phase.name),
)]

export function createTimingLedger() {
  return { intervals: [] }
}

export function recordMachineInterval(ledger, { phase, duration_ms: durationMs, session = null }) {
  if (HUMAN_TIMED_PHASES.includes(phase)) {
    throw new Error(`${phase} is human-review time and is never recorded as machine duration`)
  }
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`interval for ${phase} has an unusable duration: ${JSON.stringify(durationMs)}`)
  }
  return { ...ledger, intervals: [...ledger.intervals, { phase, duration_ms: durationMs, session }] }
}

// Resume appends: a later session adds its own measured work to what earlier
// sessions already recorded, and the wall-clock gap between them exists in no
// interval so it can never reach a total.
export function mergeTimingLedgers(previous, next) {
  return { intervals: [...(previous?.intervals ?? []), ...(next?.intervals ?? [])] }
}

export function summarizeMachineTiming({ ledger, implementationMs = null }) {
  const byPhase = new Map()
  for (const interval of ledger?.intervals ?? []) {
    const entry = byPhase.get(interval.phase) ?? { phase: interval.phase, active_ms: 0, interval_count: 0 }
    entry.active_ms += interval.duration_ms
    entry.interval_count += 1
    byPhase.set(interval.phase, entry)
  }

  const phases = [...byPhase.values()]
  const automatedActive = phases.reduce((total, entry) => total + entry.active_ms, 0)
  const implementationAvailable = Number.isFinite(implementationMs)

  return {
    implementation: {
      state: implementationAvailable ? 'available' : 'unavailable',
      active_ms: implementationAvailable ? implementationMs : null,
    },
    phases,
    automated_phase_active_ms: automatedActive,
    // A total that silently omits the implementation workflow would understate
    // the run, so an unmeasured implementation leaves the total unavailable.
    total_active_machine_ms: implementationAvailable ? implementationMs + automatedActive : null,
    sessions: [...new Set((ledger?.intervals ?? []).map((interval) => interval.session).filter(Boolean))],
    // Named rather than zero: a phase that never ran has no duration, and a
    // reported 0 ms would read as work that happened instantly.
    unobserved_phases: AUTOMATED_TIMED_PHASES.filter((phase) => !byPhase.has(phase)),
    excludes_human_review: true,
    complete: implementationAvailable,
  }
}
