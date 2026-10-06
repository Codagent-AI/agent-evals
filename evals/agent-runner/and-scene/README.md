# and-scene eval

## Second opinions on failures

Failed deterministic browser criteria and failed hard gates receive a second
opinion from two independent verifier samples, so one model call never decides
whether a failure is re-examined. Each sample's proposed overturn is tried in
turn, and the first one confirmed decides; a failure no sample overturns
stands. Every overturn needs mechanically validated source spans. For
browser-derived failures, a sample also proposes a bounded interaction replay,
and the verifier does not need to explain the failed measurement from the
record. The harness runs the replay through `chrome-devtools-axi` against the
candidate server, including during evaluator-only rescore, and the real-browser
replay decides: an admitted replay that observes the passing behavior
overturns the failure with no further model call. The harness decides which
replays count: `replayPolicy` in `lib/second-opinion.mjs` admits, per failing
target, only the input kind that failed and an observation that contradicts the
failure (a step change, a declared mode change, normative text on the active
step, a click-through of every step, or the active step's own control marked
`aria-current`). Step controls never include previous, next, or mode controls.
A target without a policy cannot be overturned by replay. The replay collects
page and console failures. Its actions, observations, errors, trace, and pass
result, and both verifier samples, are retained in
`phases/second-opinions.json`, the result, and the report. A browser or driver
fault during replay leaves the opinion pending and resumable; only what the
candidate page did can reject an overturn. Build and serve terminal failures,
and source-judged fallbacks, cannot be replayed and use the span and log audit.

## Robust judging

No single model call decides a scored criterion. Each judge job runs two
independent samples with identical inputs, concurrently, at a pinned reasoning
effort (`medium`, the judge model's default). Each source-job sample passes
through its own closed-world source audit. A contradiction never inverts that
sample's vote by itself: it marks the vote disputed, and an independent
contradiction check then decides whether that stated contradiction holds. Only
a confirmed contradiction turns the vote; a refuted one leaves it standing. An undecided audit gets one focused re-cite, and a verdict
still undecided after that stands as the sample's vote rather than spending
more citation cycles (a browser-fallback pass, which must be proven from
source, fails instead). A verdict both samples agree on, with neither vote
disputed, stands, pass or fail. A criterion they disagree on, or that either
sample's audit disputed, goes to a third independent sample that gets the job's
unchanged context and never sees the first two verdicts, so its vote decides.

A majority pass must cite line spans (`path`, `start_line`, `end_line`) that
the harness validates mechanically, exactly as the browser second opinion
does: the path must be in the verified neutral source inventory (or the
materialized evidence view for the testing-evidence and assumption-handling
jobs), resolve inside it without a symbolic link, and the range must lie inside
the file and span under 200 lines. A closed-world span audit then checks the
quoted lines against every clause of the criterion's requirement. Only
`confirmed` is recorded as confirmed; `insufficient` asks the same third sample
to re-cite once, and if the audit still cannot decide, the majority stands with
that noted; `contradicted` is replicated by a second independent audit, and the
majority pass is withdrawn only when an independent contradiction check
confirms that same stated contradiction; the check judges the first audit's
reason against the quoted lines and the rubric rather than auditing afresh, and
both are recorded. So every verdict rests on two agreeing signals: a consensus,
a majority of votes, or an audit's contradiction confirmed by a check. Every
judge, audit, and check prompt also carries one shared rule: judge only
behavior the cited source and recorded evidence establish, never a
hypothetical input, file deletion, or rendering the candidate does not
produce unless the guidance names it, and read an undefined term by the plain
meaning of its fixture requirement. Invalid third-sample output is retried and, once exhausted,
leaves the job unobserved, never failed.

Every judge sees, beside each criterion, the requirement it traces to: the
full fixture scenario from `fixture-snapshot/` for a fixture-owned criterion,
or the eval-owned reason. The assumption-handling view also carries the full
approved requirements as reference, so its judge can run the omission check.
Each criterion's evidence records its judging basis (`consensus-pass`,
`consensus-fail`, `majority-pass`, `majority-fail`), `phases/product-judging.json`
keeps every sample, the third-sample vote with its audits, and the
per-criterion consensus, and `phases/eval-owned-usage.jsonl` records each
call's `stage` (`<job>:sample-1`, `<job>:sample-2`, `<job>:tiebreak`,
`<job>:tiebreak-recite`, `<job>:tiebreak-audit`). A Codex turn rejected as at
capacity before any model output is waited out with backoff, without spending
a judge attempt, and is recorded with zero tokens. A response schema OpenAI
rejects (`invalid_json_schema`) fails fast as a harness error; every schema the
harness sends is checked against strict structured-output rules in
`test/codex-judge-schemas.test.mjs`.

`rubric-history.json` records the content hash of every automated rubric
version; a test fails when the rubric changes without a new version.

## Fixture traceability

Every automated criterion and gate has a `criterion_sources` entry in
`automated-rubric.json`. Fixture-owned entries cite a snapshot document,
heading, and normative fragment; eval-owned entries give a reason. Concrete
guidance values must appear in cited text or in `eval_owned_values` with a
reason. Refresh the offline snapshot from the pinned fixture checkout with:

```sh
node evals/agent-runner/and-scene/fixture-snapshot.mjs --checkout /path/to/and-scene
```

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

Each lead, implementor, and tester profile selects its own CLI
adapter (`claude`, `codex`, or `cursor`), and eval-owned judging always runs
through Codex. The adapter mounts the host authentication matching the selected
adapters plus Codex. Model identifiers are passed through unchanged: Cursor
accepts a versioned id such as `grok-4.6` or a full Cursor id such as
`cursor-grok-4.6-high`. A bare family such as `grok` is passed through, but the
Cursor CLI rejects it. Before starting Agent Runner, the suite verifies the
Codagent skills named by the workflow and the sub-workflows it invokes
against the pinned Agent Skills checkout and installs that local plugin for
each selected CLI. Missing literal sub-workflows fail preflight; templated
references emit a warning because their skills cannot be checked statically.

The profile names match the workflow's `lead`, `implementor`, and `tester`
agents; acceptance work runs through the `acceptance-tester` named session.
Agent Runner records the `tester` role for those attempts; attempts delegated
through `call_agent` by earlier Runner revisions use the `acceptance-reviewer`
role name.

The implementation agents use unrestricted permissions inside the container.
The container is the isolation boundary. Run trusted fixtures and pass only the
credentials the evaluation needs. Use a short-lived, repository-scoped token
with `--env GITHUB_TOKEN` or an env file for candidate delivery.

## Run the suite

The supported order is: browser proof, optional calibration or reference
baseline, full candidate run, human review, publication.

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

Run calibration when developing or reviewing scoring changes. It is a
standalone maintainer diagnostic and is not required before `--run-agent`:

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
  --tester-cli claude --tester-model opus --tester-effort high
```

Cursor profiles take a versioned id or a full Cursor model id. The suite does
not rewrite either form. `grok-4.6` works; a bare family such as `grok` does
not:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent \
  --skip-validator \
  --lead-cli cursor --lead-model grok-4.6 --lead-effort high \
  --implementor-cli cursor --implementor-model cursor-grok-4.6-high --implementor-effort medium \
  --tester-cli claude --tester-model opus --tester-effort high
```

`--skip-validator` passes `skip_validator=true` to skip all workflow-owned
Agent Validator execution: task-level compliance, the final Validator, and
acceptance-remediation Validator calls. Without it, all of those Validator
paths remain enabled. Both modes still complete the draft-PR,
acceptance-preparation, and handoff-verification steps. In skipped mode the
harness requires an explicit skipped outcome for the final `run-validator`
step; an absent, interrupted, or unexpectedly successful step is not accepted
as proof of intentional skipping.
Skipped mode also keeps Agent Validator away from the run's agents: the
controller starts Agent Runner with a `PATH` whose first entry shadows
`agent-validator` and `agent-validate` with a shim that exits 127. The shim
appends each attempt to `logs/blocked-validator-invocations.log`, and the
workflow events record a `validator-unavailable` entry. Runner needs no
Validator when every Validator step is skipped. The sandbox is unprivileged,
so the installed binary still exists; only name lookup is blocked. Validator-on
runs are unchanged.
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
  --tester-cli claude --tester-model opus --tester-effort high
```

Resume reuses the recorded Agent Runner run rather than starting a second one.
It verifies live process ownership before waiting, resumes only the exact
inactive unfinished run, and rejects a changed fixture, role profile, Runner
revision, workflow hash, Agent Skills revision or manifest, branch, draft PR,
final SHA, rubric hash, evidence identity, or other score-affecting input.
The run's private `.runtime/agent-session-state/` also retains the Codex rollout
directories, Claude project transcripts, and Cursor chat store addressed by
those recorded session IDs. Replacement containers link those allowlisted
directories into their otherwise disposable home, so genuine CLI continuation
survives without retaining auth files, CLI settings, or the rest of either home
directory.

If a Claude lead, implementor, or acceptance tester exhausts its session allowance,
the controller recognizes the Claude/Anthropic identity and limit message in
the current Agent Runner execution's durable `audit.log`. When that record also
contains an explicit UTC reset no more than six hours away, the controller
waits until one minute after the reset and resumes the exact persisted Runner
run. The wait is not recorded as active machine time. Generic HTTP 429 errors,
missing or stale reset times, longer waits, and quota messages from earlier
execution sessions remain ordinary resumable failures rather than guessed
delays.

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

A factory artifact may no longer hold `.runtime/agent-runner-projects`, where
the recorded Runner session lived. The rescore then restores the session's
acceptance evidence from `evidence/candidate/artifacts` into
`<rescore-run>/.runtime/rescore-session`, after checking the retained manifest
against the manifest hash the source recorded and every retained copy against
the recorded acceptance hashes. Any mismatch refuses the source. The
`imported-completed-run` event records the reconstruction.

Without Docker, add `--host` to run the same controller on this machine:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent --host \
  --rescore-from artifacts/evals/and-scene/<completed-run-id> \
  --artifact-dir artifacts/evals/and-scene/<rescore-run-id>
```

Host mode needs `node`, `npm`, `chrome-devtools-axi`, and `codex` on `PATH`
(or `AND_SCENE_CODEX_COMMAND`), plus either a DevTools endpoint in
`CHROME_DEVTOOLS_AXI_BROWSER_URL` or a Chrome or Chromium binary (`CHROME_PATH`,
the macOS Google Chrome app, `chromium`, or `google-chrome`). With a binary, the
controller starts headless Chrome on `AND_SCENE_HOST_DEVTOOLS_PORT` (default
9333) only for the browser evaluation and for second-opinion replays, with
flags that disable the GPU, extensions, background networking, site isolation,
and caches, cap renderer processes at two, and cap the JavaScript heap; it
stops Chrome and removes its profile as soon as each of those phases ends, so
no browser runs during source judging (`lib/host-browser.mjs`).

**Run host rescores one at a time on a small machine.** A long-lived headless
Chrome reached about 9 GB on a 16 GB Mac, and two parallel rescores exhausted
it. Start the next rescore only after the previous one exits, and check that no
earlier `controller.mjs`, `serve-candidate.mjs`, or host Chrome is still
running. Judges still run in Codex's read-only sandbox against the run's
neutral inputs. A rescore never starts or reads Agent Runner, so it leaves the
home's `~/.agent-runner/projects` untouched.

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

Calibration is an optional diagnostic, not a score or candidate-run gate. It
runs on the host and invokes no sandbox, no Agent Runner, no browser, and no
human.

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

Calibration writes its findings only into the selected calibration artifact
directory. It creates no separate receipt, and `--run-agent` never checks for
one. Automation therefore needs only the harness revision and normal candidate
inputs; it does not need shared calibration storage.

If calibration exposes a rubric defect rather than a harness defect, revise the
spec and rubric through review and calibrate again.

## First benchmark rollout

The two runs a paired human review needs can be produced without any human
input:

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
  --tester-cli claude --tester-model opus --tester-effort high
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
`f0695b96c0c23b2d17ecc6cfbaf8be1fcdedd6f8` in
`https://github.com/Codagent-AI/and-scene.git`. The implemented reference commit
`171c7def1e12aca2a5f605a5e5feafb20d4e4d19` is the comparable reference baseline.
It is not a similarity target. The fixture includes the reviewed structured test
plan merged by `Codagent-AI/and-scene#11`; advance it only to another reviewed
planning-only fixture revision. Its `.validator/config.yml` runs the checks and
`all-reviewers` on the root entry point and scopes the `skill-quality` review
to a separate `skills` entry point, so that review runs only when files under
`skills/` change. The pinned commit is kept reachable on the and-scene branch
`eval/fixture-baseline-scrub`.

The suite runs Agent Runner's exact
`workflows/core/implement-change-v1.0.yaml` workflow through completion, invoked
as `core:implement-change` with the OpenSpec artifact parameters supplied by the suite.
There is no early `--until` boundary. `--skip-validator` skips task-level,
final, and acceptance-remediation Agent Validator execution while the draft
pull request, acceptance preparation, and handoff verification always remain
required. The final `run-validator` step must be recorded as `skipped` in that
mode and `success` when validation is enabled.

Current Agent Runner delegates those final steps (`run-validator`,
`open-draft-pr`, `verify-draft-pr`, `prepare-acceptance`, and
`verify-acceptance-handoff`) to the `core:verify-change` sub-workflow,
`workflows/core/verify-change-v1.0.yaml`, through a top-level `verify-change`
step. The suite then checks the contract in that file, requires
`agent-runner debug --show-workflow core:verify-change` to match it, records its
hash as `verification_workflow_sha256`, and reads the final step outcomes at
`verify-change > sub:verify-change > <step>` in the run history. Earlier Runner
revisions declared the same steps at the top level of implement-change; that
layout is still accepted so their runs remain verifiable and rescorable. Delivery
and the published workflow result report the leaf step (for example
`run-validator`) and retain the full `step_path` in the history entry. The
sub-workflow shares its parent's session directory, so acceptance evidence is
still discovered under the run's `output/` directory. The Agent Runner checkout must be a clean Git worktree; the suite
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
| `lib/human-review.mjs` | The seven versioned questions, anchored responses, and the 30-point calculation |
| `lib/candidate-server.mjs` | Candidate-server identity, provenance-safe reuse, and cleanup |
| `lib/candidate-server-host.mjs` | Launching and probing the host candidate server |
| `lib/result.mjs` | Result assembly, the artifact manifest, and the durable artifact set |
| `lib/baseline.mjs` | Reference-baseline comparison and its rubric-match refusal |
| `lib/report.mjs` | The offline, escaped HTML report |
| `lib/publication.mjs` | The curated snapshot, path-limited commit, and retryable push |
| `lib/calibration.mjs` | Known-good/degraded calibration cases and their expectations |

`calibrate.mjs` is the third entry point. It runs the optional calibration
diagnostic on the host and writes the detailed ledger into its artifact
directory.

`human-review.sh` is the second thin host entry point, for the literal human
review; `human-review.mjs` owns its lifecycle. It runs on the host rather than
in the sandbox: the reviewer needs the candidate URL in their own browser, and a
review that spans hours must outlive the container that produced the run.

Agent Runner owns the sandbox, workflow execution, run locks, sessions, its own
internal resume point, and `run-metrics.json`. The suite does not interpret or
publish its private session contents; it only gives Runner's CLI session stores
a per-run persistent location so Runner can honor its recorded resume point in
a replacement container.

## Evidence ownership and aliases

Candidate acceptance material is untrusted input. After the local and draft-PR
heads are verified, the suite anchors discovery on the final handoff, copies
the original bytes under `evidence/candidate/`, and records hashes, origins,
claimed revisions, coverage, limitations, and lineage. Independent checks and
captures are written under `evidence/evaluator/`; they may disprove candidate
claims but never count as candidate testing proof. The harness preserves
candidate-reported CI text and its claimed revision verbatim and does not query
CI.

The semantic roles expected for complete candidate evidence and their accepted
filenames are:

| Role | Accepted aliases |
|---|---|
| Acceptance flow record (or an exploration log in its place) | `acceptance-flow-evidence.md`, `acceptance-test-results.md`, `acceptance-flow.md`, `acceptance-evidence.md`, `flow-evidence.md` |
| Exploration log (satisfies the flow record) | `exploration-log.md`, `acceptance-exploration-log.md`, `acceptance-exploration.md` |
| Screenshots | `.png`, `.jpg`, `.jpeg`, or `.webp` files referenced by the handoff or found in the recorded acceptance output, such as `acceptance-screenshots/` |
| Screenshot metadata (optional, one or more) | `acceptance-test.md`, `capture-metadata.json`, `screenshot-metadata.json`, `screenshot-manifest.json`, `capture-manifest.json`, and any `*-screenshot-metadata.md`/`.json` such as `round-1-screenshot-metadata.md` |
| Findings and retest history | `findings-history.md`, `retest-history.md`, `acceptance-findings.md`, `findings.md`, `acceptance-retest.md` |
| Final handoff | `acceptance-handoff.md`, `final-acceptance-handoff.md`, `acceptance-final-handoff.md`, `final-handoff.md`, `acceptance-handoff-tester.md` |
| Acceptance gate notice (optional) | Agent Runner's generated `acceptance-handoff.md` starting `# Acceptance did not converge within`, when a tester handoff exists |
| Assumptions ledger | `acceptance-assumptions.md`, `assumptions-ledger.md`, `acceptance-assumption-ledger.md`, `assumptions.md` |
| Acceptance pass record (optional) | `exploration-plan.md`, `acceptance-exploration-plan.md`, and pass-numbered copies of acceptance records such as `acceptance-findings-pass1.md` |
| Tested revision (optional) | `acceptance-tested-revision.txt` |

A bare filename a record names, such as `round-1-screenshot-metadata.md`
kept in `acceptance-screenshots/`, resolves to the one scanned output file with
that name; an ambiguous name stays unresolved. Without usable JSON capture
metadata, a screenshot is verified only when a verified record, including a
Markdown metadata file, names it.

When acceptance does not converge, Agent Runner's acceptance gate moves the
tester's handoff to `acceptance-handoff-tester.md` and writes its own short
notice to `acceptance-handoff.md`. The tester handoff is then the final handoff
and the notice keeps the `acceptance-gate-notice` role; the notice is the final
handoff only when the tester wrote none. Referenced session reports and
assumption/context-gap audits are retained when present; any other file a
record references is retained as `referenced-material`. A record that names a revision Git resolves to an ancestor of the
final SHA is verified as a record of that earlier revision
(`revision_relation: ancestor-of-final`); one naming a revision that does not
resolve or lies off the final history stays defective. A well-formed tested-revision SHA off the final history is still recorded for lineage diagnosis as `recorded-off-history`; it never establishes final-revision support.

The evidence lineage carries deterministic `tested_revision` facts for the
final-revision criterion: the SHA on the last non-empty line of the verified tested-revision record, its
relation to the final SHA, and the files changed since, split into product,
test-only, and harness-owned paths. Each verified pass record that declares a
`Diff base:` also gets the files between that base and the revision it tested,
so the judge can check that a diff-scoped re-test explored them; `retest_scope: files-listed` says only that those files are known, never that they were explored, and `mirrors` groups changed product files that are byte-identical at the tested revision, such as a kit file and its bootstrap-template copy. If the record does not identify an accepted tested revision, the diff base has null `tested_revision` and `changes_to_tested_revision`, with `retest_scope: not-established`. A tested
revision equal to the final SHA, or an ancestor with no later product changes,
establishes final-revision support without a full re-run. Missing expected roles make candidate-evidence coverage incomplete but
do not stop independent scored judging. The exploratory `codagent:prepare-acceptance`
skill writes `exploration-log.md` and stores screenshots under
`acceptance-screenshots/` without a metadata file; that layout is complete. A
screenshot with no metadata file is verified only when a verified flow record,
exploration log, findings record, handoff, or pass record names its path,
filename, or a per-flow or per-screenshot subdirectory in path form (`described_by`).
The shared `acceptance-screenshots/` root does not describe an individual screenshot.
`./` links, relative and variable-prefixed output paths, absolute paths, and
sentence-ending paths count, so the judge reads what was inspected
and observed there. A screenshot no metadata or verified record describes, or
one beside malformed JSON metadata, is retained as defective, unverified
candidate evidence. Present but stale,
malformed, weakly traceable, or wrong-revision content likewise remains
judgeable and is recorded as an evidence defect.

Product-source judges run from `neutral/judge/`, which contains only a
byte-exact final-commit source snapshot under neutralized paths and
identity-free approved requirements. The source snapshot excludes only exact
harness-owned paths (`.agent-runner/` and the original OpenSpec change
directory), so product modules with generic names such as `evidence` or
`acceptance` remain reviewable. The provenance manifest is stored outside that
judge root. Testing-evidence and assumption-handling jobs use separate bounded
views under `evidence/judge-views/`. The testing-evidence view also carries the
requirement and scenario headings of the approved specs as reference: coverage
is judged against those user-visible behaviors, whatever testing approach the
candidate took, never against a fixed test-plan case list. Each testing-evidence
criterion's definition comes from `criterion_definitions` in the automated
rubric and is shown to the judge beside its identifier.

Automated rubric 10.0.0 defines the terms the round-2 audit found judges
splitting on: a stable step id survives insertion and reordering, a warning
identifies an element by text, accessible name, hook, or selector, the visible
newcomer entry is judged rather than each wrapper, demo identity needs no
rearrangement, non-empty confirmation covers partial scaffolds, assumption
handling distinguishes reproduced violations and runs an explicit omission
check, complete-honest-record counts only material omissions, usable proof
treats a stated limitation as a disclosure, and final-revision applicability
credits mirrors and commands the acceptance workflow forbids.

Automated rubric 9.0.0 settles the criteria the round-1 audit found judges
splitting on: newcomer sequencing follows the design's entry delay, the
present-mode marker, the uniform-fit reference viewports (1280×720 and
390×844), preview ownership mechanisms, one representative browser-error test,
the missing-sample failure phase, textless chrome in overlap detection,
environment-impossible acceptance journeys, diff-scoped re-test exploration,
exploration-plan commitments, candor in assumption handling, and decisions
named in the final handoff. 8.0.0 was published with two contents; tell those
results apart by their recorded rubric hash.

Automated rubric 8.0.0 traces guidance to the fixture where 7.0.0 exceeded it:
settled screenshots accept the configured settle interval, touch swipe no
longer requires vertical or multi-touch rejection, overlap and allow-overlap
follow the fixture scenarios, and five scaffold branches plus template path
resolution are judged from explicit `SKILL.md` instructions. It also states
that an on-screen step number must be rendered text and that the default
attribution must link to `https://github.com/Codagent-AI/and-scene`. Scores
for those criteria are not comparable with 7.0.0; re-judge an earlier run with
`--rescore-from`.

Automated rubric 6.0.0 redefined the four testing-evidence criteria and the
final-revision rule. Testing-evidence scores from 6.0.0 are not comparable with
5.0.0 or earlier results. A resume refuses a changed rubric, so re-judge an
earlier completed run with `--rescore-from`, which rediscovers its acceptance
evidence under the new roles.

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
    ├── agent-runner-projects/
    ├── judge/
    └── agent-session-state/
        ├── codex/
        │   ├── archived_sessions/
        │   ├── memories/
        │   ├── sessions/
        │   └── shell_snapshots/
        ├── claude/
        │   └── projects/
        └── cursor/
            └── chats/
```

`.runtime/` persists across disposable containers. Agent Runner layers built-in
defaults, the global config, then the project config it discovers at
`<cwd>/.agent-runner/config.yaml`, so the eval-scoped profile is written into
the candidate worktree and Agent Runner is invoked from there. A fresh candidate
creates `eval/and-scene/<run-id>` exactly at the pinned fixture before Runner
starts; any local or remote branch collision is refused. Resumes require that
exact repository, worktree, branch, Runner run, workflow revision, draft PR,
final SHA, and evidence identity. Credentials stay in the ephemeral container
home and are never written into the run directory. The retained CLI session
directories are private recovery state, excluded from the curated publication
along with every other `.runtime/` entry.

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
3. Verify the delivered branch, remote head, and open draft PR whose base
   exactly matches the recorded `origin/HEAD`, plus its head, the final
   Validator's required successful or intentional skipped outcome, unarchived
   change, and acceptance handoff. Tracked changes and arbitrary untracked files
   still fail delivery; untracked raster screenshots under
   `artifacts/presentation-inspection/` are retained as explicitly identified
   candidate evidence and do not make the committed product revision dirty.
4. Freeze the verified final source revision.
5. Install dependencies, build, and run non-browser verification.
6. Start the evaluated candidate server.
7. Run deterministic browser checks and capture evaluator evidence.
8. Run product judging, then the separate ambiguity diagnostic.
9. Ingest metrics and resolve pricing.
10. Write the HTML report and either an eligible `pending-human-review` result
    or a conclusive automated product-fail result.
11. Attempt candidate-server cleanup, update the result artifacts, and exit.

A phase that cannot produce its outputs stops its dependents rather than letting
them run on stale or fabricated inputs. Result writing and cleanup still run.

The result consumes Agent Runner's versioned `run-metrics.json` directly. It
accepts legacy schemas v1-v3 and the authoritative schema-v4 measurement
projection. For v4, native measurements and current Validator measurement
heads are the usage sources; the `steps` compatibility view is never counted a
second time. The suite preserves requested, resolved, and observed identities,
field-level availability and precision, delivery/history gaps, per-model
allocations and unallocated usage, and scoped provider cost evidence.
Unsupported outer or nested versions are rejected instead of falling back to
an older compatibility view. `result.json` and `report.html` show implementation
usage by role, tool, provider, model, and allocation, including dispatch and
participation counts, canonical totals, pricing source, verification state, and
independent completeness dimensions. Eval-owned Codex judge usage is captured
separately in `phases/eval-owned-usage.jsonl`; it is never priced or included in
implementation cost.

## Human review

The automated command never asks a human-review question and never issues an
official total. A candidate proceeds to the separate literal review only if its
complete automated result remains eligible to pass:

```sh
evals/agent-runner/and-scene/human-review.sh --run-dir artifacts/evals/and-scene/<run>
```

It restores or restarts the exact candidate revision the automated rubric and
judges scored, prints its URL, and waits for an explicit non-scoring readiness
confirmation before question 1. It then asks the seven versioned questions in
order, one at a time. Each prompt displays five question-specific labels and
descriptions that refine the shared 1-5 anchors; a rationale is required for 3
or lower. Every accepted answer is saved immediately, so an interrupted review
resumes at the first unanswered question with the candidate URL and readiness
confirmation presented again. Nothing becomes official until the reviewer
explicitly confirms the full summary; before that the run stays
`pending-human-review`.

Once the reviewer confirms, the run is finalized and published; see
[Publication](#publication).

Pass `--no-publish` to finalize the review without committing or pushing from
this checkout. The agent factory uses it: it runs the review from a pinned,
detached agent-evals worktree and saves each finished run directory to the
eval repository itself. A later invocation against the same run with
`--no-publish` also skips any unfinished publication.

Pass `--baseline-run-dir` to review a pending reference baseline first. Each run
keeps its own candidate, rubric, response, score, and completion state, and the
candidate's result records baseline totals, component, subcomponent, and gate
deltas — only when both runs used identical rubric versions and hashes.

The human-review score is 30 points: 4 for text appearance, hierarchy, and
wording; 4 for the visual design of individual elements; 5 for composition and
placement; 6 for motion and scene evolution; 5 for overall visual identity; 3
for navigation and presentation chrome; and 3 for responsive visual quality.
Each rating `r` earns `(r - 1) / 4` of its dimension's points, summed without
intermediate rounding. The component gate passes only at 15 or more with no
individual rating of 1.

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

An automated run that remains eligible ends at `pending-human-review` and is
never published. A conclusive automated product failure also remains a local
diagnostic and is not published.
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
harness never becomes a product failure. A complete automated score below 40 of
70, either automated component below its 15-of-24 floor, or any failed hard gate
does become a conclusive product failure because human review cannot make that
candidate pass. A durably recorded product verdict survives a later harness
failure — reported as `PASS — HARNESS FAILURE` or `FAIL — HARNESS FAILURE`. A
completed reference likewise retains its score as `REFERENCE — COMPLETE —
HARNESS FAILURE`. Cleanup failure after a durably written result is recorded
diagnostically and still exits successfully.

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
subtotal out of 70 and no official total. A complete automated result must score
at least 40 of 70, meet both automated 15-of-24 component floors, and pass all
four hard gates to proceed to human review. A failed requirement produces
`evaluation_status=complete` and `product_verdict=fail` without inventing an
official score. Incomplete automated evidence instead produces the owning
workflow or harness failure; it is never converted into a low score.

Agent Factory and other orchestrators should consume the suite policy from
`result.json`: `evaluation_status=complete` with `product_verdict=fail` is a
finished failed repetition, while `evaluation_status=pending-human-review` with
`product_verdict=unavailable` is eligible for review. The nested
`score.automated_pass` field is `false`, `true`, or `null` for failed, eligible,
or incomplete automated eligibility respectively, and
`score.automated_failures` gives structured threshold, component-floor, and
hard-gate reasons. Consumers must not recalculate the 40-point policy.

`automated-rubric.json` and `human-rubric.json` own criterion identifiers,
evaluator assignment, points, gates, and thresholds. Neither the judge nor the
human-review interface may change them, and every result records both rubrics'
version and SHA-256 hash. Each row's points divide equally among its criteria,
and intermediate values are never rounded.

Deterministic browser checks exercise the built, running demo: routing, the
canonical nine steps, evolving-scene structure, present/browse modes,
navigation, end boundaries, transition reliability, control semantics, focus,
and keyboard operability. They assert only mechanically provable behavior at
the suite-owned viewport; a design choice the fixture does not state — showing
the deck title in browse mode, a responsive table of contents, a hidden rather
than disabled boundary control, fixed-canvas behavior at an extreme viewport —
is judged by the scene-kit source judge and human review instead. Each probe is
stored in `evidence/evaluator/browser-probes/` as an evaluator-owned,
revision-bound work unit with input/output hashes, required mode and position,
initial and settled state, the bounded observation its verdict was derived from
— viewport, mode, position, title, caption, chrome visibility, discovered
controls, and the selector that matched each navigation role — runtime
failures, and its pass or fail result. Matching negative
findings are reusable after interruption just like matching passes. Evaluator
screenshots carry the same ownership, revision, mode, position, settle, and
hash metadata. Focused component judge jobs review delivered source and
candidate-produced evidence.
Judges receive only their own rubric slice, get no screenshots, and do not judge
visual taste, which belongs to human review. Source judges may cite only durable
files from the neutral source snapshot; ad-hoc command output is never evidence
because the independent closed-world auditor cannot inspect it. Malformed judge
output receives up to three local attempts. Source-audit convergence receives
up to five progress-making citation cycles, while an unchanged insufficient
claim stops immediately as a harness protocol failure instead of spending more
model calls on identical evidence.

Four hard gates sit outside the point total: `verification-build-whole-app`,
`verification-sample-outline`, `verification-every-produced-step-renders`, and
`verification-clear-outcome`. A failed gate ends automated eligibility without
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
- `agent-runner-capabilities.json` in the suite for stable adapter, role, and
  effort capabilities that profile validation checks against; model names are
  intentionally not enumerated
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
revision gains or drops an adapter, role, or effort. Model availability is
resolved by Agent Runner and the selected CLI when the workflow runs.

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
`implement-change-v1.0.yaml` or delegated `verify-change-v1.0.yaml`, a missing
Codagent skill named by the workflow or a sub-workflow it invokes, missing
publishing credentials, an invalid role profile with its role and field, a
role-profile mismatch on resume, a resume-provenance change (including a changed delegated verification workflow when recorded), or a stale
run-state identity.

To diagnose or review scoring behavior, run `--calibrate` and read
`calibration.json`. Its `failures` name the case and the exact expectation that
broke, and each case's `problems` and `unintended_regressions` say whether the
harness scored the wrong component, opened the wrong gate, or turned a product
regression into a harness failure.

For a stalled or failed Codex judge call, read `.runtime/judge/`. Each call has
`NN-<job>.schema.json` and `.output.json`, and each attempt streams Codex's JSON
events to `.events.jsonl` and its stderr to `.stderr.log` as it runs; a retry or
a later recovery of the same call writes `NN-<job>.attempt-<n>.*` beside the
earlier attempt. The last event shows what a stalled call was waiting on. Shell
command output is omitted from persisted events. A call that runs longer than
10 minutes is stopped, noted in its stderr log, and retried once.

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
its supported adapters, roles, or efforts. Run calibration while reviewing
rubric, scorer, gate, or reporting changes, then run targeted tests during
development and `npm run check` before trusting a change. Candidate execution
does not depend on retaining calibration artifacts.

### Real candidate end-to-end check

`test/real-browser/candidate.test.mjs` runs the production browser evaluator in
real Chrome against one real candidate, issue #26 repetition 3, and requires its
known verdicts: it hides every step title, so the step content, present mode,
and sample outline checks fail and every other check passes. Run it by hand
after changing the browser evaluator; CI never requires it. The file header has
the build and serve commands. It takes a few minutes.

### Adversarial real-browser pages

`test/real-browser/adversarial.test.mjs` drives the production evaluator in real
Chrome against ten hand-made pages: a deck
that ignores deck keys while a button holds focus, one whose keys stay dead
after any control use, a correct scene with no recognised hook, a hidden step
title, a deck that listens for keys on its own root, a control that will not
release focus, a deck whose root has no root hook, a deck whose step titles sit
in unhooked header `<span>` and `<strong>` elements beside a persistent list of
every title, a deck that declares its mode only as `data-mode` and shows a
footer present-title paragraph with a nested step marker, and a deck that
exposes its titles only in that persistent list. The two unhooked decks
reproduce the markup of the two eval #51 candidates the outline gate wrongly
failed; the last must still fail the outline. It sits outside the
`test/*.test.mjs` glob because CI has no browser. Run it before merging any change to the control-key, scene, or
present-mode, title, caption, or mode-inference probes, and never while the candidate check is running:

```bash
node --test test/real-browser/adversarial.test.mjs
```

Published result directories are immutable historical records. Correct an
erroneous publication with a later revert commit rather than by rewriting
history.
