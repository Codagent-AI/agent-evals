# Task: Link every rubric criterion to the pinned fixture and check the link

## Goal

Make rubric text that contradicts the pinned fixture fail `npm run check`. Every criterion and
hard gate in `automated-rubric.json` declares where its requirement comes from; fixture-owned
criteria carry a structured citation verified offline against a vendored snapshot of the pinned
fixture documents; and every concrete value in rubric guidance is either found in the cited
normative text or declared eval-owned with a reason. The rubric paraphrases the fixture and the
paraphrases drifted: guidance said 880×495 where the fixture says 880 × 380, and a check inverted
the fixture scenario "Controls keep their keys". Nothing checked rubric text against the fixture.

## Background

The suite lives in `evals/agent-runner/and-scene/` (paths relative to it unless they start with
`openspec/` or `test/`). `automated-rubric.json` (5.0.0) has `components[].subcomponents[]` with
`criteria` as **bare string ids**, optional `review_guidance` strings, hard gates with requirement
text, and top-level maps such as `fallbacks` (each with `requirement` and `guidance` text) and
`contradiction_pairs`. `validateAutomatedRubric` and `rubricCriteria()` live in `lib/rubric.mjs`.
Keep criteria as bare ids; add top-level maps. The fixture pin is `FIXTURE_REF` in `run.sh`
(`892dfbcf3762bc95cdbae6f05b18cc2b168a5fab`), repository `Codagent-AI/and-scene`. Do not change
the fixture, `FIXTURE_REF`, or `REFERENCE_REF`.

New files: `fixture-snapshot/`, `fixture-snapshot.mjs`, `lib/traceability.mjs`,
`test/traceability.test.mjs`.

### Rubric

```json
"criterion_sources": {
  "demo-navigation-boundaries-and-control-keys": { "owner": "fixture",
     "document": "openspec/changes/create-and-scene/specs/evolving-scene-presentations/spec.md",
     "heading": "Scenario: Controls keep their keys",
     "quote": "navigation keys drive that control rather than also advancing the deck" },
  "assumption-…": { "owner": "eval", "reason": "Judges workflow evidence the fixture does not describe." } },
"eval_owned_values": [{ "value": "aria-current", "reason": "ARIA standard attribute." }]
```

Every criterion and gate id needs an entry (about 90); `validateAutomatedRubric` enforces presence
and completeness (a fixture-owned entry needs document, heading, and quote; an eval-owned entry
needs a reason). A criterion may cite more than one heading (`sources: [ … ]`). Author each
citation by reading the fixture text; the quote must be the normative text the criterion actually
enforces. Eval-owned values (for example suite inspection viewport sizes, web-standard attribute
names) each carry a stated reason. The version stays 5.0.0; only the pinned sha256 changes (update
`test/rubric.test.mjs`, calibration fixtures, README pins). Criteria, points, floors, gates,
owners, and existing guidance wording do not change, unless the check exposes guidance that
contradicts the fixture, in which case correct it to the fixture and say so in the commit.

### Snapshot

`fixture-snapshot/snapshot.json` records `fixture_ref`, the repository, and
`files: [{ path, blob }]`; the documents sit beside it under their fixture paths. It holds exactly
these documents from the fixture's `openspec/changes/create-and-scene/`:
`specs/evolving-scene-presentations/spec.md`, `specs/presentation-skill/spec.md`,
`specs/presentation-verification/spec.md`, `proposal.md`, `design.md`, `tasks.md`, and
`test-plan.md` where present, plus the fixture's root `README.md`. `fixture-snapshot/README.md`
states that the documents are copied verbatim from `Codagent-AI/and-scene` at the pinned revision
for offline verification. `fixture-snapshot.mjs --checkout PATH` refuses a checkout whose `HEAD`
is not `FIXTURE_REF` (exit nonzero, snapshot unchanged), copies the documents, and records each
`git ls-tree` blob id. Generate the committed snapshot with this command from a real checkout at
the pin.

### Check (`test/traceability.test.mjs`, offline, in `npm run check`)

- `fixture_ref` equals `FIXTURE_REF` parsed from `run.sh`; a mismatch tells the maintainer to
  refresh the snapshot.
- Each file's git blob id, computed as SHA-1 of `blob <size>\0<content>`, equals the recorded id;
  a mismatch names the document.
- Each citation's document exists, its heading exists, and its quote appears in the section under
  that heading after whitespace and Unicode punctuation normalization (reuse the evaluator's text
  normalizer). A failure names the criterion and the part that did not match.
- Concrete values. For each subcomponent's `review_guidance`, each fallback's text, and each gate
  requirement, extract: dimensions `\d+\s*[×x]\s*\d+`; numbers with a unit (`px`, `ms`, `s`, `%`);
  `data-*` and `aria-*` attribute names; and backticked tokens that start with `[`, `.`, or `#`.
  Criterion ids and bare unitless numbers are ignored. A value is accepted when its normalized
  form (`×`→`x`, spaces removed) appears in a section cited by any criterion of that subcomponent,
  or when it is listed in `eval_owned_values`. Anything else fails, naming the subcomponent and
  value. Because acceptance looks only inside cited sections, a hook the fixture merely offers as
  an example elsewhere does not count.

The extraction is deliberately narrow; it catches the 880×495 class of error, not every
paraphrase.

### README and check script

Document the citation rules, `eval_owned_values`, and the snapshot refresh command in the suite
`README.md`. Add `fixture-snapshot.mjs` and `lib/traceability.mjs` to the `node --check` list in
the `check` script of `package.json`.

### Corpus replay obligation

`test/corpus.test.mjs` fails `npm run check` whenever any file in the deterministic evaluator's
import closure or `automated-rubric.json` changed since the committed replay records in
`corpus/replays/*.json`. This task edits the rubric (and, if you reuse the evaluator's normalizer
by exporting it, possibly the closure), so before finishing you must rebuild and serve each of the
eight corpus candidates (loop documented in the suite `README.md`: clone `Codagent-AI/and-scene`,
check out the revision, `npm ci && npm run build`, serve, one at a time), run `corpus-replay.mjs`,
and commit the regenerated records. Every replay must still match golden. Land all rubric edits
before the final replay so it is done once. If the real replay cannot be run in your environment,
stop and report that plainly rather than committing fabricated records.

### Constraints

- TDD; `node:test`, `mkdtemp` directories. No network in the CI test; the refresh cases need only
  the `git` binary. No third-party runtime dependencies. No test writes under `results/`.
- Commit messages: `type: lowercase description`.

## Spec

From `openspec/changes/make-evals-really-great/specs/rubric-fixture-traceability/spec.md`:

### Requirement: Every criterion states where its requirement comes from
Every criterion and hard gate in the `and-scene` automated rubric SHALL declare its requirement source as either fixture-owned or eval-owned. A fixture-owned criterion SHALL cite the pinned fixture with a structured citation: the fixture document, the requirement, scenario, or section heading within it, and a quoted fragment of the normative text the criterion enforces. An eval-owned criterion, such as one that judges workflow evidence the fixture does not describe, SHALL state the reason it is eval-owned. Rubric validation SHALL reject a criterion that declares neither, and SHALL reject a fixture-owned criterion whose citation is incomplete.

#### Scenario: A fixture-owned criterion is cited
- **WHEN** the rubric is validated and `demo-navigation-boundaries-and-control-keys` cites the fixture scenario "Controls keep their keys" with a quoted fragment
- **THEN** validation accepts the criterion's requirement source

#### Scenario: A criterion declares no source
- **WHEN** a rubric criterion declares neither a fixture citation nor an eval-owned reason
- **THEN** rubric validation fails and names the criterion

#### Scenario: A citation is incomplete
- **WHEN** a fixture-owned criterion cites a document without a heading or quoted fragment
- **THEN** rubric validation fails and names the criterion

### Requirement: Citations are verified against the pinned fixture
The suite SHALL keep a committed snapshot of the normative fixture documents at the pinned fixture revision. The repository check SHALL verify every fixture citation against that snapshot without network access: the cited document SHALL exist in the snapshot, the cited heading SHALL exist in that document, and the quoted fragment SHALL appear under that heading after whitespace and Unicode punctuation normalization. A citation that fails any of these SHALL fail the check and name the criterion and the part that did not match.

#### Scenario: A quoted fragment no longer matches
- **WHEN** a criterion's quoted fragment does not appear under its cited heading in the snapshot
- **THEN** the repository check fails and names the criterion and the unmatched fragment

#### Scenario: A cited heading does not exist
- **WHEN** a criterion cites a scenario heading that the snapshot document does not contain
- **THEN** the repository check fails and names the criterion and heading

#### Scenario: A fragment differs only in punctuation style
- **WHEN** a quoted fragment differs from the fixture text only in apostrophe style or whitespace
- **THEN** the citation is accepted

### Requirement: Concrete values in guidance are accounted for
Every concrete value in a criterion's requirement or guidance text, meaning a dimension, a number that carries a unit, an attribute name, or a selector, SHALL be accounted for. Bare numbers without a unit are outside this check; the quoted-fragment check covers the requirement itself. Guidance MAY apply to a group of criteria; a value SHALL be accepted when it appears in the normative text under a heading cited by a criterion that guidance applies to. Any other value SHALL be declared eval-owned in the rubric with a stated reason, such as a suite-owned inspection viewport or a web-standard attribute name. A value that appears in the fixture only as an example, outside the cited normative text, SHALL NOT be accepted as fixture-owned. The repository check SHALL fail and name the guidance's criteria and the value when a concrete value is neither.

#### Scenario: Guidance states a dimension the fixture does not
- **WHEN** a criterion's guidance states a canvas size of 880×495 and the cited fixture text states 880 × 380
- **THEN** the repository check fails and names the criterion and the value 880×495

#### Scenario: Guidance states the fixture's dimension
- **WHEN** a criterion's guidance states a canvas size of 880×380 and its cited fixture text states 880 × 380
- **THEN** the value is accepted

#### Scenario: Guidance requires an example hook
- **WHEN** a criterion's guidance names an attribute that the fixture mentions only as an example and that does not appear in the criterion's cited normative text
- **THEN** the repository check fails unless the value is declared eval-owned with a reason

#### Scenario: An inspection viewport is eval-owned
- **WHEN** a criterion's guidance names a viewport width the suite uses for inspection and declares it eval-owned with a reason
- **THEN** the value is accepted

### Requirement: The snapshot matches the fixture pin
The fixture snapshot SHALL record the fixture revision it was taken from and the git blob identifier of every included document. The repository check SHALL fail when the recorded revision differs from the suite's fixture pin, or when a snapshot document's content does not match its recorded blob identifier. The suite SHALL provide a maintainer refresh command that regenerates the snapshot from a checkout of the fixture at the pinned revision and verifies each blob identifier against that checkout. Changing the fixture pin without refreshing the snapshot SHALL fail the repository check.

#### Scenario: The fixture pin moves without a refresh
- **WHEN** the suite's fixture pin is changed and the snapshot still records the previous revision
- **THEN** the repository check fails and tells the maintainer to refresh the snapshot

#### Scenario: A snapshot document is edited by hand
- **WHEN** a snapshot document's content no longer matches its recorded blob identifier
- **THEN** the repository check fails and names the document

#### Scenario: The snapshot is refreshed from the pinned checkout
- **WHEN** a maintainer runs the refresh command against a checkout at the pinned revision
- **THEN** the snapshot and its recorded blob identifiers match that checkout
- **AND** the repository check passes

#### Scenario: The refresh checkout is at the wrong revision
- **WHEN** the refresh command is run against a checkout that is not at the pinned revision
- **THEN** the refresh fails without changing the snapshot


## Test Plan

- **INT-006: traceability check against the real rubric and snapshot, and snapshot refresh against
  real git** (`test/traceability.test.mjs`, CI). Boundary: `lib/traceability.mjs` over the
  committed `automated-rubric.json`, `fixture-snapshot/`, and `run.sh`; `fixture-snapshot.mjs`
  against a real temporary git repository holding stand-in fixture documents at a known commit.
  Run the check on the committed files; then on in-memory mutated copies: guidance changed to
  `880×495`, a criterion's source entry removed, a citation truncated, a quote changed by one word,
  a quote's apostrophe style changed only, a missing heading cited, an uncited `data-*` name added,
  the same name added to `eval_owned_values`, a snapshot document edited, and the parsed
  `FIXTURE_REF` changed. Run refresh against the temporary repository at the pinned commit and at
  another commit. Assert: the committed rubric passes offline; each mutation fails naming the
  criterion or subcomponent and the offending value, heading, or document; the punctuation-only
  change passes; the eval-owned declaration passes; a moved pin fails telling the maintainer to
  refresh; refresh at the pin writes blob ids equal to `git ls-tree`; refresh at another commit
  exits nonzero and leaves the snapshot unchanged.

## Done When

- Every criterion and gate in `automated-rubric.json` has a verified source entry, and every
  extracted concrete value is fixture-found or eval-owned with a reason.
- Every scenario above is covered by a passing test; INT-006 passes in CI conditions.
- In a scratch copy, reverting `scene-fixed-canvas` guidance to `880×495` fails the check naming
  the subcomponent and value, and changing `FIXTURE_REF` by one character fails telling the
  maintainer to refresh the snapshot.
- The suite `README.md` documents citations and the refresh command.
- The corpus replay records are regenerated from real replays and `test/corpus.test.mjs` passes.
- `npm run check` passes. Nothing under `results/` changed.
