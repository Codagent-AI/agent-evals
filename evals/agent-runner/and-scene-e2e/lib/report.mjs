const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const number = value => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'n/a'
const row = (label, value) => `<tr><th scope="row">${escape(label)}</th><td>${value}</td></tr>`
const table = (caption, rows) => `<table><caption>${escape(caption)}</caption>${rows.length ? rows.join('') : '<tr><td>none recorded</td></tr>'}</table>`
const lines = c => c.start_line ? `:${c.start_line}${c.end_line && c.end_line !== c.start_line ? `-${c.end_line}` : ''}` : ''
const cite = c => typeof c === 'string' ? c : [c?.path ? `${c.path}${lines(c)}` : null, c?.exchange ? `exchange ${c.exchange}` : null, c?.gate ? `gate ${c.gate}` : null].filter(Boolean).join(' ') || JSON.stringify(c)
const citations = list => list?.length ? ` — citations: ${escape(list.map(cite).join('; '))}` : ''
const usd = value => Number.isFinite(value) ? `$${value.toFixed(2)}` : 'n/a'
const minutes = ms => Number.isFinite(ms) ? `${Math.round(ms / 60000)} min` : 'n/a'
const tokens = value => Number.isFinite(value) ? value.toLocaleString('en-US') : 'n/a'
function criteriaRows(product) {
  return (product?.score?.components ?? []).flatMap(component => component.subcomponents.flatMap(subcomponent => subcomponent.criteria.map(criterion => row(`${component.id} / ${criterion.id}`,
    `${escape(criterion.verdict ?? 'not observed')} (${escape(number(criterion.earned))} / ${escape(number(criterion.points))})${criterion.basis ? ` [${escape(criterion.basis)}]` : ''}${criterion.rationale ? ` — ${escape(criterion.rationale)}` : ''}${citations(criterion.citations)}`))))
}
function definitionRows(score) {
  return ['coverage', 'quality', 'fidelity'].flatMap(part => (score?.[part] ?? []).map(item => row(item.id,
    `${escape(item.verdict ?? 'not judged')}${item.basis ? ` [${escape(item.basis)}]` : ''}${item.rationale ? ` — ${escape(item.rationale)}` : ''}${citations(item.citations)}`)))
}
// A short readable form of a pinned input or profile: its identifying fields, not its full content.
function brief(value, depth = 0) {
  if (value === null || value === undefined) return 'none'
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.map(item => brief(item, depth + 1)).join(', ')
  if ((value.cli ?? value.family) && value.model) return [value.cli ?? value.family, value.model, value.effort].filter(Boolean).join(' ')
  const parts = ['id', 'path', 'version', 'commit', 'sha256'].filter(key => value[key] !== undefined && value[key] !== null && typeof value[key] !== 'object').map(key => `${key} ${value[key]}`)
  if (value.hashes && typeof value.hashes === 'object') parts.push(`hashes for ${Object.keys(value.hashes).length} versions`)
  if (Array.isArray(value.files)) parts.push(`${value.files.length} files`)
  if (Array.isArray(value.panel)) parts.push(`panel ${brief(value.panel, depth + 1)}`)
  if (parts.length || depth > 1) return parts.length ? parts.join('; ') : JSON.stringify(value)
  return Object.entries(value).map(([key, child]) => `${key}: ${brief(child, depth + 1)}`).join('; ')
}
// A summary row for a group of Runner attempts: count, time, cost and the token totals the Runner reported.
function metricsCell(summary) {
  if (!summary) return 'not recorded'
  const usage = summary.usage ?? []
  const counted = usage.filter(entry => Number.isFinite(entry.token_totals?.total))
  const cost = summary.cost?.complete && Number.isFinite(summary.cost.total_usd) ? usd(summary.cost.total_usd) : `at least ${usd(summary.cost?.known_subtotal_usd ?? 0)} (incomplete)`
  return escape(`${summary.attempts?.length ?? 0} attempts; ${minutes(summary.duration_ms)}; cost ${cost}; ${tokens(counted.reduce((sum, entry) => sum + entry.token_totals.total, 0))} tokens${counted.length < usage.length ? ` (${usage.length - counted.length} attempts without token counts)` : ''}`)
}
function workflowMetrics(metrics) {
  if (!metrics) return [row('State', 'not recorded')]
  const rows = [row('State', escape(`${metrics.state ?? 'unknown'}${metrics.reason ? ` (${metrics.reason})` : ''}`)), row('Complete', escape(metrics.complete ? 'yes' : 'no')), row('History complete', escape(metrics.history_complete ? 'yes' : 'no')), row('Active duration', escape(minutes(metrics.active_duration_ms)))]
  for (const [step, summary] of Object.entries(metrics.by_step ?? {})) rows.push(row(`Step ${step}`, metricsCell(summary)))
  for (const [role, summary] of Object.entries(metrics.by_role ?? {})) rows.push(row(`Role ${role}`, metricsCell(summary)))
  rows.push(row('Total', metricsCell(metrics.total)))
  return rows
}
// Claude's own usage fields, which the simulated user and the Claude browser judges record.
const claudeTokens = usage => Number.isFinite(usage?.input_tokens) ? ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'].reduce((sum, name) => sum + (usage[name] ?? 0), 0) : null
// Eval-owned calls grouped by who made them and on which model; a cost is shown only where calls reported one.
function evalUsage(records, errors) {
  const groups = new Map()
  for (const record of records ?? []) {
    const who = record.role ?? record.kind ?? 'judge'
    const key = `${who} / ${record.cli ?? record.provider ?? 'unknown'} ${record.model ?? ''}`.trim()
    const group = groups.get(key) ?? { calls: 0, tokens: 0, uncounted: 0, cost: 0, costed: 0 }
    const used = record.token_totals?.total ?? claudeTokens(record.role === 'simulated-user' ? record : record.usage?.tokens)
    const cost = record.cost_usd ?? record.usage?.cost_usd
    group.calls++
    if (Number.isFinite(used)) group.tokens += used; else group.uncounted++
    if (Number.isFinite(cost)) { group.cost += cost; group.costed++ }
    groups.set(key, group)
  }
  const rows = [...groups].map(([key, group]) => row(key, escape(`${group.calls} calls; ${tokens(group.tokens)} tokens${group.uncounted ? ` (${group.uncounted} calls without token counts)` : ''}${group.costed ? `; cost ${group.costed < group.calls ? `at least ${usd(group.cost)} (${group.calls - group.costed} calls without a cost)` : usd(group.cost)}` : ''}`)))
  if (errors?.length) rows.push(row('Unreadable usage lines', escape(errors.length)))
  return rows
}
function delivery(result) {
  const repo = result.delivery_repository
  const delivered = result.delivery
  if (!repo && !delivered) return []
  const rows = []
  if (repo) rows.push(row('Repository', escape(`${repo.full_name}${repo.private ? ' (private)' : ''}, id ${repo.id}, created ${repo.created_at}`)), row('Starting commit', escape(repo.starting_commit)))
  if (delivered) {
    rows.push(row('Branch', escape(delivered.branch ?? 'none')), row('Delivered commit', escape(delivered.delivered_commit ?? 'none')))
    const pr = delivered.pull_request
    rows.push(row('Pull request', pr ? escape(`#${pr.number}, ${pr.draft ? 'draft' : 'ready'}, base ${pr.base}, head ${pr.head}`) : 'none'))
    rows.push(row('Extra branches and pull requests', escape([...(delivered.extras?.branches ?? []), ...(delivered.extras?.pull_requests ?? []).map(extra => `#${extra.number ?? extra}`)].join(', ') || 'none')))
    if (delivered.bundle) rows.push(row('Retained bundle', escape(`${delivered.bundle.path} (sha256 ${delivered.bundle.sha256})`)))
    if (delivered.acceptance) rows.push(row('Acceptance evidence', escape(`${delivered.acceptance.artifacts?.length ?? 0} artifacts at ${delivered.acceptance.delivered_commit}`)))
  }
  return rows
}
function candidate(result) {
  const candidate = result.candidate
  if (!candidate) return []
  const rows = Object.entries(candidate.profiles ?? {}).map(([role, profile]) => row(`Profile ${role}`, escape(brief(profile))))
  rows.push(row('Agent Runner commit', escape(candidate.agent_runner_commit)), row('Workflow', escape(candidate.workflow ? `${candidate.workflow.reference} (name ${candidate.workflow.name ?? 'unknown'}); definition sha256 ${candidate.workflow.hash ?? 'none'}; define sha256 ${candidate.workflow.define_hash ?? 'none'}` : 'none')),
    row('Agent Skills commit', escape(candidate.agent_skills_commit)), row('Validator reviewer', escape(candidate.validator_reviewer ? `${(candidate.validator_reviewer.clis ?? []).join(', ')}; config sha256 ${candidate.validator_reviewer.config_sha256}` : 'none')))
  return rows
}
function provenance(result) {
  const p = result.provenance ?? {}
  const manifest = value => value ? `${value.files?.length ?? 0} files, ${value.invocations?.length ?? 0} invocations` : 'none'
  return [row('Final evidence manifest', escape(manifest(p.evidence_manifest))), row('Define evidence manifest', escape(manifest(p.define_evidence_manifest))),
    row('Collected definition', escape(p.collection ? `${p.collection.files?.length ?? 0} files at ${p.collection.head}` : 'none')),
    row('Pinned inputs', escape(JSON.stringify(p.pinned_inputs) === JSON.stringify(result.series_identity) ? 'the series identity above' : brief(p.pinned_inputs))),
    row('Agent Runner run', escape(result.runner_run_id ?? 'none')), row('Token refresh interval', escape(result.token_refresh_interval_minutes === null || result.token_refresh_interval_minutes === undefined ? 'n/a' : `${result.token_refresh_interval_minutes} min`)), row('Quota waits', escape(result.quota_waits?.length ?? 0))]
}
// A readable summary first: status or failure, both scores, criteria, gates, trace, audits, risk and effects.
function headline(result) {
  const outcome = [row('Evaluation status', escape(result.evaluation_status)), row('Mode', escape(result.mode ?? 'candidate'))]
  if (!['complete', 'pending-human-review'].includes(result.evaluation_status)) {
    outcome.push(row('Owning phase', escape(result.owning_phase ?? 'unknown')), row('Error', escape(result.observed_error ?? 'none recorded')), row('Resumable', escape(result.resumable === true ? 'yes' : 'no')))
    if (result.last_active_step) outcome.push(row('Last active step', escape(result.last_active_step)))
  }
  // A resume that switched Agent Runner commits ran its phases on more than one Runner build.
  if (result.agent_runner_commits) outcome.push(row('Agent Runner commits', result.agent_runner_commits.map(entry => `${escape(entry.commit)} from ${escape(entry.from_phase ?? 'unknown phase')}`).join('; ')))
  if (result.contamination_pattern_versions) outcome.push(row('Contamination pattern versions', result.contamination_pattern_versions.map(entry => escape(entry.version)).join(', then ')))
  if (result.provisional_rubric) outcome.push(row('Product rubric', 'provisional: not yet approved from calibration evidence'))
  const definition = result.definition_score
  const product = result.product_score
  const scores = [
    row('Definition score', Number.isFinite(definition?.total) ? `${escape(number(definition.total))} / 100` : 'Not scored'),
    ...Object.entries(definition?.components ?? {}).map(([name, component]) => row(`Definition ${name}`, `${escape(number(component?.score))} / ${escape(number(component?.points))}`)),
    row('Product score', Number.isFinite(product?.score) ? `${escape(number(product.score))} / 100` : product?.incomplete ? 'Incomplete (a component could not be scored)' : 'Not scored'),
    ...(product ? [row('Product automated', Number.isFinite(product.automated_score) ? `${escape(number(product.automated_score))} / 70` : 'Incomplete'), row('Product human review', Number.isFinite(product.human_points) ? `${escape(number(product.human_points))} / 30` : 'Pending')] : []),
  ]
  const gate = g => row(g.id, `<span class="${g.passed ? 'ok' : 'bad'}">${g.passed ? 'passed' : 'failed'}</span>${g.reason ? ` — ${escape(g.reason)}` : ''}`)
  const gates = [...(definition?.gates ?? []), ...(result.product?.gates ?? [])].map(gate)
  const trace = Object.entries(result.requirement_trace?.counts ?? {}).map(([name, count]) => row(name, escape(count)))
  const traceItems = (result.requirement_trace?.items ?? []).map(item => row(item.id, `${escape(item.outcome)} — asked: ${item.asked ? 'yes' : 'no'}; coverage: ${escape(item.coverage_verdict)}; product: ${escape(item.product_delivery)}${item.shared_criteria?.length ? `; shared criteria: ${escape(item.shared_criteria.map(shared => shared.criterion).join(', '))}` : ''}${item.exchange_citations?.length ? `; ${escape(item.exchange_citations.map(cite).join('; '))}` : ''}`))
  const discovery = Object.entries(result.definition_discovery?.counts ?? {}).map(([name, count]) => row(name, escape(count)))
  const audits = [row('Contamination (define checkpoint)', escape(result.contamination_audit?.pass_1?.status ?? 'not run')), row('Contamination (after delivery)', escape(result.contamination_audit?.pass_2?.status ?? 'not run')), row('Disclosure audit', escape(result.disclosure_audit?.status ?? 'not run')), row('Leaked items', escape((result.leaked_items ?? []).join(', ') || 'none')),
    ...(result.disclosure_audit?.flags ?? []).map(flag => row(`Disclosure flag: ${flag.type}`, `${escape((flag.inventory_items ?? []).join(', ') || 'no inventory item')}${flag.rationale ? ` — ${escape(flag.rationale)}` : ''}${citations(flag.citations)}`)),
    row('Conversation reconciliation', escape(result.reconciliation ? `${result.reconciliation.status}${Number.isFinite(result.reconciliation.exchanges) ? `, ${result.reconciliation.exchanges} exchanges` : ''}` : 'not run'))]
  const effects = (result.prohibited_effects ?? []).map(effect => row('Prohibited effect', escape(effect)))
  return `<section class="headline"><h2>Summary</h2>${table('Outcome', outcome)}
${table('Scores (the two scores are never combined)', scores)}
${table('Gates', gates)}
${table('Audits', audits)}
${table('Prohibited effects', effects)}
${table('Residual risk', [row('Statement', escape(result.residual_risk))])}</section>
<section><h2>Criteria</h2>${table('Definition criteria', definitionRows(definition))}
${table('Product criteria', criteriaRows(result.product))}
${table('Requirement trace (non-scoring)', trace)}
${table('Requirement trace items', traceItems)}
${table('Definition discovery (non-scoring)', discovery)}</section>`
}
function details(result) {
  const invocations = (result.effective_invocations ?? []).map(entry => row(`${entry.phase ?? 'unknown phase'} / ${entry.role ?? 'unknown role'}`, escape(`${entry.prefix ?? entry.step ?? ''}: ${brief(entry)}`)))
  return `<section><h2>Run</h2>${table('Delivery repository', delivery(result))}
${table('Series identity', Object.entries(result.series_identity ?? {}).map(([key, value]) => row(key, escape(brief(value)))))}
${table('Candidate', candidate(result))}
${table('Effective invocations', invocations)}
${table('Provenance', provenance(result))}
${table('Workflow metrics', workflowMetrics(result.workflow_metrics))}
${table('Eval-owned usage', evalUsage(result.eval_owned_usage, result.eval_owned_usage_errors))}</section>`
}
// The report is a self-contained summary; every value is escaped, and result.json beside it holds the full detail.
export function renderReport(result) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>and-scene-e2e ${escape(result.run_id)}</title><style>body{font:16px system-ui;margin:2rem;max-width:80rem}table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #bbb;padding:.3rem .6rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}caption{font-weight:700;text-align:left}.ok{color:#176f2c}.bad{color:#a40e26}</style><h1>and-scene-e2e evaluation ${escape(result.run_id)}</h1><p>The full result is in result.json beside this report.</p>
${headline(result)}
${details(result)}
</html>
`
}
