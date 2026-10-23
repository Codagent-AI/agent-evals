## ADDED Requirements

### Requirement: Evaluated workflow selection and provenance
The evaluation harness SHALL accept the evaluated Agent Runner workflow as an input, `--workflow <logical-ref>`, defaulting to the suite's default workflow. It SHALL treat the workflow as opaque: beyond its logical reference, its declared parameters, and the `codagent:*` skills its files name, the harness SHALL NOT depend on the workflow's step identifiers, step order, nesting, named sessions, or recorded step paths for preflight, delivery verification, role attribution, or scoring.

Before starting or resuming an Agent Runner workflow, the harness SHALL require the configured Agent Runner checkout to be a Git worktree with no staged, unstaged, or untracked changes. It SHALL record the checkout's commit SHA, the Agent Runner CLI version, the evaluated workflow reference, and the SHA-256 hash of the definition Agent Runner resolves for that reference (`agent-runner debug --show-workflow <logical-ref>`), but SHALL NOT require the commit SHA to match a predetermined value. The harness SHALL record two workflow identities: the requested logical reference, and the Runner-reported workflow name, which is the `name` declared by the resolved definition. Agent Runner records that name in run state and `run-metrics.json`, so the harness SHALL derive the expected Runner-reported name from the resolved definition. It SHALL use the expected name for source-run discovery, resume classification, and metrics ingestion, and SHALL reject a run or metrics artifact whose reported name differs from it. It SHALL NOT accept a discovered run merely because the run's own reported name is self-consistent.

On resume, the recorded commit, workflow reference, resolved-definition hash, Runner-reported name, and CLI version SHALL match. A workflow that does not resolve, a dirty checkout, or a provenance mismatch SHALL stop the evaluation before Agent Runner execution.

#### Scenario: Default workflow is evaluated
- **WHEN** a new evaluation runs without `--workflow`
- **THEN** the harness evaluates the suite's default workflow and records that reference, its resolved-definition hash, the Agent Runner commit, and the CLI version

#### Scenario: Another workflow is selected
- **WHEN** a new evaluation runs with `--workflow` naming another logical workflow that resolves and declares the required parameters
- **THEN** the harness evaluates that workflow through the same preflight, delivery, attribution, and scoring path without workflow-specific code

#### Scenario: Selected workflow does not resolve
- **WHEN** Agent Runner cannot resolve the selected workflow reference in the configured checkout
- **THEN** the harness stops before Agent Runner execution and reports a workflow-resolution error

#### Scenario: Agent Runner checkout is dirty
- **WHEN** the configured Agent Runner checkout has staged, unstaged, or untracked changes
- **THEN** the harness stops before Agent Runner execution with an error identifying the dirty checkout

#### Scenario: Resume provenance differs
- **WHEN** resume finds a different Agent Runner commit, workflow reference, resolved-definition hash, or CLI version from the recorded run
- **THEN** the harness refuses to reuse the Agent Runner checkpoint and reports a resume-provenance error

#### Scenario: Logical reference maps to the reported name
- **WHEN** the evaluation requests a workflow whose resolved definition declares a name, such as `name: example`
- **THEN** the harness records both identities
- **AND** it accepts run state and `run-metrics.json` only when they report that declared name

#### Scenario: Discovered run reports a different workflow
- **WHEN** source-run discovery or metrics ingestion finds a run whose reported workflow name differs from the name the resolved definition declares
- **THEN** the harness rejects it with a workflow-identity error and does not adopt it

### Requirement: Workflow arguments and Validator mode
The harness SHALL invoke the evaluated workflow with `change_name` set to the fixture change name, `change_dir` as `openspec/changes/<change-name>`, `change_label` as `OpenSpec change`, `change_kind` as `openspec`, an `artifact_validation_instruction` directing `openspec validate --type change` against that change name, and an explicit `skip_validator`. Before starting, it SHALL verify that the resolved workflow declares each of these parameters, and SHALL fail before Agent Runner execution naming any that is missing. Each supplied value SHALL be fully substituted; a value containing an unresolved placeholder SHALL NOT be passed.

The harness SHALL expose `--skip-validator`, defaulting to false, and SHALL pass `skip_validator=true` or `skip_validator=false` accordingly. The evaluated workflow owns the meaning of that argument. The harness SHALL record the requested Validator mode as workflow provenance and baseline identity, deriving the recorded `task_level_compliance` and `final_validator` values from it, and SHALL NOT verify the mode from named workflow steps or their outcomes.

The harness SHALL verify a clean pinned Agent Skills checkout containing every `codagent:*` skill named in the resolved workflow or in any workflow file it references, and SHALL install that exact checkout for every selected workflow CLI before invoking an agent.

#### Scenario: Validator is skipped
- **WHEN** the eval is invoked with `--skip-validator`
- **THEN** the harness passes `skip_validator=true` and records the requested mode as skipped

#### Scenario: Validator is included by default
- **WHEN** the eval is invoked without `--skip-validator`
- **THEN** the harness passes `skip_validator=false` and records the requested mode as required

#### Scenario: Workflow lacks a required parameter
- **WHEN** the resolved workflow does not declare one of the required parameters
- **THEN** the harness fails before starting Agent Runner and names the missing parameter

#### Scenario: Parameter values are supplied fully resolved
- **WHEN** the harness builds the workflow arguments for the evaluated change
- **THEN** every supplied value is fully substituted
- **AND** no value containing an unresolved placeholder is passed

#### Scenario: Required workflow skill is unavailable
- **WHEN** the pinned Agent Skills checkout is dirty, cannot be identified, or lacks a `codagent:*` skill named in the evaluated workflow or a workflow file it references
- **THEN** the harness fails before starting Agent Runner and identifies the unavailable skill or provenance

### Requirement: Definition-only fixture starting line
The pinned fixture revision SHALL present the evaluated change as definition artifacts only. Before creating the candidate branch, the harness SHALL verify at the pinned fixture commit that `openspec/changes/<change-name>/` contains a non-empty `proposal.md`, `design.md`, and `test-plan.md` and at least one non-empty `specs/*/spec.md`, and that it contains no `tasks.md` and no `tasks/` directory. A fixture that fails either condition SHALL stop the evaluation before Agent Runner execution with the `fixture-planning-contract` error, identifying the missing definition artifact or the task artifact that is present. The harness SHALL NOT delete, generate, or rewrite fixture files to satisfy this contract.

Judging SHALL read approved requirements from the evaluated change at the recorded fixture commit, as `product-quality-scoring` requires, never from the candidate's copy, so a candidate that edits its definition artifacts is still graded against the pinned definition.

Results produced from this starting line SHALL form a new series. Earlier results, which started from a fixture with hand-written tasks and ran `core:implement-change`, SHALL NOT be admitted to a baseline of results from this starting line without an explicit identity-mismatch override; the differing recorded workflow and fixture commit SHALL be what distinguishes them.

#### Scenario: Definition-only fixture passes preflight
- **WHEN** the pinned fixture change contains the proposal, design, test plan, and specs and no task artifacts
- **THEN** preflight passes and the harness may create the candidate branch

#### Scenario: Fixture still contains tasks
- **WHEN** the pinned fixture change contains `tasks.md` or any file under `tasks/`
- **THEN** the harness stops before Agent Runner execution with `fixture-planning-contract`
- **AND** the error names the task artifact that is present

#### Scenario: Fixture lacks a definition artifact
- **WHEN** the pinned fixture change has no non-empty `test-plan.md`, `design.md`, `proposal.md`, or spec
- **THEN** the harness stops before Agent Runner execution with `fixture-planning-contract`
- **AND** the error names the missing artifact

#### Scenario: Candidate edits its definition
- **WHEN** the evaluated workflow changes the proposal, design, specs, or test plan on the candidate branch
- **THEN** product judging still grades the candidate against the pinned fixture definition and rubric

#### Scenario: Earlier repetition is offered to a new baseline
- **WHEN** a repetition that recorded a different workflow reference and the earlier fixture commit is added to a baseline defined by the definition-only starting line
- **THEN** the baseline command refuses it as an identity mismatch naming the workflow and fixture-commit fields

### Requirement: Workflow input regression detection
The suite's automated checks SHALL verify, against a real Agent Runner checkout when one is available, that the default evaluated workflow file exists in the checkout and declares every required workflow parameter. They SHALL skip that verification with an explicit message naming the resolved path when no checkout is available. The check SHALL NOT require network access, a built Agent Runner binary, or a running workflow, and SHALL NOT assert anything about the workflow's steps. The checks SHALL resolve the Agent Runner checkout the same way the host entry point does: an explicitly configured directory when one is set, and otherwise the sibling checkout beside the repository.

#### Scenario: Real checkout provides the default workflow
- **WHEN** the automated checks run with an available Agent Runner checkout whose default evaluated workflow declares every required parameter
- **THEN** the verification passes

#### Scenario: Default workflow is missing or lacks a parameter
- **WHEN** the default evaluated workflow is absent from an available checkout or does not declare a required parameter
- **THEN** the automated checks fail and identify the missing workflow or parameter

#### Scenario: No checkout is available
- **WHEN** neither a configured nor a sibling Agent Runner checkout is readable
- **THEN** the verification is skipped with a message naming the resolved path

### Requirement: Legacy rescore sources
An evaluator-only rescore SHALL preserve the source run's recorded workflow reference and Runner-reported name, fixture commit, role profiles, workflow arguments, and provenance, rather than substituting the current default workflow, fixture pin, or role requirements. A source run that recorded `core:implement-change`, a fixture with hand-written tasks, and three role profiles SHALL be rescorable:
- without a crosscheck profile, and without inventing one;
- without the definition-only fixture preflight;
- without starting Agent Runner.

In place of live Runner status, delivery verification SHALL use the completion status retained with the source: its recorded Runner state, or, when the session directory is gone, the reconstructed retained evidence that `Evaluator-only rescore sources` already verifies. It SHALL apply the same outcome-based delivery checks, with no step-layout special case.

#### Scenario: Three-role implement-only source is rescored
- **WHEN** an evaluator-only rescore imports a completed source that recorded `core:implement-change`, fixture `f0695b9`, and lead, implementor, and tester profiles only
- **THEN** the rescore proceeds without a crosscheck profile, without the definition-only preflight, and without starting Agent Runner
- **AND** the new result records the source's workflow, fixture commit, and three profiles

#### Scenario: Source with retained Runner session is rescored
- **WHEN** the source's Runner session directory is still available
- **THEN** delivery verification reads the recorded completion status and session output for that run

#### Scenario: Source with reconstructed evidence is rescored
- **WHEN** the source's Runner session directory is gone and its retained evidence passes the existing manifest and hash verification
- **THEN** delivery verification uses the retained completion record and restored evidence
- **AND** it does not require live Runner state

## MODIFIED Requirements

### Requirement: Agent Runner run identity and resumption
The evaluation harness SHALL generate and durably record its evaluation run identifier before starting Agent Runner. It SHALL separately record the Agent Runner run identifier, session directory, candidate branch, and candidate repository as soon as Agent Runner makes them available. It SHALL add the draft-PR identity and final pull-request head SHA as the complete workflow produces them. When an eval resumes, it SHALL verify the recorded evaluation run identifier, fixture commit, Agent Runner commit, Agent Skills commit and plugin-manifest hash, lead, crosscheck, implementor, and tester profiles, evaluated workflow reference and resolved hash, workflow arguments, candidate branch, candidate repository, draft PR, and known final head before taking action.

If the recorded Agent Runner run is active, the harness SHALL verify that the active process owns that run and wait for the same run rather than launching or resuming another. If the run completed the full workflow and its delivery identity still matches, the harness SHALL continue to the next eval phase. If the run is inactive and unfinished, the harness SHALL invoke `agent-runner --resume <run-id>` and allow Agent Runner to choose its internal resume point. If the run, process, branch, pull request, or revision identity cannot be verified, the harness SHALL stop with an explicit workflow or resume-provenance error. It SHALL never start a duplicate implementation run, candidate branch, or draft pull request merely because the outer eval process restarted.

Agent Runner development builds MAY launch linked audit runs asynchronously after the source workflow finalizes. When a completed source run of the evaluated workflow has no `state.audit.links`, the harness SHALL start an explicit `agent-runner audit replay <run-id> --session <execution-session-id>` against the finalized top-level execution session recorded in that run's `run-metrics.json` (the only `sessions[]` entry, or the last closed session after resume), using the same spawn options as the source run. It SHALL NOT start a second replay when a link already exists. A replay launch failure SHALL be a harness error. When the source state reports linked audits, the harness SHALL wait until every link is `completed` or `failed` before delivery verification, artifact ingestion, or scoring, so the disposable evaluation container cannot exit underneath a live audit. An audit launch or later failed audit state SHALL remain diagnostic and SHALL NOT replace the source workflow outcome. Each recorded linked audit SHALL carry an `outcome` derived from its audit run's `local-report.json`: `delivered`, `pending-delivery` (a report assembled without a reporting connection, which the host delivers), `failed` (a failed launch, or a completed audit with no local report, whose `reason` is the lifecycle warning), or `active`; a `failed` outcome SHALL also be recorded as a `linked-audit-failed` event. During recovery without a checkpointed source-run identifier, the harness SHALL exclude `runKind: audit` siblings from source-run discovery; an audit run remains inspectable by its exact identifier but SHALL NOT be adopted as the implementation workflow.

#### Scenario: Recorded Agent Runner run is still active
- **WHEN** eval resume verifies that the recorded Agent Runner run is owned by a live process
- **THEN** the harness waits for that same run
- **AND** it does not invoke a second implementation workflow or create another candidate branch

#### Scenario: Recorded Agent Runner run completed
- **WHEN** eval resume verifies that the recorded run completed the full workflow and its branch, PR, and final-head identity still match
- **THEN** the harness preserves its outputs and continues to the next incomplete eval phase

#### Scenario: Source completes with no linked audit
- **WHEN** the source implementation workflow is complete and its durable state has no audit link
- **THEN** the harness starts an explicit audit replay for the finalized top-level execution session
- **AND** it waits for that linked audit to become completed or failed before delivery verification

#### Scenario: Linked audit completes without a report
- **WHEN** a linked audit's lifecycle state is completed but its audit run wrote no local report
- **THEN** the harness records that linked audit with outcome `failed` and the lifecycle warning as its reason
- **AND** it records a `linked-audit-failed` event without changing the source workflow outcome

#### Scenario: Source already has a linked audit
- **WHEN** the source implementation workflow is complete and already has an audit link
- **THEN** the harness does not start another replay
- **AND** it waits for any nonterminal link before delivery verification

#### Scenario: Source completes with a linked audit still active
- **WHEN** the source implementation workflow is complete but its durable audit link is reserved, launching, or started
- **THEN** the harness waits for the linked audit to become completed or failed before delivery verification
- **AND** it does not let the disposable container exit while the linked audit remains active

#### Scenario: Recovery sees a newer audit child
- **WHEN** the harness restarts after source finalization but before recording the source run identifier and the newest persisted sibling has `runKind: audit`
- **THEN** source-run discovery ignores that child and adopts the newest ordinary workflow run
- **AND** exact-id audit inspection remains possible

#### Scenario: Recorded Agent Runner run terminated unfinished
- **WHEN** eval resume verifies that the recorded run is inactive and unfinished
- **THEN** the harness invokes `agent-runner --resume` with that exact run identifier
- **AND** Agent Runner resumes against the recorded branch and draft pull request

#### Scenario: Recorded run cannot be verified
- **WHEN** the harness cannot verify the recorded run, process, branch, pull request, or revision identity
- **THEN** it reports an explicit workflow or resume-provenance error
- **AND** it does not launch another Agent Runner run or silently select another candidate

### Requirement: Workflow execution provenance
The evaluation result SHALL record the evaluation run identifier; the distinct Agent Runner run identifier; the Agent Runner commit and clean-worktree result, CLI version, evaluated workflow reference and the SHA-256 hash of its resolved definition; the Agent Skills commit, clean-worktree result, and plugin-manifest hash; the configured lead, crosscheck, implementor, and tester profiles; workflow arguments; the requested Validator mode; session directory; candidate repository and branch; draft-PR URL and base; final local and PR head SHA; every observed workflow step and outcome, recorded as Agent Runner reports them without the harness interpreting step identities; candidate-reported CI status when present; acceptance attempt history; and hashes of required acceptance artifacts. It SHALL also record start, wait, resume, completion, and retry events without treating those events as product points.

#### Scenario: Fresh Agent Runner run is recorded
- **WHEN** the harness starts a new Agent Runner run
- **THEN** it records the run identity, workflow and Agent Skills provenance, all four workflow profiles, arguments, candidate branch, and subsequent observed step outcomes
- **AND** it adds PR, final-SHA, candidate-reported CI, and acceptance provenance as those values become available

#### Scenario: Agent Runner run is resumed
- **WHEN** the harness waits for or resumes an existing Agent Runner run
- **THEN** it appends the wait or resume event
- **AND** it preserves the original run, branch, PR, and start provenance

#### Scenario: Workflow provenance is incomplete
- **WHEN** the harness cannot determine the Agent Runner revision, workflow hash, Agent Skills revision and manifest hash, configured workflow profiles, arguments, candidate identity, executed-step history, or acceptance-artifact identity
- **THEN** it marks workflow provenance incomplete
- **AND** it does not present the run as reproducible or ready for scored judging

### Requirement: Candidate delivery and acceptance handoff
Before scored product judging begins, Agent Runner SHALL report the evaluated run as completed successfully, and the run SHALL leave a clean committed candidate on the recorded `eval/and-scene/<run-id>` branch, a draft pull request with a non-empty base, identical local and pull-request head SHAs, acceptance flow evidence and screenshots, findings history, a final acceptance handoff, and an assumptions ledger. The harness SHALL establish these from the run's completion status, the candidate repository and branch, pull-request metadata, and the produced artifacts, and SHALL NOT require any named workflow step, step path, or step outcome as delivery evidence.

The acceptance artifacts SHALL be discovered under the Agent Runner session's `output/` directory, which is the only discovery anchor, using the suite's evidence role registry: its artifact roles and accepted file names and formats. Candidate repository files SHALL enter only through safe references from those artifacts, at the delivered revision. This output contract is the delivery interface any evaluated workflow must satisfy, whatever its steps; it is not inferred from step identities.

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
- **WHEN** Agent Runner does not report the run as completed successfully, or the run lacks a required candidate identity, acceptance artifact, handoff, or assumptions ledger
- **THEN** the evaluation reports `implementation-workflow-failed`
- **AND** it preserves available diagnostics without beginning scored product judging

#### Scenario: Different workflow delivers the same outputs
- **WHEN** an evaluated workflow with different step names and nesting completes successfully, leaves the required candidate and draft pull request, and writes artifacts matching the evidence role registry under its session's `output/` directory
- **THEN** the harness accepts the delivery without any workflow-specific step knowledge

#### Scenario: Artifacts are written outside the discovery anchor
- **WHEN** a completed workflow writes acceptance artifacts only inside the candidate repository, with no matching artifacts under the session's `output/` directory
- **THEN** the harness reports the missing acceptance outputs as `implementation-workflow-failed`

### Requirement: Candidate delivery and publication boundary
Before starting Agent Runner, the evaluation harness SHALL generate a durable unique evaluation run identifier and create a candidate branch named `eval/and-scene/<run-id>` from the pinned fixture commit in the configured fixture repository, where `<run-id>` is that evaluation identifier rather than the later Agent Runner run identifier. The complete workflow SHALL push only that candidate branch and SHALL create or update only its draft pull request. The pull request SHALL have a non-empty base branch identity and SHALL remain a draft.

The workflow SHALL NOT mark the pull request ready, merge it, archive the evaluated OpenSpec change, release the product, close the pull request, or delete the candidate branch. Candidate branches and draft pull requests SHALL be preserved for diagnosis and documented manual cleanup. The harness SHALL require credentials capable of pushing the candidate branch and managing its draft pull request before reporting workflow completion.

After workflow completion, the harness SHALL verify the observable delivery boundary from an existing remote candidate branch, the unarchived change location, and pull-request metadata limited to URL or number, state, draft state, base branch, head branch, and head SHA. It SHALL NOT query CI while performing this verification. An observable prohibited effect SHALL produce `evaluation_status=implementation-workflow-failed` with reason `workflow-side-effect-violation`.

The harness SHALL detect prohibited effects only from that observable final state, wherever in the workflow they were caused. It SHALL NOT inspect workflow definitions or recorded step names or paths for prohibited steps. The prohibition still covers the whole run, but verification covers only violations visible in final state:
- a pull request that is not a draft, or is merged or closed;
- a missing remote candidate branch, or a remote head that differs from the delivered SHA;
- a missing change directory.

Effects reversed before completion (marked ready and converted back to draft, a branch deleted and recreated, an archive reverted) and releases are not detectable from these observations. The result SHALL disclose that the publication-boundary check covers final state only. When the harness cannot obtain the branch or pull-request observations, it SHALL report an evaluation-harness failure rather than treat the boundary as verified.

#### Scenario: Unique candidate branch is prepared
- **WHEN** a fresh candidate evaluation starts
- **THEN** the harness generates and records the evaluation run identifier and creates `eval/and-scene/<run-id>` at the pinned fixture commit before Agent Runner begins
- **AND** it records the configured fixture origin and branch identity, then records the distinct Agent Runner run identifier when it becomes available

#### Scenario: Complete workflow opens a draft pull request
- **WHEN** the evaluated workflow publishes the candidate
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
- **WHEN** the observable delivery state establishes that the evaluated workflow marked the pull request ready, merged it, archived the change, released the product, closed the pull request, or deleted the candidate branch
- **THEN** the harness reports `evaluation_status=implementation-workflow-failed` with reason `workflow-side-effect-violation`
- **AND** it records the unexpected action without treating the workflow as successfully complete

#### Scenario: Prohibited effect occurs inside a nested step
- **WHEN** a step nested inside a sub-workflow marks the pull request ready, merges it, archives the change, closes the pull request, or deletes the candidate branch
- **THEN** the harness detects the effect from the observable delivery state and reports `workflow-side-effect-violation`

#### Scenario: Prohibited effect is declared by an entered sub-workflow
- **WHEN** the evaluated workflow enters a sub-workflow whose name suggests a prohibited effect but the observable delivery state shows no prohibited effect
- **THEN** the harness does not report a violation from the name alone
- **AND** when the observable state does show a prohibited effect, it reports `workflow-side-effect-violation`

#### Scenario: Prohibited effect was reversed before completion
- **WHEN** a workflow marked the pull request ready and converted it back to draft before completing
- **THEN** the final-state check does not detect the effect
- **AND** the result states that the publication-boundary check covers final state only

#### Scenario: Delivery observations are unavailable
- **WHEN** the harness cannot read the remote candidate branch or pull-request metadata after completion
- **THEN** it reports an evaluation-harness failure and does not mark the publication boundary verified

## REMOVED Requirements

### Requirement: Clean recorded Agent Runner revision
**Reason**: It hard-coded `workflows/core/implement-change-v1.0.yaml` and the `core:implement-change` and `core:verify-change` layouts.
**Migration**: Replaced by "Evaluated workflow selection and provenance", which records the selected workflow reference and its resolved-definition hash and keeps the clean-checkout and resume rules.

### Requirement: Validator control and stop boundary
**Reason**: It required named final steps (`run-validator`, `open-draft-pr`, `verify-draft-pr`, `prepare-acceptance`, `verify-acceptance-handoff`) at fixed step paths and verified the Validator mode from step outcomes, which ties the harness to one workflow's internals.
**Migration**: Replaced by "Workflow arguments and Validator mode" for arguments and the requested mode, and by the modified "Candidate delivery and acceptance handoff" for outcome-based delivery verification.

### Requirement: Workflow contract regression detection
**Reason**: It asserted the presence and position of named workflow steps.
**Migration**: Replaced by "Workflow input regression detection", which checks only that the default workflow exists and declares the required parameters.
