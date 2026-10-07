## ADDED Requirements

### Requirement: Versioned rubric and score contract
The suite SHALL score definitions under a versioned rubric that declares its components, criteria, points, gates, and pass threshold, and the version of the hidden-reference inventory it applies to. The score SHALL be out of 100 automated points with no human-review component, divided among requirement coverage, artifact quality, and fidelity. The rubric SHALL record the calibration evidence its weights and pass threshold were set from. The result SHALL report each component's score, every criterion's verdict and citations, every gate's outcome, and the rubric version.

#### Scenario: Result reports the score breakdown
- **WHEN** a complete run is scored
- **THEN** the result reports the total, each component's score, every criterion's verdict with citations, every gate's outcome, and the rubric version

#### Scenario: Rubric applies to a different inventory version
- **WHEN** the rubric's declared inventory version differs from the pinned inventory
- **THEN** preflight fails before any model call and identifies the mismatch

### Requirement: Gates
A definition SHALL fail through a hard gate when the collected change lacks a proposal, specifications, a design, or a test plan, or when `openspec validate` fails on the collected change. A gate failure SHALL make `definition_verdict` `fail` regardless of score, and every component SHALL still be judged on the artifacts that exist and reported as diagnostics.

#### Scenario: Validation fails
- **WHEN** `openspec validate` reports an error for the collected change
- **THEN** `definition_verdict` is `fail` through the validation gate
- **AND** the component scores are still reported as diagnostics

### Requirement: Requirement coverage
The rubric SHALL contain one coverage criterion for each `mandatory` and `acceptable-alternative` inventory item and none for `preference` items. Each criterion SHALL be judged `met`, `partial`, or `missing`, where `partial` means the artifacts commit to the item's intent but leave out or weaken part of what the item requires: a `mandatory` item against its statement, and an `acceptable-alternative` item against its intent only, so a different mechanism that achieves the intent is `met`. An item SHALL count as captured only where an artifact commits to it in a specification requirement or scenario, a design decision, or a proposal scope statement; a mention only in the test plan or in passing SHALL NOT count. A `scope-exclusion` item SHALL be `met` when the definition does not include the excluded scope, without requiring an explicit exclusion statement. Each criterion SHALL be judged against its item's pinned anchors, which state in the reference's own words what counts as `met`, `partial`, and `missing`. A definition that contradicts a graded item SHALL be scored under that item's coverage criterion only. An item the disclosure audit marks leaked SHALL be excluded from both the earned and the possible coverage points and reported as `leaked`. When every graded item is leaked, coverage and the total SHALL be reported as unavailable rather than zero, and `definition_verdict` SHALL be unavailable with that reason unless a gate failed. Coverage SHALL be the primary component.

#### Scenario: Alternative mechanism meets the intent
- **WHEN** a definition specifies a different mechanism that achieves an `acceptable-alternative` item's intent
- **THEN** that criterion is `met`

#### Scenario: Item appears only in the test plan
- **WHEN** a requirement appears only as a test-plan case with no corresponding specification, design decision, or scope statement
- **THEN** that criterion is not `met`

#### Scenario: Anchor decides a borderline item
- **WHEN** a definition commits to an item in a way its `partial` anchor describes
- **THEN** that criterion is `partial`, and the verdict cites the artifact location

#### Scenario: Every graded item leaked
- **WHEN** the disclosure audit marks every `mandatory` and `acceptable-alternative` item leaked and every gate passes
- **THEN** the coverage score and the total are reported as unavailable, not zero
- **AND** `definition_verdict` is unavailable, with the reason that coverage could not be measured

#### Scenario: Excluded scope is simply absent
- **WHEN** a definition neither includes nor mentions an excluded scope item
- **THEN** that `scope-exclusion` criterion is `met`

### Requirement: Fidelity
The fidelity component SHALL deduct for a definition that contradicts an answer the simulated user gave in the run's conversation, when that answer concerns a `preference` item or a matter outside the inventory. A contradiction of a `mandatory` or `acceptable-alternative` item, including one the simulated user stated, SHALL be scored once, under that item's coverage criterion, and SHALL NOT also be deducted under fidelity. Each deduction SHALL cite both the artifact location and the contradicted exchange. Scope a definition adds beyond the inventory SHALL NOT be deducted unless it contradicts the simulated user; included excluded scope is scored by its `scope-exclusion` coverage criterion.

#### Scenario: Definition ignores the user's answer
- **WHEN** the simulated user stated a preference that the inventory does not grade, and the definition specifies the opposite
- **THEN** fidelity is deducted, citing the artifact location and the exchange

#### Scenario: Contradiction of a graded item is scored once
- **WHEN** a definition contradicts a `mandatory` item that the simulated user also stated in an answer
- **THEN** the item's coverage criterion is not `met`, and fidelity makes no deduction for it

#### Scenario: Reasonable added scope
- **WHEN** a definition adds behavior the inventory does not contain, which neither falls under a scope exclusion nor contradicts the simulated user
- **THEN** no score is deducted for it

### Requirement: Added-scope diagnostic
The report SHALL list scope the definition adds beyond the inventory, with citations, as a non-scoring diagnostic.

#### Scenario: Added scope is listed
- **WHEN** a definition specifies behavior the inventory does not contain
- **THEN** the report lists it as added scope and it does not change the score

### Requirement: Artifact quality
The artifact-quality component SHALL judge the definition independently of the hidden reference through narrow, countable criteria: specification scenarios whose outcomes are observable, a design that does not contradict the specifications, test-plan expectations that do not contradict the specifications, design decisions that state a reason, and a planned check for every specification requirement. Each criterion's `met`, `partial`, and `missing` SHALL be defined by a count of the instances the judge lists, so that its verdict does not rest on an overall impression. Artifact-quality judges SHALL NOT receive the inventory or the hidden reference.

#### Scenario: Quality judging is reference-independent
- **WHEN** an artifact-quality judge job runs
- **THEN** its input contains the collected artifacts and no inventory item or hidden-reference content

#### Scenario: Untestable scenario
- **WHEN** a specification scenario's outcome cannot be observed or tested
- **THEN** the observable-outcomes criterion is not fully met and the verdict cites that scenario

### Requirement: Eval-owned judges
Judging SHALL be performed by eval-owned judges under a pinned judge profile, split into focused jobs for coverage by inventory area, fidelity, and artifact quality. Each scoring job SHALL be judged independently by a cross-family panel of three judges with identical inputs: one Claude-family judge and two independent Codex-family samples, each with a pinned CLI, model, and effort. A verdict SHALL be settled as follows:
- a verdict all three judges give SHALL stand;
- a verdict two judges give SHALL stand when the two include the Claude-family judge, unless the dissent is backed. A backed dissent is a higher verdict than the majority's, supported by artifact citations that pass validation. A backed dissent SHALL go to a targeted check by the pinned Claude-family decider of the dissent's stated reason. The dissent's verdict SHALL stand when the check confirms that reason, and the majority's otherwise;
- a verdict the two Codex-family judges give against the Claude-family judge, and a three-way split, SHALL be decided by the decider.

The decider SHALL receive the job's inputs and all three panel verdicts with their citations, without being told which model gave which. It SHALL rule a verdict that one of the panel judges gave, with citations that pass validation. A fidelity deduction SHALL be settled the same way, where the judges agree when they cite the same contradicted exchange. No verdict SHALL be decided by Codex-family judges alone or by a single model call. The result SHALL record every panel verdict, the settlement basis of each item or criterion, every targeted check, and every decider ruling.

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

### Requirement: Calibration
The `--calibrate` mode SHALL judge a calibration set, repeating each input at least three times, and report judge accuracy, stability, and the resulting score of each input. The calibration set SHALL include the fixture's own change; a restructured reference that renames, merges, splits, and rewords it and replaces `acceptable-alternative` mechanisms with others that meet their intents; degraded variants of both with items removed, contradictions planted, excluded scope added, and quality defects introduced; and, when available, real candidate definitions with maintainer-reviewed verdicts. Each synthetic input SHALL carry its expected per-item verdicts. Calibration SHALL report a failure when a removed `mandatory` item is not detected, when the restructured reference loses more items than the pinned tolerance, or when repeated judging of one input differs by more than the pinned spread. Calibration SHALL also report each panel judge's verdict distribution by model family, the share of items settled by each basis, the decider's ruling-flip rate when re-run on the same recorded panel outputs, and a per-item diff of two identical rescores of the same input. The maintainer SHALL mark which degraded variants are expected to fail, and the pass threshold SHALL lie between those and the definitions expected to pass. Calibration SHALL NOT be a prerequisite or runtime gate for a candidate run.

#### Scenario: Judge credits only the reference's wording
- **WHEN** the restructured reference scores below the reference by more than the pinned tolerance
- **THEN** calibration reports a failure that names the items the restructured reference lost

#### Scenario: Removed mandatory item goes undetected
- **WHEN** a degraded variant omits a `mandatory` item and the judge marks it `met`
- **THEN** calibration reports a failure that names the item and variant

#### Scenario: One model family is systematically lenient
- **WHEN** calibration completes
- **THEN** its report shows each model family's `met`, `partial`, and `missing` rates beside the expected verdicts, so a family that is systematically more lenient or strict is visible

#### Scenario: Threshold separates expected outcomes
- **WHEN** calibration completes without failures
- **THEN** every input expected to pass scores at or above the pass threshold and every degraded variant marked to fail scores below it
