// Independent lead-agent, crosscheck, task-implementor, and tester profiles.
//
// Each role independently selects a CLI adapter, model, and effort, and maps
// onto the Agent Runner agent of the same name within a single end-to-end run
// of the evaluated workflow. The harness does not depend on which steps use
// which agent, and the roles are never scored separately.

export const ROLE_AGENTS = {
  lead: 'lead',
  crosscheck: 'crosscheck',
  implementor: 'implementor',
  tester: 'tester',
}

const ROLES = Object.keys(ROLE_AGENTS)

export const PROFILE_FIELDS = ['cli', 'model', 'effort']

const NOT_APPLICABLE = 'not-applicable'
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/

// The planning lead calls the crosscheck agent through `call_agent`. Nothing
// has yet shown a Cursor lead can make that call inside the evaluation
// sandbox, so a new run rejects it before any model executes.
const UNVERIFIED_LEAD_CLIS = new Set(['cursor'])

function validateOne(role, profile, capabilities, { newRun }) {
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
  if (newRun && role === 'lead' && UNVERIFIED_LEAD_CLIS.has(profile.cli)) {
    errors.push({
      role,
      field: 'cli',
      value: profile.cli,
      message: `${profile.cli} is not supported for the lead role: Cursor agent calls are not yet verified in the evaluation sandbox`,
    })
  }
  if (!adapter.roles.includes(agent)) {
    errors.push({
      role,
      field: 'role',
      value: profile.cli,
      message: `${profile.cli} cannot run the ${agent} role autonomously`,
    })
  }
  // Model availability belongs to Agent Runner and the selected CLI. The eval
  // harness only enforces a safe, explicit identifier so newly released or
  // locally configured models do not require a harness update.
  if (typeof profile.model !== 'string' || !MODEL_IDENTIFIER.test(profile.model)) {
    errors.push({
      role,
      field: 'model',
      value: profile.model ?? null,
      message: `invalid model identifier for ${profile.cli}: ${profile.model ?? ''}`,
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

// `importedRoles` names the roles an imported (rescored) run recorded. Only
// those are validated, against capabilities alone, so a source recorded before
// a role existed is not given an invented profile.
export function validateRoleProfiles({
  lead,
  crosscheck,
  implementor,
  tester,
  capabilities,
  mode = 'agent-runner',
  importedRoles = null,
}) {
  // A reference baseline evaluates an existing candidate without invoking
  // Agent Runner, so neither role applies.
  if (mode === 'reference-baseline') {
    return {
      ok: true,
      applicable: false,
      errors: [],
      profiles: Object.fromEntries(ROLES.map((role) => [role, NOT_APPLICABLE])),
    }
  }

  const supplied = { lead, crosscheck, implementor, tester }
  const roles = importedRoles ? ROLES.filter((role) => importedRoles.includes(role)) : ROLES
  const newRun = !importedRoles
  const results = Object.fromEntries(
    roles.map((role) => [role, validateOne(role, supplied[role], capabilities, { newRun })]),
  )
  const errors = roles.flatMap((role) => results[role].errors)

  return {
    ok: errors.length === 0,
    applicable: true,
    errors,
    profiles: Object.fromEntries(
      roles.map((role) => [role, results[role].profile ?? null]),
    ),
  }
}

// The evaluation profile is materialized only inside the disposable evaluation
// environment; it neither reads nor writes the user's global or project config.
export function renderEvalConfig(profiles) {
  const lines = ['active_profile: eval', 'profiles:', '  eval:', '    agents:']
  for (const role of ROLES) {
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

export function normalizeRoleProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object') return profiles
  if (profiles.tester != null || profiles.reviewer == null) return profiles
  const { reviewer, ...rest } = profiles
  return { ...rest, tester: reviewer }
}

export function compareRoleSelections(recorded, requested) {
  return ROLES.flatMap((role) => {
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
const REPORTED_ROLES = {
  lead: 'lead',
  crosscheck: 'crosscheck',
  implementor: 'implementor',
  tester: 'tester',
  'lead-agent': 'lead',
  'task-implementor': 'implementor',
  'acceptance-tester': 'tester',
  'acceptance-reviewer': 'tester',
}

// Configured settings are never presented as observed ones. An attempt without
// complete evidence is marked incomplete instead.
// A role absent from the profiles (a legacy run recorded before it existed) is
// not reported. A configured role with no attempts is reported not invoked.
export function reconcileRoleAttempts(profiles, attempts = []) {
  const configuredRoles = ROLES.filter((role) => Object.hasOwn(profiles, role))
  const applicable = configuredRoles.every((role) => profiles[role] !== NOT_APPLICABLE)
  const roles = Object.fromEntries(
    configuredRoles.map((role) => [role, { configured: profiles[role], invocation: null, attempts: [] }]),
  )
  const mismatches = []
  let incomplete = false

  for (const attempt of attempts) {
    const role = AGENT_ROLES[attempt.agent] ?? REPORTED_ROLES[attempt.agent_role]
    if (!role || !roles[role]) continue
    const observed = {
      role,
      agent: attempt.agent ?? attempt.agent_role,
      cli: attempt.cli ?? null,
      provider: attempt.provider ?? null,
      model: attempt.model ?? null,
      effort: attempt.effort ?? null,
      session: attempt.session ?? null,
      step: attempt.step ?? null,
      attempt: attempt.attempt ?? attempt.attempt_id ?? null,
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

  for (const entry of Object.values(roles)) {
    if (entry.configured === NOT_APPLICABLE) entry.invocation = NOT_APPLICABLE
    else entry.invocation = entry.attempts.length > 0 ? 'invoked' : 'not-invoked'
  }

  return { applicable, roles, mismatches, incomplete }
}
