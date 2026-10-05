# Task: Calibrate the judges and pass threshold, then prove the suite end to end with Claude and Codex leads

## Goal

Add the `--calibrate` maintainer diagnostic and its committed calibration set. Run calibration to propose the rubric's weights and pass threshold. Then prove the whole suite with real paid runs:
- a Claude-lead candidate run, followed by a rescore;
- a Codex-lead run that is interrupted and resumed.

Calibration checks that judges credit sound alternatives instead of the reference's shape, and that they catch removed requirements and planted defects. The end-to-end runs are the only proof that the sandbox, the external-user exchange, the simulated user, the audits, the judges, and publication work together.

## Background

### Blocking prerequisite: agent-evals PR #81

Calibration and candidate runs depend on judge mechanics copied after agent-evals PR #81 ("fix: make and-scene judging and scoring robust") merges. Before doing anything else, run:

```sh
gh pr view 81 --repo Codagent-AI/agent-evals --json state
```

If it is not `MERGED`, stop and report this task as blocked on PR #81. Do not poll indefinitely.

### Context

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Rubric", "Collection, gates, and judging", "Risks / Trade-offs" (the cheaper-panel-models and decider-spread bullets), Decision 11, and "Open Questions";
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `E2E-001`, `E2E-002`, `E2E-003`, and the "Acceptance Testing Envelope".

State of the suite `evals/agent-runner/and-scene-define/`. Use these; if one is missing, stop and report which:
- `run.sh` with `--help`, `--dry-run`, `--run-agent`, `--resume`, `--rescore-from`, and `--time-limit`;
- the controller and its full ordered lifecycle;
- `rubric.json`: generated from `hidden/inventory.json`, with provisional points (coverage 60, artifact quality 25, fidelity 15), item weights (mandatory 2, acceptable-alternative 1), and a `null` pass threshold, so preflight refuses candidate runs until calibration sets it;
- the judge panel:
  - panel judge A is `claude-sonnet-5-5`; panel judges B and C are `gpt-6-luna`, run twice;
  - the decider is `claude-opus-5-5`;
  - unanimity settles a verdict, and anything short of it goes to the decider;
- `hidden/reference/`: the and-scene fixture's `create-and-scene` change at `ad667a9`;
- `hidden/inventory.json`: 24 mandatory, 48 acceptable-alternative, and 48 preference items;
- `versions.json`.

### Calibration set (`calibration/`, host-only, never staged into the sandbox)

Each synthetic input is a full change directory (proposal, specs, design, test plan) plus an expectations file with per-item expected verdicts. The set contains:
- **the reference**: the fixture's own change, expected to pass;
- **the restructured reference**:
  - renames, merges, splits, and rewords the reference;
  - replaces `acceptable-alternative` mechanisms with others that meet their intents;
  - keeps every requirement;
  - is expected to pass, losing no more items than the pinned tolerance;
- **degraded variants of both**, with mandatory items removed, contradictions planted, excluded scope added, and quality defects introduced. Each variant's expectations name the removed, contradicted, and added items;
- **real candidate definitions with maintainer-reviewed verdicts**, when available. None exist yet. Leave a documented slot, and do not invent maintainer verdicts.

Mark each degraded variant as **proposed** expected-fail. Marking which degraded variants are expected to fail is reserved to the maintainer (`HT-002`), so record your marks as proposals for that review.

### `--calibrate` mode

It judges each input at least three times, and reports:
- accuracy against expectations;
- stability across repeats;
- panel agreement and decider rate;
- each input's score.

It also re-runs the decider 3 times on the same recorded panel outputs, and reports the decider's ruling-flip rate separately from the panel's spread.

It reports a failure, naming the item and input, when:
- a removed mandatory item is not detected;
- the restructured reference loses more items than the pinned tolerance;
- repeated judging of one input differs by more than the pinned spread.

It proposes a pass threshold between the expected-fail variants and the expected-pass inputs.

Calibration:
- writes to its own output directory;
- records eval-owned usage;
- is never published;
- is never a prerequisite or runtime gate for a candidate run.

Pin the tolerance and spread limits in the rubric.

After `E2E-003` completes without failures:
- record the proposed threshold and weights, the expected-fail marks, and the calibration evidence (report path, input hashes, and judge profile) in `rubric.json`;
- mark the calibration as awaiting maintainer approval (`HT-002`);
- bump the rubric version and `versions.json`.

You do not perform `HT-002`. Report it as outstanding.

### Paid-run envelope

These limits are authorized by the test plan's Acceptance Testing Envelope.

- **Environment:**
  - this Mac with Docker;
  - Agent Runner from `/Users/paul/codagent/agent-runner/worktrees/external-user-mode` (with `--auth-only` and `--hide-source`);
  - the pinned Agent Skills checkout.
- **Credentials:**
  - Host Claude Code auth and `~/.codex/auth.json` are used read-only.
  - No GitHub credential enters any sandbox.
  - Host `gh` may be used read-only.
- **Budget:** about $150 in total, covering `E2E-003`, `E2E-001`, and `E2E-002`, plus at most one rerun of each after a fix. Stop and report before exceeding it.
- **Off limits:**
  - pushing to GitHub or any other non-test remote, in any repository. The one allowed push is candidate-run publication from the temporary agent-evals clone to its local bare remote, which `E2E-001` requires;
  - force-pushing;
  - modifying `~/.claude` or `~/.codex`;
  - the `and-scene` suite's code, rubric, and `results/**`;
  - the and-scene fixture repository;
  - publishing eval results to GitHub.

  For the publication step, run candidate runs from a **temporary clone of agent-evals whose upstream is a local bare remote**.
- **Quota:** if a lead family's quota is exhausted, report the gap. Do not swap families.
- **Defects:** a defect found in the suite is fixed here, with a test. A defect in Agent Runner is fixed on its `external-user-mode` branch in that worktree, committed but not pushed, with that repository's tests.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development for code changes.
- `npm run check` must pass. The paid runs are never part of `npm run check` or CI.

## Spec

### Requirement: Calibration
The `--calibrate` mode SHALL judge a calibration set, repeating each input at least three times, and report judge accuracy, stability, and the resulting score of each input. The calibration set SHALL include the fixture's own change; a restructured reference that renames, merges, splits, and rewords it and replaces `acceptable-alternative` mechanisms with others that meet their intents; degraded variants of both with items removed, contradictions planted, excluded scope added, and quality defects introduced; and, when available, real candidate definitions with maintainer-reviewed verdicts. Each synthetic input SHALL carry its expected per-item verdicts. Calibration SHALL report a failure when a removed `mandatory` item is not detected, when the restructured reference loses more items than the pinned tolerance, or when repeated judging of one input differs by more than the pinned spread. The maintainer SHALL mark which degraded variants are expected to fail, and the pass threshold SHALL lie between those and the definitions expected to pass. Calibration SHALL NOT be a prerequisite or runtime gate for a candidate run.

#### Scenario: Judge credits only the reference's wording
- **WHEN** the restructured reference scores below the reference by more than the pinned tolerance
- **THEN** calibration reports a failure that names the items the restructured reference lost

#### Scenario: Removed mandatory item goes undetected
- **WHEN** a degraded variant omits a `mandatory` item and the judge marks it `met`
- **THEN** calibration reports a failure that names the item and variant

#### Scenario: Threshold separates expected outcomes
- **WHEN** calibration completes without failures
- **THEN** every input expected to pass scores at or above the pass threshold and every degraded variant marked to fail scores below it

### Requirement: Versioned rubric and score contract
The suite SHALL score definitions under a versioned rubric that declares its components, criteria, points, gates, and pass threshold, and the version of the hidden-reference inventory it applies to. The score SHALL be out of 100 automated points with no human-review component, divided among requirement coverage, artifact quality, and fidelity. The rubric SHALL record the calibration evidence its weights and pass threshold were set from. The result SHALL report each component's score, every criterion's verdict and citations, every gate's outcome, and the rubric version.

#### Scenario: Result reports the score breakdown
- **WHEN** a complete run is scored
- **THEN** the result reports the total, each component's score, every criterion's verdict with citations, every gate's outcome, and the rubric version

#### Scenario: Rubric applies to a different inventory version
- **WHEN** the rubric's declared inventory version differs from the pinned inventory
- **THEN** preflight fails before any model call and identifies the mismatch

This task delivers recording the calibration evidence that the weights and pass threshold were set from, as a proposal pending maintainer approval.

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

This task delivers `--calibrate`. It is never a prerequisite or runtime gate for a candidate run.

## Test Plan

- `E2E-003` (Calibration): run `run.sh --calibrate` with the committed calibration set, the pinned judge profile, and host Claude and Codex auth.
  - Assert:
    - each input is judged at least three times;
    - the report gives accuracy, stability, panel agreement, decider rate, and each input's score;
    - the decider is re-run 3 times on the same recorded panel outputs, and its ruling-flip rate is reported separately;
    - the report names any undetected removed mandatory item, any restructured-reference loss beyond tolerance, or any spread beyond the pinned limit;
    - it proposes a pass threshold between the expected-fail variants and the expected-pass inputs.

  Run it before `E2E-001` and `E2E-002`.
- `E2E-001` (Claude-lead candidate run): run `run.sh --run-agent` with lead `claude` and crosscheck `codex`, from a temporary agent-evals clone whose upstream is a local bare remote, using the calibrated rubric. Let it finish, then run `--rescore-from` on the run directory.
  - Assert:
    - `evaluation_status` is `complete`;
    - all four artifacts are collected with hashes, and the gates are evaluated;
    - the contamination audit is clean, with a transcript for every invocation in `run-metrics.json`;
    - `result.json`, `report.html`, the conversation, the discovery ledger, and the evidence manifest exist;
    - the result reports panel verdicts and decider rulings;
    - the result commit lands on the local bare remote;
    - the rescore reproduces the contamination outcome and gate results without Docker.
- `E2E-002` (Codex-lead run, interrupted and resumed): set up as for `E2E-001`, with lead `codex` and crosscheck `claude`. Stop the sandbox after the first answered `define.proposal` exchange, then run `run.sh --resume` with the same profiles.
  - Assert:
    - only one Agent Runner run ID exists;
    - no exchange already recorded in `conversation.jsonl` is answered by a new simulated-user call;
    - the workflow stops after `define`, and the run completes;
    - resuming with a different lead profile is refused.
- Unit and integration tests, in `npm run check`, with stub judges, for the `--calibrate` aggregation:
  - accuracy, stability, the flip rate, the failure conditions, and the threshold proposal;
  - calibration output is never published;
  - candidate runs never require calibration output.

## Done When

- PR #81 was confirmed merged. Otherwise, the task is reported blocked.
- `calibration/` holds the reference, the restructured reference, and the degraded variants, each with expected per-item verdicts and proposed expected-fail marks.
- `run.sh --calibrate` works, and its aggregation is covered by tests in `npm run check`.
- `E2E-003` completed without failures. Its proposed threshold, weights, and calibration evidence are recorded in `rubric.json`, marked pending maintainer approval, with the rubric version and `versions.json` bumped.
- `E2E-001` and `E2E-002` pass under the envelope above. Their run directories are reported, and nothing was pushed to GitHub.
- Total paid spend is reported and stayed within about $150.
- The final report says that `HT-001` (starting-repository review) and `HT-002` (threshold and weights approval) remain for the maintainer.
- `npm run check` passes.
