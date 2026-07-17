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

The default run uses Claude as the implementation agent and Codex as the judge.
The adapter mounts the matching host authentication. A Codex-only run needs
only Codex authentication.

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

Run the scored evaluation with Claude implementing and Codex judging:

```bash
evals/agent-runner/and-scene/run.sh --run-agent
```

For a comparable benchmark, pin both model selections explicitly:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent \
  --benchmark \
  --model <implementation-model> \
  --judge-model <judge-model>
```

Grade an existing implementation without rerunning Agent Runner, for example to
calibrate against the reference branch:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent \
  --candidate-ref 171c7def1e12aca2a5f605a5e5feafb20d4e4d19 \
  --benchmark \
  --judge-model <judge-model>
```

Use Codex for both roles:

```bash
evals/agent-runner/and-scene/run.sh --run-agent --agent codex
```

Point at a different Agent Runner checkout:

```bash
evals/agent-runner/and-scene/run.sh \
  --run-agent \
  --agent-runner-dir /path/to/agent-runner
```

Inspect the sandbox invocation without Docker or model calls:

```bash
evals/agent-runner/and-scene/run.sh --run-agent --agent codex --dry-run
```

Proof artifacts default to
`artifacts/evals/and-scene-proof/<timestamp>/`. Scored artifacts default to
`artifacts/evals/and-scene/<timestamp>/`. Use `--artifact-dir PATH` for a stable
location.

## What it evaluates

The suite measures implementation of the `create-and-scene` OpenSpec change.
Planning artifacts and tasks are already present, so the score does not measure
proposal, specification, or task generation.

The external fixture is pinned to commit
`c11595651dfb3941e39c703c483ed1a92d152a37` in
`https://github.com/Codagent-AI/and-scene.git`. The implemented reference commit
`171c7def1e12aca2a5f605a5e5feafb20d4e4d19` is available to the judge only as a
tiebreak when the produced artifact and spec do not provide enough evidence.
It is not a similarity target.

The suite runs Agent Runner's production
`workflows/openspec/implement-change.yaml` workflow through the top-level
`run-validator` step. It stops before the archive and PR-opening tail. Every
evaluation starts with new agent sessions.

## Run lifecycle

1. Agent Runner builds its development image, builds the local Agent Runner
   binary inside it, and starts a disposable container.
2. The suite clones the pinned fixture and writes container-local Agent Runner
   configuration for the requested implementation agent.
3. Agent Runner executes the implementation workflow through `run-validator`.
4. The suite runs `npm ci`, `npm run build`, and `npm run verify` against the
   produced checkout.
5. `scene-shots.mjs` captures every presentation step using the fixture's
   `data-step-count` and `data-step-index` contract.
6. If coverage is incomplete, the judge gets one attempt to repair a temporary
   copy of the screenshot helper. The attempt cannot edit the evaluated checkout
   and always subtracts five points.
7. Evaluator-owned deterministic checks grade exact sample content, IPv4
   loopback use, attribution and active-state hooks, and screenshot-helper
   contracts.
8. The multimodal judge grades only the rubric scenarios assigned to it from the
   specs, produced source, diff, logs, screenshots, and reference source. It
   cannot choose scenario IDs, criticality, weights, the score, or pass/fail.
9. The suite validates exact scenario coverage, merges deterministic and judge
   verdicts, and computes the weighted score and critical gate from `rubric.json`.
10. An exit trap writes metadata, the aggregate reward, and a file manifest even
   when the run fails partway through.

## Scoring

| Dimension | Weight | Pass condition |
|---|---:|---|
| Workflow health | 20 | Agent Runner exits successfully |
| Correctness | 40 | Install, build, and verification exit successfully |
| Scenario compliance | 40 | Suite-computed rubric score multiplied by 0.4, with every fixed critical scenario passing |
| Evidence repair | -5 | Deducted whenever screenshot repair runs |

`reward.json` records the hard pass, soft score, dimension results, and repair
penalty. The soft score is clamped at zero. The process exits successfully only
when Agent Runner, install, build, verification, complete screenshot coverage,
deterministic evaluation, judge execution, and the critical-scenario gate all
pass. The rubric contains 68 scenarios, 22 of them critical. Critical scenarios
carry weight 2 and other scenarios weight 1.

## Artifacts

Start with:

- `reward.json` for the aggregate result
- `metadata.json` for fixture, workflow, models, Agent Runner provenance,
  agent-evals provenance, repair state, and component exit codes
- `tier1-result.json` for deterministic build and browser verification
- `tier2-deterministic-result.json` for evaluator-owned contract checks
- `tier2-judge-raw.json` for the judge's untrusted scenario verdicts
- `tier2-result.json` for the validated, merged, suite-scored result
- `rubric.json` in the suite for evaluator assignment, criticality, and weights
- `screenshot-manifest.json` for expected and captured visual coverage
- `screenshot-manifest-judge.json` for the bounded coverage summary included in
  the judge prompt; candidate page text and per-frame metadata stay out of the
  prompt
- `implementation.diff` and `diff-hash.txt` for the scored changes
- `manifest.json` for the size and SHA-256 of every collected file

Supporting evidence is under `screenshots/`, `logs/`, and `run-state/`. The
browser proof writes `proof-metadata.json`, `tier1-result.txt`, and logs without
running an implementation agent or producing a score.

## Configuration

Run `evals/agent-runner/and-scene/run.sh --help` for every option. Common
overrides include the implementation agent and model, judge model, fixture,
candidate, and reference refs, workflow, stop step, workflow arguments, and
explicit env or authentication forwarding. `--benchmark` rejects CLI-default
model selection. Metadata records whether each model was explicit, CLI-default,
or skipped, along with Agent Runner, implementation CLI, and judge CLI versions.

The default workflow receives `change_name=create-and-scene` and stops at
`run-validator`. A custom workflow receives neither default unless you provide
`--workflow-arg` and `--until`.

A custom judge command reads the prompt from standard input, writes JSON that
matches `tier2-schema.json` to standard output, and receives screenshot paths as
positional arguments.

## Troubleshooting

For browser-proof failures, start with `logs/axi-browser-proof.log`. The proof
must find `Presentations` in the AXI accessibility snapshot. Clone, build,
preview, and verification logs identify earlier failures.

For implementation failures, check `metadata.json` for the component exit code.
Then inspect `logs/agent-runner.log` or the matching install, build, and verify
log.

For incomplete screenshots, compare the expected and captured counts in
`screenshot-manifest.json`. The first attempt is in `logs/screenshots.log`.
Repair logs are `logs/repair-screenshot-capture.log` and
`logs/screenshots-repaired.log`. Any repair attempt should produce a five-point
penalty in both metadata and reward output.

For deterministic failures, inspect `tier2-deterministic-result.json` and
`logs/tier2-deterministic.log`. For judging failures, inspect
`logs/tier2-judge.log`, `tier2-judge-prompt.md`, `tier2-judge-raw.json`, and
`tier2-schema.json`. `metadata.json` distinguishes judge execution failure from a
successfully judged candidate failure. The scorer rejects missing, duplicate, or
unknown scenario IDs.

## Maintenance

Update the fixture SHA deliberately when the implementation-ready snapshot
changes. Keep scored runs pinned to exact commits. `npm run check` includes
all-pass scoring calibration plus known broken mutations for deterministic
checks. Before trusting a rubric or fixture revision, run those checks, the
browser proof, and a pinned-judge `--candidate-ref` reference calibration before
starting another full scored run.
