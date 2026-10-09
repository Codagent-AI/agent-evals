import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
    fetchImpl: async () => ({ ok: true }),
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
  assert.deepEqual(axi, ['stop'])
  assert.equal(env.CHROME_DEVTOOLS_AXI_BROWSER_URL, undefined)
  await assert.rejects(() => access(profile))
  await browser.release()
  assert.deepEqual(signals, ['SIGTERM'])

  // A later browser phase, such as a second-opinion replay, starts it again.
  await browser.ensure()
  assert.equal(launched.length, 2)
  await browser.release()
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
    fetchImpl: async () => ({ ok: true }),
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
    fetchImpl: async () => ({ ok: true }),
    axi: () => new Promise((resolve) => { finishStop = resolve }),
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
