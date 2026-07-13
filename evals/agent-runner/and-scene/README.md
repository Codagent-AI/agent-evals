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
`26d2866e5003f34786fffa528891e6092c87cf8b` in
`https://github.com/Codagent-AI/and-scene.git`. The implemented
`origin/change/create-and-scene` branch is available to the judge only as a
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
7. The multimodal judge grades every spec scenario from the specs, produced
   source, diff, logs, screenshot manifest, screenshots, and reference source.
8. An exit trap writes metadata, the aggregate reward, and a file manifest even
   when the run fails partway through.

## Scoring

| Dimension | Weight | Pass condition |
|---|---:|---|
| Workflow health | 20 | Agent Runner exits successfully |
| Correctness | 40 | Install, build, and verification exit successfully |
| Scenario compliance | 40 | Judge score multiplied by 0.4, with every critical scenario passing |
| Evidence repair | -5 | Deducted whenever screenshot repair runs |

`reward.json` records the hard pass, soft score, dimension results, and repair
penalty. The soft score is clamped at zero. The process exits successfully only
when Agent Runner, install, build, verification, complete screenshot coverage,
and the critical-scenario gate all pass.

## Artifacts

Start with:

- `reward.json` for the aggregate result
- `metadata.json` for fixture, workflow, models, Agent Runner provenance,
  agent-evals provenance, repair state, and component exit codes
- `tier1-result.json` for deterministic build and browser verification
- `tier2-result.json` for per-scenario judge results
- `screenshot-manifest.json` for expected and captured visual coverage
- `implementation.diff` and `diff-hash.txt` for the scored changes
- `manifest.json` for the size and SHA-256 of every collected file

Supporting evidence is under `screenshots/`, `logs/`, and `run-state/`. The
browser proof writes `proof-metadata.json`, `tier1-result.txt`, and logs without
running an implementation agent or producing a score.

## Configuration

Run `evals/agent-runner/and-scene/run.sh --help` for every option. Common
overrides include the implementation agent and model, judge model, fixture and
reference refs, workflow, stop step, workflow arguments, and explicit env or
authentication forwarding.

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

For judging failures, inspect `logs/tier2-judge.log`,
`tier2-judge-prompt.md`, and `tier2-schema.json`. The judge needs at least one
screenshot and schema-valid JSON. Any failed critical scenario makes the suite
exit nonzero.

## Maintenance

Update the fixture SHA deliberately when the implementation-ready snapshot
changes. Keep scored runs pinned to exact commits. Run `npm run check`, then the
browser proof before trusting a full scored run.
