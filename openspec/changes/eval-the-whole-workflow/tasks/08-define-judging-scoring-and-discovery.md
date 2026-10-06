# Task: Score definitions on the shared cross-family panel, with anchors, gates, disclosure audit, and discovery ledger

## Goal

Turn a collected, uncontaminated definition into a score. This task builds:
- the versioned rubric, generated from the inventory;
- the hard gates;
- the verdict anchors for every graded inventory item;
- host-side eval-owned judges on the shared cross-family panel (`evals/lib/panel-judging/`): one Claude judge, two Codex samples, and a Claude decider;
- the coverage, fidelity, and artifact-quality jobs;
- the disclosure audit, which neutralizes leaked items;
- the non-scoring requirement-discovery ledger;
- the deterministic scorer that produces `definition_verdict`.

Coverage of the hidden requirements, judged by intent rather than wording, is the eval's primary measure. Anchors, the cross-family settlement rule, strict schemas, and citation validation keep that judgment stable and auditable.

## Background

### Prerequisite: the shared panel-judging module

Tasks 06 and 07 built `evals/lib/panel-judging/`:
- `codex-invoker.mjs` and `claude-invoker.mjs`, each with a host mode;
- `protocol.mjs`, with strict schemas, citation validation, closed-world audits, targeted checks, and the scope rule;
- `panel.mjs`, with `runPanelJob`, the cross-family settlement, and `PANEL_PROTOCOL = 'cross-family-panel-v1'`.

Use them; do not copy judge code into this suite. If `runPanelJob` or the Claude invoker's host mode is missing, stop and report which.

### Context

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Collection, gates, and judging", "Rubric", "Shared panel judging", and Decisions 7, 11, 15, and 16;
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-002` (judge half) and `INT-003`.

State of the suite `evals/agent-runner/and-scene-define/`. Use these; if one is missing, stop and report which:
- `hidden/inventory.json`: 120 items (24 mandatory, 48 acceptable-alternative, 48 preference), each with `id`, `area`, `kind`, `title`, `statement`, `sources[]` (with `document`, `heading`, and `quote`), `class`, and `intent`;
- `scripts/check-inventory.mjs`, the inventory check;
- `hidden/reference/`: the reference change as the simulated user saw it;
- `hidden/simulated-user-policy.md`;
- `versions.json`;
- the run controller, with its ordered phases, checkpoints, and outcomes. The gate-and-judging, disclosure-audit, and discovery phases register after the contamination audit;
- `<run>/collected/` with its hashes, and `<run>/conversation.jsonl`, whose exchanges carry `step`, `step_id`, `attempt`, `turn`, `agent_message`, `reply`, and `reply_type`;
- `<run>/phases/eval-owned-usage.jsonl`;
- preflight, with a hook for rubric checks;
- the simulated-user invoker's strict-schema walking assertion in `test/and-scene-define-invokers.test.mjs`. Reuse it for every judge schema.

### Verdict anchors

- Add `anchors: { met, partial, missing }` to each of the 72 `mandatory` and `acceptable-alternative` items in `hidden/inventory.json`.
  - Draft each anchor from the item's statement, intent, and source quotes, in the fixture's own words wherever possible.
  - Write `acceptable-alternative` anchors against the intent, so another mechanism that achieves it is `met`.
  - `partial` names which part of the item may be left out or weakened while the intent still holds.
  - `missing` names what an artifact that does not commit to the item looks like, including a contradiction of the item.
- Add `anchors_review: null` at the inventory's top level. A maintainer records `{ reviewer, date, inventory_version }` there during `HT-003`. Do not fill it in yourself.
- Bump the inventory version, and update `versions.json` and the inventory's recorded hashes.
- Extend `scripts/check-inventory.mjs`: it fails when a graded item lacks any anchor, and when a `preference` item has anchors.
- Wire preflight to refuse a candidate run while `anchors_review` is null or names another inventory version, stating that the anchors need review.

### Rubric (`rubric.json`)

- Declares its version, and the inventory version it applies to.
- Components and points: coverage 60, artifact quality 25, fidelity 15. These are provisional until calibration.
- Item weights: mandatory 2, acceptable-alternative 1. Preference items get no criterion.
- Verdict values: `met` 1, `partial` 0.5, `missing` 0.
- Leaked items are dropped from both earned and possible coverage, and coverage is scaled to its 60 points over the remaining items.
- Each coverage criterion carries its item's anchors.
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
| Claude-family panel judge | `claude-sonnet-5-5`, high effort | shared Claude invoker, host mode: `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, and `--json-schema`; the job's inputs are inlined in the prompt |
| two Codex-family panel judges | `gpt-6-luna`, high effort; two independent calls | shared Codex invoker in host mode: `codex exec --sandbox read-only --json --output-schema`, with a private `CODEX_HOME` holding only a copy of `auth.json`, deleted afterward. The working directory is a scratch copy of only that job's inputs. If the shared Codex invoker has no private-`CODEX_HOME` option yet, add one there, off by default, with tests; do not change its default behavior |
| decider and targeted checks | `claude-opus-5-5`, high effort | as the Claude-family panel judge |

Pin this profile in one constant, recorded with the judge authority and in the series identity together with `PANEL_PROTOCOL`.

- Every schema sent is strict-mode valid. The shared protocol already enforces `invalid_json_schema` failing fast, capacity backoff, and zero-token rejection records, all written to `phases/eval-owned-usage.jsonl`.
- Every judge prompt includes the scope rule, adapted from the shared `JUDGE_SCOPE_RULE` to definitions: judge only what the cited artifacts establish; add no requirement the item and its anchors do not state; give undefined terms their plain meaning in the reference. For each judged item, the prompt also includes the statement or intent, every source quote with its heading, and the anchors.
- **Jobs:**

| Job | Inputs | Output |
|---|---|---|
| coverage × inventory area | collected artifacts; that area's mandatory and acceptable-alternative items (statement, intent, class, anchors, and each source quote with its reference heading) | per-item `met` / `partial` / `missing` with artifact citations |
| fidelity | collected artifacts; preference items; conversation | contradictions of the simulated user's answers about preference items or matters outside the inventory, citing artifact and exchange; added-scope list |
| artifact quality | collected artifacts only | the four quality criteria with citations |
| discovery | conversation; mandatory and acceptable-alternative items | per-item asked yes/no, with a cited exchange when yes |
| disclosure audit | conversation; the reference (as the simulated user saw it); policy; mandatory and acceptable-alternative items | flags citing exchanges; inventory items named per over-disclosure flag |

- **Panel rule** (coverage, fidelity, quality, and the disclosure audit) uses `runPanelJob`:
  - verdicts `met`, `partial`, and `missing`, ordered by credit;
  - no per-judge audit;
  - `validateCitations` enforces the citation rules below.
- Settlement is the shared cross-family rule:
  - a unanimous verdict stands;
  - a two-to-one verdict that includes the Claude-family judge stands, unless the dissent is backed. A backed dissent is a higher verdict with validated artifact citations, and gets a targeted check by the decider;
  - a Codex-only majority, or a three-way split, goes to the decider, which must rule a verdict the panel gave.
- **Fidelity deductions:** judges agree when they cite the same exchange. A deduction cited by the Claude-family judge and a Codex-family judge stands. One cited only by both Codex-family judges goes to the decider. One cited by a single judge with valid citations is a backed dissent.
- **Disclosure audit:**
  - Each item's leak settles the same way: the Claude-family judge plus a Codex-family judge naming it means leaked; only both Codex-family judges naming it goes to the decider; a single judge naming it with a valid exchange citation is a backed dissent.
  - Leaked items are excluded from coverage and reported as `leaked`.
  - Inconsistent-withholding and contradiction flags are report-only.
  - A run with flags is still scored.
- **Discovery** is non-scoring: a single call to the decider model.
- **Citations:**
  - `met` and `partial` verdicts, quality findings, and fidelity deductions cite a collected file and line range.
  - A `missing` verdict cites the list of collected files inspected. Where the artifact the item would belong in is absent, it cites the gate's absence record instead.
  - Fidelity deductions cite an exchange identity, besides the line range.
  - Discovery and disclosure flags cite an exchange identity.
  - Every citation must resolve to a collected file and line range, a collected file name, a gate record, or an exchange identity.
  - A failing output, meaning malformed, missing a criterion, or uncited, is retried up to 2 times and is never scored. A job that still fails ends the run `evaluation-harness-failed`.
- Pin, in the rubric, quality and fidelity guidance with concrete pass and fail examples. Two rules keep judges from rewarding the reference's shape:
  - an artifact organized differently from the reference is never marked down for structure;
  - an artifact that records an open question never scores below one that silently omits it.
- Rubric guidance states only what the reference states. Each omission belongs to one criterion: a contradicted graded item is a coverage verdict, never also a fidelity deduction.
- Each judge job is its own checkpointed unit, so resume reruns only unfinished jobs.
- **Scorer:** deterministic code over the validated verdicts. Discovery outcomes (`discovered`, `inferred`, `missed`, `asked-not-captured`, and `leaked`) are computed in code from the asked decisions and the coverage verdicts.
  - `definition_verdict` is `pass` only when every gate passes and the total meets the threshold.
  - Write scores, verdicts, citations, gates, panel records (votes, bases, checks, and rulings), audit flags, leaked items, added scope, and the discovery ledger to files under `<run>/judges/`, `<run>/audits/`, and `<run>/discovery/`, for result assembly.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development.
- Tests in `test/*.test.mjs` run through `npm run check`; add `node --check` entries for new modules and scripts.
- Do not modify the `and-scene` suite. A change this task needs in `evals/lib/panel-judging/` must keep `and-scene`'s tests green.
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
The rubric SHALL contain one coverage criterion for each `mandatory` and `acceptable-alternative` inventory item and none for `preference` items. Each criterion SHALL be judged `met`, `partial`, or `missing`, where `partial` means the artifacts commit to the item's intent but leave out or weaken part of what the item requires: a `mandatory` item against its statement, and an `acceptable-alternative` item against its intent only, so a different mechanism that achieves the intent is `met`. An item SHALL count as captured only where an artifact commits to it in a specification requirement or scenario, a design decision, or a proposal scope statement; a mention only in the test plan or in passing SHALL NOT count. A `scope-exclusion` item SHALL be `met` when the definition does not include the excluded scope, without requiring an explicit exclusion statement. Each criterion SHALL be judged against its item's pinned anchors, which state in the reference's own words what counts as `met`, `partial`, and `missing`. A definition that contradicts a graded item SHALL be scored under that item's coverage criterion only. An item the disclosure audit marks leaked SHALL be excluded from both the earned and the possible coverage points and reported as `leaked`. Coverage SHALL be the primary component.

#### Scenario: Alternative mechanism meets the intent
- **WHEN** a definition specifies a different mechanism that achieves an `acceptable-alternative` item's intent
- **THEN** that criterion is `met`

#### Scenario: Item appears only in the test plan
- **WHEN** a requirement appears only as a test-plan case with no corresponding specification, design decision, or scope statement
- **THEN** that criterion is not `met`

#### Scenario: Anchor decides a borderline item
- **WHEN** a definition commits to an item in a way its `partial` anchor describes
- **THEN** that criterion is `partial`, and the verdict cites the artifact location

#### Scenario: Excluded scope is simply absent
- **WHEN** a definition neither includes nor mentions an excluded scope item
- **THEN** that `scope-exclusion` criterion is `met`

### Requirement: Verdict anchors
Every `mandatory` and `acceptable-alternative` item SHALL carry anchors that state, in the fixture change's own words wherever possible, what counts as `met`, `partial`, and `missing` for that item. An `acceptable-alternative` item's anchors SHALL be written against its intent, not the reference's mechanism. Anchors SHALL be drafted from the item's statement, intent, and source quotes, and reviewed by a maintainer before the inventory version that contains them is used for a candidate run. The inventory check SHALL fail when a graded item lacks any anchor.

#### Scenario: Graded item has no anchors
- **WHEN** a `mandatory` or `acceptable-alternative` item lacks its `met`, `partial`, or `missing` anchor
- **THEN** the inventory check fails and names the item

#### Scenario: Anchors are not yet reviewed
- **WHEN** a candidate run starts and the pinned inventory's anchors have no recorded maintainer review
- **THEN** preflight fails before any model call and states that the anchors need review

This task drafts the anchors, extends the inventory check, and wires the preflight refusal. The maintainer review is `HT-003`.

### Requirement: Fidelity
The fidelity component SHALL deduct for a definition that contradicts an answer the simulated user gave in the run's conversation, when that answer concerns a `preference` item or a matter outside the inventory. A contradiction of a `mandatory` or `acceptable-alternative` item, including one the simulated user stated, SHALL be scored once, under that item's coverage criterion, and SHALL NOT also be deducted under fidelity. Each deduction SHALL cite both the artifact location and the contradicted exchange. Scope a definition adds beyond the inventory SHALL NOT be deducted unless it contradicts the simulated user; included excluded scope is scored by its `scope-exclusion` coverage criterion.

#### Scenario: Definition ignores the user's answer
- **WHEN** the simulated user stated a preference that the inventory does not grade, and the definition specifies the opposite
- **THEN** fidelity is deducted, citing the artifact location and the exchange

#### Scenario: Contradiction of a graded item is scored once
- **WHEN** a definition contradicts a `mandatory` item that the simulated user also stated in an answer
- **THEN** the item's coverage criterion is not `met`, and fidelity makes no deduction for it

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
Judging SHALL be performed by eval-owned judges under a pinned judge profile, split into focused jobs for coverage by inventory area, fidelity, and artifact quality. Each scoring job SHALL be judged independently by a cross-family panel of three judges with identical inputs: one Claude-family judge and two independent Codex-family samples, each with a pinned CLI, model, and effort. A verdict SHALL be settled as follows:
- a verdict all three judges give SHALL stand;
- a verdict two judges give SHALL stand when the two include the Claude-family judge, unless the dissent is backed. A backed dissent is a higher verdict than the majority's, supported by artifact citations that pass validation. A backed dissent SHALL go to a targeted check by the pinned Claude-family decider of the dissent's stated reason. The dissent's verdict SHALL stand when the check confirms that reason, and the majority's otherwise;
- a verdict the two Codex-family judges give against the Claude-family judge, and a three-way split, SHALL be decided by the decider.

The decider SHALL receive the job's inputs and all three panel verdicts with their citations, without being told which model gave which. It SHALL rule a verdict that one of the panel judges gave, with citations that pass validation. A fidelity deduction SHALL be settled the same way, where the judges agree when they cite the same contradicted exchange. No verdict SHALL be decided by Codex-family judges alone or by a single model call. The result SHALL record every panel verdict, the settlement basis of each item or criterion, every targeted check, and every decider ruling.

Every judge prompt SHALL include, for each item it judges, the item's statement or intent, its source quotes with their reference headings, and its anchors. It SHALL also include a pinned scope rule: judge only what the cited artifacts establish, add no requirement the item and its anchors do not state, and give undefined terms their plain meaning in the reference. Coverage and fidelity judges SHALL receive the collected artifacts, the inventory items they judge, and, for fidelity, the simulated-user conversation. Citations SHALL depend on the verdict:
- a `met` or `partial` coverage verdict, an artifact-quality finding, and a fidelity deduction SHALL cite artifact locations;
- a `missing` verdict SHALL cite the collected artifacts the judge inspected, and, where an artifact the item would belong in is absent, the gate's record of that absence.

A judge job whose output is malformed, omits a criterion, or gives a verdict without the citation its verdict requires SHALL be retried, and SHALL NOT be scored from that output. A job that still fails after its retries SHALL fail the run as `evaluation-harness-failed`.

#### Scenario: Panel agrees
- **WHEN** all three panel judges mark a coverage item `met`
- **THEN** the item is `met` and no decider call is made for it

#### Scenario: Panel disagrees
- **WHEN** the two Codex-family judges mark a coverage item `met` and the Claude-family judge marks it `missing`
- **THEN** the decider receives all three verdicts and citations, its ruling is one of the panel's verdicts, and the result records the disagreement and ruling

#### Scenario: Cross-family majority stands
- **WHEN** the Claude-family judge and one Codex-family judge mark an item `met`, and the other Codex-family judge marks it `partial`
- **THEN** the item is `met` without a decider call, and the dissent is recorded

#### Scenario: Backed dissent is checked
- **WHEN** the Claude-family judge and one Codex-family judge mark an item `missing`, and the other Codex-family judge marks it `met` citing artifact lines that pass validation
- **THEN** the decider checks that dissent's stated reason
- **AND** the item is `met` when the check confirms the reason, and `missing` otherwise

#### Scenario: Three-way split
- **WHEN** the panel marks an item `met`, `partial`, and `missing`
- **THEN** the decider rules one of those three verdicts with validated citations

#### Scenario: Verdict lacks a citation
- **WHEN** a judge job returns a `met` verdict with no artifact citation
- **THEN** the job is retried and its uncited output is not scored

#### Scenario: Missing verdict for an absent artifact
- **WHEN** the collected change has no design and a judge marks a design-only item `missing`, citing the inspected artifacts and the gate's absence record
- **THEN** the verdict is accepted without a retry and the item scores as `missing`

### Requirement: Disclosure audit
After the define workflow, eval-owned judges SHALL audit every simulated-user reply against the agent turn it answered and the conversation before it, flagging over-disclosure, inconsistent withholding, and contradiction of an earlier answer. Each flag SHALL cite the exchange. Each over-disclosure flag SHALL name the `mandatory` and `acceptable-alternative` inventory items the reply disclosed without being asked. The audit SHALL use the same cross-family panel and settlement rule as scoring jobs, judging for each item whether it was leaked. An item named in an over-disclosure flag by the Claude-family judge and at least one Codex-family judge SHALL be leaked. An item named by both Codex-family judges but not the Claude-family judge SHALL be decided by the decider. An item named by one judge alone SHALL be a dissent, checked by the decider when that judge's flag cites a valid exchange. A leaked item SHALL be excluded from that run's coverage score and SHALL be reported as `leaked` in place of its coverage verdict. Inconsistent-withholding and contradiction flags SHALL be report-only. Every flag and every leaked item SHALL be shown in the result and report, and a run with flags SHALL still be scored and published.

#### Scenario: Over-disclosure is flagged
- **WHEN** a reply states a requirement the agent's turn did not ask about
- **THEN** the audit flags over-disclosure, cites that exchange, and names the disclosed inventory item
- **AND** the run is still scored and the flag appears in the result and report

#### Scenario: Leaked item does not earn coverage
- **WHEN** the audit marks a `mandatory` item leaked and the definition captures that item
- **THEN** the item contributes neither earned nor possible coverage points and is reported as `leaked`

#### Scenario: Panel disagrees about a leak
- **WHEN** both Codex-family judges name an item in an over-disclosure flag and the Claude-family judge does not
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
    - 2-to-1 with the Claude-family judge in the majority and an unbacked dissent;
    - 2-to-1 with the Claude-family judge in the majority and a backed higher-verdict dissent, once confirmed and once refuted by the targeted check;
    - 2-to-1 with the two Codex-family judges against the Claude-family judge;
    - a three-way split;
    - a decider ruling a verdict no panel judge gave;
    - one uncited `met`;
    - one rejected call;
    - a definition that contradicts a mandatory item the simulated user also stated, and one that contradicts a stated preference;
    - a collected change with no design, where a design-only item is `missing` citing the inspected files and `gate:required-artifact:design`;
    - disclosure-audit outputs where one mandatory item is named by the Claude-family judge and one Codex-family judge, one only by both Codex-family judges, and a withholding flag by all three.
  - Action: run the scoring phase.
  - Assert:
    - unanimous items and Claude-inclusive majorities with unbacked dissents make no decider call;
    - a backed dissent gets one targeted check, and its verdict stands only when the check confirms it;
    - Codex-only majorities and three-way splits reach the decider, with verdicts labelled only A, B, and C;
    - a decider ruling outside the panel's verdicts is retried and never scored;
    - the uncited verdict is retried and never scored;
    - the contradicted mandatory item is scored only under coverage, and the contradicted preference is a fidelity deduction;
    - every prompt contains the scope rule and each judged item's anchors and source quotes;
    - the `missing` verdict for the absent design is accepted without a retry, and the run stays `complete` with `definition_verdict=fail`;
    - the cross-family leaked item, and the decider-ruled item if ruled leaked, are dropped from earned and possible coverage, reported `leaked` in the result and the discovery ledger, and coverage is scaled over the remaining items;
    - the withholding flag changes no score;
    - a rejected call writes a zero-token usage record;
    - the result records panel verdicts, each settlement basis, targeted checks, and rulings;
    - component scores, gates, and the discovery outcomes match expectations.
- Also test:
  - the inventory check rejects a graded item without anchors, and preflight refuses unreviewed anchors;
  - the `build-rubric.mjs` divergence check;
  - the preflight rubric checks;
  - that two runs with identical verdicts and different discovery outcomes get the same score and verdict;
  - that a judge-failure resume reruns only unfinished jobs.

## Done When

- Every graded item in `hidden/inventory.json` has `met`, `partial`, and `missing` anchors. The inventory version is bumped, `anchors_review` is null, and the inventory check enforces anchors.
- `rubric.json` (generated, with a `null` threshold), `scripts/build-rubric.mjs`, the jobs, the disclosure audit, discovery, gates, and the scorer exist under `evals/agent-runner/and-scene-define/`.
  - Judging runs through the shared `runPanelJob` with the pinned Sonnet, `gpt-6-luna` ×2, and Opus profile, and no judge code is copied into the suite.
  - These are registered as lifecycle phases after the contamination audit, and each job is checkpointed.
- Preflight refuses a candidate run with an uncalibrated rubric, a mismatched inventory version, or unreviewed anchors.
- `INT-002` (judge portion) and `INT-003` pass, with no paid model calls.
- `npm run check` passes, with the new modules added to it.
- The final summary tells the user that `HT-003` (anchor review) is needed before calibration.
