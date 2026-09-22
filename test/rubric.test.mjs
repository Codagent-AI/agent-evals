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
      ['scene-fixed-canvas-uniform-fit', 1],
      ['scene-fixed-canvas', 1],
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

test('source-reviewed robustness-sensitive rows carry explicit review guidance', async () => {
  const rubric = await automatedRubric()
  const required = new Set([
    'demo-code-boundaries',
    'scene-entity-transitions',
    'scene-modes-and-navigation',
    'scene-style-and-attribution',
    'skill-requirement-gathering',
    'skill-scaffolding',
    'skill-presentation-lifecycle',
    'skill-self-verification',
    'verification-missing-sample',
    'verification-addressing-and-errors',
    'verification-capture',
    'verification-warnings',
  ])
  const rows = rubric.components.flatMap(({ subcomponents }) => subcomponents)
    .filter(({ id }) => required.has(id))

  assert.equal(rows.length, required.size)
  for (const row of rows) {
    assert.ok(Array.isArray(row.review_guidance), row.id)
    assert.ok(row.review_guidance.length > 0, row.id)
    assert.ok(row.review_guidance.every((item) => typeof item === 'string' && item.length > 0), row.id)
  }
})

test('rubric 5.0 defines pre-human automated eligibility and distinguishes proof requirements', async () => {
  const rubric = await automatedRubric()
  assert.equal(rubric.version, '5.0.0')
  assert.equal(rubric.automated_pass_threshold, 40)

  const rows = new Map(
    rubric.components
      .flatMap(({ subcomponents }) => subcomponents)
      .map((subcomponent) => [subcomponent.id, subcomponent]),
  )
  const addressing = rows.get('verification-addressing-and-errors')
  assert.ok(addressing.criteria.includes('verification-preview-process-ownership'))

  const guidance = (id) => rows.get(id).review_guidance.join('\n')
  assert.match(guidance('verification-addressing-and-errors'), /score preview ownership only/i)
  assert.match(guidance('verification-addressing-and-errors'), /IPv4 loopback/i)
  assert.match(guidance('scene-entity-transitions'), /shared timing (?:value|constant).*insufficient/i)
  assert.match(guidance('skill-scaffolding'), /interactive confirmation/i)
  assert.match(guidance('verification-warnings'), /earlier revision/i)
  assert.match(guidance('verification-warnings'), /raw executable/i)
  assert.match(guidance('demo-code-boundaries'), /exactly once/i)
  assert.match(guidance('demo-code-boundaries'), /title.*consum/i)
  assert.match(guidance('scene-entity-transitions'), /plain conditional|opt-in wrapper/i)
  assert.match(guidance('scene-modes-and-navigation'), /both.*horizontal.*vertical/i)
  assert.match(guidance('scene-fixed-canvas-uniform-fit'), /one factor on both axes.*inside its available bounds/i)
  assert.match(guidance('scene-fixed-canvas'), /880×380/)
  assert.match(guidance('skill-scaffolding'), /test name|filename/i)
  assert.match(guidance('verification-addressing-and-errors'), /strictPort.*insufficient/i)
  assert.match(guidance('verification-capture'), /fixed.*delay.*insufficient/i)
  assert.match(guidance('verification-warnings'), /assert.*warning output/i)
  assert.match(guidance('demo-scene-kit-integration'), /shared Scene.*boundar/i)
  assert.match(guidance('demo-identity-and-grouping'), /every step module/i)
  assert.match(guidance('demo-identity-and-grouping'), /groupKey.*Stage/i)
  assert.match(guidance('demo-identity-and-grouping'), /ENTITY constants.*Scene.*layoutId.*node consumers/i)
  assert.match(guidance('demo-identity-and-grouping'), /do not claim.*groupKey.*derives.*entity identit/i)
  assert.match(guidance('demo-code-boundaries'), /unrelated source files/i)
  assert.match(guidance('demo-code-boundaries'), /project-local.*does not require.*inject/i)
  assert.match(guidance('scene-entity-transitions'), /persisting.*layout.*mechanism/i)
  assert.match(guidance('scene-entity-transitions'), /do not.*double.*deduct.*newcomer/i)
  assert.match(guidance('scene-entity-transitions'), /continuing.*remain.*mounted/i)
  assert.match(guidance('scene-modes-and-navigation'), /active step.*multi-line caption/i)
  assert.match(guidance('scene-modes-and-navigation'), /not.*all steps.*at once/i)
  assert.match(guidance('scene-modes-and-navigation'), /focused controls.*own keyboard semantics/i)
  assert.match(guidance('scene-modes-and-navigation'), /not.*global presentation navigation/i)
  assert.match(guidance('scene-style-and-attribution'), /stable.*(?:class|data).*hook/i)
  assert.match(guidance('scene-style-and-attribution'), /does not require.*caller.*prop/i)
  assert.match(guidance('scene-style-and-attribution'), /top-left.*brand.*not.*attribution placement/i)
  assert.match(guidance('skill-requirement-gathering'), /normative skill instructions.*implementation/i)
  assert.match(guidance('skill-requirement-gathering'), /does not require.*interaction driver/i)
  assert.match(guidance('skill-presentation-lifecycle'), /normative skill instructions.*implementation/i)
  assert.match(guidance('skill-self-verification'), /normative skill instructions.*implementation/i)
  assert.match(guidance('verification-missing-sample'), /explicit.*failure branch/i)
  assert.match(guidance('verification-missing-sample'), /does not require.*dedicated.*test/i)
  assert.match(guidance('verification-capture'), /project-local screenshot helper.*separate inspection command/i)
  assert.match(guidance('verification-capture'), /does not require.*build.*render verifier.*invoke/i)
})

test('both fixed-canvas criteria are source-reviewed rather than measured at an extreme viewport', async () => {
  const rubric = await automatedRubric()
  const fixedCanvas = rubric.components
    .flatMap(({ subcomponents }) => subcomponents)
    .filter(({ id }) => id.startsWith('scene-fixed-canvas'))

  assert.deepEqual(fixedCanvas.map(({ evaluator, job, criteria, points }) => ({
    evaluator,
    job: job ?? null,
    criteria,
    points,
  })), [
    {
      evaluator: 'llm-source-review',
      job: 'scene-kit',
      criteria: ['canvas-uniform-scaling'],
      points: 1,
    },
    {
      evaluator: 'llm-source-review',
      job: 'scene-kit',
      criteria: ['canvas-default-dimensions'],
      points: 1,
    },
  ])
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

test('assumption handling guidance catches requirement violations misclassified as environment issues', async () => {
  const rubric = await automatedRubric()
  const component = rubric.components.find(({ id }) => id === 'assumption-handling-quality')
  const guidance = component.subcomponents[0].review_guidance.join('\n')

  assert.match(guidance, /approved requirement/i)
  assert.match(guidance, /environment(?:al)? trigger/i)
  assert.match(guidance, /not a finding|optional hardening/i)
  assert.match(guidance, /assumption-repository-facts-distinguished/)
  assert.match(guidance, /assumption-decisions-and-escalations-proportionate/)
  assert.match(guidance, /omission/i)
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

  const wrongAutomatedThreshold = clone()
  wrongAutomatedThreshold.automated_pass_threshold = 39
  assert.match(validateAutomatedRubric(wrongAutomatedThreshold).join('\n'), /minimum score.*maximum human points/)

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
    validateHumanRubric({ ...human.rubric, questions: human.rubric.questions.slice(0, 6) }),
    [
      'human rubric declares question_count 7 but defines 6 questions',
      'human rubric dimension responsive has no questions',
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
    index === 0 ? { ...dimension, points: 5 } : dimension
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

test('every human-review question requires ordered question-specific rating options', async () => {
  const { human } = await loadRubrics()
  const questions = human.rubric.questions.map((question, index) => (
    index === 0
      ? { ...question, rating_options: question.rating_options.slice(0, 4) }
      : question
  ))

  assert.deepEqual(
    validateHumanRubric({ ...human.rubric, questions }),
    ['human rubric question text-appearance requires one rating option for each rating 1 through 5'],
  )
})

test('the human rubric requires unique, ordered question numbers', async () => {
  const { human } = await loadRubrics()
  const questions = human.rubric.questions.map((question, index) => (
    index === 3 ? { ...question, number: 3 } : question
  ))

  assert.ok(
    validateHumanRubric({ ...human.rubric, questions })
      .some((error) => error.includes('numbered 1 through 7 in order')),
  )
})

test('the fit and attribution guidance settle the verdicts the judge split on', async () => {
  const rubric = await automatedRubric()
  const guidance = (id) => rubric.components
    .flatMap(({ subcomponents }) => subcomponents)
    .find((row) => row.id === id)
    .review_guidance.join('\n')

  // Repetitions 1 and 2 share a minimum-scale floor; the judge failed one and passed the other.
  assert.match(guidance('scene-fixed-canvas-uniform-fit'), /minimum-scale floor[^.]*is not by itself a failure/)
  // Repetitions 2 and 3 both position the link only through sample CSS; the judge split them.
  assert.match(guidance('scene-style-and-attribution'), /For attribution-default-link, the scene kit itself must place/)
})
