import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  CANDIDATE_IDENTITY_PATH,
  createHostCandidateServer,
} from '../evals/agent-runner/and-scene/lib/candidate-server-host.mjs'

const SUITE_DIR = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'evals/agent-runner/and-scene',
)

async function runDirectory({ build = true } = {}) {
  const dir = await makeTempDir(join(tmpdir(), 'agent-evals-host-server-'))
  if (build) {
    await mkdir(join(dir, '.runtime/candidate-worktree/dist/assets'), { recursive: true })
    await writeFile(join(dir, '.runtime/candidate-worktree/dist/index.html'), '<h1>and-scene</h1>\n')
    await writeFile(join(dir, '.runtime/candidate-worktree/dist/assets/app.js'), 'export const app = 1\n')
  }
  await mkdir(join(dir, '.runtime'), { recursive: true })
  // A sibling of the served build, to prove nothing outside it is reachable.
  await writeFile(join(dir, '.runtime/checkpoint.json'), '{"secret":"not-for-the-reviewer"}\n')
  return dir
}

// A spawn stand-in that behaves as the real server does: it writes the URL file
// its parent is waiting on, and reports a pid.
function fakeSpawn({ url = 'http://127.0.0.1:41731/', pid = 8123 } = {}) {
  const calls = []
  return {
    calls,
    spawn: (command, args) => {
      calls.push([command, ...args])
      const urlFile = args[args.indexOf('--url-file') + 1]
      writeFile(urlFile, `${url}\n`)
      return { pid, unref: () => {} }
    },
  }
}

function fakeFetch(served = { 'http://127.0.0.1:41731/': 'candidate-abc' }) {
  return async (target) => {
    const base = target.replace(new RegExp(`${CANDIDATE_IDENTITY_PATH}$`), '')
    if (!(base in served)) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    return { ok: true, status: 200, text: async () => served[base] }
  }
}

test('starting the candidate server serves the evaluated build and verifies its identity', async () => {
  const dir = await runDirectory()
  const spawner = fakeSpawn()
  const adapter = createHostCandidateServer({
    runDir: dir, spawnImpl: spawner.spawn, fetchImpl: fakeFetch(),
  })

  const server = await adapter.start({ candidate: 'candidate-abc', avoid: null })

  assert.equal(server.pid, 8123)
  assert.equal(server.url, 'http://127.0.0.1:41731/')
  const [command, ...args] = spawner.calls[0]
  assert.match(command, /node|^process\.execPath$/)
  assert.ok(args[0].endsWith('serve-candidate.mjs'), args[0])
  assert.equal(args[args.indexOf('--identity') + 1], 'candidate-abc')
  assert.equal(args[args.indexOf('--root') + 1], join(dir, '.runtime/candidate-worktree/dist'))
})

test('probing an endpoint reports the candidate identity it actually serves', async () => {
  const dir = await runDirectory()
  const adapter = createHostCandidateServer({ runDir: dir, fetchImpl: fakeFetch() })

  assert.deepEqual(await adapter.probe('http://127.0.0.1:41731/'), {
    ok: true, candidate_identity: 'candidate-abc',
  })
})

test('probing an endpoint that does not answer is a refusal rather than a throw', async () => {
  const dir = await runDirectory()
  const adapter = createHostCandidateServer({ runDir: dir, fetchImpl: fakeFetch() })

  const answer = await adapter.probe('http://127.0.0.1:9999/')

  assert.equal(answer.ok, false)
  assert.match(answer.error, /ECONNREFUSED/)
})

test('an unrelated server on the port reports no candidate identity', async () => {
  const dir = await runDirectory()
  const adapter = createHostCandidateServer({
    runDir: dir,
    // Something is listening, but it does not serve the identity endpoint.
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'Not Found' }),
  })

  const answer = await adapter.probe('http://127.0.0.1:41731/')

  assert.equal(answer.ok, false)
  assert.match(answer.error, /404/)
})

test('a candidate with no build output cannot be served and says so', async () => {
  const dir = await runDirectory({ build: false })
  const adapter = createHostCandidateServer({ runDir: dir, spawnImpl: fakeSpawn().spawn })

  await assert.rejects(
    adapter.start({ candidate: 'candidate-abc' }),
    (error) => (
      error.owner === 'product'
      && error.code === 'candidate-product-serve-failed'
      && /no built candidate to serve/.test(error.message)
    ),
  )
})

test('a build directory without an application shell is a reproducible product serve failure', async () => {
  const dir = await runDirectory({ build: false })
  await mkdir(join(dir, '.runtime/candidate-worktree/dist'), { recursive: true })
  const adapter = createHostCandidateServer({ runDir: dir, spawnImpl: fakeSpawn().spawn })

  await assert.rejects(
    adapter.start({ candidate: 'candidate-abc' }),
    (error) => (
      error.owner === 'product'
      && error.code === 'candidate-product-serve-failed'
      && /application shell/.test(error.message)
    ),
  )
})

test('a failed start terminates the detached candidate server', async () => {
  const dir = await runDirectory()
  const killed = []
  const adapter = createHostCandidateServer({
    runDir: dir,
    spawnImpl: () => ({ pid: 8123, unref: () => {} }),
    killImpl: (pid, signal) => killed.push([pid, signal]),
    startTimeoutMs: 1,
  })

  await assert.rejects(adapter.start({ candidate: 'candidate-abc' }), /timed out/)
  assert.deepEqual(killed, [[8123, 'SIGTERM']])
})

test('stopping the server signals only the recorded process', async () => {
  const dir = await runDirectory()
  const killed = []
  const adapter = createHostCandidateServer({ runDir: dir, killImpl: (pid, signal) => killed.push([pid, signal]) })

  await adapter.stop({ pid: 8123, url: 'http://127.0.0.1:41731/' })

  assert.deepEqual(killed, [[8123, 'SIGTERM']])
})

// The integration test: the real script, over a real socket. This is what proves
// the shipped command can actually serve a candidate.
test('the real server script serves the build and its identity over HTTP', async () => {
  const dir = await runDirectory()
  const adapter = createHostCandidateServer({ runDir: dir, serverScript: join(SUITE_DIR, 'serve-candidate.mjs') })

  const server = await adapter.start({ candidate: 'candidate-abc' })
  try {
    assert.ok(Number.isInteger(server.pid))
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)

    assert.deepEqual(await adapter.probe(server.url), { ok: true, candidate_identity: 'candidate-abc' })

    const index = await fetch(server.url)
    assert.equal(index.status, 200)
    assert.match(await index.text(), /and-scene/)

    const asset = await fetch(`${server.url}assets/app.js`)
    assert.equal(asset.status, 200)

    // A single-page app serves its shell for unknown routes, but never a file
    // outside the build it was pointed at.
    const unknownRoute = await fetch(`${server.url}how-to-make-a-presentation`)
    assert.equal(unknownRoute.status, 200)
    assert.match(await unknownRoute.text(), /and-scene/)

    // Nothing outside the build is reachable, however the escape is spelled.
    for (const attempt of [
      '../checkpoint.json',
      '%2e%2e%2fcheckpoint.json',
      '..%2f..%2fcheckpoint.json',
      '/../checkpoint.json',
    ]) {
      const response = await fetch(`${server.url}${attempt}`)
      assert.doesNotMatch(await response.text(), /not-for-the-reviewer/, attempt)
    }
  } finally {
    await adapter.stop(server)
  }
})

test('the real server refuses to start without a build directory', async () => {
  const dir = await runDirectory({ build: false })
  const adapter = createHostCandidateServer({ runDir: dir, serverScript: join(SUITE_DIR, 'serve-candidate.mjs') })

  await assert.rejects(adapter.start({ candidate: 'candidate-abc' }), /no built candidate to serve/)
  await assert.rejects(readFile(join(dir, '.runtime/candidate-server-url'), 'utf8'), { code: 'ENOENT' })
})

// A DevTools endpoint that answers only while the fake Chrome runs: before
// launch the port must be free.
const devtoolsWhile = (running) => async () => {
  if (!running()) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  return { ok: true, status: 200 }
}

// Host rescores on a 16 GB machine: an idle headless Chrome held through the
// whole run grew to about 9 GB. The host browser now starts on demand with
// memory-limiting flags and is released after each browser phase.
test('the host browser starts lean on demand and releases its process and profile', async t => {
  const { createHostBrowser, HOST_CHROME_FLAGS } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const { EventEmitter } = await import('node:events')
  const { access } = await import('node:fs/promises')
  const launched = []
  const signals = []
  const axi = []
  const env = {}
  const children = []
  const browser = createHostBrowser({
    chromePath: '/fake/chrome',
    port: 9555,
    env,
    // Never signal a real process group from a test.
    killGroup: (pid, signal) => children.find((child) => child.pid === pid).kill(signal),
    log: () => {},
    spawnImpl: (command, args) => {
      const child = new EventEmitter()
      child.pid = 4242 + launched.length
      child.exitCode = null
      launched.push({ command, args })
      children.push(child)
      child.kill = (signal) => {
        signals.push(signal)
        child.exitCode = 0
        setImmediate(() => child.emit('exit', 0, signal))
        return true
      }
      return child
    },
    fetchImpl: devtoolsWhile(() => children.some((child) => child.exitCode === null)),
    axi: async (args) => { axi.push(args.join(' ')) },
  })
  t.after(() => browser.release())

  await browser.ensure()
  await browser.ensure()
  assert.equal(launched.length, 1)
  assert.equal(env.CHROME_DEVTOOLS_AXI_BROWSER_URL, 'http://127.0.0.1:9555')
  const args = launched[0].args
  for (const flag of HOST_CHROME_FLAGS) assert.ok(args.includes(flag), flag)
  assert.ok(args.includes('--headless=new'))
  assert.ok(args.includes('--remote-debugging-port=9555'))
  assert.ok(args.some((arg) => arg.startsWith('--js-flags=--max-old-space-size=')))
  const profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)

  await browser.release()
  assert.deepEqual(signals, ['SIGTERM'])
  assert.deepEqual(axi, ['stop', 'stop'])
  assert.equal(env.CHROME_DEVTOOLS_AXI_BROWSER_URL, undefined)
  await assert.rejects(() => access(profile))
  await browser.release()
  assert.deepEqual(signals, ['SIGTERM'])

  // A later browser phase, such as a second-opinion replay, starts it again.
  await browser.ensure()
  assert.equal(launched.length, 2)
  await browser.release()
})

// Factory eval repetition 5190d29c rep 1 failed its browser evaluation with
// "presentation step count was not found": an implementation agent had killed
// the sandbox Chromium and launched its own on the same port, and the
// evaluation drove that browser through the agent's AXI bridge. Browser phases
// now use their own Chrome through their own AXI session, and give the
// environment back afterwards.
test('browser phases score in their own Chrome and AXI session, then restore the agents\' browser environment', async t => {
  const { createHostBrowser, EVALUATOR_AXI_SESSION } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const { EventEmitter } = await import('node:events')
  const launched = []
  const axi = []
  const env = {
    CHROME_DEVTOOLS_AXI_BROWSER_URL: 'http://127.0.0.1:9333',
    CHROME_DEVTOOLS_AXI_PORT: '9224',
    AND_SCENE_HOST_CHROME_ARGS: '--no-sandbox  --disable-setuid-sandbox',
  }
  let chrome = null
  const browser = createHostBrowser({
    chromePath: '/fake/chrome', port: 9334, env,
    spawnImpl: (_command, args) => {
      launched.push(args)
      const profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)
      t.after(() => rm(profile, { recursive: true, force: true }))
      chrome = Object.assign(new EventEmitter(), { pid: 7171, exitCode: null, kill: () => true })
      return chrome
    },
    killGroup: () => {
      chrome.exitCode = 0
      setImmediate(() => chrome.emit('exit', 0))
    },
    log: () => {},
    fetchImpl: devtoolsWhile(() => chrome?.exitCode === null),
    axi: async (args, axiEnv) => { axi.push([args.join(' '), axiEnv.CHROME_DEVTOOLS_AXI_SESSION, axiEnv.CHROME_DEVTOOLS_AXI_PORT]) },
    sleep: async () => {},
  })
  t.after(() => browser.release())

  await browser.ensure()
  assert.equal(env.CHROME_DEVTOOLS_AXI_BROWSER_URL, 'http://127.0.0.1:9334')
  assert.equal(env.CHROME_DEVTOOLS_AXI_SESSION, EVALUATOR_AXI_SESSION)
  assert.equal(env.CHROME_DEVTOOLS_AXI_PORT, undefined, 'an inherited bridge port would reach the agents\' bridge')
  assert.ok(launched[0].includes('--no-sandbox'))
  assert.ok(launched[0].includes('--disable-setuid-sandbox'))
  assert.ok(!launched[0].includes(''))
  // A stale evaluator bridge is dropped before the phase attaches.
  assert.deepEqual(axi, [['stop', EVALUATOR_AXI_SESSION, undefined]])

  await browser.release()
  assert.deepEqual(axi.at(-1), ['stop', EVALUATOR_AXI_SESSION, undefined], 'release stops only the evaluator session')
  assert.deepEqual(env, {
    CHROME_DEVTOOLS_AXI_BROWSER_URL: 'http://127.0.0.1:9333',
    CHROME_DEVTOOLS_AXI_PORT: '9224',
    AND_SCENE_HOST_CHROME_ARGS: '--no-sandbox  --disable-setuid-sandbox',
  })
})

// A stale evaluator bridge that cannot be stopped could leave the phase
// driving that bridge's browser, so the phase fails instead of launching.
test('a browser phase whose stale evaluator bridge cannot be stopped fails as a harness fault without launching', async () => {
  const { createHostBrowser } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const launched = []
  const env = { CHROME_DEVTOOLS_AXI_BROWSER_URL: 'http://127.0.0.1:9333' }
  const browser = createHostBrowser({
    chromePath: '/fake/chrome', port: 9334, env,
    spawnImpl: (...args) => { launched.push(args); throw new Error('must not launch') },
    log: () => {},
    fetchImpl: async () => ({ ok: true }),
    axi: async () => { throw new Error('bridge did not stop') },
    sleep: async () => {},
  })
  await assert.rejects(browser.ensure(), (error) => {
    assert.equal(error.owner, 'evaluation-harness')
    assert.equal(error.code, 'browser-driver-failed')
    assert.equal(error.resumable, true)
    assert.match(error.message, /bridge did not stop/)
    return true
  })
  assert.deepEqual(launched, [])
  assert.deepEqual(env, { CHROME_DEVTOOLS_AXI_BROWSER_URL: 'http://127.0.0.1:9333' })
})

// Five factory evals in a row lost their browser evaluation to "host Chrome did
// not expose its DevTools endpoint" with no cause: Chrome's output was
// discarded and readiness gave up after 10 s. A cold Chrome on a loaded Fly
// Machine can need longer, and a Chrome that dies must say how.
function fakeChrome({ startsAfterMs = null, exitWith = null, output = '' } = {}) {
  let clock = 0
  const state = { chrome: null, launches: 0 }
  return {
    state,
    now: () => clock,
    // Time passes in the fake clock, but events still get their turn.
    sleep: async (ms) => { clock += ms; await new Promise((resolve) => setImmediate(resolve)) },
    killGroup: (_pid, signal) => {
      state.chrome.exitCode = 0
      setImmediate(() => state.chrome.emit('exit', null, signal))
    },
    spawnImpl: (_command, _args, options) => {
      state.launches += 1
      state.launchedAt = clock
      state.chrome = Object.assign(new EventEmitter(), { pid: 8181, exitCode: null, kill: () => true })
      if (output) writeSync(options.stdio[2], output)
      if (exitWith) {
        const chrome = state.chrome
        setImmediate(() => { chrome.exitCode = exitWith.code; chrome.emit('exit', exitWith.code, exitWith.signal ?? null) })
      }
      return state.chrome
    },
    fetchImpl: async () => {
      const listening = state.chrome?.exitCode === null && startsAfterMs !== null && clock - state.launchedAt >= startsAfterMs
      if (!listening) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      return { ok: true, status: 200 }
    },
  }
}

test('a host Chrome that exits before listening fails at once with its exit code and output, kept under the run directory', async () => {
  const { createHostBrowser, HOST_CHROME_LOG } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const runDir = await makeTempDir(join(tmpdir(), 'agent-evals-host-chrome-'))
  // Verbose output well past the bytes the failure reads back; only its tail reaches the error.
  const verbose = `early output\n${'chrome noise\n'.repeat(20_000)}`
  const fake = fakeChrome({ exitWith: { code: 1 }, output: `${verbose}starting\n[0101/000000.000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox!\n` })
  const env = { CHROME_DEVTOOLS_AXI_BROWSER_URL: 'http://127.0.0.1:9333' }
  const browser = createHostBrowser({ chromePath: '/fake/chrome', port: 9334, env, runDir, log: () => {}, axi: async () => {}, ...fake })
  await assert.rejects(browser.ensure(), (error) => {
    assert.equal(error.owner, 'evaluation-harness')
    assert.equal(error.code, 'browser-driver-failed')
    assert.equal(error.resumable, true)
    assert.match(error.message, /did not expose its DevTools endpoint at http:\/\/127\.0\.0\.1:9334: it exited with code 1 after 0\.\d s/)
    assert.match(error.message, /last probe no answer \(ECONNREFUSED\)/)
    assert.match(error.message, /No usable sandbox!/)
    assert.doesNotMatch(error.message, /early output/)
    assert.match(error.message, new RegExp(`full log ${HOST_CHROME_LOG}`))
    return true
  })
  assert.equal(fake.state.launches, 1)
  const logText = await readFile(join(runDir, HOST_CHROME_LOG), 'utf8')
  assert.match(logText, /launching \/fake\/chrome on port 9334/)
  assert.match(logText, /No usable sandbox!/)
  assert.match(logText, /not ready: it exited with code 1/)
  assert.deepEqual(env, { CHROME_DEVTOOLS_AXI_BROWSER_URL: 'http://127.0.0.1:9333' })
})

test('a host Chrome that starts slowly is waited for beyond 10 s, and its start time is logged', async () => {
  const { createHostBrowser, HOST_CHROME_LOG } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const runDir = await makeTempDir(join(tmpdir(), 'agent-evals-host-chrome-'))
  const fake = fakeChrome({ startsAfterMs: 20_000 })
  const browser = createHostBrowser({ chromePath: '/fake/chrome', port: 9334, env: {}, runDir, log: () => {}, axi: async () => {}, ...fake })
  assert.equal(await browser.ensure(), 'http://127.0.0.1:9334')
  await browser.release()
  assert.match(await readFile(join(runDir, HOST_CHROME_LOG), 'utf8'), /DevTools endpoint ready after 20\.0 s/)
})

test('a host Chrome that never listens is stopped after the readiness deadline and reported as still running', async () => {
  const { createHostBrowser } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const fake = fakeChrome({ output: 'still loading\n' })
  const browser = createHostBrowser({ chromePath: '/fake/chrome', port: 9334, env: {}, log: () => {}, axi: async () => {}, ...fake })
  await assert.rejects(browser.ensure(), (error) => {
    assert.match(error.message, /it was still running after 60\.0 s; last probe no answer \(ECONNREFUSED\)/)
    // Without a run directory the log goes with the profile, but its tail is kept.
    assert.match(error.message, /Chrome output: still loading$/)
    return true
  })
  assert.equal(fake.state.chrome.exitCode, 0, 'the Chrome that never listened was stopped')
})

test('a port that already answers DevTools requests fails the phase without launching another Chrome', async () => {
  const { createHostBrowser } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const launched = []
  const env = {}
  const browser = createHostBrowser({
    chromePath: '/fake/chrome', port: 9334, env, log: () => {}, axi: async () => {},
    spawnImpl: (...args) => { launched.push(args); throw new Error('must not launch') },
    fetchImpl: async () => ({ ok: false, status: 404 }),
    sleep: async () => {},
  })
  await assert.rejects(browser.ensure(), (error) => {
    assert.equal(error.code, 'browser-driver-failed')
    assert.match(error.message, /port 9334 already answers DevTools requests \(HTTP 404\), so another process holds it/)
    return true
  })
  assert.deepEqual(launched, [])
  assert.deepEqual(env, {})
})

// A sanity rescore failed its browser phase when Chrome's helpers were still
// writing the profile while it was removed.
test('releasing the host browser never fails the phase that used it', async t => {
  const { createHostBrowser } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const { EventEmitter } = await import('node:events')
  const removals = []
  const killed = []
  let chrome = null
  const browser = createHostBrowser({
    chromePath: '/fake/chrome', port: 9556, env: {},
    spawnImpl: (_command, args) => {
      const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)
      // This test deliberately makes product cleanup fail; remove only its own profile.
      t.after(() => rm(profile, { recursive: true, force: true, maxRetries: 3 }))
      chrome = new EventEmitter()
      chrome.pid = 5151
      chrome.exitCode = null
      chrome.kill = () => true
      return chrome
    },
    killGroup: (pid, signal) => {
      killed.push([pid, signal])
      chrome.exitCode = 0
      setImmediate(() => chrome.emit('exit', 0))
    },
    log: () => {},
    fetchImpl: devtoolsWhile(() => chrome?.exitCode === null),
    axi: async () => {},
    rmImpl: async (path, options) => {
      removals.push(options)
      throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' })
    },
    sleep: async () => {},
  })
  t.after(() => browser.release())
  await browser.ensure()
  await browser.release()
  assert.ok(removals.length >= 1)
  assert.ok(removals[0].maxRetries >= 3)
  assert.deepEqual(killed[0], [5151, 'SIGTERM'])
})

// Without MacAppCodeSignClone disabled, every Chrome launch on macOS copies the
// whole app into a temp folder, and a Chrome that is killed leaves it behind.
test('the host browser disables the macOS code-sign clone in its one disable-features switch', async () => {
  const { HOST_CHROME_FLAGS } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const disabled = HOST_CHROME_FLAGS.filter((flag) => flag.startsWith('--disable-features='))
  assert.equal(disabled.length, 1, 'Chrome keeps only the last --disable-features switch')
  assert.ok(disabled[0].slice('--disable-features='.length).split(',').includes('MacAppCodeSignClone'))
})

// A rescore that threw, or was stopped with Ctrl-C or kill, left its headless
// Chrome and the AXI bridge running.
test('the host browser is released when the evaluation throws or the process is signalled', async () => {
  const { withHostBrowser } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const { EventEmitter } = await import('node:events')
  const fakeProcess = () => Object.assign(new EventEmitter(), { exits: [], exit(code) { this.exits.push(code) } })
  let releases = 0
  const browser = { release: async () => { releases += 1 } }

  const thrown = fakeProcess()
  await assert.rejects(withHostBrowser(browser, async () => { throw new Error('judge failed') }, { processImpl: thrown }), /judge failed/)
  assert.equal(releases, 1)
  assert.equal(thrown.listenerCount('SIGINT') + thrown.listenerCount('SIGTERM'), 0)

  const done = fakeProcess()
  assert.equal(await withHostBrowser(browser, async () => 'scored', { processImpl: done }), 'scored')
  assert.equal(releases, 2)

  for (const [name, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const signalled = fakeProcess()
    let started
    const running = new Promise((resolve) => { started = resolve })
    withHostBrowser(browser, () => { started(); return new Promise(() => {}) }, { processImpl: signalled })
    await running
    const before = releases
    signalled.emit(name)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(releases, before + 1, name)
    assert.deepEqual(signalled.exits, [code], name)
  }

  assert.equal(await withHostBrowser(null, async () => 'no browser', { processImpl: fakeProcess() }), 'no browser')
})

// A signal that arrives while a phase is already releasing the browser must not
// exit before that release has stopped Chrome and removed its profile.
test('a release that starts while another is running waits for the same cleanup', async t => {
  const { createHostBrowser } = await import('../evals/agent-runner/and-scene/lib/host-browser.mjs')
  const { EventEmitter } = await import('node:events')
  let chrome = null
  let finishStop
  let profileRemoved = null
  const browser = createHostBrowser({
    chromePath: '/fake/chrome', port: 9557, env: {},
    spawnImpl: () => {
      chrome = Object.assign(new EventEmitter(), { pid: 6161, exitCode: null, kill: () => true })
      return chrome
    },
    killGroup: () => {
      chrome.exitCode = 0
      setImmediate(() => chrome.emit('exit', 0))
    },
    log: () => {},
    fetchImpl: devtoolsWhile(() => chrome?.exitCode === null),
    // Only the release's stop is held; the stop before launch returns at once.
    axi: () => (chrome ? new Promise((resolve) => { finishStop = resolve }) : Promise.resolve()),
    rmImpl: async (path) => { profileRemoved = path },
    sleep: async () => {},
  })
  t.after(() => browser.release())
  await browser.ensure()
  const first = browser.release()
  let secondDone = false
  const second = browser.release().then(() => { secondDone = true })
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(secondDone, false, 'the second release waits while AXI is still stopping')
  assert.equal(profileRemoved, null, 'the profile stays until Chrome has stopped')
  finishStop()
  await Promise.all([first, second])
  assert.equal(chrome.exitCode, 0)
  // The fake rmImpl removed nothing; remove the real temp profile.
  await rm(profileRemoved, { recursive: true, force: true })
})
