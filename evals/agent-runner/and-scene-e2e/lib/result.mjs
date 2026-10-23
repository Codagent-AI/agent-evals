import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic, writeTextAtomic } from '../../and-scene-define/lib/persistence.mjs'
import { RESIDUAL_RISK as DEFINE_RESIDUAL_RISK } from '../../and-scene-define/lib/contamination.mjs'
import { renderReport } from './report.mjs'
import { EVALUATION_STATUSES, SCORED_STATUSES } from './outcomes.mjs'
export const RESIDUAL_RISK = `${DEFINE_RESIDUAL_RISK} The evaluated sandbox held a GitHub token that can push to the run's own delivery repository and to no other repository.`
const read = (runDir, path, fallback = null) => readJson(join(runDir, path), fallback)
async function usage(runDir) {
  const text = await readFile(join(runDir, 'phases/eval-owned-usage.jsonl'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '' })
  const records = []; const errors = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch (error) { errors.push({ line: index + 1, error: error.message }) }
  }
  return { records, errors }
}
export function productTotal(product) {
  if (!product?.score) return null
  const human = product.human_review?.complete ? product.human_review.points : product.human_review?.skipped ? 0 : null
  return product.score.automated_score !== null && human !== null ? product.score.automated_score + human : null
}
// The definition and product scores are reported separately; no combined total exists anywhere in the result.
export async function assembleResult({ runDir, outcome, checkpoint, rubric = null }) {
  const status = outcome.evaluation_status
  if (!EVALUATION_STATUSES.includes(status)) throw new Error(`unknown evaluation status ${status}`)
  const scored = SCORED_STATUSES.includes(status) || status === 'implementation-workflow-failed' || (status === 'evaluation-harness-failed' && outcome.definition_scored === true)
  const [definitionScore, ledger, collection, delivery, trace, productResult, human, metrics, pass1, pass2, disclosure, reconciliation, manifest] = await Promise.all(
    ['judges/score.json', 'discovery/ledger.json', 'phases/collection.json', 'phases/delivery.json', 'phases/trace.json', 'phases/product-result.json', 'human-review/review.json', 'phases/workflow-metrics.json', 'phases/contamination-pass-1.json', 'phases/contamination-pass-2.json', 'audits/disclosure.json', 'phases/reconciliation.json', 'evidence-manifest.json'].map(path => read(runDir, path)))
  const eval_owned = await usage(runDir)
  const product = scored && productResult ? { ...productResult, human_review: human ?? productResult.human_review ?? null } : null
  const delivered = product ? { automated_score: product.score.automated_score, human_points: human?.points ?? (product.human_review?.skipped ? 0 : null), score: productTotal(product), incomplete: product.score.automated_score === null } : null
  return {
    schema_version: 1, mode: checkpoint?.kind ?? 'candidate', ...outcome,
    run_id: checkpoint?.run_id ?? outcome.run_id ?? null, series_identity: checkpoint?.series_identity ?? null, candidate: checkpoint?.candidate ?? null,
    ...(checkpoint?.original ? { original: checkpoint.original } : {}),
    configured_profiles: checkpoint?.candidate?.profiles ?? null, effective_invocations: checkpoint?.effective_invocations ?? manifest?.invocations ?? [],
    runner_run_id: checkpoint?.runner_run_id ?? null, workflow: checkpoint?.candidate?.workflow ?? null,
    delivery_repository: checkpoint?.delivery ?? null, delivery: delivery ?? null, prohibited_effects: outcome.prohibited_effects ?? delivery?.prohibited_effects ?? [],
    token_refresh_interval_minutes: checkpoint?.token_refresh_minutes ?? null, quota_waits: checkpoint?.quota_waits ?? [],
    definition_score: scored ? definitionScore : null, definition_discovery: scored ? ledger : null,
    product_score: delivered, product: product ? { ...product, rubric: { id: rubric?.rubric_id ?? product.score.rubric_id, version: rubric?.version ?? product.score.rubric_version, provisional: rubric?.provisional ?? product.score.provisional, exclusions: rubric?.exclusions ?? [] } } : null,
    requirement_trace: scored ? trace : null,
    contamination_audit: { pass_1: pass1, pass_2: pass2 }, disclosure_audit: disclosure, reconciliation,
    leaked_items: disclosure?.leaked_items ?? outcome.leaked_items ?? [], residual_risk: RESIDUAL_RISK,
    provenance: { evidence_manifest: manifest, collection, pinned_inputs: checkpoint?.series_identity ?? null },
    workflow_metrics: metrics, eval_owned_usage: eval_owned.records, eval_owned_usage_errors: eval_owned.errors,
    provisional_rubric: rubric?.provisional ?? product?.score?.provisional ?? null,
  }
}
export async function writeResultArtifacts({ runDir, result }) {
  await writeJsonAtomic(join(runDir, 'result.json'), result)
  await writeTextAtomic(join(runDir, 'report.html'), renderReport(result))
  return [join(runDir, 'result.json'), join(runDir, 'report.html')]
}
