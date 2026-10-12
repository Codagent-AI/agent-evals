import { identityOf, compareIdentity, lineageOverlaps, RUBRIC_FIELDS, summarize, stats, selectMedian } from './experiment-baseline.mjs'
import { REQUEST_ROLES } from './eval-request.mjs'

const entryOf = item => item.entry ?? item
const refusal = (code, message, rep = {}) => ({ code, message, run_id: rep.run_id ?? null, directory: rep.directory ?? null })
const protectedFields = ['fixture_commit', ...['automated', 'human'].flatMap(r => RUBRIC_FIELDS.map(f => `rubrics.${r}.${f}`))]
const at = (object, path) => path.split('.').reduce((x, key) => x?.[key], object) ?? null
const profile = (identity, role) => {
  const configured = identity.roles?.[role]?.configured
  return configured ? ['cli', 'model', 'effort'].map(key => configured[key] ?? '').join(':') : null
}
const boolean = x => x === true || x === 'true' ? true : x === false || x === 'false' ? false : null
const settingValue = (identity, key) => key === 'skip_validator' ? boolean(identity.workflow?.skip_validator) : profile(identity, key)

export function admitCohorts({ baseline, candidates }) {
  const refusals = candidates.flatMap(x => x.refusals ?? [])
  const reps = candidates.filter(x => x.entry && !x.refusals?.length).map(x => x.entry)
  const distinct = []
  for (const [index, rep] of reps.entries()) {
    for (const other of [...reps.slice(0, index), ...(baseline?.reps ?? [])]) {
      if (lineageOverlaps(rep, other)) refusals.push(refusal('lineage-overlap', `Repetitions ${rep.run_id} and ${other.run_id} share an execution lineage`, rep))
    }
    if (!distinct.some(other => lineageOverlaps(rep, other)) && !(baseline?.reps ?? []).some(other => lineageOverlaps(rep, other))) distinct.push(rep)
  }
  if (distinct.length < 2) refusals.push(refusal('too-few-repetitions', 'At least two independent admitted candidate repetitions are required'))
  const identity = reps.length ? identityOf(reps[0]) : null
  for (const rep of reps.slice(1)) {
    const differences = compareIdentity(identity, rep)
    if (differences.length) refusals.push(refusal('candidate-identity-mismatch', `Identity differs: ${differences.map(x => `${x.field}: ${JSON.stringify(x.baseline)} vs ${JSON.stringify(x.repetition)}`).join('; ')}`, rep))
  }
  const seen = new Set()
  for (const base of baseline?.reps ?? []) for (const cand of reps) for (const field of protectedFields) {
    const a = at(base, field), b = at(cand, field)
    if (a === null || b === null || a !== b) {
      const key = JSON.stringify([field, a, b])
      if (!seen.has(key)) {
        seen.add(key)
        refusals.push(refusal('not-comparable', `${field}: baseline ${JSON.stringify(a)}, candidate ${JSON.stringify(b)} (baseline run ${base.run_id})`, cand))
      }
    }
  }
  const baseline_mismatches = (baseline?.reps ?? []).slice(1).flatMap(rep => {
    const fields = compareIdentity(identityOf(baseline.reps[0]), rep).filter(x => !protectedFields.includes(x.field))
    return fields.length ? [{ run_id: rep.run_id, fields, reason: rep.mismatch?.reason ?? null }] : []
  })
  return { refusals, reps, identity, baseline_mismatches }
}

export function checkRequest(settings, identity) {
  const refusals = []
  for (const key of [...REQUEST_ROLES, 'skip_validator']) {
    if (!Object.hasOwn(settings, key)) continue
    const recorded = settingValue(identity, key)
    if (settings[key] !== recorded) refusals.push(refusal('request-results-mismatch', `${key}: requested ${JSON.stringify(settings[key])}, recorded ${JSON.stringify(recorded)}`))
  }
  return refusals
}

const repositories = [
  { repo: 'Codagent-AI/agent-runner', setting: 'agent_runner_ref', field: 'runner_commit' },
  { repo: 'Codagent-AI/agent-skills', setting: 'agent_skills_ref', field: 'skills_commit' },
]
export function planCompares(settings, baseline, candidate) {
  return repositories.flatMap(({ repo, setting, field }) => {
    if (Object.hasOwn(settings, setting)) return [{ repo, kind: 'primary', base: 'main', head: candidate[field], baseline_commit: baseline[field], requested_ref: settings[setting] }]
    return baseline[field] !== candidate[field] ? [{ repo, kind: 'ancillary', base: baseline[field], head: candidate[field] }] : []
  })
}
export function classifyDifferences(settings, baseline, candidate, compares) {
  const primary = [], ancillary = []
  for (const item of compares) {
    if (item.kind === 'primary') {
      const commits = item.commits.slice(0, 20)
      primary.push({ repo: item.repo, requested_ref: item.requested_ref, recorded_commit: item.head, main_sha: item.main_sha, ahead_by: item.ahead_by, commits, omitted: Math.max(0, item.ahead_by - commits.length),
        ...(item.ahead_by === 0 ? { note: 'none-missing-from-main', ...(item.requested_ref !== 'main' ? { may_have_merged: true } : {}) } : {}) })
    } else ancillary.push({ kind: item.kind, repo: item.repo, baseline: item.base, candidate: item.head, ahead_by: item.ahead_by, behind_by: item.behind_by })
  }
  for (const key of [...REQUEST_ROLES, 'skip_validator']) {
    if (!Object.hasOwn(settings, key)) continue
    const a = settingValue(baseline, key), b = settingValue(candidate, key)
    if (a !== b) primary.push({ setting: key, baseline: a, candidate: b })
  }
  for (const diff of compareIdentity(baseline, candidate)) {
    if (['runner_commit', 'skills_commit', ...protectedFields].includes(diff.field)) continue
    const role = /^roles\.([^.]+)\.configured\.(.+)$/.exec(diff.field)
    if (role && role[2] !== 'agent' && Object.hasOwn(settings, role[1])) continue
    if (diff.field === 'workflow.skip_validator' && Object.hasOwn(settings, 'skip_validator')) continue
    ancillary.push({ field: diff.field, baseline: diff.baseline, candidate: diff.repetition })
  }
  return { primary, ancillary }
}
export function roleCosts(result) {
  const by_role = Object.create(null)
  for (const row of result?.cost?.rows ?? []) {
    if (typeof row.agent_role !== 'string' || !row.agent_role) continue
    by_role[row.agent_role] ??= 0
    if (typeof row.cost?.amount_usd === 'number') by_role[row.agent_role] += row.cost.amount_usd
  }
  return { complete: result?.cost?.total?.complete === true, by_role }
}

export function band({ kind, base, cand }) {
  const delta = cand.mean - base.mean
  const delta_pct = base.mean === 0 ? delta === 0 ? 0 : null : delta / base.mean * 100
  let sd = Math.sqrt(((base.n - 1) * (base.stddev ?? 0) ** 2 + (cand.n - 1) * (cand.stddev ?? 0) ** 2) / (base.n + cand.n - 2))
  if (kind === 'score') sd = Math.max(sd, 3)
  const se = sd * Math.sqrt(1 / base.n + 1 / cand.n)
  const z = se > 0 ? delta / se : delta === 0 ? 0 : Math.sign(delta) * Infinity
  let level = Math.abs(z) >= 1.96 ? 'clear' : Math.abs(z) >= 1.28 ? 'leaning' : 'same'
  if (kind === 'resource' && level === 'clear' && delta_pct !== null && Math.abs(delta_pct) < 15) level = 'leaning'
  const direction = level === 'same' ? null : (kind === 'score' ? delta > 0 : delta < 0) ? 'better' : 'worse'
  return { level, direction, sd, se, z: Number.isFinite(z) ? z : null, z_infinite: !Number.isFinite(z) }
}
export function compareMetrics(baselineReps, candidateReps, costs = {}) {
  const base = summarize(baselineReps), cand = summarize(candidateReps), metrics = {}
  function add(key, a, b, kind = 'resource') {
    if (!a.complete || !b.complete) {
      metrics[key] = { status: 'incomplete', missing_run_ids: [...new Set([...(a.missing_run_ids ?? []), ...(b.missing_run_ids ?? [])])] }
      return
    }
    a = { ...a, n: baselineReps.length }; b = { ...b, n: candidateReps.length }
    const delta = b.mean - a.mean
    const verdict = band({ kind, base: a, cand: b })
    if (kind === 'resource' && verdict.direction) {
      const better = verdict.direction === 'better' ? candidateReps : baselineReps
      if (better.some(x => x.failure.product_failure !== null)) verdict.includes_product_failures = true
    }
    metrics[key] = { status: 'compared', baseline: a, candidate: b, delta, delta_pct: a.mean === 0 ? delta === 0 ? 0 : null : delta / a.mean * 100, band: verdict }
  }
  add('automated_points', base.automated_points, cand.automated_points, 'score')
  add('tokens_total', base.tokens_total, cand.tokens_total)
  const providers = [...new Set([...baselineReps, ...candidateReps].flatMap(x => Object.keys(x.tokens.by_provider)))].sort()
  for (const provider of providers) {
    const read = (summary, reps) => summary.tokens_by_provider.complete ? (summary.tokens_by_provider.providers[provider] ?? stats(reps.map(() => 0))) : summary.tokens_by_provider
    add(`tokens_provider:${provider}`, read(base, baselineReps), read(cand, candidateReps))
  }
  add('active_duration_ms', base.active_duration_ms, cand.active_duration_ms)
  add('estimated_cost_usd', base.estimated_cost_usd, cand.estimated_cost_usd)
  const roles = [...new Set(['lead', 'implementor', 'tester', 'implementation-validator', ...Object.values(costs).flatMap(x => Object.keys(x.by_role ?? {}))])].sort()
  const perRole = (reps, role) => {
    const missing = reps.filter(x => x.cost.complete !== true || !costs[x.run_id]?.complete).map(x => x.run_id)
    return missing.length ? { complete: false, missing_run_ids: missing } : stats(reps.map(x => costs[x.run_id].by_role?.[role] ?? 0))
  }
  for (const role of roles) add(`cost_role:${role}`, perRole(baselineReps, role), perRole(candidateReps, role))
  return metrics
}
export function reliabilityFlags(candidateReps, baselineSummary) {
  const items = []
  for (const rep of candidateReps) {
    const failure = rep.failure.product_failure
    const gate_ids = [...new Set([...(rep.gates.verdicts ?? []).filter(x => x.verdict === 'fail').map(x => x.id), ...(failure?.failures ?? []).map(x => x.id), ...(failure?.gate ? [failure.gate] : [])].filter(Boolean))]
    if (failure !== null || rep.gates.passed === false || gate_ids.length) items.push({ kind: 'gate', run_id: rep.run_id, gate_ids, phase: failure?.phase ?? null, reason: failure?.reason ?? (failure ? String(failure) : 'Gate failed') })
    if (baselineSummary.automated_points.complete && typeof rep.automated_score.points === 'number') {
      const shortfall = baselineSummary.automated_points.mean - rep.automated_score.points
      if (shortfall > 6) items.push({ kind: 'score-shortfall', run_id: rep.run_id, points: rep.automated_score.points, shortfall })
    }
  }
  return { items, shortfall_check: baselineSummary.automated_points.complete ? 'available' : 'unavailable' }
}
export function humanReviewPointers(baseline, candidates) {
  const baselineMedian = selectMedian(baseline.reps), median = selectMedian(candidates.map(entryOf)), item = candidates.find(x => entryOf(x).run_id === median), rep = entryOf(item)
  return {
    baseline_median: baselineMedian,
    baseline: { ...baseline.human_review, is_current_median: baselineMedian === baseline.human_review.run_id },
    candidate: { run_id: median, review_by_hand: true, status: rep.outcome.human_review_complete ? 'complete' : 'pending',
      ...(rep.outcome.human_review_complete ? { official_score: rep.outcome.official_score, points: item.reviewSnapshot?.points ?? null, possible: item.reviewSnapshot?.possible ?? null, carried_from: item.reviewSnapshot?.carried_from ?? null } : {}) },
  }
}
export function buildReport({ baseline, candidates, roleCosts: costs, request, compares, eval_issue, baseline_mismatches = [] }) {
  const reps = candidates.map(entryOf)
  const provenance = [...new Set(compares.map(x => x.repo))].map(repo => {
    const ranges = compares.filter(x => x.repo === repo)
    return { repo, main_sha: ranges[0].main_sha, resolved_at: ranges[0].resolved_at, compares: ranges.map(x => ({ kind: x.kind, range: `${x.base}...${x.head}`, status: x.status })) }
  })
  return { schema_version: 1, status: 'compared', eval_issue, request,
    baseline: { source: baseline.source, set_at: baseline.set_at, repetitions: baseline.reps.length, run_ids: baseline.reps.map(x => x.run_id) },
    candidate: { repetitions: reps.length, run_ids: reps.map(x => x.run_id) },
    differences: { ...classifyDifferences(request.settings, identityOf(baseline.reps[0]), identityOf(reps[0]), compares), baseline_mismatches },
    metrics: compareMetrics(baseline.reps, reps, costs), flags: reliabilityFlags(reps, summarize(baseline.reps)),
    human_review: humanReviewPointers(baseline, candidates), provenance: { repositories: provenance } }
}
