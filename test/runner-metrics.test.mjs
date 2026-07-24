import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import {
  RUNNER_METRICS_FILENAME,
  RUNNER_METRICS_SCHEMA_VERSION,
  ingestRunnerMetrics,
  readRunnerMetrics,
} from '../evals/agent-runner/and-scene/lib/runner-metrics.mjs'

const RUN_ID = 'run-7f3a'
const WORKFLOW = 'implement-change2'

function step(overrides = {}) {
  return {
    record_id: 'implement-task#1',
    prefix: 'implement-tasks[0]/implement-single-task',
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
    schema_version: RUNNER_METRICS_SCHEMA_VERSION,
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
  const text = JSON.stringify(metrics({ workflow: 'implement-change' }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'rejected')
  assert.match(ingested.reason, /implement-change/)
})

test('an unsupported schema version is rejected', () => {
  const text = JSON.stringify(metrics({ schema_version: 2 }))

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
