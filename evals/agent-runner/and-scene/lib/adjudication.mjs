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
    technical_adjudication: _technicalAdjudication,
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
  if (result.technical_adjudication) {
    throw new Error('technical adjudication has already been applied')
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

  const supplied = Object.keys(review.component_scores ?? {}).sort()
  const expected = [...SHARED_COMPONENT_IDS].sort()
  if (hashJson(supplied) !== hashJson(expected)) {
    throw new Error('technical adjudication must score exactly the four shared technical components')
  }

  const indexed = new Map((result.score?.components ?? []).map((component) => [component.id, component]))
  for (const id of SHARED_COMPONENT_IDS) {
    const component = indexed.get(id)
    if (!component || !Number.isFinite(component.points_awarded)) {
      throw new Error(`technical adjudication requires a complete raw score for ${id}`)
    }
    const revised = review.component_scores[id]
    if (!Number.isFinite(revised) || revised < 0 || revised > component.points_possible) {
      throw new Error(
        `${id} adjudicated score ${JSON.stringify(revised)} is outside 0-${component.points_possible}`,
      )
    }
  }
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
  const priorShared = round(
    result.score.components
      .filter(({ id }) => SHARED_COMPONENT_IDS.includes(id))
      .reduce((sum, { points_awarded: points }) => sum + points, 0),
  )
  const revisedShared = round(Object.values(componentScores).reduce((sum, points) => sum + points, 0))
  const components = result.score.components.map((component) => {
    if (!Object.hasOwn(componentScores, component.id)) return component
    const raw = component.points_awarded
    const revised = componentScores[component.id]
    return {
      ...component,
      raw_points_awarded: raw,
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
  const technicalAdjudication = {
    schema_version: TECHNICAL_ADJUDICATION_SCHEMA_VERSION,
    approved_by: review.approved_by.trim(),
    approved_at: review.approved_at,
    rationale: review.rationale.trim(),
    findings: review.findings.map((finding) => finding.trim()),
    component_scores: componentScores,
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
    automated_subtotal: automatedSubtotal,
    official_score: official,
  }
  return {
    ...result,
    official_score: official,
    automated_subtotal: automatedSubtotal,
    score,
    baseline: updateBaseline(result.baseline, componentScores, revisedShared, human),
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
    component_scores: record.component_scores,
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
