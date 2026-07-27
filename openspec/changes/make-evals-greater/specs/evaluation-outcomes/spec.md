## MODIFIED Requirements

### Requirement: Separate evaluation status and product verdict
The evaluation SHALL report execution status independently from candidate product quality. `evaluation_status` SHALL be exactly one of `complete`, `pending-human-review`, `implementation-workflow-failed`, or `evaluation-harness-failed`. `product_verdict` SHALL be exactly one of `pass`, `fail`, `unavailable`, or `not-applicable`.

A candidate product verdict SHALL be `pass` only after all required automated scoring, human scoring, and product gates have been completed from sufficient evidence. A candidate product verdict SHALL ordinarily be `fail` only after the same inputs establish that the pass contract was missed. As a narrow exception, deterministic evidence that reproducible product behavior prevents the frozen final candidate from installing, building, or serving SHALL be sufficient for a conclusive `fail` verdict without an official score or fabricated human ratings. A completed local reference SHALL use `product_verdict=not-applicable` because the candidate pass contract does not apply. The evaluation SHALL NOT infer product failure from a failed workflow, failed harness, unfinished human review, or candidate-reported CI state.

#### Scenario: Complete candidate passes
- **WHEN** all required candidate evaluation work completes and the official score and product gates satisfy the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `pass`

#### Scenario: Complete candidate fails
- **WHEN** all required candidate evaluation work completes but the official score or a product gate fails the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`

#### Scenario: Conclusive product failure prevents full scoring
- **WHEN** deterministic verification establishes that reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`
- **AND** `official_score` and human ratings remain unavailable while completed component and hard-gate evidence is preserved

#### Scenario: Complete local reference is reported
- **WHEN** all applicable reference scoring and human review complete
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `not-applicable`
- **AND** the result reports the reference score out of 92

#### Scenario: Non-product failure prevents scoring
- **WHEN** an implementation-workflow or evaluation-harness failure prevents reliable completion of required product scoring
- **THEN** `product_verdict` is `unavailable` rather than `fail`

### Requirement: Pending human-review outcome
The evaluation SHALL use `pending-human-review` when all required applicable automated scoring has completed but the required human review has not been finalized. This state SHALL contain the applicable automated subtotal, score denominator, and completed diagnostics but SHALL NOT contain an official candidate score or pass/fail verdict.

A pending candidate SHALL report its automated subtotal out of 70. A pending local reference SHALL report its applicable automated subtotal out of 62 and SHALL mark testing evidence and assumption handling not applicable.

#### Scenario: Candidate automated scoring awaits reviewer
- **WHEN** candidate automated scoring is complete and no finalized human-review record is available
- **THEN** `evaluation_status` is `pending-human-review`, `product_verdict` is `unavailable`, and no official score is issued
- **AND** the result reports the automated subtotal out of 70

#### Scenario: Reference automated scoring awaits reviewer
- **WHEN** local reference automated scoring is complete and no finalized human-review record is available
- **THEN** `evaluation_status` is `pending-human-review`, `product_verdict` is `unavailable`, and no final reference score is issued
- **AND** the result reports the applicable automated subtotal out of 62

#### Scenario: Candidate human review is finalized
- **WHEN** a pending candidate resumes and finalizes valid human-review responses
- **THEN** the evaluation replaces the pending state with `complete`
- **AND** it calculates the applicable `pass` or `fail` candidate verdict

#### Scenario: Reference human review is finalized
- **WHEN** a pending local reference resumes and finalizes valid human-review responses
- **THEN** the evaluation replaces the pending state with `complete`
- **AND** it reports the reference score out of 92 with `product_verdict=not-applicable`

#### Scenario: Noninteractive run reaches human review
- **WHEN** the main evaluation command completes applicable automated scoring
- **THEN** it exits successfully with a durable `pending-human-review` result rather than attempting human review or reporting failure

#### Scenario: Handoff cleanup is incomplete
- **WHEN** the main evaluation command cannot complete candidate-server cleanup after durably writing the pending result artifacts
- **THEN** `evaluation_status` remains `pending-human-review`, the cleanup error is recorded diagnostically for review or resume, and the command exits successfully

#### Scenario: Separate review command finalizes pending result
- **WHEN** `human-review.sh` completes and confirms all required responses for a pending run
- **THEN** the evaluation transitions to `complete` with the verdict applicability required by that run kind
- **AND** it does not rerun valid automated scoring

### Requirement: Implementation-workflow failure outcome
The evaluation SHALL use `implementation-workflow-failed` when Agent Runner or an implementation-owned workflow step fails before completing the full `implement-change-v2.0` workflow and the harness cannot continue to an evaluable delivered candidate. An evaluable delivery SHALL require the recorded candidate branch, clean committed worktree, draft pull request with non-empty base, matching local and PR heads, final Validator results, required acceptance artifacts, final acceptance handoff, and assumptions ledger.

The result SHALL identify the failed workflow step, attempt or session when available, observed error, Agent Runner run identity, missing delivery output or identity, and whether the workflow can be resumed. Product defects, failed acceptance flows, limitations, unresolved assumptions, and candidate-reported CI states contained in a structurally complete handoff SHALL remain judgeable evidence and SHALL NOT by themselves cause this outcome.

#### Scenario: Agent Runner terminates before delivering a candidate
- **WHEN** the recorded `implement-change-v2.0` run terminates unsuccessfully before completing the required candidate delivery
- **THEN** `evaluation_status` is `implementation-workflow-failed` and `product_verdict` is `unavailable`

#### Scenario: Required candidate delivery output is missing
- **WHEN** Agent Runner finishes without a required branch, draft-PR identity, matching final head, Validator result, acceptance artifact, handoff, or assumptions ledger
- **THEN** `evaluation_status` is `implementation-workflow-failed`
- **AND** scored product judging does not begin

#### Scenario: Implementation profile cannot complete a task
- **WHEN** an Agent Runner agent exhausts the workflow's permitted attempts and the implementation run fails
- **THEN** the result classifies the failure as implementation-workflow-owned and records the affected role, step, attempts, and error

#### Scenario: Complete handoff records product findings
- **WHEN** candidate delivery is structurally complete and the handoff honestly records defects, failed flows, limitations, or unresolved assumptions
- **THEN** scored product judging proceeds
- **AND** those findings do not become an implementation-workflow failure

#### Scenario: Harness remains operational after workflow failure
- **WHEN** the harness successfully records and reports an Agent Runner workflow failure
- **THEN** it does not misclassify that failure as an evaluation-harness failure

### Requirement: Evaluation-harness failure outcome
The evaluation SHALL use `evaluation-harness-failed` when eval-owned setup, candidate-identity verification, non-CI evidence verification, candidate-server management, browser evaluation, evidence processing, scored judging, human-review persistence, scoring, result persistence, report generation, or cleanup fails in a way that prevents required evaluation work or finalization. A candidate-server failure established to result from reproducible product behavior SHALL follow the conclusive product-failure rule rather than this harness-failure rule.

The result SHALL identify the failed eval phase, observed error, completed checkpoints, and whether the phase can be resumed. A harness failure SHALL NOT be reported as a product defect or implementation-workflow defect.

#### Scenario: Browser evaluator cannot collect required evidence
- **WHEN** an eval-owned browser or evidence phase fails before sufficient product evidence is produced
- **THEN** `evaluation_status` is `evaluation-harness-failed` and `product_verdict` is `unavailable`

#### Scenario: Candidate server failure is product-owned
- **WHEN** the harness operates correctly but reproducible product behavior prevents the frozen final candidate from building or serving
- **THEN** the evaluation applies the conclusive product-failure outcome
- **AND** it does not report `evaluation-harness-failed`

#### Scenario: Required scored judge output is missing
- **WHEN** any required demo, scene-kit, presentation-skill, verification, testing-evidence, or assumption-handling judge job returns missing or invalid output
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the scorer does not substitute zero points or change the score denominator

#### Scenario: Scorer cannot produce a reliable score
- **WHEN** an eval-owned scoring failure prevents reliable applicability, denominator, criterion coverage, or official scoring
- **THEN** `evaluation_status` is `evaluation-harness-failed` and no official score or candidate pass/fail verdict is issued

#### Scenario: Harness cannot process valid candidate evidence
- **WHEN** required valid candidate evidence exists but an eval-owned defect prevents it from being read or validated
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the failure is not attributed to Agent Runner

#### Scenario: Required finalization cleanup fails
- **WHEN** the separate human-review command cannot complete its required candidate-server cleanup during finalization
- **THEN** `evaluation_status` is `evaluation-harness-failed` and the result records the cleanup error

### Requirement: Preserve a durable product verdict across later harness failure
Once an official candidate score and product verdict have been computed from complete required scoring inputs and durably recorded, a later harness failure SHALL NOT erase or alter them. The evaluation SHALL change `evaluation_status` to `evaluation-harness-failed`, preserve `product_verdict` as `pass` or `fail`, and present the harness failure alongside the valid candidate result.

Once a complete local reference score out of 92 has been durably recorded with `product_verdict=not-applicable`, a later harness failure SHALL preserve that score and verdict applicability. A failure before a candidate verdict or complete reference score is durably recorded SHALL preserve completed components diagnostically while leaving the verdict unavailable.

#### Scenario: Cleanup fails after a passing candidate verdict
- **WHEN** a passing candidate score and verdict are durably recorded and candidate-server cleanup subsequently fails
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` remains `pass`, and the cleanup failure is prominently reported

#### Scenario: Report generation fails after a failing candidate verdict
- **WHEN** a failing candidate score and verdict are durably recorded and HTML report generation subsequently fails
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` remains `fail`, and `result.json` records the missing required report

#### Scenario: Failure follows a complete reference score
- **WHEN** the local reference score out of 92 was durably recorded before a later harness failure
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the reference score and `product_verdict=not-applicable` remain unchanged

#### Scenario: Failure occurs before durable scoring
- **WHEN** a harness failure occurs after some scoring work but before the applicable candidate verdict or complete reference score is durably recorded
- **THEN** `product_verdict` remains `unavailable`
- **AND** completed component results are preserved diagnostically

### Requirement: Durable outcome transitions and resume
The harness SHALL checkpoint evaluation status, product-verdict applicability, score denominator, completed component results, failed phase, failure reason, run kind, candidate and PR identity when applicable, evidence hashes, rubric and judge provenance, and resume eligibility. Resuming SHALL update the same evaluation result and SHALL preserve all still-valid completed work under the resume rules. A recovered pending or failed state SHALL be replaced by the current state while its transition remains in the checkpoint and resume history.

#### Scenario: Workflow failure is resumed successfully
- **WHEN** an `implementation-workflow-failed` evaluation resumes the same Agent Runner run, candidate branch, and draft pull request and completes candidate delivery
- **THEN** the harness records the transition and continues with the next required eval phase

#### Scenario: Harness phase is retried successfully
- **WHEN** an `evaluation-harness-failed` phase is safely resumed and completes
- **THEN** the harness records the transition and proceeds without duplicating preserved work

#### Scenario: Pending human review resumes
- **WHEN** a pending candidate or reference resumes with matching run, evidence, rubric, and human-review provenance
- **THEN** the harness preserves valid automated work
- **AND** it continues the applicable human review

#### Scenario: Failure is not recoverable
- **WHEN** provenance or checkpoint evidence cannot establish a safe resume point
- **THEN** the result remains failed and identifies why resume is unavailable

### Requirement: Consistent outcome presentation
`result.json` SHALL be the authoritative machine-readable outcome and `report.html` SHALL render the same current evaluation status, product-verdict applicability, score denominator, official score availability, failed or pending phase, and reason. Candidate-facing output SHALL use prominent `PASS` or `FAIL` labels when a candidate verdict is available, `PENDING HUMAN REVIEW` when review is outstanding, and `EVALUATION FAILED` when workflow or harness failure leaves the verdict unavailable. A conclusive unscored product failure SHALL display `FAIL`, state that the official score and human review are unavailable because the delivered product could not build or serve, and preserve the available evidence. A complete local reference SHALL use `REFERENCE — COMPLETE`, its score out of 92, and no candidate pass/fail label.

When a harness failure coexists with a valid candidate verdict or complete reference score, human-facing output SHALL display both facts prominently and SHALL explain the harness failure separately from product findings.

#### Scenario: Candidate verdict is available
- **WHEN** `product_verdict` is `pass` or `fail`
- **THEN** the result artifacts display the matching `PASS` or `FAIL` label
- **AND** they display the official score out of 100 when complete scoring produced one

#### Scenario: Conclusive product failure has no official score
- **WHEN** `evaluation_status` is `complete`, `product_verdict` is `fail`, and product-owned build or serve failure prevented complete scoring
- **THEN** the result artifacts display `FAIL`, no official score, and no fabricated human ratings
- **AND** they explain the conclusive product failure and display available component and hard-gate evidence

#### Scenario: Complete reference is presented
- **WHEN** `evaluation_status` is `complete` and `product_verdict` is `not-applicable`
- **THEN** the local result artifacts display `REFERENCE — COMPLETE` and the score out of 92
- **AND** they display no `PASS` or `FAIL` label

#### Scenario: Failure leaves verdict unavailable
- **WHEN** workflow or harness failure leaves `product_verdict` unavailable
- **THEN** the result artifacts display `EVALUATION FAILED` and identify the owning phase and reason

#### Scenario: Harness failure follows valid scoring
- **WHEN** `evaluation_status` is `evaluation-harness-failed` after a valid candidate verdict or complete reference score
- **THEN** the result artifacts prominently display both the preserved scoring result and harness-failure status
- **AND** they do not convert the preserved verdict or applicability

#### Scenario: Report and result disagree
- **WHEN** report generation detects that its rendered outcome, applicability, or denominator would differ from the current `result.json`
- **THEN** the harness fails report generation rather than publishing contradictory outcome information
