# Task: Assemble results and reports, rescore from retained evidence, compare runs, and publish completed results

## Goal

Finish the `and-scene-define` lifecycle after scoring:
- assemble `result.json` and a self-contained `report.html` that explain every outcome;
- add `--rescore-from <run-dir>`, which reruns the audits, gates, judging, and discovery from retained evidence on the host under the suite's current evaluator inputs;
- add a comparison report that pairs runs only within one series identity;
- publish completed candidate results as a single commit and an ordinary push, with resumable publication;
- document the suite in its runbook and in the root `AGENTS.md`.

These are what make a run usable by a maintainer: reproducible, comparable, and kept as a separate results series from implementation evals.

## Background

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Run directory", "Profiles, preflight, and identity" (series identity and candidate), "Retained evidence and rescore", "Reused and-scene code", and Decision 14;
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-008`.

State of the suite `evals/agent-runner/and-scene-define/`. Use these; if one is missing, stop and report which:
- `run.sh`, `controller.mjs`, and the ordered phases with checkpoints:
  1. preflight
  2. materialization
  3. define workflow
  4. collection
  5. reconciliation
  6. contamination audit
  7. disclosure audit
  8. gates and judging
  9. discovery
  10. metrics
  11. result and report (to be completed here)
  12. publication (added here)
- `run-state.json`, which records the run identity, the **series identity**, and the **candidate**:
  - The series identity: starting-prompt version, starting-tree hash, reference and inventory versions, rubric version, contamination-pattern version, simulated-user profile and policy versions, and judge profile.
  - The candidate: lead and crosscheck profiles, Agent Runner commit, `openspec:change` and `core:define-change` workflow hashes, and Agent Skills commit.
- `<run>/evidence-manifest.json`, which lists every file a rescore needs, with hashes:
  - `collected/` and its hashes;
  - `conversation.jsonl`;
  - the Runner's `run-metrics.json`, `state.json`, `audit.log`, and `exchanges.jsonl`;
  - each native transcript;
  - the per-turn output copies.

  Everything listed is copied under `<run>/evidence/`.
- the outputs of earlier phases under `<run>/audits/`, `<run>/judges/`, and `<run>/discovery/`:
  - reconciliation, contamination matches, and the residual-risk statement;
  - disclosure flags and leaked items;
  - gates, component scores, per-criterion verdicts with citations, panel verdicts, disagreements, and rulings;
  - added scope;
  - the discovery ledger.
- `phases/eval-owned-usage.jsonl`, and the workflow metrics ingested from `run-metrics.json`.

`evals/agent-runner/and-scene/lib/publication.mjs`, `result.mjs`, `report.mjs`, and `rescore.mjs` are the patterns to follow:
- copy and adapt `publication.mjs`;
- rewrite `report.mjs` and result assembly for this lifecycle.

Do not modify the and-scene suite.

Required behavior:

- **`result.json` and `report.html`** contain:
  - `evaluation_status` and `definition_verdict`;
  - the total and component scores, every criterion's verdict with citations, panel verdicts, disagreements, and rulings;
  - gate results;
  - leaked items and the leaked count;
  - the discovery-ledger summary (count per outcome) and each item's outcome;
  - the contamination- and disclosure-audit outcomes with every flag and match;
  - the residual-risk statement, always, including on clean runs;
  - added scope;
  - the series identity and candidate, and provenance (hashes of collected files and pinned inputs);
  - the configured and effective profiles;
  - workflow metrics per define step and role, with completeness;
  - eval-owned usage, kept separate.

  A failed or incomplete run names the owning phase, the observed error, and whether it is resumable. `report.html` is self-contained, with no external assets.
- **Rescore (`--rescore-from <run-dir>`):**
  - Reads only the manifest's files, and refuses any file whose hash differs.
  - Runs entirely on the host, with no Docker and no Agent Runner.
  - Reruns reconciliation, the contamination audit, the disclosure audit, gates, judging, and discovery under the suite's **current** rubric, inventory, patterns, policies, and judge profile.
  - Writes to a new rescore output directory. Its result records the current series identity as its own, and the original run's series identity and candidate alongside.
  - With the same pattern version, it reproduces the original contamination outcome and matches.
  - Rescores are never published.
- **Comparison:**
  - Provide a command, for example `compare.mjs <run-dir>...` or a `run.sh --compare` mode; document whichever you choose in `--help`.
  - It pairs runs only within one series identity, lists each candidate component that differs, and labels runs from different series as not comparable.
  - It shows the leaked count alongside scores.
- **Publication:**
  - Applies only to a candidate run with `evaluation_status=complete` and `definition_verdict` `pass` or `fail`.
  - Copies `result.json`, `report.html`, the collected definition artifacts, `conversation.jsonl`, the discovery ledger, and an artifact manifest into `evals/agent-runner/and-scene-define/results/<run-id>/`.
  - Excludes runtime state, credentials, Agent Runner session state, raw judge output, and full logs.
  - Commits only that directory with the message `chore: record and-scene-define eval <run-id>`, then runs an ordinary `git push` to the current branch's configured upstream.
  - On a commit or push failure, it preserves the result, records a retryable publication checkpoint, and exits nonzero. Resume retries only publication, reusing an existing result commit, with no duplicate commit and no force-push.
  - Contaminated, failed, harness-failed, rescore, and calibration runs are never published.
- **Documentation:**
  - Write `evals/agent-runner/and-scene-define/README.md` as the suite runbook. It covers:
    - prerequisites, including the Agent Runner `external-user-mode` checkout and the `--auth-only` and `--hide-source` sandbox options;
    - every mode, with example invocations;
    - the run-directory layout;
    - outcomes;
    - resume and rescore;
    - publication;
    - the residual risk;
    - the policy-test diagnostic;
    - the rule that changing the starting prompt, inventory, rubric, patterns, policy, or judge profile starts a new series.
  - Add a short "Running the Agent Runner `and-scene-define` suite" section to the root `AGENTS.md`, pointing to the runbook, in the style of the existing `and-scene` section.
  - Add `evals/agent-runner/and-scene-define/results/**` to whatever excludes and-scene results from Validator reviews, if such a config exists in this repository.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development.
- Tests in `test/*.test.mjs` run through `npm run check`; add `node --check` entries for new modules.
- No paid model calls in this task: use stub judges and recorded runs.

## Spec

### Requirement: Result and report
Each run SHALL write `result.json` and a self-contained `report.html` containing the evaluation status and definition verdict, scores with per-criterion verdicts and citations, gate results, the discovery-ledger summary, the contamination- and disclosure-audit outcomes, the stated residual-contamination risk, the series identity and candidate, provenance, workflow metrics, and eval-owned usage. A failed or incomplete run SHALL identify the owning phase and whether it can be resumed.

#### Scenario: Failed run explains itself
- **WHEN** a run ends with `definition-workflow-failed` or `evaluation-harness-failed`
- **THEN** `result.json` identifies the failed phase, the observed error, and whether the run can be resumed

### Requirement: Permanent result publication
After a candidate run reaches `evaluation_status=complete` with `definition_verdict` `pass` or `fail`, the harness SHALL copy `result.json`, `report.html`, the collected definition artifacts, the simulated-user conversation, the discovery ledger, and an artifact manifest into `evals/agent-runner/and-scene-define/results/<run-id>/`, commit only that directory with message `chore: record and-scene-define eval <run-id>`, and run an ordinary `git push` on the current branch's configured upstream. Contaminated, failed, harness-failed, rescore, and calibration runs SHALL NOT be published. The snapshot SHALL exclude runtime state, credentials, Agent Runner session state, raw judge output, and full logs. A commit or push failure SHALL preserve the result, record a retryable publication checkpoint, and exit nonzero; resume SHALL retry only publication, reuse an existing result commit, and SHALL NOT create a duplicate commit or force-push.

#### Scenario: Completed run is published
- **WHEN** a candidate run completes with `definition_verdict` `pass` or `fail`
- **THEN** its result directory, including the definition artifacts and simulated-user conversation, is committed alone and pushed

#### Scenario: Contaminated run is not published
- **WHEN** a run ends with `evaluation_status=contaminated`
- **THEN** no result commit is created for it

#### Scenario: Push fails
- **WHEN** the result commit succeeds but the push fails
- **THEN** the command exits nonzero and resume retries the push using the existing commit without force-pushing

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

This task delivers `--rescore-from`, including the "Rescore does not run the workflow" and "Rescore applies current evaluator inputs" scenarios, and keeps `--help` complete.

### Requirement: Series identity
Each run SHALL record a series identity composed of the evaluator and fixture inputs: the starting-prompt version, starting-repository tree hash, hidden-reference and inventory version, rubric version, contamination-pattern version, simulated-user profile and policy versions, and judge profile. Each run SHALL separately record its candidate: the evaluated profiles, the Agent Runner commit with the `openspec:change` and `core:define-change` workflow hashes, and the Agent Skills commit. Comparison reports SHALL compare runs only within one series identity, SHALL name every candidate component that differs between the compared runs, and SHALL label runs from different series as not comparable.

#### Scenario: Pinned input changed between runs
- **WHEN** two runs differ in any series-identity component
- **THEN** reports label them as different series and do not present their scores as a paired comparison

#### Scenario: Candidate workflow or skills changed between runs
- **WHEN** two runs share a series identity and differ only in the Agent Skills commit
- **THEN** reports present them as a paired comparison and name the Agent Skills commit as the differing candidate component

This task delivers the comparison reports: "Pinned input changed between runs" and "Candidate workflow or skills changed between runs".

### Requirement: Non-scoring diagnostic
The discovery ledger SHALL NOT change any score, gate, or `definition_verdict`. The result and report SHALL show the count of each outcome and each item's outcome, the ledger SHALL be included in the published result, and `--rescore-from` SHALL rebuild it.

#### Scenario: Ledger does not affect the verdict
- **WHEN** two runs have identical coverage, fidelity, and quality verdicts but different discovery outcomes
- **THEN** they receive the same score and `definition_verdict`

This task delivers showing the ledger counts and per-item outcomes in the result and report, including the ledger in the published result, and rebuilding it during `--rescore-from`.

### Requirement: Residual-risk statement
Every result and report SHALL state that the evaluated sandbox has network access and the hidden reference is publicly reachable, so contamination is detected by audit rather than prevented, that the exchange and audit evidence are writable by the evaluated agent and checked by reconciliation rather than protected, and SHALL name an enforced outbound-network allowlist and a private fixture as open hardening options.

#### Scenario: Clean run states the risk
- **WHEN** a run completes with a clean contamination audit
- **THEN** its result and report still include the residual-risk statement

This task delivers rendering the statement in every `result.json` and `report.html`.

### Requirement: Contamination audit
After artifact collection, the harness SHALL scan every retained lead and crosscheck tool call, including shell commands, file reads, web fetches, and web searches, matching both the call's input and its output against the contamination patterns. Repository, URL, skill, plugin, and path patterns SHALL match every call's input and output. Because the simulated user legitimately discloses reference content, canary phrases SHALL be narrower: a canary phrase that occurs in any simulated-user reply in the run's conversation SHALL be excluded for that run, and the remaining canary phrases SHALL NOT be matched against content the agent writes through a file-writing or editing tool. The canary check and the audit SHALL be deterministic pattern matching, so the same evidence and pattern list always produce the same outcome. Any match SHALL make the run `contaminated`, with no score and no publication, and the result SHALL list every match with its session, tool call, and matched pattern. There SHALL be no option to override a match.

#### Scenario: Agent fetches the fixture repository
- **WHEN** a web fetch or shell command input names the fixture repository
- **THEN** the run is `contaminated` and the result lists that tool call and pattern

#### Scenario: Tool output carries hidden text
- **WHEN** a web search's query matches no pattern but its output contains a canary phrase
- **THEN** the run is `contaminated` and the result lists that tool call and phrase

#### Scenario: Disclosed phrase is written into an artifact
- **WHEN** the simulated user's reply contains a canary phrase and the agent writes that phrase into a specification
- **THEN** that phrase is not a contamination match for the run

#### Scenario: Undisclosed phrase arrives through a read
- **WHEN** a canary phrase that no simulated-user reply contained appears in a file the agent read or a web result it received
- **THEN** the run is `contaminated` and the result lists that tool call and phrase

#### Scenario: Transport is read through a relative path
- **WHEN** a shell command reads a reply file through a relative path such as `../../exchange/<file>.reply.json`
- **THEN** the run is `contaminated` and the result lists that tool call and pattern

#### Scenario: Rescore reproduces the audit
- **WHEN** a run is rescored from its collected evidence with the same pattern list
- **THEN** the contamination outcome and matches are identical to the original

This task delivers "Rescore reproduces the audit" through `--rescore-from`.

### Requirement: Workflow metrics and eval-owned usage
Workflow time and cost SHALL come from Agent Runner's `run-metrics.json`, attributed per define step and per evaluated role, retaining its completeness and provenance without inventing totals. Simulated-user and judge usage SHALL be recorded separately as eval-owned usage and SHALL NOT be counted as workflow cost.

#### Scenario: Metrics are incomplete
- **WHEN** `run-metrics.json` reports incomplete usage for a step
- **THEN** the result reports that step's cost as incomplete rather than estimating a total

#### Scenario: Simulated-user usage is separated
- **WHEN** a run completes
- **THEN** simulated-user and judge usage appear only as eval-owned usage and not in workflow cost

This task delivers reporting both in the result and report, kept separate.

## Test Plan

- `INT-008` (Resume, rescore, and publication), rescore, comparison, and publication portion: extend `test/and-scene-define-lifecycle.test.mjs`, in `npm run check`.
  - Setup:
    - a recorded complete run directory, with an evidence manifest and stub judge outputs;
    - a local bare Git remote, plus one configured to reject the push.
  - Assert:
    - completed judge and audit units are reused on resume;
    - `--rescore-from` reads only manifest files, runs with no Docker on `PATH`, and reproduces the contamination outcome;
    - rescoring after a rubric version bump uses the current rubric, records the current series identity, and records the original series identity and candidate alongside;
    - rescore refuses a file whose hash differs;
    - a comparison of two recorded runs that differ only in the Agent Skills commit is paired and names that component;
    - a comparison of two runs that differ in the rubric version labels them not comparable;
    - publication commits only `results/<run-id>/`;
    - after a rejected push, resume retries the push using the same commit, with no new commit and no force;
    - contaminated, failed, and rescore runs create no result commit.
- Unit tests:
  - result assembly for each `evaluation_status`;
  - the failed-run explanation (phase, error, resumable);
  - the residual-risk statement on a clean run;
  - the separation of eval-owned usage from workflow cost;
  - the report rendering without external assets.

## Done When

- Completed runs produce `result.json` and `report.html` with every field listed above, and failed runs explain themselves.
- `run.sh --rescore-from` works host-only against a recorded run.
- The comparison command exists and is documented in `--help`.
- Publication commits and pushes a completed candidate run's result directory alone, and retries safely on resume.
- `evals/agent-runner/and-scene-define/README.md` and the root `AGENTS.md` section exist.
- `INT-008` passes in full.
- `npm run check` passes, with the new modules added to it.
