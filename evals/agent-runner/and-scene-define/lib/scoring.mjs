// Pure score computation: discovery and report-only flags are never inputs.
const verdicts = new Set(['met', 'partial', 'missing'])
export const VERDICT_UNAVAILABLE = 'pass threshold not set (calibration pending)'
export const COVERAGE_UNAVAILABLE = 'every graded item leaked, so coverage cannot be measured'
function complete(criteria, results, name) {
  if (results.length !== criteria.length || new Set(results.map(x => x.id)).size !== criteria.length || criteria.some(c => !results.some(x => x.id === c.id && verdicts.has(x.verdict)))) throw new Error(`${name}: incomplete validated verdicts`)
}
export function scoreDefinition({ rubric, coverage, quality, fidelity, leaked = [], gates }) {
  complete(rubric.coverage, coverage, 'coverage'); complete(rubric.quality, quality, 'quality')
  const gatesPassed = gates.every(x => x.passed)
  if (new Set(fidelity.map(x => x.id)).size !== fidelity.length || fidelity.some(x => !['met', 'missing'].includes(x.verdict))) throw new Error('invalid fidelity verdicts')
  const leaks = new Set(leaked)
  if (leaked.some(id => !rubric.coverage.some(x => x.id === id))) throw new Error('unknown leaked item')
  let earned = 0; let possible = 0
  const scoredCoverage = rubric.coverage.map(c => {
    const r = coverage.find(x => x.id === c.id)
    if (leaks.has(c.id)) return { ...r, coverage_verdict: r.verdict, verdict: 'leaked', weight: c.weight }
    possible += c.weight; earned += c.weight * rubric.verdict_values[r.verdict]
    return { ...r, weight: c.weight }
  })
  const components = {
    coverage: { score: possible ? rubric.components.coverage * earned / possible : null, points: rubric.components.coverage, earned, possible },
    artifact_quality: { score: rubric.quality.reduce((sum, c) => sum + c.points * rubric.verdict_values[quality.find(x => x.id === c.id).verdict], 0), points: rubric.components.artifact_quality },
    fidelity: { score: Math.max(rubric.fidelity.floor, rubric.components.fidelity - fidelity.filter(x => x.verdict === 'met').length * rubric.fidelity.deduction_per_exchange), points: rubric.components.fidelity },
  }
  // With every graded item leaked there is no clean coverage evidence: report
  // no coverage score and no total rather than a zero the agent did not earn.
  const measured = possible > 0
  const total = measured ? Object.values(components).reduce((sum, c) => sum + c.score, 0) : null
  // A failed gate fails regardless of points. Otherwise a missing threshold
  // (calibration pending) yields a full breakdown with no verdict; preflight
  // still refuses candidate runs against an uncalibrated rubric.
  const calibrated = Number.isFinite(rubric.pass_threshold)
  const definition_verdict = !gatesPassed ? 'fail' : !measured || !calibrated ? null : total >= rubric.pass_threshold ? 'pass' : 'fail'
  const unavailable = !measured ? COVERAGE_UNAVAILABLE : VERDICT_UNAVAILABLE
  return { evaluation_status: 'complete', definition_verdict, ...(definition_verdict === null ? { verdict_unavailable: unavailable } : {}), rubric_version: rubric.rubric_version, components, total, coverage: scoredCoverage, quality, fidelity, gates, leaked_items: [...leaks] }
}
export function discoveryLedger({ coverage, asked }) {
  if (asked.length !== coverage.length || new Set(asked.map(x => x.id)).size !== coverage.length) throw new Error('incomplete discovery decisions')
  const counts = Object.fromEntries(['discovered', 'inferred', 'missed', 'asked-not-captured', 'leaked'].map(x => [x, 0]))
  const items = coverage.map(c => {
    const decision = asked.find(x => x.id === c.id)
    if (typeof decision?.asked !== 'boolean') throw new Error(`missing discovery decision: ${c.id}`)
    const outcome = c.verdict === 'leaked' ? 'leaked' : c.verdict === 'missing' ? decision.asked ? 'asked-not-captured' : 'missed' : decision.asked ? 'discovered' : 'inferred'
    counts[outcome]++
    return { id: c.id, asked: decision.asked, citations: decision.citations, coverage_verdict: c.verdict, outcome }
  })
  return { scoring: false, counts, items }
}
