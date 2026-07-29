# Task: Build the delivery state machine

## Goal

Replace the boundary-oriented controller with a versioned, manifest-driven state machine that follows one candidate from the pinned fixture through complete Agent Runner delivery and a verified final draft-PR revision. Make delivery identity, failure ownership, and fine-grained resume safe and independently testable before product evaluation consumes the frozen candidate.

## Background

The approved architecture is a deliberate rewrite of the unsuccessful controller internals. Read `proposal.md`, `design.md`, `specs/runner-workflow-execution/spec.md`, and `specs/evaluation-outcomes/spec.md` before implementation. Keep all behavior suite-local under `evals/agent-runner/and-scene/`; Agent Runner continues to own workflow execution, sessions, locks, process identity, authentication forwarding, the sandbox image, and its devcontainer. Do not add a shared framework or a third-party runtime dependency.

Use `evals/agent-runner/and-scene/run.sh` as the thin host launcher and replace the lifecycle in `controller.mjs`, `lib/checkpoint.mjs`, `lib/phases.mjs`, and `lib/outcomes.mjs` with one atomic, versioned `run-state.json` plus focused reducer/orchestrator modules under `lib/`. Existing unsuccessful checkpoint-format run directories are diagnostics only and are not resumable. The state must record immutable input hashes, evolving delivery identity, typed lifecycle events and failure ownership, phase/work-unit input and dependency hashes, output paths and hashes, and explicit applicability for candidate and reference runs.

Update `lib/provenance.mjs`, `lib/workflow.mjs`, `lib/runner-state.mjs`, `lib/candidate.mjs`, controller integration, and their tests to use the exact workflow `workflows/openspec/implement-change-v2.0.yaml` without `--until`. `--skip-validator` maps only to `skip_validator=true`; it skips task-level compliance but never the final Validator or later delivery and acceptance steps. Preflight the required workflow parameter and final Validator, draft-PR, acceptance-preparation, and handoff-verification steps, and reject declared merge, ready-for-review, close, archive, release, or branch-deletion behavior.

For each fresh candidate, create `eval/and-scene/<run-id>` at the exact fixture commit in the configured fixture repository before Agent Runner starts. Refuse collisions and unverifiable existing identities. After the full workflow completes, verify the clean committed worktree, fixture ancestry, remote candidate branch, unarchived OpenSpec change, final Validator and acceptance-handoff history, and one open draft PR with a non-empty base, the expected head branch, and a head SHA equal to local `HEAD`. Limit GitHub inspection to URL/number, state, draft state, base, head branch, and head SHA; do not call checks, statuses, or any CI endpoint. Preserve the branch and draft PR in every outcome for diagnosis and manual cleanup.

Resume must revalidate fixture, Runner revision and workflow hash, arguments, profiles, candidate repository and branch, PR, final SHA, evaluator configuration, rubric provenance, and score-affecting evidence identity. Consult Runner persisted state and live process ownership before start/wait/resume/continue, invoke `agent-runner --resume <run-id>` only for the recorded inactive unfinished run, rehash completed work before reuse, and never create a duplicate run, branch, or PR because the outer process restarted. Implement these behaviors test-first in the existing `test/controller.test.mjs`, `test/checkpoint.test.mjs`, `test/workflow.test.mjs`, `test/runner-state.test.mjs`, `test/candidate.test.mjs`, `test/phases.test.mjs`, and `test/outcomes.test.mjs` conventions.

## Spec

Source: `specs/runner-workflow-execution/spec.md`

### Requirement: Validator control and stop boundary
The evaluation harness SHALL expose a `--skip-validator` option and SHALL hard-code the exact versioned workflow at `workflows/openspec/implement-change-v2.0.yaml` as the implementation workflow for this change. It SHALL record the workflow's Agent Runner commit and content hash and SHALL pass the fixture change name and an explicit `skip_validator` workflow argument. The option SHALL control only task-level compliance validation inside the implementation loop; it SHALL NOT select an early workflow stop boundary or skip the final Validator.

| Eval invocation | Workflow argument | Task-level compliance | Final Validator | Workflow boundary |
|---|---|---|---|---|
| With `--skip-validator` | `skip_validator=true` | Skipped | Required | Full workflow completion |
| Without `--skip-validator` | `skip_validator=false` | Required | Required | Full workflow completion |

The option SHALL default to false. Before starting the workflow, the harness SHALL verify that the `skip_validator` parameter and the required final Validator, draft-PR, acceptance-preparation, and handoff-verification steps exist. The first complete evaluation required by this change SHALL explicitly use `--skip-validator`.

#### Scenario: Task-level compliance is skipped
- **WHEN** the eval is invoked with `--skip-validator`
- **THEN** the harness passes `skip_validator=true`
- **AND** Agent Runner continues through the final Validator, draft-PR, and acceptance workflow

#### Scenario: Task-level compliance is included by default
- **WHEN** the eval is invoked without `--skip-validator`
- **THEN** the harness passes `skip_validator=false`
- **AND** Agent Runner runs both task-level compliance and the final Validator before completing the workflow

#### Scenario: Expected full-workflow contract is unavailable
- **WHEN** `implement-change-v2.0.yaml` is unavailable or lacks the `skip_validator` parameter or any required final-workflow step
- **THEN** the harness fails before starting Agent Runner
- **AND** it identifies the missing workflow contract

### Requirement: Publishing-side-effect boundary
Before starting Agent Runner, the evaluation harness SHALL generate a durable unique evaluation run identifier and create a candidate branch named `eval/and-scene/<run-id>` from the pinned fixture commit in the configured fixture repository, where `<run-id>` is that evaluation identifier rather than the later Agent Runner run identifier. The complete workflow SHALL push only that candidate branch and SHALL create or update only its draft pull request. The pull request SHALL have a non-empty base branch identity and SHALL remain a draft.

The workflow SHALL NOT mark the pull request ready, merge it, archive the evaluated OpenSpec change, release the product, close the pull request, or delete the candidate branch. Candidate branches and draft pull requests SHALL be preserved for diagnosis and documented manual cleanup. The harness SHALL require credentials capable of pushing the candidate branch and managing its draft pull request before reporting workflow completion.

The harness SHALL reject a workflow contract that declares a merge, ready-for-review, close, archive, release, or branch-deletion step. After workflow completion, it SHALL verify the observable delivery boundary from recorded workflow history, an existing remote candidate branch, the unarchived change location, and pull-request metadata limited to URL or number, state, draft state, base branch, head branch, and head SHA. It SHALL NOT query CI while performing this verification. An observable prohibited effect SHALL produce `evaluation_status=implementation-workflow-failed` with reason `workflow-side-effect-violation`.

#### Scenario: Unique candidate branch is prepared
- **WHEN** a fresh candidate evaluation starts
- **THEN** the harness generates and records the evaluation run identifier and creates `eval/and-scene/<run-id>` at the pinned fixture commit before Agent Runner begins
- **AND** it records the configured fixture origin and branch identity, then records the distinct Agent Runner run identifier when it becomes available

#### Scenario: Complete workflow opens a draft pull request
- **WHEN** Agent Runner reaches its pull-request step
- **THEN** it pushes the recorded candidate branch and creates or updates its draft pull request
- **AND** the resulting pull request has a non-empty base identity and remains a draft

#### Scenario: Publishing credentials are unavailable
- **WHEN** the workflow cannot push the recorded branch or manage its draft pull request with the supplied credentials
- **THEN** the evaluation reports an implementation-workflow failure
- **AND** it does not report the candidate delivery as complete

#### Scenario: Candidate is preserved after evaluation
- **WHEN** an evaluation completes or fails after creating the candidate branch or draft pull request
- **THEN** the harness leaves those external resources intact
- **AND** it records them for diagnosis and manual cleanup

#### Scenario: Prohibited publication is attempted
- **WHEN** the workflow contract, recorded step or output history, or observable delivery state establishes that the evaluated workflow marked the pull request ready, merged it, archived the change, released the product, closed the pull request, or deleted the candidate branch
- **THEN** the harness reports `evaluation_status=implementation-workflow-failed` with reason `workflow-side-effect-violation`
- **AND** it records the unexpected action without treating the workflow as successfully complete

### Requirement: Ordered evaluation lifecycle
For an Agent Runner candidate, the main evaluation command SHALL execute phases in this order: preflight the pinned fixture, unique candidate branch, Agent Runner checkout, workflow contract, credentials, profiles, evaluator, and run directory; run or resume the complete Agent Runner workflow; verify candidate delivery and acceptance-handoff completeness; install dependencies, build, and run non-browser verification; start the evaluated final candidate server; run deterministic browser checks and capture evaluator evidence; run the six focused product judge jobs; run the separate non-scoring ambiguity diagnostic; ingest metrics and resolve pricing; write the pending-human-review result and HTML report; attempt candidate-server cleanup; update the pending artifacts with the cleanup outcome; and exit successfully.

The separate human-review command SHALL later restore or start the same evaluated final candidate server; collect or resume human review; calculate the official candidate result; generate the final HTML report; attempt candidate-server cleanup; update the final artifacts; and publish a curated permanent result for a completed scored candidate pass or product-fail run. The candidate server SHALL be running before every browser-dependent phase and SHALL NOT be required to remain running between the automated and human-review commands. If verified product behavior makes the final candidate unable to install, build, or serve, dependent browser and human-review phases SHALL NOT run, and the conclusive product-failure outcome rules SHALL apply instead.

#### Scenario: Automated candidate evaluation follows the phase order
- **WHEN** every automated candidate-evaluation phase completes successfully
- **THEN** each phase begins only after its required predecessor has completed
- **AND** scored product judging begins only after complete candidate delivery and acceptance-handoff evidence are verified

#### Scenario: Human review finalizes later
- **WHEN** the separate human-review command completes a pending candidate review
- **THEN** it calculates the official result, writes the final report, attempts cleanup, updates the cleanup outcome, and then publishes the completed result

#### Scenario: Paired fresh benchmark
- **WHEN** autonomous evaluation finishes the pending recreated reference and pending fresh Agent Runner candidate
- **THEN** a later paired human-review invocation finalizes the reference before the candidate
- **AND** it generates their shared-92 comparison without rerunning completed automated phases

#### Scenario: Earlier phase cannot complete
- **WHEN** an evaluation phase cannot produce its required outputs
- **THEN** dependent phases do not run with fabricated or stale inputs
- **AND** final outcome reporting and cleanup still run when possible

#### Scenario: Delivered product cannot install, build, or serve
- **WHEN** deterministic verification establishes that the frozen final candidate cannot install, build, or serve because of reproducible product behavior
- **THEN** dependent browser and human-review phases do not run
- **AND** the evaluation applies the conclusive product-failure outcome without classifying the product defect as a harness failure

### Requirement: Agent Runner run identity and resumption
The evaluation harness SHALL generate and durably record its evaluation run identifier before starting Agent Runner. It SHALL separately record the Agent Runner run identifier, session directory, candidate branch, and candidate repository as soon as Agent Runner makes them available. It SHALL add the draft-PR identity and final pull-request head SHA as the complete workflow produces them. When an eval resumes, it SHALL verify the recorded evaluation run identifier, fixture commit, Agent Runner commit, profiles, workflow arguments, candidate branch, candidate repository, draft PR, and known final head before taking action.

If the recorded Agent Runner run is active, the harness SHALL verify that the active process owns that run and wait for the same run rather than launching or resuming another. If the run completed the full workflow and its delivery identity still matches, the harness SHALL continue to the next eval phase. If the run is inactive and unfinished, the harness SHALL invoke `agent-runner --resume <run-id>` and allow Agent Runner to choose its internal resume point. If the run, process, branch, pull request, or revision identity cannot be verified, the harness SHALL stop with an explicit workflow or resume-provenance error. It SHALL never start a duplicate implementation run, candidate branch, or draft pull request merely because the outer eval process restarted.

#### Scenario: Recorded Agent Runner run is still active
- **WHEN** eval resume verifies that the recorded Agent Runner run is owned by a live process
- **THEN** the harness waits for that same run
- **AND** it does not invoke a second implementation workflow or create another candidate branch

#### Scenario: Recorded Agent Runner run completed
- **WHEN** eval resume verifies that the recorded run completed the full workflow and its branch, PR, and final-head identity still match
- **THEN** the harness preserves its outputs and continues to the next incomplete eval phase

#### Scenario: Recorded Agent Runner run terminated unfinished
- **WHEN** eval resume verifies that the recorded run is inactive and unfinished
- **THEN** the harness invokes `agent-runner --resume` with that exact run identifier
- **AND** Agent Runner resumes against the recorded branch and draft pull request

#### Scenario: Recorded identity cannot be verified
- **WHEN** the harness cannot verify the recorded run, process, branch, pull request, or revision identity
- **THEN** it reports an explicit workflow or resume-provenance error
- **AND** it does not launch another Agent Runner run or silently select another candidate

### Requirement: Durable eval checkpointing
The harness SHALL maintain durable checkpoint state for every evaluation phase and for every finer work unit whose completion can be verified independently. Each checkpoint SHALL record its state, score-affecting input provenance, output artifact paths and hashes, and start and completion events.

Checkpoint provenance SHALL include the fixture repository and commit, Agent Runner commit and workflow hash, workflow arguments, lead and implementor profiles, candidate branch, draft-PR identity, known final SHA, evaluator configuration, rubric provenance, and hashes of required acceptance evidence. On resume, the harness SHALL reuse the finest checkpoint it can deterministically prove complete. It SHALL resume after individual browser checks, screenshots, judge jobs, or human responses when each completed unit has durable matching evidence. When it cannot prove finer completion, it SHALL restart the enclosing phase from its beginning. A completed negative product finding SHALL remain a completed result and SHALL NOT be rerun merely because its verdict was fail.

The harness SHALL reject a checkpoint when any recorded identity or score-affecting input no longer matches the resumed run.

#### Scenario: Fine-grained checkpoint is valid
- **WHEN** resume can verify an individual work unit's complete output and matching provenance
- **THEN** the harness preserves that work and continues at the next incomplete unit

#### Scenario: Fine-grained completion is uncertain
- **WHEN** resume cannot prove which portion of an interrupted phase completed correctly
- **THEN** the harness restarts that phase from its beginning

#### Scenario: Completed product failure is preserved
- **WHEN** a deterministic check or judged criterion completed with a product-fail verdict before interruption
- **THEN** resume reuses that completed verdict when its provenance still matches

#### Scenario: Candidate or evidence identity changed
- **WHEN** the recorded branch, PR, final SHA, acceptance-evidence hash, or another score-affecting input differs on resume
- **THEN** the harness refuses to reuse the stale checkpoint
- **AND** it reports which provenance changed

### Requirement: Workflow execution provenance
The evaluation result SHALL record the evaluation run identifier; the distinct Agent Runner run identifier; the Agent Runner commit and clean-worktree result, CLI version, workflow path and SHA-256 hash; workflow arguments; task-level Validator choice; session directory; candidate repository and branch; draft-PR URL and base; final local and PR head SHA; every observed workflow step and outcome; final Validator result; candidate-reported CI status when present; acceptance attempt history; and hashes of required acceptance artifacts. It SHALL also record start, wait, resume, completion, and retry events without treating those events as product points.

#### Scenario: Fresh Agent Runner run is recorded
- **WHEN** the harness starts a new Agent Runner run
- **THEN** it records the run identity, workflow provenance, arguments, candidate branch, and subsequent observed step outcomes
- **AND** it adds PR, final-SHA, Validator, candidate-reported CI, and acceptance provenance as those values become available

#### Scenario: Agent Runner run is resumed
- **WHEN** the harness waits for or resumes an existing Agent Runner run
- **THEN** it appends the wait or resume event
- **AND** it preserves the original run, branch, PR, and start provenance

#### Scenario: Workflow provenance is incomplete
- **WHEN** the harness cannot determine the Agent Runner revision, workflow hash, arguments, candidate identity, executed-step history, final Validator result, or acceptance-artifact identity
- **THEN** it marks workflow provenance incomplete
- **AND** it does not present the run as reproducible or ready for scored judging

### Requirement: Candidate delivery and acceptance handoff
Before scored product judging begins, the completed workflow SHALL leave a clean committed candidate on the recorded `eval/and-scene/<run-id>` branch, a draft pull request with a non-empty base, identical local and pull-request head SHAs, final Validator results, acceptance flow evidence and screenshots, findings history, a final acceptance handoff, and an assumptions ledger.

Product defects, failed acceptance flows, limitations, unresolved assumptions, and any candidate-reported CI state recorded honestly in an otherwise complete handoff SHALL remain judgeable evidence and SHALL NOT by themselves convert the run to an implementation-workflow failure. The harness SHALL NOT independently query CI, wait for CI, or require CI to be passing, terminal, configured, or available before scored product judging.

#### Scenario: Candidate delivery is complete and clean
- **WHEN** the workflow finishes with a clean worktree, a committed final candidate, a draft PR with a non-empty base, and matching local and PR heads
- **THEN** the harness records the delivered final SHA
- **AND** it proceeds to evaluate the remaining required handoff evidence

#### Scenario: Acceptance finds a product defect
- **WHEN** the complete handoff honestly records a failed product flow
- **THEN** scored product judging proceeds against the final candidate
- **AND** the finding remains available to the applicable product and evidence criteria

#### Scenario: Acceptance records unresolved assumptions
- **WHEN** the complete handoff and assumptions ledger identify unresolved decisions without omitting required artifacts or identity
- **THEN** scored product judging proceeds
- **AND** the unresolved decisions remain available to assumption-handling scoring

#### Scenario: Acceptance reports CI status
- **WHEN** the complete handoff reports passing, failing, pending, absent, or unavailable CI
- **THEN** the harness preserves that report as candidate-produced evidence
- **AND** scored product judging proceeds without an independent CI query

#### Scenario: Required delivery output is absent
- **WHEN** the completed workflow lacks a required candidate identity, Validator result, acceptance artifact, handoff, or assumptions ledger
- **THEN** the evaluation reports `implementation-workflow-failed`
- **AND** it preserves available diagnostics without beginning scored product judging

Source: `specs/evaluation-outcomes/spec.md`

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

## Done When

- A fresh candidate branch is created exactly once from the pinned fixture, the full versioned workflow runs without an early stop, and delivery is frozen only after the clean local head, remote branch, draft PR/base/head, final Validator, and required acceptance handoff are verified.
- Workflow preflight rejects missing required steps and prohibited side-effect declarations; post-run verification reports `workflow-side-effect-violation` for an observed prohibited effect while never querying CI.
- `run-state.json` is the sole atomic state authority, has an explicit new schema version, records all immutable inputs and evolving delivery identity, and cannot resume an old boundary-era state file.
- Start/wait/resume/continue decisions prove Runner process ownership and the recorded run/branch/PR/revision identity, reuse verified negative and positive work units by hash, and refuse duplicate or stale work with a precise provenance error.
- Structurally incomplete delivery becomes `implementation-workflow-failed` with durable diagnostics; complete handoffs containing honest product defects, failed flows, CI claims, limitations, or unresolved assumptions remain eligible for judging.
- Candidate branches and draft PRs are always retained and reported for manual cleanup; reference runs explicitly mark delivery-only state and provenance not applicable.
- The suite runbook and launcher help describe the full workflow, credential requirement, external-resource retention, resume behavior, and removal of the old stop boundary.
- Targeted state, workflow, delivery, process-identity, and resume tests pass, followed by `npm run check`.
