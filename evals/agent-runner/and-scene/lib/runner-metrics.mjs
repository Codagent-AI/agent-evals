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
export const RUNNER_METRICS_SCHEMA_VERSION = 4
export const SUPPORTED_RUNNER_METRICS_SCHEMA_VERSIONS = [1, 2, 3, RUNNER_METRICS_SCHEMA_VERSION]
export const RUNNER_MEASUREMENT_SCHEMA_VERSION = 1
export const RUNNER_MEASUREMENT_AGGREGATE_VERSION = 1

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
    measurement_history_complete: null,
    active_duration_ms: null,
    source,
    attempts: [],
    attempt_count: 0,
    dispatch_count: 0,
    invocations: [],
    sessions: [],
    coverage: {
      usage_available: 0,
      usage_unavailable: 0,
      cost_available: 0,
      cost_unavailable: 0,
    },
  }
}

const V4_KEYS = [
  'native_measurements', 'measurement_heads', 'validator_contexts', 'measurement_totals',
  'aggregate_version', 'schema_version', 'run_id', 'workflow', 'history_complete', 'sessions',
  'steps', 'session_rollups', 'repository_changes', 'totals', 'validator_delivery',
]
const ATTRIBUTION_KEYS = [
  'run_id', 'execution_session_id', 'parent_attempt_id', 'step_id', 'prefix', 'context_id',
]
const VALUE_KEYS = [
  'availability', 'value', 'reason', 'source', 'origin', 'precision', 'derivation', 'included_in',
]
const STRING_EVIDENCE_KEYS = ['availability', 'value', 'reason']
const IDENTITY_KEYS = ['adapter', 'model', 'provider', 'effort', 'provenance']
const OBSERVED_IDENTITY_KEYS = ['identity_id', 'model', 'provider', 'effort', 'provenance']
const COST_KEYS = [
  'cost_evidence_id', 'amount', 'currency', 'scope', 'allocation_id', 'coverage', 'overlap', 'source',
]
const CANONICAL_TOKEN_FIELDS = [
  'input_total', 'input_uncached', 'cache_read', 'cache_write', 'output', 'reasoning',
  'provider_total', 'normalized_total',
]
const MODEL_ATTEMPT_KEYS = [
  'adapter', 'requested_identity', 'resolved_identity', 'observed_identities',
  'observed_identity_availability', 'tokens', 'provider_native_usage', 'completeness',
  'allocations', 'unallocated_usage', 'provider_reported_costs', 'provenance', 'diagnostics',
  'record_type', 'attempt_id', 'invocation_id', 'session_id', 'revision',
  'measurement_schema_version', 'lifecycle', 'outcome', 'review_context', 'consumer_context',
]
const INVOCATION_KEYS = [
  'record_type', 'invocation_id', 'revision', 'measurement_schema_version', 'session_id',
  'lifecycle', 'attempt_ids', 'zero_dispatch', 'diagnostics', 'command', 'consumer_context', 'outcome',
]
const LIFECYCLE_KEYS = ['state', 'started_at', 'ended_at']
const COMPLETENESS_KEYS = [
  'history', 'collection', 'canonical_fields', 'normalized_total', 'per_model_attribution',
]
const PROVENANCE_KEYS = [
  'producer_version', 'build', 'adapter_mapping_version', 'cli_version', 'source_format_version',
]

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value
}

function assertKnownKeys(value, allowed, label) {
  object(value, label)
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`${label} has unsupported field ${unknown}`)
}

function validateValue(value, label) {
  assertKnownKeys(value, VALUE_KEYS, label)
  if (!['available', 'partial', 'unavailable'].includes(value.availability)) {
    throw new Error(`${label} has invalid availability`)
  }
  if (value.availability === 'unavailable' && value.value !== null) {
    throw new Error(`${label} has a value while unavailable`)
  }
  if (value.value !== null && (!Number.isFinite(value.value) || value.value < 0)) {
    throw new Error(`${label} has an invalid numeric value`)
  }
}

function validateStringEvidence(value, label) {
  assertKnownKeys(value, STRING_EVIDENCE_KEYS, label)
}

function validateIdentity(value, label) {
  assertKnownKeys(value, IDENTITY_KEYS, label)
}

function validateObservedIdentity(value, label) {
  assertKnownKeys(value, OBSERVED_IDENTITY_KEYS, label)
  validateStringEvidence(value.provider, `${label}.provider`)
  validateStringEvidence(value.effort, `${label}.effort`)
}

function validateCost(cost, label) {
  assertKnownKeys(cost, COST_KEYS, label)
  validateValue(cost.amount, `${label}.amount`)
  validateStringEvidence(cost.currency, `${label}.currency`)
}

function validateTokens(tokens, label, requireCanonical = false) {
  object(tokens, label)
  if (requireCanonical) {
    const missing = CANONICAL_TOKEN_FIELDS.find((field) => !Object.hasOwn(tokens, field))
    if (missing) throw new Error(`${label} is missing ${missing}`)
  }
  for (const [field, value] of Object.entries(tokens)) {
    if (!CANONICAL_TOKEN_FIELDS.includes(field)) {
      throw new Error(`${label} has unsupported field ${field}`)
    }
    validateValue(value, `${label}.${field}`)
  }
}

function validateAttribution(attribution, label) {
  assertKnownKeys(attribution, ATTRIBUTION_KEYS, label)
}

function validateLifecycle(lifecycle, label) {
  assertKnownKeys(lifecycle, LIFECYCLE_KEYS, label)
}

function validateConsumerContext(context, label) {
  if (context === null || context === undefined) return
  assertKnownKeys(context, ['consumer', 'context_id'], label)
}

function validateCompleteness(completeness, label) {
  assertKnownKeys(completeness, COMPLETENESS_KEYS, label)
}

function validateProvenance(provenance, label) {
  assertKnownKeys(provenance, PROVENANCE_KEYS, label)
  validateStringEvidence(provenance.build, `${label}.build`)
  validateStringEvidence(provenance.cli_version, `${label}.cli_version`)
  validateStringEvidence(provenance.source_format_version, `${label}.source_format_version`)
}

function validateMeasurementPayload(payload, label) {
  if (payload.record_type === 'invocation') {
    assertKnownKeys(payload, INVOCATION_KEYS, label)
    validateLifecycle(payload.lifecycle, `${label}.lifecycle`)
    validateConsumerContext(payload.consumer_context, `${label}.consumer_context`)
    return
  }
  if (payload.record_type !== 'model_attempt') throw new Error(`${label} has unsupported record type`)
  assertKnownKeys(payload, MODEL_ATTEMPT_KEYS, label)
  validateIdentity(payload.requested_identity, `${label}.requested_identity`)
  validateIdentity(payload.resolved_identity, `${label}.resolved_identity`)
  for (const [index, identity] of (payload.observed_identities ?? []).entries()) {
    validateObservedIdentity(identity, `${label}.observed_identities[${index}]`)
  }
  validateStringEvidence(payload.observed_identity_availability, `${label}.observed_identity_availability`)
  validateLifecycle(payload.lifecycle, `${label}.lifecycle`)
  validateConsumerContext(payload.consumer_context, `${label}.consumer_context`)
  validateCompleteness(payload.completeness, `${label}.completeness`)
  validateProvenance(payload.provenance, `${label}.provenance`)
  if (payload.review_context !== undefined) {
    assertKnownKeys(payload.review_context, ['gate', 'slot'], `${label}.review_context`)
  }
  for (const [index, usage] of (payload.provider_native_usage ?? []).entries()) {
    assertKnownKeys(usage, ['source', 'name', 'value'], `${label}.provider_native_usage[${index}]`)
  }
  validateTokens(payload.tokens, `${label}.tokens`, true)
  for (const [index, allocation] of (payload.allocations ?? []).entries()) {
    assertKnownKeys(allocation, ['allocation_id', 'observed_identity_ref', 'usage'], `${label}.allocations[${index}]`)
    validateTokens(allocation.usage, `${label}.allocations[${index}].usage`)
  }
  if (payload.unallocated_usage !== null) {
    assertKnownKeys(
      payload.unallocated_usage,
      ['allocation_id', 'observed_identity_ref', 'usage'],
      `${label}.unallocated_usage`,
    )
    validateStringEvidence(payload.unallocated_usage.observed_identity_ref, `${label}.unallocated_usage.observed_identity_ref`)
    validateTokens(payload.unallocated_usage.usage, `${label}.unallocated_usage.usage`)
  }
  for (const [index, cost] of (payload.provider_reported_costs ?? []).entries()) {
    validateCost(cost, `${label}.provider_reported_costs[${index}]`)
  }
}

function validateEnvelope(record, label) {
  assertKnownKeys(record, [
    'record_type', 'record_id', 'revision', 'measurement_schema_version', 'producer',
    'original_consumer_context', 'payload', 'digest',
  ], label)
  if (record.measurement_schema_version !== RUNNER_MEASUREMENT_SCHEMA_VERSION) {
    throw new Error(
      `${label} uses unsupported measurement schema version ${JSON.stringify(record.measurement_schema_version)}`,
    )
  }
  assertKnownKeys(record.producer, ['name', 'version'], `${label}.producer`)
  assertKnownKeys(record.original_consumer_context, ['consumer', 'context_id'], `${label}.original_consumer_context`)
  assertKnownKeys(record.digest, ['algorithm', 'canonicalization', 'value'], `${label}.digest`)
  validateMeasurementPayload(record.payload, `${label}.payload`)
  if (
    record.payload.measurement_schema_version !== record.measurement_schema_version
    || record.payload.revision !== record.revision
    || record.payload.record_type !== record.record_type
  ) {
    throw new Error(`${label} envelope and payload identity do not match`)
  }
}

function validateNativeMeasurement(measurement, label) {
  assertKnownKeys(measurement, [
    'native_measurement_schema_version', 'key', 'attribution', 'producer', 'provenance',
    'source_format', 'requested_identity', 'resolved_identity', 'observed_identities', 'tokens',
    'unallocated_usage', 'provider_reported_costs', 'limitations',
  ], label)
  if (measurement.native_measurement_schema_version !== RUNNER_MEASUREMENT_SCHEMA_VERSION) {
    throw new Error(
      `${label} uses unsupported measurement schema version ${JSON.stringify(measurement.native_measurement_schema_version)}`,
    )
  }
  validateAttribution(measurement.attribution, `${label}.attribution`)
  validateIdentity(measurement.requested_identity, `${label}.requested_identity`)
  validateIdentity(measurement.resolved_identity, `${label}.resolved_identity`)
  for (const [index, identity] of (measurement.observed_identities ?? []).entries()) {
    validateObservedIdentity(identity, `${label}.observed_identities[${index}]`)
  }
  validateTokens(measurement.tokens, `${label}.tokens`, true)
  if (measurement.unallocated_usage !== null) {
    validateValue(measurement.unallocated_usage, `${label}.unallocated_usage`)
  }
  for (const [index, cost] of (measurement.provider_reported_costs ?? []).entries()) {
    validateCost(cost, `${label}.provider_reported_costs[${index}]`)
  }
}

// Agent Runner joins nesting segments with `/` and renders a loop iteration as
// `<step-id>:<n>` (`executionIdentityPrefix` in internal/exec/step_audit.go), so
// per-task work sits under `implement-tasks:<n>`. The same validator
// sub-workflow also runs as the workflow's final `run-validator` step, and only
// this position distinguishes the two.
const TASK_LOOP_PREFIX = /^implement-tasks(?::\d+)?(?:\/|$)/

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function knownIdentityValue(value) {
  return nonEmptyString(value) && value !== 'unknown' ? value : null
}

function effectiveIdentityValue(identity, field, ...legacyValues) {
  if (nonEmptyString(identity[field])) return knownIdentityValue(identity[field])
  return legacyValues.map(knownIdentityValue).find((value) => value !== null) ?? null
}

function attemptIdOf(raw, index) {
  if (nonEmptyString(raw.attempt_id)) return raw.attempt_id
  if (nonEmptyString(raw.record_id)) return raw.record_id
  return `attempt-${index}`
}

function usageStateOf(usage, invokedCli) {
  if (usage?.status === 'collected') return PRESENT
  if (usage?.status === 'unavailable') return 'unavailable'
  return invokedCli ? 'unavailable' : 'not-applicable'
}

function agentRole(raw) {
  if (!raw.agent_invoked) return null
  if (raw.kind === 'agent-call' && raw.target_name === 'acceptance-tester') return 'acceptance-reviewer'
  if (typeof raw.prefix === 'string' && TASK_LOOP_PREFIX.test(raw.prefix)) {
    return 'task-implementor'
  }
  return 'lead-agent'
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

function availableNumber(value) {
  return value && value.availability !== 'unavailable' && Number.isFinite(value.value)
    ? value.value
    : null
}

function legacyTokensFromEnvelopes(tokens) {
  const values = {
    input: availableNumber(tokens.input_total),
    cached_input: availableNumber(tokens.cache_read),
    cache_write: availableNumber(tokens.cache_write),
    output: availableNumber(tokens.output),
    reasoning: availableNumber(tokens.reasoning),
    provider_total: availableNumber(tokens.provider_total),
  }
  const present = Object.entries(values).filter(([, value]) => value !== null)
  return present.length > 0 ? Object.fromEntries(present) : null
}

function tokenTotalsFromEnvelopes(tokens) {
  const values = {
    input: availableNumber(tokens.input_total),
    output: availableNumber(tokens.output),
    total: availableNumber(tokens.normalized_total),
  }
  const present = Object.entries(values).filter(([, value]) => value !== null)
  return present.length > 0 ? Object.fromEntries(present) : null
}

function allocationUsageState(tokens) {
  if (!Object.values(tokens).some((value) => availableNumber(value) !== null)) return 'unavailable'
  return [
    ['input_total', 'input'],
    ['output', 'output'],
    ['normalized_total', 'total'],
  ].every(([field]) => (
    tokens[field]?.availability === 'available' && Number.isFinite(tokens[field].value)
  ))
    ? PRESENT
    : 'partial'
}

// Pricing needs an exhaustive, non-overlapping billing partition. In
// particular, input_total minus known cache categories is not a measurement of
// uncached input when another cache category is unavailable.
function billingTokensFromEnvelopes(tokens) {
  const required = ['input_uncached', 'cache_read', 'cache_write', 'output']
  if (!required.every((field) => (
    tokens[field]?.availability === 'available'
    && Number.isFinite(tokens[field].value)
    && tokens[field].value >= 0
  ))) return null
  return Object.fromEntries(Object.entries({
    input: tokens.input_uncached.value,
    cached_input: tokens.cache_read.value,
    cache_write: tokens.cache_write.value,
    output: tokens.output.value,
  }).filter(([, count]) => count > 0))
}

function sourceVersion(provenance) {
  return provenance?.source_format_version?.availability === 'available'
    ? provenance.source_format_version.value
    : null
}

function observedIdentity(identity) {
  return {
    identity_id: identity.identity_id,
    provider: identity.provider?.availability === 'available' ? knownIdentityValue(identity.provider.value) : null,
    model: knownIdentityValue(identity.model),
    effort: identity.effort?.availability === 'available' ? knownIdentityValue(identity.effort.value) : null,
    provenance: identity.provenance ?? null,
    evidence: identity,
  }
}

function normalizedIdentity(measurement) {
  const requested = measurement.requested_identity ?? {}
  const resolved = measurement.resolved_identity ?? {}
  const observed = (measurement.observed_identities ?? []).map(observedIdentity)
  const effective = observed.length === 1 ? observed[0] : null
  return {
    cli: resolved.adapter ?? requested.adapter ?? null,
    provider: effective?.provider ?? knownIdentityValue(resolved.provider),
    model: effective?.model ?? knownIdentityValue(resolved.model),
    effort: effective?.effort ?? knownIdentityValue(resolved.effort),
    requested_cli: knownIdentityValue(requested.adapter),
    requested_model: knownIdentityValue(requested.model),
    requested_effort: knownIdentityValue(requested.effort),
    requested,
    resolved,
    observed,
  }
}

function normalizeAllocation(raw, identities, profile) {
  const identity = identities.find((entry) => entry.identity_id === raw.observed_identity_ref) ?? null
  const tokenTotals = tokenTotalsFromEnvelopes(raw.usage)
  return {
    allocation_id: raw.allocation_id,
    observed_identity_ref: raw.observed_identity_ref,
    provider: identity?.provider ?? profile.provider,
    model: identity?.model ?? null,
    effort: identity?.effort ?? profile.effort,
    usage: {
      state: allocationUsageState(raw.usage),
      token_envelopes: raw.usage,
      tokens: legacyTokensFromEnvelopes(raw.usage),
      token_totals: tokenTotals,
      billing_tokens: billingTokensFromEnvelopes(raw.usage),
    },
  }
}

function normalizeUnallocated(raw, tokens, identities) {
  if (raw) {
    const tokenTotals = tokenTotalsFromEnvelopes(raw.usage)
    return {
      allocation_id: raw.allocation_id,
      observed_identity_ref: raw.observed_identity_ref,
      observed_identities: identities,
      reason: raw.observed_identity_ref?.reason ?? 'usage is not allocated to a model',
      usage: {
        state: allocationUsageState(raw.usage),
        token_envelopes: raw.usage,
        tokens: legacyTokensFromEnvelopes(raw.usage),
        token_totals: tokenTotals,
        billing_tokens: billingTokensFromEnvelopes(raw.usage),
      },
    }
  }
  const tokenTotals = tokenTotalsFromEnvelopes(tokens)
  return {
    allocation_id: 'unallocated',
    observed_identity_ref: { availability: 'unavailable', reason: 'per_model_attribution_unavailable' },
    observed_identities: identities,
    reason: 'per-model attribution is unavailable',
    usage: {
      state: allocationUsageState(tokens),
      token_envelopes: tokens,
      tokens: legacyTokensFromEnvelopes(tokens),
      token_totals: tokenTotals,
      billing_tokens: billingTokensFromEnvelopes(tokens),
    },
  }
}

function completeReportedAttemptCost(costs) {
  const eligible = costs.filter((cost) => cost.scope === 'attempt'
    && cost.coverage === 'full'
    && cost.overlap === 'established'
    && cost.currency?.availability === 'available'
    && cost.currency.value === 'USD'
    && cost.amount?.availability === 'available'
    && Number.isFinite(cost.amount.value)
    && cost.amount.value >= 0)
  return eligible.length === 1 ? eligible[0].amount.value : null
}

function measurementUsage(tokens, completeness = {}) {
  const values = Object.values(tokens)
  const known = values.some((value) => availableNumber(value) !== null)
  const complete = completeness.collection === 'complete'
    && tokens.normalized_total?.availability === 'available'
    && Number.isFinite(tokens.normalized_total.value)
  return {
    state: complete ? PRESENT : (known ? 'partial' : 'unavailable'),
    reason: complete ? null : (tokens.normalized_total?.reason ?? 'measurement collection is incomplete'),
    tokens: legacyTokensFromEnvelopes(tokens),
    token_totals: tokenTotalsFromEnvelopes(tokens),
    billing_tokens: billingTokensFromEnvelopes(tokens),
    token_envelopes: tokens,
    completeness,
  }
}

function nativeUsage(tokens, limitations) {
  const normalized = tokens.normalized_total
  return measurementUsage(tokens, {
    collection: normalized?.availability === 'available' ? 'complete' : 'partial',
    canonical_fields: CANONICAL_TOKEN_FIELDS.every((field) => tokens[field]?.availability === 'available')
      ? 'complete'
      : 'partial',
    normalized_total: normalized?.availability === 'available' ? 'complete' : 'unavailable',
    per_model_attribution: limitations.includes('model_allocation_unavailable') ? 'unavailable' : 'complete',
    history: limitations.includes('legacy_token_relationships_unknown') ? 'partial' : 'complete',
  })
}

function normalizeNativeMeasurement(raw, step) {
  const profile = normalizedIdentity(raw)
  const costs = raw.provider_reported_costs ?? []
  const reported = completeReportedAttemptCost(costs)
  const usage = nativeUsage(raw.tokens, raw.limitations ?? [])
  const attributable = profile.observed.length === 1 && raw.unallocated_usage === null
  const allocations = attributable
    ? [{
        allocation_id: 'native-observed',
        observed_identity_ref: profile.observed[0].identity_id,
        provider: profile.observed[0].provider ?? profile.provider,
        model: profile.observed[0].model,
        effort: profile.observed[0].effort ?? profile.effort,
        usage: {
          state: usage.state,
          token_envelopes: raw.tokens,
          tokens: usage.tokens,
          token_totals: usage.token_totals,
          billing_tokens: usage.billing_tokens,
        },
      }]
    : []
  return {
    attempt_id: raw.key,
    producer_attempt_id: raw.key,
    measurement_key: raw.key,
    measurement_schema_version: raw.native_measurement_schema_version,
    measurement_revision: null,
    measurement_digest: null,
    measurement_producer: raw.producer,
    measurement_provenance: raw.provenance,
    source_provenance: {
      source_format: raw.source_format,
      limitations: raw.limitations,
    },
    step: raw.attribution.step_id,
    prefix: raw.attribution.prefix,
    agent_role: step?.role ?? agentRole(step ?? { agent_invoked: true, prefix: raw.attribution.prefix }),
    tool: step?.tool ?? 'agent-runner',
    invoked_cli: true,
    cli: profile.cli,
    provider: profile.provider,
    model: profile.observed.length > 1 ? null : profile.model,
    effort: profile.effort,
    requested_cli: profile.requested_cli,
    requested_model: profile.requested_model,
    requested_effort: profile.requested_effort,
    identity: {
      requested: profile.requested,
      resolved: profile.resolved,
      observed: profile.observed,
      per_model_attribution: allocations.length === 1 ? 'complete' : 'unavailable',
    },
    allocations,
    unallocated_usage: allocations.length === 0
      ? normalizeUnallocated(null, raw.tokens, profile.observed)
      : null,
    usage_source: raw.source_format,
    usage_source_version: null,
    session: step?.session_id ?? null,
    duration_ms: Number.isFinite(step?.duration_ms) ? step.duration_ms : null,
    lifecycle: null,
    outcome: step?.outcome ?? null,
    execution_session_id: raw.attribution.execution_session_id ?? null,
    execution_session_coverage: step?.execution_session_coverage ?? null,
    git_changes: step?.git_changes ?? null,
    usage,
    provider_reported_costs: costs,
    cost: {
      state: reported === null ? 'unavailable' : PRESENT,
      reason: reported === null ? 'no exhaustive non-overlapping full-attempt USD cost was reported' : null,
      estimated_api_cost_usd: reported,
    },
  }
}

function durationBetween(lifecycle) {
  const started = Date.parse(lifecycle?.started_at)
  const ended = Date.parse(lifecycle?.ended_at)
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null
}

function normalizeValidatorAttempt(head) {
  const record = head.record
  const raw = record.payload
  const profile = normalizedIdentity(raw)
  const costs = raw.provider_reported_costs ?? []
  const reported = completeReportedAttemptCost(costs)
  const usage = measurementUsage(raw.tokens, raw.completeness)
  const allocations = (raw.allocations ?? []).map(
    (allocation) => normalizeAllocation(allocation, profile.observed, profile),
  )
  const unallocated = raw.unallocated_usage
    ? normalizeUnallocated(raw.unallocated_usage, raw.tokens, profile.observed)
    : (allocations.length === 0 ? normalizeUnallocated(null, raw.tokens, profile.observed) : null)
  return {
    attempt_id: raw.attempt_id,
    producer_attempt_id: raw.attempt_id,
    invocation_id: raw.invocation_id,
    measurement_key: head.key,
    measurement_schema_version: record.measurement_schema_version,
    measurement_revision: record.revision,
    measurement_digest: record.digest.value,
    measurement_producer: record.producer.name,
    measurement_provenance: raw.provenance,
    source_provenance: {
      producer: record.producer,
      digest: record.digest,
      original_consumer_context: record.original_consumer_context,
      runner_attribution: head.attribution,
      provider_native_usage: raw.provider_native_usage,
      diagnostics: raw.diagnostics,
    },
    step: head.attribution.step_id,
    prefix: head.attribution.prefix,
    agent_role: 'implementation-validator',
    tool: 'agent-validator',
    invoked_cli: true,
    cli: profile.cli ?? raw.adapter,
    provider: profile.observed.length > 1 ? null : profile.provider,
    model: profile.observed.length > 1 ? null : profile.model,
    effort: profile.observed.length > 1 ? null : profile.effort,
    requested_cli: profile.requested_cli,
    requested_model: profile.requested_model,
    requested_effort: profile.requested_effort,
    identity: {
      requested: profile.requested,
      resolved: profile.resolved,
      observed: profile.observed,
      observed_availability: raw.observed_identity_availability,
      per_model_attribution: raw.completeness?.per_model_attribution ?? null,
    },
    allocations,
    unallocated_usage: unallocated,
    usage_source: 'agent-validator:metrics',
    usage_source_version: sourceVersion(raw.provenance),
    session: raw.session_id,
    duration_ms: durationBetween(raw.lifecycle),
    lifecycle: raw.lifecycle,
    outcome: raw.outcome,
    execution_session_id: head.attribution.execution_session_id ?? null,
    execution_session_coverage: head.attribution.execution_session_id ? 'exact' : 'unknown',
    git_changes: null,
    usage,
    provider_reported_costs: costs,
    cost: {
      state: reported === null ? 'unavailable' : PRESENT,
      reason: reported === null ? 'no exhaustive non-overlapping full-attempt USD cost was reported' : null,
      estimated_api_cost_usd: reported,
    },
  }
}

function normalizeAttempt(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`attempt ${index} is not an object`)
  }
  const attemptId = attemptIdOf(raw, index)
  const invokedCli = raw.agent_invoked === true
  if (raw.usage !== null && raw.usage !== undefined && typeof raw.usage !== 'object') {
    throw new Error(`attempt ${attemptId} has malformed usage`)
  }
  const rawUsage = raw.usage ?? null
  const identity = rawUsage?.identity ?? {}
  const usageState = usageStateOf(rawUsage, invokedCli)
  const reportedCost = Number.isFinite(raw.estimated_api_cost_usd) && raw.estimated_api_cost_usd >= 0
  const missingCostState = invokedCli ? 'unavailable' : 'not-applicable'

  return {
    attempt_id: attemptId,
    step: raw.id ?? raw.step ?? null,
    prefix: raw.prefix ?? null,
    agent_role: raw.role ?? raw.agent_role ?? agentRole(raw),
    tool: raw.tool ?? null,
    invoked_cli: invokedCli,
    cli: effectiveIdentityValue(identity, 'effective_cli', rawUsage?.cli, raw.cli),
    provider: effectiveIdentityValue(identity, 'effective_provider', rawUsage?.provider, raw.provider),
    model: effectiveIdentityValue(identity, 'effective_model', rawUsage?.model, raw.model),
    effort: effectiveIdentityValue(identity, 'effective_effort', rawUsage?.effort, raw.effort),
    requested_cli: knownIdentityValue(identity.requested_cli),
    requested_model: knownIdentityValue(identity.requested_model),
    requested_effort: knownIdentityValue(identity.requested_effort),
    identity: {
      provider_source: identity.provider_source ?? null,
      model_source: identity.model_source ?? null,
      effort_source: identity.effort_source ?? null,
    },
    usage_source: rawUsage?.source ?? raw.usage_source ?? null,
    usage_source_version: null,
    session: raw.session_id ?? raw.session ?? null,
    duration_ms: Number.isFinite(raw.duration_ms) ? raw.duration_ms : null,
    execution_session_id: knownIdentityValue(raw.execution_session_id),
    execution_session_coverage: raw.execution_session_coverage ?? null,
    git_changes: raw.git_changes ?? null,
    usage: {
      state: usageState,
      reason: rawUsage?.reason ?? (invokedCli && !rawUsage ? 'agent runner reported no usage' : null),
      tokens: rawUsage?.tokens ?? null,
      token_totals: rawUsage?.token_totals ?? null,
      billing_tokens: usageState === PRESENT ? billingTokens(rawUsage) : null,
      completeness: rawUsage?.completeness ?? null,
    },
    cost: {
      state: reportedCost ? PRESENT : missingCostState,
      reason: !reportedCost && invokedCli ? 'agent runner reported no cost' : null,
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

function validatorDeliveryComplete(payload) {
  const hasValidatorScope = payload.validator_contexts.length > 0 || payload.measurement_heads.length > 0
  if (!hasValidatorScope) return true
  const summary = payload.validator_delivery
  if (
    summary?.history_coverage !== 'complete'
    || summary?.collection !== 'complete'
    || summary?.delivery !== 'complete'
    || (summary.gaps?.length ?? 0) > 0
  ) return false
  return payload.validator_contexts.every((context) => (
    context.history === 'complete'
    && context.collection === 'complete'
    && context.delivery === 'complete'
    && context.scope_complete === true
    && context.gaps.length === 0
  ))
}

function normalizeV4(payload) {
  assertKnownKeys(payload, V4_KEYS, 'run-metrics.json schema-v4 artifact')
  if (payload.aggregate_version !== RUNNER_MEASUREMENT_AGGREGATE_VERSION) {
    throw new Error(`unsupported measurement aggregate version ${JSON.stringify(payload.aggregate_version)}`)
  }
  for (const field of ['native_measurements', 'measurement_heads', 'validator_contexts']) {
    if (payload[field] !== null && !Array.isArray(payload[field])) {
      throw new Error(`run-metrics.json has malformed ${field}`)
    }
  }
  if (!Array.isArray(payload.steps)) throw new Error('run-metrics.json has no steps array')
  const nativeMeasurements = payload.native_measurements ?? []
  const measurementHeads = payload.measurement_heads ?? []
  const validatorContexts = payload.validator_contexts ?? []
  if (payload.validator_delivery !== null && payload.validator_delivery !== undefined) {
    assertKnownKeys(
      payload.validator_delivery,
      ['history_coverage', 'collection', 'delivery', 'gaps'],
      'validator_delivery',
    )
  }

  const stepByRecord = new Map(payload.steps.map((step) => [step.record_id, step]))
  const native = nativeMeasurements.map((measurement, index) => {
    validateNativeMeasurement(measurement, `native_measurements[${index}]`)
    return normalizeNativeMeasurement(measurement, stepByRecord.get(measurement.key))
  })
  const invocations = []
  const validatorAttempts = []
  const excludedHeads = []
  for (const [index, head] of measurementHeads.entries()) {
    assertKnownKeys(head, ['key', 'store_id', 'attribution', 'record', 'status'], `measurement_heads[${index}]`)
    validateAttribution(head.attribution, `measurement_heads[${index}].attribution`)
    validateEnvelope(head.record, `measurement_heads[${index}].record`)
    if (head.attribution.run_id !== payload.run_id) {
      throw new Error(`measurement_heads[${index}] is attributed to another run`)
    }
    if (head.status !== 'supported') {
      excludedHeads.push(head)
    } else if (head.record.record_type === 'invocation') {
      invocations.push(head.record)
    } else {
      validatorAttempts.push(normalizeValidatorAttempt(head))
    }
  }
  for (const [index, context] of validatorContexts.entries()) {
    assertKnownKeys(context, [
      'attribution', 'store_id', 'evidence_state', 'delivery', 'collection', 'history',
      'gaps', 'generation', 'scope_complete',
    ], `validator_contexts[${index}]`)
    validateAttribution(context.attribution, `validator_contexts[${index}].attribution`)
  }
  for (const [field, aggregate] of Object.entries(payload.measurement_totals ?? {})) {
    if (!CANONICAL_TOKEN_FIELDS.includes(field)) {
      throw new Error(`measurement_totals has unsupported field ${field}`)
    }
    assertKnownKeys(aggregate, [
      'known_subtotal', 'availability', 'precision', 'contributing_attempts',
      'partial_attempts', 'missing_attempts',
    ], `measurement_totals.${field}`)
  }

  const attempts = [...native, ...validatorAttempts]
  assertUniqueAttemptIds(attempts)
  const normalizedPayload = {
    ...payload,
    native_measurements: nativeMeasurements,
    measurement_heads: measurementHeads,
    validator_contexts: validatorContexts,
  }
  const deliveryComplete = validatorDeliveryComplete(normalizedPayload) && excludedHeads.length === 0
  const measurementHistoryComplete = attempts.every(
    (attempt) => attempt.usage?.completeness?.history === 'complete',
  )
  const historyComplete = payload.history_complete === true
    && deliveryComplete
    && measurementHistoryComplete
  return {
    attempts,
    invocations,
    excluded_heads: excludedHeads,
    complete: historyComplete,
    history_complete: payload.history_complete ?? null,
    measurement_history_complete: measurementHistoryComplete,
    delivery_complete: deliveryComplete,
    delivery: payload.validator_delivery ?? null,
    validator_contexts: validatorContexts,
    native_measurements: nativeMeasurements,
    measurement_heads: measurementHeads,
    measurement_totals: payload.measurement_totals,
    aggregate_version: payload.aggregate_version,
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

  if (!SUPPORTED_RUNNER_METRICS_SCHEMA_VERSIONS.includes(payload?.schema_version)) {
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
  let v4 = null
  try {
    if (payload.schema_version === RUNNER_METRICS_SCHEMA_VERSION) {
      v4 = normalizeV4(payload)
      attempts = v4.attempts
    } else {
      attempts = payload.steps.map(normalizeAttempt)
      assertUniqueAttemptIds(attempts)
    }
  } catch (error) {
    return rejected(`run-metrics.json is malformed: ${error.message}`, source)
  }

  const cliAttempts = attempts.filter((entry) => entry.invoked_cli)
  const coverage = {
    usage_available: cliAttempts.filter((entry) => entry.usage.state === PRESENT).length,
    usage_partial: cliAttempts.filter((entry) => entry.usage.state === 'partial').length,
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

  if (v4) {
    coverage.delivery_complete = v4.delivery_complete
    coverage.delivery_gaps = [...new Set([
      ...(payload.validator_delivery?.gaps ?? []),
      ...v4.validator_contexts.flatMap((context) => context.gaps ?? []),
      ...v4.excluded_heads.map((head) => `measurement_head_${head.status}`),
    ])]
    coverage.measurement_totals = payload.measurement_totals
  }

  const historyComplete = v4 ? v4.complete : payload.history_complete === true

  return {
    state: 'ingested',
    reason: null,
    // Completeness is Agent Runner's own claim about its history. The harness
    // reports it rather than inferring one from the attempts it happened to see.
    complete: historyComplete,
    history_complete: payload.history_complete ?? null,
    measurement_history_complete: v4?.measurement_history_complete ?? null,
    // Agent Runner's own measure of how long its workflow was actively running.
    // Absent means unmeasured, never instant.
    active_duration_ms: Number.isFinite(payload.totals?.active_duration_ms)
      ? payload.totals.active_duration_ms
      : null,
    source,
    attempts,
    attempt_count: attempts.length,
    dispatch_count: attempts.length,
    invocations: v4?.invocations ?? [],
    sessions: [...new Set(attempts.map((entry) => entry.session).filter((value) => value !== null))],
    execution_sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
    session_rollups: Array.isArray(payload.session_rollups) ? payload.session_rollups : [],
    repository_changes: payload.repository_changes ?? null,
    delivery_complete: v4?.delivery_complete ?? null,
    delivery: v4?.delivery ?? null,
    validator_contexts: v4?.validator_contexts ?? [],
    measurement_heads: v4?.measurement_heads ?? [],
    native_measurements: v4?.native_measurements ?? [],
    excluded_measurement_heads: v4?.excluded_heads ?? [],
    measurement_totals: v4?.measurement_totals ?? null,
    measurement_aggregate_version: v4?.aggregate_version ?? null,
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
