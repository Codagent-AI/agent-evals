export const JUDGE_PROFILE = Object.freeze({ version: 1, panel: [
  { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
  { cli: 'codex', model: 'gpt-6-luna', effort: 'high' },
  { cli: 'codex', model: 'gpt-6-luna', effort: 'high' },
], decider: { cli: 'claude', model: 'claude-opus-5-5', effort: 'high' } })
export function validateProfiles(profiles) {
  for (const role of ['lead', 'crosscheck']) {
    for (const field of ['cli', 'model', 'effort']) {
      if (typeof profiles?.[role]?.[field] !== 'string' || !profiles[role][field].trim()) throw new Error(`profiles: missing ${role}.${field}`)
    }
    const allowed = role === 'lead' ? ['claude', 'codex'] : ['claude', 'codex', 'cursor']
    if (!allowed.includes(profiles[role].cli)) throw new Error(`${role} must use ${allowed.join(' or ')}`)
  }
  return profiles
}
// JSON strings are valid YAML scalars and cannot introduce config fields.
// This is the sandbox's global config: Runner refuses active_profile there and
// selects the `default` profile set. A role without `extends` must name its mode;
// the lead is interactive so the external user answers its turns.
const DEFAULT_MODES = { lead: 'interactive', crosscheck: 'autonomous' }
export function runnerConfig(profiles) {
  validateProfiles(profiles)
  return `profiles:\n  default:\n    agents:\n${Object.entries(DEFAULT_MODES).map(([role, mode]) => `      ${role}:\n        default_mode: ${mode}\n${['cli', 'model', 'effort'].map(key => `        ${key}: ${JSON.stringify(profiles[role][key])}\n`).join('')}`).join('')}`
}
export const RUNNER_SETTINGS = 'autonomous_permission_mode: yolo\n'
