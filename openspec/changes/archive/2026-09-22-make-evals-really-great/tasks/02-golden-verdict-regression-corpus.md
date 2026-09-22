# Task: Golden-verdict regression corpus, replay command, and staleness check

## Goal

Make an evaluator or rubric change unmergeable until real candidates were replayed. Commit a corpus
of adjudicated golden verdicts for eight real `and-scene` candidates, a maintainer replay command
that runs the production deterministic evaluator unmodified against a built and served candidate,
and an offline test in `npm run check` that fails when the committed replay records are missing,
stale, or disagree with the golden verdicts. Every earlier bad evaluator fix passed stub-based unit
tests; this corpus is what verifies later work against real candidates.

## Background

The suite lives in `evals/agent-runner/and-scene/` (paths below are relative to it unless they
start with `openspec/` or `test/`). `runBrowserEvaluation` (`lib/browser-eval.mjs`) runs 14
deterministic criteria over `createAxiBrowserDriver({ baseUrl })` (`lib/axi-browser-driver.mjs`).
`lib/reference-browser-regression.mjs` already replays the evaluator against an externally built
and served presentation with a fixed build/verification stub; generalise that pattern. Building
and serving stays outside the replay. The automated rubric is `automated-rubric.json` 5.0.0; the
control-keys probe already follows the fixture scenario "Controls keep their keys" (a deck key
pressed while a control holds focus is observed, never scored), and the driver recognises
`data-layout-id`, `data-scene-entity`, `data-node`, `data-entity-id`, and `data-scene-node`.

### Layout

```
corpus/
  candidates.json        golden verdicts with their basis and history
  replays/<id>.json      one generated replay record per candidate
corpus-replay.mjs        maintainer replay command
lib/corpus.mjs           validation, import walk, hashing
```

`candidates.json`:

```json
{ "schema_version": 1,
  "repository": "Codagent-AI/and-scene",
  "candidates": [{
    "id": "astra", "revision": "<40-hex>", "published_runs": ["astra-lead-…"],
    "golden": { "<criterion-or-gate-id>": {
      "outcome": "pass|fail|not-observed",
      "basis": { "source": "<fixture doc or rubric>", "heading": "…", "fact": "…" },
      "history": [{ "outcome": "pass", "date": "2026-09-21",
                    "explanation": "2026-09-21 audit replay: satisfies fixture scenario 'Controls keep their keys' (evolving-scene-presentations spec)." }] } } }] }
```

`basis` is required for `fail` and `not-observed`. `outcome` must equal the last `history` entry's
outcome and every entry needs an explanation. Every committed explanation, including the initial
entry of a golden `pass`, names the fixture text (document and heading) or the evaluator defect
that justifies that outcome; a bare "initial adjudication" note is not enough. Explanations live with the verdict rather than in a
separate log, so validation is structural and needs no previous manifest or git history.

**Scope** is the 14 deterministic criteria plus the two gates derived from browser observation,
`verification-sample-outline` and `verification-every-produced-step-renders`.
`runBrowserEvaluation` also returns `verification-build-whole-app` and `verification-clear-outcome`,
but the replay feeds those from the fixed stub, so they are kept in the replay record as
diagnostics and are **not** golden.

**The eight candidates** (repository `Codagent-AI/and-scene`): astra `6273deff…`, config
`44c8e817…`, cutover `785f48d2…`, localcodex `5d5adf57…`, sameprofile `9a2b54d4…`, and the three
issue #26 heads (and-scene PRs #21–#23). Resolve every full 40-hex SHA from the repository and
those PRs (`gh pr view <n> --repo Codagent-AI/and-scene --json headRefOid`); map `published_runs`
from the six directories under `results/` (both `candidate-rescore-2026072*` runs are the cutover
candidate). Expected deterministic results: 14/14 for the five published candidates and for
repetitions 1 and 2 (repetition 2 through a recognised convention); repetition 3 fails
`demo-present-mode-behavior` and the `verification-sample-outline` gate for its hidden step titles
and passes the rest. Each golden `fail` cites the fixture text it rests on. Confirm every golden
value by the first real replay, and adjudicate any disagreement against the fixture text (pinned at
`FIXTURE_REF` in `run.sh`, normative spec
`openspec/changes/create-and-scene/specs/evolving-scene-presentations/spec.md` in the and-scene
repository) before committing `candidates.json`. If a replay disagrees because the evaluator is
wrong, fix the evaluator test-first; if the expectation above was wrong, record the fixture-based
reason in the verdict's `history` explanation.

### Replay command

`corpus-replay.mjs --candidate <id> --base-url <url>` replays **one** candidate (replays share
Chrome, so never in parallel):

1. Probe `<url>`; if nothing answers, exit nonzero with "candidate unavailable" and write nothing.
2. Run `runBrowserEvaluation` with `createAxiBrowserDriver({ baseUrl })` and the fixed stub,
   unmodified production code. A `HarnessFailure` is reported as such and writes nothing.
3. Compare each outcome with `golden`. Print every difference (candidate, criterion, golden,
   replayed, rationale). `--all <map.json>` replays several served candidates sequentially and
   prints one combined difference report.
4. Write `replays/<id>.json`: revision, per-criterion outcome and bounded observation,
   `source_hashes`, `golden_sha256` (a hash of that candidate's `golden` outcomes only, excluding
   `basis` and `history` text), pins parsed from `run.sh` (`FIXTURE_REF`, `REFERENCE_REF`), `node`,
   `chrome-devtools-axi`, and browser versions (`unknown` when the adapter does not report one),
   and the time.
5. Exit nonzero when any outcome differs from golden.

The entry point accepts an injected driver factory so it can be tested without a browser. It never
touches `results/`.

`source_hashes` is computed by `lib/corpus.mjs`: a static walk of relative `import` specifiers
starting at `lib/browser-eval.mjs`, `lib/axi-browser-driver.mjs`, `lib/corpus.mjs`, and
`corpus-replay.mjs`, plus `automated-rubric.json`, each hashed with SHA-256. No dependency is
needed; the suite's modules use plain static relative imports. `candidates.json` as a whole is
deliberately **not** hashed: only each candidate's own golden outcomes are, so adding a candidate,
a `basis`, or an explanation never stales other candidates' records.

### Offline check

`test/corpus.test.mjs` runs in `npm run check` with no browser and fails, telling the maintainer to
run the replay, when: `candidates.json` is invalid (missing criterion, duplicate revision, `fail`
or `not-observed` without `basis`, `outcome` not matching its latest `history` entry, an entry
without an explanation, a published candidate or issue #26 repetition missing); a candidate has no
replay record, or its replay record lacks an outcome for any in-scope id; any recorded source hash differs from the current file; a candidate's
`golden_sha256` differs from its current golden outcomes; or a replay outcome differs from golden.
It also asserts the walked set contains the known core modules (guards against a missed dynamic
import).

### README

Document the maintainer loop in the suite `README.md`: clone `Codagent-AI/and-scene`, check out
each revision, `npm ci && npm run build`, serve the preview, replay, one at a time; state that
any edit to the evaluator's import closure or the rubric requires a fresh replay before merge,
that the replay is a pre-merge maintainer step and not a CI job, and that the manifest guards
against forgetting the replay, not against forgery.

### Record-restoration dossier (no records change in this task)

Five published records carry a wrong one-point `demo-navigation-boundaries-and-control-keys`
deduction applied by commit `16401c1`. They are restored later through
`applyTechnicalAdjudication` (`lib/adjudication.mjs`), only after the user approves each record.
Prepare that decision here, without applying it: using the replay observations for the four
affected candidates, write
`openspec/changes/make-evals-really-great/record-restoration.md` with, per record, the fixture
scenario text "Controls keep their keys", the old and new observation, and the proposed official
score. Verify each proposed score by calling `applyTechnicalAdjudication` on an in-memory or
`mkdtemp` copy of the record's `result.json` (expected: astra-lead 81.98,
candidate-rescore-20260728 80.19, candidate-rescore-20260729 74.11, config 74.04,
local-codex-tester 76.62; `same-profile-claude-tester` is unaffected). Do not write under
`results/` and do not commit operator scripts that mutate it.

### Constraints

- TDD; `node:test`, `mkdtemp` temporary directories, injected fakes. No test writes under
  `results/`. No third-party runtime dependencies. No shared framework outside the suite.
- Add `corpus-replay.mjs` and `lib/corpus.mjs` to the `node --check` list in `package.json`.
- The real replays need Chrome, `chrome-devtools-axi`, and network access to clone the and-scene
  repository. They make no model calls and push nothing. Stop servers and remove clones afterwards.
- The committed replay records must be generated by really replaying all eight candidates at this
  task's final evaluator source; a stubbed driver or hand-written record is not acceptable. If the
  real replay cannot be run in your environment, stop and report that plainly rather than
  committing fabricated records.
- Commit messages: `type: lowercase description`.

## Spec

From `openspec/changes/make-evals-really-great/specs/judging-regression-corpus/spec.md`:

### Requirement: Golden verdict corpus of real candidates
The `and-scene` suite SHALL keep a committed corpus of real candidate presentations. Each corpus entry SHALL identify a candidate by its repository and full commit revision, and SHALL record the adjudicated correct outcome, `pass`, `fail`, or not observed, for every deterministic browser criterion and for the two hard gates derived from browser observation, `verification-sample-outline` and `verification-every-produced-step-renders`. Hard gates derived from build or verification output are outside the corpus, because a replay supplies them as fixed inputs. Every golden `fail` and every golden not observed SHALL cite the pinned fixture text or rubric requirement it rests on and state the observed fact that justifies it, so that the corpus cannot silently preserve a misreading of the fixture. The corpus SHALL include every distinct candidate behind a published result and the three issue #26 factory repetitions, and SHALL NOT contain two entries for one revision.

Every golden verdict SHALL carry its own history: an ordered list of the outcomes it has held, each with a date and an explanation that names the fixture text or the evaluator defect that justifies it. The current outcome SHALL equal the outcome of the latest history entry, so a golden verdict cannot be changed without recording why.

#### Scenario: The corpus covers every published candidate
- **WHEN** the corpus is validated
- **THEN** it contains one entry for each distinct candidate revision behind a published result and one for each issue #26 repetition

#### Scenario: A golden failure has no justification
- **WHEN** a corpus entry records `fail` for a criterion without citing the requirement it rests on
- **THEN** corpus validation fails and names the entry and criterion

#### Scenario: A golden verdict is changed without recording why
- **WHEN** a golden verdict's outcome differs from the outcome of its latest history entry, or that entry has no explanation
- **THEN** corpus validation fails and names the entry and criterion

#### Scenario: A golden verdict is incomplete
- **WHEN** a corpus entry omits a deterministic criterion
- **THEN** corpus validation fails and names the missing criterion

### Requirement: Replay against the production evaluator
The suite SHALL provide a maintainer replay command that runs the production deterministic browser evaluator, unmodified, against an already built and served corpus candidate and compares the resulting outcome of every criterion with the golden verdict. Building and serving a candidate SHALL remain outside the replay, consistent with the pinned reference regression. The replay SHALL process one candidate at a time, because replays share a browser.

The replay SHALL report every criterion whose outcome differs from its golden verdict, with the golden outcome, the replayed outcome, and the replayed rationale. It SHALL exit nonzero when any outcome differs. A harness failure during replay SHALL be reported as a harness failure for that candidate and SHALL NOT be recorded as an outcome or compared with a golden verdict. The replay SHALL NOT modify any published result.

#### Scenario: Every outcome matches
- **WHEN** a maintainer replays every corpus candidate and each criterion's outcome equals its golden verdict
- **THEN** the replay reports no differences and exits zero

#### Scenario: An evaluator change moves a verdict
- **WHEN** a replay produces `fail` for a criterion whose golden verdict is `pass`
- **THEN** the replay reports the candidate, criterion, both outcomes, and the replayed rationale
- **AND** it exits nonzero

#### Scenario: One change moves several candidates at once
- **WHEN** an evaluator change flips the same criterion on four corpus candidates
- **THEN** the replay reports all four differences in one run

#### Scenario: The browser cannot be driven during replay
- **WHEN** the browser adapter fails while a candidate is replayed
- **THEN** the replay reports a harness failure for that candidate
- **AND** no outcome is recorded or compared for it

#### Scenario: A candidate is not being served
- **WHEN** the replay is pointed at an address where no candidate responds
- **THEN** the replay reports that the candidate is unavailable and exits nonzero
- **AND** it does not report product failures for that candidate

### Requirement: Replay manifest and staleness check
A completed replay SHALL write a generated manifest that records: each candidate revision replayed; every criterion outcome with its bounded observation; a content hash of every source file the deterministic evaluator transitively loads, the automated rubric, that candidate's golden verdicts, and the replay command itself; the fixture and reference pins; the Node, browser, and `chrome-devtools-axi` versions used; and the replay time. The manifest SHALL be committed with the change that required the replay. Recording an explanation, or adding a corpus candidate, SHALL NOT by itself require candidates whose golden verdicts did not change to be replayed again.

The repository check that runs in continuous integration SHALL fail, without needing a browser or a built candidate, when: the manifest is missing or malformed; any recorded source hash differs from the current source; the manifest does not cover every corpus candidate and criterion; a manifest outcome differs from its golden verdict; or a candidate's golden verdicts changed after its replay was recorded. The failure message SHALL tell the maintainer to run the replay.

The manifest is a guard against forgetting the replay. It SHALL NOT be presented as proof against deliberate forgery.

#### Scenario: The evaluator changes without a replay
- **WHEN** a change edits a source file the deterministic evaluator loads and does not regenerate the manifest
- **THEN** the repository check fails and tells the maintainer to run the replay

#### Scenario: The rubric changes without a replay
- **WHEN** a change edits the automated rubric and does not regenerate the manifest
- **THEN** the repository check fails

#### Scenario: A replay was run and committed
- **WHEN** the manifest's source hashes match the current sources, it covers every corpus candidate and criterion, and its outcomes equal the golden verdicts
- **THEN** the repository check passes without starting a browser

#### Scenario: A golden verdict changed after the replay
- **WHEN** a candidate's golden verdict is changed and that candidate is not replayed again
- **THEN** the repository check fails and names the candidate

#### Scenario: A new candidate is added
- **WHEN** a candidate is added to the corpus and replayed
- **THEN** the replay records of the other candidates remain current

#### Scenario: An unrelated file changes
- **WHEN** a change edits only files the deterministic evaluator does not load
- **THEN** the manifest remains current and the repository check does not require a replay


## Test Plan

- **INT-004: corpus staleness check against the real evaluator source tree**
  (`test/corpus.test.mjs`, CI). Validate the committed `corpus/`; then, in a temporary copy of the
  suite directory: append a comment to `lib/browser-eval.mjs`, to a transitively imported module
  (`lib/demo-contract.mjs`), to `automated-rubric.json`, and to an unrelated module
  (`lib/pricing.mjs`); delete a replay record; flip one golden outcome without a history entry;
  flip one with a history entry but no new replay; add an explanation-only history edit; add a
  ninth candidate with its own replay record; remove a `basis` from a golden `fail`; drop one
  criterion; remove one in-scope outcome from an otherwise present `corpus/replays/<id>.json`;
  duplicate a revision. Assert: the committed corpus passes with no browser; the walked
  source set contains `browser-eval.mjs`, `axi-browser-driver.mjs`, `demo-contract.mjs`, and
  `browser-diagnostics.mjs`; each evaluator, transitive, and rubric edit fails with a message
  telling the maintainer to run the replay; the unrelated edit passes; an explanation-only edit and
  an added candidate leave the other candidates' records current; every other mutation fails naming
  the candidate and, where it applies, the criterion (the replay record missing one outcome fails
  naming the candidate and criterion and tells the maintainer to run the replay); the two stub-fed gates are absent from golden
  verdicts; the corpus lists each distinct published candidate revision and the three issue #26
  repetitions.
- **INT-005: replay command outcomes without a browser** (`test/corpus-replay.test.mjs`, CI).
  Drive the `corpus-replay.mjs` entry point with an injected driver factory writing into a
  temporary corpus directory: a fake driver matching golden; one flipping a criterion; one throwing
  a harness failure; a base URL with nothing listening; and one run over four candidates with the
  same flipped criterion. Assert: a match writes a replay record with outcomes, observations,
  source hashes, pins, and versions and exits zero; a flip prints candidate, criterion, golden,
  replayed, and rationale and exits nonzero; four flips are all reported in one run; a harness
  failure and an unreachable candidate exit nonzero, print the distinct reason, and write no
  record; no path under `results/` is touched.

## Done When

- `corpus/candidates.json` lists the eight candidates with full revisions, a golden outcome with
  history for all 16 in-scope ids each, a fixture-citing `basis` on every `fail`, and history
  explanations that each name the fixture text or evaluator defect they rest on.
- `corpus/replays/<id>.json` exists for all eight and covers all 16 in-scope ids, generated by real replays at the final source
  of this task, each exiting zero.
- Every spec scenario above is covered by a passing test; INT-004 and INT-005 pass in CI
  conditions (no browser, no network).
- The suite `README.md` documents the replay loop.
- `record-restoration.md` exists with verified proposed scores; nothing under `results/` changed.
- `npm run check` passes.
