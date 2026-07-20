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

First prove the sandbox can build the fixture, launch Chromium, and inspect the
reference app through `chrome-devtools-axi`:

```bash
evals/agent-runner/and-scene/run.sh --proof-browser
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
directories default to `artifacts/evals/and-scene/<timestamp>/`. Use
`--artifact-dir PATH` for a stable location; its basename is the run identity.

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

Agent Runner owns the sandbox, workflow execution, run locks, sessions, its own
internal resume point, and `run-metrics.json`. None of that is copied here.

## Run directory layout

```text
artifacts/evals/and-scene/<run-id>/
├── checkpoint.json
├── result.json
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

Phases 2 and 4-8 are registered as explicit placeholders pending the product
evaluation, metrics, and reporting tasks; the ordering, checkpointing, and
outcome contracts they run under are already enforced.

A phase that cannot produce its outputs stops its dependents rather than letting
them run on stale or fabricated inputs. Result writing and cleanup still run.

## Outcomes

`evaluation_status` is exactly one of `complete`, `pending-human-review`,
`implementation-workflow-failed`, or `evaluation-harness-failed`.
`product_verdict` is exactly one of `pass`, `fail`, or `unavailable`.

Execution status and product quality are independent. A failed workflow or
harness never becomes a product failure, and a durably recorded product verdict
survives a later harness failure — reported as `PASS — HARNESS FAILURE` or
`FAIL — HARNESS FAILURE`. Cleanup failure after a durably written pending
result is recorded diagnostically and still exits successfully.

`result.json` is the authoritative machine-readable outcome. Human review and
`report.html` land with the human-review task.

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

Evidence that was never observed — a judge job that never returned usable
output, a browser evaluation that never ran — leaves its component incomplete
and the verdict unavailable. It is never converted into product failures or
rescaled away.

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

For implementation failures, `result.json` records the Agent Runner run
identifier, session directory, configured and observed stop boundaries, and
every observed step. A step observed beyond the configured boundary is reported
as a workflow-boundary failure with the unexpected step named.

## Maintenance

Update the fixture SHA deliberately when the implementation-ready snapshot
changes. Keep runs pinned to exact commits, and update
`agent-runner-capabilities.json` when the recorded Agent Runner revision changes
its supported adapters, models, or efforts. Run targeted tests during
development and `npm run check` before trusting a change.
