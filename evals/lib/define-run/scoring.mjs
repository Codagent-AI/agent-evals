// Pure score computation: discovery and report-only flags are never inputs.
const verdicts = new Set(['met', 'partial', 'missing'])
export const COVERAGE_UNAVAILABLE = 'every graded item leaked, so coverage cannot be measured'
function complete(criteria, results, name) {
  if (results.length !== criteria.length || new Set(results.map(x => x.id)).size !== criteria.length || criteria.some(c => !results.some(x => x.id === c.id && verdicts.has(x.verdict)))) throw new Error(`${name}: incomplete validated verdicts`)
}
export function scoreDefinition({ rubric, coverage, quality, fidelity, leaked = [], corrected = [], gates }) {
  complete(rubric.coverage, coverage, 'coverage'); complete(rubric.quality, quality, 'quality')
  if (new Set(fidelity.map(x => x.id)).size !== fidelity.length || fidelity.some(x => !['met', 'missing'].includes(x.verdict))) throw new Error('invalid fidelity verdicts')
  const leaks = new Set(leaked)
  if (leaked.some(id => !rubric.coverage.some(x => x.id === id))) throw new Error('unknown leaked item')
  const corrections = new Map(corrected.map(x => [x.id, x.citations ?? []]))
  if ([...corrections.keys()].some(id => !rubric.coverage.some(x => x.id === id))) throw new Error('unknown corrected item')
  for (const id of leaks) corrections.delete(id)
  if (corrections.size && !(Number.isFinite(rubric.correction_fraction) && rubric.correction_fraction > 0 && rubric.correction_fraction < 1)) throw new Error('invalid correction fraction')
  let earned = 0; let possible = 0
  const scoredCoverage = rubric.coverage.map(c => {
    const r = coverage.find(x => x.id === c.id)
    if (leaks.has(c.id)) return { ...r, coverage_verdict: r.verdict, verdict: 'leaked', weight: c.weight, corrected: false, correction_citations: [], earned_points: 0 }
    const isCorrected = corrections.has(c.id)
    const earned_points = c.weight * rubric.verdict_values[r.verdict] * (isCorrected ? rubric.correction_fraction : 1)
    possible += c.weight; earned += earned_points
    return { ...r, weight: c.weight, corrected: isCorrected, correction_citations: corrections.get(c.id) ?? [], earned_points }
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
  // The score is the result: there is no pass/fail verdict. Gates are reported
  // beside the score and never change it.
  return { evaluation_status: 'complete', ...(measured ? {} : { score_unavailable: COVERAGE_UNAVAILABLE }), rubric_version: rubric.rubric_version, components, total, coverage: scoredCoverage, quality, fidelity, gates, leaked_items: [...leaks], corrected_items: [...corrections.keys()] }
}
export function discoveryLedger({ coverage, asked }) {
  if (asked.length !== coverage.length || new Set(asked.map(x => x.id)).size !== coverage.length) throw new Error('incomplete discovery decisions')
  const counts = Object.fromEntries(['discovered', 'inferred', 'missed', 'asked-not-captured', 'leaked', 'corrected', 'corrected-not-captured'].map(x => [x, 0]))
  const items = coverage.map(c => {
    const decision = asked.find(x => x.id === c.id)
    if (typeof decision?.asked !== 'boolean') throw new Error(`missing discovery decision: ${c.id}`)
    const outcome = c.verdict === 'leaked' ? 'leaked' : c.corrected ? c.verdict === 'missing' ? 'corrected-not-captured' : 'corrected' : c.verdict === 'missing' ? decision.asked ? 'asked-not-captured' : 'missed' : decision.asked ? 'discovered' : 'inferred'
    counts[outcome]++
    return { id: c.id, asked: decision.asked, corrected: c.verdict !== 'leaked' && Boolean(c.corrected), correction_citations: c.correction_citations ?? [], citations: c.corrected && c.verdict !== 'leaked' ? c.correction_citations ?? [] : decision.citations, coverage_verdict: c.verdict, outcome }
  })
  return { scoring: false, counts, items }
}
