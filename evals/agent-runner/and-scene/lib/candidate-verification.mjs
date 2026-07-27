// Install, build, and repository-owned verification for the frozen candidate.
// Command failures are product evidence: the harness records them and lets the
// hard gates decide the verdict. Failure to launch npm at all is a harness
// failure because no claim about the candidate can be supported in that case.
import { spawnSync } from 'node:child_process'

import { runTimed } from './subprocess.mjs'

const MAX_LOG_CHARS = 4000

function outputOf(timing) {
  const text = [timing.stdout, timing.stderr].filter(Boolean).join('\n').trim()
  return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS - 1)}…` : text
}

function skipped(reason) {
  return { state: 'skipped', ok: false, reason, log: '' }
}

function commandResult(timing) {
  return {
    state: 'complete',
    ok: timing.ok,
    status: timing.status,
    log: outputOf(timing),
  }
}

function attemptedCommand(attempts) {
  const result = commandResult(attempts.at(-1))
  return {
    ...result,
    attempts: attempts.map((attempt) => commandResult(attempt)),
  }
}

function invoke(label, args, { worktree, exec }) {
  const timing = runTimed('npm', args, { label, cwd: worktree, exec })
  if (timing.error && timing.status === -1) {
    throw Object.assign(
      new Error(`cannot launch npm for candidate ${label}: ${timing.error}`),
      {
        owner: 'evaluation-harness',
        code: 'candidate-command-launch-failed',
        resumable: true,
      },
    )
  }
  return timing
}

const INFRASTRUCTURE_FAILURE_PATTERNS = [
  /\b(?:EAI_AGAIN|ENETUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOSPC)\b/i,
  /(?:registry|network).*(?:unavailable|timed out|failed|error)/i,
  /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:502|503|504)\b/i,
]

function isInfrastructureFailure(attempt) {
  const output = outputOf(attempt)
  return !attempt.ok && INFRASTRUCTURE_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
}

function throwInfrastructureFailure(attempts, stage) {
  if (attempts.length === 0 || !attempts.every(isInfrastructureFailure)) return
  const lastOutput = outputOf(attempts.at(-1))
  throw Object.assign(
    new Error(`candidate ${stage} could not be evaluated because infrastructure failed repeatedly: ${lastOutput}`),
    {
      owner: 'evaluation-harness',
      code: 'candidate-command-infrastructure-failed',
      resumable: true,
    },
  )
}

export async function runCandidateVerification({
  worktree,
  exec = spawnSync,
} = {}) {
  const timings = []
  const installAttempts = [invoke('install', ['ci'], { worktree, exec })]
  timings.push(...installAttempts)
  if (!installAttempts[0].ok) {
    installAttempts.push(invoke('install-confirmation', ['ci'], { worktree, exec }))
    timings.push(installAttempts[1])
  }
  throwInfrastructureFailure(installAttempts, 'install')
  const install = installAttempts.at(-1)

  let build = null
  const buildAttempts = []
  let verification = null
  if (install.ok) {
    build = invoke('build', ['run', 'build'], { worktree, exec })
    buildAttempts.push(build)
    timings.push(build)
    if (!build.ok) {
      build = invoke('build-confirmation', ['run', 'build'], { worktree, exec })
      buildAttempts.push(build)
      timings.push(build)
    }
    throwInfrastructureFailure(buildAttempts, 'build')
    if (build.ok) {
      verification = invoke('verification', ['run', 'verify'], { worktree, exec })
      timings.push(verification)
    }
  }

  const buildCommand = build ? attemptedCommand(buildAttempts) : skipped('dependency installation failed')
  const verificationCommand = verification
    ? attemptedCommand([verification])
    : skipped(build ? 'candidate build failed' : 'dependency installation failed')
  const installCommand = attemptedCommand(installAttempts)
  const buildOk = install.ok && build?.ok === true
  const verificationRan = verification !== null
  const failedStage = installAttempts.every((attempt) => !attempt.ok)
    ? 'install'
    : (buildAttempts.length > 0 && buildAttempts.every((attempt) => !attempt.ok) ? 'build' : null)

  return {
    commands: {
      install: installCommand,
      build: buildCommand,
      verification: verificationCommand,
    },
    build: {
      ok: buildOk,
      log: buildCommand.log || installCommand.log || buildCommand.reason,
    },
    verification: {
      // A process exit status is an unambiguous machine-readable result, but a
      // verifier that never ran produced no result at all.
      machine_readable: verificationRan,
      passed: verificationRan ? verification.ok : null,
      artifact: 'phases/verification.json',
    },
    product_failure: failedStage
      ? {
          owner: 'product',
          stage: failedStage,
          gate: 'verification-build-whole-app',
          reproducible: true,
          reason: failedStage === 'install'
            ? (installCommand.log || 'candidate dependency installation failed')
            : (buildCommand.log || 'candidate build failed'),
        }
      : null,
    timings,
  }
}
