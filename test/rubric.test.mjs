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

test('the automated rubric allocates the approved 24/24/7/7/4/4 automated components', async () => {
  const rubric = await automatedRubric()
  assert.deepEqual(validateAutomatedRubric(rubric), [])
  assert.equal(rubric.automated_points, 70)
  assert.deepEqual(
    rubric.components.map(({ id, points, floor }) => ({ id, points, floor })),
    [
      { id: 'demo-technical-quality', points: 24, floor: 15 },
      { id: 'scene-kit-correctness', points: 24, floor: 15 },
      { id: 'presentation-skill-correctness', points: 7, floor: null },
      { id: 'verification-tool-correctness', points: 7, floor: null },
      { id: 'testing-evidence-quality', points: 4, floor: null },
      { id: 'assumption-handling-quality', points: 4, floor: null },
    ],
  )
  assert.deepEqual(
    rubric.components.flatMap(({ subcomponents }) => (
      subcomponents.map(({ id, points }) => [id, points])
    )),
    [
      ['demo-canonical-content', 5],
      ['demo-navigation-and-modes', 5],
      ['demo-runtime-reliability', 4],
      ['demo-scene-kit-integration', 4],
      ['demo-identity-and-grouping', 3],
      ['demo-code-boundaries', 3],
      ['scene-step-model', 4],
      ['scene-entity-transitions', 7],
      ['scene-modes-and-navigation', 6],
      ['scene-fixed-canvas', 2],
      ['scene-style-and-attribution', 5],
      ['skill-requirement-gathering', 1],
      ['skill-scaffolding', 3],
      ['skill-presentation-lifecycle', 2],
      ['skill-self-verification', 1],
      ['verification-missing-sample', 1],
      ['verification-addressing-and-errors', 2],
      ['verification-capture', 2],
      ['verification-warnings', 2],
      ['testing-evidence-quality-criteria', 4],
      ['assumption-handling-quality-criteria', 4],
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
  assert.equal(byEvaluator('llm-source-review'), 10)
  assert.ok(
    demo.subcomponents
      .filter(({ evaluator }) => evaluator === 'llm-source-review')
      .every(({ job }) => job === 'demo-integration'),
  )
})

test('each of the six scored judge jobs maps to exactly one component', async () => {
  const rubric = await automatedRubric()
  const jobs = new Map()
  for (const component of rubric.components) {
    for (const subcomponent of component.subcomponents) {
      if (!subcomponent.evaluator.startsWith('llm-')) continue
      const owners = jobs.get(subcomponent.job) ?? new Set()
      owners.add(component.id)
      jobs.set(subcomponent.job, owners)
    }
  }
  assert.deepEqual([...jobs.keys()].sort(), [
    'assumption-handling', 'demo-integration', 'presentation-skill', 'scene-kit',
    'testing-evidence', 'verification-tooling',
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
  const replaced = new Set(rubric.replaced.map(({ id }) => id))
  const legacyScored = LEGACY_CRITERION_IDS.filter((id) => scored.has(id))

  assert.equal(legacyScored.length, 59)
  assert.equal(gates.size, 4)
  assert.equal(removed.size, 3)
  assert.equal(replaced.size, 2)
  for (const id of LEGACY_CRITERION_IDS) {
    const dispositions = [scored.has(id), gates.has(id), replaced.has(id), removed.has(id)].filter(Boolean)
    assert.equal(dispositions.length, 1, `${id} must have exactly one disposition`)
  }
  assert.deepEqual([...replaced].sort(), [
    'quality-visual-composition-inspected', 'quality-visual-warnings-reviewed',
  ])
  assert.deepEqual([...removed].sort(), [
    'quality-builds-clean', 'quality-renders-without-errors', 'skill-optional-ascii-mockup',
  ])
  assert.ok(rubric.removed.every(({ reason }) => typeof reason === 'string' && reason.length > 0))
})

test('the four testing-evidence and four assumption-handling criteria are assigned exactly once', async () => {
  const rubric = await automatedRubric()
  const rows = rubricCriteria(rubric)
  const byJob = (job) => rows.filter((row) => row.job === job).map(({ id }) => id)

  assert.deepEqual(byJob('testing-evidence'), [
    'testing-evidence-traceable-coverage',
    'testing-evidence-usable-proof',
    'testing-evidence-final-revision-applicability',
    'testing-evidence-complete-honest-record',
  ])
  assert.deepEqual(byJob('assumption-handling'), [
    'assumption-consequential-ambiguities-surfaced',
    'assumption-repository-facts-distinguished',
    'assumption-decisions-and-escalations-proportionate',
    'assumption-final-handoff-preserves-decisions',
  ])
  assert.equal(new Set(rows.map(({ id }) => id)).size, rows.length)
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

test('the human rubric requires one question per counted question and a covered dimension', async () => {
  const { human } = await loadRubrics()

  assert.deepEqual(
    validateHumanRubric({ ...human.rubric, questions: human.rubric.questions.slice(0, 12) }),
    [
      'human rubric declares question_count 13 but defines 12 questions',
      'human rubric dimension cohesion has no questions',
    ],
  )
  assert.ok(
    validateHumanRubric({
      ...human.rubric,
      questions: human.rubric.questions.map((question, index) => (
        index === 0 ? { ...question, dimension: 'nowhere' } : question
      )),
    }).some((error) => error.includes('unknown dimension nowhere')),
  )
})

test('the human rubric dimension points must sum to its total points', async () => {
  const { human } = await loadRubrics()
  const dimensions = human.rubric.dimensions.map((dimension, index) => (
    index === 0 ? { ...dimension, points: 11 } : dimension
  ))

  assert.deepEqual(
    validateHumanRubric({ ...human.rubric, dimensions }),
    ['human rubric dimension points sum to 31, expected points 30'],
  )
})

test('the human rubric requires one anchor for every rating on its scale', async () => {
  const { human } = await loadRubrics()

  assert.deepEqual(
    validateHumanRubric({ ...human.rubric, anchors: human.rubric.anchors.slice(0, 4) }),
    ['human rubric requires one anchor for each of the ratings 1 through 5'],
  )
})

test('the human rubric requires unique, ordered question numbers', async () => {
  const { human } = await loadRubrics()
  const questions = human.rubric.questions.map((question, index) => (
    index === 3 ? { ...question, number: 3 } : question
  ))

  assert.ok(
    validateHumanRubric({ ...human.rubric, questions })
      .some((error) => error.includes('numbered 1 through 13 in order')),
  )
})
