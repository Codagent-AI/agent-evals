// Keeps Agent Validator out of reach of the agents in a --skip-validator run.
//
// Skipping the workflow's validator steps does not stop an agent from running
// the image's globally installed agent-validator itself, for example because a
// skill it picked up says to. That would put validator reviews into the
// no-validator arm. Agent Runner needs no validator binary when every
// validator step is skipped, so the controller launches it with a PATH whose
// first entry shadows each validator command with a shim that refuses to run
// and records the attempt.
//
// The sandbox runs unprivileged, so the installed binary itself cannot be
// removed or masked; an agent that calls it by absolute path still reaches
// it. Agents invoke it by name, which this covers.
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const VALIDATOR_COMMANDS = ['agent-validator', 'agent-validate']

const SHIM_DIR = '.runtime/validator-unavailable/bin'
const BLOCKED_LOG = 'logs/blocked-validator-invocations.log'

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function shimScript(logPath) {
  return [
    '#!/bin/sh',
    `printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$0") $*" >> ${shellQuote(logPath)} 2>/dev/null \\`,
    '  || echo "blocked-validator-invocation: $(basename "$0") $*" >&2',
    'echo "$(basename "$0") is unavailable: this evaluation runs with --skip-validator, so Agent Validator must not run. Do not try to run it another way." >&2',
    'exit 127',
    '',
  ].join('\n')
}

export async function hideValidatorFromAgents({ runDir, env = process.env }) {
  const shimDir = join(runDir, SHIM_DIR)
  const logPath = join(runDir, BLOCKED_LOG)
  await mkdir(shimDir, { recursive: true })
  await mkdir(join(runDir, 'logs'), { recursive: true })
  const script = shimScript(logPath)
  for (const name of VALIDATOR_COMMANDS) {
    const path = join(shimDir, name)
    await writeFile(path, script)
    await chmod(path, 0o755)
  }

  const { AGENT_RUNNER_VALIDATOR_EXECUTABLE: _override, ...rest } = env
  const hiddenEnv = { ...rest, PATH: [shimDir, env.PATH].filter(Boolean).join(':') }
  // Prove the shim wins name lookup before recording that it does, so a PATH
  // that cannot carry it fails the run instead of silently admitting reviews.
  const expected = VALIDATOR_COMMANDS.map((name) => join(shimDir, name))
  const probe = spawnSync('/bin/sh', ['-c', 'for name; do command -v "$name"; done', 'sh', ...VALIDATOR_COMMANDS], {
    encoding: 'utf8',
    env: hiddenEnv,
  })
  const resolved = (probe.stdout ?? '').trim().split('\n')
  if (probe.status !== 0 || resolved.join('\n') !== expected.join('\n')) {
    throw new Error(
      `Agent Validator could not be hidden from agents: expected ${expected.join(', ')}, resolved ${resolved.join(', ') || 'nothing'}`,
    )
  }
  return {
    shimDir,
    env: hiddenEnv,
    event: {
      event: 'validator-unavailable',
      reason: 'skip-validator',
      mechanism: 'path-shim',
      commands: [...VALIDATOR_COMMANDS],
      blocked_invocations_log: BLOCKED_LOG,
    },
  }
}
