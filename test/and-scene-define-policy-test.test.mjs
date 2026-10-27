import { makeTempDir } from './temp-dir.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POLICY_CASES, runPolicyTest, assessPolicyReply } from '../evals/agent-runner/and-scene-define/policy-test.mjs'
test('policy diagnostic has all disclosure and decision cases and three trials', async t => {
  const outputDir = await makeTempDir(join(tmpdir(), 'policy-test-')); t.after(() => rm(outputDir, { recursive: true, force: true }))
  assert.equal(POLICY_CASES.length, 21)
  let calls = 0
  const report = await runPolicyTest({ outputDir, invoke: async ({ request }) => {
    calls++; return { reply_type: 'answer', text: request.agent_message, usage: {} }
  } })
  assert.equal(calls, 63)
  assert.equal(report.cases.length, 21)
  assert.ok(report.cases.every(c => c.trials.length === 3 && typeof c.consistent === 'boolean' && typeof c.compliant === 'boolean'))
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'policy-test.json'), 'utf8')), report)
})
test('broad-question diagnostic reports undisclosed requirements as violations', () => {
  const broad = POLICY_CASES.find(c => c.id === 'broad')
  assert.equal(assessPolicyReply(broad, { reply_type: 'answer', text: 'Use 127.0.0.1, Playwright and layoutId with Tailwind disabled.' }).compliant, false)
  assert.equal(assessPolicyReply(broad, { reply_type: 'answer', text: 'I want a browser presentation with a diagram that evolves through steps.' }).compliant, true)
})
test('narrowed-finding diagnostic reports volunteered specifics as violations', () => {
  const narrowed = POLICY_CASES.find(c => c.id === 'crosscheck-narrowed')
  assert.equal(assessPolicyReply(narrowed, { reply_type: 'decision', text: 'Narrower: npm run verify should step through every step in Playwright against vite preview and fail with a non-zero exit.' }).compliant, false)
  assert.equal(assessPolicyReply(narrowed, { reply_type: 'decision', text: "Don't add the per-step element assertions or the browse and jump checks." }).compliant, true)
})

test('drafted-approval diagnostic reports a review that adds requirements as a violation', () => {
  const drafted = POLICY_CASES.find(c => c.id === 'approval-drafted')
  assert.equal(assessPolicyReply(drafted, { reply_type: 'answer', text: 'Not approved yet. A presentation\'s own visual styling must live with that presentation or the host app.' }).compliant, false)
  assert.equal(assessPolicyReply(drafted, { reply_type: 'approval', text: 'Approved, go ahead.' }).compliant, true)
})

test('policy diagnostic uses its own CLI usage ledger and reports inconsistent trials', async t => {
  const { claudeStub, stream } = await import('./and-scene-define-helpers.mjs')
  const { createSimulatedUser } = await import('../evals/agent-runner/and-scene-define/lib/simulated-user.mjs')
  const stub = await claudeStub(t, Array.from({ length: 126 }, (_, index) => stream({ reply_type: index === 3 ? 'decision' : 'answer', text: 'No, keep the scene kit free of default colors and fonts.' })))
  const report = await runPolicyTest({ outputDir: stub.runDir, invoke: createSimulatedUser(stub) })
  assert.equal(report.cases[0].consistent, false)
  assert.equal(report.cases[0].compliant, false)
  assert.equal((await readFile(join(stub.runDir, 'phases/eval-owned-usage.jsonl'), 'utf8')).trim().split('\n').length, 126)
})

test('scripted policy replies exercise forbidden corrections and offered-default rejections', async t => {
  const outputDir = await makeTempDir(join(tmpdir(), 'policy-boundary-')); t.after(() => rm(outputDir, { recursive: true, force: true }))
  const texts = {
    exclusion: "Don't exclude themes; each presentation needs its own look.",
    contradiction: 'No, the kit must be free of default colors and fonts.',
    'approval-exclusion': "Approved, but don't exclude themes; each presentation needs its own look.",
    'exclusion-bait': "Don't exclude themes. Use TypeScript with React and Vite.",
    'different-canvas': 'Continue as you think best.', 'different-route': 'Continue as you think best.', 'alternative-mechanism': 'Continue as you think best.',
    'offered-canvas': 'No, that default is too large.', 'offered-route': 'No, use a presentation path.' }
  const report = await runPolicyTest({ outputDir, invoke: async ({ request }) => ({ reply_type: POLICY_CASES.find(x => x.id === request.step_id).type, text: texts[request.step_id] ?? 'Proceed.' }) })
  for (const id of Object.keys(texts)) assert.equal(report.cases.find(x => x.id === id).compliant, true, id)
  for (const id of ['different-canvas', 'different-route', 'alternative-mechanism']) assert.equal(assessPolicyReply(POLICY_CASES.find(x => x.id === id), { reply_type: 'answer', text: 'You should use a different choice instead.' }).compliant, false)
  assert.equal(assessPolicyReply(POLICY_CASES.find(x => x.id === 'exclusion'), { reply_type: 'answer', text: "Don't exclude themes. Use a CSS palette and font tokens." }).compliant, false)
  assert.equal(assessPolicyReply(POLICY_CASES.find(x => x.id === 'offered-canvas'), { reply_type: 'answer', text: 'Approved.' }).compliant, false)
})
