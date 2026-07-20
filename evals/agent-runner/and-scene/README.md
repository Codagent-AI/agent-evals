# and-scene eval

This suite gives an implementation agent a reviewed OpenSpec change with no
implementation, runs the real Agent Runner workflow in a browser-capable Docker
sandbox, and grades the result.

Run commands from the `agent-evals` repository root. The entry point is
`evals/agent-runner/and-scene/run.sh`.

## Prerequisites

You need:

- an Agent Runner checkout, normally cloned next to this repository
- Docker with a running daemon
- network access to clone the fixture and install packages
- valid host authentication for the implementation agent and judge

Agent Runner owns the sandbox image, local-source build, authentication
forwarding, and devcontainer. This suite calls its `scripts/sandbox-run.sh`
adapter and mounts only this suite at `/eval-input`.

Each role profile selects its own CLI adapter, and eval-owned judging always
runs through Codex. The adapter mounts the host authentication matching the
selected adapters plus Codex.

The implementation agents use unrestricted permissions inside the container.
The container is the isolation boundary. Run trusted fixtures and pass only the
credentials the evaluation needs. For a private fixture, use a short-lived,
repository-scoped token with `--env GITHUB_TOKEN` or an env file.

## Run the suite

The supported order is: browser proof, calibration, reference baseline, full
candidate run, paired human review, publication.

First prove the sandbox can build the fixture, launch Chromium, and inspect the
reference app through `chrome-devtools-axi`:

```bash
evals/agent-runner/and-scene/run.sh --proof-browser
```

Then calibrate. A full `--run-agent` evaluation is blocked until calibration
passes, because a run that costs real model time should not be the thing that
discovers the harness scores the wrong component:

```bash
evals/agent-runner/and-scene/run.sh --calibrate
```

Run the evaluation. Both role profiles are required and each independently
selects a CLI adapter, model, and effort:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent \
  --skip-validator \
  --lead-cli claude --lead-model opus --lead-effort high \
  --implementor-cli claude --implementor-model sonnet --implementor-effort medium
```

`--skip-validator` passes `skip_validator=true` and stops Agent Runner after
`simplify`. Without it the eval passes `skip_validator=false` and stops after
`verify-validator`. Either way the run stops before any acceptance, PR, CI,
archive, or publishing step.

Continue an interrupted evaluation against the same run directory:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent --resume --artifact-dir artifacts/evals/and-scene/<run-id> \
  --skip-validator \
  --lead-cli claude --lead-model opus --lead-effort high \
  --implementor-cli claude --implementor-model sonnet --implementor-effort medium
```

Resume reuses the recorded Agent Runner run rather than starting a second one,
and rejects a changed role profile, Agent Runner revision, workflow hash, CLI
version, rubric hash, or any other score-affecting input.

Evaluate an existing candidate as a reference baseline without invoking Agent
Runner. Role profiles are neither required nor applicable:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent --reference-baseline \
  --candidate-ref 171c7def1e12aca2a5f605a5e5feafb20d4e4d19
```

Point at a different Agent Runner checkout, or inspect the sandbox invocation
without Docker or model calls:

```bash
evals/agent-runner/and-scene/run.sh --run-agent --agent-runner-dir /path/to/agent-runner ...
evals/agent-runner/and-scene/run.sh --run-agent --dry-run ...
```

Proof artifacts default to `artifacts/evals/and-scene-proof/<timestamp>/`. Run
directories default to `artifacts/evals/and-scene/<timestamp>/`. Calibration
artifacts default to `artifacts/evals/and-scene-calibration/<timestamp>/`. Use
`--artifact-dir PATH` for a stable location; its basename is the run identity.

## Calibration

Calibration is the rollout gate, not a score. It runs on the host and invokes no
sandbox, no Agent Runner, no browser, and no human.

It evaluates the known-good reference and a suite-owned set of degraded
mutations against the real rubric, judge-job, scoring, gate, result, and report
path. The mutations are applied to evaluator output rather than to a candidate
checkout: what is being calibrated is whether the harness attributes quality to
the right place, and mutating a checkout would test the demo instead while
costing a build and a browser for every case.

Calibration asserts that:

- the reference earns the full automated 70, opens all four hard gates, and
  reaches an official pass;
- each approved mutation degrades exactly the component or gate it targets and
  stays a product regression rather than becoming a harness failure — collateral
  damage to any other component or gate fails the case just as surely as a
  target that never moved;
- the four product judge jobs all run and none fails; and
- synthetic human answers exercise rating validation, the 30-point arithmetic,
  the human gates, resume at the first unanswered question, refusal of an edited
  saved review, and report rendering.

The case set is derived from the rubric, so a rubric edit cannot silently leave
a component or gate uncalibrated. Synthetic answers exist only to exercise those
paths; no human rating is ever fabricated for a real run.

`calibration.json` records every case, its target, its problems, and any
unintended regression, and `cases/<case-id>/` holds each case's diagnostic
`result.json` and `report.html`. All of it is ignored diagnostics. Every
calibration result carries `mode: calibration`, which publication refuses by
name, so no calibration artifact can become a permanent record.

The durable pass/fail record defaults to
`artifacts/evals/and-scene-calibration/latest.json` and is what `--run-agent`
consults. Override it with `--calibration-record PATH`. A missing or failed
record stops a full evaluation with exit 2 before any container starts. A
reference baseline invokes no Agent Runner and is exempt.

A record speaks only for the rubrics and harness that produced it. It carries
both rubrics' version and hash plus a fingerprint over the modules that decide
what a case scores, gates, and reports — the scorer, rubric loader, judge jobs,
human review, outcomes, result, report, and the calibration cases themselves.
Edit any of them and the record no longer matches: the gate refuses it and asks
for a recalibration rather than letting an old pass unblock an expensive run on
the new harness's behalf.

If calibration exposes a rubric defect rather than a harness defect, revise the
spec and rubric through review and calibrate again.

## First benchmark rollout

After calibration passes, the two runs the paired human review needs are
produced without any human input:

```bash
# 1. The pending reference baseline for the existing implementation.
evals/agent-runner/and-scene/run.sh \
  --run-agent --reference-baseline \
  --candidate-ref 171c7def1e12aca2a5f605a5e5feafb20d4e4d19 \
  --artifact-dir artifacts/evals/and-scene/reference-baseline

# 2. The first full candidate run.
evals/agent-runner/and-scene/run.sh \
  --run-agent --skip-validator \
  --artifact-dir artifacts/evals/and-scene/candidate-1 \
  --lead-cli claude --lead-model opus --lead-effort high \
  --implementor-cli claude --implementor-model sonnet --implementor-effort medium
```

Both stop at `pending-human-review`. The paired review that turns them into
official scores is explicitly human and is never performed by an implementation
workflow:

```bash
evals/agent-runner/and-scene/human-review.sh \
  --baseline-run-dir artifacts/evals/and-scene/reference-baseline \
  --run-dir artifacts/evals/and-scene/candidate-1
```

After publication, the regenerable dependency and build output under `.runtime/`
can be removed; keep the candidate Git tree and Agent Runner state for audit or
retry.

## What it evaluates

The suite measures implementation of the `create-and-scene` OpenSpec change.
Planning artifacts and tasks are already present, so the score does not measure
proposal, specification, or task generation.

The external fixture is pinned to commit
`c11595651dfb3941e39c703c483ed1a92d152a37` in
`https://github.com/Codagent-AI/and-scene.git`. The implemented reference commit
`171c7def1e12aca2a5f605a5e5feafb20d4e4d19` is the comparable reference baseline.
It is not a similarity target.

The suite runs Agent Runner's `workflows/openspec/implement-change2.yaml`
workflow, which is hard-coded for this change. The Agent Runner checkout must be
a clean Git worktree; the suite records whichever commit, workflow hash, and CLI
version it used rather than pinning a predetermined revision.

## Architecture

`run.sh` is a thin host entry point. It owns argument parsing, the host-side
clean-checkout and workflow-presence checks, container identity, and invocation
of Agent Runner's `scripts/sandbox-run.sh`.

`controller.mjs` owns the evaluation lifecycle inside the sandbox, backed by
focused modules under `lib/`:

| Module | Responsibility |
|---|---|
| `lib/persistence.mjs` | Atomic JSON writes and SHA-256 hashing |
| `lib/checkpoint.mjs` | Schema-versioned checkpoints, fingerprints, resume plans |
| `lib/subprocess.mjs` | Subprocess execution with active machine timing |
| `lib/provenance.mjs` | Clean-checkout, workflow-hash, and CLI-version provenance |
| `lib/profiles.mjs` | Role profile validation, eval-scoped config, effective-profile reconciliation |
| `lib/workflow.mjs` | Stop boundary, workflow contract, Agent Runner run classification |
| `lib/runner-state.mjs` | Reading Agent Runner run state by identifier or newest timestamp |
| `lib/outcomes.mjs` | Evaluation status and product verdict model |
| `lib/phases.mjs` | The ordered lifecycle and its failure ownership |
| `lib/human-review.mjs` | The 13 versioned questions, anchored responses, and the 30-point calculation |
| `lib/candidate-server.mjs` | Candidate-server identity, provenance-safe reuse, and cleanup |
| `lib/candidate-server-host.mjs` | Launching and probing the host candidate server |
| `lib/result.mjs` | Result assembly, the artifact manifest, and the durable artifact set |
| `lib/baseline.mjs` | Reference-baseline comparison and its rubric-match refusal |
| `lib/report.mjs` | The offline, escaped HTML report |
| `lib/publication.mjs` | The curated snapshot, path-limited commit, and retryable push |
| `lib/calibration.mjs` | Known-good/degraded calibration cases and their expectations |

`calibrate.mjs` is the third entry point. It runs the calibration on the host
and also owns the gate `run.sh` consults, so the rule that blocks an expensive
run is the same code that wrote the record.

`human-review.sh` is the second thin host entry point, for the literal human
review; `human-review.mjs` owns its lifecycle. It runs on the host rather than
in the sandbox: the reviewer needs the candidate URL in their own browser, and a
review that spans hours must outlive the container that produced the run.

Agent Runner owns the sandbox, workflow execution, run locks, sessions, its own
internal resume point, and `run-metrics.json`. None of that is copied here.

## Run directory layout

```text
artifacts/evals/and-scene/<run-id>/
├── checkpoint.json
├── result.json
├── report.html
├── artifact-manifest.json
├── human-review.json
├── ambiguity-ledger.json
├── publication.json
├── logs/
├── evidence/
├── phases/
└── .runtime/
    ├── candidate-worktree/
    │   └── .agent-runner/config.yaml
    └── agent-runner-projects/
```

`.runtime/` persists across disposable containers. Agent Runner layers built-in
defaults, the global config, then the project config it discovers at
`<cwd>/.agent-runner/config.yaml`, so the eval-scoped profile is written into
the candidate worktree and Agent Runner is invoked from there. Nothing outside
this run directory is read or modified. Credentials stay in the ephemeral
container home and are never written into the run directory.

## Lifecycle

The automated command runs these phases in order:

1. Run, wait for, or resume the recorded Agent Runner run through its boundary.
2. Install dependencies, build, and run non-browser verification.
3. Start the evaluated candidate server.
4. Run deterministic browser checks and capture evidence.
5. Run the four product judge jobs.
6. Run ambiguity diagnostics.
7. Ingest metrics and resolve pricing.
8. Write the `pending-human-review` result and HTML report.
9. Attempt candidate-server cleanup.
10. Update the pending artifacts with the cleanup outcome and exit successfully.

Phase 2 is registered as an explicit placeholder pending the browser build and
verification work; the ordering, checkpointing, and outcome contracts it runs
under are already enforced.

A phase that cannot produce its outputs stops its dependents rather than letting
them run on stale or fabricated inputs. Result writing and cleanup still run.

## Human review

The automated command never asks a human-review question and never issues an
official total or pass verdict. The literal review is a separate command:

```sh
evals/agent-runner/and-scene/human-review.sh --run-dir artifacts/evals/and-scene/<run>
```

It restores or restarts the exact candidate revision the automated rubric and
judges scored, prints its URL, and waits for an explicit non-scoring readiness
confirmation before question 1. It then asks the 13 versioned questions in
order, one at a time, each rated 1-5 against shared anchors, with a rationale
required for 3 or lower. Every accepted answer is saved immediately, so an
interrupted review resumes at the first unanswered question with the candidate
URL and readiness confirmation presented again. Nothing becomes official until
the reviewer explicitly confirms the full summary; before that the run stays
`pending-human-review`.

Once the reviewer confirms, the run is finalized and published; see
[Publication](#publication).

Pass `--baseline-run-dir` to review a pending reference baseline first. Each run
keeps its own candidate, rubric, response, score, and completion state, and the
candidate's result records baseline totals, component, subcomponent, and gate
deltas — only when both runs used identical rubric versions and hashes.

The human-review score is 30 points: 10 for the average of the nine per-step
ratings, 5 for readability and visual hierarchy, 4 for navigation and
interaction usability, 4 for responsive visual quality, and 7 for overall
cohesion and polish. Each rating `r` earns `(r - 1) / 4` of its points, summed
without intermediate rounding. The component gate passes only at 15 or more with
no individual rating of 1.

The review serves the candidate itself. `serve-candidate.mjs` is a dependency-free
static server for the build at `.runtime/candidate-worktree/dist`, bound to a
port the operating system chooses. It exposes one endpoint of its own,
`/.candidate-identity`, returning the candidate revision it was started for.
That token is what ties an endpoint to a candidate: an unrelated process on a
recycled port cannot produce it.

A candidate server is only reused, or stopped, when both its process and its
endpoint prove it is still that server for the evaluated candidate. A recycled
process identifier or an occupied port is never treated as proof: the unverified
process is left running and untouched, and a new server is started elsewhere.

## Publication

A normal automated run ends at `pending-human-review` and is never published.
Once the review finalizes a `complete` result with a `pass` or `fail` product
verdict, the review command copies exactly these six files into
`evals/agent-runner/and-scene/results/<run-id>/`:

```text
result.json  report.html  human-review.json
ambiguity-ledger.json  implementation.diff  artifact-manifest.json
```

`result.json`, `report.html`, `human-review.json`, and `artifact-manifest.json`
are required; the ledger and the diff are copied when the run produced them and
recorded as absent when it did not, so a completed verdict is never held back by
a missing diagnostic. Nothing outside that list is ever copied: `.runtime`,
cloned repositories, dependency and build output, Agent Runner session state and
transcripts, raw model output, logs, screenshots, traces, raw pricing catalogs,
and credentials all stay in the ignored run directory.

If the destination already holds anything that is not a curated artifact —
stale, accidental, or planted — publication stops before it copies or stages
anything, because copying over the curated names would leave that file in place
to be published beside them.

From the agent-evals working directory the command then stages and commits those
curated files with `chore: record and-scene eval <run-id>` and runs an ordinary
`git push` on the current branch's configured upstream. Staging and committing
name each file individually rather than the directory, so neither an unrelated
dirty working tree nor a stray file sharing the results directory can ride
along. There is no force flag anywhere in the publication path.

Pending, implementation-workflow-failed, evaluation-harness-failed, and
calibration runs are all refused by name and publish nothing.

Publication is delivery, not evaluation, and it is independently retryable. The
completed product result is already durable when it begins, so a commit or push
failure leaves that result untouched, records its stage in `publication.json`,
and exits nonzero. Re-running the review command against the finalized run asks
no question and reruns no evaluation: it resumes at the recorded stage, reuses an
existing result commit rather than creating a second one, and retries only the
unfinished push.

## Outcomes

`evaluation_status` is exactly one of `complete`, `pending-human-review`,
`implementation-workflow-failed`, or `evaluation-harness-failed`.
`product_verdict` is exactly one of `pass`, `fail`, or `unavailable`.

Execution status and product quality are independent. A failed workflow or
harness never becomes a product failure, and a durably recorded product verdict
survives a later harness failure — reported as `PASS — HARNESS FAILURE` or
`FAIL — HARNESS FAILURE`. Cleanup failure after a durably written pending
result is recorded diagnostically and still exits successfully.

`result.json` is the authoritative machine-readable outcome and `report.html`
renders the same current status, verdict, score availability, and failed or
pending phase. Report generation fails rather than publishing an outcome that
contradicts `result.json`.

`report.html` is self-contained and offline: no external asset, no script, every
untrusted value escaped, and artifact links relative to the run directory.
`artifact-manifest.json` is the durable inventory of deliberate run artifacts,
rebuilt on every write and always excluding `.runtime`.

## Scoring

The product score is 100 points: 25 for demo presentation technical quality, 25
for scene-kit correctness, 10 for presentation-skill correctness, 10 for
verification-tool correctness, and 30 for human review. Runner health, workflow
completion, evidence collection, judge execution, cost, timing, retries, and
evidence repair award and deduct no product points; they are recorded
diagnostically. Until a human review exists, a run reports its automated
subtotal out of 70 and no official total or pass verdict.

`automated-rubric.json` and `human-rubric.json` own criterion identifiers,
evaluator assignment, points, gates, and thresholds. Neither the judge nor the
human-review interface may change them, and every result records both rubrics'
version and SHA-256 hash. Each row's points divide equally among its criteria,
and intermediate values are never rounded.

Deterministic browser checks exercise the built, running demo: routing, the
canonical nine steps, evolving-scene structure, present/browse modes,
navigation, end boundaries, transition reliability, control semantics, focus,
and keyboard operability. Four sequential judge jobs — demo integration, scene
kit, presentation skill, and verification tooling — review delivered source.
Judges receive only their own rubric slice, get no screenshots, and do not judge
visual taste, which belongs to human review.

Four hard gates sit outside the point total: `verification-build-whole-app`,
`verification-sample-outline`, `verification-every-produced-step-renders`, and
`verification-clear-outcome`. A failed gate blocks an official pass without
erasing the numerical score. An official pass needs at least 70 overall, 15 of
25 for demo quality, 15 of 25 for scene-kit correctness, 15 of 30 for human
review, no individual human rating of 1, all four gates, and every required
phase complete.

Judges are given the bounded list of delivered source paths alongside the
deterministic source evidence. When no candidate source is available they are
not invoked at all, because a judge shown no source cannot support a verdict
about it.

Evidence that was never observed leaves its component or gate incomplete and the
verdict unavailable. It is never converted into product failures or rescaled
away. This covers a judge job that never returned usable output, a browser
evaluation that never ran, a build or verification result that was never
recorded, and a run where runtime failures could not be read back — an empty
failure list only proves clean rendering when the failure list was readable.

## Artifacts

- `result.json` for evaluation status, product verdict, score breakdown, rubric
  provenance, workflow provenance, configured and observed role details,
  boundaries, and recovery history
- `checkpoint.json` for phase and work-unit state, input fingerprints, and
  output hashes
- `phases/browser-evaluation.json`, `phases/product-judging.json`, and
  `phases/score.json` for the evidence each scored component rests on
- `automated-rubric.json` and `human-rubric.json` in the suite for the scoring
  policy every result cites by version and hash
- `agent-runner-capabilities.json` in the suite for the role capabilities that
  profile validation checks against
- `publication.json` for the publication stage, its result commit, which curated
  files were published, and any retryable error
- `results/<run-id>/` in the suite for the permanent published record of a
  finalized run

Supporting evidence is under `logs/`, `evidence/`, and `phases/`. The browser
proof writes `proof-metadata.json`, `tier1-result.txt`, and logs without running
an implementation agent or producing a score.

## Configuration

Run `evals/agent-runner/and-scene/run.sh --help` for every option. The
implementation workflow and its stop steps are hard-coded; there is no
`--workflow`, `--until`, or `--workflow-arg` override. Update
`agent-runner-capabilities.json` deliberately when the recorded Agent Runner
revision gains or drops an adapter, model, or effort.

## Troubleshooting

For browser-proof failures, start with `logs/axi-browser-proof.log`. The proof
must find `Presentations` in the AXI accessibility snapshot. Clone, build,
preview, and verification logs identify earlier failures.

For evaluation failures, start with `result.json`. It records
`evaluation_status`, the owning phase, the observed error, whether the phase can
be resumed, and the full transition history. `checkpoint.json` records which
phases and work units completed.

Preflight failures exit 2 before any workflow starts and name the exact cause: a
dirty Agent Runner checkout, a missing or non-conforming
`implement-change2.yaml`, an invalid role profile with its role and field, a
role-profile mismatch on resume, a resume-provenance change, or a stale
checkpoint identity.

For a blocked full evaluation, run `--calibrate` and read `calibration.json`.
Its `failures` name the case and the exact expectation that broke, and each
case's `problems` and `unintended_regressions` say whether the harness scored
the wrong component, opened the wrong gate, or turned a product regression into
a harness failure.

For publication failures, `publication.json` records the stage, the result
commit if one exists, and the git error. Re-run the review command against the
same run directory to retry only the unfinished work.

For implementation failures, `result.json` records the Agent Runner run
identifier, session directory, configured and observed stop boundaries, and
every observed step. A step observed beyond the configured boundary is reported
as a workflow-boundary failure with the unexpected step named.

## Maintenance

Update the fixture SHA deliberately when the implementation-ready snapshot
changes. Keep runs pinned to exact commits, and update
`agent-runner-capabilities.json` when the recorded Agent Runner revision changes
its supported adapters, models, or efforts. Recalibrate after any rubric,
scorer, gate, or reporting change: the record is what unblocks the next full
evaluation, and a stale one is worth nothing. Run targeted tests during
development and `npm run check` before trusting a change.

Published result directories are immutable historical records. Correct an
erroneous publication with a later revert commit rather than by rewriting
history.
