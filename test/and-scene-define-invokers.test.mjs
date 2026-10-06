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
  const invoke = createSimulatedUser({ runDir: stub.runDir, inputs, env: { ...process.env, PATH: `${stub.runDir}:${process.env.PATH}`, CLAUDECODE: 'nested', CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-secret', ANTHROPIC_API_KEY: 'test-api-secret', CLAUDE_CODE_API_KEY: 'test-claude-api-secret', CLAUDE_CONFIG_DIR: '/unwanted/config', CLAUDE_CODE_USE_BEDROCK: '1' } })
  await invoke({ conversation: [{ step: 'define.proposal', agent_message: 'Earlier?', text: 'Earlier answer' }], request: { agent_message: 'Later?' }, deadline: Date.now() + 10000 })
  const [call] = await stub.calls()
  for (const flag of ['--tools', '--setting-sources']) assert.equal(call.argv[call.argv.indexOf(flag) + 1], '')
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(call.argv.includes(flag))
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'claude-opus-5-5')
  assert.deepEqual(call.files, ['system-prompt.md'])
  assert.equal(call.promptMode, 0o600)
  assert.equal(call.scratchMode, 0o700)
  assert.equal(call.oauth, true)
  assert.equal(call.apiKey, true)
  assert.equal(call.claudeApiKey, true)
  assert.equal(call.configDir, undefined)
  assert.equal(call.bedrock, undefined)
  assert.equal(call.nested, undefined)
  assert.equal(call.home, process.env.HOME)
  const system = call.system
  assert.ok(call.argv.includes('--system-prompt-file'))
  assert.ok(!call.argv.includes('--system-prompt'))
  assert.ok(!call.argv.some(arg => arg.includes(inputs.referenceDocuments[0].text)))
  await assert.rejects(readFile(call.argv[call.argv.indexOf('--system-prompt-file') + 1]), { code: 'ENOENT' })
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


test('CLI auth failures retain bounded diagnostics with credential redaction and scratch cleanup', async t => {
  const stub = await claudeStub(t, Array.from({ length: 3 }, () => ({ stdout: '', code: 1, stderr: 'Authentication failed: token test-oauth-secret / key test-api-secret / test-claude-api-secret. ' + 'x'.repeat(2000) })))
  const invoke = createSimulatedUser({ ...stub, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-secret', ANTHROPIC_API_KEY: 'test-api-secret', CLAUDE_CODE_API_KEY: 'test-claude-api-secret' } })
  await assert.rejects(invoke({ request: { agent_message: '?' }, deadline: Date.now() + 10000 }), error => {
    assert.match(error.message, /Authentication failed/)
    assert.ok(!error.message.includes('test-oauth-secret'))
    assert.ok(!error.message.includes('test-api-secret'))
    assert.ok(!error.message.includes('test-claude-api-secret'))
    return true
  })
  const usage = (await readFile(join(stub.runDir, 'phases/eval-owned-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(usage.every(record => /Authentication failed/.test(record.rejection) && record.rejection.length < 1200 && !record.rejection.includes('test-oauth-secret') && !record.rejection.includes('test-api-secret')))
  for (const call of await stub.calls()) await assert.rejects(readFile(join(call.cwd, 'system-prompt.md')), { code: 'ENOENT' })
})

test('CLI output overflow is rejected with zero usage and only one stop signal per process', async t => {
  const stub = await claudeStub(t, Array.from({ length: 3 }, () => ({ flood: 128 * 1024 })))
  await assert.rejects(createSimulatedUser({ ...stub, maxOutputBytes: 64 * 1024 })({ request: { agent_message: '?' }, deadline: Date.now() + 10000 }), /output exceeded/)
  const usage = (await readFile(join(stub.runDir, 'phases/eval-owned-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(usage.length, 3)
  assert.ok(usage.every(record => /output exceeded/.test(record.rejection) && record.input_tokens === 0 && record.output_tokens === 0))
  assert.equal((await readFile(join(stub.runDir, 'signals.jsonl'), 'utf8')).trim().split('\n').length, 3)
})


test('cancellation during overflow cleanup does not send SIGTERM twice or leak its kill timer', async t => {
  const stub = await claudeStub(t, [{ flood: 128 * 1024, ignoreTerm: true }])
  const controller = new AbortController()
  const pending = assert.rejects(createSimulatedUser({ ...stub, maxOutputBytes: 64 * 1024 })({ request: { agent_message: '?' }, signal: controller.signal, deadline: Date.now() + 10000 }), /cancelled/)
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await readFile(join(stub.runDir, 'signals.jsonl')); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  controller.abort()
  await pending
  assert.equal((await readFile(join(stub.runDir, 'signals.jsonl'), 'utf8')).trim().split('\n').length, 1)
  assert.equal((await stub.calls()).length, 1)
})

import { mkdtemp, mkdir, chmod, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createClaudeJudgeInvoker } from '../evals/lib/panel-judging/claude-invoker.mjs'
import { createCodexJudgeInvoker } from '../evals/lib/panel-judging/codex-invoker.mjs'
import { JUDGE_PROFILE, judgeSchema, discoverySchema } from '../evals/agent-runner/and-scene-define/lib/judge-jobs.mjs'

test('INT-002 pinned Claude judge and decider are tool-less, strict, fail fast on invalid schema and reject tools', async t => {
  const schema = judgeSchema(['item'])
  for (const authority of [JUDGE_PROFILE.panel[0], JUDGE_PROFILE.decider]) {
    const stub = await claudeStub(t, [stream({ results: [] })])
    const invoke = createClaudeJudgeInvoker(stub)
    await invoke({ job: 'judge', authority, schema, prompt: 'inlined inputs' })
    const [call] = await stub.calls()
    for (const flag of ['--tools', '--setting-sources']) assert.equal(call.argv[call.argv.indexOf(flag) + 1], '')
    for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(call.argv.includes(flag))
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], authority.model)
    assertStrictSchema(JSON.parse(call.argv[call.argv.indexOf('--json-schema') + 1]))
    assert.deepEqual(call.files, [])
  }
  assertStrictSchema(discoverySchema(['item']))
  const bad = await claudeStub(t, [stream({ results: [] }, [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }])])
  await assert.rejects(createClaudeJudgeInvoker(bad)({ authority: JUDGE_PROFILE.decider, schema, prompt: 'inputs' }), /forbidden tool/)
  const invalid = await claudeStub(t, [{ stdout: '', stderr: 'invalid_json_schema', code: 1 }])
  await assert.rejects(createClaudeJudgeInvoker(invalid)({ authority: JUDGE_PROFILE.decider, schema, prompt: 'inputs' }), error => error.retryable === false)
  assert.equal((await invalid.calls()).length, 1)
  const record = JSON.parse((await readFile(join(invalid.runDir, 'phases/eval-owned-usage.jsonl'), 'utf8')).trim())
  assert.equal(record.token_totals.total, 0)
})

test('INT-002 private Codex home contains only auth.json and is removed on success or schema rejection', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'define-codex-')); t.after(() => rm(runDir, { recursive: true, force: true }))
  const authHome = join(runDir, 'host-home'); await mkdir(authHome)
  await writeFile(join(authHome, 'auth.json'), '{"token":"test"}')
  await writeFile(join(authHome, 'config.toml'), 'must not be copied')
  const cwd = join(runDir, 'inputs'); await mkdir(cwd); await writeFile(join(cwd, 'packet.json'), '{}')
  const command = join(runDir, 'codex')
  await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const argv = process.argv.slice(2); let prompt = '';
process.stdin.on('data', x => prompt += x); process.stdin.on('end', () => {
fs.appendFileSync(${JSON.stringify(join(runDir, 'calls.jsonl'))}, JSON.stringify({ argv, cwd: process.cwd(), home: process.env.CODEX_HOME, files: fs.readdirSync(process.env.CODEX_HOME), mode: fs.statSync(process.env.CODEX_HOME).mode & 0o777, authMode: fs.statSync(path.join(process.env.CODEX_HOME, 'auth.json')).mode & 0o777, schema: JSON.parse(fs.readFileSync(argv[argv.indexOf('--output-schema')+1])), prompt })+'\\n');
if (prompt === 'reject') { process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'invalid_json_schema'}})+'\\n'); process.exitCode=1; }
else { fs.writeFileSync(argv[argv.indexOf('--output-last-message')+1], '{"results":[]}'); process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}})+'\\n'); }
});`)
  await chmod(command, 0o755)
  const invoke = createCodexJudgeInvoker({ runDir, defaultCwd: cwd, command, privateCodexHome: true, env: { ...process.env, CODEX_HOME: authHome } })
  const request = { job: 'quality', authority: JUDGE_PROFILE.panel[1], schema: judgeSchema(['item']), prompt: 'inputs' }
  await invoke(request)
  await assert.rejects(invoke({ ...request, prompt: 'reject' }), error => error.retryable === false)
  const calls = (await readFile(join(runDir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.notEqual(call.home, authHome); assert.deepEqual(call.files, ['auth.json']); assert.equal(call.mode, 0o700); assert.equal(call.authMode, 0o600)
    assert.equal(call.argv[call.argv.indexOf('--sandbox') + 1], 'read-only'); assert.equal(call.cwd, await realpath(cwd))
    assertStrictSchema(call.schema)
    await assert.rejects(readdir(call.home), { code: 'ENOENT' })
  }
  const usage = (await readFile(join(runDir, 'phases/eval-owned-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(usage[1].token_totals.total, 0)
})
