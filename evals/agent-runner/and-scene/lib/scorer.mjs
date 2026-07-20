// The suite-owned product scorer.
//
// Evaluators return verdicts; this module owns everything else. It validates
// criterion coverage, divides each subcomponent's points equally among its
// criteria, applies the hard gates and pass contract, and decides when a result
// is complete enough to carry an official score at all.
//
// Two distinctions run through the whole module:
//
//   * A criterion result that is present but wrong (missing, duplicated,
//     unknown, or malformed) is a validation failure — no score is produced.
//   * An evaluator that never ran is *incomplete*, not failing. Its component
//     keeps no points, the observed points of other components are preserved
//     unrescaled, and the official verdict becomes unavailable.
//
// Harness activity — retries, evidence repair, workflow failures — is carried
// through diagnostically and never touches a point.
import { rubricCriteria } from './rubric.mjs'

export const SCORE_SCHEMA_VERSION = 1

const VERDICTS = ['pass', 'fail']

export class RubricValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RubricValidationError'
    this.code = 'rubric-validation'
  }
}

// Validate one evaluator's output against the exact criterion set it owns.
// Coverage must be exact in both directions: the scorer never changes the
// denominator to accommodate what an evaluator happened to return.
function indexResults(source, results, expectedIds) {
  const indexed = new Map()
  const duplicates = []
  const unknown = []
  if (!Array.isArray(results)) {
    throw new RubricValidationError(`${source} results must be an array`)
  }
  const expected = new Set(expectedIds)
  for (const result of results) {
    if (!result || typeof result.id !== 'string' || result.id.length === 0) {
      throw new RubricValidationError(`malformed criterion result from ${source}: missing id`)
    }
    if (!VERDICTS.includes(result.verdict)) {
      throw new RubricValidationError(
        `malformed criterion result from ${source}: ${result.id} has verdict ${JSON.stringify(result.verdict)}`,
      )
    }
    if (typeof result.rationale !== 'string' || result.rationale.trim().length === 0) {
      throw new RubricValidationError(
        `malformed criterion result from ${source}: ${result.id} has no rationale`,
      )
    }
    if (!Array.isArray(result.evidence)) {
      throw new RubricValidationError(
        `malformed criterion result from ${source}: ${result.id} has no cited evidence`,
      )
    }
    if (indexed.has(result.id)) duplicates.push(result.id)
    else if (!expected.has(result.id)) unknown.push(result.id)
    indexed.set(result.id, result)
  }
  if (duplicates.length > 0) {
    throw new RubricValidationError(`duplicate criterion results for ${source}: ${duplicates.join(', ')}`)
  }
  if (unknown.length > 0) {
    throw new RubricValidationError(`unknown criterion results for ${source}: ${unknown.join(', ')}`)
  }
  const missing = expectedIds.filter((id) => !indexed.has(id))
  if (missing.length > 0) {
    throw new RubricValidationError(`missing criterion results for ${source}: ${missing.join(', ')}`)
  }
  return indexed
}

// Which evaluator source owns a subcomponent, and under what name it is
// reported when its output is missing or invalid.
function sourceOf(subcomponent) {
  return subcomponent.evaluator === 'deterministic-browser' ? 'deterministic-browser' : subcomponent.job
}

function validateHumanReview(humanReview, humanRubric) {
  if (humanReview === null || humanReview === undefined) return null
  const { min, max } = humanRubric.rating_scale
  if (!Array.isArray(humanReview.ratings) || humanReview.ratings.length !== humanRubric.question_count) {
    throw new RubricValidationError(
      `human review requires ${humanRubric.question_count} ratings`,
    )
  }
  for (const rating of humanReview.ratings) {
    if (!Number.isInteger(rating) || rating < min || rating > max) {
      throw new RubricValidationError(`human review rating ${JSON.stringify(rating)} is outside ${min}-${max}`)
    }
  }
  if (!Number.isFinite(humanReview.total) || humanReview.total < 0 || humanReview.total > humanRubric.points) {
    throw new RubricValidationError(
      `human review total ${JSON.stringify(humanReview.total)} is outside 0-${humanRubric.points}`,
    )
  }
  return {
    points: humanReview.total,
    possible: humanRubric.points,
    floor: humanRubric.floor,
    ratings: [...humanReview.ratings],
    lowest_rating: Math.min(...humanReview.ratings),
    complete: true,
  }
}

function greatestCommonDivisor(a, b) {
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

// Sum shares of the form `points * passed / count` over a common denominator.
// Adding the shares directly would accumulate floating-point association error,
// so an all-pass component would land near — but not on — its integer point
// value, and a partial component would not equal the fraction the rubric says
// it is. Reducing once at the end keeps the exact rubric arithmetic without
// rounding any intermediate value.
function sumShares(shares) {
  if (shares.length === 0) return 0
  const denominator = shares.reduce(
    (accumulator, { count }) => accumulator / greatestCommonDivisor(accumulator, count) * count,
    1,
  )
  const numerator = shares.reduce(
    (sum, { points, passed, count }) => sum + points * passed * (denominator / count),
    0,
  )
  return numerator / denominator
}

function scoreSubcomponent(component, subcomponent, resultsBySource) {
  const source = sourceOf(subcomponent)
  const indexed = resultsBySource.get(source)
  const criterionPoints = subcomponent.points / subcomponent.criteria.length
  const criteria = subcomponent.criteria.map((id) => {
    const result = indexed?.get(id) ?? null
    return {
      id,
      points_possible: criterionPoints,
      points_awarded: result ? (result.verdict === 'pass' ? criterionPoints : 0) : null,
      verdict: result?.verdict ?? null,
      rationale: result?.rationale ?? null,
      evidence: result?.evidence ?? [],
      observed: Boolean(result),
    }
  })
  const passed = criteria.filter(({ verdict }) => verdict === 'pass').length
  const share = { points: subcomponent.points, passed, count: subcomponent.criteria.length }
  return {
    share: indexed ? share : null,
    record: {
      id: subcomponent.id,
      title: subcomponent.title,
      points_possible: subcomponent.points,
      points_awarded: indexed ? sumShares([share]) : null,
      complete: Boolean(indexed),
      evaluator: subcomponent.evaluator,
      job: subcomponent.job ?? null,
      component: component.id,
      criteria,
    },
  }
}

function scoreComponent(component, resultsBySource) {
  const scored = component.subcomponents.map(
    (subcomponent) => scoreSubcomponent(component, subcomponent, resultsBySource),
  )
  const observedShares = scored.map(({ share }) => share).filter(Boolean)
  const subcomponents = scored.map(({ record }) => record)
  const complete = subcomponents.every(({ complete: done }) => done)
  const observedPoints = sumShares(observedShares)
  return {
    id: component.id,
    title: component.title,
    points_possible: component.points,
    // A component with unobserved evidence has no score at all; reporting a
    // partial number as if it were the component total would silently convert
    // missing evidence into a product failure.
    points_awarded: complete ? observedPoints : null,
    points_observed: observedPoints,
    points_observed_possible: observedShares.reduce((sum, { points }) => sum + points, 0),
    floor: component.floor ?? null,
    complete,
    subcomponents,
    observed_shares: observedShares,
  }
}

function scoreGates(gates, results) {
  if (results === null || results === undefined) {
    return { gates: gates.map(({ id, requirement }) => ({ id, requirement, verdict: null, rationale: null, evidence: [], observed: false })), passed: null }
  }
  const indexed = indexResults('hard-gates', results, gates.map(({ id }) => id))
  const rows = gates.map(({ id, requirement }) => {
    const result = indexed.get(id)
    return {
      id,
      requirement,
      verdict: result.verdict,
      rationale: result.rationale,
      evidence: result.evidence,
      observed: true,
    }
  })
  return { gates: rows, passed: rows.every(({ verdict }) => verdict === 'pass') }
}

export function scoreProduct({
  rubrics,
  deterministic = null,
  judges = {},
  gates = null,
  humanReview = null,
  harness = null,
  mode = 'agent-runner',
}) {
  const automated = rubrics.automated.rubric
  const humanRubric = rubrics.human.rubric

  // Validate each evaluator's coverage against the criteria the rubric assigns
  // it, before any arithmetic depends on it.
  const resultsBySource = new Map()
  const rows = rubricCriteria(automated)
  const deterministicIds = rows.filter(({ evaluator }) => evaluator === 'deterministic-browser').map(({ id }) => id)
  if (deterministic !== null && deterministic !== undefined) {
    resultsBySource.set('deterministic-browser', indexResults('deterministic-browser', deterministic, deterministicIds))
  }
  const jobIds = [...new Set(rows.filter(({ job }) => job).map(({ job }) => job))]
  for (const job of jobIds) {
    const results = judges?.[job]
    if (results === null || results === undefined) continue
    resultsBySource.set(job, indexResults(job, results, rows.filter((row) => row.job === job).map(({ id }) => id)))
  }

  const scoredComponents = automated.components.map((component) => scoreComponent(component, resultsBySource))
  const components = scoredComponents.map(({ observed_shares: _shares, ...component }) => component)
  const gateScore = scoreGates(automated.gates, gates)
  const human = validateHumanReview(humanReview, humanRubric)

  const automatedComplete = components.every(({ complete }) => complete)
  const automatedSubtotal = {
    points: sumShares(scoredComponents.flatMap(({ observed_shares: shares }) => shares)),
    possible: automated.automated_points,
    // What the observed evidence could have awarded. Reporting this alongside
    // `possible` keeps a partial run readable without rescaling its score.
    observed_possible: components.reduce((sum, { points_observed_possible }) => sum + points_observed_possible, 0),
    complete: automatedComplete,
  }

  const incomplete = [
    ...components.filter(({ complete }) => !complete).map(({ id }) => id),
    ...(gateScore.passed === null ? ['hard-gates'] : []),
    ...(human ? [] : ['human-review']),
  ]

  const evaluable = incomplete.length === 0
  const officialScore = evaluable ? automatedSubtotal.points + human.points : null

  const passFailures = []
  if (evaluable) {
    if (officialScore < automated.pass_threshold) {
      passFailures.push({ rule: 'total', id: null, value: officialScore, required: automated.pass_threshold })
    }
    for (const component of components) {
      if (component.floor !== null && component.points_awarded < component.floor) {
        passFailures.push({
          rule: 'component-floor', id: component.id,
          value: component.points_awarded, required: component.floor,
        })
      }
    }
    if (human.points < human.floor) {
      passFailures.push({ rule: 'human-floor', id: 'human-review', value: human.points, required: human.floor })
    }
    if (human.lowest_rating < humanRubric.min_individual_rating) {
      passFailures.push({
        rule: 'human-rating-one', id: 'human-review',
        value: human.lowest_rating, required: humanRubric.min_individual_rating,
      })
    }
    for (const gate of gateScore.gates) {
      if (gate.verdict !== 'pass') {
        passFailures.push({ rule: 'hard-gate', id: gate.id, value: gate.verdict, required: 'pass' })
      }
    }
  }

  return {
    schema_version: SCORE_SCHEMA_VERSION,
    mode,
    rubrics: {
      automated: {
        rubric_id: rubrics.automated.rubric_id,
        version: rubrics.automated.version,
        sha256: rubrics.automated.sha256,
      },
      human: {
        rubric_id: rubrics.human.rubric_id,
        version: rubrics.human.version,
        sha256: rubrics.human.sha256,
      },
    },
    components,
    gates: gateScore.gates,
    gates_passed: gateScore.passed,
    automated_subtotal: automatedSubtotal,
    human_review: human,
    official_score: officialScore,
    // An unevaluable pass contract yields no verdict at all rather than a
    // failure, so an interrupted run is never reported as a bad product.
    official_pass: evaluable ? passFailures.length === 0 : null,
    pass_failures: passFailures,
    incomplete,
    harness,
  }
}
