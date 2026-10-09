import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderReport } from '../evals/agent-runner/and-scene/lib/report.mjs'
import {
  criteriaForJob, deterministicCriteria, loadRubrics, validateAutomatedRubric,
} from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { scoreProduct } from '../evals/agent-runner/and-scene/lib/scorer.mjs'

const rubrics = await loadRubrics()
const automated = rubrics.automated.rubric

const JOBS = [
  'demo-integration',
  'scene-kit',
  'presentation-skill',
  'verification-tooling',
  'engineering-quality',
  'testing-evidence',
  'assumption-handling',
]
const GATE_IDS = automated.gates.map(({ id }) => id)

function verdicts(ids, failures) {
  return ids.map((id) => ({
    id,
    verdict: failures.includes(id) ? 'fail' : 'pass',
    rationale: 'observed in the delivered implementation',
    evidence: ['src/example.tsx:1'],
  }))
}

function inputs({ failures = [], gateFailures = [], omit = [], humanReview = null } = {}) {
  const absent = new Set(omit)
  const judges = {}
  for (const job of JOBS) {
    judges[job] = absent.has(job) ? null : verdicts(criteriaForJob(automated, job), failures)
  }
  return {
    rubrics,
    deterministic: absent.has('deterministic') ? null : verdicts(deterministicCriteria(automated), failures),
    judges,
    gates: absent.has('gates') ? null : verdicts(GATE_IDS, gateFailures),
    humanReview,
  }
}

const fullHumanReview = { total: 30, ratings: Array.from({ length: 7 }, () => 5) }

function component(result, id) {
  return result.components.find((entry) => entry.id === id)
}

function subcomponentCriteria(componentId, subcomponentId) {
  return automated.components
    .find(({ id }) => id === componentId)
    .subcomponents.find(({ id }) => id === subcomponentId)
    .criteria
}

test('an all-pass automated evaluation scores the full 70-point subtotal', () => {
  const result = scoreProduct(inputs())

  assert.equal(result.automated_subtotal.points, 70)
  assert.equal(result.automated_subtotal.possible, 70)
  assert.equal(result.automated_subtotal.complete, true)
  assert.deepEqual(
    result.components.map(({ id, points_awarded }) => [id, points_awarded]),
    [
      ['demo-technical-quality', 20],
      ['scene-kit-correctness', 20],
      ['presentation-skill-correctness', 7],
      ['verification-tool-correctness', 7],
      ['engineering-quality', 8],
      ['testing-evidence-quality', 4],
      ['assumption-handling-quality', 4],
    ],
  )
  assert.ok(result.components.every(({ applicable, points_possible }) => applicable && points_possible > 0))
  assert.equal(result.score_denominator, 100)
  assert.ok(result.components.every(({ complete }) => complete))
  assert.equal(result.gates_passed, true)
})

test('a not-observed scene criterion is resolved by its declared fallback judge', () => {
  const data = inputs()
  data.deterministic = data.deterministic.map((row) => row.id === 'demo-evolving-scene-structure'
    ? { ...row, verdict: null, outcome: 'not-observed', looked_for: ['data-layout-id'], observed: false }
    : row)
  data.judges['demo-integration'] = [
    ...data.judges['demo-integration'],
    { id: 'demo-evolving-scene-structure', verdict: 'pass', rationale: 'stable identities are in source', evidence: ['src/demo.tsx'], citations: ['src/demo.tsx'] },
  ]

  const result = scoreProduct(data)
  const criterion = component(result, 'demo-technical-quality').subcomponents
    .find(({ id }) => id === 'demo-canonical-content').criteria
    .find(({ id }) => id === 'demo-evolving-scene-structure')
  assert.equal(criterion.verdict, 'pass')
  assert.equal(criterion.verdict_source, 'fallback')
  assert.equal(criterion.fallback_job, 'demo-integration')
  assert.equal(result.fallback.criteria, 1)
  // A critical demo criterion earns 2 points whoever decides it.
  assert.equal(criterion.tier, 'critical')
  assert.equal(result.fallback.points, 2)
})

test('a pending human review reports the subtotal but no official total or verdict', () => {
  const result = scoreProduct(inputs())

  assert.equal(result.automated_pass_threshold, 40)
  assert.equal(result.automated_pass, true)
  assert.deepEqual(result.automated_failures, [])
  assert.equal(result.human_review, null)
  assert.equal(result.official_score, null)
  assert.equal(result.official_pass, null)
  assert.deepEqual(result.incomplete, ['human-review'])
})

function engineeringCriteria() {
  return automated.components.find(({ id }) => id === 'engineering-quality')
    .subcomponents.flatMap(({ criteria }) => criteria)
}

test('an automated subtotal of exactly 40 remains eligible for human review', () => {
  const failures = [
    ...criteriaForJob(automated, 'presentation-skill'),
    ...criteriaForJob(automated, 'verification-tooling'),
    ...criteriaForJob(automated, 'testing-evidence'),
    ...criteriaForJob(automated, 'assumption-handling'),
    ...engineeringCriteria(),
  ]

  const result = scoreProduct(inputs({ failures }))

  assert.equal(result.automated_subtotal.points, 40)
  assert.equal(component(result, 'demo-technical-quality').points_awarded, 20)
  assert.equal(component(result, 'engineering-quality').points_awarded, 0)
  assert.equal(result.automated_pass, true)
  assert.deepEqual(result.automated_failures, [])
})

test('a complete automated subtotal below 40 fails before human review', () => {
  const failures = [
    ...criteriaForJob(automated, 'presentation-skill'),
    ...criteriaForJob(automated, 'verification-tooling'),
    ...criteriaForJob(automated, 'testing-evidence'),
    ...criteriaForJob(automated, 'assumption-handling'),
    ...engineeringCriteria(),
    // A major demo criterion is worth exactly 1 point.
    'demo-present-mode-behavior',
  ]

  const result = scoreProduct(inputs({ failures }))

  assert.equal(result.automated_subtotal.points, 39)
  assert.ok(component(result, 'demo-technical-quality').points_awarded >= 12.5)
  assert.ok(component(result, 'scene-kit-correctness').points_awarded >= 12.5)
  assert.equal(result.automated_pass, false)
  assert.deepEqual(result.automated_failures.filter(({ rule }) => rule !== 'hard-gate'), [{
    rule: 'automated-total',
    id: null,
    value: result.automated_subtotal.points,
    required: 40,
  }])
})

test('component floors and hard gates fail automated eligibility before human review', () => {
  const floorFailure = scoreProduct(inputs({ failures: deterministicCriteria(automated) }))
  assert.equal(floorFailure.human_review, null)
  assert.equal(floorFailure.automated_pass, false)
  assert.ok(floorFailure.automated_failures.some(
    ({ rule, id }) => rule === 'component-floor' && id === 'demo-technical-quality',
  ))

  const gate = GATE_IDS[0]
  const gateFailure = scoreProduct(inputs({ gateFailures: [gate] }))
  assert.equal(gateFailure.human_review, null)
  assert.equal(gateFailure.automated_pass, false)
  assert.ok(gateFailure.automated_failures.some(
    ({ rule, id }) => rule === 'hard-gate' && id === gate,
  ))
})

test('a completed human review produces the official 100-point score and pass verdict', () => {
  const result = scoreProduct(inputs({ humanReview: fullHumanReview }))

  assert.equal(result.human_review.points, 30)
  assert.equal(result.official_score, 100)
  assert.equal(result.official_pass, true)
  assert.deepEqual(result.pass_failures, [])
  assert.deepEqual(result.incomplete, [])
})

test('each criterion earns its tier weight without rounding', () => {
  const result = scoreProduct(inputs({ failures: ['attribution-top-left-opt-in', 'navigation-keyboard'] }))
  const kit = component(result, 'scene-kit-correctness')
  const style = kit.subcomponents.find(({ id }) => id === 'scene-style-and-attribution')
  const navigation = kit.subcomponents.find(({ id }) => id === 'scene-modes-and-navigation')

  // The subcomponent reports the sum of its criteria's weights: two majors at
  // 0.75 and five minors at 0.25.
  assert.equal(style.points_possible, 2.75)
  assert.equal(style.points_awarded, 2.5)
  const failed = style.criteria.find(({ id }) => id === 'attribution-top-left-opt-in')
  assert.deepEqual([failed.tier, failed.points_possible, failed.points_awarded], ['minor', 0.25, 0])
  // A critical scene-kit criterion is worth 1.5625, a sixteenth-exact weight.
  assert.equal(navigation.points_possible, 7.3125)
  assert.equal(navigation.points_awarded, 5.75)
  assert.equal(kit.points_awarded, 18.1875)
  assert.equal(result.automated_subtotal.points, 68.1875)
})

test('engineering quality awards each criterion its tier weight', () => {
  const result = scoreProduct(inputs({ failures: [
    'engineering-skill-out-of-scope-redirects', 'engineering-tests-wait-on-state',
    'input-swipe-from-control-ignored', 'engineering-inspect-fails-loudly',
  ] }))
  const engineering = component(result, 'engineering-quality')
  const row = (id) => engineering.subcomponents.find((subcomponent) => subcomponent.id === id)

  assert.equal(engineering.points_possible, 8)
  assert.equal(engineering.floor, null)
  // Each failure is a minor criterion worth 0.375.
  assert.equal(row('engineering-input-hygiene').points_awarded, 0.375)
  assert.equal(row('engineering-verification-tooling-robustness').points_awarded, 2.625)
  assert.equal(row('engineering-skill-instructions-and-templates').points_awarded, 2.125)
  assert.equal(row('engineering-presentation-code-and-tests').points_awarded, 1.375)
  assert.equal(engineering.points_awarded, 6.5)
  assert.equal(result.automated_subtotal.points, 68.5)
  assert.equal(result.automated_subtotal.possible, 70)
})

test('both automated floors hold at exactly 12.5 of 20 and fail just below it', () => {
  // 7.5 of 20 demo points: two majors, two criticals, and three minors.
  const demoAtFloor = [
    'demo-mode-interaction-reliability', 'demo-control-semantics',
    ...subcomponentCriteria('demo-technical-quality', 'demo-scene-kit-integration'),
    ...subcomponentCriteria('demo-technical-quality', 'demo-identity-and-grouping'),
    ...subcomponentCriteria('demo-technical-quality', 'demo-code-boundaries'),
  ]
  // 7.5 of 20 scene-kit points: four criticals, a major, and two minors.
  const kitAtFloor = [
    ...subcomponentCriteria('scene-kit-correctness', 'scene-step-model'),
    'entity-persisting-morph', 'grouped-scene-updates-in-place', 'navigation-keyboard', 'navigation-clamp-start',
  ]
  const atFloor = scoreProduct(inputs({ failures: [...demoAtFloor, ...kitAtFloor], humanReview: fullHumanReview }))
  assert.equal(component(atFloor, 'demo-technical-quality').points_awarded, 12.5)
  assert.equal(component(atFloor, 'scene-kit-correctness').points_awarded, 12.5)
  assert.equal(component(atFloor, 'demo-technical-quality').floor, 12.5)
  assert.equal(component(atFloor, 'scene-kit-correctness').floor, 12.5)
  assert.equal(atFloor.automated_subtotal.points, 55)
  assert.deepEqual(atFloor.automated_failures, [])
  assert.equal(atFloor.automated_pass, true)
  assert.equal(atFloor.official_pass, true)

  const belowFloor = scoreProduct(inputs({
    failures: [
      ...demoAtFloor, ...kitAtFloor,
      'demo-step-and-transition-reliability', 'navigation-clamp-end',
    ],
  }))
  assert.equal(belowFloor.automated_pass, false)
  assert.deepEqual(
    belowFloor.automated_failures.filter(({ rule }) => rule === 'component-floor').map(({ id, required }) => [id, required]),
    [['demo-technical-quality', 12.5], ['scene-kit-correctness', 12.5]],
  )
})

test('every criterion result records its identifier, verdict, rationale, and cited evidence', () => {
  const result = scoreProduct(inputs())
  const criteria = result.components.flatMap((entry) => entry.subcomponents.flatMap(({ criteria: rows }) => rows))

  // Every listed criterion, including the two zero-point gate inputs.
  assert.equal(criteria.length, 102)
  assert.ok(criteria.every(({ id, verdict, rationale, evidence }) => (
    typeof id === 'string' && ['pass', 'fail'].includes(verdict)
      && rationale.length > 0 && Array.isArray(evidence)
  )))
})

test('a total below the pass threshold fails the official verdict', () => {
  // Drop the whole skill and verification components plus most of the scene kit.
  const failures = [
    ...criteriaForJob(automated, 'presentation-skill'),
    ...criteriaForJob(automated, 'verification-tooling'),
    ...criteriaForJob(automated, 'scene-kit').slice(0, 20),
    ...engineeringCriteria(),
  ]
  const result = scoreProduct(inputs({ failures, humanReview: fullHumanReview }))

  assert.ok(result.official_score < 70)
  assert.equal(result.official_pass, false)
  assert.ok(result.pass_failures.some((entry) => entry.rule === 'total'))
})

test('missing a component floor fails the official verdict even above the total threshold', () => {
  const demoFloor = scoreProduct(inputs({
    failures: deterministicCriteria(automated),
    humanReview: fullHumanReview,
  }))
  assert.ok(component(demoFloor, 'demo-technical-quality').points_awarded < 12.5)
  assert.ok(demoFloor.official_score >= 70)
  assert.equal(demoFloor.official_pass, false)
  assert.ok(demoFloor.pass_failures.some((entry) => entry.rule === 'component-floor'))

  const kitFloor = scoreProduct(inputs({
    failures: criteriaForJob(automated, 'scene-kit').slice(0, 24),
    humanReview: fullHumanReview,
  }))
  assert.ok(component(kitFloor, 'scene-kit-correctness').points_awarded < 12.5)
  assert.equal(kitFloor.official_pass, false)

  const humanFloor = scoreProduct(inputs({
    humanReview: { total: 14, ratings: Array.from({ length: 7 }, () => 3) },
  }))
  assert.equal(humanFloor.official_score, 84)
  assert.equal(humanFloor.official_pass, false)
  assert.ok(humanFloor.pass_failures.some((entry) => entry.rule === 'human-floor'))
})

test('any individual human rating of one fails the official verdict', () => {
  const ratings = Array.from({ length: 7 }, () => 5)
  ratings[6] = 1
  const result = scoreProduct(inputs({ humanReview: { total: 28, ratings } }))

  assert.equal(result.official_score, 98)
  assert.equal(result.official_pass, false)
  assert.ok(result.pass_failures.some((entry) => entry.rule === 'human-rating-one'))
})

test('each hard gate blocks an official pass while preserving the numerical score', () => {
  for (const gate of GATE_IDS.filter((id) => id !== 'verification-sample-outline')) {
    const result = scoreProduct(inputs({ gateFailures: [gate], humanReview: fullHumanReview }))
    assert.equal(result.official_pass, false, gate)
    assert.ok(result.pass_failures.some((entry) => entry.rule === 'hard-gate' && entry.id === gate), gate)
    assert.equal(result.official_score, 100, gate)
    assert.equal(result.automated_subtotal.points, 70, gate)
  }
  const outline = scoreProduct(inputs({ gateFailures: ['verification-sample-outline'], humanReview: fullHumanReview }))
  assert.equal(outline.gates.find(({ id }) => id === 'verification-sample-outline').verdict, 'pass')
})

test('an audited second opinion awards points while retaining the raw failed verdict', () => {
  const id = 'demo-supported-navigation'
  const data = inputs({ failures: [id], gateFailures: ['verification-every-produced-step-renders'] })
  const raw = scoreProduct(data)
  const opinion = { raw_verdict: 'fail', verdict: 'pass', decision: 'overturn', rationale: 'input misread' }
  const scored = scoreProduct({ ...data, secondOpinions: {
    [id]: opinion, 'verification-every-produced-step-renders': opinion,
  } })
  const row = scored.components.flatMap(({ subcomponents }) => subcomponents.flatMap(({ criteria }) => criteria))
    .find((criterion) => criterion.id === id)
  assert.equal(row.verdict, 'pass')
  assert.equal(row.second_opinion.raw_verdict, 'fail')
  assert.ok(scored.automated_subtotal.points > raw.automated_subtotal.points)
  assert.equal(scored.gates.find(({ id: gate }) => gate === 'verification-every-produced-step-renders').verdict, 'pass')
})

test('scored criteria never include the four hard gates', () => {
  const result = scoreProduct(inputs())
  const scored = result.components
    .flatMap((entry) => entry.subcomponents.flatMap(({ criteria }) => criteria.map(({ id }) => id)))

  for (const gate of GATE_IDS) assert.equal(scored.includes(gate), false, gate)
})

test('missing, duplicate, unknown, and malformed criterion results fail validation', () => {
  const kitCriteria = criteriaForJob(automated, 'scene-kit')
  const withJudges = (results) => {
    const base = inputs()
    return { ...base, judges: { ...base.judges, 'scene-kit': results } }
  }

  assert.throws(
    () => scoreProduct(withJudges(verdicts(kitCriteria.slice(1), []))),
    /missing criterion results for scene-kit: scene-step-narration-and-identity/,
  )
  assert.throws(
    () => scoreProduct(withJudges([...verdicts(kitCriteria, []), ...verdicts(kitCriteria.slice(0, 1), [])])),
    /duplicate criterion results for scene-kit/,
  )
  assert.throws(
    () => scoreProduct(withJudges([
      ...verdicts(kitCriteria, []),
      { id: 'demo-scope-discipline', verdict: 'pass', rationale: 'r', evidence: ['src/demo.tsx:1'] },
    ])),
    /unknown criterion results for scene-kit: demo-scope-discipline/,
  )
  assert.throws(
    () => scoreProduct(withJudges(
      verdicts(kitCriteria, []).map((row, index) => index === 0 ? { ...row, verdict: 'maybe' } : row),
    )),
    /malformed criterion result/,
  )
  assert.throws(
    () => scoreProduct(withJudges(
      verdicts(kitCriteria, []).map((row, index) => index === 0 ? { ...row, rationale: '' } : row),
    )),
    /malformed criterion result/,
  )
})

test('unobserved evaluator output leaves its component incomplete instead of failing it', () => {
  const result = scoreProduct(inputs({ omit: ['scene-kit'] }))

  assert.equal(component(result, 'scene-kit-correctness').complete, false)
  assert.equal(component(result, 'scene-kit-correctness').points_awarded, null)
  // Components with complete evidence keep their scores.
  assert.equal(component(result, 'demo-technical-quality').points_awarded, 20)
  assert.equal(result.automated_subtotal.points, 50)
  assert.equal(result.automated_subtotal.possible, 70)
  assert.equal(result.automated_subtotal.complete, false)
  // The observed subtotal is never rescaled to hide the missing evidence.
  assert.equal(result.automated_subtotal.observed_possible, 50)
  assert.equal(result.official_score, null)
  assert.equal(result.official_pass, null)
  assert.equal(result.automated_pass, null)
  assert.deepEqual(result.automated_failures, [])
  assert.ok(result.incomplete.includes('scene-kit-correctness'))
})

test('a partially observed component keeps its deterministic score and marks judging incomplete', () => {
  const result = scoreProduct(inputs({ omit: ['demo-integration'] }))
  const demo = component(result, 'demo-technical-quality')

  assert.equal(demo.complete, false)
  assert.equal(demo.points_awarded, null)
  assert.equal(demo.points_observed, 14.5)
  assert.equal(
    demo.subcomponents.find(({ id }) => id === 'demo-canonical-content').points_awarded,
    5,
  )
  assert.equal(demo.subcomponents.find(({ id }) => id === 'demo-code-boundaries').points_awarded, null)
})

test('unobserved gates make the verdict unavailable without failing the gates', () => {
  const result = scoreProduct(inputs({ omit: ['gates'], humanReview: fullHumanReview }))

  assert.equal(result.gates_passed, null)
  assert.equal(result.official_pass, null)
  assert.ok(result.incomplete.includes('hard-gates'))
})

test('harness activity is recorded diagnostically and changes no product points', () => {
  const baseline = scoreProduct(inputs({ humanReview: fullHumanReview }))
  const withHarnessActivity = scoreProduct({
    ...inputs({ humanReview: fullHumanReview }),
    harness: {
      evidence_repair: { attempted: true, succeeded: false },
      judge_retries: { 'scene-kit': 2 },
      workflow_failures: 1,
    },
  })

  assert.equal(withHarnessActivity.automated_subtotal.points, baseline.automated_subtotal.points)
  assert.equal(withHarnessActivity.official_score, baseline.official_score)
  assert.equal(withHarnessActivity.official_pass, baseline.official_pass)
  assert.deepEqual(withHarnessActivity.harness, {
    evidence_repair: { attempted: true, succeeded: false },
    judge_retries: { 'scene-kit': 2 },
    workflow_failures: 1,
  })
})

test('the result records both rubric versions and hashes', () => {
  const result = scoreProduct(inputs())

  assert.equal(result.rubrics.automated.version, rubrics.automated.version)
  assert.equal(result.rubrics.automated.sha256, rubrics.automated.sha256)
  assert.equal(result.rubrics.human.version, rubrics.human.version)
  assert.equal(result.rubrics.human.sha256, rubrics.human.sha256)
  assert.notEqual(result.rubrics.automated.rubric_id, result.rubrics.human.rubric_id)
})

test('a malformed human review is rejected rather than scored', () => {
  assert.throws(
    () => scoreProduct(inputs({ humanReview: { total: 31, ratings: Array.from({ length: 7 }, () => 5) } })),
    /human review total/,
  )
  assert.throws(
    () => scoreProduct(inputs({ humanReview: { total: 20, ratings: Array.from({ length: 6 }, () => 4) } })),
    /human review requires 7 ratings/,
  )
  assert.throws(
    () => scoreProduct(inputs({ humanReview: { total: 20, ratings: Array.from({ length: 7 }, () => 9) } })),
    /human review rating/,
  )
})

test('a reference baseline excludes workflow-quality components without rescaling or a candidate verdict', () => {
  const baseline = scoreProduct({ ...inputs({ humanReview: fullHumanReview }), mode: 'reference-baseline' })

  assert.equal(baseline.automated_subtotal.points, 62)
  assert.equal(baseline.automated_subtotal.possible, 62)
  assert.equal(baseline.score_denominator, 92)
  assert.equal(baseline.official_score, 92)
  assert.equal(baseline.official_pass, null)
  assert.deepEqual(baseline.pass_failures, [])
  for (const id of ['testing-evidence-quality', 'assumption-handling-quality']) {
    assert.deepEqual(component(baseline, id), {
      id,
      title: component(baseline, id).title,
      applicable: false,
      points_possible: 0,
      points_awarded: null,
      points_observed: 0,
      points_observed_possible: 0,
      floor: null,
      complete: true,
      subcomponents: [],
    })
  }
})

test('the reference scores engineering quality within its shared 62 automated points', () => {
  const baseline = scoreProduct({ ...inputs({ humanReview: fullHumanReview }), mode: 'reference-baseline' })
  const engineering = component(baseline, 'engineering-quality')

  assert.equal(engineering.applicable, true)
  assert.equal(engineering.points_possible, 8)
  assert.equal(engineering.points_awarded, 8)
  assert.deepEqual(
    baseline.components.filter(({ applicable }) => applicable).map(({ id }) => id),
    ['demo-technical-quality', 'scene-kit-correctness', 'presentation-skill-correctness',
      'verification-tool-correctness', 'engineering-quality'],
  )
})

test('a pending reference reports 62 automated points but no final reference score', () => {
  const baseline = scoreProduct({ ...inputs(), mode: 'reference-baseline' })

  assert.equal(baseline.automated_subtotal.points, 62)
  assert.equal(baseline.automated_subtotal.possible, 62)
  assert.equal(baseline.official_score, null)
  assert.equal(baseline.official_pass, null)
  assert.deepEqual(baseline.incomplete, ['human-review'])
})

test('floorless workflow-quality components can score zero without creating a pass gate', () => {
  const failures = [
    ...criteriaForJob(automated, 'testing-evidence'),
    ...criteriaForJob(automated, 'assumption-handling'),
  ]
  const result = scoreProduct(inputs({ failures, humanReview: fullHumanReview }))

  assert.equal(component(result, 'testing-evidence-quality').points_awarded, 0)
  assert.equal(component(result, 'assumption-handling-quality').points_awarded, 0)
  assert.equal(result.official_score, 92)
  assert.equal(result.official_pass, true)
  assert.equal(result.pass_failures.some(({ rule }) => rule === 'component-floor'), false)
})

test('engineering quality can score zero without creating a pass gate', () => {
  const result = scoreProduct(inputs({ failures: engineeringCriteria(), humanReview: fullHumanReview }))

  assert.equal(component(result, 'engineering-quality').points_awarded, 0)
  assert.equal(result.automated_pass, true)
  assert.equal(result.official_score, 92)
  assert.equal(result.official_pass, true)
  assert.equal(result.pass_failures.some(({ rule }) => rule === 'component-floor'), false)
})

test('a gate whose evidence was never observed blocks the verdict without failing', () => {
  const base = inputs({ humanReview: fullHumanReview })
  const result = scoreProduct({
    ...base,
    gates: base.gates.map((gate) => gate.id === 'verification-build-whole-app'
      ? { id: gate.id, verdict: null, rationale: 'no build result was recorded', evidence: [], observed: false }
      : gate),
  })

  assert.equal(result.gates_passed, null)
  assert.equal(result.official_pass, null)
  assert.equal(result.official_score, null)
  assert.ok(result.incomplete.includes('hard-gates'))
  // An unobserved gate is never reported as a gate the candidate failed.
  assert.deepEqual(result.pass_failures, [])
  // Points supported by observed evidence survive.
  assert.equal(result.automated_subtotal.points, 70)
})

test('a malformed gate result still fails validation', () => {
  const base = inputs({ humanReview: fullHumanReview })
  assert.throws(
    () => scoreProduct({
      ...base,
      gates: base.gates.map((gate, index) => index === 0 ? { ...gate, verdict: 'probably' } : gate),
    }),
    /malformed criterion result/,
  )
  assert.throws(
    () => scoreProduct({ ...base, gates: base.gates.slice(1) }),
    /missing criterion results for hard-gates/,
  )
})

// INT-004: the real rubric 15.0.0 file through validation, scoring, floors,
// gates, eligibility, and the report.
function criterionRow(result, id) {
  return result.components.flatMap(({ subcomponents }) => subcomponents.flatMap(({ criteria }) => criteria))
    .find((criterion) => criterion.id === id)
}

function outlineGate(result) {
  return result.gates.find(({ id }) => id === 'verification-sample-outline')
}

test('rubric 15.0.0 validates and scores every verdict set by tier weight', () => {
  assert.deepEqual(validateAutomatedRubric(automated), [])
  assert.equal(rubrics.automated.version, '15.0.0')

  const allPass = scoreProduct(inputs({ humanReview: fullHumanReview }))
  assert.equal(allPass.automated_subtotal.points, 70)
  assert.equal(allPass.official_score, 100)
  assert.equal(allPass.official_pass, true)

  // One critical failure costs the critical weight, wherever it sits.
  const critical = scoreProduct(inputs({ failures: ['demo-required-scene-content'] }))
  assert.equal(component(critical, 'demo-technical-quality').points_awarded, 18)
  assert.equal(criterionRow(critical, 'demo-required-scene-content').tier, 'critical')
  assert.equal(critical.automated_subtotal.points, 68)
  assert.equal(critical.automated_pass, true)

  // One minor failure costs the minor weight.
  const minor = scoreProduct(inputs({ failures: ['demo-scope-discipline'] }))
  assert.equal(component(minor, 'demo-technical-quality').points_awarded, 19.5)
  assert.equal(minor.automated_subtotal.points, 69.5)

  // The spec scenario: passing a critical and failing a minor moves the demo
  // component by 2 and 0.5, whatever their subcomponents hold.
  const mixed = scoreProduct(inputs({ failures: ['demo-scope-discipline', 'demo-required-scene-content'] }))
  assert.equal(component(minor, 'demo-technical-quality').points_awarded
    - component(mixed, 'demo-technical-quality').points_awarded, 2)
  assert.equal(component(allPass, 'demo-technical-quality').points_awarded
    - component(minor, 'demo-technical-quality').points_awarded, 0.5)
  for (const result of [allPass, critical, minor, mixed]) assert.equal(outlineGate(result).verdict, 'pass')
})

// Skill and verification contracts: every judged criterion, failed alone,
// costs exactly its tier weight from the spec tables.
for (const [job, componentId, weights] of [
  ['presentation-skill', 'presentation-skill-correctness', { critical: 0.75, major: 0.375, minor: 0.125 }],
  ['verification-tooling', 'verification-tool-correctness', { critical: 1.25, major: 0.625, minor: 0.375 }],
]) {
  test(`each ${job} criterion failed alone costs its tier weight`, () => {
    const ids = criteriaForJob(automated, job)
    assert.ok(ids.length > 0)
    const full = component(scoreProduct(inputs()), componentId).points_awarded
    for (const id of ids) {
      const result = scoreProduct(inputs({ failures: [id] }))
      const row = criterionRow(result, id)
      assert.equal(row.verdict, 'fail', id)
      assert.equal(row.points_possible, weights[row.tier], id)
      assert.equal(full - component(result, componentId).points_awarded, weights[row.tier], id)
    }
  })
}

test('a critical engineering failure leaves 6.625 of 8 engineering points', () => {
  const result = scoreProduct(inputs({ failures: ['engineering-templates-build-at-destination'] }))
  const engineering = component(result, 'engineering-quality')
  assert.equal(engineering.points_awarded, 6.625)
  assert.equal(engineering.points_possible, 8)
  assert.equal(criterionRow(result, 'engineering-templates-build-at-destination').points_possible, 1.375)
  assert.equal(result.automated_subtotal.points, 68.625)
})

test('a failed zero-point gate input changes no points but fails the outline gate and eligibility', () => {
  for (const id of ['demo-route-and-registration', 'demo-nine-step-content-and-order']) {
    const result = scoreProduct(inputs({ failures: [id], humanReview: fullHumanReview }))
    const row = criterionRow(result, id)
    assert.deepEqual([row.tier, row.verdict, row.points_possible, row.points_awarded], ['gate-input', 'fail', 0, 0], id)
    assert.equal(component(result, 'demo-technical-quality').points_awarded, 20, id)
    assert.equal(component(result, 'demo-technical-quality').subcomponents
      .find(({ id: sub }) => sub === 'demo-canonical-content').points_awarded, 5, id)
    assert.equal(result.automated_subtotal.points, 70, id)
    assert.equal(outlineGate(result).verdict, 'fail', id)
    assert.equal(result.automated_pass, false, id)
    assert.deepEqual(result.automated_failures, [{
      rule: 'hard-gate', id: 'verification-sample-outline', value: 'fail', required: 'pass',
    }], id)
    assert.equal(result.official_pass, false, id)
  }
})

test('a not-observed gate input is fallback-judged for the outline gate and carries no points', () => {
  const id = 'demo-nine-step-content-and-order'
  const data = inputs()
  data.deterministic = data.deterministic.map((row) => row.id === id
    ? { ...row, verdict: null, outcome: 'not-observed', looked_for: ['data-presentation-title'], observed: false }
    : row)
  data.judges['demo-integration'] = [...data.judges['demo-integration'],
    { id, verdict: 'fail', rationale: 'the sample has eight steps', evidence: ['src/demo.tsx:1'], citations: ['src/demo.tsx'] }]

  const result = scoreProduct(data)
  const row = criterionRow(result, id)
  assert.equal(row.verdict_source, 'fallback')
  assert.equal(row.points_possible, 0)
  assert.equal(result.fallback.criteria, 1)
  assert.equal(result.fallback.points, 0)
  assert.equal(component(result, 'demo-technical-quality').points_awarded, 20)
  assert.equal(outlineGate(result).verdict, 'fail')
})

test('an unresolved gate input leaves the outline gate unobserved while the demo component stays complete', () => {
  // The nine-step input is not observed and its fallback verdict is unresolved
  // because its second opinion never settled.
  const id = 'demo-nine-step-content-and-order'
  const pendingData = inputs({ humanReview: fullHumanReview })
  pendingData.deterministic = pendingData.deterministic.map((row) => row.id === id
    ? { ...row, verdict: null, outcome: 'not-observed', looked_for: ['data-presentation-title'], observed: false }
    : row)
  pendingData.judges['demo-integration'] = [...pendingData.judges['demo-integration'],
    { id, verdict: 'fail', rationale: 'the sample has eight steps', evidence: ['src/demo.tsx:1'], citations: ['src/demo.tsx'] }]
  const pending = scoreProduct({ ...pendingData, pendingSecondOpinions: [{ kind: 'criterion', id }] })
  const demo = component(pending, 'demo-technical-quality')
  assert.equal(demo.complete, true)
  assert.equal(demo.points_awarded, 20)
  assert.equal(outlineGate(pending).verdict, null)
  assert.equal(outlineGate(pending).observed, false)
  assert.equal(pending.gates_passed, null)
  assert.equal(pending.automated_pass, null)
  // The unresolved input is reported: its row keeps the browser evidence and
  // no verdict, and the unobserved gate set is listed as incomplete.
  const pendingRow = criterionRow(pending, id)
  assert.deepEqual([pendingRow.verdict, pendingRow.observed, pendingRow.verdict_source, pendingRow.fallback_job],
    [null, false, 'fallback', 'demo-integration'])
  assert.deepEqual(pendingRow.not_observed.looked_for, ['data-presentation-title'])
  assert.deepEqual(pending.incomplete, ['hard-gates'])
  assert.equal(pending.official_score, null)
  assert.equal(pending.official_pass, null)
  // An unresolved input is neither a gate pass nor a product failure.
  assert.deepEqual(pending.automated_failures, [])
  assert.deepEqual(pending.pass_failures, [])

  // Not observed with no fallback verdict: the canonical-content row still
  // reports its scored criteria while the gate it feeds stays unobserved.
  const data = inputs({ omit: ['demo-integration'] })
  data.deterministic = data.deterministic.map((row) => row.id === 'demo-nine-step-content-and-order'
    ? { ...row, verdict: null, outcome: 'not-observed', observed: false }
    : row)
  const unjudged = scoreProduct(data)
  const canonical = component(unjudged, 'demo-technical-quality').subcomponents
    .find(({ id }) => id === 'demo-canonical-content')
  assert.equal(canonical.complete, true)
  assert.equal(canonical.points_awarded, 5)
  const row = criterionRow(unjudged, 'demo-nine-step-content-and-order')
  assert.equal(row.verdict_source, 'unresolved')
  assert.equal(row.not_observed.outcome, 'not-observed')
  assert.equal(outlineGate(unjudged).verdict, null)
  assert.equal(unjudged.gates_passed, null)
})

test('an overturned outline input passes the derived gate without changing any points', () => {
  const id = 'demo-nine-step-content-and-order'
  const data = inputs({ failures: [id], humanReview: fullHumanReview })
  const before = scoreProduct(data)
  const after = scoreProduct({ ...data, secondOpinions: {
    [id]: { raw_verdict: 'fail', verdict: 'pass', decision: 'overturn', rationale: 'title probe misread' },
  } })
  assert.equal(outlineGate(before).verdict, 'fail')
  assert.equal(outlineGate(after).verdict, 'pass')
  assert.equal(criterionRow(after, id).verdict, 'pass')
  assert.equal(component(after, 'demo-technical-quality').points_awarded,
    component(before, 'demo-technical-quality').points_awarded)
  assert.equal(after.automated_subtotal.points, before.automated_subtotal.points)
  assert.equal(after.second_opinions.overturned, 1)
  assert.equal(after.second_opinions.overturned_points, 0)
  assert.equal(after.official_pass, true)
})

test('the report shows each criterion with its tier and points, gate inputs at zero', () => {
  const score = scoreProduct(inputs({ failures: ['demo-route-and-registration', 'navigation-keyboard'] }))
  const html = renderReport({ label: 'NOT ELIGIBLE', score })
  assert.match(html, /<td>navigation-keyboard<\/td><td>scene-modes-and-navigation<\/td><td>0 of 1\.5625 \(critical\)<\/td>/)
  assert.match(html, /<td>demo-route-and-registration<\/td><td>demo-canonical-content<\/td><td>0 of 0 \(gate input\)<\/td>/)
  assert.match(html, /<td>entity-ungrouped-transition-morph<\/td><td>scene-entity-transitions<\/td><td>0\.75 of 0\.75 \(major\)<\/td>/)
  assert.match(html, /<td>demo-canonical-content<\/td>[\s\S]*?<td>5<\/td>/)
})
