import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { repoGit } from '../evals/agent-runner/and-scene-define/lib/starting-repo.mjs'
import { verifyMountPlan } from '../evals/agent-runner/and-scene-define/lib/preflight.mjs'
import { STAGED_FILES } from '../evals/agent-runner/and-scene-define/lib/sandbox.mjs'
const runnerDir = process.env.AGENT_RUNNER_DIR
// The real Runner is the tested boundary. Isolated auth/skills inputs avoid
// depending on a maintainer's plugin inventory or exposing their credentials.
for (const claudeAuth of ['file', 'token']) test(`INT-006 real Runner dry-run checks every container without Docker or model calls (Claude ${claudeAuth})`, { skip: !runnerDir && 'AGENT_RUNNER_DIR is unset; real Runner sandbox plan requires a checkout' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'define-plan-')); t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'); const skills = join(root, 'skills'); const run = join(root, 'run')
  for (const dir of [join(home, '.claude'), join(home, '.codex'), join(skills, '.claude-plugin'), join(skills, '.codex-plugin')]) await mkdir(dir, { recursive: true })
  if (claudeAuth === 'file') await writeFile(join(home, '.claude/.credentials.json'), '{"test":"credential"}')
  await writeFile(join(home, '.codex/auth.json'), '{"test":"credential"}')
  await writeFile(join(home, '.claude/settings.json'), '{"must_not_forward":true}')
  await writeFile(join(skills, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'codagent', source: './' }] }))
  await writeFile(join(skills, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'codagent', skills: './skills/' }))
  for (const skill of ['propose', 'proposal-review', 'call-agent', 'spec', 'design', 'test-plan', 'review-approach']) {
    await mkdir(join(skills, 'skills', skill), { recursive: true }); await writeFile(join(skills, 'skills', skill, 'SKILL.md'), `# ${skill}\nTest fixture\n`)
  }
  repoGit(skills, ['init', '--initial-branch=main']); repoGit(skills, ['add', '.']); repoGit(skills, ['commit', '-m', 'test: skill fixture'])
  const env = { ...process.env, GOMODCACHE: execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8' }).trim(), GOCACHE: execFileSync('go', ['env', 'GOCACHE'], { encoding: 'utf8' }).trim(), HOME: home, GITHUB_TOKEN: 'host-token-must-not-forward', ...(claudeAuth === 'token' ? { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-value' } : {}), AGENT_RUNNER_DIR: resolve(runnerDir), AGENT_SKILLS_DIR: skills }
  const processResult = spawnSync('bash', ['evals/agent-runner/and-scene-define/run.sh', '--dry-run', '--run-dir', run, '--lead-cli', 'codex', '--lead-model', 'gpt-6', '--lead-effort', 'high', '--crosscheck-cli', 'claude', '--crosscheck-model', 'claude-opus-5-5', '--crosscheck-effort', 'high'], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(processResult.status, 0, processResult.stdout + processResult.stderr)
  const output = processResult.stdout
  for (const flag of ['--auth-only', '--hide-source', '--no-default-secrets']) assert.ok(output.includes(flag))
  assert.ok(!output.includes('host-token-must-not-forward')); assert.ok(!output.includes('GITHUB_TOKEN')); assert.ok(!output.includes('settings.json'))
  const state = JSON.parse(await readFile(join(run, 'run-state.json'), 'utf8'))
  const options = { runnerDir: resolve(runnerDir), inputDir: join(run, 'sandbox-input'), artifactDir: join(run, 'sandbox'), skillsDir: skills, credentialFiles: [...(claudeAuth === 'file' ? [join(home, '.claude/.credentials.json')] : []), join(home, '.codex/auth.json')], forwardedEnv: claudeAuth === 'token' ? ['CLAUDE_CODE_OAUTH_TOKEN'] : [] }
  const containers = verifyMountPlan(state.plan.output, options)
  assert.equal(containers.length, 2)
  const command = containers.find(container => container.kind === 'command')
  assert.equal(command.mounts.filter(mount => mount.type === 'bind').length, claudeAuth === 'file' ? 5 : 4)
  assert.ok(!output.includes('claude-token-value'))
  assert.deepEqual(command.env.filter(value => value.startsWith('CLAUDE')), claudeAuth === 'token' ? ['CLAUDE_CODE_OAUTH_TOKEN'] : [])
  assert.ok(!command.mounts.some(mount => ['/agent-runner-source', '/tmp/agent-runner-local'].includes(mount.target)))
  assert.ok(!command.mounts.some(mount => mount.source.includes('and-scene-define')))
  assert.deepEqual((await readdir(options.inputDir)).sort(), [...STAGED_FILES].sort())
  assert.throws(() => verifyMountPlan(state.plan.output.replace(' -v ', ' -v /private/hidden:/hidden -v '), options), /\/private\/hidden/)
  const result = JSON.parse(await readFile(join(run, 'result.json'), 'utf8'))
  assert.equal(result.dry_run, true); assert.notEqual(result.evaluation_status, 'complete')
})
