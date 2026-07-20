import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  AUTOMATED_RUBRIC_PATH,
  HUMAN_RUBRIC_PATH,
  LEGACY_CRITERION_IDS,
  loadRubrics,
  rubricCriteria,
  validateAutomatedRubric,
  validateHumanRubric,
} from '../evals/agent-runner/and-scene/lib/rubric.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function automatedRubric() {
  return JSON.parse(await readFile(AUTOMATED_RUBRIC_PATH, 'utf8'))
}

test('the automated rubric allocates exactly 70 points across the four product components', async () => {
  const rubric = await automatedRubric()
  assert.deepEqual(validateAutomatedRubric(rubric), [])
  assert.equal(rubric.automated_points, 70)
  assert.deepEqual(
    rubric.components.map(({ id, points, floor }) => ({ id, points, floor })),
    [
      { id: 'demo-technical-quality', points: 25, floor: 15 },
      { id: 'scene-kit-correctness', points: 25, floor: 15 },
      { id: 'presentation-skill-correctness', points: 10, floor: null },
      { id: 'verification-tool-correctness', points: 10, floor: null },
    ],
  )
  for (const component of rubric.components) {
    const subtotal = component.subcomponents.reduce((sum, { points }) => sum + points, 0)
    assert.equal(subtotal, component.points, component.id)
    assert.ok(component.subcomponents.every(({ criteria }) => criteria.length > 0))
  }
})

test('deterministic browser and LLM source review own disjoint demo subcomponents', async () => {
  const rubric = await automatedRubric()
  const demo = rubric.components.find(({ id }) => id === 'demo-technical-quality')
  const byEvaluator = (evaluator) => demo.subcomponents
    .filter((subcomponent) => subcomponent.evaluator === evaluator)
    .reduce((sum, { points }) => sum + points, 0)

  assert.equal(byEvaluator('deterministic-browser'), 14)
  assert.equal(byEvaluator('llm-source-review'), 11)
  assert.ok(
    demo.subcomponents
      .filter(({ evaluator }) => evaluator === 'llm-source-review')
      .every(({ job }) => job === 'demo-integration'),
  )
})

test('each product judge job maps to exactly one component', async () => {
  const rubric = await automatedRubric()
  const jobs = new Map()
  for (const component of rubric.components) {
    for (const subcomponent of component.subcomponents) {
      if (subcomponent.evaluator !== 'llm-source-review') continue
      const owners = jobs.get(subcomponent.job) ?? new Set()
      owners.add(component.id)
      jobs.set(subcomponent.job, owners)
    }
  }
  assert.deepEqual([...jobs.keys()].sort(), [
    'demo-integration', 'presentation-skill', 'scene-kit', 'verification-tooling',
  ])
  assert.ok([...jobs.values()].every((owners) => owners.size === 1))
})

test('every legacy criterion id receives exactly one approved disposition', async () => {
  const rubric = await automatedRubric()
  assert.equal(LEGACY_CRITERION_IDS.length, 68)
  assert.equal(new Set(LEGACY_CRITERION_IDS).size, 68)

  const scored = new Set(rubricCriteria(rubric).map(({ id }) => id))
  const gates = new Set(rubric.gates.map(({ id }) => id))
  const removed = new Set(rubric.removed.map(({ id }) => id))
  const legacyScored = LEGACY_CRITERION_IDS.filter((id) => scored.has(id))

  assert.equal(legacyScored.length, 61)
  assert.equal(gates.size, 4)
  assert.equal(removed.size, 3)
  for (const id of LEGACY_CRITERION_IDS) {
    const dispositions = [scored.has(id), gates.has(id), removed.has(id)].filter(Boolean)
    assert.equal(dispositions.length, 1, `${id} must have exactly one disposition`)
  }
  assert.deepEqual([...removed].sort(), [
    'quality-builds-clean', 'quality-renders-without-errors', 'skill-optional-ascii-mockup',
  ])
  assert.ok(rubric.removed.every(({ reason }) => typeof reason === 'string' && reason.length > 0))
})

test('the four hard gates are excluded from the scored verification component', async () => {
  const rubric = await automatedRubric()
  const scored = new Set(rubricCriteria(rubric).map(({ id }) => id))
  for (const id of [
    'verification-build-whole-app', 'verification-sample-outline',
    'verification-every-produced-step-renders', 'verification-clear-outcome',
  ]) assert.equal(scored.has(id), false, id)
})

test('rubric validation rejects mis-summed points, duplicate ids, and unknown evaluators', async () => {
  const rubric = await automatedRubric()
  const clone = () => JSON.parse(JSON.stringify(rubric))

  const misSummed = clone()
  misSummed.components[0].subcomponents[0].points += 1
  assert.match(validateAutomatedRubric(misSummed).join('\n'), /points/)

  const duplicated = clone()
  duplicated.components[1].subcomponents[0].criteria.push(
    duplicated.components[1].subcomponents[1].criteria[0],
  )
  assert.match(validateAutomatedRubric(duplicated).join('\n'), /duplicate criterion/)

  const unknownEvaluator = clone()
  unknownEvaluator.components[0].subcomponents[0].evaluator = 'vibes'
  assert.match(validateAutomatedRubric(unknownEvaluator).join('\n'), /evaluator/)

  const gateOverlap = clone()
  gateOverlap.gates.push({ id: gateOverlap.components[0].subcomponents[0].criteria[0], requirement: 'x' })
  assert.match(validateAutomatedRubric(gateOverlap).join('\n'), /gate/)
})

test('the human rubric owns 30 points, a floor, and a distinct version', async () => {
  const human = JSON.parse(await readFile(HUMAN_RUBRIC_PATH, 'utf8'))
  const automated = await automatedRubric()
  assert.deepEqual(validateHumanRubric(human), [])
  assert.equal(human.points, 30)
  assert.equal(human.floor, 15)
  assert.equal(human.min_individual_rating, 2)
  assert.notEqual(human.rubric_id, automated.rubric_id)
})

test('loading records distinct version identifiers and SHA-256 hashes for both rubrics', async () => {
  const provenance = await loadRubrics()
  for (const rubric of [provenance.automated, provenance.human]) {
    assert.match(rubric.sha256, /^[0-9a-f]{64}$/)
    assert.equal(typeof rubric.version, 'string')
    assert.ok(rubric.version.length > 0)
  }
  assert.notEqual(provenance.automated.rubric_id, provenance.human.rubric_id)
  assert.notEqual(provenance.automated.sha256, provenance.human.sha256)

  const expected = await readFile(join(root, 'evals/agent-runner/and-scene/automated-rubric.json'))
  const { createHash } = await import('node:crypto')
  assert.equal(provenance.automated.sha256, createHash('sha256').update(expected).digest('hex'))
})
