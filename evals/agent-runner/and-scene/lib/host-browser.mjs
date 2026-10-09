// The headless Chrome a host rescore drives through chrome-devtools-axi.
//
// In the sandbox Chrome lives as long as the container. On a host it shares a
// small machine with everything else, and an idle Chrome held through an hour
// of source judging grew to about 9 GB. So the host browser starts only when a
// browser phase needs it, with flags that keep it lean, and is released as
// soon as that phase ends; a later phase, such as a second-opinion replay,
// starts a fresh one.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const READY_ATTEMPTS = 100
const READY_DELAY_MS = 100
const EXIT_GRACE_MS = 5000

const defaultAxi = async (args) => {
  spawnSync('chrome-devtools-axi', args, { encoding: 'utf8', timeout: 30_000 })
}

export function createHostBrowser({
  chromePath,
  port = 9333,
  env = process.env,
  spawnImpl = spawn,
  fetchImpl = fetch,
  axi = defaultAxi,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  rmImpl = rm,
  // Chrome leads its own process group, so its helpers stop with it.
  killGroup = (pid, signal) => process.kill(-pid, signal),
  log = (line) => console.error(line),
} = {}) {
  let child = null
  let profile = null
  const url = `http://127.0.0.1:${port}`

  async function ensure() {
    if (child && child.exitCode === null) return url
    profile = await mkdtemp(join(tmpdir(), 'and-scene-host-chrome-'))
    child = spawnImpl(chromePath, [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--js-flags=--max-old-space-size=${JS_HEAP_MB}`,
      ...HOST_CHROME_FLAGS,
      'about:blank',
    ], { stdio: 'ignore', detached: true })
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      try {
        if ((await fetchImpl(`${url}/json/version`)).ok) {
          env.CHROME_DEVTOOLS_AXI_BROWSER_URL = url
          return url
        }
      } catch {
        // Not listening yet.
      }
      await sleep(READY_DELAY_MS)
    }
    await release()
    throw Object.assign(new Error(`host Chrome did not expose its DevTools endpoint at ${url}`), {
      owner: 'evaluation-harness', code: 'browser-driver-failed', resumable: true,
    })
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
      await axi(['stop']).catch(() => {})
      if (running.exitCode === null) {
        const exited = new Promise((resolve) => running.once('exit', resolve))
        signal(running, 'SIGTERM')
        const timer = setTimeout(() => { if (running.exitCode === null) signal(running, 'SIGKILL') }, EXIT_GRACE_MS)
        await exited
        clearTimeout(timer)
      }
      delete env.CHROME_DEVTOOLS_AXI_BROWSER_URL
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
