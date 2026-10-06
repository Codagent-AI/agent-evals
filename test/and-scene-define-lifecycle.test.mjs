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
    await mkdir(join(session, 'external-user'), { recursive: true })
    await mkdir(join(session, 'output'), { recursive: true })
    const native = join(options.runDir, 'sandbox/.runtime/codex/sessions')
    await mkdir(native, { recursive: true })
    await writeFile(join(native, 'rollout-fixture-lead.jsonl'), '{"type":"event_msg","payload":{"type":"task_complete"}}\n')
    await writeFile(join(session, 'output/define_proposal.attempt-1.turn-1.out'), '{"type":"turn.completed"}\n')
    await writeFile(join(session, 'external-user/exchanges.jsonl'), '')
    await writeFile(join(options.runDir, 'conversation.jsonl'), '')
    await writeFile(join(session, 'run-metrics.json'), JSON.stringify({ schema_version: 3, run_id: 'runner-one', workflow: 'openspec:change', history_complete: false, steps: [{ id: 'proposal', prefix: 'define/proposal', cli: 'codex', agent_invoked: true, session_id: 'lead' }] }))
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
  const deps = { handlers: { 'disclosure-audit': async () => { throw Object.assign(new Error('stub disclosure failure'), { resumable: true }) } }, sandbox: new FakeSandbox(options), inspect: async () => identity, checkSandboxInputs: async () => {}, respond: async ({ signal }) => new Promise(resolve => { const done = () => resolve({ status: 'stopped' }); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done() }) }
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
  assert.equal(resumed.result.owning_phase, 'disclosure-audit'); assert.match(resumed.result.observed_error, /stub disclosure failure/)
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

for (const corruption of ['incomplete JSON', 'missing audit file']) {
  test(`Runner state read failure (${corruption}) remains resumable without a duplicate`, async t => {
    const f = await fixture(t)
    const start = f.deps.sandbox.start.bind(f.deps.sandbox)
    const session = join(f.options.runDir, 'sandbox/.runtime/agent-runner-projects/project/runs/runner-one')
    f.deps.sandbox.start = async (...args) => {
      await start(...args)
      if (corruption === 'incomplete JSON') await writeFile(join(session, 'state.json'), '{"incomplete":')
      else await rm(join(session, 'audit.log'))
    }
    const { result } = await runEvaluation(f.options, f.deps)
    assert.equal(result.evaluation_status, 'evaluation-harness-failed')
    assert.equal(result.owning_phase, 'define-workflow')
    assert.equal(result.resumable, true)
    assert.match(result.observed_error, /JSON|ENOENT/)
    await f.state('interrupted')
    f.deps.sandbox.start = start
    f.setNext('capped')
    await runEvaluation({ ...f.options, resume: true }, f.deps)
    assert.deepEqual(f.modes, [{ kind: 'fresh' }, { kind: 'resume', runId: 'runner-one' }])
  })
}
test('recovery eligibility does not relax the Runner workflow identity check', async t => {
  const f = await fixture(t)
  const start = f.deps.sandbox.start.bind(f.deps.sandbox)
  f.deps.sandbox.start = async (...args) => {
    await start(...args)
    await writeFile(join(f.options.runDir, 'sandbox/.runtime/agent-runner-projects/project/runs/runner-one/state.json'), JSON.stringify({ workflowName: 'other-workflow', currentStep: { stepId: 'define' } }))
  }
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.resumable, false)
  assert.match(result.observed_error, /unexpected Agent Runner workflow/)
  assert.deepEqual(f.modes, [{ kind: 'fresh' }])
})

test('contamination checkpoints the audit and prevents gates, judging, and publication on fresh and resumed runs', async t => {
  const f = await fixture(t, 'capped')
  const start = f.deps.sandbox.start.bind(f.deps.sandbox)
  f.deps.sandbox.start = async (...args) => {
    await start(...args)
    await writeFile(join(f.options.runDir, 'sandbox/.runtime/codex/sessions/rollout-fixture-lead.jsonl'), [
      { type: 'response_item', payload: { type: 'web_search_call', id: 'fixture-fetch', action: { query: 'normal' }, results: 'https://github.com/Codagent-AI/and-scene' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ].map(JSON.stringify).join('\n') + '\n')
  }
  const called = []
  f.deps.handlers = Object.fromEntries(['disclosure-audit', 'gates-and-judging', 'discovery', 'result-and-report', 'publication'].map(phase => [phase, async () => { called.push(phase); return [] }]))
  const first = await runEvaluation(f.options, f.deps)
  assert.equal(first.result.evaluation_status, 'contaminated'); assert.equal(first.result.definition_verdict, 'unavailable')
  assert.equal(first.result.score, undefined); assert.deepEqual(called, [])
  assert.ok(first.result.matches.some(m => m.tool_call === 'fixture-fetch'))
  assert.match(first.result.residual_risk, /Docker image is not scanned/)
  const state = JSON.parse(await readFile(join(f.options.runDir, 'run-state.json'), 'utf8'))
  assert.equal(state.phases['contamination-audit'].units.phase.state, 'complete')
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(resumed.result.evaluation_status, 'contaminated'); assert.deepEqual(called, []); assert.equal(f.modes.length, 1)
  assert.deepEqual(resumed.result.matches, first.result.matches)
  // verifyUnit must reject both an altered output and a deleted output before
  // the controller's reusable-audit branch can trust either.
  const auditPath = join(f.options.runDir, 'phases/contamination-audit.json')
  for (const corruption of ['tampered', 'deleted']) {
    if (corruption === 'tampered') await writeFile(auditPath, JSON.stringify({ status: 'clean', matches: [] }))
    else await rm(auditPath)
    const recovered = await runEvaluation({ ...f.options, resume: true }, f.deps)
    assert.equal(recovered.result.evaluation_status, 'contaminated', corruption)
    assert.deepEqual(recovered.result.matches, first.result.matches)
    assert.deepEqual(called, [])
  }
})

test('a missing evaluated transcript produces a harness failure naming the session', async t => {
  const f = await fixture(t, 'capped')
  const start = f.deps.sandbox.start.bind(f.deps.sandbox)
  f.deps.sandbox.start = async (...args) => { await start(...args); await rm(join(f.options.runDir, 'sandbox/.runtime/codex/sessions/rollout-fixture-lead.jsonl')) }
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.owning_phase, 'artifact-collection'); assert.match(result.observed_error, /missing.*codex:lead/)
  assert.equal(result.definition_verdict, 'unavailable'); assert.match(result.residual_risk, /network access/)
})

test('changed retained evidence invalidates reconciliation and audit checkpoints', async t => {
  const f = await fixture(t, 'capped')
  const clean = await runEvaluation(f.options, f.deps)
  assert.equal(clean.result.contamination_audit.status, 'clean')
  const manifest = JSON.parse(await readFile(join(f.options.runDir, 'evidence-manifest.json'), 'utf8'))
  const native = [
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'changed', arguments: '{"cmd":"cat hidden/reference/file"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'changed', output: 'contents' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(JSON.stringify).join('\n') + '\n'
  await writeFile(join(f.options.runDir, 'sandbox/.runtime/codex/sessions/rollout-fixture-lead.jsonl'), native)
  await writeFile(join(f.options.runDir, manifest.invocations[0].transcript), native)
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(resumed.result.evaluation_status, 'contaminated')
  assert.ok(resumed.result.matches.some(match => match.tool_call === 'changed'))
})

import { rescoreEvaluation } from '../evals/agent-runner/and-scene-define/lib/rescore.mjs'
import { loadJudgingInputs } from '../evals/agent-runner/and-scene-define/lib/judging.mjs'
import { buildRubric } from '../evals/agent-runner/and-scene-define/lib/rubric.mjs'
import { parseArguments } from '../evals/agent-runner/and-scene-define/controller.mjs'
function missingJudges(calls) {
  const invoke = async req => {
    calls.push(req.job)
    return JSON.stringify({ results: req.criteria.map(id => req.job === 'discovery' ? { id, asked: false, rationale: 'No question recorded', citations: [] } : { id, verdict: 'missing', rationale: 'Missing from inspected proposal', evidence: ['inspected proposal'], citations: req.job === 'disclosure-audit' || req.job === 'fidelity' ? [] : [{ path: 'proposal.md', start_line: null, end_line: null, gate: null, exchange: null }], subject_id: null, added_scope: [] }) })
  }
  return { panel: [0, 1, 2].map(n => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high', invoke })), decider: { family: 'claude', model: 'stub', effort: 'high', invoke } }
}
const minimalInputs = async args => {
  const data = await loadJudgingInputs(args)
  data.inventory = { ...data.inventory, items: data.inventory.items.filter(x => x.class !== 'preference').slice(0, 2) }
  data.rubric = { ...buildRubric(data.inventory), rubric_version: 999, pass_threshold: 70 }
  return data
}
test('INT-008 host rescore uses only manifest evidence, current evaluator inputs and original provenance', async t => {
  const f = await fixture(t, 'capped'); await runEvaluation(f.options, f.deps)
  const original = JSON.parse(await readFile(join(f.options.runDir, 'result.json'), 'utf8'))
  // Destroy every unmanifested source including result, checkpoint, and sandbox.
  await rm(join(f.options.runDir, 'sandbox'), { recursive: true })
  await rm(join(f.options.runDir, 'run-state.json')); await rm(join(f.options.runDir, 'result.json'))
  const calls = []; const deps = { inspectEvaluator: async () => ({ seriesIdentity: { rubric: 999 } }), judges: missingJudges(calls), loadInputs: minimalInputs, gateCommand: async () => ({ status: 1, stderr: 'invalid definition' }) }
  const options = parseArguments(['--rescore-from', f.options.runDir, '--run-dir', join(f.options.runDir, '../rescore')])
  const originalPath = process.env.PATH
  process.env.PATH = '' // No Docker, Runner, or other executable is available.
  t.after(() => { process.env.PATH = originalPath })
  const { result, exitCode } = await runEvaluation(options, { ...deps, sandbox: { start: () => { throw new Error('rescore must not dispatch') } }, inspect: () => { throw new Error('must not probe Runner') } })
  assert.equal(exitCode, 0); assert.equal(result.evaluation_status, 'complete'); assert.equal(result.definition_verdict, 'fail')
  assert.equal(result.rubric_version, 999); assert.deepEqual(result.series_identity, { rubric: 999 })
  assert.deepEqual(result.original.series_identity, original.series_identity); assert.deepEqual(result.original.candidate, original.candidate)
  assert.deepEqual(result.contamination_audit, original.contamination_audit)
  assert.equal(result.mode, 'rescore'); assert.equal(result.workflow_metrics.history_complete, false)
  assert.ok(calls.includes('discovery')); assert.ok(calls.includes('disclosure-audit')); assert.ok(calls.includes('artifact-quality'))
  await assert.rejects(readFile(join(options.runDir, 'publication.json')), { code: 'ENOENT' })
  await writeFile(join(f.options.runDir, 'collected/proposal.md'), 'tampered')
  await assert.rejects(rescoreEvaluation({ ...options, runDir: join(f.options.runDir, '../tampered-rescore') }, deps), /evidence hash mismatch/)
})
test('INT-008 publication-only resume preserves completed result and never preflights or dispatches', async t => {
  const f = await fixture(t, 'capped'); const calls = []; let failPush = true; let publications = 0
  delete f.deps.handlers
  Object.assign(f.deps, { judges: missingJudges(calls), loadInputs: minimalInputs, gateCommand: async () => ({ status: 1 }), publish: async () => { publications++; if (failPush) throw Object.assign(new Error('rejected push'), { publication: true, resumable: true }) } })
  const completed = await runEvaluation(f.options, f.deps)
  assert.equal(completed.result.evaluation_status, 'complete'); assert.equal(completed.result.definition_verdict, 'fail'); assert.equal(completed.exitCode, 1)
  const saved = await readFile(join(f.options.runDir, 'result.json'), 'utf8'); const count = calls.length
  const state = JSON.parse(await readFile(join(f.options.runDir, 'run-state.json'), 'utf8'))
  assert.equal(state.phases.publication.units.phase.state, 'failed')
  failPush = false
  f.deps.inspect = () => { throw new Error('must not preflight') }; f.deps.sandbox.isActive = () => { throw new Error('must not inspect sandbox') }
  const resumed = await runEvaluation({ runDir: f.options.runDir, resume: true }, f.deps)
  assert.equal(JSON.parse(await readFile(join(f.options.runDir, 'run-state.json'), 'utf8')).phases.publication.units.phase.state, 'complete')
  assert.equal(resumed.exitCode, 0); assert.equal(publications, 2); assert.equal(calls.length, count); assert.equal(f.modes.length, 1)
  assert.equal(await readFile(join(f.options.runDir, 'result.json'), 'utf8'), saved)
})
test('INT-008 contaminated rescore reproduces every match and makes no judge or publication call', async t => {
  const f = await fixture(t, 'capped')
  const start = f.deps.sandbox.start.bind(f.deps.sandbox)
  f.deps.sandbox.start = async (...args) => {
    await start(...args)
    await writeFile(join(f.options.runDir, 'sandbox/.runtime/codex/sessions/rollout-fixture-lead.jsonl'), [
      { type: 'response_item', payload: { type: 'web_search_call', id: 'fixture-fetch', action: { query: 'normal' }, results: 'https://github.com/Codagent-AI/and-scene' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ].map(JSON.stringify).join('\n') + '\n')
  }
  const original = await runEvaluation(f.options, f.deps)
  const rescored = await runEvaluation({ rescoreFrom: f.options.runDir, runDir: join(f.options.runDir, '../contaminated-rescore') }, { inspectEvaluator: async () => ({ seriesIdentity: f.identity.seriesIdentity }), judges: { panel: [], decider: { invoke: () => { throw new Error('must not judge') } } }, publish: () => { throw new Error('must not publish') } })
  assert.equal(rescored.exitCode, 1); assert.equal(rescored.result.evaluation_status, 'contaminated')
  assert.deepEqual(rescored.result.contamination_audit, original.result.contamination_audit)
  assert.ok(rescored.result.residual_risk)
})
