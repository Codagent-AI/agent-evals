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
// content, present mode, and sample outline checks; everything else conforms.
const FAILING = new Set(['demo-nine-step-content-and-order', 'demo-present-mode-behavior', 'verification-sample-outline'])
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
})
