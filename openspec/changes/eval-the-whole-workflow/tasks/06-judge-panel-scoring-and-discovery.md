# Task: Score definitions with a cross-family judge panel, gates, disclosure audit, and discovery ledger

## Goal

Turn a collected, uncontaminated definition into a score. This task builds:
- the versioned rubric, generated from the inventory;
- the hard gates;
- host-side eval-owned judges: a three-judge cross-family panel, plus a decider for anything short of consensus;
- the coverage, fidelity, and artifact-quality jobs;
- the disclosure audit, which neutralizes leaked items;
- the non-scoring requirement-discovery ledger;
- the deterministic scorer that produces `definition_verdict`.

Coverage of the hidden requirements, judged by intent rather than wording, is the eval's primary measure. The panel-and-decider rule, strict schemas, and citation validation keep that judgment stable and auditable.

## Background

### Blocking prerequisite: agent-evals PR #81

The judge mechanics are copied from the and-scene suite only after agent-evals PR #81 ("fix: make and-scene judging and scoring robust") merges. Before doing anything else, run:

```sh
gh pr view 81 --repo Codagent-AI/agent-evals --json state
```

- If it is `MERGED`, fetch `origin/main` and copy from the updated `evals/agent-runner/and-scene/lib/`. That copy includes majority voting, capacity backoff, zero-token rejection records, strict schemas, citation validation, and protocol-versioned judge caches.
- If it is not merged, stop and report this task as blocked on PR #81. Do not copy the pre-#81 versions, and do not poll indefinitely.

### Context

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Collection, gates, and judging", "Rubric", "Reused and-scene code", and Decisions 7, 11, and 15;
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-002` (judge half) and `INT-003`.

State of the suite `evals/agent-runner/and-scene-define/`. Use these; if one is missing, stop and report which:
- `hidden/inventory.json`: 120 items (24 mandatory, 48 acceptable-alternative, 48 preference), each with `id`, `area`, `kind`, `title`, `statement`, `sources[]` (with `document`, `heading`, and `quote`), `class`, and `intent`;
- `hidden/reference/`: the reference change as the simulated user saw it;
- `hidden/simulated-user-policy.md`;
- `versions.json`;
- the run controller, with its ordered phases, checkpoints, and outcomes. The gate-and-judging, disclosure-audit, and discovery phases register after the contamination audit;
- `<run>/collected/` with its hashes, and `<run>/conversation.jsonl`, whose exchanges carry `step`, `step_id`, `attempt`, `turn`, `agent_message`, `reply`, and `reply_type`;
- `<run>/phases/eval-owned-usage.jsonl`;
- preflight, with a hook for rubric checks;
- the simulated-user invoker's strict-schema walking assertion in `test/and-scene-define-invokers.test.mjs`. Reuse it for every judge schema.

### Rubric (`rubric.json`)

- Declares its version, and the inventory version it applies to.
- Components and points: coverage 60, artifact quality 25, fidelity 15. These are provisional until calibration.
- Item weights: mandatory 2, acceptable-alternative 1. Preference items get no criterion.
- Verdict values: `met` 1, `partial` 0.5, `missing` 0.
- Leaked items are dropped from both earned and possible coverage, and coverage is scaled to its 60 points over the remaining items.
- Also declares the fidelity deductions, quality criteria (testable scenarios, cross-artifact consistency, design decisions with rationale, test-plan coverage of requirements), gates, the pass threshold, and the calibration evidence. The threshold is `null` until calibration; record it that way.
- `scripts/build-rubric.mjs` generates the coverage criteria from `inventory.json`. The generated file is committed, and a test fails when the two diverge.
- Record the rubric in `versions.json`.
- Wire preflight's rubric hook:
  - the rubric's inventory version must match the pinned inventory;
  - a candidate run is refused while the threshold is `null`, with a message that calibration must set it first.

### Gates

- The four artifacts are present: `proposal.md`, at least one `specs/**/spec.md`, `design.md`, and `test-plan.md`. Each absence produces a gate record, for example `gate:required-artifact:design`.
- `openspec validate add-presentation-skill --strict` passes on a scratch copy of `collected/`.

A gate failure gives `evaluation_status=complete` with `definition_verdict=fail`, and every component is still judged on what exists, as diagnostics.

### Judges (host-side, under one pinned judge profile)

| Role | Model | Invocation |
|---|---|---|
| panel judge A | `claude-sonnet-5-5`, high effort | `claude -p` with `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, and `--json-schema`; the job's inputs are inlined in the prompt |
| panel judges B and C | `gpt-6-luna`, high effort; two independent calls | `codex exec --sandbox read-only --json --output-schema`; a private `CODEX_HOME` containing only a copy of `auth.json`, deleted afterward; the working directory is a scratch copy of only that job's inputs |
| decider | `claude-opus-5-5`, high effort | as panel judge A |

- Copy the following into `and-scene-define/lib/` and adapt them:
  - `judge-invoker.mjs`, made host-side with the private `CODEX_HOME`, plus a Claude `claude -p` invoker for panel judge A and the decider;
  - the citation and schema checks from `judge-jobs.mjs`.
- Every schema sent is strict-mode valid: `additionalProperties: false` on every object, and every property listed in `required`.
- An `invalid_json_schema` response is a non-retryable harness failure.
- A model-capacity response backs off without using up an attempt.
- A rejected call still writes a zero-token usage record to `phases/eval-owned-usage.jsonl`.
- **Jobs:**

| Job | Inputs | Output |
|---|---|---|
| coverage × inventory area | collected artifacts; that area's mandatory and acceptable-alternative items (statement, intent, class, and each source quote with its reference heading) | per-item `met` / `partial` / `missing` with artifact citations |
| fidelity | collected artifacts; mandatory and acceptable-alternative items; conversation | contradictions citing artifact and item or exchange; added-scope list |
| artifact quality | collected artifacts only | the four quality criteria with citations |
| discovery | conversation; mandatory and acceptable-alternative items | per-item asked yes/no, with a cited exchange when yes |
| disclosure audit | conversation; the reference (as the simulated user saw it); policy; mandatory and acceptable-alternative items | flags citing exchanges; inventory items named per over-disclosure flag |

- **Panel rule** (coverage, fidelity, quality, and disclosure audit):
  - All three panel judges run each job independently, on identical inputs.
  - Only unanimity settles a verdict. A fidelity deduction stands without the decider only when all three cite the same contradicted item or exchange; no deduction stands when none of the three finds one.
  - Every non-consensus item or criterion is batched per job to the decider. The decider sees the inputs and all three verdicts with citations, labelled only "A", "B", and "C", and returns the final verdict with its own citation.
  - A job with no disagreement makes no decider call.
  - The result records panel verdicts, every disagreement, and every ruling.
- **Disclosure audit:**
  - An item is leaked when all three panel judges name it in an over-disclosure flag, and not leaked when none does; otherwise the decider rules.
  - Leaked items are excluded from coverage and reported as `leaked`.
  - Inconsistent-withholding and contradiction flags are report-only.
  - A run with flags is still scored.
- **Discovery** is non-scoring: a single call to the decider model.
- **Citations:**
  - `met` and `partial` verdicts, quality findings, and fidelity deductions cite a collected file and line range. Fidelity deductions also cite an item or exchange identity.
  - A `missing` verdict cites the list of collected files inspected. Where the artifact the item would belong in is absent, it cites the gate's absence record instead.
  - Discovery and disclosure flags cite an exchange identity.
  - Every citation must resolve to a collected file and line range, a collected file name, a gate record, or an exchange identity.
  - A failing output, meaning malformed, missing a criterion, or uncited, is retried up to 2 times and is never scored. A job that still fails ends the run `evaluation-harness-failed`.
- Pin, in the rubric, quality and fidelity guidance with concrete pass and fail examples. Two rules keep judges from rewarding the reference's shape:
  - an artifact organized differently from the reference is never marked down for structure;
  - an artifact that records an open question never scores below one that silently omits it.
- Each judge job is its own checkpointed unit, so resume reruns only unfinished jobs.
- **Scorer:** deterministic code over the validated verdicts. Discovery outcomes (`discovered`, `inferred`, `missed`, `asked-not-captured`, and `leaked`) are computed in code from the asked decisions and the coverage verdicts.
  - `definition_verdict` is `pass` only when every gate passes and the total meets the threshold.
  - Write scores, verdicts, citations, gates, panel records, audit flags, leaked items, added scope, and the discovery ledger to files under `<run>/judges/`, `<run>/audits/`, and `<run>/discovery/`, for result assembly.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development.
- Tests in `test/*.test.mjs` run through `npm run check`; add `node --check` entries for new modules and scripts.
- Do not modify the `and-scene` suite.
- No paid model calls in this task.

## Spec

### Requirement: Versioned rubric and score contract
The suite SHALL score definitions under a versioned rubric that declares its components, criteria, points, gates, and pass threshold, and the version of the hidden-reference inventory it applies to. The score SHALL be out of 100 automated points with no human-review component, divided among requirement coverage, artifact quality, and fidelity. The rubric SHALL record the calibration evidence its weights and pass threshold were set from. The result SHALL report each component's score, every criterion's verdict and citations, every gate's outcome, and the rubric version.

#### Scenario: Result reports the score breakdown
- **WHEN** a complete run is scored
- **THEN** the result reports the total, each component's score, every criterion's verdict with citations, every gate's outcome, and the rubric version

#### Scenario: Rubric applies to a different inventory version
- **WHEN** the rubric's declared inventory version differs from the pinned inventory
- **THEN** preflight fails before any model call and identifies the mismatch

### Requirement: Gates
A definition SHALL fail through a hard gate when the collected change lacks a proposal, specifications, a design, or a test plan, or when `openspec validate` fails on the collected change. A gate failure SHALL make `definition_verdict` `fail` regardless of score, and every component SHALL still be judged on the artifacts that exist and reported as diagnostics.

#### Scenario: Validation fails
- **WHEN** `openspec validate` reports an error for the collected change
- **THEN** `definition_verdict` is `fail` through the validation gate
- **AND** the component scores are still reported as diagnostics

### Requirement: Requirement coverage
The rubric SHALL contain one coverage criterion for each `mandatory` and `acceptable-alternative` inventory item and none for `preference` items. Each criterion SHALL be judged `met`, `partial`, or `missing`, where `partial` means the artifacts commit to the item's intent but leave out or weaken part of what the item requires: a `mandatory` item against its statement, and an `acceptable-alternative` item against its intent only, so a different mechanism that achieves the intent is `met`. An item SHALL count as captured only where an artifact commits to it in a specification requirement or scenario, a design decision, or a proposal scope statement; a mention only in the test plan or in passing SHALL NOT count. A `scope-exclusion` item SHALL be `met` when the definition does not include the excluded scope, without requiring an explicit exclusion statement. An item the disclosure audit marks leaked SHALL be excluded from both the earned and the possible coverage points and reported as `leaked`. Coverage SHALL be the primary component.

#### Scenario: Alternative mechanism meets the intent
- **WHEN** a definition specifies a different mechanism that achieves an `acceptable-alternative` item's intent
- **THEN** that criterion is `met`

#### Scenario: Item appears only in the test plan
- **WHEN** a requirement appears only as a test-plan case with no corresponding specification, design decision, or scope statement
- **THEN** that criterion is not `met`

#### Scenario: Excluded scope is simply absent
- **WHEN** a definition neither includes nor mentions an excluded scope item
- **THEN** that `scope-exclusion` criterion is `met`

### Requirement: Fidelity
The fidelity component SHALL deduct for a definition that contradicts a `mandatory` or `acceptable-alternative` inventory item, or that contradicts an answer the simulated user gave in the run's conversation, including an answer about a `preference` item. Each deduction SHALL cite both the artifact location and the contradicted item or conversation exchange. Scope a definition adds beyond the inventory SHALL NOT be deducted unless it includes a `mandatory` scope-exclusion item's scope or contradicts the simulated user.

#### Scenario: Definition ignores the user's answer
- **WHEN** the simulated user answered a question and the definition specifies the opposite
- **THEN** fidelity is deducted, citing the artifact location and the exchange

#### Scenario: Reasonable added scope
- **WHEN** a definition adds behavior the inventory does not contain, which neither falls under a scope exclusion nor contradicts the simulated user
- **THEN** no score is deducted for it

### Requirement: Added-scope diagnostic
The report SHALL list scope the definition adds beyond the inventory, with citations, as a non-scoring diagnostic.

#### Scenario: Added scope is listed
- **WHEN** a definition specifies behavior the inventory does not contain
- **THEN** the report lists it as added scope and it does not change the score

### Requirement: Artifact quality
The artifact-quality component SHALL judge the definition independently of the hidden reference: specification scenarios that are observable and testable, consistency across the proposal, specifications, design, and test plan, design decisions stated with their rationale, and a test plan that covers the specified requirements. Artifact-quality judges SHALL NOT receive the inventory or the hidden reference.

#### Scenario: Quality judging is reference-independent
- **WHEN** an artifact-quality judge job runs
- **THEN** its input contains the collected artifacts and no inventory item or hidden-reference content

#### Scenario: Untestable scenario
- **WHEN** a specification scenario's outcome cannot be observed or tested
- **THEN** the testable-scenarios criterion is not fully met and the verdict cites that scenario

### Requirement: Eval-owned judges
Judging SHALL be performed by eval-owned judges under a pinned judge profile, split into focused jobs for coverage by inventory area, fidelity, and artifact quality. Each scoring job SHALL be judged independently by a panel of three judges, each with a pinned CLI, model, and effort, drawn from at least two model families. Only a unanimous panel verdict SHALL stand on its own; a fidelity deduction SHALL stand on its own only when all three panel judges cite the same contradicted item or exchange. Every item or criterion without consensus SHALL be decided by a pinned decider judge that receives the job's inputs and all three panel verdicts with their citations, without being told which model gave which. The result SHALL record the panel verdicts, each non-consensus item, and the decider's ruling. Coverage and fidelity judges SHALL receive the collected artifacts, the inventory items they judge with their source quotes, and, for fidelity, the simulated-user conversation. Citations SHALL depend on the verdict: a `met` or `partial` coverage verdict, an artifact-quality finding, and a fidelity deduction SHALL cite artifact locations; a `missing` verdict SHALL cite the collected artifacts the judge inspected, and, where an artifact the item would belong in is absent, the gate's record of that absence. A judge job whose output is malformed, omits a criterion, or gives a verdict without the citation its verdict requires SHALL be retried and SHALL NOT be scored from that output; a job that still fails after its retries SHALL fail the run as `evaluation-harness-failed`.

#### Scenario: Panel agrees
- **WHEN** all three panel judges mark a coverage item `met`
- **THEN** the item is `met` and no decider call is made for it

#### Scenario: Panel disagrees
- **WHEN** two panel judges mark a coverage item `met` and the third marks it `missing`
- **THEN** the decider receives all three verdicts and citations, its ruling is the item's verdict, and the result records the disagreement and ruling

#### Scenario: Verdict lacks a citation
- **WHEN** a judge job returns a `met` verdict with no artifact citation
- **THEN** the job is retried and its uncited output is not scored

#### Scenario: Missing verdict for an absent artifact
- **WHEN** the collected change has no design and a judge marks a design-only item `missing`, citing the inspected artifacts and the gate's absence record
- **THEN** the verdict is accepted without a retry and the item scores as `missing`

### Requirement: Disclosure audit
After the define workflow, eval-owned judges SHALL audit every simulated-user reply against the agent turn it answered and the conversation before it, flagging over-disclosure, inconsistent withholding, and contradiction of an earlier answer. Each flag SHALL cite the exchange. Each over-disclosure flag SHALL name the `mandatory` and `acceptable-alternative` inventory items the reply disclosed without being asked. The audit SHALL use the same three-judge panel and decider rule as scoring jobs: an item SHALL be leaked when all three panel judges name it in an over-disclosure flag, SHALL NOT be leaked when none does, and SHALL otherwise be decided by the decider. A leaked item SHALL be excluded from that run's coverage score and SHALL be reported as `leaked` in place of its coverage verdict. Inconsistent-withholding and contradiction flags SHALL be report-only. Every flag and every leaked item SHALL be shown in the result and report, and a run with flags SHALL still be scored and published.

#### Scenario: Over-disclosure is flagged
- **WHEN** a reply states a requirement the agent's turn did not ask about
- **THEN** the audit flags over-disclosure, cites that exchange, and names the disclosed inventory item
- **AND** the run is still scored and the flag appears in the result and report

#### Scenario: Leaked item does not earn coverage
- **WHEN** the audit marks a `mandatory` item leaked and the definition captures that item
- **THEN** the item contributes neither earned nor possible coverage points and is reported as `leaked`

#### Scenario: Panel disagrees about a leak
- **WHEN** two panel judges name an item in an over-disclosure flag and the third does not
- **THEN** the decider rules whether the item is leaked and the result records the disagreement and ruling

#### Scenario: Withholding flag does not change the score
- **WHEN** the audit flags only inconsistent withholding
- **THEN** the score is unchanged and the flag appears in the result and report

#### Scenario: Clean conversation
- **WHEN** no reply exceeds, withholds, or contradicts relative to the policy
- **THEN** the result reports the disclosure audit as clean

### Requirement: Discovery ledger
For each `mandatory` and `acceptable-alternative` inventory item, the suite SHALL record whether any agent turn in the simulated-user conversation asked about it, citing the exchange, and SHALL combine that with the item's coverage verdict into one outcome:

| Outcome | Asked | Coverage verdict |
|---|---|---|
| `discovered` | Yes | `met` or `partial` |
| `inferred` | No | `met` or `partial` |
| `missed` | No | `missing` |
| `asked-not-captured` | Yes | `missing` |
| `leaked` | Any | `leaked` (disclosed without being asked) |

The captured part SHALL come from the coverage verdicts, not from a second judgment.

#### Scenario: Requirement found by asking
- **WHEN** the agent asked about an item and its coverage verdict is `met`
- **THEN** the ledger records `discovered` and cites the exchange

#### Scenario: Requirement never raised
- **WHEN** no agent turn asked about an item and its coverage verdict is `missing`
- **THEN** the ledger records `missed`

### Requirement: Discovery judge
An eval-owned judge with a pinned profile SHALL decide the asked part from the simulated-user conversation and the inventory items. An `asked` decision without a cited exchange SHALL be retried and SHALL NOT be recorded from that output.

#### Scenario: Asked without a citation
- **WHEN** the discovery judge marks an item asked without citing an exchange
- **THEN** the job is retried and the uncited decision is not recorded

### Requirement: Non-scoring diagnostic
The discovery ledger SHALL NOT change any score, gate, or `definition_verdict`. The result and report SHALL show the count of each outcome and each item's outcome, the ledger SHALL be included in the published result, and `--rescore-from` SHALL rebuild it.

#### Scenario: Ledger does not affect the verdict
- **WHEN** two runs have identical coverage, fidelity, and quality verdicts but different discovery outcomes
- **THEN** they receive the same score and `definition_verdict`

This task computes the ledger and keeps it out of every score, gate, and verdict. Showing it in the report, publishing it, and rebuilding it during a rescore belong to result assembly.

### Requirement: Evaluation status and definition verdict
The result SHALL report `evaluation_status` as exactly one of `complete`, `definition-workflow-failed`, `contaminated`, or `evaluation-harness-failed`, and `definition_verdict` as exactly one of `pass`, `fail`, or `unavailable`. A completed define workflow whose collected artifacts are missing a required artifact or fail `openspec validate` SHALL be `complete` with `definition_verdict=fail` through a hard gate, and any artifacts that exist SHALL still be judged as diagnostics. A contaminated run SHALL have `definition_verdict=unavailable` and no score. Workflow and harness failures SHALL have `definition_verdict=unavailable` and SHALL NOT be reported as a definition failure.

#### Scenario: Definition passes
- **WHEN** gates pass and the score meets the pass threshold
- **THEN** `evaluation_status` is `complete` and `definition_verdict` is `pass`

#### Scenario: Required artifact is missing
- **WHEN** the define workflow completes but the collected change lacks a design
- **THEN** `evaluation_status` is `complete` and `definition_verdict` is `fail` through the required-artifact gate
- **AND** the proposal, specifications, and test plan that exist are still judged and reported as diagnostics

#### Scenario: Run is contaminated
- **WHEN** the contamination audit finds access to hidden material
- **THEN** `evaluation_status` is `contaminated`, `definition_verdict` is `unavailable`, and no score is reported

#### Scenario: Workflow fails
- **WHEN** Agent Runner fails or the elapsed-time limit is reached before define completes
- **THEN** `evaluation_status` is `definition-workflow-failed` and `definition_verdict` is `unavailable`

This task delivers the "Definition passes" and "Required artifact is missing" scenarios.

### Requirement: Preflight
Before any model call, the harness SHALL verify a clean Agent Runner checkout that provides the external-user mode for interactive steps; a clean Agent Skills checkout containing every `codagent:*` skill named by the define workflow and the workflows it invokes; Docker; authentication for the selected evaluated CLIs and for the pinned simulated-user and judge CLIs; every pinned input matching its recorded hash; a rubric that records a calibrated pass threshold; and an unused run directory unless resuming. Any failed check SHALL stop the run with `evaluation_status=evaluation-harness-failed` and SHALL identify the check.

#### Scenario: Runner lacks external-user mode
- **WHEN** the configured Agent Runner checkout does not provide the external-user mode
- **THEN** preflight fails before any model call and identifies the missing Runner capability

#### Scenario: Rubric is not yet calibrated
- **WHEN** a candidate run starts and the pinned rubric records no calibrated pass threshold
- **THEN** preflight fails before any model call and states that calibration must set the threshold first

#### Scenario: Pinned input hash mismatch
- **WHEN** the starting snapshot, hidden reference, or inventory does not match its pinned hash
- **THEN** preflight fails before any model call and identifies the mismatched input

This task delivers the "Rubric is not yet calibrated" scenario, and the rubric's inventory-version check.

### Requirement: Durable checkpoints and resume
The harness SHALL checkpoint every phase and every independently verifiable unit, including each judge job and each audit, with its input provenance and output hashes. On resume in the same run directory it SHALL verify the recorded run identity, series identity, and candidate, including the profiles; reuse every unit it can prove complete; resume an inactive unfinished Agent Runner run with `--resume <run-id>`; and SHALL NOT start a duplicate Agent Runner run. A provenance mismatch SHALL stop the resume with an explicit error.

#### Scenario: Resume after a judge failure
- **WHEN** a run stopped after some judge jobs completed
- **THEN** resume reruns only the unfinished judge jobs and reuses the completed ones

#### Scenario: Interrupted workflow resumes
- **WHEN** the recorded Agent Runner run is inactive and unfinished
- **THEN** the harness invokes `agent-runner --resume` with that run identifier and does not start another run

This task delivers "Resume after a judge failure": each judge job is a checkpointed unit.

## Test Plan

- `INT-002` (Eval-owned CLI invocation contracts), judge portion: extend `test/and-scene-define-invokers.test.mjs`, in `npm run check`.
  - Stub `claude` and `codex` executables record argv and environment, and replay recorded stream-json and `--json` output.
  - Assert:
    - the Claude judges (panel A and the decider) receive `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, and `--no-session-persistence`;
    - a stray `tool_use` is rejected;
    - Codex judges run with `--sandbox read-only` and a private `CODEX_HOME` that holds only `auth.json` and is deleted afterward;
    - every judge schema sent is strict-mode valid;
    - `invalid_json_schema` fails the run without retrying.
- `INT-003` (Judge panel to score): `test/and-scene-define-scoring.test.mjs`, in `npm run check`.
  - Setup: a collected definition fixture with known per-item expectations, plus canned panel outputs:
    - unanimous;
    - 2-to-1;
    - a three-way split;
    - fidelity citations that don't match;
    - one uncited `met`;
    - one rejected call;
    - a collected change with no design, where a design-only item is `missing` citing the inspected files and `gate:required-artifact:design`;
    - disclosure-audit outputs where one mandatory item is named by all three, one by two of three, and a withholding flag by all three.
  - Action: run the scoring phase.
  - Assert:
    - unanimous items make no decider call;
    - every non-consensus item reaches the decider, with verdicts labelled only A, B, and C;
    - the uncited verdict is retried and never scored;
    - the `missing` verdict for the absent design is accepted without a retry, and the run stays `complete` with `definition_verdict=fail`;
    - the unanimously leaked item, and the decider-ruled item if ruled leaked, are dropped from earned and possible coverage, reported `leaked` in the result and the discovery ledger, and coverage is scaled over the remaining items;
    - the withholding flag changes no score;
    - a rejected call writes a zero-token usage record;
    - the result records panel verdicts, non-consensus items, and rulings;
    - component scores, gates, and the four discovery outcomes match expectations.
- Also test:
  - the `build-rubric.mjs` divergence check;
  - the preflight rubric checks;
  - that two runs with identical verdicts and different discovery outcomes get the same score and verdict;
  - that a judge-failure resume reruns only unfinished jobs.

## Done When

- PR #81 was confirmed merged before any judge code was copied. Otherwise, the task is reported blocked and nothing was copied.
- `rubric.json` (generated, with a `null` threshold), `scripts/build-rubric.mjs`, the judge invokers, the jobs, the panel and decider, the disclosure audit, discovery, gates, and the scorer exist under `evals/agent-runner/and-scene-define/`. They are registered as lifecycle phases after the contamination audit, and each job is checkpointed.
- Preflight refuses a candidate run with an uncalibrated rubric or a mismatched inventory version.
- `INT-002` (judge portion) and `INT-003` pass, with no paid model calls.
- `npm run check` passes, with the new modules added to it.
