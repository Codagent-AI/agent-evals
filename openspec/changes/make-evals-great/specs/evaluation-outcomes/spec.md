## ADDED Requirements

### Requirement: Separate evaluation status and product verdict
The evaluation SHALL report execution status independently from product quality. `evaluation_status` SHALL be exactly one of `complete`, `pending-human-review`, `implementation-workflow-failed`, or `evaluation-harness-failed`. `product_verdict` SHALL be exactly one of `pass`, `fail`, or `unavailable`.

A product verdict SHALL be `pass` or `fail` only after all required automated scoring, human scoring, and product gates have been completed from sufficient evidence. The evaluation SHALL NOT infer product failure from a failed workflow, failed harness, or unfinished human review.

#### Scenario: Complete product passes
- **WHEN** all required evaluation work completes and the official score and product gates satisfy the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `pass`

#### Scenario: Complete product fails
- **WHEN** all required evaluation work completes but the official score or a product gate fails the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`

#### Scenario: Non-product failure prevents scoring
- **WHEN** an implementation-workflow or evaluation-harness failure prevents reliable completion of required product scoring
- **THEN** `product_verdict` is `unavailable` rather than `fail`

### Requirement: Pending human-review outcome
The evaluation SHALL use `pending-human-review` when all required automated scoring has completed but the required human review has not been finalized. This state SHALL contain the automated subtotal and available completed diagnostics but SHALL NOT contain an official score or pass/fail product verdict.

#### Scenario: Automated scoring awaits reviewer
- **WHEN** automated scoring is complete and no finalized human-review record is available
- **THEN** `evaluation_status` is `pending-human-review`, `product_verdict` is `unavailable`, and no official score is issued

#### Scenario: Human review is finalized
- **WHEN** a pending evaluation resumes and finalizes valid human-review responses
- **THEN** the evaluation replaces the pending state with `complete` and calculates the applicable `pass` or `fail` product verdict

#### Scenario: Noninteractive run reaches human review
- **WHEN** the main evaluation command completes automated scoring
- **THEN** it exits successfully with a durable `pending-human-review` result rather than attempting human review or reporting failure

#### Scenario: Handoff cleanup is incomplete
- **WHEN** the main evaluation command cannot complete candidate-server cleanup after durably writing the pending result artifacts
- **THEN** `evaluation_status` remains `pending-human-review`, the cleanup error is recorded diagnostically for review or resume, and the command exits successfully

#### Scenario: Separate review command finalizes pending result
- **WHEN** `human-review.sh` completes and confirms all required responses for a pending run
- **THEN** the evaluation transitions to `complete` with the applicable product verdict without rerunning automated scoring

### Requirement: Implementation-workflow failure outcome
The evaluation SHALL use `implementation-workflow-failed` when Agent Runner or an implementation-owned workflow step fails before the configured workflow boundary and the harness cannot continue to an evaluable delivered product. The result SHALL identify the failed workflow step, attempt or session when available, observed error, Agent Runner run identity, and whether the workflow can be resumed.

#### Scenario: Agent Runner terminates before delivering a candidate
- **WHEN** the recorded `implement-change2` run terminates unsuccessfully before its configured stop boundary and no evaluable candidate is delivered
- **THEN** `evaluation_status` is `implementation-workflow-failed` and `product_verdict` is `unavailable`

#### Scenario: Implementation profile cannot complete a task
- **WHEN** an Agent Runner agent exhausts the workflow's permitted attempts and the implementation run fails
- **THEN** the result classifies the failure as implementation-workflow-owned and records the affected role, step, attempts, and error

#### Scenario: Harness remains operational after workflow failure
- **WHEN** the harness successfully records and reports an Agent Runner workflow failure
- **THEN** it does not misclassify that failure as an evaluation-harness failure

### Requirement: Evaluation-harness failure outcome
The evaluation SHALL use `evaluation-harness-failed` when eval-owned setup, verification, candidate-server management, browser evaluation, evidence processing, LLM judging, human-review persistence, scoring, result persistence, report generation, or cleanup fails in a way that prevents required evaluation work or finalization.

The result SHALL identify the failed eval phase, observed error, completed checkpoints, and whether the phase can be resumed. A harness failure SHALL NOT be reported as a product defect.

#### Scenario: Browser evaluator cannot collect required evidence
- **WHEN** an eval-owned browser or evidence phase fails before sufficient product evidence is produced
- **THEN** `evaluation_status` is `evaluation-harness-failed` and `product_verdict` is `unavailable`

#### Scenario: Scorer cannot produce a reliable score
- **WHEN** an eval-owned scoring failure prevents reliable official scoring
- **THEN** `evaluation_status` is `evaluation-harness-failed` and no official score or pass/fail verdict is issued

#### Scenario: Required finalization cleanup fails
- **WHEN** the separate human-review command cannot complete its required candidate-server cleanup during finalization
- **THEN** `evaluation_status` is `evaluation-harness-failed` and the result records the cleanup error

### Requirement: Preserve a durable product verdict across later harness failure
Once the official score and product verdict have been computed from complete required scoring inputs and durably recorded, a later harness failure SHALL NOT erase or alter them. The evaluation SHALL change `evaluation_status` to `evaluation-harness-failed`, preserve `product_verdict` as `pass` or `fail`, and present the harness failure alongside the valid product result.

#### Scenario: Cleanup fails after a passing verdict
- **WHEN** a passing official score and verdict are durably recorded and candidate-server cleanup subsequently fails
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` remains `pass`, and the cleanup failure is prominently reported

#### Scenario: Report generation fails after a failing verdict
- **WHEN** a failing official score and verdict are durably recorded and HTML report generation subsequently fails
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` remains `fail`, and `result.json` records the missing required report

#### Scenario: Failure occurs before durable verdict
- **WHEN** a harness failure occurs after some scoring work but before an official product verdict is durably recorded
- **THEN** `product_verdict` remains `unavailable` and completed component results are preserved diagnostically

### Requirement: Durable outcome transitions and resume
The harness SHALL checkpoint evaluation status, product verdict, completed component results, failed phase, failure reason, and resume eligibility. Resuming SHALL update the same evaluation result and SHALL preserve all still-valid completed work under the resume rules. A recovered pending or failed state SHALL be replaced by the current state while its transition remains in the checkpoint and resume history.

#### Scenario: Workflow failure is resumed successfully
- **WHEN** an `implementation-workflow-failed` evaluation resumes the same Agent Runner run and reaches the configured boundary
- **THEN** the harness records the transition and continues with the next required eval phase

#### Scenario: Harness phase is retried successfully
- **WHEN** an `evaluation-harness-failed` phase is safely resumed and completes
- **THEN** the harness records the transition and proceeds without duplicating preserved work

#### Scenario: Failure is not recoverable
- **WHEN** provenance or checkpoint evidence cannot establish a safe resume point
- **THEN** the result remains failed and identifies why resume is unavailable

### Requirement: Consistent outcome presentation
`result.json` SHALL be the authoritative machine-readable outcome and `report.html` SHALL render the same current evaluation status, product verdict, official score availability, failed or pending phase, and reason. Human-facing output SHALL use prominent `PASS` or `FAIL` labels when a product verdict is available, `PENDING HUMAN REVIEW` when review is outstanding, and `EVALUATION FAILED` when workflow or harness failure leaves the product verdict unavailable.

When a harness failure coexists with a valid product verdict, human-facing output SHALL display both, such as `PASS — HARNESS FAILURE` or `FAIL — HARNESS FAILURE`, and SHALL explain the harness failure separately from product findings.

#### Scenario: Product verdict is available
- **WHEN** `product_verdict` is `pass` or `fail`
- **THEN** the result artifacts display the matching `PASS` or `FAIL` label and official score

#### Scenario: Failure leaves verdict unavailable
- **WHEN** workflow or harness failure leaves `product_verdict` unavailable
- **THEN** the result artifacts display `EVALUATION FAILED` and identify the owning phase and reason

#### Scenario: Harness failure follows valid verdict
- **WHEN** `evaluation_status` is `evaluation-harness-failed` and `product_verdict` is `pass` or `fail`
- **THEN** the result artifacts prominently display both statuses without converting the product verdict to unavailable

#### Scenario: Report and result disagree
- **WHEN** report generation detects that its rendered outcome would differ from the current `result.json`
- **THEN** the harness fails report generation rather than publishing contradictory outcome information
