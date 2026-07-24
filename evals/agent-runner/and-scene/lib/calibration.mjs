// Autonomous known-good / degraded calibration.
//
// Calibration answers one question before the first full Agent Runner
// evaluation is allowed to cost anything: does this harness attribute quality to
// the right place? It runs the known-good reference and a suite-owned set of
// degraded mutations without invoking Agent Runner, a browser, or a human, and
// asserts that
//
//   * the reference earns its expected automated range, opens every hard gate,
//     and reaches an official pass, and
//   * each approved mutation degrades exactly the component or gate it was
//     designed to degrade, degrades nothing else, and stays a *product*
//     regression rather than becoming a harness failure.
//
// The mutations are applied to evaluator output, not to a candidate checkout.
// That is deliberate: what is being calibrated is the scoring, gating, result,
// and reporting path, and mutating a checkout would test the demo instead while
// costing a build and a browser for every case.
//
// Everything calibration writes is a diagnostic. Its results carry
// `mode: 'calibration'`, which `lib/publication.mjs` refuses outright, so no
// calibration artifact can ever become a published record.
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  firstUnanswered,
  recordResponse,
  createReviewState,
  scoreHumanReview,
  validateResponse,
  validateSavedReview,
} from './human-review.mjs'
import { runProductJudging } from './judge-jobs.mjs'
import { applyOutcomeEvent, createOutcome } from './outcomes.mjs'
import { hashFile, hashJson, writeJsonAtomic } from './persistence.mjs'
import { renderReport } from './report.mjs'
import { assembleResult, writeResultArtifacts } from './result.mjs'
import { loadRubrics, rubricCriteria, rubricProvenance } from './rubric.mjs'
import { scoreProduct } from './scorer.mjs'

export const CALIBRATION_SCHEMA_VERSION = 1

const LIB_DIR = dirname(fileURLToPath(import.meta.url))

// Everything outside the two rubrics that decides what a calibration case
// scores, gates, or reports. Rubric bytes are already covered by rubric
// provenance; this covers the code that acts on them, so a scorer or gate edit
// invalidates a passing record instead of silently inheriting it.
export const HARNESS_FINGERPRINT_SOURCES = [
  'calibration.mjs',
  'scorer.mjs',
  'rubric.mjs',
  'judge-jobs.mjs',
  'human-review.mjs',
  'outcomes.mjs',
  'result.mjs',
  'report.mjs',
]

export async function harnessFingerprint() {
  const entries = []
  for (const name of HARNESS_FINGERPRINT_SOURCES) {
    entries.push([name, await hashFile(join(LIB_DIR, name))])
  }
  return hashJson(Object.fromEntries(entries))
}

// What a calibration record must still match before it may unblock a full
// evaluation. A record is a statement about one harness and one pair of
// rubrics; it says nothing about any other.
export async function calibrationIdentity(rubrics = null) {
  return {
    schema_version: CALIBRATION_SCHEMA_VERSION,
    rubrics: rubricProvenance(rubrics ?? await loadRubrics()),
    harness_fingerprint: await harnessFingerprint(),
  }
}

// The mode every calibration artifact records, and the one `publicationEligibility`
// refuses by name.
export const CALIBRATION_MODE = 'calibration'

const CALIBRATION_AUTHORITY = { cli: 'calibration-fixture', model: 'suite-owned' }

function criteriaOf(rubric, predicate) {
  return rubricCriteria(rubric).filter(predicate).map(({ id }) => id)
}

// The approved case set: the reference, one mutation per scored component, one
// per hard gate, and two synthetic human-review regressions. Derived from the
// rubric rather than hard-coded, so a rubric edit cannot silently leave a
// component or gate uncalibrated.
export function calibrationCases(rubric) {
  const componentCases = rubric.components.map((component) => {
    const ids = criteriaOf(rubric, (row) => row.component === component.id)
    // A component with a floor sinks the pass contract on its own; one without
    // only costs its points, and the case records which is expected.
    const remaining = rubric.automated_points - component.points
    const expectedPass = component.floor === null || component.floor === undefined
      ? remaining + rubric.human_points >= rubric.pass_threshold
      : false
    return {
      id: `${component.id}-regression`,
      description: `every criterion of ${component.id} fails`,
      target: { kind: 'component', id: component.id },
      fail_criteria: ids,
      fail_gates: [],
      human: null,
      expected_official_pass: expectedPass,
    }
  })

  const gateCases = rubric.gates.map((gate) => ({
    id: `${gate.id}-gate-regression`,
    description: `the ${gate.id} hard gate fails`,
    target: { kind: 'gate', id: gate.id },
    fail_criteria: [],
    fail_gates: [gate.id],
    human: null,
    expected_official_pass: false,
  }))

  return [
    {
      id: 'reference',
      description: 'the known-good reference: every criterion and gate passes',
      target: { kind: 'reference', id: 'reference' },
      fail_criteria: [],
      fail_gates: [],
      human: null,
      expected_official_pass: true,
    },
    ...componentCases,
    ...gateCases,
    {
      id: 'human-rating-one-regression',
      description: 'a single human rating of 1 blocks an otherwise passing candidate',
      target: { kind: 'human-review', id: 'human-rating-one' },
      fail_criteria: [],
      fail_gates: [],
      human: { first: 1, rest: 5 },
      expected_official_pass: false,
    },
    {
      id: 'human-floor-regression',
      description: 'a uniformly weak human review falls under the component floor',
      target: { kind: 'human-review', id: 'human-floor' },
      fail_criteria: [],
      fail_gates: [],
      human: { first: 2, rest: 2 },
      expected_official_pass: false,
    },
  ]
}

function verdictFor(id, failing) {
  return {
    id,
    verdict: failing.has(id) ? 'fail' : 'pass',
    rationale: 'calibration fixture verdict',
    evidence: ['calibration-fixture'],
  }
}

// The suite-owned judge stand-in. It answers exactly the criteria the request
// asks for, so the real judge-job path — request construction, schema parsing,
// coverage validation, and retry accounting — is exercised without a model call.
export function fixtureJudgeInvoke(failing) {
  return async (request) => JSON.stringify({
    results: request.criteria.map((id) => verdictFor(id, failing)),
  })
}

// Deterministic browser evidence and gate evidence for one case.
export function calibrationEvidence(rubric, { failCriteria = [], failGates = [] } = {}) {
  const failing = new Set(failCriteria)
  const failingGates = new Set(failGates)
  return {
    criteria: criteriaOf(rubric, (row) => row.evaluator === 'deterministic-browser')
      .map((id) => verdictFor(id, failing)),
    gates: rubric.gates.map(({ id }) => verdictFor(id, failingGates)),
    failing,
  }
}

// The synthetic reviewer. Answers are generated, never invented on a human's
// behalf: they exist to exercise validation, arithmetic, gates, resume, and
// rendering, and they are recorded as fixtures in the diagnostics.
export function syntheticReview(humanRubric, { first = 5, rest = 5 } = {}) {
  let state = createReviewState({
    candidate: { candidate_identity: 'calibration-fixture', run_id: 'calibration' },
    rubric: { rubric_id: humanRubric.rubric_id, version: humanRubric.version, sha256: 'calibration' },
  })
  for (const [index, question] of humanRubric.questions.entries()) {
    const rating = index === 0 ? first : rest
    state = recordResponse(humanRubric, state, {
      id: question.id,
      rating,
      rationale: rating <= humanRubric.rationale_required_at_or_below ? 'calibration fixture rationale' : '',
    })
  }
  const score = scoreHumanReview(humanRubric, state)
  return { ...state, score, complete: true, completed_at: null }
}

// Compare one degraded case against the reference and report both halves of the
// contract: the intended target degraded, and nothing else did.
function compareToReference({ reference, score, target }) {
  const problems = []
  const unintended = []

  for (const component of score.components) {
    const referenceComponent = reference.components.find(({ id }) => id === component.id)
    const intended = target.kind === 'component' && target.id === component.id
    if (intended) {
      if (!(component.points_awarded < referenceComponent.points_awarded)) {
        problems.push(
          `${component.id} was expected to lose points but scored ${component.points_awarded}`,
        )
      }
      continue
    }
    if (component.points_awarded !== referenceComponent.points_awarded) {
      unintended.push({
        kind: 'component',
        id: component.id,
        reference: referenceComponent.points_awarded,
        observed: component.points_awarded,
      })
    }
  }

  for (const gate of score.gates) {
    const referenceGate = reference.gates.find(({ id }) => id === gate.id)
    const intended = target.kind === 'gate' && target.id === gate.id
    if (intended) {
      if (gate.verdict !== 'fail') problems.push(`gate ${gate.id} was expected to fail but is ${gate.verdict}`)
      continue
    }
    if (gate.verdict !== referenceGate.verdict) {
      unintended.push({ kind: 'gate', id: gate.id, reference: referenceGate.verdict, observed: gate.verdict })
    }
  }

  if (target.kind === 'human-review' && !score.pass_failures.some(({ rule }) => rule === target.id)) {
    problems.push(`the pass contract was expected to record a ${target.id} failure`)
  }

  return { problems, unintended }
}

// Exercise the human-review library the way a reviewer's session would, with no
// reviewer. Each check is reported by name so a calibration failure says which
// guarantee broke.
export function humanReviewChecks(humanRubric, referenceResult) {
  const checks = []
  const record = (id, ok, detail) => checks.push({ id, ok, detail })

  const { max } = humanRubric.rating_scale
  record(
    'rejects-out-of-range-rating',
    validateResponse(humanRubric, { rating: max + 1, rationale: 'out of range' }).ok === false,
    `a rating of ${max + 1} must be refused`,
  )

  const threshold = humanRubric.rationale_required_at_or_below
  record(
    'requires-rationale-at-or-below-threshold',
    validateResponse(humanRubric, { rating: threshold, rationale: '' }).ok === false
      && validateResponse(humanRubric, { rating: threshold, rationale: 'explained' }).ok === true,
    `a rating of ${threshold} must require a rationale`,
  )

  const complete = syntheticReview(humanRubric)
  record(
    'scores-a-complete-review',
    complete.score.complete === true
      && complete.score.total === humanRubric.points
      && complete.score.gate_passed === true,
    `an all-${max} review must score exactly ${humanRubric.points}`,
  )

  // Resume: a partial review reopens at the first unanswered question.
  let partial = createReviewState({
    candidate: { candidate_identity: 'calibration-fixture' },
    rubric: { rubric_id: humanRubric.rubric_id, version: humanRubric.version, sha256: 'calibration' },
  })
  const answered = humanRubric.questions.slice(0, 5)
  for (const question of answered) {
    partial = recordResponse(humanRubric, partial, { id: question.id, rating: 4, rationale: '' })
  }
  const next = firstUnanswered(humanRubric, partial)
  record(
    'resumes-at-the-first-unanswered-question',
    next?.id === humanRubric.questions[answered.length].id
      && scoreHumanReview(humanRubric, partial).complete === false,
    'a partial review must resume in order and score nothing',
  )

  // A saved review edited outside the interview must never reach the arithmetic.
  const corrupted = {
    ...complete,
    responses: complete.responses.map((response, index) => (
      index === 0 ? { ...response, rating: max + 4 } : response
    )),
  }
  record(
    'rejects-a-corrupted-saved-review',
    validateSavedReview(humanRubric, corrupted).length > 0
      && scoreHumanReview(humanRubric, corrupted).complete === false,
    'an edited saved rating must be refused',
  )

  let rendered = ''
  let renderError = null
  try {
    rendered = renderReport(referenceResult, { current: referenceResult })
  } catch (error) {
    renderError = error.message
  }
  record(
    'renders-the-finalized-report',
    renderError === null && rendered.startsWith('<!doctype html>') && rendered.includes('PASS'),
    renderError ?? 'the finalized reference report must render',
  )

  return checks
}

async function runCase({ rubrics, definition, outDir, judgeInvoke }) {
  const rubric = rubrics.automated.rubric
  const evidence = calibrationEvidence(rubric, {
    failCriteria: definition.fail_criteria,
    failGates: definition.fail_gates,
  })
  const invoke = judgeInvoke ?? fixtureJudgeInvoke(evidence.failing)

  const judging = await runProductJudging({
    rubrics,
    authority: CALIBRATION_AUTHORITY,
    evidence: [...evidence.criteria, ...evidence.gates],
    sources: ['calibration-fixture'],
    invoke,
  })

  const humanReview = syntheticReview(rubrics.human.rubric, definition.human ?? {})
  const score = scoreProduct({
    rubrics,
    deterministic: evidence.criteria,
    judges: judging.judges,
    gates: evidence.gates,
    humanReview: { ratings: humanReview.responses.map(({ rating }) => rating), total: humanReview.score.total },
    harness: { judge_retries: judging.retries, failed_judge_jobs: judging.failed_jobs },
    mode: CALIBRATION_MODE,
  })

  let outcome = applyOutcomeEvent(createOutcome(), {
    type: 'automated-scoring-complete',
    automated_subtotal: score.automated_subtotal.points,
  })
  outcome = applyOutcomeEvent(outcome, {
    type: 'product-verdict',
    verdict: score.official_pass ? 'pass' : 'fail',
    official_score: score.official_score,
  })

  const result = assembleResult({
    runId: definition.id,
    mode: CALIBRATION_MODE,
    outcome,
    rubrics: rubricProvenance(rubrics),
    score,
    humanReview,
    judging,
    browser: { criteria: evidence.criteria, gates: evidence.gates, bounds_exceeded: [] },
  })

  const caseDir = join(outDir, 'cases', definition.id)
  await mkdir(caseDir, { recursive: true })
  await writeResultArtifacts({ runDir: caseDir, result })

  return { definition, score, judging, result, dir: caseDir }
}

export async function runCalibration({
  rubrics,
  outDir,
  cases = null,
  // A live judge authority may be injected to calibrate against the real
  // evaluator; without one the suite-owned fixture judge answers instead.
  judgeInvoke = null,
  log = () => {},
}) {
  const rubric = rubrics.automated.rubric
  const definitions = cases ?? calibrationCases(rubric)
  const referenceDefinition = definitions.find(({ id }) => id === 'reference')
  if (!referenceDefinition) throw new Error('calibration requires a reference case')

  const executed = []
  for (const definition of definitions) {
    executed.push(await runCase({ rubrics, definition, outDir, judgeInvoke }))
  }

  const reference = executed.find(({ definition }) => definition.id === 'reference')
  const referenceProblems = []
  if (reference.score.automated_subtotal.points !== rubric.automated_points) {
    referenceProblems.push(
      `the reference scored ${reference.score.automated_subtotal.points} of the expected ${rubric.automated_points} automated points`,
    )
  }
  if (reference.score.gates_passed !== true) referenceProblems.push('the reference did not open every hard gate')
  if (reference.score.official_pass !== true) referenceProblems.push('the reference did not reach an official pass')

  const reported = executed.map(({ definition, score, judging, result }) => {
    const isReference = definition.id === 'reference'
    const comparison = isReference
      ? { problems: referenceProblems, unintended: [] }
      : compareToReference({ reference: reference.score, score, target: definition.target })
    const problems = [...comparison.problems]
    // Collateral damage fails the case as surely as a target that never moved.
    // A mutation that also degrades something it does not name means the harness
    // is not attributing quality where it claims to, which is the whole thing
    // calibration exists to prove.
    for (const regression of comparison.unintended) {
      problems.push(
        `unintended regression in ${regression.kind} ${regression.id}: `
        + `reference ${regression.reference}, observed ${regression.observed}`,
      )
    }
    if (score.official_pass !== definition.expected_official_pass) {
      problems.push(
        `expected official_pass ${definition.expected_official_pass} but observed ${score.official_pass}`,
      )
    }
    // A degradation must remain a product regression. Anything that reports the
    // harness as the failing party means the mutation broke the eval, not the
    // candidate, and calibration must not pass on it.
    if (result.evaluation_status !== 'complete') {
      problems.push(`the case ended ${result.evaluation_status} rather than complete`)
    }
    if (judging.failed_jobs.length > 0) {
      problems.push(`judge jobs failed: ${judging.failed_jobs.join(', ')}`)
    }
    return {
      id: definition.id,
      description: definition.description,
      target: definition.target,
      ok: problems.length === 0,
      problems,
      unintended_regressions: comparison.unintended,
      evaluation_status: result.evaluation_status,
      automated_subtotal: score.automated_subtotal.points,
      official_score: score.official_score,
      official_pass: score.official_pass,
      gates_passed: score.gates_passed,
      pass_failures: score.pass_failures,
      judging: { judges: judging.judges, retries: judging.retries, failed_jobs: judging.failed_jobs },
      artifacts: join('cases', definition.id),
    }
  })

  const checks = humanReviewChecks(rubrics.human.rubric, reference.result)
  const failures = [
    ...reported.filter(({ ok }) => !ok).flatMap(({ id, problems }) => problems.map((problem) => ({
      case: id, problem,
    }))),
    ...checks.filter(({ ok }) => !ok).map(({ id, detail }) => ({ case: `human-review:${id}`, problem: detail })),
  ]

  const ledger = {
    schema_version: CALIBRATION_SCHEMA_VERSION,
    mode: CALIBRATION_MODE,
    passed: failures.length === 0,
    rubrics: rubricProvenance(rubrics),
    expected_automated_points: rubric.automated_points,
    cases: reported,
    human_review_checks: checks,
    failures,
  }
  await writeJsonAtomic(join(outDir, 'calibration.json'), ledger)
  log(`calibration: ${ledger.passed ? 'passed' : 'failed'} (${reported.length} cases, ${failures.length} failures)`)
  return ledger
}
