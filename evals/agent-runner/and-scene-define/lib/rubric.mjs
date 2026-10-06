import { join } from 'node:path'
import { readJson, SUITE_ROOT } from './files.mjs'
export const QUALITY_CRITERIA = [
  { id: 'quality:testable-scenarios', requirement: 'Specification scenarios have observable, testable outcomes.', met: 'A scenario names an action and an observable result.', missing: 'Scenarios assert vague success without observable behavior.', examples: { pass: 'WHEN the viewer advances from step 1, THEN step 2 is active and its caption is visible.', fail: 'WHEN the viewer advances, THEN the presentation works well; no observable result is defined.' } },
  { id: 'quality:consistency', requirement: 'Proposal, specifications, design and test plan are consistent.', met: 'Artifacts agree on scoped behavior and decisions.', missing: 'The design contradicts a specification requirement.', examples: { pass: 'The proposal includes present and browse modes; the specification permits switching without changing the current step; the design preserves the index and the test plan checks it.', fail: 'The specification preserves the current step when switching modes, but the design resets the index to zero.' } },
  { id: 'quality:rationale', requirement: 'Design decisions state their rationale.', met: 'A design decision explains why the approach serves the requirements.', missing: 'The design names an approach without explaining why.', examples: { pass: 'The design matches entities by stable identity so continuing entities animate in place across steps.', fail: 'The design lists stable entity identities but gives no reason for that decision.' } },
  { id: 'quality:test-plan', requirement: 'The test plan covers the specified requirements.', met: 'The test plan exercises the behavior specified in requirements.', missing: 'Specified behavior has no corresponding planned check.', examples: { pass: 'The specification requires previous/next navigation and the plan tests both directions, including the first and last steps.', fail: 'The specification requires previous/next navigation, but the test plan only builds the application and never exercises navigation.' } },
]
export function buildRubric(inventory, settings = {}) {
  return { rubric_version: settings.rubric_version ?? 2, inventory_version: inventory.inventory_version,
    provisional: settings.provisional ?? true, components: { coverage: 60, artifact_quality: 25, fidelity: 15 },
    weights: { mandatory: 2, 'acceptable-alternative': 1 }, verdict_values: { met: 1, partial: 0.5, missing: 0 },
    leaked_items: 'Drop from earned and possible coverage; scale over remaining items. If none remain, coverage is zero.',
    coverage: inventory.items.filter(x => x.class !== 'preference').map(x => ({ id: x.id, area: x.area, class: x.class, weight: x.class === 'mandatory' ? 2 : 1, anchors: x.anchors })),
    quality: QUALITY_CRITERIA.map(x => ({ ...x, partial: 'Commits to the criterion but leaves some of its required behavior unclear.', points: 6.25 })),
    fidelity: { deduction_per_exchange: 3, floor: 0, met: 'An artifact specifies the opposite of a preference or outside-inventory answer in a cited exchange.', missing: 'The artifact respects the answer, or added scope does not contradict an answer.', guidance: 'Charge each contradicted exchange once. Contradicted graded items belong only to coverage. Reasonable added scope is diagnostic only.', examples: { deduction: ['The user answers a preference question with: use TypeScript + React + Vite. The design instead mandates plain JavaScript without React; cite that decision and the exchange.', 'For a matter outside the inventory, the user explicitly rejects live collaboration. The proposal includes simultaneous multi-user editing; cite the scope statement and the exchange.'], no_deduction: ['The user requests TypeScript + React + Vite and the design chooses that stack, even if its sections differ from the reference.', 'The design adds a feature outside the inventory that the user never rejected; list the added scope without deducting.', 'The user confirms stable entity continuity, but the design recreates entities between steps. Score that graded contradiction only under coverage, without a second fidelity deduction.'] } },
    guidance: ['Different organization from the reference never lowers a verdict. Example: requirements grouped by viewer journey with the same commitments receive the same credit as requirements grouped by component; do not fail them because headings or order differ.', 'Recording an open question never scores below silently omitting it. Example: a design that records how to preserve the step on a mode switch as unresolved cannot receive less credit than an otherwise identical design that omits that issue; neither open question alone is a commitment that earns met.', 'Coverage requires a commitment in specifications, a design decision, or proposal scope; a test-plan-only or passing mention does not capture an item.', 'Judge acceptable alternatives against intent only.', 'Absent excluded scope is met without an explicit exclusion statement.'],
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
