import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ROLE_AGENTS,
  compareRoleSelections,
  reconcileRoleAttempts,
  renderEvalConfig,
  renderEvalSettings,
  validateRoleProfiles,
} from '../evals/agent-runner/and-scene/lib/profiles.mjs'

const capabilities = {
  clis: {
    claude: { models: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'], roles: ['planner', 'implementor'] },
    codex: { models: ['gpt-5'], efforts: ['medium', 'high'], roles: ['implementor'] },
  },
}

const lead = { cli: 'claude', model: 'opus', effort: 'high' }
const implementor = { cli: 'claude', model: 'sonnet', effort: 'medium' }

test('roles map to the implement-change2 planner and implementor agents', () => {
  assert.deepEqual(ROLE_AGENTS, { lead: 'planner', implementor: 'implementor' })
})

test('independently selected profiles are accepted and normalized', () => {
  const result = validateRoleProfiles({ lead, implementor, capabilities })

  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.profiles.lead, { cli: 'claude', model: 'opus', effort: 'high', agent: 'planner' })
  assert.deepEqual(result.profiles.implementor, {
    cli: 'claude', model: 'sonnet', effort: 'medium', agent: 'implementor',
  })
})

test('two identical profiles remain two independently declared selections', () => {
  const result = validateRoleProfiles({ lead, implementor: { ...lead }, capabilities })

  assert.equal(result.ok, true)
  assert.notEqual(result.profiles.lead.agent, result.profiles.implementor.agent)
  assert.equal(result.profiles.lead.model, result.profiles.implementor.model)
})

test('a missing lead profile is rejected before Agent Runner starts', () => {
  const result = validateRoleProfiles({ implementor, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field]), [['lead', 'profile']])
})

test('a missing implementor profile is rejected before Agent Runner starts', () => {
  const result = validateRoleProfiles({ lead, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field]), [['implementor', 'profile']])
})

test('a reference baseline needs no role profiles and reports them not applicable', () => {
  const result = validateRoleProfiles({ capabilities, mode: 'reference-baseline' })

  assert.equal(result.ok, true)
  assert.equal(result.applicable, false)
  assert.equal(result.profiles.lead, 'not-applicable')
  assert.equal(result.profiles.implementor, 'not-applicable')
})

test('an unsupported lead CLI names the failing role and field', () => {
  const result = validateRoleProfiles({ lead: { ...lead, cli: 'gemini' }, implementor, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    { role: 'lead', field: 'cli', value: 'gemini', message: 'unsupported CLI adapter: gemini' },
  ])
})

test('a CLI that cannot run the planner role autonomously is rejected for the lead', () => {
  const result = validateRoleProfiles({ lead: { ...lead, cli: 'codex', model: 'gpt-5' }, implementor, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field]), [['lead', 'role']])
  assert.match(result.errors[0].message, /planner/)
})

test('an unavailable implementor model names the failing role and field', () => {
  const result = validateRoleProfiles({ lead, implementor: { ...implementor, model: 'opus-9' }, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    { role: 'implementor', field: 'model', value: 'opus-9', message: 'unavailable model for claude: opus-9' },
  ])
})

test('an invalid implementor effort names the failing role and field', () => {
  const result = validateRoleProfiles({ lead, implementor: { ...implementor, effort: 'turbo' }, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field, error.value]), [
    ['implementor', 'effort', 'turbo'],
  ])
})

test('renderEvalConfig materializes both roles autonomously in an eval-scoped profile', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, capabilities })

  const config = renderEvalConfig(profiles)

  assert.match(config, /^active_profile: eval$/m)
  assert.match(config, /^ {6}planner:$/m)
  assert.match(config, /^ {6}implementor:$/m)
  assert.equal(config.match(/default_mode: autonomous/g).length, 2)
  assert.match(config, /planner:\n {8}default_mode: autonomous\n {8}cli: claude\n {8}model: opus\n {8}effort: high/)
  assert.match(config, /implementor:\n {8}default_mode: autonomous\n {8}cli: claude\n {8}model: sonnet\n {8}effort: medium/)
})

test('renderEvalConfig never inherits host or project Agent Runner settings', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, capabilities })

  const config = renderEvalConfig(profiles)

  assert.ok(!config.includes('include'), config)
  assert.ok(!config.includes('~'), config)
  assert.equal(config.match(/^profiles:$/gm).length, 1)
})

test('the disposable Agent Runner home grants autonomous agents container-level authority', () => {
  assert.equal(renderEvalSettings(), 'autonomous_permission_mode: yolo\n')
})

test('resume with matching selections reports no mismatch', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, capabilities })

  assert.deepEqual(compareRoleSelections(profiles, validateRoleProfiles({
    lead: { ...lead }, implementor: { ...implementor }, capabilities,
  }).profiles), [])
})

test('resume that changes one profile identifies the role and field', () => {
  const recorded = validateRoleProfiles({ lead, implementor, capabilities }).profiles
  const requested = validateRoleProfiles({
    lead: { ...lead, model: 'sonnet' }, implementor, capabilities,
  }).profiles

  assert.deepEqual(compareRoleSelections(recorded, requested), [
    { role: 'lead', field: 'model', recorded: 'opus', requested: 'sonnet' },
  ])
})

test('an observed attempt matching its configuration is linked to the role', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, capabilities })

  const report = reconcileRoleAttempts(profiles, [
    { agent: 'planner', cli: 'claude', provider: 'anthropic', model: 'opus', effort: 'high', session: 'lead-agent', step: 'plan', attempt: 1 },
  ])

  assert.equal(report.roles.lead.attempts[0].matches_configuration, true)
  assert.deepEqual(report.roles.lead.attempts[0].mismatches, [])
  assert.equal(report.roles.lead.configured.model, 'opus')
  assert.equal(report.incomplete, false)
  assert.deepEqual(report.mismatches, [])
})

test('an effective setting differing from configuration preserves both values', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, capabilities })

  const report = reconcileRoleAttempts(profiles, [
    { agent: 'implementor', cli: 'claude', provider: 'anthropic', model: 'opus', effort: 'medium', session: 'task-1', step: 'implement', attempt: 1 },
  ])

  assert.deepEqual(report.mismatches, [
    { role: 'implementor', field: 'model', configured: 'sonnet', observed: 'opus', attempt: 1, session: 'task-1', step: 'implement' },
  ])
  assert.equal(report.roles.implementor.attempts[0].matches_configuration, false)
  assert.equal(report.roles.implementor.attempts[0].observed.model, 'opus')
  assert.equal(report.roles.implementor.configured.model, 'sonnet')
})

test('missing effective evidence is incomplete and is never inferred from configuration', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, capabilities })

  const report = reconcileRoleAttempts(profiles, [
    { agent: 'implementor', session: 'task-1', step: 'implement', attempt: 1 },
  ])

  const attempt = report.roles.implementor.attempts[0]
  assert.equal(attempt.complete, false)
  assert.equal(attempt.observed.model, null)
  assert.equal(attempt.matches_configuration, null)
  assert.equal(report.incomplete, true)
  assert.deepEqual(report.mismatches, [])
})

test('every retried and resumed attempt is retained under its role', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, capabilities })

  const report = reconcileRoleAttempts(profiles, [
    { agent: 'implementor', cli: 'claude', provider: 'anthropic', model: 'sonnet', effort: 'medium', session: 's', step: 'implement', attempt: 1 },
    { agent: 'implementor', cli: 'claude', provider: 'anthropic', model: 'sonnet', effort: 'medium', session: 's', step: 'implement', attempt: 2 },
    { agent: 'planner', cli: 'claude', provider: 'anthropic', model: 'opus', effort: 'high', session: 'lead-agent', step: 'simplify', attempt: 1 },
  ])

  assert.deepEqual(report.roles.implementor.attempts.map((a) => a.observed.attempt), [1, 2])
  assert.equal(report.roles.lead.attempts.length, 1)
})

test('a reference baseline reports both roles not applicable', () => {
  const { profiles } = validateRoleProfiles({ capabilities, mode: 'reference-baseline' })

  const report = reconcileRoleAttempts(profiles, [])

  assert.equal(report.applicable, false)
  assert.equal(report.roles.lead.configured, 'not-applicable')
  assert.equal(report.incomplete, false)
})
