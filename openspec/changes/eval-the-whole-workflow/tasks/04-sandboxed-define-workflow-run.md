# Task: Run the define workflow in the sandbox from `run.sh`, with preflight, profiles, collection, and resume

## Goal

Make `evals/agent-runner/and-scene-define/run.sh` run Agent Runner's `openspec:change --until define` in the Agent Runner sandbox, from the materialized starting repository, while the host-side controller answers interactive turns through the external-user exchange. The run covers:
- validating the lead and crosscheck profiles and every preflight check before any model call;
- staging only the allowed sandbox input, and refusing any wider mount;
- enforcing one elapsed-time limit;
- classifying the workflow outcome from Agent Runner state;
- collecting the produced change directory with hashes;
- ingesting workflow metrics;
- checkpointing each phase, and resuming an interrupted Runner run without starting a duplicate.

This is the backbone every later phase plugs into: the audits, judging, results, and calibration.

## Background

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Process layout", "Run directory", "In-sandbox driver", "Elapsed-time limit and stopping", "Outcome of the workflow phase", "Collection, gates, and judging" (collection only), "Profiles, preflight, and identity", "Controller-to-sandbox interface", "Reused and-scene code", and Decisions 1–3, 6, 13, and 14;
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-006` and the resume assertions of `INT-008`;
- `/Users/paul/codagent/agent-runner/worktrees/external-user-mode/docs/external-user-mode.md`. It covers:
  - `--external-user <dir>` and `agent-runner --resume <run-id> --until define`;
  - the capped stop: `currentStep` is `define` with `completed: true`, while the run's `completed` stays false;
  - interruption semantics;
  - `run-metrics.json` listing every invocation's `cli` and `session_id`;
  - per-turn output files.

Existing pieces in the suite `evals/agent-runner/and-scene-define/`. Use them; if any is missing, stop and report which:
- `starting-repo/` and a materialization function producing a deterministic `starting-repo.bundle` (single commit, `main` and `add-presentation-skill`, no remote, `.validator/config.yml` with `base_branch: main`);
- `contamination-patterns.json` and a host-side canary-check function over staged directories, the Agent Skills checkout, and forwarded credential files;
- the inventory check, with a stale-or-unpinned function, plus `versions.json` and its hash checks;
- `hidden/starting-prompt.md` and the simulated-user responder loop (`lib/responder.mjs`). The loop takes the run directory, the exchange directory, a deadline, and an invoker, and writes `conversation.jsonl` and `phases/eval-owned-usage.jsonl`.

Agent Runner comes from `/Users/paul/codagent/agent-runner/worktrees/external-user-mode` until it merges. Its `scripts/sandbox-run.sh` supports these options, with exact spellings in its `--help`:
- `--dry-run`, `--input-dir` (mounted read-only at `/eval-input`), `--artifact-dir` (mounted at `/artifacts`);
- `--no-default-secrets`, `--mount-claude-auth`, `--mount-codex-auth`, `--mount-cursor-auth`;
- `--auth-only`: forward only credential files, never Claude `settings.json` or `settings.local.json`;
- `--hide-source`: run the command in a container without `/agent-runner-source` or `/tmp/agent-runner-local`.

If `--auth-only` or `--hide-source` is absent from that checkout, preflight must fail and name the missing option.

### Process and run-directory layout (from the design)

```
host: run.sh → controller.mjs (Node 22, no third-party dependencies)
  preflight · materialize · canary check · stage sandbox input
  responder loop → simulated user
  collection · ... later phases ...
      │ <run>/sandbox-input/ → /eval-input (read-only)
      │ <run>/sandbox/       → /artifacts  (read-write)
      ▼
sandbox: sandbox-run.sh --no-default-secrets --auth-only --hide-source
  sandbox-driver.sh → agent-runner run openspec:change --external-user /artifacts/exchange --until define

<run>/
  run-state.json, result.json
  conversation.jsonl, collected/, logs/, phases/eval-owned-usage.jsonl
  sandbox-input/   starting-repo.bundle, sandbox-driver.sh, bootstrap-agent-skills.sh,
                   prepare-agent-session-state.sh, runner-config.yaml, runner-settings.yaml
  sandbox/         exchange/, workspace/repo/, .runtime/, logs/
```

- **`sandbox-driver.sh`** is the only suite code that runs in the sandbox. It contains no pattern, reference text, or suite path. It:
  1. links session state (`~/.agent-runner/projects`, `~/.claude`, `~/.codex`, and, for a Cursor crosscheck, the Cursor chat store `~/.cursor/chats`) into `/artifacts/.runtime`, using `prepare-agent-session-state.sh` copied from `evals/agent-runner/and-scene/` (it already links all three CLIs' allowlisted state), with its symlink guards on every session-state path and its parent. Every evaluated invocation's native session must survive in `.runtime`, because the contamination audit requires a complete transcript for each one, Cursor crosschecks included;
  2. writes the Agent Runner config (an `eval` profile whose `lead` and `crosscheck` agents come from the run's profiles) and settings (`autonomous_permission_mode: yolo`);
  3. installs Agent Skills from the read-only checkout mount for the selected CLIs, adapting and-scene's `bootstrap-agent-skills.sh`;
  4. on a fresh run, clones `starting-repo.bundle` into `/artifacts/workspace/repo`, creates `main` and `add-presentation-skill` at the starting commit, and checks out `add-presentation-skill` with no remote;
  5. runs either `agent-runner run openspec:change --external-user /artifacts/exchange --until define` with change name `add-presentation-skill`, or `agent-runner --resume <run-id> --until define`;
  6. writes the exit status to `/artifacts/logs/runner-exit.json`.
- **`lib/sandbox.mjs`** is the only module that knows how the evaluated environment is provided. It exposes:
  - `stage(inputDir)`;
  - `start(profiles, mode)`;
  - `wait()`;
  - `stop()`;
  - an exchange-directory handle;
  - `retrieve(paths)`.

  Locally it wraps `sandbox-run.sh` with bind mounts. The controller runs the sandbox as a child process and runs the responder loop concurrently.
- **Profiles:** `run.sh` requires `--lead-cli/--lead-model/--lead-effort` and `--crosscheck-cli/--crosscheck-model/--crosscheck-effort`.
  - The lead CLI must be `claude` or `codex`.
  - The crosscheck CLI may be `claude`, `codex`, or `cursor`.
  - Credentials are mounted only for the selected evaluated CLIs.
  - The simulated-user and judge profiles are pinned in the suite and cannot be overridden.
  - Record configured profiles, and effective invocations from `run-metrics.json`.
- **Preflight** runs before any model call, and each failure stops with `evaluation-harness-failed`, naming the check:
  - The Agent Runner checkout:
    - is clean, with its commit recorded;
    - `agent-runner --help` lists `--external-user`;
    - `openspec:change` declares `create` and `define`;
    - `core:define-change` declares `proposal`, `specs`, `design`, `test-plan`, and `approach-review`. Read these from the Runner checkout's workflow files on the host.
  - The Agent Skills checkout is clean, and every required `codagent:*` skill is present.
  - Docker is available.
  - Auth exists for the evaluated CLIs, for host `claude` (simulated user), and for host `codex` (judges).
  - Every pinned hash matches.
  - The inventory is neither stale nor unpinned.
  - The run directory is unused unless resuming.
  - The mount set, taken from the dry-run docker command, is exactly `sandbox-input/`, `sandbox/`, the Agent Skills checkout, and the selected CLIs' credential files. No other host path is mounted; in particular, not the suite directory, `/agent-runner-source`, Claude settings files, or a separate host directory holding the Runner binary. With `--hide-source`, the Runner binary reaches the command container through a non-host-path mechanism (a named volume or derived image) or under the run's `sandbox/` directory. Check every container in the dry-run output, the build container included: the build container may mount the Runner source, but must mount no suite or hidden path.
  - No GitHub variable or credential helper is passed.
  - The canary check passes.

  Rubric checks (inventory-version match and calibrated threshold) are added with the rubric. Leave an explicit hook for them in preflight.
- **Series identity and candidate:** record both in `run-state.json` and `result.json`.
  - The series identity holds only evaluator and fixture inputs: starting-prompt version, starting-tree hash, reference and inventory versions, rubric version (when present), contamination-pattern version, simulated-user profile and policy versions, and judge profile.
  - The candidate holds the lead and crosscheck profiles, the Agent Runner commit, the `openspec:change` and `core:define-change` workflow file hashes, and the Agent Skills commit.
  - Resume requires the same series identity and the same candidate, profiles included, and names any mismatch.
- **Elapsed-time limit:** one whole-run limit, defaulting to 3 hours, configurable with `--time-limit`, and starting when the workflow phase starts.
  - Pass the deadline to the responder loop; it writes the abort when a request is pending.
  - If the limit is reached mid-turn, stop the sandbox child; `docker run` forwards the signal.
  - Either way the result is `definition-workflow-failed`, naming the last active step (from the last request or Agent Runner state) and the applied limit.
- **Workflow outcome:** after the sandbox exits, read Agent Runner `state.json` and `audit.log` from `sandbox/.runtime/`:
  - capped stop (success): `currentStep` is `define` with `completed: true`, and the run is not completed;
  - interrupted (resumable): `define` or an earlier step is incomplete, with no capped stop;
  - failed or aborted: `definition-workflow-failed`, with the audit error.

  Never call `--resume` for a run already stopped after `define`. Record each define step's outcome.
- **Collection:** copy `sandbox/workspace/repo/openspec/changes/add-presentation-skill/` to `<run>/collected/`, and record each file's SHA-256 and the repository HEAD. Every later phase reads `collected/` only.
- **Metrics:** ingest Agent Runner's `run-metrics.json`. Attribute time and cost per define step and per evaluated role, and keep its completeness and provenance without inventing totals. Simulated-user usage stays in `phases/eval-owned-usage.jsonl` and never enters workflow cost.
- **Lifecycle:** phases run in this order:
  1. preflight
  2. materialization
  3. define workflow
  4. artifact collection
  5. conversation reconciliation
  6. contamination audit
  7. disclosure audit
  8. gates and judging
  9. discovery
  10. metrics
  11. result and report
  12. publication

  A phase starts only after its predecessor completes. Build the phase list so that the phases this task does not implement can be registered later. Never run a phase before its registered predecessors. Until the intervening phases (reconciliation, both audits, gates and judging, discovery) are registered, a candidate run stops after artifact collection, with a result that says which phases are not yet implemented, without claiming `complete`. Build and unit-test the metrics ingester now, but register it to run only in its specified position, after discovery. Checkpoint every phase with its input provenance and output hashes.
- **Outcomes:** `evaluation_status` is exactly one of `complete`, `definition-workflow-failed`, `contaminated`, or `evaluation-harness-failed`. `definition_verdict` is exactly one of `pass`, `fail`, or `unavailable`. Workflow and harness failures always have `definition_verdict=unavailable`. A failed or incomplete run's `result.json` names the owning phase, the observed error, and whether it is resumable.
- **Modes in this task:** `--help`, `--dry-run`, `--run-agent`, `--resume`, and `--time-limit`.
  - `--help` documents every mode and option, including `--rescore-from` and `--calibrate`, which other work implements.
  - `--dry-run` prints the planned sandbox invocation, starting no Docker container and making no model call.
  - `--resume` reuses the exact run directory.
- **Reused code:** copy and adapt these into `and-scene-define/lib/`:
  - from `evals/agent-runner/and-scene/lib/`: `persistence.mjs`, `checkpoint.mjs`, `orchestrator.mjs`, `phases.mjs`, `runner-metrics.mjs`, `runner-state.mjs`, and `subprocess.mjs`;
  - rewritten for this lifecycle: `state-machine.mjs`, `outcomes.mjs`, and `profiles.mjs`.

  Do **not** copy `judge-invoker.mjs` or `judge-jobs.mjs` in this task. Do not modify the and-scene suite.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development.
- Tests in `test/*.test.mjs` run through `npm run check`. Add `bash -n` and `node --check` entries for every new script and module to `package.json`.
- Tests that need an Agent Runner checkout or Docker read the checkout path from `AGENT_RUNNER_DIR`, and skip visibly with the reason when it is unset.

## Spec

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

This task delivers `--help`, `--dry-run`, `--run-agent`, and `--resume`, including the "Dry run makes no external calls" scenario. Rescore and calibration behavior are outside this task, but `--help` documents them.

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

This task records the series identity and candidate and enforces them on resume. Comparison reports that pair or separate runs are outside this task.

### Requirement: Preflight
Before any model call, the harness SHALL verify a clean Agent Runner checkout that provides the external-user mode for interactive steps; a clean Agent Skills checkout containing every `codagent:*` skill named by the define workflow and the workflows it invokes; Docker; authentication for the selected evaluated CLIs and for the pinned simulated-user and judge CLIs; every pinned input matching its recorded hash; a rubric that records a calibrated pass threshold; and an unused run directory unless resuming. Any failed check SHALL stop the run with `evaluation_status=evaluation-harness-failed` and SHALL identify the check.

#### Scenario: Runner lacks external-user mode
- **WHEN** the configured Agent Runner checkout does not provide the external-user mode
- **THEN** preflight fails before any model call and identifies the missing Runner capability

#### Scenario: Rubric is not yet calibrated
- **WHEN** a candidate run starts and the pinned rubric records no calibrated pass threshold
- **THEN** preflight fails before any model call and states that calibration must set the threshold first

#### Scenario: Pinned input hash mismatch
- **WHEN** the starting snapshot, hidden reference, or inventory does not match its pinned hash
- **THEN** preflight fails before any model call and identifies the mismatched input

This task delivers every check except the two rubric checks, the calibrated threshold and the "Rubric is not yet calibrated" scenario, which come with the rubric. Leave a hook for them.

### Requirement: Starting environment
The evaluated agent SHALL start in a repository materialized from the suite's allowlisted starting snapshot. The repository SHALL contain exactly one commit, no remote, a `main` branch at that commit, and a feature branch at that commit checked out, and its tree SHALL match the pinned hash. The evaluated environment SHALL receive no GitHub credential. No candidate branch SHALL be pushed and no pull request SHALL be created.

#### Scenario: Starting repository exposes no other history
- **WHEN** the starting repository has been materialized for a run
- **THEN** its reachable history across all refs contains only the starting commit and it has no configured remote

#### Scenario: No GitHub credential is forwarded
- **WHEN** the evaluated sandbox starts
- **THEN** its environment contains no GitHub token or credential helper configured with a GitHub credential

This task delivers the sandbox side: the materialized repository is the only repository the agent works in, no GitHub credential or credential helper reaches the sandbox, and nothing is pushed.

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

This task delivers the ordered phase machinery, the phases through artifact collection, and the metrics ingester registered in its position after discovery, including "Judging waits for collection" as a phase-ordering guarantee. The audit, judging, result, and publication phases plug into it.

### Requirement: Evaluation status and definition verdict
The result SHALL report `evaluation_status` as exactly one of `complete`, `definition-workflow-failed`, `contaminated`, or `evaluation-harness-failed`, and `definition_verdict` as exactly one of `pass`, `fail`, or `unavailable`. A completed define workflow whose collected artifacts are missing a required artifact or fail `openspec validate` SHALL be `complete` with `definition_verdict=fail` through a hard gate, and any artifacts that exist SHALL still be judged as diagnostics. A contaminated run SHALL have `definition_verdict=unavailable` and no score. Workflow and harness failures SHALL have `definition_verdict=unavailable` and SHALL NOT be reported as a definition failure.

#### Scenario: Definition passes
- **WHEN** gates pass and the score meets the pass threshold
- **THEN** `evaluation_status` is `complete` and `definition_verdict` is `pass`

#### Scenario: Required artifact is missing
- **WHEN** the define workflow completes but the collected change lacks a design
- **THEN** `evaluation_status` is `complete` and `definition_verdict` is `fail` through the required-artifact gate
- **AND** the proposal, specifications, and test plan that exist are still judged and reported as diagnostics

#### Scenario: Run is contaminated
- **WHEN** the contamination audit finds access to hidden material
- **THEN** `evaluation_status` is `contaminated`, `definition_verdict` is `unavailable`, and no score is reported

#### Scenario: Workflow fails
- **WHEN** Agent Runner fails or the elapsed-time limit is reached before define completes
- **THEN** `evaluation_status` is `definition-workflow-failed` and `definition_verdict` is `unavailable`

This task delivers the "Workflow fails" scenario and the status and verdict vocabulary. Gate, score, and contamination outcomes plug into it.

### Requirement: Durable checkpoints and resume
The harness SHALL checkpoint every phase and every independently verifiable unit, including each judge job and each audit, with its input provenance and output hashes. On resume in the same run directory it SHALL verify the recorded run identity, series identity, and candidate, including the profiles; reuse every unit it can prove complete; resume an inactive unfinished Agent Runner run with `--resume <run-id>`; and SHALL NOT start a duplicate Agent Runner run. A provenance mismatch SHALL stop the resume with an explicit error.

#### Scenario: Resume after a judge failure
- **WHEN** a run stopped after some judge jobs completed
- **THEN** resume reruns only the unfinished judge jobs and reuses the completed ones

#### Scenario: Interrupted workflow resumes
- **WHEN** the recorded Agent Runner run is inactive and unfinished
- **THEN** the harness invokes `agent-runner --resume` with that run identifier and does not start another run

This task delivers phase checkpoints and the "Interrupted workflow resumes" scenario. Reuse of completed judge jobs follows from the same checkpoint mechanism once judging exists.

### Requirement: Workflow metrics and eval-owned usage
Workflow time and cost SHALL come from Agent Runner's `run-metrics.json`, attributed per define step and per evaluated role, retaining its completeness and provenance without inventing totals. Simulated-user and judge usage SHALL be recorded separately as eval-owned usage and SHALL NOT be counted as workflow cost.

#### Scenario: Metrics are incomplete
- **WHEN** `run-metrics.json` reports incomplete usage for a step
- **THEN** the result reports that step's cost as incomplete rather than estimating a total

#### Scenario: Simulated-user usage is separated
- **WHEN** a run completes
- **THEN** simulated-user and judge usage appear only as eval-owned usage and not in workflow cost

### Requirement: Hidden material is not mounted
The evaluated environment SHALL contain only the materialized starting repository and the runtime the evaluated workflow needs. The fixture change, the reference implementation, the hidden-reference inventory, the rubric, calibration inputs, the suite's data, and earlier results SHALL NOT be mounted into or readable from it.

#### Scenario: Suite data is absent from the sandbox
- **WHEN** the evaluated sandbox starts
- **THEN** none of the suite's hidden-reference, inventory, rubric, calibration, or result paths is present in its filesystem

### Requirement: Simulated-user boundary
The simulated user, the judges, and the suite's hidden data SHALL run and reside outside the evaluated environment, and the external-user exchange SHALL carry only the conversation. Preflight SHALL verify that the evaluated environment's mounts are exactly the staged sandbox input, the run's sandbox working directory, the Agent Skills checkout, and the selected CLIs' credential files, and SHALL fail with `evaluation_status=evaluation-harness-failed` when any other host path would be mounted. The simulated user and judges are eval-owned and SHALL NOT be subject to the contamination audit.

#### Scenario: Unexpected mount
- **WHEN** the planned sandbox invocation would mount a host path outside the allowed set, such as the suite directory or the Agent Runner source
- **THEN** preflight fails before any model call and identifies the path

## Test Plan

- `INT-006` (Sandbox mount plan against the real Runner script): `test/and-scene-define-sandbox-plan.test.mjs`, in `npm run check`. It is skipped, with the reason stated, when `AGENT_RUNNER_DIR` is unset.
  - Setup:
    - `AGENT_RUNNER_DIR` points at `/Users/paul/codagent/agent-runner/worktrees/external-user-mode`;
    - valid lead and crosscheck profiles;
    - a GitHub token is set in the host environment.
  - Action: run `run.sh --dry-run`, which invokes the real `scripts/sandbox-run.sh --dry-run`. Then run preflight against a deliberately widened mount plan.
  - Assert:
    - the planned mounts are exactly the staged input, the run's sandbox directory, the Agent Skills checkout, and the selected CLIs' credential files;
    - the suite directory, `/agent-runner-source`, the Claude settings files, and any separate host directory for the Runner binary are not mounted in the command container;
    - `--auth-only`, `--hide-source`, and `--no-default-secrets` are present;
    - no GitHub variable is passed;
    - the widened plan fails preflight, naming the extra path.
- `INT-008` (Resume, rescore, and publication), resume portion: `test/and-scene-define-lifecycle.test.mjs`, in `npm run check`.
  - Setup: a fake sandbox module (killed mid-workflow), and recorded `state.json` and `audit.log` for interrupted, capped-stop, and failed runs.
  - Assert:
    - resume invokes `--resume <run-id> --until define` and never starts a second Runner run;
    - a run already stopped after `define` is not resumed;
    - resume refuses a changed lead profile, and a changed Agent Skills commit, as candidate mismatches;
    - the failed state yields `definition-workflow-failed` naming the step;
    - an expired limit mid-turn stops the sandbox and yields `definition-workflow-failed` naming the last active step and the limit.

  Structure the file so that rescore, publication, and judge-unit-reuse cases can be added.
- Unit tests for profile validation (missing field; `cursor` as lead), preflight checks (missing Runner capability, missing workflow step, hash mismatch), metrics attribution with incomplete usage, and collection hashing.

## Done When

- `run.sh --help`, `--dry-run`, `--run-agent`, `--resume`, and `--time-limit` work as described.
- A dry run prints the full planned sandbox invocation without Docker or model calls.
- The controller, `lib/sandbox.mjs`, `sandbox-driver.sh`, and the copied and adapted modules exist under `evals/agent-runner/and-scene-define/`.
- Preflight enforces every check listed here before any model call, with named failures.
- A real `--run-agent` invocation is not required in this task: no paid runs. Its dry run must be correct, and the lifecycle tests must exercise it through the fake sandbox.
- `INT-006` and the resume portion of `INT-008` pass. `INT-006` runs locally with `AGENT_RUNNER_DIR` set, and skips visibly without it.
- `npm run check` passes, with the new scripts added to it.
