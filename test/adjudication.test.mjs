import assert from 'node:assert/strict'
import { test } from 'node:test'

async function adjudicationModule() {
  return import('../evals/agent-runner/and-scene/lib/adjudication.mjs').catch(() => null)
}

function component(id, pointsAwarded, pointsPossible) {
  return {
    id,
    title: id,
    applicable: true,
    points_awarded: pointsAwarded,
    points_observed: pointsAwarded,
    points_possible: pointsPossible,
    points_observed_possible: pointsPossible,
    floor: id.includes('demo') || id.includes('scene') ? 15 : null,
    complete: true,
    subcomponents: [],
  }
}

function candidateResult() {
  const components = [
    component('demo-technical-quality', 23, 24),
    component('scene-kit-correctness', 23.4, 24),
    component('presentation-skill-correctness', 7, 7),
    component('verification-tool-correctness', 6.5, 7),
    component('testing-evidence-quality', 4, 4),
    component('assumption-handling-quality', 4, 4),
  ]
  return {
    run_id: 'candidate-1',
    mode: 'agent-runner',
    evaluation_status: 'complete',
    product_verdict: 'pass',
    label: 'PASS',
    official_score: 88.4,
    score_denominator: 100,
    automated_subtotal: { points: 67.9, possible: 70, observed_possible: 70, complete: true },
    rubrics: {
      automated: { rubric_id: 'and-scene-automated-product', version: '3.0.0', sha256: 'a'.repeat(64) },
      human: { rubric_id: 'and-scene-human-review', version: '1.0.0', sha256: 'b'.repeat(64) },
    },
    score: {
      components,
      gates: [
        'verification-build-whole-app',
        'verification-sample-outline',
        'verification-every-produced-step-renders',
        'verification-clear-outcome',
      ].map((id) => ({ id, verdict: 'pass', observed: true })),
      gates_passed: true,
      automated_subtotal: { points: 67.9, possible: 70, observed_possible: 70, complete: true },
      human_review: {
        applicable: true,
        points_awarded: 20.5,
        points_possible: 30,
        points: 20.5,
        possible: 30,
        floor: 15,
        lowest_rating: 3,
        complete: true,
      },
      official_score: 88.4,
      official_pass: true,
      pass_failures: [],
      incomplete: [],
    },
    human_review: { complete: true, score: { total: 20.5, possible: 30 } },
    baseline: {
      comparable: true,
      baseline_run_id: 'reference-1',
      denominator: 92,
      totals: { baseline: 92, candidate: 80.4, delta: -11.6 },
      components: [
        { id: 'demo-technical-quality', baseline: 24, candidate: 23, delta: -1 },
        { id: 'scene-kit-correctness', baseline: 24, candidate: 23.4, delta: -0.6 },
        { id: 'presentation-skill-correctness', baseline: 7, candidate: 7, delta: 0 },
        { id: 'verification-tool-correctness', baseline: 7, candidate: 6.5, delta: -0.5 },
      ],
      human_review: { baseline: 30, candidate: 20.5, delta: -9.5 },
    },
  }
}

function approvedReview() {
  return {
    approved_by: 'user',
    approved_at: '2026-07-28T20:00:00.000Z',
    rationale: 'Independent technical review corrected scanner errors and assessed robustness.',
    component_scores: {
      'demo-technical-quality': 24,
      'scene-kit-correctness': 22.5,
      'presentation-skill-correctness': 6,
      'verification-tool-correctness': 5.5,
    },
    findings: [
      'active-state scanner false negatives',
      'transition settlement is not wired to layout timing',
      'skill edge cases are described but not behaviorally exercised',
      'fixed preview ports can attach to a stale server',
    ],
  }
}

function replacementHumanReview() {
  const rubric = {
    rubric_id: 'and-scene-human-review',
    version: '2.1.0',
    sha256: 'c'.repeat(64),
  }
  const ratings = [3, 4, 2, 3, 3, 5, 4]
  const points = [2, 3, 1.25, 3, 2.5, 3, 2.25]
  return {
    audit: {
      approved_by: 'Paul (user)',
      approved_at: '2026-08-29T12:00:00.000Z',
      rationale: 'The reviewer confirmed the replacement seven-question visual review.',
    },
    humanReview: {
      schema_version: 1,
      candidate: { candidate_identity: 'candidate-abc', run_id: 'candidate-1' },
      rubric,
      readiness_confirmed: true,
      responses: ratings.map((rating, index) => ({
        id: `question-${index + 1}`,
        number: index + 1,
        dimension: `dimension-${index + 1}`,
        question_text: `Question ${index + 1}`,
        rating,
        rationale: rating <= 3 ? 'confirmed rationale' : '',
      })),
      score: {
        complete: true,
        subtotals: points.map((value, index) => ({
          id: `dimension-${index + 1}`,
          title: `Dimension ${index + 1}`,
          points: value,
          points_possible: [4, 4, 5, 6, 5, 3, 3][index],
          ratings: [ratings[index]],
        })),
        total: 17,
        possible: 30,
        floor: 15,
        lowest_rating: 2,
        gate_passed: true,
        gate_failures: [],
      },
      complete: true,
      completed_at: '2026-08-29T11:59:00.000Z',
    },
    rubric,
  }
}

test('a confirmed replacement human review updates the official score with supersession history', async () => {
  const module = await adjudicationModule()
  const original = candidateResult()
  const replacement = replacementHumanReview()
  const revised = module.applyHumanReviewSupersession(original, replacement)

  assert.equal(revised.human_review.score.total, 17)
  assert.equal(revised.score.human_review.points_awarded, 17)
  assert.deepEqual(revised.score.human_review.ratings, [3, 4, 2, 3, 3, 5, 4])
  assert.equal(revised.official_score, 84.9)
  assert.equal(revised.score.official_score, 84.9)
  assert.equal(revised.product_verdict, 'pass')
  assert.deepEqual(revised.human_review_history, [original.human_review])
  assert.equal(revised.rubrics.human.version, '2.1.0')
  assert.equal(revised.human_review_supersession.prior_human_score, 20.5)
  assert.equal(revised.human_review_supersession.revised_human_score, 17)
  assert.equal(revised.human_review_supersession.prior_official_score, 88.4)
  assert.equal(revised.human_review_supersession.revised_official_score, 84.9)
  assert.equal(revised.baseline.human_review.candidate, 17)
  assert.equal(revised.baseline.totals.candidate, 76.9)
  assert.equal(module.validateHumanReviewSupersession(original, revised).valid, true)
})

test('human-review supersession rejects an unconfirmed or arithmetically inconsistent review', async () => {
  const module = await adjudicationModule()
  const replacement = replacementHumanReview()
  assert.throws(
    () => module.applyHumanReviewSupersession(candidateResult(), {
      ...replacement,
      humanReview: { ...replacement.humanReview, complete: false },
    }),
    /complete replacement human review/,
  )
  assert.throws(
    () => module.applyHumanReviewSupersession(candidateResult(), {
      ...replacement,
      humanReview: {
        ...replacement.humanReview,
        score: { ...replacement.humanReview.score, total: 18 },
      },
    }),
    /subtotal sum/,
  )
})

test('an approved technical adjudication revises the shared score to 58 with an audit trail', async () => {
  const module = await adjudicationModule()
  assert.ok(module, 'technical adjudication support must exist')

  const revised = module.applyTechnicalAdjudication(candidateResult(), approvedReview())

  assert.equal(revised.technical_adjudication.prior_shared_technical_score, 59.9)
  assert.equal(revised.technical_adjudication.revised_shared_technical_score, 58)
  assert.equal(revised.automated_subtotal.points, 66)
  assert.equal(revised.official_score, 86.5)
  assert.equal(
    revised.score.components.find(({ id }) => id === 'testing-evidence-quality').points_awarded,
    4,
  )
  assert.equal(
    revised.score.components.find(({ id }) => id === 'assumption-handling-quality').points_awarded,
    4,
  )
  assert.equal(revised.baseline.totals.candidate, 78.5)
  assert.equal(revised.baseline.totals.delta, -13.5)
  assert.equal(revised.score.components.find(({ id }) => id === 'demo-technical-quality').raw_points_awarded, 23)
  assert.equal(revised.score.components.find(({ id }) => id === 'demo-technical-quality').points_awarded, 24)
})

test('a reviewed adjudication can supersede a provisional adjudication without losing either audit record', async () => {
  const module = await adjudicationModule()
  assert.ok(module, 'technical adjudication support must exist')

  const provisional = module.applyTechnicalAdjudication(candidateResult(), approvedReview())
  const finalReview = {
    approved_by: 'user',
    approved_at: '2026-07-28T22:00:00.000Z',
    rationale: 'A fresh rubric 3.2 review produced the final technical score.',
    reviewed_rubric: {
      rubric_id: 'and-scene-automated-product',
      version: '3.2.0',
      sha256: 'c'.repeat(64),
    },
    component_scores: {
      'demo-technical-quality': 23,
      'scene-kit-correctness': 637 / 30,
      'presentation-skill-correctness': 41 / 8,
      'verification-tool-correctness': 13 / 3,
    },
    workflow_component_scores: {
      'testing-evidence-quality': 4,
      'assumption-handling-quality': 2,
    },
    findings: ['fresh independent review found no consequential rubric issues'],
  }

  const revised = module.applyTechnicalAdjudication(provisional, finalReview)

  assert.equal(revised.technical_adjudication.prior_shared_technical_score, 58)
  assert.equal(revised.technical_adjudication.revised_shared_technical_score, 53.691666666667)
  assert.equal(revised.technical_adjudication_history.length, 1)
  assert.deepEqual(revised.technical_adjudication_history[0], provisional.technical_adjudication)
  assert.deepEqual(revised.technical_adjudication.reviewed_rubric, finalReview.reviewed_rubric)
  assert.equal(revised.technical_adjudication.prior_workflow_quality_score, 8)
  assert.equal(revised.technical_adjudication.revised_workflow_quality_score, 6)
  assert.equal(revised.automated_subtotal.points, 59.691666666667)
  assert.equal(revised.official_score, 80.191666666667)
  const demo = revised.score.components.find(({ id }) => id === 'demo-technical-quality')
  assert.equal(demo.raw_points_awarded, 23)
  assert.equal(demo.prior_points_awarded, 24)
  assert.equal(demo.points_awarded, 23)
  assert.equal(demo.adjudication_adjustment, 0)
  assert.equal(demo.prior_adjudication_adjustment, 1)
  const assumptions = revised.score.components.find(({ id }) => id === 'assumption-handling-quality')
  assert.equal(assumptions.raw_points_awarded, 4)
  assert.equal(assumptions.points_awarded, 2)
  assert.equal(assumptions.prior_adjudication_adjustment, 0)
  assert.equal(assumptions.adjudication_adjustment, -2)
  assert.equal(
    module.validateTechnicalAdjudicationSupersession(provisional, revised).valid,
    true,
  )
})

test('technical adjudication rejects incomplete or out-of-range component scores', async () => {
  const module = await adjudicationModule()
  assert.ok(module, 'technical adjudication support must exist')

  const review = approvedReview()
  delete review.component_scores['verification-tool-correctness']
  assert.throws(
    () => module.applyTechnicalAdjudication(candidateResult(), review),
    /exactly the four shared technical components/,
  )

  assert.throws(
    () => module.applyTechnicalAdjudication(candidateResult(), {
      ...approvedReview(),
      component_scores: { ...approvedReview().component_scores, 'scene-kit-correctness': 25 },
    }),
    /outside 0-24/,
  )

  for (const reviewed_rubric of [null, false, 0, '']) {
    assert.throws(
      () => module.applyTechnicalAdjudication(candidateResult(), {
        ...approvedReview(),
        reviewed_rubric,
      }),
      /reviewed_rubric must be an object/,
    )
  }
})

test('technical adjudication recomputes the pass contract after lowering a passing score', async () => {
  const module = await adjudicationModule()
  const result = candidateResult()
  const revised = module.applyTechnicalAdjudication(result, {
    ...approvedReview(),
    component_scores: {
      'demo-technical-quality': 15,
      'scene-kit-correctness': 15,
      'presentation-skill-correctness': 0,
      'verification-tool-correctness': 0,
    },
  })

  assert.equal(revised.official_score, 58.5)
  assert.equal(revised.score.official_pass, false)
  assert.deepEqual(revised.score.pass_failures, [{
    rule: 'total', id: null, value: 58.5, required: 70,
  }])
  assert.equal(revised.product_verdict, 'fail')
  assert.equal(revised.label, 'FAIL')
})

test('technical adjudication can correct an observed hard gate without replacing its raw verdict', async () => {
  const module = await adjudicationModule()
  const result = candidateResult()
  const outline = result.score.gates.find(({ id }) => id === 'verification-sample-outline')
  outline.verdict = 'fail'
  result.score.gates_passed = false
  result.score.official_pass = false
  result.score.pass_failures = [{
    rule: 'hard-gate', id: outline.id, value: 'fail', required: 'pass',
  }]
  result.product_verdict = 'fail'
  result.label = 'FAIL'
  const gateVerdicts = Object.fromEntries(result.score.gates.map(({ id }) => [id, 'pass']))

  const revised = module.applyTechnicalAdjudication(result, {
    ...approvedReview(),
    gate_verdicts: gateVerdicts,
  })

  const revisedOutline = revised.score.gates.find(({ id }) => id === outline.id)
  assert.equal(revisedOutline.raw_verdict, 'fail')
  assert.equal(revisedOutline.verdict, 'pass')
  assert.equal(revisedOutline.adjudication_changed, true)
  assert.deepEqual(revised.technical_adjudication.prior_gate_verdicts, {
    'verification-build-whole-app': 'pass',
    'verification-sample-outline': 'fail',
    'verification-every-produced-step-renders': 'pass',
    'verification-clear-outcome': 'pass',
  })
  assert.deepEqual(revised.technical_adjudication.revised_gate_verdicts, gateVerdicts)
  assert.deepEqual(revised.score.pass_failures, [])
  assert.equal(revised.score.gates_passed, true)
  assert.equal(revised.score.official_pass, true)
  assert.equal(revised.product_verdict, 'pass')
  assert.equal(revised.label, 'PASS')
  assert.equal(module.validateTechnicalAdjudicationSupersession(result, revised).valid, true)
})

test('technical adjudication separates a changed gate raw record from its revised record', async () => {
  // A revised pass shown beside the failure it replaced reads as a
  // contradictory current gate. The harness output survives as raw data.
  const module = await adjudicationModule()
  const result = candidateResult()
  const outline = result.score.gates.find(({ id }) => id === 'verification-sample-outline')
  outline.verdict = 'fail'
  outline.rationale = 'the canonical nine-step sample must be registered'
  outline.evidence = ['evidence/evaluator/browser-probes/demo-route-and-registration.json']
  const build = result.score.gates.find(({ id }) => id === 'verification-build-whole-app')
  build.rationale = 'the complete application built successfully'
  build.evidence = ['phases/verification.json']
  result.score.gates_passed = false
  const review = {
    ...approvedReview(),
    gate_verdicts: Object.fromEntries(result.score.gates.map(({ id }) => [id, 'pass'])),
  }

  const revised = module.applyTechnicalAdjudication(result, review)

  const revisedOutline = revised.score.gates.find(({ id }) => id === outline.id)
  assert.equal(revisedOutline.raw_rationale, 'the canonical nine-step sample must be registered')
  assert.deepEqual(revisedOutline.raw_evidence, [
    'evidence/evaluator/browser-probes/demo-route-and-registration.json',
  ])
  assert.equal(revisedOutline.rationale, review.rationale)
  assert.deepEqual(revisedOutline.evidence, [
    `technical adjudication approved by ${review.approved_by} at ${review.approved_at}`,
  ])

  const revisedBuild = revised.score.gates.find(({ id }) => id === build.id)
  assert.equal(revisedBuild.rationale, 'the complete application built successfully')
  assert.deepEqual(revisedBuild.evidence, ['phases/verification.json'])
  assert.equal(Object.hasOwn(revisedBuild, 'raw_rationale'), false)
  assert.equal(Object.hasOwn(revisedBuild, 'raw_evidence'), false)

  // A second adjudication keeps the original harness record as the raw one.
  const again = module.applyTechnicalAdjudication(revised, {
    ...review,
    approved_at: '2026-07-29T20:00:00.000Z',
  })
  const againOutline = again.score.gates.find(({ id }) => id === outline.id)
  assert.equal(againOutline.raw_rationale, 'the canonical nine-step sample must be registered')
  assert.deepEqual(againOutline.evidence, [
    `technical adjudication approved by ${review.approved_by} at 2026-07-29T20:00:00.000Z`,
  ])
  assert.equal(module.validateTechnicalAdjudicationSupersession(result, revised).valid, true)
})

test('technical adjudication rejects partial or unknown gate verdict sets', async () => {
  const module = await adjudicationModule()
  const result = candidateResult()

  assert.throws(
    () => module.applyTechnicalAdjudication(result, {
      ...approvedReview(),
      gate_verdicts: { 'verification-sample-outline': 'pass' },
    }),
    /exactly the four recorded hard gates/,
  )
  assert.throws(
    () => module.applyTechnicalAdjudication(result, {
      ...approvedReview(),
      gate_verdicts: Object.fromEntries(result.score.gates.map(({ id }) => [id, 'maybe'])),
    }),
    /must be pass or fail/,
  )
})
