// Evaluator-only rescore of a previous run's retained evidence under the current evaluator inputs. It never
// starts Agent Runner or an evaluated agent and never reads GitHub; its result is never published.
import { cp, lstat, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFINE_ROOT, SUITE_ROOT, readJson, sha256 } from './files.mjs'
import { failureOutcome } from './outcomes.mjs'
import { createCheckpoint, beginUnit, completeUnit, failUnit, saveCheckpoint } from '../../../lib/define-run/checkpoint.mjs'
import { hashFile, writeJsonAtomic } from '../../../lib/define-run/persistence.mjs'
import { loadEvidence } from '../../../lib/define-run/evidence.mjs'
import { reconcileConversation } from '../../../lib/define-run/reconciliation.mjs'
import { auditContamination } from '../../../lib/define-run/contamination.mjs'
import { createJudgingPhases } from '../../../lib/define-run/judging.mjs'
import { createDefinitionJudges } from '../../../lib/define-run/judge-invoker.mjs'
import { inspectEvaluatorInputs } from '../../../lib/define-run/preflight.mjs'
import { loadProductInputs } from './product-rubric.mjs'
import { evaluateProduct } from './product-evaluation.mjs'
import { createProductionDeps } from './production-deps.mjs'
import { buildTrace } from './trace.mjs'
import { ingestWorkflowMetrics } from './metrics.mjs'
import { assembleResult, writeResultArtifacts } from './result.mjs'
import { productSeriesParts } from './preflight.mjs'
import { JUDGE_PROFILE } from '../../../lib/define-run/profiles.mjs'
import { PRODUCT_JUDGE_PROFILE } from '../../and-scene/lib/judge-profile.mjs'
import { PANEL_PROTOCOL } from '../../../lib/panel-judging/panel.mjs'
const SNAP = { define: { evidenceRoot: 'evidence/define', manifestPath: 'evidence/define-manifest.json' }, final: { evidenceRoot: 'evidence/final', manifestPath: 'evidence/final-manifest.json' } }
const usage = message => Object.assign(new Error(message), { usage: true })
const RETAINED = ['conversation.jsonl', 'phases/collection.json', 'phases/delivery.json', 'phases/product-result.json', 'evidence', 'collected', 'source']
// Current series identity from evaluator inputs alone: no Runner, Docker, credentials or network.
export async function evaluatorIdentity({ dryRun = false } = {}) {
  const { seriesIdentity: define } = await inspectEvaluatorInputs({ suiteRoot: DEFINE_ROOT, dryRun })
  const parts = await productSeriesParts()
  const { contamination_patterns: _ignored, ...rest } = define
  return { ...rest, definition_rubric: define.rubric, contamination_patterns: parts.versions['contamination-patterns'].version, product_rubric: parts.product_rubric, human_rubric: parts.human_rubric,
    judge_profiles: { definition: JUDGE_PROFILE, product: PRODUCT_JUDGE_PROFILE }, panel_protocol: PANEL_PROTOCOL, e2e_input_versions: Object.fromEntries(Object.entries(parts.versions).map(([name, record]) => [name, { version: record.version, sha256: record.hashes[record.version] }])) }
}
export async function verifyRetained(source) {
  const read = path => readJson(join(source, path)).catch(() => { throw usage(`the source run lacks retained ${path}`) })
  for (const snapshot of Object.values(SNAP)) await loadEvidence(source, snapshot).catch(error => { throw usage(`retained evidence is not intact: ${error.message}`) })
  const delivery = await read('phases/delivery.json')
  if (delivery.ok !== true) throw usage('the source run has no verified delivery to rescore')
  const bundle = await hashFile(join(source, delivery.bundle.path))
  if (bundle !== delivery.bundle.sha256) throw usage('the retained candidate bundle does not match its recorded SHA-256')
  for (const artifact of delivery.acceptance?.artifacts ?? []) if (await hashFile(join(source, artifact.file)) !== artifact.sha256) throw usage(`retained acceptance evidence differs from its record: ${artifact.file}`)
  const collection = await read('phases/collection.json')
  for (const file of collection.files) if (await hashFile(join(source, 'collected', file.path)) !== file.sha256) throw usage(`the collected definition differs from its record: ${file.path}`)
  const product = await read('phases/product-result.json')
  if (!product.build_plan) throw usage('the source run never got a build plan; resume it instead of rescoring it')
  return { delivery, collection, product }
}
export async function rescoreEvaluation(options, deps = {}) {
  const source = resolve(options.rescoreFrom); const runDir = resolve(options.runDir)
  if (!await lstat(source).catch(() => null)) throw usage(`rescore source ${source} does not exist`)
  if (await lstat(runDir).catch(() => null)) throw usage('the rescore output directory must be new')
  const retained = await verifyRetained(source)
  const sourceResult = await readJson(join(source, 'result.json'), null)
  const sourceState = await readJson(join(source, 'run-state.json'), null)
  await mkdir(runDir, { recursive: true })
  for (const path of RETAINED) await cp(join(source, path), join(runDir, path), { recursive: true }).catch(error => { if (error.code !== 'ENOENT') throw error })
  for (const path of ['phases', 'judges', 'audits', 'discovery', 'logs', '.runtime/definition-job-inputs', '.runtime/judge', '.runtime/judge-claude', 'human-review']) await mkdir(join(runDir, path), { recursive: true })
  const product = deps.productInputs ?? await loadProductInputs()
  const identity = deps.evaluatorIdentity ? await deps.evaluatorIdentity() : await evaluatorIdentity({ dryRun: deps.dryRun })
  let checkpoint = createCheckpoint({ run_id: `rescore-${randomUUID().slice(0, 8)}`, kind: 'rescore', identity: { series_identity: identity, candidate: sourceState?.identity?.candidate ?? sourceResult?.candidate ?? null, run_directory: runDir, time_limit_ms: null } })
  checkpoint.original = { run_id: sourceResult?.run_id ?? sourceState?.run_id ?? null, series_identity: sourceResult?.series_identity ?? sourceState?.identity?.series_identity ?? null, candidate: sourceResult?.candidate ?? sourceState?.identity?.candidate ?? null, run_directory: source }
  checkpoint.delivery = sourceState?.delivery ?? sourceResult?.delivery_repository ?? null
  checkpoint.runner_run_id = sourceState?.runner_run_id ?? null
  const statePath = join(runDir, 'run-state.json')
  const persist = () => saveCheckpoint(statePath, checkpoint)
  await persist()
  let phase = 'rescore'; let outcome = null
  const step = async (name, run) => {
    phase = name
    checkpoint = beginUnit(checkpoint, { phase: name, unit: 'phase', inputs: {}, dependencies: {} }); await persist()
    try { const outputs = await run(); checkpoint = await completeUnit(checkpoint, { phase: name, unit: 'phase', inputs: {}, dependencies: {}, outputs: outputs ?? [] }); await persist() }
    catch (error) { checkpoint = failUnit(checkpoint, { phase: name, unit: 'phase', error: error.message }); await persist(); throw error }
  }
  const judging = () => createJudgingPhases({ runDir, suiteRoot: DEFINE_ROOT, getCheckpoint: () => checkpoint, setCheckpoint: value => { checkpoint = value }, persist, judges: deps.judges ?? createDefinitionJudges({ runDir }), gateCommand: deps.gateCommand, loadInputs: deps.loadInputs })
  const patterns = await readJson(join(SUITE_ROOT, 'contamination-patterns.json'))
  try {
    await step('reconciliation', async () => { const target = join(runDir, 'phases/reconciliation.json'); try { await writeJsonAtomic(target, reconcileConversation(await loadEvidence(runDir, SNAP.define))) } catch (error) { throw Object.assign(error, { resumable: false }) } return [target] })
    for (const [name, snapshot] of [['contamination-pass-1', SNAP.define], ['contamination-pass-2', SNAP.final]]) {
      await step(name, async () => { const audit = auditContamination({ ...await loadEvidence(runDir, snapshot), patterns }); const target = join(runDir, `phases/${name}.json`); await writeJsonAtomic(target, audit); if (audit.status === 'contaminated') outcome = { ...audit, evaluation_status: 'contaminated', owning_phase: name, resumable: false }; return [target] })
      if (outcome) break
    }
    if (!outcome) {
      await step('disclosure-audit', async () => judging()['disclosure-audit']())
      const disclosure = await readJson(join(runDir, 'audits/disclosure.json'))
      if (disclosure.leaked_items.length) outcome = failureOutcome({ phase: 'disclosure-audit', reason: `the simulated user leaked ${disclosure.leaked_items.join(', ')}`, resumable: false, leaked: disclosure.leaked_items })
    }
    if (!outcome) {
      await step('definition-scoring', async () => { const phases = judging(); return [...await phases['gates-and-judging'](), ...await phases.discovery()] })
      checkpoint.definition_scored = true
      let evaluated
      await step('product-evaluation', async () => {
        const production = deps.productDeps ? null : createProductionDeps({ runDir })
        evaluated = await (deps.evaluateProduct ?? evaluateProduct)({ runDir, rubric: product.rubric, inventory: product.inventory, bundlePath: join(runDir, retained.delivery.bundle.path), commit: retained.delivery.delivered_commit, collectedDir: join(runDir, 'collected'), acceptance: retained.delivery.acceptance,
          plan: retained.product.build_plan, deps: deps.productDeps ?? production })
        const target = join(runDir, 'phases/product-result.json'); await writeJsonAtomic(target, evaluated); return [target]
      })
      await step('requirement-trace', async () => {
        const asked = (await readJson(join(runDir, 'discovery/asked.json'))).results; const coverage = (await readJson(join(runDir, 'judges/score.json'))).coverage
        const target = join(runDir, 'phases/trace.json'); await writeJsonAtomic(target, buildTrace({ inventory: product.inventory, rubric: product.rubric, asked, coverage, product: evaluated.score, gates: evaluated.gates })); return [target]
      })
      await step('metrics', async () => {
        const text = await readFile(join(runDir, 'evidence/final/runner/run-metrics.json'), 'utf8').catch(() => null)
        const target = join(runDir, 'phases/workflow-metrics.json')
        await writeJsonAtomic(target, text ? ingestWorkflowMetrics({ text, runId: checkpoint.runner_run_id, workflow: sourceResult?.workflow?.name ?? 'change' }) : { state: 'unavailable', complete: false, by_step: {}, by_role: {}, total: null }); return [target]
      })
      if (!evaluated.human_review.eligible) await writeJsonAtomic(join(runDir, 'human-review/review.json'), { skipped: true, points: 0, reason: evaluated.human_review.reason, complete: false })
      outcome = { evaluation_status: evaluated.human_review.eligible ? 'pending-human-review' : 'complete', resumable: false }
    }
  } catch (error) {
    outcome = failureOutcome({ phase, reason: error.message, resumable: error.resumable ?? true, definition_scored: false })
    if (checkpoint.definition_scored) outcome.definition_scored = true
  }
  const result = await assembleResult({ runDir, outcome: { ...outcome }, checkpoint: { ...checkpoint, kind: 'rescore', series_identity: identity, candidate: checkpoint.identity.candidate, original: checkpoint.original, delivery: checkpoint.delivery }, rubric: product.rubric })
  result.mode = 'rescore'; result.rescore = true; result.series_identity = identity; result.original = checkpoint.original
  await writeResultArtifacts({ runDir, result })
  // A rescore is never published.
  return { result, exitCode: ['complete', 'pending-human-review'].includes(result.evaluation_status) ? 0 : 1 }
}
