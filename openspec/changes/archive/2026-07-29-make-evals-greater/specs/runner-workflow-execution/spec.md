## MODIFIED Requirements

### Requirement: Validator control and stop boundary
The evaluation harness SHALL expose a `--skip-validator` option and SHALL hard-code the exact versioned workflow at `workflows/openspec/implement-change-v2.0.yaml` as the implementation workflow for this change. It SHALL record the workflow's Agent Runner commit and content hash and SHALL pass the fixture change name and an explicit `skip_validator` workflow argument. The option SHALL control only task-level compliance validation inside the implementation loop; it SHALL NOT select an early workflow stop boundary or skip the final Validator.

| Eval invocation | Workflow argument | Task-level compliance | Final Validator | Workflow boundary |
|---|---|---|---|---|
| With `--skip-validator` | `skip_validator=true` | Skipped | Required | Full workflow completion |
| Without `--skip-validator` | `skip_validator=false` | Required | Required | Full workflow completion |

The option SHALL default to false. Before starting the workflow, the harness SHALL verify that the `skip_validator` parameter and the required final Validator, draft-PR, acceptance-preparation, and handoff-verification steps exist. It SHALL also verify a clean pinned Agent Skills checkout containing every `codagent:*` skill named by the workflow and install that exact checkout for every selected workflow CLI before invoking an agent. The first complete evaluation required by this change SHALL explicitly use `--skip-validator`.

#### Scenario: Validator is skipped
- **WHEN** the eval is invoked with `--skip-validator`
- **THEN** the harness passes `skip_validator=true`
- **AND** Agent Runner continues through the final Validator, draft-PR, and acceptance workflow

#### Scenario: Validator is included by default
- **WHEN** the eval is invoked without `--skip-validator`
- **THEN** the harness passes `skip_validator=false`
- **AND** Agent Runner runs both task-level compliance and the final Validator before completing the workflow

#### Scenario: Expected workflow contract is unavailable
- **WHEN** `implement-change-v2.0.yaml` is unavailable or lacks the `skip_validator` parameter or any required final-workflow step
- **THEN** the harness fails before starting Agent Runner
- **AND** it identifies the missing workflow contract

#### Scenario: Required workflow skill is unavailable
- **WHEN** the pinned Agent Skills checkout is dirty, cannot be identified, or lacks a `codagent:*` skill named by the workflow
- **THEN** the harness fails before starting Agent Runner
- **AND** it identifies the unavailable skill or provenance

### Requirement: Ordered evaluation lifecycle
For an Agent Runner candidate, the main evaluation command SHALL execute phases in this order: preflight the pinned fixture, unique candidate branch, Agent Runner checkout, Agent Skills checkout, workflow contract, credentials, lead, implementor, and reviewer profiles, evaluator, and run directory; install the pinned workflow skills for the selected CLIs; run or resume the complete Agent Runner workflow; verify candidate delivery and acceptance-handoff completeness; install dependencies, build, and run non-browser verification; start the evaluated final candidate server; run deterministic browser checks and capture evaluator evidence; run the six focused product judge jobs; run the separate non-scoring ambiguity diagnostic; ingest metrics and resolve pricing; write the pending-human-review result and HTML report; attempt candidate-server cleanup; update the pending artifacts with the cleanup outcome; and exit successfully.

The separate human-review command SHALL later restore or start the same evaluated final candidate server; collect or resume human review; calculate the official candidate result; generate the final HTML report; attempt candidate-server cleanup; update the final artifacts; and publish a curated permanent result for a completed scored candidate pass or product-fail run. The candidate server SHALL be running before every browser-dependent phase and SHALL NOT be required to remain running between the automated and human-review commands. If verified product behavior makes the final candidate unable to install, build, or serve, dependent browser and human-review phases SHALL NOT run, and the conclusive product-failure outcome rules SHALL apply instead.

#### Scenario: Automated evaluation follows the phase order
- **WHEN** every automated candidate-evaluation phase completes successfully
- **THEN** each phase begins only after its required predecessor has completed
- **AND** scored product judging begins only after complete candidate delivery and acceptance-handoff evidence are verified

#### Scenario: Human review finalizes later
- **WHEN** the separate human-review command completes a pending candidate review
- **THEN** it calculates the official result, writes the final report, attempts cleanup, updates the cleanup outcome, and then publishes the completed result

#### Scenario: Paired first benchmark
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
The evaluation harness SHALL generate and durably record its evaluation run identifier before starting Agent Runner. It SHALL separately record the Agent Runner run identifier, session directory, candidate branch, and candidate repository as soon as Agent Runner makes them available. It SHALL add the draft-PR identity and final pull-request head SHA as the complete workflow produces them. When an eval resumes, it SHALL verify the recorded evaluation run identifier, fixture commit, Agent Runner commit, Agent Skills commit and plugin-manifest hash, lead, implementor, and reviewer profiles, workflow arguments, candidate branch, candidate repository, draft PR, and known final head before taking action.

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

#### Scenario: Recorded run cannot be verified
- **WHEN** the harness cannot verify the recorded run, process, branch, pull request, or revision identity
- **THEN** it reports an explicit workflow or resume-provenance error
- **AND** it does not launch another Agent Runner run or silently select another candidate

### Requirement: Durable eval checkpointing
The harness SHALL maintain durable checkpoint state for every evaluation phase and for every finer work unit whose completion can be verified independently. Each checkpoint SHALL record its state, score-affecting input provenance, output artifact paths and hashes, and start and completion events.

Checkpoint provenance SHALL include the fixture repository and commit, Agent Runner commit and workflow hash, Agent Skills commit and plugin-manifest hash, workflow arguments, lead, implementor, and reviewer profiles, candidate branch, draft-PR identity, known final SHA, evaluator configuration, rubric provenance, and hashes of required acceptance evidence. On resume, the harness SHALL reuse the finest checkpoint it can deterministically prove complete. It SHALL resume after individual browser checks, screenshots, judge jobs, or human responses when each completed unit has durable matching evidence. When it cannot prove finer completion, it SHALL restart the enclosing phase from its beginning. A completed negative product finding SHALL remain a completed result and SHALL NOT be rerun merely because its verdict was fail.

The harness SHALL reject a checkpoint when any recorded identity or score-affecting input no longer matches the resumed run.

When a defect is confined to evaluator-owned phases after a candidate has completed the full implementation and acceptance workflow, the harness SHALL permit a fresh evaluator-only rescore from that completed run. It SHALL verify the source run, acceptance-artifact hashes, candidate branch, draft pull request, and final SHA; read the source run without modifying it; preserve candidate scoring applicability; and execute no Agent Runner workflow, candidate mutation, branch creation, push, or acceptance workflow.

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
- **WHEN** the recorded branch, PR, final SHA, acceptance-evidence hash, or another score-affecting input differs on resume
- **THEN** the harness refuses to reuse the stale checkpoint
- **AND** it reports which provenance changed

#### Scenario: Evaluator defect is corrected after candidate completion
- **WHEN** a completed candidate has trustworthy implementation and acceptance provenance but its evaluator-owned result is invalid
- **THEN** the harness can create a fresh candidate result by rerunning only evaluator-owned phases against the exact recorded final SHA
- **AND** it does not invoke Agent Runner, modify the candidate, create or push a branch, or repeat acceptance testing

### Requirement: Workflow execution provenance
The evaluation result SHALL record the evaluation run identifier; the distinct Agent Runner run identifier; the Agent Runner commit and clean-worktree result, CLI version, workflow path and SHA-256 hash; the Agent Skills commit, clean-worktree result, and plugin-manifest hash; the configured lead, implementor, and reviewer profiles; workflow arguments; task-level Validator choice; session directory; candidate repository and branch; draft-PR URL and base; final local and PR head SHA; every observed workflow step and outcome; final Validator result; candidate-reported CI status when present; acceptance attempt history; and hashes of required acceptance artifacts. It SHALL also record start, wait, resume, completion, and retry events without treating those events as product points.

#### Scenario: Fresh Agent Runner run is recorded
- **WHEN** the harness starts a new Agent Runner run
- **THEN** it records the run identity, workflow and Agent Skills provenance, all three workflow profiles, arguments, candidate branch, and subsequent observed step outcomes
- **AND** it adds PR, final-SHA, Validator, candidate-reported CI, and acceptance provenance as those values become available

#### Scenario: Agent Runner run is resumed
- **WHEN** the harness waits for or resumes an existing Agent Runner run
- **THEN** it appends the wait or resume event
- **AND** it preserves the original run, branch, PR, and start provenance

#### Scenario: Workflow provenance is incomplete
- **WHEN** the harness cannot determine the Agent Runner revision, workflow hash, Agent Skills revision and manifest hash, configured workflow profiles, arguments, candidate identity, executed-step history, final Validator result, or acceptance-artifact identity
- **THEN** it marks workflow provenance incomplete
- **AND** it does not present the run as reproducible or ready for scored judging

## REMOVED Requirements

### Requirement: Publishing-side-effect boundary
**Reason**: Replaced by branch-and-draft-PR delivery semantics; the old stop-point scenarios reference workflow steps this change eliminates.

## ADDED Requirements

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

### Requirement: Candidate delivery and publication boundary
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
