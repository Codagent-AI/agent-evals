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
  '--disable-features=site-per-process,Translate,BackForwardCache,MediaRouter,OptimizationHints',
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
    ], { stdio: 'ignore' })
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

  async function release() {
    const running = child
    child = null
    if (running) {
      // The AXI bridge holds a connection to this Chrome; drop it first so the
      // next phase reconnects to the fresh browser.
      await axi(['stop']).catch(() => {})
      if (running.exitCode === null) {
        const exited = new Promise((resolve) => running.once('exit', resolve))
        running.kill('SIGTERM')
        const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, EXIT_GRACE_MS)
        await exited
        clearTimeout(timer)
      }
      delete env.CHROME_DEVTOOLS_AXI_BROWSER_URL
    }
    if (profile) {
      await rm(profile, { recursive: true, force: true })
      profile = null
    }
  }

  return { ensure, release, url }
}
