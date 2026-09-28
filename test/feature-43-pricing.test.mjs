import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { deriveBillingTokens, refreshBillingTokens } from '../evals/agent-runner/and-scene/lib/runner-metrics.mjs'
import {
  calculateRateCost,
  loadFallbackRates,
  lookupFallbackRate,
  resolveAttemptCost,
  resolveImplementationPricing,
  validateFallbackRates,
} from '../evals/agent-runner/and-scene/lib/pricing.mjs'
import { aggregateImplementationCost } from '../evals/agent-runner/and-scene/lib/cost.mjs'
import { renderReport } from '../evals/agent-runner/and-scene/lib/report.mjs'

const readJson = async (relativePath) => JSON.parse(await readFile(new URL(relativePath, import.meta.url)))

const available = (value) => ({ availability: 'available', value })
const missing = (reason) => ({ availability: 'unavailable', reason })
const envelopes = {
  input_total: available(1_643_996), input_uncached: missing('not_reported'),
  cache_read: available(1_569_792), cache_write: missing('not_reported'), output: available(15_013),
  normalized_total: available(1_659_009),
}
const table = await loadFallbackRates()

// The trimmed d7f384ba-…-rep-1 attempts with billing re-derived from their
// retained envelopes, and the pinned models.dev excerpt.
async function loadRetainedAttempts() {
  const fixture = await readJson('./fixtures/feature-43-retained-attempts.json')
  const entries = await readJson('./fixtures/feature-43-catalog.json')
  return {
    attempts: refreshBillingTokens(fixture.attempts),
    catalog: { state: 'available', url: 'https://models.dev/api.json', retrieved_at: '2026-09-27', sha256: 'fixture', entries },
  }
}

function costsFromSource(pricing, attempts, usageSource) {
  const ids = new Set(attempts.filter((attempt) => attempt.usage_source === usageSource).map((attempt) => attempt.attempt_id))
  return pricing.costs.filter((cost) => ids.has(cost.attempt_id))
}

test('checked-in fallback is valid and exact-match only', () => {
  assert.equal(table.state, 'available')
  assert.equal(table.rows.length, 4)
  assert.equal(lookupFallbackRate(table, 'openai', 'gpt-6-luna')?.row.model, 'gpt-6-luna')
  assert.equal(lookupFallbackRate(table, 'openai', 'gpt-6-astra')?.row.model, 'gpt-6-astra')
  assert.equal(lookupFallbackRate(table, 'openai', 'gpt-6-lun'), null)
  assert.throws(() => validateFallbackRates({ schema_version: 1, rows: [...table.rows, table.rows[0]] }), /duplicate/)
  const legacy = structuredClone(table.rows[0])
  legacy.rates.context_over_200k = { input: 1, output: 2 }
  assert.throws(() => validateFallbackRates({ schema_version: 1, rows: [legacy] }), /unsupported legacy context tier key/)
  assert.ok(table.rows.every((row) => !Object.keys(row.rates).some((key) => /^context_over_\d+k$/.test(key))))
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
  const reportedWrite = deriveBillingTokens({ ...envelopes, cache_write: available(10_000) }, 'codex:turn.completed', { collectionComplete: true })
  assert.equal(reportedWrite.billing_tokens, null)
  assert.match(reportedWrite.billing_reason, /cannot be derived beside a reported cache_write/)
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
  assert.equal(calculateRateCost({ cost: rates, tokens, promptBounds: { lower: 300000 } }).context_tier.basis, 'ambiguous')
  assert.equal(calculateRateCost({ cost: rates, tokens, promptBounds: { lower: 300000, single_request: true } }).context_tier.basis, 'above_highest')
  const conflicting = { ...rates, context_over_200k: { input: 0.2, output: 0.75 } }
  assert.equal(calculateRateCost({ cost: conflicting, tokens, promptBounds: { lower: 240000 } }).context_tier.basis, 'ambiguous')
  const knownSmall = calculateRateCost({ cost: rates, tokens, promptBounds: { upper: 300000, lower: 200000 } })
  assert.equal(knownSmall.context_tier.basis, 'within_lowest')
  assert.deepEqual(knownSmall.assumptions, [])
})

test('known-small prompt uses catalog verification even when total input exceeds the tier', async () => {
  const attempt = { attempt_id: 'small-prompt', invoked_cli: true, provider: 'openai', model: 'gpt-6-luna',
    max_request_prompt_tokens: 200000, usage: { state: 'available', billing_tokens: { input: 300000 } } }
  const catalog = { state: 'available', url: 'https://models.dev/api.json', retrieved_at: '2026-09-28', sha256: 'fixture',
    entries: { openai: { models: { 'gpt-6-luna': { cost: table.rows[0].rates } } } } }
  const priced = await resolveAttemptCost({ attempt, catalog, fallbackTable: table })
  assert.equal(priced.verification, 'catalog')
  assert.equal(priced.provenance.context_tier.basis, 'within_lowest')
  assert.deepEqual(priced.provenance.assumptions, [])
})

test('fallback provenance preserves a partial catalog rate failure', async () => {
  const attempt = { attempt_id: 'fallback', invoked_cli: true, provider: 'openai', model: 'gpt-6-luna',
    usage: { state: 'available', billing_tokens: { cached_input: 1000 } } }
  const catalog = { state: 'available', url: 'https://models.dev/api.json', retrieved_at: '2026-09-28', sha256: 'fixture',
    entries: { openai: { models: { 'gpt-6-luna': { cost: { input: 0.1, output: 0.5 } } } } } }
  const priced = await resolveAttemptCost({ attempt, catalog, fallbackTable: table })
  assert.equal(priced.source, 'fallback-table')
  assert.deepEqual(priced.provenance.prior_source_failures, ['models.dev: rate source has no rate for token category cached_input'])
})

test('gpt-6-astra prices from the pinned table when models.dev is unavailable', async () => {
  const offline = { state: 'unavailable', reason: 'offline', entries: null }
  const attempt = { attempt_id: 'astra', invoked_cli: true, provider: 'openai', model: 'gpt-6-astra',
    usage: { state: 'available', billing_tokens: { input: 1_000_000, cached_input: 1_000_000,
      cache_write: 1_000_000, output: 100_000 } } }
  const priced = await resolveAttemptCost({ attempt, catalog: offline, fallbackTable: table, invoke: null })
  assert.equal(priced.source, 'fallback-table')
  assert.equal(priced.amount_usd, 28.5)
  assert.equal(priced.provenance.source_url, 'https://developers.openai.com/api/docs/models/gpt-6-astra')
  const row = lookupFallbackRate(table, 'openai', 'gpt-6-astra').row
  assert.deepEqual(row.rates.tiers[0], { input: 20, output: 75, cache_read: 2, cache_write: 25,
    tier: { type: 'context', size: 272000 } })
})

test('zero reported tokens and missing tokens have distinct unresolved reasons', async () => {
  const zero = { attempt_id: 'zero', invoked_cli: true, provider: 'openai', model: 'gpt-6-luna',
    usage: { state: 'available', billing_tokens: { input: 0, output: 0 } } }
  const missing = { ...zero, attempt_id: 'missing', usage: { state: 'available', billing_tokens: null } }
  const pricing = await resolveImplementationPricing({ attempts: [zero, missing], catalog: null, fallbackTable: table })
  assert.equal(pricing.costs[0].reason, 'reported token usage is zero')
  assert.equal(pricing.costs[1].reason, 'usage has no complete billing-token partition to price against the catalog')
  const resolved = { attempt_id: 'priced', invoked_cli: true, cost: { state: 'available', estimated_api_cost_usd: 2 } }
  const withSubtotal = await resolveImplementationPricing({ attempts: [resolved, zero], catalog: null, fallbackTable: table })
  const cost = aggregateImplementationCost({ attempts: [resolved, zero], costs: withSubtotal.costs })
  assert.equal(cost.total.state, 'unavailable')
  assert.equal(cost.total.known_cost_subtotal_usd, 2)
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
  const { attempts, catalog } = await loadRetainedAttempts()
  const pricing = await resolveImplementationPricing({ attempts, catalog, fallbackTable: table, invoke: null })
  const runnerCodex = costsFromSource(pricing, attempts, 'codex:turn.completed')
  assert.equal(runnerCodex.length, 11)
  assert.ok(runnerCodex.every((cost) => cost.state === 'resolved' && cost.source === 'models.dev' && cost.verification === 'estimated'))
  const validators = costsFromSource(pricing, attempts, 'agent-validator:metrics')
  assert.equal(validators.length, 16)
  assert.ok(validators.every((cost) => cost.state === 'unavailable' && /exact provider and model identity/.test(cost.reason)))
  const claude = costsFromSource(pricing, attempts, 'claude:result-event')
  assert.ok(claude.every((cost) => cost.state === 'resolved' && cost.verification === 'reported'))
  const cost = aggregateImplementationCost({ attempts, costs: pricing.costs })
  assert.equal(cost.total.state, 'unavailable')
  assert.ok(cost.total.known_cost_subtotal_usd > 0)
  const runnerRows = cost.rows.filter((row) => row.provider === 'openai' && row.model === 'gpt-6-luna')
  assert.ok(runnerRows.length > 0)
  assert.equal(runnerRows.reduce((sum, row) => sum + row.attempt_count, 0), 11)
  assert.equal(Number(runnerRows.reduce((sum, row) => sum + row.cost.amount_usd, 0).toFixed(6)), 0.825724)
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

const mixedAttempt = () => ({ attempt_id: 'mixed', invoked_cli: true, step: 'deliver', agent_role: 'lead',
  usage: { state: 'available' }, allocations: [
    { allocation_id: 'one', provider: 'openai', model: 'gpt-6-luna', usage: { state: 'available', tokens: { input: 1 } } },
    { allocation_id: 'two', provider: 'anthropic', model: 'claude-opus-5-5', usage: { state: 'available', tokens: { output: 2 } } },
  ] })
const rowSum = (rows) => Number(rows.reduce((sum, row) => sum + (row.cost.amount_usd ?? 0), 0).toFixed(10))

test('a full-attempt cost with only some allocation costs stays one undivided cost row', () => {
  const costs = [{ attempt_id: 'mixed', state: 'resolved', amount_usd: 3, known_subtotal_usd: 3,
    source: 'agent-runner-reported', verification: 'reported',
    allocation_costs: [{ allocation_id: 'one', amount_usd: 1, state: 'resolved', source: 'agent-runner-reported' }] }]
  const result = aggregateImplementationCost({ attempts: [mixedAttempt()], costs })
  assert.equal(result.total.estimated_api_cost_usd, 3)
  assert.equal(result.rows.find((row) => row.allocation === 'unattributed_cost').cost.amount_usd, 3)
  const modelRows = result.rows.filter((row) => row.allocation === 'attributed')
  assert.ok(modelRows.every((row) => row.cost.state === 'not_allocated' && row.cost.amount_usd === null))
  assert.equal(rowSum(result.rows), result.total.estimated_api_cost_usd)
})

test('allocation costs that exhaust the resolved amount divide it among model rows', () => {
  const costs = [{ attempt_id: 'mixed', state: 'resolved', amount_usd: 0.3, known_subtotal_usd: 0.3,
    source: 'mixed-allocation-pricing', verification: 'estimated', allocation_costs: [
      { allocation_id: 'one', amount_usd: 0.1, source: 'models.dev', verification: 'estimated' },
      { allocation_id: 'two', amount_usd: 0.2, source: 'models.dev', verification: 'estimated' },
    ] }]
  const result = aggregateImplementationCost({ attempts: [mixedAttempt()], costs })
  assert.equal(result.rows.some((row) => row.allocation === 'unattributed_cost'), false)
  assert.deepEqual(result.rows.map((row) => row.cost.amount_usd), [0.1, 0.2])
  assert.equal(rowSum(result.rows), result.total.estimated_api_cost_usd)
})

test('a step entry states the pricing assumptions of every allocation', () => {
  const costs = [{ attempt_id: 'mixed', state: 'resolved', amount_usd: 0.3, known_subtotal_usd: 0.3,
    source: 'models.dev', verification: 'estimated', allocation_costs: [
      { allocation_id: 'one', amount_usd: 0.1, source: 'models.dev', verification: 'estimated' },
      { allocation_id: 'two', amount_usd: 0.2, source: 'models.dev', verification: 'estimated' },
    ], provenance: { allocations: [
      { allocation_id: 'one', provenance: { assumptions: ['context_tier_unknown_priced_at_base'] } },
      { allocation_id: 'two', provenance: { assumptions: [
        'cache_write_not_reported_priced_as_input', 'context_tier_unknown_priced_at_base',
      ] } },
    ] } }]
  const [step] = aggregateImplementationCost({ attempts: [mixedAttempt()], costs }).steps
  assert.deepEqual(step.assumptions, ['context_tier_unknown_priced_at_base', 'cache_write_not_reported_priced_as_input'])
})

test('historical result and new step schedule both render safely', async () => {
  const historical = await readJson('../evals/agent-runner/and-scene/results/d7f384ba-0e94-4926-852e-6662fec752be-rep-1/result.json')
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
  const { attempts, catalog } = await loadRetainedAttempts()
  // Stands in for agent-validator#160: Validator attempts gain an exact identity.
  for (const attempt of attempts.filter((entry) => entry.usage_source === 'agent-validator:metrics')) {
    attempt.provider = 'openai'
    attempt.model = 'gpt-6-luna'
  }
  const pricing = await resolveImplementationPricing({ attempts, catalog, fallbackTable: table, invoke: null })
  assert.equal(pricing.complete, true)
  assert.equal(pricing.verified, false)
  assert.equal(pricing.verification, 'estimated')
  const cost = aggregateImplementationCost({ attempts, costs: pricing.costs })
  const total = cost.total.estimated_api_cost_usd
  assert.equal(cost.total.complete, true)
  assert.ok(Math.abs(cost.rows.reduce((sum, row) => sum + (row.cost.amount_usd ?? 0), 0) - total) < 1e-9)
  assert.ok(Math.abs(cost.step_rollup.reduce((sum, row) => sum + row.amount_usd, 0) - total) < 1e-9)
})

test('aggregate tokens do not all receive a high context rate from one long request', async () => {
  const attempt = { attempt_id: 'mixed-requests', invoked_cli: true, provider: 'openai', model: 'gpt-6-luna',
    max_request_prompt_tokens: 300000, usage: { state: 'available', billing_tokens: { input: 400000 },
      token_envelopes: { input_total: available(400000) } }, cost: { state: 'unavailable' } }
  const resolution = await resolveAttemptCost({ attempt, catalog: { state: 'available', url: 'catalog',
    entries: { openai: { models: { 'gpt-6-luna': { cost: table.rows[0].rates } } } } },
  fallbackTable: table, invoke: null })
  assert.equal(resolution.amount_usd, 0.04)
  assert.equal(resolution.verification, 'estimated')
  assert.ok(resolution.provenance.assumptions.includes('context_tier_ambiguous_priced_at_base'))
})

test('rescore refreshes a legacy native single allocation from attempt envelopes', async () => {
  const legacy = { attempt_id: 'native', invoked_cli: true, provider: 'openai', model: 'gpt-6-luna',
    usage_source: 'codex:turn.completed', usage: { state: 'available', token_envelopes: envelopes, billing_tokens: null },
    cost: { state: 'unavailable' }, allocations: [{ allocation_id: 'native-observed', provider: 'openai',
      model: 'gpt-6-luna', usage: { state: 'available', billing_tokens: null } }], unallocated_usage: null }
  refreshBillingTokens([legacy])
  assert.deepEqual(legacy.allocations[0].usage.billing_tokens, legacy.usage.billing_tokens)
  assert.deepEqual(legacy.allocations[0].usage.billing_assumptions, ['cache_write_not_reported_priced_as_input'])
  const resolution = await resolveAttemptCost({ attempt: legacy, catalog: null, fallbackTable: table, invoke: null })
  assert.equal(resolution.state, 'resolved')
  assert.equal(resolution.verification, 'estimated')
})

test('a catalog miss and a fallback-table miss hand the attempt to the judge', async () => {
  const attempt = { attempt_id: 'unlisted', invoked_cli: true, provider: 'openai', model: 'gpt-7-unlisted',
    usage: { state: 'available', billing_tokens: { input: 1_000_000, output: 1_000_000 } }, cost: { state: 'unavailable' } }
  const catalog = { state: 'available', url: 'https://models.dev/api.json', retrieved_at: '2026-09-27', sha256: 'hash',
    entries: { openai: { models: { 'gpt-6-luna': { cost: table.rows[0].rates } } } } }
  const requests = []
  const invoke = async (request) => {
    requests.push(request)
    return JSON.stringify({ found: true, source_url: 'https://example.test/pricing', matched_provider: 'openai',
      matched_model: 'gpt-7-unlisted', unit: 'usd_per_million_tokens', rates: { input: 2, output: 8 },
      rationale: 'the vendor page lists this model', judge_model: 'codex-default' })
  }
  const resolution = await resolveAttemptCost({ attempt, catalog, fallbackTable: table, invoke })
  assert.equal(requests.length, 1)
  assert.equal(resolution.state, 'resolved')
  assert.equal(resolution.source, 'judge-web-search')
  assert.equal(resolution.verification, 'unverified')
  assert.equal(resolution.amount_usd, 10)
})

test('an undivided multi-model cost renders as a whole-attempt row without usage counts', async () => {
  const historical = await readJson('../evals/agent-runner/and-scene/results/d7f384ba-0e94-4926-852e-6662fec752be-rep-1/result.json')
  const attempts = [{ attempt_id: 'mixed', invoked_cli: true, step: 'deliver', agent_role: 'lead',
    usage: { state: 'available' }, allocations: [
      { allocation_id: 'one', provider: 'openai', model: 'gpt-6-luna',
        usage: { state: 'available', tokens: { input: 1 } } },
      { allocation_id: 'two', provider: 'anthropic', model: 'claude-opus-5-5',
        usage: { state: 'available', tokens: { output: 2 } } },
    ] }]
  const cost = aggregateImplementationCost({ attempts, costs: [{ attempt_id: 'mixed', state: 'resolved', amount_usd: 3,
    known_subtotal_usd: 3, source: 'agent-runner-reported', verification: 'reported', allocation_costs: [] }] })
  const current = { ...historical, cost }
  const html = renderReport(current, { current })
  const row = html.split('<tr>').find((cells) => cells.includes('whole-attempt cost (not divided among models)'))
  assert.ok(row, 'the whole-attempt cost row is rendered')
  const cells = [...row.matchAll(/<td>(.*?)<\/td>/g)].map((match) => match[1])
  // Six usage columns stay blank: the row carries a cost, never usage of its own.
  assert.deepEqual(cells.slice(4, 13), ['whole-attempt cost (not divided among models)', '1',
    '', '', '', '', '', '', 'incomplete'])
  assert.equal(cells[13], '$3')
})
