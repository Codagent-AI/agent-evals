import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateProfiles, runnerConfig } from '../evals/agent-runner/and-scene-define/lib/profiles.mjs'
import { verifyCapabilities, verifyWorkflow, verifyMountPlan } from '../evals/agent-runner/and-scene-define/lib/preflight.mjs'
import { collectArtifacts } from '../evals/agent-runner/and-scene-define/lib/collection.mjs'
import { ingestDefineMetrics } from '../evals/agent-runner/and-scene-define/lib/runner-metrics.mjs'
import { repoGit } from '../evals/agent-runner/and-scene-define/lib/starting-repo.mjs'
const profiles = { lead: { cli: 'codex', model: 'gpt-6', effort: 'high' }, crosscheck: { cli: 'cursor', model: 'opus', effort: 'high' } }
test('profiles require every field and reject Cursor leads before dispatch', () => {
  assert.deepEqual(validateProfiles(profiles), profiles)
  assert.throws(() => validateProfiles({ ...profiles, lead: { cli: 'codex' } }), /lead.model/)
  assert.throws(() => validateProfiles({ ...profiles, lead: { ...profiles.lead, cli: 'cursor' } }), /claude or codex/)
  assert.match(runnerConfig(profiles), /active_profile: eval/)
})
test('preflight names missing Runner flags and workflow steps', () => {
  assert.throws(() => verifyCapabilities('help', '--auth-only --hide-source'), /--external-user/)
  assert.throws(() => verifyCapabilities('--external-user', '--hide-source'), /--auth-only/)
  assert.throws(() => verifyWorkflow('steps:\n  - id: proposal\n', ['proposal', 'specs'], 'core:define-change'), /specs/)
  assert.throws(() => verifyWorkflow('prompt: |\n  - id: specs\n', ['specs'], 'core:define-change'), /steps/)
})
test('mount preflight admits a forwarded variable by name only when expected', () => {
  const options = { inputDir: '/run/input', artifactDir: '/run/sandbox', skillsDir: '/skills', runnerDir: '/runner', credentialFiles: [] }
  const command = 'docker run -e HOME=/workspace/home -e CLAUDE_CODE_OAUTH_TOKEN -v /run/input:/eval-input:ro -v /run/sandbox:/artifacts -v /skills:/agent-skills:ro --mount type=volume,source=runner-bin,target=/workspace/bin image bash -lc run'
  assert.throws(() => verifyMountPlan(command, options), /CLAUDE_CODE_OAUTH_TOKEN/)
  assert.equal(verifyMountPlan(command, { ...options, forwardedEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] }).length, 1)
  assert.throws(() => verifyMountPlan(command.replace('CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN=value'), { ...options, forwardedEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] }), /CLAUDE_CODE_OAUTH_TOKEN/)
})

test('the sandbox launcher sees a Claude setup-token but no other host secret', async () => {
  const { sandboxEnvironment } = await import('../evals/agent-runner/and-scene-define/lib/sandbox.mjs')
  assert.deepEqual(sandboxEnvironment({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'token-value', GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' }), { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'token-value' })
})

test('mount preflight inspects build and command containers, modes, and environment', () => {
  const options = { inputDir: '/run/input', artifactDir: '/run/sandbox', skillsDir: '/skills', runnerDir: '/runner', credentialFiles: ['/home/.codex/auth.json'] }
  const build = 'docker run -v /runner:/agent-runner-source:ro --mount type=volume,source=runner-bin,target=/workspace/bin image bash -lc build'
  const command = 'docker run -e HOME=/workspace/home -v /run/input:/eval-input:ro -v /run/sandbox:/artifacts -v /skills:/agent-skills:ro --mount type=bind,source=/home/.codex/auth.json,target=/host-home/codex/auth.json,readonly --mount type=volume,source=runner-bin,target=/workspace/bin image bash -lc run'
  assert.equal(verifyMountPlan(`${build}\n${command}`, options).length, 2)
  assert.throws(() => verifyMountPlan(`${build}\n${command.replace(' image', ' -v /hidden:/hidden image')}`, options), /\/hidden/)
  assert.throws(() => verifyMountPlan(`${build.replace(' image', ' -v /suite:/suite image')}\n${command}`, options), /\/suite/)
  assert.throws(() => verifyMountPlan(command.replace(':ro', ''), options), /read-only/)
  assert.throws(() => verifyMountPlan(command.replace(' image', ' -e GITHUB_TOKEN image'), options), /GITHUB_TOKEN/)
  assert.throws(() => verifyMountPlan(command.replace(' image', ' --env-file /secrets image'), options), /env-file/)
})
test('collection freezes files and records SHA-256 and HEAD', async t => {
  const root = await mkdtemp(join(tmpdir(), 'define-collection-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const repo = join(root, 'repo'); const change = join(repo, 'openspec/changes/add-presentation-skill')
  await mkdir(change, { recursive: true }); await writeFile(join(change, 'proposal.md'), 'proposal')
  repoGit(repo, ['init', '--initial-branch=main']); repoGit(repo, ['add', '.']); repoGit(repo, ['commit', '-m', 'test: fixture'])
  const manifest = await collectArtifacts({ repoDir: repo, runDir: root })
  assert.equal(manifest.head, repoGit(repo, ['rev-parse', 'HEAD']))
  assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/)
  await writeFile(join(change, 'proposal.md'), 'changed')
  assert.equal(await readFile(join(root, 'collected/proposal.md'), 'utf8'), 'proposal')
})
test('define metrics attribute children to crosscheck and retain incomplete costs and usage', () => {
  const text = JSON.stringify({ schema_version: 3, run_id: 'r', workflow: 'openspec:change', history_complete: false, steps: [
    { id: 'proposal', prefix: 'define/proposal', agent_invoked: true, cli: 'codex', session_id: 'lead', duration_ms: 10, usage: { status: 'unavailable', reason: 'partial' } },
    { id: 'crosscheck', prefix: 'define/proposal/call-agent', kind: 'agent-call', target_name: 'crosscheck', agent_invoked: true, cli: 'cursor', session_id: 'child', duration_ms: 5, estimated_api_cost_usd: 1, usage: { status: 'collected', tokens: { input: 2 }, completeness: { history: 'partial' } } },
  ] })
  const metrics = ingestDefineMetrics({ text, runId: 'r' })
  assert.equal(metrics.complete, false)
  assert.equal(metrics.attempts[1].agent_role, 'crosscheck')
  assert.equal(metrics.by_step.proposal.duration_ms, 10)
  assert.equal(metrics.by_step.proposal.cost.complete, false)
  assert.equal(metrics.by_step.proposal.cost.total_usd, null)
  assert.equal(metrics.by_role.crosscheck.cost.known_subtotal_usd, 1)
  assert.equal(metrics.effective_invocations[1].session_id, 'child')
  assert.equal(ingestDefineMetrics({ text, runId: 'other' }).state, 'rejected')
})

test('sandbox driver creates the pinned repository, preserves all CLI sessions, and caps fresh/resumed argv', async t => {
  const { execFileSync } = await import('node:child_process')
  const { readlink } = await import('node:fs/promises')
  const { materialize } = await import('../evals/agent-runner/and-scene-define/lib/starting-repo.mjs')
  const { stageRuntime } = await import('../evals/agent-runner/and-scene-define/lib/sandbox.mjs')
  const root = await mkdtemp(join(tmpdir(), 'define-driver-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const starting = await materialize(join(root, 'starting'))
  const input = join(root, 'input'); const home = join(root, 'home'); const artifacts = join(root, 'sandbox'); const bin = join(root, 'bin'); const skills = join(root, 'skills')
  for (const dir of [home, bin, skills]) await mkdir(dir)
  await stageRuntime({ inputDir: input, bundlePath: starting.bundlePath, profiles })
  await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(bin, 'agent-runner'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/runner-argv"\n', { mode: 0o755 })
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GITHUB_TOKEN: 'unforwarded-test-token' }
  const args = [join(input, 'sandbox-driver.sh'), artifacts, skills, 'fresh', '', 'codex', 'cursor']
  execFileSync('bash', args, { env, stdio: 'pipe' })
  const repo = join(artifacts, 'workspace/repo')
  assert.equal(repoGit(repo, ['rev-list', '--all', '--count']), '1'); assert.equal(repoGit(repo, ['remote']), '')
  assert.equal(repoGit(repo, ['branch', '--show-current']), 'add-presentation-skill')
  assert.equal(repoGit(repo, ['rev-parse', 'main']), starting.commit)
  assert.match(await readFile(join(home, 'runner-argv'), 'utf8'), /run\nopenspec:change\n--external-user\n.*\n--until\ndefine\n--param\nchange_name=add-presentation-skill/s)
  for (const [name, path] of [['.agent-runner/projects', 'agent-runner-projects'], ['.codex/sessions', 'codex/sessions'], ['.claude/projects', 'claude/projects'], ['.cursor/chats', 'cursor/chats']]) assert.equal(await readlink(join(home, name)), join(artifacts, '.runtime', path))
  assert.equal(JSON.parse(await readFile(join(artifacts, 'logs/runner-exit.json'), 'utf8')).exit_code, 0)
  execFileSync('bash', [join(input, 'sandbox-driver.sh'), artifacts, skills, 'resume', 'existing-run', 'codex', 'cursor'], { env, stdio: 'pipe' })
  assert.equal(await readFile(join(home, 'runner-argv'), 'utf8'), '--resume\nexisting-run\n--until\ndefine\n')
})

async function preflightFixture(t) {
  const { cp } = await import('node:fs/promises')
  const { SUITE_ROOT } = await import('../evals/agent-runner/and-scene-define/lib/files.mjs')
  const root = await mkdtemp(join(tmpdir(), 'define-pins-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const runner = join(root, 'runner'); const skills = join(root, 'skills'); const suite = join(root, 'suite'); const home = join(root, 'home')
  for (const dir of [join(runner, 'workflows/openspec'), join(runner, 'workflows/core'), join(skills, '.claude-plugin'), join(skills, '.codex-plugin'), join(skills, '.cursor-plugin'), join(home, '.codex'), join(home, '.cursor')]) await mkdir(dir, { recursive: true })
  await writeFile(join(runner, 'workflows/openspec/change-v2.0.yaml'), 'steps:\n  - id: create\n  - id: define\n    workflow: ../core/define-change-v1.0.yaml\n')
  await writeFile(join(runner, 'workflows/core/define-change-v1.0.yaml'), 'steps:\n  - id: proposal\n  - id: specs\n  - id: design\n  - id: test-plan\n  - id: approach-review\n')
  await writeFile(join(skills, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'codagent', source: './' }] }))
  await writeFile(join(skills, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'codagent', skills: './skills/' }))
  await writeFile(join(skills, '.cursor-plugin/plugin.json'), JSON.stringify({ name: 'codagent' }))
  for (const path of [join(home, '.codex/auth.json'), join(home, '.cursor/auth.json')]) await writeFile(path, '{}')
  await cp(SUITE_ROOT, suite, { recursive: true })
  for (const repo of [runner, skills, suite]) { repoGit(repo, ['init', '--initial-branch=main']); repoGit(repo, ['add', '.']); repoGit(repo, ['commit', '-m', 'test: input fixture']) }
  const calls = []
  const command = (command, args) => { calls.push([command, args]); return { ok: true, stdout: '--external-user --auth-only --hide-source --no-default-secrets --input-dir --artifact-dir', stderr: '' } }
  return { runner, skills, suite, home, calls, command }
}

test('full preflight rejects pinned hash changes before any agent can start', async t => {
  const { inspectInputs } = await import('../evals/agent-runner/and-scene-define/lib/preflight.mjs')
  const { runner, skills, suite, home, calls, command } = await preflightFixture(t)
  await writeFile(join(suite, 'hidden/starting-prompt.md'), 'altered under the same pin')
  await assert.rejects(inspectInputs({ profiles, runnerDir: runner, skillsDir: skills, suiteRoot: suite, home, dryRun: true, command }), /hash mismatch|content hash differs/)
  assert.ok(!calls.some(([name]) => ['docker', 'claude', 'codex', 'cursor'].includes(name)))
})

test('a Claude agent without a credentials file is forwarded a setup-token instead', async t => {
  const { inspectInputs } = await import('../evals/agent-runner/and-scene-define/lib/preflight.mjs')
  const { runner, skills, suite, home, command } = await preflightFixture(t)
  const claudeProfiles = { ...profiles, crosscheck: { cli: 'claude', model: 'claude-opus-5-5', effort: 'high' } }
  // The token is relied on only when the Runner's sandbox help says it forwards it.
  const forwarding = (name, args) => ({ ...command(name, args), stdout: `${command(name, args).stdout} CLAUDE_CODE_OAUTH_TOKEN` })
  await assert.rejects(inspectInputs({ profiles: claudeProfiles, runnerDir: runner, skillsDir: skills, suiteRoot: suite, home, dryRun: true, command, rubricChecks: async () => {}, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-value' } }), /sandbox capability: .*does not forward CLAUDE_CODE_OAUTH_TOKEN/)
  const inputs = { profiles: claudeProfiles, runnerDir: runner, skillsDir: skills, suiteRoot: suite, home, dryRun: true, command: forwarding, rubricChecks: async () => {} }
  const inspected = await inspectInputs({ ...inputs, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-value' } })
  assert.deepEqual(inspected.credentials, [join(home, '.codex/auth.json')])
  assert.deepEqual(inspected.forwardedEnv, ['CLAUDE_CODE_OAUTH_TOKEN'])
  await assert.rejects(inspectInputs({ ...inputs, env: {} }), /\.claude\/\.credentials\.json.*CLAUDE_CODE_OAUTH_TOKEN/)
  await mkdir(join(home, '.claude')); await writeFile(join(home, '.claude/.credentials.json'), '{}')
  const withFile = await inspectInputs({ ...inputs, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-value' } })
  assert.deepEqual(withFile.credentials, [join(home, '.codex/auth.json'), join(home, '.claude/.credentials.json')])
  assert.deepEqual(withFile.forwardedEnv, [])
})

test('host judges check the host Claude login instead of a credentials file', async t => {
  const { inspectInputs } = await import('../evals/agent-runner/and-scene-define/lib/preflight.mjs')
  const { runner, skills, suite, home, calls, command } = await preflightFixture(t)
  const inputs = { profiles, runnerDir: runner, skillsDir: skills, suiteRoot: suite, home, dryRun: false, env: {}, rubricChecks: async () => {} }
  await inspectInputs({ ...inputs, command })
  assert.ok(calls.some(([name, args]) => name === 'claude' && args.join(' ') === 'auth status'))
  const loggedOut = (name, args) => name === 'claude' && args[0] === 'auth' ? { ok: false, stdout: '', stderr: 'not logged in', status: 1 } : command(name, args)
  await assert.rejects(inspectInputs({ ...inputs, command: loggedOut }), /host claude login/)
})

test('effective invocation evidence uses observed CLI identity instead of configured profiles', async () => {
  const { effectiveDefineInvocations } = await import('../evals/agent-runner/and-scene-define/lib/runner-metrics.mjs')
  const invocations = effectiveDefineInvocations({ steps: [{ id: 'design', prefix: 'define/design', agent_invoked: true, session_id: 'native', usage: { cli: 'codex', model: 'observed-model', effort: 'medium', identity: { requested_model: 'configured-model' } } }] })
  assert.deepEqual(invocations[0], { role: 'lead', step: 'design', prefix: 'define/design', session_id: 'native', cli: 'codex', model: 'observed-model', effort: 'medium', observed_identities: [] })
})

test('failed subprocess diagnostics retain exit status when stderr is empty', async () => {
  const { requireCommand } = await import('../evals/agent-runner/and-scene-define/lib/subprocess.mjs')
  assert.throws(() => requireCommand({ ok: false, error: null, stderr: '', status: 17 }, 'Docker availability'), /Docker availability: exit 17/)
  assert.throws(() => requireCommand({ ok: false, error: null, stderr: ' \n ', status: 3 }, 'Runner help'), /Runner help: exit 3/)
  assert.throws(() => requireCommand({ ok: false, error: null, stderr: '', status: null, signal: 'SIGTERM' }, 'Runner build'), /Runner build: signal SIGTERM/)
  assert.throws(() => requireCommand({ ok: false, error: 'spawn failed', stderr: 'secondary', status: null }), /spawn failed/)
  assert.throws(() => requireCommand({ ok: false, error: null, stderr: 'specific failure\n', status: 1 }), /specific failure/)
})
test('active-container lookup tolerates absent artifact directories and still detects their mounts', async t => {
  const { LocalSandbox } = await import('../evals/agent-runner/and-scene-define/lib/sandbox.mjs')
  const { realpath } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'define-active-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  let source = '/unrelated/artifacts'
  const command = (_command, args) => ({ ok: true, stdout: args[0] === 'ps' ? 'other-container\n' : JSON.stringify([{ Mounts: [{ Source: source }] }]), stderr: '' })
  const sandbox = new LocalSandbox({ runDir: root, runnerDir: root, skillsDir: root, command })
  assert.equal(await sandbox.isActive(), false)
  source = join(await realpath(root), 'sandbox')
  assert.equal(await sandbox.isActive(), true)
})
