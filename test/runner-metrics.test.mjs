import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import {
  RUNNER_METRICS_FILENAME,
  ingestRunnerMetrics,
  readRunnerMetrics,
} from '../evals/agent-runner/and-scene/lib/runner-metrics.mjs'

const RUN_ID = 'run-7f3a'
const WORKFLOW = 'implement-change'

function step(overrides = {}) {
  return {
    record_id: 'implement-task#1',
    prefix: 'implement-tasks:0/implement-single-task/sub:implement-task',
    id: 'generate-code',
    kind: 'step',
    type: 'agent',
    attempt: 1,
    iteration: null,
    outcome: 'success',
    agent_invoked: true,
    session_id: 'session-1',
    duration_ms: 1200,
    usage: {
      status: 'collected',
      cli: 'codex',
      provider: 'openai',
      model: 'gpt-5-codex',
      effort: 'high',
      source: 'codex:turn.completed',
      completeness: 'complete',
      tokens: { input: 1000, cached_input: 200, output: 300, reasoning: 50 },
      token_totals: { input: 1000, output: 300, total: 1300 },
    },
    estimated_api_cost_usd: 0.0125,
    ...overrides,
  }
}

function metrics(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    workflow: WORKFLOW,
    history_complete: true,
    sessions: [{ started_at: '2026-07-20T12:00:00Z', last_observed_at: '2026-07-20T12:00:01Z', duration_ms: 1000, status: 'closed' }],
    steps: [step()],
    totals: {
      active_duration_ms: 45_000,
      tokens: { input: 1000, cached_input: 200, output: 300, reasoning: 50 },
      usage_coverage: 'complete',
      token_totals: { input: 1000, output: 300, total: 1300 },
      token_total_coverage: 'complete',
      estimated_api_cost_usd: 0.0125,
      cost_coverage: 'complete',
    },
    ...overrides,
  }
}

function measured(value, overrides = {}) {
  return {
    availability: 'available', value, reason: null, source: 'provider_usage',
    origin: 'observed', precision: 'exact', derivation: null, included_in: null,
    ...overrides,
  }
}

function unavailable(reason = 'not_reported') {
  return {
    availability: 'unavailable', value: null, reason, source: null,
    origin: null, precision: null, derivation: null, included_in: null,
  }
}

function canonicalTokens(overrides = {}) {
  return {
    input_total: measured(100),
    input_uncached: unavailable(),
    cache_read: measured(40, { included_in: ['input_total'] }),
    cache_write: unavailable(),
    output: measured(50),
    reasoning: unavailable(),
    provider_total: unavailable(),
    normalized_total: measured(150),
    ...overrides,
  }
}

function identity(model, id) {
  return {
    identity_id: id,
    model,
    provider: { availability: 'available', value: 'fixture-provider', reason: null },
    effort: { availability: 'unavailable', value: null, reason: 'not_reported' },
    provenance: 'telemetry',
  }
}

function validatorPayload(overrides = {}) {
  return {
    record_type: 'model_attempt',
    attempt_id: 'validator-attempt-1',
    revision: 2,
    measurement_schema_version: 1,
    session_id: 'validator-session-1',
    invocation_id: 'validator-invocation-1',
    lifecycle: {
      state: 'completed',
      started_at: '2026-09-08T12:00:00Z',
      ended_at: '2026-09-08T12:00:01Z',
    },
    adapter: 'codex',
    outcome: 'passed',
    requested_identity: {
      adapter: 'codex', model: 'configured-model', provider: null, effort: null,
      provenance: 'configuration',
    },
    resolved_identity: {
      adapter: 'codex', model: 'configured-model', provider: null, effort: null,
      provenance: 'launch_resolution',
    },
    observed_identities: [identity('model-a', 'identity-a'), identity('model-b', 'identity-b')],
    observed_identity_availability: { availability: 'available', reason: null },
    tokens: canonicalTokens(),
    provider_native_usage: [],
    completeness: {
      collection: 'complete', canonical_fields: 'partial', normalized_total: 'complete',
      per_model_attribution: 'partial', history: 'complete',
    },
    allocations: [{
      allocation_id: 'allocation-a',
      observed_identity_ref: 'identity-a',
      usage: { normalized_total: measured(100) },
    }],
    unallocated_usage: {
      allocation_id: 'allocation-unallocated',
      observed_identity_ref: { availability: 'unavailable', reason: 'aggregate_only' },
      usage: { normalized_total: measured(50) },
    },
    provider_reported_costs: [{
      cost_evidence_id: 'cost-a', scope: 'allocation', allocation_id: 'allocation-a',
      amount: measured(0.01),
      currency: { availability: 'available', value: 'USD', reason: null },
      coverage: 'full', overlap: 'unknown', source: 'provider_usage',
    }],
    provenance: {
      producer_version: '1.2.3',
      build: { availability: 'available', value: 'abc123', reason: null },
      adapter_mapping_version: 'adapter-collection-v1',
      cli_version: { availability: 'available', value: '0.9.0', reason: null },
      source_format_version: { availability: 'available', value: 'codex-jsonl-v1', reason: null },
    },
    diagnostics: [],
    review_context: { gate: 'all-reviewers', slot: 1 },
    consumer_context: { consumer: 'agent-runner', context_id: 'context-1' },
    ...overrides,
  }
}

function invocationPayload(overrides = {}) {
  return {
    record_type: 'invocation',
    invocation_id: 'validator-invocation-1',
    revision: 2,
    measurement_schema_version: 1,
    session_id: 'validator-session-1',
    lifecycle: {
      state: 'completed',
      started_at: '2026-09-08T12:00:00Z',
      ended_at: '2026-09-08T12:00:01Z',
    },
    attempt_ids: ['validator-attempt-1'],
    zero_dispatch: false,
    diagnostics: [],
    command: 'run',
    consumer_context: { consumer: 'agent-runner', context_id: 'context-1' },
    outcome: 'passed',
    ...overrides,
  }
}

function envelope(payload) {
  const id = payload.record_type === 'model_attempt' ? payload.attempt_id : payload.invocation_id
  return {
    record_type: payload.record_type,
    record_id: id,
    revision: payload.revision,
    measurement_schema_version: payload.measurement_schema_version,
    producer: { name: 'agent-validator', version: '1.2.3' },
    original_consumer_context: { consumer: 'agent-runner', context_id: 'context-1' },
    payload,
    digest: { algorithm: 'sha256', canonicalization: 'rfc8785', value: '0'.repeat(64) },
  }
}

function head(payload) {
  const record = envelope(payload)
  return {
    key: `store-1/${record.record_type}/${record.record_id}`,
    store_id: 'store-1',
    attribution: {
      run_id: RUN_ID,
      execution_session_id: 'execution-1',
      parent_attempt_id: 'parent-1',
      step_id: 'run-validator',
      prefix: '',
      context_id: 'context-1',
    },
    record,
    status: 'supported',
  }
}

function nativeMeasurement(overrides = {}) {
  return {
    native_measurement_schema_version: 1,
    key: 'implement-task#1',
    attribution: {
      run_id: RUN_ID,
      execution_session_id: 'execution-1',
      parent_attempt_id: '',
      step_id: 'generate-code',
      prefix: 'implement-tasks:0/implement-single-task/sub:implement-task',
    },
    producer: 'agent-runner',
    provenance: 'native',
    source_format: 'claude:result-event',
    requested_identity: {
      adapter: 'claude', model: 'claude-opus-5', provider: null, effort: null,
      provenance: 'configuration',
    },
    resolved_identity: {
      adapter: 'claude', model: 'claude-opus-5', provider: 'anthropic', effort: 'high',
      provenance: 'launch_resolution',
    },
    observed_identities: [identity('claude-opus-5', 'observed-1')],
    tokens: canonicalTokens({ input_uncached: measured(60), cache_write: measured(0) }),
    unallocated_usage: null,
    provider_reported_costs: [{
      cost_evidence_id: 'reported-cost', scope: 'attempt',
      amount: measured(0.25),
      currency: { availability: 'available', value: 'USD', reason: null },
      coverage: 'full', overlap: 'established', source: 'provider_usage',
    }],
    limitations: [],
    ...overrides,
  }
}

function v4Metrics(overrides = {}) {
  const native = nativeMeasurement()
  const validator = validatorPayload()
  return {
    schema_version: 4,
    run_id: RUN_ID,
    workflow: WORKFLOW,
    history_complete: true,
    aggregate_version: 1,
    native_measurements: [native],
    measurement_heads: [head(invocationPayload()), head(validator)],
    validator_contexts: [{
      attribution: head(validator).attribution,
      store_id: 'store-1',
      evidence_state: 'saved',
      delivery: 'complete',
      collection: 'complete',
      history: 'complete',
      gaps: [],
      generation: 1,
      scope_complete: true,
    }],
    measurement_totals: {
      normalized_total: {
        known_subtotal: 300, availability: 'available', precision: 'exact',
        contributing_attempts: 2, partial_attempts: 0, missing_attempts: 0,
      },
    },
    validator_delivery: {
      history_coverage: 'complete', collection: 'complete', delivery: 'complete',
    },
    sessions: [{
      execution_session_id: 'execution-1', started_at: '2026-09-08T11:59:00Z',
      last_observed_at: '2026-09-08T12:01:00Z', ended_at: '2026-09-08T12:01:00Z',
      duration_ms: 120_000, status: 'closed',
    }],
    steps: [
      step({ role: 'task-implementor', tool: 'agent-runner', execution_session_id: 'execution-1' }),
      step({
        record_id: `measurement/${head(validator).key}`,
        measurement_key: head(validator).key,
        id: 'validator-attempt-1',
        role: 'implementation-validator',
        tool: 'agent-validator',
        execution_session_id: 'execution-1',
      }),
    ],
    session_rollups: [],
    repository_changes: null,
    totals: { active_duration_ms: 120_000 },
    ...overrides,
  }
}

async function sessionDir(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-metrics-'))
  if (contents !== null) {
    await writeFile(join(dir, RUNNER_METRICS_FILENAME), contents)
  }
  return dir
}

test('valid schema-v1 metrics are ingested with every attempt preserved', () => {
  const text = JSON.stringify(metrics())

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.reason, null)
  assert.equal(ingested.history_complete, true)
  assert.equal(ingested.complete, true)
  assert.equal(ingested.source.sha256, hashString(text))
  assert.equal(ingested.source.schema_version, 1)
  assert.equal(ingested.attempts.length, 1)
  assert.deepEqual(ingested.attempts[0].usage.tokens, {
    input: 1000, cached_input: 200, output: 300, reasoning: 50,
  })
  assert.deepEqual(ingested.attempts[0].usage.billing_tokens, {
    input: 800, cached_input: 200, output: 300,
  })
  assert.equal(ingested.attempts[0].cost.estimated_api_cost_usd, 0.0125)
  assert.equal(ingested.attempts[0].duration_ms, 1200)
  assert.equal(ingested.attempts[0].effort, 'high')
})

test('the reported implementation active duration is preserved', () => {
  const withDuration = ingestRunnerMetrics({
    text: JSON.stringify(metrics()),
    runId: RUN_ID,
    workflow: WORKFLOW,
  })
  const without = ingestRunnerMetrics({
    text: JSON.stringify(metrics({ totals: { ...metrics().totals, active_duration_ms: null } })),
    runId: RUN_ID,
    workflow: WORKFLOW,
  })

  assert.equal(withDuration.active_duration_ms, 45_000)
  // Unmeasured stays unmeasured: a zero would read as an instant workflow.
  assert.equal(without.active_duration_ms, null)
})

test('an unavailable usage or cost keeps its reason and never becomes zero', () => {
  const text = JSON.stringify(metrics({
    steps: [step({
      usage: { status: 'unavailable', reason: 'cli reported no usage', cli: 'codex', source: 'agent-runner' },
      estimated_api_cost_usd: null,
    })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  const [only] = ingested.attempts
  assert.equal(only.usage.state, 'unavailable')
  assert.equal(only.usage.reason, 'cli reported no usage')
  assert.equal(only.usage.tokens, null)
  assert.equal(only.cost.state, 'unavailable')
  assert.equal(only.cost.estimated_api_cost_usd, null)
  assert.equal(ingested.coverage.usage_unavailable, 1)
  assert.equal(ingested.coverage.cost_unavailable, 1)
})

test('metrics naming another run are rejected as implementation metrics input', () => {
  const text = JSON.stringify(metrics({ run_id: 'run-other' }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'rejected')
  assert.equal(ingested.complete, false)
  assert.equal(ingested.attempts.length, 0)
  assert.match(ingested.reason, /run-other/)
})

test('metrics naming another workflow are rejected', () => {
  const text = JSON.stringify(metrics({ workflow: 'legacy-implement-change' }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'rejected')
  assert.match(ingested.reason, /implement-change/)
})

test('schema-v2 metrics use Runner role, tool, and effective invocation identity', () => {
  const text = JSON.stringify(metrics({
    schema_version: 2,
    steps: [step({
      role: 'implementor',
      tool: 'agent-runner',
      usage: {
        ...step().usage,
        model: null,
        identity: {
          requested_cli: 'codex',
          requested_model: 'gpt-5.6-terra',
          requested_effort: 'high',
          effective_cli: 'codex',
          effective_provider: 'openai',
          effective_model: 'gpt-5.6-terra',
          effective_effort: 'high',
          provider_source: 'adapter',
          model_source: 'invocation',
          effort_source: 'invocation',
        },
      },
    })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.source.schema_version, 2)
  assert.equal(ingested.attempts[0].agent_role, 'implementor')
  assert.equal(ingested.attempts[0].tool, 'agent-runner')
  assert.equal(ingested.attempts[0].model, 'gpt-5.6-terra')
  assert.equal(ingested.attempts[0].effort, 'high')
  assert.equal(ingested.attempts[0].requested_model, 'gpt-5.6-terra')
  assert.equal(ingested.attempts[0].identity.model_source, 'invocation')
})

test('schema-v3 metrics preserve Runner execution-session and Git attribution', () => {
  const text = JSON.stringify(metrics({
    schema_version: 3,
    sessions: [{
      execution_session_id: 'execution-1',
      started_at: '2026-09-05T12:00:00Z',
      last_observed_at: '2026-09-05T12:00:01Z',
      ended_at: '2026-09-05T12:00:01Z',
      duration_ms: 1000,
      status: 'closed',
    }],
    session_rollups: [{
      execution_session_id: 'execution-1',
      duration_ms: 1000,
      step_count: 1,
      totals: metrics().totals,
    }],
    repository_changes: { files_changed: 2, lines_added: 20, lines_deleted: 3 },
    steps: [step({
      execution_session_id: 'execution-1',
      execution_session_coverage: 'exact',
      git_changes: { files_changed: 1, lines_added: 12, lines_deleted: 2 },
    })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.source.schema_version, 3)
  assert.equal(ingested.attempts[0].execution_session_id, 'execution-1')
  assert.equal(ingested.attempts[0].execution_session_coverage, 'exact')
  assert.deepEqual(ingested.attempts[0].git_changes, {
    files_changed: 1, lines_added: 12, lines_deleted: 2,
  })
  assert.deepEqual(ingested.execution_sessions, JSON.parse(text).sessions)
  assert.deepEqual(ingested.session_rollups, JSON.parse(text).session_rollups)
  assert.deepEqual(ingested.repository_changes, {
    files_changed: 2, lines_added: 20, lines_deleted: 3,
  })
})

test('schema-v2 nested model records remain attributable to their tool-owned role', () => {
  const text = JSON.stringify(metrics({
    schema_version: 2,
    steps: [step({
      record_id: 'validator/review-1#1',
      id: 'review-1',
      kind: 'nested-agent',
      role: 'implementation-validator',
      tool: 'agent-validator',
      invocation_id: 'review-1',
      usage: {
        ...step().usage,
        identity: {
          requested_cli: 'codex',
          requested_model: 'gpt-5.6-sol',
          effective_cli: 'codex',
          effective_provider: 'openai',
          effective_model: 'gpt-5.6-sol',
          provider_source: 'adapter',
          model_source: 'invocation',
        },
      },
    })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.attempts[0].agent_role, 'implementation-validator')
  assert.equal(ingested.attempts[0].tool, 'agent-validator')
})

test('schema-v2 legacy unknown identity remains unavailable rather than becoming a model name', () => {
  const text = JSON.stringify(metrics({
    schema_version: 2,
    steps: [step({
      role: 'legacy-unknown',
      tool: 'agent-runner',
      usage: {
        ...step().usage,
        provider: '',
        model: '',
        effort: '',
        identity: {
          requested_cli: 'codex',
          requested_model: 'unknown',
          requested_effort: 'unknown',
          effective_cli: 'codex',
          effective_provider: 'unknown',
          effective_model: 'unknown',
          effective_effort: 'unknown',
          provider_source: 'legacy',
          model_source: 'legacy',
          effort_source: 'legacy',
        },
      },
    })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.attempts[0].provider, null)
  assert.equal(ingested.attempts[0].model, null)
  assert.equal(ingested.attempts[0].effort, null)
  assert.equal(ingested.attempts[0].requested_model, null)
  assert.equal(ingested.attempts[0].identity.model_source, 'legacy')
  assert.equal(ingested.coverage.effective_profile_incomplete, 1)
})

test('schema-v4 ingests authoritative native and Validator measurements without compatibility-view duplication', () => {
  const text = JSON.stringify(v4Metrics())

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.source.schema_version, 4)
  assert.equal(ingested.attempt_count, 2)
  assert.equal(ingested.dispatch_count, 2)
  assert.deepEqual(ingested.attempts.map((attempt) => attempt.attempt_id), [
    'implement-task#1', 'validator-attempt-1',
  ])
  assert.deepEqual(ingested.attempts.map((attempt) => attempt.agent_role), [
    'task-implementor', 'implementation-validator',
  ])
  assert.equal(ingested.invocations.length, 1)
  assert.equal(ingested.invocations[0].record_id, 'validator-invocation-1')
  assert.deepEqual(ingested.measurement_totals, v4Metrics().measurement_totals)
  assert.deepEqual(ingested.delivery, v4Metrics().validator_delivery)
})

test('schema-v4 preserves source versions, canonical envelopes, and billing-category uncertainty', () => {
  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(v4Metrics()), runId: RUN_ID, workflow: WORKFLOW,
  })

  const native = ingested.attempts[0]
  const validator = ingested.attempts[1]
  assert.equal(native.measurement_schema_version, 1)
  assert.equal(native.measurement_producer, 'agent-runner')
  assert.equal(native.usage.billing_tokens.input, 60)
  assert.equal(native.usage.billing_tokens.cached_input, 40)
  assert.equal(native.usage.billing_tokens.output, 50)
  assert.equal(native.cost.estimated_api_cost_usd, 0.25)
  assert.equal(validator.measurement_schema_version, 1)
  assert.equal(validator.measurement_revision, 2)
  assert.equal(validator.measurement_digest, '0'.repeat(64))
  assert.deepEqual(validator.usage.token_envelopes, canonicalTokens())
  assert.equal(validator.usage.billing_tokens, null)
  assert.equal(validator.usage.reason, null)
  assert.equal(validator.usage_source_version, 'codex-jsonl-v1')
  assert.deepEqual(validator.provider_reported_costs, validatorPayload().provider_reported_costs)
})

test('a full non-overlapping attempt cost remains authoritative beside allocation evidence', () => {
  const validator = validatorPayload({
    provider_reported_costs: [
      {
        cost_evidence_id: 'attempt-cost', scope: 'attempt',
        amount: measured(0.5),
        currency: { availability: 'available', value: 'USD', reason: null },
        coverage: 'full', overlap: 'established', source: 'provider_usage',
      },
      ...validatorPayload().provider_reported_costs,
    ],
  })
  const payload = v4Metrics({
    native_measurements: [],
    measurement_heads: [head(invocationPayload()), head(validator)],
  })

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.attempts[0].cost.state, 'available')
  assert.equal(ingested.attempts[0].cost.estimated_api_cost_usd, 0.5)
})

test('a model allocation uses resolved provider evidence when telemetry names only the model', () => {
  const validator = validatorPayload({
    resolved_identity: {
      adapter: 'codex', model: 'configured-model', provider: 'openai', effort: 'high',
      provenance: 'launch_resolution',
    },
    observed_identities: [{
      ...identity('model-a', 'identity-a'),
      provider: { availability: 'unavailable', value: null, reason: 'not_reported' },
    }],
    allocations: [{
      allocation_id: 'allocation-a', observed_identity_ref: 'identity-a',
      usage: { normalized_total: measured(150) },
    }],
    unallocated_usage: null,
    completeness: {
      collection: 'complete', canonical_fields: 'partial', normalized_total: 'complete',
      per_model_attribution: 'complete', history: 'complete',
    },
  })
  const payload = v4Metrics({
    native_measurements: [],
    measurement_heads: [head(invocationPayload()), head(validator)],
  })

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.attempts[0].allocations[0].provider, 'openai')
  assert.equal(ingested.attempts[0].allocations[0].model, 'model-a')
  assert.equal(ingested.attempts[0].identity.observed[0].provider, null)
})

test('schema-v4 keeps one dispatch with attributed and unallocated model usage', () => {
  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(v4Metrics({ native_measurements: [], steps: [v4Metrics().steps[1]] })),
    runId: RUN_ID,
    workflow: WORKFLOW,
  })

  const [attempt] = ingested.attempts
  assert.equal(attempt.model, null)
  assert.equal(attempt.identity.per_model_attribution, 'partial')
  assert.equal(attempt.allocations.length, 1)
  assert.equal(attempt.allocations[0].allocation_id, 'allocation-a')
  assert.equal(attempt.allocations[0].model, 'model-a')
  assert.equal(attempt.unallocated_usage.allocation_id, 'allocation-unallocated')
  assert.equal(ingested.dispatch_count, 1)
})

test('partial attempt envelopes remain partial in a fallback unallocated row', () => {
  const validator = validatorPayload({
    tokens: canonicalTokens({
      input_total: measured(100, { availability: 'partial', reason: 'truncated' }),
      output: measured(50, { availability: 'partial', reason: 'truncated' }),
      normalized_total: measured(150, { availability: 'partial', reason: 'truncated' }),
    }),
    allocations: [],
    unallocated_usage: null,
    completeness: {
      collection: 'partial', canonical_fields: 'partial', normalized_total: 'partial',
      per_model_attribution: 'unavailable', history: 'complete',
    },
  })
  const payload = v4Metrics({
    native_measurements: [],
    measurement_heads: [head(invocationPayload()), head(validator)],
  })

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.attempts[0].unallocated_usage.usage.state, 'partial')
})

test('schema-v4 preserves a failed Validator dispatch as measured work', () => {
  const failed = validatorPayload({
    outcome: 'failed',
    lifecycle: {
      state: 'failed',
      started_at: '2026-09-08T12:00:00Z',
      ended_at: '2026-09-08T12:00:02Z',
    },
  })
  const payload = v4Metrics({
    native_measurements: [],
    measurement_heads: [head(invocationPayload()), head(failed)],
  })

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.dispatch_count, 1)
  assert.equal(ingested.attempts[0].outcome, 'failed')
  assert.equal(ingested.attempts[0].lifecycle.state, 'failed')
  assert.equal(ingested.attempts[0].duration_ms, 2000)
})

test('schema-v4 preserves a confirmed zero-dispatch invocation without fabricating an attempt', () => {
  const invocation = invocationPayload({ attempt_ids: [], zero_dispatch: true })
  const payload = v4Metrics({
    native_measurements: [],
    measurement_heads: [head(invocation)],
    measurement_totals: {},
  })

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.dispatch_count, 0)
  assert.equal(ingested.invocations.length, 1)
  assert.equal(ingested.invocations[0].payload.zero_dispatch, true)
})

test('schema-v4 delivery gaps and incomplete collection prevent complete metrics', () => {
  const payload = v4Metrics({
    validator_delivery: {
      history_coverage: 'complete', collection: 'partial', delivery: 'partial',
      gaps: ['batch_pending'],
    },
  })
  payload.validator_contexts[0] = {
    ...payload.validator_contexts[0], delivery: 'partial', collection: 'partial',
    scope_complete: false, gaps: ['batch_pending'],
  }

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.complete, false)
  assert.equal(ingested.delivery_complete, false)
  assert.deepEqual(ingested.coverage.delivery_gaps, ['batch_pending'])
})

test('schema-v4 rejects unsupported nested measurement versions instead of using compatibility steps', () => {
  const payload = v4Metrics()
  payload.measurement_heads[1].record.measurement_schema_version = 2
  payload.measurement_heads[1].record.payload.measurement_schema_version = 2

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.state, 'rejected')
  assert.match(ingested.reason, /measurement schema version 2/)
  assert.equal(ingested.attempt_count, 0)
})

test('schema-v4 rejects unknown fields instead of silently dropping new meanings', () => {
  const payload = v4Metrics({ future_measurement_semantics: true })

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.state, 'rejected')
  assert.match(ingested.reason, /future_measurement_semantics/)
})

test('schema-v4 rejects unknown nested measurement fields', () => {
  const payload = v4Metrics()
  payload.measurement_heads[1].record.payload.lifecycle.future_state_detail = 'new-semantics'

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.state, 'rejected')
  assert.match(ingested.reason, /future_state_detail/)
})

test('the pinned Validator multi-model fixture remains ingestible through Runner schema v4', async () => {
  const fixturePath = new URL(
    '../evals/agent-runner/and-scene/contracts/model-metrics/v1/fixtures/two-model-allocation-cost.json',
    import.meta.url,
  )
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
  const producerAttempt = {
    ...fixture.records[0],
    consumer_context: { consumer: 'agent-runner', context_id: 'context-1' },
  }
  const payload = v4Metrics({
    native_measurements: [],
    measurement_heads: [head(invocationPayload({
      invocation_id: producerAttempt.invocation_id,
      session_id: producerAttempt.session_id,
      attempt_ids: [producerAttempt.attempt_id],
    })), head(producerAttempt)],
    measurement_totals: {
      normalized_total: {
        known_subtotal: 150, availability: 'available', precision: 'exact',
        contributing_attempts: 1, partial_attempts: 0, missing_attempts: 0,
      },
    },
  })

  const ingested = ingestRunnerMetrics({
    text: JSON.stringify(payload), runId: RUN_ID, workflow: WORKFLOW,
  })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.dispatch_count, 1)
  assert.equal(ingested.attempts[0].allocations[0].model, 'A')
  assert.equal(
    ingested.attempts[0].unallocated_usage.usage.token_envelopes.normalized_total.value,
    50,
  )
  assert.equal(ingested.attempts[0].allocations[0].usage.token_totals.total, 100)
  assert.equal(ingested.attempts[0].unallocated_usage.usage.token_totals.total, 50)
  assert.equal(ingested.attempts[0].cost.state, 'unavailable')
})

test('an unsupported schema version is rejected', () => {
  const text = JSON.stringify(metrics({ schema_version: 5 }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'rejected')
  assert.match(ingested.reason, /schema/)
})

test('unreadable metrics are rejected rather than reconstructed', () => {
  const ingested = ingestRunnerMetrics({ text: 'not json', runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'rejected')
  assert.equal(ingested.attempts.length, 0)
  assert.equal(ingested.history_complete, null)
})

test('an invoked agent step without effective model evidence stays explicit and incomplete', () => {
  const text = JSON.stringify(metrics({ steps: [step({ usage: { ...step().usage, model: null } })] }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.attempts[0].model, null)
  assert.equal(ingested.coverage.effective_profile_incomplete, 1)
})

test('a non-CLI step may report no provider or model and still be ingested', () => {
  const text = JSON.stringify(metrics({
    steps: [step({
      record_id: 'shell#1',
      id: 'build',
      type: 'shell',
      agent_invoked: false,
      session_id: '',
      usage: null,
      estimated_api_cost_usd: null,
    })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.attempts[0].invoked_cli, false)
})

test('duplicate attempt identifiers are rejected rather than silently collapsed', () => {
  const text = JSON.stringify(metrics({
    steps: [step({ record_id: 'implement-task#1' }), step({ record_id: 'implement-task#1' })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  // Costs are resolved per attempt id. Two attempts sharing one id would have
  // a single resolution counted twice, silently inflating the total.
  assert.equal(ingested.state, 'rejected')
  assert.equal(ingested.attempts.length, 0)
  assert.match(ingested.reason, /implement-task#1/)
})

test('resumed attempts are retained alongside the earlier ones', () => {
  const text = JSON.stringify(metrics({
    steps: [
      step({ record_id: 'implement-task#1', session_id: 'session-1' }),
      step({ record_id: 'implement-task#2', session_id: 'session-2' }),
    ],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.attempts.length, 2)
  assert.deepEqual(ingested.attempts.map((entry) => entry.session), ['session-1', 'session-2'])
  assert.deepEqual(ingested.sessions, ['session-1', 'session-2'])
})

test('Runner-owned acceptance-tester calls are attributed to the acceptance-reviewer profile', () => {
  const text = JSON.stringify(metrics({
    steps: [step({
      record_id: 'prepare-acceptance/acceptance-tester#1',
      id: 'acceptance-tester',
      kind: 'agent-call',
      target_name: 'acceptance-tester',
    })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.attempts[0].agent_role, 'acceptance-reviewer')
})

test('task-loop position attributes validator remediation to the implementor but not final validation', () => {
  const text = JSON.stringify(metrics({
    steps: [
      step({ id: 'fix-violations', prefix: 'implement-tasks:0/implement-single-task/sub:implement-task/run-validator/sub:run-validator' }),
      step({ record_id: 'final-fix#1', id: 'fix-violations', prefix: 'run-validator/sub:run-validator' }),
    ],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.deepEqual(ingested.attempts.map((attempt) => attempt.agent_role), ['task-implementor', 'lead-agent'])
})

// Agent Runner renders a loop iteration as `<step-id>:<n>` and joins nesting
// segments with `/` (internal/exec/step_audit.go, executionIdentityPrefix).
// Attribution must key on that emitted form, not on a bracketed one.
test('a real Agent Runner loop-iteration prefix attributes task work to the implementor', () => {
  const text = JSON.stringify(metrics({
    steps: [
      step({ prefix: 'implement-tasks:0/implement-single-task/sub:implement-task' }),
      step({
        record_id: 'task-fix#1',
        id: 'fix-violations',
        prefix: 'implement-tasks:0/implement-single-task/sub:implement-task/run-validator/sub:run-validator/validator-retry:0',
      }),
      step({
        record_id: 'final-fix#1',
        id: 'fix-violations',
        prefix: 'run-validator/sub:run-validator/validator-retry:0',
      }),
    ],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.deepEqual(
    ingested.attempts.map((attempt) => attempt.agent_role),
    ['task-implementor', 'task-implementor', 'lead-agent'],
  )
})

test('incomplete Runner history is preserved rather than presented as complete', () => {
  const text = JSON.stringify(metrics({ history_complete: false }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.history_complete, false)
  assert.equal(ingested.complete, false)
})

test('reading preserves the source artifact copy, path, and hash', async () => {
  const text = JSON.stringify(metrics(), null, 2)
  const dir = await sessionDir(text)

  const ingested = await readRunnerMetrics({ sessionDir: dir, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.source.path, join(dir, RUNNER_METRICS_FILENAME))
  assert.equal(ingested.source.sha256, hashString(text))
  assert.equal(ingested.source.text, text)
})

test('a missing metrics artifact marks implementation metrics incomplete', async () => {
  const dir = await sessionDir(null)

  const ingested = await readRunnerMetrics({ sessionDir: dir, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'rejected')
  assert.equal(ingested.complete, false)
  assert.match(ingested.reason, /not found/)
})

test('no recorded session directory leaves metrics unavailable', async () => {
  const ingested = await readRunnerMetrics({ sessionDir: null, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'rejected')
  assert.equal(ingested.attempts.length, 0)
})
