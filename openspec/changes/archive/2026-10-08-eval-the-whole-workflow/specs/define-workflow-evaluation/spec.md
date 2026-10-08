## ADDED Requirements

### Requirement: Suite entry point and modes
The define-workflow evaluation SHALL be run through `evals/agent-runner/and-scene-define/run.sh` from the repository root. It SHALL support a paid candidate run (`--run-agent`), a dry run that prints the planned sandbox invocation without Docker or model calls (`--dry-run`), resumption in an existing run directory (`--resume`), an evaluator-only rescore of a previous run's collected artifacts and conversation under the suite's current evaluator inputs (`--rescore-from <run-dir>`), and a maintainer calibration diagnostic (`--calibrate`). Calibration SHALL NOT be a prerequisite or runtime gate for a candidate run. `--help` SHALL document every mode and option.

#### Scenario: Dry run makes no external calls
- **WHEN** the suite is invoked with `--dry-run` and valid candidate options
- **THEN** it prints the planned sandbox invocation
- **AND** it starts no Docker container and makes no model call

#### Scenario: Rescore does not run the workflow
- **WHEN** the suite is invoked with `--rescore-from` naming a run directory that contains collected artifacts and a simulated-user conversation
- **THEN** it reruns audits, gates, judging, and the discovery diagnostic from that collected evidence
- **AND** it does not launch Agent Runner or any evaluated agent

#### Scenario: Rescore applies current evaluator inputs
- **WHEN** the rubric version has changed since the original run and that run is rescored
- **THEN** the rescore uses the current rubric, records the current series identity as its own, and records the original run's series identity and candidate alongside it

### Requirement: Evaluated role profiles
A candidate run SHALL require exactly two evaluated profiles, `lead` and `crosscheck`, each independently selecting a CLI adapter, a model, and an effort. The `lead` CLI SHALL be `claude` or `codex`, the CLIs that Agent Runner's external-user mode supports for interactive steps; the `crosscheck` CLI SHALL be `claude`, `codex`, or `cursor`. The harness SHALL validate both profiles before any model call, SHALL record configured and effective invocations for each, and SHALL require the same profiles on resume. The simulated-user and judge profiles SHALL be pinned in the suite and SHALL NOT be overridable per run.

#### Scenario: Missing evaluated profile
- **WHEN** a candidate run omits the lead or crosscheck CLI, model, or effort
- **THEN** preflight fails before any model call and names the missing profile field

#### Scenario: Unsupported lead CLI
- **WHEN** a candidate run selects `cursor` as the lead CLI
- **THEN** preflight fails before any model call and states that the lead must use `claude` or `codex`

#### Scenario: Effective invocations are reported
- **WHEN** a candidate run completes the define workflow
- **THEN** the result reports the configured and effective CLI, model, and effort used for lead and crosscheck invocations

#### Scenario: Profiles changed on resume
- **WHEN** a resume supplies a lead or crosscheck profile different from the recorded run
- **THEN** the harness refuses to resume and reports the mismatched profile

### Requirement: Series identity
Each run SHALL record a series identity composed of the evaluator and fixture inputs: the starting-prompt version, starting-repository tree hash, hidden-reference and inventory version, rubric version, contamination-pattern version, simulated-user profile and policy versions, and judge profile. Each run SHALL separately record its candidate: the evaluated profiles, the Agent Runner commit with the `openspec:change` and `core:define-change` workflow hashes, and the Agent Skills commit. Comparison reports SHALL compare runs only within one series identity, SHALL name every candidate component that differs between the compared runs, and SHALL label runs from different series as not comparable.

#### Scenario: Pinned input changed between runs
- **WHEN** two runs differ in any series-identity component
- **THEN** reports label them as different series and do not present their scores as a paired comparison

#### Scenario: Candidate workflow or skills changed between runs
- **WHEN** two runs share a series identity and differ only in the Agent Skills commit
- **THEN** reports present them as a paired comparison and name the Agent Skills commit as the differing candidate component

### Requirement: Preflight
Before any model call, the harness SHALL verify a clean Agent Runner checkout that provides the external-user mode for interactive steps; a clean Agent Skills checkout containing every `codagent:*` skill named by the define workflow and the workflows it invokes; Docker; authentication for the selected evaluated CLIs and for the pinned simulated-user and judge CLIs; every pinned input matching its recorded hash; and an unused run directory unless resuming. A candidate run SHALL NOT require a pass threshold, because a definition receives a score only. Any failed check SHALL stop the run with `evaluation_status=evaluation-harness-failed` and SHALL identify the check.

#### Scenario: Runner lacks external-user mode
- **WHEN** the configured Agent Runner checkout does not provide the external-user mode
- **THEN** preflight fails before any model call and identifies the missing Runner capability

#### Scenario: Rubric sets a pass threshold
- **WHEN** a candidate run starts and the pinned rubric sets a pass threshold
- **THEN** preflight fails before any model call and states that the rubric must not set a pass threshold

#### Scenario: Pinned input hash mismatch
- **WHEN** the starting snapshot, hidden reference, or inventory does not match its pinned hash
- **THEN** preflight fails before any model call and identifies the mismatched input

### Requirement: Starting environment
The evaluated agent SHALL start in a repository materialized from the suite's allowlisted starting snapshot. The repository SHALL contain exactly one commit, no remote, a `main` branch at that commit, and a feature branch at that commit checked out, and its tree SHALL match the pinned hash. The evaluated environment SHALL receive no GitHub credential. No candidate branch SHALL be pushed and no pull request SHALL be created.

#### Scenario: Starting repository exposes no other history
- **WHEN** the starting repository has been materialized for a run
- **THEN** its reachable history across all refs contains only the starting commit and it has no configured remote

#### Scenario: No GitHub credential is forwarded
- **WHEN** the evaluated sandbox starts
- **THEN** its environment contains no GitHub token or credential helper configured with a GitHub credential

### Requirement: Define workflow execution
The harness SHALL run Agent Runner's `openspec:change` workflow with `--until define` and a pinned change name, with every interactive turn delivered to the simulated user through Agent Runner's external-user mode. Before starting, it SHALL verify that the workflow declares the top-level `create` and `define` steps and that the define sub-workflow declares the `proposal`, `specs`, `design`, `test-plan`, and `approach-review` steps; a missing step SHALL fail the run before Agent Runner starts. After execution, the harness SHALL record each define step's outcome.

#### Scenario: Workflow contract is incomplete
- **WHEN** the define sub-workflow lacks any of the required steps
- **THEN** the harness fails before starting Agent Runner and identifies the missing step

#### Scenario: Interactive turns reach the simulated user
- **WHEN** an interactive define step ends an agent turn without requesting step completion
- **THEN** the turn is answered by the simulated user and no terminal input is required

### Requirement: Elapsed-time limit
The workflow phase SHALL be bounded by a single configurable whole-run elapsed-time limit with a pinned default. Reaching the limit SHALL stop the workflow and produce `evaluation_status=definition-workflow-failed`, identifying the last active define step and recording the limit that applied.

#### Scenario: Agent never completes a step
- **WHEN** the define workflow is still running when the elapsed-time limit is reached
- **THEN** the harness stops the workflow and reports `definition-workflow-failed`
- **AND** the result names the last active step and the applied limit

### Requirement: Artifact collection
After the define workflow completes, the harness SHALL copy the change directory from the final worktree into the run directory and record the final commit and a hash of every collected file. Gates, judging, audits, and the discovery diagnostic SHALL read only the collected copy.

#### Scenario: Worktree changes after collection
- **WHEN** the worktree changes after artifact collection
- **THEN** scoring and diagnostics are unaffected and use the collected, hashed artifacts

### Requirement: Ordered lifecycle
A candidate run SHALL execute phases in this order: preflight; starting-environment materialization; define workflow; artifact collection; conversation reconciliation; contamination audit; disclosure audit; gates and judging; discovery diagnostic; metrics ingestion; result and report; publication. A phase SHALL start only after its required predecessor completes. A contaminated run SHALL NOT proceed to gates, judging, or publication.

#### Scenario: Contaminated run is not judged
- **WHEN** the contamination audit invalidates a run
- **THEN** no gate, judge, or publication phase runs for it

#### Scenario: Judging waits for collection
- **WHEN** the define workflow has completed but artifact collection has not
- **THEN** no judge job starts

### Requirement: Evaluation status and score
The result SHALL report `evaluation_status` as exactly one of `complete`, `definition-workflow-failed`, `contaminated`, or `evaluation-harness-failed`. A complete evaluation SHALL report the definition's score; there SHALL be no pass/fail verdict. A completed define workflow whose collected artifacts are missing a required artifact or fail `openspec validate` SHALL be `complete`, with the failed gate reported beside a score of the artifacts that exist. A contaminated run SHALL have no score. Workflow and harness failures SHALL have no score and SHALL NOT be reported as a definition result.

#### Scenario: Definition is scored
- **WHEN** the define workflow completes and judging finishes
- **THEN** `evaluation_status` is `complete` and the result reports the total score and its breakdown, with no pass/fail verdict

#### Scenario: Required artifact is missing
- **WHEN** the define workflow completes but the collected change lacks a design
- **THEN** `evaluation_status` is `complete` and the required-artifact gate is reported as failed
- **AND** the proposal, specifications, and test plan that exist are judged and scored

#### Scenario: Run is contaminated
- **WHEN** the contamination audit finds access to hidden material
- **THEN** `evaluation_status` is `contaminated` and no score is reported

#### Scenario: Workflow fails
- **WHEN** Agent Runner fails or the elapsed-time limit is reached before define completes
- **THEN** `evaluation_status` is `definition-workflow-failed` and no score is reported

### Requirement: Durable checkpoints and resume
The harness SHALL checkpoint every phase and every independently verifiable unit, including each judge job and each audit, with its input provenance and output hashes. On resume in the same run directory it SHALL verify the recorded run identity, series identity, and candidate, including the profiles; reuse every unit it can prove complete; resume an inactive unfinished Agent Runner run with `--resume <run-id>`; and SHALL NOT start a duplicate Agent Runner run. A provenance mismatch SHALL stop the resume with an explicit error.

#### Scenario: Resume after a judge failure
- **WHEN** a run stopped after some judge jobs completed
- **THEN** resume reruns only the unfinished judge jobs and reuses the completed ones

#### Scenario: Interrupted workflow resumes
- **WHEN** the recorded Agent Runner run is inactive and unfinished
- **THEN** the harness invokes `agent-runner --resume` with that run identifier and does not start another run

### Requirement: Workflow metrics and eval-owned usage
Workflow time and cost SHALL come from Agent Runner's `run-metrics.json`, attributed per define step and per evaluated role, retaining its completeness and provenance without inventing totals. Simulated-user and judge usage SHALL be recorded separately as eval-owned usage and SHALL NOT be counted as workflow cost.

#### Scenario: Metrics are incomplete
- **WHEN** `run-metrics.json` reports incomplete usage for a step
- **THEN** the result reports that step's cost as incomplete rather than estimating a total

#### Scenario: Simulated-user usage is separated
- **WHEN** a run completes
- **THEN** simulated-user and judge usage appear only as eval-owned usage and not in workflow cost

### Requirement: Result and report
Each run SHALL write `result.json` and a self-contained `report.html` containing the evaluation status, scores with per-criterion verdicts and citations, gate results, the discovery-ledger summary, the contamination- and disclosure-audit outcomes, the stated residual-contamination risk, the series identity and candidate, provenance, workflow metrics, and eval-owned usage. A failed or incomplete run SHALL identify the owning phase and whether it can be resumed.

#### Scenario: Failed run explains itself
- **WHEN** a run ends with `definition-workflow-failed` or `evaluation-harness-failed`
- **THEN** `result.json` identifies the failed phase, the observed error, and whether the run can be resumed

### Requirement: Permanent result publication
After a candidate run reaches `evaluation_status=complete` with a score, the harness SHALL copy `result.json`, `report.html`, the collected definition artifacts, the simulated-user conversation, the discovery ledger, and an artifact manifest into `evals/agent-runner/and-scene-define/results/<run-id>/`, commit only that directory with message `chore: record and-scene-define eval <run-id>`, and run an ordinary `git push` on the current branch's configured upstream. Contaminated, failed, harness-failed, rescore, and calibration runs SHALL NOT be published. The snapshot SHALL exclude runtime state, credentials, Agent Runner session state, raw judge output, and full logs. A commit or push failure SHALL preserve the result, record a retryable publication checkpoint, and exit nonzero; resume SHALL retry only publication, reuse an existing result commit, and SHALL NOT create a duplicate commit or force-push.

#### Scenario: Completed run is published
- **WHEN** a candidate run completes with a score
- **THEN** its result directory, including the definition artifacts and simulated-user conversation, is committed alone and pushed

#### Scenario: Contaminated run is not published
- **WHEN** a run ends with `evaluation_status=contaminated`
- **THEN** no result commit is created for it

#### Scenario: Push fails
- **WHEN** the result commit succeeds but the push fails
- **THEN** the command exits nonzero and resume retries the push using the existing commit without force-pushing
