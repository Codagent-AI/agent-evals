import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { E2E, ROLE_ARGS, fakeGitHub, fakeHome, fakeRunner, fakeSkills, keyPair, script, temp } from './and-scene-e2e-helpers.mjs'
import { OPTION_INVENTORY, TOKEN_REFRESH, parseArguments, DEFAULT_TIME_LIMIT_MS, parseRefreshInterval } from '../evals/agent-runner/and-scene-e2e/lib/options.mjs'

async function world(t) {
  const root = await temp(t, 'e2e-entry-')
  const github = await fakeGitHub(t, { repos: [] })
  const { privateKey } = keyPair()
  await writeFile(join(root, 'app.pem'), privateKey)
  const bin = join(root, 'bin'); const log = join(root, 'cli.log')
  // Container and model CLIs are traps: a dry run must never reach them.
  for (const name of ['docker', 'claude', 'codex', 'cursor']) await script(join(bin, name), `echo "${name} $*" >> "${log}"; exit 1`)
  for (const name of ['chrome', 'chrome-devtools-axi']) await script(join(bin, name), `echo "${name} $*" >> "${log}"; exit 1`)
  const env = { PATH: `${bin}:${process.env.PATH}`, AND_SCENE_HOST_CHROME: join(bin, 'chrome'), HOME: await fakeHome(root), AND_SCENE_E2E_APP_ID: '123', AND_SCENE_E2E_APP_KEY_FILE: join(root, 'app.pem'), AND_SCENE_E2E_GITHUB_API: github.url, CLAUDE_CODE_OAUTH_TOKEN: 'SENTINEL-OAUTH-SECRET' }
  return { root, github, env, log, runner: await fakeRunner(root), skills: await fakeSkills(root), runDir: join(root, 'run') }
}
// Asynchronous: the in-process fake GitHub server must answer while the CLI runs.
const run = (w, args, env = w.env) => new Promise(resolve => {
  const child = spawn('bash', [join(E2E, 'run.sh'), ...args], { env, cwd: join(E2E, '../../..') })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  child.on('exit', status => resolve({ stdout, stderr, status }))
})
let counter = 0
const candidate = (w, extra = [], dir = null) => ['--dry-run', '--run-dir', dir ?? `${w.runDir}-${counter++}`, '--runner-dir', w.runner, '--skills-dir', w.skills, ...ROLE_ARGS('codex'), ...extra]

test('E2E-001 help documents every mode and option with defaults and bounds', async t => {
  const w = await world(t)
  const { stdout, status } = await run(w, ['--help'])
  assert.equal(status, 0)
  for (const option of OPTION_INVENTORY) assert.ok(stdout.includes(option), `help is missing ${option}`)
  assert.match(stdout, /--token-refresh-interval MINUTES[^\n]*default 30, from 1 to 50/)
  assert.match(stdout, /default 12h/); assert.match(stdout, /default 45m/); assert.match(stdout, /--workflow REF[^\n]*openspec:change/)
  assert.match(stdout, /AND_SCENE_E2E_APP_ID/)
})

test('E2E-001 a dry run prints the planned provisioning and sandbox invocation and changes nothing', async t => {
  const w = await world(t)
  const { stdout, stderr, status } = await run(w, candidate(w, [], w.runDir))
  assert.equal(status, 0, stdout + stderr)
  const state = JSON.parse(await readFile(join(w.runDir, 'run-state.json'), 'utf8'))
  const runId = state.run_id
  assert.match(stdout, new RegExp(`Codagent-AI/e2e-run-${runId}`))
  const planned = JSON.parse(stdout.slice(stdout.indexOf('{\n')))
  assert.deepEqual(planned.planned_provisioning.run_token_permissions, { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', metadata: 'read' })
  assert.deepEqual(planned.planned_provisioning.run_token_repositories, [`e2e-run-${runId}`])
  assert.equal(planned.dry_run, true)
  assert.match(stdout, /sandbox-driver\.sh/); assert.match(stdout, /openspec:change/); assert.match(stdout, /--docker-run-arg/); assert.match(stdout, /\.github-auth:\/github-auth:ro/)
  // Only reads reached GitHub, no container started, no model CLI invoked.
  assert.equal(w.github.requests.filter(request => request.method === 'POST' && request.path.endsWith('/repos')).length, 0)
  assert.equal(w.github.requests.filter(request => ['PUT', 'PATCH', 'DELETE'].includes(request.method)).length, 0)
  await assert.rejects(access(w.log))
  for (const secret of ['SENTINEL-OAUTH-SECRET', 'prov-token', 'BEGIN PRIVATE KEY']) { assert.ok(!stdout.includes(secret) && !stderr.includes(secret), secret) }
  const saved = JSON.parse(await readFile(join(w.runDir, 'result.json'), 'utf8'))
  assert.equal(saved.dry_run, true); assert.equal(saved.evaluation_status, 'dry-run'); assert.equal(saved.observed_error, undefined)
})

test('E2E-001 preflight fails with the missing profile field or CLI rule, before any provisioning or model call', async t => {
  const w = await world(t)
  const tester = candidate(w).filter((arg, index, all) => !(arg === '--tester-effort' || all[index - 1] === '--tester-effort'))
  const missing = await run(w, tester)
  assert.notEqual(missing.status, 0); assert.match(missing.stdout + missing.stderr, /profiles: missing tester\.effort/)
  const cursorLead = await run(w, candidate(w).map((arg, index, all) => all[index - 1] === '--lead-cli' ? 'cursor' : arg))
  assert.match(cursorLead.stdout + cursorLead.stderr, /lead must use claude or codex/)
  const cursorTesterDir = join(w.root, 'run2')
  const cursorTester = await run(w, ['--dry-run', '--run-dir', cursorTesterDir, '--runner-dir', w.runner, '--skills-dir', w.skills, ...ROLE_ARGS('codex').map((arg, index, all) => all[index - 1] === '--tester-cli' ? 'cursor' : arg)])
  assert.match(cursorTester.stdout + cursorTester.stderr, /cursor is accepted only for crosscheck/)
  assert.equal(w.github.requests.length, 0); await assert.rejects(access(w.log))
  const occupied = await run(w, candidate(w, [], cursorTesterDir)); assert.match(occupied.stdout + occupied.stderr, /run directory is already used; use --resume/)
  // A launcher may create the directory for its own log first; that alone does not make it used.
  const launched = join(w.root, 'launched'); await mkdir(join(launched, '.factory'), { recursive: true }); await writeFile(join(launched, 'factory-suite.log'), '')
  const fresh = await run(w, candidate(w, [], launched)); assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr)
  const stale = join(w.root, 'stale'); await mkdir(stale); await writeFile(join(stale, 'factory-suite.log'), ''); await writeFile(join(stale, 'notes.txt'), '')
  const refused = await run(w, candidate(w, [], stale)); assert.match(refused.stdout + refused.stderr, /run directory is already used; use --resume/)
})

test('E2E-001 preflight names a dirty checkout, a missing skill, a missing option and missing credentials', async t => {
  const w = await world(t)
  await writeFile(join(w.runner, 'dirty.txt'), 'x')
  const dirty = await run(w, candidate(w)); assert.match(dirty.stdout + dirty.stderr, /Agent Runner checkout/)
  const w2 = await world(t)
  await writeFile(join(w2.root, 'skills/skills/propose/SKILL.md'), '')
  const empty = await run(w2, candidate(w2)); assert.match(empty.stdout + empty.stderr, /Agent Skills checkout|missing required codagent:propose/)
  const w3 = await world(t)
  const noKey = await run(w3, candidate(w3), { ...w3.env, AND_SCENE_E2E_APP_ID: '' })
  assert.match(noKey.stdout + noKey.stderr, /provisioning credentials/)
  assert.equal(w3.github.requests.filter(request => request.path.endsWith('/repos')).length, 0)
})

test('E2E-001 the argument parser applies defaults, bounds and mode rules', () => {
  const base = ['--run-agent', ...ROLE_ARGS('claude')]
  const parsed = parseArguments(base, {})
  assert.equal(parsed.tokenRefreshMinutes, 30); assert.equal(parsed.timeLimitMs, DEFAULT_TIME_LIMIT_MS); assert.equal(parsed.stallWindowMs, 45 * 60 * 1000); assert.equal(parsed.workflow, 'openspec:change')
  for (const ok of ['1', '30', '50']) assert.equal(parseArguments([...base, '--token-refresh-interval', ok], {}).tokenRefreshMinutes, Number(ok))
  for (const bad of ['0', '51', 'abc', '-1']) assert.throws(() => parseArguments([...base, '--token-refresh-interval', bad], {}), /between 1 and 50/)
  assert.throws(() => parseRefreshInterval(0.5), /between 1 and 50/)
  assert.throws(() => parseArguments(['--rescore-from', '/tmp/x'], {}), /requires a new --run-dir/)
  assert.throws(() => parseArguments(['--rescore-from'], {}), /requires a run directory/)
  assert.equal(parseArguments(['--rescore-from', '/tmp/x', '--run-dir', '/tmp/y'], {}).rescoreFrom, '/tmp/x')
  assert.throws(() => parseArguments(['--resume'], {}), /requires --run-dir/)
  assert.throws(() => parseArguments(['--run-agent', '--dry-run'], {}), /exactly one mode/)
  assert.throws(() => parseArguments(['--calibrate'], {}), /calibrate\.mjs/)
  assert.throws(() => parseArguments([...base, '--no-such', 'x'], {}), /unknown option/)
  for (const pinned of ['--judge-model', '--judge-cli', '--simulated-user-model', '--judge-effort']) assert.throws(() => parseArguments([...base, pinned, 'x'], {}), /unknown option/, `${pinned} cannot override a pinned evaluator profile`)
  assert.equal(parseArguments([...base, '--workflow', 'openspec:change-v2'], {}).workflow, 'openspec:change-v2')
  const extra = parseArguments([...base, '--auditor-cli', 'claude', '--auditor-model', 'm', '--auditor-effort', 'e'], {})
  assert.deepEqual(extra.profiles.auditor, { cli: 'claude', model: 'm', effort: 'e' }, 'a role beyond the four defaults takes the same options')
  assert.equal(TOKEN_REFRESH.max, 50)
})
