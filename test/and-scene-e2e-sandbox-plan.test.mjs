import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { E2E, temp } from './and-scene-e2e-helpers.mjs'
import { verifyMountPlan } from '../evals/lib/define-run/mount-plan.mjs'
import { E2ESandbox, readValidatorReviewerClis, validatorReviewerClis, runnerConfig, STAGED_FILES } from '../evals/agent-runner/and-scene-e2e/lib/sandbox.mjs'

// A plan shaped like sandbox-run.sh --dry-run output: one build and one command container.
function plan({ input, art, skills, token, home, runner, claude = 'file', writableToken = false, extraHost = null, extraEnv = null }) {
  const mount = (source, target, ro = true) => `--mount type=bind\\,source=${source}\\,target=${target}${ro ? '\\,readonly' : ''}`
  const command = ['docker run --rm --init --shm-size=1g -w /workspace -e CI=1 -e HOME=/workspace/home',
    `-v ${art}:/artifacts -v ${input}:/eval-input:ro -v ${skills}:/agent-skills:ro -v ${token}:/github-auth${writableToken ? '' : ':ro'}`,
    mount(`${home}/.codex/auth.json`, '/host-home/codex/auth.json'),
    claude === 'file' ? mount(`${home}/.claude/.credentials.json`, '/host-home/claude/.credentials.json') : '-e CLAUDE_CODE_OAUTH_TOKEN',
    extraHost ? `-v ${extraHost}:/hidden:ro` : '', extraEnv ? `-e ${extraEnv}=1` : '',
    'agent-runner-dev:local bash -lc script'].filter(Boolean).join(' ')
  return `docker build -t agent-runner-dev:local -f ${runner}/docker/dev/Dockerfile ${runner}\n${command}\n`
}
async function setup(t) {
  const root = await temp(t, 'e2e-plan-')
  const dirs = { input: join(root, 'input'), art: join(root, 'run/sandbox'), skills: join(root, 'skills'), token: join(root, 'run/.github-auth'), home: join(root, 'home'), runner: join(root, 'runner') }
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
  for (const file of ['codex/auth.json', '.codex/auth.json', '.claude/.credentials.json']) { await mkdir(join(dirs.home, file, '..'), { recursive: true }); await writeFile(join(dirs.home, file), '{}') }
  const credentialFiles = [join(dirs.home, '.codex/auth.json'), join(dirs.home, '.claude/.credentials.json')]
  const options = { inputDir: dirs.input, artifactDir: dirs.art, skillsDir: dirs.skills, runnerDir: dirs.runner, credentialFiles, extraMounts: [{ source: dirs.token, target: '/github-auth', ro: true }] }
  return { dirs, options }
}

test('INT-003 the e2e plan adds exactly the reviewer auth and the read-only token directory', async t => {
  const { dirs, options } = await setup(t)
  const containers = verifyMountPlan(plan(dirs), options)
  const command = containers.find(container => container.kind === 'command')
  assert.ok(command.mounts.some(mount => mount.target === '/github-auth' && mount.ro))
  assert.ok(command.mounts.some(mount => mount.target === '/host-home/claude/.credentials.json'))
})

test('INT-003 setup-token reviewer auth is forwarded by name only', async t => {
  const { dirs, options } = await setup(t)
  const withToken = { ...options, credentialFiles: options.credentialFiles.slice(0, 1), forwardedEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] }
  assert.doesNotThrow(() => verifyMountPlan(plan({ ...dirs, claude: 'token' }), withToken))
  assert.throws(() => verifyMountPlan(plan({ ...dirs, claude: 'token' }), { ...withToken, forwardedEnv: [] }), /CLAUDE_CODE_OAUTH_TOKEN/)
})

test('INT-003 variants with an extra path, a writable token mount or another variable are rejected', async t => {
  const { dirs, options } = await setup(t)
  assert.throws(() => verifyMountPlan(plan({ ...dirs, extraHost: '/private/hidden' }), options), /\/private\/hidden/)
  assert.throws(() => verifyMountPlan(plan({ ...dirs, writableToken: true }), options), /must be read-only/)
  assert.throws(() => verifyMountPlan(plan({ ...dirs, extraEnv: 'GITHUB_TOKEN' }), options), /GITHUB_TOKEN/)
  assert.throws(() => verifyMountPlan(plan(dirs).replace(/-v \S+:\/github-auth:ro/, ''), options), /missing mount/)
})

test('INT-003 the reviewer CLI is planned even when every role uses codex', async t => {
  const { dirs } = await setup(t)
  const reviewer = validatorReviewerClis('cli:\n  default_preference:\n    - claude\n    - codex\n')
  assert.deepEqual(reviewer, ['claude'])
  assert.deepEqual(await readValidatorReviewerClis(), ['claude'])
  const sandbox = new E2ESandbox({ runDir: join(dirs.art, '..'), runnerDir: dirs.runner, skillsDir: dirs.skills, reviewerClis: reviewer, workflow: 'openspec:change', deliveryUrl: 'https://github.com/Codagent-AI/e2e-run-x.git' })
  sandbox.inputDir = dirs.input
  const codex = Object.fromEntries(['lead', 'crosscheck', 'implementor', 'tester'].map(role => [role, { cli: 'codex', model: 'm', effort: 'e' }]))
  const args = sandbox.args(codex, { kind: 'fresh' })
  assert.ok(args.includes('--mount-claude-auth') && args.includes('--mount-codex-auth'))
  assert.ok(args.includes(`${sandbox.tokenDir}:/github-auth:ro`))
  const resume = sandbox.args(codex, { kind: 'resume', runId: 'abc', until: 'implement' })
  assert.deepEqual(resume.slice(resume.indexOf('/artifacts')), ['/artifacts', '/agent-skills', 'resume', 'abc', 'implement', 'openspec:change', 'https://github.com/Codagent-AI/e2e-run-x.git', 'codex', 'claude'])
  assert.throws(() => validatorReviewerClis('base_branch: main\n'), /no reviewer CLI/)
})

test('INT-003 role config makes only the lead interactive', () => {
  const profiles = Object.fromEntries(['lead', 'crosscheck', 'implementor', 'tester'].map(role => [role, { cli: 'claude', model: 'm', effort: 'high' }]))
  const config = runnerConfig(profiles)
  assert.match(config, /lead:\n        default_mode: interactive/)
  for (const role of ['crosscheck', 'implementor', 'tester']) assert.match(config, new RegExp(`${role}:\\n        default_mode: autonomous`))
  assert.equal(STAGED_FILES.length, 6)
})

const runnerDir = process.env.AGENT_RUNNER_DIR ?? '/Users/paul/codagent/agent-runner'
test('INT-003 the real Runner dry-run plan verifies with the e2e additions', { skip: !process.env.AGENT_RUNNER_DIR && 'AGENT_RUNNER_DIR is unset; real Runner sandbox script unavailable' }, async t => {
  const { dirs, options } = await setup(t)
  const sandbox = new E2ESandbox({ runDir: join(dirs.art, '..'), runnerDir, skillsDir: dirs.skills, env: { PATH: process.env.PATH, HOME: dirs.home }, reviewerClis: ['claude'], workflow: 'openspec:change', deliveryUrl: 'https://github.com/Codagent-AI/e2e-run-x.git' })
  sandbox.inputDir = dirs.input
  const profiles = Object.fromEntries(['lead', 'crosscheck', 'implementor', 'tester'].map(role => [role, { cli: 'codex', model: 'm', effort: 'e' }]))
  const result = spawnSync('bash', sandbox.args(profiles, { kind: 'fresh' }, true), { env: sandbox.env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const real = { ...options, runnerDir }
  assert.doesNotThrow(() => verifyMountPlan(result.stdout, real))
  assert.throws(() => verifyMountPlan(result.stdout.replace(' -v ', ' -v /private/hidden:/hidden -v '), real), /\/private\/hidden/)
})
