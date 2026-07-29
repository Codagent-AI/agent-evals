import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REFERENCE_REVISION,
  runReferenceBrowserRegression,
} from '../evals/agent-runner/and-scene/lib/reference-browser-regression.mjs'

const canonicalIds = [
  'demo-route-and-registration',
  'demo-nine-step-content-and-order',
  'demo-required-scene-content',
  'demo-evolving-scene-structure',
  'quality-captions-and-navigation',
]

test('the pinned reference regression requires real mode operation and every canonical criterion', async () => {
  const calls = []
  const result = await runReferenceBrowserRegression({
    baseUrl: 'http://127.0.0.1:4173/',
    revision: REFERENCE_REVISION,
    driverFactory: ({ baseUrl }) => ({ baseUrl }),
    evaluate: async ({ driver, revision }) => {
      calls.push({ driver, revision })
      return {
        criteria: canonicalIds.map((id) => ({ id, verdict: 'pass' })),
        probes: canonicalIds.map((id) => ({
          id,
          required_mode: 'browse',
          established_state: { mode: 'browse', position: 0 },
          settled_state: { settled: true },
        })),
      }
    },
  })

  assert.equal(result.passed, true)
  assert.equal(result.revision, REFERENCE_REVISION)
  assert.deepEqual(calls, [{
    driver: { baseUrl: 'http://127.0.0.1:4173/' },
    revision: REFERENCE_REVISION,
  }])
})

test('a programmatic reference regression persists the artifact it cites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reference-browser-regression-'))
  const artifact = join(dir, 'reference-browser.json')
  const result = await runReferenceBrowserRegression({
    baseUrl: 'http://127.0.0.1:4173/',
    revision: REFERENCE_REVISION,
    artifact,
    driverFactory: () => ({}),
    evaluate: async () => ({
      criteria: canonicalIds.map((id) => ({ id, verdict: 'pass' })),
      probes: canonicalIds.map((id) => ({
        id,
        required_mode: 'browse',
        established_state: { mode: 'browse', position: 0 },
        settled_state: { settled: true },
      })),
    }),
  })

  assert.deepEqual(JSON.parse(await readFile(artifact, 'utf8')), result)
})

test('the real-browser regression refuses a different revision or presenter-state caption evidence', async () => {
  await assert.rejects(
    runReferenceBrowserRegression({
      baseUrl: 'http://127.0.0.1:4173/',
      revision: 'not-the-reference',
    }),
    /pinned reference revision/,
  )

  await assert.rejects(
    runReferenceBrowserRegression({
      baseUrl: 'http://127.0.0.1:4173/',
      revision: REFERENCE_REVISION,
      driverFactory: () => ({}),
      evaluate: async () => ({
        criteria: canonicalIds.map((id) => ({ id, verdict: 'pass' })),
        probes: canonicalIds.map((id) => ({
          id,
          required_mode: id === 'quality-captions-and-navigation' ? 'present' : 'browse',
          established_state: { mode: 'present', position: 0 },
          settled_state: { settled: true },
        })),
      }),
    }),
    /browse mode/,
  )
})
