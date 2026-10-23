import { GATE_INPUT_TIER } from './product-rubric.mjs'
export const SCORE_SCHEMA_VERSION = 1
const round = value => Math.round(value * 1e6) / 1e6
const earned = verdict => verdict?.verdict === 'pass'
// Automated product score: each passing criterion earns its component's tier weight. A component with any
// criterion that was never observed is incomplete, and no total hides the gap or rescales around it.
export function scoreProduct({ rubric, verdicts, incomplete = {} }) {
  const components = rubric.components.map(component => {
    const subcomponents = component.subcomponents.map(subcomponent => {
      const criteria = subcomponent.criteria.map(id => {
        const tier = subcomponent.tiers[id]
        const points = tier === GATE_INPUT_TIER ? 0 : component.tier_weights[tier]
        const verdict = verdicts[id] ?? null
        return { id, tier, points, earned: verdict && earned(verdict) ? points : verdict ? 0 : null, verdict: verdict?.verdict ?? null, basis: verdict?.basis ?? null, rationale: verdict?.rationale ?? null, citations: verdict?.citations ?? [], reason: verdict?.reason ?? null }
      })
      const observed = criteria.every(criterion => criterion.verdict !== null)
      return { id: subcomponent.id, points: subcomponent.points, score: observed ? round(criteria.reduce((sum, criterion) => sum + criterion.earned, 0)) : null, criteria }
    })
    const reason = incomplete[component.id] ?? (subcomponents.some(subcomponent => subcomponent.score === null) ? 'a criterion was not observed' : null)
    return { id: component.id, points: component.points, complete: reason === null, incomplete_reason: reason, score: reason === null ? round(subcomponents.reduce((sum, subcomponent) => sum + subcomponent.score, 0)) : null, subcomponents }
  })
  const missing = components.filter(component => !component.complete)
  return { schema_version: SCORE_SCHEMA_VERSION, rubric_id: rubric.rubric_id, rubric_version: rubric.version, provisional: rubric.provisional, automated_points: rubric.automated_points,
    complete: missing.length === 0, automated_score: missing.length === 0 ? round(components.reduce((sum, component) => sum + component.score, 0)) : null,
    complete_components_score: round(components.filter(component => component.complete).reduce((sum, component) => sum + component.score, 0)),
    incomplete_components: missing.map(component => ({ id: component.id, reason: component.incomplete_reason })), components }
}
// Gates are reported beside the score and never change it.
export function evaluateGates({ rubric, verdicts, build, verifier }) {
  const passed = id => verdicts[id]?.verdict === 'pass'
  const buildFailure = build?.ok === false ? `the build failed: ${build.reason ?? 'see the build log'}` : null
  const gate = (id, ok, reason) => ({ id, passed: ok, reason: ok ? null : reason })
  const byId = Object.fromEntries(rubric.gates.map(entry => [entry.id, entry]))
  return [
    gate('gate-build-whole-app', build?.ok === true, buildFailure ?? 'the build was not run'),
    gate('gate-sample-reachable', !buildFailure && byId['gate-sample-reachable'].inputs.every(passed), buildFailure ?? 'no reachable sample presentation that explains the skill was confirmed'),
    gate('gate-every-step-renders', !buildFailure && byId['gate-every-step-renders'].inputs.every(passed), buildFailure ?? 'a produced step did not render cleanly'),
    gate('gate-verifier-clear-outcome', verifier?.found === true && verifier.clear === true, verifier?.found === false ? 'no verifier exists in the delivered tree' : verifier?.reason ?? 'the verifier did not report a clear outcome'),
  ]
}
// The criteria a build failure zeroes: those whose evaluator is a browser judge (no fallback judge decides them).
export function browserDependentCriteria(rubric) {
  return rubric.components.flatMap(component => component.subcomponents.filter(subcomponent => subcomponent.evaluator === 'browser-judge').flatMap(subcomponent => subcomponent.criteria))
}
