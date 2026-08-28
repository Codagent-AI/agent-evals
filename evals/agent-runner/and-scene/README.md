# and-scene eval

This suite gives an implementation agent a reviewed OpenSpec change with no
implementation, runs the real Agent Runner workflow in a browser-capable Docker
sandbox, and grades the result.

Run commands from the `agent-evals` repository root. The entry point is
`evals/agent-runner/and-scene/run.sh`.

## Prerequisites

You need:

- an Agent Runner checkout, normally cloned next to this repository
- a clean Agent Skills checkout, normally cloned next to this repository
- Docker with a running daemon
- network access to clone the fixture and install packages
- valid host authentication for the implementation agent and judge
- repository-scoped GitHub credentials that can push the candidate branch and
  manage its draft pull request

Agent Runner owns the sandbox image, local-source build, authentication
forwarding, and devcontainer. This suite calls its `scripts/sandbox-run.sh`
adapter and mounts only this suite at `/eval-input`.

Each lead, implementor, and acceptance-reviewer profile selects its own CLI
adapter, and eval-owned judging always runs through Codex. The adapter mounts
the host authentication matching the selected adapters plus Codex. Before
starting Agent Runner, the suite verifies the workflow's named Codagent skills
against the pinned Agent Skills checkout and installs that local plugin for
each selected CLI.

The profile names remain stable at the CLI boundary, but map to the workflow's
`lead`, `implementor`, and `tester` agents respectively; acceptance work runs
through the `acceptance-tester` named session.

The implementation agents use unrestricted permissions inside the container.
The container is the isolation boundary. Run trusted fixtures and pass only the
credentials the evaluation needs. Use a short-lived, repository-scoped token
with `--env GITHUB_TOKEN` or an env file for candidate delivery.

## Run the suite

The supported order is: browser proof, calibration, reference baseline, full
candidate run, paired human review, publication.

First prove the sandbox can build the fixture, launch Chromium, and inspect the
reference app through `chrome-devtools-axi`:

```bash
evals/agent-runner/and-scene/run.sh --proof-browser
```

The browser-evaluator cutover regression uses the implemented reference at the
exact pinned revision and the product repository's own install, build, and
preview commands. In one terminal:

```bash
git clone https://github.com/Codagent-AI/and-scene.git /tmp/and-scene-reference
git -C /tmp/and-scene-reference checkout --detach 171c7def1e12aca2a5f605a5e5feafb20d4e4d19
npm --prefix /tmp/and-scene-reference ci
npm --prefix /tmp/and-scene-reference run build
(
  cd /tmp/and-scene-reference
  npm exec vite -- preview --host 127.0.0.1 --port 4173 --strictPort
)
```

Then run the suite-owned AXI regression from this repository:

```bash
node evals/agent-runner/and-scene/lib/reference-browser-regression.mjs \
  --url http://127.0.0.1:4173/ \
  --revision 171c7def1e12aca2a5f605a5e5feafb20d4e4d19 \
  --output /tmp/and-scene-reference-browser.json
```

It fails unless every route, outline, caption, canonical-content, and
evolving-scene criterion passes from explicitly established browse mode. The
normal deterministic run also establishes present or browse mode and starting
position independently for every navigation, reliability, and accessibility
probe. Opening records the product's initial mode before any state change.

Then calibrate. A full `--run-agent` evaluation is blocked until calibration
passes, because a run that costs real model time should not be the thing that
discovers the harness scores the wrong component:

```bash
evals/agent-runner/and-scene/run.sh --calibrate
```

Run the evaluation. All three role profiles are required and each independently
selects a CLI adapter, model, and effort:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent \
  --skip-validator \
  --lead-cli claude --lead-model opus --lead-effort high \
  --implementor-cli claude --implementor-model sonnet --implementor-effort medium \
  --reviewer-cli claude --reviewer-model opus --reviewer-effort high
```

`--skip-validator` passes `skip_validator=true` only to task-level compliance.
Without it, task-level compliance also runs. Both paths complete the final
Validator, draft-PR, acceptance-preparation, and handoff-verification steps.
The first complete benchmark candidate explicitly uses `--skip-validator`.
The harness never queries CI and never permits merge, ready-for-review, close,
archive, release, or candidate-branch deletion behavior.

Continue an interrupted evaluation against the same run directory:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent --resume --artifact-dir artifacts/evals/and-scene/<run-id> \
  --skip-validator \
  --lead-cli claude --lead-model opus --lead-effort high \
  --implementor-cli claude --implementor-model sonnet --implementor-effort medium \
  --reviewer-cli claude --reviewer-model opus --reviewer-effort high
```

Resume reuses the recorded Agent Runner run rather than starting a second one.
It verifies live process ownership before waiting, resumes only the exact
inactive unfinished run, and rejects a changed fixture, role profile, Runner
revision, workflow hash, Agent Skills revision or manifest, branch, draft PR,
final SHA, rubric hash, evidence identity, or other score-affecting input.

If implementation and acceptance completed but an evaluator-owned defect
invalidated the result, create a fresh evaluator-only record from that completed
run:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent \
  --rescore-from artifacts/evals/and-scene/<completed-run-id> \
  --artifact-dir artifacts/evals/and-scene/<rescore-run-id>
```

The source is mounted read-only. The harness verifies its workflow, evidence,
branch, draft PR, and final SHA, then runs only evaluator-owned phases. It does
not invoke Agent Runner, repeat acceptance, create or push a branch, or modify
the candidate.

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
evals/agent-runner/and-scene/run.sh --run-agent --agent-skills-dir /path/to/agent-skills ...
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

- the reference earns all 62 applicable automated points and opens all four
  hard gates without receiving a candidate pass/fail verdict, while the
  candidate-control case earns the full automated 70 and reaches an official
  pass;
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
  --implementor-cli claude --implementor-model sonnet --implementor-effort medium \
  --reviewer-cli claude --reviewer-model opus --reviewer-effort high
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
The score does not measure proposal, specification, test-plan, or task
generation. Before creating the candidate branch or invoking Agent Runner, the
suite therefore verifies that the selected fixture contains the complete
structured planning contract: non-empty proposal, design, specifications,
test plan, task index, and linked task files; the required test-plan sections;
and at least one fully defined `AT-*` obligation represented in the coverage
map. An incompatible fixture exits as `fixture-planning-contract`, with no
agent call.

The external fixture is pinned to commit
`892dfbcf3762bc95cdbae6f05b18cc2b168a5fab` in
`https://github.com/Codagent-AI/and-scene.git`. The implemented reference commit
`171c7def1e12aca2a5f605a5e5feafb20d4e4d19` is the comparable reference baseline.
It is not a similarity target. The fixture includes the reviewed structured test
plan merged by `Codagent-AI/and-scene#11`; advance it only to another reviewed
planning-only fixture revision.

The suite runs Agent Runner's exact
`workflows/core/implement-change-v1.0.yaml` workflow through completion, invoked
as `core:implement-change` with the OpenSpec artifact parameters supplied by the suite.
There is no early `--until` boundary. `--skip-validator` sets only the
workflow's task-level `skip_validator` parameter; the final Validator, draft
pull request, acceptance preparation, and handoff verification always remain
required. The Agent Runner checkout must be a clean Git worktree; the suite
records whichever commit, workflow hash, and CLI version it used. The Agent
Skills checkout must also be clean; the suite records its commit and plugin
manifest hash.

## Architecture

`run.sh` is a thin host entry point. It owns argument parsing, the host-side
clean-checkout and workflow-presence checks, container identity, and invocation
of Agent Runner's `scripts/sandbox-run.sh`.

`controller.mjs` owns the evaluation lifecycle inside the sandbox, backed by
focused modules under `lib/`:

| Module | Responsibility |
|---|---|
| `lib/persistence.mjs` | Atomic JSON writes and SHA-256 hashing |
| `lib/state-machine.mjs` | Versioned run-state schema and typed lifecycle reducer |
| `lib/orchestrator.mjs` | Dependency-aware, hash-verified fine-grained resume plans |
| `lib/checkpoint.mjs` | Run-state persistence and work-unit artifact verification |
| `lib/subprocess.mjs` | Subprocess execution with active machine timing |
| `lib/provenance.mjs` | Agent Runner and Agent Skills clean-checkout, revision, workflow, manifest, and CLI-version provenance |
| `lib/profiles.mjs` | Role profile validation, eval-scoped config, effective-profile reconciliation |
| `lib/workflow.mjs` | Full-workflow contract, prohibited-side-effect checks, Runner run classification |
| `lib/evidence.mjs` | Role-based candidate intake, byte integrity, lineage, evaluator evidence, contradictions, and bounded judge views |
| `lib/neutral-source.mjs` | Byte-exact final-commit source under neutralized paths plus approved identity-free requirement bundles |
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

## Evidence ownership and aliases

Candidate acceptance material is untrusted input. After the local and draft-PR
heads are verified, the suite anchors discovery on the final handoff, copies
the original bytes under `evidence/candidate/`, and records hashes, origins,
claimed revisions, coverage, limitations, and lineage. Independent checks and
captures are written under `evidence/evaluator/`; they may disprove candidate
claims but never count as candidate testing proof. The harness preserves
candidate-reported CI text and its claimed revision verbatim and does not query
CI.

The required semantic roles and accepted filenames are:

| Role | Accepted aliases |
|---|---|
| Acceptance flow record | `acceptance-flow-evidence.md`, `acceptance-test-results.md`, `acceptance-flow.md`, `acceptance-evidence.md`, `flow-evidence.md` |
| Screenshots | `.png`, `.jpg`, `.jpeg`, or `.webp` files referenced by the handoff or found in the recorded acceptance output |
| Screenshot metadata | `capture-metadata.json`, `screenshot-metadata.json`, `screenshot-manifest.json`, `capture-manifest.json` |
| Findings and retest history | `findings-history.md`, `retest-history.md`, `acceptance-findings.md`, `findings.md`, `acceptance-retest.md` |
| Final handoff | `acceptance-handoff.md`, `final-acceptance-handoff.md`, `acceptance-final-handoff.md`, `final-handoff.md` |
| Assumptions ledger | `acceptance-assumptions.md`, `assumptions-ledger.md`, `acceptance-assumption-ledger.md`, `assumptions.md` |

Referenced session reports and assumption/context-gap audits are retained when
present. Missing required roles stop scored judging as an implementation
workflow failure. Present but stale, malformed, weakly traceable, or
wrong-revision content remains judgeable and is recorded as an evidence defect.

Product-source judges run from `neutral/judge/`, which contains only a
byte-exact final-commit source snapshot under neutralized paths and
identity-free approved requirements. The source snapshot excludes only exact
harness-owned paths (`.agent-runner/` and the original OpenSpec change
directory), so product modules with generic names such as `evidence` or
`acceptance` remain reviewable. The provenance manifest is stored outside that
judge root. Testing-evidence and assumption-handling jobs use separate bounded
views under `evidence/judge-views/`.

## Run directory layout

```text
artifacts/evals/and-scene/<run-id>/
├── run-state.json
├── result.json
├── report.html
├── artifact-manifest.json
├── human-review.json
├── ambiguity-ledger.json
├── implementation.diff
├── candidate-source-manifest.json
├── publication.json
├── logs/
├── evidence/
│   ├── candidate/
│   ├── evaluator/
│   └── judge-views/
├── neutral/
│   ├── judge/
│   └── provenance/
├── phases/
└── .runtime/
    ├── candidate-worktree/
    │   └── .agent-runner/config.yaml
    └── agent-runner-projects/
```

`.runtime/` persists across disposable containers. Agent Runner layers built-in
defaults, the global config, then the project config it discovers at
`<cwd>/.agent-runner/config.yaml`, so the eval-scoped profile is written into
the candidate worktree and Agent Runner is invoked from there. A fresh candidate
creates `eval/and-scene/<run-id>` exactly at the pinned fixture before Runner
starts; any local or remote branch collision is refused. Resumes require that
exact repository, worktree, branch, Runner run, workflow revision, draft PR,
final SHA, and evidence identity. Credentials stay in the ephemeral container
home and are never written into the run directory.

Candidate runs require GitHub credentials capable of pushing the recorded
branch and creating or updating its draft pull request. The branch and draft PR
are retained after success and failure for diagnosis and manual cleanup. The
harness never merges, marks ready, closes, archives, releases, or deletes these
resources automatically.

## Lifecycle

The automated command runs these phases in order:

1. Preflight the fixture, unique candidate branch, Runner checkout and workflow,
   Agent Skills checkout and required skills, publishing credentials, profiles,
   evaluator inputs, and run directory.
2. Start, wait for, resume, or continue the one recorded complete Runner run.
3. Verify the clean delivered branch, remote head, and open draft PR whose base
   exactly matches the recorded `origin/HEAD`, plus its head, final Validator,
   unarchived change, and acceptance handoff.
4. Freeze the verified final source revision.
5. Install dependencies, build, and run non-browser verification.
6. Start the evaluated candidate server.
7. Run deterministic browser checks and capture evaluator evidence.
8. Run product judging, then the separate ambiguity diagnostic.
9. Ingest metrics and resolve pricing.
10. Write the `pending-human-review` result and HTML report.
11. Attempt candidate-server cleanup, update the pending artifacts, and exit.

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
Once the review finalizes a scored Agent Runner candidate with a `complete`
result, a `pass` or `fail` product verdict, and completed human review, the
review command copies exactly these six files into
`evals/agent-runner/and-scene/results/<run-id>/`:

```text
result.json  report.html  human-review.json
ambiguity-ledger.json  implementation.diff  artifact-manifest.json
```

All six files are required; publication stops before committing if any is
missing, so the permanent record is never a partial snapshot. Nothing outside
that list is ever copied: `.runtime`,
cloned repositories, dependency and build output, Agent Runner session state and
transcripts, raw model output, logs, screenshots, traces, raw pricing catalogs,
and credentials all stay in the ignored run directory.

Nothing may survive the copy that the copy does not replace. If the destination
holds an entry this snapshot will not overwrite — an uncurated file that was
never part of any snapshot, or a curated artifact left by an earlier publication
under the same run id that this run does not produce — publication stops before
it copies or stages anything, because that entry would otherwise remain and the
permanent record would describe two different runs. A destination whose every
entry is being rewritten is an ordinary resume and proceeds.

From the agent-evals working directory the command then stages and commits those
curated files with `chore: record and-scene eval <run-id>` and runs an ordinary
`git push` on the current branch's configured upstream. Staging and committing
name each file individually rather than the directory, so neither an unrelated
dirty working tree nor a stray file sharing the results directory can ride
along. There is no force flag anywhere in the publication path.

Pending, implementation-workflow-failed, evaluation-harness-failed, reference,
calibration, conclusive unscored product-fail, and incomplete-human-review runs
are refused and publish nothing.

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
`product_verdict` is exactly one of `pass`, `fail`, `unavailable`, or
`not-applicable`. A pending reference remains `unavailable`; only a completed
reference score uses `not-applicable` and the `REFERENCE — COMPLETE` headline.

Execution status and product quality are independent. A failed workflow or
harness never becomes a product failure, and a durably recorded product verdict
survives a later harness failure — reported as `PASS — HARNESS FAILURE` or
`FAIL — HARNESS FAILURE`. A completed reference likewise retains its score as
`REFERENCE — COMPLETE — HARNESS FAILURE`. Cleanup failure after a durably
written pending result is recorded diagnostically and still exits successfully.

`result.json` is the authoritative machine-readable outcome and `report.html`
renders the same current status, verdict, score availability, and failed or
pending phase. Report generation fails rather than publishing an outcome that
contradicts `result.json`.

`report.html` is self-contained and offline: no external asset, no script, every
untrusted value escaped, and only retained, confined run-directory artifacts
rendered as relative links. Pending, partial, and conclusive unscored outcomes
omit `official_score` rather than representing its absence as zero or `null`.
`artifact-manifest.json` is the durable inventory of deliberate run artifacts,
rebuilt on every write, carrying the same outcome projection, and always
excluding `.runtime`.

## Scoring

The candidate score is 100 points: 24 for demo presentation technical quality,
24 for scene-kit correctness, 7 for presentation-skill correctness, 7 for
verification-tool correctness, 4 for testing-evidence quality, 4 for
assumption-handling quality, and 30 for human review. A reference applies only
the four shared automated components and human review, for an unscaled
denominator of 92. Runner health, workflow
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
and keyboard operability. Each probe is stored in
`evidence/evaluator/browser-probes/` as an evaluator-owned, revision-bound
work unit with input/output hashes, required mode and position, initial and
settled state, runtime failures, and its pass or fail result. Matching negative
findings are reusable after interruption just like matching passes. Evaluator
screenshots carry the same ownership, revision, mode, position, settle, and
hash metadata. Focused component judge jobs review delivered source and
candidate-produced evidence.
Judges receive only their own rubric slice, get no screenshots, and do not judge
visual taste, which belongs to human review.

Four hard gates sit outside the point total: `verification-build-whole-app`,
`verification-sample-outline`, `verification-every-produced-step-renders`, and
`verification-clear-outcome`. A failed gate blocks an official pass without
erasing the numerical score. An official pass needs at least 70 overall, 15 of
24 for demo quality, 15 of 24 for scene-kit correctness, 15 of 30 for human
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
  provenance, workflow and Agent Skills provenance, configured and observed
  role details, delivery identity, and recovery history
- `run-state.json` as the sole atomic state authority for immutable input
  hashes, evolving branch/Runner/PR/final-SHA identity, typed events and failure
  ownership, phase and work-unit dependency hashes, output hashes, outcome, and
  resume eligibility
- `phases/browser-evaluation.json`, `phases/product-judging.json`, and
  `phases/score.json` for the evidence each scored component rests on
- `evidence/evaluator/browser-probes/*.json` for independently reusable,
  hash-verified browser pass and fail work units
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
implementation workflow and its full delivery contract are hard-coded; there is no
`--workflow`, `--until`, or `--workflow-arg` override. Update
`agent-runner-capabilities.json` deliberately when the recorded Agent Runner
revision gains or drops an adapter, model, or effort.

## Troubleshooting

For browser-proof failures, start with `logs/axi-browser-proof.log`. The proof
must find `Presentations` in the AXI accessibility snapshot. Clone, build,
preview, and verification logs identify earlier failures.

For evaluation failures, start with `result.json`. It records
`evaluation_status`, the owning phase, the observed error, whether the phase can
be resumed, and the full transition history. `run-state.json` records which
phases and work units completed and the hashes that must still match before
they can be reused.

Preflight failures exit 2 before any workflow starts and name the exact cause: a
dirty Agent Runner or Agent Skills checkout, a missing or non-conforming
`implement-change-v1.0.yaml`, a missing workflow-named Codagent skill, missing
publishing credentials, an invalid role profile with its role and field, a
role-profile mismatch on resume, a resume-provenance change, or a stale
run-state identity.

For a blocked full evaluation, run `--calibrate` and read `calibration.json`.
Its `failures` name the case and the exact expectation that broke, and each
case's `problems` and `unintended_regressions` say whether the harness scored
the wrong component, opened the wrong gate, or turned a product regression into
a harness failure.

For publication failures, `publication.json` records the stage, the result
commit if one exists, and the git error. Re-run the review command against the
same run directory to retry only the unfinished work.

For implementation failures, `result.json` records the Agent Runner run
identifier, session directory, candidate branch, retained draft PR, final SHA,
and every observed step outcome. A declared or observed merge, ready, close,
archive, release, or branch deletion is reported as
`workflow-side-effect-violation`; no CI checks or status endpoints are queried.

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
