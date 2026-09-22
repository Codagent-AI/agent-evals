// Explicit post-run technical adjudication.
//
// An adjudication never rewrites the judge record. It preserves each raw
// component score, records the approved component-level replacement and
// recalculates only the aggregates that depend on those four shared technical
// components. Publication accepts the resulting supersession only when it can
// reproduce the exact revised result from the previously published result and
// the embedded adjudication record.
import { SHARED_COMPONENT_IDS } from './baseline.mjs'
import { hashJson } from './persistence.mjs'

export const TECHNICAL_ADJUDICATION_SCHEMA_VERSION = 1
export const HUMAN_REVIEW_SUPERSESSION_SCHEMA_VERSION = 1
const WORKFLOW_COMPONENT_IDS = [
  'testing-evidence-quality',
  'assumption-handling-quality',
]
const DEFAULT_PASS_THRESHOLD = 70
const DEFAULT_MIN_INDIVIDUAL_RATING = 2

function round(value) {
  return Math.round(value * 1e12) / 1e12
}

function humanPoints(result) {
  return result.score?.human_review?.points_awarded
    ?? result.score?.human_review?.points
    ?? result.human_review?.score?.total
    ?? null
}

function resultFingerprint(result) {
  const {
    artifacts: _artifacts,
    report: _report,
    ...stable
  } = result ?? {}
  return hashJson(stable)
}

function adjudicationComparableCore(result) {
  const { artifacts: _artifacts, report: _report, ...core } = result ?? {}
  return core
}

function validateReview(result, review) {
  if (result?.mode !== 'agent-runner' || result?.evaluation_status !== 'complete') {
    throw new Error('technical adjudication requires a completed Agent Runner candidate result')
  }
  for (const field of ['approved_by', 'approved_at', 'rationale']) {
    if (typeof review?.[field] !== 'string' || review[field].trim().length === 0) {
      throw new Error(`technical adjudication requires ${field}`)
    }
  }
  if (!Array.isArray(review.findings) || review.findings.length === 0
    || review.findings.some((finding) => typeof finding !== 'string' || finding.trim().length === 0)) {
    throw new Error('technical adjudication requires at least one finding')
  }
  const hasReviewedRubric = Object.hasOwn(review ?? {}, 'reviewed_rubric')
  if (hasReviewedRubric) {
    if (
      review.reviewed_rubric === null
      || typeof review.reviewed_rubric !== 'object'
      || Array.isArray(review.reviewed_rubric)
    ) {
      throw new Error('technical adjudication reviewed_rubric must be an object')
    }
    for (const field of ['rubric_id', 'version', 'sha256']) {
      if (
        typeof review.reviewed_rubric[field] !== 'string'
        || review.reviewed_rubric[field].trim().length === 0
      ) {
        throw new Error(`technical adjudication reviewed_rubric requires ${field}`)
      }
    }
  }

  const supplied = Object.keys(review.component_scores ?? {}).sort()
  const expected = [...SHARED_COMPONENT_IDS].sort()
  if (hashJson(supplied) !== hashJson(expected)) {
    throw new Error('technical adjudication must score exactly the four shared technical components')
  }
  const hasWorkflowScores = Object.hasOwn(review ?? {}, 'workflow_component_scores')
  if (hasWorkflowScores) {
    if (
      review.workflow_component_scores === null
      || typeof review.workflow_component_scores !== 'object'
      || Array.isArray(review.workflow_component_scores)
    ) {
      throw new Error('technical adjudication workflow_component_scores must be an object')
    }
    const suppliedWorkflow = Object.keys(review.workflow_component_scores).sort()
    const expectedWorkflow = [...WORKFLOW_COMPONENT_IDS].sort()
    if (hashJson(suppliedWorkflow) !== hashJson(expectedWorkflow)) {
      throw new Error(
        'technical adjudication must score exactly the two workflow-quality components when supplied',
      )
    }
  }

  const hasGateVerdicts = Object.hasOwn(review ?? {}, 'gate_verdicts')
  if (hasGateVerdicts) {
    if (
      review.gate_verdicts === null
      || typeof review.gate_verdicts !== 'object'
      || Array.isArray(review.gate_verdicts)
    ) {
      throw new Error('technical adjudication gate_verdicts must be an object')
    }
    const recordedGates = result.score?.gates ?? []
    const suppliedGates = Object.keys(review.gate_verdicts).sort()
    const expectedGates = recordedGates.map(({ id }) => id).sort()
    if (expectedGates.length === 0 || hashJson(suppliedGates) !== hashJson(expectedGates)) {
      throw new Error('technical adjudication must decide exactly the four recorded hard gates')
    }
    for (const id of expectedGates) {
      if (!['pass', 'fail'].includes(review.gate_verdicts[id])) {
        throw new Error(`technical adjudication gate ${id} must be pass or fail`)
      }
    }
  }

  const indexed = new Map((result.score?.components ?? []).map((component) => [component.id, component]))
  const reviewedIds = hasWorkflowScores
    ? [...SHARED_COMPONENT_IDS, ...WORKFLOW_COMPONENT_IDS]
    : SHARED_COMPONENT_IDS
  for (const id of reviewedIds) {
    const component = indexed.get(id)
    if (!component || !Number.isFinite(component.points_awarded)) {
      throw new Error(`technical adjudication requires a complete raw score for ${id}`)
    }
    const revised = review.component_scores[id] ?? review.workflow_component_scores[id]
    if (!Number.isFinite(revised) || revised < 0 || revised > component.points_possible) {
      throw new Error(
        `${id} adjudicated score ${JSON.stringify(revised)} is outside 0-${component.points_possible}`,
      )
    }
  }
}

function policyValue(result, rule, fallback) {
  return result.score?.pass_failures
    ?.find((failure) => failure.rule === rule)
    ?.required ?? fallback
}

function recomputePassContract({ result, components, gates, official }) {
  const human = result.score?.human_review
  const failures = []
  const passThreshold = result.score?.pass_contract?.total_required
    ?? policyValue(result, 'total', DEFAULT_PASS_THRESHOLD)
  if (official < passThreshold) {
    failures.push({ rule: 'total', id: null, value: official, required: passThreshold })
  }
  for (const component of components) {
    if (
      component.applicable !== false
      && Number.isFinite(component.floor)
      && component.points_awarded < component.floor
    ) {
      failures.push({
        rule: 'component-floor',
        id: component.id,
        value: component.points_awarded,
        required: component.floor,
      })
    }
  }
  if (Number.isFinite(human?.floor) && human.points_awarded < human.floor) {
    failures.push({
      rule: 'human-floor', id: 'human-review',
      value: human.points_awarded, required: human.floor,
    })
  }
  const minIndividual = result.score?.pass_contract?.min_individual_rating
    ?? policyValue(result, 'human-rating-one', DEFAULT_MIN_INDIVIDUAL_RATING)
  if (Number.isFinite(human?.lowest_rating) && human.lowest_rating < minIndividual) {
    failures.push({
      rule: 'human-rating-one', id: 'human-review',
      value: human.lowest_rating, required: minIndividual,
    })
  }
  for (const gate of gates) {
    if (gate.verdict !== 'pass') {
      failures.push({ rule: 'hard-gate', id: gate.id, value: gate.verdict, required: 'pass' })
    }
  }
  return { official_pass: failures.length === 0, pass_failures: failures }
}

function updateBaseline(baseline, componentScores, revisedShared, candidateHuman) {
  if (baseline?.comparable !== true) return baseline ?? null
  const components = (baseline.components ?? []).map((component) => {
    if (!Object.hasOwn(componentScores, component.id)) return component
    const candidate = componentScores[component.id]
    return {
      ...component,
      candidate,
      delta: Number.isFinite(component.baseline) ? round(candidate - component.baseline) : null,
    }
  })
  const candidate = round(revisedShared + candidateHuman)
  return {
    ...baseline,
    totals: {
      ...baseline.totals,
      candidate,
      delta: Number.isFinite(baseline.totals?.baseline)
        ? round(candidate - baseline.totals.baseline)
        : null,
    },
    components,
  }
}

export function applyTechnicalAdjudication(result, review) {
  validateReview(result, review)

  const componentScores = Object.fromEntries(
    SHARED_COMPONENT_IDS.map((id) => [id, review.component_scores[id]]),
  )
  const workflowComponentScores = Object.hasOwn(review, 'workflow_component_scores')
    ? Object.fromEntries(
        WORKFLOW_COMPONENT_IDS.map((id) => [id, review.workflow_component_scores[id]]),
      )
    : null
  const allComponentScores = {
    ...componentScores,
    ...(workflowComponentScores ?? {}),
  }
  const gateVerdicts = Object.hasOwn(review, 'gate_verdicts')
    ? Object.fromEntries(Object.entries(review.gate_verdicts))
    : null
  const priorShared = round(
    result.score.components
      .filter(({ id }) => SHARED_COMPONENT_IDS.includes(id))
      .reduce((sum, { points_awarded: points }) => sum + points, 0),
  )
  const revisedShared = round(Object.values(componentScores).reduce((sum, points) => sum + points, 0))
  const priorWorkflow = workflowComponentScores
    ? round(
        result.score.components
          .filter(({ id }) => WORKFLOW_COMPONENT_IDS.includes(id))
          .reduce((sum, { points_awarded: points }) => sum + points, 0),
      )
    : null
  const revisedWorkflow = workflowComponentScores
    ? round(Object.values(workflowComponentScores).reduce((sum, points) => sum + points, 0))
    : null
  const components = result.score.components.map((component) => {
    if (!Object.hasOwn(allComponentScores, component.id)) return component
    const prior = component.points_awarded
    const raw = component.raw_points_awarded ?? prior
    const revised = allComponentScores[component.id]
    return {
      ...component,
      raw_points_awarded: raw,
      ...(result.technical_adjudication
        ? {
            prior_points_awarded: prior,
            prior_adjudication_adjustment: round(prior - raw),
          }
        : {}),
      points_awarded: revised,
      points_observed: revised,
      adjudication_adjustment: round(revised - raw),
    }
  })
  const automatedPoints = round(
    components
      .filter(({ applicable }) => applicable !== false)
      .reduce((sum, { points_awarded: points }) => sum + points, 0),
  )
  const human = humanPoints(result)
  if (!Number.isFinite(human)) throw new Error('technical adjudication requires a complete human review')
  const official = round(automatedPoints + human)
  const priorGateVerdicts = gateVerdicts
    ? Object.fromEntries((result.score?.gates ?? []).map(({ id, verdict }) => [id, verdict]))
    : null
  // A gate the adjudication overturns keeps the harness's rationale and
  // evidence as raw data. Its current fields describe the adjudicated record,
  // so a revised verdict is never shown beside the failure it replaced.
  const adjudicationCitation = `technical adjudication approved by ${review.approved_by.trim()} at ${review.approved_at}`
  const gates = (result.score?.gates ?? []).map((gate) => {
    if (!gateVerdicts) return gate
    const raw = gate.raw_verdict ?? gate.verdict
    const revised = gateVerdicts[gate.id]
    const changed = revised !== raw
    const {
      raw_rationale: priorRawRationale,
      raw_evidence: priorRawEvidence,
      ...current
    } = gate
    const rawRationale = priorRawRationale !== undefined ? priorRawRationale : (gate.rationale ?? null)
    const rawEvidence = priorRawEvidence !== undefined ? priorRawEvidence : (gate.evidence ?? [])
    return {
      ...current,
      raw_verdict: raw,
      ...(changed ? { raw_rationale: rawRationale, raw_evidence: rawEvidence } : {}),
      ...(result.technical_adjudication ? { prior_verdict: gate.verdict } : {}),
      verdict: revised,
      // A later adjudication that restores the raw verdict restores the raw
      // record with it.
      ...(changed
        ? { rationale: review.rationale.trim(), evidence: [adjudicationCitation] }
        : {
            ...(priorRawRationale !== undefined ? { rationale: priorRawRationale } : {}),
            ...(priorRawEvidence !== undefined ? { evidence: priorRawEvidence } : {}),
          }),
      observed: true,
      adjudication_changed: changed,
    }
  })
  const passContract = recomputePassContract({ result, components, gates, official })
  const technicalAdjudication = {
    schema_version: TECHNICAL_ADJUDICATION_SCHEMA_VERSION,
    approved_by: review.approved_by.trim(),
    approved_at: review.approved_at,
    rationale: review.rationale.trim(),
    findings: review.findings.map((finding) => finding.trim()),
    ...(Object.hasOwn(review, 'reviewed_rubric')
      ? {
          reviewed_rubric: Object.fromEntries(
            ['rubric_id', 'version', 'sha256']
              .map((field) => [field, review.reviewed_rubric[field].trim()]),
          ),
        }
      : {}),
    component_scores: componentScores,
    ...(workflowComponentScores
      ? {
          workflow_component_scores: workflowComponentScores,
          prior_workflow_quality_score: priorWorkflow,
          revised_workflow_quality_score: revisedWorkflow,
        }
      : {}),
    ...(gateVerdicts
      ? {
          prior_gate_verdicts: priorGateVerdicts,
          revised_gate_verdicts: gateVerdicts,
        }
      : {}),
    prior_shared_technical_score: priorShared,
    revised_shared_technical_score: revisedShared,
    prior_automated_subtotal: result.score.automated_subtotal?.points
      ?? result.automated_subtotal?.points
      ?? null,
    revised_automated_subtotal: automatedPoints,
    prior_official_score: result.score.official_score ?? result.official_score,
    revised_official_score: official,
    prior_result_fingerprint: resultFingerprint(result),
  }
  const automatedSubtotal = {
    ...(result.score.automated_subtotal ?? result.automated_subtotal),
    points: automatedPoints,
  }
  const score = {
    ...result.score,
    components,
    gates,
    gates_passed: gates.length > 0
      ? gates.every(({ verdict }) => verdict === 'pass')
      : result.score?.gates_passed,
    automated_subtotal: automatedSubtotal,
    official_score: official,
    ...passContract,
  }
  const technicalAdjudicationHistory = result.technical_adjudication
    ? [
        ...(result.technical_adjudication_history ?? []),
        result.technical_adjudication,
      ]
    : result.technical_adjudication_history
  return {
    ...result,
    product_verdict: passContract.official_pass ? 'pass' : 'fail',
    label: passContract.official_pass ? 'PASS' : 'FAIL',
    official_score: official,
    automated_subtotal: automatedSubtotal,
    score,
    baseline: updateBaseline(result.baseline, componentScores, revisedShared, human),
    ...(technicalAdjudicationHistory
      ? { technical_adjudication_history: technicalAdjudicationHistory }
      : {}),
    technical_adjudication: technicalAdjudication,
  }
}

export function validateTechnicalAdjudicationSupersession(published, next) {
  const record = next?.technical_adjudication
  if (!record) return { valid: false, reason: 'technical adjudication record is missing' }
  if (record.schema_version !== TECHNICAL_ADJUDICATION_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `technical adjudication schema version ${JSON.stringify(record.schema_version)} is unsupported`,
    }
  }
  if (record.prior_result_fingerprint !== resultFingerprint(published)) {
    return {
      valid: false,
      reason: 'technical adjudication prior-result fingerprint does not match the published result',
    }
  }
  const review = {
    approved_by: record.approved_by,
    approved_at: record.approved_at,
    rationale: record.rationale,
    findings: record.findings,
    ...(Object.hasOwn(record, 'reviewed_rubric')
      ? { reviewed_rubric: record.reviewed_rubric }
      : {}),
    component_scores: record.component_scores,
    ...(Object.hasOwn(record, 'workflow_component_scores')
      ? { workflow_component_scores: record.workflow_component_scores }
      : {}),
    ...(Object.hasOwn(record, 'revised_gate_verdicts')
      ? { gate_verdicts: record.revised_gate_verdicts }
      : {}),
  }
  try {
    const expected = applyTechnicalAdjudication(published, review)
    if (
      hashJson(adjudicationComparableCore(expected))
      !== hashJson(adjudicationComparableCore(next))
    ) {
      return {
        valid: false,
        reason: 'technical adjudication replacement does not reproduce from its published result and audit record',
      }
    }
    return { valid: true, reason: null }
  } catch (error) {
    return { valid: false, reason: error.message }
  }
}

export function isValidTechnicalAdjudicationSupersession(published, next) {
  return validateTechnicalAdjudicationSupersession(published, next).valid
}

function validateReplacementHumanReview(result, { audit, humanReview, rubric }) {
  if (result?.mode !== 'agent-runner' || result?.evaluation_status !== 'complete') {
    throw new Error('human-review supersession requires a completed Agent Runner candidate result')
  }
  if (result.human_review?.complete !== true || !Number.isFinite(result.human_review?.score?.total)) {
    throw new Error('human-review supersession requires a prior complete human review')
  }
  for (const field of ['approved_by', 'approved_at', 'rationale']) {
    if (typeof audit?.[field] !== 'string' || audit[field].trim().length === 0) {
      throw new Error(`human-review supersession requires ${field}`)
    }
  }
  for (const field of ['rubric_id', 'version', 'sha256']) {
    if (typeof rubric?.[field] !== 'string' || rubric[field].trim().length === 0) {
      throw new Error(`human-review supersession rubric requires ${field}`)
    }
    if (humanReview?.rubric?.[field] !== rubric[field]) {
      throw new Error(`replacement human review does not match rubric ${field}`)
    }
  }
  if (
    humanReview?.complete !== true
    || humanReview?.score?.complete !== true
    || !Array.isArray(humanReview?.responses)
    || humanReview.responses.length === 0
  ) {
    throw new Error('human-review supersession requires a complete replacement human review')
  }
  const { score } = humanReview
  if (!Number.isFinite(score.total) || !Number.isFinite(score.possible) || score.possible <= 0) {
    throw new Error('replacement human-review score requires finite total and possible points')
  }
  const subtotalSum = (score.subtotals ?? []).reduce((sum, subtotal) => sum + subtotal.points, 0)
  if (!Number.isFinite(subtotalSum) || round(subtotalSum) !== round(score.total)) {
    throw new Error('replacement human-review subtotal sum does not match its total')
  }
  const ratings = humanReview.responses.map(({ rating }) => rating)
  if (ratings.some((rating) => !Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw new Error('replacement human review contains an invalid rating')
  }
  if (Math.min(...ratings) !== score.lowest_rating) {
    throw new Error('replacement human-review lowest rating does not match its responses')
  }
}

function updateBaselineHumanReview(baseline, priorHuman, revisedHuman) {
  if (baseline?.comparable !== true) return baseline ?? null
  const adjustment = round(revisedHuman - priorHuman)
  const baselineHuman = baseline.human_review?.baseline
  return {
    ...baseline,
    totals: {
      ...baseline.totals,
      candidate: Number.isFinite(baseline.totals?.candidate)
        ? round(baseline.totals.candidate + adjustment)
        : null,
      delta: Number.isFinite(baseline.totals?.delta)
        ? round(baseline.totals.delta + adjustment)
        : null,
    },
    human_review: {
      ...baseline.human_review,
      candidate: revisedHuman,
      delta: Number.isFinite(baselineHuman) ? round(revisedHuman - baselineHuman) : null,
    },
  }
}

export function applyHumanReviewSupersession(result, replacement) {
  validateReplacementHumanReview(result, replacement)
  const { audit, humanReview, rubric } = replacement
  const priorHuman = result.human_review.score.total
  const revisedHuman = humanReview.score.total
  const automated = result.score?.automated_subtotal?.points ?? result.automated_subtotal?.points
  if (!Number.isFinite(automated)) {
    throw new Error('human-review supersession requires a complete automated subtotal')
  }
  const official = round(automated + revisedHuman)
  const ratings = humanReview.responses.map(({ rating }) => rating)
  const humanComponent = {
    ...(result.score?.human_review ?? {}),
    applicable: true,
    points_awarded: revisedHuman,
    points_possible: humanReview.score.possible,
    points: revisedHuman,
    possible: humanReview.score.possible,
    floor: humanReview.score.floor,
    ratings,
    lowest_rating: humanReview.score.lowest_rating,
    complete: true,
  }
  const passResult = {
    ...result,
    score: { ...result.score, human_review: humanComponent },
  }
  const passContract = recomputePassContract({
    result: passResult,
    components: result.score?.components ?? [],
    gates: result.score?.gates ?? [],
    official,
  })
  const record = {
    schema_version: HUMAN_REVIEW_SUPERSESSION_SCHEMA_VERSION,
    approved_by: audit.approved_by.trim(),
    approved_at: audit.approved_at,
    rationale: audit.rationale.trim(),
    prior_rubric: result.rubrics?.human ?? result.human_review.rubric,
    reviewed_rubric: rubric,
    prior_human_score: priorHuman,
    revised_human_score: revisedHuman,
    prior_official_score: result.score?.official_score ?? result.official_score,
    revised_official_score: official,
    prior_result_fingerprint: resultFingerprint(result),
  }
  const humanReviewHistory = [...(result.human_review_history ?? []), result.human_review]
  const supersessionHistory = result.human_review_supersession
    ? [...(result.human_review_supersession_history ?? []), result.human_review_supersession]
    : result.human_review_supersession_history
  return {
    ...result,
    product_verdict: passContract.official_pass ? 'pass' : 'fail',
    label: passContract.official_pass ? 'PASS' : 'FAIL',
    official_score: official,
    rubrics: { ...result.rubrics, human: rubric },
    score: {
      ...result.score,
      human_review: humanComponent,
      official_score: official,
      ...passContract,
    },
    human_review: humanReview,
    human_review_history: humanReviewHistory,
    human_review_supersession: record,
    ...(supersessionHistory ? { human_review_supersession_history: supersessionHistory } : {}),
    baseline: updateBaselineHumanReview(result.baseline, priorHuman, revisedHuman),
  }
}

export function validateHumanReviewSupersession(published, next) {
  const record = next?.human_review_supersession
  if (!record) return { valid: false, reason: 'human-review supersession record is missing' }
  if (record.schema_version !== HUMAN_REVIEW_SUPERSESSION_SCHEMA_VERSION) {
    return { valid: false, reason: 'human-review supersession schema version is unsupported' }
  }
  if (record.prior_result_fingerprint !== resultFingerprint(published)) {
    return { valid: false, reason: 'human-review supersession prior-result fingerprint does not match' }
  }
  try {
    const expected = applyHumanReviewSupersession(published, {
      audit: {
        approved_by: record.approved_by,
        approved_at: record.approved_at,
        rationale: record.rationale,
      },
      humanReview: next.human_review,
      rubric: record.reviewed_rubric,
    })
    return hashJson(adjudicationComparableCore(expected)) === hashJson(adjudicationComparableCore(next))
      ? { valid: true, reason: null }
      : { valid: false, reason: 'human-review supersession does not reproduce from its audit record' }
  } catch (error) {
    return { valid: false, reason: error.message }
  }
}
