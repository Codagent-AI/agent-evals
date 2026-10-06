import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import {
  buildSecondOpinionRequest, outlineFollowUpTargets, runSecondOpinion, secondOpinionTargets, validReplay,
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
  const root = await mkdtemp(join(tmpdir(), 'second-opinion-invalid-audit-'))
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
  const root = await mkdtemp(join(tmpdir(), 'second-opinion-audit-error-'))
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
  const root = await mkdtemp(join(tmpdir(), 'second-opinion-'))
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
  const root = await mkdtemp(join(tmpdir(), 'second-opinion-replay-'))
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
  const root = await mkdtemp(join(tmpdir(), 'terminal-opinion-'))
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
  const root = await mkdtemp(join(tmpdir(), 'runtime-opinion-'))
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
  const root = await mkdtemp(join(tmpdir(), 'second-opinion-allowlist-'))
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
  const root = await mkdtemp(join(tmpdir(), 'second-opinion-prefix-'))
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
  }
})
