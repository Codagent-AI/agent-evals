#!/usr/bin/env node
// The and-scene evaluation controller.
//
// `run.sh` remains the thin host launcher; this module owns the evaluation
// state machine: preflight, role configuration, Agent Runner run identity and
// resumption, durable checkpoints, and the ordered phase lifecycle.
//
// Phases owned by later tasks (product judging, ambiguity diagnostics, pricing,
// human review, reporting) are registered here as explicit placeholders so the
// ordering, checkpointing, and outcome contracts can be exercised now and the
// handlers replaced without touching the lifecycle.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  validateCheckpointIdentity,
} from './lib/checkpoint.mjs'
import { applyOutcomeEvent, createOutcome, outcomeLabel } from './lib/outcomes.mjs'
import { AUTOMATED_PHASES, runPhases } from './lib/phases.mjs'
import { hashJson, readJson, writeJsonAtomic } from './lib/persistence.mjs'
import {
  compareRoleSelections,
  reconcileRoleAttempts,
  renderEvalConfig,
  validateRoleProfiles,
} from './lib/profiles.mjs'
import { compareProvenance, readWorkflowProvenance } from './lib/provenance.mjs'
import { runTimed, summarizeTimings } from './lib/subprocess.mjs'
import {
  checkBoundary,
  classifyRunnerRun,
  parseWorkflowContract,
  resolveBoundary,
  verifyWorkflowContract,
} from './lib/workflow.mjs'

const SUITE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CAPABILITIES = join(SUITE_DIR, 'agent-runner-capabilities.json')

export const RESULT_SCHEMA_VERSION = 1

const FLAGS = new Map([
  ['--skip-validator', 'skipValidator'],
  ['--resume', 'resume'],
  ['--reference-baseline', 'referenceBaseline'],
])
const VALUES = new Map([
  ['--run-dir', 'runDir'],
  ['--agent-runner-dir', 'agentRunnerDir'],
  ['--change-name', 'changeName'],
  ['--fixture-ref', 'fixtureRef'],
  ['--candidate-ref', 'candidateRef'],
  ['--judge-model', 'judgeModel'],
  ['--capabilities', 'capabilitiesPath'],
  ['--lead-cli', 'leadCli'],
  ['--lead-model', 'leadModel'],
  ['--lead-effort', 'leadEffort'],
  ['--implementor-cli', 'implementorCli'],
  ['--implementor-model', 'implementorModel'],
  ['--implementor-effort', 'implementorEffort'],
])

export function parseArgs(argv) {
  const options = {
    skipValidator: false,
    resume: false,
    referenceBaseline: false,
    changeName: 'create-and-scene',
    judgeModel: 'codex-default',
    capabilitiesPath: DEFAULT_CAPABILITIES,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (FLAGS.has(argument)) {
      options[FLAGS.get(argument)] = true
      continue
    }
    const key = VALUES.get(argument)
    if (!key) throw new Error(`unknown controller option: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`missing value for ${argument}`)
    options[key] = value
    index += 1
  }
  if (!options.runDir) throw new Error('--run-dir is required')
  return options
}

function roleProfileFrom(options, role) {
  const cli = options[`${role}Cli`]
  const model = options[`${role}Model`]
  const effort = options[`${role}Effort`]
  return cli || model || effort ? { cli, model, effort } : null
}

async function prepareRunDirectory(runDir) {
  for (const relative of [
    'logs',
    'evidence',
    'phases',
    // Persistent across disposable containers; credentials stay in the
    // ephemeral container home and are never copied here.
    '.runtime/candidate-worktree',
    '.runtime/agent-runner-projects',
    '.runtime/agent-runner-config',
  ]) {
    await mkdir(join(runDir, relative), { recursive: true })
  }
}

// Agent Runner owns its run state; the controller only reads it to decide
// whether to start, wait for, resume, or continue past the recorded run.
async function defaultReadRunnerState(runDir) {
  const projects = join(runDir, '.runtime/agent-runner-projects')
  let newest = null
  const visit = async (dir, depth) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (depth === 0) {
        const state = await readJson(join(path, 'state.json'), null)
        if (state) newest = state
        continue
      }
      await visit(path, depth - 1)
    }
  }
  // <projects>/<project>/runs/<run-id>/state.json
  await visit(projects, 2)
  return newest
}

function failure(errors) {
  return { exitCode: 2, errors, outcome: null }
}

export async function runEvaluation({
  argv,
  exec,
  isProcessAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
  readRunnerState,
  observedSteps,
  waitForRun = () => {},
  handlers: handlerOverrides = {},
  log = () => {},
}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    return failure([{ code: 'invalid-arguments', message: error.message }])
  }

  const runDir = resolve(options.runDir)
  const runId = basename(runDir)
  const mode = options.referenceBaseline ? 'reference-baseline' : 'agent-runner'

  let capabilities
  try {
    capabilities = await readJson(options.capabilitiesPath)
  } catch (error) {
    return failure([{
      code: 'invalid-capabilities',
      message: `cannot read role capabilities from ${options.capabilitiesPath}: ${error.message}`,
    }])
  }

  const validation = validateRoleProfiles({
    lead: roleProfileFrom(options, 'lead'),
    implementor: roleProfileFrom(options, 'implementor'),
    capabilities,
    mode,
  })
  if (!validation.ok) {
    return failure(validation.errors.map((error) => ({ code: 'invalid-role-profile', ...error })))
  }

  const boundary = resolveBoundary({ skipValidator: options.skipValidator, changeName: options.changeName })

  // A reference baseline evaluates an existing candidate without invoking Agent
  // Runner, so it needs no clean checkout or workflow contract.
  let provenance = null
  let workflowText = ''
  if (mode === 'agent-runner') {
    if (!options.agentRunnerDir) {
      return failure([{ code: 'invalid-arguments', message: '--agent-runner-dir is required' }])
    }
    try {
      provenance = await readWorkflowProvenance({ agentRunnerDir: resolve(options.agentRunnerDir), exec })
    } catch (error) {
      return failure([{ code: error.code ?? 'provenance-error', message: error.message }])
    }
    workflowText = await readFile(provenance.workflow_path, 'utf8')
    const contract = verifyWorkflowContract(workflowText, boundary)
    if (!contract.ok) {
      return failure(contract.errors.map((message) => ({ code: 'workflow-contract', message })))
    }
  }

  const identity = {
    candidate_identity: options.candidateRef ?? null,
    fixture_revision: options.fixtureRef ?? null,
    agent_runner_provenance: hashJson({
      commit: provenance?.commit ?? null,
      workflow_sha256: provenance?.workflow_sha256 ?? null,
      cli_version: provenance?.cli_version ?? null,
    }),
    workflow_arguments: hashJson(boundary.workflow_arguments),
    agent_configuration: hashJson(validation.profiles),
    evaluator_configuration: options.judgeModel,
    // Owned by the product-scoring task; recorded here so resume already
    // rejects a rubric change.
    rubric_provenance: null,
  }

  await prepareRunDirectory(runDir)
  const checkpointPath = join(runDir, 'checkpoint.json')

  let checkpoint
  try {
    checkpoint = await loadCheckpoint(checkpointPath)
  } catch (error) {
    return failure([{ code: 'checkpoint-schema', message: error.message }])
  }

  if (checkpoint) {
    const roleMismatches = compareRoleSelections(checkpoint.role_profiles, validation.profiles)
    if (roleMismatches.length > 0) {
      return failure(roleMismatches.map((mismatch) => ({ code: 'role-profile-mismatch', ...mismatch })))
    }
    if (provenance && checkpoint.agent_runner_provenance) {
      const drift = compareProvenance(checkpoint.agent_runner_provenance, provenance)
      if (drift.length > 0) {
        return failure(drift.map((mismatch) => ({ code: 'resume-provenance', ...mismatch })))
      }
    }
    const stale = validateCheckpointIdentity(checkpoint, identity)
    if (stale.length > 0) {
      return failure(stale.map((mismatch) => ({ code: 'stale-checkpoint', ...mismatch })))
    }
  } else {
    checkpoint = {
      ...createCheckpoint({ run_id: runId, identity }),
      role_profiles: validation.profiles,
      agent_runner_provenance: provenance,
      boundary,
      agent_runner: null,
    }
    await saveCheckpoint(checkpointPath, checkpoint)
  }

  // The evaluation profile lives only in the run directory; the user's global
  // and project Agent Runner configuration is never read or modified.
  if (mode === 'agent-runner') {
    await writeFile(
      join(runDir, '.runtime/agent-runner-config/config.yaml'),
      renderEvalConfig(validation.profiles),
    )
  }

  const record = {
    boundary: { ok: true, unexpected_step: null, last_observed_step: null },
    observed_steps: [],
    events: [],
    run: checkpoint.agent_runner,
    timings: [],
  }
  const readState = readRunnerState ?? (() => defaultReadRunnerState(runDir))
  const readSteps = observedSteps ?? ((state) => state?.steps ?? [])

  const handlers = {
    'agent-runner': async () => {
      if (mode === 'reference-baseline') {
        record.events.push({ event: 'skipped', reason: 'reference-baseline' })
        return
      }

      const decision = classifyRunnerRun({
        recorded: checkpoint.agent_runner,
        state: await readState(),
        boundaryStep: boundary.stop_step,
        isProcessAlive,
      })
      record.events.push({ event: decision.action, status: decision.status, reason: decision.reason })
      log(`agent-runner: ${decision.action}`)

      if (decision.action === 'error') throw new Error(decision.reason)

      if (decision.action === 'start') {
        const timing = runTimed('agent-runner', [
          'run', provenance.workflow_path,
          '--until', boundary.stop_step,
          ...boundary.workflow_arguments,
        ], { label: 'agent-runner', exec })
        record.timings.push(timing)
        if (!timing.ok) throw new Error(`agent-runner exited ${timing.status}`)
      } else if (decision.action === 'resume') {
        const [command, ...args] = decision.command
        const timing = runTimed(command, args, { label: 'agent-runner-resume', exec })
        record.timings.push(timing)
        if (!timing.ok) throw new Error(`agent-runner resume exited ${timing.status}`)
      } else if (decision.action === 'wait') {
        await waitForRun(decision.run_id)
      }

      // Record the run identity durably as soon as it becomes available so a
      // restarted outer process never launches a duplicate implementation run.
      const state = await readState()
      if (state?.run_id) {
        record.run = { run_id: state.run_id, session_dir: state.session_dir ?? null }
        checkpoint = { ...checkpoint, agent_runner: record.run }
        await saveCheckpoint(checkpointPath, checkpoint)
      }

      record.observed_steps = await readSteps(state)
      record.boundary = checkBoundary({
        boundaryStep: boundary.stop_step,
        workflowSteps: parseWorkflowContract(workflowText).steps,
        observedSteps: record.observed_steps,
      })
      if (!record.boundary.ok) {
        throw new Error(
          `workflow boundary violated: ${record.boundary.unexpected_step} executed after ${boundary.stop_step}`,
        )
      }
    },

    // Placeholders owned by tasks 02-04. They keep the lifecycle honest about
    // ordering and server dependency without claiming work they do not do.
    verification: async () => {},
    'candidate-server': async (context) => { context.serverRunning = true },
    'browser-evaluation': async () => {},
    'product-judging': async () => {},
    'ambiguity-diagnostics': async () => {},
    'metrics-pricing': async () => {},

    'pending-result': async (context) => { await writeResult(context.outcome) },
    cleanup: async (context) => { context.serverRunning = false },
    'cleanup-result': async (context) => { await writeResult(context.outcome) },

    ...handlerOverrides,
  }

  async function writeResult(outcome) {
    await writeJsonAtomic(join(runDir, 'result.json'), {
      schema_version: RESULT_SCHEMA_VERSION,
      run_id: runId,
      mode,
      evaluation_status: outcome.evaluation_status,
      product_verdict: outcome.product_verdict,
      official_score: outcome.official_score,
      automated_subtotal: outcome.automated_subtotal,
      label: outcomeLabel(outcome),
      failed_phase: outcome.failed_phase,
      failure: outcome.failure,
      resumable: outcome.resumable,
      cleanup: outcome.cleanup,
      history: outcome.history,
      workflow: {
        workflow: boundary.workflow,
        skip_validator: boundary.skip_validator,
        arguments: boundary.workflow_arguments,
        configured_stop_step: boundary.stop_step,
        last_observed_step: record.boundary.last_observed_step,
        unexpected_step: record.boundary.unexpected_step,
        observed_steps: record.observed_steps,
        run_id: record.run?.run_id ?? null,
        session_dir: record.run?.session_dir ?? null,
        provenance,
        events: record.events,
      },
      role_configuration: reconcileRoleAttempts(validation.profiles, []),
      timings: summarizeTimings(record.timings),
    })
  }

  const completedPhases = new Set(
    Object.entries(checkpoint.phases ?? {})
      .filter(([, phase]) => phase.state === 'complete')
      .map(([name]) => name),
  )

  // Record phase completion durably as each phase finishes, so an interrupted
  // run resumes at the first incomplete phase instead of repeating valid work.
  const tracked = {}
  for (const phase of AUTOMATED_PHASES) {
    const handler = handlers[phase.name]
    if (!handler) continue
    tracked[phase.name] = async (context) => {
      await handler(context)
      checkpoint = {
        ...checkpoint,
        phases: {
          ...checkpoint.phases,
          [phase.name]: {
            ...(checkpoint.phases?.[phase.name] ?? { units: {} }),
            state: 'complete',
            completed_at: new Date().toISOString(),
          },
        },
      }
      await saveCheckpoint(checkpointPath, checkpoint)
    }
  }

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: tracked,
    outcome: createOutcome(),
    isComplete: (name) => completedPhases.has(name),
  })

  return { ...result, errors: [], runDir, runId, boundary, provenance, profiles: validation.profiles }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runEvaluation({ argv: process.argv.slice(2), log: (line) => console.error(line) })
  for (const error of result.errors ?? []) console.error(JSON.stringify(error))
  process.exit(result.exitCode)
}
