import { join } from 'node:path'
import { readJson, SUITE_ROOT } from './files.mjs'
// Each quality criterion is a narrow, countable question: judges list what they
// found and the count decides the verdict. Broad questions ("is the test plan
// good?") split the panel and left the decider ruling close calls inconsistently.
const CONTRADICTION = 'A contradiction is two statements giving different concrete facts about the same thing: a size, a count, a file or path, a name, a route, or whether something happens. Count each contradicted fact once, however many places restate it. A difference in detail, a topic one artifact leaves unaddressed, and a choice the specifications leave open are not contradictions.'
export const QUALITY_CRITERIA = [
  { id: 'quality:observable-outcomes', requirement: 'Every specification scenario\'s THEN clause states an outcome that can be observed or checked.', met: 'Every THEN clause names something checkable: a visible element or state, a value, an exit status, a file, a message, or the active step.', partial: 'One to three scenarios end only in a subjective or unobservable outcome. A scenario whose THEN clause names any checkable outcome passes, even when it also uses a subjective phrase.', missing: 'Four or more scenarios end only in a subjective or unobservable outcome, or the specifications have no scenarios.', examples: { pass: 'WHEN the viewer advances from step 1, THEN step 2 is active and its caption is visible.', fail: 'WHEN the window is resized, THEN the presentation continues to look right.' } },
  { id: 'quality:design-matches-specs', requirement: `The design does not contradict the specifications. ${CONTRADICTION}`, met: 'No design statement contradicts a specification.', partial: 'Exactly one design statement contradicts a specification.', missing: 'Two or more design statements contradict the specifications.', examples: { pass: 'The specification requires a 880 × 380 canvas and the design scales an 880 × 380 stage.', fail: 'The specification requires a 880 × 380 canvas but the design lays out a 960 × 540 stage.' } },
  { id: 'quality:test-plan-matches-specs', requirement: `The test plan's setups and expected results do not contradict the specifications. ${CONTRADICTION}`, met: 'No test-plan expectation contradicts a specification.', partial: 'Exactly one test-plan expectation contradicts a specification.', missing: 'Two or more test-plan expectations contradict the specifications.', examples: { pass: 'The specification defines nine sample steps and the end-to-end test advances through nine.', fail: 'The specification defines nine sample steps but the end-to-end test advances through twelve.' } },
  { id: 'quality:decision-rationale', requirement: 'Each design decision states why it was chosen. A decision is an entry under a decisions heading or an explicit choice between approaches; a reason is any stated purpose, requirement served, or trade-off, such as "because", "so that", or "chosen over". The reason must be stated with the decision, in its own entry or in the passage that makes the choice; a reason you would have to infer from another section does not count.', met: 'At most one decision lacks a reason.', partial: 'Two or more decisions lack a reason, but at least half give one.', missing: 'Fewer than half of the decisions give a reason, or the design states no decisions.', examples: { pass: 'Registry entries are an explicit array, chosen over a file glob so registration is deterministic and reviewable.', fail: 'Registry: explicit array.' } },
  { id: 'quality:requirements-tested', requirement: 'Each specification requirement (each "### Requirement" heading) has a planned check. A requirement counts as checked when a named test or the coverage map exercises its main behavior, or the plan explicitly assigns its logic to focused or unit tests. Individual scenarios and details need no test of their own.', met: 'Every requirement has a planned check.', partial: 'One or two requirements have no planned check.', missing: 'Three or more requirements have no planned check, or there is no test plan.', examples: { pass: 'The specification requires previous/next navigation and an acceptance test navigates in both directions.', fail: 'The specification requires present and browse modes, navigation, and boundary behavior, and no planned test exercises any of them.' } },
]
// Calibrated settings are recorded in rubric.json itself and round-trip through
// buildRubric; coverage criteria, anchors, quality text, guidance and gates are
// always regenerated from the inventory and this module. These defaults are
// the provisional pre-calibration values.
export const CALIBRATION_LIMITS_NOTE = 'Provisional limits pending E2E-003 calibration evidence and maintainer approval (HT-002). restructured_tolerance_items: total coverage weight the restructured reference may lose versus the reference. max_spread: total-score points by which repeated judging of one input may differ.'
export const RUBRIC_SETTINGS_DEFAULTS = Object.freeze({
  rubric_version: 3, provisional: true,
  components: { coverage: 70, artifact_quality: 15, fidelity: 15 },
  weights: { mandatory: 2, 'acceptable-alternative': 1 },
  quality_points: Object.fromEntries(QUALITY_CRITERIA.map(x => [x.id, 15 / QUALITY_CRITERIA.length])),
  fidelity: { deduction_per_exchange: 3, floor: 0 },
  calibration: { restructured_tolerance_items: 3, max_spread: 5, provisional: true, note: CALIBRATION_LIMITS_NOTE },
  pass_threshold: null, calibration_evidence: null,
})
// Extract the recordable settings from an existing rubric, filling defaults.
export function rubricSettings(rubric = {}) {
  const d = RUBRIC_SETTINGS_DEFAULTS
  const quality = Array.isArray(rubric.quality) ? Object.fromEntries(rubric.quality.map(x => [x.id, x.points])) : null
  return { rubric_version: rubric.rubric_version ?? d.rubric_version, provisional: rubric.provisional ?? d.provisional,
    components: { ...d.components, ...rubric.components }, weights: { ...d.weights, ...rubric.weights },
    quality_points: quality ?? { ...d.quality_points },
    fidelity: { deduction_per_exchange: rubric.fidelity?.deduction_per_exchange ?? d.fidelity.deduction_per_exchange, floor: rubric.fidelity?.floor ?? d.fidelity.floor },
    calibration: { ...d.calibration, ...rubric.calibration },
    pass_threshold: rubric.pass_threshold ?? d.pass_threshold, calibration_evidence: rubric.calibration_evidence ?? d.calibration_evidence }
}
const finite = (value, min = 0) => typeof value === 'number' && Number.isFinite(value) && value >= min
const near = (a, b) => Math.abs(a - b) < 1e-9
export function validateRubricSettings(settings) {
  const errors = []
  const { components, weights, quality_points: points, fidelity, calibration, pass_threshold: threshold } = settings
  if (!['coverage', 'artifact_quality', 'fidelity'].every(key => finite(components?.[key])) || Object.keys(components ?? {}).length !== 3) errors.push('rubric components must be coverage, artifact_quality and fidelity points')
  else if (!near(components.coverage + components.artifact_quality + components.fidelity, 100)) errors.push('rubric components must sum to 100 points')
  if (!['mandatory', 'acceptable-alternative'].every(key => finite(weights?.[key]) && weights[key] > 0) || Object.keys(weights ?? {}).length !== 2) errors.push('rubric item weight must be positive for mandatory and acceptable-alternative')
  const ids = QUALITY_CRITERIA.map(x => x.id)
  if (Object.keys(points ?? {}).length !== ids.length || !ids.every(id => finite(points[id]))) errors.push('rubric quality points must name every quality criterion')
  else if (finite(components?.artifact_quality) && !near(ids.reduce((sum, id) => sum + points[id], 0), components.artifact_quality)) errors.push('rubric quality points must sum to the artifact_quality component')
  if (!finite(fidelity?.deduction_per_exchange)) errors.push('rubric fidelity deduction must be a non-negative number')
  if (!finite(fidelity?.floor) || (finite(components?.fidelity) && fidelity.floor > components.fidelity)) errors.push('rubric fidelity floor must lie within the fidelity component')
  for (const key of ['restructured_tolerance_items', 'max_spread']) if (!finite(calibration?.[key])) errors.push(`rubric calibration ${key} must be a non-negative number`)
  if (threshold !== null && !(finite(threshold) && threshold <= 100)) errors.push('rubric pass threshold must be null or between 0 and 100')
  return errors
}
export function buildRubric(inventory, overrides = {}) {
  const settings = { ...RUBRIC_SETTINGS_DEFAULTS, ...overrides }
  return { rubric_version: settings.rubric_version, inventory_version: inventory.inventory_version,
    provisional: settings.provisional, components: { ...settings.components },
    weights: { ...settings.weights }, verdict_values: { met: 1, partial: 0.5, missing: 0 },
    leaked_items: 'Drop from earned and possible coverage; scale over remaining items. If none remain, coverage and the total are unavailable and there is no verdict unless a gate failed.',
    coverage: inventory.items.filter(x => x.class !== 'preference').map(x => ({ id: x.id, area: x.area, class: x.class, weight: settings.weights[x.class], anchors: x.anchors })),
    quality: QUALITY_CRITERIA.map(x => ({ ...x, points: settings.quality_points?.[x.id] })),
    fidelity: { deduction_per_exchange: settings.fidelity.deduction_per_exchange, floor: settings.fidelity.floor, met: 'An artifact specifies the opposite of a preference or outside-inventory answer in a cited exchange.', missing: 'The artifact respects the answer, or added scope does not contradict an answer.', guidance: 'Charge each contradicted exchange once. Contradicted graded items belong only to coverage. Reasonable added scope is diagnostic only.', examples: { deduction: ['The user answers a preference question with: use TypeScript + React + Vite. The design instead mandates plain JavaScript without React; cite that decision and the exchange.', 'For a matter outside the inventory, the user explicitly rejects live collaboration. The proposal includes simultaneous multi-user editing; cite the scope statement and the exchange.'], no_deduction: ['The user requests TypeScript + React + Vite and the design chooses that stack, even if its sections differ from the reference.', 'The design adds a feature outside the inventory that the user never rejected; list the added scope without deducting.', 'The user confirms stable entity continuity, but the design recreates entities between steps. Score that graded contradiction only under coverage, without a second fidelity deduction.'] } },
    guidance: ['Different organization from the reference never lowers a verdict. Example: requirements grouped by viewer journey with the same commitments receive the same credit as requirements grouped by component; do not fail them because headings or order differ.', 'Recording an open question never scores below silently omitting it. Example: a design that records how to preserve the step on a mode switch as unresolved cannot receive less credit than an otherwise identical design that omits that issue; neither open question alone is a commitment that earns met.', 'Coverage requires a commitment in specifications, a design decision, or proposal scope; a test-plan-only or passing mention does not capture an item.', 'Judge acceptable alternatives against intent only.', 'Absent excluded scope is met without an explicit exclusion statement.'],
    gates: ['gate:required-artifact:proposal', 'gate:required-artifact:specs', 'gate:required-artifact:design', 'gate:required-artifact:test-plan', 'gate:openspec-validate'],
    calibration: { ...settings.calibration },
    pass_threshold: settings.pass_threshold, calibration_evidence: settings.calibration_evidence }
}
export function checkRubric(rubric, inventory) {
  const settings = rubricSettings(rubric)
  const errors = validateRubricSettings(settings)
  if (JSON.stringify(rubric) !== JSON.stringify(buildRubric(inventory, settings))) errors.push('generated rubric diverges from inventory or pinned rubric guidance; rebuild rubric')
  return errors
}
export function verifyJudgingInputs({ inventory, rubric, candidate = true }) {
  if (rubric.inventory_version !== inventory.inventory_version) throw new Error('rubric inventory version does not match pinned inventory')
  if (checkRubric(rubric, inventory).length) throw new Error(checkRubric(rubric, inventory).join('\n'))
  if (!candidate) return
  const review = inventory.anchors_review
  if (!review?.reviewer?.trim() || !review.date || review.inventory_version !== inventory.inventory_version) throw new Error('anchors need review (HT-003) for the pinned inventory version')
  if (!Number.isFinite(rubric.pass_threshold)) throw new Error('rubric is uncalibrated: calibration must set the pass threshold first')
  if (rubric.pass_threshold < 0 || rubric.pass_threshold > 100) throw new Error('rubric pass threshold must be between 0 and 100')
}
export async function checkJudgingInputs({ suiteRoot = SUITE_ROOT, inventory, dryRun = false }) {
  verifyJudgingInputs({ inventory, rubric: await readJson(join(suiteRoot, 'rubric.json')), candidate: !dryRun })
}
