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

function invoke(label, args, { worktree, exec }) {
  const timing = runTimed('npm', args, { label, cwd: worktree, exec })
  if (timing.error && timing.status === -1) {
    throw new Error(`cannot launch npm for candidate ${label}: ${timing.error}`)
  }
  return timing
}

export async function runCandidateVerification({
  worktree,
  exec = spawnSync,
} = {}) {
  const timings = []
  const install = invoke('install', ['ci'], { worktree, exec })
  timings.push(install)

  let build = null
  let verification = null
  if (install.ok) {
    build = invoke('build', ['run', 'build'], { worktree, exec })
    timings.push(build)
    if (build.ok) {
      verification = invoke('verification', ['run', 'verify'], { worktree, exec })
      timings.push(verification)
    }
  }

  const buildCommand = build ? commandResult(build) : skipped('dependency installation failed')
  const verificationCommand = verification
    ? commandResult(verification)
    : skipped(build ? 'candidate build failed' : 'dependency installation failed')
  const buildOk = install.ok && build?.ok === true
  const verificationOk = buildOk && verification?.ok === true

  return {
    commands: {
      install: commandResult(install),
      build: buildCommand,
      verification: verificationCommand,
    },
    build: {
      ok: buildOk,
      log: buildCommand.log || commandResult(install).log || buildCommand.reason,
    },
    verification: {
      machine_readable: true,
      passed: verificationOk,
      artifact: 'phases/verification.json',
    },
    timings,
  }
}
