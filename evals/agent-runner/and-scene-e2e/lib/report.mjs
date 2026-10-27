const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const number = value => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'n/a'
const row = (label, value) => `<tr><th scope="row">${escape(label)}</th><td>${value}</td></tr>`
const table = (caption, rows) => `<table><caption>${escape(caption)}</caption>${rows.length ? rows.join('') : '<tr><td>none recorded</td></tr>'}</table>`
function criteriaRows(product) {
  return (product?.score?.components ?? []).flatMap(component => component.subcomponents.flatMap(subcomponent => subcomponent.criteria.map(criterion => row(`${component.id} / ${criterion.id}`,
    `${escape(criterion.verdict ?? 'not observed')} (${escape(number(criterion.earned))} / ${escape(number(criterion.points))})${criterion.basis ? ` [${escape(criterion.basis)}]` : ''}${criterion.rationale ? ` — ${escape(criterion.rationale)}` : ''}${criterion.citations?.length ? ` — citations: ${escape(criterion.citations.map(c => typeof c === 'string' ? c : JSON.stringify(c)).join(', '))}` : ''}`))))
}
// A readable summary first; every field of the result is then inlined, so a copied report needs no assets.
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
    row('Product score', Number.isFinite(product?.score) ? `${escape(number(product.score))} / 100` : product?.incomplete ? 'Incomplete (a component could not be scored)' : 'Not scored'),
    ...(product ? [row('Product automated', Number.isFinite(product.automated_score) ? `${escape(number(product.automated_score))} / 70` : 'Incomplete'), row('Product human review', Number.isFinite(product.human_points) ? `${escape(number(product.human_points))} / 30` : 'Pending')] : []),
  ]
  const gates = (result.product?.gates ?? []).map(gate => row(gate.id, `<span class="${gate.passed ? 'ok' : 'bad'}">${gate.passed ? 'passed' : 'failed'}</span>${gate.reason ? ` — ${escape(gate.reason)}` : ''}`))
  const trace = Object.entries(result.requirement_trace?.counts ?? {}).map(([name, count]) => row(name, escape(count)))
  const traceItems = (result.requirement_trace?.items ?? []).map(item => row(item.id, `${escape(item.outcome)} — asked: ${escape(item.asked_part ?? (item.asked ? 'yes' : 'no'))}; coverage: ${escape(item.coverage_verdict)}; product: ${escape(item.product_delivery)}${item.shared_criteria?.length ? `; shared criteria: ${escape(item.shared_criteria.map(shared => shared.criterion).join(', '))}` : ''}${item.correction_citations?.length ? `; correction: ${escape(JSON.stringify(item.correction_citations))}` : ''}${item.exchange_citations?.length ? `; exchange: ${escape(JSON.stringify(item.exchange_citations))}` : ''}`))
  const audits = [row('Contamination (define checkpoint)', escape(result.contamination_audit?.pass_1?.status ?? 'not run')), row('Contamination (after delivery)', escape(result.contamination_audit?.pass_2?.status ?? 'not run')), row('Disclosure audit', escape(result.disclosure_audit?.status ?? 'not run')), row('Leaked items', escape((result.leaked_items ?? []).join(', ') || 'none'))]
  audits.push(row('Corrected items', escape(`${result.corrected_count ?? result.corrected_items?.length ?? 0}${result.corrected_items?.length ? `: ${result.corrected_items.join(', ')}` : ''}`)))
  audits.push(...(result.disclosure_audit?.flags ?? []).map(flag => row(flag.type, escape(`${flag.rationale ?? ''} ${JSON.stringify(flag.citations ?? [])}`))))
  const effects = (result.prohibited_effects ?? []).map(effect => row('Prohibited effect', escape(effect)))
  return `<section class="headline"><h2>Summary</h2>${table('Outcome', outcome)}${table('Scores (the two scores are never combined)', scores)}${table('Product criteria', criteriaRows(result.product))}${table('Gates', gates)}${table('Requirement trace (non-scoring)', trace)}${table('Requirement trace items', traceItems)}${table('Audits', audits)}${table('Prohibited effects', effects)}${table('Residual risk', [row('Statement', escape(result.residual_risk))])}</section>`
}
export function renderReport(result) {
  const fields = Object.entries(result).map(([key, value]) => `<section><h2>${escape(key)}</h2><pre>${escape(JSON.stringify(value, null, 2))}</pre></section>`).join('\n')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>and-scene-e2e ${escape(result.run_id)}</title><style>body{font:16px system-ui;margin:2rem;max-width:80rem}table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #bbb;padding:.3rem .6rem;text-align:left;vertical-align:top}caption{font-weight:700;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f6f6;padding:.75rem}.ok{color:#176f2c}.bad{color:#a40e26}</style><h1>and-scene-e2e evaluation ${escape(result.run_id)}</h1>${headline(result)}${fields}</html>`
}
