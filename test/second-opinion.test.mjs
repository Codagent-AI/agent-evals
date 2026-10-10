import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { REQUIREMENT_QUESTION_RULE } from '../evals/lib/panel-judging/protocol.mjs'

import { loadRubrics, rubricCriteria } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import {
  SECOND_OPINION_SCHEMA, buildSecondOpinionRequest, outlineFollowUpTargets, runSecondOpinion, secondOpinionTargets,
  describeReplayPolicy, replayPolicy, validReplay,
} from '../evals/agent-runner/and-scene/lib/second-opinion.mjs'

const uphold = { decision: 'uphold', rationale: 'the recorded failure stands', mismeasured_step: null,
  measurement_fault: null, citations: [], log_citations: [], replay: null }

test('second opinions target owner failures and failed gates once, excluding reference baselines', () => {
  const args = { deterministic: [{ id: 'demo-supported-navigation', verdict: 'fail' },
    { id: 'demo-present-mode-behavior', verdict: null }],
  gates: [{ id: 'verification-sample-outline', verdict: 'fail' },
    { id: 'verification-every-produced-step-renders', verdict: 'fail' }] }
  assert.deepEqual(secondOpinionTargets(args), [
    { kind: 'criterion', id: 'demo-supported-navigation' },
    { kind: 'gate', id: 'verification-every-produced-step-renders' },
  ])
  assert.deepEqual(secondOpinionTargets({ ...args, mode: 'reference-baseline' }), [])
  assert.deepEqual(outlineFollowUpTargets({ resolutions: new Map([
    ['demo-nine-step-content-and-order', { result: { verdict: 'fail' } }],
  ]), checked: [] }), [{ kind: 'criterion', id: 'demo-nine-step-content-and-order',
    on_behalf_of: 'verification-sample-outline' }])
})

test('an overturn without source spans is rejected while uphold remains fail', async () => {
  const request = { target: { kind: 'criterion', id: 'demo-supported-navigation' } }
  const accepted = await runSecondOpinion({ request, invoke: async () => JSON.stringify(uphold) })
  assert.equal(accepted.verdict, 'fail')
  const rejected = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...uphold, decision: 'overturn', mismeasured_step: 'swipe', measurement_fault: 'input mismatch',
  }) })
  assert.equal(rejected.decision, 'overturn-rejected')
  assert.equal(rejected.verdict, 'fail')
  const tooMany = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...uphold, decision: 'overturn', mismeasured_step: 'swipe', measurement_fault: 'input mismatch',
    citations: Array.from({ length: 13 }, () => ({ path: 'src/demo.js', start_line: 1, end_line: 1 })),
  }) })
  assert.equal(tooMany.decision, 'overturn-rejected')
})

test('malformed verifier output exhausts retries without silently upholding', async () => {
  let calls = 0
  const outcome = await runSecondOpinion({ request: { target: { kind: 'criterion', id: 'demo-supported-navigation' } },
    attempts: 2, invoke: async () => { calls += 1; return '{broken' } })
  // Two independent verifier samples, two attempts each.
  assert.equal(calls, 4)
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /second-opinion output invalid:/)
  assert.match(outcome.reason, /JSON|Unexpected|property/i)
})

test('malformed verifier and audit shapes retain their validation cause', async () => {
  const malformed = await runSecondOpinion({
    request: { target: { kind: 'criterion', id: 'demo-supported-navigation' } },
    attempts: 1, invoke: async () => JSON.stringify({ ...uphold, rationale: '' }),
  })
  assert.match(malformed.reason, /malformed second-opinion answer/)
  const root = await makeTempDir(join(tmpdir(), 'second-opinion-invalid-audit-'))
  await writeFile(join(root, 'handler.js'), 'handler\n')
  const request = { target: { kind: 'criterion', id: 'demo-supported-navigation' }, browser_derived: false,
    verified_source_paths: ['handler.js'], input_roots: { source: root }, audit_cwd: root,
    failing_record: { verdict: 'fail' } }
  const audit = await runSecondOpinion({ request, attempts: 1,
    invoke: async (call) => JSON.stringify(call.audit_stage ? { results: [] } : {
      ...uphold, decision: 'overturn', mismeasured_step: 'next', measurement_fault: 'missed key',
      citations: [{ path: 'handler.js', start_line: 1, end_line: 1 }],
    }),
  })
  assert.match(audit.reason, /second-opinion audit output invalid: malformed audit/)
})

test('browser replay classification follows the failing evidence source', async () => {
  const rubrics = await loadRubrics()
  const browser = { criteria: [{ id: 'demo-nine-step-content-and-order', verdict: null }],
    probes: [{ id: 'demo-nine-step-content-and-order', result: { verdict: null, outcome: 'not-observed' } }],
    gates: [{ id: 'verification-every-produced-step-renders', verdict: 'fail' },
      { id: 'verification-clear-outcome', verdict: 'fail' }] }
  const judging = { judges: { 'demo-integration': [{ id: 'demo-nine-step-content-and-order',
    verdict: 'fail', rationale: 'missing outline', citations: ['src/demo.js'] }] } }
  const neutral = { sources: ['src/demo.js'] }
  const request = (target) => buildSecondOpinionRequest({ target, rubrics, browser, judging, neutral })
  const fallback = request({ kind: 'criterion', id: 'demo-nine-step-content-and-order',
    on_behalf_of: 'verification-sample-outline' })
  assert.equal(fallback.browser_derived, false)
  assert.equal(fallback.failing_record.verdict, 'fail')
  assert.deepEqual(fallback.failing_record.citations, ['src/demo.js'])
  assert.equal(request({ kind: 'gate', id: 'verification-every-produced-step-renders' }).browser_derived, true)
  assert.equal(request({ kind: 'gate', id: 'verification-clear-outcome' }).browser_derived, false)
})

test('verifier invocation failure retries and keeps its cause when exhausted', async () => {
  let calls = 0
  const outcome = await runSecondOpinion({ request: { target: { kind: 'criterion', id: 'demo-supported-navigation' } },
    attempts: 3, invoke: async () => { calls += 1; throw new Error('judge transport closed') } })
  assert.equal(calls, 6)
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /judge transport closed/)
})

test('audit invocation failure retries and keeps its cause when exhausted', async () => {
  const root = await makeTempDir(join(tmpdir(), 'second-opinion-audit-error-'))
  await writeFile(join(root, 'handler.js'), 'pointer handler\n')
  const request = { target: { kind: 'criterion', id: 'demo-supported-navigation' }, browser_derived: false,
    verified_source_paths: ['handler.js'], input_roots: { source: root }, audit_cwd: root,
    failing_record: { result: { verdict: 'fail' } } }
  const answer = { ...uphold, decision: 'overturn', mismeasured_step: 'swipe',
    measurement_fault: 'touch input mismatch', citations: [{ path: 'handler.js', start_line: 1, end_line: 1 }] }
  let calls = 0
  const outcome = await runSecondOpinion({ request, attempts: 3, invoke: async (call) => {
    calls += 1
    if (call.audit_stage) throw 'audit transport closed'
    return JSON.stringify(answer)
  } })
  // Two verifier samples, then three audit attempts for the first overturn.
  assert.equal(calls, 5)
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /audit transport closed/)
})

test('an audited exact source span can overturn and invalid line ranges cannot', async () => {
  const root = await makeTempDir(join(tmpdir(), 'second-opinion-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/demo.js'), 'pointer handler\n')
  const rubrics = await loadRubrics()
  const neutral = { root, source_root: root, audit_root: root, sources: ['src/demo.js'] }
  const request = buildSecondOpinionRequest({ target: { kind: 'criterion', id: 'demo-supported-navigation' },
    rubrics, browser: { probes: [{ id: 'demo-supported-navigation',
      result: { verdict: 'fail', rationale: 'keyboard 1/0, swipe 0/0, direct jump 4' },
      reading_basis: [{ mode: 'declared' }], failures: [] }] }, neutral, authority: { model: 'test' } })
  const answer = { ...uphold, decision: 'overturn', mismeasured_step: 'swipe',
    measurement_fault: 'touch dispatched but source handles pointer',
    citations: [{ path: 'src/demo.js', start_line: 1, end_line: 1 }],
    replay: { actions: [{ type: 'navigate', path: '/how-to-make-a-presentation' },
      { type: 'swipe', direction: 'left', input: 'pointer' }],
      expect: { type: 'step-index-equals', value: 1 } } }
  assert.match(request.prompt, /Replay allowlist: .*swipe/)
  let calls = 0
  const result = await runSecondOpinion({ request, replay: async () => ({ passed: true, errors: [],
    observations: [{ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 1 }], trace: ['navigated', 'swiped'] }), invoke: async (r) => {
    calls += 1
    if (r.audit_stage) {
      assert.match(r.prompt, /pointer handler/)
      assert.match(r.prompt, /reading_basis/)
      return JSON.stringify({ results: [{ id: 'demo-supported-navigation', classification: 'confirmed',
        rationale: 'source proves the behavior and fault', evidence: ['src/demo.js:1'] }] })
    }
    return JSON.stringify(answer)
  } })
  assert.equal(calls, 2)
  assert.equal(result.verdict, 'pass')
  assert.equal(result.replay.passed, true)
  const invalid = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...answer, citations: [{ path: 'src/demo.js', start_line: 9, end_line: 9 }],
  }) })
  assert.equal(invalid.decision, 'overturn-rejected')
})

test('a confirmed browser overturn requires a passing replay', async () => {
  const root = await makeTempDir(join(tmpdir(), 'second-opinion-replay-'))
  await writeFile(join(root, 'handler.js'), 'pointer handler\n')
  const request = { target: { kind: 'criterion', id: 'demo-supported-navigation' }, browser_derived: true,
    verified_source_paths: ['handler.js'], input_roots: { source: root }, audit_cwd: root,
    failing_record: { verdict: 'fail', rationale: 'keyboard 0/0, swipe 1/0, direct jump 4' } }
  const answer = { ...uphold, decision: 'overturn', mismeasured_step: 'swipe',
    measurement_fault: 'touch mismatch', citations: [{ path: 'handler.js', start_line: 1, end_line: 1 }],
    replay: { actions: [{ type: 'navigate', path: '/how-to-make-a-presentation' }, { type: 'press', key: 'ArrowRight' }],
      expect: { type: 'step-index-equals', value: 1 } } }
  const invoke = async (call) => JSON.stringify(call.audit_stage
    ? { results: [{ id: request.target.id, classification: 'confirmed', rationale: 'confirmed', evidence: ['handler.js:1'] }] }
    : answer)
  const failed = await runSecondOpinion({ request, invoke, replay: async () => ({ passed: false,
    observations: [{ stepIndex: 0 }], trace: ['pressed'] }) })
  assert.equal(failed.decision, 'overturn-rejected')
  assert.equal(failed.replay.passed, false)
  const unavailable = await runSecondOpinion({ request, invoke })
  assert.equal(unavailable.ok, false)
  assert.match(unavailable.reason, /replay/i)
  const missing = await runSecondOpinion({ request, invoke: async (call) => JSON.stringify(call.audit_stage
    ? { results: [{ id: request.target.id, classification: 'confirmed', rationale: 'confirmed', evidence: ['handler.js:1'] }] }
    : { ...answer, replay: null }), replay: async () => ({ passed: true }) })
  assert.equal(missing.decision, 'overturn-rejected')
  const malformed = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...answer, replay: { actions: [{ type: 'script', code: 'window.go(1)' }],
      expect: { type: 'step-index-equals', value: 1 } },
  }), replay: async () => ({ passed: true }) })
  assert.equal(malformed.decision, 'overturn-rejected')
  assert.match(malformed.rejection_reason, /replay/i)
  const arrayReplay = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...answer, replay: [],
  }) })
  assert.equal(arrayReplay.decision, 'overturn-rejected')
  const omitted = await runSecondOpinion({ request, invoke: async (call) => JSON.stringify(call.audit_stage
    ? { results: [{ id: request.target.id, classification: 'confirmed',
      rationale: 'confirmed', evidence: ['handler.js:1'] }] }
    : Object.fromEntries(Object.entries(answer).filter(([key]) => key !== 'replay'))),
  replay: async () => ({ passed: true }) })
  assert.equal(omitted.decision, 'overturn-rejected')
  const gateRequest = { ...request, target: { kind: 'gate', id: 'verification-every-produced-step-renders' } }
  const gate = await runSecondOpinion({ request: gateRequest, invoke: async (call) => JSON.stringify(call.audit_stage
    ? { results: [{ id: gateRequest.target.id, classification: 'confirmed',
      rationale: 'confirmed', evidence: ['handler.js:1'] }] }
    : answer), replay: async () => ({ passed: false, observations: [{ stepIndex: 0 }], trace: [] }) })
  assert.equal(gate.decision, 'overturn-rejected')
})

test('a terminal overturn without recorded log lines is rejected', async () => {
  const root = await makeTempDir(join(tmpdir(), 'terminal-opinion-'))
  await writeFile(join(root, 'package.json'), '{"scripts":{"build":"vite build"}}\n')
  const request = { target: { kind: 'terminal', id: 'verification-build-whole-app' },
    verified_source_paths: ['package.json'], input_roots: { source: root },
    log_root: root, log_artifact: 'build.log' }
  const outcome = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...uphold, decision: 'overturn', mismeasured_step: 'build invocation',
    measurement_fault: 'the wrong script ran',
    citations: [{ path: 'package.json', start_line: 1, end_line: 1 }],
  }) })
  assert.equal(outcome.decision, 'overturn-rejected')
  assert.match(outcome.rejection_reason, /log citation/)
})

test('a contrary runtime error remains in the audit packet and a nonconfirmation rejects overturn', async () => {
  const root = await makeTempDir(join(tmpdir(), 'runtime-opinion-'))
  await writeFile(join(root, 'handler.js'), 'pointer handler\n')
  const request = { target: { kind: 'criterion', id: 'demo-supported-navigation' }, browser_derived: false,
    verified_source_paths: ['handler.js'], input_roots: { source: root }, audit_cwd: root,
    failing_record: { result: { verdict: 'fail' }, runtime_failures: ['TypeError during swipe'] } }
  const answer = { ...uphold, decision: 'overturn', mismeasured_step: 'swipe',
    measurement_fault: 'touch input mismatch',
    citations: [{ path: 'handler.js', start_line: 1, end_line: 1 }] }
  let audited = false
  const outcome = await runSecondOpinion({ request, invoke: async (call) => {
    if (!call.audit_stage) return JSON.stringify(answer)
    audited = true
    assert.match(call.prompt, /TypeError during swipe/)
    return JSON.stringify({ results: [{ id: request.target.id, classification: 'contradicted',
      rationale: 'the runtime error was not explained', evidence: ['recorded page error'] }] })
  } })
  assert.equal(audited, true)
  assert.equal(outcome.decision, 'overturn-rejected')
  assert.equal(outcome.verdict, 'fail')
})

const DEMO_PATH = '/how-to-make-a-presentation'

async function replayRequest(id, rationale, kind = 'criterion') {
  const root = await makeTempDir(join(tmpdir(), 'second-opinion-allowlist-'))
  await writeFile(join(root, 'handler.js'), 'handler\n')
  return { target: { kind, id }, browser_derived: true, verified_source_paths: ['handler.js'],
    input_roots: { source: root }, audit_cwd: root,
    failing_record: kind === 'gate' ? { id, verdict: 'fail', rationale }
      : { id, result: { id, verdict: 'fail', rationale } } }
}

const overturnWith = (replay) => ({ ...uphold, decision: 'overturn', mismeasured_step: 'input',
  measurement_fault: 'probe input mismatch', citations: [{ path: 'handler.js', start_line: 1, end_line: 1 }], replay })

function confirmingInvoke(request, answer, audits = []) {
  return async (call) => {
    if (!call.audit_stage) return JSON.stringify(answer)
    audits.push(call)
    return JSON.stringify({ results: [{ id: request.target.id, classification: 'confirmed',
      rationale: 'confirmed', evidence: ['handler.js:1'] }] })
  }
}

// An auditor that rejects whatever it is shown. A replay outside the
// allowlist is decided by this independent audit, so a stub that confirms
// everything would say nothing about the guard.
function contradictingInvoke(request, answer, audits = []) {
  return async (call) => {
    if (!call.audit_stage) return JSON.stringify(answer)
    audits.push(call)
    return JSON.stringify({ results: [{ id: request.target.id, classification: 'contradicted',
      rationale: 'the replay does not exercise the failing behavior', evidence: ['replay'] }] })
  }
}

const observed = (...states) => states.map((state) => ({ stepCount: 9, mode: 'present', modeBasis: 'declared',
  visible: false, text: '', ...state }))

test('a replay outside the allowlist is decided by the independent audit, never on its own', async () => {
  // Only swipe failed, so only a swipe that moves the step decides alone.
  const request = await replayRequest('demo-supported-navigation', 'keyboard 1/0, swipe 0/0, direct jump 4')
  const replay = async () => ({ passed: true, observations: observed({ stepIndex: null }, { stepIndex: 0 }), trace: [], errors: [] })
  const outside = [
    { actions: [{ type: 'navigate', path: DEMO_PATH }], expect: { type: 'step-index-equals', value: 0 } },
    { actions: [{ type: 'navigate', path: DEMO_PATH }], expect: { type: 'selector-visible', selector: 'body' } },
    { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '#next' }],
      expect: { type: 'step-index-changes' } },
    { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'press', key: 'ArrowRight' }],
      expect: { type: 'step-index-changes' } },
    { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'swipe', direction: 'left', input: 'touch' }],
      expect: { type: 'mode-equals', value: 'present' } },
  ]
  for (const plan of outside) {
    const audits = []
    const outcome = await runSecondOpinion({ request, replay, invoke: contradictingInvoke(request, overturnWith(plan), audits) })
    assert.equal(outcome.decision, 'overturn-rejected', JSON.stringify(plan))
    assert.equal(audits.length, 1, JSON.stringify(plan))
    assert.match(audits[0].prompt, /proposed and the harness ran in a real browser/)
    assert.match(outcome.allowlist_refusal, /allowlist/, JSON.stringify(plan))
    assert.notEqual(outcome.confirmed_by, 'browser-replay')
  }
  const audited = await runSecondOpinion({ request, replay,
    invoke: confirmingInvoke(request, overturnWith(outside[3])) })
  assert.equal(audited.decision, 'overturn')
  assert.equal(audited.confirmed_by, 'audited-browser-replay')

  let replays = 0
  const elsewhere = await runSecondOpinion({ request,
    replay: async () => { replays += 1; return { passed: true, observations: [], trace: [], errors: [] } },
    invoke: confirmingInvoke(request, overturnWith({ actions: [{ type: 'navigate', path: '/elsewhere' },
      { type: 'swipe', direction: 'left', input: 'touch' }], expect: { type: 'step-index-changes' } })) })
  assert.equal(elsewhere.decision, 'overturn-rejected')
  assert.match(elsewhere.rejection_reason, /must navigate/)
  assert.equal(replays, 0, 'a replay off the demo route never reaches the browser')

  // A swipe whose expected index is the index it started from proves nothing
  // alone; it goes to the audit.
  const swipe = [{ type: 'navigate', path: DEMO_PATH }, { type: 'swipe', direction: 'left', input: 'touch' }]
  const stayedAudits = []
  const stayed = await runSecondOpinion({ request,
    invoke: contradictingInvoke(request, overturnWith({ actions: swipe, expect: { type: 'step-index-equals', value: 0 } }), stayedAudits),
    replay: async () => ({ passed: true, errors: [], trace: [],
      observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 0 }) }) })
  assert.equal(stayed.decision, 'overturn-rejected')
  assert.equal(stayedAudits.length, 1)

  const audits = []
  const moved = await runSecondOpinion({ request,
    invoke: confirmingInvoke(request, overturnWith({ actions: swipe, expect: { type: 'step-index-changes' } }), audits),
    replay: async () => ({ passed: true, errors: [], trace: swipe,
      observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 1 }) }) })
  assert.equal(moved.decision, 'overturn')
  assert.equal(moved.verdict, 'pass')
  // The admitted real-browser replay decides; no model audit follows it.
  assert.equal(audits.length, 0)
  assert.equal(moved.confirmed_by, 'browser-replay')
  assert.deepEqual(moved.replay.actions, swipe)
  assert.equal(moved.replay.observations.at(-1).stepIndex, 1)
})

// agent-evals #78 rep 2: a failure shape no allowlist anticipated (a disabled
// Previous button reported as unfocusable) could never be overturned.
test('a failure with no replay allowlist is overturned only when the audit confirms the replay', async () => {
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'press', key: 'ArrowRight' }],
    expect: { type: 'step-index-changes' } }
  for (const [id, rationale] of [
    ['demo-navigation-boundaries-and-control-keys', 'start clamp 0, end clamp 8→8'],
    ['demo-supported-navigation', 'keyboard 0/0, swipe 0/0, direct jump 4'],
    ['demo-focus-and-keyboard-accessibility', 'control Previous step is not keyboard focusable'],
  ]) {
    const request = await replayRequest(id, rationale)
    const replay = async () => ({ passed: true, trace: [], errors: [],
      observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 1 }) })
    const audits = []
    const rejected = await runSecondOpinion({ request, replay, invoke: contradictingInvoke(request, overturnWith(plan), audits) })
    assert.equal(rejected.decision, 'overturn-rejected', id)
    assert.equal(audits.length, 1, id)
    assert.match(rejected.allowlist_refusal, /no replay allowlist/, id)
    const confirmed = await runSecondOpinion({ request, replay, invoke: confirmingInvoke(request, overturnWith(plan)) })
    assert.equal(confirmed.decision, 'overturn', id)
    assert.equal(confirmed.confirmed_by, 'audited-browser-replay', id)
    const failing = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan)),
      replay: async () => ({ passed: false, trace: [], errors: [], observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 0 }) }) })
    assert.equal(failing.decision, 'overturn-rejected', id)
    assert.match(failing.rejection_reason, /did not confirm the passing behavior/, id)
  }
})

test('a title overturn needs the normative title in an element that tracks the active step', async () => {
  const request = await replayRequest('demo-nine-step-content-and-order', 'step 2 title does not match the required outline')
  const title = 'The skill interviews you'
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'press', key: 'ArrowRight' }],
    expect: { type: 'text-present', selector: 'h2', text: title } }
  const persistent = await runSecondOpinion({ request, invoke: contradictingInvoke(request, overturnWith(plan)),
    replay: async () => ({ passed: true, errors: [], trace: [], observations: observed({ stepIndex: null },
      { stepIndex: 0, visible: true, text: title }, { stepIndex: 1, visible: true, text: title }) }) })
  assert.equal(persistent.decision, 'overturn-rejected')
  const wrongText = await runSecondOpinion({ request,
    invoke: contradictingInvoke(request, overturnWith({ ...plan, expect: { ...plan.expect, text: 'interviews' } })),
    replay: async () => ({ passed: true, errors: [], trace: [], observations: [] }) })
  assert.equal(wrongText.decision, 'overturn-rejected')
  assert.match(wrongText.allowlist_refusal, /allowlist/)
  const active = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan)),
    replay: async () => ({ passed: true, errors: [], trace: [], observations: observed({ stepIndex: null },
      { stepIndex: 0, visible: true, text: 'You have a topic' }, { stepIndex: 1, visible: true, text: title }) }) })
  assert.equal(active.decision, 'overturn')
})

test('the renders gate replay must step through every produced step without runtime failures', async () => {
  const request = await replayRequest('verification-every-produced-step-renders',
    '1 runtime or console failure(s) occurred while stepping the demo', 'gate')
  const actions = [{ type: 'navigate', path: DEMO_PATH },
    ...Array.from({ length: 8 }, () => ({ type: 'press', key: 'ArrowRight' }))]
  const plan = { actions, expect: { type: 'step-index-changes' } }
  const every = observed({ stepIndex: null }, ...Array.from({ length: 9 }, (_, stepIndex) => ({ stepIndex })))
  const run = (result) => runSecondOpinion({ request, invoke: contradictingInvoke(request, overturnWith(plan)),
    replay: async () => ({ passed: true, trace: [], ...result }) })
  const erroring = await run({ observations: every, errors: ['TypeError: boom'] })
  assert.equal(erroring.decision, 'overturn-rejected')
  assert.match(erroring.rejection_reason, /runtime or console failure/)
  const unobserved = await run({ observations: every })
  assert.equal(unobserved.decision, 'overturn-rejected')
  const partial = await run({ errors: [], observations: observed({ stepIndex: null }, { stepIndex: 0 },
    ...Array.from({ length: 8 }, () => ({ stepIndex: 1 }))) })
  assert.equal(partial.decision, 'overturn-rejected')
  assert.match(partial.allowlist_refusal, /every produced step/)
  // Runtime failures stay a rejection even when the audit would confirm.
  const confirmedErrors = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan)),
    replay: async () => ({ passed: true, trace: [], observations: every, errors: ['TypeError: boom'] }) })
  assert.equal(confirmedErrors.decision, 'overturn-rejected')
  assert.match(confirmedErrors.rejection_reason, /runtime or console failure/)
  const clean = await run({ observations: every, errors: [] })
  assert.equal(clean.decision, 'overturn')
})

test('replay harness faults stay pending while product evidence rejects', async () => {
  const request = await replayRequest('demo-supported-navigation', 'keyboard 1/0, swipe 1/0, direct jump 0')
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '#step-5' }],
    expect: { type: 'step-index-equals', value: 4 } }
  const invoke = confirmingInvoke(request, overturnWith(plan))
  const crashed = await runSecondOpinion({ request, invoke, replay: async () => {
    throw Object.assign(new Error('browser adapter failed: Chrome crashed'), { resumable: true, owner: 'evaluation-harness' })
  } })
  assert.equal(crashed.ok, false)
  assert.match(crashed.reason, /Chrome crashed/)
  const missing = await runSecondOpinion({ request, invoke })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /replay/)
  const invalid = await runSecondOpinion({ request, invoke, replay: async () => ({ observations: [] }) })
  assert.equal(invalid.ok, false)
  const absent = await runSecondOpinion({ request, invoke, replay: async () => ({ passed: false, errors: [],
    trace: [], product_failure: 'replay click target was not found', observations: observed({ stepIndex: null }, { stepIndex: 0 }) }) })
  assert.equal(absent.ok, true)
  assert.equal(absent.decision, 'overturn-rejected')
  assert.match(absent.rejection_reason, /click target was not found/)
})

test('replay navigation cannot leave the candidate origin through backslashes', () => {
  const expect = { type: 'step-index-changes' }
  assert.equal(validReplay({ actions: [{ type: 'navigate', path: '/\\\\example.com/x' }], expect }), false)
  assert.equal(validReplay({ actions: [{ type: 'navigate', path: '/demo\\x' }], expect }), false)
  assert.equal(validReplay({ actions: [{ type: 'navigate', path: DEMO_PATH }], expect }), true)
})

test('a non-retryable verifier error is not retried', async () => {
  const { runSecondOpinion } = await import('../evals/agent-runner/and-scene/lib/second-opinion.mjs')
  let calls = 0
  const outcome = await runSecondOpinion({
    request: { target: { kind: 'criterion', id: 'x' }, criteria: ['x'] },
    invoke: async () => {
      calls += 1
      throw Object.assign(new Error('invalid_json_schema'), { retryable: false })
    },
  })
  assert.equal(outcome.ok, false)
  // Each verifier sample is tried once and never retried.
  assert.equal(calls, 2)
  assert.match(outcome.reason, /invalid_json_schema/)
})

// Round-3 audit: two verifiers found measurement faults on these criteria but
// could not overturn them because no replay policy covered them.
test('a control-count failure can be overturned by clicking through every step', async () => {
  const request = await replayRequest('quality-captions-and-navigation', 'navigation exposes 11 controls for 9 steps')
  const actions = [{ type: 'navigate', path: DEMO_PATH },
    ...Array.from({ length: 8 }, (_, index) => ({ type: 'click', selector: `[data-step="${index + 2}"]` }))]
  const plan = { actions, expect: { type: 'step-index-changes' } }
  const every = observed({ stepIndex: null }, ...Array.from({ length: 9 }, (_, stepIndex) => ({ stepIndex })))
  const confirmed = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan)),
    replay: async () => ({ passed: true, trace: [], errors: [], observations: every }) })
  assert.equal(confirmed.decision, 'overturn')
  const keyed = await runSecondOpinion({ request,
    invoke: contradictingInvoke(request, overturnWith({ ...plan, actions: [plan.actions[0], { type: 'press', key: 'ArrowRight' }] })),
    replay: async () => ({ passed: true, trace: [], errors: [], observations: every }) })
  assert.equal(keyed.decision, 'overturn-rejected')
  assert.match(keyed.allowlist_refusal, /allowlist/)
})

test('a wrong-current-control failure is overturned only by the active step\'s current control', async () => {
  const request = await replayRequest('demo-control-semantics', 'step 1 marks the wrong control as current')
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '[data-step="2"]' },
    { type: 'click', selector: '[data-step="1"]' }],
    expect: { type: 'text-present', selector: '[aria-current="step"]', text: 'You have a topic' } }
  const run = (observations, candidate = plan, invoke = confirmingInvoke) => runSecondOpinion({ request,
    invoke: invoke(request, overturnWith(candidate)),
    replay: async () => ({ passed: true, trace: [], errors: [], observations }) })
  const tracking = await run(observed({ stepIndex: null },
    { stepIndex: 0, visible: true, text: 'You have a topic' },
    { stepIndex: 1, visible: true, text: 'The skill interviews you' },
    { stepIndex: 0, visible: true, text: 'You have a topic' }))
  assert.equal(tracking.decision, 'overturn')
  const stuck = await run(observed({ stepIndex: null },
    { stepIndex: 0, visible: true, text: 'Previous' }, { stepIndex: 1, visible: true, text: 'Previous' },
    { stepIndex: 0, visible: true, text: 'Previous' }), plan, contradictingInvoke)
  assert.equal(stuck.decision, 'overturn-rejected')
  assert.match(stuck.allowlist_refusal, /control marked current/)
  const unscoped = await run([], { ...plan, expect: { ...plan.expect, selector: 'h2' } }, contradictingInvoke)
  assert.equal(unscoped.decision, 'overturn-rejected')
  assert.match(unscoped.allowlist_refusal, /aria-current/)
})

// A planted false direct-jump fail was upheld because the verifier could not
// name the measurement fault from the record. For a browser-derived failure
// the harness replay in a real browser is the evidence, so the verifier is
// told to propose one whenever the source establishes the behavior.
test('a browser-derived verifier proposes a replay without naming the fault from the record', async () => {
  const rubrics = await loadRubrics()
  const rationale = 'keyboard 1/0, swipe 1/0, direct jump 0'
  const request = buildSecondOpinionRequest({
    target: { kind: 'criterion', id: 'demo-supported-navigation' }, rubrics,
    browser: { criteria: [{ id: 'demo-supported-navigation', verdict: 'fail', rationale }],
      probes: [{ id: 'demo-supported-navigation', result: { verdict: 'fail', rationale } }], gates: [] },
    judging: null, neutral: null, authority: { cli: 'codex', model: 'm' },
  })
  assert.match(request.prompt, /do not need to identify the measurement fault from the record/)
  assert.match(request.prompt, /the harness replay in a real browser decides/)
  assert.doesNotMatch(request.prompt, /^Uphold unless exact candidate-source lines positively establish the whole requirement and explain a specific fault/m)
})

test('the replay observation can explain a browser failure to the span auditor', async () => {
  const { buildSpanAuditRequest } = await import('../evals/agent-runner/and-scene/lib/second-opinion.mjs')
  const audit = buildSpanAuditRequest({ request: { requirement: 'r', criteria: ['demo-supported-navigation'],
    failing_record: {} }, answer: { mismeasured_step: 'direct', measurement_fault: 'suspected input' },
  spans: [], logSpans: [], replay: { plan: {}, observation: { passed: true } } })
  assert.match(audit.prompt, /by that replay observing the passing behavior in a real browser/)
  assert.match(audit.prompt, /the failing measurement itself needs no further explanation/)
})

// A real verifier cited its working-directory path (source/src/...) for a file
// the inventory lists as src/..., and the valid overturn was refused before
// the replay could run.
test('a verifier citation prefixed with the neutral source directory resolves to its inventory path', async () => {
  const root = await makeTempDir(join(tmpdir(), 'second-opinion-prefix-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/nav.ts'), 'export const jump = true\n')
  const request = { target: { kind: 'criterion', id: 'demo-supported-navigation' }, browser_derived: true,
    verified_source_paths: ['src/nav.ts'], input_roots: { source: root }, audit_cwd: root,
    failing_record: { id: 'demo-supported-navigation', result: { verdict: 'fail', rationale: 'keyboard 1/0, swipe 1/0, direct jump 0' } } }
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '[data-step="5"]' }],
    expect: { type: 'step-index-equals', value: 4 } }
  const answer = { ...overturnWith(plan), citations: [{ path: 'source/src/nav.ts', start_line: 1, end_line: 1 }] }
  let replays = 0
  const outcome = await runSecondOpinion({ request, invoke: confirmingInvoke(request, answer),
    replay: async () => { replays += 1; return { passed: true, errors: [], trace: [],
      observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 4 }) } } })
  assert.equal(replays, 1)
  assert.equal(outcome.decision, 'overturn')
  assert.equal(outcome.citations[0].path, 'src/nav.ts')
})

// Round 4: the same planted evidence was overturned in one run and upheld in
// another, because one verifier call decided whether a replay ran at all.
test('two verifier samples run and either admissible replay is tried, the real-browser replay deciding', async () => {
  const request = await replayRequest('demo-supported-navigation', 'keyboard 1/0, swipe 1/0, direct jump 0')
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '[data-step="5"]' }],
    expect: { type: 'step-index-equals', value: 4 } }
  const calls = []
  let replays = 0
  const outcome = await runSecondOpinion({ request,
    invoke: async (call) => {
      calls.push(call)
      if (call.audit_stage) throw new Error('a confirmed browser replay needs no model audit')
      return JSON.stringify(call.verifier_sample === 1 ? uphold : overturnWith(plan))
    },
    replay: async () => { replays += 1; return { passed: true, errors: [], trace: plan.actions,
      observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 4 }) } } })
  assert.deepEqual(calls.map(({ verifier_sample: sample }) => sample).sort(), [1, 2])
  assert.equal(replays, 1)
  assert.equal(outcome.decision, 'overturn')
  assert.equal(outcome.verdict, 'pass')
  assert.equal(outcome.replay.observations.at(-1).stepIndex, 4)
  assert.deepEqual(outcome.samples.map(({ sample, decision }) => [sample, decision]), [[1, 'uphold'], [2, 'overturn']])
})

test('when neither verifier sample proposes an admissible replay the failure stands', async () => {
  const request = await replayRequest('demo-supported-navigation', 'keyboard 1/0, swipe 1/0, direct jump 0')
  let replays = 0
  const outcome = await runSecondOpinion({ request,
    invoke: async () => JSON.stringify(uphold),
    replay: async () => { replays += 1; return { passed: true, observations: [] } } })
  assert.equal(replays, 0)
  assert.equal(outcome.decision, 'uphold')
  assert.equal(outcome.verdict, 'fail')
  assert.equal(outcome.samples.length, 2)
})

test('a second sample\'s replay still runs when the first sample\'s replay does not confirm', async () => {
  const request = await replayRequest('demo-supported-navigation', 'keyboard 1/0, swipe 1/0, direct jump 0')
  const wrong = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '#missing' }],
    expect: { type: 'step-index-equals', value: 4 } }
  const right = { ...wrong, actions: [wrong.actions[0], { type: 'click', selector: '[data-step="5"]' }] }
  const outcome = await runSecondOpinion({ request,
    invoke: async (call) => JSON.stringify(overturnWith(call.verifier_sample === 1 ? wrong : right)),
    replay: async (plan) => (plan.actions[1].selector === '#missing'
      ? { passed: false, observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 0 }), errors: [], trace: [] }
      : { passed: true, observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 4 }), errors: [], trace: [] }) })
  assert.equal(outcome.decision, 'overturn')
  assert.equal(outcome.samples[0].decision, 'overturn-rejected')
  assert.equal(outcome.samples[1].decision, 'overturn')
})

test('the verifier and its audit carry the shared judging scope rule', async () => {
  const rubrics = await loadRubrics()
  const rationale = 'keyboard 1/0, swipe 1/0, direct jump 0'
  const request = buildSecondOpinionRequest({ target: { kind: 'criterion', id: 'demo-supported-navigation' }, rubrics,
    browser: { criteria: [{ id: 'demo-supported-navigation', verdict: 'fail', rationale }],
      probes: [{ id: 'demo-supported-navigation', result: { verdict: 'fail', rationale } }], gates: [] },
    judging: null, neutral: null, authority: { cli: 'codex', model: 'm' } })
  const { buildSpanAuditRequest } = await import('../evals/agent-runner/and-scene/lib/second-opinion.mjs')
  const audit = buildSpanAuditRequest({ request, answer: { mismeasured_step: 's', measurement_fault: 'f' }, spans: [], logSpans: [] })
  for (const prompt of [request.prompt, audit.prompt]) {
    assert.match(prompt, /hypothetical input, file deletion, or rendering the candidate does not produce/)
    assert.ok(prompt.includes(REQUIREMENT_QUESTION_RULE))
  }
})

// Live check on agent-evals #78 rep 2: verifiers told that a failure with no
// preset replay "stands" gave up on a false focus failure instead of
// proposing a replay for the audit.
test('a verifier is invited to propose an audited replay for a failure no allowlist covers', async () => {
  const rubrics = await loadRubrics()
  const rationale = 'control Previous step is not keyboard focusable'
  const request = buildSecondOpinionRequest({ target: { kind: 'criterion', id: 'demo-focus-and-keyboard-accessibility' }, rubrics,
    browser: { criteria: [{ id: 'demo-focus-and-keyboard-accessibility', verdict: 'fail', rationale }],
      probes: [{ id: 'demo-focus-and-keyboard-accessibility', result: { verdict: 'fail', rationale } }], gates: [] },
    judging: null, neutral: null, authority: { cli: 'codex', model: 'm' } })
  assert.doesNotMatch(request.prompt, /failure stands|cannot confirm an overturn|accepts only a replay inside its allowlist/)
  assert.match(request.prompt, /independent auditor decides the overturn from those observations/)
  assert.match(request.prompt, /propose one whenever you overturn/)
  assert.match(request.prompt, /Decide whether the candidate meets the requirement as quoted/)
})

// Live check on agent-evals #78 rep 2: verifiers also cited the probe's
// evidence file as a log, and that one citation discarded correct overturns.
test('an unusable log citation is dropped for a browser failure but a terminal overturn still needs one', async () => {
  const request = await replayRequest('demo-supported-navigation', 'keyboard 1/0, swipe 1/0, direct jump 0')
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '[data-step="5"]' }],
    expect: { type: 'step-index-equals', value: 4 } }
  const answer = { ...overturnWith(plan),
    log_citations: [{ artifact: 'evidence/evaluator/browser-probes/demo-supported-navigation.json', start_line: 1, end_line: 1 }] }
  const outcome = await runSecondOpinion({ request, invoke: confirmingInvoke(request, answer),
    replay: async () => ({ passed: true, errors: [], trace: [],
      observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 4 }) }) })
  assert.equal(outcome.decision, 'overturn')
  assert.deepEqual(outcome.log_citations, [])
  assert.match(outcome.dropped_citations[0].reason, /outside recorded artifact/)

  const terminal = { ...request, target: { kind: 'terminal', id: 'verification-build-whole-app' }, browser_derived: false,
    log_root: request.input_roots.source, log_artifact: 'build.log' }
  const rejected = await runSecondOpinion({ request: terminal, invoke: confirmingInvoke(terminal, answer) })
  assert.equal(rejected.decision, 'overturn-rejected')
  assert.match(rejected.rejection_reason, /outside recorded artifact/)
})

// Input-hygiene probes (eval-validator). A replay may press a key while
// holding modifiers and start a swipe on a selector; strict structured output
// needs both as required, nullable fields.
test('the replay schema carries nullable press modifiers and a nullable swipe start selector', () => {
  const actions = SECOND_OPINION_SCHEMA.properties.replay.anyOf[1].properties.actions.items.anyOf
  const variant = (type) => actions.find(({ properties }) => properties.type.enum[0] === type)
  const press = variant('press')
  assert.deepEqual(press.required.sort(), ['key', 'modifiers', 'type'])
  const modifiers = press.properties.modifiers.anyOf
  assert.ok(modifiers.some(({ type }) => type === 'null'))
  assert.deepEqual(modifiers.find(({ type }) => type === 'array').items.enum, ['Alt', 'Control', 'Meta'])
  const swipe = variant('swipe')
  assert.deepEqual(swipe.required.sort(), ['direction', 'input', 'selector', 'type'])
  assert.deepEqual(swipe.properties.selector.type, ['string', 'null'])
})

test('a replay may press a key holding modifiers and start a swipe on a selector', () => {
  const plan = (...actions) => ({ actions: [{ type: 'navigate', path: DEMO_PATH }, ...actions],
    expect: { type: 'step-index-changes' } })
  for (const action of [
    { type: 'press', key: 'ArrowRight' },
    { type: 'press', key: 'ArrowRight', modifiers: null },
    { type: 'press', key: 'ArrowRight', modifiers: [] },
    { type: 'press', key: 'ArrowRight', modifiers: ['Alt'] },
    { type: 'press', key: 'ArrowLeft', modifiers: ['Control', 'Meta'] },
    { type: 'swipe', direction: 'left', input: 'touch' },
    { type: 'swipe', direction: 'left', input: 'touch', selector: null },
    { type: 'swipe', direction: 'right', input: 'pointer', selector: '[data-mode-toggle]' },
  ]) assert.equal(validReplay(plan(action)), true, JSON.stringify(action))
  for (const action of [
    { type: 'press', key: 'ArrowRight', modifiers: ['Shift'] },
    { type: 'press', key: 'ArrowRight', modifiers: ['alt'] },
    { type: 'press', key: 'ArrowRight', modifiers: ['Alt', 'Alt'] },
    { type: 'press', key: 'ArrowRight', modifiers: 'Alt' },
    { type: 'press', key: 'ArrowRight', modifiers: ['Alt', 'Control', 'Meta', 'Alt'] },
    { type: 'swipe', direction: 'left', input: 'touch', selector: '' },
    { type: 'swipe', direction: 'left', input: 'touch', selector: 7 },
    { type: 'click', selector: '#next', modifiers: ['Alt'] },
  ]) assert.equal(validReplay(plan(action)), false, JSON.stringify(action))
})

const MODIFIER_ID = 'input-modifier-keys-pass-through'
const CONTROL_SWIPE_ID = 'input-swipe-from-control-ignored'

async function inputRequest(id, observations) {
  const request = await replayRequest(id, 'input hygiene failed')
  request.failing_record.result.observations = observations
  return request
}

const modifierPress = (key, modifier, before, after, extra = {}) => ({ key, modifier, step_before: before,
  step_after: after, prevented: false, unloaded: false, ...extra })
const modifierKeys = (...presses) => ({ modifier_keys: { mode: 'present', start_step: 4, presses } })
const ALT_RIGHT_CHANGED = modifierKeys(modifierPress('ArrowRight', 'Alt', 4, 5),
  modifierPress('ArrowLeft', 'Alt', 4, 4), modifierPress('ArrowRight', 'Control', 4, 4))
const right = (modifiers = null) => ({ type: 'press', key: 'ArrowRight', modifiers })

test('a modifier-key step change is overturned by an admitted replay that holds the step', async () => {
  const request = await inputRequest(MODIFIER_ID, ALT_RIGHT_CHANGED)
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, right(), right(), right(['Alt']), right(['Alt'])],
    expect: { type: 'step-index-equals', value: 2 } }
  const audits = []
  const outcome = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan), audits),
    replay: async () => ({ passed: true, errors: [], trace: [],
      observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 2 },
        { stepIndex: 2 }, { stepIndex: 2 }) }) })
  assert.equal(outcome.decision, 'overturn', outcome.rejection_reason ?? outcome.allowlist_refusal)
  assert.equal(outcome.confirmed_by, 'browser-replay')
  assert.equal(audits.length, 0)
})

test('a modifier-key replay outside the admitted entry goes to the audited path', async () => {
  const request = await inputRequest(MODIFIER_ID, ALT_RIGHT_CHANGED)
  const navigate = { type: 'navigate', path: DEMO_PATH }
  const cases = [
    // The recorded failure is Alt+ArrowRight; Control+ArrowRight is another press.
    [[navigate, right(), right(['Control'])], [null, 0, 1, 1], 1],
    // An unmodified press after the modified one can undo what it did.
    [[navigate, right(), right(['Alt']), { type: 'press', key: 'ArrowLeft', modifiers: null }], [null, 0, 1, 2, 1], 1],
    // Never leaving the first step cannot show the press being ignored.
    [[navigate, right(['Alt'])], [null, 0, 0], 0],
    // A step that moved and came back is not a step that held.
    [[navigate, right(), right(['Alt']), { type: 'press', key: 'ArrowLeft', modifiers: ['Alt'] }], [null, 0, 1, 2, 1], 1],
    // Only presses can confirm a modifier-key failure.
    [[navigate, right(), { type: 'click', selector: '#next' }, right(['Alt'])], [null, 0, 1, 2, 2], 2],
    // No modified press at all.
    [[navigate, right(), right()], [null, 0, 1, 2], 2],
  ]
  for (const [actions, steps, value] of cases) {
    const plan = { actions, expect: { type: 'step-index-equals', value } }
    const audits = []
    const outcome = await runSecondOpinion({ request, invoke: contradictingInvoke(request, overturnWith(plan), audits),
      replay: async () => ({ passed: true, errors: [], trace: [],
        observations: observed(...steps.map((stepIndex) => ({ stepIndex }))) }) })
    assert.equal(outcome.decision, 'overturn-rejected', JSON.stringify(actions))
    assert.equal(audits.length, 1, JSON.stringify(actions))
    assert.match(outcome.allowlist_refusal, /allowlist/, JSON.stringify(actions))
    const confirmed = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan)),
      replay: async () => ({ passed: true, errors: [], trace: [],
        observations: observed(...steps.map((stepIndex) => ({ stepIndex }))) }) })
    assert.equal(confirmed.confirmed_by, 'audited-browser-replay', JSON.stringify(actions))
  }
  // No modified press changed the step, so no entry admits a replay.
  // An unloaded press passed through to the browser.
  const unchanged = await inputRequest(MODIFIER_ID, modifierKeys(modifierPress('ArrowRight', 'Alt', 4, 4),
    modifierPress('ArrowLeft', 'Alt', 4, null, { unloaded: true })))
  const audits = []
  const plan = { actions: [navigate, right(), right(['Alt'])], expect: { type: 'step-index-equals', value: 1 } }
  const outcome = await runSecondOpinion({ request: unchanged, invoke: contradictingInvoke(unchanged, overturnWith(plan), audits),
    replay: async () => ({ passed: true, errors: [], trace: [], observations: observed({ stepIndex: null },
      { stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 1 }) }) })
  assert.match(outcome.allowlist_refusal, /no replay allowlist/)
  assert.equal(audits.length, 1)
})

test('a prevented-default modifier failure is rejected before any replay or audit', async () => {
  const prevented = modifierKeys(modifierPress('ArrowLeft', 'Control', 4, 4, { prevented: true }),
    modifierPress('ArrowRight', 'Alt', 4, 4))
  // A step change alongside the prevented default does not open a way in.
  const both = modifierKeys(modifierPress('ArrowRight', 'Alt', 4, 5),
    modifierPress('ArrowLeft', 'Control', 4, 4, { prevented: true }))
  const admitted = { actions: [{ type: 'navigate', path: DEMO_PATH }, right(), right(['Alt'])],
    expect: { type: 'step-index-equals', value: 1 } }
  const audited = { actions: [{ type: 'navigate', path: DEMO_PATH }, right(),
    { type: 'press', key: 'ArrowLeft', modifiers: ['Control'] }], expect: { type: 'step-index-equals', value: 1 } }
  for (const observations of [prevented, both]) {
    const request = await inputRequest(MODIFIER_ID, observations)
    for (const plan of [admitted, audited]) {
      let replays = 0
      const audits = []
      const outcome = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan), audits),
        replay: async () => { replays += 1
          return { passed: true, errors: [], trace: [], observations: observed({ stepIndex: null },
            { stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 1 }) } } })
      assert.equal(outcome.ok, true)
      assert.equal(outcome.decision, 'overturn-rejected')
      assert.equal(outcome.verdict, 'fail')
      assert.match(outcome.rejection_reason, /prevented/)
      assert.equal(replays, 0)
      assert.equal(audits.length, 0)
    }
  }
  // An uphold is still an uphold.
  const request = await inputRequest(MODIFIER_ID, prevented)
  const upheld = await runSecondOpinion({ request, invoke: async () => JSON.stringify(uphold) })
  assert.equal(upheld.decision, 'uphold')
})

const MODE_CONTROL = '[data-presentation-mode-toggle]'
const swipeFromControl = (attempts, direction = 'left') => {
  const failing = attempts.find(({ changed, exempt }) => changed && !exempt)
  return { swipe_from_control: { mode: 'browse', start_step: 4, direction,
    control: { kind: 'mode', name: 'Present', selector: MODE_CONTROL, hook: MODE_CONTROL, activation_target: null },
    controls_discovered: 3, inputs_tried: attempts.map(({ input }) => input), attempts,
    failure: failing ? { input: failing.input, step_before: failing.step_before, step_after: failing.step_after } : null } }
}
const attempt = (input, before, after, exempt = false) => ({ input, step_before: before, step_after: after,
  changed: before !== after, exempt })
const touchFromModeControl = swipeFromControl([attempt('touch', 4, 5)])
const swipeFrom = (selector, input = 'touch', direction = 'left') => ({ type: 'swipe', direction, input, selector })

test('a swipe-from-control failure is overturned by an admitted replay from the recorded control', async () => {
  for (const [observations, input] of [[touchFromModeControl, 'touch'],
    // Touch left the step alone, so the recorded failure is the pointer path.
    [swipeFromControl([attempt('touch', 4, 4), attempt('pointer', 4, 5)]), 'pointer'],
    // Touch reached the control's own activation target, which is exempt.
    [swipeFromControl([attempt('touch', 4, 6, true), attempt('pointer', 4, 5)]), 'pointer']]) {
    const request = await inputRequest(CONTROL_SWIPE_ID, observations)
    const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, right(), right(),
      { type: 'click', selector: '#browse' }, { type: 'wait', ms: 100 }, swipeFrom(MODE_CONTROL, input)],
    expect: { type: 'step-index-equals', value: 2 } }
    const audits = []
    const outcome = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan), audits),
      replay: async () => ({ passed: true, errors: [], trace: [], observations: observed({ stepIndex: null },
        { stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 2 }, { stepIndex: 2, mode: 'browse' },
        { stepIndex: 2, mode: 'browse' }, { stepIndex: 2, mode: 'browse' }) }) })
    assert.equal(outcome.decision, 'overturn', outcome.allowlist_refusal ?? outcome.rejection_reason)
    assert.equal(outcome.confirmed_by, 'browser-replay', input)
    assert.equal(audits.length, 0, input)
  }
})

// The input-hygiene entries are admitted on the same terms as the existing
// ones: an admitted replay skips only the source audit. The overturn still
// needs a valid cited source span, a replay that opens the demo route, and a
// replay that completes with its expected observation and no product failure.
test('an admitted input-hygiene replay still needs a valid span and a clean, passing replay', async () => {
  const navigate = { type: 'navigate', path: DEMO_PATH }
  const admitted = [
    [MODIFIER_ID, ALT_RIGHT_CHANGED, { actions: [navigate, right(), right(['Alt'])],
      expect: { type: 'step-index-equals', value: 1 } }, [null, 0, 1, 1]],
    [CONTROL_SWIPE_ID, swipeFromControl([attempt('touch', 4, 5)]), { actions: [navigate, right(),
      { type: 'click', selector: '#browse' }, swipeFrom(MODE_CONTROL)], expect: { type: 'step-index-equals', value: 1 } },
    [null, 0, 1, 1, 1]],
  ]
  for (const [id, observations, plan, steps] of admitted) {
    const request = await inputRequest(id, observations)
    const states = steps.map((stepIndex) => ({ stepIndex, mode: id === CONTROL_SWIPE_ID && stepIndex !== null ? 'browse' : 'present' }))
    // The baseline: this replay is admitted and decides on its own.
    const accepted = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan)),
      replay: async () => ({ passed: true, errors: [], trace: [], observations: observed(...states) }) })
    assert.equal(accepted.confirmed_by, 'browser-replay', `${id}: ${accepted.allowlist_refusal ?? accepted.rejection_reason}`)

    // No valid cited span: rejected before the replay runs.
    let replays = 0
    const unsupported = await runSecondOpinion({ request,
      invoke: confirmingInvoke(request, { ...overturnWith(plan),
        citations: [{ path: 'handler.js', start_line: 1, end_line: 999 }, { path: 'missing.js', start_line: 1, end_line: 1 }] }),
      replay: async () => { replays += 1; return { passed: true, errors: [], trace: [], observations: observed(...states) } } })
    assert.equal(unsupported.decision, 'overturn-rejected', id)
    assert.match(unsupported.rejection_reason, /invalid source line range|outside verified inventory/, id)
    assert.equal(replays, 0, id)

    // A replay that does not open the demo route is refused without running.
    const elsewhere = { ...plan, actions: [{ type: 'navigate', path: '/' }, ...plan.actions.slice(1)] }
    const offRoute = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(elsewhere)),
      replay: async () => { replays += 1; return { passed: true, errors: [], trace: [], observations: observed(...states) } } })
    assert.equal(offRoute.decision, 'overturn-rejected', id)
    assert.equal(replays, 0, id)

    // A product failure during the replay, or an unmet expectation, rejects it.
    for (const [result, reason] of [
      [{ passed: true, product_failure: 'the page crashed' }, /browser replay failed: the page crashed/],
      [{ passed: false }, /did not confirm the passing behavior/],
    ]) {
      const audits = []
      const outcome = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan), audits),
        replay: async () => ({ errors: [], trace: [], observations: observed(...states), ...result }) })
      assert.equal(outcome.decision, 'overturn-rejected', id)
      assert.match(outcome.rejection_reason, reason, id)
      assert.equal(audits.length, 0, id)
    }
  }
})

test('a swipe-from-control replay outside the admitted entry goes to the audited path', async () => {
  const request = await inputRequest(CONTROL_SWIPE_ID, touchFromModeControl)
  const lead = [{ type: 'navigate', path: DEMO_PATH }, right(), { type: 'click', selector: '#browse' }]
  const leadSteps = [{ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 1, mode: 'browse' }]
  const cases = [
    // The recorded failure was by touch; the same swipe by pointer is another input.
    [[...lead, swipeFrom(MODE_CONTROL, 'pointer')], 1],
    // From the stage rather than the recorded control.
    [[...lead, swipeFrom('[data-presentation-stage]')], 1],
    [[...lead, { type: 'swipe', direction: 'left', input: 'touch', selector: null }], 1],
    // The swipe must be the last input.
    [[...lead, swipeFrom(MODE_CONTROL), { type: 'click', selector: '#browse' }], 1],
    // Two swipes are not one.
    [[...lead, swipeFrom(MODE_CONTROL), swipeFrom(MODE_CONTROL)], 1],
    // The recorded failure swiped left; a right swipe from the same control is another gesture.
    [[...lead, swipeFrom(MODE_CONTROL, 'touch', 'right')], 1],
    // A modified press is not how the mode or step is established.
    [[{ type: 'navigate', path: DEMO_PATH }, right(['Alt']), right(), swipeFrom(MODE_CONTROL)], 1],
  ]
  for (const [actions, value] of cases) {
    const steps = [...leadSteps, ...actions.slice(3).map(() => ({ stepIndex: 1, mode: 'browse' }))]
    const plan = { actions, expect: { type: 'step-index-equals', value } }
    const audits = []
    const outcome = await runSecondOpinion({ request, invoke: contradictingInvoke(request, overturnWith(plan), audits),
      replay: async () => ({ passed: true, errors: [], trace: [], observations: observed(...steps) }) })
    assert.equal(outcome.decision, 'overturn-rejected', JSON.stringify(actions))
    assert.equal(audits.length, 1, JSON.stringify(actions))
    assert.match(outcome.allowlist_refusal, /allowlist/, JSON.stringify(actions))
  }
  // The recorded control was used in browse mode; a swipe in present mode is elsewhere.
  const plan = { actions: [...lead, swipeFrom(MODE_CONTROL)], expect: { type: 'step-index-equals', value: 1 } }
  const audits = []
  const presentMode = await runSecondOpinion({ request, invoke: contradictingInvoke(request, overturnWith(plan), audits),
    replay: async () => ({ passed: true, errors: [], trace: [], observations: observed({ stepIndex: null },
      { stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 1, mode: 'present' }, { stepIndex: 1, mode: 'present' }) }) })
  assert.match(presentMode.allowlist_refusal, /mode/)
  assert.equal(audits.length, 1)
  // A swipe from the first step proves nothing about leaving a step alone.
  const firstStep = { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '#browse' },
    swipeFrom(MODE_CONTROL)], expect: { type: 'step-index-equals', value: 0 } }
  const stayed = await runSecondOpinion({ request, invoke: contradictingInvoke(request, overturnWith(firstStep)),
    replay: async () => ({ passed: true, errors: [], trace: [], observations: observed({ stepIndex: null },
      { stepIndex: 0 }, { stepIndex: 0, mode: 'browse' }, { stepIndex: 0, mode: 'browse' }) }) })
  assert.match(stayed.allowlist_refusal, /allowlist/)
})

test('an admitted swipe-from-control replay must repeat the recorded swipe direction', async () => {
  const lead = [{ type: 'navigate', path: DEMO_PATH }, right(), { type: 'click', selector: '#browse' }]
  const steps = [{ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 1, mode: 'browse' },
    { stepIndex: 1, mode: 'browse' }]
  const recordedRight = swipeFromControl([attempt('touch', 4, 3)], 'right')
  const request = await inputRequest(CONTROL_SWIPE_ID, recordedRight)
  const run = (direction, audits) => runSecondOpinion({ request,
    invoke: (audits ? contradictingInvoke : confirmingInvoke)(request, overturnWith({
      actions: [...lead, swipeFrom(MODE_CONTROL, 'touch', direction)], expect: { type: 'step-index-equals', value: 1 } }), audits),
    replay: async () => ({ passed: true, errors: [], trace: [], observations: observed(...steps) }) })

  const same = await run('right')
  assert.equal(same.confirmed_by, 'browser-replay', same.allowlist_refusal ?? same.rejection_reason)

  const audits = []
  const opposite = await run('left', audits)
  assert.equal(opposite.decision, 'overturn-rejected')
  assert.match(opposite.allowlist_refusal, /recorded right direction/)
  assert.equal(audits.length, 1)

  // A record without a usable direction admits no replay.
  const undirected = structuredClone(recordedRight)
  delete undirected.swipe_from_control.direction
  const policy = replayPolicy({ target: { kind: 'criterion', id: CONTROL_SWIPE_ID },
    failing_record: { result: { observations: undirected } } })
  assert.equal(policy, null)
  assert.match(describeReplayPolicy(replayPolicy({ target: { kind: 'criterion', id: CONTROL_SWIPE_ID },
    failing_record: { result: { observations: recordedRight } } })), /one touch swipe right whose selector/)
})

test('a swipe whose start selector matches nothing is a failed replay, never a pass', async () => {
  const request = await inputRequest(CONTROL_SWIPE_ID, touchFromModeControl)
  const plan = { actions: [{ type: 'navigate', path: DEMO_PATH }, right(), swipeFrom(MODE_CONTROL)],
    expect: { type: 'step-index-equals', value: 1 } }
  const outcome = await runSecondOpinion({ request, invoke: confirmingInvoke(request, overturnWith(plan)),
    replay: async () => ({ passed: false, product_failure: 'replay swipe start target was not found', errors: [],
      trace: [], observations: observed({ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 1 }) }) })
  assert.equal(outcome.decision, 'overturn-rejected')
  assert.match(outcome.rejection_reason, /swipe start target was not found/)
})

test('the verifier is told it may hold modifiers and start a swipe on a selector', async () => {
  const rubrics = await loadRubrics()
  const rationale = 'keyboard 1/0, swipe 1/0, direct jump 0'
  const request = buildSecondOpinionRequest({ target: { kind: 'criterion', id: 'demo-supported-navigation' }, rubrics,
    browser: { criteria: [{ id: 'demo-supported-navigation', verdict: 'fail', rationale }],
      probes: [{ id: 'demo-supported-navigation', result: { verdict: 'fail', rationale } }], gates: [] },
    judging: null, neutral: null, authority: { cli: 'codex', model: 'm' } })
  assert.match(request.prompt, /modifiers/)
  assert.match(request.prompt, /Alt, Control, Meta/)
  assert.match(request.prompt, /swipe[^.]*selector/)
})

test('a verifier is told a prevented-default failure cannot be overturned', async () => {
  const rubrics = await loadRubrics()
  const id = MODIFIER_ID
  const probe = { id, result: { id, verdict: 'fail', rationale: 'Control+ArrowLeft default prevented',
    observations: modifierKeys(modifierPress('ArrowLeft', 'Control', 4, 4, { prevented: true })) } }
  const build = (record) => buildSecondOpinionRequest({ target: { kind: 'criterion', id }, rubrics,
    browser: { criteria: [{ id, verdict: 'fail', rationale: record.result.rationale }], probes: [record], gates: [] },
    judging: null, neutral: null, authority: { cli: 'codex', model: 'm' } })
  assert.match(build(probe).prompt, /rejects any overturn of this failure/)
  const moved = { id, result: { ...probe.result, observations: ALT_RIGHT_CHANGED } }
  const prompt = build(moved).prompt
  assert.doesNotMatch(prompt, /rejects any overturn/)
  assert.match(prompt, /ArrowRight holding Alt/)
})

// INT-002: the second-opinion source-pass audit keeps the base commit's
// contract. The schema is snapshotted here, not imported, so a change to the
// shared panel audit schema cannot silently change what the verifier's
// auditor is asked for or how its answer is read.
const BASE_SOURCE_AUDIT_RESULT_SCHEMA = {
  type: 'object',
  required: ['results'],
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'classification', 'rationale', 'evidence'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          classification: { enum: ['confirmed', 'contradicted', 'insufficient'] },
          rationale: { type: 'string', minLength: 1 },
          evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        },
      },
    },
  },
}

test('a zero-point gate input still gets its second opinion under the unchanged audit contract', async () => {
  const rubrics = await loadRubrics()
  const route = 'demo-route-and-registration'
  const outline = 'demo-nine-step-content-and-order'
  assert.equal(rubricCriteria(rubrics.automated.rubric).find(({ id }) => id === route).criterion_points, 0)

  // A browser fail of a gate input is targeted exactly once, like any
  // deterministic criterion; a fallback-judged fail is checked for the gate.
  assert.deepEqual(secondOpinionTargets({ deterministic: [{ id: route, verdict: 'fail' }],
    gates: [{ id: 'verification-sample-outline', verdict: 'fail' }] }), [{ kind: 'criterion', id: route }])
  assert.deepEqual(outlineFollowUpTargets({ resolutions: new Map([[route, { result: { verdict: 'fail' } }],
    [outline, { result: { verdict: 'fail' } }]]), checked: [{ kind: 'criterion', id: route }] }),
  [{ kind: 'criterion', id: outline, on_behalf_of: 'verification-sample-outline' }])
  const browserRequest = buildSecondOpinionRequest({ target: { kind: 'criterion', id: route }, rubrics,
    browser: { criteria: [{ id: route, verdict: 'fail' }], probes: [{ id: route,
      result: { verdict: 'fail', rationale: 'the demo route is not registered' }, failures: [] }] },
    neutral: { sources: ['src/demo.js'] } })
  assert.equal(browserRequest.browser_derived, true)
  assert.equal(browserRequest.requirement, rubrics.automated.rubric.fallbacks[route].requirement)

  const root = await makeTempDir(join(tmpdir(), 'second-opinion-gate-input-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/demo.js'), 'export const steps = nineRequiredSteps\n')
  const request = buildSecondOpinionRequest({ target: { kind: 'criterion', id: outline,
    on_behalf_of: 'verification-sample-outline' }, rubrics,
  browser: { criteria: [{ id: outline, verdict: null }],
    probes: [{ id: outline, result: { verdict: null, outcome: 'not-observed' } }] },
  judging: { judges: { 'demo-integration': [{ id: outline, verdict: 'fail', rationale: 'eight steps',
    citations: ['src/demo.js'] }] } },
  neutral: { root, source_root: root, audit_root: root, sources: ['src/demo.js'] }, authority: { model: 'test' } })
  assert.equal(request.browser_derived, false)
  assert.match(request.prompt, /on behalf of verification-sample-outline/)
  const answer = { ...uphold, decision: 'overturn', mismeasured_step: 'title read',
    measurement_fault: 'the fallback judge counted the step array before the ninth step was appended',
    citations: [{ path: 'src/demo.js', start_line: 1, end_line: 1 }] }
  // Today's recorded audit response shape: no citations.
  const recorded = (classification) => JSON.stringify({ results: [{ id: outline, classification,
    rationale: 'the source registers all nine steps', evidence: ['src/demo.js:1'] }] })
  const audits = []
  const run = (classification) => runSecondOpinion({ request, invoke: async (call) => {
    if (!call.audit_stage) return JSON.stringify(answer)
    audits.push(call)
    return recorded(classification)
  } })

  const confirmed = await run('confirmed')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].audit_stage, 'source-pass-audit')
  assert.deepEqual(audits[0].schema, BASE_SOURCE_AUDIT_RESULT_SCHEMA)
  assert.equal(JSON.stringify(audits[0].schema).includes('citations'), false)
  assert.deepEqual([confirmed.decision, confirmed.verdict, confirmed.on_behalf_of],
    ['overturn', 'pass', 'verification-sample-outline'])
  assert.deepEqual(confirmed.audit, JSON.parse(recorded('confirmed')).results[0])

  const contradicted = await run('contradicted')
  assert.deepEqual([contradicted.decision, contradicted.verdict, contradicted.rejection_reason],
    ['overturn-rejected', 'fail', 'the source registers all nine steps'])
  assert.deepEqual(audits.at(-1).schema, BASE_SOURCE_AUDIT_RESULT_SCHEMA)
})
