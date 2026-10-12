import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ptyAvailable, ptyExec, ptyInvocation, shellQuote } from '../evals/agent-runner/and-scene/lib/pty-exec.mjs'

const linuxScript = process.platform === 'linux'
  && /util-linux/.test(spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout ?? '')

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 999_999_999
  child.stdin = Object.assign(new EventEmitter(), { destroy() { this.destroyed = true } })
  child.signals = []
  child.kill = (signal) => {
    child.signals.push(signal)
    if (signal === 'SIGTERM') setImmediate(() => child.emit('close', 143, null))
    return true
  }
  return child
}

test('arguments are single-quoted so no argument becomes shell syntax', () => {
  assert.equal(shellQuote(`a'b`), `'a'\\''b'`)
  const { command, args } = ptyInvocation('agent-runner', ['run', 'x=`id` $(id) "q"'], { rows: 40, columns: 120 })
  assert.equal(command, 'script')
  assert.deepEqual(args.slice(0, 4), ['--quiet', '--return', '--flush', '--command'])
  assert.equal(args.at(-1), '/dev/null')
  assert.equal(args[4], `stty rows 40 cols 120 2>/dev/null; exec 'agent-runner' 'run' 'x=\`id\` $(id) "q"'`)
})

test('the pseudo-terminal is supported only by util-linux script on Linux', () => {
  assert.equal(ptyAvailable({ platform: 'darwin' }).ok, false)
  const missing = ptyAvailable({ platform: 'linux', exec: () => ({ status: null, error: new Error('ENOENT') }) })
  assert.match(missing.reason, /not installed/)
  const bsd = ptyAvailable({ platform: 'linux', exec: () => ({ status: 0, stdout: 'script 1.0\n' }) })
  assert.match(bsd.reason, /not util-linux/)
  assert.equal(ptyAvailable({ platform: 'linux', exec: () => ({ status: 0, stdout: 'script from util-linux 2.39.3\n' }) }).ok, true)
})

test('the executor keeps stdin open, runs detached, and reports the exit status', async () => {
  const child = fakeChild()
  let seen
  const pending = ptyExec('agent-runner', ['run'], {
    spawn: (command, args, options) => { seen = { command, args, options }; return child },
    env: { PATH: '/bin' },
  })
  setImmediate(() => child.emit('close', 3, null))
  const result = await pending
  assert.equal(seen.command, 'script')
  assert.equal(seen.options.detached, true)
  assert.equal(seen.options.stdio[0], 'pipe')
  assert.equal(seen.options.env.TERM, 'xterm-256color')
  assert.equal(result.status, 3)
  assert.equal(result.error, undefined)
  assert.equal(child.stdin.destroyed, true)
})

test('a run with no durable activity for the stall timeout is ended as stalled', async () => {
  const child = fakeChild()
  let tick
  let clock = 0
  const pending = ptyExec('agent-runner', ['run'], {
    spawn: () => child,
    now: () => clock,
    setInterval: (callback) => { tick = callback; return { unref() {} } },
    clearInterval: () => {},
    stall: { timeoutMs: 1000, maxMs: 10_000, lastActivityMs: () => 500 },
  })
  clock = 1400
  tick()
  assert.deepEqual(child.signals, [])
  clock = 1600
  tick()
  const result = await pending
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(result.ended, 'stalled')
  assert.equal(result.error.code, 'ESTALLED')
})

test('a run that keeps progressing past the hard cap is ended as timed out', async () => {
  const child = fakeChild()
  let tick
  let clock = 0
  const pending = ptyExec('agent-runner', ['run'], {
    spawn: () => child,
    now: () => clock,
    setInterval: (callback) => { tick = callback; return { unref() {} } },
    clearInterval: () => {},
    stall: { timeoutMs: 1000, maxMs: 5000, lastActivityMs: () => clock },
  })
  clock = 4000
  tick()
  assert.deepEqual(child.signals, [])
  clock = 5000
  tick()
  const result = await pending
  assert.equal(result.ended, 'timed-out')
  assert.equal(result.error.code, 'ETIMEDOUT')
})

test('a process that never closes after SIGKILL still settles', async () => {
  const child = fakeChild()
  child.kill = (signal) => { child.signals.push(signal); return true }
  let tick
  let clock = 0
  const pending = ptyExec('agent-runner', ['run'], {
    spawn: () => child,
    now: () => clock,
    setInterval: (callback) => { tick = callback; return { unref() {} } },
    clearInterval: () => {},
    killGraceMs: 5,
    stall: { timeoutMs: 1000, lastActivityMs: () => 0 },
  })
  clock = 2000
  tick()
  const result = await pending
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(result.error.code, 'ESTALLED')
})

test('a stop signal sent to the controller reaches Agent Runner, and the controller then ends with it', async () => {
  const child = fakeChild()
  const host = Object.assign(new EventEmitter(), { pid: 42, raised: [], kill(pid, signal) { this.raised.push([pid, signal]) } })
  const pending = ptyExec('agent-runner', ['run'], { spawn: () => child, host })
  host.emit('SIGTERM', 'SIGTERM')
  const result = await pending
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(result.signal, 'SIGTERM')
  assert.deepEqual(host.raised, [[42, 'SIGTERM']])
  assert.equal(host.listenerCount('SIGTERM'), 0)

  // Another handler in the controller decides how to exit; the signal is not raised again.
  const second = fakeChild()
  const owned = () => {}
  host.on('SIGINT', owned)
  const handled = ptyExec('agent-runner', ['run'], { spawn: () => second, host })
  host.emit('SIGINT', 'SIGINT')
  setImmediate(() => second.emit('close', 130, null))
  assert.equal((await handled).signal, 'SIGINT')
  assert.deepEqual(host.raised, [[42, 'SIGTERM']])
})

test('real script: the child gets a terminal on stdin and arguments arrive intact', { skip: !linuxScript }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pty-exec-'))
  const out = join(dir, 'out.txt')
  const tricky = `it's a "test" with \`ticks\` and $(dollars)`
  const result = await ptyExec('sh', ['-c', `{ test -t 0 && echo tty || echo notty; printf "%s\\n" "$1"; stty size; } > ${shellQuote(out)}`, 'sh', tricky], {
    cwd: dir,
  })
  assert.equal(result.status, 0)
  const lines = (await readFile(out, 'utf8')).trim().split('\n')
  assert.deepEqual(lines, ['tty', tricky, '50 200'])
})

test('real script: the exit status passes through', { skip: !linuxScript }, async () => {
  const result = await ptyExec('sh', ['-c', 'exit 7'])
  assert.equal(result.status, 7)
})

test('real script: stdin never reaches end of input, so only the stall ends the read', { skip: !linuxScript }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pty-exec-'))
  const marker = join(dir, 'read-returned')
  await writeFile(marker, '')
  const started = Date.now()
  const result = await ptyExec('sh', ['-c', `read line; echo returned > ${shellQuote(marker)}`], {
    stall: { timeoutMs: 1500, pollMs: 250, lastActivityMs: () => null },
  })
  assert.equal(result.ended, 'stalled')
  assert.ok(Date.now() - started >= 1500)
  assert.equal(await readFile(marker, 'utf8'), '')
})
