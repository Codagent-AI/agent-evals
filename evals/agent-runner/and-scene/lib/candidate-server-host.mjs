// The host candidate-server adapter.
//
// `lib/candidate-server.mjs` owns the *policy* — when a server may be reused,
// when it may be stopped, and what counts as proof of identity. This module is
// the mechanism behind that policy on a real host: it launches the suite's
// static server against the evaluated build, learns which port it bound, and
// answers identity probes over HTTP.
//
// The probe deliberately asks the endpoint what it serves rather than inferring
// it from a port or a process. That is what makes a recycled process identifier
// harmless: an unrelated process cannot produce the candidate token, so it is
// never reused and never killed.
import { spawn as spawnProcess } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUITE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export const CANDIDATE_IDENTITY_PATH = '.candidate-identity'
export const DEFAULT_SERVER_SCRIPT = join(SUITE_DIR, 'serve-candidate.mjs')
// The candidate worktree and its build output both live under the run
// directory, so a review can serve the exact revision that was scored.
export const CANDIDATE_BUILD_DIR = '.runtime/candidate-worktree/dist'

const START_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 50

function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

async function waitFor(read, { timeoutMs, description }) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  for (;;) {
    try {
      const value = await read()
      if (value !== null && value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

export function createHostCandidateServer({
  runDir,
  buildDir = null,
  serverScript = DEFAULT_SERVER_SCRIPT,
  spawnImpl = spawnProcess,
  fetchImpl = fetch,
  killImpl = (pid, signal) => process.kill(pid, signal),
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  const root = buildDir ? resolve(buildDir) : join(resolve(runDir), CANDIDATE_BUILD_DIR)
  const urlFile = join(resolve(runDir), '.runtime/candidate-server-url')

  async function probe(url) {
    try {
      const response = await fetchImpl(new URL(CANDIDATE_IDENTITY_PATH, url).toString())
      if (!response.ok) {
        return { ok: false, error: `the endpoint answered ${response.status} for the candidate identity` }
      }
      return { ok: true, candidate_identity: (await response.text()).trim() }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  return {
    probe,

    async start({ candidate }) {
      try {
        await access(root)
      } catch {
        throw new Error(
          `no built candidate to serve at ${root}; the candidate must be built before human review`,
        )
      }

      // A stale URL from an earlier session would otherwise be read as this
      // server's endpoint.
      await rm(urlFile, { force: true })

      const child = spawnImpl(process.execPath, [
        serverScript,
        '--root', root,
        '--identity', candidate ?? '',
        '--url-file', urlFile,
        // Port 0: the operating system picks a free port, so the review never
        // competes for one and never seizes an occupied one.
        '--port', '0',
      ], { detached: true, stdio: 'ignore' })
      child.unref?.()

      const url = await waitFor(
        async () => (await readFile(urlFile, 'utf8')).trim() || null,
        { timeoutMs: startTimeoutMs, description: 'the candidate server to report its URL' },
      )
      await waitFor(
        async () => ((await probe(url)).ok ? url : null),
        { timeoutMs: startTimeoutMs, description: 'the candidate server to answer an identity probe' },
      )

      return { pid: child.pid, url, candidate_identity: candidate ?? null }
    },

    async stop(server) {
      // Only the recorded process, and only ever by its recorded identifier. The
      // caller has already verified that this process is the one it started.
      killImpl(server.pid, 'SIGTERM')
      await rm(urlFile, { force: true })
    },
  }
}
