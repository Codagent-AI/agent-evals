import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createSimulatedUser, REPLY_SCHEMA } from '../evals/agent-runner/and-scene-define/lib/simulated-user.mjs'
import { loadSimulatedUserInputs } from '../evals/agent-runner/and-scene-define/lib/simulated-user-inputs.mjs'
import { checkVersions } from '../evals/agent-runner/and-scene-define/lib/versions.mjs'

import { assertStrictSchema, claudeStub, stream } from './and-scene-define-helpers.mjs'

test('INT-002: simulated-user CLI is stateless, tool-less, strict and keeps host auth', async t => {
  const stub = await claudeStub(t, [stream()])
  const inputs = await loadSimulatedUserInputs()
  const invoke = createSimulatedUser({ runDir: stub.runDir, inputs, env: { ...process.env, PATH: `${stub.runDir}:${process.env.PATH}`, CLAUDECODE: 'nested' } })
  await invoke({ conversation: [{ step: 'define.proposal', agent_message: 'Earlier?', text: 'Earlier answer' }], request: { agent_message: 'Later?' }, deadline: Date.now() + 10000 })
  const [call] = await stub.calls()
  for (const flag of ['--tools', '--setting-sources']) assert.equal(call.argv[call.argv.indexOf(flag) + 1], '')
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(call.argv.includes(flag))
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'claude-opus-5-5')
  assert.deepEqual(call.files, [])
  assert.equal(call.nested, undefined)
  assert.equal(call.home, process.env.HOME)
  const system = call.argv[call.argv.indexOf('--system-prompt') + 1]
  for (const doc of inputs.referenceDocuments) assert.ok(system.includes(doc.text))
  assert.ok(!system.includes('inventory_class'))
  assert.ok(!system.includes('## Done When'))
  assert.ok(!system.includes('rubric criterion'))
  assert.match(call.argv.at(-1), /Earlier answer/)
  assert.match(call.argv.at(-1), /Later\?/)
  assertStrictSchema(JSON.parse(call.argv[call.argv.indexOf('--json-schema') + 1]))
  assertStrictSchema(REPLY_SCHEMA)
})

test('policy content is version pinned; tampering without a bump fails', async t => {
  assert.deepEqual(await checkVersions(), [])
  const inputs = await loadSimulatedUserInputs()
  assert.equal(inputs.policyVersion, 1)
  const stub = await claudeStub(t, [])
  const root = resolve('evals/agent-runner/and-scene-define')
  const ledger = JSON.parse(await readFile(join(root, 'versions.json'), 'utf8'))
  const { cp } = await import('node:fs/promises')
  await cp(root, join(stub.runDir, 'suite'), { recursive: true })
  await writeFile(join(stub.runDir, 'suite/hidden/simulated-user-policy.md'), 'changed')
  assert.ok((await checkVersions({ suiteRoot: join(stub.runDir, 'suite'), previous: ledger })).some(x => /simulated-user-policy: content hash differs/.test(x)))
})

test('stray tools, malformed output and CLI failures exhaust three calls with zero usage', async t => {
  const bad = stream(undefined, [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }])
  const stub = await claudeStub(t, [bad, { stdout: 'not json' }, { stdout: '', stderr: 'failed', code: 1 }])
  const invoke = createSimulatedUser({ ...stub, sleep: async () => {} })
  await assert.rejects(invoke({ request: { agent_message: 'Question' }, conversation: [], deadline: Date.now() + 10000 }), /three attempts/)
  assert.equal((await stub.calls()).length, 3)
  const usage = (await readFile(join(stub.runDir, 'phases/eval-owned-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(usage.length, 3)
  assert.ok(usage.every(x => x.input_tokens === 0 && x.output_tokens === 0 && x.accepted === false))
})

test('invalid_json_schema is non-retryable; capacity does not consume a retry', async t => {
  const invalid = await claudeStub(t, [{ stdout: '', stderr: 'invalid_json_schema', code: 1 }])
  await assert.rejects(createSimulatedUser(invalid)({ request: { agent_message: '?' }, deadline: Date.now() + 10000 }), /invalid_json_schema/)
  assert.equal((await invalid.calls()).length, 1)
  const capacity = await claudeStub(t, [{ stdout: '', stderr: '429 rate_limit_error', code: 1 }, { stdout: 'bad' }, { stdout: 'bad' }, stream()])
  const reply = await createSimulatedUser({ ...capacity, sleep: async () => {} })({ request: { agent_message: '?' }, deadline: Date.now() + 10000 })
  assert.equal(reply.text, 'No preference, your call.')
  assert.equal((await capacity.calls()).length, 4)
})

// Eval-owned judge invocation cases belong here when its later task lands.

test('init capabilities are required; all nested tool uses are checked', async t => {
  for (const stdout of [
    JSON.stringify({ type: 'result', subtype: 'success', structured_output: { text: 'OK', reply_type: 'answer' } }),
    stream(undefined, [{ type: 'stream_event', event: { content_block: { type: 'tool_use', name: 'Bash' } } }]).stdout,
    stream().stdout.replace('["StructuredOutput"]', '["StructuredOutput","Read"]'),
  ]) {
    const stub = await claudeStub(t, Array.from({ length: 3 }, () => ({ stdout })))
    await assert.rejects(createSimulatedUser(stub)({ request: { agent_message: '?' }, deadline: Date.now() + 10000 }), /three attempts/)
    assert.equal((await stub.calls()).length, 3)
  }
})

test('successful answer text mentioning a rate limit does not trigger capacity recovery', async t => {
  const stub = await claudeStub(t, [stream({ text: 'No preference on rate limits, your call.', reply_type: 'answer' })])
  assert.match((await createSimulatedUser(stub)({ request: { agent_message: '?' }, deadline: Date.now() + 10000 })).text, /rate limits/)
  assert.equal((await stub.calls()).length, 1)
})

test('capacity backoff is bounded by the deadline and records each rejected call', async t => {
  const stub = await claudeStub(t, [{ stdout: '', code: 1, stderr: 'overloaded_error' }])
  const deadline = Date.now() + 10000
  let clock = Date.now()
  await assert.rejects(createSimulatedUser({ ...stub, now: () => clock, sleep: async ms => {
    assert.ok(ms > 0 && ms <= deadline - clock)
    clock = deadline
  } })({ request: { agent_message: '?' }, deadline }), /elapsed-time limit/)
  assert.equal((await stub.calls()).length, 1)
  const usage = JSON.parse((await readFile(join(stub.runDir, 'phases/eval-owned-usage.jsonl'), 'utf8')).trim())
  assert.equal(usage.rejection, 'capacity')
  assert.equal(usage.output_tokens, 0)
})
