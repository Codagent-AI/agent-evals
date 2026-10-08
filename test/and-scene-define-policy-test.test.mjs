import { makeTempDir } from './temp-dir.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POLICY_CASES, runPolicyTest, assessPolicyReply } from '../evals/agent-runner/and-scene-define/policy-test.mjs'
test('policy diagnostic has all disclosure and decision cases and three trials', async t => {
  const outputDir = await makeTempDir(join(tmpdir(), 'policy-test-')); t.after(() => rm(outputDir, { recursive: true, force: true }))
  assert.equal(POLICY_CASES.length, 10)
  let calls = 0
  const report = await runPolicyTest({ outputDir, invoke: async ({ request }) => {
    calls++; return { reply_type: 'answer', text: request.agent_message, usage: {} }
  } })
  assert.equal(calls, 30)
  assert.equal(report.cases.length, 10)
  assert.ok(report.cases.every(c => c.trials.length === 3 && typeof c.consistent === 'boolean' && typeof c.compliant === 'boolean'))
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'policy-test.json'), 'utf8')), report)
})
test('broad-question diagnostic reports undisclosed requirements as violations', () => {
  const broad = POLICY_CASES.find(c => c.id === 'broad')
  assert.equal(assessPolicyReply(broad, { reply_type: 'answer', text: 'Use 127.0.0.1, Playwright and layoutId with Tailwind disabled.' }).compliant, false)
  assert.equal(assessPolicyReply(broad, { reply_type: 'answer', text: 'I want a browser presentation with a diagram that evolves through steps.' }).compliant, true)
})

test('policy diagnostic uses its own CLI usage ledger and reports inconsistent trials', async t => {
  const { claudeStub, stream } = await import('./and-scene-define-helpers.mjs')
  const { createSimulatedUser } = await import('../evals/agent-runner/and-scene-define/lib/simulated-user.mjs')
  const stub = await claudeStub(t, Array.from({ length: 30 }, (_, index) => stream({ reply_type: index === 1 ? 'decision' : 'answer', text: 'No, keep the scene kit free of default colors and fonts.' })))
  const report = await runPolicyTest({ outputDir: stub.runDir, invoke: createSimulatedUser(stub) })
  assert.equal(report.cases[0].consistent, false)
  assert.equal(report.cases[0].compliant, false)
  assert.equal((await readFile(join(stub.runDir, 'phases/eval-owned-usage.jsonl'), 'utf8')).trim().split('\n').length, 30)
})
