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

test('the automated rubric allocates the approved 20/20/7/7/8/4/4 automated components', async () => {
  const rubric = await automatedRubric()
  assert.deepEqual(validateAutomatedRubric(rubric), [])
  assert.equal(rubric.automated_points, 70)
  assert.deepEqual(
    rubric.components.map(({ id, points, floor }) => ({ id, points, floor })),
    [
      { id: 'demo-technical-quality', points: 20, floor: 12.5 },
      { id: 'scene-kit-correctness', points: 20, floor: 12.5 },
      { id: 'presentation-skill-correctness', points: 7, floor: null },
      { id: 'verification-tool-correctness', points: 7, floor: null },
      { id: 'engineering-quality', points: 8, floor: null },
      { id: 'testing-evidence-quality', points: 4, floor: null },
      { id: 'assumption-handling-quality', points: 4, floor: null },
    ],
  )
  assert.deepEqual(
    rubric.components.flatMap(({ subcomponents }) => (
      subcomponents.map(({ id, points }) => [id, points])
    )),
    [
      ['demo-canonical-content', 4],
      ['demo-navigation-and-modes', 4],
      ['demo-runtime-reliability', 3],
      ['demo-scene-kit-integration', 4],
      ['demo-identity-and-grouping', 3],
      ['demo-code-boundaries', 2],
      ['scene-step-model', 3],
      ['scene-entity-transitions', 6],
      ['scene-modes-and-navigation', 5],
      ['scene-fixed-canvas-uniform-fit', 1],
      ['scene-fixed-canvas', 1],
      ['scene-style-and-attribution', 4],
      ['skill-requirement-gathering', 1],
      ['skill-scaffolding', 3],
      ['skill-presentation-lifecycle', 2],
      ['skill-self-verification', 1],
      ['verification-missing-sample', 1],
      ['verification-addressing-and-errors', 2],
      ['verification-capture', 2],
      ['verification-warnings', 2],
      ['engineering-input-hygiene', 2],
      ['engineering-verification-tooling-robustness', 3],
      ['engineering-skill-instructions-and-templates', 1.5],
      ['engineering-presentation-code-and-tests', 1.5],
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

  assert.equal(byEvaluator('deterministic-browser'), 11)
  assert.equal(byEvaluator('llm-source-review'), 9)
  assert.ok(
    demo.subcomponents
      .filter(({ evaluator }) => evaluator === 'llm-source-review')
      .every(({ job }) => job === 'demo-integration'),
  )
})

test('every deterministic criterion has a declared fallback', async () => {
  const rubric = await automatedRubric()
  const deterministic = rubricCriteria(rubric).filter(({ evaluator }) => evaluator === 'deterministic-browser')
  assert.equal(deterministic.length, 16)
  for (const { id } of deterministic) {
    assert.equal(rubric.fallbacks[id]?.job, 'demo-integration')
    const copy = structuredClone(rubric)
    delete copy.fallbacks[id]
    assert.match(validateAutomatedRubric(copy).join('\n'), new RegExp(`criterion ${id} requires a fallback`))
  }
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

test('rubric 12.3 defines pre-human automated eligibility and distinguishes proof requirements', async () => {
  const rubric = await automatedRubric()
  assert.equal(rubric.version, '14.0.0')
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
  assert.match(guidance('scene-entity-transitions'), /delay[^.]*at least as long as the continuing entities' layout transition/i)
  assert.match(guidance('skill-scaffolding'), /interactive confirmation needs no live human/i)
  assert.match(guidance('verification-warnings'), /earlier revision/i)
  assert.match(guidance('verification-warnings'), /raw executable/i)
  assert.match(guidance('demo-code-boundaries'), /exactly once/i)
  assert.match(guidance('demo-code-boundaries'), /title.*consum/i)
  assert.match(guidance('scene-entity-transitions'), /plain conditional|opt-in wrapper/i)
  assert.match(guidance('scene-modes-and-navigation'), /swipe to the left advances one step and a swipe to the right goes back/i)
  assert.match(guidance('scene-fixed-canvas-uniform-fit'), /one factor on both axes.*inside its available bounds/i)
  assert.match(guidance('scene-fixed-canvas'), /880×380/)
  assert.match(guidance('skill-scaffolding'), /test name|filename/i)
  assert.match(guidance('verification-addressing-and-errors'), /A strict port alone is likewise insufficient/)
  assert.match(guidance('verification-capture'), /fixed configured interval satisfies the criterion/i)
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
  assert.match(guidance('verification-missing-sample'), /check that reports the sample as missing/i)
  assert.match(guidance('verification-missing-sample'), /dedicated missing-sample regression test is not required/i)
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

test('each of the seven scored judge jobs maps to exactly one component', async () => {
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
    'assumption-handling', 'demo-integration', 'engineering-quality', 'presentation-skill', 'scene-kit',
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

test('every testing-evidence criterion carries the definition its judge applies', async () => {
  const rubric = await automatedRubric()
  const row = rubric.components
    .flatMap(({ subcomponents }) => subcomponents)
    .find(({ job }) => job === 'testing-evidence')
  const definition = (id) => row.criterion_definitions[id]

  assert.deepEqual(Object.keys(row.criterion_definitions), row.criteria)
  // Coverage is measured against the approved specs, whatever the approach.
  assert.match(definition('testing-evidence-traceable-coverage'), /approved specs/)
  assert.match(definition('testing-evidence-traceable-coverage'), /Any testing approach is acceptable/)
  assert.match(definition('testing-evidence-traceable-coverage'), /do not require a fixed case inventory/)
  assert.match(definition('testing-evidence-traceable-coverage'), /undisclosed omission counts fully/)
  assert.match(definition('testing-evidence-usable-proof'), /verified candidate artifacts/)
  // A diff-scoped re-test is enough; a full re-run is not demanded.
  assert.match(definition('testing-evidence-final-revision-applicability'), /tested_revision/)
  assert.match(definition('testing-evidence-final-revision-applicability'), /full re-run of earlier passes and bounded-impact lineage are not required/)
  assert.match(definition('testing-evidence-final-revision-applicability'), /Fail when any listed product file is unexplored/)
  assert.match(definition('testing-evidence-complete-honest-record'), /no completion or coverage claim exceeds/)
})

test('rubric validation rejects incomplete, unknown, and missing criterion definitions', async () => {
  const rubric = await automatedRubric()
  const testingRow = (mutated) => mutated.components
    .flatMap(({ subcomponents }) => subcomponents)
    .find(({ job }) => job === 'testing-evidence')

  const incomplete = structuredClone(rubric)
  delete testingRow(incomplete).criterion_definitions['testing-evidence-usable-proof']
  assert.match(validateAutomatedRubric(incomplete).join('\n'), /does not define criterion testing-evidence-usable-proof/)

  const unknown = structuredClone(rubric)
  testingRow(unknown).criterion_definitions['scene-kit-anything'] = 'text'
  assert.match(validateAutomatedRubric(unknown).join('\n'), /defines unknown criterion scene-kit-anything/)

  const blank = structuredClone(rubric)
  testingRow(blank).criterion_definitions['testing-evidence-usable-proof'] = ' '
  assert.match(validateAutomatedRubric(blank).join('\n'), /testing-evidence-usable-proof definition must be non-empty/)

  const missing = structuredClone(rubric)
  delete testingRow(missing).criterion_definitions
  assert.match(validateAutomatedRubric(missing).join('\n'), /must define every testing-evidence criterion/)
})

// Round-0 baseline audit: guidance that exceeded or contradicted the fixture
// cost every repetition points the fixture never asked for.
test('rubric 8.0 guidance traces to the fixture rather than exceeding it', async () => {
  const rubric = await automatedRubric()
  const guidance = (id) => rubric.components
    .flatMap(({ subcomponents }) => subcomponents)
    .find((row) => row.id === id)
    .review_guidance.join('\n')

  // "waits for the configured settle interval before capturing"
  assert.doesNotMatch(guidance('verification-capture'), /fixed settlement delay is insufficient/i)
  assert.match(guidance('verification-capture'), /configured settle interval/)
  // "swiping left advances and swiping right goes back": nothing about multi-touch.
  assert.match(guidance('scene-modes-and-navigation'), /do not require rejection of vertical scrolling or multi-touch/i)
  assert.doesNotMatch(guidance('scene-modes-and-navigation'), /require focused assertions for predominantly vertical/i)
  // "elements inside that subtree": a marked member exempts the pair.
  assert.match(guidance('verification-warnings'), /at least one element is inside a marked subtree is a correct reading/i)
  assert.doesNotMatch(guidance('verification-warnings'), /nested text\/chrome/i)
  // Scaffold branches are SKILL.md procedure verified by agent acceptance.
  assert.match(guidance('skill-scaffolding'), /Do not require an executable test, driver, or transcript for these branches/)
  assert.match(guidance('skill-scaffolding'), /copying the template into a new app path/)
  // Judge errors the audit found.
  assert.match(guidance('scene-step-model'), /aria-label[^.]*is not on screen/)
  assert.match(guidance('demo-identity-and-grouping'), /trace every use[^.]*arrow or connector counts/i)
  assert.match(guidance('demo-identity-and-grouping'), /single groupKey shared by all nine steps is the correct grouping/)
  assert.match(guidance('demo-code-boundaries'), /trace it through every use/)
  assert.match(guidance('scene-style-and-attribution'), /https:\/\/github\.com\/Codagent-AI\/and-scene/)
  // "navigation keys drive that control": the mode shortcut is not a navigation key.
  assert.match(guidance('scene-modes-and-navigation'), /mode-toggle shortcut is not part of this criterion/)
  // "does not contain a default and-scene brand link": no brand slot is required.
  assert.match(guidance('scene-style-and-attribution'), /does not require a kit brand slot/)
})

// Round-1 audit: 76283fa changed guidance under the same 8.0.0 version, so two
// rubrics claimed one version. Every content now needs its own version.
test('the rubric version identifies exactly one recorded rubric content', async () => {
  const { readFile } = await import('node:fs/promises')
  const { automated } = await loadRubrics()
  const history = JSON.parse(await readFile(
    new URL('../evals/agent-runner/and-scene/rubric-history.json', import.meta.url), 'utf8'))
  const recorded = history.versions[automated.version]
  assert.deepEqual(recorded, [automated.sha256],
    `automated rubric ${automated.version} content changed: bump the version and record its hash in rubric-history.json`)
  const owners = new Map()
  for (const [version, hashes] of Object.entries(history.versions)) {
    for (const hash of hashes) {
      assert.equal(owners.has(hash), false, `${hash} is recorded for ${owners.get(hash)} and ${version}`)
      owners.set(hash, version)
    }
  }
})

// Round-1 audit: guidance that contradicted the fixture design or left a
// criterion open to the judge's own choice of viewport, marker, or mechanism.
test('rubric 9.0 guidance settles the criteria round 1 judged inconsistently', async () => {
  const rubric = await automatedRubric()
  const rows = rubric.components.flatMap(({ subcomponents }) => subcomponents)
  const guidance = (id) => rows.find((row) => row.id === id).review_guidance.join('\n')
  const definition = (id) => rows.find((row) => row.criterion_definitions?.[id]).criterion_definitions[id]

  assert.match(guidance('scene-entity-transitions'), /fixed configured delay that meets this is the fixture's own mechanism/)
  assert.match(guidance('scene-entity-transitions'), /same delay is also applied to the continuing entities' layout motion/)
  assert.doesNotMatch(guidance('scene-entity-transitions'), /use the same settlement contract/)
  assert.match(guidance('verification-addressing-and-errors'), /one representative browser-error test/)
  assert.match(guidance('verification-addressing-and-errors'), /fresh port it reserved itself[\s\S]*raced against the spawned child's exit/)
  assert.match(guidance('verification-missing-sample'), /unrelated browser or render timeout does not name the failed phase/)
  assert.match(guidance('scene-modes-and-navigation'), /the marker is a visible indicator/)
  assert.match(guidance('scene-fixed-canvas-uniform-fit'), /1280×720 \(wide\) and 390×844 \(narrow\)/)
  assert.match(guidance('verification-warnings'), /chrome counts whether or not it contains text/)
  assert.match(guidance('assumption-handling-quality-criteria'), /Never score silence above candor/)
  assert.match(guidance('assumption-handling-quality-criteria'), /count of open decisions with only a pointer/)
  assert.match(definition('testing-evidence-traceable-coverage'), /could not exercise[\s\S]*does not count against coverage/)
  assert.match(definition('testing-evidence-final-revision-applicability'), /A changed command counts as explored when the pass ran it/)
  assert.match(definition('testing-evidence-complete-honest-record'), /exploration plan commits to exercising/)
})

// Round-2 audit: criteria judges split on because the guidance left a term open.
test('rubric 10.0 defines the terms round 2 judged inconsistently', async () => {
  const rubric = await automatedRubric()
  const rows = rubric.components.flatMap(({ subcomponents }) => subcomponents)
  const guidance = (id) => rows.find((row) => row.id === id).review_guidance.join('\n')
  const definition = (id) => rows.find((row) => row.criterion_definitions?.[id]).criterion_definitions[id]

  assert.match(guidance('scene-step-model'), /computed from the step's array position or index[^.]*is not stable/)
  assert.match(guidance('verification-warnings'), /without visible text its accessible name, a stable hook/)
  assert.match(guidance('verification-warnings'), /An empty string[^.]*does not identify it/)
  assert.match(guidance('scene-entity-transitions'), /Judge the visible entry, not each wrapper/)
  assert.match(guidance('demo-identity-and-grouping'), /do not require the sample deck to rearrange/)
  assert.match(guidance('skill-scaffolding'), /includes a partially scaffolded project/)
  assert.match(guidance('assumption-handling-quality-criteria'), /reproduced only when the record shows the workflow observed/)
  assert.match(guidance('assumption-handling-quality-criteria'), /check for unsurfaced requirement deviations/)
  assert.match(guidance('assumption-handling-quality-criteria'), /omits it entirely, also fail assumption-repository-facts-distinguished/)
  assert.match(definition('testing-evidence-complete-honest-record'), /Only a material omission counts/)
  assert.match(definition('testing-evidence-final-revision-applicability'), /mirror group/)
  assert.match(definition('testing-evidence-final-revision-applicability'), /acceptance workflow forbids running it/)
  assert.match(definition('testing-evidence-final-revision-applicability'), /retest_scope fact[^.]*never decides exploration/)
  assert.match(definition('testing-evidence-usable-proof'), /A stated limitation[^.]*is a disclosure, not a claim/)
})

// Round-3 audit: one plan omission cost three criteria, and two phrases let
// samples split on identical evidence.
test('rubric 11.0 scores each omission once and settles the round-3 splits', async () => {
  const rubric = await automatedRubric()
  const rows = rubric.components.flatMap(({ subcomponents }) => subcomponents)
  const guidance = (id) => rows.find((row) => row.id === id).review_guidance.join('\n')
  assert.match(guidance('assumption-handling-quality-criteria'), /Do not fail it for a plan commitment[^.]*\./)
  assert.doesNotMatch(guidance('assumption-handling-quality-criteria'), /every behavior the exploration plan commits to exercising that the exploration log/)
  assert.match(guidance('assumption-handling-quality-criteria'), /A material limitation here is one the record itself identifies elsewhere/)
  assert.match(guidance('verification-warnings'), /a stable hook or selector of that chrome[^.]*says which chrome it is/)
  assert.match(rubric.fallbacks['quality-captions-and-navigation'].guidance.join('\n'), /Captions are met in browse mode/)
  assert.match(rubric.fallbacks['quality-captions-and-navigation'].guidance.join('\n'), /without the previous\/next controls/)
  // Round 4b: samples split on whether a changed verify script is covered by
  // the acceptance skill's ban on automated suites.
  const definition = (id) => rows.find((row) => row.criterion_definitions?.[id]).criterion_definitions[id]
  assert.match(definition('testing-evidence-final-revision-applicability'), /changed verification or test script counts as explored even though the record does not name that script/)
  // Round 4b: two span audits failed controls-keep-keys for a slider the deck never renders.
  assert.match(guidance('scene-modes-and-navigation'), /do not fail the criterion for a hypothetical control type/)
})

// Round-4 audit: judges invented a partial-deletion scenario for a missing
// sample and split on whether a type-checked build proves a typed boundary.
test('rubric 12.0 defines a missing sample and what proves a compile-time claim', async () => {
  const rubric = await automatedRubric()
  const rows = rubric.components.flatMap(({ subcomponents }) => subcomponents)
  const guidance = (id) => rows.find((row) => row.id === id).review_guidance.join('\n')
  const definition = (id) => rows.find((row) => row.criterion_definitions?.[id]).criterion_definitions[id]
  assert.match(guidance('verification-missing-sample'), /A missing sample means the reference presentation is not registered/)
  assert.match(guidance('verification-missing-sample'), /names the build or sample phase satisfies the criterion/)
  assert.match(guidance('verification-missing-sample'), /Do not construct partial-deletion scenarios/)
  assert.match(definition('testing-evidence-usable-proof'), /proven by a recorded successful type-checked build/)
  // Sanity rescore at 12.0.0: samples failed honest-record because uniform
  // scaling was observed only as the scene fitting the viewport.
  assert.match(definition('testing-evidence-complete-honest-record'), /internal properties a viewer cannot see[^.]*need no separate observation/)
})

// Round-5 audit: rep-2-a failed skill-failures-fixed-before-success on a
// strict reading that every check type must be named.
// #78 rep 2: judges split on a presentation whose own CSS moved the kit's
// bottom-right default attribution to the top right and hid it in present mode.
test('rubric 12.4 judges attribution-default-link on the kit default only', async () => {
  const rubric = await automatedRubric()
  const guidance = rubric.components.flatMap(({ subcomponents }) => subcomponents)
    .flatMap(({ review_guidance = [] }) => review_guidance)
    .filter((line) => line.startsWith('For attribution-default-link')).join('\n')
  assert.match(guidance, /Judge the kit's default only/)
  assert.match(guidance, /moves the link away from the bottom-right or hides it in present mode does not fail this criterion/)
})

test('rubric 12.2 credits a general fix-and-rerun gate for skill failures', async () => {
  const rubric = await automatedRubric()
  const guidance = rubric.components.flatMap(({ subcomponents }) => subcomponents)
    .find(({ id }) => id === 'skill-self-verification').review_guidance.join('\n')
  assert.match(guidance, /credit a general instruction to fix failures and re-run the checks/)
  // Round-6 audit: "any check" went beyond the fixture's build, render, and
  // visual composition checks.
  assert.match(guidance, /reporting success while a build or render failure remains/)
  assert.match(guidance, /fixing visual composition findings and re-inspecting satisfies the visual check/)
  assert.match(guidance, /Do not fail it for a failure mode of a check tool the instructions do not mention/)
  assert.doesNotMatch(guidance, /while any check fails/)
  assert.match(guidance, /need not name each check type/)
  assert.match(guidance, /allow completing with a failing check/)
  assert.match(guidance, /pass\/fail field in a completion report format is not a permission/)
})

// Issue #77 class A coverage audit (openspec/changes/eval-validator/class-a-coverage.md):
// proposals P5, P6, and P7 restate fixture requirements the existing guidance missed.
test('rubric 14.0 adds the class A coverage guidance for narrow viewports, kit parity, and step hooks', async () => {
  const rubric = await automatedRubric()
  const rows = rubric.components.flatMap(({ subcomponents }) => subcomponents)
  const lines = (id) => rows.find((row) => row.id === id).review_guidance
  const line = (id, prefix) => lines(id).find((item) => item.startsWith(prefix))

  const p5 = line('skill-self-verification', 'For skill-checks-run-before-done, the fixture')
  assert.ok(p5, 'P5 guidance on skill-self-verification')
  assert.match(p5, /responsive-sensitive presentations are also checked at a narrow viewport/)
  assert.match(p5, /Fail when the instructions' visual composition check never directs a narrow-viewport check/)
  assert.match(p5, /screenshot helper need not capture the narrow viewport/)

  const p6 = line('skill-scaffolding', 'For skill-empty-directory-scaffold, the scene kit in the bootstrap template')
  assert.ok(p6, 'P6 guidance on skill-scaffolding')
  assert.match(p6, /snapshot of the canonical src\/presentation-kit\//)
  assert.match(p6, /differs in behavior or public types from its canonical counterpart/)
  assert.match(p6, /Formatting-only differences do not fail/)

  const p7 = line('verification-addressing-and-errors', 'For verification-step-error-fails, the verifier must not')
  assert.ok(p7, 'P7 guidance on verification-addressing-and-errors')
  assert.match(p7, /missing, zero, or non-numeric data-step-count or data-step-index as progress/)
  assert.match(p7, /Number\(null\) === 0/)
  assert.match(p7, /unreadable step count makes the verifier step through no steps and still pass/)
  // The inspect helper stays with the engineering criterion; P7 judges verify only.
  assert.match(p7, /inspect helper's handling of the same hooks is scored by engineering-inspect-fails-loudly, not here/)
  assert.ok(!lines('verification-addressing-and-errors').some((item) => /engineering-inspect-fails-loudly/.test(item) && item !== p7))
})

// Issue #77 class A item B7, adopted by Paul's decision after review: the
// scaffold's render-verification dependencies include the Playwright Chromium
// browser, which the fixture design installs in the verify step.
test('rubric 14.0 fails a scaffold that never installs or checks for the Chromium browser', async () => {
  const rubric = await automatedRubric()
  const rows = rubric.components.flatMap(({ subcomponents }) => subcomponents)
  const b7 = rows.find((row) => row.id === 'skill-scaffolding').review_guidance
    .find((item) => item.startsWith('For skill-empty-directory-scaffold, the dependencies needed for render verification'))
  assert.ok(b7, 'B7 guidance on skill-scaffolding')
  assert.match(b7, /Playwright Chromium browser/)
  assert.match(b7, /Credit SKILL\.md, the bootstrap scripts, or the verify step when they install Chromium or check that it is available before the render check/)
  assert.match(b7, /Fail when none of them installs it or checks for it/)

  const citations = rubric.criterion_sources['skill-empty-directory-scaffold'].sources
  assert.ok(citations?.some(({ document, quote }) => (
    document === 'openspec/changes/create-and-scene/specs/presentation-skill/spec.md' && /render verification/.test(quote))))
  assert.ok(citations?.some(({ document, heading, quote }) => (
    document === 'openspec/changes/create-and-scene/design.md' && heading === 'Risks / Trade-offs'
      && /Install Chromium in the verify step/.test(quote))))
})

// Issue #77: engineering quality a good implementation has even though the
// fixture's planning documents do not require it.
const ENGINEERING_ROWS = [
  ['engineering-input-hygiene', 2, 'deterministic-browser', null, [
    'input-modifier-keys-pass-through',
    'input-swipe-from-control-ignored',
  ]],
  ['engineering-verification-tooling-robustness', 3, 'llm-source-review', 'engineering-quality', [
    'engineering-preview-terminated-on-every-exit',
    'engineering-preview-readiness-bounded',
    'engineering-bootstrap-scripts-generic',
    'engineering-inspect-fails-loudly',
    'engineering-checks-read-rendered-page',
    'engineering-diagnostics-cover-presentation',
  ]],
  ['engineering-skill-instructions-and-templates', 1.5, 'llm-source-review', 'engineering-quality', [
    'engineering-templates-build-at-destination',
    'engineering-skill-description-triggers',
    'engineering-skill-out-of-scope-redirects',
    'engineering-skill-completion-report',
  ]],
  ['engineering-presentation-code-and-tests', 1.5, 'llm-source-review', 'engineering-quality', [
    'engineering-presentation-css-scoped',
    'engineering-typed-kit-primitives',
    'engineering-tests-wait-on-state',
    'engineering-tests-isolate-resources',
  ]],
]
const ENGINEERING_IDS = ENGINEERING_ROWS.flatMap(([, , , , criteria]) => criteria)

function engineeringComponent(rubric) {
  return rubric.components.find(({ id }) => id === 'engineering-quality')
}

test('rubric 14.0 adds the eight-point engineering-quality component with sixteen classified criteria', async () => {
  const rubric = await automatedRubric()
  const component = engineeringComponent(rubric)
  assert.equal(component.title, 'Engineering quality beyond the spec')
  assert.equal(component.points, 8)
  assert.equal(component.floor, null)
  assert.notEqual(component.reference_applicable, false)
  assert.deepEqual(
    component.subcomponents.map(({ id, points, evaluator, job, criteria }) => [id, points, evaluator, job ?? null, criteria]),
    ENGINEERING_ROWS,
  )
  assert.equal(ENGINEERING_IDS.length, 16)
  const rows = rubricCriteria(rubric)
  for (const id of ENGINEERING_IDS) {
    assert.equal(rows.filter((row) => row.id === id).length, 1, id)
    assert.equal(LEGACY_CRITERION_IDS.includes(id), false, id)
  }
  // Both probes fall back to demo integration, so the engineering-quality job
  // always judges exactly its fourteen source-reviewed criteria.
  for (const id of ENGINEERING_ROWS[0][4]) {
    assert.equal(rubric.fallbacks[id]?.job, 'demo-integration', id)
    assert.ok(rubric.fallbacks[id].requirement.length > 0, id)
  }
  assert.equal(rows.filter(({ job }) => job === 'engineering-quality').length, 14)
})

test('every engineering-quality criterion is eval-owned and its reason states its full pass condition', async () => {
  const rubric = await automatedRubric()
  const reason = (id) => {
    const source = rubric.criterion_sources[id]
    assert.equal(source?.owner, 'eval', id)
    return source.reason
  }
  const expectations = {
    'input-modifier-keys-pass-through': [/neither the first nor the last/, /Alt, Control, and Meta/, /ArrowRight and ArrowLeft/, /preventDefault/, /step index/, /leave the presentation document/i],
    'input-swipe-from-control-ignored': [/horizontal single-touch swipe/, /starts on an interactive control/, /touch events/, /pointer events/, /only control available is a step control/, /own activation target/],
    'engineering-preview-terminated-on-every-exit': [/every exit path/, /browser launch failure/, /bootstrap template copies/, /npm or npx wrapper/, /preview\(\) API/],
    'engineering-preview-readiness-bounded': [/timeout/, /after the build/, /ANSI colour codes/, /split across chunks/],
    'engineering-bootstrap-scripts-generic': [/argument, or verify every registered route/, /unregistered slug/, /non-zero failure/, /landing-page fallback/, /reference sample/],
    'engineering-inspect-fails-loudly': [/missing, zero, or non-numeric/, /reported step index equals/, /zero captures/],
    'engineering-checks-read-rendered-page': [/titles, captions, outline order, and registration/, /rendered page at each step/, /regular expressions over source text/],
    'engineering-diagnostics-cover-presentation': [/every captured step/, /chrome rather than only a cropped scene/],
    'engineering-templates-build-at-destination': [/step, presentation, and inspect template/, /type-check and build/, /documented destination/, /relative imports, CSS imports, required props, and field names/, /focused test/],
    'engineering-skill-description-triggers': [/third person/, /when to use the skill/, /at least two example user phrases/],
    'engineering-skill-out-of-scope-redirects': [/PowerPoint or Keynote output/, /PDF or image export/, /visual editor/, /hosting/, /redirect/],
    'engineering-skill-completion-report': [/completion-report template/, /presentation route/, /files changed/, /build, render, and inspect results/, /advisory warnings/],
    'engineering-presentation-css-scoped': [/every selector/, /root class or hook/, /CSS module/, /`\.presentation-attribution`/, /host-owned global stylesheet/i],
    'engineering-typed-kit-primitives': [/rendered element's props/, /Record<string, unknown>/, /after caller props/, /data-presentation-\*/, /layoutId/, /off the DOM/],
    'engineering-tests-wait-on-state': [/observable state/, /polling or auto-waiting assertion/, /fixed sleeps/, /returns immediately/],
    'engineering-tests-isolate-resources': [/allocate ports dynamically/, /terminate every process they start/],
  }
  assert.deepEqual(Object.keys(expectations).sort(), [...ENGINEERING_IDS].sort())
  for (const [id, patterns] of Object.entries(expectations)) {
    for (const pattern of patterns) assert.match(reason(id), pattern, `${id}: ${pattern}`)
  }
})

test('engineering-quality guidance carries each double-counting boundary, the fail cases, and the noise exclusions', async () => {
  const rubric = await automatedRubric()
  const guidance = (id) => engineeringComponent(rubric).subcomponents.find((row) => row.id === id).review_guidance.join('\n')
  const tooling = guidance('engineering-verification-tooling-robustness')
  const skill = guidance('engineering-skill-instructions-and-templates')
  const code = guidance('engineering-presentation-code-and-tests')

  // Boundaries from the design's double-counting table.
  assert.match(tooling, /scored only by verification-preview-process-ownership/)
  assert.match(tooling, /verification-step-error-fails/)
  assert.match(tooling, /visual-helper-\* criteria/)
  assert.match(skill, /skill-template-path-resolution/)
  assert.match(skill, /skill-checks-run-before-done and skill-failures-fixed-before-success/)
  assert.match(skill, /No existing criterion scores the description or the out-of-scope section/)
  assert.match(code, /attribution-styling-hook/)
  assert.match(code, /skill-presentation-owns-style/)
  assert.match(code, /host-owned global stylesheet may style kit hooks/i)
  // Explicit fail cases from the spec scenarios.
  assert.match(tooling, /kills only an npm or npx wrapper/)
  assert.match(tooling, /browser launch failure/)
  assert.match(tooling, /ANSI colour codes/)
  assert.match(tooling, /first registry entry/)
  assert.match(tooling, /zero captures/)
  assert.match(tooling, /only on the final step|only on one step/)
  assert.match(tooling, /cropped scene/)
  assert.match(skill, /resolves outside the project's src directory/)
  assert.match(skill, /without a prop the kit's types require/)
  assert.match(skill, /first-person description/i)
  assert.match(skill, /gives no redirect/)
  assert.match(code, /spreads caller props after/)
  assert.match(code, /fixed number of milliseconds|fixed sleep/)
  assert.match(code, /same hardcoded port/)
  // Validator noise is not rewarded, wherever an engineering criterion is judged.
  for (const text of [tooling, skill, code]) {
    assert.match(text, /runtime step-list changes beyond clamping at the ends/)
    assert.match(text, /syntax that never occurs/)
    assert.match(text, /hosting concerns the proposal excludes/)
    assert.match(text, /longer fixed settle delays/)
    assert.match(text, /arrow keys driving the deck while an interactive control holds focus/)
  }
  assert.match(tooling, /performance of the overlap scan/)
})

test('concrete values in engineering-quality guidance are accounted for as eval-owned values', async () => {
  const rubric = await automatedRubric()
  const owned = new Map(rubric.eval_owned_values.map(({ value, reason }) => [value, reason]))
  for (const value of [
    'PowerPoint', 'Keynote', 'PDF or image export', 'visual editor', 'hosting',
    'data-presentation', '.presentation-attribution', 'layoutId',
  ]) {
    assert.ok(owned.get(value)?.trim().length > 0, `${value} needs an eval-owned value entry with a reason`)
  }
})

test('rubric validation keeps the engineering-quality criteria classified and eval-owned', async () => {
  const rubric = await automatedRubric()
  const subcomponent = (copy, id) => engineeringComponent(copy).subcomponents.find((row) => row.id === id)

  const fixtureOwned = structuredClone(rubric)
  fixtureOwned.criterion_sources['engineering-tests-wait-on-state'] = {
    owner: 'fixture', document: 'x', heading: 'y', quote: 'z',
  }
  assert.match(validateAutomatedRubric(fixtureOwned).join('\n'), /engineering-tests-wait-on-state must be eval-owned/)

  const moved = structuredClone(rubric)
  subcomponent(moved, 'engineering-presentation-code-and-tests').criteria.pop()
  subcomponent(moved, 'engineering-skill-instructions-and-templates').criteria.push('engineering-tests-isolate-resources')
  assert.match(validateAutomatedRubric(moved).join('\n'), /engineering-quality must own exactly its approved criteria/)

  const missing = structuredClone(rubric)
  subcomponent(missing, 'engineering-presentation-code-and-tests').criteria.pop()
  assert.match(validateAutomatedRubric(missing).join('\n'), /engineering-quality must own exactly its approved criteria/)

  const otherJob = structuredClone(rubric)
  subcomponent(otherJob, 'engineering-skill-instructions-and-templates').job = 'presentation-skill'
  assert.match(validateAutomatedRubric(otherJob).join('\n'), /engineering-quality must own exactly its approved criteria/)

  const misweighted = structuredClone(rubric)
  engineeringComponent(misweighted).points = 9
  subcomponent(misweighted, 'engineering-input-hygiene').points = 3
  assert.match(validateAutomatedRubric(misweighted).join('\n'), /approved 20\/20\/7\/7\/8\/4\/4 allocation and floors/)
})

test('rubric validation rejects an engineering criterion moved across a subcomponent boundary', async () => {
  const rubric = await automatedRubric()
  const subcomponent = (copy, id) => engineeringComponent(copy).subcomponents.find((row) => row.id === id)
  const id = 'engineering-templates-build-at-destination'

  // Moving the first criterion of one subcomponent to the end of the previous
  // one keeps the flattened criterion order but changes its point share.
  const moved = structuredClone(rubric)
  const from = subcomponent(moved, 'engineering-skill-instructions-and-templates')
  const to = subcomponent(moved, 'engineering-verification-tooling-robustness')
  assert.equal(from.criteria.shift(), id)
  to.criteria.push(id)

  const before = rubricCriteria(rubric).find((row) => row.id === id)
  const after = rubricCriteria(moved).find((row) => row.id === id)
  assert.notEqual(after.criterion_points, before.criterion_points)
  assert.match(
    validateAutomatedRubric(moved).join('\n'),
    /subcomponent engineering-verification-tooling-robustness must own exactly its approved engineering-quality criteria/,
  )
  assert.match(
    validateAutomatedRubric(moved).join('\n'),
    /subcomponent engineering-skill-instructions-and-templates must own exactly its approved engineering-quality criteria/,
  )
})

test('rubric validation rejects engineering points moved between subcomponents', async () => {
  const moved = structuredClone(await automatedRubric())
  const subcomponent = (id) => engineeringComponent(moved).subcomponents.find((row) => row.id === id)
  // The component total and criterion membership stay the same, but each
  // criterion's share of the points changes.
  subcomponent('engineering-verification-tooling-robustness').points -= 0.5
  subcomponent('engineering-presentation-code-and-tests').points += 0.5
  assert.match(
    validateAutomatedRubric(moved).join('\n'),
    /subcomponent engineering-verification-tooling-robustness must award its approved 3 points/,
  )
})
