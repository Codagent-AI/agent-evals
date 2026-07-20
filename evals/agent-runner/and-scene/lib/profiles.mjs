// Independent lead-agent and task-implementor role profiles.
//
// Each role independently selects a CLI adapter, model, and effort. The two
// roles map onto the `planner` and `implementor` agents of a single
// end-to-end `implement-change2` run; they are never scored separately.

export const ROLE_AGENTS = { lead: 'planner', implementor: 'implementor' }

export const PROFILE_FIELDS = ['cli', 'model', 'effort']

const NOT_APPLICABLE = 'not-applicable'

function validateOne(role, profile, capabilities) {
  const agent = ROLE_AGENTS[role]
  if (!profile) {
    return { errors: [{ role, field: 'profile', value: null, message: `${role} profile is required` }] }
  }

  const errors = []
  const adapter = capabilities.clis?.[profile.cli]
  if (!adapter) {
    errors.push({ role, field: 'cli', value: profile.cli ?? null, message: `unsupported CLI adapter: ${profile.cli}` })
    return { errors }
  }
  // A CLI that cannot drive this workflow role autonomously fails validation
  // before any implementation workflow is launched.
  if (!adapter.roles.includes(agent)) {
    errors.push({
      role,
      field: 'role',
      value: profile.cli,
      message: `${profile.cli} cannot run the ${agent} role autonomously`,
    })
  }
  if (!adapter.models.includes(profile.model)) {
    errors.push({
      role,
      field: 'model',
      value: profile.model ?? null,
      message: `unavailable model for ${profile.cli}: ${profile.model}`,
    })
  }
  if (!adapter.efforts.includes(profile.effort)) {
    errors.push({
      role,
      field: 'effort',
      value: profile.effort ?? null,
      message: `invalid effort for ${profile.cli}: ${profile.effort}`,
    })
  }

  if (errors.length > 0) return { errors }
  return {
    errors: [],
    profile: { cli: profile.cli, model: profile.model, effort: profile.effort, agent },
  }
}

export function validateRoleProfiles({ lead, implementor, capabilities, mode = 'agent-runner' }) {
  // A reference baseline evaluates an existing candidate without invoking
  // Agent Runner, so neither role applies.
  if (mode === 'reference-baseline') {
    return {
      ok: true,
      applicable: false,
      errors: [],
      profiles: { lead: NOT_APPLICABLE, implementor: NOT_APPLICABLE },
    }
  }

  const results = {
    lead: validateOne('lead', lead, capabilities),
    implementor: validateOne('implementor', implementor, capabilities),
  }
  const errors = [...results.lead.errors, ...results.implementor.errors]

  return {
    ok: errors.length === 0,
    applicable: true,
    errors,
    profiles: { lead: results.lead.profile ?? null, implementor: results.implementor.profile ?? null },
  }
}

// The evaluation profile is materialized only inside the disposable evaluation
// environment; it neither reads nor writes the user's global or project config.
export function renderEvalConfig(profiles) {
  const lines = ['active_profile: eval', 'profiles:', '  eval:', '    agents:']
  for (const role of ['lead', 'implementor']) {
    const profile = profiles[role]
    if (!profile || profile === NOT_APPLICABLE) continue
    lines.push(`      ${profile.agent}:`)
    lines.push('        default_mode: autonomous')
    lines.push(`        cli: ${profile.cli}`)
    lines.push(`        model: ${profile.model}`)
    lines.push(`        effort: ${profile.effort}`)
  }
  return `${lines.join('\n')}\n`
}

// Agent Runner's conservative Codex mode shells out to bubblewrap. The eval is
// already isolated by Agent Runner's disposable sandbox, where nested user
// namespaces are unavailable, so the sandbox's private home opts autonomous
// agents into direct command execution.
export function renderEvalSettings() {
  return 'autonomous_permission_mode: yolo\n'
}

export function compareRoleSelections(recorded, requested) {
  return ['lead', 'implementor'].flatMap((role) => {
    const before = recorded?.[role]
    const after = requested?.[role]
    if (before === after) return []
    if (!before || !after || before === NOT_APPLICABLE || after === NOT_APPLICABLE) {
      return [{ role, field: 'profile', recorded: before ?? null, requested: after ?? null }]
    }
    return PROFILE_FIELDS.flatMap((field) => (
      before[field] === after[field]
        ? []
        : [{ role, field, recorded: before[field], requested: after[field] }]
    ))
  })
}

const AGENT_ROLES = Object.fromEntries(Object.entries(ROLE_AGENTS).map(([role, agent]) => [agent, role]))

// Configured settings are never presented as observed ones. An attempt without
// complete evidence is marked incomplete instead.
export function reconcileRoleAttempts(profiles, attempts = []) {
  const applicable = profiles.lead !== NOT_APPLICABLE && profiles.implementor !== NOT_APPLICABLE
  const roles = {
    lead: { configured: profiles.lead, attempts: [] },
    implementor: { configured: profiles.implementor, attempts: [] },
  }
  const mismatches = []
  let incomplete = false

  for (const attempt of attempts) {
    const role = AGENT_ROLES[attempt.agent]
    if (!role) continue
    const observed = {
      role,
      agent: attempt.agent,
      cli: attempt.cli ?? null,
      provider: attempt.provider ?? null,
      model: attempt.model ?? null,
      effort: attempt.effort ?? null,
      session: attempt.session ?? null,
      step: attempt.step ?? null,
      attempt: attempt.attempt ?? null,
    }
    const configured = roles[role].configured
    const complete = PROFILE_FIELDS.every((field) => observed[field] !== null)
    if (!complete) incomplete = true

    let attemptMismatches = []
    if (complete && configured && configured !== NOT_APPLICABLE) {
      attemptMismatches = PROFILE_FIELDS.flatMap((field) => (
        configured[field] === observed[field]
          ? []
          : [{
            role,
            field,
            configured: configured[field],
            observed: observed[field],
            attempt: observed.attempt,
            session: observed.session,
            step: observed.step,
          }]
      ))
      mismatches.push(...attemptMismatches)
    }

    roles[role].attempts.push({
      observed,
      complete,
      matches_configuration: complete ? attemptMismatches.length === 0 : null,
      mismatches: attemptMismatches,
    })
  }

  return { applicable, roles, mismatches, incomplete }
}
