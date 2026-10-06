import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic, writeTextAtomic } from './persistence.mjs'
import { RESIDUAL_RISK } from './contamination.mjs'
import { renderReport } from './report.mjs'
export async function assembleResult({ runDir, outcome, checkpoint }) {
  const read = path => readJson(join(runDir, path), null)
  const [score, discovery, contamination, disclosure, reconciliation, metrics, manifest, collection] = await Promise.all(['judges/score.json', 'discovery/ledger.json', 'phases/contamination-audit.json', 'audits/disclosure.json', 'phases/reconciliation.json', 'phases/workflow-metrics.json', 'evidence-manifest.json', 'phases/collection.json'].map(read))
  const usage = await readFile(join(runDir, 'phases/eval-owned-usage.jsonl'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '' })
  return { schema_version: 1, mode: checkpoint?.kind ?? 'candidate', total: null, components: null, coverage: [], quality: [], fidelity: [], gates: [], panel_records: [], added_scope: [], ...score, ...outcome,
    run_id: checkpoint?.run_id ?? outcome.run_id ?? null,
    series_identity: checkpoint?.series_identity ?? null, candidate: checkpoint?.candidate ?? null,
    ...(checkpoint?.original ? { original: checkpoint.original } : {}),
    configured_profiles: checkpoint?.candidate?.profiles ?? null,
    effective_invocations: checkpoint?.effective_invocations ?? manifest?.invocations ?? [], runner_run_id: checkpoint?.runner_run_id ?? null,
    leaked_items: disclosure?.leaked_items ?? score?.leaked_items ?? [], leaked_count: (disclosure?.leaked_items ?? score?.leaked_items ?? []).length,
    discovery_ledger: discovery, contamination_audit: contamination ?? checkpoint?.contamination_audit ?? null,
    disclosure_audit: disclosure, reconciliation, residual_risk: RESIDUAL_RISK,
    provenance: { pinned_inputs: checkpoint?.series_identity ?? null, evidence_manifest: manifest, collection },
    workflow_metrics: metrics, eval_owned_usage: usage.split('\n').filter(x => x.trim()).map(JSON.parse),
  }
}
export async function writeResultArtifacts({ runDir, result }) {
  await writeJsonAtomic(join(runDir, 'result.json'), result)
  await writeTextAtomic(join(runDir, 'report.html'), renderReport(result))
  return [join(runDir, 'result.json'), join(runDir, 'report.html')]
}
