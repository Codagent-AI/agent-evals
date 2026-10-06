import { mkdir, rm, rename, readFile, lstat, open, unlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { filesUnder } from './lib/files.mjs'
import { inspectInputs, verifyMountPlan } from './lib/preflight.mjs'
import { validateProfiles } from './lib/profiles.mjs'
import { LocalSandbox, stageRuntime } from './lib/sandbox.mjs'
import { materialize } from './lib/starting-repo.mjs'
import { scanCanaries } from './lib/canary.mjs'
import { createCheckpoint, beginUnit, completeUnit, failUnit, verifyUnit, loadCheckpoint, saveCheckpoint } from './lib/checkpoint.mjs'
import { hashJson, writeJsonAtomic, readJson, hashFile } from './lib/persistence.mjs'
import { readRunnerState, listRunnerStates, classifyDefineState } from './lib/runner-state.mjs'
import { runResponder } from './lib/responder.mjs'
import { ingestDefineMetrics, effectiveDefineInvocations } from './lib/runner-metrics.mjs'
import { collectArtifacts } from './lib/collection.mjs'
import { AUTOMATED_PHASES, runPhases } from './lib/phases.mjs'
import { failureOutcome } from './lib/outcomes.mjs'
export const DEFAULT_TIME_LIMIT_MS = 3 * 60 * 60 * 1000
export function identityMismatches(recorded, current, path = '') {
  if (hashJson(recorded) === hashJson(current)) return []
  if (!recorded || !current || typeof recorded !== 'object' || typeof current !== 'object') return [path]
  return [...new Set([...Object.keys(recorded), ...Object.keys(current)])].flatMap(key => identityMismatches(recorded[key] ?? null, current[key] ?? null, path ? `${path}.${key}` : key))
}
async function privatePath(path, boundary = dirname(resolve(path))) {
  // Inspect every existing component before mkdir or reading untrusted state.
  for (let probe = resolve(path); ; probe = dirname(probe)) {
    const stat = await lstat(probe).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (stat?.isSymbolicLink()) throw new Error(`run path refuses symlink: ${probe}`)
    if (probe === resolve(boundary) || probe === dirname(probe)) break
  }
}
async function checkSandboxInputs({ sandbox, plan, inputDir, runnerDir, skillsDir, credentials }) {
  verifyMountPlan(plan.output, { inputDir, artifactDir: sandbox.artifactDir, runnerDir, skillsDir, credentialFiles: credentials })
  const matches = await scanCanaries({ stagedDir: inputDir, skillsDir, credentialFiles: credentials })
  if (matches.length) throw new Error(`canary check failed: ${matches.map(match => `${match.file} (${match.pattern})`).join(', ')}`)
}
function workflowError(reason, { step = null, resumable = true } = {}) {
  return Object.assign(new Error(reason), { workflow: true, step, resumable })
}
async function acquireLock(runDir) {
  const path = join(runDir, '.controller.lock')
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); await handle.close()
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const lock = await readJson(path)
    try { process.kill(lock.pid, 0); throw new Error(`evaluation controller is active (PID ${lock.pid})`) }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe }
    await unlink(path); return acquireLock(runDir)
  }
  return () => unlink(path)
}
export async function runEvaluation(options, dependencies = {}) {
  const runDir = resolve(options.runDir)
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS
  const statePath = join(runDir, 'run-state.json')
  const inputDir = join(runDir, 'sandbox-input')
  const sandbox = dependencies.sandbox ?? new LocalSandbox({ ...options, runDir })
  const inspect = dependencies.inspect ?? inspectInputs
  const safetyCheck = dependencies.checkSandboxInputs ?? checkSandboxInputs
  const respond = dependencies.respond ?? runResponder
  let checkpoint; let phase = 'preflight'; let result; let release; let writable = false; let runnerState = null
  const persist = () => saveCheckpoint(statePath, checkpoint)
  const provenance = () => ({ ...checkpoint.identity, materialization: checkpoint.materialization ?? null, schema_version: checkpoint.schema_version })
  async function readState() {
    try {
      const root = join(sandbox.artifactDir, '.runtime/agent-runner-projects')
      await privatePath(root, runDir)
      const states = await listRunnerStates(root)
      if (states.length > 1) throw new Error('multiple Agent Runner runs found; refusing to select or start a duplicate')
      if (checkpoint.runner_run_id && states.length && states[0].run_id !== checkpoint.runner_run_id) throw new Error('Agent Runner run identity mismatch')
      const state = await readRunnerState(root, checkpoint.runner_run_id)
      if (state && state.workflow_name !== 'openspec:change') throw new Error(`unexpected Agent Runner workflow ${state.workflow_name}`)
      return state
    } catch (error) {
      // Persisted files can be unavailable or incomplete after interruption.
      // Retrying only re-reads them; dispatch still requires one valid, inactive
      // Runner identity and never falls back to a second fresh run.
      if (checkpoint.workflow_started_at && (error instanceof SyntaxError || ['ENOENT', 'EIO', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE', 'ESTALE', 'EINTR'].includes(error.code))) error.resumable = true
      throw error
    }
  }
  async function saveWorkflow(state, outcome) {
    checkpoint.runner_run_id = state.run_id
    checkpoint.workflow_outcome = outcome
    const evidence = []
    for (const name of ['state.json', 'audit.log', 'run-metrics.json']) {
      const path = join(state.session_dir, name)
      if (await hashFile(path)) evidence.push(...await sandbox.retrieve([path.slice(sandbox.artifactDir.length + 1)]))
    }
    // Effective dispatch identity is retained now; cost ingestion remains a later phase.
    const metrics = await readJson(join(state.session_dir, 'run-metrics.json'), null)
    const effective = effectiveDefineInvocations(metrics)
    checkpoint.effective_invocations = effective
    const path = join(runDir, 'phases/workflow.json')
    await writeJsonAtomic(path, { runner_run_id: state.run_id, outcome, configured_profiles: options.profiles, effective_invocations: effective, evidence })
    await persist()
    return [path, ...evidence]
  }
  const handlers = {
    preflight: async () => {
      validateProfiles(options.profiles)
      if (!Number.isFinite(timeLimitMs) || timeLimitMs <= 0) throw new Error('time-limit must be positive')
      const inspected = await inspect({ ...options, dryRun: options.dryRun ?? false })
      const identity = { series_identity: inspected.seriesIdentity, candidate: inspected.candidate, run_directory: runDir, time_limit_ms: timeLimitMs }
      if (options.resume) {
        checkpoint = await loadCheckpoint(statePath)
        if (!checkpoint) throw new Error('resume requires run-state.json in the exact existing run directory')
        const mismatch = identityMismatches(checkpoint.identity, identity)
        if (mismatch.length) throw new Error(`resume identity mismatch: ${mismatch.join(', ')}`)
      } else checkpoint = createCheckpoint({ run_id: randomUUID(), identity })
      checkpoint = beginUnit(checkpoint, { phase: 'preflight', unit: 'phase', inputs: identity, dependencies: {} })
      await persist()
      const materializationDir = join(runDir, '.materialization')
      const runtimeStage = join(runDir, '.sandbox-input-staging')
      await privatePath(materializationDir); await privatePath(runtimeStage)
      await rm(materializationDir, { recursive: true, force: true })
      await rm(runtimeStage, { recursive: true, force: true })
      const staged = await materialize(materializationDir)
      try {
        await stageRuntime({ inputDir: runtimeStage, bundlePath: staged.bundlePath, profiles: options.profiles })
        if (await lstat(inputDir).catch(() => null)) {
          for (const path of await filesUnder(runtimeStage)) {
            const name = path.slice(runtimeStage.length + 1)
            if (await hashFile(join(inputDir, name)) !== await hashFile(path)) throw new Error(`pinned sandbox input hash mismatch: ${name}`)
          }
        } else await rename(runtimeStage, inputDir)
        checkpoint.materialization = { commit: staged.commit, tree_hash: staged.treeHash }
      } finally {
        await rm(materializationDir, { recursive: true, force: true })
        await rm(runtimeStage, { recursive: true, force: true })
      }
      await sandbox.stage(inputDir)
      const plan = await sandbox.plan(options.profiles, { kind: 'fresh' })
      await safetyCheck({ sandbox, plan, inputDir, ...options, credentials: inspected.credentials })
      checkpoint.plan = plan
      const path = join(runDir, 'phases/preflight.json')
      await writeJsonAtomic(path, { series_identity: inspected.seriesIdentity, candidate: inspected.candidate, planned_invocation: plan, checks: ['profiles', 'Runner capabilities', 'workflow steps', 'skills', 'auth', 'pins', 'inventory', 'mounts', 'canaries'], image_canary_scan: 'not performed: Runner image contains generic tooling' })
      await persist()
      return [path]
    },
    materialization: async () => {
      const path = join(runDir, 'phases/materialization.json')
      await writeJsonAtomic(path, checkpoint.materialization)
      return [path, ...await filesUnder(inputDir)]
    },
    'define-workflow': async () => {
      if (await sandbox.isActive()) throw new Error('Agent Runner sandbox is still active; refusing a duplicate or concurrent resume')
      runnerState = await readState()
      const existing = classifyDefineState(runnerState)
      if (existing.kind === 'capped') return saveWorkflow(runnerState, existing)
      if (checkpoint.workflow_started_at && !runnerState) throw new Error('unfinished workflow has no recoverable Runner state; refusing to start a duplicate run')
      if (!checkpoint.workflow_started_at) {
        checkpoint.workflow_started_at = new Date().toISOString()
        checkpoint.workflow_deadline = Date.now() + timeLimitMs
      }
      await persist()
      if (Date.now() >= checkpoint.workflow_deadline) throw workflowError(`elapsed-time limit reached (${timeLimitMs}ms)`, { step: existing.step, resumable: false })
      if (runnerState) checkpoint.runner_run_id = runnerState.run_id
      await persist()
      const mode = runnerState ? { kind: 'resume', runId: runnerState.run_id } : { kind: 'fresh' }
      const abort = new AbortController()
      let timer; let timedOut = false; let interrupted = false; let stopped = false
      const stopSandbox = async () => { if (!stopped) { stopped = true; await sandbox.stop() } }
      const interrupt = () => { interrupted = true; abort.abort(); void stopSandbox() }
      dependencies.signal?.addEventListener('abort', interrupt, { once: true })
      let responderPromise
      try {
        if (dependencies.signal?.aborted) throw workflowError('controller interrupted', { step: existing.step })
        await sandbox.start(options.profiles, mode)
        responderPromise = respond({ runDir, exchangeDir: sandbox.exchangeDir, deadline: checkpoint.workflow_deadline, runnerRunId: checkpoint.runner_run_id, signal: abort.signal,
          onExchangeDurable: async exchange => {
            if (checkpoint.runner_run_id && checkpoint.runner_run_id !== exchange.run_id) throw new Error('Runner exchange run identity mismatch')
            checkpoint.runner_run_id = exchange.run_id; checkpoint.last_active_step = exchange.step; await persist()
          } }).catch(error => ({ status: 'evaluation-harness-failed', reason: error.message }))
        const elapsed = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve({ type: 'deadline' }) }, Math.max(0, checkpoint.workflow_deadline - Date.now())) })
        const finished = await Promise.race([sandbox.wait().then(exit => ({ type: 'exit', exit })), responderPromise.then(response => ({ type: 'responder', response })), elapsed])
        if (finished.type !== 'exit') {
          // Give the responder a chance to publish an abort for a pending request.
          if (finished.type === 'deadline') {
            let grace
            try { await Promise.race([responderPromise, new Promise(resolve => { grace = setTimeout(resolve, 300) })]) } finally { clearTimeout(grace) }
          }
          await stopSandbox()
        }
        abort.abort()
        const response = await responderPromise
        const exit = await sandbox.wait()
        runnerState = await readState()
        const outcome = classifyDefineState(runnerState)
        if (runnerState) await saveWorkflow(runnerState, outcome)
        const step = response.last_active_step ?? outcome.step ?? checkpoint.last_active_step
        if (timedOut || response.status === 'elapsed-time-limit') throw workflowError(`elapsed-time limit reached (${timeLimitMs}ms)`, { step, resumable: false })
        if (response.status === 'evaluation-harness-failed') throw Object.assign(new Error(response.reason), { resumable: true, step })
        if (interrupted) throw workflowError('controller interrupted', { step })
        if (outcome.kind !== 'capped' || exit.code !== 0) throw workflowError(outcome.reason ?? `Runner exited ${exit.code ?? exit.signal}`, { step, resumable: !!runnerState })
        return [join(runDir, 'phases/workflow.json'), ...await filesUnder(join(runDir, 'evidence'))]
      } finally {
        clearTimeout(timer); abort.abort(); dependencies.signal?.removeEventListener('abort', interrupt)
        await stopSandbox()
        if (responderPromise) await responderPromise
      }
    },
    'artifact-collection': async () => {
      await privatePath(join(sandbox.artifactDir, 'workspace/repo/openspec/changes/add-presentation-skill'), runDir)
      const manifest = await collectArtifacts({ repoDir: join(sandbox.artifactDir, 'workspace/repo'), runDir })
      checkpoint.collection = manifest
      await persist()
      return [join(runDir, 'phases/collection.json'), ...await filesUnder(join(runDir, 'collected'))]
    },
    // Registered now, but ordered after discovery: unavailable predecessors block it.
    metrics: async () => {
      const workflow = await readJson(join(runDir, 'phases/workflow.json'))
      const path = workflow.evidence.find(path => path.endsWith('/run-metrics.json'))
      const text = path ? await readFile(path, 'utf8') : null
      const metrics = ingestDefineMetrics({ text, runId: checkpoint.runner_run_id, path })
      const target = join(runDir, 'phases/workflow-metrics.json')
      await writeJsonAtomic(target, metrics)
      return [target]
    },
    ...dependencies.handlers,
  }
  try {
    await privatePath(runDir)
    if (!options.resume && await lstat(runDir).catch(() => null)) throw new Error('run directory is already used; use --resume with its exact path')
    if (options.resume && !await lstat(runDir).catch(() => null)) throw new Error('resume run directory does not exist')
    await mkdir(runDir, { recursive: true }); release = await acquireLock(runDir); writable = true
    for (const path of ['phases', 'logs', 'sandbox-input', 'sandbox/exchange', 'sandbox/workspace/repo', 'sandbox/.runtime', 'evidence', 'collected']) await privatePath(join(runDir, path), runDir)
    await mkdir(join(runDir, 'phases'), { recursive: true }); await mkdir(join(runDir, 'logs'), { recursive: true })
    if (options.dryRun) {
      const outputs = await handlers.preflight()
      checkpoint = await completeUnit(checkpoint, { phase: 'preflight', unit: 'phase', inputs: provenance(), dependencies: {}, outputs })
      await persist()
      result = { ...failureOutcome({ phase: 'define-workflow', reason: 'dry-run: workflow was not started' }), dry_run: true }
    } else {
      const lifecycle = await runPhases({ handlers, execute: async (name, handler) => {
        phase = name
        const inputs = checkpoint ? provenance() : {}
        const dependencies = name === 'preflight' ? {} : { predecessor: AUTOMATED_PHASES[AUTOMATED_PHASES.indexOf(name) - 1], materialization: checkpoint.materialization ?? null }
        if (!['preflight', 'define-workflow'].includes(name) && (await verifyUnit(checkpoint, { phase: name, unit: 'phase', inputs, dependencies })).reusable) return
        if (checkpoint) { checkpoint = beginUnit(checkpoint, { phase: name, unit: 'phase', inputs, dependencies }); await persist() }
        const outputs = await handler()
        checkpoint = await completeUnit(checkpoint, { phase: name, unit: 'phase', inputs: provenance(), dependencies, outputs })
        await persist()
      } })
      result = lifecycle.blocked ? { ...failureOutcome({ phase: lifecycle.blocked, reason: `phases not yet implemented: ${lifecycle.missing.join(', ')}`, resumable: true }), unimplemented_phases: lifecycle.missing }
        : { evaluation_status: 'complete', definition_verdict: checkpoint.definition_verdict ?? 'unavailable', resumable: false }
    }
  } catch (error) {
    result = failureOutcome({ phase, reason: error.message, workflow: error.workflow ?? false, resumable: error.resumable ?? false, step: error.step ?? null, timeLimitMs: timeLimitMs })
    if (checkpoint && writable) {
      checkpoint = failUnit(checkpoint, { phase, unit: 'phase', error: error.message })
      await persist()
    }
  } finally {
    if (writable && result) {
      result = { ...result, run_id: checkpoint?.run_id ?? null, series_identity: checkpoint?.series_identity ?? null, candidate: checkpoint?.candidate ?? null, configured_profiles: checkpoint?.candidate?.profiles ?? options.profiles, effective_invocations: checkpoint?.effective_invocations ?? [], runner_run_id: checkpoint?.runner_run_id ?? null }
      await writeJsonAtomic(join(runDir, 'result.json'), result)
    }
    if (release) await release()
  }
  return { result, exitCode: options.dryRun && result.dry_run ? 0 : result.evaluation_status === 'complete' ? 0 : 1, plan: checkpoint?.plan }
}
export function parseTimeLimit(value) {
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  const number = match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? 's']) : NaN
  if (!Number.isFinite(number) || number <= 0 || number > 2147483647) throw new Error('time-limit must be a positive duration (for example 3h, 30m, or 60s) below 25 days')
  return number
}
export const HELP = `Usage: evals/agent-runner/and-scene-define/run.sh MODE [options]
Modes:
  --help                    Show all modes and options.
  --dry-run                 Print the full sandbox plan; no containers or model calls.
  --run-agent               Run the paid candidate workflow through define.
  --resume                  Reuse --run-dir and resume its inactive unfinished Runner run.
  --rescore-from RUN_DIR     Evaluator-only rescore (implemented by a later task).
  --calibrate               Maintainer rubric diagnostic (implemented by a later task).
Options:
  --run-dir PATH            Artifact directory; required for --resume, otherwise generated.
  --runner-dir PATH         Runner checkout (or AGENT_RUNNER_DIR).
  --skills-dir PATH         Clean Agent Skills checkout (or AGENT_SKILLS_DIR).
  --lead-cli CLI            claude or codex (required).
  --lead-model MODEL        Lead model (required).
  --lead-effort EFFORT      Lead effort (required).
  --crosscheck-cli CLI      claude, codex, or cursor (required).
  --crosscheck-model MODEL  Crosscheck model (required).
  --crosscheck-effort EFFORT Crosscheck effort (required).
  --time-limit DURATION     One elapsed-time limit, default 3h; unchanged on resume.
Pinned simulated-user and judge profiles cannot be overridden.
Later audit and scoring phases are not implemented: candidates stop after collection.
`
export function parseArguments(args, env = process.env) {
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  const options = { profiles: { lead: {}, crosscheck: {} }, runnerDir: env.AGENT_RUNNER_DIR ?? '/Users/paul/codagent/agent-runner/worktrees/external-user-mode', skillsDir: env.AGENT_SKILLS_DIR ?? '/Users/paul/codagent/agent-skills', timeLimitMs: DEFAULT_TIME_LIMIT_MS }
  let mode
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (['--dry-run', '--run-agent', '--resume', '--calibrate', '--rescore-from'].includes(arg)) {
      if (mode) throw new Error('select exactly one mode')
      mode = arg
      if (['--calibrate', '--rescore-from'].includes(arg)) throw new Error(`${arg} is not yet implemented`)
      continue
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    const profile = arg.match(/^--(lead|crosscheck)-(cli|model|effort)$/)
    if (profile) options.profiles[profile[1]][profile[2]] = value
    else if (arg === '--run-dir') options.runDir = resolve(value)
    else if (arg === '--runner-dir') options.runnerDir = resolve(value)
    else if (arg === '--skills-dir') options.skillsDir = resolve(value)
    else if (arg === '--time-limit') options.timeLimitMs = parseTimeLimit(value)
    else throw new Error(`unknown option ${arg}`)
  }
  if (!mode) throw new Error('select --dry-run, --run-agent, or --resume')
  if (mode === '--resume' && !options.runDir) throw new Error('--resume requires --run-dir')
  options.runDir ??= resolve('artifacts/and-scene-define', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  return { ...options, dryRun: mode === '--dry-run', resume: mode === '--resume' }
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
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
