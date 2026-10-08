import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runResponder } from '../evals/agent-runner/and-scene-define/lib/responder.mjs'
import { loadSimulatedUserInputs } from '../evals/agent-runner/and-scene-define/lib/simulated-user-inputs.mjs'
import { spawn } from 'node:child_process'
import { createSimulatedUser } from '../evals/agent-runner/and-scene-define/lib/simulated-user.mjs'
import { claudeStub, stream } from './and-scene-define-helpers.mjs'
const delay = ms => new Promise(r => setTimeout(r, ms))
const request = (turn, overrides = {}) => ({ schema_version: 1, run_id: 'runner-1', step: 'define.proposal', step_id: 'proposal', attempt: 1, turn, cli: 'codex', session_id: 'session', agent_message: 'What should I build?', empty_turn: false, ...overrides })
async function setup(t) {
  const runDir = await mkdtemp(join(tmpdir(), 'define-responder-'))
  const exchangeDir = join(runDir, 'exchange'); await mkdir(exchangeDir)
  t.after(() => rm(runDir, { recursive: true, force: true }))
  return { runDir, exchangeDir }
}
async function publish(dir, name, body) {
  await writeFile(join(dir, `${name}.tmp`), JSON.stringify(body), { mode: 0o644 })
  await rename(join(dir, `${name}.tmp`), join(dir, `${name}.request.json`))
}
async function reply(dir, name) {
  for (let n = 0; n < 200; n++) {
    try { return JSON.parse(await readFile(join(dir, `${name}.reply.json`), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    await delay(10)
  }
  throw new Error('reply never appeared')
}

test('INT-001: atomic exchange, durable opening, full conversation and restart replay', async t => {
  const dirs = await setup(t); const inputs = await loadSimulatedUserInputs()
  let calls = 0; let durable = 0
  const invoke = async ({ conversation }) => { calls++; assert.equal(conversation[0].text, inputs.startingPrompt); return { text: 'Approved.', reply_type: 'approval', usage: { input_tokens: 1 } } }
  const start = () => {
    const controller = new AbortController()
    const done = runResponder({ ...dirs, inputs, invoke, signal: controller.signal, deadline: Date.now() + 10000, onExchangeDurable: () => { durable++ } })
    // Stop the loop even when an assertion fails first, or the file never exits.
    t.after(() => { controller.abort(); return done.catch(() => {}) })
    return { controller, done }
  }
  const first = start()
  await publish(dirs.exchangeDir, 'unrelated-name', request(1))
  assert.equal((await reply(dirs.exchangeDir, 'unrelated-name')).text, inputs.startingPrompt)
  assert.equal(calls, 0); assert.equal(durable, 1)
  await publish(dirs.exchangeDir, 'second', request(2, { step: 'define.design', step_id: 'design' }))
  assert.equal((await reply(dirs.exchangeDir, 'second')).text, 'Approved.')
  assert.equal(durable, 2)
  const records = (await readFile(join(dirs.runDir, 'conversation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(records[1].simulated_approval, true)
  assert.equal((await stat(join(dirs.exchangeDir, 'second.reply.json'))).mode & 0o777, 0o644)
  first.controller.abort(); await first.done
  await rm(join(dirs.exchangeDir, 'second.reply.json'))
  const second = start()
  assert.equal((await reply(dirs.exchangeDir, 'second')).text, 'Approved.')
  assert.equal(calls, 1)
  second.controller.abort(); await second.done
})

test('run identity mismatch and deadline write aborts', async t => {
  for (const mode of ['mismatch', 'deadline']) {
    const dirs = await setup(t)
    await publish(dirs.exchangeDir, 'pending', request(1, { run_id: 'wrong' }))
    const outcome = await runResponder({ ...dirs, runnerRunId: mode === 'mismatch' ? 'expected' : undefined, deadline: mode === 'deadline' ? Date.now() - 1 : Date.now() + 10000 })
    assert.equal(outcome.status, mode === 'deadline' ? 'elapsed-time-limit' : 'evaluation-harness-failed')
    assert.equal((await reply(dirs.exchangeDir, 'pending')).action, 'abort')
  }
})

test('three malformed invocations abort the pending Runner request', async t => {
  const dirs = await setup(t)
  const stub = await claudeStub(t, [{ stdout: 'bad' }, { stdout: 'bad' }, { stdout: 'bad' }])
  await writeFile(join(dirs.runDir, 'conversation.jsonl'), JSON.stringify({ ...request(1), text: 'Opening', reply_type: 'answer' }) + '\n')
  await publish(dirs.exchangeDir, 'pending', request(2))
  const outcome = await runResponder({ ...dirs, invoke: createSimulatedUser({ ...stub, runDir: dirs.runDir }), deadline: Date.now() + 10000 })
  assert.equal(outcome.status, 'evaluation-harness-failed')
  assert.equal((await reply(dirs.exchangeDir, 'pending')).action, 'abort')
})

test('deadline interrupts an invoker that never settles', async t => {
  const dirs = await setup(t)
  await writeFile(join(dirs.runDir, 'conversation.jsonl'), JSON.stringify({ ...request(1), text: 'Opening', reply_type: 'answer' }) + '\n')
  await publish(dirs.exchangeDir, 'pending', request(2))
  const outcome = await runResponder({ ...dirs, invoke: () => new Promise(() => {}), deadline: Date.now() + 100 })
  assert.equal(outcome.status, 'elapsed-time-limit')
  assert.equal((await reply(dirs.exchangeDir, 'pending')).reason, 'elapsed-time limit')
})

test('INT-001: actual conversation fsync precedes publication; stop in write-ahead window replays', async t => {
  const { open } = await import('node:fs/promises')
  const dirs = await setup(t)
  const probe = await open(join(dirs.runDir, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe)
  const originalSync = prototype.sync
  let synced = false
  prototype.sync = async function () {
    const result = await originalSync.call(this)
    try {
      if ((await this.stat()).ino === (await stat(join(dirs.runDir, 'conversation.jsonl'))).ino) synced = true
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    return result
  }
  await probe.close()
  t.after(() => { prototype.sync = originalSync })
  const controller = new AbortController()
  await publish(dirs.exchangeDir, 'opening', request(1))
  const outcome = await runResponder({ ...dirs, deadline: Date.now() + 10000, signal: controller.signal, onExchangeDurable: async () => {
    assert.equal(synced, true)
    await assert.rejects(readFile(join(dirs.exchangeDir, 'opening.reply.json')), { code: 'ENOENT' })
    controller.abort()
  } })
  assert.equal(outcome.status, 'stopped')
  await assert.rejects(readFile(join(dirs.exchangeDir, 'opening.reply.json')), { code: 'ENOENT' })
  const resumed = new AbortController()
  const done = runResponder({ ...dirs, deadline: Date.now() + 10000, signal: resumed.signal, invoke: () => { throw new Error('must replay') } })
  t.after(() => { resumed.abort(); return done.catch(() => {}) })
  const inputs = await loadSimulatedUserInputs()
  assert.equal((await reply(dirs.exchangeDir, 'opening')).text, inputs.startingPrompt)
  resumed.abort(); await done
})

test('INT-001: stub claude replays a clean recorded whole-turn response across steps', { timeout: 60000 }, async t => {
  const dirs = await setup(t)
  const poc = 'openspec/changes/eval-the-whole-workflow/poc/runs/codex-20261004T023437Z'
  const conversation = JSON.parse(await readFile(join(poc, 'conversation.json'), 'utf8'))
  const exchanges = conversation.exchanges
  const recorded = await readFile(join(poc, 'turns/02-simuser.stdout.jsonl'), 'utf8')
  const stub = await claudeStub(t, [{ stdout: recorded }])
  const controller = new AbortController()
  const done = runResponder({ ...dirs, signal: controller.signal, deadline: Date.now() + 10000, invoke: createSimulatedUser({ ...stub, runDir: dirs.runDir }) })
  t.after(() => { controller.abort(); return done.catch(() => {}) })
  // A separate fake Runner process publishes atomic requests and awaits replies.
  const runner = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFile, rename, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const dir = ${JSON.stringify(dirs.exchangeDir)};
    const turns = ${JSON.stringify([['first', request(1, { agent_message: exchanges[0].agentMessage })], ['next', request(2, { agent_message: exchanges[1].agentMessage, step: 'define.specs', step_id: 'specs' })]])};
    for (const [name, body] of turns) {
      await writeFile(join(dir,name+'.tmp'), JSON.stringify(body), {mode:0o644});
      await rename(join(dir,name+'.tmp'), join(dir,name+'.request.json'));
      while (true) {
        try { await readFile(join(dir,name+'.reply.json')); break }
        catch (e) { if (e.code !== 'ENOENT') throw e }
        await new Promise(r => setTimeout(r, 10));
      }
    }
  `], { stdio: ['ignore', 'ignore', 'pipe'] })
  const runnerDone = new Promise((resolve, reject) => { runner.on('error', reject); runner.on('close', code => code === 0 ? resolve() : reject(new Error('fake Runner failed'))) })
  t.after(() => runner.kill())
  // The fake Runner waits for replies indefinitely; fail as soon as the
  // responder stops instead of hanging the test file.
  await Promise.race([runnerDone, done.then(outcome => { throw new Error(`responder stopped before the fake Runner finished: ${outcome?.status}`) })])
  const result = JSON.parse(recorded.trim().split('\n').at(-1))
  assert.equal((await reply(dirs.exchangeDir, 'next')).text, result.structured_output.text)
  controller.abort(); await done
  const [call] = await stub.calls()
  assert.equal(JSON.parse(call.argv.at(-1)).conversation[0].agent_message, exchanges[0].agentMessage)
  assert.equal(JSON.parse(call.argv.at(-1)).current_agent_turn, exchanges[1].agentMessage)
})

test('stopping during a pending invocation leaves the exchange resumable', async t => {
  const dirs = await setup(t)
  await writeFile(join(dirs.runDir, 'conversation.jsonl'), JSON.stringify({ ...request(1), text: 'Opening', reply_type: 'answer' }) + '\n')
  await publish(dirs.exchangeDir, 'pending', request(2))
  const controller = new AbortController()
  const done = runResponder({ ...dirs, signal: controller.signal, deadline: Date.now() + 10000, invoke: () => { controller.abort(); return new Promise(() => {}) } })
  assert.equal((await done).status, 'stopped')
  await assert.rejects(readFile(join(dirs.exchangeDir, 'pending.reply.json')), { code: 'ENOENT' })
})

test('elapsed limit aborts the pending exchange and preserves already consumed replies', async t => {
  const dirs = await setup(t)
  await writeFile(join(dirs.runDir, 'conversation.jsonl'), JSON.stringify({ ...request(1), text: 'Opening', reply_type: 'answer' }) + '\n')
  await publish(dirs.exchangeDir, 'a-old', request(1))
  await writeFile(join(dirs.exchangeDir, 'a-old.reply.json'), JSON.stringify({ text: 'Opening', schema_version: 1 }))
  await publish(dirs.exchangeDir, 'z-pending', request(2))
  const outcome = await runResponder({ ...dirs, deadline: Date.now() - 1 })
  assert.equal(outcome.status, 'elapsed-time-limit')
  assert.equal((await reply(dirs.exchangeDir, 'a-old')).text, 'Opening')
  assert.equal((await reply(dirs.exchangeDir, 'z-pending')).reason, 'elapsed-time limit')
})


test('torn final conversation records are durably truncated before regenerating the pending reply', async t => {
  for (const suffix of ['{"schema_version":1,"text":"torn', '{"schema_version":1,"text":"torn\n\n']) {
    const dirs = await setup(t)
    const prior = { ...request(1), text: 'Opening with Unicode 🌳', reply_type: 'answer' }
    const prefix = JSON.stringify(prior) + '\n'
    await writeFile(join(dirs.runDir, 'conversation.jsonl'), prefix + suffix)
    await publish(dirs.exchangeDir, 'pending', request(2))
    const controller = new AbortController()
    let calls = 0
    const done = runResponder({ ...dirs, signal: controller.signal, deadline: Date.now() + 10000, invoke: async ({ conversation }) => {
      calls++
      assert.deepEqual(conversation, [prior])
      assert.equal(await readFile(join(dirs.runDir, 'conversation.jsonl'), 'utf8'), prefix)
      return { text: 'Recovered', reply_type: 'answer' }
    } })
    t.after(() => { controller.abort(); return done.catch(() => {}) })
    assert.equal((await reply(dirs.exchangeDir, 'pending')).text, 'Recovered')
    controller.abort(); assert.equal((await done).status, 'stopped')
    assert.equal(calls, 1)
    const records = (await readFile(join(dirs.runDir, 'conversation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(records.length, 2)
    assert.equal(records[0].text, prior.text)
    assert.equal(records[1].text, 'Recovered')
  }
})

test('corruption in a non-final conversation line fails closed without truncation', async t => {
  const dirs = await setup(t)
  const text = '{bad json}\n' + JSON.stringify({ ...request(1), text: 'Opening', reply_type: 'answer' }) + '\n'
  await writeFile(join(dirs.runDir, 'conversation.jsonl'), text)
  const outcome = await runResponder({ ...dirs, deadline: Date.now() + 10000 })
  assert.equal(outcome.status, 'evaluation-harness-failed')
  assert.equal(await readFile(join(dirs.runDir, 'conversation.jsonl'), 'utf8'), text)
})

test('a complete final record missing its newline is retained and separated from the next append', async t => {
  const dirs = await setup(t)
  const prior = { ...request(1), text: 'Opening', reply_type: 'answer' }
  await writeFile(join(dirs.runDir, 'conversation.jsonl'), JSON.stringify(prior))
  await publish(dirs.exchangeDir, 'pending', request(2))
  const controller = new AbortController()
  const done = runResponder({ ...dirs, signal: controller.signal, deadline: Date.now() + 10000, invoke: async () => ({ text: 'Next', reply_type: 'answer' }) })
  t.after(() => { controller.abort(); return done.catch(() => {}) })
  assert.equal((await reply(dirs.exchangeDir, 'pending')).text, 'Next')
  controller.abort(); await done
  const records = (await readFile(join(dirs.runDir, 'conversation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 2)
  assert.equal(records[0].text, 'Opening')
})
