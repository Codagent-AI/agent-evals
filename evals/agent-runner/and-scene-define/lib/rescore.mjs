import { mkdir, lstat } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SUITE_ROOT, contained } from './files.mjs'
import { loadEvidence, guardPath } from './evidence.mjs'
import { inspectEvaluatorInputs } from './preflight.mjs'
import { createCheckpoint, saveCheckpoint, beginUnit, completeUnit, failUnit } from './checkpoint.mjs'
import { readJson, writeJsonAtomic, writeTextAtomic, hashJson } from './persistence.mjs'
import { reconcileConversation } from './reconciliation.mjs'
import { auditContamination } from './contamination.mjs'
import { createJudgingPhases } from './judging.mjs'
import { ingestDefineMetrics } from './runner-metrics.mjs'
import { assembleResult, writeResultArtifacts } from './result.mjs'
import { failureOutcome } from './outcomes.mjs'
// The manifest identity is hash-protected by loadEvidence. When the original
// run's own records survive, they must also agree with it; a rescore source
// records its original under `original`.
async function crossCheckOriginal(source, identity) {
  for (const file of ['run-state.json', 'result.json']) {
    const path = join(source, file); await guardPath(source, path)
    const record = await readJson(path, null)
    if (!record) continue
    const recorded = record.kind === 'rescore' || record.mode === 'rescore' ? record.original : record
    for (const field of ['run_id', 'series_identity', 'candidate']) {
      if (hashJson(recorded?.[field] ?? null) !== hashJson(identity[field] ?? null)) throw new Error(`original identity mismatch: ${file} ${field} differs from the evidence manifest`)
    }
  }
}
// Read original evidence exclusively through the verified manifest. Only its
// byte buffers are copied; no workspace, old judgments, or runtime is consulted.
export async function rescoreEvaluation(options, dependencies = {}) {
  const runDir = resolve(options.runDir); const source = resolve(options.rescoreFrom); const suiteRoot = options.suiteRoot ?? SUITE_ROOT
  if (runDir === source || runDir.startsWith(source + '/')) throw Object.assign(new Error('rescore requires a separate new output directory'), { usage: true })
  await guardPath(runDir, runDir)
  if (await lstat(runDir).catch(error => { if (error.code !== 'ENOENT') throw error; return null })) throw Object.assign(new Error('rescore output directory is already used'), { usage: true })
  const evidence = await loadEvidence(source)
  if (!evidence.manifest.identity?.series_identity || !evidence.manifest.identity?.candidate) throw new Error('evidence manifest lacks original series identity and candidate')
  await crossCheckOriginal(source, evidence.manifest.identity)
  const { seriesIdentity } = await (dependencies.inspectEvaluator ?? inspectEvaluatorInputs)({ suiteRoot })
  await mkdir(dirname(runDir), { recursive: true })
  await mkdir(runDir)
  let checkpoint = createCheckpoint({ run_id: randomUUID(), kind: 'rescore', identity: { series_identity: seriesIdentity, candidate: evidence.manifest.identity.candidate, run_directory: runDir } })
  checkpoint.original = { run_directory: source, ...evidence.manifest.identity }
  const persist = () => saveCheckpoint(join(runDir, 'run-state.json'), checkpoint)
  let phase = 'retained-evidence'; let outcome
  try {
    for (const [path, bytes] of evidence.bytesByPath) {
      // The evidence contract has a fixed namespace; a forged manifest cannot
      // inject settings, checkpoints, or old score outputs into the new run.
      if (!['conversation.jsonl', 'phases/collection.json'].includes(path) && !path.startsWith('collected/') && !path.startsWith('evidence/')) throw new Error(`unexpected retained evidence path: ${path}`)
      const target = contained(runDir, path); await guardPath(runDir, target)
      await mkdir(dirname(target), { recursive: true }); await writeTextAtomic(target, bytes)
    }
    for (const dir of ['phases', 'audits', 'judges', 'discovery']) await mkdir(join(runDir, dir), { recursive: true })
    await writeJsonAtomic(join(runDir, 'evidence-manifest.json'), evidence.manifest)
    await persist()
    const judging = createJudgingPhases({ runDir, suiteRoot, getCheckpoint: () => checkpoint, setCheckpoint: value => { checkpoint = value }, persist, judges: dependencies.judges, gateCommand: dependencies.gateCommand, loadInputs: dependencies.loadInputs })
    const handlers = {
      'conversation-reconciliation': async () => { const target = join(runDir, 'phases/reconciliation.json'); await writeJsonAtomic(target, reconcileConversation(evidence)); return [target] },
      'contamination-audit': async () => { const target = join(runDir, 'phases/contamination-audit.json'); checkpoint.contamination_audit = auditContamination({ ...evidence, patterns: await readJson(join(suiteRoot, 'contamination-patterns.json')) }); await writeJsonAtomic(target, checkpoint.contamination_audit); return [target] },
      ...judging,
      metrics: async () => {
        const path = 'evidence/runner/run-metrics.json'; const text = evidence.bytesByPath.get(path)?.toString('utf8')
        const target = join(runDir, 'phases/workflow-metrics.json')
        await writeJsonAtomic(target, ingestDefineMetrics({ text, runId: text ? JSON.parse(text).run_id : null, path }))
        return [target]
      },
    }
    for (const [name, handler] of Object.entries(handlers)) {
      phase = name
      const inputs = checkpoint.identity; const dependencies = { evidence: evidence.manifest }
      checkpoint = beginUnit(checkpoint, { phase, unit: 'phase', inputs, dependencies }); await persist()
      const outputs = await handler()
      checkpoint = await completeUnit(checkpoint, { phase, unit: 'phase', inputs, dependencies, outputs }); await persist()
      if (checkpoint.contamination_audit?.status === 'contaminated') { outcome = { evaluation_status: 'contaminated', owning_phase: phase, resumable: false }; break }
    }
    outcome ??= { evaluation_status: 'complete', resumable: false }
  } catch (error) {
    outcome = failureOutcome({ phase, reason: error.message, resumable: false })
    checkpoint = failUnit(checkpoint, { phase, unit: 'phase', error: error.message }); await persist()
  }
  const result = await assembleResult({ runDir, outcome, checkpoint }); await writeResultArtifacts({ runDir, result })
  return { result, exitCode: result.evaluation_status === 'complete' ? 0 : 1 }
}
