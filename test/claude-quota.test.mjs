import assert from 'node:assert/strict'
import { test } from 'node:test'

const quotaModule = await import(
  '../evals/agent-runner/and-scene/lib/claude-quota.mjs'
).catch(() => ({}))

test('detects a Claude implementor limit and its explicit UTC reset', () => {
  assert.equal(typeof quotaModule.detectClaudeQuotaReset, 'function')

  const audit = [
    '2026-08-30T19:29:47.462986506Z [implement-tasks:0, implement-single-task, sub:implement-task, generate-code] step_end '
      + JSON.stringify({
        exit_code: 1,
        identity: { cli: 'claude', role: 'implementor' },
        stdout: "You've hit your org's monthly spend limit · your session limit resets 10pm (UTC)",
        usage: { provider: 'anthropic', model: '<synthetic>' },
      }),
  ].join('\n')

  const detected = quotaModule.detectClaudeQuotaReset({
    audit,
    now: new Date('2026-08-30T19:30:00.000Z'),
  })

  assert.equal(detected?.role, 'implementor')
  assert.equal(detected?.reset_at, '2026-08-30T22:00:00.000Z')
})

test('detects and attributes a Claude lead-agent limit', () => {
  assert.equal(typeof quotaModule.detectClaudeQuotaReset, 'function')

  const audit = [
    '2026-08-30T01:00:00.000000000Z [prepare-acceptance] step_end '
      + JSON.stringify({
        exit_code: 1,
        identity: { cli: 'claude', role: 'lead' },
        stdout: "You've hit your org's monthly spend limit · your session limit resets 4:30am (UTC)",
        usage: { provider: 'anthropic', model: '<synthetic>' },
      }),
  ].join('\n')

  const detected = quotaModule.detectClaudeQuotaReset({
    audit,
    now: new Date('2026-08-30T01:01:00.000Z'),
  })

  assert.equal(detected?.role, 'lead')
  assert.equal(detected?.reset_at, '2026-08-30T04:30:00.000Z')
})

test('detects a nested Claude acceptance-tester limit from the durable lead report', () => {
  assert.equal(typeof quotaModule.detectClaudeQuotaReset, 'function')

  const audit = [
    '2026-08-30T00:51:11.451380258Z [prepare-acceptance] step_end '
      + JSON.stringify({
        exit_code: 0,
        identity: { cli: 'codex', role: 'lead' },
        stdout: [
          'The child session transcript reveals the precise impediment: the tester profile is backed by Claude,',
          'and the provider rejected both calls for an organization spend/rate limit, with zero inference.',
          'Provider reset was reported for 04:30 UTC.',
        ].join(' '),
      }),
  ].join('\n')

  const detected = quotaModule.detectClaudeQuotaReset({
    audit,
    now: new Date('2026-08-30T00:52:00.000Z'),
  })

  assert.equal(detected?.role, 'tester')
  assert.equal(detected?.reset_at, '2026-08-30T04:30:00.000Z')
})

test('does not wait for generic failures, non-Claude limits, missing reset times, or implausible waits', () => {
  assert.equal(typeof quotaModule.detectClaudeQuotaReset, 'function')

  const now = new Date('2026-08-30T00:00:00.000Z')
  for (const audit of [
    'HTTP 429 from an unrelated service; resets 1am (UTC)',
    'Claude failed with an organization spend limit but supplied no reset time',
    "You've hit your org's monthly spend limit · your session limit resets 10pm (UTC)",
  ]) {
    assert.equal(quotaModule.detectClaudeQuotaReset({ audit, now }), null)
  }
})

test('waits until just after reset and reports the durable quota event', async () => {
  assert.equal(typeof quotaModule.waitForClaudeQuotaReset, 'function')

  const delays = []
  const messages = []
  const result = await quotaModule.waitForClaudeQuotaReset({
    audit: [
      '2026-08-30T19:29:47.462986506Z [implement-tasks:0, generate-code] step_end ',
      JSON.stringify({
        identity: { cli: 'claude', role: 'implementor' },
        stdout: "You've hit your org's monthly spend limit · your session limit resets 10pm (UTC)",
      }),
    ].join(''),
    now: () => new Date('2026-08-30T19:30:00.000Z'),
    sleep: async (milliseconds) => { delays.push(milliseconds) },
    log: (message) => { messages.push(message) },
  })

  assert.deepEqual(delays, [9_060_000])
  assert.equal(result.waited, true)
  assert.equal(result.reset_at, '2026-08-30T22:00:00.000Z')
  assert.match(messages.join('\n'), /Claude implementor quota.*22:00:00\.000Z/)
})

function quotaAudit(payload, prefix = '[review-tasks] step_end ') {
  return `2026-08-30T19:29:47.462986506Z ${prefix}${JSON.stringify({
    exit_code: 1,
    stdout: "You've hit your org's monthly spend limit · your session limit resets 10pm (UTC)",
    ...payload,
  })}`
}

const beforeReset = new Date('2026-08-30T19:30:00.000Z')

test('a Claude tester limit in a renamed session is attributed by its recorded agent', () => {
  const audit = quotaAudit(
    { session: 'acceptance-review', identity: { cli: 'claude', role: 'tester' } },
    '[verify > acceptance-review] step_end ',
  )

  const detected = quotaModule.detectClaudeQuotaReset({ audit, now: beforeReset })

  assert.equal(detected?.role, 'tester')
  assert.equal(detected?.reset_at, '2026-08-30T22:00:00.000Z')
})

test('a Claude crosscheck quota event is attributed to the crosscheck role', () => {
  const audit = quotaAudit({
    kind: 'agent-call',
    identity: { cli: 'claude', role: 'crosscheck' },
    usage: { provider: 'anthropic' },
  })

  const detected = quotaModule.detectClaudeQuotaReset({ audit, now: beforeReset })

  assert.equal(detected?.role, 'crosscheck')
})

test('a misleading acceptance-tester session name is not evidence of Claude identity', () => {
  const audit = quotaAudit(
    { session: 'acceptance-tester', identity: { cli: 'codex', role: 'lead' }, usage: { provider: 'openai' } },
    '[prepare-acceptance > acceptance-tester] step_end ',
  )

  assert.equal(quotaModule.detectClaudeQuotaReset({ audit, now: beforeReset }), null)
})

test('a Claude session name does not supply the role when no agent is recorded', () => {
  const audit = quotaAudit(
    { session: 'acceptance-tester', identity: { cli: 'claude' } },
    '[prepare-acceptance > acceptance-tester] step_end ',
  )

  const detected = quotaModule.detectClaudeQuotaReset({ audit, now: beforeReset })

  assert.notEqual(detected, null)
  assert.equal(detected.role, null)
})
