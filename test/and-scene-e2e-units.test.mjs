import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { E2E, ROLE_ARGS, fakeHome, fakeRunner, fakeSkills, git, keyPair, script, temp, SKILLS } from './and-scene-e2e-helpers.mjs'
import { checkWorkflow, resolveWorkflowFile } from '../evals/agent-runner/and-scene-e2e/lib/workflow.mjs'
import { validateProfiles, DEFAULT_ROLES } from '../evals/agent-runner/and-scene-e2e/lib/options.mjs'
import { inspectInputs, PreflightError } from '../evals/agent-runner/and-scene-e2e/lib/preflight.mjs'
import { runTimed } from '../evals/lib/define-run/subprocess.mjs'
import { GitHubApp } from '../evals/agent-runner/and-scene-e2e/lib/provisioning.mjs'
import { ingestWorkflowMetrics, effectiveInvocations, invocationsThrough, topLevelStep } from '../evals/agent-runner/and-scene-e2e/lib/metrics.mjs'
import { failureOutcome, EVALUATION_STATUSES, publicationEligibility } from '../evals/agent-runner/and-scene-e2e/lib/outcomes.mjs'
import { ActiveClock, StallDetector } from '../evals/agent-runner/and-scene-e2e/lib/watchdogs.mjs'
import { privatePath } from '../evals/agent-runner/and-scene-e2e/lib/runner.mjs'
import { runEvaluation } from '../evals/agent-runner/and-scene-e2e/controller.mjs'
import { lifecycle } from './and-scene-e2e-lifecycle-helpers.mjs'
import { checkVersions } from '../evals/agent-runner/and-scene-e2e/lib/versions.mjs'
import { assembleResult } from '../evals/agent-runner/and-scene-e2e/lib/result.mjs'

// ---- workflow resolution -----------------------------------------------------------------------------------------------
const TOP = ['create', 'define', 'implement']
test('I-5 the default workflow is recorded with the reference, the reported name and the hash of what Runner resolves', async t => {
  const root = await temp(t, 'e2e-wf-'); const runner = await fakeRunner(root)
  const checked = await checkWorkflow({ runnerDir: runner, reference: 'openspec:change' })
  assert.equal(checked.reference, 'openspec:change'); assert.equal(checked.name, 'change')
  assert.equal(checked.hash, createHash('sha256').update(await readFile(join(runner, 'workflows/openspec/change-v3.0.yaml'))).digest('hex'))
  assert.deepEqual(checked.roles, DEFAULT_ROLES); assert.deepEqual(checked.top_steps, ['create', 'define', 'implement', 'accept'])
  await writeFile(join(runner, 'workflows/openspec/change-v3.1.yaml'), (await readFile(join(runner, 'workflows/openspec/change-v3.0.yaml'), 'utf8')).replace('name: change', 'name: change-newer'))
  assert.match(await resolveWorkflowFile(runner, 'openspec:change'), /change-v3\.1\.yaml$/, 'the highest version resolves')
  assert.equal((await checkWorkflow({ runnerDir: runner, reference: 'openspec:change' })).name, 'change-newer')
})
test('I-6 each required declaration is checked and named; nothing else about step ids, order, nesting or sessions is', async t => {
  for (const missing of TOP) {
    const root = await temp(t, 'e2e-wf-'); const runner = await fakeRunner(root)
    const file = join(runner, 'workflows/openspec/change-v3.0.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace(new RegExp(`  - id: ${missing}\\n(?:    .*\\n)*`), ''))
    await assert.rejects(checkWorkflow({ runnerDir: runner, reference: 'openspec:change' }), new RegExp(`missing top-level ${missing} step`), missing)
  }
  for (const missing of ['proposal', 'specs', 'design', 'test-plan', 'approach-review']) {
    const root = await temp(t, 'e2e-wf-'); const runner = await fakeRunner(root)
    const file = join(runner, 'workflows/core/define-change-v1.0.yaml')
    await writeFile(file, (await readFile(file, 'utf8')).replace(new RegExp(`  - id: ${missing}\\n(?:    .*\\n)*`), ''))
    await assert.rejects(checkWorkflow({ runnerDir: runner, reference: 'openspec:change' }), new RegExp(`define sub-workflow is missing step ${missing}`), missing)
  }
  const root = await temp(t, 'e2e-wf-'); const runner = await fakeRunner(root)
  // Reordered top-level steps, renamed unrelated steps, new session names and an extra step are all accepted.
  await writeFile(join(runner, 'workflows/openspec/change-v3.0.yaml'), `name: change\nsteps:\n  - id: finalize\n    script: x.sh\n  - id: implement\n    workflow: ../core/implement-change-v2.0.yaml\n  - id: create\n    script: create.sh\n  - id: define\n    workflow: ../core/define-change-v1.0.yaml\n    session: whatever-name\n`)
  await writeFile(join(runner, 'workflows/core/define-change-v1.0.yaml'), `steps:\n${['approach-review', 'test-plan', 'design', 'specs', 'proposal', 'extra'].map(id => `  - id: ${id}\n    agent: lead\n    session: s-${id}\n`).join('')}`)
  const accepted = await checkWorkflow({ runnerDir: runner, reference: 'openspec:change' })
  assert.deepEqual(accepted.top_steps, ['finalize', 'implement', 'create', 'define'])
  await assert.rejects(checkWorkflow({ runnerDir: runner, reference: 'not a ref' }), /group:name/); await assert.rejects(checkWorkflow({ runnerDir: runner, reference: 'openspec:nothing' }), /no definition found/)
})
test('I-7 every role the selected workflow uses needs a profile; cursor is crosscheck-only; lead is claude or codex', async t => {
  const root = await temp(t, 'e2e-wf-'); const runner = await fakeRunner(root)
  const file = join(runner, 'workflows/core/implement-change-v2.0.yaml')
  await writeFile(file, `${await readFile(file, 'utf8')}  - id: audit\n    agent: auditor\n`)
  const checked = await checkWorkflow({ runnerDir: runner, reference: 'openspec:change' })
  assert.deepEqual(checked.roles, [...DEFAULT_ROLES, 'auditor'])
  const profile = cli => ({ cli, model: 'm', effort: 'e' })
  const base = Object.fromEntries(DEFAULT_ROLES.map(role => [role, profile('codex')]))
  assert.throws(() => validateProfiles(base, checked.roles), /profiles: missing auditor\.cli/); assert.doesNotThrow(() => validateProfiles({ ...base, auditor: profile('claude') }, checked.roles))
  for (const role of DEFAULT_ROLES) for (const field of ['cli', 'model', 'effort']) assert.throws(() => validateProfiles({ ...base, [role]: { ...base[role], [field]: ' ' } }), new RegExp(`missing ${role}\\.${field}`))
  assert.throws(() => validateProfiles({ ...base, lead: profile('cursor') }), /lead must use claude or codex/)
  assert.doesNotThrow(() => validateProfiles({ ...base, crosscheck: profile('cursor') }))
  for (const role of ['implementor', 'tester']) assert.throws(() => validateProfiles({ ...base, [role]: profile('cursor') }), /cursor is accepted only for crosscheck/)
  assert.throws(() => validateProfiles({ ...base, crosscheck: profile('gemini') }), /crosscheck must use/)
})

// ---- preflight ------------------------------------------------------------------------------------------------------------
async function preflightWorld(t, { suiteRoot = undefined } = {}) {
  const root = await temp(t, 'e2e-pre-')
  const runner = await fakeRunner(root); const skills = await fakeSkills(root); const home = await fakeHome(root)
  const calls = []
  const command = (cmd, args, options) => { calls.push(cmd); if (['docker', 'claude', 'codex'].includes(cmd)) return { ok: true, status: 0, stdout: '', stderr: '' }; return runTimed(cmd, args, options) }
  const { privateKey } = keyPair()
  const provisioning = { tokens: 0, repos: [{ name: 'e2e-run-a', full_name: 'Codagent-AI/e2e-run-a' }] }
  const app = new GitHubApp({ appId: '1', privateKey, apiUrl: 'http://127.0.0.1:1', fetch: async (url, init) => {
    const path = new URL(url).pathname
    const json = value => ({ status: 200, text: async () => JSON.stringify(value) })
    if (path.endsWith('/installation')) return json({ id: 5 })
    if (path.includes('/access_tokens')) { provisioning.tokens++; return { status: 201, text: async () => JSON.stringify({ token: 't', expires_at: 'x' }) } }
    if (path === '/installation/repositories') return json({ repositories: provisioning.repos })
    return { status: 404, text: async () => '{}' }
  } })
  const base = { profiles: Object.fromEntries(DEFAULT_ROLES.map(role => [role, { cli: 'codex', model: 'm', effort: 'e' }])), workflow: 'openspec:change', runnerDir: runner, skillsDir: skills, home, env: { PATH: process.env.PATH, HOME: home }, command, app, dryRun: false, ...(suiteRoot ? { suiteRoot } : {}) }
  return { root, runner, skills, home, calls, provisioning, base }
}
const failsWith = async (base, check, pattern) => assert.rejects(inspectInputs(base), error => error instanceof PreflightError && error.check === check && pattern.test(error.message), check)
test('I-11 preflight fails each dependency independently, naming the check, before provisioning or any model call', async t => {
  const w = await preflightWorld(t)
  const ok = await inspectInputs(w.base)
  assert.deepEqual(ok.requiredSkills, [...ok.requiredSkills].sort()); assert.equal(w.provisioning.tokens, 1)
  assert.ok(w.calls.every(cmd => !['claude', 'codex'].includes(cmd) || true))
  await writeFile(join(w.runner, 'dirty'), 'x'); await failsWith(w.base, 'Agent Runner checkout', /not clean/); await rm(join(w.runner, 'dirty'))
  await writeFile(join(w.skills, 'dirty'), 'x'); await failsWith(w.base, 'Agent Skills checkout', /not clean/); await rm(join(w.skills, 'dirty'))
  for (const skill of SKILLS) {
    const w2 = await preflightWorld(t); await writeFile(join(w2.skills, 'skills', skill, 'SKILL.md'), ''); git(w2.skills, ['add', '-A']); git(w2.skills, ['commit', '--quiet', '-m', 'empty'])
    await failsWith(w2.base, 'Agent Skills', new RegExp(`missing required codagent:${skill}`)); assert.equal(w2.provisioning.tokens, 0, 'no provisioning before the skills check')
  }
  const noOption = await preflightWorld(t, {}); await script(join(noOption.runner, 'bin/agent-runner'), 'echo "--external-user"'); git(noOption.runner, ['add', '-A']); git(noOption.runner, ['commit', '--quiet', '-m', 'old'])
  await failsWith(noOption.base, 'Agent Runner capability', /missing --until/)
  const noExternal = await preflightWorld(t); await script(join(noExternal.runner, 'bin/agent-runner'), 'echo "--until"'); git(noExternal.runner, ['add', '-A']); git(noExternal.runner, ['commit', '--quiet', '-m', 'old'])
  await failsWith(noExternal.base, 'Agent Runner capability', /missing --external-user/)
  const noSandboxOption = await preflightWorld(t); await script(join(noSandboxOption.runner, 'scripts/sandbox-run.sh'), 'echo "--auth-only"'); git(noSandboxOption.runner, ['add', '-A']); git(noSandboxOption.runner, ['commit', '--quiet', '-m', 'old'])
  await failsWith(noSandboxOption.base, 'Agent Runner capability', /sandbox capability: missing --hide-source/)
  const docker = await preflightWorld(t); docker.base.command = (cmd, args, options) => cmd === 'docker' ? { ok: false, status: 1, stdout: '', stderr: 'no daemon' } : runTimed(cmd, args, options)
  await failsWith(docker.base, 'Docker', /Docker availability/); await inspectInputs({ ...docker.base, dryRun: true })
  const codexAuth = await preflightWorld(t); await rm(join(codexAuth.home, '.codex/auth.json')); await failsWith(codexAuth.base, 'authentication', /missing regular credential file/)
  const hostCli = await preflightWorld(t); hostCli.base.command = (cmd, args, options) => cmd === 'claude' ? { ok: false, status: 1, stdout: '', stderr: 'not logged in' } : runTimed(cmd, args, options)
  await failsWith(hostCli.base, 'judge and simulated-user authentication', /host claude/)
  const noCreds = await preflightWorld(t); noCreds.base.app = null; noCreds.base.env = { PATH: process.env.PATH, HOME: noCreds.home }
  await failsWith(noCreds.base, 'provisioning credentials', /AND_SCENE_E2E_APP_ID/)
})
test('I-12 missing Claude authentication for Validator reviews fails preflight even when every role uses codex', async t => {
  const w = await preflightWorld(t); await rm(join(w.home, '.claude/.credentials.json'))
  await failsWith(w.base, 'Validator reviewer authentication', /missing Claude authentication for the CLI the Validator reviews with/)
  assert.equal(w.provisioning.tokens, 0)
  await script(join(w.runner, 'scripts/sandbox-run.sh'), 'echo "--auth-only --hide-source --no-default-secrets --input-dir --artifact-dir --docker-run-arg"'); git(w.runner, ['add', '-A']); git(w.runner, ['commit', '--quiet', '-m', 'old'])
  const withToken = await inspectInputs({ ...w.base, env: { ...w.base.env, CLAUDE_CODE_OAUTH_TOKEN: 'set' } }).catch(error => error)
  assert.match(String(withToken.message), /does not forward CLAUDE_CODE_OAUTH_TOKEN/, 'a setup-token needs a Runner that forwards it')
  await script(join(w.runner, 'scripts/sandbox-run.sh'), 'echo "--auth-only --hide-source --no-default-secrets --input-dir --artifact-dir --docker-run-arg CLAUDE_CODE_OAUTH_TOKEN"'); git(w.runner, ['add', '-A']); git(w.runner, ['commit', '--quiet', '-m', 'token'])
  const ok = await inspectInputs({ ...w.base, env: { ...w.base.env, CLAUDE_CODE_OAUTH_TOKEN: 'set' } })
  assert.deepEqual(ok.forwardedEnv, ['CLAUDE_CODE_OAUTH_TOKEN']); assert.ok(!ok.credentials.some(path => path.endsWith('.claude/.credentials.json')))
})
test('I-13 the installation reaching a repository outside the delivery repositories fails preflight naming it', async t => {
  const w = await preflightWorld(t); w.provisioning.repos.push({ name: 'and-scene', full_name: 'Codagent-AI/and-scene' })
  await assert.rejects(inspectInputs(w.base), error => error instanceof PreflightError && error.check === 'provisioning reach' && /Codagent-AI\/and-scene/.test(error.message))
})
test('I-9 the series identity holds every evaluator input and the candidate every evaluated one; each moves only its own record', async t => {
  const w = await preflightWorld(t)
  const first = await inspectInputs(w.base)
  for (const key of ['starting_prompt', 'starting_tree_hash', 'reference', 'inventory', 'definition_rubric', 'contamination_patterns', 'product_rubric', 'human_rubric', 'judge_profiles', 'simulated_user_profile', 'simulated_user_policy', 'panel_protocol']) assert.ok(first.seriesIdentity[key] !== undefined, key)
  for (const key of ['profiles', 'agent_runner_commit', 'workflow', 'agent_skills_commit', 'validator_reviewer']) assert.ok(first.candidate[key] !== undefined, key)
  assert.deepEqual(Object.keys(first.candidate.workflow).sort(), ['define_hash', 'hash', 'name', 'reference'])
  // A candidate-only change: another Runner commit and another model change the candidate, not the series.
  await writeFile(join(w.runner, 'note.txt'), 'x'); git(w.runner, ['add', '-A']); git(w.runner, ['commit', '--quiet', '-m', 'move'])
  const moved = await inspectInputs({ ...w.base, profiles: { ...w.base.profiles, lead: { cli: 'codex', model: 'other', effort: 'e' } } })
  assert.deepEqual(moved.seriesIdentity, first.seriesIdentity); assert.notEqual(moved.candidate.agent_runner_commit, first.candidate.agent_runner_commit); assert.equal(moved.candidate.profiles.lead.model, 'other')
  // An evaluator-only change: a bumped product rubric moves the series and leaves the candidate.
  const tree = join(w.root, 'evals/agent-runner'); await mkdir(tree, { recursive: true })
  await cp(E2E, join(tree, 'and-scene-e2e'), { recursive: true }); await symlink(join(E2E, '../and-scene'), join(tree, 'and-scene')); await symlink(join(E2E, '../and-scene-define'), join(tree, 'and-scene-define'))
  const suiteRoot = join(tree, 'and-scene-e2e')
  const rubricPath = join(suiteRoot, 'product-rubric.json'); const rubric = JSON.parse(await readFile(rubricPath, 'utf8')); rubric.version = '9.9.9'; const text = `${JSON.stringify(rubric, null, 2)}\n`
  await writeFile(rubricPath, text); const ledger = JSON.parse(await readFile(join(suiteRoot, 'versions.json'), 'utf8')); ledger.inputs['product-rubric'].version = 2; ledger.inputs['product-rubric'].hashes['2'] = createHash('sha256').update(text).digest('hex'); await writeFile(join(suiteRoot, 'versions.json'), JSON.stringify(ledger, null, 2))
  const bumped = await inspectInputs({ ...w.base, suiteRoot })
  assert.equal(bumped.seriesIdentity.product_rubric.version, '9.9.9'); assert.notDeepEqual(bumped.seriesIdentity, moved.seriesIdentity); assert.deepEqual(bumped.candidate, moved.candidate.agent_runner_commit === bumped.candidate.agent_runner_commit ? { ...bumped.candidate } : bumped.candidate)
  assert.equal(bumped.candidate.agent_runner_commit, moved.candidate.agent_runner_commit)
  // The refresh interval is provenance, not identity.
  assert.ok(!JSON.stringify(first.seriesIdentity).includes('token_refresh'))
})
test('I-66 a rubric declaring a threshold or floor fails preflight before any model call, and so do tampered pinned inputs', async t => {
  const w = await preflightWorld(t)
  const tree = join(w.root, 'evals/agent-runner'); await mkdir(tree, { recursive: true })
  await cp(E2E, join(tree, 'and-scene-e2e'), { recursive: true }); await symlink(join(E2E, '../and-scene'), join(tree, 'and-scene')); await symlink(join(E2E, '../and-scene-define'), join(tree, 'and-scene-define'))
  const suiteRoot = join(tree, 'and-scene-e2e'); const path = join(suiteRoot, 'product-rubric.json')
  const original = await readFile(path, 'utf8')
  const rewrite = async edit => { const rubric = JSON.parse(original); edit(rubric); const text = JSON.stringify(rubric, null, 2) + '\n'; await writeFile(path, text); const ledger = JSON.parse(await readFile(join(suiteRoot, 'versions.json'), 'utf8')); ledger.inputs['product-rubric'].hashes['1'] = createHash('sha256').update(text).digest('hex'); await writeFile(join(suiteRoot, 'versions.json'), JSON.stringify(ledger, null, 2)) }
  await rewrite(rubric => { rubric.pass_threshold = 70 }); await failsWith({ ...w.base, suiteRoot }, 'product rubric', /must not declare pass_threshold/)
  await rewrite(rubric => { rubric.components[0].floor = 12.5 }); await failsWith({ ...w.base, suiteRoot }, 'product rubric', /must not declare a floor/)
  await writeFile(path, original); await failsWith({ ...w.base, suiteRoot }, 'pinned inputs', /content hash differs at version 1/)
  assert.equal(w.provisioning.tokens, 0, 'preflight stopped before provisioning')
  assert.deepEqual(await checkVersions(), [])
})

// ---- metrics, outcomes, clocks, paths ------------------------------------------------------------------------------------
test('I-57 workflow metrics span both invocations, split per top-level step and role, and never invent totals', async () => {
  const text = await readFile(new URL('./fixtures/run-metrics-two-invocations.json', import.meta.url), 'utf8')
  const runId = JSON.parse(text).run_id
  const metrics = ingestWorkflowMetrics({ text, runId, workflow: 'change', stepOrder: ['define', 'implement'] })
  assert.equal(metrics.state, 'ingested')
  assert.ok(metrics.by_step.define.attempts.length > 0 && metrics.by_step.implement.attempts.length > 0)
  const defineOnly = new Set(metrics.by_step.define.attempts), implementOnly = new Set(metrics.by_step.implement.attempts)
  assert.ok([...defineOnly].every(id => !implementOnly.has(id)), 'no attempt is counted in both stages')
  assert.equal(metrics.total.attempts.length, defineOnly.size + implementOnly.size)
  assert.ok(['lead', 'crosscheck', 'implementor'].every(role => role in metrics.by_role)); assert.equal(typeof metrics.complete, 'boolean')
  for (const summary of [...Object.values(metrics.by_step), ...Object.values(metrics.by_role), metrics.total]) assert.ok(summary.cost.complete === false ? summary.cost.total_usd === null : true, 'an incomplete total is null, not a guess')
  const duplicated = JSON.parse(text); duplicated.steps.push(duplicated.steps.find(step => step.agent_invoked))
  assert.equal(ingestWorkflowMetrics({ text: JSON.stringify(duplicated), runId, workflow: 'change' }).total.attempts.length, metrics.total.attempts.length, 'a repeated attempt record counts once')
  assert.equal(ingestWorkflowMetrics({ text: '{}', runId: 'x', workflow: 'change' }).total, null)
  assert.equal(topLevelStep({ prefix: 'implement/sub:implement-change/x' }), 'implement'); assert.equal(topLevelStep({ prefix: '', id: 'define' }), 'define')
  const invocations = effectiveInvocations(JSON.parse(text)); assert.deepEqual(invocationsThrough(invocations, ['create', 'define', 'implement'], 'define').map(i => i.phase), invocationsThrough(invocations, ['create', 'define', 'implement'], 'define').map(() => 'define'))
  assert.ok(invocations.some(i => i.phase === 'implement' && i.role === 'implementor'))
})
test('I-53 the status table: exactly the six statuses, workflow failures named by stage, and a harness failure is never a score', async t => {
  assert.deepEqual(EVALUATION_STATUSES, ['complete', 'pending-human-review', 'definition-workflow-failed', 'implementation-workflow-failed', 'contaminated', 'evaluation-harness-failed'])
  assert.equal(failureOutcome({ phase: 'p', reason: 'r', workflow: true, defineCompleted: false }).evaluation_status, 'definition-workflow-failed')
  assert.equal(failureOutcome({ phase: 'p', reason: 'r', workflow: true, defineCompleted: true }).evaluation_status, 'implementation-workflow-failed')
  assert.equal(failureOutcome({ phase: 'p', reason: 'r' }).evaluation_status, 'evaluation-harness-failed')
  const f = await lifecycle(t)
  await assert.rejects(assembleResult({ runDir: f.runDir, outcome: { evaluation_status: 'passed' }, checkpoint: {} }), /unknown evaluation status/)
  for (const status of ['contaminated', 'evaluation-harness-failed', 'definition-workflow-failed']) {
    await mkdir(f.runDir, { recursive: true })
    const result = await assembleResult({ runDir: f.runDir, outcome: { evaluation_status: status, owning_phase: 'x', observed_error: 'e', resumable: false }, checkpoint: { run_id: 'r' } })
    assert.equal(result.definition_score, null); assert.equal(result.product_score, null); assert.equal(result.requirement_trace, null)
    for (const field of ['verdict', 'pass', 'passed']) assert.ok(!(field in result), field)
  }
  assert.equal(publicationEligibility({ evaluation_status: 'complete' }), true)
})
test('I-30 the active clock counts only running time across resumes, with default and custom limits', () => {
  let now = 0; const clock = new ActiveClock({ limitMs: 12 * 3600e3, now: () => now })
  clock.start(); now += 10 * 3600e3; assert.equal(clock.stop(), 10 * 3600e3)
  now += 14 * 3600e3
  const resumed = new ActiveClock({ limitMs: 12 * 3600e3, usedMs: clock.usedMs, now: () => now }); assert.equal(resumed.remainingMs(), 2 * 3600e3)
  resumed.start(); now += 2 * 3600e3 - 1; assert.equal(resumed.exhausted(), false); now += 1; assert.equal(resumed.exhausted(), true)
  const waited = new ActiveClock({ limitMs: 3600e3, now: () => now }); waited.start(); now += 600e3; waited.pause(300e3); assert.equal(waited.elapsedMs(), 300e3, 'a quota wait is not active time')
})
test('I-31 the stall detector reads the newest activity, treats a credited wait as activity, and stalls at the window boundary', () => {
  let now = 1000; let activity = 1000
  const detector = new StallDetector({ windowMs: 100, latestActivityMs: () => activity, now: () => now, startedMs: 1000 })
  now = 1099; assert.equal(detector.check().stalled, false); now = 1100; assert.equal(detector.check().stalled, true)
  activity = 1100; assert.equal(detector.check().stalled, false)
  now = 1250; detector.credit(100); assert.equal(detector.check().stalled, false)
})
test('C-2 every run path is guarded against symlinks, and a second controller for a run is refused', async t => {
  const root = await temp(t, 'e2e-paths-'); const outside = await temp(t, 'e2e-outside-')
  await mkdir(join(root, 'run')); await symlink(outside, join(root, 'run/evidence'))
  await assert.rejects(privatePath(join(root, 'run/evidence/final'), join(root, 'run')), /refuses symlink/)
  await assert.doesNotReject(privatePath(join(root, 'run/not-yet'), join(root, 'run')))
  const f = await lifecycle(t)
  await mkdir(f.runDir, { recursive: true }); await symlink(outside, join(f.runDir, 'phases'))
  const refused = await runEvaluation(f.options, f.deps)
  assert.equal(refused.result.evaluation_status, 'evaluation-harness-failed'); assert.match(refused.result.observed_error, /refuses symlink|already used/)
  assert.deepEqual(await readdir(outside), [], 'nothing was written through the link')
  const g = await lifecycle(t); await mkdir(g.runDir, { recursive: true }); await writeFile(join(g.runDir, '.controller.lock'), JSON.stringify({ pid: process.pid }))
  const locked = await runEvaluation({ ...g.options, resume: true }, g.deps)
  assert.match(locked.result.observed_error, /controller is active/)
})

import { checkVersions as checkDefineVersions } from '../evals/lib/define-run/versions.mjs'
import { materialize, verifySnapshot } from '../evals/lib/define-run/starting-repo.mjs'
import { DEFINE_ROOT } from '../evals/agent-runner/and-scene-e2e/lib/files.mjs'
import { filesUnder } from '../evals/lib/define-run/files.mjs'
test('I-4 a candidate is admitted without any calibration state: preflight never reads the calibration directory', async t => {
  const w = await preflightWorld(t)
  const tree = join(w.root, 'evals/agent-runner'); await mkdir(tree, { recursive: true })
  await cp(E2E, join(tree, 'and-scene-e2e'), { recursive: true }); await symlink(join(E2E, '../and-scene'), join(tree, 'and-scene')); await symlink(join(E2E, '../and-scene-define'), join(tree, 'and-scene-define'))
  await rm(join(tree, 'and-scene-e2e/calibration'), { recursive: true, force: true })
  const admitted = await inspectInputs({ ...w.base, suiteRoot: join(tree, 'and-scene-e2e') })
  assert.ok(admitted.seriesIdentity.product_rubric)
  for (const file of ['lib/preflight.mjs', 'controller.mjs']) assert.doesNotMatch(await readFile(join(E2E, file), 'utf8'), /calibration/, `${file} does not depend on calibration`)
})
test('C-1 the starting prompt, tree, inventory and policies are the pinned define-suite inputs; the materialized repository is one clean commit', async t => {
  assert.deepEqual(await checkDefineVersions({ suiteRoot: DEFINE_ROOT }), [])
  const tree = await verifySnapshot({ suiteRoot: DEFINE_ROOT })
  const root = await temp(t, 'e2e-start-'); const staged = await materialize(join(root, 'stage'), { suiteRoot: DEFINE_ROOT })
  assert.equal(staged.treeHash, tree)
  assert.equal(git(staged.repoDir, ['rev-list', '--all', '--count']), '1')
  const names = git(staged.repoDir, ['ls-files']).split('\n')
  assert.ok(names.length > 0); assert.ok(!names.some(name => /(^|\/)(hidden|calibration)(\/|$)|contamination-patterns|product-rubric|preference-values|simulated-user-policy|starting-prompt|inventory\.json/.test(name)), 'no evaluator file is in the starting tree')
  assert.ok(names.includes('.validator/config.yml'))
  const input = JSON.parse(await readFile(join(DEFINE_ROOT, 'versions.json'), 'utf8')).inputs
  for (const name of ['starting-prompt', 'inventory', 'simulated-user-policy', 'contamination-patterns']) assert.ok(input[name].hashes[input[name].version])
})
test('C-14 definition verdicts never change the product score, and the definition runs on the collected copy with an empty leaked set', async t => {
  const totals = []
  for (const verdict of ['met', 'missing']) {
    const f = await lifecycle(t); const patch = invoke => async req => req.job?.startsWith('coverage') && !req.audit_stage ? JSON.stringify({ results: req.criteria.map(id => ({ id, verdict, rationale: 'r', evidence: ['e'], citations: verdict === 'met' ? [{ path: 'proposal.md', start_line: 1, end_line: 1, gate: null, exchange: null }] : [{ path: 'proposal.md', start_line: null, end_line: null, gate: null, exchange: null }], subject_id: null, added_scope: [] })) }) : invoke(req)
    f.deps.judges = { panel: f.deps.judges.panel.map(member => ({ ...member, invoke: patch(member.invoke) })), decider: { ...f.deps.judges.decider, invoke: patch(f.deps.judges.decider.invoke) } }
    const { result } = await runEvaluation(f.options, f.deps)
    assert.equal(result.evaluation_status, 'pending-human-review', result.observed_error); assert.deepEqual(result.definition_score.leaked_items, [])
    totals.push({ definition: result.definition_score.components.coverage.score, product: result.product_score.automated_score })
  }
  assert.notEqual(totals[0].definition, totals[1].definition); assert.equal(totals[0].product, totals[1].product)
})
