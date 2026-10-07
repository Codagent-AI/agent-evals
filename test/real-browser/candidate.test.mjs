// End-to-end check of the production browser evaluator against one real
// candidate: issue #26 repetition 3, the only known candidate with genuine
// browser failures, so one run proves both what must pass and what must fail.
// Outside the `test/*.test.mjs` glob on purpose: CI has no browser, and this is
// run by hand after changing the browser evaluator. Build and serve the
// candidate, then point the test at it:
//
//   git clone https://github.com/Codagent-AI/and-scene.git && cd and-scene
//   git fetch origin refs/pull/23/head && git checkout --detach 6b576c657b0814c6f47352adc78cff2ecb30572d
//   npm ci && npm run build && npx vite preview --port 4799
//   AND_SCENE_CANDIDATE_URL=http://127.0.0.1:4799/ node --test test/real-browser/candidate.test.mjs
//
// Never at the same time as the adversarial pages: they share Chrome.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAxiBrowserDriver } from '../../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
import { runBrowserEvaluation } from '../../evals/agent-runner/and-scene/lib/browser-eval.mjs'

const REVISION = '6b576c657b0814c6f47352adc78cff2ecb30572d'
const baseUrl = process.env.AND_SCENE_CANDIDATE_URL

// The candidate hides every step title from readers, which fails the step
// content, present mode, and sample outline checks. Its keydown handler in
// src/presentation-kit/usePresentationNav.ts ignores modifiers and prevents
// every arrow default, and its swipe handler listens on the whole stage, so
// both input-hygiene probes fail too; everything else conforms.
const FAILING = new Set([
  'demo-nine-step-content-and-order',
  'demo-present-mode-behavior',
  'verification-sample-outline',
  'input-modifier-keys-pass-through',
  'input-swipe-from-control-ignored',
])
const EXPECTED = [
  'demo-route-and-registration',
  'demo-nine-step-content-and-order',
  'demo-required-scene-content',
  'demo-evolving-scene-structure',
  'quality-captions-and-navigation',
  'demo-present-mode-behavior',
  'demo-browse-mode-behavior',
  'demo-mode-position-preservation',
  'demo-supported-navigation',
  'demo-navigation-boundaries-and-control-keys',
  'demo-step-and-transition-reliability',
  'demo-mode-interaction-reliability',
  'demo-control-semantics',
  'demo-focus-and-keyboard-accessibility',
  'verification-sample-outline',
  'verification-every-produced-step-renders',
  'input-modifier-keys-pass-through',
  'input-swipe-from-control-ignored',
]

test('repetition 3 receives exactly its known browser verdicts', { skip: !baseUrl && 'set AND_SCENE_CANDIDATE_URL to a served build of repetition 3', timeout: 900_000 }, async () => {
  const result = await runBrowserEvaluation({
    driver: createAxiBrowserDriver({ baseUrl }),
    revision: REVISION,
    evidenceArtifacts: { probe: (id) => `candidate:${id}`, verification: 'candidate:verification' },
    build: { ok: true, log: 'built before the test' },
    verification: { machine_readable: true, passed: true, artifact: 'fixed verification stub' },
  })
  const entries = new Map([...result.criteria, ...result.gates].map((entry) => [entry.id, entry]))
  const differences = EXPECTED.flatMap((id) => {
    const entry = entries.get(id)
    const expected = FAILING.has(id) ? 'fail' : 'pass'
    return entry?.verdict === expected ? [] : [`${id}: expected ${expected}, got ${entry?.verdict ?? 'not observed'} (${entry?.rationale ?? ''})`]
  })
  assert.deepEqual(differences, [])

  // The first modified press moves the deck, and every modified press has its
  // default prevented.
  const modifier = entries.get('input-modifier-keys-pass-through').observations.modifier_keys
  assert.equal(modifier.mode, 'present')
  assert.deepEqual(modifier.failure,
    { key: 'ArrowRight', modifier: 'Alt', reason: 'step-changed', prevented: true, step_before: 4, step_after: 5 })
  assert.equal(modifier.presses.length, 6)
  assert.ok(modifier.presses.every(({ prevented }) => prevented === true), JSON.stringify(modifier.presses))

  // A touch swipe left starting on the mode control in present mode moves the deck.
  const swipe = entries.get('input-swipe-from-control-ignored').observations.swipe_from_control
  assert.equal(swipe.mode, 'present')
  assert.equal(swipe.direction, 'left')
  assert.equal(swipe.control.kind, 'mode')
  assert.equal(swipe.control.selector, '[data-presentation-mode-toggle]')
  assert.equal(swipe.failure.input, 'touch')
  assert.equal(swipe.failure.step_before, 4)
  assert.equal(swipe.failure.step_after, 5)
})
