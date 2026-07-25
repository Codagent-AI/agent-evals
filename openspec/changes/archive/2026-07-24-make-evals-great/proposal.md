## Why

The current `and-scene` evaluation can award substantial credit for harness health even when the delivered product is poor, while omitting official human UI/UX judgment, implementation-agent cost and machine timing data, and actionable diagnosis of agent failures. With Agent Runner's `implement-change2` workflow and run-metrics contract now available, the suite can become a product-centered, reproducible evaluation before its first complete benchmark run.

## What Changes

- Redesign scoring so delivered product quality determines the result, while workflow health, build success, evidence completeness, and similar harness signals act as gates or diagnostic dimensions.
- Make literal human UI/UX review part of the official score through an initial v1 human-review rubric, a `pending-human-review` state, a separate interactive human-review command, and explicit candidate-server cleanup.
- Switch the suite to `implement-change2` from a clean, recorded Agent Runner revision, add the `skip_validator` option, stop before publishing side effects, and record the workflow arguments, boundary, and executed steps.
- Add reproducible usage, implementation-agent API-cost estimates, and machine timing by consuming Agent Runner's `run-metrics.json`, resolving missing implementation prices through recorded real-time lookups, preserving missingness, writing detailed JSON and HTML results, comparing the first full run with a scored reference baseline, and automatically committing and pushing curated records for finalized runs.
- Capture implementor assumptions, context gaps, and their observable handling from Agent Runner artifacts in a structured, non-scoring ambiguity ledger; use the evaluation judge to classify the evidence and propose reviewed fixture improvements without mutating benchmark inputs during a run.
- Allow the `implement-change2` lead agent and task implementors to use independently selected agent profiles within one end-to-end evaluation of the delivered product, and record the effective profile, model, session, cost, time, retries, and outcome for each role.
- Report whether an unsuccessful or incomplete result was caused by the delivered product, the implementation workflow, the evaluation harness, or an outstanding human review.
- Verify the revised scoring system against a known-good implementation and intentionally broken examples before completing one pinned `and-scene` run with `skip_validator=true`, recorded human review, and clean server shutdown.
- Keep cost report-only initially. Define the exact v1 human-review questions and rating anchors during specs/design, while deferring later rubric refinement, Agent Validator cost tracking, Validator-enabled reruns, repeated trials, and Harbor parity work beyond this change.

## Capabilities

### New Capabilities

- `product-quality-scoring`: Product-centered gates and scoring across the automated product rubric and recorded human-review score, including version and hash provenance for both rubrics.
- `human-review-workflow`: A versioned v1 human-review rubric with anchored questions, a separate resumable review command, candidate server handoff, pending review state, official score completion, and cleanup.
- `runner-workflow-execution`: Clean-revision `implement-change2` execution, `skip_validator` control, safe stop boundaries, publishing-side-effect protection, workflow provenance, and resumable eval phases.
- `evaluation-metrics-reporting`: Phase-level usage, report-only implementation-agent API cost, machine timing, explicit completeness, recorded real-time pricing lookup, durable JSON and HTML result artifacts, reference comparison, and automatic permanent-result publication.
- `ambiguity-evaluation`: Non-scoring capture and judge classification of ambiguity evidence and observable workflow handling, with reviewed feedback into future fixture versions.
- `agent-role-configuration`: Independent lead-agent and task-implementor profile selection and per-role provenance within a single end-to-end product evaluation.
- `evaluation-outcomes`: Result reporting that separately identifies delivered-product failures, implementation-workflow failures, evaluation-harness failures, and runs awaiting human review.

### Modified Capabilities

None. `openspec/specs/` contains no existing capability specifications.

## Impact

- Affects the `evals/agent-runner/and-scene/` runner, scorer, automated product rubric, evidence capture, evaluator scripts, artifacts, tests, and runbook.
- Depends on a clean, recorded Agent Runner revision that provides `implement-change2`, `skip_validator`, safe pre-publish stop steps, lead and implementor entry points, and `run-metrics.json`.
- Adds a versioned human-review rubric and recorded pricing inputs, records version and hash provenance for both the automated product rubric and human-review rubric, and adds `result.json`, a self-contained HTML score report, ambiguity-ledger, human-review, workflow-provenance, per-role provenance, reference-baseline comparison, and tracked finalized-result snapshots.
- Affects the pinned `and-scene` fixture only through reviewed, versioned updates; benchmark inputs remain immutable during each run.
- Does not add third-party runtime dependencies or move Agent Runner-owned infrastructure into this repository.
