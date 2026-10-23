#!/usr/bin/env node
// Host lifecycle for one end-to-end evaluation: provision a delivery repository, run the selected workflow in
// two capped invocations around a define checkpoint, verify delivery, then audit, score and report.
import { mkdir, rm, lstat, open, unlink, readFile, rename, copyFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DEFINE_ROOT, SUITE_ROOT, CHANGE_NAME, ORGANIZATION, REPO_ROOT, filesUnder, readJson, sha256 } from './lib/files.mjs'
import { HELP, parseArguments, DEFAULT_ROLES } from './lib/options.mjs'
import { failureOutcome, publicationEligibility } from './lib/outcomes.mjs'
import { inspectInputs, PreflightError } from './lib/preflight.mjs'
import { E2ESandbox, stageRuntime, readValidatorReviewerClis } from './lib/sandbox.mjs'
import { createCheckpoint, beginUnit, completeUnit, failUnit, verifyUnit, loadCheckpoint, saveCheckpoint } from '../and-scene-define/lib/checkpoint.mjs'
import { hashJson, hashFile, writeJsonAtomic } from '../and-scene-define/lib/persistence.mjs'
import { materialize, verifySnapshot } from '../and-scene-define/lib/starting-repo.mjs'
import { scanCanaries } from '../and-scene-define/lib/canary.mjs'
import { verifyMountPlan } from '../and-scene-define/lib/mount-plan.mjs'
import { collectEvidence, loadEvidence, guardPath } from '../and-scene-define/lib/evidence.mjs'
import { reconcileConversation } from '../and-scene-define/lib/reconciliation.mjs'
import { auditContamination } from '../and-scene-define/lib/contamination.mjs'
import { createJudgingPhases } from '../and-scene-define/lib/judging.mjs'
import { runResponder } from '../and-scene-define/lib/responder.mjs'
import { createDefinitionJudges } from '../and-scene-define/lib/judge-invoker.mjs'
import { latestActivityMs } from '../and-scene/lib/runner-activity.mjs'
import { GitHubApp, loadAppCredentials, plannedProvisioning, provisionDelivery, reuseDelivery, startTokenRefresher, writeTokenFile, removeTokenFile, deliveryName } from './lib/provisioning.mjs'
import { checkWorkflow } from './lib/workflow.mjs'
import { readRunnerRun, classifyRun, privatePath } from './lib/runner.mjs'
import { runInvocation, InvocationError } from './lib/invocation.mjs'
import { watchForRequests } from './lib/responder.mjs'
import { collectDefinition, verifyDelivery, DeliveryError, HarnessEvidenceError } from './lib/delivery.mjs'
import { effectiveInvocations, invocationsThrough, ingestWorkflowMetrics } from './lib/metrics.mjs'
import { loadProductInputs } from './lib/product-rubric.mjs'
import { evaluateProduct, ProductHarnessError } from './lib/product-evaluation.mjs'
import { NotEvaluableError } from './lib/build-plan.mjs'
import { createProductJudges } from './lib/product-judges.mjs'
import { buildTrace } from './lib/trace.mjs'
import { assembleResult, writeResultArtifacts } from './lib/result.mjs'
import { publishRun } from './lib/publication.mjs'
import { rescoreEvaluation } from './lib/rescore.mjs'
import { PHASES } from './lib/phases.mjs'
export { HELP, parseArguments }
const DEFINE_MANIFEST = 'evidence/define-manifest.json'
const FINAL_MANIFEST = 'evidence/final-manifest.json'
const SNAPSHOT = { define: { evidenceRoot: 'evidence/define', manifestPath: DEFINE_MANIFEST }, final: { evidenceRoot: 'evidence/final', manifestPath: FINAL_MANIFEST } }
export function identityMismatches(recorded, current, path = '') {
  if (hashJson(recorded) === hashJson(current)) return []
  if (!recorded || !current || typeof recorded !== 'object' || typeof current !== 'object') return [path]
  return [...new Set([...Object.keys(recorded), ...Object.keys(current)])].flatMap(key => identityMismatches(recorded[key] ?? null, current[key] ?? null, path ? `${path}.${key}` : key))
}
async function acquireLock(runDir) {
  const path = join(runDir, '.controller.lock')
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); await handle.close()
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const lock = await readJson(path)
    try { process.kill(lock.pid, 0); throw new Error(`evaluation controller is active (PID ${lock.pid})`) } catch (probe) { if (probe.code !== 'ESRCH') throw probe }
    await unlink(path); return acquireLock(runDir)
  }
  return () => unlink(path)
}
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12)
export async function runEvaluation(options, deps = {}) {
  if (options.rescoreFrom) return rescoreEvaluation(options, deps)
  const runDir = resolve(options.runDir)
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => Date.now())
  const statePath = join(runDir, 'run-state.json')
  const inputDir = join(runDir, 'sandbox-input')
  const tokenDir = join(runDir, '.github-auth')
  const patternsPath = join(SUITE_ROOT, 'contamination-patterns.json')
  const product = await loadProductInputs()
  let checkpoint; let phase = 'preflight'; let result = null; let release; let writable = false; let artifactsWritten = false; let publicationFailed = false
  let sandbox; let inspected; let app
  const persist = () => saveCheckpoint(statePath, checkpoint)
  const provenance = () => ({ ...checkpoint.identity, materialization: checkpoint.materialization ?? null, schema_version: checkpoint.schema_version })
  const failWith = (error, extra = {}) => {
    const workflow = Boolean(error.workflow) && !error.harness
    return failureOutcome({ phase: error.phase ?? phase, reason: error.message, workflow, defineCompleted: Boolean(checkpoint?.define_completed), resumable: error.resumable ?? false, step: error.step ?? null, limit: error.limit ?? null, window: error.window ?? null, prohibited: error.prohibited ?? [], ...extra })
  }
  // A unit is reused only when its inputs, dependencies and output hashes still match.
  async function unit(name, handler, { dependencies = {}, reuse = null } = {}) {
    const inputs = checkpoint ? provenance() : {}
    phase = name
    if ((await verifyUnit(checkpoint, { phase: name, unit: 'phase', inputs, dependencies })).reusable) { if (reuse) await reuse(); return }
    checkpoint = beginUnit(checkpoint, { phase: name, unit: 'phase', inputs, dependencies }); await persist()
    const outputs = await handler()
    checkpoint = await completeUnit(checkpoint, { phase: name, unit: 'phase', inputs: provenance(), dependencies, outputs })
    await persist()
  }
  const manifestHash = async manifest => hashFile(join(runDir, manifest))
  async function invokeWorkflow({ until, mode, startResponder }) {
    const tokens = deps.tokens ?? { mint: async () => app.runToken(deliveryName(checkpoint.run_id)) }
    await writeTokenFile(tokenDir, (await tokens.mint()).token)
    const refresher = startTokenRefresher({ mint: () => tokens.mint(), dir: tokenDir, intervalMs: (options.tokenRefreshMinutes ?? 30) * 60 * 1000, onError: error => { checkpoint.token_refresh_errors = [...(checkpoint.token_refresh_errors ?? []), error.message.slice(0, 200)] }, setTimer: deps.setTimer, clearTimer: deps.clearTimer })
    try {
      return await runInvocation({ sandbox, profiles: options.profiles, mode, until, state: checkpoint, limitMs: options.timeLimitMs ?? checkpoint.identity.time_limit_ms, stallWindowMs: checkpoint.stall_window_ms,
        activity: deps.activity ?? (() => latestActivityMs({ roots: [join(sandbox.artifactDir, '.runtime'), join(sandbox.artifactDir, 'workspace/repo')] })), now, monitorMs: deps.monitorMs ?? 1000, signal: deps.signal, quota: deps.quota, sleep: deps.sleep,
        persist, readOutcome: async () => { const runnerState = await readRunnerRun({ sandbox, runDir, recordedId: checkpoint.runner_run_id }); return { runnerState, outcome: classifyRun(runnerState, until) } }, startResponder })
    } finally { refresher.stop(); await removeTokenFile(tokenDir) }
  }
  async function saveWorkflow(state, name) {
    checkpoint.runner_run_id = state.run_id
    const evidence = []
    for (const file of ['state.json', 'audit.log', 'run-metrics.json']) {
      const path = join(state.session_dir, file)
      if (await hashFile(path)) evidence.push(...await sandbox.retrieve([path.slice(sandbox.artifactDir.length + 1)]))
    }
    const target = join(runDir, `phases/workflow-${name}.json`)
    await writeJsonAtomic(target, { runner_run_id: state.run_id, phase: name, configured_profiles: options.profiles, evidence })
    await persist()
    return [target, ...evidence]
  }
  async function dispatch(until, startResponder) {
    let state = await readRunnerRun({ sandbox, runDir, recordedId: checkpoint.runner_run_id, workflowName: inspected?.workflow.name })
    if (classifyRun(state, until).kind === 'capped') return saveWorkflow(state, until)
    if (await sandbox.isActive()) throw new Error('Agent Runner sandbox is still active; refusing a duplicate or concurrent resume')
    if (checkpoint[`${until}_started`] && !state) throw Object.assign(new Error('unfinished workflow has no recoverable Runner state; refusing to start a duplicate run'), { resumable: false })
    checkpoint[`${until}_started`] = true
    if (state) checkpoint.runner_run_id = state.run_id
    await persist()
    const mode = until === 'define' && !state ? { kind: 'fresh' } : { kind: 'resume', runId: state.run_id, until }
    const outcome = await invokeWorkflow({ until, mode, startResponder })
    return saveWorkflow(outcome.runnerState, until)
  }
  const handlers = {
    preflight: async () => {
      inspected = await inspect()
      const identity = { series_identity: inspected.seriesIdentity, candidate: inspected.candidate, run_directory: runDir, time_limit_ms: options.timeLimitMs }
      if (options.resume) {
        checkpoint = await loadCheckpoint(statePath)
        if (!checkpoint) throw new Error('resume requires run-state.json in the exact existing run directory')
        const mismatch = identityMismatches(checkpoint.identity, identity)
        if (mismatch.length) throw new Error(`resume identity mismatch: ${mismatch.join(', ')}`)
        if (checkpoint.stall_window_ms !== options.stallWindowMs) throw new Error(`resume stall window differs from the recorded ${checkpoint.stall_window_ms}ms`)
      } else {
        checkpoint = createCheckpoint({ run_id: shortId(), identity })
        checkpoint.step_order = inspected.workflow.top_steps
        Object.assign(checkpoint, { stall_window_ms: options.stallWindowMs, token_refresh_minutes: options.tokenRefreshMinutes, active_ms: 0, quota_waits: [] })
      }
      sandbox = deps.sandbox ?? new E2ESandbox({ ...options, runDir, tokenDir, reviewerClis: inspected.reviewerClis, workflow: options.workflow, deliveryUrl: `https://github.com/${ORGANIZATION}/${deliveryName(checkpoint.run_id)}.git` })
      checkpoint = beginUnit(checkpoint, { phase: 'preflight', unit: 'phase', inputs: identity, dependencies: {} }); await persist()
      const staging = join(runDir, '.materialization'); const runtimeStage = join(runDir, '.sandbox-input-staging')
      await privatePath(staging); await privatePath(runtimeStage)
      await rm(staging, { recursive: true, force: true }); await rm(runtimeStage, { recursive: true, force: true })
      const staged = await (deps.materialize ?? materialize)(staging, { suiteRoot: DEFINE_ROOT })
      try {
        await stageRuntime({ inputDir: runtimeStage, bundlePath: staged.bundlePath, profiles: options.profiles, roles: inspected.workflow.roles })
        if (await lstat(inputDir).catch(() => null)) {
          for (const path of await filesUnder(runtimeStage)) {
            const name = path.slice(runtimeStage.length + 1)
            if (await hashFile(join(inputDir, name)) !== await hashFile(path)) throw new Error(`pinned sandbox input hash mismatch: ${name}`)
          }
        } else await rename(runtimeStage, inputDir)
        checkpoint.materialization = { commit: staged.commit, tree_hash: staged.treeHash }
      } finally { await rm(staging, { recursive: true, force: true }); await rm(runtimeStage, { recursive: true, force: true }) }
      await sandbox.stage(inputDir)
      await mkdir(tokenDir, { recursive: true, mode: 0o700 })
      const plan = await sandbox.plan(options.profiles, { kind: 'fresh' })
      // The staged input and the planned mounts are checked before anything is dispatched.
      verifyMountPlan(plan.output, { inputDir, artifactDir: sandbox.artifactDir, runnerDir: options.runnerDir, skillsDir: options.skillsDir, credentialFiles: inspected.credentials, forwardedEnv: inspected.forwardedEnv, extraMounts: sandbox.extraMounts() })
      const matches = await scanCanaries({ stagedDir: inputDir, skillsDir: options.skillsDir, credentialFiles: inspected.credentials, patternsPath })
      if (matches.length) throw new Error(`canary check failed: ${matches.map(match => `${match.file} (${match.pattern})`).join(', ')}`)
      checkpoint.plan = plan
      const path = join(runDir, 'phases/preflight.json')
      await writeJsonAtomic(path, { series_identity: inspected.seriesIdentity, candidate: inspected.candidate, planned_provisioning: plannedProvisioning(checkpoint.run_id), planned_invocation: plan, token_refresh_minutes: options.tokenRefreshMinutes, stall_window_ms: options.stallWindowMs })
      await persist()
      return [path]
    },
    provisioning: async () => {
      const patterns = await readJson(patternsPath)
      const delivery = options.resume && checkpoint.delivery?.full_name
        ? await (deps.reuseDelivery ?? reuseDelivery)({ app, recorded: checkpoint.delivery, token: inspected.provisioning.token })
        : await (deps.provisionDelivery ?? provisionDelivery)({ app, runId: checkpoint.run_id, bundlePath: join(inputDir, 'starting-repo.bundle'), commit: checkpoint.materialization.commit, patterns, token: inspected.provisioning.token })
      checkpoint.delivery = delivery
      const target = join(runDir, 'phases/delivery-repository.json')
      await writeJsonAtomic(target, delivery); await persist()
      return [target]
    },
    materialization: async () => {
      const target = join(runDir, 'phases/materialization.json')
      await writeJsonAtomic(target, checkpoint.materialization)
      return [target, ...await filesUnder(inputDir)]
    },
    'define-workflow': () => dispatch('define', ({ signal, deadline }) => runResponder({ runDir, exchangeDir: sandbox.exchangeDir, deadline, signal, runnerRunId: checkpoint.runner_run_id, invoke: deps.simulatedUser, inputs: deps.simulatedInputs,
      onExchangeDurable: async exchange => { if (checkpoint.runner_run_id && checkpoint.runner_run_id !== exchange.run_id) throw new Error('Runner exchange run identity mismatch'); checkpoint.runner_run_id = exchange.run_id; checkpoint.last_active_step = exchange.step; await persist() } })
      .catch(error => ({ status: 'evaluation-harness-failed', reason: error.message }))),
    'definition-collection': async () => {
      const state = await readRunnerRun({ sandbox, runDir, recordedId: checkpoint.runner_run_id })
      await privatePath(join(sandbox.artifactDir, 'workspace/repo'), runDir)
      const manifest = await (deps.collectDefinition ?? collectDefinition)({ workspaceRepo: join(sandbox.artifactDir, 'workspace/repo'), runDir })
      checkpoint.collection = manifest
      const metrics = await readJson(join(state.session_dir, 'run-metrics.json'))
      const invocations = invocationsThrough(effectiveInvocations(metrics), checkpoint.step_order, 'define')
      const evidence = await collectEvidence({ runDir, runnerDir: state.session_dir, invocations, identity: { run_id: checkpoint.run_id, series_identity: checkpoint.identity.series_identity, candidate: checkpoint.identity.candidate }, ...SNAPSHOT.define })
      checkpoint.define_completed = true
      await persist()
      return [join(runDir, 'phases/collection.json'), join(runDir, DEFINE_MANIFEST), ...evidence.files.map(file => join(runDir, file.path))]
    },
    'define-checkpoint': null,
    'implement-workflow': () => dispatch('implement', ({ signal }) => watchForRequests({ exchangeDir: sandbox.exchangeDir, signal })),
    'delivery-verification': async () => {
      const state = await readRunnerRun({ sandbox, runDir, recordedId: checkpoint.runner_run_id })
      const github = deps.deliveryApi ?? deliveryApi(app, inspected.provisioning.token, checkpoint.delivery.full_name)
      let verified
      try {
        verified = await (deps.verifyDelivery ?? verifyDelivery)({ runDir, fullName: checkpoint.delivery.full_name, url: deps.deliveryUrl, token: inspected.provisioning.token, api: github, sessionDir: state.session_dir })
      } catch (error) {
        if (error instanceof DeliveryError) { await writeJsonAtomic(join(runDir, 'phases/delivery.json'), { ok: false, missing_outcome: error.outcome, prohibited_effects: error.prohibited }); throw Object.assign(error, { workflow: true, phase: 'delivery-verification', defineCompleted: true }) }
        if (error instanceof HarnessEvidenceError) throw Object.assign(error, { harness: true, resumable: true })
        throw error
      }
      checkpoint.delivered_commit = verified.delivered_commit
      const target = join(runDir, 'phases/delivery.json')
      await writeJsonAtomic(target, { ok: true, ...verified, identity: checkpoint.delivery, prohibited_effects: [] }); await persist()
      return [target, join(runDir, verified.bundle.path)]
    },
    'contamination-pass-2': async () => {
      const state = await readRunnerRun({ sandbox, runDir, recordedId: checkpoint.runner_run_id })
      const metrics = await readJson(join(state.session_dir, 'run-metrics.json'))
      await collectEvidence({ runDir, runnerDir: state.session_dir, invocations: effectiveInvocations(metrics), identity: { run_id: checkpoint.run_id, series_identity: checkpoint.identity.series_identity, candidate: checkpoint.identity.candidate }, ...SNAPSHOT.final })
      const evidence = await loadEvidence(runDir, SNAPSHOT.final)
      const audit = auditContamination({ ...evidence, patterns: await readJson(patternsPath) })
      const target = join(runDir, 'phases/contamination-pass-2.json')
      await writeJsonAtomic(target, audit); checkpoint.contamination_pass_2 = audit.status; await persist()
      return [target]
    },
    'product-evaluation': async () => {
      const judges = deps.productJudges ?? createProductJudges({ runDir, allowedRoots: [join(runDir, 'neutral')] })
      const delivery = await readJson(join(runDir, 'phases/delivery.json'))
      const evaluated = await evaluateProduct({ runDir, rubric: product.rubric, inventory: product.inventory, bundlePath: join(runDir, 'source/candidate.bundle'), commit: delivery.delivered_commit, collectedDir: join(runDir, 'collected'), acceptance: delivery.acceptance,
        plan: checkpoint.build_plan ?? null, deps: { panel: judges.panel, decider: judges.decider, invoke: judges.invoke, ...deps.productDeps } })
      checkpoint.build_plan = evaluated.build_plan
      const target = join(runDir, 'phases/product-result.json')
      await writeJsonAtomic(target, evaluated); await persist()
      return [target]
    },
    'requirement-trace': async () => {
      const productResult = await readJson(join(runDir, 'phases/product-result.json'), null)
      const target = join(runDir, 'phases/trace.json')
      await writeJsonAtomic(target, await traceFor(productResult?.score ?? null))
      return [target]
    },
    metrics: async () => {
      const target = join(runDir, 'phases/workflow-metrics.json')
      const path = join(runDir, 'evidence/final/runner/run-metrics.json')
      const text = await readFile(path, 'utf8').catch(() => readFile(join(runDir, 'evidence/define/runner/run-metrics.json'), 'utf8').catch(() => null))
      await writeJsonAtomic(target, text ? ingestWorkflowMetrics({ text, runId: checkpoint.runner_run_id, workflow: inspected?.workflow?.name ?? 'change', stepOrder: checkpoint.step_order?.filter(step => ['define', 'implement'].includes(step)) ?? ['define', 'implement'] }) : { state: 'unavailable', complete: false, by_step: {}, by_role: {}, total: null })
      return [target]
    },
    ...deps.handlers,
  }
  // Definition-side judging reuses the define suite's phases over the collected copy and the define-only evidence.
  const judging = () => createJudgingPhases({ runDir, suiteRoot: DEFINE_ROOT, getCheckpoint: () => checkpoint, setCheckpoint: value => { checkpoint = value }, persist, judges: deps.judges ?? createDefinitionJudges({ runDir }), gateCommand: deps.gateCommand, loadInputs: deps.loadInputs })
  async function traceFor(productScore) {
    const asked = (await readJson(join(runDir, 'discovery/asked.json'))).results
    const coverage = (await readJson(join(runDir, 'judges/score.json'))).coverage
    return buildTrace({ inventory: product.inventory, rubric: product.rubric, asked, coverage, product: productScore })
  }
  async function inspect() {
    const found = await (deps.inspect ?? inspectInputs)({ profiles: options.profiles, workflow: options.workflow, runnerDir: options.runnerDir, skillsDir: options.skillsDir, dryRun: options.dryRun ?? false, env, home: deps.home, command: deps.command, app: deps.app })
    app = found.provisioning.app
    return found
  }
  const deliveryApi = (github, token, full) => ({ pulls: () => github.paged(`/repos/${full}/pulls?state=all`, token), refs: () => github.paged(`/repos/${full}/git/matching-refs/heads`, token) })
  const checkpointUnits = async () => {
    // The define checkpoint: reconciliation, contamination pass 1, disclosure audit, stopping at the first failure.
    await unit('reconciliation', async () => {
      const evidence = await loadEvidence(runDir, SNAPSHOT.define)
      const target = join(runDir, 'phases/reconciliation.json')
      try { await writeJsonAtomic(target, reconcileConversation(evidence)) } catch (error) { throw Object.assign(error, { phase: 'reconciliation', resumable: false }) }
      return [target]
    }, { dependencies: { manifest: await manifestHash(DEFINE_MANIFEST) } })
    await unit('contamination-pass-1', async () => {
      const evidence = await loadEvidence(runDir, SNAPSHOT.define)
      const audit = auditContamination({ ...evidence, patterns: await readJson(patternsPath) })
      const target = join(runDir, 'phases/contamination-pass-1.json')
      await writeJsonAtomic(target, audit); checkpoint.contamination_pass_1 = audit.status; await persist()
      return [target]
    }, { dependencies: { manifest: await manifestHash(DEFINE_MANIFEST), patterns: await hashFile(patternsPath) } })
    if (checkpoint.contamination_pass_1 === 'contaminated' || (await readJson(join(runDir, 'phases/contamination-pass-1.json'))).status === 'contaminated') {
      result = { ...(await readJson(join(runDir, 'phases/contamination-pass-1.json'))), evaluation_status: 'contaminated', owning_phase: 'contamination-pass-1', resumable: false }; return 'stop'
    }
    await unit('disclosure-audit', async () => judging()['disclosure-audit'](), { dependencies: { conversation: await hashFile(join(runDir, 'conversation.jsonl')), collection: await hashFile(join(runDir, 'phases/collection.json')) } })
    const disclosure = await readJson(join(runDir, 'audits/disclosure.json'))
    if (disclosure.leaked_items.length) {
      result = failureOutcome({ phase: 'disclosure-audit', reason: `the simulated user leaked ${disclosure.leaked_items.join(', ')}; a new run is required`, resumable: false, leaked: disclosure.leaked_items })
      return 'stop'
    }
    return null
  }
  const definitionScoring = async () => unit('definition-scoring', async () => {
    const phases = judging()
    const outputs = [...await phases['gates-and-judging'](), ...await phases.discovery()]
    checkpoint.definition_scored = true; await persist()
    return outputs
  }, { dependencies: { collection: await hashFile(join(runDir, 'phases/collection.json')), conversation: await hashFile(join(runDir, 'conversation.jsonl')) } })
  async function finalizeResult(outcome) {
    result = await assembleResult({ runDir, outcome, checkpoint, rubric: product.rubric })
    await writeResultArtifacts({ runDir, result }); artifactsWritten = true
    return result
  }
  const publish = async () => { await (deps.publish ?? publishRun)({ runDir, repoDir: options.repoDir ?? REPO_ROOT, result }); return (await hashFile(join(runDir, 'publication.json'))) ? [join(runDir, 'publication.json')] : [] }
  try {
    await privatePath(runDir)
    if (!options.resume && await lstat(runDir).catch(() => null)) throw new Error('run directory is already used; use --resume with its exact path')
    if (options.resume && !await lstat(runDir).catch(() => null)) throw new Error('resume run directory does not exist')
    await mkdir(runDir, { recursive: true }); release = await acquireLock(runDir); writable = true
    for (const path of ['phases', 'logs', 'sandbox-input', 'sandbox/exchange', 'sandbox/workspace/repo', 'sandbox/.runtime', 'evidence', 'collected', 'judges', 'audits', 'discovery', 'source', '.runtime', '.runtime/definition-job-inputs', '.runtime/judge', '.runtime/judge-claude', 'human-review']) await privatePath(join(runDir, path), runDir)
    await mkdir(join(runDir, 'phases'), { recursive: true }); await mkdir(join(runDir, 'logs'), { recursive: true })
    const saved = options.resume ? await readJson(join(runDir, 'result.json'), null) : null
    if (saved && saved.evaluation_status !== 'complete' && saved.resumable === false) throw Object.assign(new Error(`this run ended ${saved.evaluation_status} (${saved.owning_phase ?? 'unknown phase'}) and cannot be resumed${saved.leaked_items?.length || saved.owning_phase === 'disclosure-audit' ? '; a new run is required' : ''}`), { resumable: false, refused: true })
    if (publicationEligibility(saved)) {
      checkpoint = await loadCheckpoint(statePath)
      if (!checkpoint || saved.run_id !== checkpoint.run_id) throw new Error('publication resume run identity mismatch')
      phase = 'publication'; result = saved; artifactsWritten = true
      await publish()
      return { result, exitCode: 0 }
    }
    if (options.dryRun) {
      await handlers.preflight()
      checkpoint = await completeUnit(checkpoint, { phase: 'preflight', unit: 'phase', inputs: provenance(), dependencies: {}, outputs: [join(runDir, 'phases/preflight.json')] }); await persist()
      result = { ...failureOutcome({ phase: 'define-workflow', reason: 'dry-run: workflow was not started' }), dry_run: true, planned_provisioning: plannedProvisioning(checkpoint.run_id) }
    } else {
      const ordered = [['preflight'], ['provisioning'], ['materialization'], ['define-workflow'], ['definition-collection']]
      for (const [name] of ordered) {
        if (name === 'preflight') { phase = name; await handlers.preflight(); checkpoint = await completeUnit(checkpoint, { phase: name, unit: 'phase', inputs: provenance(), dependencies: {}, outputs: [join(runDir, 'phases/preflight.json')] }); await persist(); continue }
        const dependencies = name === 'materialization' ? {} : { materialization: checkpoint.materialization }
        if (name === 'define-workflow') { phase = name; checkpoint = beginUnit(checkpoint, { phase: name, unit: 'phase', inputs: provenance(), dependencies }); await persist(); const outputs = await handlers[name](); checkpoint = await completeUnit(checkpoint, { phase: name, unit: 'phase', inputs: provenance(), dependencies, outputs }); await persist(); continue }
        await unit(name, handlers[name], { dependencies })
      }
      if (await checkpointUnits() === 'stop') {
        // contamination and leaks end the run before implementation
      } else {
        phase = 'implement-workflow'
        checkpoint = beginUnit(checkpoint, { phase, unit: 'phase', inputs: provenance(), dependencies: {} }); await persist()
        try { checkpoint = await completeUnit(checkpoint, { phase, unit: 'phase', inputs: provenance(), dependencies: {}, outputs: await handlers['implement-workflow']() }); await persist() }
        catch (error) { throw Object.assign(error, { defineCompleted: true }) }
        await unit('delivery-verification', handlers['delivery-verification'])
        await unit('contamination-pass-2', handlers['contamination-pass-2'], { dependencies: { patterns: await hashFile(patternsPath) } })
        if ((await readJson(join(runDir, 'phases/contamination-pass-2.json'))).status === 'contaminated') {
          result = { ...(await readJson(join(runDir, 'phases/contamination-pass-2.json'))), evaluation_status: 'contaminated', owning_phase: 'contamination-pass-2', resumable: false }
        } else {
          await definitionScoring()
          await unit('product-evaluation', handlers['product-evaluation'])
          await unit('requirement-trace', handlers['requirement-trace'])
          await unit('metrics', handlers.metrics)
          const evaluated = await readJson(join(runDir, 'phases/product-result.json'))
          const eligible = evaluated.human_review.eligible
          if (!eligible) await writeJsonAtomic(join(runDir, 'human-review/review.json'), { skipped: true, points: 0, reason: evaluated.human_review.reason, complete: false })
          phase = 'result-and-report'
          await finalizeResult({ evaluation_status: eligible ? 'pending-human-review' : 'complete', resumable: false })
          if (publicationEligibility(result)) { phase = 'publication'; await publish() }
        }
      }
    }
  } catch (error) {
    if (phase === 'publication' && result?.evaluation_status === 'complete') publicationFailed = true
    else {
      const productError = error instanceof NotEvaluableError || error instanceof ProductHarnessError
      result = failWith(error, productError ? { definition_scored: Boolean(checkpoint?.definition_scored) } : error.refused ? {} : { definition_scored: Boolean(checkpoint?.definition_scored) })
      if (error instanceof InvocationError || error.workflow) result.defineCompleted = undefined
      if (checkpoint && writable && !error.refused) { checkpoint = failUnit(checkpoint, { phase, unit: 'phase', error: error.message }); await persist() }
      // A workflow that failed after define still reports the definition score and a trace with delivery unavailable.
      if (writable && checkpoint?.define_completed && result.evaluation_status === 'implementation-workflow-failed') {
        try {
          if (!checkpoint.definition_scored) await definitionScoring()
          const target = join(runDir, 'phases/trace.json'); await writeJsonAtomic(target, await traceFor(null))
          result.definition_scored = true
          await handlers.metrics().catch(() => {})
        } catch (scoringError) { result.scoring_error = scoringError.message }
      }
    }
  } finally {
    try {
      if (writable && result && !artifactsWritten && !options.dryRun) {
        try { result = await assembleResult({ runDir, outcome: result, checkpoint, rubric: product.rubric }) }
        catch (assemblyError) { result = { ...result, assembly_error: assemblyError.message, run_id: checkpoint?.run_id ?? null, series_identity: checkpoint?.series_identity ?? null, candidate: checkpoint?.candidate ?? null } }
        await writeResultArtifacts({ runDir, result })
      } else if (writable && result && options.dryRun) await writeJsonAtomic(join(runDir, 'result.json'), result)
    } finally { if (release) await release() }
  }
  const succeeded = ['complete', 'pending-human-review'].includes(result?.evaluation_status) && !publicationFailed
  return { result, exitCode: options.dryRun && result?.dry_run ? 0 : succeeded ? 0 : 1, plan: checkpoint?.plan }
}
async function main() {
  let options
  try { options = parseArguments(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1; return }
  if (options.help) { console.log(HELP); return }
  const signal = new AbortController()
  const stop = () => signal.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const { result, exitCode, plan } = await runEvaluation(options, { signal: signal.signal })
    if (options.dryRun && plan) { console.log(plan.command.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')); console.log(plan.output) }
    console.log(JSON.stringify({ ...result, run_directory: options.runDir }, null, 2)); process.exitCode = exitCode
  } catch (error) {
    console.error(`and-scene-e2e: ${error?.message ?? String(error)}`)
    if (!error?.usage) console.error(error?.stack ?? error)
    process.exitCode = 1
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
