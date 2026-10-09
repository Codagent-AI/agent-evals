## MODIFIED Requirements

### Requirement: Eval-owned judges
Judging SHALL be performed by eval-owned judges under a pinned judge profile, split into focused jobs for coverage by inventory area, fidelity, and artifact quality. Each scoring job SHALL be judged independently by a cross-family panel of three judges with identical inputs: one Claude-family judge and two independent Codex-family samples, each with a pinned CLI, model, and effort. A verdict SHALL be settled as follows:
- a verdict all three judges give SHALL stand;
- a verdict two judges give SHALL stand when the two include the Claude-family judge, unless the dissent is backed. A backed dissent is a higher verdict than the majority's, supported by artifact citations that pass validation. A backed dissent SHALL go to a targeted check by the pinned Claude-family decider of the dissent's stated reason. The dissent's verdict SHALL stand when the check confirms that reason, and the majority's otherwise;
- a verdict the two Codex-family judges give against the Claude-family judge, and a three-way split, SHALL be decided by the decider.

The decider SHALL receive the job's inputs and all three panel verdicts with their citations, without being told which model gave which. It SHALL rule a verdict that one of the panel judges gave, with citations that pass validation. A fidelity deduction SHALL be settled the same way, where the judges agree when they cite the same contradicted exchange. A decider ruling that overrules a verdict two panel judges gave SHALL go to a targeted check, by the pinned Claude-family decider model, of the ruling's stated reason against its citations. The ruling SHALL stand when the check confirms that reason, and the two judges' verdict SHALL stand otherwise, including when the check cannot decide. The check SHALL NOT produce a verdict no panel judge gave. A three-way split has no two-judge verdict to restore, so its decider ruling SHALL stand without this check. The check SHALL apply to every define panel job, including the simulated-user disclosure audit, and to every path that re-runs the decider on recorded panel outputs, including calibration's ruling-flip measure. No verdict SHALL be decided by Codex-family judges alone or by a single model call. The result SHALL record every panel verdict, the settlement basis of each item or criterion, every targeted check, every decider ruling, and whether an overrule check upheld or rejected that ruling.

Every judge prompt SHALL include, for each item it judges, the item's statement or intent, its source quotes with their reference headings, and its anchors. It SHALL also include a pinned scope rule: judge only what the cited artifacts establish, add no requirement the item and its anchors do not state, and give undefined terms their plain meaning in the reference. Coverage and fidelity judges SHALL receive the collected artifacts, the inventory items they judge, and, for fidelity, the simulated-user conversation. Citations SHALL depend on the verdict:
- a `met` or `partial` coverage verdict, an artifact-quality finding, and a fidelity deduction SHALL cite artifact locations;
- a `missing` verdict SHALL cite the collected artifacts the judge inspected, and, where an artifact the item would belong in is absent, the gate's record of that absence.

A judge job whose output is malformed, omits a criterion, or gives a verdict without the citation its verdict requires SHALL be retried, and SHALL NOT be scored from that output. A job that still fails after its retries SHALL fail the run as `evaluation-harness-failed`.

#### Scenario: Panel agrees
- **WHEN** all three panel judges mark a coverage item `met`
- **THEN** the item is `met` and no decider call is made for it

#### Scenario: Panel disagrees
- **WHEN** the two Codex-family judges mark a coverage item `met` and the Claude-family judge marks it `missing`
- **THEN** the decider receives all three verdicts and citations, its ruling is one of the panel's verdicts, and the result records the disagreement and ruling

#### Scenario: Cross-family majority stands
- **WHEN** the Claude-family judge and one Codex-family judge mark an item `met`, and the other Codex-family judge marks it `partial`
- **THEN** the item is `met` without a decider call, and the dissent is recorded

#### Scenario: Backed dissent is checked
- **WHEN** the Claude-family judge and one Codex-family judge mark an item `missing`, and the other Codex-family judge marks it `met` citing artifact lines that pass validation
- **THEN** the decider checks that dissent's stated reason
- **AND** the item is `met` when the check confirms the reason, and `missing` otherwise

#### Scenario: Three-way split
- **WHEN** the panel marks an item `met`, `partial`, and `missing`
- **THEN** the decider rules one of those three verdicts with validated citations

#### Scenario: Verdict lacks a citation
- **WHEN** a judge job returns a `met` verdict with no artifact citation
- **THEN** the job is retried and its uncited output is not scored

#### Scenario: Missing verdict for an absent artifact
- **WHEN** the collected change has no design and a judge marks a design-only item `missing`, citing the inspected artifacts and the gate's absence record
- **THEN** the verdict is accepted without a retry and the item scores as `missing`

#### Scenario: A lenient overrule is rejected
- **WHEN** the Claude-family judge marks a removed item `met`, both Codex-family judges mark it `partial`, and the decider rules `met` on citations that do not establish the item
- **THEN** a targeted check judges the decider's stated reason
- **AND** when the check does not confirm it, the item is `partial`, the two Codex-family judges' verdict

#### Scenario: An overrule is upheld
- **WHEN** the decider overrules the two Codex-family judges and the targeted check confirms the decider's stated reason
- **THEN** the decider's ruling stands and the result records the check

#### Scenario: An overrule check cannot decide
- **WHEN** the targeted check of a decider overrule returns `insufficient`
- **THEN** the two judges' verdict stands

#### Scenario: A decider ruling agrees with the two-judge verdict
- **WHEN** both Codex-family judges mark an item `met`, the Claude-family judge marks it `missing`, and the decider rules `met`
- **THEN** no overrule check runs and the item is `met`

#### Scenario: A three-way split keeps its ruling
- **WHEN** the panel marks an item `met`, `partial`, and `missing`, and the decider rules `met`
- **THEN** the ruling stands without an overrule check

#### Scenario: Calibration re-runs the decider
- **WHEN** calibration re-runs the decider on recorded panel outputs and the re-run ruling overrules a two-judge verdict
- **THEN** the overrule check runs before the ruling is counted in the ruling-flip rate
