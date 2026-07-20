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

const IMPLEMENTOR_STEPS = new Set(['generate-code', 'commit-leftovers-if-needed', 'session-report', 'fix-violations'])

function agentRole(raw) {
  if (!raw.agent_invoked) return null
  return IMPLEMENTOR_STEPS.has(raw.id) ? 'task-implementor' : 'lead-agent'
}

// Agent Runner preserves category details and separately provides canonical
// input/output totals. Cache and reasoning categories overlap those totals, so
// pricing the raw map directly would double-charge them. Keep the raw evidence
// and derive a non-overlapping billing map only when canonical totals exist.
function billingTokens(usage) {
  const totals = usage?.token_totals
  if (!totals || !Number.isFinite(totals.input) || !Number.isFinite(totals.output)) return null
  const cached = Number.isFinite(usage.tokens?.cached_input) ? usage.tokens.cached_input : 0
  const written = Number.isFinite(usage.tokens?.cache_write) ? usage.tokens.cache_write : 0
  const ordinary = totals.input - cached - written
  if (ordinary < 0 || totals.output < 0) return null
  return Object.fromEntries(Object.entries({
    input: ordinary,
    cached_input: cached,
    cache_write: written,
    output: totals.output,
  }).filter(([, count]) => count > 0))
}

function normalizeAttempt(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`attempt ${index} is not an object`)
  }
  const attemptId = typeof raw.attempt_id === 'string' && raw.attempt_id.length > 0
    ? raw.attempt_id
    : (typeof raw.record_id === 'string' && raw.record_id.length > 0 ? raw.record_id : `attempt-${index}`)
  const invokedCli = raw.agent_invoked === true
  if (raw.usage !== null && raw.usage !== undefined && typeof raw.usage !== 'object') {
    throw new Error(`attempt ${attemptId} has malformed usage`)
  }
  const rawUsage = raw.usage ?? null
  const usageState = rawUsage?.status === 'collected'
    ? PRESENT
    : (rawUsage?.status === 'unavailable' ? 'unavailable' : (invokedCli ? 'unavailable' : 'not-applicable'))
  const reportedCost = Number.isFinite(raw.estimated_api_cost_usd) && raw.estimated_api_cost_usd >= 0

  return {
    attempt_id: attemptId,
    step: raw.id ?? raw.step ?? null,
    prefix: raw.prefix ?? null,
    agent_role: raw.agent_role ?? agentRole(raw),
    invoked_cli: invokedCli,
    cli: rawUsage?.cli ?? raw.cli ?? null,
    provider: rawUsage?.provider ?? raw.provider ?? null,
    model: rawUsage?.model ?? raw.model ?? null,
    usage_source: rawUsage?.source ?? raw.usage_source ?? null,
    usage_source_version: null,
    session: raw.session_id ?? raw.session ?? null,
    duration_ms: Number.isFinite(raw.duration_ms) ? raw.duration_ms : null,
    usage: {
      state: usageState,
      reason: rawUsage?.reason ?? (invokedCli && !rawUsage ? 'agent runner reported no usage' : null),
      tokens: rawUsage?.tokens ?? null,
      token_totals: rawUsage?.token_totals ?? null,
      billing_tokens: usageState === PRESENT ? billingTokens(rawUsage) : null,
      completeness: rawUsage?.completeness ?? null,
    },
    cost: {
      state: reportedCost ? PRESENT : (invokedCli ? 'unavailable' : 'not-applicable'),
      reason: reportedCost ? null : (invokedCli ? 'agent runner reported no cost' : null),
      estimated_api_cost_usd: reportedCost ? raw.estimated_api_cost_usd : null,
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
  if (!Array.isArray(payload.steps)) {
    return rejected('run-metrics.json has no steps array', source)
  }

  let attempts
  try {
    attempts = payload.steps.map(normalizeAttempt)
    assertUniqueAttemptIds(attempts)
  } catch (error) {
    return rejected(`run-metrics.json is malformed: ${error.message}`, source)
  }

  const cliAttempts = attempts.filter((entry) => entry.invoked_cli)
  const coverage = {
    usage_available: cliAttempts.filter((entry) => entry.usage.state === PRESENT).length,
    usage_unavailable: cliAttempts.filter((entry) => entry.usage.state === 'unavailable').length,
    cost_available: cliAttempts.filter((entry) => entry.cost.state === PRESENT).length,
    cost_unavailable: cliAttempts.filter((entry) => entry.cost.state === 'unavailable').length,
    effective_profile_incomplete: cliAttempts.filter((entry) => !entry.cli || !entry.provider || !entry.model).length,
    reported: {
      usage: payload.totals?.usage_coverage ?? null,
      token_totals: payload.totals?.token_total_coverage ?? null,
      cost: payload.totals?.cost_coverage ?? null,
    },
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
    active_duration_ms: Number.isFinite(payload.totals?.active_duration_ms)
      ? payload.totals.active_duration_ms
      : null,
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
