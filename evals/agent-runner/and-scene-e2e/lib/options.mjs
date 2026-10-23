import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
export const DEFAULT_TIME_LIMIT_MS = 12 * 60 * 60 * 1000
export const DEFAULT_STALL_WINDOW_MS = 45 * 60 * 1000
export const TOKEN_REFRESH = { default: 30, min: 1, max: 50 }
export const DEFAULT_WORKFLOW = 'openspec:change'
// Evaluator profiles are pinned and cannot be chosen from the command line.
const PINNED_ROLES = ['judge', 'decider', 'panel', 'simulated-user', 'user', 'validator']
export const DEFAULT_ROLES = ['lead', 'crosscheck', 'implementor', 'tester']
export function parseDuration(value, label = 'duration') {
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  const number = match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] ?? 's']) : NaN
  if (!Number.isFinite(number) || number <= 0 || number > 2147483647) throw new Error(`${label} must be a positive duration (for example 12h, 45m, or 60s) below 25 days`)
  return number
}
export function parseRefreshInterval(value) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < TOKEN_REFRESH.min || minutes > TOKEN_REFRESH.max) throw new Error(`token-refresh-interval must be between ${TOKEN_REFRESH.min} and ${TOKEN_REFRESH.max} minutes`)
  return minutes
}
// Roles come from the selected workflow; only the profile fields and CLI rules are fixed here.
export function validateProfiles(profiles, roles = DEFAULT_ROLES) {
  for (const role of roles) {
    for (const field of ['cli', 'model', 'effort']) {
      if (typeof profiles?.[role]?.[field] !== 'string' || !profiles[role][field].trim()) throw new Error(`profiles: missing ${role}.${field}`)
    }
    const allowed = role === 'lead' ? ['claude', 'codex'] : role === 'crosscheck' ? ['claude', 'codex', 'cursor'] : ['claude', 'codex']
    if (!allowed.includes(profiles[role].cli)) {
      throw new Error(role === 'lead' ? 'lead must use claude or codex' : `${role} must use ${allowed.join(' or ')}: cursor is accepted only for crosscheck`)
    }
  }
  return profiles
}
export const HELP = `Usage: evals/agent-runner/and-scene-e2e/run.sh MODE [options]
Modes:
  --help                    Show all modes and options.
  --dry-run                 Print planned delivery-repository provisioning and the sandbox invocation; creates nothing.
  --run-agent               Run the paid end-to-end candidate workflow from the short prompt to a draft pull request.
  --resume                  Reuse --run-dir and resume its inactive unfinished run (or retry publication only).
  --rescore-from RUN_DIR     Host-only rescore of retained evidence under current evaluator inputs; needs a new --run-dir; never published.
  --calibrate               Maintainer product-rubric calibration (calibrate.mjs); never published or required.
Options:
  --run-dir PATH            Artifact directory; required for --resume and --rescore-from, otherwise generated.
  --runner-dir PATH         Clean Agent Runner checkout (or AGENT_RUNNER_DIR).
  --skills-dir PATH         Clean Agent Skills checkout (or AGENT_SKILLS_DIR).
  --workflow REF            Evaluated workflow logical reference (default ${DEFAULT_WORKFLOW}).
  --lead-cli CLI            claude or codex (required).     --lead-model MODEL     --lead-effort EFFORT
  --crosscheck-cli CLI      claude, codex, or cursor.       --crosscheck-model MODEL  --crosscheck-effort EFFORT
  --implementor-cli CLI     claude or codex.                --implementor-model MODEL --implementor-effort EFFORT
  --tester-cli CLI          claude or codex.                --tester-model MODEL   --tester-effort EFFORT
  --time-limit DURATION     One whole-run elapsed-time limit counting only running time, default 12h; unchanged on resume.
  --stall-window DURATION   Inactivity window before a stalled invocation is stopped, default 45m; unchanged on resume.
  --token-refresh-interval MINUTES  Delivery-token refresh interval, default ${TOKEN_REFRESH.default}, from ${TOKEN_REFRESH.min} to ${TOKEN_REFRESH.max}; not part of the series identity.
Any other role the workflow uses through implement takes --ROLE-cli, --ROLE-model and --ROLE-effort the same way.
Profiles for every role the workflow uses through implement are required; the simulated-user and judge profiles are pinned.
Compare recorded runs (scores are paired only within one series; at least three scored repetitions per group):
  node evals/agent-runner/and-scene-e2e/compare.mjs RUN_DIR RUN_DIR [...]
Human review of a pending run: evals/agent-runner/and-scene-e2e/human-review.sh --run-dir RUN_DIR
Calibration (with --calibrate): --out DIR, --repeats N (>=3, default 3), --calibration-dir DIR, --dry-run.
Host provisioning credentials: AND_SCENE_E2E_APP_ID and AND_SCENE_E2E_APP_KEY_FILE (a GitHub App installed on Codagent-AI with no repositories selected), read from ~/.config/and-scene-e2e/app.json when unset.
Claude auth for the sandbox: ~/.claude/.credentials.json, or CLAUDE_CODE_OAUTH_TOKEN from the environment or Agent Runner's .sandbox-secrets.env (that entry only).
`
const MODES = ['--dry-run', '--run-agent', '--resume', '--calibrate', '--rescore-from']
export function parseArguments(args, env = process.env) {
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  const options = { profiles: Object.fromEntries(DEFAULT_ROLES.map(role => [role, {}])), workflow: DEFAULT_WORKFLOW,
    runnerDir: env.AGENT_RUNNER_DIR ?? '/Users/paul/codagent/agent-runner', skillsDir: env.AGENT_SKILLS_DIR ?? '/Users/paul/codagent/agent-skills',
    timeLimitMs: DEFAULT_TIME_LIMIT_MS, stallWindowMs: DEFAULT_STALL_WINDOW_MS, tokenRefreshMinutes: TOKEN_REFRESH.default }
  let mode
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (MODES.includes(arg)) {
      if (mode) throw new Error('select exactly one mode')
      mode = arg
      if (arg === '--calibrate') throw new Error('--calibrate runs through run.sh (calibrate.mjs), not the candidate controller')
      if (arg === '--rescore-from') {
        const source = args[++index]
        if (!source || source.startsWith('--')) throw new Error('--rescore-from requires a run directory')
        options.rescoreFrom = resolve(source)
      }
      continue
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    const profile = arg.match(/^--([a-z][a-z0-9-]*)-(cli|model|effort)$/)
    if (profile && !PINNED_ROLES.includes(profile[1])) (options.profiles[profile[1]] ??= {})[profile[2]] = value
    else if (arg === '--run-dir') options.runDir = resolve(value)
    else if (arg === '--runner-dir') options.runnerDir = resolve(value)
    else if (arg === '--skills-dir') options.skillsDir = resolve(value)
    else if (arg === '--workflow') options.workflow = value
    else if (arg === '--time-limit') options.timeLimitMs = parseDuration(value, 'time-limit')
    else if (arg === '--stall-window') options.stallWindowMs = parseDuration(value, 'stall-window')
    else if (arg === '--token-refresh-interval') options.tokenRefreshMinutes = parseRefreshInterval(value)
    else throw new Error(`unknown option ${arg}`)
  }
  if (!mode) throw new Error('select --dry-run, --run-agent, --resume, or --rescore-from')
  if (mode === '--resume' && !options.runDir) throw new Error('--resume requires --run-dir')
  if (mode === '--rescore-from' && !options.runDir) throw new Error('--rescore-from requires a new --run-dir')
  options.runDir ??= resolve('artifacts/and-scene-e2e', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  return { ...options, dryRun: mode === '--dry-run', resume: mode === '--resume' }
}
// Every parser option, for help-coverage checks.
export const OPTION_INVENTORY = ['--help', ...MODES, '--run-dir', '--runner-dir', '--skills-dir', '--workflow', '--time-limit', '--stall-window', '--token-refresh-interval',
  ...DEFAULT_ROLES.flatMap(role => ['cli', 'model', 'effort'].map(field => `--${role}-${field}`))]
