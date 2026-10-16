const safe = value => String(value ?? 'null').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\`*_|\[\]\\]/g, '\\$&').replace(/[\r\n]/g, ' ').replace(/[@#]/g, '$&\u200b').replace(/\b(https?|ftp):\/\//gi, '$1:\u200b//').replace(/\bwww\./gi, 'www.\u200b')
const val = x => safe(typeof x === 'string' ? x : JSON.stringify(x))
const more = n => n > 0 ? `… and ${n} more` : ''
export function formatRefusals(refusals, { json = false } = {}) {
  if (json) return JSON.stringify({ status: 'refused', refusals }, null, 2) + '\n'
  return `# Comparison refused\n\n${refusals.map(x => `- **${safe(x.code)}**${x.run_id || x.directory ? ` (${safe(x.run_id ?? x.directory)})` : ''}: ${safe(x.message)}`).join('\n')}\n`
}
function render(report, commitLimit, mismatchLimit) {
  const lines = ['# Experiment comparison', '',
    `Eval issue: ${safe(report.eval_issue)}. Candidate repetitions: ${report.candidate.repetitions}; baseline repetitions: ${report.baseline.repetitions}.`,
    `Baseline source: ${safe(report.baseline.source)}; set: ${safe(report.baseline.set_at)}.`,
    `Baseline runs: ${report.baseline.run_ids.map(safe).join(', ')}.`,
    `Candidate runs: ${report.candidate.run_ids.map(safe).join(', ')}.`, '', '## Primary differences', '']
  if (!report.differences.primary.length) lines.push('No primary differences.')
  for (const diff of report.differences.primary) {
    if (!diff.repo) { lines.push(`- ${safe(diff.setting)}: ${val(diff.baseline)} → ${val(diff.candidate)}`); continue }
    lines.push(`- ${safe(diff.repo)}: requested ${safe(diff.requested_ref)}; recorded ${safe(diff.recorded_commit)}; main ${safe(diff.main_sha)}; ${diff.ahead_by} commits ahead.`)
    if (diff.note) lines.push('  No commits on the recorded commit are missing from main as resolved.')
    if (diff.may_have_merged) lines.push('  The branch may have merged since the eval ran; its commits can no longer be recovered from main.')
    const commits = diff.commits.slice(0, commitLimit)
    for (const commit of commits) lines.push(`  - ${safe(commit.sha.slice(0, 8))} ${safe(commit.subject)}`)
    const omitted = (diff.omitted ?? 0) + diff.commits.length - commits.length
    if (omitted) lines.push(`  ${more(omitted)}`)
  }
  lines.push('', '## Ancillary differences', '')
  if (!report.differences.ancillary.length) lines.push('No ancillary differences.')
  for (const diff of report.differences.ancillary) lines.push(diff.repo ?
    `- ${safe(diff.repo)} (${safe(diff.kind)}): ${val(diff.baseline)} → ${val(diff.candidate)}; ahead ${diff.ahead_by}, behind ${diff.behind_by}.` :
    `- ${safe(diff.field)}: ${val(diff.baseline)} → ${val(diff.candidate)}`)
  const mismatches = report.differences.baseline_mismatches
  if (mismatches.length) {
    lines.push('', '## Baseline repetition mismatches', '')
    for (const mismatch of mismatches.slice(0, mismatchLimit)) {
      lines.push(`- ${safe(mismatch.run_id)}; reason: ${safe(mismatch.reason)}`)
      for (const field of mismatch.fields) lines.push(`  - ${safe(field.field)}: ${val(field.baseline)} → ${val(field.repetition)}`)
    }
    if (mismatches.length > mismatchLimit) lines.push(more(mismatches.length - mismatchLimit))
  }
  lines.push('', '## Metrics', '', '| Metric | Baseline mean ± sd [min–max] | Candidate mean ± sd [min–max] | Δ | Δ% | Band |', '| --- | --- | --- | --- | --- | --- |')
  for (const [key, metric] of Object.entries(report.metrics)) {
    const number = x => {
      if (x === null) return 'n/a'
      if (key.startsWith('tokens')) return Math.round(x).toLocaleString('en-US')
      if (key === 'active_duration_ms') return (x / 60000).toFixed(1)
      return x.toFixed(2)
    }
    const summary = x => `${number(x.mean)} ± ${number(x.stddev)} [${number(x.min)}–${number(x.max)}]`
    const label = key === 'active_duration_ms' ? 'Active time (min)' : key.startsWith('cost_role:') || key === 'estimated_cost_usd' ? `${key} (USD)` : key
    if (metric.status === 'incomplete') {
      lines.push(`| ${safe(label)} | incomplete (missing: ${metric.missing_run_ids.map(safe).join(', ')}) | incomplete | n/a | n/a | incomplete |`)
      continue
    }
    const band = metric.band.level === 'same' ? 'same' : `${metric.band.level === 'clear' ? 'clearly' : 'leaning'} ${metric.band.direction}`
    lines.push(`| ${safe(label)} | ${summary(metric.baseline)} | ${summary(metric.candidate)} | ${number(metric.delta)} | ${metric.delta_pct === null ? 'not defined' : metric.delta_pct.toFixed(2) + '%'} | ${band}${metric.band.includes_product_failures ? ' (includes product failures)' : ''} |`)
  }
  lines.push('', '## Reliability flags', '')
  if (!report.flags.items.length) lines.push('No reliability flags.')
  for (const flag of report.flags.items) lines.push(flag.kind === 'gate' ?
    `- ${safe(flag.run_id)}: gate failure; ${flag.gate_ids.map(safe).join(', ')}; ${safe(flag.phase)}: ${safe(flag.reason)}` :
    `- ${safe(flag.run_id)}: score ${flag.points.toFixed(2)}, shortfall ${flag.shortfall.toFixed(2)} points.`)
  if (report.flags.shortfall_check === 'unavailable') lines.push('Score-shortfall check unavailable: baseline automated score is incomplete.')
  lines.push('', '## Human review', '')
  const human = report.human_review
  lines.push(`Baseline median: ${safe(human.baseline_median)}.`,
    `Baseline reviewed repetition: ${safe(human.baseline.run_id)}; official score ${val(human.baseline.official_score)}; human points ${val(human.baseline.points)}/${val(human.baseline.possible)}.`)
  if (!human.baseline.is_current_median) lines.push('The human-reviewed baseline repetition is not the current median.')
  if (human.baseline.carried_from) lines.push(`Baseline review carried from ${safe(human.baseline.carried_from)}.`)
  lines.push(`Candidate median: ${safe(human.candidate.run_id)} — review this repetition by hand. Review: ${human.candidate.status}.`)
  if (human.candidate.status === 'complete') lines.push(`Official score ${val(human.candidate.official_score)}; human points ${val(human.candidate.points)}/${val(human.candidate.possible)} (information only).`)
  if (human.candidate.carried_from) lines.push(`Candidate review carried from ${safe(human.candidate.carried_from)}.`)
  lines.push('', '## Provenance', '', `Request SHA-256: ${safe(report.request.hash)}.`, `Request settings: ${val(report.request.settings)}.`)
  for (const repository of report.provenance.repositories) {
    lines.push(`- ${safe(repository.repo)}: main ${safe(repository.main_sha)}, resolved ${safe(repository.resolved_at)}.`)
    for (const compare of repository.compares) lines.push(`  - ${safe(compare.kind)}: ${safe(compare.range)} (${safe(compare.status)})`)
  }
  return lines.join('\n') + '\n'
}
export function formatMarkdown(report, { limit = 65_536 } = {}) {
  for (const [commits, mismatches] of [[20, Infinity], [5, Infinity], [0, Infinity], [0, 5], [0, 0]]) {
    const text = render(report, commits, mismatches)
    if (text.length <= limit) return text
  }
  throw Error(`Comparison report exceeds ${limit} characters after trimming lists`)
}
