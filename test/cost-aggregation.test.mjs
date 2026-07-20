import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  aggregateImplementationCost,
  summarizeEvalOwnedUsage,
} from '../evals/agent-runner/and-scene/lib/cost.mjs'

function attempt(overrides = {}) {
  return {
    attempt_id: 'implement-task#1',
    step: 'implement-task',
    agent_role: 'task-implementor',
    invoked_cli: true,
    provider: 'openai',
    model: 'gpt-5-codex',
    usage: { state: 'available', reason: null, tokens: { input: 1000, output: 200 } },
    cost: { state: 'available', reason: null, estimated_api_cost_usd: 0.01 },
    ...overrides,
  }
}

function resolved(attemptId, amount, overrides = {}) {
  return {
    attempt_id: attemptId,
    state: 'resolved',
    amount_usd: amount,
    source: 'agent-runner-reported',
    verification: 'reported',
    reason: null,
    ...overrides,
  }
}

test('retries of one role and model collapse into a single aggregate row', () => {
  const attempts = [
    attempt({ attempt_id: 'a1' }),
    attempt({ attempt_id: 'a2', usage: { state: 'available', reason: null, tokens: { input: 500, output: 100 } } }),
  ]
  const costs = [resolved('a1', 0.01), resolved('a2', 0.02)]

  const { rows, total } = aggregateImplementationCost({ attempts, costs })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].agent_role, 'task-implementor')
  assert.equal(rows[0].attempt_count, 2)
  assert.deepEqual(rows[0].tokens, { input: 1500, output: 300 })
  assert.equal(rows[0].cost.amount_usd, 0.03)
  assert.equal(total.estimated_api_cost_usd, 0.03)
})

test('one role using different models yields one row per provider and model', () => {
  const attempts = [
    attempt({ attempt_id: 'a1', model: 'gpt-5-codex' }),
    attempt({ attempt_id: 'a2', model: 'gpt-5-codex-mini' }),
  ]
  const costs = [resolved('a1', 0.01), resolved('a2', 0.002)]

  const { rows } = aggregateImplementationCost({ attempts, costs })

  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.model).sort(), ['gpt-5-codex', 'gpt-5-codex-mini'])
  assert.ok(rows.every((row) => row.attempt_count === 1))
})

test('the same model under different roles stays in separate rows', () => {
  const attempts = [
    attempt({ attempt_id: 'a1', agent_role: 'lead-agent' }),
    attempt({ attempt_id: 'a2', agent_role: 'task-implementor' }),
  ]
  const costs = [resolved('a1', 0.01), resolved('a2', 0.01)]

  const { rows } = aggregateImplementationCost({ attempts, costs })

  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.agent_role).sort(), ['lead-agent', 'task-implementor'])
})

test('a fully resolved run reports the sum of every row as the total', () => {
  const attempts = [
    attempt({ attempt_id: 'a1', agent_role: 'lead-agent' }),
    attempt({ attempt_id: 'a2' }),
  ]
  const costs = [resolved('a1', 0.25), resolved('a2', 0.75)]

  const { total } = aggregateImplementationCost({ attempts, costs })

  assert.equal(total.state, 'available')
  assert.equal(total.estimated_api_cost_usd, 1)
  assert.equal(total.known_cost_subtotal_usd, 1)
  assert.equal(total.complete, true)
  assert.deepEqual(total.unresolved_attempts, [])
})

test('one unresolved attempt leaves the total unavailable with a known subtotal', () => {
  const attempts = [
    attempt({ attempt_id: 'a1', agent_role: 'lead-agent' }),
    attempt({ attempt_id: 'a2' }),
  ]
  const costs = [
    resolved('a1', 0.25),
    { attempt_id: 'a2', state: 'unavailable', amount_usd: null, source: null, verification: null, reason: 'no exact match' },
  ]

  const { rows, total } = aggregateImplementationCost({ attempts, costs })

  assert.equal(total.state, 'unavailable')
  assert.equal(total.estimated_api_cost_usd, null)
  assert.equal(total.known_cost_subtotal_usd, 0.25)
  assert.equal(total.complete, false)
  assert.deepEqual(total.unresolved_attempts, ['a2'])
  const unresolvedRow = rows.find((row) => row.agent_role === 'task-implementor')
  assert.equal(unresolvedRow.cost.state, 'incomplete')
  assert.equal(unresolvedRow.complete, false)
})

test('an attempt with no resolution at all counts as unresolved', () => {
  const attempts = [attempt({ attempt_id: 'a1' })]

  const { total } = aggregateImplementationCost({ attempts, costs: [] })

  assert.equal(total.state, 'unavailable')
  assert.deepEqual(total.unresolved_attempts, ['a1'])
})

test('unavailable usage keeps the row token totals incomplete without zero-filling', () => {
  const attempts = [
    attempt({ attempt_id: 'a1' }),
    attempt({
      attempt_id: 'a2',
      usage: { state: 'unavailable', reason: 'cli reported no usage', tokens: null },
    }),
  ]
  const costs = [resolved('a1', 0.01), resolved('a2', 0.02)]

  const { rows } = aggregateImplementationCost({ attempts, costs })

  assert.deepEqual(rows[0].tokens, { input: 1000, output: 200 })
  assert.equal(rows[0].usage_complete, false)
  assert.equal(rows[0].attempts_missing_usage, 1)
  assert.equal(rows[0].cost.amount_usd, 0.03)
})

test('a row with no measured usage reports null tokens rather than zeros', () => {
  const attempts = [attempt({
    attempt_id: 'a1',
    usage: { state: 'unavailable', reason: 'cli reported no usage', tokens: null },
  })]

  const { rows } = aggregateImplementationCost({ attempts, costs: [resolved('a1', 0.01)] })

  assert.equal(rows[0].tokens, null)
  assert.deepEqual(rows[0].token_categories, [])
})

test('a judge-found rate marks its row unverified but still contributes', () => {
  const attempts = [attempt({ attempt_id: 'a1' })]
  const costs = [resolved('a1', 0.02, { source: 'judge-web-search', verification: 'unverified' })]

  const { rows, total } = aggregateImplementationCost({ attempts, costs })

  assert.equal(rows[0].verification, 'unverified')
  assert.deepEqual(rows[0].cost.sources, ['judge-web-search'])
  assert.equal(total.estimated_api_cost_usd, 0.02)
})

test('steps that never invoked a CLI are excluded from cost aggregation', () => {
  const attempts = [
    attempt({ attempt_id: 'a1' }),
    attempt({
      attempt_id: 'shell#1',
      agent_role: null,
      invoked_cli: false,
      provider: null,
      model: null,
      usage: { state: 'not-applicable', reason: 'shell step', tokens: null },
      cost: { state: 'not-applicable', reason: 'shell step', estimated_api_cost_usd: null },
    }),
  ]

  const { rows, total } = aggregateImplementationCost({ attempts, costs: [resolved('a1', 0.01)] })

  assert.equal(rows.length, 1)
  assert.equal(total.state, 'available')
  assert.equal(total.estimated_api_cost_usd, 0.01)
})

test('an incomplete attempt history cannot produce a numeric total', () => {
  const { total } = aggregateImplementationCost({
    attempts: [attempt({ attempt_id: 'a1' })],
    costs: [resolved('a1', 0.01)],
    attemptsComplete: false,
  })

  assert.equal(total.state, 'unavailable')
  assert.equal(total.estimated_api_cost_usd, null)
  assert.equal(total.known_cost_subtotal_usd, 0.01)
  assert.equal(total.complete, false)
  assert.match(total.reason, /attempt history/)
})

test('rejected metrics yield an unavailable total rather than zero', () => {
  const { rows, total } = aggregateImplementationCost({ attempts: [], costs: [], attemptsComplete: false })

  assert.deepEqual(rows, [])
  assert.equal(total.state, 'unavailable')
  assert.equal(total.estimated_api_cost_usd, null)
  assert.equal(total.known_cost_subtotal_usd, 0)
})

test('eval-owned usage is reported diagnostically and never priced', () => {
  const summary = summarizeEvalOwnedUsage([
    { phase: 'product-judging', provider: 'openai', model: 'gpt-5', tokens: { input: 900, output: 120 } },
    { phase: 'ambiguity-diagnostics', provider: 'openai', model: 'gpt-5', tokens: { input: 100, output: 30 } },
  ])

  assert.equal(summary.priced, false)
  assert.equal(summary.included_in_implementation_total, false)
  assert.deepEqual(summary.tokens, { input: 1000, output: 150 })
  assert.deepEqual(summary.by_phase.map((entry) => entry.phase), ['product-judging', 'ambiguity-diagnostics'])
})

test('absent eval-owned usage is unavailable rather than zero', () => {
  const summary = summarizeEvalOwnedUsage([])

  assert.equal(summary.tokens, null)
  assert.equal(summary.state, 'unavailable')
})

test('cost aggregation carries no scoring effect', () => {
  const { scoring_effect: effect } = aggregateImplementationCost({
    attempts: [attempt({ attempt_id: 'a1' })],
    costs: [resolved('a1', 0.01)],
  })

  assert.equal(effect, 'none')
})
