import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFallbacks, createBrowserSession, runBrowserJudging, browserJobs } from '../evals/agent-runner/and-scene-e2e/lib/browser-judging.mjs'
import { executeReplay, expectationMet, validReplay } from '../evals/agent-runner/and-scene-e2e/lib/replay.mjs'
import { loadProductInputs } from '../evals/agent-runner/and-scene-e2e/lib/product-rubric.mjs'

const miniRubric = ids => ({ criterion_sources: Object.fromEntries(ids.map(id => [id, { owner: 'eval', reason: `requirement of ${id}` }])), gates: [] })
const goodReplay = (text = 'OK') => ({ actions: [{ type: 'navigate', path: '/anything' }, { type: 'click', text: 'Next' }], expect: { type: 'text-present', text } })
const panel = [{ family: 'claude', model: 'm1', effort: 'high' }, { family: 'claude', model: 'm2', effort: 'high' }, { family: 'codex', model: 'm3', effort: 'high' }]
const decider = { family: 'claude', model: 'd', effort: 'high' }
// A fake judge CLI: `script[model]` returns the per-criterion results; concurrency is observed.
function judgeHarness(script) {
  const state = { active: 0, max: 0, calls: [], prompts: [] }
  const invoke = async request => {
    state.active++; state.max = Math.max(state.max, state.active)
    state.calls.push(request.authority.model); state.prompts.push(request.prompt)
    await new Promise(resolve => setTimeout(resolve, 5))
    state.active--
    const out = script[request.authority.model](request.criteria, request)
    return JSON.stringify({ results: out })
  }
  return { state, invoke }
}
const vote = (id, verdict, replay = null) => ({ id, verdict, rationale: `${verdict} ${id}`, evidence: ['saw it'], replay })
function driverHarness(behaviour) {
  const state = { sessions: [], open: 0, overlapped: false }
  const createDriver = async label => {
    state.open++; if (state.open > 1) state.overlapped = true
    const session = { label, start: Date.now() }
    state.sessions.push(session)
    return { replayGeneric: async (actions, probes) => { await new Promise(resolve => setTimeout(resolve, 5)); return behaviour(actions, probes, label) }, close: async () => { state.open--; session.end = Date.now() } }
  }
  return { state, createDriver }
}
const observed = (text, changed = true) => ({ states: [{ dom: 'a', screenshot: 'a', text: '', probes: [] }], final: { dom: changed ? 'b' : 'a', screenshot: changed ? 'b' : 'a', text, probes: [] }, marks: {}, product_failure: null })
const run = async ({ ids, script, behaviour, secondOpinion }) => {
  const judges = judgeHarness(script); const drivers = driverHarness(behaviour)
  const session = createBrowserSession(drivers.createDriver)
  const result = await runBrowserJudging({ rubric: miniRubric(ids), inventory: { items: [] }, url: 'http://127.0.0.1:1', panel: panel.map(member => ({ ...member })), decider: { ...decider }, invoke: judges.invoke, session, secondOpinion, jobs: [{ id: 'job', criteria: ids }] })
  return { result, judges, drivers }
}

test('INT-012 a reproducing pass is counted and marked replay-confirmed, in a fresh driver context', async () => {
  const same = () => ids => ids.map(id => vote(id, 'pass', goodReplay()))
  const { result, judges, drivers } = await run({ ids: ['A'], script: { m1: same(), m2: same(), m3: same() }, behaviour: () => observed('OK') })
  assert.equal(result.verdicts.A.verdict, 'pass'); assert.equal(result.verdicts.A.basis, 'replay-confirmed')
  assert.equal(drivers.state.sessions.length, 1); assert.match(drivers.state.sessions[0].label, /^replay:A/)
  assert.equal(judges.state.max, 1, 'judge CLIs ran one at a time')
  assert.equal(drivers.state.overlapped, false)
})

test('INT-012 verdicts carry the judges\' evidence as citations, and every job\'s settled results are returned', async () => {
  const same = () => ids => ids.map(id => ({ ...vote(id, 'pass', goodReplay()), evidence: ['clicked Next and saw step 2'] }))
  const { result } = await run({ ids: ['A'], script: { m1: same(), m2: same(), m3: same() }, behaviour: () => observed('OK') })
  assert.deepEqual(result.verdicts.A.citations, ['clicked Next and saw step 2'])
  assert.ok(Object.keys(result.judged).some(key => key.startsWith('browser:')), 'the settled results are kept for the judge records')
})

test('INT-012 when the first passing judge\'s replay mismatches and the second reproduces, the pass counts', async () => {
  const seat = text => () => ids => ids.map(id => vote(id, 'pass', goodReplay(text)))
  const behaviour = actions => observed(actions.length ? 'present' : 'x')
  const { result, drivers } = await run({ ids: ['A'], script: { m1: seat('WRONG-TEXT')(), m2: seat('present')(), m3: seat('present')() }, behaviour })
  assert.equal(result.verdicts.A.verdict, 'pass'); assert.equal(result.verdicts.A.basis, 'replay-confirmed')
  assert.equal(result.verdicts.A.attempts.length, 2); assert.equal(result.verdicts.A.attempts[0].confirmed, false); assert.equal(result.verdicts.A.attempts[1].confirmed, true)
  assert.equal(drivers.state.sessions.length, 2); assert.equal(drivers.state.overlapped, false)
  assert.ok(drivers.state.sessions[1].start >= drivers.state.sessions[0].end, 'the next session waited for the previous to close')
})

test('INT-012 a pass no replay reproduces counts as failed with the mismatch recorded', async () => {
  const same = () => ids => ids.map(id => vote(id, 'pass', goodReplay('never shown')))
  const { result } = await run({ ids: ['A'], script: { m1: same(), m2: same(), m3: same() }, behaviour: () => observed('something else') })
  assert.equal(result.verdicts.A.verdict, 'fail'); assert.equal(result.verdicts.A.basis, 'replay-mismatch')
  assert.match(result.verdicts.A.mismatch, /was not present/)
  assert.equal(result.verdicts.A.attempts.length, 3)
})

test('INT-012 a settled fail goes to the replay-based second opinion; only a reproduced overturn counts', async () => {
  const failing = () => ids => ids.map(id => vote(id, 'fail'))
  const calls = []
  const overturn = async ({ id }) => { calls.push(id); return { decision: 'overturn', rationale: 'I found it', replay: goodReplay('shown') } }
  const first = await run({ ids: ['A'], script: { m1: failing(), m2: failing(), m3: failing() }, behaviour: () => observed('shown'), secondOpinion: overturn })
  assert.deepEqual(calls, ['A']); assert.equal(first.result.verdicts.A.verdict, 'pass'); assert.equal(first.result.verdicts.A.basis, 'second-opinion-overturned')
  assert.ok(first.drivers.state.sessions.some(session => session.label === 'second-opinion:A'))
  const unreproduced = await run({ ids: ['A'], script: { m1: failing(), m2: failing(), m3: failing() }, behaviour: () => observed('nope'), secondOpinion: overturn })
  assert.equal(unreproduced.result.verdicts.A.verdict, 'fail'); assert.equal(unreproduced.result.verdicts.A.second_opinion.replay.confirmed, false)
  const upheld = await run({ ids: ['A'], script: { m1: failing(), m2: failing(), m3: failing() }, behaviour: () => observed('x'), secondOpinion: async () => ({ decision: 'uphold', rationale: 'stands' }) })
  assert.equal(upheld.result.verdicts.A.basis, 'settled-fail'); assert.equal(upheld.drivers.state.sessions.length, 0)
})

test('INT-012 when no judge can locate the evidence the fallback decides; an unconfirmed fallback pass fails', async () => {
  const nowhere = () => ids => ids.map(id => vote(id, 'not-located'))
  const { result } = await run({ ids: ['A', 'B'], script: { m1: nowhere(), m2: nowhere(), m3: nowhere() }, behaviour: () => observed('x') })
  assert.equal(result.verdicts.A.verdict, 'fallback'); assert.equal(result.verdicts.A.basis, 'fallback-judged')
  const merged = applyFallbacks({ verdicts: result.verdicts, fallbackResults: { A: { verdict: 'pass', confirmed: true }, B: { verdict: 'pass', confirmed: false } } })
  assert.equal(merged.A.verdict, 'pass'); assert.equal(merged.A.basis, 'fallback-judged')
  assert.equal(merged.B.verdict, 'fail'); assert.equal(merged.B.basis, 'fallback-judged')
})

test('INT-012 browser packets name the requirement and the URL but no reference route, count, title, era or size', async () => {
  const same = () => ids => ids.map(id => vote(id, 'fail'))
  const { judges } = await run({ ids: ['A'], script: { m1: same(), m2: same(), m3: same() }, behaviour: () => observed('x') })
  const inputs = await loadProductInputs()
  for (const prompt of judges.state.prompts) {
    assert.match(prompt, /http:\/\/127\.0\.0\.1:1/); assert.match(prompt, /chrome-devtools-axi/)
    for (const value of inputs.preferenceValues) assert.ok(!prompt.includes(value), value)
    assert.doesNotMatch(prompt, /nine|data-step-count|\/demo/i)
  }
  // The real rubric's browser jobs each cover only browser-judge criteria.
  const jobs = browserJobs(inputs.rubric)
  assert.ok(jobs.length >= 1)
  const rows = new Map(inputs.rubric.components.flatMap(c => c.subcomponents.filter(s => s.evaluator === 'browser-judge').flatMap(s => s.criteria)).map(id => [id, true]))
  for (const job of jobs) for (const id of job.criteria) assert.ok(rows.has(id))
})

test('INT-012 the closed replay schema accepts generic plans and rejects escapes; expectations are judged from the observed state', () => {
  assert.ok(validReplay({ actions: [{ type: 'navigate', path: '/x' }, { type: 'click', selector: 'button.next' }, { type: 'mark', label: 'a' }, { type: 'press', key: 'ArrowRight', modifiers: ['Alt'] }], expect: { type: 'rendered-state-matches', label: 'a' } }))
  assert.ok(!validReplay({ actions: [{ type: 'click', text: 'x' }], expect: { type: 'rendered-state-changes' } }), 'must start with navigate')
  assert.ok(!validReplay({ actions: [{ type: 'navigate', path: '/../x' }], expect: { type: 'rendered-state-changes' } }))
  assert.ok(!validReplay({ actions: [{ type: 'navigate', path: '/x' }], expect: { type: 'rendered-state-matches', label: 'missing' } }))
  assert.ok(!validReplay({ actions: [{ type: 'navigate', path: '/x' }], expect: { type: 'step-index-equals', value: 1 } }), 'reference hooks are not expectations')
  const probes = (visible) => [{ selector: '#a', visible, text: 'hello world' }]
  const states = [{ dom: '1', screenshot: 's1', probes: probes(true), text: 'first' }]
  const result = { states, final: { dom: '2', screenshot: 's2', probes: probes(false), text: 'hello world' }, marks: { a: { dom: '2', screenshot: 's2' }, b: { dom: '9', screenshot: 's9' } } }
  assert.ok(expectationMet({ type: 'rendered-state-changes' }, result).met)
  assert.ok(expectationMet({ type: 'rendered-state-matches', label: 'a' }, result).met)
  assert.ok(!expectationMet({ type: 'rendered-state-matches', label: 'b' }, result).met)
  assert.ok(expectationMet({ type: 'selector-hidden', selector: '#a' }, result).met)
  assert.ok(!expectationMet({ type: 'selector-visible', selector: '#a' }, result).met)
  assert.ok(expectationMet({ type: 'text-present', text: 'HELLO' }, result).met)
  assert.ok(!expectationMet({ type: 'rendered-state-changes' }, { states, final: { ...states[0] } }).met)
})

test('INT-012 a replay whose browser reports a product failure or an invalid plan is a mismatch, never a pass', async () => {
  const driver = { replayGeneric: async () => ({ product_failure: 'replay click target was not found', states: [], marks: {} }) }
  assert.equal((await executeReplay({ driver, replay: goodReplay() })).confirmed, false)
  assert.equal((await executeReplay({ driver, replay: { actions: [], expect: {} } })).confirmed, false)
})

test('INT-012 a failed browser judge call is still recorded in the usage ledger', async t => {
  const { createBrowserJudgeInvoker } = await import('../evals/agent-runner/and-scene-e2e/lib/browser-judge-invokers.mjs')
  const { temp } = await import('./and-scene-e2e-helpers.mjs'); const { readFile } = await import('node:fs/promises'); const { EventEmitter } = await import('node:events')
  const runDir = await temp(t, 'e2e-usage-')
  const spawnImpl = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() { setImmediate(() => { child.stdout.emit('data', JSON.stringify({ type: 'result', usage: { input_tokens: 5 }, total_cost_usd: 0.25 }) + '\n'); child.stderr.emit('data', 'boom'); child.emit('close', 1) }) } }; child.kill = () => {}; return child }
  const invoke = createBrowserJudgeInvoker({ runDir, spawnImpl })
  await assert.rejects(invoke({ job: 'j', authority: { cli: 'claude', model: 'm', effort: 'high' }, schema: {}, prompt: 'p' }), /claude exited 1/)
  const [entry] = (await readFile(`${runDir}/phases/eval-owned-usage.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(entry.ok, false); assert.equal(entry.usage.cost_usd, 0.25); assert.equal(entry.job, 'j')
})

test('INT-012 a Claude browser judge gets the user identity its Keychain login needs, and a login failure names itself', async t => {
  const { createBrowserJudgeInvoker } = await import('../evals/agent-runner/and-scene-e2e/lib/browser-judge-invokers.mjs')
  const { temp } = await import('./and-scene-e2e-helpers.mjs'); const { EventEmitter } = await import('node:events')
  const runDir = await temp(t, 'e2e-identity-')
  let seen = null
  const spawnImpl = (command, args, options) => { seen = options.env; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() { setImmediate(() => { child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }) + '\n'); child.emit('close', 1) }) } }; child.kill = () => {}; return child }
  const invoke = createBrowserJudgeInvoker({ runDir, spawnImpl, env: { PATH: '/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', SECRET_THING: 'x' } })
  await assert.rejects(invoke({ job: 'j', authority: { cli: 'claude', model: 'm', effort: 'high' }, schema: {}, prompt: 'p' }), /claude exited 1: Not logged in/)
  assert.equal(seen.USER, 'u'); assert.equal(seen.LOGNAME, 'u'); assert.equal(seen.SECRET_THING, undefined)
})

test('INT-012 a Codex browser judge runs outside Codex\'s sandbox with a stripped environment, a private Codex home and the installed AXI MCP', async t => {
  const { createBrowserJudgeInvoker } = await import('../evals/agent-runner/and-scene-e2e/lib/browser-judge-invokers.mjs')
  const { temp } = await import('./and-scene-e2e-helpers.mjs'); const { EventEmitter } = await import('node:events'); const { writeFile } = await import('node:fs/promises')
  const runDir = await temp(t, 'e2e-codex-seat-')
  let seen = null
  const spawnImpl = (command, args, options) => { seen = { command, args, env: options.env }; const out = args[args.indexOf('--output-last-message') + 1]; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() { writeFile(out, '{"ok":true}').then(() => child.emit('close', 0)) } }; child.kill = () => {}; return child }
  const invoke = createBrowserJudgeInvoker({ runDir, spawnImpl, env: { PATH: '/bin', HOME: '/home/u', USER: 'u', CHROME_DEVTOOLS_AXI_MCP_PATH: '/mcp.js', OPENAI_API_KEY: 'k' } })
  assert.equal(await invoke({ job: 'j', authority: { cli: 'codex', model: 'm', effort: 'high' }, schema: {}, prompt: 'p', browser_session: 's' }), '{"ok":true}')
  assert.equal(seen.args[seen.args.indexOf('--sandbox') + 1], 'danger-full-access')
  assert.equal(seen.env.CHROME_DEVTOOLS_AXI_MCP_PATH, '/mcp.js'); assert.equal(seen.env.CHROME_DEVTOOLS_AXI_SESSION, 's')
  assert.equal(seen.env.OPENAI_API_KEY, undefined); assert.ok(seen.env.CODEX_HOME && !seen.env.CODEX_HOME.startsWith('/home/u'))
})

test('INT-012 the evaluator AXI bridge starts on the host for a judge, and a bridge that cannot start is a resumable harness failure', async () => {
  const { startAxiBridge } = await import('../evals/agent-runner/and-scene-e2e/lib/production-deps.mjs')
  const calls = []
  startAxiBridge({ PATH: '/bin', CHROME_DEVTOOLS_AXI_MCP_PATH: '/mcp.js' }, (command, args, options) => { calls.push({ command, args, env: options.env }); return { status: 0 } })
  assert.deepEqual(calls.map(call => [call.command, call.args]), [['chrome-devtools-axi', ['start']]])
  assert.equal(calls[0].env.CHROME_DEVTOOLS_AXI_SESSION, 'and-scene-evaluator'); assert.equal(calls[0].env.CHROME_DEVTOOLS_AXI_MCP_PATH, '/mcp.js')
  assert.throws(() => startAxiBridge({ PATH: '/bin' }, () => ({ status: 1, stderr: 'BRIDGE_NOT_READY' })), error => /could not start the evaluator AXI bridge: BRIDGE_NOT_READY/.test(error.message) && error.owner === 'evaluation-harness' && error.resumable === true)
})

test('INT-012 the AXI MCP is found beside the installed chrome-devtools-axi, and is absent when it is not installed', async t => {
  const { findAxiMcp } = await import('../evals/agent-runner/and-scene-e2e/lib/host-chrome.mjs')
  const { temp } = await import('./and-scene-e2e-helpers.mjs'); const { mkdir, writeFile, symlink, rm } = await import('node:fs/promises'); const { join, dirname } = await import('node:path')
  const root = await temp(t, 'e2e-axi-mcp-')
  const axi = join(root, 'lib/node_modules/chrome-devtools-axi/dist/bin/chrome-devtools-axi.js'); const mcp = join(root, 'lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')
  for (const file of [axi, mcp]) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, '#!/usr/bin/env node\n', { mode: 0o755 }) }
  await mkdir(join(root, 'bin')); await symlink(axi, join(root, 'bin/chrome-devtools-axi'))
  const env = { PATH: join(root, 'bin') }
  assert.equal(findAxiMcp(env).endsWith('lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'), true)
  assert.equal(findAxiMcp({ ...env, CHROME_DEVTOOLS_AXI_MCP_PATH: '/chosen.js' }), '/chosen.js')
  await rm(join(root, 'lib/node_modules/chrome-devtools-mcp'), { recursive: true })
  assert.equal(findAxiMcp(env), null)
})

test('INT-012 the replay driver\'s AXI commands leave this process free to serve the product while they run', async t => {
  const { axiCommand } = await import('../evals/agent-runner/and-scene-e2e/lib/production-deps.mjs')
  const { temp } = await import('./and-scene-e2e-helpers.mjs'); const { writeFile } = await import('node:fs/promises'); const { join } = await import('node:path')
  const bin = await temp(t, 'e2e-axi-cmd-')
  await writeFile(join(bin, 'chrome-devtools-axi'), '#!/bin/sh\nsleep 0.3\necho "args:$*"\ncat\n', { mode: 0o755 })
  let ticks = 0; const timer = setInterval(() => { ticks++ }, 20)
  const result = await axiCommand({ PATH: `${bin}:${process.env.PATH}` })(['run'], 'script-body')
  clearInterval(timer)
  assert.equal(result.status, 0); assert.equal(result.stdout, 'args:run\nscript-body')
  assert.ok(ticks >= 5, `the event loop kept running (${ticks} ticks)`)
  const missing = await axiCommand({ PATH: '/nonexistent' })(['run'])
  assert.ok(missing.error, 'a missing axi is reported, not thrown')
})

test('INT-012 a split browser panel is settled by the decider from its observed evidence', async () => {
  const ids = ['c1']
  const script = { m1: () => [vote('c1', 'pass', goodReplay())], m2: () => [vote('c1', 'fail')], m3: () => [vote('c1', 'not-located')], d: () => [vote('c1', 'pass', goodReplay())] }
  const { result, judges } = await run({ ids, script, behaviour: () => observed('OK') })
  assert.deepEqual(result.failed_jobs, []); assert.ok(judges.state.calls.includes('d'), 'the decider settled the split')
  assert.equal(result.verdicts.c1.verdict, 'pass'); assert.equal(result.verdicts.c1.basis, 'replay-confirmed')
})

test('INT-012 a browser request\'s answer format admits only its own criteria, each exactly once', async () => {
  const { buildBrowserRequest, BROWSER_RESULT_SCHEMA } = await import('../evals/agent-runner/and-scene-e2e/lib/judge-requests.mjs')
  const ids = ['c1', 'c2']
  const { schema } = buildBrowserRequest({ rubric: miniRubric(ids), inventory: { items: [] }, job: { id: 'job', criteria: ids }, url: 'http://127.0.0.1:1' })
  const results = schema.properties.results
  assert.deepEqual(results.items.properties.id.enum, ids); assert.equal(results.minItems, 2); assert.equal(results.maxItems, 2)
  assert.equal(BROWSER_RESULT_SCHEMA.properties.results.items.properties.id.enum, undefined, 'the shared schema is not changed')
})
