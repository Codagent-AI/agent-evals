import { weakestVerification } from './pricing.mjs'
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
  return JSON.stringify([attempt.agent_role, attempt.provider, attempt.model, attempt.allocation ?? 'attempt'])
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
  const next = into ? { ...into } : {}
  for (const category of ['input', 'output', 'total']) {
    if (Number.isFinite(totals[category])) next[category] = (next[category] ?? 0) + totals[category]
  }
  return Object.keys(next).length > 0 ? next : into
}

function completeTokenTotals(totals) {
  return ['input', 'output', 'total'].every((category) => Number.isFinite(totals?.[category]))
}

function verificationOf(states) {
  const weakest = weakestVerification(states)
  return weakest === 'unverified' || weakest === 'estimated' ? weakest : (weakest ? 'verified' : null)
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
  let usageTokens = null
  let usageTokenTotals = null
  let attemptsMissingUsage = 0
  let attemptsMissingTokenTotals = 0
  const cliAttempts = attempts.filter((entry) => entry.invoked_cli)

  // Only work executed inside the Agent Runner implementation workflow is
  // priced. Shell steps, and every eval-owned invocation, are out of scope by
  // construction rather than by subtraction.
  for (const attempt of cliAttempts) {
    const measured = ['available', 'partial'].includes(attempt.usage?.state)
    if (measured) {
      usageTokens = addTokens(usageTokens, attempt.usage.tokens)
      usageTokenTotals = addTokenTotals(usageTokenTotals, attempt.usage.token_totals)
      if (!completeTokenTotals(attempt.usage.token_totals)) attemptsMissingTokenTotals += 1
    } else {
      attemptsMissingUsage += 1
      attemptsMissingTokenTotals += 1
    }

    const resolution = byAttempt.get(attempt.attempt_id)
    if (resolution?.state === 'resolved' && Number.isFinite(resolution.amount_usd) && resolution.amount_usd >= 0) {
      knownSubtotal += resolution.amount_usd
    } else {
      if (Number.isFinite(resolution?.known_subtotal_usd) && resolution.known_subtotal_usd >= 0) {
        knownSubtotal += resolution.known_subtotal_usd
      }
      unresolved.push(attempt.attempt_id)
    }

    const pieces = [
      ...(attempt.allocations ?? []).map((allocation) => ({ ...allocation, allocation: 'attributed' })),
      ...(attempt.unallocated_usage ? [{ ...attempt.unallocated_usage, allocation: 'unallocated', provider: null, model: null, effort: null }] : []),
    ]
    const single = pieces.length <= 1
    const fragments = single ? [{
      allocation: 'attempt', allocation_id: pieces[0]?.allocation_id ?? null,
      provider: pieces[0]?.provider ?? attempt.provider,
      model: pieces[0]?.model ?? attempt.model,
      effort: pieces[0]?.effort ?? attempt.effort,
      usage: pieces[0]?.usage ?? attempt.usage,
    }] : [...pieces, ...(resolution?.state === 'resolved' && !resolution.allocation_costs?.length
      ? [{ allocation: 'unattributed_cost', allocation_id: null, provider: null, model: null, usage: null }] : [])]

    for (const fragment of fragments) {
      const descriptor = {
        agent_role: attempt.agent_role,
        tool: attempt.tool ?? null,
        provider: fragment.provider ?? null,
        model: fragment.model ?? null,
        allocation: fragment.allocation,
      }
      const key = rowKey(descriptor)
      const row = rows.get(key) ?? {
        ...descriptor,
        attempt_count: 0,
        participating_attempt_count: 0,
        attempt_ids: [],
        allocation_ids: [],
        tokens: null,
        token_totals: null,
        attempts_missing_usage: 0,
        attempts_partial_usage: 0,
        attempts_missing_token_totals: 0,
        missing_usage_attempt_ids: [],
        partial_usage_attempt_ids: [],
        missing_token_total_attempt_ids: [],
        resolved_amount_usd: 0,
        resolved_count: 0,
        sources: [],
        unresolved_attempts: [],
        not_allocated_attempts: [],
        verifications: [],
      }
      if (!row.attempt_ids.includes(attempt.attempt_id)) {
        row.attempt_count += 1
        row.participating_attempt_count += 1
        row.attempt_ids.push(attempt.attempt_id)
      }
      if (fragment.allocation_id) row.allocation_ids.push(fragment.allocation_id)
      const fragmentMeasured = fragment.usage?.tokens || fragment.usage?.token_totals
      if (fragmentMeasured) {
        row.tokens = addTokens(row.tokens, fragment.usage.tokens)
        row.token_totals = addTokenTotals(row.token_totals, fragment.usage.token_totals)
        if (fragment.usage.state === 'partial' && !row.partial_usage_attempt_ids?.includes(attempt.attempt_id)) {
          row.attempts_partial_usage += 1
          row.partial_usage_attempt_ids.push(attempt.attempt_id)
        }
        if (
          !completeTokenTotals(fragment.usage.token_totals)
          && !row.missing_token_total_attempt_ids?.includes(attempt.attempt_id)
        ) {
          row.attempts_missing_token_totals += 1
          row.missing_token_total_attempt_ids.push(attempt.attempt_id)
        }
      } else {
        if (!row.missing_usage_attempt_ids?.includes(attempt.attempt_id)) {
          row.attempts_missing_usage += 1
          row.missing_usage_attempt_ids.push(attempt.attempt_id)
        }
        if (!row.missing_token_total_attempt_ids?.includes(attempt.attempt_id)) {
          row.attempts_missing_token_totals += 1
          row.missing_token_total_attempt_ids.push(attempt.attempt_id)
        }
      }

      const allocationCost = resolution?.allocation_costs?.find(
        (entry) => entry.allocation_id === fragment.allocation_id,
      )
      const rowAmount = fragment.allocation === 'unattributed_cost' ? resolution?.amount_usd
        : (fragment.allocation === 'attempt' && resolution?.state === 'resolved' ? resolution.amount_usd : allocationCost?.amount_usd)
      if (Number.isFinite(rowAmount) && rowAmount >= 0) {
        row.resolved_amount_usd += rowAmount
        row.resolved_count += 1
        const source = allocationCost?.source ?? resolution.source
        if (source && !row.sources.includes(source)) row.sources.push(source)
        row.verifications.push(allocationCost?.verification ?? resolution.verification)
      }
      if (pieces.length > 1 && resolution?.state === 'resolved' && !resolution.allocation_costs?.length
        && fragment.allocation !== 'unattributed_cost') {
        if (!row.not_allocated_attempts.includes(attempt.attempt_id)) row.not_allocated_attempts.push(attempt.attempt_id)
      } else if (!Number.isFinite(rowAmount) || rowAmount < 0 || allocationCost?.state === 'incomplete') {
        if (!row.unresolved_attempts.includes(attempt.attempt_id)) {
          row.unresolved_attempts.push(attempt.attempt_id)
        }
      }
      rows.set(key, row)
    }
  }

  const complete = unresolved.length === 0 && attemptsComplete
  const rendered = [...rows.values()].map((row) => {
    const rowComplete = row.unresolved_attempts.length === 0
    return {
      agent_role: row.agent_role,
      tool: row.tool,
      provider: row.provider,
      model: row.model,
      allocation: row.allocation,
      attempt_count: row.attempt_count,
      participating_attempt_count: row.participating_attempt_count,
      attempt_ids: row.attempt_ids,
      allocation_ids: row.allocation_ids,
      tokens: row.tokens,
      token_totals: row.token_totals,
      token_categories: row.tokens ? Object.keys(row.tokens).sort() : [],
      usage_complete: row.attempts_missing_usage === 0 && row.attempts_partial_usage === 0,
      attempts_missing_usage: row.attempts_missing_usage,
      attempts_partial_usage: row.attempts_partial_usage,
      token_totals_complete: row.attempts_missing_token_totals === 0,
      attempts_missing_token_totals: row.attempts_missing_token_totals,
      cost: {
        // A row missing any attempt's cost reports what is known and says so,
        // rather than presenting a partial sum as the row's cost.
        state: rowComplete ? (row.not_allocated_attempts.length ? 'not_allocated' : 'available') : 'incomplete',
        amount_usd: row.resolved_count > 0 ? roundUsd(row.resolved_amount_usd) : null,
        sources: row.sources,
        unresolved_attempts: row.unresolved_attempts,
        not_allocated_attempts: row.not_allocated_attempts,
      },
      verification: verificationOf(row.verifications),
      complete: rowComplete,
    }
  })
  const stepCosts = buildStepCosts({ attempts, costs })
  const resolvedVerifications = cliAttempts.map((attempt) => byAttempt.get(attempt.attempt_id)).filter((entry) => entry?.state === 'resolved').map((entry) => entry.verification)
  const attemptCount = cliAttempts.length
  const usageComplete = attemptsComplete
    && attemptCount > 0
    && attemptsMissingUsage === 0
    && attemptsMissingTokenTotals === 0
    && cliAttempts.every((attempt) => attempt.usage?.state === 'available')

  return {
    rows: rendered,
    ...stepCosts,
    dispatch_count: attemptCount,
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
      verification: weakestVerification(resolvedVerifications),
      includes_estimated: resolvedVerifications.includes('estimated'),
      includes_unverified: resolvedVerifications.includes('unverified'),
      unresolved_attempts: unresolved,
      reason: attemptsComplete
        ? (complete ? null : 'one or more agent attempts have no defensible cost')
        : 'the Agent Runner attempt history is incomplete',
    },
    scoring_effect: 'none',
  }
}

export function buildStepCosts({ attempts = [], costs = [] }) {
  const byAttempt = new Map(costs.map((cost) => [cost.attempt_id, cost]))
  const groups = new Map()
  const steps = []
  for (const attempt of attempts.filter((entry) => entry.invoked_cli)) {
    const path = [attempt.prefix, attempt.step].filter(Boolean).join('/') || null
    const first = (attempt.prefix || attempt.step || '').split('/')[0]
    const top = first ? first.replace(/:\d+$/, '') : null
    const resolution = byAttempt.get(attempt.attempt_id)
    const resolved = resolution?.state === 'resolved' && Number.isFinite(resolution.amount_usd)
    const allocations = (resolution?.allocation_costs ?? []).map((cost) => {
      const allocation = attempt.allocations?.find((item) => item.allocation_id === cost.allocation_id)
      return { allocation_id: cost.allocation_id, provider: allocation?.provider ?? null,
        model: allocation?.model ?? null, amount_usd: cost.amount_usd ?? null,
        source: cost.source ?? null, verification: cost.verification ?? null }
    })
    const entry = { attempt_id: attempt.attempt_id, step_path: path, top_level_step: top,
      producer: attempt.measurement_producer ?? attempt.tool ?? null, agent_role: attempt.agent_role ?? null,
      cli: attempt.cli ?? null, provider: attempt.provider ?? null, model: attempt.model ?? null,
      billing_tokens: attempt.usage?.billing_tokens ?? null, amount_usd: resolved ? resolution.amount_usd : null,
      known_subtotal_usd: resolution?.known_subtotal_usd ?? 0,
      state: resolution?.state ?? 'unavailable', source: resolution?.source ?? null,
      verification: resolved ? resolution.verification ?? null : null,
      assumptions: resolution?.provenance?.assumptions ?? [], reason: resolved ? null : resolution?.reason ?? 'cost unavailable',
      duration_ms: attempt.duration_ms ?? null, allocations }
    steps.push(entry)
    const group = groups.get(top) ?? { top_level_step: top, label: top ?? 'unattributed', attempt_count: 0,
      attempt_ids: [], known_subtotal_usd: 0, amount_usd: 0, complete: true, verifications: [] }
    group.attempt_count += 1; group.attempt_ids.push(attempt.attempt_id)
    group.known_subtotal_usd += entry.known_subtotal_usd
    if (resolved) { group.amount_usd += resolution.amount_usd; group.verifications.push(resolution.verification) }
    else group.complete = false
    groups.set(top, group)
  }
  const ordered = [...groups.values()].sort((a, b) => a.top_level_step === null ? 1 : b.top_level_step === null ? -1 : 0)
  return { steps, step_rollup: ordered.map(({ verifications, ...group }) => ({ ...group,
    known_subtotal_usd: roundUsd(group.known_subtotal_usd), amount_usd: group.complete ? roundUsd(group.amount_usd) : null,
    verification: weakestVerification(verifications) })) }
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
