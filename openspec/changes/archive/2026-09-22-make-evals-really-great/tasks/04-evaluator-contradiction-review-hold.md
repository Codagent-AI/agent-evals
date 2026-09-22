# Task: Hold publication when the browser evaluator and an LLM judge contradict each other

## Goal

Detect when the deterministic browser evaluator and an LLM judge reach opposite verdicts on the
same proposition, record it, and hold the result from publication until a maintainer reviews it
through an audited action. Scoring, outcomes, exit status, and human review proceed unchanged;
only publication waits. Today nothing reacts to, for example, "no scene objects found" next to
full scene-identity marks.

## Background

The suite lives in `evals/agent-runner/and-scene/` (paths relative to it unless they start with
`openspec/` or `test/`). `assembleResult` (`lib/result.mjs`) builds `result.json` from
`scoreProduct` (`lib/scorer.mjs`); `lib/evidence.mjs` has `detectEvidenceContradictions`, which
compares the candidate's own claims with evaluator evidence (`result.evidence.contradictions`) —
the comparison added here is new and kept separate. `result.json` is rewritten on every resume, so
anything a maintainer records must live in its own durable file, as `human-review.json` does.
Publication is gated by `publicationEligibility(result)` (`lib/publication.mjs`) and happens via
`publishRun` when `human-review.mjs` finalizes a run. `lib/report.mjs` renders `report.html`.

The scorer already tags every criterion record with `verdict_source` (`'owner'`, or `'fallback'`
when a not-observed deterministic criterion was resolved by its declared fallback judge) and
`source_citations`. `automated-rubric.json` is 5.0.0 with bare-id `criteria` arrays and top-level
maps (`fallbacks`); `validateAutomatedRubric` lives in `lib/rubric.mjs`.

### Rubric

Add `"contradiction_pairs": [{ "deterministic": "demo-evolving-scene-structure", "judge":
"demo-stable-identity-and-grouping", "proposition": "The demo is one evolving scene whose objects
keep a stable identity across steps." }]`. This is the only pair in 5.0.0: both criteria are about
the delivered demo and rest on the same behavior. Every other candidate pair crosses the demo/kit
boundary, where opposite verdicts are legitimate (a demo can bypass a correct kit), so none is
declared. Validation requires the first id to be deterministic-owned, the second judge-owned, and
rejects a pair whose criteria sit in components with different `reference_applicable` values. The
version stays 5.0.0; only the pinned sha256 changes (update tests, calibration fixtures, README).

### Detection

`detectEvaluatorContradictions(score, rubric)` in `lib/evidence.mjs`, next to
`detectEvidenceContradictions`, returns an entry for each pair whose two criteria are both
`verdict_source: 'owner'` with opposite verdicts, carrying both ids, verdicts, rationales, and
evidence citations. It is pure and runs in `assembleResult`. It changes no verdict, points, gate,
or product verdict.

### Hold

`lib/review-hold.mjs` owns a durable `review-hold.json` in the run directory:

```json
{ "schema_version": 1, "contradictions_sha256": "…", "contradictions": [ … ],
  "raised_at": "…", "release": null }
```

At result assembly: no contradictions and no file → nothing. Contradictions whose hash differs
from the file's (or no file) → write a new active hold. Same hash → keep the file as is, including
any release. `result.review_hold` mirrors the file (`active: release === null`), names the
contradictions and the release command, and `result.evaluator_contradictions` lists the entries,
separate from `result.evidence.contradictions`. `RESULT_SCHEMA_VERSION` 7 → 8. The hold touches
neither `lib/outcomes.mjs` nor any exit status, and resume never reruns scoring because of it.

### Release

`review-hold.sh --run-dir PATH --reviewer NAME --decision stand|verdict-wrong --rationale TEXT`, a
thin wrapper over `review-hold.mjs` in the style of `human-review.sh` / `human-review.mjs`, with
`--help`. It rejects a missing reviewer or rationale and a run with no active hold (nonzero exit,
file unchanged). `stand` writes `release` (reviewer, time, decision, rationale), rewrites result
artifacts, and, when the result is `complete`, calls the same `publishRun` path human-review
finalization uses. `verdict-wrong` writes `resolution: { decision: 'verdict-wrong', … }` and
leaves `release` null, so the result stays unpublishable for good; the maintainer fixes the
evaluator, rubric, or judge guidance and re-scores with `run.sh --rescore-from` into a new
artifact directory. A recorded `verdict-wrong` resolution is terminal: every later review action
on that run, including `stand`, is rejected with a nonzero exit and leaves `review-hold.json`
byte-identical, and publication keeps treating the hold as active. A held result is never
corrected in place. Either decision retains the
original contradiction entries unchanged.

### Publication

`publicationEligibility` returns
`{ publishable: false, reason: 'an evaluator contradiction holds this result for review', held: true }`
for an active hold, before its other checks pass through to publish. Callers treat `held` as a
clean non-publication: no `PublicationError`, no publication checkpoint. All other eligibility
rules stay as they are; a conclusive product failure without an official score remains a local
diagnostic whether or not it carries a hold. Existing publication checkpoints are unchanged.

### Report

`lib/report.mjs` adds a hold banner (states the result is held from publication and names the
release command), a contradictions section (both ids, verdicts, rationales, citations), and the
release or `verdict-wrong` record (reviewer, time, decision, rationale; a `verdict-wrong` result
states it is permanently unpublished and superseded by re-scoring). All are keyed on fields older
results lack, so older results render unchanged. Fallback-resolved marking already exists; keep it
working.

### README and check script

Document the hold and `review-hold.sh` in the suite `README.md`. Add `bash -n` for
`review-hold.sh` and `node --check` for `review-hold.mjs` and `lib/review-hold.mjs` to the `check`
script in `package.json`.

### Corpus replay obligation

`test/corpus.test.mjs` fails `npm run check` whenever any file in the deterministic evaluator's
import closure or `automated-rubric.json` changed since the committed replay records in
`corpus/replays/*.json`. This task edits the rubric, so before finishing you must rebuild and serve
each of the eight corpus candidates (loop documented in the suite `README.md`: clone
`Codagent-AI/and-scene`, check out the revision, `npm ci && npm run build`, serve, one at a time),
run `corpus-replay.mjs`, and commit the regenerated records. Every replay must still match golden.
If the real replay cannot be run in your environment, stop and report that plainly rather than
committing fabricated records.

### Constraints

- TDD; `node:test`, `mkdtemp` directories, injected git and fakes as the existing controller,
  publication, and human-review tests do. No test writes under `results/` except reading a
  committed record read-only. No third-party runtime dependencies.
- Commit messages: `type: lowercase description`.

## Spec

From `openspec/changes/make-evals-really-great/specs/product-quality-scoring/spec.md`:

### Requirement: Deterministic and LLM verdicts on one proposition are compared
The automated rubric SHALL declare which pairs of criteria, one judged by the deterministic browser evaluator and one judged by an LLM judge, answer the same proposition about the same product boundary. A pair SHALL NOT be declared between a criterion about the delivered demo and a criterion about the reusable scene kit unless both verdicts rest on the same observable behavior, so that the live demo and the reusable kit remain independently assessed.

After automated scoring, the harness SHALL compare the verdicts of every declared pair. Opposite `pass` and `fail` verdicts on a declared pair SHALL be recorded as an evaluator contradiction that retains both criterion identifiers, both verdicts, both rationales, and both evidence citations. A not-observed or fallback-resolved criterion SHALL NOT form a contradiction with its own fallback verdict. An evaluator contradiction SHALL NOT change any criterion verdict, any points, any gate, or the product verdict; it SHALL only place the result under a review hold as specified by evaluation outcomes.

#### Scenario: The browser and the source judge disagree on one proposition
- **WHEN** the deterministic evaluator records `fail` for a criterion and an LLM judge records `pass` for the criterion declared as its pair
- **THEN** the result records an evaluator contradiction with both verdicts, rationales, and citations
- **AND** neither verdict and no points change

#### Scenario: Paired criteria agree
- **WHEN** both criteria of every declared pair carry the same verdict
- **THEN** no evaluator contradiction is recorded

#### Scenario: A demo criterion and a kit criterion differ
- **WHEN** a demo criterion fails and a scene-kit criterion that is not declared as its pair passes
- **THEN** no evaluator contradiction is recorded

#### Scenario: A criterion was resolved by its fallback judge
- **WHEN** a not-observed criterion is resolved by its fallback judge
- **THEN** the not-observed record and the fallback verdict are not treated as a contradiction

From `openspec/changes/make-evals-really-great/specs/evaluation-outcomes/spec.md`:

### Requirement: Review hold for evaluator contradictions
When automated scoring records one or more evaluator contradictions, the harness SHALL place the result under a review hold. The review hold SHALL be durable run state recorded in `result.json`, separate from `evaluation_status` and from the product verdict. It SHALL NOT change `evaluation_status`, the product verdict, any score, or any gate, and it SHALL NOT be reported as an evaluation-harness failure or an implementation-workflow failure.

A held result SHALL follow its normal outcome transitions: it MAY become `pending-human-review`, human review MAY be completed, and it MAY become `complete`. Only permanent publication SHALL wait for the hold. A noninteractive run that reaches a hold SHALL NOT wait for input; it SHALL finish with the exit status its outcome would otherwise have, and `result.json` SHALL name the hold, the contradictions that caused it, and the maintainer action that releases it.

A maintainer SHALL resolve a hold through an explicit review action that records the reviewer, the time, a decision, and a rationale. The decision SHALL be one of two. When the verdicts stand as scored, the hold is released. When a verdict is wrong, the hold SHALL stay in place permanently, the result SHALL never be published, and the correction SHALL be made where the error lives, in the evaluator, the rubric, or the judge guidance, followed by re-scoring the candidate into a new evaluation record; a held result SHALL NOT be corrected in place. Either decision SHALL retain the original contradiction record unchanged. A release SHALL be rejected when it names no reviewer or no rationale, or when the run has no active hold. A released hold SHALL NOT be re-raised by resume or by regenerating the report from the same scored evidence; re-scoring that produces a new contradiction SHALL raise a new hold.

Resume SHALL preserve an active hold and a recorded release. Resuming a held run SHALL NOT rerun scoring solely because of the hold.

#### Scenario: A contradiction holds a result that is otherwise eligible
- **WHEN** automated scoring of a candidate records an evaluator contradiction and the candidate reaches automated eligibility
- **THEN** `evaluation_status` becomes `pending-human-review` as it otherwise would
- **AND** `result.json` records an active review hold naming the contradiction and the release action

#### Scenario: An unattended run reaches a hold
- **WHEN** a noninteractive run records an evaluator contradiction
- **THEN** the run does not wait for input
- **AND** it exits with the status its outcome would otherwise have
- **AND** the hold is recorded in `result.json`

#### Scenario: Human review completes under a hold
- **WHEN** a maintainer completes human review of a held result
- **THEN** the result becomes `complete` with its official score and product verdict
- **AND** the review hold remains active

#### Scenario: A maintainer releases a hold
- **WHEN** a maintainer records a review decision that the verdicts stand, with a reviewer and rationale
- **THEN** the hold is released
- **AND** the original contradiction record is retained unchanged alongside the release

#### Scenario: A maintainer finds a verdict wrong
- **WHEN** a maintainer reviewing a hold decides one of the contradicting verdicts is wrong
- **THEN** the decision and rationale are recorded and the hold stays in place
- **AND** the result is never published
- **AND** the candidate is re-scored into a new evaluation record after the evaluator, rubric, or judge guidance is corrected

#### Scenario: A release is incomplete
- **WHEN** a release action names no reviewer or no rationale
- **THEN** the release is rejected and the hold remains active

#### Scenario: A held run is resumed
- **WHEN** a run with an active review hold is resumed
- **THEN** the hold and its contradictions are preserved
- **AND** scoring is not rerun because of the hold

#### Scenario: A released run is resumed
- **WHEN** a run whose hold was released is resumed without re-scoring
- **THEN** the hold stays released

From `openspec/changes/make-evals-really-great/specs/evaluation-metrics-reporting/spec.md`:

### Requirement: Held results are not published
Permanent result publication SHALL refuse a result that is under an active review hold, SHALL say that the hold is the reason, and SHALL leave any existing published snapshot unchanged. A result whose hold has been released SHALL be publishable under the existing publication rules, and its permanent snapshot SHALL include the contradiction record and the release. Refusing a held result SHALL NOT be recorded as a retryable publication failure, because retrying without a release cannot succeed. All other publication eligibility rules SHALL remain unchanged; in particular a conclusive product failure without an official score SHALL remain a local diagnostic.

#### Scenario: Publication is attempted under an active hold
- **WHEN** human review finalizes a candidate whose result is under an active review hold
- **THEN** the result is not published
- **AND** the harness reports that the review hold prevents publication
- **AND** no retryable publication checkpoint is recorded for it

#### Scenario: A released result is published
- **WHEN** a finalized result's review hold has been released
- **THEN** the result is published under the existing publication rules
- **AND** the published result retains the contradiction record and the release

#### Scenario: A failed candidate without an official score is not published
- **WHEN** a candidate conclusively fails an automated hard gate and has no official score
- **THEN** it remains a local diagnostic and is not published, whether or not it carries a review hold

This task delivers the contradiction and hold portion of the following requirement (second
paragraph; scenarios "An active hold is reported" and "A released hold is reported") and must keep
the already-delivered fallback reporting and "An earlier published result is rendered" passing:

### Requirement: Verdict source and review hold reporting
`result.json` and `report.html` SHALL identify, for every scored deterministic criterion, whether its verdict came from the owning evaluator or from a declared fallback judge. A fallback-resolved criterion SHALL be visibly marked in the report as decided by the LLM because the browser check could not observe it, and SHALL show both the browser's not-observed record, including the conventions it looked for, and the fallback judge's verdict, rationale, and source citations. The result SHALL record the count of fallback-resolved criteria and the points they carry, so a reader can see how much of an automated score rests on fallback verdicts.

When a result carries evaluator contradictions, `result.json` and `report.html` SHALL present each contradiction with both criterion identifiers, verdicts, rationales, and evidence citations, kept separate from contradictions between candidate-produced and evaluator-produced evidence. When a review hold is active, the report SHALL state prominently that the result is held from publication and what releases it. When a hold has been released, or a maintainer has recorded that a verdict is wrong, the report SHALL show the reviewer, time, decision, and rationale, and SHALL keep the original contradiction visible; a result whose hold records a wrong verdict SHALL state that it is permanently unpublished and superseded by re-scoring.

A result that predates this capability and carries no verdict-source data SHALL render as before and SHALL NOT be shown as fallback-resolved or held.

#### Scenario: A fallback-resolved criterion is reported
- **WHEN** a result contains a criterion resolved by its fallback judge
- **THEN** the report marks that criterion as decided by the LLM because the browser check could not observe it
- **AND** it shows the not-observed record and the fallback verdict with its citations
- **AND** the result records the number of fallback-resolved criteria and their points

#### Scenario: No criterion needed a fallback
- **WHEN** every deterministic criterion was observed
- **THEN** the result records zero fallback-resolved criteria
- **AND** the report shows no fallback marking

#### Scenario: An active hold is reported
- **WHEN** a result is under an active review hold
- **THEN** the report states that the result is held from publication and names the release action
- **AND** each evaluator contradiction is shown with both verdicts, rationales, and citations

#### Scenario: A released hold is reported
- **WHEN** a result's review hold has been released
- **THEN** the report shows the reviewer, time, decision, and rationale
- **AND** the original contradiction remains visible

#### Scenario: An earlier published result is rendered
- **WHEN** a report is regenerated for a result that carries no verdict-source data
- **THEN** the report renders without fallback or hold markings


## Test Plan

- **INT-003: review hold lifecycle across result assembly, resume, release, and publication**
  (`test/review-hold.test.mjs`, CI). Boundary: `assembleResult` + `lib/review-hold.mjs` +
  `review-hold.mjs` CLI + `publicationEligibility`/`publishRun`, on a real temporary run directory
  with an injected git. Inputs: `demo-evolving-scene-structure` owner `fail` with
  `demo-stable-identity-and-grouping` `pass`; a second set where the first is fallback-resolved; a
  third where an undeclared demo/kit pair disagrees. Actions: assemble; assemble again (resume);
  attempt publication; run the review action with no reviewer, with no rationale, against a run
  with no hold, then validly with `stand`; assemble again; publish; re-score to a different
  contradiction set. On a second held run directory, record `verdict-wrong`, assemble again, and
  attempt publication. Assert: `review-hold.json` is written once and is byte-stable across
  reassembly; `result.review_hold.active` is true and `evaluation_status`, product verdict, scores,
  and gates equal those of the same inputs without a contradiction; publication returns `held`
  with the hold reason, throws no `PublicationError`, and writes no publication checkpoint; invalid
  releases exit nonzero and leave the file unchanged; a valid release records reviewer, time,
  decision, and rationale and keeps the contradiction entries unchanged; after release the result
  publishes and the snapshot's `result.json` contains the contradiction and the release;
  `verdict-wrong` records reviewer, decision, and rationale, survives reassembly, and leaves the
  result permanently unpublishable with the hold reason; a later `stand` attempt on that
  `verdict-wrong` run exits nonzero, leaves `review-hold.json` byte-identical, and the result
  stays unpublishable; a changed contradiction set raises a new
  active hold; the fallback-resolved and undeclared-pair inputs raise none.
- **INT-008: results published before this change still load, render, and validate**
  (`test/legacy-result.test.mjs`, CI). Copy one committed published result that carries a technical
  adjudication from `evals/agent-runner/and-scene/results/` into a temporary directory. Render its
  report with the new code; run `publicationEligibility`; run technical-adjudication supersession
  validation (`lib/adjudication.mjs`) against its committed predecessor state as the existing tests
  do. Assert: rendering succeeds with no fallback marking, hold banner, or contradiction section;
  eligibility is unchanged; supersession validation passes; the committed record is not modified.
- **E2E-002: a contradiction holds a finalized result until a maintainer releases it**
  (`test/review-hold-journey.test.mjs`, CI). Surface: the controller, `human-review.mjs`, and
  `review-hold.mjs` entry points, with an injected git and a temporary repository directory. Fakes
  produce the declared contradiction and an otherwise eligible automated score; a scripted human
  review. Journey: run automated phases; finalize human review; run the release command with
  `stand`. Assert: the automated run exits as an ordinary pending run and names the hold and
  release command in `result.json`; human review finalizes to `complete` with an official score
  while nothing is published and no publication checkpoint exists; the report shows the hold banner
  and both verdicts; after release exactly one result commit is made and the report shows the
  release record with the contradiction still visible.

## Done When

- Every scenario of the requirements above assigned to this task is covered by a passing test.
- INT-003, INT-008, and E2E-002 pass in CI conditions (no browser, network, or model calls).
- `review-hold.sh --help` describes the command; the suite `README.md` documents the hold.
- The corpus replay records are regenerated from real replays and `test/corpus.test.mjs` passes.
- `npm run check` passes. Nothing under `results/` changed.
