#!/usr/bin/env node
// The and-scene evaluation controller.
//
// `run.sh` remains the thin host launcher; this module owns the evaluation
// state machine: preflight, role configuration, Agent Runner run identity and
// resumption, durable checkpoints, and the ordered phase lifecycle.
//
// The command deliberately stops at `pending-human-review`: it writes the
// automated result, its report, and the artifact manifest, attempts
// candidate-server cleanup, and exits successfully. The literal human review
// that turns that into an official score lives in `human-review.mjs`, because it
// runs on human time and must never cost the completed automated work.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectAmbiguityArtifacts,
  runAmbiguityDiagnostics,
} from './lib/ambiguity.mjs'
import {
  beginUnit,
  completeUnit,
  createCheckpoint,
  failUnit,
  loadCheckpoint,
  saveCheckpoint,
  validateCheckpointIdentity,
  verifyUnit,
} from './lib/checkpoint.mjs'
import {
  freezeCandidate,
  prepareCandidateRescoreWorktree,
  prepareCandidateWorktree,
  verifyCandidateDelivery,
  verifyRecordedDeliveryIdentity,
} from './lib/candidate.mjs'
import { loadCandidateRescoreSource } from './lib/rescore.mjs'
import { runCandidateVerification } from './lib/candidate-verification.mjs'
import { createHostCandidateServer } from './lib/candidate-server-host.mjs'
import { aggregateImplementationCost, summarizeEvalOwnedUsage } from './lib/cost.mjs'
import { fetchPricingCatalog, needsPricingLookup, resolveImplementationPricing } from './lib/pricing.mjs'
import { readRunnerMetrics } from './lib/runner-metrics.mjs'
import {
  createTimingLedger,
  mergeTimingLedgers,
  recordMachineInterval,
  summarizeMachineTiming,
} from './lib/timing.mjs'
import { collectSourceEvidence } from './deterministic-checks.mjs'
import { runBrowserEvaluation } from './lib/browser-eval.mjs'
import { createAxiBrowserDriver } from './lib/axi-browser-driver.mjs'
import { ensureCandidateServer, stopCandidateServer } from './lib/candidate-server.mjs'
import {
  assembleResult,
  readEvidenceProjectionInputs,
  writeResultArtifacts,
} from './lib/result.mjs'
import { createCodexJudgeInvoker } from './lib/judge-invoker.mjs'
import { runProductJudging } from './lib/judge-jobs.mjs'
import {
  buildCandidateEvidenceManifest,
  buildEvaluatorEvidenceManifest,
  detectEvidenceContradictions,
  materializeEvidenceJudgeViews,
  recordEvidenceContradictions,
  validateCandidateEvidenceLineage,
} from './lib/evidence.mjs'
import { materializeNeutralInputs } from './lib/neutral-source.mjs'
import { applyOutcomeEvent, createOutcome } from './lib/outcomes.mjs'
import { applyRunStateEvent } from './lib/state-machine.mjs'
import { loadRubrics, rubricProvenance } from './lib/rubric.mjs'
import { scoreProduct } from './lib/scorer.mjs'
import { AUTOMATED_PHASES, runPhases } from './lib/phases.mjs'
import { hashFile, hashJson, hashString, readJson, writeJsonAtomic } from './lib/persistence.mjs'
import {
  compareRoleSelections,
  reconcileRoleAttempts,
  renderEvalConfig,
  renderEvalSettings,
  validateRoleProfiles,
} from './lib/profiles.mjs'
import {
  compareAgentSkillsProvenance,
  compareProvenance,
  readAgentSkillsProvenance,
  readWorkflowProvenance,
} from './lib/provenance.mjs'
import {
  isAgentRunnerProcessAlive,
  readRunnerState as readPersistedRunnerState,
  resolveProjectsDir,
  waitForRunnerRun,
} from './lib/runner-state.mjs'
import { runTimed, summarizeTimings } from './lib/subprocess.mjs'
import {
  checkWorkflowHistory,
  classifyRunnerRun,
  IMPLEMENTATION_WORKFLOW_INSPECTION_REF,
  IMPLEMENTATION_WORKFLOW_LOGICAL_NAME,
  resolveBoundary,
  verifyWorkflowContract,
} from './lib/workflow.mjs'

const SUITE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CAPABILITIES = join(SUITE_DIR, 'agent-runner-capabilities.json')
const BROWSER_EVALUATOR_FILES = [
  'lib/browser-eval.mjs',
  'lib/axi-browser-driver.mjs',
  'lib/browser-diagnostics.mjs',
  'lib/demo-contract.mjs',
]
const GITHUB_WRITE_PERMISSIONS = new Set(['WRITE', 'MAINTAIN', 'ADMIN'])

const FLAGS = new Map([
  ['--skip-validator', 'skipValidator'],
  ['--resume', 'resume'],
  ['--reference-baseline', 'referenceBaseline'],
])
const VALUES = new Map([
  ['--run-dir', 'runDir'],
  ['--run-id', 'runId'],
  ['--repo', 'repo'],
  ['--agent-runner-dir', 'agentRunnerDir'],
  ['--agent-skills-dir', 'agentSkillsDir'],
  ['--change-name', 'changeName'],
  ['--fixture-ref', 'fixtureRef'],
  ['--candidate-ref', 'candidateRef'],
  ['--rescore-from', 'rescoreFrom'],
  ['--judge-model', 'judgeModel'],
  ['--capabilities', 'capabilitiesPath'],
  ['--lead-cli', 'leadCli'],
  ['--lead-model', 'leadModel'],
  ['--lead-effort', 'leadEffort'],
  ['--implementor-cli', 'implementorCli'],
  ['--implementor-model', 'implementorModel'],
  ['--implementor-effort', 'implementorEffort'],
  ['--reviewer-cli', 'reviewerCli'],
  ['--reviewer-model', 'reviewerModel'],
  ['--reviewer-effort', 'reviewerEffort'],
])

export function parseArgs(argv) {
  const options = {
    skipValidator: false,
    resume: false,
    referenceBaseline: false,
    changeName: 'create-and-scene',
    changeNameProvided: false,
    judgeModel: 'codex-default',
    repo: 'https://github.com/Codagent-AI/and-scene.git',
    fixtureRef: '892dfbcf3762bc95cdbae6f05b18cc2b168a5fab',
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
    if (key === 'changeName') options.changeNameProvided = true
    index += 1
  }
  if (!options.runDir) throw new Error('--run-dir is required')
  if (options.rescoreFrom && (options.resume || options.referenceBaseline || options.candidateRef)) {
    throw new Error(
      '--rescore-from cannot be combined with --resume, --reference-baseline, or --candidate-ref',
    )
  }
  options.runId ??= basename(resolve(options.runDir))
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.runId)) {
    throw new Error('--run-id must be a single safe path component')
  }
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
  ]) {
    await mkdir(join(runDir, relative), { recursive: true })
  }
}

function failure(errors) {
  return { exitCode: 2, errors, outcome: null }
}

function runnerFailure(timing) {
  const details = []
  if (timing.error_code) details.push(timing.error_code)
  if (timing.error) details.push(timing.error)
  if (timing.status !== null && timing.status !== undefined) details.push(`exit ${timing.status}`)
  if (timing.signal) details.push(`signal ${timing.signal}`)
  const diagnostic = details.length > 0 ? details.join(': ') : 'unknown subprocess failure'
  const output = timing.output_path ? `; output: ${timing.output_path}` : ''
  return `${timing.label} failed (${diagnostic})${output}`
}

async function fingerprintFiles(paths) {
  const hashes = await Promise.all(paths.map(async (path) => [
    path,
    await hashFile(join(SUITE_DIR, path)),
  ]))
  return hashJson(Object.fromEntries(hashes))
}

function repositoryPermissionLevel(repository, worktree, exec) {
  const permission = exec(
    'gh',
    ['repo', 'view', repository, '--json', 'viewerPermission', '--jq', '.viewerPermission'],
    { cwd: worktree },
  )
  if (permission.status !== 0 || permission.error) return ''
  return String(permission.stdout ?? '').trim().toUpperCase()
}

export async function runEvaluation({
  argv,
  exec,
  isProcessAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
  isRunnerProcessAlive = isAgentRunnerProcessAlive,
  readRunnerState,
  observedSteps,
  waitForRun = null,
  handlers: handlerOverrides = {},
  // Product evidence sources. Each is injected so the whole scored lifecycle is
  // exercisable without a browser or a model call, and so a source that is
  // absent leaves its component unobserved rather than failing the candidate.
  browserDriver = null,
  browserDriverFactory = null,
  judgeInvoke = null,
  // The candidate-server adapter. Without one the suite still reaches a durable
  // pending result; it simply has no server to hand the reviewer, and says so
  // rather than pretending it started one.
  candidateServer = null,
  verifyCandidate = null,
  verifyDelivery = null,
  verifyResumeDelivery = null,
  materializeEvidence = null,
  materializeNeutral = null,
  buildResult = null,
  verificationResult = null,
  // The live models.dev catalog. Injected so pricing is exercisable offline and
  // so a test never depends on today's published rates.
  pricingFetch = null,
  loadRescoreSource = loadCandidateRescoreSource,
  // Agent Runner resolves its run store from $HOME. The controller must read
  // the same store the spawned runner writes to, so the home is explicit and
  // is passed through to the child rather than being inherited implicitly.
  // Linking a run store into a home is also a real side effect, so library
  // callers name the home they mean instead of inheriting the ambient one.
  home = null,
  log = () => {},
}) {
  exec ??= (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options })
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    return failure([{ code: 'invalid-arguments', message: error.message }])
  }

  const runDir = resolve(options.runDir)
  const runId = options.runId
  const mode = options.referenceBaseline ? 'reference-baseline' : 'agent-runner'
  const runKind = options.referenceBaseline ? 'reference' : 'candidate'
  const rescore = Boolean(options.rescoreFrom)

  let importedRun = null
  if (rescore) {
    try {
      importedRun = await loadRescoreSource({ sourceDir: options.rescoreFrom })
    } catch (error) {
      return failure([{ code: 'invalid-rescore-source', message: error.message }])
    }
  }
  if (
    importedRun
    && options.changeNameProvided
    && options.changeName !== importedRun.change_name
  ) {
    return failure([{
      code: 'rescore-change-name-conflict',
      message: `--change-name ${options.changeName} conflicts with source change ${importedRun.change_name}`,
    }])
  }
  const changeName = importedRun?.change_name ?? options.changeName

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
    lead: importedRun?.role_profiles?.lead ?? roleProfileFrom(options, 'lead'),
    implementor: importedRun?.role_profiles?.implementor ?? roleProfileFrom(options, 'implementor'),
    reviewer: importedRun?.role_profiles?.reviewer ?? roleProfileFrom(options, 'reviewer'),
    capabilities,
    mode,
  })
  if (!validation.ok) {
    return failure(validation.errors.map((error) => ({ code: 'invalid-role-profile', ...error })))
  }

  const importedSkipValidator = importedRun?.workflow?.arguments
    ?.includes('skip_validator=true')
  const boundary = resolveBoundary({
    skipValidator: importedRun ? importedSkipValidator : options.skipValidator,
    changeName,
  })
  if (importedRun?.workflow?.arguments) {
    boundary.workflow_arguments = [...importedRun.workflow.arguments]
  }

  let rubrics
  try {
    rubrics = await loadRubrics()
  } catch (error) {
    return failure([{ code: 'invalid-rubric', message: error.message }])
  }
  const provenanceOfRubrics = rubricProvenance(rubrics)
  const browserEvaluatorFingerprint = await fingerprintFiles(BROWSER_EVALUATOR_FILES)

  // A reference baseline evaluates an existing candidate without invoking Agent
  // Runner, so it needs no clean checkout or workflow contract.
  let provenance = null
  let agentSkillsProvenance = null
  let workflowText = ''
  if (rescore) {
    provenance = importedRun.agent_runner_provenance
    agentSkillsProvenance = importedRun.agent_skills_provenance
  } else if (mode === 'agent-runner') {
    if (!options.agentRunnerDir) {
      return failure([{ code: 'invalid-arguments', message: '--agent-runner-dir is required' }])
    }
    if (!options.agentSkillsDir) {
      return failure([{ code: 'invalid-arguments', message: '--agent-skills-dir is required' }])
    }
    // Without a home the controller and Agent Runner would read and write
    // different run stores, so a run identity could be silently lost.
    if (!home) {
      return failure([{
        code: 'unresolvable-home',
        message: 'cannot resolve a home directory for Agent Runner run state; set HOME',
      }])
    }
    try {
      provenance = await readWorkflowProvenance({ agentRunnerDir: resolve(options.agentRunnerDir), exec })
      agentSkillsProvenance = await readAgentSkillsProvenance({
        agentSkillsDir: resolve(options.agentSkillsDir),
        exec,
      })
    } catch (error) {
      return failure([{ code: error.code ?? 'provenance-error', message: error.message }])
    }
    if (!agentSkillsProvenance.complete) {
      return failure([{
        code: 'agent-skills-provenance',
        message: 'Agent Skills provenance is incomplete',
      }])
    }
    workflowText = await readFile(provenance.workflow_path, 'utf8')
    const contract = verifyWorkflowContract(workflowText)
    if (!contract.ok) {
      return failure(contract.errors.map((message) => ({ code: 'workflow-contract', message })))
    }
    const credentials = exec('gh', ['auth', 'status'], { cwd: resolve(options.agentRunnerDir) })
    if (credentials.status !== 0 || credentials.error) {
      return failure([{
        code: 'publishing-credentials',
        message: 'GitHub credentials capable of pushing the candidate branch and managing its draft pull request are required',
      }])
    }
  }

  await prepareRunDirectory(runDir)
  const checkpointPath = join(runDir, 'run-state.json')
  let checkpoint
  try {
    checkpoint = await loadCheckpoint(checkpointPath)
  } catch (error) {
    return failure([{ code: 'checkpoint-schema', message: error.message }])
  }
  if (checkpoint && !options.resume) {
    return failure([{
      code: 'run-directory-collision',
      message: `run-state.json already exists for ${runId}; use --resume to continue it`,
    }])
  }
  if (!checkpoint && options.resume) {
    return failure([{
      code: 'resume-state-missing',
      message: `cannot resume ${runId}: run-state.json does not exist`,
    }])
  }

  const candidateWorktree = join(runDir, '.runtime/candidate-worktree')
  const freezeCurrentCandidate = () => freezeCandidate({
    repo: options.repo,
    worktree: candidateWorktree,
    runDir,
    fixtureRevision: importedRun?.candidate_source.fixture_commit ?? options.fixtureRef,
    exec,
  })
  const selectedCandidateRef = mode === 'reference-baseline'
    ? (options.candidateRef ?? options.fixtureRef)
    : options.fixtureRef
  let candidateSource
  try {
    candidateSource = rescore
      ? await prepareCandidateRescoreWorktree({
          repo: options.repo,
          worktree: candidateWorktree,
          source: {
            ...importedRun.candidate_source,
            final_sha: importedRun.delivery.final_sha,
          },
          exec,
        })
      : await prepareCandidateWorktree({
          repo: options.repo,
          worktree: candidateWorktree,
          ref: selectedCandidateRef,
          resume: options.resume,
          expectedSource: checkpoint?.candidate_source ?? null,
          runId,
          kind: runKind,
          changeName,
          exec,
        })
  } catch (error) {
    return failure([{ code: error.code ?? 'candidate-worktree', message: error.message }])
  }
  if (mode === 'agent-runner' && !rescore) {
    const resolvedWorkflow = exec(
      'agent-runner',
      ['debug', '--show-workflow', IMPLEMENTATION_WORKFLOW_INSPECTION_REF],
      {
        cwd: candidateWorktree,
        env: { ...process.env, HOME: home, AGENT_RUNNER_NO_TUI: '1' },
      },
    )
    if (resolvedWorkflow.status !== 0 || resolvedWorkflow.error) {
      return failure([{
        code: 'workflow-resolution',
        message: 'Cannot resolve the logical Agent Runner workflow selected for execution',
      }])
    }
    if (hashString(resolvedWorkflow.stdout ?? '') !== provenance.workflow_sha256) {
      return failure([{
        code: 'workflow-resolution',
        message: 'The logical Agent Runner workflow does not match the verified pinned workflow',
      }])
    }
    const permission = repositoryPermissionLevel(
      candidateSource.repository,
      candidateWorktree,
      exec,
    )
    if (!GITHUB_WRITE_PERMISSIONS.has(permission)) {
      return failure([{
        code: 'publishing-credentials',
        message: 'GitHub credentials must have write permission for the candidate repository',
      }])
    }
  }

  // A baseline is immutable as soon as it is checked out. An implementation
  // candidate becomes immutable only after Agent Runner reaches the configured
  // delivery; on resume, a previously frozen identity is re-derived rather
  // than trusted from the checkpoint alone.
  let frozenCandidate = null
  if (mode === 'reference-baseline' || rescore || checkpoint?.identity?.candidate_identity) {
    try {
      frozenCandidate = await freezeCurrentCandidate()
    } catch (error) {
      return failure([{ code: 'candidate-freeze', message: error.message }])
    }
  }

  const identity = {
    candidate_identity: frozenCandidate?.candidate_identity ?? null,
    fixture_revision: frozenCandidate?.fixture_commit ?? candidateSource.fixture_commit,
    agent_runner_provenance: hashJson({
      commit: provenance?.commit ?? null,
      workflow_sha256: provenance?.workflow_sha256 ?? null,
      cli_version: provenance?.cli_version ?? null,
      rescore_source: importedRun?.provenance_sha256 ?? null,
    }),
    agent_skills_provenance: hashJson({
      commit: agentSkillsProvenance?.commit ?? null,
      manifest_sha256: agentSkillsProvenance?.manifest_sha256 ?? null,
    }),
    workflow_arguments: hashJson(boundary.workflow_arguments),
    agent_configuration: hashJson(validation.profiles),
    evaluator_configuration: hashJson({
      judge_model: options.judgeModel,
      browser_evaluator: browserEvaluatorFingerprint,
    }),
    // A rubric edit changes what the score means, so it invalidates a resumed
    // run rather than being blended into half-scored results.
    rubric_provenance: hashJson(provenanceOfRubrics),
    candidate_repository: candidateSource.repository,
    candidate_branch: candidateSource.branch,
    candidate_base_branch: candidateSource.base_branch,
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
    if (agentSkillsProvenance && checkpoint.agent_skills_provenance) {
      const drift = compareAgentSkillsProvenance(
        checkpoint.agent_skills_provenance,
        agentSkillsProvenance,
      )
      if (drift.length > 0) {
        return failure(drift.map((mismatch) => ({
          code: 'resume-agent-skills-provenance',
          ...mismatch,
        })))
      }
    }
    const stale = validateCheckpointIdentity(checkpoint, identity)
    if (stale.length > 0) {
      return failure(stale.map((mismatch) => ({ code: 'stale-checkpoint', ...mismatch })))
    }
    if (mode === 'agent-runner') {
      try {
        const revalidate = verifyResumeDelivery ?? verifyRecordedDeliveryIdentity
        await revalidate({
          worktree: candidateWorktree,
          recorded: checkpoint.delivery,
          exec,
        })
      } catch (error) {
        return failure([{
          code: 'resume-provenance',
          field: 'delivery',
          message: error.message,
        }])
      }
    }
  } else {
    checkpoint = {
      ...createCheckpoint({
        run_id: runId,
        identity,
        kind: runKind,
        delivery: rescore
          ? {
              ...importedRun.delivery,
              applicable: true,
              repository: candidateSource.repository,
              origin: candidateSource.repository,
              runner: importedRun.runner,
              acceptance: importedRun.delivery.acceptance,
            }
          : {
              repository: candidateSource.repository,
              origin: candidateSource.repository,
              fixture_commit: candidateSource.fixture_commit,
              branch: candidateSource.branch,
              base_branch: candidateSource.base_branch,
            },
      }),
      role_profiles: validation.profiles,
      agent_runner_provenance: provenance,
      agent_skills_provenance: agentSkillsProvenance,
      candidate_source: {
        repository: candidateSource.repository,
        fixture_commit: candidateSource.fixture_commit,
        branch: candidateSource.branch,
        base_branch: candidateSource.base_branch,
      },
      workflow: boundary,
      agent_runner: importedRun?.runner ?? null,
    }
    await saveCheckpoint(checkpointPath, checkpoint)
  }

  // Agent Runner layers built-in defaults, the global config, then the project
  // config it discovers at <cwd>/.agent-runner/config.yaml. Writing the
  // evaluation profile there and running Agent Runner from the candidate
  // worktree is what actually makes the selected roles take effect; the user's
  // own configuration outside this run directory is never read or modified.
  if (mode === 'agent-runner' && !rescore) {
    await mkdir(join(candidateWorktree, '.agent-runner'), { recursive: true })
    await writeFile(
      join(candidateWorktree, '.agent-runner/config.yaml'),
      renderEvalConfig(validation.profiles),
    )
    await mkdir(join(home, '.agent-runner'), { recursive: true })
    await writeFile(join(home, '.agent-runner/settings.yaml'), renderEvalSettings())
  }

  const record = {
    workflowHistory: rescore
      ? checkWorkflowHistory(importedRun.workflow.observed_steps)
      : {
          ok: mode === 'reference-baseline',
          missing_steps: [],
          prohibited_effects: [],
          observed_steps: [],
        },
    observed_steps: importedRun?.workflow.observed_steps ?? [],
    events: rescore
      ? [{
          event: 'imported-completed-run',
          source_run_id: importedRun.source_run_id,
          provenance_sha256: importedRun.provenance_sha256,
        }]
      : [],
    run: checkpoint.agent_runner,
    timings: [],
    browser: null,
    sourceEvidence: null,
    judging: null,
    score: null,
    metrics: importedRun?.implementation_metrics ?? null,
    pricing: importedRun?.pricing ?? null,
    cost: importedRun?.cost ?? null,
    ambiguity: null,
    candidateEvidence: null,
    evaluatorEvidence: null,
    contradictions: null,
    evidenceLineage: null,
    evidenceViews: null,
    neutral: null,
    candidateServer: null,
    candidate: frozenCandidate,
    delivery: checkpoint.delivery?.final_sha ? checkpoint.delivery : null,
    // Measured durations only. See lib/timing.mjs: nothing here holds a
    // wall-clock stamp, so no stopped-process or human-review gap can reach a
    // reported total. Earlier sessions' intervals are carried forward from the
    // checkpoint so a resumed run reports total active machine time rather than
    // only the last session's share of it.
    timing: mergeTimingLedgers(checkpoint.timing, createTimingLedger()),
  }

  // Pricing and ambiguity are eval-owned judge jobs and reuse the single
  // recorded Codex authority rather than selecting one of their own.
  const judgeAuthority = { cli: 'codex', model: options.judgeModel }

  // Each execution session gets its own label so the reported total reads as a
  // sum of recorded machine sessions rather than one uninterrupted stretch.
  const executionSession = `${runId}#${new Set(
    record.timing.intervals.map((interval) => interval.session),
  ).size + 1}`
  // Link the persistent run store into the container home so Agent Runner
  // writes where the controller reads, then read from whichever store is
  // actually in effect.
  const projectsDir = await resolveProjectsDir({ runDir, home })
  const readState = readRunnerState ?? ((runIdentifier) => readPersistedRunnerState(projectsDir, runIdentifier))
  const readSteps = observedSteps ?? ((state) => state?.history ?? state?.steps ?? [])
  // Agent Runner must run in the candidate worktree so it discovers the
  // eval-scoped project config, and under the same home the controller reads
  // run state from so both agree on the run store.
  const runnerSpawnOptions = {
    cwd: candidateWorktree,
    env: { ...process.env, HOME: home, AGENT_RUNNER_NO_TUI: '1' },
  }

  async function persistRunnerState(state) {
    record.run = { run_id: state.run_id, session_dir: state.session_dir ?? null }
    checkpoint = applyRunStateEvent(
      { ...checkpoint, agent_runner: record.run },
      {
        type: 'delivery-identity-recorded',
        owner: 'implementation-workflow',
        runner: record.run,
      },
    )
    await saveCheckpoint(checkpointPath, checkpoint)
  }

  const handlers = {
    preflight: async () => {
      // All preflight work has completed before phase scheduling so failures
      // cannot create or resume an Agent Runner process. This phase records the
      // successful contract in the authoritative state.
      await writeJsonAtomic(join(runDir, 'phases/preflight.json'), {
        fixture: candidateSource,
        workflow: boundary,
        agent_runner_provenance: provenance,
        agent_skills_provenance: agentSkillsProvenance,
        role_profiles: validation.profiles,
        evaluator_configuration: options.judgeModel,
        rubric_provenance: provenanceOfRubrics,
      })
    },

    'agent-runner': async () => {
      if (mode === 'reference-baseline') {
        record.events.push({ event: 'skipped', reason: 'reference-baseline' })
        return
      }
      if (rescore) {
        await writeJsonAtomic(join(runDir, 'phases/workflow-execution.json'), {
          run: record.run,
          workflow: boundary,
          provenance,
          events: record.events,
          history: record.observed_steps,
          history_verification: record.workflowHistory,
          imported_from: {
            run_id: importedRun.source_run_id,
            provenance_sha256: importedRun.provenance_sha256,
          },
        })
        return
      }

      let state = await readState(checkpoint.agent_runner?.run_id ?? null)
      let runnerStateSnapshot = state
      let decision = classifyRunnerRun({
        recorded: checkpoint.agent_runner,
        state,
        // With no checkpointed identity, an already-persisted run means a
        // previous process was interrupted mid-flight; adopt it rather than
        // starting a second implementation workflow.
        discovered: checkpoint.agent_runner?.run_id ? null : state,
        isProcessAlive: isRunnerProcessAlive,
      })
      while (decision.action !== 'continue') {
        const action = decision.action
        record.events.push({
          event: action,
          status: decision.status,
          reason: decision.reason,
          adopted: decision.adopted ?? false,
        })
        log(`agent-runner: ${action}`)
        if (action === 'error') throw new Error(decision.reason)

        // Adopting a persisted run records its identity before any further
        // work, so a second interruption cannot lose it again.
        if (decision.adopted && decision.run_id) {
          await persistRunnerState({
            run_id: decision.run_id,
            session_dir: state?.session_dir ?? null,
          })
        }

        let waitedState = null
        if (action === 'start') {
          const timing = runTimed('agent-runner', [
            'run', IMPLEMENTATION_WORKFLOW_LOGICAL_NAME,
            ...boundary.workflow_arguments,
          ], {
            label: 'agent-runner',
            exec,
            outputPath: join(runDir, 'logs/agent-runner.log'),
            ...runnerSpawnOptions,
          })
          record.timings.push(timing)
          if (!timing.ok) {
            const failedState = await readState(record.run?.run_id ?? null)
            if (failedState?.run_id) await persistRunnerState(failedState)
            throw new Error(runnerFailure(timing))
          }
        } else if (action === 'resume') {
          const [command, ...args] = decision.command
          const timing = runTimed(command, args, {
            label: 'agent-runner-resume',
            exec,
            outputPath: join(runDir, 'logs/agent-runner.log'),
            ...runnerSpawnOptions,
          })
          record.timings.push(timing)
          if (!timing.ok) {
            const failedState = await readState(record.run?.run_id ?? decision.run_id ?? null)
            if (failedState?.run_id) await persistRunnerState(failedState)
            throw new Error(runnerFailure(timing))
          }
        } else if (action === 'wait') {
          waitedState = waitForRun
            ? await waitForRun(decision.run_id)
            : await waitForRunnerRun({
                readState,
                runId: decision.run_id,
                isProcessAlive: isRunnerProcessAlive,
              })
        }

        state = waitedState ?? await readState(record.run?.run_id ?? decision.run_id ?? null)
        runnerStateSnapshot = state
        if (!state?.run_id) {
          throw new Error('Agent Runner exited without a discoverable persisted run state')
        }

        const observedRun = { run_id: state.run_id }
        decision = classifyRunnerRun({
          recorded: observedRun,
          state,
          isProcessAlive: isRunnerProcessAlive,
        })
        if (decision.action === 'resume' && action !== 'wait') {
          throw new Error(
            `Agent Runner ${action} exited before completing the full ${boundary.workflow} workflow`,
          )
        }
        if (decision.action !== 'error') {
          await persistRunnerState(state)
        }
      }
      if (state?.run_id && record.run?.run_id !== state.run_id) {
        await persistRunnerState(state)
      }
      record.events.push({ event: 'continue', status: decision.status, reason: null, adopted: false })

      record.observed_steps = await readSteps(runnerStateSnapshot)
      record.workflowHistory = checkWorkflowHistory(record.observed_steps)
      await writeJsonAtomic(join(runDir, 'phases/workflow-execution.json'), {
        run: record.run,
        workflow: boundary,
        provenance,
        events: record.events,
        history: record.observed_steps,
        history_verification: record.workflowHistory,
      })
    },

    'delivery-verification': async () => {
      if (mode === 'reference-baseline') return
      try {
        if (rescore) {
          const revalidate = verifyResumeDelivery ?? verifyRecordedDeliveryIdentity
          await revalidate({
            worktree: candidateWorktree,
            recorded: importedRun.delivery,
            exec,
          })
          record.delivery = importedRun.delivery
        } else {
          const verifier = verifyDelivery ?? verifyCandidateDelivery
          record.delivery = await verifier({
            worktree: candidateWorktree,
            fixtureCommit: candidateSource.fixture_commit,
            branch: candidateSource.branch,
            expectedBase: candidateSource.base_branch,
            changeName,
            sessionDir: record.run?.session_dir,
            workflowHistory: record.observed_steps,
            exec,
          })
        }
      } catch (error) {
        error.run_id ??= record.run?.run_id ?? null
        error.candidate_branch ??= candidateSource.branch
        error.pull_request ??= checkpoint.delivery?.pull_request ?? null
        throw error
      }
      checkpoint = applyRunStateEvent(checkpoint, {
        type: 'delivery-identity-recorded',
        owner: 'implementation-workflow',
        branch: candidateSource.branch,
        pull_request: record.delivery.pull_request,
        final_sha: record.delivery.final_sha,
        final_validator: record.delivery.final_validator,
        acceptance: {
          artifacts: record.delivery.acceptance_artifacts,
          workflow_history: record.delivery.workflow_history,
        },
      })
      await writeJsonAtomic(join(runDir, 'phases/delivery-verification.json'), record.delivery)
      await saveCheckpoint(checkpointPath, checkpoint)
    },

    'evidence-provenance': async () => {
      if (mode === 'reference-baseline') {
        await writeJsonAtomic(join(runDir, 'phases/evidence-provenance.json'), {
          applicable: false,
          reason: 'reference-baseline',
        })
        return
      }
      const evidenceBuilder = materializeEvidence
        ?? (verifyDelivery ? null : buildCandidateEvidenceManifest)
      if (!evidenceBuilder) {
        await writeJsonAtomic(join(runDir, 'phases/evidence-provenance.json'), {
          applicable: true,
          state: 'not-configured',
        })
        return
      }
      try {
        record.candidateEvidence = await evidenceBuilder({
          worktree: candidateWorktree,
          sessionDir: record.run?.session_dir ?? null,
          runDir,
          delivery: record.delivery,
        })
        record.evidenceLineage = await validateCandidateEvidenceLineage({
          finalSha: record.delivery.final_sha,
          worktree: candidateWorktree,
          manifest: record.candidateEvidence,
          exec,
        })
      } catch (error) {
        error.owner ??= 'evaluation-harness'
        if (error.owner === 'implementation-workflow') {
          error.run_id ??= record.run?.run_id ?? null
          error.candidate_branch ??= candidateSource.branch
          error.pull_request ??= record.delivery?.pull_request ?? null
          error.final_sha ??= record.delivery?.final_sha ?? null
        }
        throw error
      }
      checkpoint = applyRunStateEvent(checkpoint, {
        type: 'delivery-identity-recorded',
        owner: 'evaluation-harness',
        acceptance: {
          artifacts: record.delivery.acceptance_artifacts,
          workflow_history: record.delivery.workflow_history,
          manifest_sha256: record.candidateEvidence.manifest_sha256,
          lineage: record.evidenceLineage,
        },
      })
      await writeJsonAtomic(join(runDir, 'phases/evidence-provenance.json'), {
        applicable: true,
        manifest_sha256: record.candidateEvidence.manifest_sha256,
        lineage: record.evidenceLineage,
      })
      await saveCheckpoint(checkpointPath, checkpoint)
    },

    'source-freeze': async () => {
      if (!(mode === 'reference-baseline' && record.candidate)) {
        record.candidate = await freezeCurrentCandidate()
      }
      const neutralBuilder = materializeNeutral
        ?? (verifyDelivery ? null : materializeNeutralInputs)
      if (neutralBuilder) {
        const finalSha = record.delivery?.final_sha ?? record.candidate.produced_commit
        record.neutral = await neutralBuilder({
          worktree: candidateWorktree,
          runDir,
          finalSha,
          changeName,
          identities: {
            run: [runId, record.run?.run_id].filter(Boolean),
            branch: [candidateSource.branch].filter(Boolean),
            pull_request: [
              record.delivery?.pull_request?.url,
              record.delivery?.pull_request?.number,
            ].filter((value) => value !== null && value !== undefined),
            baseline: mode === 'reference-baseline' ? [record.candidate.candidate_identity] : [],
            candidate: [record.candidate.candidate_identity],
            change: [changeName],
          },
        })
      }
      checkpoint = {
        ...checkpoint,
        identity: {
          ...checkpoint.identity,
          candidate_identity: record.candidate.candidate_identity,
          fixture_revision: record.candidate.fixture_commit,
        },
        immutable_inputs: {
          ...checkpoint.immutable_inputs,
          candidate_identity: record.candidate.candidate_identity,
          fixture_revision: record.candidate.fixture_commit,
        },
        candidate: record.candidate,
      }
      await saveCheckpoint(checkpointPath, checkpoint)
    },

    verification: async () => {
      if (!verifyCandidate) return
      const verified = await verifyCandidate({ worktree: candidateWorktree, runDir, exec })
      buildResult = verified.build
      verificationResult = verified.verification
      record.timings.push(...(verified.timings ?? []))
      await writeJsonAtomic(join(runDir, 'phases/verification.json'), verified)
      if (verified.product_failure) {
        return [{
          type: 'conclusive-product-failure',
          phase: 'verification',
          reason: verified.product_failure.reason,
          gate: verified.product_failure.gate,
        }]
      }
    },

    'candidate-server': async (context) => {
      if (!candidateServer) {
        context.serverRunning = true
        return
      }
      let outcome
      try {
        outcome = await ensureCandidateServer({
          recorded: checkpoint.candidate_server ?? null,
          candidate: record.candidate?.candidate_identity ?? checkpoint.identity.candidate_identity,
          isProcessAlive,
          probe: candidateServer.probe,
          start: candidateServer.start,
        })
      } catch (error) {
        if (error?.owner !== 'product') throw error
        return [{
          type: 'conclusive-product-failure',
          phase: 'candidate-server',
          reason: error.message,
          gate: error.gate ?? 'verification-every-produced-step-renders',
        }]
      }
      record.candidateServer = outcome.server
      // Recorded durably as soon as it exists, so the separate human-review
      // command can find the very server this run evaluated.
      checkpoint = { ...checkpoint, candidate_server: outcome.server }
      await saveCheckpoint(checkpointPath, checkpoint)
      log(`candidate-server: ${outcome.action} at ${outcome.server.url}`)
      context.serverRunning = true
    },

    'browser-evaluation': async () => {
      const activeBrowserDriver = browserDriver ?? (
        browserDriverFactory && record.candidateServer?.url
          ? await browserDriverFactory({ baseUrl: record.candidateServer.url, runDir })
          : null
      )
      if (!activeBrowserDriver) {
        // Without a driver the live demo was never observed. That is missing
        // evidence, not a demo that misbehaved, so nothing is recorded against
        // the candidate.
        record.events.push({ event: 'skipped', reason: 'no browser driver configured' })
        return
      }
      const revision = record.delivery?.final_sha
        ?? record.candidate?.produced_commit
        ?? checkpoint.delivery?.final_sha
        ?? checkpoint.identity.candidate_identity
      const probeDirectory = join(runDir, 'evidence/evaluator/browser-probes')
      await mkdir(probeDirectory, { recursive: true })
      const evaluation = await runBrowserEvaluation({
        driver: activeBrowserDriver,
        build: buildResult,
        verification: verificationResult,
        revision,
        evaluatorFingerprint: browserEvaluatorFingerprint,
        evidenceArtifacts: {
          probe: (id) => `evidence/evaluator/browser-probes/${id}.json`,
          verification: 'phases/verification.json',
        },
        loadProbe: async ({ id, inputs, dependencies }) => {
          const reusable = await verifyUnit(checkpoint, {
            phase: 'browser-evaluation',
            unit: id,
            inputs,
            dependencies,
          })
          if (!reusable.reusable) return null
          const artifact = join(probeDirectory, `${id}.json`)
          return readJson(artifact, null)
        },
        saveProbe: async ({ id, inputs, dependencies, result }) => {
          const artifact = join(probeDirectory, `${id}.json`)
          checkpoint = beginUnit(checkpoint, {
            phase: 'browser-evaluation',
            unit: id,
            inputs,
            dependencies,
          })
          await saveCheckpoint(checkpointPath, checkpoint)
          await writeJsonAtomic(artifact, result)
          checkpoint = await completeUnit(checkpoint, {
            phase: 'browser-evaluation',
            unit: id,
            inputs,
            dependencies,
            outputs: [artifact],
          })
          await saveCheckpoint(checkpointPath, checkpoint)
        },
      })
      record.browser = evaluation
      await writeJsonAtomic(join(runDir, 'phases/browser-evaluation.json'), evaluation)
    },

    'product-judging': async () => {
      // The judges answer source-review criteria, so they must be shown the
      // delivered source. Collecting it here also bounds it: the scan budget
      // caps how much candidate-controlled text can reach a prompt.
      const sourceRoot = record.neutral
        ? join(runDir, record.neutral.source.root)
        : candidateWorktree
      record.sourceEvidence = await collectSourceEvidence(sourceRoot)
      await writeJsonAtomic(join(runDir, 'phases/source-evidence.json'), record.sourceEvidence)
      record.evaluatorEvidence = await buildEvaluatorEvidenceManifest({
        runDir,
        finalSha: record.delivery?.final_sha ?? record.candidate?.produced_commit ?? null,
        artifacts: [{
          id: 'deterministic-source-facts',
          kind: 'deterministic-checks',
          content: `${JSON.stringify(record.sourceEvidence, null, 2)}\n`,
          media_type: 'application/json',
          coverage: record.sourceEvidence.evidence.map(({ id }) => id),
          claims: record.sourceEvidence.evidence.map(({ id, verdict, note }) => ({
            id, verdict, note,
          })),
        }, ...(record.browser ? [{
          id: 'deterministic-browser-facts',
          kind: 'deterministic-browser-checks',
          content: `${JSON.stringify(record.browser, null, 2)}\n`,
          media_type: 'application/json',
          coverage: [
            ...(record.browser.criteria ?? []).map(({ id }) => id),
            ...(record.browser.gates ?? []).map(({ id }) => id),
          ],
          claims: [
            ...(record.browser.criteria ?? []),
            ...(record.browser.gates ?? []),
          ].map(({ id, verdict, note }) => ({ id, verdict, note })),
        }] : [])],
      })
      record.contradictions = await recordEvidenceContradictions({
        runDir,
        candidate: record.candidateEvidence,
        evaluator: record.evaluatorEvidence,
        contradictions: detectEvidenceContradictions({
          candidate: record.candidateEvidence,
          evaluator: record.evaluatorEvidence,
        }),
      })
      if (record.candidateEvidence) {
        record.evidenceViews = await materializeEvidenceJudgeViews({
          runDir,
          candidate: record.candidateEvidence,
          evaluator: record.evaluatorEvidence,
          contradictions: record.contradictions,
          lineage: record.evidenceLineage,
        })
      }

      const judgeDirectory = join(runDir, 'phases/judges')
      await mkdir(judgeDirectory, { recursive: true })
      const evidenceViews = Object.fromEntries(
        Object.entries(record.evidenceViews ?? {}).map(([id, view]) => [id, {
          ...view,
          root: join(runDir, view.root),
          index: join(runDir, view.index),
        }]),
      )
      const judgeDependencies = {
        rubric: provenanceOfRubrics.automated,
        final_sha: record.delivery?.final_sha ?? record.candidate?.produced_commit ?? null,
        neutral_manifest: record.neutral?.manifest_sha256 ?? null,
        evidence_views: record.evidenceViews ?? null,
      }

      if (record.sourceEvidence.files.length === 0) {
        throw new Error('candidate source is empty; product judging cannot produce an evidence-backed result')
      } else if (!judgeInvoke) {
        const error = new Error('required scored judging has no judge invoker configured')
        error.code = 'judge-output'
        throw error
      } else {
        record.judging = await runProductJudging({
          rubrics,
          authority: { cli: 'codex', model: options.judgeModel },
          evidence: [
            ...record.sourceEvidence.evidence,
            ...(record.browser?.criteria ?? []),
            ...(record.browser?.gates ?? []),
          ],
          sources: record.sourceEvidence.files,
          neutral: record.neutral ? {
            root: join(runDir, record.neutral.judge?.root ?? 'neutral/judge'),
            source_root: join(runDir, record.neutral.source.root),
            requirements_root: join(runDir, record.neutral.requirements.root),
            audit_root: join(runDir, '.runtime/judge-workspace'),
          } : null,
          evidenceViews,
          mode,
          loadJob: async ({ id, inputHash }) => {
            const reusable = await verifyUnit(checkpoint, {
              phase: 'product-judging',
              unit: id,
              inputs: { input_hash: inputHash },
              dependencies: judgeDependencies,
            })
            if (!reusable.reusable) return null
            return readJson(join(judgeDirectory, `${id}.json`), null)
          },
          startJob: async ({ id, inputHash }) => {
            checkpoint = beginUnit(checkpoint, {
              phase: 'product-judging',
              unit: id,
              inputs: { input_hash: inputHash },
              dependencies: judgeDependencies,
            })
            await saveCheckpoint(checkpointPath, checkpoint)
          },
          saveJob: async ({ id, inputHash, ...outcome }) => {
            const artifact = join(judgeDirectory, `${id}.json`)
            await writeJsonAtomic(artifact, { id, input_hash: inputHash, ...outcome })
            checkpoint = await completeUnit(checkpoint, {
              phase: 'product-judging',
              unit: id,
              inputs: { input_hash: inputHash },
              dependencies: judgeDependencies,
              outputs: [artifact],
            })
            await saveCheckpoint(checkpointPath, checkpoint)
          },
          failJob: async ({ id, attempts }) => {
            checkpoint = failUnit(checkpoint, {
              phase: 'product-judging',
              unit: id,
              error: attempts.at(-1)?.error ?? 'judge output exhausted',
            })
            await saveCheckpoint(checkpointPath, checkpoint)
          },
          invoke: judgeInvoke,
        })
        await writeJsonAtomic(join(runDir, 'phases/product-judging.json'), record.judging)
      }

      record.score = scoreProduct({
        rubrics,
        deterministic: record.browser?.criteria ?? null,
        judges: record.judging?.judges ?? {},
        gates: record.browser?.gates ?? null,
        humanReview: null,
        // Retries, repair, and workflow lifecycle events are diagnostic context for the
        // reader; the scorer never turns any of them into points.
        harness: {
          judge_retries: record.judging?.retries ?? {},
          failed_judge_jobs: record.judging?.failed_jobs ?? [],
          browser_bounds_exceeded: record.browser?.bounds_exceeded ?? [],
          source_scan_budget_exceeded: record.sourceEvidence?.budget_exceeded ?? [],
        },
        mode,
      })
      await writeJsonAtomic(join(runDir, 'phases/score.json'), record.score)
      if ((record.judging?.failed_jobs ?? []).length > 0) {
        const error = new Error(
          `required judge output exhausted: ${record.judging.failed_jobs.join(', ')}`,
        )
        error.code = 'judge-output'
        throw error
      }
      return [{
        type: 'automated-scoring-complete',
        automated_subtotal: record.score.automated_subtotal.points,
      }]
    },

    // Both diagnostic phases are deliberately terminal in their own scope: they
    // return no outcome events, so nothing they observe can move a point, open a
    // gate, or change the product verdict.
    'ambiguity-diagnostics': async () => {
      const ledgerPath = join(runDir, 'ambiguity-ledger.json')
      const artifacts = await collectAmbiguityArtifacts({ sessionDir: record.run?.session_dir ?? null })
      // A ledger written by an earlier session is the record of what was already
      // observed; this run adds to it rather than replacing it.
      const previous = await readJson(ledgerPath, null)

      const { ledger } = await runAmbiguityDiagnostics({
        runId: record.run?.run_id ?? runId,
        artifacts,
        productEvidence: [
          ...(record.sourceEvidence?.evidence ?? []),
          ...(record.browser?.criteria ?? []),
          ...(record.browser?.gates ?? []),
        ],
        authority: judgeAuthority,
        invoke: judgeInvoke,
        previous,
      })

      record.ambiguity = ledger
      await writeJsonAtomic(ledgerPath, ledger)
      await writeJsonAtomic(join(runDir, 'phases/ambiguity-diagnostics.json'), ledger)
    },

    'metrics-pricing': async () => {
      if (rescore) {
        await writeJsonAtomic(join(runDir, 'phases/metrics-pricing.json'), {
          metrics: record.metrics,
          pricing: record.pricing,
          cost: record.cost,
          imported_from: {
            run_id: importedRun.source_run_id,
            provenance_sha256: importedRun.provenance_sha256,
          },
        })
        return
      }
      record.metrics = await readRunnerMetrics({
        sessionDir: record.run?.session_dir ?? null,
        runId: record.run?.run_id ?? runId,
        workflow: boundary.workflow,
      })

      const catalog = needsPricingLookup(record.metrics.attempts)
        ? await fetchPricingCatalog(pricingFetch ? { fetchImpl: pricingFetch } : {})
        : null
      record.pricing = await resolveImplementationPricing({
        attempts: record.metrics.attempts,
        catalog,
        invoke: judgeInvoke,
        authority: judgeAuthority,
      })
      record.cost = {
        ...aggregateImplementationCost({
          attempts: record.metrics.attempts,
          costs: record.pricing.costs,
          // Rejected or partial Runner metrics mean the set of attempts is
          // unknown, so no total computed from them can be presented as final.
          attemptsComplete: record.metrics.complete,
        }),
        // Reported beside implementation cost and never inside it.
        eval_owned: summarizeEvalOwnedUsage([]),
      }

      await writeJsonAtomic(join(runDir, 'phases/metrics-pricing.json'), {
        metrics: record.metrics,
        pricing: record.pricing,
        cost: record.cost,
      })
    },

    'pending-result': async (context) => { await writeResult(context.outcome) },

    cleanup: async (context) => {
      context.serverRunning = false
      if (!candidateServer) return
      const outcome = await stopCandidateServer({
        recorded: record.candidateServer,
        isProcessAlive,
        probe: candidateServer.probe,
        stop: candidateServer.stop,
      })
      // Cleanup after a durably written pending result is a handoff detail: the
      // lifecycle records the failure diagnostically and the command still exits
      // successfully.
      if (!outcome.completed) {
        throw new Error(`candidate-server cleanup did not complete: ${outcome.error ?? outcome.reason}`)
      }
    },

    'cleanup-result': async (context) => { await writeResult(context.outcome) },

    ...handlerOverrides,
  }

  // The pending result, its report, and the artifact manifest are written from
  // one assembled value, so the three artifacts can never describe different
  // states of the same run.
  async function writeResult(outcome) {
    const projectedState = { ...checkpoint, outcome }
    const result = assembleResult({
        runId,
        mode,
        outcome,
        rubrics: provenanceOfRubrics,
        score: record.score,
        // Human review belongs to the separate review command. The automated
        // command hands off without one and never invents an official verdict.
        humanReview: null,
        browser: record.browser,
        sourceEvidence: record.sourceEvidence,
        judging: record.judging,
        workflow: {
          workflow: boundary.workflow,
          workflow_path: boundary.workflow_path,
          skip_validator: boundary.skip_validator,
          task_level_compliance: boundary.task_level_compliance,
          final_validator: boundary.final_validator,
          arguments: boundary.workflow_arguments,
          full_workflow: true,
          configured_stop_step: null,
          last_observed_step: record.workflowHistory.observed_steps.at(-1) ?? null,
          unexpected_step: record.workflowHistory.prohibited_effects[0]?.step ?? null,
          observed_steps: record.observed_steps,
          history_complete: record.workflowHistory.ok,
          missing_steps: record.workflowHistory.missing_steps,
          prohibited_effects: record.workflowHistory.prohibited_effects,
          run_id: record.run?.run_id ?? null,
          session_dir: record.run?.session_dir ?? null,
          provenance,
          agent_skills_provenance: agentSkillsProvenance,
          events: record.events,
        },
        // A reference baseline invoked no implementation workflow, so its usage,
        // cost, and duration are absent rather than zero.
        metrics: mode === 'reference-baseline' ? null : record.metrics,
        cost: mode === 'reference-baseline' ? null : record.cost,
        pricing: record.pricing,
        // Summarized at write time so the reported total covers every automated
        // phase that had actually run when the result was written.
        timing: summarizeMachineTiming({
          ledger: record.timing,
          implementationMs: record.metrics?.active_duration_ms ?? null,
        }),
        ambiguity: record.ambiguity ? {
          artifact: 'ambiguity-ledger.json',
          coverage: record.ambiguity.coverage,
          finding_count: record.ambiguity.findings.length,
          classifications: record.ambiguity.findings.map(({ id, classification, consequence }) => ({
            id, classification, consequence,
          })),
          fixture_improvement_proposals: record.ambiguity.fixture_improvement_proposals,
          scoring_effect: 'none',
        } : null,
        evidence: {
          candidate: record.candidateEvidence,
          evaluator: record.evaluatorEvidence,
          contradictions: record.contradictions,
          lineage: record.evidenceLineage,
          workflow_provenance: mode === 'reference-baseline' ? 'not-applicable' : 'complete',
        },
        roleConfiguration: reconcileRoleAttempts(
          validation.profiles,
          record.metrics?.attempts ?? [],
        ),
        timings: summarizeTimings(record.timings),
        runState: projectedState,
        candidate: record.candidate ?? checkpoint.candidate ?? {
          candidate_identity: checkpoint.identity.candidate_identity,
        },
        delivery: checkpoint.delivery,
        // The endpoint the reviewer is handed. Null when no server was started,
        // so the human-review command starts one rather than trusting a stale
        // URL.
        candidateServer: record.candidateServer,
      })
    await writeResultArtifacts({ runDir, result })
  }

  const completedPhases = new Set()
  for (const [name, phase] of Object.entries(checkpoint.phases ?? {})) {
    if (phase.state !== 'complete' || !Array.isArray(phase.outputs) || phase.outputs.length === 0) continue
    let matches = true
    for (const output of phase.outputs) {
      if (await hashFile(join(runDir, output.path)) !== output.sha256) {
        matches = false
        break
      }
    }
    if (matches) completedPhases.add(name)
  }

  // A reused phase runs no handler, so its findings would be absent from the
  // record the result is rendered from. Rehydrating from the durable phase
  // artifacts is what makes a resumed `result.json` describe the whole
  // evaluation rather than only the phases this session happened to execute.
  for (const [phase, load] of [
    ['verification', (value) => {
      buildResult = value.build
      verificationResult = value.verification
      record.timings.push(...(value.timings ?? []))
    }],
    ['browser-evaluation', (value) => { record.browser = value }],
    ['source-evidence', (value) => { record.sourceEvidence = value }],
    ['neutral-inputs', (value) => { record.neutral = value }],
    ['product-judging', (value) => { record.judging = value }],
    ['score', (value) => { record.score = value }],
    ['ambiguity-diagnostics', (value) => { record.ambiguity = value }],
    ['metrics-pricing', (value) => {
      record.metrics = value.metrics
      record.pricing = value.pricing
      record.cost = value.cost
    }],
  ]) {
    const persisted = await readJson(join(runDir, `phases/${phase}.json`), null)
    if (persisted) load(persisted)
  }
  const durableEvidence = await readEvidenceProjectionInputs(runDir)
  record.candidateEvidence ??= durableEvidence.candidate
  record.evaluatorEvidence ??= durableEvidence.evaluator
  record.contradictions ??= durableEvidence.contradictions
  record.evidenceLineage ??= durableEvidence.lineage

  // Record phase completion durably as each phase finishes, so an interrupted
  // run resumes at the first incomplete phase instead of repeating valid work.
  const tracked = {}
  const phaseArtifactPaths = {
    preflight: ['phases/preflight.json'],
    'agent-runner': ['phases/workflow-execution.json'],
    'delivery-verification': ['phases/delivery-verification.json'],
    'evidence-provenance': [
      'phases/evidence-provenance.json',
      'evidence/candidate/manifest.json',
    ],
    'source-freeze': [
      'implementation.diff',
      'candidate-source-manifest.json',
      'neutral/provenance/manifest.json',
    ],
    verification: ['phases/verification.json'],
    'browser-evaluation': ['phases/browser-evaluation.json'],
    'product-judging': [
      'phases/source-evidence.json',
      'phases/product-judging.json',
      'phases/score.json',
      'evidence/evaluator/manifest.json',
      'evidence/evaluator/contradictions.json',
    ],
    'ambiguity-diagnostics': ['phases/ambiguity-diagnostics.json', 'ambiguity-ledger.json'],
    'metrics-pricing': ['phases/metrics-pricing.json'],
    'pending-result': ['result.json', 'report.html', 'artifact-manifest.json'],
    'cleanup-result': ['result.json', 'report.html', 'artifact-manifest.json'],
  }
  async function recordedPhaseOutputs(name) {
    const outputs = []
    for (const relative of phaseArtifactPaths[name] ?? []) {
      const path = join(runDir, relative)
      const sha256 = await hashFile(path)
      if (sha256) outputs.push({ path: relative, sha256 })
    }
    return outputs
  }
  for (const phase of AUTOMATED_PHASES) {
    const handler = handlers[phase.name]
    if (!handler) continue
    tracked[phase.name] = async (context) => {
      checkpoint = applyRunStateEvent(checkpoint, {
        type: 'phase-started',
        owner: phase.owner,
        phase: phase.name,
        input_fingerprint: hashJson(identity),
        dependency_fingerprint: hashJson(
          Object.fromEntries(
            Object.entries(checkpoint.phases ?? {})
              .filter(([, value]) => value.state === 'complete')
              .map(([name, value]) => [name, value.completed_at]),
          ),
        ),
      })
      await saveCheckpoint(checkpointPath, checkpoint)
      const start = process.hrtime.bigint()
      let events
      try {
        events = await handler(context)
      } catch (error) {
        if (phase.owner === 'implementation-workflow') {
          error.candidate_branch ??= candidateSource.branch
          error.pull_request ??= checkpoint.delivery?.pull_request ?? null
          error.final_sha ??= checkpoint.delivery?.final_sha ?? null
          error.run_id ??= record.run?.run_id ?? checkpoint.agent_runner?.run_id ?? null
        }
        throw error
      }
      // Only the phase's own active execution is measured. The implementation
      // workflow's duration comes from Agent Runner's own metrics instead, so it
      // is not double-counted here.
      if (phase.owner === 'evaluation-harness') {
        record.timing = recordMachineInterval(record.timing, {
          phase: phase.name,
          duration_ms: Number(process.hrtime.bigint() - start) / 1e6,
          session: executionSession,
        })
      }
      checkpoint = applyRunStateEvent({
        ...checkpoint,
        timing: record.timing,
      }, {
        type: 'phase-completed',
        owner: phase.owner,
        phase: phase.name,
        outputs: await recordedPhaseOutputs(phase.name),
      })
      await saveCheckpoint(checkpointPath, checkpoint)
      return events
    }
  }

  const result = await runPhases({
    phases: AUTOMATED_PHASES,
    handlers: tracked,
    outcome: checkpoint.outcome ?? createOutcome({ kind: runKind }),
    isComplete: (name) => completedPhases.has(name),
  })

  checkpoint = applyRunStateEvent(checkpoint, {
    type: 'outcome-updated',
    owner: 'evaluation-harness',
    outcome: result.outcome,
  })
  if (result.failed) {
    checkpoint = applyRunStateEvent(checkpoint, {
      type: 'phase-failed',
      owner: result.outcome.failure?.owner ?? 'evaluation-harness',
      phase: result.failed,
      error: result.outcome.failure,
    })
  }
  await saveCheckpoint(checkpointPath, checkpoint)

  return { ...result, errors: [], runDir, runId, boundary, provenance, profiles: validation.profiles }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const runDirIndex = argv.indexOf('--run-dir')
  const productionRunDir = runDirIndex === -1 ? null : argv[runDirIndex + 1]
  const candidateWorktree = productionRunDir
    ? join(resolve(productionRunDir), '.runtime/candidate-worktree')
    : null
  const result = await runEvaluation({
    argv,
    home: process.env.HOME ?? null,
    verifyCandidate: productionRunDir
      ? ({ worktree, exec }) => runCandidateVerification({ worktree, exec })
      : null,
    candidateServer: productionRunDir
      ? createHostCandidateServer({ runDir: productionRunDir })
      : null,
    browserDriverFactory: productionRunDir
      ? ({ baseUrl }) => createAxiBrowserDriver({ baseUrl })
      : null,
    judgeInvoke: productionRunDir
      ? createCodexJudgeInvoker({
          runDir: productionRunDir,
          candidateWorktree,
          defaultCwd: join(resolve(productionRunDir), '.runtime/judge-workspace'),
          allowedRoots: [
            join(resolve(productionRunDir), '.runtime/judge-workspace'),
            join(resolve(productionRunDir), 'neutral/judge'),
            join(resolve(productionRunDir), 'evidence/judge-views'),
          ],
        })
      : null,
    log: (line) => console.error(line),
  })
  for (const error of result.errors ?? []) console.error(JSON.stringify(error))
  process.exit(result.exitCode)
}
