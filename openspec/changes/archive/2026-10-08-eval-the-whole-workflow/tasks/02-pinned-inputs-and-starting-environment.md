# Task: Pin the hidden reference, inventory, starting repository, and contamination patterns for `and-scene-define`

## Goal

Create the new suite `evals/agent-runner/and-scene-define/` and its pinned evaluator and fixture inputs:
- the hidden reference;
- the reconciled requirement inventory and its checks;
- the starting prompt;
- the allowlisted starting repository and its deterministic materialization;
- the versioned contamination-pattern list and the host-side canary check;
- a `versions.json` that makes every versioned input's content checkable.

Everything later in the suite depends on these inputs: the simulated user, the sandboxed run, the audits, and the judges. Defects here change what the eval measures.

## Background

### What the suite is

agent-evals is adding a suite that runs Agent Runner's interactive define workflow (`openspec:change --until define`) from a short prompt. An eval-owned simulated user answers the lead agent from a **hidden reference**, and judges score the produced proposal, specifications, design, and test plan against a pinned **inventory** of requirements derived from that reference. The hidden reference is the and-scene fixture's reviewed `create-and-scene` change at fixture commit `ad667a965a0e1ea0b028c36c04d57bf0411d30d9` in `https://github.com/Codagent-AI/and-scene.git`.

The evaluated agent runs in a networked sandbox and must never be able to read hidden material. All hidden data stays on the host, under `hidden/` and `calibration/` in the suite, and is never staged into the sandbox input.

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, especially the sections "Starting repository", "Hidden data in the suite", "Contamination audit and evidence", "Canary check", "Rubric" (the `versions.json` part), and "Migration Plan";
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-005`.

Repository rules (`AGENTS.md`):
- Node 22 with no third-party runtime dependencies.
- Test-driven development.
- Tests live in `test/*.test.mjs` and run through `npm run check`. Add `node --check` and `bash -n` entries for every new script to `package.json`'s `check` script, following the existing and-scene entries.
- Do not modify `evals/agent-runner/and-scene/`. You may copy and adapt its code. `evals/agent-runner/and-scene/fixture-snapshot.mjs` and `lib/pins.mjs` show how that suite fetches and pins fixture files.

### Layout to create

```
evals/agent-runner/and-scene-define/
  hidden/
    reference/            fixture change proposal.md, specs/**/spec.md, design.md, test-plan.md (no tasks)
    reference.json        fixture repo, commit, change name, per-file SHA-256
    inventory.json, items.json, labels-opus.json, labels-codex.json,
    labelling-brief.md, starting-prompt.md
    simulated-user-policy.md (later; not in this task)
  starting-repo/
    tree/                 the allowlisted, neutrally rewritten starting files
    manifest.json         allowlist, rewrites, per-file hashes, tree hash
  contamination-patterns.json
  versions.json
  lib/                    inventory check, snapshot materialization, canary check, versions
  scripts/
    refresh-reference.mjs
    build-starting-snapshot.mjs
```

The exact sub-layout under `starting-repo/` (`tree/` plus `manifest.json`) is your choice, as long as the manifest is separate from the tree the agent sees.

### Hidden reference and inventory

- **Move** the six files in `openspec/changes/eval-the-whole-workflow/inventory/` into `evals/agent-runner/and-scene-define/hidden/`. Use `git mv` semantics, and leave no copy in the change directory. `inventory.json` records its inputs by relative path (`starting-prompt.md`, `items.json`, `labelling-brief.md`, the label files), so they stay siblings.
  - Do not change any item, class, or intent. The inventory has 24 mandatory, 48 acceptable-alternative, and 48 preference items, at `inventory_version` 1.
  - Its top-level keys are `inventory_version`, `source`, `inputs`, `reconciliation`, `counts`, `items`, `coverage`, and `excluded`.
  - Each item has `id`, `area`, `kind`, `title`, `statement`, `sources[]` (`document`, `heading`, `quote`), `class`, `intent`, `intent_source`, `labels`, and `resolution`.
- `scripts/refresh-reference.mjs` copies the fixture change's `proposal.md`, `specs/**/spec.md`, `design.md`, and `test-plan.md` from the pinned fixture commit into `hidden/reference/`, preserving their `openspec/changes/create-and-scene/...` relative paths. It writes `reference.json` with per-file SHA-256 hashes.
  - It accepts either a local fixture clone or a fresh fetch, mirroring and-scene's `fixture-snapshot.mjs`.
  - The and-scene suite's own `fixture-snapshot/` is pinned at a different commit (`2262a9f`), so do not reuse it.
- The **inventory check** (`lib/inventory.mjs` or similar, with a maintainer CLI entry) enforces every rule in the hidden-reference requirements below against `hidden/reference/`:
  - input hashes;
  - verbatim quotes under their cited headings;
  - every fixture requirement and scenario either mapped or excluded with a reason;
  - exactly one final class per item;
  - an intent on every `acceptable-alternative` item and on no other class;
  - a final class and reason on every disagreement.

  The refresh mode compares against a newly fetched fixture change and reports stale quotes and newly unmapped requirements and scenarios. Expose a function that preflight can call to reject a candidate run whose inventory is stale or unpinned. This task does not build preflight itself.

### Starting repository

- `scripts/build-starting-snapshot.mjs` builds the tree from the fixture's **pre-change scaffold** at the pinned commit. It uses an explicit allowlist with neutral rewrites, and writes `manifest.json`: the allowlist, the rewrites, per-file hashes, and the tree hash.
  - Exclude, or rewrite neutrally, anything that names the target product, the hidden change, the evaluation, or the target project map. The fixture's `AGENTS.md` and `README.md`, for example, currently name the hidden change.
  - Include a minimal neutral `.validator/config.yml` that sets `base_branch: main`. Without that line, `agent-validator detect` diffs against `origin/main` and the workflow's `create` step fails.
- **Materialization** is deterministic:
  1. `git init`, add the tree, and commit once with a fixed author, committer, and date;
  2. create `main` and `add-presentation-skill` at that commit, check out `add-presentation-skill`, and configure no remote;
  3. verify the tree hash against the manifest;
  4. `git bundle create --all`.

  The change name is pinned as `add-presentation-skill`. Expose this as a library function, `materialize(outDir) → { bundlePath, commit, treeHash }` or similar, for the run controller to call.
- Maintainer review of the tree (`HT-001`) is a human step after this task. Do not perform it or claim it.

### Contamination patterns and canary check

`contamination-patterns.json` is versioned. Each entry is a case-insensitive literal or an anchored regular expression, with a kind: `locator` or `canary`. It contains:
- `Codagent-AI/and-scene` and `Codagent-AI/agent-evals`, with their URLs;
- the and-scene skill name `and-scene:presentation` and its plugin and marketplace paths;
- `and-scene-define` and the suite's hidden data paths;
- transport and runtime fragments, chosen so that absolute and relative spellings both match:
  - `exchange/` followed by a `.request.json` or `.reply.json` name;
  - `external-user/exchanges.jsonl`;
  - `/artifacts/.runtime` and `../.runtime`;
  - `eval-input`;
- canary phrases from the hidden reference, distinctive enough not to arise in an independent definition, and qualified rather than bare words.

The canary check (`lib/canary.mjs`) scans, on the host, every file that will be readable in the sandbox:
- a staged sandbox-input directory, including the starting-repository tree or bundle contents;
- the Agent Skills checkout's tracked files at its current commit;
- a list of forwarded credential files.

It returns the matches, each naming the file and the pattern. The pattern list itself must never be written into any staged directory. The caller turns a match into an `evaluation-harness-failed` stop before any evaluated model call.

### Versioned inputs

`versions.json` records the content SHA-256 of every versioned input under its version: the rubric, the contamination-pattern list, the simulated-user policy, the inventory, and the starting prompt. Add the rubric and policy entries when those files exist. Structure the check so that adding them is a one-line change. A test fails when any recorded content changes without a version bump.

### Migration hygiene

Keep `openspec/changes/eval-the-whole-workflow/poc/` with the change as implementation reference. Never commit `poc/runs/claude-20261004T022704Z/`: it records the maintainer's personal Claude setup. Leave it on disk, untracked, for example through a `.gitignore` entry scoped to that directory.

## Spec

### Requirement: Pinned hidden-reference inventory
The suite SHALL own a pinned hidden-reference inventory consisting of the starting prompt, the itemized requirements, each independent label set, the labelling brief, and the reconciled inventory, all derived from the and-scene fixture change at one pinned fixture commit. The reconciled inventory SHALL record the fixture repository, commit, and change name, and the hash of every input it was built from. The inventory SHALL be stored in suite data that is never mounted into or readable from the evaluated agent's environment.

#### Scenario: Inventory identifies its inputs
- **WHEN** a maintainer inspects the reconciled inventory
- **THEN** it names the fixture repository, commit, and change, and records the hash of the starting prompt, items, brief, and each label set

#### Scenario: Recorded input no longer matches
- **WHEN** an input file's hash differs from the hash recorded in the reconciled inventory
- **THEN** the suite's inventory check fails and identifies the changed input

### Requirement: Traceable items
Each inventory item SHALL state one distinct requirement with a stable identifier, an area, a kind (`behavior`, `constraint`, `value`, `scope-inclusion`, `scope-exclusion`, or `decision`), a title, and a statement. Each item SHALL cite at least one verbatim quote from the fixture change, with the source document and heading. The suite's inventory check SHALL verify every quote against the suite's pinned snapshot of the fixture change.

#### Scenario: Quote does not match the snapshot
- **WHEN** an item's quote does not appear under its cited heading in the pinned snapshot
- **THEN** the inventory check fails and names the item and source

### Requirement: Complete coverage of the fixture change
Every requirement and every scenario in the fixture change's specifications SHALL map to at least one inventory item or appear in the inventory's exclusions with a stated reason. The inventory check SHALL fail on any requirement or scenario that is neither mapped nor excluded.

#### Scenario: Unmapped scenario
- **WHEN** a scenario in the pinned fixture change has no inventory item and no exclusion
- **THEN** the inventory check fails and names the scenario

#### Scenario: Excluded entry without a reason
- **WHEN** an exclusion has no stated reason
- **THEN** the inventory check fails and names the exclusion

### Requirement: Prompt-relative classification
Every item SHALL carry exactly one final class, decided relative to the pinned starting prompt by whether a reasonable user who sent that prompt would consider a result that lacks the item, or does it differently, incomplete or incorrect:

| Class | Meaning | Grading |
|---|---|---|
| `mandatory` | Asked for or clearly hinted at by the prompt, or needed by any competent, complete realization of it | Graded as stated |
| `acceptable-alternative` | The underlying need is required, but the reference's mechanism, form, structure, or value is one of several reasonable choices | Graded on its intent only |
| `preference` | Opinion, taste, naming, wording, an incidental value or layout, or another choice whose difference or absence would not make the result less complete or correct | Not graded |

Every `acceptable-alternative` item SHALL have a non-empty intent that states what any acceptable alternative must achieve without the reference's specifics. Items of other classes SHALL have no intent.

#### Scenario: Acceptable alternative without an intent
- **WHEN** an `acceptable-alternative` item has no intent
- **THEN** the inventory check fails and names the item

#### Scenario: Preference item is not graded
- **WHEN** a candidate definition omits or contradicts a `preference` item
- **THEN** that item contributes no criterion to the score

### Requirement: Independent labelling and reconciliation
Final classes SHALL come from two independent label sets produced from the same versioned labelling brief by labellers from different model families, neither of which reads the other's labels. A maintainer SHALL reconcile every item on which the labels disagree, and the reconciled inventory SHALL record for each item both labellers' classes and confidence, the final class, the intent and which labeller's intent it was taken from, whether the class was agreed or reconciled, and, for a reconciled item, the reason. Any general rule the maintainer applies across items SHALL be recorded in the inventory.

#### Scenario: Labellers disagree
- **WHEN** the two label sets give an item different classes
- **THEN** the reconciled inventory records both classes, the maintainer's final class, and the reason for it

#### Scenario: Disagreement left unresolved
- **WHEN** an item's labels disagree and the reconciled inventory gives no final class or no reason
- **THEN** the inventory check fails and names the item

### Requirement: Inventory versioning
A change to the pinned fixture commit, the starting prompt, any item, or any item's final class or intent SHALL produce a new inventory version. The inventory version SHALL be part of the run's series identity, so runs scored against different inventory versions are not compared.

#### Scenario: Final class changes
- **WHEN** a maintainer changes one item's final class
- **THEN** the inventory version changes and runs scored against the earlier version are reported as a different series

This task provides the inventory version and its `versions.json` check. Recording the inventory version in a run's series identity is done by the run controller.

### Requirement: Refresh from the fixture
When the fixture pin moves, the suite SHALL provide a maintainer check that compares the inventory against the new fixture change and reports every item whose source quotes no longer match and every requirement or scenario that is newly unmapped. Each reported item SHALL be re-itemized or relabelled through the independent labelling and reconciliation process before the new inventory version can be used for a candidate run.

#### Scenario: Source text changed in the new pin
- **WHEN** the new fixture commit changes the text an item quotes
- **THEN** the refresh check reports that item as needing relabelling
- **AND** preflight rejects a candidate run until the inventory is updated and its new version is pinned

This task delivers the refresh check, plus a stale-or-unpinned inventory function that preflight can call. Wiring that function into candidate-run preflight is outside this task.

### Requirement: Starting environment
The evaluated agent SHALL start in a repository materialized from the suite's allowlisted starting snapshot. The repository SHALL contain exactly one commit, no remote, a `main` branch at that commit, and a feature branch at that commit checked out, and its tree SHALL match the pinned hash. The evaluated environment SHALL receive no GitHub credential. No candidate branch SHALL be pushed and no pull request SHALL be created.

#### Scenario: Starting repository exposes no other history
- **WHEN** the starting repository has been materialized for a run
- **THEN** its reachable history across all refs contains only the starting commit and it has no configured remote

#### Scenario: No GitHub credential is forwarded
- **WHEN** the evaluated sandbox starts
- **THEN** its environment contains no GitHub token or credential helper configured with a GitHub credential

This task delivers the starting-repository portion: the single commit, no remote, `main`, the checked-out feature branch, and the pinned tree hash. Keeping GitHub credentials out of the sandbox environment, and never pushing or opening a pull request, belong to the sandbox invocation.

### Requirement: Pinned contamination patterns
The suite SHALL pin a versioned list of contamination patterns: the fixture and evaluation repositories' qualified names and URLs, the reference implementation's location, hidden paths, and canary phrases taken from the hidden reference that are distinctive enough not to arise in an independent definition. Patterns SHALL be qualified rather than bare words. Path patterns SHALL match a distinctive fragment of the path, such as the exchange directory with its request or reply file suffix, so that a relative or alternate spelling of the path is also matched. The suite's tests SHALL verify that the list produces no match on the starting environment or on a recorded clean run. The pattern-list version SHALL be part of the series identity.

#### Scenario: Pattern matches the clean baseline
- **WHEN** a pattern matches the starting environment or the recorded clean run
- **THEN** the suite's tests fail and name the pattern and the matched location

This task verifies the list against the starting environment. Verifying it against a recorded clean run belongs to the contamination audit.

### Requirement: Canary check
After the starting environment is materialized and before the evaluated sandbox starts, the harness SHALL search every file that will be mounted or copied into the evaluated environment, including the starting repository, the staged sandbox input, the Agent Skills checkout to be installed, and any forwarded credential or configuration file, for the contamination patterns. The search SHALL run outside the evaluated environment, and the pattern list SHALL NOT enter it. A match SHALL stop the run with `evaluation_status=evaluation-harness-failed` before any evaluated model call and SHALL identify the pattern and location.

#### Scenario: Setup leaks a canary phrase
- **WHEN** a canary phrase is found in a file the evaluated agent can read
- **THEN** the run stops before the define workflow with `evaluation-harness-failed` and reports the phrase and file

#### Scenario: Forwarded configuration names the fixture
- **WHEN** a configuration file that would be forwarded into the sandbox names the fixture repository
- **THEN** the run stops before the sandbox starts with `evaluation-harness-failed` and reports the file and pattern

This task delivers the scan and its reporting. Calling it between materialization and sandbox start belongs to the run controller.

## Test Plan

- `INT-005` (Starting repository and canary check): `test/and-scene-define-starting-repo.test.mjs`, in `npm run check`, with real `git` and real files.
  - Setup:
    - the committed `starting-repo/` tree and manifest;
    - a temporary staged input directory;
    - a forwarded-settings fixture file that contains a fixture-repository name.
  - Action: materialize twice, then run the canary check over the clean staging, and again with each planted file.
  - Assert:
    - both materializations produce the same commit and tree hash;
    - across all refs there is exactly one commit, with `main` and `add-presentation-skill` at it and HEAD on `add-presentation-skill`;
    - there is no remote;
    - `.validator/config.yml` sets `base_branch: main`;
    - the pattern list finds nothing in the snapshot;
    - each planted match is reported with its file and pattern.
- Also add unit tests for:
  - the inventory check (every failing scenario above, using small synthetic inventories and reference snapshots);
  - the `versions.json` content-hash check;
  - a test that no path under `hidden/` or `calibration/`, and not `contamination-patterns.json`, is ever placed in a staged directory produced by this task's code.

## Done When

- `evals/agent-runner/and-scene-define/` exists with the following, all committed:
  - `hidden/reference/` and `reference.json` at fixture commit `ad667a9...`;
  - the moved inventory files;
  - `starting-repo/` and its manifest;
  - `contamination-patterns.json`;
  - `versions.json`.
- The inventory check passes on the committed inventory and reference, and fails with the named item, source, scenario, or exclusion in each failing case.
- The refresh check reports stale quotes and newly unmapped entries against a modified fixture.
- `INT-005` passes, and the contamination patterns produce no match on the starting snapshot.
- `openspec/changes/eval-the-whole-workflow/inventory/` no longer exists, and `poc/runs/claude-20261004T022704Z/` is untracked.
- `npm run check` passes, with the new scripts added to it.
