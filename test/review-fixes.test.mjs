import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('screenshot settle delay rejects invalid values and caps excessive waits', async () => {
  const { parseSettleMs } = await import('../evals/agent-runner/and-scene/capture-policy.mjs')

  assert.equal(parseSettleMs(undefined), 1000)
  assert.equal(parseSettleMs('not-a-number'), 1000)
  assert.equal(parseSettleMs('-1'), 1000)
  assert.equal(parseSettleMs('250'), 250)
  assert.equal(parseSettleMs('60000'), 10000)
})

test('judge manifest excludes candidate-controlled text and frame metadata', async () => {
  const { sanitizeJudgeManifest } = await import('../evals/agent-runner/and-scene/judge-manifest.mjs')
  const manifest = {
    expectedPresentations: 2,
    capturedPresentations: 1,
    expectedScreenshots: 9,
    capturedScreenshots: 8,
    complete: false,
    presentations: [{
      slug: 'candidate-controlled',
      stepTexts: ['very long candidate-controlled page text'],
      frames: [{ path: 'candidate-controlled/step-00.png', bytes: 10, sha256: 'abc' }],
      errors: ['candidate-controlled failure text'],
    }],
  }

  assert.deepEqual(sanitizeJudgeManifest(manifest), {
    expectedPresentations: 2,
    capturedPresentations: 1,
    expectedScreenshots: 9,
    capturedScreenshots: 8,
    complete: false,
    errorCount: 1,
  })
})

test('screenshot capture hashes the Playwright buffer without rereading the PNG', async () => {
  const script = await readFile(join(root, 'evals/agent-runner/and-scene/scene-shots.mjs'), 'utf8')

  assert.ok(script.includes('const bytes = await page.screenshot({ path: screenshotPath })'))
  assert.ok(!script.includes('readFile(screenshotPath)'))
})

// The judge prompt no longer lives in run.sh: the controller owns judging and
// the sanitized-manifest boundary is asserted directly against
// sanitizeJudgeManifest above. Prompt assembly is re-covered by the product
// evaluation task that rebuilds it behind the controller.

test('deterministic scanning bounds directory materialization before sorting', async () => {
  const script = await readFile(
    join(root, 'evals/agent-runner/and-scene/deterministic-checks.mjs'),
    'utf8',
  )

  assert.ok(script.includes("opendir(current)"))
  assert.ok(!script.includes("readdir(current, { withFileTypes: true })"))
})
