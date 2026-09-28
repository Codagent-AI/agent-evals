import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveBillingTokens, refreshBillingTokens } from '../evals/agent-runner/and-scene/lib/runner-metrics.mjs'
import { calculateRateCost, loadFallbackRates, lookupFallbackRate, resolveAttemptCost, validateFallbackRates } from '../evals/agent-runner/and-scene/lib/pricing.mjs'
import { aggregateImplementationCost } from '../evals/agent-runner/and-scene/lib/cost.mjs'

const available = (value) => ({ availability: 'available', value })
const missing = (reason) => ({ availability: 'unavailable', reason })
const envelopes = {
  input_total: available(1_643_996), input_uncached: missing('not_reported'),
  cache_read: available(1_569_792), cache_write: missing('not_reported'), output: available(15_013),
  normalized_total: available(1_659_009),
}
const table = await loadFallbackRates()

test('checked-in fallback is valid and exact-match only', () => {
  assert.equal(table.state, 'available')
  assert.equal(table.rows.length, 3)
  assert.equal(lookupFallbackRate(table, 'openai', 'gpt-6-luna')?.row.model, 'gpt-6-luna')
  assert.equal(lookupFallbackRate(table, 'openai', 'gpt-6-lun'), null)
  assert.throws(() => validateFallbackRates({ schema_version: 1, rows: [...table.rows, table.rows[0]] }), /duplicate/)
})

test('Codex billing derivation preserves the cache-write assumption and collection gate', () => {
  const billing = deriveBillingTokens(envelopes, 'codex:turn.completed', { collectionComplete: true })
  assert.deepEqual(billing.billing_tokens, { input: 74204, cached_input: 1569792, output: 15013 })
  assert.deepEqual(billing.billing_assumptions, ['cache_write_not_reported_priced_as_input'])
  assert.equal(billing.billing_derivation.cache_write_reason, 'not_reported')
  assert.equal(deriveBillingTokens(envelopes, 'other', { collectionComplete: true }).billing_tokens, null)
  assert.match(deriveBillingTokens(envelopes, 'codex:turn.completed', { collectionComplete: false, reason: 'lost' }).billing_reason, /lost/)
  assert.equal(deriveBillingTokens({ ...envelopes, cache_read: available(2_000_000) }, 'codex:turn.completed', { collectionComplete: true }).billing_tokens, null)
  assert.equal(deriveBillingTokens({ ...envelopes, cache_write: missing('codex_usage_not_observed') }, 'codex-exec-jsonl-turn.completed', { collectionComplete: true }).billing_tokens.input, 74204)
  assert.equal(deriveBillingTokens({ ...envelopes, cache_write: missing('other') }, 'codex:turn.completed', { collectionComplete: true }).billing_tokens, null)
})

test('Codex sample estimates at exact rates and reprices retained envelopes', async () => {
  const attempt = { attempt_id: 'sample', invoked_cli: true, step: 'generate-code', prefix: 'implement-tasks:0/sub',
    agent_role: 'implementor', cli: 'codex', provider: 'openai', model: 'gpt-6-luna',
    usage_source: 'codex:turn.completed', usage: { state: 'available', token_envelopes: envelopes, billing_tokens: null },
    cost: { state: 'unavailable' }, allocations: [], unallocated_usage: null }
  refreshBillingTokens([attempt])
  const catalog = { state: 'available', url: 'https://models.dev/api.json', retrieved_at: '2026-09-27', sha256: 'hash',
    entries: { openai: { models: { 'gpt-6-luna': { cost: table.rows[0].rates } } } } }
  const priced = await resolveAttemptCost({ attempt, catalog, fallbackTable: table, invoke: null })
  assert.equal(priced.amount_usd, 0.03062482)
  assert.equal(priced.verification, 'estimated')
  assert.deepEqual(priced.provenance.assumptions, ['cache_write_not_reported_priced_as_input', 'context_tier_unknown_priced_at_base'])
  const cost = aggregateImplementationCost({ attempts: [attempt], costs: [priced] })
  assert.equal(cost.rows[0].cost.amount_usd, priced.amount_usd)
  assert.equal(cost.step_rollup[0].top_level_step, 'implement-tasks')
  assert.equal(cost.step_rollup[0].amount_usd, cost.total.estimated_api_cost_usd)
  const fallback = await resolveAttemptCost({ attempt, catalog: null, fallbackTable: table, invoke: null })
  assert.equal(fallback.source, 'fallback-table')
})

test('context tiers use bounds without choosing conflicting thresholds', () => {
  const rates = table.rows[0].rates
  const tokens = { input: 1000 }
  assert.equal(calculateRateCost({ cost: rates, tokens, promptBounds: { upper: 100000 } }).context_tier.basis, 'within_lowest')
  assert.equal(calculateRateCost({ cost: rates, tokens, promptBounds: { lower: 300000 } }).context_tier.basis, 'above_highest')
  assert.equal(calculateRateCost({ cost: rates, tokens, promptBounds: { lower: 240000 } }).context_tier.basis, 'ambiguous')
})

test('unresolved attempt leaves step amount unavailable with known subtotal', () => {
  const attempts = ['a', 'b'].map((id) => ({ attempt_id: id, invoked_cli: true, prefix: 'run-validator/sub', step: 'fix', usage: {} }))
  const costs = [{ attempt_id: 'a', state: 'resolved', amount_usd: 2, known_subtotal_usd: 2, verification: 'estimated' },
    { attempt_id: 'b', state: 'unavailable', known_subtotal_usd: 0, reason: 'identity missing' }]
  const result = aggregateImplementationCost({ attempts, costs })
  assert.equal(result.step_rollup[0].amount_usd, null)
  assert.equal(result.step_rollup[0].known_subtotal_usd, 2)
  assert.equal(result.step_rollup[0].verification, 'estimated')
})

test('retained result replay prices Runner Codex and keeps Validator gaps', async () => {
  const { readFile } = await import('node:fs/promises')
  const { resolveImplementationPricing } = await import('../evals/agent-runner/and-scene/lib/pricing.mjs')
  const fixture = JSON.parse(await readFile(new URL('./fixtures/feature-43-retained-attempts.json', import.meta.url)))
  const entries = JSON.parse(await readFile(new URL('./fixtures/feature-43-catalog.json', import.meta.url)))
  const attempts = refreshBillingTokens(fixture.attempts)
  const pricing = await resolveImplementationPricing({ attempts,
    catalog: { state: 'available', url: 'https://models.dev/api.json', retrieved_at: '2026-09-27', sha256: 'fixture', entries },
    fallbackTable: table, invoke: null })
  const runnerCodex = pricing.costs.filter((cost) => attempts.find((attempt) => attempt.attempt_id === cost.attempt_id)?.usage_source === 'codex:turn.completed')
  assert.equal(runnerCodex.length, 11)
  assert.ok(runnerCodex.every((cost) => cost.state === 'resolved' && cost.source === 'models.dev' && cost.verification === 'estimated'))
  const validators = pricing.costs.filter((cost) => attempts.find((attempt) => attempt.attempt_id === cost.attempt_id)?.usage_source === 'agent-validator:metrics')
  assert.equal(validators.length, 16)
  assert.ok(validators.every((cost) => cost.state === 'unavailable' && /exact provider and model identity/.test(cost.reason)))
  const claude = pricing.costs.filter((cost) => attempts.find((attempt) => attempt.attempt_id === cost.attempt_id)?.usage_source === 'claude:result-event')
  assert.ok(claude.every((cost) => cost.state === 'resolved' && cost.verification === 'reported'))
  const cost = aggregateImplementationCost({ attempts, costs: pricing.costs })
  assert.equal(cost.total.state, 'unavailable')
  assert.ok(cost.total.known_cost_subtotal_usd > 0)
  assert.equal(cost.steps.length, 33)
  assert.equal(cost.step_rollup.reduce((sum, row) => sum + row.attempt_count, 0), 33)
})

test('multi-model reported attempt keeps model usage and one undivided cost row', () => {
  const attempts = [{ attempt_id: 'mixed', invoked_cli: true, step: 'deliver', agent_role: 'lead',
    usage: { state: 'available' }, allocations: [
      { allocation_id: 'one', provider: 'openai', model: 'gpt-6-luna', usage: { state: 'available', tokens: { input: 1 } } },
      { allocation_id: 'two', provider: 'anthropic', model: 'claude-opus-5-5', usage: { state: 'available', tokens: { output: 2 } } },
    ] }]
  const costs = [{ attempt_id: 'mixed', state: 'resolved', amount_usd: 3, known_subtotal_usd: 3,
    source: 'agent-runner-reported', verification: 'reported', allocation_costs: [] }]
  const result = aggregateImplementationCost({ attempts, costs })
  assert.equal(result.rows.filter((row) => row.cost.state === 'not_allocated').length, 2)
  assert.equal(result.rows.find((row) => row.allocation === 'unattributed_cost').cost.amount_usd, 3)
  assert.equal(result.rows.reduce((sum, row) => sum + (row.cost.amount_usd ?? 0), 0), result.total.estimated_api_cost_usd)
  assert.equal(result.steps.length, 1)
})

test('historical result and new step schedule both render safely', async () => {
  const { readFile } = await import('node:fs/promises')
  const { renderReport } = await import('../evals/agent-runner/and-scene/lib/report.mjs')
  const historical = JSON.parse(await readFile(new URL('../evals/agent-runner/and-scene/results/d7f384ba-0e94-4926-852e-6662fec752be-rep-1/result.json', import.meta.url)))
  const oldHtml = renderReport(historical, { current: historical })
  assert.match(oldHtml, /Per-step cost was not recorded for this result/)
  const cost = aggregateImplementationCost({ attempts: [{ attempt_id: 'a', invoked_cli: true, step: '<script>',
    agent_role: 'lead', provider: 'openai', model: 'gpt-6-luna', usage: { state: 'available' } }],
    costs: [{ attempt_id: 'a', state: 'resolved', amount_usd: 1, known_subtotal_usd: 1, source: 'models.dev',
      verification: 'estimated', provenance: { assumptions: ['cache_write_not_reported_priced_as_input'] } }] })
  const current = { ...historical, cost, pricing: { complete: true, costs: [{ secret: 'raw-pricing-marker' }],
    verification: 'estimated', includes_estimated: true, catalog: { state: 'available', sha256: 'hash' } } }
  const html = renderReport(current, { current })
  assert.match(html, /Per-step cost/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /raw-pricing-marker/)
})

test('complete retained attempt pricing reconciles rows, steps, and total', async () => {
  const { readFile } = await import('node:fs/promises')
  const { resolveImplementationPricing } = await import('../evals/agent-runner/and-scene/lib/pricing.mjs')
  const fixture = JSON.parse(await readFile(new URL('./fixtures/feature-43-retained-attempts.json', import.meta.url)))
  const entries = JSON.parse(await readFile(new URL('./fixtures/feature-43-catalog.json', import.meta.url)))
  const attempts = refreshBillingTokens(fixture.attempts)
  for (const attempt of attempts.filter((entry) => entry.usage_source === 'agent-validator:metrics')) {
    attempt.provider = 'openai'; attempt.model = 'gpt-6-luna'
  }
  const pricing = await resolveImplementationPricing({ attempts,
    catalog: { state: 'available', url: 'https://models.dev/api.json', retrieved_at: '2026-09-27', sha256: 'fixture', entries },
    fallbackTable: table, invoke: null })
  assert.equal(pricing.complete, true)
  assert.equal(pricing.verified, false)
  assert.equal(pricing.verification, 'estimated')
  const cost = aggregateImplementationCost({ attempts, costs: pricing.costs })
  const total = cost.total.estimated_api_cost_usd
  assert.equal(cost.total.complete, true)
  assert.ok(Math.abs(cost.rows.reduce((sum, row) => sum + (row.cost.amount_usd ?? 0), 0) - total) < 1e-9)
  assert.ok(Math.abs(cost.step_rollup.reduce((sum, row) => sum + row.amount_usd, 0) - total) < 1e-9)
})
