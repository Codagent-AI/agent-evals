import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { runDeterministicChecks } from '../evals/agent-runner/and-scene/deterministic-checks.mjs'
import { scoreEvaluation } from '../evals/agent-runner/and-scene/score.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rubricPath = join(root, 'evals/agent-runner/and-scene/rubric.json')

async function loadRubric() {
  return JSON.parse(await readFile(rubricPath, 'utf8'))
}

function passingResults(scenarios) {
  return scenarios.map(({ id }) => ({ id, verdict: 'pass', note: 'verified', evidence: ['test'] }))
}

test('rubric owns a unique evaluator and fixed scoring policy for every scenario', async () => {
  const rubric = await loadRubric()
  assert.equal(rubric.version, 1)
  assert.ok(rubric.scenarios.length >= 60)
  assert.equal(new Set(rubric.scenarios.map(({ id }) => id)).size, rubric.scenarios.length)
  assert.ok(rubric.scenarios.every(({ evaluator }) => ['deterministic', 'judge'].includes(evaluator)))
  assert.ok(rubric.scenarios.every(({ critical }) => typeof critical === 'boolean'))
  assert.ok(rubric.scenarios.every(({ weight }) => Number.isFinite(weight) && weight > 0))
  assert.ok(rubric.scenarios.filter(({ critical }) => critical).length < rubric.scenarios.length / 2)
})

test('scorer computes pass and score from rubric-owned fields', async () => {
  const rubric = await loadRubric()
  const deterministic = rubric.scenarios.filter(({ evaluator }) => evaluator === 'deterministic')
  const judged = rubric.scenarios.filter(({ evaluator }) => evaluator === 'judge')
  const result = scoreEvaluation({
    rubric,
    deterministicResults: passingResults(deterministic),
    judgeResults: passingResults(judged),
  })
  assert.equal(result.overall_score, 100)
  assert.equal(result.pass, true)
  assert.equal(result.scenarios.length, rubric.scenarios.length)
  assert.deepEqual(
    result.scenarios.map(({ id, critical, weight, evaluator }) => ({ id, critical, weight, evaluator })),
    rubric.scenarios.map(({ id, critical, weight, evaluator }) => ({ id, critical, weight, evaluator })),
  )
})

test('scorer rejects missing, duplicate, and unknown judge scenario IDs', async () => {
  const rubric = await loadRubric()
  const deterministic = rubric.scenarios.filter(({ evaluator }) => evaluator === 'deterministic')
  const judged = rubric.scenarios.filter(({ evaluator }) => evaluator === 'judge')
  const base = {
    rubric,
    deterministicResults: passingResults(deterministic),
  }
  assert.throws(
    () => scoreEvaluation({ ...base, judgeResults: passingResults(judged.slice(1)) }),
    /missing judge scenario IDs/,
  )
  assert.throws(
    () => scoreEvaluation({ ...base, judgeResults: [...passingResults(judged), passingResults(judged.slice(0, 1))[0]] }),
    /duplicate judge scenario IDs/,
  )
  assert.throws(
    () => scoreEvaluation({ ...base, judgeResults: [...passingResults(judged), { id: 'invented', verdict: 'pass', note: '', evidence: [] }] }),
    /unknown judge scenario IDs/,
  )
})

test('a failed critical scenario fails the candidate while a noncritical failure only lowers score', async () => {
  const rubric = await loadRubric()
  const deterministic = passingResults(rubric.scenarios.filter(({ evaluator }) => evaluator === 'deterministic'))
  const judgedScenarios = rubric.scenarios.filter(({ evaluator }) => evaluator === 'judge')
  const critical = judgedScenarios.find(({ critical: value }) => value)
  const noncritical = judgedScenarios.find(({ critical: value }) => !value)
  const judgeResults = passingResults(judgedScenarios)

  const criticalResult = scoreEvaluation({
    rubric,
    deterministicResults: deterministic,
    judgeResults: judgeResults.map((item) => item.id === critical.id ? { ...item, verdict: 'fail' } : item),
  })
  assert.equal(criticalResult.pass, false)
  assert.ok(criticalResult.overall_score < 100)

  const noncriticalResult = scoreEvaluation({
    rubric,
    deterministicResults: deterministic,
    judgeResults: judgeResults.map((item) => item.id === noncritical.id ? { ...item, verdict: 'fail' } : item),
  })
  assert.equal(noncriticalResult.pass, true)
  assert.ok(noncriticalResult.overall_score < 100)
})

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
