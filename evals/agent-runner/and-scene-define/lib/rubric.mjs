import { join } from 'node:path'
import { readJson, SUITE_ROOT } from './files.mjs'
export const QUALITY_CRITERIA = [
  { id: 'quality:testable-scenarios', requirement: 'Specification scenarios have observable, testable outcomes.', met: 'A scenario names an action and an observable result.', missing: 'Scenarios assert vague success without observable behavior.' },
  { id: 'quality:consistency', requirement: 'Proposal, specifications, design and test plan are consistent.', met: 'Artifacts agree on scoped behavior and decisions.', missing: 'The design contradicts a specification requirement.' },
  { id: 'quality:rationale', requirement: 'Design decisions state their rationale.', met: 'A design decision explains why the approach serves the requirements.', missing: 'The design names an approach without explaining why.' },
  { id: 'quality:test-plan', requirement: 'The test plan covers the specified requirements.', met: 'The test plan exercises the behavior specified in requirements.', missing: 'Specified behavior has no corresponding planned check.' },
]
export function buildRubric(inventory, settings = {}) {
  return { rubric_version: settings.rubric_version ?? 1, inventory_version: inventory.inventory_version,
    provisional: settings.provisional ?? true, components: { coverage: 60, artifact_quality: 25, fidelity: 15 },
    weights: { mandatory: 2, 'acceptable-alternative': 1 }, verdict_values: { met: 1, partial: 0.5, missing: 0 },
    leaked_items: 'Drop from earned and possible coverage; scale over remaining items. If none remain, coverage is zero.',
    coverage: inventory.items.filter(x => x.class !== 'preference').map(x => ({ id: x.id, area: x.area, class: x.class, weight: x.class === 'mandatory' ? 2 : 1, anchors: x.anchors })),
    quality: QUALITY_CRITERIA.map(x => ({ ...x, partial: 'Commits to the criterion but leaves some of its required behavior unclear.', points: 6.25 })),
    fidelity: { deduction_per_exchange: 3, floor: 0, met: 'An artifact specifies the opposite of a preference or outside-inventory answer in a cited exchange.', missing: 'The artifact respects the answer, or added scope does not contradict an answer.', guidance: 'Charge each contradicted exchange once. Contradicted graded items belong only to coverage. Reasonable added scope is diagnostic only.' },
    guidance: ['Different organization from the reference never lowers a verdict.', 'Recording an open question never scores below silently omitting it.', 'Coverage requires a commitment in specifications, a design decision, or proposal scope; a test-plan-only or passing mention does not capture an item.', 'Judge acceptable alternatives against intent only.', 'Absent excluded scope is met without an explicit exclusion statement.'],
    gates: ['gate:required-artifact:proposal', 'gate:required-artifact:specs', 'gate:required-artifact:design', 'gate:required-artifact:test-plan', 'gate:openspec-validate'],
    pass_threshold: settings.pass_threshold ?? null, calibration_evidence: settings.calibration_evidence ?? null }
}
export function checkRubric(rubric, inventory) {
  const expected = buildRubric(inventory, rubric)
  return JSON.stringify(rubric) === JSON.stringify(expected) ? [] : ['generated rubric diverges from inventory or pinned rubric guidance; rebuild rubric']
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
