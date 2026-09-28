// Cost resolution for Agent Runner attempts that reported no cost.
//
// Ordered sources: reported cost, exact models.dev rate, exact pinned fallback
// rate, then a judge. Derived billing or uncertain context tiers are estimated.
//
// Two things are forbidden throughout, because both manufacture a confident
// number out of nothing: pricing a model from a similar name, and dropping a
// token category that has no rate so the remaining ones add up to something.
// Either would turn "we do not know" into a figure someone would quote.
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bounded } from './browser-eval.mjs'
import { hashString } from './persistence.mjs'

export const MODELS_DEV_URL = 'https://models.dev/api.json'

const SUITE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const REPOSITORY_ROOT = resolve(SUITE_DIR, '../../..')
export const FALLBACK_RATES_PATH = join(SUITE_DIR, 'pricing/fallback-rates.json')

// Rate keys a catalog or fallback-table entry may carry. Input and output are
// required of every fallback row; the rest are priced only when present.
const RATE_KEYS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning']
const REQUIRED_RATE_KEYS = ['input', 'output']
const REQUIRED_FALLBACK_FIELDS = ['provider', 'model', 'source_url', 'retrieved_date']

// Strongest first. A figure combined from several costs is only as certain as
// its least certain part.
const VERIFICATION_ORDER = ['reported', 'catalog', 'estimated', 'unverified']

export function weakestVerification(states = []) {
  const ranks = states.map((state) => VERIFICATION_ORDER.indexOf(state)).filter((rank) => rank >= 0)
  return ranks.length > 0 ? VERIFICATION_ORDER[Math.max(...ranks)] : null
}

// The verification disclosure shared by the pricing summary and the cost total.
export function summarizeVerification(states = []) {
  return {
    verification: weakestVerification(states),
    includes_estimated: states.includes('estimated'),
    includes_unverified: states.includes('unverified'),
  }
}

export function validateFallbackRates(table) {
  if (table?.schema_version !== 1 || !Array.isArray(table.rows)) {
    throw new Error('fallback table needs schema_version 1 and rows')
  }
  const seen = new Set()
  for (const row of table.rows) {
    if (!row || !REQUIRED_FALLBACK_FIELDS.every((key) => typeof row[key] === 'string' && row[key])) {
      throw new Error('fallback row is missing a required field')
    }
    const validSource = /^https:\/\//.test(row.source_url) && /^\d{4}-\d{2}-\d{2}$/.test(row.retrieved_date)
    if (row.unit !== PRICING_UNIT || !validSource) {
      throw new Error('fallback row has invalid unit or source')
    }
    for (const key of RATE_KEYS) {
      const rate = row.rates?.[key]
      const required = REQUIRED_RATE_KEYS.includes(key)
      if ((required || rate !== undefined) && !nonNegative(rate)) {
        throw new Error(`fallback row has invalid ${key} rate`)
      }
    }
    for (const tier of row.rates.tiers ?? []) {
      const validTier = tier.tier?.type === 'context'
        && nonNegative(tier.tier.size)
        && nonNegative(tier.input)
        && nonNegative(tier.output)
      if (!validTier) throw new Error('fallback row has invalid context tier')
    }
    const key = JSON.stringify([row.provider, row.model])
    if (seen.has(key)) throw new Error('duplicate fallback provider/model row')
    seen.add(key)
  }
  return table
}

export async function loadFallbackRates({ path = FALLBACK_RATES_PATH } = {}) {
  // Recorded relative to the repository so a result names the same file
  // whichever directory the evaluation ran from.
  const displayPath = relative(REPOSITORY_ROOT, resolve(path))
  let sha256 = null
  try {
    const body = await readFile(path, 'utf8')
    sha256 = hashString(body)
    const rows = validateFallbackRates(JSON.parse(body)).rows
    return { state: 'available', path: displayPath, sha256, rows, row_count: rows.length, reason: null }
  } catch (error) {
    return { state: 'unavailable', path: displayPath, sha256, rows: [], row_count: 0, reason: error.message }
  }
}

export function lookupFallbackRate(table, provider, model) {
  if (table?.state !== 'available') return null
  const row = table.rows.find((item) => item.provider === provider && item.model === model)
  return row ? { provider, model, cost: row.rates, row } : null
}

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
  reasoning: 'output',
  reasoning_output: 'output',
}

export const PRICING_FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'found', 'reason', 'source_url', 'matched_provider', 'matched_model',
    'unit', 'rates', 'rationale', 'judge_model',
  ],
  properties: {
    found: { type: 'boolean' },
    reason: { type: ['string', 'null'] },
    source_url: { type: ['string', 'null'] },
    matched_provider: { type: ['string', 'null'] },
    matched_model: { type: ['string', 'null'] },
    unit: { enum: [PRICING_UNIT, 'usd_per_thousand_tokens', null] },
    rates: {
      type: 'object',
      additionalProperties: false,
      required: ['input', 'cached_input', 'cache_write', 'output', 'reasoning', 'reasoning_output'],
      properties: Object.fromEntries(
        ['input', 'cached_input', 'cache_write', 'output', 'reasoning', 'reasoning_output']
          .map((category) => [category, { type: ['number', 'null'] }]),
      ),
    },
    rationale: { type: ['string', 'null'] },
    judge_model: { type: ['string', 'null'] },
  },
}

function unavailable(reason, extra = {}) {
  return { state: 'unavailable', amount_usd: null, reason, ...extra }
}

// Pricing is a diagnostic, so a stalled catalog request must degrade to an
// unavailable catalog rather than hold the whole evaluation open indefinitely.
export const CATALOG_TIMEOUT_MS = 15_000

export async function fetchPricingCatalog({
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  timeoutMs = CATALOG_TIMEOUT_MS,
} = {}) {
  const retrievedAt = now()
  const base = { url: MODELS_DEV_URL, retrieved_at: retrievedAt, sha256: null, entries: null }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { signal: controller.signal })
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
  } finally {
    // Cleared whichever way the request settled, so a completed fetch never
    // leaves a pending timer holding the process open.
    clearTimeout(timer)
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

// Money and token counts are never negative. A negative value is malformed data,
// not a discount and not an absence, so it is refused everywhere rather than
// flowing into a total that would end up understated or inverted.
function nonNegative(value) {
  return Number.isFinite(value) && value >= 0
}

// The first reported category whose count is not a non-negative number, or null
// when the usage is well formed. Silently skipping such a category would be the
// same omission this module refuses elsewhere.
function malformedCategory(tokens) {
  return Object.entries(tokens ?? {}).find(([, value]) => !nonNegative(value))?.[0] ?? null
}

function billedCategories(tokens) {
  return Object.entries(tokens ?? {}).filter(([, value]) => nonNegative(value) && value > 0)
}

function attemptBillingTokens(attempt) {
  return Object.hasOwn(attempt.usage ?? {}, 'billing_tokens')
    ? attempt.usage.billing_tokens
    : attempt.usage?.tokens
}

function reportedCostSummary(attempt) {
  const evidence = Array.isArray(attempt.provider_reported_costs)
    ? attempt.provider_reported_costs
    : []
  const usd = evidence.filter((cost) => (
    cost.amount?.availability !== 'unavailable'
    && nonNegative(cost.amount?.value)
    && cost.currency?.availability === 'available'
    && cost.currency.value === 'USD'
  ))
  const allocationGroups = new Map()
  for (const cost of usd.filter((entry) => entry.scope === 'allocation' && entry.allocation_id)) {
    const group = allocationGroups.get(cost.allocation_id) ?? []
    group.push(cost)
    allocationGroups.set(cost.allocation_id, group)
  }
  const allocationCosts = [...allocationGroups.entries()]
    .filter(([, costs]) => costs.length === 1)
    .map(([allocationId, [cost]]) => ({
      allocation_id: allocationId,
      amount_usd: cost.amount.value,
      cost_evidence_id: cost.cost_evidence_id,
      state: cost.coverage === 'full' ? 'resolved' : 'incomplete',
      coverage: cost.coverage,
      overlap: cost.overlap,
      source: 'agent-runner-reported',
    }))
  const allocationIds = new Set((attempt.allocations ?? []).map((allocation) => allocation.allocation_id))
  const exhaustiveAllocations = allocationIds.size > 0
    && !attempt.unallocated_usage
    && allocationCosts.length === allocationIds.size
    && allocationCosts.every((cost) => allocationIds.has(cost.allocation_id))
    && usd.filter((entry) => entry.scope === 'allocation').every((cost) => (
      cost.coverage === 'full' && cost.overlap === 'established'
    ))
  const additiveAllocationIds = allocationCosts.length === 1
    ? new Set(allocationCosts.map((cost) => cost.allocation_id))
    : new Set(usd.filter((cost) => (
      cost.scope === 'allocation'
      && cost.allocation_id
      && cost.overlap === 'established'
      && allocationGroups.get(cost.allocation_id)?.length === 1
    )).map((cost) => cost.allocation_id))
  let knownSubtotal = allocationCosts
    .filter((cost) => additiveAllocationIds.has(cost.allocation_id))
    .reduce((sum, cost) => sum + cost.amount_usd, 0)
  // A lone partial whole-attempt charge is still a known subtotal. When
  // allocation charges also exist, however, its overlap with them is not an
  // independently established disjoint scope, so it is retained as evidence
  // but not added again.
  const attemptCosts = usd.filter((entry) => entry.scope === 'attempt')
  if (allocationCosts.length === 0 && attemptCosts.length === 1) {
    knownSubtotal = attemptCosts[0].amount.value
  }
  return {
    evidence,
    known_subtotal_usd: knownSubtotal,
    complete_amount_usd: exhaustiveAllocations ? Number(knownSubtotal.toFixed(10)) : null,
    allocation_costs: allocationCosts,
  }
}

export function calculateRateCost({ cost, tokens, assumptions = [], promptBounds = {} }) {
  if (!cost) return unavailable('no exact provider/model match')
  const malformed = malformedCategory(tokens)
  if (malformed) return unavailable(`token category ${malformed} has an unusable count`)
  const billed = billedCategories(tokens)
  if (billed.length === 0) return unavailable('no billable token usage was reported')

  const definitions = contextTierDefinitions(cost)
  const tier = selectContextTier(definitions, promptBounds)
  const selected = tier.rates ?? cost
  const rates = {}
  let amount = 0
  for (const [category, count] of billed) {
    const rateKey = CATEGORY_RATE_KEYS[category]
    const rate = rateKey ? selected[rateKey] : undefined
    if (!nonNegative(rate)) return unavailable(`rate source has no rate for token category ${category}`)
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
    assumptions: tier.assumption ? [...assumptions, tier.assumption] : [...assumptions],
    context_tier: {
      thresholds: definitions.map((definition) => definition.threshold),
      applied: tier.rates ? 'tier' : 'base',
      basis: tier.basis,
    },
  }
}

// Every context-size tier a rate source declares, in either of the catalog's
// two shapes. Neither shape is preferred: when they disagree the tier is
// ambiguous, not resolved by precedence.
function contextTierDefinitions(cost) {
  const structured = (cost.tiers ?? [])
    .filter((tier) => tier.tier?.type === 'context')
    .map((tier) => ({ threshold: tier.tier.size, rates: tier }))
  const legacy = Object.entries(cost)
    .filter(([key]) => /^context_over_\d+k$/.test(key))
    .map(([key, rates]) => ({ threshold: Number(key.match(/\d+/)[0]) * 1000, rates }))
  return [...structured, ...legacy]
}

// Base rates apply unless the billed tokens are known to be one request whose
// prompt exceeds every declared threshold under identical tier rates. Any other
// uncertainty prices at base and is disclosed as an assumption.
function selectContextTier(definitions, promptBounds) {
  if (definitions.length === 0) return { basis: 'no_tier', rates: null, assumption: null }
  const low = Math.min(...definitions.map((definition) => definition.threshold))
  const high = Math.max(...definitions.map((definition) => definition.threshold))
  const sameRates = definitions.every((definition) => (
    RATE_KEYS.every((key) => definition.rates[key] === definitions[0].rates[key])
  ))
  if (Number.isFinite(promptBounds.upper) && promptBounds.upper <= low) {
    return { basis: 'within_lowest', rates: null, assumption: null }
  }
  const lowerKnown = Number.isFinite(promptBounds.lower)
  if (promptBounds.single_request === true && lowerKnown && promptBounds.lower > high && sameRates) {
    return { basis: 'above_highest', rates: definitions[0].rates, assumption: null }
  }
  if (lowerKnown) {
    return { basis: 'ambiguous', rates: null, assumption: 'context_tier_ambiguous_priced_at_base' }
  }
  return { basis: 'unknown', rates: null, assumption: 'context_tier_unknown_priced_at_base' }
}

export function calculateCatalogCost({ entry, tokens }) {
  if (!entry) return unavailable('no exact models.dev provider/model match')
  return calculateRateCost({ cost: entry.cost, tokens })
}

// The attempt's total input bounds every request's prompt from above. Nothing
// currently reports a per-request size, so `lower` and `single_request` are only
// set by a producer that does.
function promptBoundsOf(item) {
  const inputTotal = item.usage?.token_envelopes?.input_total?.value
  const tokens = item.usage?.billing_tokens
  const billedInput = tokens
    ? (tokens.input ?? 0) + (tokens.cached_input ?? 0) + (tokens.cache_write ?? 0)
    : null
  return {
    upper: Number.isFinite(inputTotal) ? inputTotal : billedInput,
    lower: item.max_request_prompt_tokens ?? null,
    single_request: item.request_count === 1 || item.usage?.request_count === 1,
  }
}

function rateSourceProvenance({ source, entry, catalog, fallbackTable }) {
  if (source === 'models.dev') {
    return { url: catalog.url, retrieved_at: catalog.retrieved_at, response_sha256: catalog.sha256 }
  }
  return {
    table_path: fallbackTable.path,
    table_sha256: fallbackTable.sha256,
    source_url: entry.row.source_url,
    retrieved_date: entry.row.retrieved_date,
  }
}

export function buildPricingRequest({ attempt, authority }) {
  const categories = billedCategories(attemptBillingTokens(attempt)).map(([category]) => category)
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
    if (!nonNegative(rate)) {
      return unavailable(`the judge pricing finding has no rate for token category ${category}`)
    }
    rates[category] = rate
    amount += (count * rate) / divisor
  }
  return { state: 'resolved', amount_usd: amount, reason: null, rates }
}

export async function resolveAttemptCost({ attempt, catalog, fallbackTable = null, invoke, authority = null }) {
  const reported = reportedCostSummary(attempt)
  const base = {
    attempt_id: attempt.attempt_id,
    provenance: null,
    provider_reported_costs: reported.evidence,
    known_subtotal_usd: reported.known_subtotal_usd,
    allocation_costs: reported.allocation_costs,
  }
  const unresolved = (reason, extra = {}) => ({
    ...base,
    ...unavailable(reason),
    state: reported.known_subtotal_usd > 0 ? 'incomplete' : 'unavailable',
    source: reported.known_subtotal_usd > 0 ? 'provider-reported' : null,
    verification: reported.known_subtotal_usd > 0 ? 'reported' : null,
    ...extra,
  })

  // Agent Runner's own reported cost wins outright: it measured the attempt, and
  // a lookup could only second-guess it with less information.
  if (attempt.cost?.state === 'available' && nonNegative(attempt.cost.estimated_api_cost_usd)) {
    return {
      ...base,
      state: 'resolved',
      amount_usd: attempt.cost.estimated_api_cost_usd,
      known_subtotal_usd: attempt.cost.estimated_api_cost_usd,
      source: 'agent-runner-reported',
      verification: 'reported',
      reason: null,
    }
  }

  if (reported.complete_amount_usd !== null) {
    return {
      ...base,
      state: 'resolved',
      amount_usd: reported.complete_amount_usd,
      known_subtotal_usd: reported.complete_amount_usd,
      source: 'agent-runner-reported',
      verification: 'reported',
      reason: null,
    }
  }

  // A dispatch can use several observed models. When all usage is allocated,
  // price each exact identity separately and add the disjoint allocations;
  // never collapse them into a made-up whole-attempt model identity.
  if ((attempt.allocations?.length ?? 0) > 0 && !attempt.unallocated_usage) {
    const allocationCosts = []
    for (const allocation of attempt.allocations) {
      const tokens = allocation.usage?.billing_tokens
      if (!allocation.provider || !allocation.model || billedCategories(tokens).length === 0) {
        return unresolved('every model allocation needs exact identity and billable usage for pricing')
      }
      const resolution = await resolveAttemptCost({
        attempt: {
          attempt_id: `${attempt.attempt_id}:${allocation.allocation_id}`,
          invoked_cli: true,
          provider: allocation.provider,
          model: allocation.model,
          usage: {
            state: 'available',
            billing_tokens: tokens,
            billing_assumptions: allocation.usage.billing_assumptions ?? [],
            billing_derivation: allocation.usage.billing_derivation ?? null,
            token_envelopes: allocation.usage.token_envelopes,
          },
          max_request_prompt_tokens: allocation.max_request_prompt_tokens,
          cost: { state: 'unavailable', amount_usd: null },
          provider_reported_costs: [],
          allocations: [],
          unallocated_usage: null,
        },
        catalog,
        fallbackTable,
        invoke,
        authority,
      })
      if (resolution.state !== 'resolved') {
        return unresolved(`allocation ${allocation.allocation_id} could not be priced: ${resolution.reason}`)
      }
      allocationCosts.push({
        allocation_id: allocation.allocation_id,
        amount_usd: resolution.amount_usd,
        source: resolution.source,
        verification: resolution.verification,
        provenance: resolution.provenance,
      })
    }
    const amount = Number(allocationCosts.reduce((sum, cost) => sum + cost.amount_usd, 0).toFixed(10))
    const sources = [...new Set(allocationCosts.map((cost) => cost.source))]
    const verification = weakestVerification(allocationCosts.map((cost) => cost.verification))
    return {
      ...base,
      state: 'resolved',
      amount_usd: amount,
      known_subtotal_usd: amount,
      allocation_costs: allocationCosts,
      source: sources.length === 1 ? sources[0] : 'mixed-allocation-pricing',
      verification,
      reason: null,
      provenance: { allocations: allocationCosts.map(({ allocation_id, provenance }) => ({ allocation_id, provenance })) },
    }
  }

  const tokens = attempt.usage?.state === 'available' ? attemptBillingTokens(attempt) : null
  const malformed = malformedCategory(tokens)
  if (malformed) {
    return unresolved(`token category ${malformed} has an unusable count`)
  }
  if (billedCategories(tokens).length === 0) {
    return unresolved(attempt.usage?.billing_reason ?? 'no reported token usage to price this attempt with')
  }

  if (!attempt.provider || !attempt.model) {
    return unresolved('exact provider and model identity are required for pricing')
  }

  const assumptions = attempt.usage?.billing_assumptions ?? []
  const billingDerivation = attempt.usage?.billing_derivation ?? null
  const promptBounds = promptBoundsOf(attempt)
  const failures = []
  for (const [source, entry] of [
    ['models.dev', lookupCatalogEntry(catalog, attempt.provider, attempt.model)],
    ['fallback-table', lookupFallbackRate(fallbackTable, attempt.provider, attempt.model)],
  ]) {
    const calculated = calculateRateCost({ cost: entry?.cost, tokens, assumptions, promptBounds })
    if (calculated.state !== 'resolved') {
      failures.push(`${source}: ${calculated.reason}`)
      continue
    }
    return {
      ...base,
      state: 'resolved',
      amount_usd: calculated.amount_usd,
      known_subtotal_usd: calculated.amount_usd,
      source,
      verification: calculated.assumptions.length > 0 ? 'estimated' : 'catalog',
      reason: null,
      provenance: {
        requested_provider: attempt.provider,
        requested_model: attempt.model,
        matched_provider: entry.provider,
        matched_model: entry.model,
        rates: calculated.rates,
        unit: calculated.unit,
        token_categories: calculated.token_categories,
        assumptions: calculated.assumptions,
        billing_derivation: billingDerivation,
        context_tier: calculated.context_tier,
        rate_source: source,
        ...rateSourceProvenance({ source, entry, catalog, fallbackTable }),
      },
    }
  }
  const lookupFailures = failures.join('; ')

  if (!invoke) {
    return unresolved(lookupFailures)
  }

  let finding
  try {
    finding = parsePricingFinding(await invoke(buildPricingRequest({ attempt, authority })), attempt)
  } catch (error) {
    return unresolved(`${lookupFailures}; ${error.message}`)
  }
  if (!finding.found) {
    return unresolved(`${lookupFailures}; ${finding.reason}`)
  }
  // An answer about another model is an answer to another question. Accepting it
  // is exactly the similar-name inference this module forbids.
  if (finding.matched_model !== attempt.model || finding.matched_provider !== attempt.provider) {
    return unresolved(
      `the judge matched ${finding.matched_provider}/${finding.matched_model}, not ${attempt.provider}/${attempt.model}`,
    )
  }

  const priced = calculateFindingCost({ finding, tokens })
  if (priced.state !== 'resolved') {
    return unresolved(priced.reason)
  }

  return {
    ...base,
    state: 'resolved',
    amount_usd: priced.amount_usd,
    known_subtotal_usd: priced.amount_usd,
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
      assumptions,
      billing_derivation: billingDerivation,
    },
  }
}

// True when at least one CLI attempt lacks a reported cost. The catalog is a
// live network resource, so it is fetched only when something actually needs
// pricing rather than once per run out of habit.
export function needsPricingLookup(attempts = []) {
  return attempts.some((attempt) => (
    attempt.invoked_cli
    && !(attempt.cost?.state === 'available' && nonNegative(attempt.cost.estimated_api_cost_usd))
    && reportedCostSummary(attempt).complete_amount_usd === null
    && (
      (attempt.provider && attempt.model)
      || ((attempt.allocations?.length ?? 0) > 0
        && !attempt.unallocated_usage
        && attempt.allocations.every((allocation) => allocation.provider && allocation.model))
    )
  ))
}

export async function resolveImplementationPricing({ attempts = [], catalog, fallbackTable = null, invoke, authority = null }) {
  const costs = []
  // Sequential: the pricing judge shares one authority and rate budget with the
  // product judges, and a lookup failure must stay attributable to its attempt.
  for (const attempt of attempts.filter((entry) => entry.invoked_cli)) {
    costs.push(await resolveAttemptCost({ attempt, catalog, fallbackTable, invoke, authority }))
  }
  const unresolved = costs.filter((entry) => entry.state !== 'resolved')
  const sources = [...new Set(costs.map((entry) => entry.source).filter(Boolean))]
  const complete = unresolved.length === 0
  const resolvedVerifications = costs
    .filter((entry) => entry.state === 'resolved')
    .map((entry) => entry.verification)
  return {
    costs,
    complete,
    ...summarizeVerification(resolvedVerifications),
    verified: complete && resolvedVerifications.every((state) => ['reported', 'catalog'].includes(state)),
    fallback_table: fallbackTable
      ? {
          path: fallbackTable.path,
          state: fallbackTable.state,
          sha256: fallbackTable.sha256,
          reason: fallbackTable.reason,
          row_count: fallbackTable.row_count,
        }
      : null,
    sources,
    unresolved_attempts: unresolved.map((entry) => entry.attempt_id),
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
