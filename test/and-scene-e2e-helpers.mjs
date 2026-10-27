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
  const s = { requests: [], repos: [{ name: 'e2e-run-old', full_name: 'Codagent-AI/e2e-run-old' }], refs: {}, pulls: {}, commits: {}, ...state }
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
      if (path === '/orgs/Codagent-AI/installation') return send(200, { id: 77, permissions: s.permissions ?? { administration: 'write', contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', metadata: 'read' } })
      if (path === '/app/installations/77/access_tokens') { s.minted = (s.minted ?? 0) + 1; return send(201, { token: `${record.body?.repositories ? 'run' : 'prov'}-token-${s.minted}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }) }
      if (path === '/installation/repositories') return send(200, { repositories: page(s.repos) })
      if (path === '/orgs/Codagent-AI/repos' && req.method === 'POST') { const repo = { name: record.body.name, full_name: `Codagent-AI/${record.body.name}`, id: 9001, created_at: '2026-10-23T00:00:00Z', private: record.body.private }; s.created = repo; return send(201, repo) }
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/matching-refs\/?$/))) return send(200, page(s.refs[m[1]] ?? []))
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/(\w+)$/))) return send(200, s.commits[m[2]] ?? { sha: m[2], parents: [] })
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/))) return send(200, page(s.pulls[m[1]] ?? []))
      // Like the real App, which holds no issues permission: issues cannot be listed, only the repository's setting read.
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) return send(403, { message: 'Resource not accessible by integration' })
      if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)$/)) && s.created?.full_name === m[1]) return send(200, { ...s.created, has_issues: s.hasIssues ?? false })
      send(404, { message: 'not found' })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  s.url = `http://127.0.0.1:${server.address().port}`
  return s
}
const WORKFLOW = `name: change
steps:
  - id: create
    script: create-change.sh
  - id: define
    workflow: ../core/define-change-v1.0.yaml
  - id: implement
    workflow: ../core/implement-change-v2.0.yaml
  - id: accept
    workflow: ../core/accept-change-v1.0.yaml
`
const DEFINE = `steps:
  - id: proposal
    agent: lead
    prompt: use codagent:propose
  - id: specs
    agent: lead
    prompt: use codagent:spec
  - id: design
    agent: lead
    prompt: use codagent:design
  - id: test-plan
    agent: lead
    prompt: use codagent:test-plan
  - id: approach-review
    agent: lead
    prompt: ask a fresh \`agent: crosscheck\` using codagent:review-approach
`
const IMPLEMENT = `steps:
  - id: implement
    agent: implementor
    prompt: use codagent:implement-change
  - id: acceptance
    agent: tester
    prompt: use codagent:prepare-acceptance
`
export const SKILLS = ['propose', 'spec', 'design', 'test-plan', 'review-approach', 'implement-change', 'prepare-acceptance']
const commitAll = (dir, message) => { git(dir, ['init', '--quiet', '--initial-branch=main']); git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', message]) }
// A clean Agent Runner checkout with a workflow, a recorded sandbox-run.sh substitute and a prebuilt agent-runner help.
export async function fakeRunner(root, { workflow = WORKFLOW, define = DEFINE, implement = IMPLEMENT, runnerHelp = '--external-user --until' } = {}) {
  const dir = join(root, 'runner')
  await mkdir(join(dir, 'workflows/openspec'), { recursive: true }); await mkdir(join(dir, 'workflows/core'), { recursive: true })
  await writeFile(join(dir, 'workflows/openspec/change-v3.0.yaml'), workflow); await writeFile(join(dir, 'workflows/core/define-change-v1.0.yaml'), define); await writeFile(join(dir, 'workflows/core/implement-change-v2.0.yaml'), implement); await writeFile(join(dir, 'workflows/core/accept-change-v1.0.yaml'), 'steps: []\n')
  await script(join(dir, 'bin/agent-runner'), `echo "${runnerHelp}"`)
  await script(join(dir, 'scripts/sandbox-run.sh'), `
if [[ "$1" == "--help" ]]; then echo "--auth-only --hide-source --no-default-secrets --input-dir --artifact-dir --docker-run-arg --mount-claude-auth --mount-codex-auth CLAUDE_CODE_OAUTH_TOKEN"; exit 0; fi
dry=0; vols=(); mounts=(); input=""; art=""; envs=()
while [[ $# -gt 0 ]]; do case "$1" in
  --dry-run) dry=1;; --input-dir) input="$2"; shift;; --artifact-dir) art="$2"; shift;;
  --docker-run-arg) vols+=("$2"); shift;;
  --mount-claude-auth) mounts+=("claude");; --mount-codex-auth) mounts+=("codex");; --mount-cursor-auth) mounts+=("cursor");;
  --) shift; break;; esac; shift; done
line="docker run --rm --init -w /workspace -e CI=1 -e HOME=/workspace/home -v $art:/artifacts -v $input:/eval-input:ro"
i=0; while [[ $i -lt \${#vols[@]} ]]; do if [[ "\${vols[$i]}" == "-v" ]]; then line="$line -v \${vols[$((i+1))]}"; i=$((i+2)); else i=$((i+1)); fi; done
for m in "\${mounts[@]}"; do case "$m" in claude) line="$line --mount type=bind\\\\,source=$HOME/.claude/.credentials.json\\\\,target=/host-home/claude/.credentials.json\\\\,readonly";; codex) line="$line --mount type=bind\\\\,source=$HOME/.codex/auth.json\\\\,target=/host-home/codex/auth.json\\\\,readonly";; esac; done
echo "$line agent-runner-dev:local bash -lc script"
`)
  commitAll(dir, 'runner')
  return dir
}
export async function fakeSkills(root, skills = SKILLS) {
  const dir = join(root, 'skills')
  for (const skill of skills) { await mkdir(join(dir, 'skills', skill), { recursive: true }); await writeFile(join(dir, 'skills', skill, 'SKILL.md'), `# ${skill}\n`) }
  commitAll(dir, 'skills')
  return dir
}
export async function fakeHome(root) {
  const home = join(root, 'home')
  await mkdir(join(home, '.claude'), { recursive: true }); await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.claude/.credentials.json'), '{"credential":"x"}'); await writeFile(join(home, '.codex/auth.json'), '{"credential":"x"}')
  return home
}
export const ROLE_ARGS = (cli = 'codex') => ['lead', 'crosscheck', 'implementor', 'tester'].flatMap(role => [`--${role}-cli`, cli, `--${role}-model`, 'm', `--${role}-effort`, 'high'])
