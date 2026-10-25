## ADDED Requirements

### Requirement: Suite entry point and modes
The end-to-end evaluation SHALL be run through `evals/agent-runner/and-scene-e2e/run.sh` from the repository root. It SHALL support a paid candidate run (`--run-agent`), a dry run that prints the planned delivery-repository provisioning and sandbox invocation without creating a repository, starting Docker, or making a model call (`--dry-run`), resumption in an existing run directory (`--resume`), an evaluator-only rescore of a previous run's retained evidence under the suite's current evaluator inputs (`--rescore-from <run-dir> --run-dir <new-dir>`), and a maintainer calibration diagnostic (`--calibrate`). Calibration SHALL NOT be a prerequisite or runtime gate for a candidate run. `--help` SHALL document every mode and option.

#### Scenario: Dry run makes no external changes
- **WHEN** the suite is invoked with `--dry-run` and valid candidate options
- **THEN** it prints the planned delivery-repository provisioning and sandbox invocation
- **AND** it creates no repository, starts no Docker container, and makes no model call
- **AND** its result reports `evaluation_status=dry-run`, not a failure

#### Scenario: Rescore does not run the workflow
- **WHEN** the suite is invoked with `--rescore-from` naming a run directory that holds retained evidence
- **THEN** it reruns audits, definition scoring, product evaluation, and the requirement trace from that evidence
- **AND** it does not launch Agent Runner, any evaluated agent, or any GitHub operation

#### Scenario: Rescore applies current evaluator inputs
- **WHEN** the product rubric version has changed since the original run and that run is rescored
- **THEN** the rescore uses the current rubric, records the current series identity as its own, and records the original run's series identity and candidate alongside it

### Requirement: Evaluated workflow selection
The evaluated workflow SHALL be selected with `--workflow <logical-ref>`, defaulting to `openspec:change`. Before Agent Runner starts, the harness SHALL verify that the resolved workflow declares top-level `create`, `define`, and `implement` steps, and that its define sub-workflow declares the `proposal`, `specs`, `design`, `test-plan`, and `approach-review` steps. It SHALL depend on no other step identifier, step order, nesting, or session name. The harness SHALL record the requested logical reference, the Runner-reported workflow name, and the hash of the definition Agent Runner resolves for it.

#### Scenario: Default workflow
- **WHEN** a candidate run omits `--workflow`
- **THEN** the run evaluates `openspec:change` and records its reference, reported name, and definition hash

#### Scenario: Workflow lacks an implement step
- **WHEN** the selected workflow declares no top-level `implement` step
- **THEN** the run fails with `evaluation_status=evaluation-harness-failed` before Agent Runner starts and identifies the missing step

### Requirement: Evaluated role profiles
A candidate run SHALL require an explicit profile, with a CLI adapter, a model, and an effort, for every agent role the selected workflow uses through its implement step; for `openspec:change` these are `lead`, `crosscheck`, `implementor`, and `tester`. The suite SHALL NOT supply default evaluated profiles. The `lead` CLI SHALL be `claude` or `codex`, the CLIs that Agent Runner's external-user mode supports. Because the contamination audit requires a complete transcript for every evaluated invocation, `cursor` SHALL be accepted only for `crosscheck`, the one role whose Cursor transcripts the audit reads. The harness SHALL validate every profile before any model call, SHALL report the configured and effective CLI, model, and effort for each role, and SHALL require identical profiles on resume. The simulated-user and judge profiles SHALL be pinned in the suite and SHALL NOT be overridable per run.

#### Scenario: Missing tester profile
- **WHEN** a candidate run of `openspec:change` omits the tester CLI, model, or effort
- **THEN** preflight fails before any model call and names the missing profile field

#### Scenario: Unsupported lead CLI
- **WHEN** a candidate run selects `cursor` as the lead CLI
- **THEN** preflight fails before any model call and states that the lead must use `claude` or `codex`

#### Scenario: Cursor outside crosscheck
- **WHEN** a candidate run selects `cursor` as the implementor or tester CLI
- **THEN** preflight fails before any model call and states that `cursor` is accepted only for `crosscheck`

#### Scenario: Profiles changed on resume
- **WHEN** a resume supplies any role profile different from the recorded run
- **THEN** the harness refuses to resume and reports the mismatched profile

### Requirement: Series identity and candidate
Each run SHALL record a series identity composed of its evaluator and fixture inputs: the starting-prompt version, starting-repository tree hash, hidden-reference and inventory version, simulated-user profile and policy versions, contamination-pattern version, definition rubric version, from-prompt product rubric version, human-review rubric version, and judge profiles. Each run SHALL separately record its candidate: the evaluated profiles, the Agent Runner commit, workflow reference and definition hash, the Agent Skills commit, and the Agent Validator reviewer configuration. Comparison reports SHALL pair runs only within one series identity, SHALL name every candidate component that differs between paired runs, and SHALL label runs from different series as not comparable.

#### Scenario: Pinned input changed between runs
- **WHEN** two runs differ in any series-identity component
- **THEN** comparison labels them as different series and does not present their scores as a paired comparison

#### Scenario: Only the workflow differs
- **WHEN** two runs share a series identity and differ only in the evaluated workflow
- **THEN** comparison pairs them and names the workflow reference and definition hash as the differing candidate component

### Requirement: Preflight
Before any model call or repository creation, the harness SHALL verify: clean Agent Runner and Agent Skills checkouts; that Agent Runner provides the external-user mode and `--until`; that Agent Skills contains every `codagent:*` skill the selected workflow names; Docker; authentication for every evaluated role CLI, for the CLI the starting tree's Agent Validator configuration uses for reviews, and for the pinned simulated-user and judge CLIs; the host credentials that provision delivery repositories, and that those credentials can reach no repository other than the suite's own delivery repositories; the host Chrome and `chrome-devtools-axi` that browser judging uses; every pinned input matching its recorded hash; and an unused run directory unless resuming. A run directory that holds only a launcher's own output (`factory-suite.log` and `.factory/`) SHALL count as unused. Any failed check SHALL stop the run with `evaluation_status=evaluation-harness-failed` and SHALL identify the check.

#### Scenario: Validator reviewer authentication is missing
- **WHEN** every evaluated role uses `codex` and no Claude authentication is available for the starting tree's Claude-based Validator reviews
- **THEN** preflight fails before any model call and identifies the missing Validator reviewer authentication

#### Scenario: Provisioning credentials are missing
- **WHEN** the host credentials that provision delivery repositories are unavailable or lack permission to create a repository
- **THEN** preflight fails before any repository is created or model is called and identifies the check

#### Scenario: Provisioning credentials reach another repository
- **WHEN** the provisioning credentials can reach a repository that is not one of the suite's delivery repositories
- **THEN** preflight fails before any repository is created or model is called and names that repository

### Requirement: Per-run delivery repository
Each new candidate run SHALL provision, from the host, a fresh private GitHub repository whose only content is the starting repository's single commit on `main`. Before any evaluated model call, the harness SHALL verify that the repository has exactly that content and no other branch, tag, pull request, or issue. The evaluated environment's local repository SHALL be the materialized starting repository with this repository as its only remote. The evaluated environment SHALL receive a GitHub token that can reach only that repository: a GitHub App installation token restricted to it, minted on the host and refreshed by the host before it expires for as long as the evaluated environment runs. A resumed run SHALL reuse the repository recorded for it, and a new run SHALL never reuse another run's repository. The harness SHALL NOT delete a delivery repository; it SHALL be retained and its identity recorded in the result.

#### Scenario: Remote holds only the starting commit
- **WHEN** a new run's delivery repository has been provisioned
- **THEN** its reachable history across all refs is the starting commit only and it has no pull request or issue

#### Scenario: Unexpected content in a new repository
- **WHEN** the provisioned repository holds any ref, pull request, or issue beyond the starting commit on `main`
- **THEN** the run fails with `evaluation_status=evaluation-harness-failed` before any evaluated model call and identifies the unexpected content

#### Scenario: Token cannot reach another repository
- **WHEN** the evaluated environment uses its GitHub token against any repository other than the run's delivery repository
- **THEN** GitHub denies the request

#### Scenario: Token outlives its first hour
- **WHEN** the implement step pushes more than an hour after its invocation started
- **THEN** the push uses a refreshed token and succeeds

#### Scenario: Resume reuses the run's repository
- **WHEN** an interrupted run is resumed
- **THEN** the harness uses the delivery repository recorded for that run and provisions no other

### Requirement: Workflow execution and stop points
The harness SHALL run the selected workflow in Agent Runner's sandbox with a pinned change name as one Agent Runner run in two capped invocations: first with `--until define`, then, only after the define checkpoint passes, by resuming the same Agent Runner run with `--until implement`. Every interactive turn during `define` SHALL be delivered to the simulated user through Agent Runner's external-user mode. The simulated user SHALL answer only during `define`; an external-user request after `define` completed SHALL end the run with `evaluation_status=evaluation-harness-failed`, naming the requesting step. Each workflow phase SHALL succeed only on Agent Runner's successful capped stop after its step; the run SHALL NOT require Agent Runner to report the whole workflow completed. No step after `implement`, including the top-level `accept` step, SHALL run.

#### Scenario: Interactive turns reach the simulated user
- **WHEN** a define step ends an agent turn without requesting step completion
- **THEN** the simulated user answers it and no terminal input is required

#### Scenario: Implementation waits for the define checkpoint
- **WHEN** Agent Runner stops after `define`
- **THEN** the implement step does not start until the define checkpoint has passed

#### Scenario: User request after define
- **WHEN** a step after `define` sends an external-user request
- **THEN** the run ends `evaluation-harness-failed`, names the requesting step, and the request is not answered

#### Scenario: Run stops before acceptance
- **WHEN** the `implement` step completes
- **THEN** Agent Runner stops with its capped-stop outcome and the `accept` step does not start

#### Scenario: Capped stop counts as success
- **WHEN** Agent Runner reports a successful capped stop after `implement` and its run is not marked completed
- **THEN** the harness treats the workflow phase as succeeded

### Requirement: Elapsed-time limit
The workflow phase SHALL be bounded by one configurable whole-run elapsed-time limit with a pinned default. The limit SHALL count only time during which an Agent Runner invocation is running, accumulated across resumes, and SHALL NOT count time between an interruption and its resume. Reaching the limit SHALL stop the workflow and end the run with `definition-workflow-failed` when `define` had not completed, or `implementation-workflow-failed` otherwise, naming the last active step and recording the applied limit.

#### Scenario: Limit reached during implementation
- **WHEN** the elapsed-time limit is reached after `define` completed and before `implement` completed
- **THEN** the harness stops the workflow and reports `implementation-workflow-failed`, naming the last active step and the applied limit

#### Scenario: Downtime before a resume
- **WHEN** a run stalls after ten hours of workflow time and is resumed the next day
- **THEN** the resumed invocation has the remaining two hours of the default limit

### Requirement: Stalled workflow
The harness SHALL stop an Agent Runner invocation that shows no activity in its run store, CLI transcripts, or worktree for a configurable stall window with a pinned default of 45 minutes, preserved across resume. A stalled stop SHALL end the run with `definition-workflow-failed` when `define` had not completed, or `implementation-workflow-failed` otherwise, naming the last active step and the applied window, and SHALL leave the run resumable.

#### Scenario: Implementation stalls
- **WHEN** no activity is observed for the stall window during the implement invocation
- **THEN** the harness stops the sandbox and reports `implementation-workflow-failed`, resumable, naming the last active step and the window

### Requirement: Quota limits in the evaluated environment
When an evaluated invocation hits an identified Claude usage-limit event with an explicit UTC reset within six hours, the harness SHALL wait for the reset and resume the run, under the same narrow recovery the `and-scene` suite applies, and SHALL NOT count the wait as a stall or toward the elapsed-time limit. Any other usage-limit or rate-limit failure SHALL be handled as an ordinary resumable workflow failure or stall.

#### Scenario: Claude limit with a near reset
- **WHEN** the implementor hits a Claude usage limit whose event states a UTC reset two hours away
- **THEN** the harness waits for the reset, resumes the run with `--until implement`, and records the wait

#### Scenario: Ambiguous rate limit
- **WHEN** an evaluated invocation fails with a 429 that states no reset time
- **THEN** the run ends with a resumable workflow failure naming the last active step

### Requirement: Definition collection
When Agent Runner stops after `define`, the harness SHALL copy the change directory from the worktree into the run directory and record the commit and a hash of every collected file. Definition scoring, the disclosure audit, and the requirement trace's defined part SHALL read only that collected copy. The evidence collected at the define checkpoint SHALL be retained as an immutable snapshot, and evidence collected after delivery SHALL be retained separately and SHALL NOT overwrite it. The harness SHALL NOT run Git on the host against the evaluated workspace, whose repository configuration the evaluated agents control.

#### Scenario: Definition edited during implementation
- **WHEN** an agent edits a specification during the implement step
- **THEN** definition scoring still uses the copy collected when `define` completed

#### Scenario: Evaluated workspace carries hostile Git configuration
- **WHEN** the evaluated workspace's repository configuration names a command to run on Git operations
- **THEN** collection completes without running that command on the host

### Requirement: Define checkpoint
After definition collection and before the implement step starts, the harness SHALL reconcile the simulated-user conversation, run the contamination audit over every evaluated invocation's retained transcript so far, and run the disclosure audit. A contamination match SHALL end the run `contaminated`. A disclosure audit that settles any `mandatory` or `acceptable-alternative` item as leaked SHALL end the run with `evaluation_status=evaluation-harness-failed`, owned by the disclosure audit, with no score and no publication, recording the leaked items and their citing exchanges; such a run SHALL NOT be resumable, and a retry SHALL be a new run. Inconsistent-withholding and contradiction flags SHALL be reported and SHALL NOT stop the run. Only a define checkpoint with no contamination match and no leaked item SHALL let the implement step start.

#### Scenario: Leak stops the run before implementation
- **WHEN** the disclosure audit settles an item as leaked at the define checkpoint
- **THEN** the run ends `evaluation-harness-failed`, names the leaked item and exchange, and the implement step never starts
- **AND** a resume of that run is refused and states that a new run is required

#### Scenario: Contamination during define
- **WHEN** the contamination audit at the define checkpoint finds a match
- **THEN** the run ends `contaminated` and the implement step never starts

#### Scenario: Clean checkpoint
- **WHEN** the define checkpoint finds no contamination match and no leaked item
- **THEN** the harness resumes the Agent Runner run with `--until implement`

### Requirement: Delivery verification
After a successful capped stop, the harness SHALL verify delivery from the run's delivery repository only, fetching it into a repository the harness creates, and SHALL NOT read the evaluated workspace's repository for this purpose. The required outcomes are: the candidate branch pushed to the delivery repository, an open draft pull request whose head equals the delivered commit, and the change left unarchived at that commit. It SHALL retain the delivered commit in the run directory as a Git bundle, and product evaluation, rescore, and human review SHALL use the retained bundle rather than GitHub. It SHALL also retain the implement step's acceptance evidence, recorded against the delivered commit, so that rescore needs neither GitHub nor the sandbox's runtime state. Marking the pull request ready, merging or closing it, deleting the branch, or archiving the change SHALL each mean a required outcome is missing: the run SHALL end `implementation-workflow-failed`, identifying the missing outcome, and the effect SHALL also be recorded as a prohibited effect. Any additional branch or pull request SHALL be reported and SHALL NOT change the status.

#### Scenario: Draft pull request is missing
- **WHEN** the capped stop succeeded but the delivery repository has no open draft pull request for the candidate branch
- **THEN** the run ends `implementation-workflow-failed` and identifies the missing pull request

#### Scenario: Pull request merged
- **WHEN** the capped stop succeeded and the candidate's pull request was merged
- **THEN** the run ends `implementation-workflow-failed`, records the merge as a prohibited effect, and is not published

#### Scenario: Extra branch
- **WHEN** the delivery repository holds an additional branch beside the candidate branch and the required outcomes are present
- **THEN** the result reports the extra branch and the run proceeds to scoring

#### Scenario: Rescore without GitHub
- **WHEN** a completed run is rescored after its delivery repository has become unreachable
- **THEN** product evaluation uses the retained bundle and the rescore proceeds

### Requirement: Ordered lifecycle
A candidate run SHALL execute phases in this order: preflight; delivery-repository provisioning; starting-environment materialization; workflow through `define`; definition collection; define checkpoint; workflow through `implement`; delivery verification and source retention; contamination audit over the implementation's transcripts; definition scoring; product evaluation (build, browser judging, other judging); requirement trace; metrics ingestion; result and report; human-review handoff; publication. A phase SHALL start only after its required predecessor completes. A contaminated run SHALL NOT proceed past the audit that found the match.

#### Scenario: Contaminated run is not scored
- **WHEN** the contamination audit over the implementation's transcripts invalidates a run
- **THEN** no scoring, trace, human-review, or publication phase runs for it

### Requirement: Evaluation status and scores
The result SHALL report `evaluation_status` as exactly one of `complete`, `pending-human-review`, `definition-workflow-failed`, `implementation-workflow-failed`, `contaminated`, `evaluation-harness-failed`, or, for a dry run only, `dry-run`. A run SHALL report a definition score and a product score, and SHALL report no pass/fail verdict. When `define` completed and a later workflow phase failed, the run SHALL still score the collected definition and report it in that run's result, and SHALL report no product score. A contaminated run SHALL have no score. A workflow or harness failure SHALL never be reported as a low score.

#### Scenario: Implementation fails after define
- **WHEN** `define` completed and the implement step fails
- **THEN** `evaluation_status` is `implementation-workflow-failed`, the definition score is reported, and no product score is reported

#### Scenario: Define fails
- **WHEN** Agent Runner fails before `define` completes
- **THEN** `evaluation_status` is `definition-workflow-failed` and no score is reported

### Requirement: Durable checkpoints and resume
The harness SHALL checkpoint every phase and every independently verifiable unit, including each judge job and audit, with its input provenance and output hashes. On resume in the same run directory it SHALL verify the recorded run identity, series identity, candidate other than its Agent Runner commit, profiles, and delivery repository; reuse every unit it can prove complete; resume an inactive unfinished Agent Runner run with its recorded run identifier and the `--until` of the workflow phase it was in, so that a run interrupted during `define` resumes with `--until define` and then passes through definition collection and the define checkpoint; and SHALL NOT start a duplicate Agent Runner run. A provenance mismatch SHALL stop the resume with an explicit error. A run that failed the define checkpoint for a leak SHALL NOT be resumed. A resume MAY run on a different Agent Runner commit, so a Runner fix can finish the run it failed; the run SHALL keep its starting commit as the candidate and record, in `result.json` and the report, every Agent Runner commit it used with the first unfinished phase each took over. A run that ended `contaminated` SHALL be resumable only under a newer contamination-pattern version than the one that produced the verdict; that resume SHALL rerun both contamination passes under the current patterns, continue only if they are clean, and record each pattern version the run was audited under.

#### Scenario: Interrupted workflow resumes
- **WHEN** the recorded Agent Runner run is inactive and unfinished after the define checkpoint passed
- **THEN** the harness resumes that run with `--until implement` and starts no other run

#### Scenario: Define interrupted
- **WHEN** the recorded Agent Runner run is inactive and unfinished before `define` completed
- **THEN** the harness resumes that run with `--until define`, then runs definition collection and the define checkpoint before any implement invocation

#### Scenario: Resume after a judge failure
- **WHEN** a run stopped after some judge jobs completed
- **THEN** resume reruns only the unfinished judge jobs and reuses the completed ones

#### Scenario: Contamination verdict superseded by corrected patterns
- **WHEN** a run that ended `contaminated` is resumed after the contamination patterns are corrected and their version bumped
- **THEN** the harness reruns both contamination passes under the new patterns and, if they are clean, continues to scoring without rerunning the workflow

#### Scenario: Contamination verdict under unchanged patterns
- **WHEN** a run that ended `contaminated` is resumed with the same contamination patterns
- **THEN** the harness refuses to resume

#### Scenario: Resume on a fixed Agent Runner
- **WHEN** a run whose implement phase failed is resumed with a different Agent Runner commit
- **THEN** the harness reuses the completed phases, resumes the recorded Agent Runner run with `--until implement`, and the result lists both commits, the new one from the implement phase

### Requirement: Workflow metrics and eval-owned usage
Workflow time and cost SHALL come from Agent Runner's `run-metrics.json`, covering the whole run through `implement`, attributed per top-level step and per evaluated role, and retaining its completeness and provenance without inventing totals. Simulated-user, judge, and audit usage SHALL be recorded separately as eval-owned usage and SHALL NOT be counted as workflow cost.

#### Scenario: Costs are attributed per stage
- **WHEN** a run completes the workflow phase
- **THEN** the result reports workflow cost and time for `define` and `implement` separately and in total, each with its completeness

#### Scenario: Simulated-user usage is separated
- **WHEN** a run completes
- **THEN** simulated-user and judge usage appear only as eval-owned usage

### Requirement: Result and report
Each run SHALL write `result.json` and a self-contained, offline `report.html` containing the evaluation status, definition score and product score with per-criterion verdicts and citations, gates, the requirement trace, the contamination- and disclosure-audit outcomes, the residual-risk statement, prohibited effects, the delivery repository identity, the series identity and candidate, provenance, workflow metrics, and eval-owned usage. A failed or incomplete run SHALL identify the owning phase, the observed error, and whether it can be resumed.

#### Scenario: Failed run explains itself
- **WHEN** a run ends with a workflow or harness failure
- **THEN** `result.json` identifies the failed phase, the observed error, and whether the run can be resumed

### Requirement: Permanent result publication
A candidate run SHALL be published once it reaches `evaluation_status=complete`, unless it was invoked with `--no-publish`, in which case neither the run nor its resume SHALL publish it. A `pending-human-review` run SHALL be published by the human-review command when the review completes, not before. To publish, the harness SHALL copy `result.json`, `report.html`, the collected definition, the simulated-user conversation, the requirement trace, and an artifact manifest into `evals/agent-runner/and-scene-e2e/results/<run-id>/`, commit only that directory with message `chore: record and-scene-e2e eval <run-id>`, and run an ordinary `git push` to the current branch's configured upstream. Contaminated, workflow-failed, harness-failed, rescore, and calibration runs SHALL NOT be published. The snapshot SHALL exclude runtime state, credentials, session state, raw judge output, and full logs. A commit or push failure SHALL preserve the result, record a retryable publication checkpoint, and exit nonzero; resume SHALL retry only publication, reuse an existing result commit, and SHALL NOT force-push.

#### Scenario: Implementation failure is not published
- **WHEN** a run ends `implementation-workflow-failed` with a definition score
- **THEN** no result commit is created for it

#### Scenario: Push fails
- **WHEN** the result commit succeeds but the push fails
- **THEN** the command exits nonzero and resume retries the push using the existing commit without force-pushing

### Requirement: Run comparison
The suite SHALL provide a comparison command that takes run directories, groups scored runs by series identity and candidate, and lists unscored runs with their status and owning phase. For each group it SHALL report the mean, standard deviation, and worst repetition of the definition score and the product score, and the mean requirement-trace counts. It SHALL compare two groups within one series identity only when each holds at least three scored repetitions, SHALL name their differing candidate components, and SHALL classify each score difference as same, leaning, or clear using the noise bands of `and-scene`'s experiment comparison. A group with fewer than three scored repetitions SHALL be labelled a screen and SHALL NOT be classified.

#### Scenario: Unscored run in a comparison
- **WHEN** a compared run ended `implementation-workflow-failed`
- **THEN** comparison lists it as unscored with its status and owning phase and excludes it from pairing

#### Scenario: Single run is a screen
- **WHEN** a candidate has one scored run in a series
- **THEN** comparison reports its scores labelled as a screen and classifies no difference against it
