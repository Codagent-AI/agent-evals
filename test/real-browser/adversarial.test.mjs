// INT-007. Real Chrome over chrome-devtools-axi, against hand-made pages that no
// real candidate resembles. Outside the `test/*.test.mjs` glob on purpose: CI
// has no browser. Run with:
//
//   node --test test/real-browser/adversarial.test.mjs
//
// One at a time, and never while candidate.test.mjs is running: they share Chrome.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { createAxiBrowserDriver } from '../../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
import { runBrowserEvaluation } from '../../evals/agent-runner/and-scene/lib/browser-eval.mjs'
import { runSecondOpinion } from '../../evals/agent-runner/and-scene/lib/second-opinion.mjs'

function serve(variant) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve-page.mjs', import.meta.url)), variant], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.once('data', (chunk) => resolve({ baseUrl: String(chunk).trim(), close: () => child.kill() }))
  })
}

async function evaluate(variant) {
  const { baseUrl, close } = await serve(variant)
  try {
    return await runBrowserEvaluation({
      driver: createAxiBrowserDriver({ baseUrl }),
      revision: 'a'.repeat(40),
      evidenceArtifacts: { probe: (id) => `adversarial:${id}`, verification: 'adversarial:verification' },
      build: { ok: true, log: 'static page' },
      verification: { machine_readable: true, passed: true, artifact: 'static page' },
    })
  } finally {
    await close()
  }
}

const criterion = (result, id) => result.criteria.find((entry) => entry.id === id)
const KEYS = 'demo-navigation-boundaries-and-control-keys'
const KEYBOARD_ID = 'demo-focus-and-keyboard-accessibility'

const DEMO_PATH = '/how-to-make-a-presentation'
const SOURCE_ROOT = dirname(fileURLToPath(new URL('./pages/presentation.html', import.meta.url)))

function proposing(request, replay) {
  const proposed = { decision: 'overturn', rationale: 'source has navigation handlers',
    mismeasured_step: 'next', measurement_fault: 'probe input mismatch',
    citations: [{ path: 'presentation.html', start_line: 188, end_line: 191 }], log_citations: [], replay }
  return async (call) => JSON.stringify(call.audit_stage
    ? { results: [{ id: request.target.id, classification: 'confirmed',
      rationale: 'cited handler appears to advance', evidence: ['presentation.html:188'] }] }
    : proposed)
}

const replayRequest = (target, failingRecord) => ({ target, browser_derived: true,
  verified_source_paths: ['presentation.html'], input_roots: { source: SOURCE_ROOT }, audit_cwd: SOURCE_ROOT,
  failing_record: failingRecord })

test('(r) source-plausible navigation is not overturned when browser replay stays on the step',
  { timeout: 600_000 }, async () => {
    const { baseUrl, close } = await serve('r')
    try {
      const driver = createAxiBrowserDriver({ baseUrl })
      const request = replayRequest({ kind: 'criterion', id: 'demo-supported-navigation' },
        { verdict: 'fail', rationale: 'keyboard 0/0, swipe 1/0, direct jump 4' })
      const outcome = await runSecondOpinion({ request,
        invoke: proposing(request, { actions: [
          { type: 'navigate', path: DEMO_PATH },
          { type: 'press', key: 'ArrowRight' },
        ], expect: { type: 'step-index-equals', value: 1 } }),
        replay: ({ actions, expect }) => driver.replay(actions, expect),
      })
      assert.equal(outcome.decision, 'overturn-rejected')
      assert.equal(outcome.replay.passed, false)
      assert.equal(outcome.replay.observations.at(-1).stepIndex, 0)
    } finally { await close() }
  })

// Since agent-evals #82 a replay outside the target's allowlist still runs in
// the browser, but it never decides on its own: the independent span audit
// does, from what the harness observed. An auditor that rejects whatever it
// is shown stands in for that audit here.
function contradicting(request, replay, audits) {
  const proposed = proposing(request, replay)
  return async (call) => {
    if (!call.audit_stage) return proposed(call)
    audits.push(call)
    return JSON.stringify({ results: [{ id: request.target.id, classification: 'contradicted',
      rationale: 'the replay does not exercise keyboard navigation', evidence: ['replay'] }] })
  }
}

test('(r) a trivial or wrong-input replay cannot overturn the real keyboard failure',
  { timeout: 600_000 }, async () => {
    const result = await evaluate('r')
    const probe = result.probes.find(({ id }) => id === KEYBOARD_ID)
    assert.equal(probe.result.verdict, 'fail', probe.result.rationale)
    const { baseUrl, close } = await serve('r')
    try {
      const driver = createAxiBrowserDriver({ baseUrl })
      const replay = ({ actions, expect }) => driver.replay(actions, expect)
      const request = replayRequest({ kind: 'criterion', id: KEYBOARD_ID }, probe)
      const outside = [
        // Holding still on the first step is what the broken deck already does.
        { actions: [{ type: 'navigate', path: DEMO_PATH }], expect: { type: 'step-index-equals', value: 0 } },
        { actions: [{ type: 'navigate', path: DEMO_PATH }], expect: { type: 'selector-visible', selector: 'body' } },
        // Keyboard failed. A click or a swipe that does move the deck is a
        // different input and cannot confirm keyboard navigation alone.
        { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'click', selector: '[data-presentation-progress-dot]:nth-child(2)' }],
          expect: { type: 'step-index-changes' } },
        { actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'swipe', direction: 'left', input: 'touch' }],
          expect: { type: 'step-index-changes' } },
      ]
      for (const plan of outside) {
        const audits = []
        const outcome = await runSecondOpinion({ request, replay, invoke: contradicting(request, plan, audits) })
        assert.equal(outcome.decision, 'overturn-rejected', JSON.stringify(plan))
        assert.notEqual(outcome.confirmed_by, 'browser-replay', JSON.stringify(plan))
        // A replay the page passes reaches the audit with the harness's
        // observations, flagged as outside the allowlist; one it fails is
        // rejected without one.
        if (outcome.replay.passed) {
          assert.match(outcome.allowlist_refusal, /allowlist/, JSON.stringify(plan))
          assert.equal(audits.length, 1, JSON.stringify(plan))
          assert.match(audits[0].prompt, /proposed and the harness ran in a real browser/)
        } else {
          assert.equal(audits.length, 0, JSON.stringify(plan))
        }
      }
      // The admitted input reaches the browser, which shows the deck stuck.
      const audits = []
      const pressed = await runSecondOpinion({ request, replay, invoke: contradicting(request, {
        actions: [{ type: 'navigate', path: DEMO_PATH }, { type: 'press', key: 'ArrowRight' }],
        expect: { type: 'step-index-changes' } }, audits) })
      assert.equal(pressed.decision, 'overturn-rejected')
      assert.match(pressed.rejection_reason, /did not confirm the passing behavior/)
      assert.equal(pressed.replay.observations.at(-1).stepIndex, 0)
      assert.equal(audits.length, 0)
    } finally { await close() }
  })

// Variant (a) is a correct deck except for input hygiene: its key handler
// ignores modifiers, so a modified arrow moves it, and a touch swipe that
// starts on one of its controls reaches its root's swipe handler. Admitted
// replays built from the recorded failures reach the browser and are
// rejected there.
test('(a) admitted input-hygiene replays cannot overturn a deck that a modified key or a control swipe moves',
  { timeout: 600_000 }, async () => {
    const result = await evaluate('a')
    const probe = (id) => {
      const record = result.probes.find((entry) => entry.id === id)
      assert.equal(record.result.verdict, 'fail', record.result.rationale)
      return record
    }
    const modifierProbe = probe('input-modifier-keys-pass-through')
    const swipeProbe = probe('input-swipe-from-control-ignored')
    const { failure: pressed } = modifierProbe.result.observations.modifier_keys
    assert.equal(pressed.reason, 'step-changed')
    const { control, mode, failure: swiped } = swipeProbe.result.observations.swipe_from_control
    assert.equal(mode, 'present')
    const { baseUrl, close } = await serve('a')
    try {
      const driver = createAxiBrowserDriver({ baseUrl })
      const replay = ({ actions, expect }) => driver.replay(actions, expect)
      const right = { type: 'press', key: 'ArrowRight', modifiers: null }
      for (const [record, actions] of [
        [modifierProbe, [right, { type: 'press', key: pressed.key, modifiers: [pressed.modifier] }]],
        [swipeProbe, [right, { type: 'swipe', direction: 'left', input: swiped.input, selector: control.selector }]],
      ]) {
        const request = replayRequest({ kind: 'criterion', id: record.id }, record)
        const audits = []
        const outcome = await runSecondOpinion({ request, replay, invoke: contradicting(request, {
          actions: [{ type: 'navigate', path: DEMO_PATH }, ...actions],
          expect: { type: 'step-index-equals', value: 1 } }, audits) })
        assert.equal(outcome.decision, 'overturn-rejected', record.id)
        assert.match(outcome.rejection_reason, /did not confirm the passing behavior/, record.id)
        assert.notEqual(outcome.replay.observations.at(-1).stepIndex, 1, record.id)
        assert.equal(audits.length, 0, record.id)
      }
    } finally { await close() }
  })

test('(u) a renders-gate replay is refused when a step throws, and confirmed when every step renders cleanly',
  { timeout: 600_000 }, async () => {
    const target = { kind: 'gate', id: 'verification-every-produced-step-renders' }
    const plan = { actions: [{ type: 'navigate', path: DEMO_PATH },
      ...Array.from({ length: 8 }, () => ({ type: 'press', key: 'ArrowRight' }))],
    expect: { type: 'step-index-changes' } }
    for (const [variant, decision] of [['u', 'overturn-rejected'], ['a', 'overturn']]) {
      const { baseUrl, close } = await serve(variant)
      try {
        const driver = createAxiBrowserDriver({ baseUrl })
        const request = replayRequest(target, { id: target.id, verdict: 'fail',
          rationale: '1 runtime or console failure(s) occurred while stepping the demo' })
        const outcome = await runSecondOpinion({ request, invoke: proposing(request, plan),
          replay: ({ actions, expect }) => driver.replay(actions, expect) })
        assert.equal(outcome.decision, decision, `${variant}: ${outcome.rejection_reason ?? ''}`)
        if (variant === 'u') {
          assert.match(outcome.rejection_reason, /runtime or console failure/)
          assert.ok(outcome.replay.errors.some((line) => /step 6 failed to render/.test(line)), JSON.stringify(outcome.replay.errors))
        } else {
          assert.deepEqual(outcome.replay.errors, [])
        }
      } finally { await close() }
    }
  })

test('(a) a deck that ignores deck keys while a button holds focus is not deducted', { timeout: 600_000 }, async () => {
  const keys = criterion(await evaluate('a'), KEYS)
  assert.equal(keys.verdict, 'pass', keys.rationale)
  assert.equal(keys.observations.keys_while_control_focused.after, keys.observations.keys_while_control_focused.before)
  assert.equal(Math.abs(keys.observations.keys_after_focus_released.after - keys.observations.keys_after_focus_released.before), 1)
})

test('(b) deck keys that stay dead after any control use are a failure', { timeout: 600_000 }, async () => {
  const keys = criterion(await evaluate('b'), KEYS)
  assert.equal(keys.verdict, 'fail', keys.rationale)
})

test('(c) a correct scene with no recognised hook is not observed, never failed', { timeout: 600_000 }, async () => {
  const result = await evaluate('c')
  for (const id of ['demo-required-scene-content', 'demo-evolving-scene-structure']) {
    assert.equal(criterion(result, id).outcome, 'not-observed', id)
    assert.equal(criterion(result, id).verdict, null, id)
    assert.ok(criterion(result, id).looked_for.includes('[data-layout-id]'), id)
  }
})

test('(d) a step title hidden from readers in present mode is a failure, not "not observed"', { timeout: 600_000 }, async () => {
  const present = criterion(await evaluate('d'), 'demo-present-mode-behavior')
  assert.equal(present.verdict, 'fail', present.rationale)
  assert.notEqual(present.outcome, 'not-observed')
})

test('(e) a deck that listens for keys on its own root is not deducted', { timeout: 600_000 }, async () => {
  const keys = criterion(await evaluate('e'), KEYS)
  assert.equal(keys.verdict, 'pass', keys.rationale)
})

test('(f) a control that cannot release focus is a harness failure, not a verdict', { timeout: 600_000 }, async () => {
  await assert.rejects(evaluate('f'), /could not release focus from the navigation control/)
})

test('(g) a deck whose root has no root hook still has its focus released', { timeout: 600_000 }, async () => {
  const keys = criterion(await evaluate('g'), KEYS)
  assert.equal(keys.verdict, 'pass', keys.rationale)
})

const TITLE_AND_MODE = [
  'demo-nine-step-content-and-order',
  'demo-required-scene-content',
  'demo-present-mode-behavior',
  'demo-mode-position-preservation',
  'demo-mode-interaction-reliability',
  'verification-sample-outline',
]

test('(h) step titles in unhooked header <span> and <strong> elements beside a persistent title list are exposed, not missing', { timeout: 600_000 }, async () => {
  const result = await evaluate('h')
  for (const id of TITLE_AND_MODE) assert.equal(criterion(result, id)?.verdict ?? result.gates.find((gate) => gate.id === id)?.verdict, 'pass', id)
})

test('(i) a deck with only data-mode and a footer present-title paragraph still enters present mode', { timeout: 600_000 }, async () => {
  const result = await evaluate('i')
  for (const id of TITLE_AND_MODE) assert.equal(criterion(result, id)?.verdict ?? result.gates.find((gate) => gate.id === id)?.verdict, 'pass', id)
})

test('(j) a persistent list of every step title does not stand in for a missing active title', { timeout: 600_000 }, async () => {
  const result = await evaluate('j')
  assert.equal(criterion(result, 'demo-nine-step-content-and-order').verdict, 'fail')
  assert.equal(result.gates.find((gate) => gate.id === 'verification-sample-outline').verdict, 'fail')
})

test('(k) a deck with only data-mode and a footer step-marker paragraph still enters present mode', { timeout: 600_000 }, async () => {
  const result = await evaluate('k')
  for (const id of TITLE_AND_MODE) assert.equal(criterion(result, id)?.verdict ?? result.gates.find((gate) => gate.id === id)?.verdict, 'pass', id)
})

test('(l) a footer step-marker paragraph does not stand in for a missing step title', { timeout: 600_000 }, async () => {
  const result = await evaluate('l')
  assert.equal(criterion(result, 'demo-nine-step-content-and-order').verdict, 'fail')
  assert.equal(result.gates.find((gate) => gate.id === 'verification-sample-outline').verdict, 'fail')
})

const NAVIGATION = 'demo-supported-navigation'

test('(m) a deck that commits its touch start only after a frame still swipes', { timeout: 600_000 }, async () => {
  const navigation = criterion(await evaluate('m'), NAVIGATION)
  assert.equal(navigation.verdict, 'pass', navigation.rationale)
  assert.match(navigation.rationale, /swipe 1\/0/)
})

test('(n) a deck with no swipe support is not observed for swipe navigation', { timeout: 600_000 }, async () => {
  const navigation = criterion(await evaluate('n'), NAVIGATION)
  assert.equal(navigation.outcome, 'not-observed', navigation.rationale)
  assert.match(navigation.rationale, /keyboard 1\/0, swipe 0\/0, direct jump 4/)
})

test('(o) a deck that listens for touches on its stage swipes when the finger lands on the stage', { timeout: 600_000 }, async () => {
  const navigation = criterion(await evaluate('o'), NAVIGATION)
  assert.equal(navigation.verdict, 'pass', navigation.rationale)
  assert.match(navigation.rationale, /swipe 1\/0/)
})

test('(p) a declared data-mode establishes mode', { timeout: 600_000 }, async () => {
  const result = await evaluate('p')
  assert.equal(criterion(result, 'demo-present-mode-behavior').verdict, 'pass')
  assert.ok(result.probes.some(({ reading_basis }) => reading_basis?.some(({ mode }) => mode === 'declared')))
})

test('(q) a pointer-only swipe passes after touch leaves the step unchanged', { timeout: 600_000 }, async () => {
  const navigation = criterion(await evaluate('q'), NAVIGATION)
  assert.equal(navigation.verdict, 'pass', navigation.rationale)
  assert.equal(navigation.observations.swipe.touch.left, 0)
  assert.equal(navigation.observations.swipe.pointer.left, 1)
})

test('(r) an undeclared mode inferred from a footer never fails mode or outline', { timeout: 600_000 }, async () => {
  const result = await evaluate('r')
  for (const id of TITLE_AND_MODE) {
    const row = criterion(result, id) ?? result.gates.find((gate) => gate.id === id)
    assert.notEqual(row.verdict, 'fail', id)
  }
})

test('(s) a caption split across nested spans is present by text basis', { timeout: 600_000 }, async () => {
  const result = await evaluate('s')
  assert.notEqual(criterion(result, 'demo-required-scene-content').verdict, 'fail')
  assert.ok(result.probes.some(({ probe_observations }) => probe_observations.some(({ text_presence }) =>
    text_presence && Object.values(text_presence).some(({ visibleElements, complete }) => complete && visibleElements > 0))))
})

test('(t) a hidden labelledby title is present by accessible-name basis', { timeout: 600_000 }, async () => {
  const result = await evaluate('t')
  assert.notEqual(criterion(result, 'demo-present-mode-behavior').verdict, 'fail')
  assert.ok(result.probes.some(({ probe_observations }) => probe_observations.some(({ text_presence }) =>
    text_presence && Object.values(text_presence).some(({ accessibleNames, complete }) => complete && accessibleNames > 0))))
})

// ---- generic replay (the end-to-end suite's browser judges) -----------------------------------------------------------
// Products whose routes, controls and step counts no reference describes; the real replay executor must confirm what a
// person would see and refuse what does not reproduce.
import { executeReplay } from '../../evals/agent-runner/and-scene-e2e/lib/replay.mjs'
import { createBrowserSession, runBrowserJudging } from '../../evals/agent-runner/and-scene-e2e/lib/browser-judging.mjs'

async function genericReplay(variant, replay) {
  const { baseUrl, close } = await serve(variant)
  try { return await executeReplay({ driver: createAxiBrowserDriver({ baseUrl }), replay }) } finally { await close() }
}
const NAV = path => ({ type: 'navigate', path })
test('(g1) a presentation on a route the reference does not use is replayed and its state change is observed', { timeout: 600_000 }, async () => {
  const outcome = await genericReplay('generic-route', { actions: [NAV('/tour'), { type: 'press', key: 'ArrowRight' }], expect: { type: 'rendered-state-changes' } })
  assert.equal(outcome.confirmed, true, outcome.mismatch)
  const nested = await genericReplay('generic-route', { actions: [NAV('/nested/deck'), { type: 'click', text: 'next' }], expect: { type: 'text-present', text: 'Step 2 of 7' } })
  assert.equal(nested.confirmed, true, nested.mismatch)
})
test('(g2) a deck advanced only by an on-screen Next button: the button replay confirms and the keyboard replay does not', { timeout: 600_000 }, async () => {
  const button = await genericReplay('generic-next-button', { actions: [NAV('/'), { type: 'click', text: 'Next' }, { type: 'click', text: 'Next' }], expect: { type: 'text-present', text: 'Step 3 of 7' } })
  assert.equal(button.confirmed, true, button.mismatch)
  const keyboard = await genericReplay('generic-next-button', { actions: [NAV('/'), { type: 'press', key: 'ArrowRight' }], expect: { type: 'rendered-state-changes' } })
  assert.equal(keyboard.confirmed, false); assert.match(keyboard.mismatch, /did not change/)
})
test('(g3) a five-step deck: traversal, saved-label matches and mismatches, and a button that stops at the last step', { timeout: 600_000 }, async () => {
  const forwardAndBack = await genericReplay('generic-five-step', { actions: [NAV('/'), { type: 'click', text: 'Next' }, { type: 'mark', label: 'second' }, { type: 'click', text: 'Next' }, { type: 'click', text: 'Previous' }], expect: { type: 'rendered-state-matches', label: 'second' } })
  assert.equal(forwardAndBack.confirmed, true, forwardAndBack.mismatch)
  const differs = await genericReplay('generic-five-step', { actions: [NAV('/'), { type: 'mark', label: 'first' }, { type: 'click', text: 'Next' }], expect: { type: 'rendered-state-matches', label: 'first' } })
  assert.equal(differs.confirmed, false); assert.match(differs.mismatch, /does not match the one saved as first/)
  const end = await genericReplay('generic-five-step', { actions: [NAV('/'), ...Array.from({ length: 5 }, () => ({ type: 'click', text: 'Next' }))], expect: { type: 'text-present', text: 'Step 5 of 5' } })
  assert.equal(end.confirmed, true, end.mismatch)
  const beyond = await genericReplay('generic-five-step', { actions: [NAV('/'), ...Array.from({ length: 6 }, () => ({ type: 'click', text: 'Next' }))], expect: { type: 'text-present', text: 'Step 6' } })
  assert.equal(beyond.confirmed, false)
})
test('(g4) selector visibility and hiding are judged from the rendered page', { timeout: 600_000 }, async () => {
  const hidden = await genericReplay('generic-route', { actions: [NAV('/tour'), { type: 'click', text: 'Toggle note' }], expect: { type: 'selector-hidden', selector: '#note' } })
  assert.equal(hidden.confirmed, true, hidden.mismatch)
  const stillVisible = await genericReplay('generic-route', { actions: [NAV('/tour'), { type: 'click', text: 'Next' }], expect: { type: 'selector-hidden', selector: '#note' } })
  assert.equal(stillVisible.confirmed, false)
  const visible = await genericReplay('generic-route', { actions: [NAV('/tour')], expect: { type: 'selector-visible', selector: '#note' } })
  assert.equal(visible.confirmed, true, visible.mismatch)
  const missingTarget = await genericReplay('generic-route', { actions: [NAV('/tour'), { type: 'click', text: 'No such control' }], expect: { type: 'rendered-state-changes' } })
  assert.equal(missingTarget.confirmed, false); assert.match(missingTarget.mismatch, /click target was not found/)
})
test('(g5) a pass whose replay does not reproduce on the real page counts as failed through browser judging', { timeout: 600_000 }, async () => {
  const { baseUrl, close } = await serve('generic-five-step')
  try {
    const vote = id => ({ id, verdict: 'pass', rationale: 'it works', evidence: ['saw it'], replay: { actions: [{ type: 'navigate', path: '/' }, { type: 'click', text: 'Next' }], expect: { type: 'text-present', text: 'Step 9 of 9' } } })
    const invoke = async request => JSON.stringify({ results: request.criteria.map(vote) })
    const panel = [{ family: 'claude', model: 'a', effort: 'h' }, { family: 'claude', model: 'b', effort: 'h' }, { family: 'codex', model: 'c', effort: 'h' }]
    const session = createBrowserSession(async () => createAxiBrowserDriver({ baseUrl }))
    const result = await runBrowserJudging({ rubric: { criterion_sources: { A: { owner: 'eval', reason: 'works' } }, gates: [] }, inventory: { items: [] }, url: baseUrl, panel, decider: { family: 'claude', model: 'd', effort: 'h' }, invoke, session, jobs: [{ id: 'j', criteria: ['A'] }] })
    assert.equal(result.verdicts.A.verdict, 'fail'); assert.equal(result.verdicts.A.basis, 'replay-mismatch'); assert.match(result.verdicts.A.mismatch, /was not present/)
  } finally { await close() }
})
