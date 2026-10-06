import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEvaluation } from '../evals/agent-runner/and-scene-define/controller.mjs'
import { LocalSandbox } from '../evals/agent-runner/and-scene-define/lib/sandbox.mjs'
import { repoGit } from '../evals/agent-runner/and-scene-define/lib/starting-repo.mjs'
import { runPhases, AUTOMATED_PHASES } from '../evals/agent-runner/and-scene-define/lib/phases.mjs'
const profiles = { lead: { cli: 'codex', model: 'gpt-6', effort: 'high' }, crosscheck: { cli: 'claude', model: 'opus', effort: 'high' } }
async function fixture(t, outcome = 'interrupted') {
  const root = await mkdtemp(join(tmpdir(), 'define-life-')); t.after(() => rm(root, { recursive: true, force: true }))
  const options = { runDir: join(root, 'run'), profiles, timeLimitMs: 10000, runnerDir: root, skillsDir: root }
  const modes = []; let stopCount = 0; let next = outcome
  const session = join(options.runDir, 'sandbox/.runtime/agent-runner-projects/project/runs/runner-one')
  async function state(kind) {
    await mkdir(session, { recursive: true })
    await writeFile(join(session, 'state.json'), JSON.stringify({ workflowName: 'openspec:change', currentStep: { stepId: 'define', completed: kind === 'capped' }, completed: false }))
    await writeFile(join(session, 'audit.log'), kind === 'failed' ? '2026-10-05T00:00:00Z [define, sub:define-change, design] step_end {"outcome":"failed","error":"CLI failed"}\n' : kind === 'capped' ? '2026-10-05T00:00:00Z [define] step_end {"outcome":"success"}\n2026-10-05T00:00:00Z run_end {"outcome":"success","completed":false}\n' : '2026-10-05T00:00:00Z [define, sub:define-change, specs] step_start {}\n')
    await writeFile(join(session, 'run-metrics.json'), JSON.stringify({ schema_version: 3, run_id: 'runner-one', workflow: 'openspec:change', history_complete: false, steps: [] }))
  }
  class FakeSandbox extends LocalSandbox {
    plan() { return { command: ['fake'], output: 'fake-plan' } }
    async isActive() { return false }
    async start(p, mode) {
      modes.push(mode)
      if (mode.kind === 'fresh') {
        const repo = join(this.artifactDir, 'workspace/repo'); await mkdir(join(repo, '..'), { recursive: true })
        repoGit(this.runDir, ['clone', join(this.inputDir, 'starting-repo.bundle'), repo]); repoGit(repo, ['remote', 'remove', 'origin'])
        const change = join(repo, 'openspec/changes/add-presentation-skill'); await mkdir(change, { recursive: true }); await writeFile(join(change, 'proposal.md'), 'proposal')
      }
      await state(next)
      this.completion = next === 'hanging' ? new Promise(resolve => { this.finish = resolve }) : Promise.resolve({ code: next === 'capped' ? 0 : 1, signal: next === 'interrupted' ? 'SIGTERM' : null })
    }
    async stop() { stopCount++; this.finish?.({ code: null, signal: 'SIGTERM' }) }
  }
  const identity = { seriesIdentity: { version: 1 }, candidate: { profiles, agent_skills_commit: 'skills-one' }, credentials: [] }
  const deps = { sandbox: new FakeSandbox(options), inspect: async () => identity, checkSandboxInputs: async () => {}, respond: async ({ signal }) => new Promise(resolve => { const done = () => resolve({ status: 'stopped' }); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done() }) }
  return { options, deps, modes, identity, state, setNext: value => { next = value }, stopCount: () => stopCount }
}
test('INT-008 interrupted workflow resumes exact Runner ID without a second fresh run', async t => {
  const f = await fixture(t)
  const interrupted = await runEvaluation(f.options, f.deps)
  assert.equal(interrupted.result.evaluation_status, 'definition-workflow-failed'); assert.equal(interrupted.result.resumable, true)
  f.setNext('capped')
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.deepEqual(f.modes, [{ kind: 'fresh' }, { kind: 'resume', runId: 'runner-one' }])
  assert.equal(resumed.result.definition_verdict, 'unavailable'); assert.notEqual(resumed.result.evaluation_status, 'complete')
  assert.equal(resumed.result.owning_phase, 'conversation-reconciliation'); assert.ok(resumed.result.unimplemented_phases.includes('discovery'))
  assert.equal(await readFile(join(f.options.runDir, 'collected/proposal.md'), 'utf8'), 'proposal')
  assert.equal((await runEvaluation({ ...f.options, resume: true }, f.deps)).result.resumable, true)
  assert.equal(f.modes.length, 2)
})
test('INT-008 capped Runner state after a controller crash is collected without resuming', async t => {
  const f = await fixture(t); await runEvaluation(f.options, f.deps); await f.state('capped')
  await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(f.modes.length, 1)
})
test('INT-008 candidate profile and Agent Skills commit mismatches are explicit and do not dispatch', async t => {
  const f = await fixture(t); await runEvaluation(f.options, f.deps)
  f.identity.candidate = { ...f.identity.candidate, agent_skills_commit: 'skills-two' }
  const changed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.match(changed.result.observed_error, /candidate.agent_skills_commit/)
  f.identity.candidate = { ...f.identity.candidate, agent_skills_commit: 'skills-one', profiles: { ...profiles, lead: { ...profiles.lead, model: 'different' } } }
  assert.match((await runEvaluation({ ...f.options, resume: true }, f.deps)).result.observed_error, /candidate.profiles.lead.model/)
  assert.equal(f.modes.length, 1)
})
test('INT-008 failed audit reports the owning step and unavailable verdict', async t => {
  const f = await fixture(t, 'failed'); const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'definition-workflow-failed'); assert.equal(result.last_active_step, 'define.design'); assert.match(result.observed_error, /CLI failed/)
})
test('INT-008 whole-run deadline stops a mid-turn sandbox and persists across resume', async t => {
  const f = await fixture(t, 'hanging'); f.options.timeLimitMs = 30
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(f.stopCount(), 1); assert.equal(result.evaluation_status, 'definition-workflow-failed'); assert.equal(result.last_active_step, 'define.specs'); assert.equal(result.time_limit_ms, 30)
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.match(resumed.result.observed_error, /elapsed-time limit/); assert.equal(f.modes.length, 1)
})
test('later registered phases wait for every predecessor, including on contamination', async () => {
  const called = []
  const handlers = Object.fromEntries(['preflight', 'materialization', 'define-workflow', 'artifact-collection', 'metrics', 'publication'].map(name => [name, () => called.push(name)]))
  const result = await runPhases({ handlers })
  assert.equal(result.blocked, 'conversation-reconciliation'); assert.deepEqual(called, AUTOMATED_PHASES.slice(0, 4))
  handlers['conversation-reconciliation'] = () => {}; handlers['contamination-audit'] = () => { throw new Error('contaminated') }
  await assert.rejects(runPhases({ handlers }), /contaminated/)
  assert.ok(!called.includes('publication'))
})

test('resume rejects altered staged inputs before Runner dispatch', async t => {
  const f = await fixture(t); await runEvaluation(f.options, f.deps)
  await writeFile(join(f.options.runDir, 'sandbox-input/runner-config.yaml'), 'profiles: injected')
  const { result } = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(result.evaluation_status, 'evaluation-harness-failed')
  assert.match(result.observed_error, /pinned sandbox input hash mismatch: runner-config.yaml/)
  assert.equal(f.modes.length, 1)
})
test('collection checkpoint reuses the frozen copy after the worktree changes', async t => {
  const f = await fixture(t, 'capped'); await runEvaluation(f.options, f.deps)
  await writeFile(join(f.options.runDir, 'sandbox/workspace/repo/openspec/changes/add-presentation-skill/proposal.md'), 'changed after collection')
  await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(await readFile(join(f.options.runDir, 'collected/proposal.md'), 'utf8'), 'proposal')
  assert.equal(f.modes.length, 1)
})
test('active sandbox refuses resume and a used directory refuses a fresh invocation', async t => {
  const f = await fixture(t); await runEvaluation(f.options, f.deps)
  assert.match((await runEvaluation(f.options, f.deps)).result.observed_error, /already used/)
  f.deps.sandbox.isActive = async () => true
  const { result } = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.match(result.observed_error, /still active/); assert.equal(f.modes.length, 1)
})
