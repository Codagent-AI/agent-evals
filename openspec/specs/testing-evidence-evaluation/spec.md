# testing-evidence-evaluation Specification

## Purpose
TBD - created by archiving change make-evals-greater. Update Purpose after archive.
## Requirements
### Requirement: Candidate and evaluator evidence separation
The evaluation SHALL use candidate-produced acceptance evidence as the primary record of workflow testing. It SHALL label candidate-produced and evaluator-produced evidence separately in every durable artifact and report. Evaluator-produced deterministic checks, probes, and screenshots SHALL remain available to corroborate or contradict candidate claims, but SHALL NOT add credit to the candidate's testing-evidence score.

The evaluator SHALL NOT perform another subjective visual-quality review. The separate 13-question human review SHALL remain the authoritative visual-quality assessment.

#### Scenario: Candidate evidence supports its own score
- **WHEN** the testing-evidence judge evaluates a candidate
- **THEN** it assigns credit only from verified candidate-produced evidence
- **AND** it identifies every cited item as candidate-produced

#### Scenario: Evaluator evidence is captured
- **WHEN** the harness runs deterministic checks or captures its own screenshots
- **THEN** it stores them in a distinct evaluator-evidence namespace
- **AND** those artifacts cannot increase the candidate's testing-evidence score

#### Scenario: Evaluator evidence contradicts a candidate claim
- **WHEN** verified evaluator evidence contradicts candidate-produced evidence
- **THEN** the contradiction is provided to the testing-evidence judge
- **AND** the judge fails each applicable criterion that the contradiction disproves

#### Scenario: Visual quality is assessed
- **WHEN** subjective visual quality must be scored
- **THEN** the evaluator uses the separate human-review workflow
- **AND** it does not invoke a third subjective visual-review job

### Requirement: Required evidence before scored judging
Before scored product judging begins, the evaluation SHALL require readable candidate-produced acceptance flow evidence, screenshot evidence and metadata, findings history, final handoff, and assumptions ledger. It SHALL also require a verifiable candidate repository, draft pull request, final local commit, pull-request head, and pull-request base identity.

If the evaluated workflow fails to produce those required artifacts or identities, the evaluation SHALL report `implementation-workflow-failed`, preserve available diagnostics, and SHALL NOT begin scored product judging or issue an official product score or verdict. If those inputs exist but the harness cannot process otherwise valid inputs because of an evaluator defect, it SHALL report `evaluation-harness-failed`.

#### Scenario: Required candidate evidence is missing
- **WHEN** the completed workflow omits a required acceptance artifact
- **THEN** the evaluation reports `implementation-workflow-failed`
- **AND** scored product judging does not begin

#### Scenario: Final candidate identity is unverifiable
- **WHEN** the harness cannot establish the required repository, draft-PR, base, local-head, and PR-head identity
- **THEN** the evaluation reports `implementation-workflow-failed`
- **AND** it preserves the available workflow diagnostics without issuing a product score

#### Scenario: Evidence is present but poor
- **WHEN** all required artifacts and identities exist but their contents are stale, incomplete, misleading, or tied to the wrong revision
- **THEN** scored judging proceeds against the established final candidate
- **AND** the testing-evidence judge withholds points for the applicable defects

#### Scenario: Harness cannot process valid evidence
- **WHEN** required valid evidence exists but an evaluator defect prevents it from being read or validated
- **THEN** the evaluation reports `evaluation-harness-failed`
- **AND** it does not classify the failure as an implementation-workflow failure

### Requirement: Final-revision evidence provenance
The evaluation SHALL verify a coherent acceptance-evidence lineage terminating at the final evaluated pull-request SHA. The final handoff, local `HEAD`, and pull-request head SHALL identify that SHA. When candidate-produced acceptance evidence reports CI status, it SHALL identify the revision to which that status applies or explicitly state that CI evidence is absent, pending, or unavailable. The harness SHALL NOT independently query CI or require a particular CI state before judging.

The evaluation SHALL accept a lineage using a trustworthy full-flow pass from an ancestor commit plus targeted verification at the final SHA only when the candidate evidence identifies the intervening changes, bounds their impact, covers affected and directly dependent flows, and explains why other flows remain supported by the baseline. Evidence-only final verification SHALL be valid only when no tracked product content changed after the trustworthy full-flow pass. A broad change, an unbounded impact, or the absence of a trustworthy baseline SHALL require a new full-flow pass at the final SHA.

#### Scenario: Full flow passes at the final revision
- **WHEN** complete acceptance flow evidence was produced at the final evaluated SHA
- **THEN** the evaluation accepts that evidence as the final-revision lineage

#### Scenario: Targeted retest closes a bounded change
- **WHEN** a trustworthy full-flow baseline exists at an ancestor SHA and final-SHA evidence explicitly bounds and tests the intervening change and dependent flows
- **THEN** the evaluation accepts the combined baseline and targeted evidence as a lineage terminating at the final SHA

#### Scenario: Only external alignment changed
- **WHEN** no tracked product content changed after a trustworthy full-flow pass and final verification only aligns the PR, CI, or other external state
- **THEN** the evaluation accepts evidence-only verification that ties the handoff and external state to the final SHA

#### Scenario: Change impact is not bounded
- **WHEN** the intervening change is broad, its impact cannot be bounded, or no trustworthy full-flow baseline exists
- **THEN** the evaluation requires a new full-flow pass at the final SHA
- **AND** it withholds the final-revision evidence point when that pass is absent

### Requirement: Evidence integrity and contradiction handling
The evaluation SHALL treat candidate evidence as untrusted. Before judging it, the harness SHALL verify referenced files, hashes, screenshot metadata, revision claims, requirement and flow coverage, and pull-request identity. It SHALL preserve missing, malformed, stale, or contradictory evidence as findings and SHALL NOT silently repair, replace, or reinterpret candidate-produced evidence. It SHALL treat CI status as a candidate-produced claim and SHALL NOT query GitHub checks or other CI systems to replace or validate that claim.

#### Scenario: Referenced evidence verifies
- **WHEN** every candidate citation resolves to an artifact with matching integrity and revision metadata
- **THEN** the harness marks those citations verified for judging

#### Scenario: Citation is missing or altered
- **WHEN** a cited file does not exist or its recorded hash does not match
- **THEN** the harness records the integrity failure
- **AND** the affected claim cannot earn testing-evidence credit

#### Scenario: Screenshot metadata is inconsistent
- **WHEN** screenshot metadata does not establish the claimed flow, state, capture identity, or revision
- **THEN** the harness records the inconsistency
- **AND** the screenshot cannot support the affected criterion

#### Scenario: Candidate claim conflicts with independent evidence
- **WHEN** candidate evidence claims a behavior that verified evaluator evidence disproves
- **THEN** the harness preserves both sources and identifies the contradiction
- **AND** the judge scores the applicable criterion from the contradiction rather than silently reconciling it

#### Scenario: Candidate reports CI status
- **WHEN** candidate acceptance evidence reports passing, failing, pending, absent, or unavailable CI
- **THEN** the harness preserves the reported state and its claimed revision as candidate-produced evidence
- **AND** it does not independently query CI or block judging because of that state

### Requirement: Four-point testing-evidence score
The evaluation SHALL score candidate testing-evidence quality out of four points using four one-point binary criteria. A focused testing-evidence judge SHALL return a pass/fail verdict, rationale, and cited verified evidence for every criterion.

| Criterion | Points | Required behavior |
|---|---:|---|
| Traceable coverage | 1 | Requirements, user flows, and representative visual states are covered and traceable. |
| Usable proof | 1 | Actions, observed outcomes, screenshots, and warning dispositions provide usable proof. |
| Final-revision applicability | 1 | Evidence, candidate-reported CI status when present, and pull-request identity apply through a valid lineage to the final evaluated SHA. |
| Complete and honest record | 1 | Limitations, unexercised flows, failures, fixes, and retesting are complete and honest enough for independent judging. |

The component SHALL have no independent score floor. For a reference-baseline evaluation, the component SHALL be not applicable and SHALL contribute neither points earned nor points possible.

#### Scenario: Candidate evidence satisfies every criterion
- **WHEN** the focused judge passes all four testing-evidence criteria
- **THEN** the candidate receives four of four testing-evidence points

#### Scenario: One evidence criterion fails
- **WHEN** the focused judge fails one criterion and passes the other three
- **THEN** the candidate receives three of four testing-evidence points
- **AND** the failed criterion retains its rationale and cited evidence

#### Scenario: Component misses every criterion
- **WHEN** required artifacts exist but none of the four evidence-quality criteria passes
- **THEN** the candidate receives zero of four testing-evidence points
- **AND** the absence of a component floor does not create an additional pass gate

#### Scenario: Reference baseline is evaluated
- **WHEN** the evaluator scores the reference baseline
- **THEN** it marks testing-evidence quality not applicable
- **AND** it excludes the component's four points from the reference denominator

