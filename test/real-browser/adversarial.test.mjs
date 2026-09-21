// INT-007. Real Chrome over chrome-devtools-axi, against hand-made pages that no
// corpus candidate resembles. Outside the `test/*.test.mjs` glob on purpose: CI
// has no browser. Run with:
//
//   node --test test/real-browser/adversarial.test.mjs
//
// One at a time, and never while a corpus replay is running: they share Chrome.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAxiBrowserDriver } from '../../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
import { runBrowserEvaluation } from '../../evals/agent-runner/and-scene/lib/browser-eval.mjs'

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
