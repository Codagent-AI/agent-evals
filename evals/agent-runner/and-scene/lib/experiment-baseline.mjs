export const RECORD_SCHEMA_VERSION = 1
export const SUPPORTED_RESULT_SCHEMA_VERSIONS = [8]
export const SOURCES = ['accepted-candidate', 'profile-change', 'manual']
const WORKFLOW_FIELDS = ['workflow', 'workflow_path', 'task_level_compliance', 'final_validator', 'skip_validator']
const PROFILE_FIELDS = ['cli', 'model', 'effort', 'agent']
const RUBRIC_FIELDS = ['rubric_id', 'version', 'sha256']
const value = x => x ?? null
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const copyFields = (x, fields) => Object.fromEntries(fields.map(field => [field, value(x?.[field])]))
const refusal = (entry, code, message) => ({ directory: entry?.directory ?? null, run_id: entry?.run_id ?? null, code, message })
const entryOf = item => item && Object.hasOwn(item, 'entry') ? item.entry : item
const snapshotOf = item => item?.reviewSnapshot ?? null
const timestamp = now => typeof now === 'string' ? now : (now instanceof Date ? now : now()).toISOString()

export function emptyRecord() { return { schema_version: RECORD_SCHEMA_VERSION, current: null, anchor: null, history: [] } }

export function validateBaseline(baseline, path = 'current', anchor = path === 'anchor') {
  const fail = (field, message) => { throw Error(`${path}.${field}: ${message}`) }
  if (!object(baseline)) fail('', 'must be a baseline object')
  if (!Array.isArray(baseline.reps) || baseline.reps.length === 0) fail('reps', 'must be a non-empty array')
  const ids = new Set()
  baseline.reps.forEach((rep, i) => {
    if (!object(rep) || typeof rep.run_id !== 'string' || !rep.run_id) fail(`reps[${i}].run_id`, 'must be a non-empty string')
    if (ids.has(rep.run_id)) fail(`reps[${i}].run_id`, 'duplicate repetition id')
    ids.add(rep.run_id)
  })
  if (!object(baseline.identity)) fail('identity', 'must be an object')
  if (!object(baseline.summary)) fail('summary', 'must be an object')
  if (!ids.has(baseline.median_rep)) fail('median_rep', `${JSON.stringify(baseline.median_rep)} is not a repetition`)
  if (!object(baseline.human_review)) fail('human_review', 'must be an object')
  if (!ids.has(baseline.human_review.run_id)) fail('human_review.run_id', 'is not a repetition')
  if (typeof baseline.human_review.is_current_median !== 'boolean') fail('human_review.is_current_median', 'must be a boolean')
  if (!SOURCES.includes(baseline.source)) fail('source', 'invalid source')
  for (const field of ['reason', 'set_at']) if (typeof baseline[field] !== 'string') fail(field, 'must be a string')
  if (anchor) for (const field of ['anchored_at', 'anchor_reason']) if (typeof baseline[field] !== 'string') fail(field, 'must be a string')
  return baseline
}

export function validateRecord(raw) {
  if (!object(raw)) throw Error('record: must be an object')
  if (raw.schema_version !== RECORD_SCHEMA_VERSION) throw Error(`schema_version: unsupported ${JSON.stringify(raw.schema_version)}; supported: ${RECORD_SCHEMA_VERSION}`)
  for (const field of ['current', 'anchor']) {
    if (raw[field] !== null) validateBaseline(raw[field], field, field === 'anchor')
  }
  if (!Array.isArray(raw.history)) throw Error('history: must be an array')
  raw.history.forEach((entry, i) => {
    const path = `history[${i}]`
    if (!object(entry)) throw Error(`${path}: must be an object`)
    if (!['current', 'anchor'].includes(entry.kind)) throw Error(`${path}.kind: invalid kind`)
    for (const field of ['replaced_at', 'replacement_reason']) if (typeof entry[field] !== 'string') throw Error(`${path}.${field}: must be a string`)
    validateBaseline(entry.record, `${path}.record`, entry.kind === 'anchor')
  })
  return raw
}

export function extractRepetition(result, { directory = null, addedAt, addedBy } = {}) {
  const errors = []
  const context = { directory, run_id: value(result?.run_id) }
  if (!SUPPORTED_RESULT_SCHEMA_VERSIONS.includes(result?.schema_version)) errors.push(refusal(context, 'unsupported-schema', `Unsupported result schema version ${JSON.stringify(result?.schema_version)}; supported: 8`))
  if (result?.run_kind !== 'candidate' || result?.mode !== 'agent-runner') errors.push(refusal(context, 'not-candidate', 'Not an Agent Runner candidate run'))
  const roles = Object.fromEntries(Object.entries(result?.role_configuration?.roles ?? {}).map(([name, role]) => [name, {
    configured: copyFields(role?.configured, PROFILE_FIELDS),
    observed_models: [...new Set((role?.attempts ?? []).map(x => x?.observed?.model).filter(x => x != null))].sort(),
  }]))
  const byProvider = {}
  for (const row of result?.cost?.rows ?? []) {
    if (!row?.token_totals) continue
    const provider = row.provider ?? 'unknown'
    const totals = byProvider[provider] ??= { input: 0, output: 0, total: 0 }
    for (const field of ['input', 'output', 'total']) if (typeof row.token_totals[field] === 'number') totals[field] += row.token_totals[field]
  }
  const automated = result?.automated_subtotal
  const points = automated?.complete === true && typeof automated.points === 'number' ? automated.points : null
  const entry = {
    run_id: context.run_id, added_at: addedAt, added_by: addedBy,
    rescored_from: value(result?.workflow?.events?.find(x => x?.event === 'imported-completed-run')?.source_run_id),
    runner_commit: value(result?.workflow?.provenance?.commit), skills_commit: value(result?.workflow?.agent_skills_provenance?.commit),
    workflow: copyFields(result?.workflow, WORKFLOW_FIELDS), fixture_commit: value(result?.candidate_source?.fixture_commit), roles,
    rubrics: { automated: copyFields(result?.rubrics?.automated, RUBRIC_FIELDS), human: copyFields(result?.rubrics?.human, RUBRIC_FIELDS) },
    automated_score: { points, possible: value(automated?.possible), complete: value(automated?.complete) },
    gates: { passed: value(result?.score?.gates_passed), verdicts: value(result?.score?.gates?.map(x => copyFields(x, ['id', 'verdict']))) },
    outcome: { evaluation_status: value(result?.evaluation_status), product_verdict: value(result?.product_verdict), official_score: value(result?.official_score), human_review_complete: result?.human_review?.complete === true && typeof result?.official_score === 'number' },
    tokens: { complete: result?.cost?.usage?.complete === true, totals: value(result?.cost?.usage?.token_totals), detail: value(result?.cost?.usage?.tokens), by_provider: byProvider },
    active_duration_ms: value(result?.implementation_metrics?.active_duration_ms),
    cost: copyFields(result?.cost?.total, ['state', 'complete', 'estimated_api_cost_usd', 'known_cost_subtotal_usd']),
    failure: copyFields(result, ['failure', 'failed_phase', 'product_failure']), mismatch: null,
  }
  const reviewSnapshot = { run_id: entry.run_id, official_score: value(result?.official_score), points: value(result?.human_review?.score?.total), possible: value(result?.human_review?.score?.possible), rubric: value(result?.human_review?.rubric), completed_at: value(result?.human_review?.completed_at), is_current_median: true }
  if (!entry.runner_commit) errors.push(refusal(context, 'missing-runner-commit', 'Runner commit is missing'))
  if ((entry.failure.failure !== null && entry.failure.product_failure === null) || (entry.failure.product_failure === null && points === null)) errors.push(refusal(context, 'infrastructure-failure', 'Infrastructure failure or incomplete automated score; rerun this repetition'))
  return { entry, reviewSnapshot, directory, refusals: errors }
}

export function identityOf(entry) {
  return { runner_commit: entry.runner_commit, skills_commit: entry.skills_commit, workflow: structuredClone(entry.workflow), fixture_commit: entry.fixture_commit,
    roles: Object.fromEntries(Object.entries(entry.roles).map(([name, role]) => [name, { configured: structuredClone(role.configured) }])), rubrics: structuredClone(entry.rubrics) }
}

export function compareIdentity(base, entry) {
  const other = identityOf(entry), differences = []
  const check = (field, a, b) => { if (value(a) !== value(b)) differences.push({ field, baseline: value(a), repetition: value(b) }) }
  for (const field of ['runner_commit', 'skills_commit']) check(field, base[field], other[field])
  for (const field of WORKFLOW_FIELDS) check(`workflow.${field}`, base.workflow?.[field], other.workflow?.[field])
  check('fixture_commit', base.fixture_commit, other.fixture_commit)
  for (const role of [...new Set([...Object.keys(base.roles ?? {}), ...Object.keys(other.roles ?? {})])].sort()) for (const field of PROFILE_FIELDS) check(`roles.${role}.configured.${field}`, base.roles?.[role]?.configured?.[field], other.roles?.[role]?.configured?.[field])
  for (const rubric of ['automated', 'human']) for (const field of RUBRIC_FIELDS) check(`rubrics.${rubric}.${field}`, base.rubrics?.[rubric]?.[field], other.rubrics?.[rubric]?.[field])
  return differences
}

function overlapping(a, b) { return [a.run_id, a.rescored_from].filter(Boolean).some(id => id === b.run_id || id === b.rescored_from) }
function duplicate(a, b) { return refusal(a, 'duplicate-run', `Repetitions ${a.run_id} and ${b.run_id} share an execution lineage.${a.rescored_from || b.rescored_from ? ' Rebuild with set using only the rescored directory.' : ''}`) }
function archive(record, kind, date, reason) { record.history.push({ kind, replaced_at: date, replacement_reason: reason, record: structuredClone(record[kind]) }) }
function identityRefusals(base, entry, allowMismatch, directory = null) {
  const differences = compareIdentity(base, entry), errors = []
  const runner = differences.find(x => x.field === 'runner_commit')
  if (runner) errors.push(refusal({ ...entry, directory }, 'runner-commit-mismatch', `Runner commits differ: baseline ${JSON.stringify(runner.baseline)}, repetition ${JSON.stringify(runner.repetition)}; this cannot be waived`))
  const others = differences.filter(x => x.field !== 'runner_commit')
  if (others.length && !allowMismatch) errors.push(refusal({ ...entry, directory }, 'identity-mismatch', `Identity differs: ${others.map(x => `${x.field} baseline=${JSON.stringify(x.baseline)} repetition=${JSON.stringify(x.repetition)}`).join('; ')}`))
  if (others.length && allowMismatch) entry.mismatch = { fields: others.map(x => x.field), reason: allowMismatch }
  return errors
}

export function selectMedian(reps) {
  const sorted = [...reps].sort((a, b) => {
    const x = a.automated_score.points, y = b.automated_score.points
    if (x === null && y !== null) return -1
    if (y === null && x !== null) return 1
    if (x !== y) return x - y
    return a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0
  })
  return sorted[Math.floor((sorted.length - 1) / 2)]?.run_id ?? null
}

function stats(values) {
  const mean = values.reduce((sum, x) => sum + x, 0) / values.length
  return { complete: true, mean, min: Math.min(...values), max: Math.max(...values), stddev: values.length === 1 ? null : Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1)) }
}
function metric(reps, read) {
  const values = reps.map(read), missing = reps.filter((_, i) => typeof values[i] !== 'number').map(x => x.run_id)
  return missing.length ? { complete: false, missing_run_ids: missing } : stats(values)
}
export function summarize(reps) {
  const tokensComplete = x => x.tokens.complete && typeof x.tokens.totals?.total === 'number'
  const tokens = metric(reps, x => tokensComplete(x) ? x.tokens.totals.total : null)
  const providers = [...new Set(reps.flatMap(x => Object.keys(x.tokens.by_provider)))].sort()
  const providerMissing = reps.filter(x => !tokensComplete(x)).map(x => x.run_id)
  return {
    repetitions: reps.length,
    automated_points: metric(reps, x => x.automated_score.points),
    tokens_total: tokens,
    tokens_by_provider: providerMissing.length ? { complete: false, missing_run_ids: providerMissing } : { complete: true, providers: Object.fromEntries(providers.map(provider => [provider, stats(reps.map(x => x.tokens.by_provider[provider]?.total ?? 0))])) },
    active_duration_ms: metric(reps, x => x.active_duration_ms),
    estimated_cost_usd: metric(reps, x => x.cost.complete === true ? x.cost.estimated_api_cost_usd : null),
  }
}

export function applySet(record, items, { source, reason, allowMismatch, now }) {
  const admissible = items.filter(item => entryOf(item))
  const entries = admissible.map(item => structuredClone(entryOf(item)))
  const errors = items.flatMap(item => item?.refusals ?? [])
  if (entries.length) {
    const identity = identityOf(entries[0])
    for (let i = 1; i < entries.length; i++) errors.push(...identityRefusals(identity, entries[i], allowMismatch, admissible[i]?.directory))
    for (let i = 0; i < entries.length; i++) for (let j = 0; j < i; j++) if (overlapping(entries[i], entries[j])) errors.push(duplicate({ ...entries[i], directory: admissible[i]?.directory }, entries[j]))
  }
  if (errors.length) return { refusals: errors }
  const median = selectMedian(entries), index = entries.findIndex(x => x.run_id === median)
  if (!entries[index]?.outcome.human_review_complete) return { refusals: [refusal({ ...entries[index], directory: admissible[index]?.directory }, 'median-not-reviewed', `Median repetition ${median} requires a complete human review and numeric official score`)] }
  const result = structuredClone(record), date = timestamp(now)
  if (result.current) archive(result, 'current', date, reason)
  if (source === 'profile-change' && result.anchor) { archive(result, 'anchor', date, reason); result.anchor = null }
  result.current = { source, reason, set_at: date, identity: identityOf(entries[0]), reps: entries, median_rep: median, summary: summarize(entries), human_review: structuredClone(snapshotOf(admissible[index])) }
  return { record: result }
}

export function applyAddRep(record, item, { allowMismatch, now }) {
  const directory = item?.directory ?? item?.refusals?.[0]?.directory ?? null
  if (!record.current) return { refusals: [...(item?.refusals ?? []), refusal({ ...entryOf(item), directory }, 'no-current', 'Set a baseline first')] }
  const errors = [...(item?.refusals ?? [])], entry = structuredClone(entryOf(item))
  if (!entry) return { refusals: errors }
  errors.push(...identityRefusals(record.current.identity, entry, allowMismatch, item?.directory))
  for (const old of record.current.reps) if (overlapping(entry, old)) errors.push(duplicate({ ...entry, directory: item?.directory }, old))
  if (errors.length) return { refusals: errors }
  const result = structuredClone(record)
  result.current.reps.push(entry)
  result.current.median_rep = selectMedian(result.current.reps)
  result.current.summary = summarize(result.current.reps)
  result.current.human_review.is_current_median = result.current.median_rep === result.current.human_review.run_id
  return { record: result }
}

export function applyAnchor(record, { reason, now }) {
  if (!record.current) return { refusals: [refusal(null, 'no-current', 'Set a baseline first')] }
  const current = record.current
  if (!current.human_review.is_current_median) return { refusals: [refusal(null, 'median-not-reviewed', `Current median ${current.median_rep} differs from reviewed repetition ${current.human_review.run_id}; use a fresh set including the new median's review`)] }
  const result = structuredClone(record), date = timestamp(now)
  if (result.anchor) archive(result, 'anchor', date, reason)
  result.anchor = { ...structuredClone(result.current), anchored_at: date, anchor_reason: reason }
  return { record: result }
}

export function formatShow(record) {
  const lines = [], current = record.current
  const number = (x, digits = 2) => typeof x === 'number' ? x.toFixed(digits) : 'incomplete'
  const showMetric = (label, x, digits = 2) => x.complete ? `${label}: mean ${number(x.mean, digits)}  min ${number(x.min, digits)}  max ${number(x.max, digits)}  sd ${x.stddev === null ? 'n/a' : number(x.stddev, digits)}` : `${label}: incomplete (missing: ${x.missing_run_ids.join(', ')})`
  if (!current) lines.push('No experiment baseline is set.')
  else {
    lines.push(`Experiment baseline (source: ${current.source}, set ${current.set_at})`, `Reason: ${current.reason}`, `Repetitions (${current.reps.length}):`)
    for (const rep of current.reps) {
      const score = rep.automated_score.points === null ? 'unscored' : `${number(rep.automated_score.points)}/${rep.automated_score.possible}`
      const outcome = rep.failure.product_failure ? `product failure: ${typeof rep.failure.product_failure === 'string' ? rep.failure.product_failure : JSON.stringify(rep.failure.product_failure)}` : `verdict ${rep.outcome.product_verdict ?? 'unavailable'}`
      lines.push(`  ${rep.run_id}  automated ${score}  ${outcome}  active ${rep.active_duration_ms === null ? 'incomplete' : number(rep.active_duration_ms / 60000, 1) + ' min'}  cost ${rep.cost.complete ? number(rep.cost.estimated_api_cost_usd) : 'incomplete'}${rep.mismatch ? `  [mismatch: ${rep.mismatch.fields.join(', ')} — ${rep.mismatch.reason}]` : ''}${rep.rescored_from ? `  [rescored from ${rep.rescored_from}]` : ''}`)
    }
    const s = current.summary
    const active = s.active_duration_ms.complete ? { complete: true, mean: s.active_duration_ms.mean / 60000, min: s.active_duration_ms.min / 60000, max: s.active_duration_ms.max / 60000, stddev: s.active_duration_ms.stddev === null ? null : s.active_duration_ms.stddev / 60000 } : s.active_duration_ms
    for (const [label, metric, digits] of [['Automated points', s.automated_points, 2], ['Tokens total', s.tokens_total, 0], ['Active time (min)', active, 1], ['Cost (USD)', s.estimated_cost_usd, 2]]) lines.push(showMetric(label, metric, digits))
    lines.push(s.tokens_by_provider.complete ? `Tokens by provider: ${Object.entries(s.tokens_by_provider.providers).map(([name, metric]) => `${name} mean ${number(metric.mean, 0)} min ${number(metric.min, 0)} max ${number(metric.max, 0)} sd ${metric.stddev === null ? 'n/a' : number(metric.stddev, 0)}`).join('; ')}` : `Tokens by provider: incomplete (missing: ${s.tokens_by_provider.missing_run_ids.join(', ')})`)
    lines.push(`Median repetition: ${current.median_rep}`, `Human review: ${current.human_review.run_id}  official ${number(current.human_review.official_score)}  review ${current.human_review.points}/${current.human_review.possible}`)
    if (!current.human_review.is_current_median) lines.push(`  Note: the current median repetition ${current.median_rep} is not the human-reviewed repetition ${current.human_review.run_id}.`)
  }
  const anchor = record.anchor
  lines.push(anchor ? `Anchor: set ${anchor.anchored_at} (${anchor.anchor_reason}), ${anchor.reps.length} repetitions, mean automated ${anchor.summary.automated_points.complete ? number(anchor.summary.automated_points.mean) : 'incomplete'}` : 'Anchor: none')
  return `${lines.join('\n')}\n`
}
