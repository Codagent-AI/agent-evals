import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerify } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fakeGitHub, git, keyPair, startingRepo, temp } from './and-scene-e2e-helpers.mjs'
import { filesUnder } from '../evals/agent-runner/and-scene-e2e/lib/files.mjs'
import { GitHubApp, RUN_TOKEN_PERMISSIONS, checkReach, checkRepositoryName, provisionDelivery, reuseDelivery, signAppJwt, loadAppCredentials, startTokenRefresher, writeTokenFile, removeTokenFile, plannedProvisioning, APP_PERMISSIONS, ProvisioningError } from '../evals/agent-runner/and-scene-e2e/lib/provisioning.mjs'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const patterns = JSON.parse(readFileSync(new URL('../evals/agent-runner/and-scene-define/contamination-patterns.json', import.meta.url), 'utf8'))
async function setup(t, state) {
  const server = await fakeGitHub(t, state)
  const { publicKey, privateKey } = keyPair()
  const app = new GitHubApp({ appId: '123', privateKey, apiUrl: server.url })
  const root = await temp(t, 'e2e-prov-')
  return { server, app, publicKey, root }
}
// The local bare remote stands in for the created repository.
async function remote(root, commit) {
  const bare = join(root, 'remote.git'); await mkdir(bare, { recursive: true })
  git(bare, ['init', '--quiet', '--bare', '--initial-branch=main'])
  return bare
}
const seeder = bare => async ({ bundlePath, commit }) => { const clone = bundlePath + '.work'; execFileSync('git', ['clone', '--quiet', bundlePath, clone]); git(clone, ['push', '--quiet', bare, `${commit}:refs/heads/main`]) }

test('INT-004 the App JWT is RS256 and verifies with the test public key; tampering fails', async t => {
  const { publicKey, app } = await setup(t)
  const jwt = app.jwt(); const [head, body, signature] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.equal(JSON.parse(Buffer.from(body, 'base64url')).iss, '123')
  const verify = data => createVerify('RSA-SHA256').update(data).verify(publicKey, Buffer.from(signature, 'base64url'))
  assert.ok(verify(`${head}.${body}`)); assert.ok(!verify(`${head}.${body}x`))
  assert.ok(signAppJwt({ appId: 1, privateKey: app.privateKey, now: 0 }))
})

test('INT-004 reach check passes for delivery repositories only and fails on a foreign one, even on a later page', async t => {
  const { app, server } = await setup(t)
  assert.deepEqual(await checkReach(app, 'prov'), ['Codagent-AI/e2e-run-old'])
  server.repos = [...Array.from({ length: 100 }, (_, i) => ({ name: `e2e-run-${i}`, full_name: `Codagent-AI/e2e-run-${i}` })), { name: 'and-scene', full_name: 'Codagent-AI/and-scene' }]
  await assert.rejects(checkReach(app, 'prov'), /Codagent-AI\/and-scene/)
  const creates = server.requests.filter(request => request.method === 'POST' && request.path.endsWith('/repos'))
  assert.equal(creates.length, 0)
})

test('INT-004 provisioning creates a private repository and verifies only the starting commit', async t => {
  const { app, server, root } = await setup(t)
  const { bundle, commit } = await startingRepo(root); const bare = await remote(root, commit)
  const runId = 'abc123'
  server.refs['Codagent-AI/e2e-run-abc123'] = [{ ref: 'refs/heads/main', object: { sha: commit } }]
  const identity = await provisionDelivery({ app, runId, bundlePath: bundle, commit, patterns, seed: async args => seeder(bare)(args) })
  assert.equal(identity.full_name, 'Codagent-AI/e2e-run-abc123'); assert.equal(identity.private, true); assert.equal(identity.id, 9001)
  const create = server.requests.find(request => request.path === '/orgs/Codagent-AI/repos')
  assert.deepEqual(create.body, { name: 'e2e-run-abc123', private: true, has_issues: false, has_projects: false, has_wiki: false, auto_init: false })
  assert.equal(git(bare, ['rev-list', '--all', '--count']), '1'); assert.equal(git(bare, ['rev-parse', 'refs/heads/main']), commit)
  assert.deepEqual(plannedProvisioning(runId), { repository: 'Codagent-AI/e2e-run-abc123', private: true, has_issues: false, has_projects: false, has_wiki: false, run_token_permissions: RUN_TOKEN_PERMISSIONS, run_token_repositories: ['e2e-run-abc123'] })
  // The provisioning token, not the run token, creates the repository.
  assert.match(create.auth, /prov-token/)
})

test('INT-004 each bad repository state fails before any evaluated work and names the content', async t => {
  const bad = {
    'an extra branch': (refs, commit) => [...refs, { ref: 'refs/heads/other', object: { sha: commit } }],
    'a tag': (refs, commit) => [...refs, { ref: 'refs/tags/v1', object: { sha: commit } }],
    'the wrong main head': refs => [{ ref: 'refs/heads/main', object: { sha: 'f'.repeat(40) } }],
  }
  for (const [label, mutate] of Object.entries(bad)) {
    const { app, server, root } = await setup(t); const { bundle, commit } = await startingRepo(root); const bare = await remote(root, commit)
    server.refs['Codagent-AI/e2e-run-bad'] = mutate([{ ref: 'refs/heads/main', object: { sha: commit } }], commit)
    await assert.rejects(provisionDelivery({ app, runId: 'bad', bundlePath: bundle, commit, patterns, seed: async args => seeder(bare)(args) }), /delivery repository content/, label)
  }
  const states = {
    'history': s => { s.commits = { [s.commit]: { sha: s.commit, parents: [{ sha: 'a'.repeat(40) }] } } },
    'an open pull request': s => { s.pulls['Codagent-AI/e2e-run-bad'] = [{ number: 1, state: 'open' }] },
    'a closed pull request on a later page': s => { s.pulls['Codagent-AI/e2e-run-bad'] = [...Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })), { number: 101, state: 'closed' }] },
    'an issue': s => { s.issues['Codagent-AI/e2e-run-bad'] = [{ number: 3 }] },
  }
  for (const [label, mutate] of Object.entries(states)) {
    const { app, server, root } = await setup(t); const { bundle, commit } = await startingRepo(root); const bare = await remote(root, commit)
    server.refs['Codagent-AI/e2e-run-bad'] = [{ ref: 'refs/heads/main', object: { sha: commit } }]; server.commit = commit; mutate(server)
    await assert.rejects(provisionDelivery({ app, runId: 'bad', bundlePath: bundle, commit, patterns, seed: async args => seeder(bare)(args) }), /delivery repository content/, label)
  }
})

test('INT-004 a repository name that matches a contamination pattern fails before creation', async t => {
  const { app, server, root } = await setup(t); const { bundle, commit } = await startingRepo(root)
  assert.throws(() => checkRepositoryName({ patterns, fullName: 'Codagent-AI/e2e-run-x', url: 'https://github.com/Codagent-AI/and-scene.git' }), error => error instanceof ProvisioningError && /and-scene|fixture/.test(error.message))
  const hostile = { ...patterns, patterns: [...patterns.patterns, { id: 'run-name', kind: 'locator', type: 'literal', value: 'e2e-run-poison' }] }
  await assert.rejects(provisionDelivery({ app, runId: 'poison', bundlePath: bundle, commit, patterns: hostile }), /run-name/)
  assert.equal(server.requests.filter(request => request.path === '/orgs/Codagent-AI/repos').length, 0)
  // The real pattern list matches neither a delivery repository's name nor its URL.
  assert.doesNotThrow(() => checkRepositoryName({ patterns, fullName: 'Codagent-AI/e2e-run-0123abcd', url: 'https://github.com/Codagent-AI/e2e-run-0123abcd.git' }))
})

test('INT-004 the run token names exactly one repository and the designed permissions', async t => {
  const { app, server } = await setup(t)
  const { token } = await app.runToken('e2e-run-abc')
  const request = server.requests.findLast(item => item.path.endsWith('/access_tokens'))
  assert.deepEqual(request.body, { repositories: ['e2e-run-abc'], permissions: { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', metadata: 'read' } })
  assert.deepEqual(Object.keys(request.body.permissions).sort(), ['checks', 'contents', 'metadata', 'pull_requests', 'statuses'])
  for (const forbidden of ['administration', 'workflows']) assert.ok(!(forbidden in request.body.permissions))
  assert.ok(!('*' in request.body.permissions)); assert.ok(APP_PERMISSIONS.administration === 'write' && !('workflows' in APP_PERMISSIONS))
  assert.match(token, /^run-token-/)
})

test('INT-004 stopping the refresher waits for a refresh in flight, and no write follows the stop', async t => {
  const { root } = await setup(t)
  const dir = join(root, '.github-auth-inflight')
  await writeTokenFile(dir, 'first')
  let tick; let release
  const gate = new Promise(resolve => { release = resolve })
  const refresher = startTokenRefresher({ mint: async () => { await gate; return { token: 'late', expires_at: 'x' } }, dir, intervalMs: 1000, setTimer: fn => { tick = fn; return { unref() {} } }, clearTimer() {} })
  const refreshing = tick()
  let stopped = false
  const stopping = refresher.stop().then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false, 'stop waits for the refresh in flight')
  release(); await stopping; await refreshing
  assert.notEqual(await readFile(join(dir, 'token'), 'utf8'), 'late', 'a refresh that finishes after stop writes nothing')
  await removeTokenFile(dir)
  await assert.rejects(stat(dir))
})
test('INT-004 the refresher atomically replaces the token file and nothing outlives the invocation', async t => {
  const { app, root, server } = await setup(t)
  const dir = join(root, '.github-auth')
  await writeTokenFile(dir, (await app.runToken('e2e-run-abc')).token)
  assert.equal((await stat(join(dir, 'token'))).mode & 0o777, 0o600)
  let tick; const timers = []
  const refresher = startTokenRefresher({ mint: () => app.runToken('e2e-run-abc'), dir, intervalMs: 30 * 60 * 1000, setTimer: (fn, ms) => { tick = fn; timers.push(ms); return { unref() {} } }, clearTimer: () => timers.push('cleared') })
  const first = await readFile(join(dir, 'token'), 'utf8')
  await tick()
  const second = await readFile(join(dir, 'token'), 'utf8')
  assert.notEqual(first, second); assert.deepEqual(timers, [1800000])
  assert.deepEqual((await readdir(dir)).sort(), ['token'])
  await refresher.stop(); assert.equal(timers.at(-1), 'cleared')
  // A refresh error is reported without leaving a partial or stale temporary file.
  server.handler = request => request.path.endsWith('/access_tokens') ? (request.body = request.body, true) && false : false
  const errors = []
  const failing = startTokenRefresher({ mint: async () => { throw new Error('mint failed') }, dir, intervalMs: 1, onError: error => errors.push(error.message), setTimer: fn => { tick = fn; return { unref() {} } }, clearTimer() {} })
  await tick(); assert.deepEqual(errors, ['mint failed']); assert.equal(await readFile(join(dir, 'token'), 'utf8'), second)
  await removeTokenFile(dir)
  await assert.rejects(stat(dir))
  // No token value lingers anywhere in the run directory once the file is removed.
  for (const file of await filesUnder(root).catch(() => [])) assert.ok(!/(run|prov)-token-\d/.test(await readFile(file, 'utf8')), file)
})

test('INT-004 a resume reuses the recorded repository, creates none, and refuses a mismatch', async t => {
  const { app, server } = await setup(t)
  const recorded = { full_name: 'Codagent-AI/e2e-run-abc', id: 9001 }
  server.handler = (request, send) => { if (request.path === '/repos/Codagent-AI/e2e-run-abc') { send(200, { id: 9001 }); return true } }
  assert.equal(await reuseDelivery({ app, recorded }), recorded)
  server.handler = (request, send) => { if (request.path.startsWith('/repos/')) { send(200, { id: 4 }); return true } }
  await assert.rejects(reuseDelivery({ app, recorded }), /not the repository recorded/)
  server.handler = (request, send) => { if (request.path.startsWith('/repos/')) { send(404, { message: 'gone' }); return true } }
  await assert.rejects(reuseDelivery({ app, recorded }), /unavailable/)
  assert.equal(server.requests.filter(request => request.method === 'POST' && request.path.endsWith('/repos')).length, 0)
  // The harness never deletes a repository.
  assert.equal(server.requests.filter(request => request.method === 'DELETE').length, 0)
})

test('INT-004 a fake token authority reaches only the repository the run token names', async t => {
  const { app, server } = await setup(t)
  const grants = new Map()
  server.handler = (request, send) => {
    if (request.path.endsWith('/access_tokens')) { const token = `scoped-${grants.size}`; grants.set(token, request.body?.repositories ?? null); send(201, { token, expires_at: 'x' }); return true }
    const match = request.path.match(/^\/repos\/Codagent-AI\/([^/]+)/)
    if (match) { const repositories = grants.get(request.auth.replace('Bearer ', '')); send(repositories && repositories.includes(match[1]) ? 200 : 403, { message: repositories ? 'allowed' : 'denied' }); return true }
  }
  const { token } = await app.runToken('e2e-run-mine')
  assert.deepEqual((await app.request('GET', '/repos/Codagent-AI/e2e-run-mine', { token })).message, 'allowed')
  for (const other of ['and-scene', 'agent-evals', 'e2e-run-other']) await assert.rejects(app.request('GET', `/repos/Codagent-AI/${other}`, { token }), error => error.status === 403, other)
})

test('an App key file that is not a PEM private key fails preflight with a clear message', async t => {
  const dir = await temp(t)
  const bad = join(dir, 'not-a-key.pem'); await writeFile(bad, 'this is not a key\n')
  const good = join(dir, 'app.pem'); await writeFile(good, keyPair().privateKey)
  await assert.rejects(loadAppCredentials({ AND_SCENE_E2E_APP_ID: '1', AND_SCENE_E2E_APP_KEY_FILE: bad }), error => error instanceof ProvisioningError && /not a PEM private key/.test(error.message) && !/error:|DECODER|asn1/i.test(error.message))
  assert.equal((await loadAppCredentials({ AND_SCENE_E2E_APP_ID: '1', AND_SCENE_E2E_APP_KEY_FILE: good })).appId, '1')
})

test('credentials come from the App record and the Runner secrets file when the environment lacks them', async t => {
  const { resolveCredentialEnv } = await import('../evals/agent-runner/and-scene-e2e/lib/credentials.mjs')
  const home = await temp(t); const runnerDir = await temp(t)
  await mkdir(join(home, '.config/and-scene-e2e'), { recursive: true })
  await writeFile(join(home, '.config/and-scene-e2e/app.json'), JSON.stringify({ id: 42, slug: 's', key_file: '/keys/app.pem' }))
  await writeFile(join(runnerDir, '.sandbox-secrets.env'), 'GITHUB_TOKEN=broad-token\nexport CLAUDE_CODE_OAUTH_TOKEN="claude-token"\n')
  const found = await resolveCredentialEnv({ PATH: '/bin' }, { runnerDir, home })
  assert.equal(found.AND_SCENE_E2E_APP_ID, '42')
  assert.equal(found.AND_SCENE_E2E_APP_KEY_FILE, '/keys/app.pem')
  assert.equal(found.CLAUDE_CODE_OAUTH_TOKEN, 'claude-token')
  // Only the Claude entry is taken: the broad GitHub token never enters the run's environment.
  assert.equal(found.GITHUB_TOKEN, undefined)
  // The environment wins over both sources.
  const explicit = await resolveCredentialEnv({ AND_SCENE_E2E_APP_ID: '7', AND_SCENE_E2E_APP_KEY_FILE: '/k.pem', CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }, { runnerDir, home })
  assert.deepEqual([explicit.AND_SCENE_E2E_APP_ID, explicit.AND_SCENE_E2E_APP_KEY_FILE, explicit.CLAUDE_CODE_OAUTH_TOKEN], ['7', '/k.pem', 'env-token'])
  // With neither source, nothing is invented and preflight still reports what is missing.
  const none = await resolveCredentialEnv({}, { runnerDir: await temp(t), home: await temp(t) })
  assert.deepEqual([none.AND_SCENE_E2E_APP_ID, none.CLAUDE_CODE_OAUTH_TOKEN], [undefined, undefined])
})
