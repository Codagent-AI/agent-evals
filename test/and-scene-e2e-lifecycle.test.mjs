import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runEvaluation } from '../evals/agent-runner/and-scene-e2e/controller.mjs'
import { lifecycle } from './and-scene-e2e-lifecycle-helpers.mjs'

test('INT-005 happy path: define, checkpoint, implement, delivery, scoring, trace and the pending result in order', async t => {
  const f = await lifecycle(t)
  const { result, exitCode } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'pending-human-review', JSON.stringify({ e: result.observed_error, p: result.owning_phase }))
  assert.equal(exitCode, 0)
  assert.deepEqual(f.sandbox.starts.map(start => [start.mode.kind, start.until]), [['fresh', 'define'], ['resume', 'implement']])
  assert.equal(f.sandbox.starts[1].mode.runId, 'runner-one')
  const state = await f.read('run-state.json')
  const order = Object.entries(state.phases).flatMap(([phase, value]) => Object.entries(value.units).map(([unit, record]) => [phase, record.completed_at])).sort((a, b) => a[1].localeCompare(b[1]) || 0).map(([phase]) => phase)
  const expected = ['preflight', 'provisioning', 'materialization', 'define-workflow', 'definition-collection', 'reconciliation', 'contamination-pass-1', 'disclosure-audit', 'implement-workflow', 'delivery-verification', 'contamination-pass-2', 'definition-scoring', 'product-evaluation', 'requirement-trace', 'metrics']
  let cursor = -1
  for (const phase of expected) { const index = order.indexOf(phase); assert.ok(index >= 0, `${phase} ran`); assert.ok(index >= cursor, `${phase} out of order: ${order.join(',')}`); cursor = index }
  assert.ok(result.definition_score.total >= 0); assert.equal(result.product_score.automated_score, 70); assert.equal(result.product_score.score, null, 'the human component is still pending')
  assert.ok(!('combined_total' in result)); assert.equal(result.delivery_repository.id, 9001)
  assert.equal(result.contamination_audit.pass_1.status, 'clean'); assert.equal(result.contamination_audit.pass_2.status, 'clean')
  assert.equal(result.requirement_trace.scoring, false)
  assert.match(result.residual_risk, /token that can push to the run's own delivery repository/)
  assert.deepEqual(f.harness.published, [], 'a pending run is not published')
  // The token directory is gone after each invocation.
  await assert.rejects(access(join(f.runDir, '.github-auth')))
})

const without = (f, name) => f.sandbox.starts.every(start => start.until !== name)
const phaseOf = async f => (await f.read('result.json'))

test('INT-005 a settled mandatory leak ends the run before implementation, not resumable, with no score or publication', async t => {
  const f = await lifecycle(t, {}); f.harness.withExchange()
  const target = f.subset.items.find(item => item.class === 'mandatory').id
  f.harness.leak = id => id === `leak:${target}`
  const { result, exitCode } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'evaluation-harness-failed'); assert.equal(result.owning_phase, 'disclosure-audit'); assert.equal(result.resumable, false); assert.equal(exitCode, 1)
  assert.deepEqual(result.leaked_items, [target]); assert.match(result.observed_error, /new run is required/)
  assert.ok(without(f, 'implement'), 'implement never dispatched')
  assert.equal(result.definition_score, null); assert.equal(result.product_score, null); assert.deepEqual(f.harness.published, [])
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.match(resumed.result.observed_error, /cannot be resumed; a new run is required/); assert.equal(f.sandbox.starts.length, 1)
})

test('INT-005 a settled acceptable-alternative leak also ends the run', async t => {
  const f = await lifecycle(t, {}); f.harness.withExchange()
  const target = f.subset.items.find(item => item.class === 'acceptable-alternative').id
  f.harness.leak = id => id === `leak:${target}`
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.owning_phase, 'disclosure-audit'); assert.deepEqual(result.leaked_items, [target]); assert.ok(without(f, 'implement'))
})

test('INT-005 a single-judge flag the decider rejects, and withholding flags, do not fail the run', async t => {
  const f = await lifecycle(t, {}); f.harness.withExchange()
  const target = f.subset.items[0].id
  f.harness.leak = (id, index) => (id === `leak:${target}` && index === 2) || id.startsWith('inconsistent-withholding:')
  f.harness.classification = () => 'contradicted'
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'pending-human-review', result.observed_error)
  assert.deepEqual(result.leaked_items, []); assert.equal(result.disclosure_audit.status, 'flagged'); assert.ok(result.disclosure_audit.flags.some(flag => flag.type === 'inconsistent-withholding'))
})

test('INT-005 a reconciliation mismatch at the checkpoint ends the run before implementation', async t => {
  const f = await lifecycle(t, {}); f.harness.withExchange(); f.harness.exchanges = ''
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'evaluation-harness-failed'); assert.equal(result.owning_phase, 'reconciliation'); assert.match(result.observed_error, /extra reply|Runner exchange/)
  assert.ok(without(f, 'implement'))
})

test('INT-005 first-pass contamination ends the run contaminated, without implementation, scoring or publication', async t => {
  const f = await lifecycle(t, { transcripts: { 'lead-s': '{"type":"response_item","payload":{"type":"function_call","call_id":"c1","name":"shell","arguments":"git clone https://github.com/Codagent-AI/and-scene"}}\n{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n' } })
  const { result, exitCode } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'contaminated'); assert.equal(result.owning_phase, 'contamination-pass-1'); assert.equal(result.resumable, false); assert.equal(exitCode, 1)
  assert.ok(result.matches.some(match => match.pattern === 'fixture-repository' && match.session === 'lead-s'))
  assert.ok(without(f, 'implement')); assert.equal(f.deliveryCalls.length, 0); assert.deepEqual(f.harness.published, [])
  assert.equal(f.judgeCalls.length, 0, 'no disclosure or scoring jobs ran')
  assert.match((await runEvaluation({ ...f.options, resume: true }, f.deps)).result.observed_error, /cannot be resumed/)
})

test('INT-005 an external-user request during implement is refused, never answered, and ends the run', async t => {
  const f = await lifecycle(t, {})
  f.harness.plans.implement.push({ type: 'hang', before: async ({ sandbox }) => { await writeFile(join(sandbox.exchangeDir, 'r.request.json'), JSON.stringify({ step: 'implement.sub.implement', run_id: 'runner-one' })) } })
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'evaluation-harness-failed'); assert.match(result.observed_error, /implement\.sub\.implement step after define completed/)
  const reply = JSON.parse(await readFile(join(f.sandbox.exchangeDir, 'r.reply.json'), 'utf8'))
  assert.equal(reply.action, 'abort'); assert.equal(f.deliveryCalls.length, 0); assert.equal(f.judgeCalls.filter(call => call.job === 'discovery').length, 0)
})

const H = 3600e3
// A hanging invocation whose running time is simulated by moving the injected clock.
const hang = (advanceMs, { during } = {}) => ({ type: 'hang', during: ({ harness }) => setTimeout(() => { harness.clock.t += advanceMs; during?.({ harness }) }, 20) })

test('INT-005 the elapsed limit stops a define invocation as definition-workflow-failed and is not resumable', async t => {
  const f = await lifecycle(t, { limitMs: H })
  f.harness.plans.define.push(hang(2 * H))
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'definition-workflow-failed'); assert.equal(result.resumable, false); assert.equal(result.time_limit_ms, H)
  assert.match(result.observed_error, /elapsed-time limit reached/); assert.equal(f.sandbox.stops >= 1, true)
  assert.equal(result.definition_score, null)
  assert.match((await runEvaluation({ ...f.options, resume: true }, f.deps)).result.observed_error, /cannot be resumed/)
})

test('INT-005 the elapsed limit during implement is implementation-workflow-failed, names the step and limit, and reports the definition score', async t => {
  const f = await lifecycle(t, { limitMs: H })
  f.harness.plans.implement.push(hang(2 * H))
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'implementation-workflow-failed'); assert.equal(result.resumable, false); assert.equal(result.time_limit_ms, H); assert.equal(result.last_active_step, 'implement')
  assert.ok(result.definition_score.total >= 0); assert.equal(result.product_score, null)
  // The trace reports delivery as unavailable for every covered item, and none of the four product outcomes.
  const items = result.requirement_trace.items
  assert.ok(items.length > 0)
  for (const item of items) { assert.equal(item.product_delivery, 'unavailable'); assert.ok(!['delivered', 'partially-delivered', 'defined-not-delivered', 'not-graded-in-product'].includes(item.outcome), item.outcome) }
  assert.deepEqual(f.harness.published, [])
})

test('INT-005 a stall is resumable, keeps its window across resume, and the resumed run continues the same Runner run', async t => {
  const f = await lifecycle(t, { stallMs: 45 * 60e3 })
  f.harness.plans.implement.push(hang(46 * 60e3))
  const first = await runEvaluation(f.options, f.deps)
  assert.equal(first.result.evaluation_status, 'implementation-workflow-failed'); assert.equal(first.result.resumable, true); assert.equal(first.result.stall_window_ms, 45 * 60e3); assert.equal(first.result.last_active_step, 'implement')
  assert.match(first.result.observed_error, /no activity/)
  const changed = await runEvaluation({ ...f.options, resume: true, stallWindowMs: 10 * 60e3 }, f.deps)
  assert.match(changed.result.observed_error, /stall window differs from the recorded 2700000ms/)
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(resumed.result.evaluation_status, 'pending-human-review', resumed.result.observed_error)
  assert.deepEqual(f.sandbox.starts.map(start => [start.mode.kind, start.until, start.mode.runId ?? null]), [['fresh', 'define', null], ['resume', 'implement', 'runner-one'], ['resume', 'implement', 'runner-one']])
})

test('INT-005 downtime between a stall and its resume is not counted: the resumed invocation gets the remaining two hours', async t => {
  const f = await lifecycle(t)
  f.harness.plans.implement.push(hang(10 * H))
  const first = await runEvaluation(f.options, f.deps)
  assert.equal(first.result.resumable, true)
  const state = await f.read('run-state.json'); assert.equal(Math.round(state.active_ms / H), 10)
  f.clock.t += 14 * H
  const deadlines = []
  f.deps.startImplementResponder = ({ signal, deadline }) => { deadlines.push(deadline - Date.now()); return new Promise(resolve => { signal.addEventListener('abort', () => resolve({ status: 'stopped' }), { once: true }) }) }
  f.harness.plans.implement.push({ type: 'capped' })
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(resumed.result.evaluation_status, 'pending-human-review', resumed.result.observed_error)
  assert.ok(Math.abs(deadlines[0] - 2 * H) < 60e3, `remaining ${deadlines[0]}`)
})

test('INT-005 a near-reset Claude limit is waited out of active time, in define and in implement, and resumes with that phase cap', async t => {
  for (const until of ['define', 'implement']) {
    const f = await lifecycle(t)
    f.harness.plans[until].push({ type: 'failed', error: 'You have hit your limit' })
    const waits = []
    f.deps.quota = async ({ audit }) => { waits.push(audit.includes('hit your limit')); if (waits.length > 1) return { waited: false }; f.clock.t += 2 * H; return { waited: true, role: 'implementor', reset_at: new Date(f.clock.t).toISOString(), wait_ms: 2 * H } }
    const { result } = await runEvaluation(f.options, f.deps)
    assert.equal(result.evaluation_status, 'pending-human-review', result.observed_error)
    assert.equal(result.quota_waits.length, 1); assert.equal(result.quota_waits[0].phase, until); assert.equal(result.quota_waits[0].wait_ms, 2 * H)
    const state = await f.read('run-state.json'); assert.ok(state.active_ms < 60e3, `the wait was counted as active time: ${state.active_ms}`)
    const expected = until === 'define' ? [['fresh', 'define'], ['resume', 'define'], ['resume', 'implement']] : [['fresh', 'define'], ['resume', 'implement'], ['resume', 'implement']]
    assert.deepEqual(f.sandbox.starts.map(start => [start.mode.kind, start.until]), expected, until)
    if (until === 'define') assert.equal(f.sandbox.starts.filter(start => start.until === 'implement').length, 1, 'collection and the checkpoint ran before implementation')
  }
})

test('INT-005 a rate limit without a usable reset is an ordinary resumable workflow failure naming the step', async t => {
  const f = await lifecycle(t)
  f.harness.plans.implement.push({ type: 'failed', error: 'HTTP 429 too many requests' })
  f.deps.quota = async () => ({ waited: false })
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'implementation-workflow-failed'); assert.equal(result.resumable, true); assert.equal(result.last_active_step, 'implement'); assert.match(result.observed_error, /CLI failed|429/)
  assert.equal(f.sandbox.starts.length, 2)
})

test('INT-005 interruption during define resumes with --until define, then collects and checkpoints before any implement dispatch', async t => {
  const f = await lifecycle(t)
  const abort = new AbortController(); f.deps.signal = abort.signal
  f.harness.plans.define.push(hang(0, { during: () => abort.abort() }))
  const first = await runEvaluation(f.options, f.deps)
  assert.equal(first.result.evaluation_status, 'definition-workflow-failed'); assert.equal(first.result.resumable, true); assert.match(first.result.observed_error, /interrupted/)
  f.deps.signal = undefined
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(resumed.result.evaluation_status, 'pending-human-review', resumed.result.observed_error)
  assert.deepEqual(f.sandbox.starts.map(start => [start.mode.kind, start.until]), [['fresh', 'define'], ['resume', 'define'], ['resume', 'implement']])
})

test('INT-005 a crash after define completed but before collection resumes without dispatching define again', async t => {
  const f = await lifecycle(t)
  let heads = 0; const original = f.deps.readHead
  f.deps.readHead = async args => { if (heads++ === 0) throw new Error('simulated crash during collection'); return original(args) }
  const first = await runEvaluation(f.options, f.deps)
  assert.equal(first.result.evaluation_status, 'evaluation-harness-failed'); assert.equal(first.result.owning_phase, 'definition-collection')
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(resumed.result.evaluation_status, 'pending-human-review', resumed.result.observed_error)
  assert.deepEqual(f.sandbox.starts.map(start => [start.mode.kind, start.until]), [['fresh', 'define'], ['resume', 'implement']])
})

test('INT-005 resume reuses the recorded delivery repository and provisions no other', async t => {
  const f = await lifecycle(t)
  let provisioned = 0; const original = f.deps.provisionDelivery
  f.deps.provisionDelivery = async args => { provisioned++; return original(args) }
  f.harness.plans.implement.push({ type: 'failed' }); f.deps.quota = async () => ({ waited: false })
  const first = await runEvaluation(f.options, f.deps)
  assert.equal(first.result.resumable, true)
  const resumed = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.equal(resumed.result.evaluation_status, 'pending-human-review', resumed.result.observed_error)
  assert.equal(provisioned, 1); assert.equal(f.harness.reused, undefined, 'a completed provisioning unit is reused, not re-verified or re-created')
  assert.equal(resumed.result.delivery_repository.id, 9001)
})

test('INT-005 a resume with any recorded role profile changed is refused naming the field, with no dispatch', async t => {
  const f = await lifecycle(t)
  f.harness.plans.define.push({ type: 'failed' }); f.deps.quota = async () => ({ waited: false })
  assert.equal((await runEvaluation(f.options, f.deps)).result.resumable, true)
  const dispatched = f.sandbox.starts.length
  const original = await f.deps.inspect()
  for (const role of Object.keys(f.options.profiles)) for (const field of ['cli', 'model', 'effort']) {
    const changed = { ...original, candidate: JSON.parse(JSON.stringify(original.candidate)) }; changed.candidate.profiles[role][field] = 'different'
    const resumed = await runEvaluation({ ...f.options, resume: true }, { ...f.deps, inspect: async () => changed })
    assert.match(resumed.result.observed_error, new RegExp(`candidate\\.profiles\\.${role}\\.${field}`))
  }
  assert.equal(f.sandbox.starts.length, dispatched)
})

test('INT-005 resume refuses an active sandbox and more than one Runner run', async t => {
  const f = await lifecycle(t)
  f.harness.plans.implement.push({ type: 'failed' }); f.deps.quota = async () => ({ waited: false })
  await runEvaluation(f.options, f.deps)
  const active = await runEvaluation({ ...f.options, resume: true }, { ...f.deps, sandbox: Object.assign(f.sandbox, { isActive: async () => true }) })
  assert.match(active.result.observed_error, /still active/)
  f.sandbox.isActive = async () => false
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(f.sandbox.artifactDir, '.runtime/agent-runner-projects/p/runs/runner-two'), { recursive: true })
  await writeFile(join(f.sandbox.artifactDir, '.runtime/agent-runner-projects/p/runs/runner-two/state.json'), JSON.stringify({ workflowName: 'change', currentStep: { stepId: 'define', completed: true } }))
  await writeFile(join(f.sandbox.artifactDir, '.runtime/agent-runner-projects/p/runs/runner-two/audit.log'), '')
  const dup = await runEvaluation({ ...f.options, resume: true }, f.deps)
  assert.match(dup.result.observed_error, /multiple Agent Runner runs/)
})

test('INT-005 a controller interrupted during implement reports a resumable failure naming the step', async t => {
  const f = await lifecycle(t)
  const abort = new AbortController(); f.deps.signal = abort.signal
  f.harness.plans.implement.push(hang(0, { during: () => abort.abort() }))
  const { result } = await runEvaluation(f.options, f.deps)
  assert.equal(result.evaluation_status, 'implementation-workflow-failed'); assert.equal(result.resumable, true); assert.match(result.observed_error, /interrupted/)
})
