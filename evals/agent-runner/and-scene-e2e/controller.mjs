#!/usr/bin/env node
// Host lifecycle for one end-to-end evaluation: provision a delivery repository, run the selected workflow in
// two capped invocations around a define checkpoint, verify delivery, then audit, score and report.
import { resolveCredentialEnv } from './lib/credentials.mjs'
import { mkdir, rm, lstat, open, unlink, readFile, readdir, rename, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DEFINE_ROOT, SUITE_ROOT, ORGANIZATION, REPO_ROOT, filesUnder, readJson } from './lib/files.mjs'
import { HELP, parseArguments } from './lib/options.mjs'
import { failureOutcome, publicationEligibility } from './lib/outcomes.mjs'
import { inspectInputs } from './lib/preflight.mjs'
import { E2ESandbox, stageRuntime } from './lib/sandbox.mjs'
import { createCheckpoint, beginUnit, completeUnit, failUnit, verifyUnit, loadCheckpoint, saveCheckpoint } from '../../lib/define-run/checkpoint.mjs'
import { hashJson, hashFile, writeJsonAtomic } from '../../lib/define-run/persistence.mjs'
import { materialize } from '../../lib/define-run/starting-repo.mjs'
import { scanCanaries } from '../../lib/define-run/canary.mjs'
import { verifyMountPlan } from '../../lib/define-run/mount-plan.mjs'
import { collectEvidence, loadEvidence, guardPath } from '../../lib/define-run/evidence.mjs'
import { reconcileConversation } from '../../lib/define-run/reconciliation.mjs'
import { auditContamination } from '../../lib/define-run/contamination.mjs'
import { createJudgingPhases } from '../../lib/define-run/judging.mjs'
import { runResponder } from '../../lib/define-run/responder.mjs'
import { createDefinitionJudges } from '../../lib/define-run/judge-invoker.mjs'
import { latestActivityMs } from '../and-scene/lib/runner-activity.mjs'
import { plannedProvisioning, provisionDelivery, reuseDelivery, startTokenRefresher, writeTokenFile, removeTokenFile, deliveryName } from './lib/provisioning.mjs'
import { readRunnerRun, classifyRun, privatePath } from './lib/runner.mjs'
import { runInvocation } from './lib/invocation.mjs'
import { watchForRequests } from './lib/responder.mjs'
import { collectDefinition, verifyDelivery, DeliveryError, HarnessEvidenceError } from './lib/delivery.mjs'
import { effectiveInvocations, invocationsThrough, ingestWorkflowMetrics } from './lib/metrics.mjs'
import { loadProductInputs } from './lib/product-rubric.mjs'
import { evaluateProduct, ProductHarnessError } from './lib/product-evaluation.mjs'
import { NotEvaluableError } from './lib/build-plan.mjs'
import { createProductionDeps } from './lib/production-deps.mjs'
import { buildTrace } from './lib/trace.mjs'
import { assembleResult, writeResultArtifacts } from './lib/result.mjs'
import { publishRun } from './lib/publication.mjs'
import { rescoreEvaluation } from './lib/rescore.mjs'
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
// A launcher may create the run directory first for its own output (Agent Factory writes factory-suite.log and .factory/); anything else means it was used.
const LAUNCHER_ENTRIES = ['factory-suite.log', '.factory']
const usedRunDir = async dir => { const entries = await readdir(dir).catch(error => { if (error.code === 'ENOENT') return null; throw error }); return entries !== null && entries.some(name => !LAUNCHER_ENTRIES.includes(name)) }
export async function runEvaluation(options, deps = {}) {
  if (options.rescoreFrom) return rescoreEvaluation(options, deps)
  const runDir = resolve(options.runDir)
  const env = deps.env ?? await resolveCredentialEnv(process.env, { runnerDir: options.runnerDir })
  const now = deps.now ?? (() => Date.now())
  const statePath = join(runDir, 'run-state.json')
  const inputDir = join(runDir, 'sandbox-input')
  const tokenDir = join(runDir, '.github-auth')
  const patternsPath = join(SUITE_ROOT, 'contamination-patterns.json')
  const product = await loadProductInputs()
  let checkpoint; let phase = 'preflight'; let result = null; let release; let writable = false; let artifactsWritten = false; let publicationFailed = false; let refused = false
  let sandbox; let inspected; let app
  const persist = () => saveCheckpoint(statePath, checkpoint)
  const provenance = () => ({ ...checkpoint.identity, materialization: checkpoint.materialization ?? null, schema_version: checkpoint.schema_version })
  const failWith = (error, extra = {}) => {
    const workflow = Boolean(error.workflow) && !error.harness
    return failureOutcome({ phase: error.phase ?? phase, reason: error.message, workflow, defineCompleted: Boolean(checkpoint?.define_completed), resumable: error.resumable ?? true, step: error.step ?? null, limit: error.limit ?? null, window: error.window ?? null, prohibited: error.prohibited ?? [], ...extra })
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
    } finally { await refresher.stop(); await removeTokenFile(tokenDir) }
  }
  // Each phase keeps its own copy: the Runner rewrites these files during the next invocation, and an earlier unit's
  // recorded output hashes must keep matching.
  async function saveWorkflow(state, name) {
    checkpoint.runner_run_id = state.run_id
    const directory = join(runDir, `phases/workflow-${name}`)
    await mkdir(directory, { recursive: true })
    const copies = []
    for (const file of ['state.json', 'audit.log', 'run-metrics.json']) {
      const source = join(state.session_dir, file)
      if (!await hashFile(source)) continue
      await guardPath(runDir, source)
      await copyFile(source, join(directory, file)); copies.push(join(directory, file))
    }
    const target = join(runDir, `phases/workflow-${name}.json`)
    await writeJsonAtomic(target, { runner_run_id: state.run_id, phase: name, configured_profiles: options.profiles, evidence: copies.map(path => path.slice(runDir.length + 1)) })
    await persist()
    return [target, ...copies]
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
  async function safetyCheck({ plan, sandbox: planned, inputDir: staged, credentials, forwardedEnv }) {
    verifyMountPlan(plan.output, { inputDir: staged, artifactDir: planned.artifactDir, runnerDir: options.runnerDir, skillsDir: options.skillsDir, credentialFiles: credentials, forwardedEnv, extraMounts: planned.extraMounts() })
    const matches = await scanCanaries({ stagedDir: staged, skillsDir: options.skillsDir, credentialFiles: credentials, patternsPath })
    if (matches.length) throw new Error(`canary check failed: ${matches.map(match => `${match.file} (${match.pattern})`).join(', ')}`)
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
      sandbox = deps.sandbox ?? new E2ESandbox({ ...options, env, runDir, tokenDir, reviewerClis: inspected.reviewerClis, workflow: options.workflow, deliveryUrl: `https://github.com/${ORGANIZATION}/${deliveryName(checkpoint.run_id)}.git` })
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
      await (deps.safetyCheck ?? safetyCheck)({ plan, sandbox, inputDir, credentials: inspected.credentials, forwardedEnv: inspected.forwardedEnv })
      checkpoint.plan = plan
      const path = join(runDir, 'phases/preflight.json')
      await writeJsonAtomic(path, { series_identity: inspected.seriesIdentity, candidate: inspected.candidate, planned_provisioning: plannedProvisioning(checkpoint.run_id), planned_invocation: plan, token_refresh_minutes: options.tokenRefreshMinutes, stall_window_ms: options.stallWindowMs })
      await persist()
      return [path]
    },
    provisioning: async () => {
      const patterns = await readJson(patternsPath)
      const token = await provisioningToken()
      const recorded = checkpoint.delivery?.full_name ? checkpoint.delivery : null
      const delivery = recorded && !recorded.pending
        ? await (deps.reuseDelivery ?? reuseDelivery)({ app, recorded, token })
        : await (deps.provisionDelivery ?? provisionDelivery)({ app, runId: checkpoint.run_id, bundlePath: join(inputDir, 'starting-repo.bundle'), commit: checkpoint.materialization.commit, patterns, token,
          existing: recorded, onCreated: async identity => { checkpoint.delivery = { ...identity, pending: true }; await persist() } })
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
    'define-workflow': () => dispatch('define', deps.startDefineResponder ?? (({ signal, deadline }) => runResponder({ runDir, exchangeDir: sandbox.exchangeDir, deadline, signal, runnerRunId: checkpoint.runner_run_id, invoke: deps.simulatedUser, inputs: deps.simulatedInputs,
      onExchangeDurable: async exchange => { if (checkpoint.runner_run_id && checkpoint.runner_run_id !== exchange.run_id) throw new Error('Runner exchange run identity mismatch'); checkpoint.runner_run_id = exchange.run_id; checkpoint.last_active_step = exchange.step; await persist() } })
      .catch(error => ({ status: 'evaluation-harness-failed', reason: error.message })))),
    'definition-collection': async () => {
      // The frozen definition is never rebuilt from a workspace implementation may have edited.
      if (checkpoint.implement_started) throw Object.assign(new Error('the definition was collected before implementation started and cannot be collected again from the edited workspace'), { resumable: false })
      const state = await readRunnerRun({ sandbox, runDir, recordedId: checkpoint.runner_run_id })
      await privatePath(join(sandbox.artifactDir, 'workspace/repo'), runDir)
      const manifest = await (deps.collectDefinition ?? collectDefinition)({ workspaceRepo: join(sandbox.artifactDir, 'workspace/repo'), runDir, readHead: deps.readHead })
      checkpoint.collection = manifest
      const metrics = await readJson(join(state.session_dir, 'run-metrics.json'))
      const invocations = invocationsThrough(effectiveInvocations(metrics), checkpoint.step_order, 'define')
      const evidence = await collectEvidence({ runDir, runnerDir: state.session_dir, invocations, identity: { run_id: checkpoint.run_id, series_identity: checkpoint.identity.series_identity, candidate: checkpoint.identity.candidate }, ...SNAPSHOT.define })
      checkpoint.define_completed = true
      await persist()
      return [join(runDir, 'phases/collection.json'), join(runDir, DEFINE_MANIFEST), ...evidence.files.map(file => join(runDir, file.path))]
    },
    'implement-workflow': async () => { checkpoint.implement_started = true; await persist(); return dispatch('implement', deps.startImplementResponder ?? (({ signal }) => watchForRequests({ exchangeDir: sandbox.exchangeDir, signal }))) },
    'delivery-verification': async () => {
      const state = await readRunnerRun({ sandbox, runDir, recordedId: checkpoint.runner_run_id })
      const token = await provisioningToken()
      const github = deps.deliveryApi ?? deliveryApi(app, token, checkpoint.delivery.full_name)
      let verified
      try {
        verified = await (deps.verifyDelivery ?? verifyDelivery)({ runDir, fullName: checkpoint.delivery.full_name, url: deps.deliveryUrl, token, api: github, sessionDir: state.session_dir })
      } catch (error) {
        if (error instanceof DeliveryError) await writeJsonAtomic(join(runDir, 'phases/delivery.json'), { ok: false, missing_outcome: error.outcome, prohibited_effects: error.prohibited })
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
      const production = deps.productDeps ? null : createProductionDeps({ runDir, env })
      const delivery = await readJson(join(runDir, 'phases/delivery.json'))
      const evaluated = await evaluateProduct({ runDir, rubric: product.rubric, inventory: product.inventory, bundlePath: join(runDir, 'source/candidate.bundle'), commit: delivery.delivered_commit, collectedDir: join(runDir, 'collected'), acceptance: delivery.acceptance,
        plan: checkpoint.build_plan ?? null, deps: deps.productDeps ?? production })
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
      // The whole run through implement: the latest Runner copy, whichever phase last saved one.
      let text = null
      for (const source of ['phases/workflow-implement/run-metrics.json', 'phases/workflow-define/run-metrics.json']) { text = await readFile(join(runDir, source), 'utf8').catch(() => null); if (text) break }
      const order = checkpoint.step_order ?? ['define', 'implement']
      const through = order.slice(0, order.indexOf('implement') + 1)
      await writeJsonAtomic(target, text ? ingestWorkflowMetrics({ text, runId: checkpoint.runner_run_id, workflow: inspected?.workflow?.name ?? 'change', stepOrder: through }) : { state: 'unavailable', complete: false, by_step: {}, by_role: {}, total: null })
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
  // Installation tokens last an hour and a run lasts hours, so the host-only provisioning token is minted when needed.
  const provisioningToken = async () => deps.provisioningToken ? deps.provisioningToken() : (await app.provisioningToken()).token
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
    if (!options.resume && await usedRunDir(runDir)) throw new Error('run directory is already used; use --resume with its exact path')
    if (options.resume && !await lstat(runDir).catch(() => null)) throw new Error('resume run directory does not exist')
    await mkdir(runDir, { recursive: true }); release = await acquireLock(runDir); writable = true
    for (const path of ['phases', 'logs', 'sandbox-input', 'sandbox/exchange', 'sandbox/workspace/repo', 'sandbox/.runtime', 'evidence', 'collected', 'judges', 'audits', 'discovery', 'source', 'human-review', '.runtime', '.runtime/definition-job-inputs', '.runtime/judge', '.runtime/judge-claude', 'human-review']) await privatePath(join(runDir, path), runDir)
    for (const dir of ['phases', 'logs', 'human-review', 'source', 'judges', 'audits', 'discovery']) await mkdir(join(runDir, dir), { recursive: true })
    const saved = options.resume ? await readJson(join(runDir, 'result.json'), null) : null
    if (saved && saved.evaluation_status !== 'complete' && saved.resumable === false) throw Object.assign(new Error(`this run ended ${saved.evaluation_status} (${saved.owning_phase ?? 'unknown phase'}) and cannot be resumed${saved.leaked_items?.length || saved.owning_phase === 'disclosure-audit' ? '; a new run is required' : ''}`), { resumable: false, refused: true })
    if (publicationEligibility(saved) && options.noPublish) return { result: saved, exitCode: 0 }
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
      result = { evaluation_status: 'dry-run', owning_phase: 'preflight', resumable: false, dry_run: true, planned_provisioning: plannedProvisioning(checkpoint.run_id) }
    } else {
      phase = 'preflight'; await handlers.preflight()
      checkpoint = await completeUnit(checkpoint, { phase, unit: 'phase', inputs: provenance(), dependencies: {}, outputs: [join(runDir, 'phases/preflight.json')] }); await persist()
      // A resumed run verifies its recorded repository even when provisioning was already complete.
      if (options.resume && checkpoint.delivery?.full_name && !checkpoint.delivery.pending) await (deps.reuseDelivery ?? reuseDelivery)({ app, recorded: checkpoint.delivery, token: await provisioningToken() })
      for (const name of ['provisioning', 'materialization', 'define-workflow', 'definition-collection']) await unit(name, handlers[name], { dependencies: name === 'materialization' ? {} : { materialization: checkpoint.materialization } })
      if (await checkpointUnits() === 'stop') {
        // contamination and leaks end the run before implementation
      } else {
        phase = 'implement-workflow'
        checkpoint = beginUnit(checkpoint, { phase, unit: 'phase', inputs: provenance(), dependencies: {} }); await persist()
        try { checkpoint = await completeUnit(checkpoint, { phase, unit: 'phase', inputs: provenance(), dependencies: {}, outputs: await handlers['implement-workflow']() }); await persist() }
        catch (error) { throw Object.assign(error, { defineCompleted: true }) }
        try { await unit('delivery-verification', handlers['delivery-verification']) }
        catch (error) {
          // A missing delivery outcome is a workflow failure; evidence the harness could not read is the harness's.
          if (error instanceof DeliveryError) throw Object.assign(error, { workflow: true, phase: 'delivery-verification' })
          if (error instanceof HarnessEvidenceError) throw Object.assign(error, { harness: true, resumable: true })
          throw error
        }
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
          if (publicationEligibility(result) && !options.noPublish) { phase = 'publication'; await publish() }
        }
      }
    }
  } catch (error) {
    if (phase === 'publication' && result?.evaluation_status === 'complete') publicationFailed = true
    else {
      const productError = error instanceof NotEvaluableError || error instanceof ProductHarnessError
      refused = Boolean(error.refused)
      result = failWith(error, productError ? { definition_scored: Boolean(checkpoint?.definition_scored) } : error.refused ? {} : { definition_scored: Boolean(checkpoint?.definition_scored) })
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
      if (writable && result && !artifactsWritten && !options.dryRun && !refused) {
        try { result = await assembleResult({ runDir, outcome: result, checkpoint, rubric: product.rubric }) }
        catch (assemblyError) { result = { ...result, assembly_error: assemblyError.message, run_id: checkpoint?.run_id ?? null, series_identity: checkpoint?.series_identity ?? null, candidate: checkpoint?.candidate ?? null } }
        await writeResultArtifacts({ runDir, result })
      } else if (writable && result && options.dryRun && !refused) await writeJsonAtomic(join(runDir, 'result.json'), result)
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
