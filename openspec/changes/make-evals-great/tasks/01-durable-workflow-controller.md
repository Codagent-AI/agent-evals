# Task: Build the durable workflow controller

## Goal

Replace the generated monolithic scored-run lifecycle with a testable suite-local Node controller while retaining the existing Agent Runner sandbox adapter. Deliver clean-revision `implement-change2` execution, independent lead/implementor profiles, durable checkpoints and resume, and an explicit outcome model that downstream evaluation phases can safely consume.

## Background

The current lifecycle is embedded in `evals/agent-runner/and-scene/run.sh`. Keep that file as the thin host entry point for argument parsing, clean Agent Runner checkout checks, `scripts/sandbox-run.sh` invocation, and container identity. Move phase/state logic into `evals/agent-runner/and-scene/controller.mjs` and focused modules under `evals/agent-runner/and-scene/lib/` (at minimum persistence/checkpoint, subprocess timing, workflow integration, provenance, and outcomes). Add focused tests under `test/` alongside the existing `and-scene.test.mjs` conventions.

The run directory is `artifacts/evals/and-scene/<run-id>/`; `.runtime/candidate-worktree/` and `.runtime/agent-runner-projects/` persist across disposable containers, while credentials remain in the ephemeral container home. JSON writes must use same-directory temporary files plus atomic rename. Checkpoints must be schema-versioned and hash their score-affecting inputs and outputs.

Use `workflows/openspec/implement-change2.yaml` from a clean configured Agent Runner checkout. The suite owns orchestration and checkpoint state; Agent Runner owns the sandbox, workflow execution, run locks, sessions, internal resume selection, and `run-metrics.json`. Do not copy Agent Runner infrastructure into this repository. Do not add a third-party runtime dependency.

This task owns the evaluation outcome/state model and the ordered phase skeleton. Its tests may inject stubs for product judging, diagnostics, pricing, human review, and reporting; `tasks/02-product-evaluation-scoring.md` through `tasks/04-human-review-reporting.md` implement those phase contracts. Task 04 owns the complete `Detailed result artifact` contract from `specs/evaluation-metrics-reporting/spec.md` for `result.json`.

Implement behavior test-first. Preserve proof mode where it remains useful, replace legacy scored-run assumptions deliberately, run targeted Node/shell tests, and finish with `npm run check`.

## Spec

Source: `specs/agent-role-configuration/spec.md`

### Requirement: Independent role profile selection
The evaluation harness SHALL require an explicit lead-agent profile and an explicit task-implementor profile for each new Agent Runner evaluation run. Each profile SHALL independently specify the Agent Runner CLI adapter, model, and effort setting used for that role.

The harness SHALL map the selected lead-agent profile to the `planner` agent used by the `implement-change2` named `lead-agent` session and the selected task-implementor profile to the `implementor` agent used by its task workflows. Both roles SHALL execute within the same end-to-end `implement-change2` run.

#### Scenario: Different profiles are selected
- **WHEN** a run selects different CLI, model, or effort settings for the lead agent and task implementor
- **THEN** the harness configures Agent Runner's `planner` and `implementor` agents independently with the selected settings
- **AND** both participate in the same end-to-end workflow run

#### Scenario: Same settings are selected explicitly
- **WHEN** the lead-agent and task-implementor profiles explicitly contain the same settings
- **THEN** the harness accepts them as two independently declared role profiles

#### Scenario: A required role profile is missing
- **WHEN** either the lead-agent profile or task-implementor profile is absent for a new run
- **THEN** the harness rejects the configuration before starting Agent Runner

#### Scenario: Reference baseline bypasses implementation
- **WHEN** a reference-baseline run evaluates an existing candidate without invoking Agent Runner
- **THEN** lead-agent and task-implementor profiles are not required and are reported not applicable

### Requirement: Profile validation
Before starting Agent Runner, the harness SHALL validate both role profiles against the capabilities of the recorded Agent Runner revision. Validation SHALL reject unsupported CLI adapters, unavailable or invalid model identifiers, invalid effort values, and configurations that cannot run the applicable workflow role autonomously. A validation failure SHALL identify the affected role and invalid field without launching an implementation workflow.

#### Scenario: Both profiles are valid
- **WHEN** both selected profiles use supported and available settings for their workflow roles
- **THEN** the harness permits the Agent Runner workflow to start

#### Scenario: Lead profile is invalid
- **WHEN** the selected lead-agent profile contains a setting Agent Runner cannot use for the `planner` role
- **THEN** the harness rejects the run and identifies the lead-agent setting that failed validation

#### Scenario: Implementor profile is invalid
- **WHEN** the selected task-implementor profile contains a setting Agent Runner cannot use for the `implementor` role
- **THEN** the harness rejects the run and identifies the task-implementor setting that failed validation

### Requirement: Evaluation-scoped Agent Runner configuration
The harness SHALL materialize the two selected profiles only within the disposable evaluation environment. It SHALL NOT modify or depend upon the user's global or project Agent Runner configuration outside that environment. The generated configuration SHALL retain the autonomous execution modes required by the noninteractive evaluation workflow.

#### Scenario: Evaluation configuration is created
- **WHEN** the harness prepares the Agent Runner environment
- **THEN** it writes an evaluation-scoped profile configuration containing the selected `planner` and `implementor` settings

#### Scenario: User has an Agent Runner configuration
- **WHEN** the host contains global or project Agent Runner profile settings
- **THEN** the evaluation does not modify those settings or allow them to silently change the selected evaluation profiles

### Requirement: Role configuration continuity on resume
The harness SHALL checkpoint the normalized lead-agent and task-implementor profile selections with the run. Before resuming, it SHALL compare the requested selections with the checkpointed selections and SHALL reject a mismatch rather than continue one evaluation with changed role profiles.

#### Scenario: Resume uses matching profiles
- **WHEN** a resumable evaluation is invoked with role profiles matching the checkpointed selections
- **THEN** the harness continues the recorded Agent Runner run with those profiles

#### Scenario: Resume changes one profile
- **WHEN** a resume invocation changes the lead-agent or task-implementor profile from its checkpointed selection
- **THEN** the harness rejects the resume and identifies the profile mismatch

### Requirement: Configured and effective role reporting
The evaluation result SHALL record the normalized configured profile for each role and the actual role, CLI adapter, provider, model, effort, Agent Runner session, workflow step, and attempt identity observed for every agent invocation. It SHALL retain retries and resumed attempts and SHALL clearly identify any difference between configured and observed values.

Role configuration and per-attempt details SHALL appear in `result.json` and `report.html` and SHALL be available to the agent-and-model usage and cost aggregation. Missing effective-profile evidence SHALL be reported as incomplete rather than inferred from configuration alone.

#### Scenario: Agent invocation matches its configuration
- **WHEN** an Agent Runner attempt reports the role settings that were configured for it
- **THEN** the evaluation links the configured profile to the observed CLI, provider, model, effort, session, step, and attempt

#### Scenario: Effective setting differs from configuration
- **WHEN** an observed Agent Runner attempt uses a CLI, model, or effort different from its selected role profile
- **THEN** the evaluation preserves both values and prominently reports the mismatch

#### Scenario: Effective-profile evidence is unavailable
- **WHEN** Agent Runner artifacts do not establish the actual settings for an attempt
- **THEN** the evaluation marks effective role details incomplete without treating configured values as observed values

#### Scenario: Role has retries
- **WHEN** a lead-agent or task-implementor step is retried or resumed
- **THEN** every attempt is retained under the applicable role and configured profile

### Requirement: End-to-end product evaluation only
Independent role configuration SHALL NOT create isolated lead-agent evaluations, isolated task-implementor evaluations, or role-specific product-quality scores. The official score and verdict SHALL evaluate only the delivered product from the complete configured workflow. Per-role attempts, outcomes, usage, cost, and timing SHALL remain diagnostic data for comparisons among end-to-end runs.

#### Scenario: End-to-end workflow completes
- **WHEN** independently configured lead and implementor roles produce a candidate
- **THEN** the scorer evaluates the final delivered product under the common product-quality rubric
- **AND** it does not assign separate product-quality scores to either role

#### Scenario: Runs use different role combinations
- **WHEN** evaluators compare end-to-end runs with different lead-agent or task-implementor profiles
- **THEN** each run retains its role-level diagnostic data while its official result remains the score of its delivered product

Source: `specs/runner-workflow-execution/spec.md`

### Requirement: Clean recorded Agent Runner revision
The evaluation harness SHALL use `workflows/openspec/implement-change2.yaml` from the configured Agent Runner checkout. Before starting or resuming an Agent Runner workflow, the harness SHALL require that checkout to be a Git worktree with no staged, unstaged, or untracked changes. It SHALL record the checkout's commit SHA, the SHA-256 hash of the workflow file, and the Agent Runner CLI version, but SHALL NOT require the commit SHA to match a predetermined value.

On resume, the recorded Agent Runner commit, workflow hash, and CLI version SHALL match the checkout being used. A missing workflow, dirty checkout, or provenance mismatch SHALL stop the evaluation before Agent Runner execution.

#### Scenario: Clean Agent Runner checkout starts
- **WHEN** the configured Agent Runner checkout is clean and contains `workflows/openspec/implement-change2.yaml`
- **THEN** the harness records its commit, workflow hash, and CLI version and may start the workflow

#### Scenario: Agent Runner checkout has uncommitted changes
- **WHEN** the configured Agent Runner checkout has staged, unstaged, or untracked changes
- **THEN** the harness stops before Agent Runner execution with an error identifying the dirty checkout

#### Scenario: Recorded commit is not predetermined
- **WHEN** the clean Agent Runner checkout uses a commit different from an earlier evaluation
- **THEN** the harness permits a new evaluation and records the commit as workflow provenance

#### Scenario: Resume provenance changed
- **WHEN** resume finds a different Agent Runner commit, workflow hash, or CLI version from the recorded run
- **THEN** the harness refuses to reuse the Agent Runner checkpoint and reports a resume-provenance error

### Requirement: Validator control and stop boundary
The evaluation harness SHALL expose a `--skip-validator` option and SHALL hard-code `implement-change2` as the implementation workflow for this change. It SHALL pass the fixture change name and an explicit `skip_validator` workflow argument, and SHALL derive the final Agent Runner step from the eval option as follows.

| Eval invocation | Workflow argument | Final Agent Runner step |
|---|---|---|
| With `--skip-validator` | `skip_validator=true` | `simplify` |
| Without `--skip-validator` | `skip_validator=false` | `verify-validator` |

The option SHALL default to false. Before starting the workflow, the harness SHALL verify that the expected workflow parameter and selected stop step exist. The first complete evaluation required by this change SHALL explicitly use `--skip-validator`.

#### Scenario: Validator is skipped
- **WHEN** the eval is invoked with `--skip-validator`
- **THEN** the harness passes `skip_validator=true` and stops Agent Runner after `simplify`

#### Scenario: Validator is included by default
- **WHEN** the eval is invoked without `--skip-validator`
- **THEN** the harness passes `skip_validator=false` and stops Agent Runner after `verify-validator`

#### Scenario: Expected workflow contract is unavailable
- **WHEN** `implement-change2` lacks the `skip_validator` parameter or selected stop step
- **THEN** the harness fails before starting Agent Runner

### Requirement: Publishing-side-effect boundary
The evaluation harness SHALL stop `implement-change2` at the selected boundary and SHALL NOT execute any subsequent acceptance-test, pull-request, CI, archive, acceptance, or publishing step. It SHALL record both the configured boundary and the last observed executed workflow step.

#### Scenario: Skip-validator path reaches its boundary
- **WHEN** Agent Runner successfully completes `simplify` for a skip-validator evaluation
- **THEN** the harness ends Agent Runner execution without entering `run-validator` or any later step

#### Scenario: Validator path reaches its boundary
- **WHEN** Agent Runner successfully completes `verify-validator` for a Validator-enabled evaluation
- **THEN** the harness ends Agent Runner execution without entering `acceptance-test` or any later step

#### Scenario: Step beyond the boundary is observed
- **WHEN** Agent Runner provenance indicates that a later workflow step executed
- **THEN** the harness reports a workflow-boundary failure and records the unexpected step

### Requirement: Ordered evaluation lifecycle
The main evaluation command SHALL execute phases in this order: run or resume Agent Runner; install dependencies, build, and run non-browser verification; start the evaluated candidate server; run deterministic browser checks and capture evidence; run the four product judge jobs; run ambiguity diagnostics; ingest metrics and resolve pricing; write the pending-human-review result and HTML report; attempt candidate-server cleanup; update the pending artifacts with the cleanup outcome; and exit successfully.

The separate human-review command SHALL later restore or start the same evaluated candidate server; collect or resume human review; calculate the official result; generate the final HTML report; attempt candidate-server cleanup; update the final artifacts; and publish a curated permanent result for a completed pass or product-fail run. The candidate server SHALL be running before every browser-dependent phase and SHALL NOT be required to remain running between the automated and human-review commands.

#### Scenario: Automated evaluation follows the phase order
- **WHEN** every automated evaluation phase completes successfully
- **THEN** each automated phase begins only after its required predecessor has completed
- **AND** the command writes pending result artifacts, attempts candidate-server cleanup, and exits successfully without human input

#### Scenario: Human review finalizes later
- **WHEN** the separate human-review command completes a pending review
- **THEN** it calculates the official result, writes the final report, attempts cleanup, updates the cleanup outcome, and then publishes the completed result

#### Scenario: Paired first benchmark
- **WHEN** autonomous implementation finishes the pending reference baseline and pending first full Agent Runner run
- **THEN** a later paired human-review invocation finalizes the reference before the candidate and generates their comparison without rerunning automated phases

#### Scenario: Earlier phase cannot complete
- **WHEN** an evaluation phase cannot produce its required outputs
- **THEN** dependent phases do not run with fabricated or stale inputs
- **AND** final outcome reporting and cleanup still run when possible

### Requirement: Agent Runner run identity and resumption
The evaluation harness SHALL durably record the Agent Runner run identifier and session directory as soon as they become available. When an eval resumes, it SHALL use Agent Runner's persisted state and run-lock identity to determine the recorded run's status before taking action.

If the recorded Agent Runner run is active, the harness SHALL verify that the active process owns that run and wait for the same run rather than launching or resuming another. If the run completed through the configured stop boundary, the harness SHALL continue to the next eval phase. If the run is inactive and unfinished, the harness SHALL invoke `agent-runner --resume <run-id>` and allow Agent Runner to choose its internal resume point. If the run identity or status cannot be verified, the harness SHALL stop with an explicit workflow error. It SHALL never start a duplicate implementation run merely because the outer eval process restarted.

#### Scenario: Recorded Agent Runner run is still active
- **WHEN** eval resume verifies that the recorded Agent Runner run is owned by a live process
- **THEN** the harness waits for that same run and does not invoke a second implementation workflow

#### Scenario: Recorded Agent Runner run completed
- **WHEN** eval resume verifies that the recorded run completed through its configured stop boundary
- **THEN** the harness preserves its outputs and continues to the next incomplete eval phase

#### Scenario: Recorded Agent Runner run terminated unfinished
- **WHEN** eval resume verifies that the recorded run is inactive and unfinished
- **THEN** the harness invokes `agent-runner --resume` with that exact run identifier
- **AND** Agent Runner determines the internal workflow resume point

#### Scenario: Recorded run cannot be verified
- **WHEN** the harness cannot verify the recorded run's identity or status
- **THEN** it reports a workflow error and does not launch another Agent Runner run

### Requirement: Durable eval checkpointing
The harness SHALL maintain durable checkpoint state for every evaluation phase and for any finer work unit whose completion can be verified independently. Each checkpoint SHALL record its state, score-affecting input provenance, output artifact paths and hashes, and start and completion events.

On resume, the harness SHALL reuse the finest checkpoint it can deterministically prove complete. It MAY resume after individual browser checks, screenshots, judge batches, or human responses when each completed unit has durable matching evidence. When it cannot prove finer completion, it SHALL restart the enclosing phase from its beginning. A completed negative product finding SHALL remain a completed result and SHALL NOT be rerun merely because its verdict was fail.

The harness SHALL reject a checkpoint when its candidate identity, fixture revision, Agent Runner provenance, workflow arguments, agent configuration, evaluator configuration, or rubric provenance no longer matches the resumed run.

#### Scenario: Fine-grained checkpoint is valid
- **WHEN** resume can verify an individual work unit's complete output and matching provenance
- **THEN** the harness preserves that work and continues at the next incomplete unit

#### Scenario: Fine-grained completion is uncertain
- **WHEN** resume cannot prove which portion of an interrupted phase completed correctly
- **THEN** the harness restarts that phase from its beginning

#### Scenario: Completed product failure is preserved
- **WHEN** a deterministic check or judged criterion completed with a product-fail verdict before interruption
- **THEN** resume reuses that completed verdict when its provenance still matches

#### Scenario: Score-affecting provenance changed
- **WHEN** any score-affecting checkpoint input differs on resume
- **THEN** the harness refuses to reuse the stale checkpoint and reports which provenance changed

### Requirement: Workflow execution provenance
The evaluation result SHALL record the Agent Runner commit and clean-worktree result, CLI version, workflow path and SHA-256 hash, workflow arguments, Validator choice, run identifier, session directory, configured and observed stop boundaries, and every observed workflow step with its outcome. It SHALL also record start, wait, resume, completion, and retry events without treating those events as product points.

#### Scenario: Fresh Agent Runner run is recorded
- **WHEN** the harness starts a new Agent Runner run
- **THEN** it records the run identity, workflow provenance, arguments, stop boundary, and subsequent observed step outcomes

#### Scenario: Agent Runner run is resumed
- **WHEN** the harness waits for or resumes an existing Agent Runner run
- **THEN** it appends the wait or resume event while preserving the original run identity and start provenance

#### Scenario: Workflow provenance is incomplete
- **WHEN** the harness cannot determine the Agent Runner revision, workflow hash, arguments, or executed-step boundary
- **THEN** it marks workflow provenance incomplete and does not present the run as reproducible

Source: `specs/evaluation-outcomes/spec.md`

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

## Done When

- The thin host launcher can create or reopen a stable run directory, verify the clean Agent Runner/workflow contract, materialize independent `planner` and `implementor` profiles, and invoke or resume the exact recorded run through `simplify` or `verify-validator`.
- Unit and integration tests cover atomic persistence, provenance fingerprints, stale checkpoint rejection, active/inactive/completed Runner states, boundary violations, profile validation/mismatch, phase ordering, outcome transitions, and preservation of completed negative findings.
- Restarting the outer process never starts a duplicate Agent Runner implementation run, and credentials or user/global Agent Runner configuration are never persisted into the run directory.
- `result.json` can represent every approved execution status independently from product verdict availability, including recovery history and a later harness failure after a durable verdict.
- Existing and new targeted tests pass, shell and module syntax checks pass, and `npm run check` succeeds.
