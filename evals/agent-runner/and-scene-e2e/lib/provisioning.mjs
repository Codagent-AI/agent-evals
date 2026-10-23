// Delivery-repository provisioning on the host through a GitHub App. Nothing here runs in the sandbox,
// and the provisioning token and App key never leave the host.
import { createSign } from 'node:crypto'
import { chmod, mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORGANIZATION, REPOSITORY_PREFIX } from './files.mjs'
import { compilePatterns } from '../../../lib/define-run/canary.mjs'

export const RUN_TOKEN_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', metadata: 'read' })
export const APP_PERMISSIONS = Object.freeze({ administration: 'write', ...RUN_TOKEN_PERMISSIONS })
const b64url = value => Buffer.from(value).toString('base64url')
export function signAppJwt({ appId, privateKey, now = Date.now() }) {
  const seconds = Math.floor(now / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: String(appId) }))
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')
  return `${head}.${body}.${signature}`
}
export class ProvisioningError extends Error {
  constructor(check, message) { super(`${check}: ${message}`); this.check = check }
}
export class GitHubApp {
  constructor({ appId, privateKey, apiUrl = 'https://api.github.com', fetch = globalThis.fetch, organization = ORGANIZATION, now = () => Date.now() }) {
    Object.assign(this, { appId, privateKey, apiUrl: apiUrl.replace(/\/$/, ''), fetch, organization, now })
  }
  async request(method, path, { token, body, accept = [200, 201] } = {}) {
    const response = await this.fetch(`${this.apiUrl}${path}`, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'and-scene-e2e' }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    if (!accept.includes(response.status)) throw Object.assign(new Error(`GitHub ${method} ${path} returned ${response.status}${json?.message ? `: ${json.message}` : ''}`), { status: response.status })
    return json
  }
  async paged(path, token, key = null) {
    const items = []
    for (let page = 1; ; page++) {
      const data = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { token })
      const list = key ? data[key] : data
      items.push(...list)
      if (list.length < 100) return items
    }
  }
  jwt() { return signAppJwt({ appId: this.appId, privateKey: this.privateKey, now: this.now() }) }
  installation() { return this.request('GET', `/orgs/${this.organization}/installation`, { token: this.jwt() }) }
  async installationId() { return (await this.installation()).id }
  async mint({ repositories, permissions } = {}) {
    const id = await this.installationId()
    const body = repositories ? { repositories, permissions } : undefined
    const token = await this.request('POST', `/app/installations/${id}/access_tokens`, { token: this.jwt(), body })
    return { token: token.token, expires_at: token.expires_at }
  }
  provisioningToken() { return this.mint() }
  runToken(repository) { return this.mint({ repositories: [repository], permissions: RUN_TOKEN_PERMISSIONS }) }
}
export async function loadAppCredentials(env = process.env) {
  if (!env.AND_SCENE_E2E_APP_ID || !env.AND_SCENE_E2E_APP_KEY_FILE) throw new ProvisioningError('provisioning credentials', 'set AND_SCENE_E2E_APP_ID and AND_SCENE_E2E_APP_KEY_FILE')
  const privateKey = await readFile(env.AND_SCENE_E2E_APP_KEY_FILE, 'utf8').catch(() => { throw new ProvisioningError('provisioning credentials', 'the App private-key file is unreadable') })
  return { appId: env.AND_SCENE_E2E_APP_ID, privateKey }
}
// The installation may reach only the suite's own delivery repositories.
export async function checkReach(app, token) {
  let repositories
  try { repositories = await app.paged('/installation/repositories', token, 'repositories') }
  catch (error) { throw new ProvisioningError('provisioning credentials', `cannot list the installation's repositories: ${error.message}`) }
  const foreign = repositories.find(repository => !repository.name.startsWith(REPOSITORY_PREFIX))
  if (foreign) throw new ProvisioningError('provisioning reach', `the installation can reach ${foreign.full_name}, which is not a delivery repository`)
  return repositories.map(repository => repository.full_name)
}
// The installation must grant every permission provisioning and the run token rely on, at least at the level asked.
const LEVELS = { read: 1, write: 2, admin: 3 }
export async function checkInstallationPermissions(app) {
  let granted
  try { granted = (await app.installation()).permissions ?? {} }
  catch (error) { throw new ProvisioningError('provisioning credentials', `cannot read the installation's permissions: ${error.message}`) }
  const short = Object.entries(APP_PERMISSIONS).filter(([name, level]) => (LEVELS[granted[name]] ?? 0) < LEVELS[level]).map(([name, level]) => `${name}:${level}`)
  if (short.length) throw new ProvisioningError('provisioning credentials', `the installation lacks permissions: ${short.join(', ')}`)
}
export const deliveryName = runId => `${REPOSITORY_PREFIX}${runId}`
export function checkRepositoryName({ patterns, fullName, url }) {
  for (const pattern of compilePatterns(patterns)) for (const text of [fullName, url]) {
    if (pattern.matches(text)) throw new ProvisioningError('contamination patterns', `delivery repository ${fullName} matches pattern ${pattern.id}`)
  }
}
export function plannedProvisioning(runId, organization = ORGANIZATION) {
  const name = deliveryName(runId)
  return { repository: `${organization}/${name}`, private: true, has_issues: false, has_projects: false, has_wiki: false, run_token_permissions: { ...RUN_TOKEN_PERMISSIONS }, run_token_repositories: [name] }
}
export async function createRepository(app, token, runId) {
  const name = deliveryName(runId)
  const created = await app.request('POST', `/orgs/${app.organization}/repos`, { token, body: { name, private: true, has_issues: false, has_projects: false, has_wiki: false, auto_init: false } })
  return { full_name: created.full_name, name: created.name, id: created.id, created_at: created.created_at, private: created.private, clone_url: created.clone_url ?? `https://github.com/${created.full_name}.git` }
}
// The token reaches git only through the child process environment, never a URL or file.
async function withAskpass(token, run) {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-askpass-'))
  const script = join(dir, 'askpass.sh')
  try {
    await writeFile(script, '#!/bin/sh\ncase "$1" in *sername*) echo x-access-token;; *) printf %s "$E2E_GIT_TOKEN";; esac\n', { mode: 0o700 })
    return await run({ GIT_ASKPASS: script, E2E_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  } finally { await rm(dir, { recursive: true, force: true }) }
}
export function gitCommand(args, { env = {}, cwd, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, encoding, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout)
    // Errors reach result.json and the published report, so no credential may travel in them.
    const secret = env.E2E_GIT_TOKEN
    const redact = text => { let out = String(text ?? '').replace(/x-access-token(:[^@\s]*)?/g, 'x-access-token:***').replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@'); if (secret) out = out.split(secret).join('***'); return out }
    error.message = redact(error.message)
    reject(Object.assign(error, { stderr: redact(stderr) }))
  }))
}
export function authenticatedGit(token, args, options = {}) {
  return withAskpass(token, env => gitCommand(args, { ...options, env: { ...env, ...options.env } }))
}
export async function seedRepository({ url, token, bundlePath, commit, git = authenticatedGit }) {
  const scratch = await mkdtemp(join(tmpdir(), 'e2e-seed-'))
  try {
    await gitCommand(['clone', '--quiet', '--template=', bundlePath, scratch], { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
    await git(token, ['-C', scratch, 'push', url, `${commit}:refs/heads/main`])
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
// A new repository must hold exactly the starting commit on main: no other ref, history, pull request or issue.
export async function verifyRepository(app, token, { fullName, commit }) {
  const refs = await app.paged(`/repos/${fullName}/git/matching-refs/`, token)
  const unexpected = refs.filter(ref => ref.ref !== 'refs/heads/main')
  if (unexpected.length) throw new ProvisioningError('delivery repository content', `${fullName} holds unexpected ref ${unexpected[0].ref}`)
  if (refs.length !== 1 || refs[0].object?.sha !== commit) throw new ProvisioningError('delivery repository content', `${fullName} main is not the starting commit`)
  const head = await app.request('GET', `/repos/${fullName}/commits/${commit}`, { token })
  if ((head.parents ?? []).length) throw new ProvisioningError('delivery repository content', `${fullName} has history beyond the starting commit`)
  const pulls = await app.paged(`/repos/${fullName}/pulls?state=all`, token)
  if (pulls.length) throw new ProvisioningError('delivery repository content', `${fullName} already has pull request #${pulls[0].number}`)
  const issues = await app.request('GET', `/repos/${fullName}/issues?state=all&per_page=100`, { token, accept: [200, 410] }).catch(error => { throw error })
  if (Array.isArray(issues) && issues.length) throw new ProvisioningError('delivery repository content', `${fullName} already has issue #${issues[0].number}`)
}
// Host side of the run token: one atomic file in a directory the sandbox mounts read-only.
export async function writeTokenFile(dir, token) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `.token.${process.pid}.${Date.now()}`)
  await writeFile(temporary, token, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, join(dir, 'token'))
}
export async function removeTokenFile(dir) { await rm(dir, { recursive: true, force: true }) }
export function startTokenRefresher({ mint, dir, intervalMs, onError = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  let stopped = false
  let inflight = Promise.resolve()
  const refresh = async () => {
    if (stopped) return
    try { const { token } = await mint(); if (!stopped) await writeTokenFile(dir, token) } catch (error) { onError(error) }
  }
  const timer = setTimer(() => (inflight = refresh()), intervalMs)
  timer.unref?.()
  // Stopping waits for a refresh already running, so nothing can recreate the directory after its removal.
  return { stop: async () => { stopped = true; clearTimer(timer); await inflight } }
}
// Create, seed and verify a run's delivery repository. `seed` is injectable so tests can push to a local bare remote.
// `existing` resumes a repository that was created but not yet verified; `onCreated` records its identity at once.
export async function provisionDelivery({ app, runId, bundlePath, commit, patterns, seed = seedRepository, token = null, existing = null, onCreated = async () => {} }) {
  const provisioning = token ?? (await app.provisioningToken()).token
  const name = deliveryName(runId)
  checkRepositoryName({ patterns, fullName: `${app.organization}/${name}`, url: `https://github.com/${app.organization}/${name}.git` })
  let identity = existing
  if (!identity) { identity = await createRepository(app, provisioning, runId); await onCreated(identity) }
  await seed({ url: identity.clone_url, token: provisioning, bundlePath, commit })
  await verifyRepository(app, provisioning, { fullName: identity.full_name, commit })
  return { ...identity, starting_commit: commit }
}
// A resumed run reuses its recorded repository; one that no longer matches is an error, never a new repository.
export async function reuseDelivery({ app, recorded, token = null }) {
  const provisioning = token ?? (await app.provisioningToken()).token
  let current
  try { current = await app.request('GET', `/repos/${recorded.full_name}`, { token: provisioning }) }
  catch (error) { throw new ProvisioningError('delivery repository', `the recorded repository ${recorded.full_name} is unavailable: ${error.message}`) }
  if (current.id !== recorded.id) throw new ProvisioningError('delivery repository', `${recorded.full_name} is not the repository recorded for this run`)
  return recorded
}
