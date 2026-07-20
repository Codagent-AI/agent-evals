## ADDED Requirements

### Requirement: Observable ambiguity capture
The evaluation harness SHALL create a structured ambiguity ledger from assumption and context-gap information present in Agent Runner workflow artifacts. The harness SHALL capture findings explicitly reported by implementation agents and consequential ambiguity evidence discovered by the evaluation judge while examining the workflow artifacts and delivered product.

Each finding SHALL identify the originating run, workflow step, agent role, and task when available; state the assumption or context gap; reference the supporting artifacts or product evidence; and record the observable handling and consequence. The harness SHALL distinguish absent evidence from evidence that no ambiguity was reported, and SHALL NOT require the Agent Runner lead agent or task implementors to perform evaluation-owned classification work.

#### Scenario: Implementor reports an assumption
- **WHEN** an Agent Runner task-implementor artifact reports an assumption or missing-context concern
- **THEN** the harness records it in the ambiguity ledger with its origin, evidence, observable handling, and consequence

#### Scenario: Judge discovers a consequential unreported assumption
- **WHEN** the evaluation judge finds evidence that an unreported assumption materially affected the delivered product or implementation workflow
- **THEN** the harness records a judge-discovered finding and links it to the supporting evidence

#### Scenario: Agent Runner artifacts contain no ambiguity evidence
- **WHEN** the available workflow artifacts contain no reported or judge-discovered ambiguity evidence
- **THEN** the ledger records that no findings were observed for the evaluated artifacts

#### Scenario: Expected workflow artifacts are unavailable
- **WHEN** assumption or context-gap artifacts needed for evaluation are unavailable
- **THEN** the ledger marks ambiguity coverage incomplete rather than claiming that no ambiguity occurred

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
Ambiguity findings and classifications SHALL be diagnostic-only. They SHALL NOT add or subtract product points, create a scoring gate, or independently change the official product verdict.

An ambiguity-related product defect SHALL affect scoring only through the applicable product-quality criterion. An ambiguity-related interruption that prevents completion SHALL affect the result only through the applicable implementation-workflow outcome. A genuine specification gap SHALL remain diagnostic unless another specified scoring or outcome rule applies.

#### Scenario: Incorrect assumption causes a product defect
- **WHEN** an ambiguity finding is associated with behavior that fails a scored product criterion
- **THEN** the product criterion determines the scoring effect and the ambiguity finding adds no separate deduction

#### Scenario: Needless escalation stops implementation
- **WHEN** an unnecessary escalation prevents the Agent Runner workflow from completing
- **THEN** the evaluation uses the implementation-workflow outcome rules and adds no ambiguity score or gate

#### Scenario: Genuine fixture gap is found
- **WHEN** a finding is classified as a genuine specification gap without an independently applicable scoring or outcome rule
- **THEN** the evaluation reports the finding diagnostically without penalizing the candidate

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
The harness SHALL write the ambiguity ledger durably with the evaluation artifacts and reference it from `result.json` and `report.html`. Each finding SHALL have a stable identifier. On resume, the harness SHALL preserve prior findings, add newly supported evidence or findings, and avoid duplicating a finding already recorded for the same origin and concern.

#### Scenario: Evaluation resumes with existing findings
- **WHEN** an evaluation resumes after ambiguity findings were recorded
- **THEN** the harness preserves the existing stable findings and adds only new findings or evidence

#### Scenario: Same finding appears in resumed artifacts
- **WHEN** resumed workflow artifacts repeat an already recorded assumption or context gap
- **THEN** the harness updates or references the existing finding rather than creating a duplicate

#### Scenario: Evaluation report is generated
- **WHEN** `result.json` and `report.html` are written or updated
- **THEN** they reference or present the ambiguity ledger, its coverage, classifications, consequences, and unapproved fixture-improvement proposals as diagnostic information
