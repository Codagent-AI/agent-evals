import { hashJson } from '../../and-scene-define/lib/persistence.mjs'
import { stats } from '../../and-scene/lib/experiment-baseline.mjs'
import { band as scoreBand } from '../../and-scene/lib/experiment-comparison.mjs'
import { OUTCOMES } from './trace.mjs'
export const MIN_REPETITIONS = 3
function differences(a, b, path = '') {
  if (hashJson(a ?? null) === hashJson(b ?? null)) return []
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return [{ component: path, left: a ?? null, right: b ?? null }]
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => differences(a[key], b[key], path ? `${path}.${key}` : key))
}
const complete = result => result?.evaluation_status === 'complete'
const definitionOf = result => result.definition_score?.total
const productOf = result => result.product_score?.score
const summary = values => values.length ? (({ mean, stddev, min }) => ({ n: values.length, mean, stddev, worst: min }))(stats(values)) : null
// Groups by series identity and candidate. Only complete runs are scored; a run with an incomplete product score
// still contributes its definition score and none to the product score.
export function compareResults(results) {
  const unscored = results.filter(result => !complete(result)).map(result => ({ run_id: result?.run_id ?? null, evaluation_status: result?.evaluation_status ?? null, owning_phase: result?.owning_phase ?? null,
    reason: `evaluation status ${result?.evaluation_status ?? 'unknown'}: not compared` }))
  const groups = new Map()
  for (const result of results.filter(complete)) {
    if (result.series_identity == null) { unscored.push({ run_id: result.run_id, evaluation_status: result.evaluation_status, owning_phase: null, reason: 'no series identity: not compared' }); continue }
    const key = `${hashJson(result.series_identity)}:${hashJson(result.candidate)}`
    if (!groups.has(key)) groups.set(key, { series: hashJson(result.series_identity), candidate_hash: hashJson(result.candidate), series_identity: result.series_identity, candidate: result.candidate, runs: [] })
    groups.get(key).runs.push(result)
  }
  const list = [...groups.values()].map(group => {
    const definition = group.runs.map(definitionOf).filter(Number.isFinite)
    const product = group.runs.map(productOf).filter(Number.isFinite)
    const trace = Object.fromEntries(OUTCOMES.map(outcome => [outcome, group.runs.length ? group.runs.reduce((sum, run) => sum + (run.requirement_trace?.counts?.[outcome] ?? 0), 0) / group.runs.length : null]))
    return { series: group.series, candidate_hash: group.candidate_hash, candidate: group.candidate, run_ids: group.runs.map(run => run.run_id), scored_repetitions: group.runs.length,
      label: group.runs.length >= MIN_REPETITIONS ? 'group' : 'screen', definition: summary(definition), product: summary(product), mean_trace_counts: trace }
  })
  const pairs = []
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]; const b = list[j]
    if (a.series !== b.series) { pairs.push({ groups: [a.candidate_hash, b.candidate_hash], comparable: false, reason: 'different series identities: not comparable' }); continue }
    const classified = a.scored_repetitions >= MIN_REPETITIONS && b.scored_repetitions >= MIN_REPETITIONS
    const classify = key => {
      if (!classified || !a[key] || !b[key] || a[key].n < MIN_REPETITIONS || b[key].n < MIN_REPETITIONS) return null
      return { ...scoreBand({ kind: 'score', base: a[key], cand: b[key] }), delta: b[key].mean - a[key].mean }
    }
    pairs.push({ groups: [a.candidate_hash, b.candidate_hash], comparable: true, classified, reason: classified ? null : `a group has fewer than ${MIN_REPETITIONS} scored repetitions: screen only`,
      candidate_differences: differences(a.candidate, b.candidate), definition: classify('definition'), product: classify('product') })
  }
  return { groups: list, pairs, unscored }
}
