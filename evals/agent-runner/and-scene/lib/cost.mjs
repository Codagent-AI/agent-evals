// Agent-and-model implementation cost aggregation.
//
// Attempts aggregate by the exact tuple `agent role + provider + model`. The
// tuple is exact on purpose: two models that merely look alike bill differently,
// so folding them together would report a number nobody can reproduce.
//
// The headline total is deliberately fragile. It exists only when every CLI
// attempt has a defensible cost; one unresolved attempt turns it into a
// known-cost subtotal plus an explicit gap. Treating that attempt as zero would
// produce a confident, wrong, smaller number — the failure mode this whole
// module is built to avoid.
//
// Nothing here feeds scoring. Cost is reported so runs can be compared, and two
// runs with identical products score identically however much they cost.

// Sums of decimal cents accumulate binary float error (0.01 + 0.02 becomes
// 0.030000000000000002). Rounding to sub-microdollar precision keeps reported
// totals readable without discarding any real cost.
const USD_PRECISION = 10

function roundUsd(value) {
  return Number(value.toFixed(USD_PRECISION))
}

function rowKey(attempt) {
  return JSON.stringify([attempt.agent_role, attempt.provider, attempt.model])
}

function addTokens(into, tokens) {
  if (!tokens || typeof tokens !== 'object') return into
  const totals = into ?? {}
  for (const [category, value] of Object.entries(tokens)) {
    if (!Number.isFinite(value)) continue
    totals[category] = (totals[category] ?? 0) + value
  }
  return totals
}

function addTokenTotals(into, totals) {
  if (!totals || typeof totals !== 'object') return into
  const next = into ?? { input: 0, output: 0, total: 0 }
  for (const category of ['input', 'output', 'total']) {
    if (Number.isFinite(totals[category])) next[category] += totals[category]
  }
  return next
}

function verificationOf(sources) {
  if (sources.length === 0) return null
  return sources.includes('judge-web-search') ? 'unverified' : 'verified'
}

// `attemptsComplete` is false when Agent Runner's metrics were rejected or its
// history was partial. Without it, an empty or truncated attempt list would
// aggregate to a confident $0.00 — the most misleading number this module could
// produce, because nothing about it looks wrong.
export function aggregateImplementationCost({ attempts = [], costs = [], attemptsComplete = true }) {
  const byAttempt = new Map(costs.map((entry) => [entry.attempt_id, entry]))
  const rows = new Map()
  const unresolved = []
  let knownSubtotal = 0

  // Only work executed inside the Agent Runner implementation workflow is
  // priced. Shell steps, and every eval-owned invocation, are out of scope by
  // construction rather than by subtraction.
  for (const attempt of attempts.filter((entry) => entry.invoked_cli)) {
    const key = rowKey(attempt)
    const row = rows.get(key) ?? {
      agent_role: attempt.agent_role,
      tool: attempt.tool ?? null,
      provider: attempt.provider,
      model: attempt.model,
      attempt_count: 0,
      attempt_ids: [],
      tokens: null,
      token_totals: null,
      attempts_missing_usage: 0,
      attempts_missing_token_totals: 0,
      resolved_amount_usd: 0,
      resolved_count: 0,
      sources: [],
      unresolved_attempts: [],
    }

    row.attempt_count += 1
    row.attempt_ids.push(attempt.attempt_id)
    if (attempt.usage?.state === 'available') {
      row.tokens = addTokens(row.tokens, attempt.usage.tokens)
      row.token_totals = addTokenTotals(row.token_totals, attempt.usage.token_totals)
      if (!attempt.usage.token_totals) row.attempts_missing_token_totals += 1
    } else {
      row.attempts_missing_usage += 1
      row.attempts_missing_token_totals += 1
    }

    const resolution = byAttempt.get(attempt.attempt_id)
    // Non-negative, not merely finite: a negative amount is malformed data, and
    // admitting one would let a single bad row silently reduce the total.
    if (resolution?.state === 'resolved' && Number.isFinite(resolution.amount_usd) && resolution.amount_usd >= 0) {
      row.resolved_amount_usd += resolution.amount_usd
      row.resolved_count += 1
      knownSubtotal += resolution.amount_usd
      if (!row.sources.includes(resolution.source)) row.sources.push(resolution.source)
    } else {
      row.unresolved_attempts.push(attempt.attempt_id)
      unresolved.push(attempt.attempt_id)
    }

    rows.set(key, row)
  }

  const complete = unresolved.length === 0 && attemptsComplete
  const rendered = [...rows.values()].map((row) => {
    const rowComplete = row.unresolved_attempts.length === 0
    return {
      agent_role: row.agent_role,
      tool: row.tool,
      provider: row.provider,
      model: row.model,
      attempt_count: row.attempt_count,
      attempt_ids: row.attempt_ids,
      tokens: row.tokens,
      token_totals: row.token_totals,
      token_categories: row.tokens ? Object.keys(row.tokens).sort() : [],
      usage_complete: row.attempts_missing_usage === 0,
      attempts_missing_usage: row.attempts_missing_usage,
      token_totals_complete: row.attempts_missing_token_totals === 0,
      attempts_missing_token_totals: row.attempts_missing_token_totals,
      cost: {
        // A row missing any attempt's cost reports what is known and says so,
        // rather than presenting a partial sum as the row's cost.
        state: rowComplete ? 'available' : 'incomplete',
        amount_usd: row.resolved_count > 0 ? roundUsd(row.resolved_amount_usd) : null,
        sources: row.sources,
        unresolved_attempts: row.unresolved_attempts,
      },
      verification: verificationOf(row.sources),
      complete: rowComplete,
    }
  })
  const attemptCount = rendered.reduce((sum, row) => sum + row.attempt_count, 0)
  const attemptsMissingUsage = rendered.reduce((sum, row) => sum + row.attempts_missing_usage, 0)
  const attemptsMissingTokenTotals = rendered.reduce(
    (sum, row) => sum + row.attempts_missing_token_totals,
    0,
  )
  const usageTokens = rendered.reduce((sum, row) => addTokens(sum, row.tokens), null)
  const usageTokenTotals = rendered.reduce(
    (sum, row) => addTokenTotals(sum, row.token_totals),
    null,
  )
  const usageComplete = attemptsComplete
    && attemptCount > 0
    && attemptsMissingUsage === 0
    && attemptsMissingTokenTotals === 0

  return {
    rows: rendered,
    usage: {
      state: usageComplete
        ? 'available'
        : (usageTokens || usageTokenTotals ? 'partial' : 'unavailable'),
      complete: usageComplete,
      attempt_count: attemptCount,
      attempts_missing_usage: attemptsMissingUsage,
      attempts_missing_token_totals: attemptsMissingTokenTotals,
      tokens: usageTokens,
      token_totals: usageTokenTotals,
    },
    total: {
      state: complete ? 'available' : 'unavailable',
      estimated_api_cost_usd: complete ? roundUsd(knownSubtotal) : null,
      known_cost_subtotal_usd: roundUsd(knownSubtotal),
      complete,
      unresolved_attempts: unresolved,
      reason: attemptsComplete
        ? (complete ? null : 'one or more agent attempts have no defensible cost')
        : 'the Agent Runner attempt history is incomplete',
    },
    scoring_effect: 'none',
  }
}

// Eval-owned work — judging, evidence repair, pricing lookup, reporting — is
// reported when it is measurable and is never priced or added to the
// implementation total. Mixing the two would make the benchmark's own overhead
// look like a property of the candidate.
export function summarizeEvalOwnedUsage(entries = []) {
  let tokens = null
  let tokenTotals = null
  let available = 0
  const grouped = new Map()
  for (const entry of entries) {
    const state = entry.usage?.state ?? (entry.tokens ? 'available' : 'unavailable')
    const measured = state === 'available' && entry.tokens
    if (measured) {
      available += 1
      tokens = addTokens(tokens, entry.tokens)
      tokenTotals = addTokenTotals(tokenTotals, entry.token_totals)
    }
    const key = JSON.stringify([entry.phase ?? null, entry.provider ?? null, entry.model ?? null])
    const row = grouped.get(key) ?? {
      phase: entry.phase ?? null,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      attempt_count: 0,
      attempts_missing_usage: 0,
      tokens: null,
      token_totals: null,
    }
    row.attempt_count += 1
    if (measured) {
      row.tokens = addTokens(row.tokens, entry.tokens)
      row.token_totals = addTokenTotals(row.token_totals, entry.token_totals)
    } else {
      row.attempts_missing_usage += 1
    }
    grouped.set(key, row)
  }
  const missing = entries.length - available
  return {
    state: entries.length === 0 ? 'unavailable' : (missing === 0 ? 'available' : (available > 0 ? 'partial' : 'unavailable')),
    complete: entries.length > 0 && missing === 0,
    attempt_count: entries.length,
    attempts_missing_usage: missing,
    priced: false,
    included_in_implementation_total: false,
    tokens,
    token_totals: tokenTotals,
    token_categories: tokens ? Object.keys(tokens).sort() : [],
    by_phase: [...grouped.values()].map((row) => ({
      ...row,
      usage_complete: row.attempts_missing_usage === 0,
    })),
  }
}
