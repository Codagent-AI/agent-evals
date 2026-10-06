import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic, writeTextAtomic } from './persistence.mjs'
import { RESIDUAL_RISK } from './contamination.mjs'
import { renderReport } from './report.mjs'
import { DEFINITION_VERDICTS } from './outcomes.mjs'
export async function assembleResult({ runDir, outcome, checkpoint }) {
  const read = async path => {
    try { return await readJson(join(runDir, path), null) }
    catch (error) { throw new Error(`cannot assemble ${path}: ${error.message}`, { cause: error }) }
  }
  const [score, discovery, contamination, disclosure, reconciliation, metrics, manifest, collection] = await Promise.all(['judges/score.json', 'discovery/ledger.json', 'phases/contamination-audit.json', 'audits/disclosure.json', 'phases/reconciliation.json', 'phases/workflow-metrics.json', 'evidence-manifest.json', 'phases/collection.json'].map(read))
  const usage = await readFile(join(runDir, 'phases/eval-owned-usage.jsonl'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '' })
  const eval_owned_usage = []; const eval_owned_usage_errors = []
  const lines = usage.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try { eval_owned_usage.push(JSON.parse(line)) }
    catch (error) {
      // Keep accepted records without treating an interrupted append as a total
      // assembly failure. Retain line diagnostics so missing usage is visible.
      eval_owned_usage_errors.push({ line: index + 1, error: error.message, truncated: index === lines.length - 1 && !usage.endsWith('\n') })
    }
  }
  const result = { schema_version: 1, mode: checkpoint?.kind ?? 'candidate', total: null, components: null, coverage: [], quality: [], fidelity: [], gates: [], panel_records: [], added_scope: [], ...score, ...outcome,
    run_id: checkpoint?.run_id ?? outcome.run_id ?? null,
    series_identity: checkpoint?.series_identity ?? null, candidate: checkpoint?.candidate ?? null,
    ...(checkpoint?.original ? { original: checkpoint.original } : {}),
    configured_profiles: checkpoint?.candidate?.profiles ?? null,
    effective_invocations: checkpoint?.effective_invocations ?? manifest?.invocations ?? [], runner_run_id: checkpoint?.runner_run_id ?? null,
    leaked_items: disclosure?.leaked_items ?? score?.leaked_items ?? [], leaked_count: (disclosure?.leaked_items ?? score?.leaked_items ?? []).length,
    discovery_ledger: discovery, contamination_audit: contamination ?? checkpoint?.contamination_audit ?? null,
    disclosure_audit: disclosure, reconciliation, residual_risk: RESIDUAL_RISK,
    provenance: { pinned_inputs: checkpoint?.series_identity ?? null, evidence_manifest: manifest, collection },
    workflow_metrics: metrics, eval_owned_usage, eval_owned_usage_errors,
  }
  // A score without a verdict (no calibrated threshold) is reported as
  // unavailable with its reason, never as pass/fail, so it is never publishable.
  if (!DEFINITION_VERDICTS.includes(result.definition_verdict)) result.definition_verdict = 'unavailable'
  return result
}
export async function writeResultArtifacts({ runDir, result }) {
  await writeJsonAtomic(join(runDir, 'result.json'), result)
  await writeTextAtomic(join(runDir, 'report.html'), renderReport(result))
  return [join(runDir, 'result.json'), join(runDir, 'report.html')]
}
