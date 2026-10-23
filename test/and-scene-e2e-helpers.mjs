import { makeTempDir } from './temp-dir.mjs'
import { mkdir, writeFile, chmod, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
export const E2E = join(import.meta.dirname, '../evals/agent-runner/and-scene-e2e')
export const git = (cwd, args, env = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...env } }).trim()
export async function temp(t, name = 'e2e-') {
  const dir = await makeTempDir(join(tmpdir(), name))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
export async function script(path, body) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, `#!/usr/bin/env bash\n${body}\n`); await chmod(path, 0o755) }
// A one-commit repository and its bundle, standing in for the materialized starting tree.
export async function startingRepo(root) {
  const repo = join(root, 'start'); await mkdir(repo, { recursive: true })
  git(repo, ['init', '--quiet', '--initial-branch=main'])
  await writeFile(join(repo, 'README.md'), 'start\n'); await mkdir(join(repo, '.validator'), { recursive: true }); await writeFile(join(repo, '.validator/config.yml'), 'cli:\n  default_preference:\n    - claude\n')
  git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'start'])
  const bundle = join(root, 'starting-repo.bundle')
  git(repo, ['bundle', 'create', bundle, 'HEAD', 'main'])
  return { repo, bundle, commit: git(repo, ['rev-parse', 'HEAD']) }
}
export const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
// A programmable local GitHub REST server for the App, repository, token, ref, pull and issue routes.
export async function fakeGitHub(t, state = {}) {
  const s = { requests: [], repos: [{ name: 'e2e-run-old', full_name: 'Codagent-AI/e2e-run-old' }], refs: {}, pulls: {}, issues: {}, commits: {}, ...state }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x'); const path = url.pathname
      const record = { method: req.method, path, query: url.search, auth: req.headers.authorization, body: body ? JSON.parse(body) : null }
      s.requests.push(record)
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)) }
      const page = list => { const n = Number(url.searchParams.get('page') ?? 1); return list.slice((n - 1) * 100, n * 100) }
      if (s.handler) { const handled = s.handler(record, send); if (handled) return }
      let m
      if (path === '/orgs/Codagent-AI/installation') return send(200, { id: 77 })
      if (path === '/app/installations/77/access_tokens') { s.minted = (s.minted ?? 0) + 1; return send(201, { token: `${record.body?.repositories ? 'run' : 'prov'}-token-${s.minted}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }) }
      if (path === '/installation/repositories') return send(200, { repositories: page(s.repos) })
      if (path === '/orgs/Codagent-AI/repos' && req.method === 'POST') { const repo = { name: record.body.name, full_name: `Codagent-AI/${record.body.name}`, id: 9001, created_at: '2026-10-23T00:00:00Z', private: record.body.private }; s.created = repo; return send(201, repo) }
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/matching-refs\/?$/))) return send(200, page(s.refs[m[1]] ?? []))
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/(\w+)$/))) return send(200, s.commits[m[2]] ?? { sha: m[2], parents: [] })
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/))) return send(200, page(s.pulls[m[1]] ?? []))
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) return send(200, page(s.issues[m[1]] ?? []))
      send(404, { message: 'not found' })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  s.url = `http://127.0.0.1:${server.address().port}`
  return s
}
