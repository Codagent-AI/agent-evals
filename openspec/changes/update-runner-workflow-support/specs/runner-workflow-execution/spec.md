## MODIFIED Requirements

### Requirement: Clean recorded Agent Runner revision
The evaluation harness SHALL use `workflows/core/implement-change-v1.0.yaml` from the configured Agent Runner checkout. Before starting or resuming an Agent Runner workflow, the harness SHALL require that checkout to be a Git worktree with no staged, unstaged, or untracked changes. It SHALL record the checkout's commit SHA, the SHA-256 hash of the workflow file, and the Agent Runner CLI version, but SHALL NOT require the commit SHA to match a predetermined value.

On resume, the recorded Agent Runner commit, workflow hash, and CLI version SHALL match the checkout being used. A missing workflow, dirty checkout, or provenance mismatch SHALL stop the evaluation before Agent Runner execution.

#### Scenario: Clean Agent Runner checkout starts
- **WHEN** the configured Agent Runner checkout is clean and contains `workflows/core/implement-change-v1.0.yaml`
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

#### Scenario: Resolved workflow does not match the pinned workflow
- **WHEN** the workflow Agent Runner resolves for the logical reference `core:implement-change` does not match the hash recorded from the pinned workflow file
- **THEN** the harness stops before Agent Runner execution and reports a workflow-resolution error

### Requirement: Validator control and stop boundary
The evaluation harness SHALL expose a `--skip-validator` option and SHALL hard-code the exact versioned workflow at `workflows/core/implement-change-v1.0.yaml` as the implementation workflow for this change, invoking it by the logical reference `core:implement-change`. It SHALL record the workflow's Agent Runner commit and content hash and SHALL pass the fixture change name, the OpenSpec artifact directory, change label, and artifact-validation instruction, together with an explicit `skip_validator` workflow argument. The option SHALL control only task-level compliance validation inside the implementation loop; it SHALL NOT select an early workflow stop boundary or skip the final Validator.

Because the shared workflow accepts the backend-specific values that Agent Runner's OpenSpec namespace would otherwise supply, the harness SHALL pass `change_dir` as `openspec/changes/<change-name>`, `change_label` as `OpenSpec change`, and an `artifact_validation_instruction` directing `openspec validate --type change` against the evaluated change name.

Each supplied parameter value SHALL be fully substituted before it is passed. Agent Runner interpolates a step template once against its parameters and does not re-interpolate a substituted value, so a parameter value containing an unresolved placeholder SHALL NOT be passed; it would reach the agent verbatim without raising an error.

| Eval invocation | Workflow argument | Task-level compliance | Final Validator | Workflow boundary |
|---|---|---|---|---|
| With `--skip-validator` | `skip_validator=true` | Skipped | Required | Full workflow completion |
| Without `--skip-validator` | `skip_validator=false` | Required | Required | Full workflow completion |

The option SHALL default to false. Before starting the workflow, the harness SHALL verify that the `change_name`, `change_dir`, `change_label`, `artifact_validation_instruction`, and `skip_validator` parameters exist, and that the required final Validator, draft-PR, draft-PR verification, acceptance-preparation, and handoff-verification steps exist as direct top-level steps of the invoked workflow. A required step declared only inside a loop, group, or nested step definition SHALL NOT satisfy the contract, because completed-step verification identifies a step by the first segment of its recorded step path. It SHALL also verify a clean pinned Agent Skills checkout containing every `codagent:*` skill named by the workflow and install that exact checkout for every selected workflow CLI before invoking an agent. The first complete evaluation required by this change SHALL explicitly use `--skip-validator`.

#### Scenario: Validator is skipped
- **WHEN** the eval is invoked with `--skip-validator`
- **THEN** the harness passes `skip_validator=true`
- **AND** Agent Runner continues through the final Validator, draft-PR, and acceptance workflow

#### Scenario: Validator is included by default
- **WHEN** the eval is invoked without `--skip-validator`
- **THEN** the harness passes `skip_validator=false`
- **AND** Agent Runner runs both task-level compliance and the final Validator before completing the workflow

#### Scenario: OpenSpec artifact parameters are supplied
- **WHEN** the harness starts the shared implementation workflow for the evaluated change
- **THEN** it passes `change_dir` as `openspec/changes/<change-name>`, `change_label` as `OpenSpec change`, and an artifact-validation instruction naming `openspec validate --type change` for that change

#### Scenario: Parameter values are supplied fully resolved
- **WHEN** the harness builds the workflow arguments for the evaluated change
- **THEN** every supplied value is fully substituted
- **AND** no value containing an unresolved placeholder is passed

#### Scenario: Expected workflow contract is unavailable
- **WHEN** `implement-change-v1.0.yaml` is unavailable or lacks any required parameter or any required final-workflow step
- **THEN** the harness fails before starting Agent Runner
- **AND** it identifies the missing workflow contract

#### Scenario: Required step is not a top-level step
- **WHEN** a required final-workflow step is declared only inside a loop, group, or nested step definition rather than as a direct top-level step
- **THEN** the harness fails before starting Agent Runner
- **AND** it identifies the step that does not satisfy the contract

#### Scenario: Required workflow skill is unavailable
- **WHEN** the pinned Agent Skills checkout is dirty, cannot be identified, or lacks a `codagent:*` skill named by the workflow
- **THEN** the harness fails before starting Agent Runner
- **AND** it identifies the unavailable skill or provenance

### Requirement: Candidate delivery and publication boundary
Before starting Agent Runner, the evaluation harness SHALL generate a durable unique evaluation run identifier and create a candidate branch named `eval/and-scene/<run-id>` from the pinned fixture commit in the configured fixture repository, where `<run-id>` is that evaluation identifier rather than the later Agent Runner run identifier. The complete workflow SHALL push only that candidate branch and SHALL create or update only its draft pull request. The pull request SHALL have a non-empty base branch identity and SHALL remain a draft.

The workflow SHALL NOT mark the pull request ready, merge it, archive the evaluated OpenSpec change, release the product, close the pull request, or delete the candidate branch. Candidate branches and draft pull requests SHALL be preserved for diagnosis and documented manual cleanup. The harness SHALL require credentials capable of pushing the candidate branch and managing its draft pull request before reporting workflow completion.

The harness SHALL reject a workflow contract that declares a merge, ready-for-review, close, archive, release, or branch-deletion step. After workflow completion, it SHALL verify the observable delivery boundary from recorded workflow history, an existing remote candidate branch, the unarchived change location, and pull-request metadata limited to URL or number, state, draft state, base branch, head branch, and head SHA. It SHALL NOT query CI while performing this verification. An observable prohibited effect SHALL produce `evaluation_status=implementation-workflow-failed` with reason `workflow-side-effect-violation`.

Agent Runner records each executed step as a path whose segments identify the enclosing steps and the sub-workflows they entered, where an entered sub-workflow appears as its workflow name behind a `sub:` prefix. The harness SHALL evaluate every segment of a recorded step path for a prohibited effect, and SHALL remove the `sub:` prefix before matching so that an entered sub-workflow whose name declares a prohibited effect is detected rather than excluded by its prefix.

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

#### Scenario: Prohibited effect occurs inside a nested step
- **WHEN** a recorded step path contains a prohibited step in a segment other than its first
- **THEN** the harness reports `workflow-side-effect-violation` for that step

#### Scenario: Prohibited effect is declared by an entered sub-workflow
- **WHEN** a recorded step path contains a `sub:` segment whose workflow name declares a prohibited effect
- **THEN** the harness matches that segment with its `sub:` prefix removed and reports `workflow-side-effect-violation`

## ADDED Requirements

### Requirement: Workflow contract regression detection
The suite's automated checks SHALL verify the pinned workflow contract against a real Agent Runner checkout when one is available at the configured Agent Runner directory, and SHALL skip that verification with an explicit message when no checkout is available. The check SHALL NOT require network access, a built Agent Runner binary, or a running workflow.

#### Scenario: Real checkout satisfies the contract
- **WHEN** the automated checks run with an available Agent Runner checkout whose pinned workflow declares every required parameter and required final-workflow step
- **THEN** the contract verification passes

#### Scenario: Real checkout no longer satisfies the contract
- **WHEN** the pinned workflow in an available Agent Runner checkout no longer declares a required parameter or required final-workflow step
- **THEN** the automated checks fail and identify each missing parameter or step

#### Scenario: Required step moved below the top level
- **WHEN** the pinned workflow in an available Agent Runner checkout declares a required final-workflow step only inside a loop, group, or nested step definition
- **THEN** the automated checks fail and identify that step

#### Scenario: No Agent Runner checkout is available
- **WHEN** the automated checks run without an available Agent Runner checkout
- **THEN** the contract verification is skipped with an explicit message
- **AND** the remaining automated checks still run
