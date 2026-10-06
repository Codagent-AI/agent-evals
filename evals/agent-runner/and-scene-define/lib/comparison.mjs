import { hashJson } from './persistence.mjs'
function differences(a, b, path = '') {
  if (hashJson(a ?? null) === hashJson(b ?? null)) return []
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return [{ component: path, left: a ?? null, right: b ?? null }]
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => differences(a[key], b[key], path ? `${path}.${key}` : key))
}
export function compareResults(results) {
  const pairs = []
  for (let i = 0; i < results.length; i++) for (let j = i + 1; j < results.length; j++) {
    const a = results[i]; const b = results[j]
    const same = a.series_identity != null && b.series_identity != null && hashJson(a.series_identity) === hashJson(b.series_identity)
    pairs.push({ run_ids: [a.run_id, b.run_id], comparable: same, reason: same ? null : 'different or unavailable series identities: not comparable',
      ...(same ? { candidate_differences: differences(a.candidate, b.candidate), runs: [a, b].map(r => ({ run_id: r.run_id, evaluation_status: r.evaluation_status, definition_verdict: r.definition_verdict, total: r.total ?? null, components: r.components ?? null, leaked_count: r.leaked_count ?? null })) } : { series_differences: differences(a.series_identity, b.series_identity) }) })
  }
  return { pairs }
}
