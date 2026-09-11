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
    claude: {
      efforts: ['low', 'medium', 'high'],
      roles: ['lead', 'implementor', 'tester'],
    },
    codex: { efforts: ['medium', 'high'], roles: ['implementor'] },
    cursor: {
      efforts: ['low', 'medium', 'high'],
      roles: ['lead', 'implementor', 'tester'],
    },
  },
}

const lead = { cli: 'claude', model: 'opus', effort: 'high' }
const implementor = { cli: 'claude', model: 'sonnet', effort: 'medium' }
const tester = { cli: 'claude', model: 'opus', effort: 'high' }

test('roles map to the core workflow lead, implementor, and tester agents', () => {
  assert.deepEqual(ROLE_AGENTS, { lead: 'lead', implementor: 'implementor', tester: 'tester' })
})

test('independently selected profiles are accepted and normalized', () => {
  const result = validateRoleProfiles({ lead, implementor, tester, capabilities })

  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.profiles.lead, { cli: 'claude', model: 'opus', effort: 'high', agent: 'lead' })
  assert.deepEqual(result.profiles.implementor, {
    cli: 'claude', model: 'sonnet', effort: 'medium', agent: 'implementor',
  })
  assert.deepEqual(result.profiles.tester, {
    cli: 'claude', model: 'opus', effort: 'high', agent: 'tester',
  })
})

test('identical profiles remain independently declared selections', () => {
  const result = validateRoleProfiles({ lead, implementor: { ...lead }, tester: { ...lead }, capabilities })

  assert.equal(result.ok, true)
  assert.notEqual(result.profiles.lead.agent, result.profiles.implementor.agent)
  assert.notEqual(result.profiles.lead.agent, result.profiles.tester.agent)
  assert.equal(result.profiles.lead.model, result.profiles.implementor.model)
  assert.equal(result.profiles.lead.model, result.profiles.tester.model)
})

test('a missing lead profile is rejected before Agent Runner starts', () => {
  const result = validateRoleProfiles({ implementor, tester, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field]), [['lead', 'profile']])
})

test('a missing implementor profile is rejected before Agent Runner starts', () => {
  const result = validateRoleProfiles({ lead, tester, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field]), [['implementor', 'profile']])
})

test('a missing tester profile is rejected before Agent Runner starts', () => {
  const result = validateRoleProfiles({ lead, implementor, capabilities })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field]), [['tester', 'profile']])
})

test('a reference baseline needs no role profiles and reports them not applicable', () => {
  const result = validateRoleProfiles({ capabilities, mode: 'reference-baseline' })

  assert.equal(result.ok, true)
  assert.equal(result.applicable, false)
  assert.equal(result.profiles.lead, 'not-applicable')
  assert.equal(result.profiles.implementor, 'not-applicable')
  assert.equal(result.profiles.tester, 'not-applicable')
})

test('an unsupported lead CLI names the failing role and field', () => {
  const result = validateRoleProfiles({
    lead: { ...lead, cli: 'gemini' }, implementor, tester, capabilities,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    { role: 'lead', field: 'cli', value: 'gemini', message: 'unsupported CLI adapter: gemini' },
  ])
})

test('a CLI that cannot run the lead role autonomously is rejected for the lead', () => {
  const result = validateRoleProfiles({
    lead: { ...lead, cli: 'codex', model: 'gpt-5' }, implementor, tester, capabilities,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field]), [['lead', 'role']])
  assert.match(result.errors[0].message, /lead/)
})

test('new model identifiers are accepted without a harness capability update', () => {
  const result = validateRoleProfiles({
    lead, implementor: { ...implementor, model: 'gpt-6-astra' }, tester, capabilities,
  })

  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.profiles.implementor.model, 'gpt-6-astra')
})

test('Cursor accepts family model identifiers as well as versioned ones', () => {
  const family = validateRoleProfiles({
    lead: { cli: 'cursor', model: 'grok', effort: 'high' },
    implementor: { cli: 'cursor', model: 'grok-4.6', effort: 'medium' },
    tester: { cli: 'cursor', model: 'composer', effort: 'high' },
    capabilities,
  })
  const versioned = validateRoleProfiles({
    lead: { cli: 'cursor', model: 'cursor-grok-4.6-high', effort: 'high' },
    implementor: { cli: 'cursor', model: 'composer-2.5', effort: 'medium' },
    tester: { cli: 'cursor', model: 'gpt-5.6-sol-high', effort: 'high' },
    capabilities,
  })

  assert.equal(family.ok, true, JSON.stringify(family.errors))
  assert.equal(family.profiles.lead.model, 'grok')
  assert.equal(family.profiles.implementor.model, 'grok-4.6')
  assert.equal(family.profiles.tester.model, 'composer')
  assert.equal(versioned.ok, true, JSON.stringify(versioned.errors))
  assert.equal(versioned.profiles.lead.model, 'cursor-grok-4.6-high')
})

test('renderEvalConfig passes Cursor family models through unchanged', () => {
  const { profiles } = validateRoleProfiles({
    lead: { cli: 'cursor', model: 'grok', effort: 'high' },
    implementor: { cli: 'cursor', model: 'grok-4.6', effort: 'medium' },
    tester: { cli: 'claude', model: 'opus', effort: 'high' },
    capabilities,
  })

  const config = renderEvalConfig(profiles)

  assert.match(config, /lead:\n {8}default_mode: autonomous\n {8}cli: cursor\n {8}model: grok\n {8}effort: high/)
  assert.match(config, /implementor:\n {8}default_mode: autonomous\n {8}cli: cursor\n {8}model: grok-4\.6\n {8}effort: medium/)
})

test('an invalid implementor effort names the failing role and field', () => {
  const result = validateRoleProfiles({
    lead, implementor: { ...implementor, effort: 'turbo' }, tester, capabilities,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => [error.role, error.field, error.value]), [
    ['implementor', 'effort', 'turbo'],
  ])
})

test('renderEvalConfig materializes all workflow roles autonomously in an eval-scoped profile', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, tester, capabilities })

  const config = renderEvalConfig(profiles)

  assert.match(config, /^active_profile: eval$/m)
  assert.match(config, /^ {6}lead:$/m)
  assert.match(config, /^ {6}implementor:$/m)
  assert.match(config, /^ {6}tester:$/m)
  assert.equal(config.match(/default_mode: autonomous/g).length, 3)
  assert.match(config, /lead:\n {8}default_mode: autonomous\n {8}cli: claude\n {8}model: opus\n {8}effort: high/)
  assert.match(config, /implementor:\n {8}default_mode: autonomous\n {8}cli: claude\n {8}model: sonnet\n {8}effort: medium/)
  assert.match(config, /tester:\n {8}default_mode: autonomous\n {8}cli: claude\n {8}model: opus\n {8}effort: high/)
})

test('renderEvalConfig never inherits host or project Agent Runner settings', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, tester, capabilities })

  const config = renderEvalConfig(profiles)

  assert.ok(!config.includes('include'), config)
  assert.ok(!config.includes('~'), config)
  assert.equal(config.match(/^profiles:$/gm).length, 1)
})

test('the disposable Agent Runner home grants autonomous agents container-level authority', () => {
  assert.equal(renderEvalSettings(), 'autonomous_permission_mode: yolo\n')
})

test('resume with matching selections reports no mismatch', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, tester, capabilities })

  assert.deepEqual(compareRoleSelections(profiles, validateRoleProfiles({
    lead: { ...lead }, implementor: { ...implementor }, tester: { ...tester }, capabilities,
  }).profiles), [])
})

test('resume that changes one profile identifies the role and field', () => {
  const recorded = validateRoleProfiles({ lead, implementor, tester, capabilities }).profiles
  const requested = validateRoleProfiles({
    lead: { ...lead, model: 'sonnet' }, implementor, tester, capabilities,
  }).profiles

  assert.deepEqual(compareRoleSelections(recorded, requested), [
    { role: 'lead', field: 'model', recorded: 'opus', requested: 'sonnet' },
  ])
})

test('an observed attempt matching its configuration is linked to the role', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, tester, capabilities })

  const report = reconcileRoleAttempts(profiles, [
    { agent: 'lead', cli: 'claude', provider: 'anthropic', model: 'opus', effort: 'high', session: 'lead-agent', step: 'plan', attempt: 1 },
  ])

  assert.equal(report.roles.lead.attempts[0].matches_configuration, true)
  assert.deepEqual(report.roles.lead.attempts[0].mismatches, [])
  assert.equal(report.roles.lead.configured.model, 'opus')
  assert.equal(report.incomplete, false)
  assert.deepEqual(report.mismatches, [])
})

test('Runner schema-v2 profile role names reconcile without legacy aliases', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, tester, capabilities })

  const report = reconcileRoleAttempts(profiles, [{
    agent_role: 'implementor',
    cli: 'claude',
    provider: 'anthropic',
    model: 'sonnet',
    effort: 'medium',
    session: 'task-1',
    step: 'generate-code',
    attempt: 1,
  }])

  assert.equal(report.roles.implementor.attempts.length, 1)
  assert.equal(report.roles.implementor.attempts[0].matches_configuration, true)
})

test('an effective setting differing from configuration preserves both values', () => {
  const { profiles } = validateRoleProfiles({ lead, implementor, tester, capabilities })

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
  const { profiles } = validateRoleProfiles({ lead, implementor, tester, capabilities })

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
  const { profiles } = validateRoleProfiles({ lead, implementor, tester, capabilities })

  const report = reconcileRoleAttempts(profiles, [
    { agent: 'implementor', cli: 'claude', provider: 'anthropic', model: 'sonnet', effort: 'medium', session: 's', step: 'implement', attempt: 1 },
    { agent: 'implementor', cli: 'claude', provider: 'anthropic', model: 'sonnet', effort: 'medium', session: 's', step: 'implement', attempt: 2 },
    { agent: 'lead', cli: 'claude', provider: 'anthropic', model: 'opus', effort: 'high', session: 'lead-agent', step: 'simplify', attempt: 1 },
    { agent: 'tester', cli: 'claude', provider: 'anthropic', model: 'opus', effort: 'high', session: 'acceptance-tester', step: 'prepare-acceptance', attempt: 1 },
  ])

  assert.deepEqual(report.roles.implementor.attempts.map((a) => a.observed.attempt), [1, 2])
  assert.equal(report.roles.lead.attempts.length, 1)
  assert.equal(report.roles.tester.attempts.length, 1)
})

test('a reference baseline reports every workflow role not applicable', () => {
  const { profiles } = validateRoleProfiles({ capabilities, mode: 'reference-baseline' })

  const report = reconcileRoleAttempts(profiles, [])

  assert.equal(report.applicable, false)
  assert.equal(report.roles.lead.configured, 'not-applicable')
  assert.equal(report.roles.tester.configured, 'not-applicable')
  assert.equal(report.incomplete, false)
})
