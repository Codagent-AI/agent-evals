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
})
