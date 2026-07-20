// Cost resolution for Agent Runner attempts that reported no cost.
//
// Three ordered sources, each weaker than the last and each labelled as what it
// is: the cost Agent Runner reported, an exact match in the current models.dev
// catalog, and — only when both fail — a web-searching judge whose finding is
// recorded as `unverified`.
//
// Two things are forbidden throughout, because both manufacture a confident
// number out of nothing: pricing a model from a similar name, and dropping a
// token category that has no rate so the remaining ones add up to something.
// Either would turn "we do not know" into a figure someone would quote.
import { bounded } from './browser-eval.mjs'
import { hashString } from './persistence.mjs'

export const MODELS_DEV_URL = 'https://models.dev/api.json'

// models.dev publishes rates in USD per million tokens.
export const PRICING_UNIT = 'usd_per_million_tokens'
const TOKENS_PER_UNIT = 1_000_000

// Agent Runner's token categories mapped to the catalog's rate keys. This is a
// billing fact, not a name-similarity guess: reasoning output is billed at the
// output rate, and Agent Runner reports it as a category disjoint from `output`.
// A category absent from this map has no defensible rate, so the attempt goes
// unpriced rather than being priced on a guess.
const CATEGORY_RATE_KEYS = {
  input: 'input',
  cached_input: 'cache_read',
  cache_write: 'cache_write',
  output: 'output',
  reasoning_output: 'output',
}

export const PRICING_FINDING_SCHEMA = {
  type: 'object',
  required: ['found'],
  properties: {
    found: { type: 'boolean' },
    reason: { type: 'string' },
    source_url: { type: 'string' },
    matched_provider: { type: 'string' },
    matched_model: { type: 'string' },
    unit: { enum: [PRICING_UNIT, 'usd_per_thousand_tokens'] },
    rates: { type: 'object', additionalProperties: { type: 'number' } },
    rationale: { type: 'string', minLength: 1 },
    judge_model: { type: 'string' },
  },
}

function unavailable(reason, extra = {}) {
  return { state: 'unavailable', amount_usd: null, reason, ...extra }
}

export async function fetchPricingCatalog({
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  const retrievedAt = now()
  const base = { url: MODELS_DEV_URL, retrieved_at: retrievedAt, sha256: null, entries: null }
  try {
    const response = await fetchImpl(MODELS_DEV_URL)
    if (!response.ok) {
      return { ...base, state: 'unavailable', reason: `models.dev responded ${response.status}` }
    }
    const body = await response.text()
    return {
      ...base,
      state: 'available',
      reason: null,
      // Hash the exact bytes the calculation used, so a later reader can tell
      // whether today's catalog still says what this run relied on.
      sha256: hashString(body),
      entries: JSON.parse(body),
    }
  } catch (error) {
    return { ...base, state: 'unavailable', reason: `models.dev is unavailable: ${error.message}` }
  }
}

// Exact identifiers only. A near match is a different model with different
// rates, and the catalog is not authoritative about which near match is meant.
export function lookupCatalogEntry(catalog, provider, model) {
  if (catalog?.state !== 'available' || !provider || !model) return null
  const models = catalog.entries?.[provider]?.models
  const entry = models && Object.hasOwn(models, model) ? models[model] : null
  if (!entry?.cost) return null
  return { provider, model, cost: entry.cost }
}

function billedCategories(tokens) {
  return Object.entries(tokens ?? {}).filter(([, value]) => Number.isFinite(value) && value > 0)
}

export function calculateCatalogCost({ entry, tokens }) {
  if (!entry) return unavailable('no exact models.dev provider/model match')
  const billed = billedCategories(tokens)
  if (billed.length === 0) return unavailable('no billable token usage was reported')

  const rates = {}
  let amount = 0
  for (const [category, count] of billed) {
    const rateKey = CATEGORY_RATE_KEYS[category]
    const rate = rateKey ? entry.cost[rateKey] : undefined
    if (!Number.isFinite(rate)) {
      // Every reported category must be priced. Omitting this one would produce
      // a complete-looking estimate that silently undercounts.
      return unavailable(`models.dev has no rate for token category ${category}`)
    }
    rates[category] = rate
    amount += (count * rate) / TOKENS_PER_UNIT
  }

  return {
    state: 'resolved',
    amount_usd: amount,
    reason: null,
    rates,
    unit: PRICING_UNIT,
    token_categories: billed.map(([category]) => category),
  }
}

export function buildPricingRequest({ attempt, authority }) {
  const categories = billedCategories(attempt.usage?.tokens).map(([category]) => category)
  const prompt = [
    'Find published API pricing for one exact provider and model.',
    '',
    `Provider: ${bounded(attempt.provider)}`,
    `Model: ${bounded(attempt.model)}`,
    `Billed token categories needing a rate: ${categories.join(', ')}`,
    '',
    'Search the web for the vendor\'s published rates. Return a finding only when the',
    'source names this exact model identifier. Do not infer a price from a similar or',
    'successor model name, and do not omit a category you cannot find a rate for:',
    'report found=false instead.',
    '',
    '# Response',
    `Reply with JSON matching this schema: ${JSON.stringify(PRICING_FINDING_SCHEMA)}`,
  ].join('\n')

  return {
    job: 'pricing-lookup',
    attempt_id: attempt.attempt_id,
    // The pricing judge is the only job authorized to reach the network, and it
    // is separately schema-constrained so its answer cannot become a verdict.
    web_search: 'authorized',
    schema: PRICING_FINDING_SCHEMA,
    authority,
    scoring_effect: 'none',
    prompt,
  }
}

export function parsePricingFinding(text, attempt) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new Error(`pricing finding is not valid JSON: ${error.message}`)
  }
  if (payload?.found !== true) {
    return { found: false, reason: payload?.reason ?? 'the judge found no published rates' }
  }
  for (const field of ['source_url', 'matched_provider', 'matched_model', 'rates', 'rationale']) {
    if (payload[field] === undefined || payload[field] === null) {
      throw new Error(`pricing finding is missing ${field}`)
    }
  }
  return {
    found: true,
    source_url: String(payload.source_url),
    matched_provider: String(payload.matched_provider),
    matched_model: String(payload.matched_model),
    unit: payload.unit === 'usd_per_thousand_tokens' ? 'usd_per_thousand_tokens' : PRICING_UNIT,
    rates: payload.rates,
    rationale: bounded(payload.rationale),
    judge_model: payload.judge_model ?? null,
  }
}

function calculateFindingCost({ finding, tokens }) {
  const divisor = finding.unit === 'usd_per_thousand_tokens' ? 1000 : TOKENS_PER_UNIT
  const rates = {}
  let amount = 0
  for (const [category, count] of billedCategories(tokens)) {
    // The finding is keyed by Agent Runner's own category names; the judge is
    // asked for exactly those, so no cross-vocabulary mapping happens here.
    const rate = finding.rates?.[category] ?? finding.rates?.[CATEGORY_RATE_KEYS[category]]
    if (!Number.isFinite(rate)) {
      return unavailable(`the judge pricing finding has no rate for token category ${category}`)
    }
    rates[category] = rate
    amount += (count * rate) / divisor
  }
  return { state: 'resolved', amount_usd: amount, reason: null, rates }
}

export async function resolveAttemptCost({ attempt, catalog, invoke, authority = null }) {
  const base = { attempt_id: attempt.attempt_id, provenance: null }

  // Agent Runner's own reported cost wins outright: it measured the attempt, and
  // a lookup could only second-guess it with less information.
  if (attempt.cost?.state === 'available' && Number.isFinite(attempt.cost.estimated_api_cost_usd)) {
    return {
      ...base,
      state: 'resolved',
      amount_usd: attempt.cost.estimated_api_cost_usd,
      source: 'agent-runner-reported',
      verification: 'reported',
      reason: null,
    }
  }

  const tokens = attempt.usage?.state === 'available' ? attempt.usage.tokens : null
  if (billedCategories(tokens).length === 0) {
    return {
      ...base,
      ...unavailable('no reported token usage to price this attempt with'),
      source: null,
      verification: null,
    }
  }

  const entry = lookupCatalogEntry(catalog, attempt.provider, attempt.model)
  const calculated = calculateCatalogCost({ entry, tokens })
  if (calculated.state === 'resolved') {
    return {
      ...base,
      state: 'resolved',
      amount_usd: calculated.amount_usd,
      source: 'models.dev',
      verification: 'catalog',
      reason: null,
      provenance: {
        url: catalog.url,
        retrieved_at: catalog.retrieved_at,
        response_sha256: catalog.sha256,
        requested_provider: attempt.provider,
        requested_model: attempt.model,
        matched_provider: entry.provider,
        matched_model: entry.model,
        rates: calculated.rates,
        unit: calculated.unit,
        token_categories: calculated.token_categories,
      },
    }
  }

  if (!invoke) {
    return { ...base, ...unavailable(calculated.reason), source: null, verification: null }
  }

  let finding
  try {
    finding = parsePricingFinding(await invoke(buildPricingRequest({ attempt, authority })), attempt)
  } catch (error) {
    return { ...base, ...unavailable(error.message), source: null, verification: null }
  }
  if (!finding.found) {
    return { ...base, ...unavailable(finding.reason), source: null, verification: null }
  }
  // An answer about another model is an answer to another question. Accepting it
  // is exactly the similar-name inference this module forbids.
  if (finding.matched_model !== attempt.model || finding.matched_provider !== attempt.provider) {
    return {
      ...base,
      ...unavailable(
        `the judge matched ${finding.matched_provider}/${finding.matched_model}, not ${attempt.provider}/${attempt.model}`,
      ),
      source: null,
      verification: null,
    }
  }

  const priced = calculateFindingCost({ finding, tokens })
  if (priced.state !== 'resolved') {
    return { ...base, ...priced, source: null, verification: null }
  }

  return {
    ...base,
    state: 'resolved',
    amount_usd: priced.amount_usd,
    source: 'judge-web-search',
    // A judge-found rate may contribute to the total, but it is never presented
    // as verified: a reader must be able to see which figures rest on a search.
    verification: 'unverified',
    reason: null,
    provenance: {
      source_url: finding.source_url,
      retrieved_at: catalog?.retrieved_at ?? null,
      requested_provider: attempt.provider,
      requested_model: attempt.model,
      matched_provider: finding.matched_provider,
      matched_model: finding.matched_model,
      rates: priced.rates,
      unit: finding.unit,
      token_categories: billedCategories(tokens).map(([category]) => category),
      rationale: finding.rationale,
      judge_model: finding.judge_model,
    },
  }
}

// True when at least one CLI attempt lacks a reported cost. The catalog is a
// live network resource, so it is fetched only when something actually needs
// pricing rather than once per run out of habit.
export function needsPricingLookup(attempts = []) {
  return attempts.some((attempt) => (
    attempt.invoked_cli
    && !(attempt.cost?.state === 'available' && Number.isFinite(attempt.cost.estimated_api_cost_usd))
  ))
}

export async function resolveImplementationPricing({ attempts = [], catalog, invoke, authority = null }) {
  const costs = []
  // Sequential: the pricing judge shares one authority and rate budget with the
  // product judges, and a lookup failure must stay attributable to its attempt.
  for (const attempt of attempts.filter((entry) => entry.invoked_cli)) {
    costs.push(await resolveAttemptCost({ attempt, catalog, invoke, authority }))
  }
  return {
    costs,
    catalog: {
      url: catalog?.url ?? MODELS_DEV_URL,
      state: catalog?.state ?? 'not-required',
      retrieved_at: catalog?.retrieved_at ?? null,
      sha256: catalog?.sha256 ?? null,
      reason: catalog?.reason ?? null,
    },
    scoring_effect: 'none',
  }
}
