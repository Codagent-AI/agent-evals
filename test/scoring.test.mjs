import assert from 'node:assert/strict'
import { test } from 'node:test'

import { criteriaForJob, deterministicCriteria, loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { scoreProduct } from '../evals/agent-runner/and-scene/lib/scorer.mjs'

const rubrics = await loadRubrics()
const automated = rubrics.automated.rubric

const JOBS = ['demo-integration', 'scene-kit', 'presentation-skill', 'verification-tooling']
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

const fullHumanReview = { total: 30, ratings: Array.from({ length: 13 }, () => 5) }

function component(result, id) {
  return result.components.find((entry) => entry.id === id)
}

test('an all-pass automated evaluation scores the full 70-point subtotal', () => {
  const result = scoreProduct(inputs())

  assert.equal(result.automated_subtotal.points, 70)
  assert.equal(result.automated_subtotal.possible, 70)
  assert.equal(result.automated_subtotal.complete, true)
  assert.deepEqual(
    result.components.map(({ id, points_awarded }) => [id, points_awarded]),
    [
      ['demo-technical-quality', 25],
      ['scene-kit-correctness', 25],
      ['presentation-skill-correctness', 10],
      ['verification-tool-correctness', 10],
    ],
  )
  assert.ok(result.components.every(({ complete }) => complete))
  assert.equal(result.gates_passed, true)
})

test('a pending human review reports the subtotal but no official total or verdict', () => {
  const result = scoreProduct(inputs())

  assert.equal(result.human_review, null)
  assert.equal(result.official_score, null)
  assert.equal(result.official_pass, null)
  assert.deepEqual(result.incomplete, ['human-review'])
})

test('a completed human review produces the official 100-point score and pass verdict', () => {
  const result = scoreProduct(inputs({ humanReview: fullHumanReview }))

  assert.equal(result.human_review.points, 30)
  assert.equal(result.official_score, 100)
  assert.equal(result.official_pass, true)
  assert.deepEqual(result.pass_failures, [])
  assert.deepEqual(result.incomplete, [])
})

test('a subcomponent divides its points equally among its criteria without rounding', () => {
  const result = scoreProduct(inputs({ failures: ['entity-departing-exit'] }))
  const transitions = component(result, 'scene-kit-correctness')
    .subcomponents.find(({ id }) => id === 'scene-entity-transitions')

  assert.equal(transitions.points_possible, 7)
  // Five of six criteria pass, so the row is worth exactly 35/6 — not a rounded
  // 5.83, and not a float built by adding five separate 7/6 shares.
  assert.equal(transitions.points_awarded, 35 / 6)
  assert.equal(transitions.criteria.find(({ id }) => id === 'entity-departing-exit').points_awarded, 0)
  assert.equal(component(result, 'scene-kit-correctness').points_awarded, 25 - 7 / 6)
  assert.equal(result.automated_subtotal.points, 70 - 7 / 6)
})

test('every criterion result records its identifier, verdict, rationale, and cited evidence', () => {
  const result = scoreProduct(inputs())
  const criteria = result.components.flatMap((entry) => entry.subcomponents.flatMap(({ criteria: rows }) => rows))

  assert.equal(criteria.length, 78)
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
  assert.ok(component(demoFloor, 'demo-technical-quality').points_awarded < 15)
  assert.ok(demoFloor.official_score >= 70)
  assert.equal(demoFloor.official_pass, false)
  assert.ok(demoFloor.pass_failures.some((entry) => entry.rule === 'component-floor'))

  const kitFloor = scoreProduct(inputs({
    failures: criteriaForJob(automated, 'scene-kit').slice(0, 24),
    humanReview: fullHumanReview,
  }))
  assert.ok(component(kitFloor, 'scene-kit-correctness').points_awarded < 15)
  assert.equal(kitFloor.official_pass, false)

  const humanFloor = scoreProduct(inputs({
    humanReview: { total: 14, ratings: Array.from({ length: 13 }, () => 3) },
  }))
  assert.equal(humanFloor.official_score, 84)
  assert.equal(humanFloor.official_pass, false)
  assert.ok(humanFloor.pass_failures.some((entry) => entry.rule === 'human-floor'))
})

test('any individual human rating of one fails the official verdict', () => {
  const ratings = Array.from({ length: 13 }, () => 5)
  ratings[6] = 1
  const result = scoreProduct(inputs({ humanReview: { total: 28, ratings } }))

  assert.equal(result.official_score, 98)
  assert.equal(result.official_pass, false)
  assert.ok(result.pass_failures.some((entry) => entry.rule === 'human-rating-one'))
})

test('each hard gate blocks an official pass while preserving the numerical score', () => {
  for (const gate of GATE_IDS) {
    const result = scoreProduct(inputs({ gateFailures: [gate], humanReview: fullHumanReview }))
    assert.equal(result.official_pass, false, gate)
    assert.ok(result.pass_failures.some((entry) => entry.rule === 'hard-gate' && entry.id === gate), gate)
    assert.equal(result.official_score, 100, gate)
    assert.equal(result.automated_subtotal.points, 70, gate)
  }
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
      { id: 'demo-scope-discipline', verdict: 'pass', rationale: 'r', evidence: [] },
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
  assert.equal(component(result, 'demo-technical-quality').points_awarded, 25)
  assert.equal(result.automated_subtotal.points, 45)
  assert.equal(result.automated_subtotal.possible, 70)
  assert.equal(result.automated_subtotal.complete, false)
  // The observed subtotal is never rescaled to hide the missing evidence.
  assert.equal(result.automated_subtotal.observed_possible, 45)
  assert.equal(result.official_score, null)
  assert.equal(result.official_pass, null)
  assert.ok(result.incomplete.includes('scene-kit-correctness'))
})

test('a partially observed component keeps its deterministic score and marks judging incomplete', () => {
  const result = scoreProduct(inputs({ omit: ['demo-integration'] }))
  const demo = component(result, 'demo-technical-quality')

  assert.equal(demo.complete, false)
  assert.equal(demo.points_awarded, null)
  assert.equal(demo.points_observed, 14)
  assert.equal(
    demo.subcomponents.find(({ id }) => id === 'demo-canonical-content').points_awarded,
    5,
  )
  assert.equal(demo.subcomponents.find(({ id }) => id === 'demo-scope-discipline').points_awarded, null)
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
    () => scoreProduct(inputs({ humanReview: { total: 31, ratings: Array.from({ length: 13 }, () => 5) } })),
    /human review total/,
  )
  assert.throws(
    () => scoreProduct(inputs({ humanReview: { total: 20, ratings: Array.from({ length: 12 }, () => 4) } })),
    /human review requires 13 ratings/,
  )
  assert.throws(
    () => scoreProduct(inputs({ humanReview: { total: 20, ratings: Array.from({ length: 13 }, () => 9) } })),
    /human review rating/,
  )
})

test('a reference baseline is scored with the same rubric, weights, gates, and thresholds', () => {
  const candidate = scoreProduct({ ...inputs({ humanReview: fullHumanReview }), mode: 'agent-runner' })
  const baseline = scoreProduct({ ...inputs({ humanReview: fullHumanReview }), mode: 'reference-baseline' })

  assert.deepEqual(
    { ...baseline, mode: null },
    { ...candidate, mode: null },
  )
})
