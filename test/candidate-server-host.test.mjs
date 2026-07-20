import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-host-server-'))
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
    /no built candidate to serve/,
  )
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
