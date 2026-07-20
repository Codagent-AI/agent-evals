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

function attempt(overrides = {}) {
  return {
    attempt_id: 'implement-task#1',
    step: 'implement-task',
    agent_role: 'task-implementor',
    invoked_cli: true,
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-5-codex',
    usage_source: 'codex-json',
    usage_source_version: '0.4.0',
    session: 'session-1',
    duration_ms: 1200,
    usage: {
      state: 'available',
      reason: null,
      tokens: { input: 1000, cached_input: 200, output: 300, reasoning_output: 50 },
    },
    cost: { state: 'available', reason: null, estimated_api_cost_usd: 0.0125 },
    ...overrides,
  }
}

function metrics(overrides = {}) {
  return {
    schema_version: RUNNER_METRICS_SCHEMA_VERSION,
    run_id: RUN_ID,
    workflow: WORKFLOW,
    history_complete: true,
    attempts: [attempt()],
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
    input: 1000,
    cached_input: 200,
    output: 300,
    reasoning_output: 50,
  })
  assert.equal(ingested.attempts[0].cost.estimated_api_cost_usd, 0.0125)
  assert.equal(ingested.attempts[0].duration_ms, 1200)
})

test('the reported implementation active duration is preserved', () => {
  const withDuration = ingestRunnerMetrics({
    text: JSON.stringify(metrics({ active_duration_ms: 45_000 })),
    runId: RUN_ID,
    workflow: WORKFLOW,
  })
  const without = ingestRunnerMetrics({ text: JSON.stringify(metrics()), runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(withDuration.active_duration_ms, 45_000)
  // Unmeasured stays unmeasured: a zero would read as an instant workflow.
  assert.equal(without.active_duration_ms, null)
})

test('an unavailable usage or cost keeps its reason and never becomes zero', () => {
  const text = JSON.stringify(metrics({
    attempts: [attempt({
      usage: { state: 'unavailable', reason: 'cli reported no usage', tokens: null },
      cost: { state: 'unavailable', reason: 'no pricing catalog entry', estimated_api_cost_usd: null },
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

test('an attempt without provider or model identity is rejected', () => {
  const text = JSON.stringify(metrics({ attempts: [attempt({ model: null })] }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'rejected')
  assert.match(ingested.reason, /model/)
})

test('a non-CLI step may report no provider or model and still be ingested', () => {
  const text = JSON.stringify(metrics({
    attempts: [attempt({
      attempt_id: 'shell#1',
      step: 'build',
      agent_role: null,
      invoked_cli: false,
      cli: null,
      provider: null,
      model: null,
      usage: { state: 'not-applicable', reason: 'shell step', tokens: null },
      cost: { state: 'not-applicable', reason: 'shell step', estimated_api_cost_usd: null },
    })],
  }))

  const ingested = ingestRunnerMetrics({ text, runId: RUN_ID, workflow: WORKFLOW })

  assert.equal(ingested.state, 'ingested')
  assert.equal(ingested.attempts[0].invoked_cli, false)
})

test('resumed attempts are retained alongside the earlier ones', () => {
  const text = JSON.stringify(metrics({
    attempts: [
      attempt({ attempt_id: 'implement-task#1', session: 'session-1' }),
      attempt({ attempt_id: 'implement-task#2', session: 'session-2' }),
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
