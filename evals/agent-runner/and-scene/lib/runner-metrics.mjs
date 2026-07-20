// Ingestion of Agent Runner's `run-metrics.json`.
//
// Agent Runner owns measurement of its own implementation workflow. This module
// consumes the one artifact it publishes for that purpose and nothing else: an
// artifact that is missing, unreadable, versioned differently, or describing
// another run is *rejected*, never patched up from audit-log text, transcripts,
// or CLI output. Reconstructed metrics would look like measurements while being
// guesses, so implementation metrics stay explicitly incomplete instead.
//
// Missing usage and missing cost are preserved with their reasons. Nothing here
// substitutes zero for an unknown: a zero would be indistinguishable from a
// genuinely free attempt and would silently understate the reported total.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { hashString } from './persistence.mjs'

export const RUNNER_METRICS_FILENAME = 'run-metrics.json'
export const RUNNER_METRICS_SCHEMA_VERSION = 1

// States Agent Runner may report for a usage or cost value. `not-applicable`
// covers steps that never invoked a CLI, which is distinct from an agent
// attempt whose usage could not be measured.
const PRESENT = 'available'

function rejected(reason, source = null) {
  return {
    state: 'rejected',
    reason,
    complete: false,
    history_complete: null,
    active_duration_ms: null,
    source,
    attempts: [],
    attempt_count: 0,
    sessions: [],
    coverage: {
      usage_available: 0,
      usage_unavailable: 0,
      cost_available: 0,
      cost_unavailable: 0,
    },
  }
}

// Preserve the reported shape rather than normalizing it into a denser one: the
// artifact is evidence, and a reader comparing the result against Agent Runner's
// own output must see the same states, reasons, and token categories.
function normalizeMeasurement(value, field, attemptId) {
  if (value === null || value === undefined) {
    return { state: 'unavailable', reason: `agent runner reported no ${field}`, tokens: null }
  }
  if (typeof value !== 'object') {
    throw new Error(`attempt ${attemptId} has a malformed ${field}`)
  }
  return value
}

function normalizeAttempt(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`attempt ${index} is not an object`)
  }
  const attemptId = typeof raw.attempt_id === 'string' && raw.attempt_id.length > 0
    ? raw.attempt_id
    : `attempt-${index}`
  const invokedCli = raw.invoked_cli === true

  // Only CLI attempts are priced and aggregated, so only they must carry the
  // provider/model identity that aggregation keys on. Demanding it of shell
  // steps would reject a well-formed artifact.
  if (invokedCli) {
    for (const field of ['provider', 'model']) {
      if (typeof raw[field] !== 'string' || raw[field].length === 0) {
        throw new Error(`attempt ${attemptId} invoked a CLI without a ${field}`)
      }
    }
  }

  const usage = normalizeMeasurement(raw.usage, 'usage', attemptId)
  const cost = normalizeMeasurement(raw.cost, 'cost', attemptId)

  return {
    attempt_id: attemptId,
    step: raw.step ?? null,
    agent_role: raw.agent_role ?? null,
    invoked_cli: invokedCli,
    cli: raw.cli ?? null,
    provider: raw.provider ?? null,
    model: raw.model ?? null,
    usage_source: raw.usage_source ?? null,
    usage_source_version: raw.usage_source_version ?? null,
    session: raw.session ?? null,
    duration_ms: Number.isFinite(raw.duration_ms) ? raw.duration_ms : null,
    usage: {
      state: usage.state ?? 'unavailable',
      reason: usage.reason ?? null,
      // `tokens` stays exactly as reported. An absent category is absent, not
      // zero, so a later calculation can tell "no cached input" from "cached
      // input was never measured".
      tokens: usage.tokens ?? null,
    },
    cost: {
      state: cost.state ?? 'unavailable',
      reason: cost.reason ?? null,
      estimated_api_cost_usd: cost.estimated_api_cost_usd ?? null,
    },
  }
}

// Attempt ids are the key every downstream cost resolution is looked up by. Two
// attempts sharing one id would share one resolution, and that resolution would
// then be counted once per duplicate — a silently wrong total that looks
// perfectly well-formed. The artifact is rejected instead.
function assertUniqueAttemptIds(attempts) {
  const seen = new Set()
  for (const attempt of attempts) {
    if (seen.has(attempt.attempt_id)) {
      throw new Error(`duplicate attempt id ${attempt.attempt_id}`)
    }
    seen.add(attempt.attempt_id)
  }
}

export function ingestRunnerMetrics({ text, runId, workflow, path = null }) {
  const source = {
    path,
    sha256: hashString(text ?? ''),
    schema_version: null,
    // The verbatim artifact is kept so the result carries the evidence it was
    // derived from, not just a summary of it.
    text: text ?? null,
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    return rejected(`run-metrics.json is not readable JSON: ${error.message}`, source)
  }

  if (payload?.schema_version !== RUNNER_METRICS_SCHEMA_VERSION) {
    return rejected(
      `unsupported run-metrics.json schema version ${JSON.stringify(payload?.schema_version)}`,
      source,
    )
  }
  source.schema_version = payload.schema_version

  if (payload.run_id !== runId) {
    return rejected(
      `run-metrics.json names run ${JSON.stringify(payload.run_id)}, not the recorded run ${runId}`,
      source,
    )
  }
  if (payload.workflow !== workflow) {
    return rejected(
      `run-metrics.json names workflow ${JSON.stringify(payload.workflow)}, not ${workflow}`,
      source,
    )
  }
  if (!Array.isArray(payload.attempts)) {
    return rejected('run-metrics.json has no attempts array', source)
  }

  let attempts
  try {
    attempts = payload.attempts.map(normalizeAttempt)
    assertUniqueAttemptIds(attempts)
  } catch (error) {
    return rejected(`run-metrics.json is malformed: ${error.message}`, source)
  }

  const coverage = {
    usage_available: attempts.filter((entry) => entry.usage.state === PRESENT).length,
    usage_unavailable: attempts.filter((entry) => entry.usage.state === 'unavailable').length,
    cost_available: attempts.filter((entry) => entry.cost.state === PRESENT).length,
    cost_unavailable: attempts.filter((entry) => entry.cost.state === 'unavailable').length,
  }

  const historyComplete = payload.history_complete === true

  return {
    state: 'ingested',
    reason: null,
    // Completeness is Agent Runner's own claim about its history. The harness
    // reports it rather than inferring one from the attempts it happened to see.
    complete: historyComplete,
    history_complete: payload.history_complete ?? null,
    // Agent Runner's own measure of how long its workflow was actively running.
    // Absent means unmeasured, never instant.
    active_duration_ms: Number.isFinite(payload.active_duration_ms) ? payload.active_duration_ms : null,
    source,
    attempts,
    attempt_count: attempts.length,
    sessions: [...new Set(attempts.map((entry) => entry.session).filter((value) => value !== null))],
    coverage,
  }
}

export async function readRunnerMetrics({ sessionDir, runId, workflow }) {
  if (!sessionDir) {
    return rejected('no Agent Runner session directory was recorded for this run')
  }
  const path = join(sessionDir, RUNNER_METRICS_FILENAME)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return rejected(`run-metrics.json not found at ${path}: ${error.message}`, {
      path,
      sha256: null,
      schema_version: null,
      text: null,
    })
  }
  return ingestRunnerMetrics({ text, runId, workflow, path })
}
