// The headless Chrome the evaluator scores with, driven through
// chrome-devtools-axi.
//
// The evaluator owns this browser in the sandbox and on a host alike. In the
// sandbox the implementation agents share another Chromium for their own
// testing, and they can stop, restart, or reconfigure it: one killed it and
// launched its own on the same port, and the browser evaluation then ran in
// the agent's browser through the agent's AXI bridge and failed. So browser
// phases use a fresh Chrome on a port of their own, reached through an AXI
// session of their own, never an agent's.
//
// On a host Chrome shares a small machine with everything else, and an idle
// Chrome held through an hour of source judging grew to about 9 GB. So the
// browser starts only when a browser phase needs it, with flags that keep it
// lean, and is released as soon as that phase ends; a later phase, such as a
// second-opinion replay, starts a fresh one.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Flags that cut background work, extra processes, and caches. The candidate
// page is a local static app, so site isolation and the GPU are not needed.
// MacAppCodeSignClone stops macOS Chrome from copying its whole app into a
// temp folder on every launch, a copy a killed Chrome leaves behind. Chrome
// keeps only the last --disable-features switch, so every feature is listed in
// this one.
export const HOST_CHROME_FLAGS = [
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--renderer-process-limit=2',
  '--disable-site-isolation-trials',
  '--disable-features=site-per-process,Translate,BackForwardCache,MediaRouter,OptimizationHints,MacAppCodeSignClone',
  '--disk-cache-size=1048576',
]
const JS_HEAP_MB = 1024
// A cold Chrome on a shared-CPU Fly Machine, after hours of implementation
// have pushed it out of the page cache, can take well over 10 s to listen: the
// agents' Chromium needs about 6 s on the same machine when it is fresh and
// idle. The deadline is generous because a slow start that misses it discards
// the whole run's evaluation; a Chrome that exits fails at once instead.
const READY_TIMEOUT_MS = 60_000
const READY_DELAY_MS = 250
const PROBE_TIMEOUT_MS = 2_000
const OUTPUT_TAIL_LINES = 15
const OUTPUT_TAIL_CHARS = 2_000
// Bytes read from the end of the log, so a large accumulated log is never loaded whole.
const OUTPUT_TAIL_BYTES = 64 * 1024
const EXIT_GRACE_MS = 5000

// The AXI session browser phases drive, so the evaluator never reuses a bridge
// an implementation agent started (or the default session of whoever runs a
// host rescore). AXI derives the session's bridge port from its name.
export const EVALUATOR_AXI_SESSION = 'and-scene-evaluator'
// The environment browser phases change while they hold the browser, restored
// when they release it.
const BROWSER_ENV = [
  'CHROME_DEVTOOLS_AXI_BROWSER_URL',
  'CHROME_DEVTOOLS_AXI_SESSION',
  'CHROME_DEVTOOLS_AXI_PORT',
]

const defaultAxi = async (args, env = process.env) => {
  const result = spawnSync('chrome-devtools-axi', args, { encoding: 'utf8', timeout: 30_000, env })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim()
      || (result.signal ? `killed by ${result.signal}` : `exited with status ${result.status}`)
    throw new Error(`chrome-devtools-axi ${args.join(' ')} failed: ${detail}`)
  }
}

// Chrome's own output, kept under the run directory so a browser phase that
// cannot start its Chrome leaves a cause behind. Every launch appends to it.
export const HOST_CHROME_LOG = 'phases/command-output/host-chrome.log'

const harnessFault = (message) => Object.assign(new Error(message), {
  owner: 'evaluation-harness', code: 'browser-driver-failed', resumable: true,
})
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

export function createHostBrowser({
  chromePath,
  port = 9333,
  // Without a run directory (a test, or a caller with nowhere to keep it) the
  // log lives in the profile and is gone once the browser is released; its
  // tail still reaches the error.
  runDir = null,
  env = process.env,
  spawnImpl = spawn,
  fetchImpl = fetch,
  axi = defaultAxi,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  rmImpl = rm,
  // Chrome leads its own process group, so its helpers stop with it.
  killGroup = (pid, signal) => process.kill(-pid, signal),
  log = (line) => console.error(line),
} = {}) {
  let child = null
  let exit = null
  let profile = null
  let savedEnv = null
  let output = null
  const url = `http://127.0.0.1:${port}`

  // One DevTools request: { ok, status } for any HTTP answer, { error } when
  // nothing answered.
  async function probe() {
    try {
      const response = await fetchImpl(`${url}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      return { ok: response.ok, status: response.status }
    } catch (error) {
      return { ok: false, error: error.cause?.code ?? error.name ?? error.message }
    }
  }
  const describeProbe = (result) => {
    if (!result) return 'none'
    return result.error ? `no answer (${result.error})` : `HTTP ${result.status}`
  }

  function openOutput() {
    const candidates = [runDir && join(runDir, HOST_CHROME_LOG), join(profile, 'host-chrome.log')].filter(Boolean)
    for (const path of candidates) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const fd = openSync(path, 'a')
        return { path, fd, label: path === candidates[0] && runDir ? HOST_CHROME_LOG : null }
      } catch (error) {
        log(`host-browser: could not open ${path}: ${error.message}`)
      }
    }
    return null
  }
  const note = (line) => {
    if (!output) return
    try {
      writeSync(output.fd, `--- ${new Date().toISOString()} ${line} ---\n`)
    } catch {
      // The note is diagnostic; the browser phase does not depend on it.
    }
  }
  // The last lines Chrome wrote since this launch began.
  function outputTail() {
    if (!output) return null
    let fd
    try {
      fd = openSync(output.path, 'r')
      const size = statSync(output.path).size
      const start = Math.max(output.start, size - OUTPUT_TAIL_BYTES)
      const buffer = Buffer.alloc(Math.max(0, size - start))
      const read = readSync(fd, buffer, 0, buffer.length, start)
      const text = buffer.subarray(0, read).toString('utf8').trim()
      return text.split('\n').slice(-OUTPUT_TAIL_LINES).join('\n').slice(-OUTPUT_TAIL_CHARS)
    } catch {
      return null
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  async function ensure() {
    if (child) {
      if (!exit && child.exitCode === null) return url
      // Chrome died since the last phase; clear its state before starting another.
      await release()
    }
    if (!savedEnv) {
      savedEnv = Object.fromEntries(BROWSER_ENV.map((name) => [name, env[name]]))
      env.CHROME_DEVTOOLS_AXI_SESSION = EVALUATOR_AXI_SESSION
      // An inherited port would put this session's bridge on another
      // session's port.
      delete env.CHROME_DEVTOOLS_AXI_PORT
    }
    // A bridge an earlier phase or job left in this session is attached to a
    // Chrome that is gone; drop it so the first command attaches afresh. If it
    // cannot be dropped, the phase could drive that bridge's browser instead
    // of this one, so it fails as the harness's own resumable fault.
    try {
      await axi(['stop'], env)
    } catch (error) {
      await release()
      throw harnessFault(`could not stop a stale evaluator AXI bridge: ${error.message}`)
    }
    // Something already answering on the port is not this phase's browser,
    // and the Chrome about to start could not listen there.
    const occupied = await probe()
    if (!occupied.error) {
      await release()
      throw harnessFault(`host Chrome could not start: port ${port} already answers DevTools requests (${describeProbe(occupied)}), so another process holds it`)
    }
    profile = await mkdtemp(join(tmpdir(), 'and-scene-host-chrome-'))
    output = openOutput()
    if (output) {
      note(`launching ${chromePath} on port ${port}`)
      try { output.start = statSync(output.path).size } catch { output.start = 0 }
    }
    exit = null
    const launched = spawnImpl(chromePath, [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--js-flags=--max-old-space-size=${JS_HEAP_MB}`,
      ...HOST_CHROME_FLAGS,
      // Flags the caller's environment needs, such as --no-sandbox in the
      // sandbox container (run.sh).
      ...String(env.AND_SCENE_HOST_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean),
      'about:blank',
    ], { stdio: ['ignore', output?.fd ?? 'ignore', output?.fd ?? 'ignore'], detached: true })
    child = launched
    launched.once('exit', (code, signal) => { if (child === launched) exit ??= { code, signal } })
    // A binary that cannot be started reports an error and may never exit.
    launched.once('error', (error) => { if (child === launched) exit ??= { error } })

    const started = now()
    let last = null
    while (!exit) {
      last = await probe()
      if (last.ok && !exit) {
        note(`DevTools endpoint ready after ${seconds(now() - started)}`)
        env.CHROME_DEVTOOLS_AXI_BROWSER_URL = url
        return url
      }
      if (exit || now() - started >= READY_TIMEOUT_MS) break
      await sleep(READY_DELAY_MS)
    }
    const waited = seconds(now() - started)
    let cause = `it was still running after ${waited}`
    if (exit?.error) cause = `it could not be started (${exit.error.message})`
    else if (exit?.signal) cause = `it was killed by ${exit.signal} after ${waited}`
    else if (exit) cause = `it exited with code ${exit.code} after ${waited}`
    const tail = outputTail()
    note(`DevTools endpoint not ready: ${cause}; last probe ${describeProbe(last)}`)
    const where = output?.label ? ` (full log ${output.label})` : ''
    await release()
    throw harnessFault(`host Chrome did not expose its DevTools endpoint at ${url}: ${cause}; last probe ${describeProbe(last)}. Chrome output${where}: ${tail || '(none)'}`)
  }

  const signal = (running, name) => {
    try {
      killGroup(running.pid, name)
    } catch {
      running.kill(name)
    }
  }

  // Releasing is cleanup: it never fails the browser phase that used Chrome.
  // A release that starts while another is running, such as a signal during a
  // phase's cleanup, waits for that one rather than returning before Chrome
  // has stopped.
  let releasing = null
  function release() {
    releasing ??= stopAndRemove().finally(() => { releasing = null })
    return releasing
  }

  async function stopAndRemove() {
    const running = child
    child = null
    if (running) {
      // The AXI bridge holds a connection to this Chrome; drop it first so the
      // next phase reconnects to the fresh browser.
      await axi(['stop'], env).catch(() => {})
      if (!exit && running.exitCode === null) {
        const exited = new Promise((resolve) => running.once('exit', resolve))
        signal(running, 'SIGTERM')
        const timer = setTimeout(() => { if (running.exitCode === null) signal(running, 'SIGKILL') }, EXIT_GRACE_MS)
        await exited
        clearTimeout(timer)
      }
    }
    exit = null
    if (output) {
      try { closeSync(output.fd) } catch { /* already closed */ }
      output = null
    }
    if (savedEnv) {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete env[name]
        else env[name] = value
      }
      savedEnv = null
    }
    if (profile) {
      const directory = profile
      profile = null
      // Helpers may still flush into the profile for a moment after exit.
      try {
        await rmImpl(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (error) {
        log(`host-browser: could not remove ${directory}: ${error.message}`)
      }
    }
  }

  return { ensure, release, url }
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 }

// Runs an evaluation that may use the host browser and releases the browser
// however it ends: returning, throwing, or the process being told to stop.
// Chrome is detached in its own process group, so without this a failed or
// interrupted rescore left it and the AXI bridge running.
export async function withHostBrowser(browser, run, { processImpl = process } = {}) {
  if (!browser) return run()
  const handlers = Object.keys(SIGNAL_EXIT_CODES).map((name) => {
    // release() is single-flight, so this waits for a cleanup already running.
    const handler = () => {
      browser.release().finally(() => processImpl.exit(SIGNAL_EXIT_CODES[name]))
    }
    processImpl.once(name, handler)
    return [name, handler]
  })
  try {
    return await run()
  } finally {
    for (const [name, handler] of handlers) processImpl.removeListener(name, handler)
    await browser.release()
  }
}
