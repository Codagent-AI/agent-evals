## Context

The `and-scene` suite is currently a one-shot proof-of-concept centered on a generated Bash program in `run.sh`. It invokes Agent Runner in its browser-capable sandbox, performs install/build/verification, captures screenshots, calls one broad Codex judge, calculates the legacy score, and writes ignored artifacts. The revised specifications add a product-centered 100-point rubric, four independently configured implementation and judging concerns, literal human review, durable resume, structured Agent Runner metrics, real-time pricing, ambiguity diagnostics, HTML reporting, and permanent result publication.

This is a cross-cutting suite change, but its ownership boundary remains narrow:

- The suite owns fixture pins, evaluation policy, orchestration, evidence, scoring, reporting, and results.
- Agent Runner owns its sandbox image and launcher, workflow execution, sessions, run state, and `run-metrics.json`.
- The evaluated `and-scene` repository remains immutable during a run except for the implementation produced by Agent Runner.
- No shared eval framework or third-party runtime dependency is introduced for this first suite.

The design follows Codagent's existing harness principles: sequencing stays outside agents, specifications and results are durable artifacts, and resumability is explicit state rather than inference from prose logs.

## Goals / Non-Goals

**Goals:**

- Keep the existing Agent Runner sandbox adapter while replacing the monolithic in-container Bash lifecycle with a testable suite-local controller.
- Make every automated phase and human-review response durably resumable from validated artifacts.
- Separate Agent Runner implementation failures, eval-harness failures, pending human review, and product pass/fail.
- Run four focused product judge jobs plus independent ambiguity and pricing jobs through one recorded judge authority.
- Produce an authoritative `result.json`, an offline `report.html`, and a comparable scored reference baseline.
- Automatically commit and push curated permanent records for every finalized pass or product-fail run.
- Calibrate the automated scoring system before the first full Agent Runner evaluation.

**Non-Goals:**

- Running the eval harness itself as an Agent Runner workflow.
- Isolated lead-agent or implementor-agent quality scores.
- Supporting arbitrary workflow variants beyond the current `implement-change2` contract.
- Pinning Agent Runner to a predetermined commit; the clean revision used is recorded instead.
- Pricing eval-owned judge, evidence-repair, or reporting work.
- Automatically replacing the literal human reviewer with an LLM.
- Publishing pending, workflow-failed, harness-failed, or automated calibration runs.
- Generalizing suite components into a repository-wide eval framework.

## Approach

### Components

`evals/agent-runner/and-scene/run.sh` remains the main host entry point. It owns argument parsing, host-side Agent Runner checkout checks, invocation of Agent Runner's existing `sandbox-run.sh`, and post-review Git publication. It does not own phase logic or score calculations.

A new suite-local Node controller owns the evaluation state machine. Supporting suite-local modules own:

- atomic JSON and checkpoint persistence;
- subprocess execution and active machine timing;
- candidate and provenance fingerprints;
- deterministic browser evaluation and evidence capture;
- judge manifests and strict result validation;
- Agent Runner metrics ingestion and price resolution;
- score and outcome calculation;
- human-review persistence and scoring; and
- escaped, self-contained HTML rendering.

`evals/agent-runner/and-scene/human-review.sh` is a separate thin host command into the same controller. It reopens a pending run, restores or starts the exact candidate server, asks the 13 rubric questions, finalizes the score and report, performs cleanup, and triggers publication. It may accept a reference baseline run alongside a new run so the reviewer can complete both reviews in one session.

Automated and human scoring policies live in distinct versioned JSON rubric files. The scorer, not the judge, owns criterion assignment, points, gates, thresholds, and final arithmetic.

### Durable run layout

Each invocation creates or reopens one run directory:

```text
artifacts/evals/and-scene/<run-id>/
├── checkpoint.json
├── result.json
├── report.html
├── human-review.json
├── ambiguity-ledger.json
├── implementation.diff
├── artifact-manifest.json
├── logs/
├── evidence/
├── phases/
└── .runtime/
    ├── candidate-worktree/
    └── agent-runner-projects/
```

The artifact root is already the sandbox's persistent host mount. The controller keeps the candidate Git worktree there and links only Agent Runner's project/run-state directory into the ephemeral container home. Codex, Claude, and Git credentials remain in the ephemeral home and are never copied into `.runtime`.

Every phase artifact is schema-versioned. A completed checkpoint records input fingerprints, output paths and SHA-256 hashes, start and completion events, attempt history, and machine duration. JSON is written to a same-directory temporary file and atomically renamed. Resume reuses the finest completed unit whose artifact and fingerprint still validate; otherwise it restarts the enclosing phase.

### Automated lifecycle

The main command executes:

1. Preflight the fixture, suite inputs, clean Agent Runner checkout, `implement-change2` workflow contract, stop boundary, role profiles, judge configuration, and persistent run directory.
2. Generate an evaluation-scoped Agent Runner config mapping the requested lead profile to `planner` and implementor profile to `implementor`.
3. Start, wait for, or resume the recorded Agent Runner run through `simplify` when `skip_validator=true`, or `verify-validator` otherwise.
4. Freeze the candidate identity from the fixture commit, produced commit, normalized implementation diff, and source manifest.
5. Install, build, and run non-browser verification.
6. Start the candidate server, run deterministic browser checks, and capture evidence. A single bounded evidence-repair job may edit only a temporary helper copy.
7. Run four sequential, schema-constrained product judge jobs: demo integration, scene kit, presentation skill, and verification tooling.
8. Run the independent non-scoring ambiguity judge.
9. Ingest Agent Runner schema-v1 metrics, aggregate attempts by role/provider/model, and resolve missing implementation prices through models.dev followed by conditional web-enabled pricing judge jobs.
10. Write `pending-human-review` `result.json` and `report.html`, attempt candidate-server cleanup, update both artifacts with the cleanup result, and exit successfully.

The eval harness is not an Agent Runner workflow. Agent Runner is the evaluated implementation orchestrator; placing eval control inside it would make Runner failures capable of suppressing their own diagnosis.

The host launcher assigns a stable container identity to the run. A concurrent resume verifies that identity and waits for the active sandbox. When no active sandbox remains, the controller examines its checkpoint and Agent Runner state. An inactive unfinished Agent Runner run is continued with `agent-runner --resume <run-id>`; an already completed run advances to the next eval phase.

### Judge isolation

All eval-owned LLM work uses one explicitly recorded Codex CLI and model, invoked directly with argument arrays and strict output schemas.

The four product jobs align with automated score components. Each receives only its assigned rubric slice, approved fixture specifications, relevant deterministic evidence, and read-only access to candidate source. Product judges do not receive screenshots and do not judge visual taste. The scorer rejects missing, duplicated, unknown, or cross-component criterion identifiers.

The ambiguity judge uses workflow artifacts and product evidence but produces no score or gate. Pricing judge jobs run only when models.dev cannot establish an exact usable rate and are explicitly web-enabled; their extracted rates remain labeled unverified. Evidence repair uses a writable temporary directory containing only the capture helper and a sanitized coverage summary.

Separate jobs were chosen over one large judge prompt because failures and retries remain component-local, prompts remain focused, and optional diagnostics cannot invalidate official product judging. Splitting every rubric subcomponent was rejected because it would repeat large amounts of source context and introduce unnecessary cross-call inconsistency.

### Human review and comparison

`human-review.sh <run-directory>` verifies the pending run's candidate and rubric fingerprints, starts or verifies its server, prints the URL, obtains an explicit readiness confirmation, and asks the 13 approved questions one at a time. Each valid answer is saved atomically. An interrupted invocation resumes at the first unanswered question. After confirmation, the controller calculates the human score, official score, gates, outcome, and final report, then cleans up the server.

For the first benchmark, autonomous calibration and implementation leave two pending runs: a `reference-baseline` for the existing implementation and an Agent Runner-produced candidate. Invoking human review with `--baseline <reference-run> <candidate-run>` completes the 13 reference questions first and the 13 candidate questions second. Both runs use the same product and human rubrics. The reference result reports Agent Runner roles, implementation cost, and implementation timing as not applicable rather than zero. The candidate report includes baseline identifiers and total, component, subcomponent, and gate deltas.

### Result assembly, reporting, and publication

`result.json` is assembled only from validated phase artifacts and remains the authoritative machine-readable result. `report.html` is a pure rendering of that JSON, escapes every untrusted value, embeds no candidate markup or external asset, and uses relative links for optional artifacts.

Normal automated runs stop successfully at `pending-human-review` and are not published. After `human-review.sh` finalizes a pass or product-fail result, it copies this curated snapshot into:

```text
evals/agent-runner/and-scene/results/<run-id>/
├── result.json
├── report.html
├── human-review.json
├── ambiguity-ledger.json
├── implementation.diff
└── artifact-manifest.json
```

The command then stages and commits only that exact result directory in the agent-evals working directory, using `chore: record and-scene eval <run-id>`, and runs `git push` on the current branch's configured upstream. It never force-pushes and never stages `.runtime`, raw transcripts, full logs, screenshots, traces, raw pricing catalogs, credentials, or unrelated working-tree files.

Publication is post-evaluation delivery. A commit or push error leaves the completed result intact, records a retryable publication checkpoint, exits nonzero, and is retried without rerunning evaluation or human review.

### Calibration

Before the first full Agent Runner evaluation, an autonomous calibration command evaluates the known-good reference and suite-owned degraded mutations without invoking Agent Runner. It exercises the automated 70 points, hard gates, all four product judges, result/report generation, and synthetic human-answer fixtures for question validation, scoring, gates, resume, and rendering.

Calibration asserts that the reference meets its expected automated range and that each degradation fails in its intended component or gate without becoming a harness failure. Calibration artifacts are diagnostic and ignored; they are not official or published results. A failed calibration blocks the first full Agent Runner run until the harness or reviewed rubric is corrected.

Literal visual judgment is not automated during calibration. The reference receives its comparable 100-point score only during the final paired human-review session after autonomous implementation work is complete.

## Decisions

### Keep Bash thin and move lifecycle state to Node

Node provides testable data structures, atomic artifact handling, strict validation, interactive input, and HTML rendering without adding a dependency. Bash remains appropriate for the existing host/sandbox boundary and exact Git commands.

Alternatives considered:

- Expanding the generated Bash program minimizes the initial refactor but makes checkpoint schemas, resume logic, interactive review, and reporting brittle.
- Replacing the host launcher and controlling Docker from Node duplicates Agent Runner's sandbox, authentication, and bootstrap responsibilities.

### Persist filesystem state, not a long-lived container

The ignored run directory keeps candidate and Agent Runner state inspectable and portable across disposable containers. A long-lived container is harder to recover, and opaque named volumes separate critical state from the run record.

### Separate automated execution from human finalization

Autonomous implementation tasks can complete the automated harness and leave durable pending results. A separate command lets the user perform literal review later without introducing human input between task agents or pretending a headless implementor can answer terminal questions.

### Publish from the current working tree

The harness uses a path-limited commit and ordinary `git push` in the branch from which it was launched. A temporary publication worktree or dedicated results branch adds machinery without protecting anything the exact pathspec does not already protect.

### Keep calibration outside official scoring requirements

Calibration is a rollout gate and implementation validation activity, not runtime product behavior. It is documented here and will be captured in tasks rather than turned into another score component.

## Risks / Trade-offs

- [Persistent runtime state consumes disk] → Exclude it from Git and manifests; after publication remove regenerable dependency/build output while retaining the candidate Git tree and Agent Runner state needed for audit or retry.
- [Checkpoint reuse can preserve stale work] → Hash every score-affecting input and validate both schema and output hashes before reuse; restart the enclosing phase when proof is insufficient.
- [LLM verdicts vary] → Use focused component prompts, one recorded model, strict criterion coverage, evidence citations, rubric hashes, and pre-run calibration.
- [Human ratings remain subjective] → Use fixed anchors, required rationales for ratings at or below three, exact question provenance, and a paired baseline/candidate review.
- [Candidate text can prompt-inject judges or reports] → Treat all candidate material as evidence, keep judge sandboxes read-only, validate schemas, and escape report content.
- [Pricing sources drift or remain incomplete] → Prefer Runner-reported cost, hash models.dev inputs, preserve raw rates and units, label fallback research unverified, and never convert missing cost to zero.
- [Automatic Git publication is an external side effect] → Publish only finalized pass/fail results, restrict commits to a unique generated path, never force-push, and make publication independently retryable.
- [Bash and Node can diverge at their interface] → Keep the interface narrow and cover launcher arguments, environment, artifact paths, exit states, and publication with integration tests.
- [A paired human review may be interrupted] → Save each answer immediately and resume the baseline or candidate at its first unanswered question.

## Migration Plan

1. Add failing unit tests for the new rubric math, outcomes, checkpoints, human review, metrics, pricing, reporting, and publication policy.
2. Extract the current scored lifecycle behind the Node controller while retaining the existing Agent Runner sandbox adapter and proof mode.
3. Replace the legacy rubric and `reward.json` path with versioned automated/human rubrics, four judge outputs, `result.json`, and `report.html`.
4. Add persistent candidate/Agent Runner state, phase checkpoints, safe server lifecycle, and resume integration tests.
5. Add the separate `human-review.sh` command, reference-baseline comparison, and path-limited commit/push.
6. Run targeted tests followed by `npm run check`.
7. Run autonomous known-good/degraded calibration. If calibration exposes a rubric defect, revise the spec/rubric through review and repeat.
8. Produce the pending reference baseline and first full `skip_validator=true` Agent Runner result.
9. Complete the paired human review, verify the comparison and cleanup, and confirm both permanent result records were pushed.

Rollback is a normal Git revert of the harness implementation. Published result directories are immutable historical records; an erroneous publication is corrected with a later revert commit rather than history rewriting.

## Open Questions

None. Exact module filenames and internal JSON field organization may be adjusted during implementation without changing the approved component boundaries or artifact contracts.
