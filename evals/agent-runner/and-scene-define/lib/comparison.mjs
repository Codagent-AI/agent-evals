import { hashJson } from './persistence.mjs'
function differences(a, b, path = '') {
  if (hashJson(a ?? null) === hashJson(b ?? null)) return []
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return [{ component: path, left: a ?? null, right: b ?? null }]
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => differences(a[key], b[key], path ? `${path}.${key}` : key))
}
const scored = r => r?.evaluation_status === 'complete' && Number.isFinite(r.total)
// Only complete runs with a score are compared; every other run is listed with
// its outcome so a failed or contaminated run is never paired on stale numbers.
export function compareResults(results) {
  const pairs = []
  const unscored = results.filter(r => !scored(r)).map(r => ({ run_id: r?.run_id ?? null, evaluation_status: r?.evaluation_status ?? null, owning_phase: r?.owning_phase ?? null,
    reason: r?.evaluation_status === 'complete' ? 'complete run has no score: not compared' : `evaluation status ${r?.evaluation_status ?? 'unknown'}: not compared` }))
  const comparable = results.filter(scored)
  for (let i = 0; i < comparable.length; i++) for (let j = i + 1; j < comparable.length; j++) {
    const a = comparable[i]; const b = comparable[j]
    const same = a.series_identity != null && b.series_identity != null && hashJson(a.series_identity) === hashJson(b.series_identity)
    pairs.push({ run_ids: [a.run_id, b.run_id], comparable: same, reason: same ? null : 'different or unavailable series identities: not comparable',
      ...(same ? { candidate_differences: differences(a.candidate, b.candidate), runs: [a, b].map(r => ({ run_id: r.run_id, evaluation_status: r.evaluation_status, total: r.total ?? null, components: r.components ?? null, leaked_count: r.leaked_count ?? null })) } : { series_differences: differences(a.series_identity, b.series_identity) }) })
  }
  return { pairs, unscored }
}
