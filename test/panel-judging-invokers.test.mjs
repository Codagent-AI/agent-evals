import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createClaudeJudgeInvoker } from '../evals/lib/panel-judging/claude-invoker.mjs'

async function fixture(t, events, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claude-judge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const command = join(root, 'claude')
  await writeFile(command, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst root = ${JSON.stringify(root)};\nlet n = Number(fs.existsSync(root+'/count') ? fs.readFileSync(root+'/count','utf8') : 0);\nfs.writeFileSync(root+'/count',String(n+1));\nfs.writeFileSync(root+'/args',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env}));\nprocess.stdin.resume();\nprocess.stdin.on('end',()=>{process.stderr.write(${JSON.stringify(options.stderr ?? '')});process.stdout.write(${JSON.stringify(events)}[Math.min(n,${events.length - 1})].map(e=>JSON.stringify(e)).join('\\n')+'\\n');});\n`, { mode: 0o755 })
  const invoke = createClaudeJudgeInvoker({ runDir: root, command, allowedRoots: [root], ...options })
  return { root, invoke, request: { job: 'test', schema: {}, authority: { model: 'sonnet', effort: 'medium' }, prompt: 'packet', cwd: root } }
}
const success = [{ type: 'system', subtype: 'init', tools: ['StructuredOutput'] }, { type: 'result', subtype: 'success', structured_output: { results: [] }, usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 } }]
test('host mode isolates cwd and tools, pins effort and records Anthropic usage', async t => {
  const { root, invoke, request } = await fixture(t, [success])
  assert.equal(await invoke(request), '{"results":[]}')
  const { args, cwd } = JSON.parse(await readFile(join(root, 'args'), 'utf8'))
  for (const flag of ['--setting-sources', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--json-schema']) assert.ok(args.includes(flag))
  assert.equal(args[args.indexOf('--tools') + 1], '')
  assert.equal(args[args.indexOf('--effort') + 1], 'medium')
  assert.notEqual(cwd, root)
  const [usage] = await invoke.readUsageEntries()
  assert.equal(usage.provider, 'anthropic')
  assert.deepEqual(usage.token_totals, { input: 15, output: 4, total: 19 })
})
test('sandbox permits only read tools in approved roots', async t => {
  const { root, invoke, request } = await fixture(t, [success], { mode: 'in-sandbox' })
  await invoke({ ...request, input_roots: { source: root } })
  const { args, cwd } = JSON.parse(await readFile(join(root, 'args'), 'utf8'))
  assert.equal(cwd, await realpath(root))
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob')
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob')
  await assert.rejects(invoke({ ...request, cwd: tmpdir() }), /approved/)
})
for (const event of [{ type: 'system', subtype: 'init', tools: ['Bash'] }, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }]) test('unexpected tool is rejected', async t => {
  const { invoke, request } = await fixture(t, [[event, ...success]])
  await assert.rejects(invoke(request), /tool/)
})
test('capacity writes zero tokens and backs off; schema rejection fails fast', async t => {
  const delays = []
  const { invoke, request } = await fixture(t, [[{ type: 'result', is_error: true, errors: ['at capacity'] }], success], { sleep: async ms => delays.push(ms) })
  await invoke(request)
  assert.deepEqual(delays, [30000])
  assert.equal((await invoke.readUsageEntries())[0].token_totals.total, 0)
  const bad = await fixture(t, [[{ type: 'result', is_error: true, errors: ['invalid_json_schema'] }]])
  await assert.rejects(bad.invoke(bad.request), error => error.retryable === false)
  assert.equal(await readFile(join(bad.root, 'count'), 'utf8'), '1')
})
test('identified quota waits through injected helper; ambiguous quota is resumable', async t => {
  const limit = [{ type: 'result', is_error: true, errors: ['hit your limit resets 3pm UTC'] }]
  let waited = 0
  const { invoke, request } = await fixture(t, [limit, success], { detectQuotaReset: () => ({ wait_ms: 1000 }), waitForQuotaReset: async () => { waited++; return { waited: true } } })
  await invoke(request)
  assert.equal(waited, 1)
  const bad = await fixture(t, [limit])
  await assert.rejects(bad.invoke(bad.request), error => error.resumable === true && error.owner === 'evaluation-harness')
})

test('Read contents are omitted from durable events while tool input and Grep output survive', async t => {
  const events = [
    { type: 'system', subtype: 'init', tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'private file contents' }] }, tool_use_result: { file: { content: 'private file contents' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'grep1', name: 'Grep', input: { pattern: 'foo' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'grep1', content: 'grep evidence' }] } },
    success[1],
  ]
  const { root, invoke, request } = await fixture(t, [events], { mode: 'in-sandbox' })
  await invoke({ ...request, input_roots: { source: root } })
  const saved = await readFile(join(root, '.runtime/judge-claude/01-test.events.jsonl'), 'utf8')
  assert.doesNotMatch(saved, /private file contents/)
  assert.match(saved, /file_path/)
  assert.match(saved, /grep evidence/)
})

test('sandbox evidence packet has no tools and runs in empty scratch cwd', async t => {
  const { root, invoke, request } = await fixture(t, [success], { mode: 'in-sandbox' })
  await invoke({ ...request, input_roots: { evidence: root } })
  const { args, cwd } = JSON.parse(await readFile(join(root, 'args'), 'utf8'))
  assert.equal(args[args.indexOf('--tools') + 1], '')
  assert.notEqual(cwd, await realpath(root))
})

import { detectClaudeQuotaReset, waitForClaudeQuotaReset } from '../evals/agent-runner/and-scene/lib/claude-quota.mjs'
for (const [label, error, waits] of [
  ['near reset', 'hit your limit reset 2026-10-06 15:00 UTC', true],
  ['over six hours', 'hit your limit reset 2026-10-06 22:00 UTC', false],
  ['stale', 'hit your limit reset 2026-10-06 12:00 UTC', false],
  ['ambiguous 429', '429 rate limit', false],
]) test(`quota policy: ${label}`, async t => {
  const slept = []
  const clock = () => new Date('2026-10-06T13:00:00Z')
  const { invoke, request } = await fixture(t, [[{ type: 'result', is_error: true, errors: [error] }], success], {
    now: clock, detectQuotaReset: detectClaudeQuotaReset,
    waitForQuotaReset: args => waitForClaudeQuotaReset({ ...args, now: clock, sleep: async ms => slept.push(ms) }),
  })
  if (waits) {
    await invoke(request)
    assert.deepEqual(slept, [2 * 60 * 60 * 1000 + 60000])
  } else {
    await assert.rejects(invoke(request), e => e.owner === 'evaluation-harness' && e.resumable === true)
    assert.deepEqual(slept, [])
  }
})

for (const text of ['quota rate limit 429', 'schema is invalid', 'identifier 4290']) test(`successful answer is not a CLI failure: ${text}`, async t => {
  const { invoke, request } = await fixture(t, [[success[0], { ...success[1], result: text }]])
  assert.equal(await invoke(request), '{"results":[]}')
})

test('repeated identified subscription limits stop after bounded waits', async t => {
  let waits = 0
  const { root, invoke, request } = await fixture(t, [[{ type: 'result', is_error: true, errors: ['hit your limit'] }]], {
    detectQuotaReset: () => ({ wait_ms: 1000 }),
    waitForQuotaReset: async () => { if (++waits > 4) throw new Error('unbounded quota retry'); return { waited: true } },
  })
  await assert.rejects(invoke(request), e => e.code === 'claude-quota' && e.resumable === true)
  assert.equal(waits, 2)
  assert.equal(await readFile(join(root, 'count'), 'utf8'), '3')
})


test('successful stderr diagnostics do not trigger schema or quota recovery', async t => {
  const { invoke, request } = await fixture(t, [success], { stderr: 'quota 429 schema invalid warning' })
  assert.equal(await invoke(request), '{"results":[]}')
})

test('a numeric error containing 429 is not a rate-limit signal', async t => {
  const { invoke, request } = await fixture(t, [[{ type: 'result', is_error: true, errors: ['error identifier 4290'] }]])
  await assert.rejects(invoke(request), error => error.code !== 'claude-quota')
})
test('host judge keeps the login identity the Claude CLI needs on macOS', async t => {
  const { root, invoke, request } = await fixture(t, [success], { env: { HOME: '/home/judge', PATH: process.env.PATH, USER: 'judge', LOGNAME: 'judge', GH_TOKEN: 'secret' } })
  await invoke(request)
  const { env } = JSON.parse(await readFile(join(root, 'args'), 'utf8'))
  assert.equal(env.USER, 'judge')
  assert.equal(env.LOGNAME, 'judge')
  assert.equal(env.GH_TOKEN, undefined)
})

test('a Claude judge receives a setup-token login without persisting it', async t => {
  const token = 'sk-ant-oat-judge-token-value'
  const { root, invoke, request } = await fixture(t, [success], { env: { HOME: '/home/judge', PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: 'other-secret' } })
  await invoke(request)
  const { env } = JSON.parse(await readFile(join(root, 'args'), 'utf8'))
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  await invoke.readUsageEntries()
  // The stub's own argument dump is test scaffolding; everything else is the invoker's.
  const { readdir } = await import('node:fs/promises')
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && !['args', 'claude', 'count'].includes(entry.name))
  assert.ok(files.length > 0)
  for (const entry of files) assert.ok(!(await readFile(join(entry.parentPath, entry.name), 'utf8')).includes(token), entry.name)
})

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runAttempt } from '../evals/lib/panel-judging/codex-invoker.mjs'

// A stopped judge's force-kill must not outlive it: once the CLI is gone its
// process-group id may be reused, and an armed timer holds the event loop open.
for (const [label, overrun] of [
  ['a timeout', { timeoutMs: 5 }],
  ['an output-limit', { timeoutMs: 60000, maxStdoutBytes: 4 }],
]) test(`${label} stop leaves no SIGKILL timer armed once the judge exits`, async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const armed = new Set()
  globalThis.setTimeout = (callback, ms, ...rest) => {
    const handle = realSetTimeout(() => { armed.delete(handle); callback(...rest) }, ms)
    armed.add(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => { armed.delete(handle); realClearTimeout(handle) }
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    // The judge honours SIGTERM promptly.
    if (signal === 'SIGTERM') setImmediate(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', null, signal)
      child.emit('close', null, signal)
    })
    return true
  }
  const sink = { write: async () => {} }
  let result
  try {
    const attempt = runAttempt({
      spawnImpl: () => child, command: 'judge', args: [], options: {}, prompt: 'x',
      files: { events: sink, stderr: sink, pathOf: () => 'sink' },
      killGraceMs: 60000, maxStdoutBytes: 1024, label: 'judge', ...overrun,
    })
    if (overrun.maxStdoutBytes) setImmediate(() => child.stdout.write('too much output'))
    result = await attempt
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
  const leaked = armed.size
  for (const handle of armed) realClearTimeout(handle)
  assert.ok(result.timedOut || result.outputLimitExceeded)
  assert.equal(leaked, 0)
  // Descendants still in the stopped group are force-killed at exit instead.
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
})
