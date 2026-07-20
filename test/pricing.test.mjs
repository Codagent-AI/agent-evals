import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import {
  MODELS_DEV_URL,
  PRICING_FINDING_SCHEMA,
  buildPricingRequest,
  calculateCatalogCost,
  fetchPricingCatalog,
  lookupCatalogEntry,
  parsePricingFinding,
  resolveAttemptCost,
  resolveImplementationPricing,
} from '../evals/agent-runner/and-scene/lib/pricing.mjs'

const CATALOG_BODY = JSON.stringify({
  openai: {
    id: 'openai',
    models: {
      'gpt-5-codex': {
        id: 'gpt-5-codex',
        cost: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 1.5 },
      },
      'gpt-5-nano': { id: 'gpt-5-nano', cost: { input: 0.05 } },
    },
  },
})

function catalogFetch(body = CATALOG_BODY, ok = true) {
  return async (url) => {
    assert.equal(url, MODELS_DEV_URL)
    return { ok, status: ok ? 200 : 503, text: async () => body }
  }
}

function attempt(overrides = {}) {
  return {
    attempt_id: 'implement-task#1',
    agent_role: 'task-implementor',
    invoked_cli: true,
    provider: 'openai',
    model: 'gpt-5-codex',
    usage: { state: 'available', reason: null, tokens: { input: 1_000_000, output: 100_000 } },
    cost: { state: 'unavailable', reason: 'no catalog entry', estimated_api_cost_usd: null },
    ...overrides,
  }
}

async function loadedCatalog() {
  return fetchPricingCatalog({ fetchImpl: catalogFetch(), now: () => '2026-07-20T10:00:00.000Z' })
}

test('the catalog fetch records retrieval time and response hash', async () => {
  const catalog = await loadedCatalog()

  assert.equal(catalog.state, 'available')
  assert.equal(catalog.url, MODELS_DEV_URL)
  assert.equal(catalog.retrieved_at, '2026-07-20T10:00:00.000Z')
  assert.equal(catalog.sha256, hashString(CATALOG_BODY))
})

test('a stalled catalog request aborts instead of hanging the evaluation', async () => {
  let signal = null
  const catalog = await fetchPricingCatalog({
    timeoutMs: 20,
    fetchImpl: (url, options) => {
      signal = options?.signal
      // Never settles on its own; only the timeout can end this.
      return new Promise((resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    },
  })

  assert.equal(catalog.state, 'unavailable')
  assert.equal(signal?.aborted, true)
  assert.equal(catalog.entries, null)
})

test('a catalog fetch that returns in time is not aborted', async () => {
  let aborted = null
  const catalog = await fetchPricingCatalog({
    timeoutMs: 5000,
    fetchImpl: async (url, options) => {
      aborted = () => options?.signal?.aborted
      return { ok: true, status: 200, text: async () => CATALOG_BODY }
    },
  })

  assert.equal(catalog.state, 'available')
  // The timer must be cleared, not left pending against a settled request.
  assert.equal(aborted(), false)
})

test('an unreachable catalog is unavailable rather than empty', async () => {
  const catalog = await fetchPricingCatalog({
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') },
  })

  assert.equal(catalog.state, 'unavailable')
  assert.equal(catalog.entries, null)
  assert.match(catalog.reason, /ENOTFOUND/)
})

test('a non-OK catalog response is unavailable', async () => {
  const catalog = await fetchPricingCatalog({ fetchImpl: catalogFetch('', false) })

  assert.equal(catalog.state, 'unavailable')
  assert.match(catalog.reason, /503/)
})

test('catalog lookup matches provider and model exactly', async () => {
  const catalog = await loadedCatalog()

  assert.ok(lookupCatalogEntry(catalog, 'openai', 'gpt-5-codex'))
  assert.equal(lookupCatalogEntry(catalog, 'openai', 'gpt-5-codex-preview'), null)
  assert.equal(lookupCatalogEntry(catalog, 'openai', 'GPT-5-Codex'), null)
  assert.equal(lookupCatalogEntry(catalog, 'azure', 'gpt-5-codex'), null)
})

test('catalog calculation prices every reported token category', async () => {
  const catalog = await loadedCatalog()
  const entry = lookupCatalogEntry(catalog, 'openai', 'gpt-5-codex')

  const calculated = calculateCatalogCost({
    entry,
    tokens: { input: 1_000_000, cached_input: 1_000_000, output: 100_000 },
  })

  assert.equal(calculated.state, 'resolved')
  assert.equal(calculated.amount_usd, 1.25 + 0.125 + 1)
  assert.equal(calculated.unit, 'usd_per_million_tokens')
  assert.deepEqual(calculated.token_categories.sort(), ['cached_input', 'input', 'output'])
  assert.deepEqual(calculated.rates, { input: 1.25, cached_input: 0.125, output: 10 })
})

test('a token category with no catalog rate leaves the attempt unpriced', async () => {
  const catalog = await loadedCatalog()
  const entry = lookupCatalogEntry(catalog, 'openai', 'gpt-5-nano')

  const calculated = calculateCatalogCost({ entry, tokens: { input: 1000, output: 500 } })

  assert.equal(calculated.state, 'unavailable')
  assert.match(calculated.reason, /output/)
  assert.equal(calculated.amount_usd, null)
})

test('an unrecognised token category is never silently omitted', async () => {
  const catalog = await loadedCatalog()
  const entry = lookupCatalogEntry(catalog, 'openai', 'gpt-5-codex')

  const calculated = calculateCatalogCost({ entry, tokens: { input: 1000, audio_input: 20 } })

  assert.equal(calculated.state, 'unavailable')
  assert.match(calculated.reason, /audio_input/)
})

test('reported cost is used without any pricing lookup', async () => {
  const catalog = await loadedCatalog()
  const judge = async () => { throw new Error('judge must not be called') }

  const resolution = await resolveAttemptCost({
    attempt: attempt({ cost: { state: 'available', reason: null, estimated_api_cost_usd: 0.42 } }),
    catalog,
    invoke: judge,
  })

  assert.equal(resolution.state, 'resolved')
  assert.equal(resolution.amount_usd, 0.42)
  assert.equal(resolution.source, 'agent-runner-reported')
  assert.equal(resolution.verification, 'reported')
})

test('a negative reported cost is refused rather than subtracted from the total', async () => {
  const catalog = await loadedCatalog()

  const resolution = await resolveAttemptCost({
    attempt: attempt({ cost: { state: 'available', reason: null, estimated_api_cost_usd: -5 } }),
    catalog,
    invoke: null,
  })

  // A negative cost cannot be a real charge; accepting it would let a malformed
  // artifact understate or invert the implementation total.
  assert.notEqual(resolution.amount_usd, -5)
  assert.equal(resolution.source, 'models.dev')
})

test('a negative token count is not billable usage', async () => {
  const catalog = await loadedCatalog()
  const entry = lookupCatalogEntry(catalog, 'openai', 'gpt-5-codex')

  const calculated = calculateCatalogCost({ entry, tokens: { input: -1000, output: 500 } })

  assert.equal(calculated.state, 'unavailable')
  assert.match(calculated.reason, /input/)
})

test('a negative catalog rate cannot price an attempt', async () => {
  const catalog = await fetchPricingCatalog({
    fetchImpl: catalogFetch(JSON.stringify({
      openai: { id: 'openai', models: { 'gpt-5-codex': { cost: { input: -1, output: 10 } } } },
    })),
  })
  const entry = lookupCatalogEntry(catalog, 'openai', 'gpt-5-codex')

  const calculated = calculateCatalogCost({ entry, tokens: { input: 1000, output: 500 } })

  assert.equal(calculated.state, 'unavailable')
  assert.match(calculated.reason, /input/)
})

test('a negative judge-found rate is refused', async () => {
  const catalog = await loadedCatalog()
  const invoke = async () => JSON.stringify({
    found: true,
    source_url: 'https://example.test/pricing',
    matched_provider: 'anthropic',
    matched_model: 'claude-opus-4-8',
    unit: 'usd_per_million_tokens',
    rates: { input: -5, output: 25 },
    rationale: 'the vendor page lists this model',
    judge_model: 'codex-default',
  })

  const resolution = await resolveAttemptCost({
    attempt: attempt({ provider: 'anthropic', model: 'claude-opus-4-8' }),
    catalog,
    invoke,
  })

  assert.equal(resolution.state, 'unavailable')
  assert.match(resolution.reason, /input/)
})

test('an exact catalog match prices the attempt and records the match details', async () => {
  const catalog = await loadedCatalog()

  const resolution = await resolveAttemptCost({ attempt: attempt(), catalog, invoke: null })

  assert.equal(resolution.state, 'resolved')
  assert.equal(resolution.source, 'models.dev')
  assert.equal(resolution.verification, 'catalog')
  assert.equal(resolution.amount_usd, 1.25 + 1)
  assert.equal(resolution.provenance.retrieved_at, '2026-07-20T10:00:00.000Z')
  assert.equal(resolution.provenance.response_sha256, hashString(CATALOG_BODY))
  assert.equal(resolution.provenance.requested_model, 'gpt-5-codex')
  assert.equal(resolution.provenance.matched_model, 'gpt-5-codex')
  assert.equal(resolution.provenance.requested_provider, 'openai')
})

test('a missing catalog match asks the judge to search for a pricing source', async () => {
  const catalog = await loadedCatalog()
  const asked = []
  const invoke = async (request) => {
    asked.push(request)
    return JSON.stringify({
      found: true,
      source_url: 'https://example.test/pricing',
      matched_provider: 'anthropic',
      matched_model: 'claude-opus-4-8',
      unit: 'usd_per_million_tokens',
      rates: { input: 5, output: 25 },
      rationale: 'the vendor pricing page lists this exact model id',
      judge_model: 'codex-default',
    })
  }

  const resolution = await resolveAttemptCost({
    attempt: attempt({ provider: 'anthropic', model: 'claude-opus-4-8' }),
    catalog,
    invoke,
    authority: { cli: 'codex', model: 'codex-default' },
  })

  assert.equal(asked.length, 1)
  assert.equal(asked[0].web_search, 'authorized')
  assert.equal(resolution.state, 'resolved')
  assert.equal(resolution.source, 'judge-web-search')
  assert.equal(resolution.verification, 'unverified')
  assert.equal(resolution.amount_usd, 5 + 2.5)
  assert.equal(resolution.provenance.source_url, 'https://example.test/pricing')
  assert.equal(resolution.provenance.rationale, 'the vendor pricing page lists this exact model id')
  assert.equal(resolution.provenance.judge_model, 'codex-default')
})

test('an unavailable catalog still routes the attempt to the judge', async () => {
  const catalog = await fetchPricingCatalog({ fetchImpl: async () => { throw new Error('offline') } })
  let asked = 0
  const invoke = async () => {
    asked += 1
    return JSON.stringify({ found: false, reason: 'no published rates' })
  }

  const resolution = await resolveAttemptCost({ attempt: attempt(), catalog, invoke })

  assert.equal(asked, 1)
  assert.equal(resolution.state, 'unavailable')
})

test('a judge finding for a different model is rejected as name inference', async () => {
  const catalog = await loadedCatalog()
  const invoke = async () => JSON.stringify({
    found: true,
    source_url: 'https://example.test/pricing',
    matched_provider: 'openai',
    matched_model: 'gpt-5-codex-preview',
    unit: 'usd_per_million_tokens',
    rates: { input: 1, output: 2 },
    rationale: 'closest available name',
    judge_model: 'codex-default',
  })

  const resolution = await resolveAttemptCost({
    attempt: attempt({ provider: 'anthropic', model: 'claude-opus-4-8' }),
    catalog,
    invoke,
  })

  assert.equal(resolution.state, 'unavailable')
  assert.match(resolution.reason, /gpt-5-codex-preview/)
})

test('a judge finding missing a needed token rate cannot price the attempt', async () => {
  const catalog = await loadedCatalog()
  const invoke = async () => JSON.stringify({
    found: true,
    source_url: 'https://example.test/pricing',
    matched_provider: 'anthropic',
    matched_model: 'claude-opus-4-8',
    unit: 'usd_per_million_tokens',
    rates: { input: 5 },
    rationale: 'only input pricing is published',
    judge_model: 'codex-default',
  })

  const resolution = await resolveAttemptCost({
    attempt: attempt({ provider: 'anthropic', model: 'claude-opus-4-8' }),
    catalog,
    invoke,
  })

  assert.equal(resolution.state, 'unavailable')
  assert.match(resolution.reason, /output/)
})

test('an attempt with no usable usage is never priced', async () => {
  const catalog = await loadedCatalog()
  let asked = 0

  const resolution = await resolveAttemptCost({
    attempt: attempt({ usage: { state: 'unavailable', reason: 'cli reported no usage', tokens: null } }),
    catalog,
    invoke: async () => { asked += 1; return '{}' },
  })

  assert.equal(asked, 0)
  assert.equal(resolution.state, 'unavailable')
  assert.match(resolution.reason, /usage/)
})

test('the pricing finding schema is enforced on the judge response', () => {
  assert.equal(PRICING_FINDING_SCHEMA.type, 'object')
  assert.throws(
    () => parsePricingFinding('not json', attempt()),
    /valid JSON/,
  )
  assert.throws(
    () => parsePricingFinding(JSON.stringify({ found: true, matched_model: 'gpt-5-codex' }), attempt()),
    /source_url/,
  )
})

test('a pricing request names the attempt model and its needed categories', () => {
  const request = buildPricingRequest({
    attempt: attempt(),
    authority: { cli: 'codex', model: 'codex-default' },
  })

  assert.equal(request.authority.cli, 'codex')
  assert.match(request.prompt, /gpt-5-codex/)
  assert.match(request.prompt, /input/)
  assert.match(request.prompt, /output/)
  assert.equal(request.schema, PRICING_FINDING_SCHEMA)
})

test('pricing resolution covers every CLI attempt and records the catalog once', async () => {
  const catalog = await loadedCatalog()
  const attempts = [
    attempt({ attempt_id: 'a1' }),
    attempt({ attempt_id: 'a2', cost: { state: 'available', reason: null, estimated_api_cost_usd: 0.5 } }),
    attempt({ attempt_id: 'shell#1', invoked_cli: false, provider: null, model: null }),
  ]

  const resolution = await resolveImplementationPricing({ attempts, catalog, invoke: null })

  assert.deepEqual(resolution.costs.map((entry) => entry.attempt_id), ['a1', 'a2'])
  assert.equal(resolution.catalog.sha256, hashString(CATALOG_BODY))
  assert.equal(resolution.costs[0].source, 'models.dev')
  assert.equal(resolution.costs[1].source, 'agent-runner-reported')
})

test('pricing lookup never carries a scoring effect', async () => {
  const catalog = await loadedCatalog()

  const resolution = await resolveImplementationPricing({ attempts: [attempt()], catalog, invoke: null })

  assert.equal(resolution.scoring_effect, 'none')
})
