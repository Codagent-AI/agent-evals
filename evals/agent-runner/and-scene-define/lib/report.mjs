const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const number = value => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : 'n/a'
const row = (label, value) => `<tr><th scope="row">${escape(label)}</th><td>${value}</td></tr>`
const table = (caption, rows) => rows.length ? `<table><caption>${escape(caption)}</caption>${rows.join('')}</table>` : ''
// A readable summary first: status or failure, scores, gates, leaks and
// discovery. The score is the result; there is no pass/fail verdict. Every
// value is escaped; the full JSON follows for detail.
function headline(result) {
  const outcome = [row('Evaluation status', escape(result.evaluation_status ?? 'unknown')), row('Mode', escape(result.mode ?? 'candidate'))]
  if (result.evaluation_status !== 'complete') {
    outcome.push(row('Owning phase', escape(result.owning_phase ?? 'unknown')), row('Error', escape(result.observed_error ?? 'none recorded')), row('Resumable', escape(result.resumable === true ? 'yes' : 'no')))
    if (result.last_active_step) outcome.push(row('Last active step', escape(result.last_active_step)))
  }
  const scores = Number.isFinite(result.total)
    ? [row('Total', `${escape(number(result.total))} / 100`), ...Object.entries(result.components ?? {}).map(([name, c]) => row(name, `${escape(number(c?.score))} / ${escape(number(c?.points))}`))]
    : [row('Total', result.score_unavailable ? `Not scored (${escape(result.score_unavailable)})` : 'Not scored')]
  if (Array.isArray(result.leaked_items)) scores.push(row('Leaked items', escape(`${result.leaked_count ?? result.leaked_items.length}${result.leaked_items.length ? `: ${result.leaked_items.join(', ')}` : ''}`)))
  else scores.push(row('Leaked items', escape(result.leaked_count ?? 0)))
  if (result.excluded_graded_contradictions?.length) scores.push(row('Excluded graded contradictions', escape(result.excluded_graded_contradictions.map(x => x.subject_id).join(', '))))
  const gates = (result.gates ?? []).map(g => row(g.id ?? 'gate', `<span class="${g.passed ? 'ok' : 'bad'}">${g.passed ? 'passed' : 'failed'}</span>${g.passed || !g.reason ? '' : ` — ${escape(g.reason)}`}`))
  const discovery = Object.entries(result.discovery_ledger?.counts ?? {}).map(([name, count]) => row(name, escape(count)))
  return `<section class="headline"><h2>Summary</h2>${table('Outcome', outcome)}${table('Scores', scores)}${table('Gates', gates)}${table('Discovery ledger (non-scoring)', discovery)}</section>`
}
// Inline every result field, including detailed panels and provenance. No assets
// or executable content are required to inspect a copied report offline.
export function renderReport(result) {
  const fields = Object.entries(result).map(([key, value]) => `<section><h2>${escape(key)}</h2><pre>${escape(JSON.stringify(value, null, 2))}</pre></section>`).join('\n')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>and-scene-define ${escape(result.run_id)}</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#202124}h2{font-size:1.1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f6;padding:1rem}section{border-top:1px solid #ddd}table{border-collapse:collapse;margin:0 0 1rem;min-width:50%}caption{text-align:left;font-weight:600;padding:.25rem 0}th,td{text-align:left;padding:.2rem .75rem .2rem 0;border-bottom:1px solid #eee;vertical-align:top;overflow-wrap:anywhere}.ok{color:#137333}.bad{color:#b3261e}</style><h1>and-scene-define ${escape(result.run_id)}</h1>${headline(result)}<h2>Full result</h2>${fields}</html>\n`
}
