// Real Chrome over chrome-devtools-axi, against an input-hygiene deck that
// only does what each variant names, proving the modifier-key and
// swipe-from-control probes end to end. Outside the `test/*.test.mjs` glob on
// purpose: CI has no browser. Run with:
//
//   node --test test/real-browser/input-hygiene.test.mjs
//
// One at a time, and never while another real-browser test is running: they
// share Chrome.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAxiBrowserDriver } from '../../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
import { DETERMINISTIC_BROWSER_CRITERIA, runBrowserEvaluation } from '../../evals/agent-runner/and-scene/lib/browser-eval.mjs'

const MODIFIER_PROBE = 'input-modifier-keys-pass-through'
const SWIPE_PROBE = 'input-swipe-from-control-ignored'

function serve(variant) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve-page.mjs', import.meta.url)), variant],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.once('data', (chunk) => resolve({ baseUrl: String(chunk).trim(), close: () => child.kill() }))
  })
}

// Runs only the input-hygiene probes: every other probe is answered from a
// stand-in checkpoint, so the browser is driven for these two alone.
async function evaluate(variant, probes = [MODIFIER_PROBE, SWIPE_PROBE]) {
  const { baseUrl, close } = await serve(variant)
  try {
    const result = await runBrowserEvaluation({
      driver: createAxiBrowserDriver({ baseUrl }),
      revision: 'b'.repeat(40),
      evidenceArtifacts: { probe: (id) => `input-hygiene:${id}`, verification: 'input-hygiene:verification' },
      build: { ok: true, log: 'static page' },
      verification: { machine_readable: true, passed: true, artifact: 'static page' },
      loadProbe: async ({ id }) => (probes.includes(id) ? null : {
        id, failures: [], result: { id, verdict: 'pass', rationale: 'not under test', evidence: ['skipped'], observed: true },
      }),
    })
    assert.deepEqual(result.criteria.map(({ id }) => id), DETERMINISTIC_BROWSER_CRITERIA)
    return result
  } finally {
    await close()
  }
}

const criterion = (result, id) => result.criteria.find((entry) => entry.id === id)

test('a deck that ignores modified arrows and swipes from its controls passes both probes', { timeout: 600_000 }, async () => {
  const result = await evaluate('input-pass')
  const modifier = criterion(result, MODIFIER_PROBE)
  assert.equal(modifier.verdict, 'pass', modifier.rationale)
  const presses = modifier.observations.modifier_keys.presses
  assert.equal(presses.length, 6)
  assert.ok(presses.every(({ step_before, step_after, prevented, unloaded, keydown_observed }) => (
    step_before === 4 && step_after === 4 && !prevented && !unloaded && keydown_observed)), JSON.stringify(presses))
  const swipe = criterion(result, SWIPE_PROBE)
  assert.equal(swipe.verdict, 'pass', swipe.rationale)
  const observed = swipe.observations.swipe_from_control
  assert.equal(observed.mode, 'present')
  assert.equal(observed.control.kind, 'mode')
  assert.equal(observed.control.selector, '#mode')
  assert.deepEqual(observed.inputs_tried, ['touch', 'pointer'])
})

test('a modified arrow that navigates fails the modifier probe', { timeout: 600_000 }, async () => {
  const entry = criterion(await evaluate('input-modifier-fail', [MODIFIER_PROBE]), MODIFIER_PROBE)
  assert.equal(entry.verdict, 'fail')
  assert.deepEqual(entry.observations.modifier_keys.failure,
    { key: 'ArrowRight', modifier: 'Alt', reason: 'step-changed', prevented: false, step_before: 4, step_after: 5 })
})

test('a prevented default on Control+ArrowLeft fails the modifier probe', { timeout: 600_000 }, async () => {
  const entry = criterion(await evaluate('input-modifier-prevent', [MODIFIER_PROBE]), MODIFIER_PROBE)
  assert.equal(entry.verdict, 'fail')
  assert.deepEqual(entry.observations.modifier_keys.failure,
    { key: 'ArrowLeft', modifier: 'Control', reason: 'prevented-default', prevented: true, step_before: 4, step_after: 4 })
})

test('a prevented default hidden behind stopped propagation still fails the modifier probe', { timeout: 600_000 }, async () => {
  const entry = criterion(await evaluate('input-modifier-stop', [MODIFIER_PROBE]), MODIFIER_PROBE)
  assert.equal(entry.verdict, 'fail')
  assert.deepEqual(entry.observations.modifier_keys.failure,
    { key: 'ArrowRight', modifier: 'Meta', reason: 'prevented-default', prevented: true, step_before: 4, step_after: 4 })
})

test('a modified press that leaves the document passes through and the probe continues', { timeout: 600_000 }, async () => {
  const result = await evaluate('input-modifier-unload', [MODIFIER_PROBE])
  const entry = criterion(result, MODIFIER_PROBE)
  assert.equal(entry.verdict, 'pass', entry.rationale)
  const presses = entry.observations.modifier_keys.presses
  assert.equal(presses.length, 6)
  const left = presses.find(({ modifier, key }) => modifier === 'Alt' && key === 'ArrowLeft')
  assert.equal(left.unloaded, true)
  assert.equal(left.reestablished, true)
  assert.equal(left.step_after, null)
  assert.ok(presses.filter((press) => press !== left).every(({ unloaded, step_before, step_after }) => (
    !unloaded && step_before === 4 && step_after === 4)), JSON.stringify(presses))
  const probe = result.probes.find(({ id }) => id === MODIFIER_PROBE)
  assert.deepEqual(probe.sessions.map(({ established_state: state }) => state.position), [0, 4, 4])
})

test('a deck with no middle step leaves both probes not observed', { timeout: 600_000 }, async () => {
  const result = await evaluate('input-two-steps')
  for (const id of [MODIFIER_PROBE, SWIPE_PROBE]) {
    const entry = criterion(result, id)
    assert.equal(entry.outcome, 'not-observed', id)
    assert.match(entry.rationale, /no step that is neither the first nor the last/, id)
  }
})

test('a touch swipe from the mode control that navigates fails the swipe probe', { timeout: 600_000 }, async () => {
  const entry = criterion(await evaluate('input-swipe-fail', [SWIPE_PROBE]), SWIPE_PROBE)
  assert.equal(entry.verdict, 'fail')
  const observed = entry.observations.swipe_from_control
  assert.equal(observed.control.selector, '#mode')
  assert.equal(observed.mode, 'present')
  assert.deepEqual(observed.failure, { input: 'touch', step_before: 4, step_after: 5 })
})

test('a pointer-only swipe from the mode control that navigates fails on the pointer path', { timeout: 600_000 }, async () => {
  const entry = criterion(await evaluate('input-swipe-pointer', [SWIPE_PROBE]), SWIPE_PROBE)
  assert.equal(entry.verdict, 'fail')
  assert.deepEqual(entry.observations.swipe_from_control.failure, { input: 'pointer', step_before: 4, step_after: 5 })
})

test('controls that stop their own gestures pass the swipe probe', { timeout: 600_000 }, async () => {
  const entry = criterion(await evaluate('input-swipe-stop', [SWIPE_PROBE]), SWIPE_PROBE)
  assert.equal(entry.verdict, 'pass', entry.rationale)
  assert.deepEqual(entry.observations.swipe_from_control.inputs_tried, ['touch', 'pointer'])
})

test('a deck with no interactive control is not observed for the swipe probe', { timeout: 600_000 }, async () => {
  const entry = criterion(await evaluate('input-no-controls', [SWIPE_PROBE]), SWIPE_PROBE)
  assert.equal(entry.outcome, 'not-observed')
  assert.ok(entry.looked_for.includes('[data-presentation-mode-toggle]'), JSON.stringify(entry.looked_for))
  assert.ok(entry.looked_for.includes('accessible step name'), JSON.stringify(entry.looked_for))
})
