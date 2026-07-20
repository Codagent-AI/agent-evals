import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { runDeterministicChecks } from '../evals/agent-runner/and-scene/deterministic-checks.mjs'

// The static candidate scan no longer produces criterion verdicts. It produces
// deterministic source evidence that the product judges cite, plus the source
// half of the canonical-sample hard gate.
async function writeCandidate(rootDir, overrides = {}) {
  const files = {
    'src/presentations/how-to-make-a-presentation/steps.tsx': [
      'You have a topic', 'The skill interviews you', 'Answers become steps',
      'The deck grows', 'You set the depth', 'It assembles the scene',
      'It checks its own work', 'Changed your mind? Loop it.', "You're looking at one",
    ].join('\n'),
    'src/presentation-kit/Attribution.tsx': 'made by and-scene https://github.com/Codagent-AI/and-scene',
    'src/presentation-kit/Toc.tsx': 'aria-current data-active',
    'scripts/verify.mjs': 'http://127.0.0.1:4319 data-step-count data-step-index',
    'scripts/screenshot.mjs': [
      'playwright screenshot data-allow-overlap overlap warning',
      'getComputedStyle active inactive aria-current warning',
      'made by and-scene missing attribution fontSize textDecoration warning',
    ].join('\n'),
    ...overrides,
  }
  for (const [path, contents] of Object.entries(files)) {
    const target = join(rootDir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
}

test('deterministic evaluator passes a contract-complete candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'and-scene-deterministic-'))
  await writeCandidate(dir)
  const results = await runDeterministicChecks(dir)
  assert.ok(results.length >= 7)
  assert.deepEqual([...new Set(results.map(({ verdict }) => verdict))], ['pass'])
})

test('every source-evidence id addresses a scored criterion or a hard gate', async () => {
  const { loadRubrics, rubricCriteria } = await import('../evals/agent-runner/and-scene/lib/rubric.mjs')
  const { automated } = await loadRubrics()
  const addressable = new Set([
    ...rubricCriteria(automated.rubric).map(({ id }) => id),
    ...automated.rubric.gates.map(({ id }) => id),
  ])
  const dir = await mkdtemp(join(tmpdir(), 'and-scene-source-evidence-ids-'))
  await writeCandidate(dir)

  const results = await runDeterministicChecks(dir)

  assert.ok(results.length > 0)
  for (const { id } of results) assert.ok(addressable.has(id), id)
})

test('deterministic evaluator fails safely when candidate text exceeds its scan budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'and-scene-deterministic-budget-'))
  await writeCandidate(dir, {
    'src/presentations/oversized.md': 'x'.repeat(600 * 1024),
  })

  const results = await runDeterministicChecks(dir)

  assert.ok(results.every(({ verdict }) => verdict === 'fail'))
  assert.ok(results.every(({ note }) => note.includes('scan budget exceeded')))
})

test('deterministic evaluator accepts the project-local helper in the scaffold template', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'and-scene-template-helper-'))
  await writeCandidate(dir)
  const rootHelper = join(dir, 'scripts/screenshot.mjs')
  const templateHelper = join(dir, 'skills/presentation/templates/bootstrap/scripts/inspect-presentation.mjs')
  await mkdir(dirname(templateHelper), { recursive: true })
  await writeFile(templateHelper, await readFile(rootHelper, 'utf8'))
  await rm(rootHelper)
  const results = await runDeterministicChecks(dir)
  for (const id of [
    'quality-project-local-screenshot-helper', 'visual-helper-overlap-warning',
    'visual-helper-active-state-warning', 'visual-helper-attribution-warning',
  ]) assert.equal(results.find((item) => item.id === id)?.verdict, 'pass', id)
})

test('deterministic evaluator catches known sample, loopback, attribution, active-state, and screenshot-helper mutations', async () => {
  const mutations = [
    ['verification-sample-outline', { 'src/presentations/how-to-make-a-presentation/steps.tsx': 'You have a topic\nThe skill interviews you' }],
    ['verification-ipv4-loopback', { 'scripts/verify.mjs': 'http://localhost:4319 data-step-count data-step-index' }],
    ['attribution-default-link', { 'src/presentation-kit/Attribution.tsx': 'no attribution' }],
    ['navigation-active-state', { 'src/presentation-kit/Toc.tsx': 'className active' }],
    ['visual-helper-overlap-warning', { 'scripts/screenshot.mjs': 'playwright getComputedStyle active inactive aria-current made by and-scene attribution font-size text-decoration warning' }],
    ['visual-helper-active-state-warning', { 'scripts/screenshot.mjs': 'playwright data-allow-overlap overlap warning made by and-scene attribution font-size text-decoration warning' }],
    ['visual-helper-attribution-warning', { 'scripts/screenshot.mjs': 'playwright data-allow-overlap overlap warning getComputedStyle active inactive aria-current warning' }],
  ]
  for (const [expectedFailure, override] of mutations) {
    const dir = await mkdtemp(join(tmpdir(), 'and-scene-mutant-'))
    await writeCandidate(dir, override)
    const results = await runDeterministicChecks(dir)
    assert.equal(results.find(({ id }) => id === expectedFailure)?.verdict, 'fail', expectedFailure)
  }
})

test('deterministic sample check requires browser evidence in canonical title order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'and-scene-order-'))
  await writeCandidate(dir)
  const manifest = join(dir, 'screenshot-manifest.json')
  await writeFile(manifest, `${JSON.stringify({
    expectedScreenshots: 9,
    capturedScreenshots: 9,
    presentations: [{
      slug: 'how-to-make-a-presentation',
      stepTexts: [
        'You have a topic', 'Answers become steps', 'The skill interviews you',
        'The deck grows', 'You set the depth', 'It assembles the scene',
        'It checks its own work', 'Changed your mind? Loop it.', "You're looking at one",
      ],
    }],
  })}\n`)
  const results = await runDeterministicChecks(dir, { screenshotManifest: manifest })
  assert.equal(results.find(({ id }) => id === 'verification-sample-outline')?.verdict, 'fail')
})
