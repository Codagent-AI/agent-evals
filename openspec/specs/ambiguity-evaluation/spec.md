# ambiguity-evaluation Specification

## Purpose
Define non-scoring capture, classification, and reporting of assumptions, context gaps, and consequential ambiguity evidence.
## Requirements
### Requirement: Observable ambiguity capture
The evaluation harness SHALL create a structured ambiguity ledger from assumption and context-gap information present in Agent Runner session reports, the acceptance assumptions ledger, findings history, final acceptance handoff, and relevant delivered-product evidence. The harness SHALL capture findings explicitly reported by implementation or acceptance agents and consequential ambiguity evidence discovered by the evaluation judge.

Each finding SHALL identify the originating run, workflow step, agent role, and task when available; state the assumption or context gap; reference the supporting artifacts or product evidence; and record the observable handling and consequence. The harness SHALL distinguish absent evidence from an explicit, evidence-backed statement that no unresolved assumptions or context gaps remain. It SHALL NOT require Agent Runner agents to perform evaluation-owned diagnostic classification.

If required assumption or handoff artifacts are absent, the harness SHALL preserve ambiguity coverage as incomplete and defer to the implementation-workflow outcome rules. If the required artifacts exist but contain missed, inaccurate, false-positive, or poorly handled assumptions, the harness SHALL preserve those defects for assumption-handling scoring and diagnostic classification.

#### Scenario: Implementor reports an assumption
- **WHEN** an Agent Runner implementation or acceptance artifact reports an assumption or missing-context concern
- **THEN** the harness records it in the ambiguity ledger with its origin, evidence, observable handling, and consequence

#### Scenario: Judge discovers a consequential unreported assumption
- **WHEN** the evaluation judge finds evidence that an unreported assumption materially affected the delivered product or implementation workflow
- **THEN** the harness records a judge-discovered finding and links it to the supporting evidence
- **AND** the unreported finding remains available to the scored surfacing criterion

#### Scenario: Agent Runner artifacts contain no ambiguity evidence
- **WHEN** the required workflow artifacts explicitly report no unresolved assumptions or context gaps and available evidence supports that statement
- **THEN** the ledger records that no findings were observed for the evaluated artifacts
- **AND** the absence of findings does not prevent full assumption-handling credit

#### Scenario: No-findings statement is inaccurate
- **WHEN** required artifacts claim that no unresolved assumptions remain but verified evidence establishes a consequential unreported ambiguity
- **THEN** the harness records the contradiction and judge-discovered finding
- **AND** the scored assumption judge evaluates the applicable handling criteria

#### Scenario: Expected workflow artifacts are unavailable
- **WHEN** required assumption, findings, or handoff artifacts are unavailable
- **THEN** the ledger marks ambiguity coverage incomplete rather than claiming that no ambiguity occurred
- **AND** the implementation-workflow outcome rules determine whether scored judging can begin

### Requirement: Evaluation-owned diagnostic classification
The evaluation judge SHALL classify each ambiguity finding using the available specification, task, repository, workflow, and product evidence. Supported classifications SHALL include genuine specification gap, missing discoverable repository context, legitimate implementation choice, incorrect assumption or false alarm, unnecessary escalation, and unresolved due to insufficient evidence.

The classification SHALL include a concise rationale, the observed resolution or unresolved state, and any associated product defect or implementation-workflow interruption. Classification SHALL describe observable evidence and SHALL NOT prescribe internal behavior for Agent Runner agents.

#### Scenario: Specification leaves required behavior undefined
- **WHEN** the evidence establishes that a required product decision cannot be resolved from the fixture specification, tasks, or relevant repository context
- **THEN** the judge classifies the finding as a genuine specification gap and explains the missing contract

#### Scenario: Relevant context was discoverable
- **WHEN** the reported gap is resolved by relevant repository context available to the implementation workflow
- **THEN** the judge classifies the finding as missing discoverable repository context and cites that context

#### Scenario: Multiple implementations satisfy the contract
- **WHEN** an implementation choice is not uniquely specified and the chosen behavior satisfies all applicable requirements
- **THEN** the judge classifies the finding as a legitimate implementation choice

#### Scenario: Escalation unnecessarily prevents progress
- **WHEN** an agent stops or escalates despite sufficient available context to make a requirement-conforming implementation choice
- **THEN** the judge classifies the finding as an unnecessary escalation and records the observable workflow consequence

#### Scenario: Evidence cannot support a reliable conclusion
- **WHEN** available artifacts are insufficient to distinguish among supported classifications
- **THEN** the judge classifies the finding as unresolved due to insufficient evidence without inventing a conclusion

### Requirement: Non-scoring ambiguity diagnostics
The detailed ambiguity ledger, its classifications, and its fixture-improvement proposals SHALL remain diagnostic-only. They SHALL NOT directly add or subtract points, create a scoring gate, or independently change the official candidate verdict. The separate assumption-handling judge SHALL score only its four fixed criteria from verified evidence.

An ambiguity-related product defect SHALL affect the applicable product-quality criterion. Poor ambiguity handling SHALL affect only the applicable fixed assumption-handling criterion rather than create an additional discretionary deduction. An ambiguity-related interruption that prevents completion SHALL also follow the applicable implementation-workflow outcome rule. A genuine specification gap SHALL remain diagnostic, and proportionate handling of that gap SHALL be eligible for full assumption-handling credit.

#### Scenario: Incorrect assumption causes a product defect
- **WHEN** an ambiguity finding is associated with behavior that fails a scored product criterion and also demonstrates poor assumption handling
- **THEN** the product criterion determines the product-quality effect
- **AND** only the applicable fixed assumption-handling criterion determines the handling-quality effect

#### Scenario: Needless escalation stops implementation
- **WHEN** an unnecessary escalation prevents the Agent Runner workflow from completing
- **THEN** the evaluation uses the implementation-workflow outcome rules
- **AND** the diagnostic classification creates no additional score or gate

#### Scenario: Genuine fixture gap is found
- **WHEN** a genuine specification gap is surfaced, distinguished from discoverable context, escalated proportionately, and preserved in the handoff
- **THEN** the diagnostic ledger reports the gap
- **AND** the candidate remains eligible for full assumption-handling credit

#### Scenario: Diagnostic ledger contains a severe finding
- **WHEN** the non-scoring ambiguity judge records a severe classification
- **THEN** that classification does not itself change points or verdicts
- **AND** any scoring effect must come from a defined product, assumption-handling, or outcome rule

### Requirement: Reviewed fixture-improvement proposals
For findings classified as genuine specification gaps or recurring sources of misleading ambiguity, the harness SHALL be able to record a proposed fixture improvement containing the affected fixture location, the observed problem, the proposed clarification, and the evidence supporting it. Proposed improvements SHALL be clearly marked as unapproved and SHALL require later human review before use in a future fixture version.

The harness SHALL NOT alter the pinned fixture, its specifications, or its tasks during an evaluation run.

#### Scenario: Finding suggests a fixture clarification
- **WHEN** ambiguity evidence supports a concrete improvement to a future fixture version
- **THEN** the ledger records an unapproved fixture-improvement proposal with its target, rationale, proposed clarification, and evidence

#### Scenario: Current run produces an improvement proposal
- **WHEN** an improvement proposal is recorded during an evaluation
- **THEN** the pinned fixture used by that run remains unchanged

#### Scenario: Proposal has not received human approval
- **WHEN** a fixture-improvement proposal has not been reviewed and approved by a human
- **THEN** the harness excludes it from future fixture inputs

### Requirement: Durable ambiguity ledger
The harness SHALL write the non-scoring ambiguity ledger durably with the evaluation artifacts and reference it separately from the four-point assumption-handling result in `result.json` and `report.html`. Each finding SHALL have a stable identifier. On resume, the harness SHALL preserve prior findings, add newly supported evidence or findings, and avoid duplicating a finding already recorded for the same origin and concern.

Each persisted finding SHALL retain its source evidence, observed handling, consequence, diagnostic classification, rationale, resolution state, and any unapproved fixture-improvement proposal. The ledger SHALL NOT embed or replace the scored assumption-handling verdicts.

#### Scenario: Evaluation resumes with existing findings
- **WHEN** an evaluation resumes after ambiguity findings were recorded
- **THEN** the harness preserves the existing stable findings and adds only new findings or evidence

#### Scenario: Same finding appears in resumed artifacts
- **WHEN** resumed workflow artifacts repeat an already recorded assumption or context gap
- **THEN** the harness updates or references the existing finding rather than creating a duplicate

#### Scenario: Evaluation report is generated
- **WHEN** `result.json` and `report.html` are written or updated
- **THEN** they present the assumption-handling score separately from ambiguity-ledger coverage, classifications, consequences, and unapproved fixture-improvement proposals

#### Scenario: Scored and diagnostic findings overlap
- **WHEN** the same evidence supports a scored assumption-handling verdict and a diagnostic ambiguity finding
- **THEN** both artifacts retain their distinct purpose and provenance
- **AND** the ledger classification does not create points beyond the fixed scored criterion

### Requirement: Four-point assumption-handling score
The evaluation SHALL score candidate assumption-handling quality out of four points using four one-point binary criteria. A focused assumption-handling judge SHALL return a pass/fail verdict, rationale, and cited verified evidence for every criterion.

| Criterion | Points | Required behavior |
|---|---:|---|
| Consequential ambiguities surfaced | 1 | Consequential ambiguities and context gaps are identified rather than silently resolved or omitted. |
| Repository facts distinguished from specification gaps | 1 | Discoverable repository context, legitimate implementation flexibility, and genuine specification gaps are distinguished accurately. |
| Decisions and escalations are proportionate | 1 | Decisions, assumptions, and escalations are evidence-backed, within authority, and proportionate to consequence and uncertainty. |
| Final handoff preserves decisions | 1 | The handoff is evidence-backed and actionable, and preserves unresolved decisions, options, consequences, and known limitations. |

The component SHALL have no independent score floor. For a reference-baseline evaluation, the component SHALL be not applicable and SHALL contribute neither points earned nor points possible.

#### Scenario: Genuine unresolved gap is handled well
- **WHEN** the candidate surfaces a genuine consequential specification gap, distinguishes it from repository facts, escalates proportionately, and preserves it actionably in the handoff
- **THEN** the unresolved state does not by itself fail any assumption-handling criterion

#### Scenario: No consequential ambiguity exists
- **WHEN** required artifacts explicitly report no unresolved assumptions and verified evidence supports that conclusion
- **THEN** the candidate remains eligible to pass all four assumption-handling criteria

#### Scenario: Consequential ambiguity is silently resolved
- **WHEN** the workflow makes a consequential unsupported decision without surfacing or preserving the ambiguity
- **THEN** the surfaced-ambiguities criterion fails
- **AND** any other affected criterion is scored from its own evidence

#### Scenario: Discoverable fact is reported as a gap
- **WHEN** relevant repository context resolves a claimed specification gap
- **THEN** the repository-facts distinction criterion fails
- **AND** the judge cites the discoverable context

#### Scenario: Escalation is disproportionate
- **WHEN** an agent escalates or stops despite sufficient authority and evidence for a requirement-conforming decision
- **THEN** the decisions-and-escalations criterion fails

#### Scenario: Reproduced product defect is misclassified as environmental
- **WHEN** workflow evidence reproduces candidate behavior that violates an approved requirement but the workflow calls it environmental, not a finding, or optional hardening
- **THEN** the repository-facts distinction criterion fails
- **AND** the decisions-and-escalations criterion fails when the workflow clears the environmental trigger without reporting the observed candidate defect
- **AND** the surfaced-ambiguities criterion remains independently scored from whether the observation was recorded
- **AND** the final-handoff criterion remains eligible to pass when the handoff preserves the raw observation, consequence, and actionable correction rather than omitting them

#### Scenario: Final handoff is incomplete
- **WHEN** unresolved decisions, known consequences, or material limitations are omitted from the final handoff
- **THEN** the final-handoff criterion fails

#### Scenario: Candidate satisfies every criterion
- **WHEN** the focused judge passes all four assumption-handling criteria
- **THEN** the candidate receives four of four assumption-handling points

#### Scenario: Component earns no points
- **WHEN** required artifacts exist but none of the four assumption-handling criteria passes
- **THEN** the candidate receives zero of four assumption-handling points
- **AND** the absence of a component floor creates no additional pass gate

#### Scenario: Reference baseline is evaluated
- **WHEN** the evaluator scores the reference baseline
- **THEN** it marks assumption-handling quality not applicable
- **AND** it excludes the component's four points from the reference denominator

