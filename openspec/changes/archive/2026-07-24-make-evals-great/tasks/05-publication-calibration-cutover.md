# Task: Publish, calibrate, and cut over

## Goal

Complete the operational cutover from legacy `reward.json` scoring to curated permanent results. Add retryable path-limited publication, gate the first full evaluation on autonomous known-good/degraded calibration, and update the suite runbook for the new automated and human commands.

## Background

Add publication support under `evals/agent-runner/and-scene/lib/` and expose an autonomous calibration mode through `evals/agent-runner/and-scene/run.sh` and the suite-local controller. Update `evals/agent-runner/and-scene/README.md`, `package.json` checks where new modules/scripts require syntax coverage, and integration tests under `test/`.

Publication runs only after human review has durably finalized a `complete` pass or product-fail result. It copies exactly the curated snapshot into `evals/agent-runner/and-scene/results/<run-id>/`, stages only that directory, commits with `chore: record and-scene eval <run-id>`, and pushes the current branch's configured upstream. It never force-pushes or stages runtime state, transcripts, raw logs, screenshots, raw pricing catalogs, credentials, or unrelated worktree changes. Commit and push checkpoints are independently retryable.

Calibration runs the known-good reference and suite-owned degraded mutations without invoking Agent Runner. It exercises the automated 70 points, all hard gates and four product judges, result/report generation, plus synthetic human-answer fixtures for validation, scoring, gates, resume, and rendering. Calibration artifacts remain ignored diagnostics and a failed calibration blocks the first full Runner evaluation.

After calibration, the supported rollout is: create a pending `reference-baseline`; run the first full candidate explicitly with `--skip-validator`; then leave both ready for the later paired literal-human review. Do not automate or fabricate human ratings, and do not publish pending or failed-infrastructure runs.

Use existing Git and Node tooling only. Implement publication tests against disposable repositories/remotes, make external side effects injectable, run targeted tests, and finish with `npm run check`.

## Spec

Source: `specs/evaluation-metrics-reporting/spec.md` (`Permanent result publication`)

### Requirement: Permanent result publication
After human review finalizes a run with `evaluation_status=complete` and product verdict `pass` or `fail`, the harness SHALL copy exactly `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`. From the agent-evals working directory, it SHALL stage and commit only that exact result directory with message `chore: record and-scene eval <run-id>` and SHALL run an ordinary `git push` on the current branch's configured upstream.

The harness SHALL NOT publish pending-human-review, implementation-workflow-failed, evaluation-harness-failed, or calibration runs. The permanent snapshot SHALL exclude runtime state, cloned repositories, dependency and build output, Agent Runner session state and transcripts, raw LLM output, full logs, screenshots, traces, raw pricing catalogs, credentials, and unrelated working-tree files. A commit or push failure SHALL preserve the completed product result, record a retryable publication checkpoint, and exit nonzero. Resume SHALL retry only the unfinished publication work, reuse an existing result commit, and SHALL NOT rerun evaluation or human review, create a duplicate commit, or force-push.

#### Scenario: Completed result is published permanently
- **WHEN** human review finalizes a run with `evaluation_status=complete` and product verdict `pass` or `fail`
- **THEN** the harness copies `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`
- **AND** from the agent-evals working directory it commits only that exact result directory with message `chore: record and-scene eval <run-id>` and runs `git push` on the current branch's configured upstream

#### Scenario: Incomplete result is not published
- **WHEN** a run is pending human review or has an implementation-workflow or evaluation-harness failure
- **THEN** the harness does not create or push a permanent result commit for that run

#### Scenario: Permanent snapshot excludes runtime data
- **WHEN** the harness prepares a permanent result directory
- **THEN** it excludes `.runtime`, cloned repositories, dependency and build output, Agent Runner session state and transcripts, raw LLM output, full logs, screenshots, traces, raw pricing catalogs, credentials, and unrelated working-tree files

#### Scenario: Publication fails after evaluation completes
- **WHEN** the path-limited commit or ordinary push fails for an otherwise completed pass or product-fail run
- **THEN** the completed product result remains unchanged, the publication checkpoint records the error, and the command exits nonzero
- **AND** resume retries publication without rerunning automated evaluation or human review

#### Scenario: Publication is retried after commit
- **WHEN** the result commit exists locally but its push did not complete
- **THEN** resume reuses that exact commit and retries the ordinary push without creating a duplicate result commit or force-pushing

## Done When

- A finalized complete pass or product-fail run produces exactly the six-file permanent snapshot, a path-limited commit with the approved message, and an ordinary upstream push.
- Pending, workflow-failed, harness-failed, and calibration runs never publish; unrelated dirty worktree files are never staged.
- Commit failure and post-commit push failure preserve the completed result and resume from the correct publication checkpoint without duplicate commits, rerunning evaluation/review, or force-pushing.
- Autonomous calibration proves the reference range and each approved degraded mutation's intended component or gate; failures block full Agent Runner execution and remain diagnostic/ignored.
- The launcher and runbook document the new automated, calibration, resume, `--skip-validator`, baseline, paired human-review, artifact, cleanup, and publication flows, replacing legacy workflow/rubric/reward guidance.
- Targeted unit/integration tests, disposable-repository publication tests, the full calibration command, and `npm run check` succeed.
- A pending reference baseline and first full `skip_validator=true` candidate can be produced without human input; final paired review remains explicitly human and is not fabricated by the implementation workflow.
