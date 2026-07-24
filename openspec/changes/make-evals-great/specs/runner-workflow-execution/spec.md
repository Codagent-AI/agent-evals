## ADDED Requirements

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
