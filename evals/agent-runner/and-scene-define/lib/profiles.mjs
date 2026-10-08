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
export function runnerConfig(profiles) {
  validateProfiles(profiles)
  return `active_profile: eval\nprofiles:\n  eval:\n    agents:\n${['lead', 'crosscheck'].map(role => `      ${role}:\n${Object.entries(profiles[role]).map(([key, value]) => `        ${key}: ${JSON.stringify(value)}\n`).join('')}`).join('')}`
}
export const RUNNER_SETTINGS = 'autonomous_permission_mode: yolo\n'
