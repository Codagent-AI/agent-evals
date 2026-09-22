# Task: Not-observed outcome for deterministic criteria, resolved by a declared fallback judge

## Goal

Make "could not find it" impossible to record as a product failure, without giving candidates a
way to dodge a failure by hiding things. Scored deterministic browser criteria gain a third
outcome, not observed, that is deliberately narrow; the rubric declares a fallback LLM judge for
the two scene-object criteria; the judge receives the browser observation and must cite source for
a pass; the scorer substitutes and tags the fallback verdict; and `result.json` and `report.html`
flag the criterion as LLM-resolved. The run finishes unattended.

## Background

The suite lives in `evals/agent-runner/and-scene/` (paths relative to it unless they start with
`openspec/` or `test/`). Phases (`lib/phases.mjs`): `browser-evaluation` →
`runBrowserEvaluation` (`lib/browser-eval.mjs`) over `createAxiBrowserDriver`
(`lib/axi-browser-driver.mjs`); `product-judging` → six sequential LLM judge jobs
(`lib/judge-jobs.mjs`, `judge-manifest.mjs`); `pending-result` → `assembleResult`
(`lib/result.mjs`) from `scoreProduct` (`lib/scorer.mjs`); `lib/report.mjs` renders `report.html`.

Facts to build on:

- `automated-rubric.json` (5.0.0) has `components[].subcomponents[]`, each with `evaluator`,
  optional `job`, `points`, `criteria` as **bare string ids**, and optional `review_guidance`.
  Criterion points are `points / criteria.length`. `rubricCriteria()` flattens this;
  `validateAutomatedRubric()` (`lib/rubric.mjs`) rejects duplicate ids. Keep criteria as bare ids;
  new data goes in top-level rubric maps.
- `scoreProduct` indexes each source's results against the exact id set the rubric assigns it
  (`indexResults`), accepts only `pass`/`fail` for scored criteria, and allows `verdict: null`
  only for hard gates (`allowUnobserved`).
- A probe returns `[ok, rationale, evidence]`; `unobserved()` exists but only gates use it. Every
  probe retains a bounded observation.
- Judge jobs are cached by input hash (`runProductJudging`: job, criteria, prompt, rubric sha).
  `parseJudgeOutput(text, expectedIds, job, { requireSourceCitations })` enforces exact coverage.
- The driver's state carries `entityConventions`, the list of scene-object selectors it looked for
  (`data-layout-id`, `data-scene-entity`, `data-node`, `data-entity-id`, `data-scene-node`).

### Rubric

Add a top-level map:

```json
"fallbacks": {
  "demo-required-scene-content": {
    "job": "demo-integration",
    "requirement": "Every step renders the scene content the fixture requires for it.",
    "guidance": ["…cite the step definitions that declare each step's scene objects…"] },
  "demo-evolving-scene-structure": {
    "job": "demo-integration",
    "requirement": "The nine steps are one evolving scene whose objects persist across steps.",
    "guidance": ["…cite the identity each persisting object carries across steps…"] } }
```

`validateAutomatedRubric` requires each key to be a deterministic-browser criterion and each `job`
to be a known judge job. These two are the only fallbacks: every other deterministic criterion
rests on reader-visible facts, so absence there is a `fail`. The version stays 5.0.0; only the
pinned sha256 changes (update tests, calibration fixtures, README pins). Criteria, points, floors,
gates, and owners do not change. Hard gates get no fallbacks and their handling is untouched.

### Evaluator

Probes may return `notObserved(rationale, evidence, lookedFor)` in place of a tuple. The probe
runner turns it into
`{ id, verdict: null, outcome: 'not-observed', looked_for, rationale, evidence, observed: false }`
and refuses it, as a harness defect, for a criterion with no declared fallback. The two scene
probes change:

- `demo-required-scene-content`: a caption mismatch is `fail`. Otherwise, when any step has no
  recognised entity ids, not observed; a convention seen on some steps is not proof another step
  lacks content. Otherwise `pass`.
- `demo-evolving-scene-structure`: `fail` only on positive evidence, meaning entities were
  identified on two consecutive steps and none persisted between them, or a declared scene
  identity changed. When any step has no recognised entity ids and no such positive evidence
  exists, not observed. Otherwise judged as today.

An unreadable page state, an adapter diagnostic, and an ambiguous control stay resumable harness
failures. Absence of a reader-visible element (step title, step numbering, browse caption,
operable navigation control) stays `fail`.

### Judging

`controller.mjs` already has the deterministic results when `product-judging` starts. Pass
`notObserved` (id, rationale, looked_for, bounded observation) into `runProductJudging`.
`productJudgeJobs` appends to a job's `criteria` the not-observed ids whose fallback names that
job; `buildJudgeRequest` appends a "Browser check could not observe" section with each fallback's
requirement, guidance, and observation, and tells the judge to treat the observation as a lead,
not an authoritative verdict. Because criteria and prompt feed the job's input hash, caching and
resume need no new code. `parseJudgeOutput` gains `requireSourceCitationsFor: [ids]`: a `pass` for
those ids without a delivered-source citation raises `JudgeOutputError`, which consumes a retry
like any invalid output. The existing source audit applies to those citations.

### Scoring

Resolution is per criterion, inside `scoreProduct`:

1. Index the deterministic results with exact coverage, accepting a not-observed row as
   resolvable only for an id in `fallbacks` (`indexResults` gains `allowNotObservedFor: Set`).
   The conforming evaluator never emits a not-observed row for a criterion without a fallback
   (its probe runner refuses it as a harness defect), but the scorer must still be defensive: if
   such a row is supplied anyway, `scoreProduct` does not score it `fail` and does not reject the
   whole deterministic source; it resolves that criterion as `unresolved`, so its subcomponent and
   component are incomplete and the official verdict is unavailable rather than failed (scenario
   "A criterion without a fallback cannot be observed").
2. Index each judge job against its owned ids plus the not-observed ids that name it. A fallback
   verdict for an observed criterion is "unknown criterion" and a missing one is "missing
   criterion", both existing `RubricValidationError`s.
3. Build a resolution map: each deterministic id resolves to `owner` (its own verdict),
   `fallback` (the judge's verdict, with `fallback_job`, the retained `not_observed` record, and
   the judge's `source_citations`), or `unresolved` (the fallback job has no results).

`scoreSubcomponent` reads from the resolution map and computes `complete` from its own criteria,
replacing today's `Boolean(indexed)`: a subcomponent is incomplete only when one of its criteria is
unresolved, so sibling deterministic subcomponents keep their scores. A not-observed row whose
fallback job produced no results leaves its subcomponent incomplete (`complete: false`, points
`null`), never `fail`; the existing exhausted-judge outcome applies. Criterion records for every
evaluator gain `verdict_source` and `source_citations` (today the scorer drops the judge's
`citations` array). The score gains `fallback: { criteria: n, points: p }`.
`SCORE_SCHEMA_VERSION` 3 → 4. The fallback verdict is substituted in the scorer, not in the
browser artifact, which stays a faithful record of what the browser saw.

### Result and report

`result.json` carries the per-criterion verdict source, the retained not-observed record
(including `looked_for`), the fallback verdict with rationale and citations, and the fallback
count and points. `lib/report.mjs` adds a "decided by the LLM because the browser check could not
observe it" badge and detail block on fallback criteria and a fallback summary line. Key all of it
on fields older results lack, so a schema-7 / score-schema-3 result renders unchanged with no
fallback marking. Bump `RESULT_SCHEMA_VERSION` only if the result shape you add requires it; every
new field must be optional on read.

### Corpus replay obligation

The repository has a golden-verdict corpus (`corpus/candidates.json`, `corpus/replays/*.json`,
`corpus-replay.mjs`, `lib/corpus.mjs`; loop documented in the suite `README.md`).
`test/corpus.test.mjs` fails `npm run check` whenever any file in the evaluator's import closure
or `automated-rubric.json` changed since the committed replay records. This task edits both, so
before finishing you must rebuild and serve each of the eight corpus candidates (clone
`Codagent-AI/and-scene`, check out the revision, `npm ci && npm run build`, serve, one at a time),
run the replay, and commit the regenerated records. Expected: every replay still matches golden;
issue #26 repetition 2 passes both scene criteria through a recognised convention, not the
fallback. A golden verdict changes only with a `history` entry whose explanation cites the fixture
text or evaluator defect. If the real replay cannot be run in your environment, stop and report
that plainly rather than committing fabricated records.

### Constraints

- TDD; `node:test`, `mkdtemp` directories, injected fakes for the driver and judge invoker. No test
  writes under `results/`. No third-party runtime dependencies.
- Add any new module to the `node --check` list in `package.json`.
- Commit messages: `type: lowercase description`.

## Spec

From `openspec/changes/make-evals-really-great/specs/product-quality-scoring/spec.md`:

### Requirement: Deterministic criteria fail only on positive evidence
A scored deterministic browser criterion SHALL have exactly three outcomes: `pass`, `fail`, and not observed. The evaluator SHALL record `fail` only when it holds positive evidence that the candidate violates the requirement the criterion enforces, such as visible text that differs from the normative text, an input that lands on the wrong step, or a browser failure raised by the page. The evaluator SHALL NOT record `fail` because it could not locate the thing it needed to inspect.

Not observed SHALL be deliberately narrow, because the candidate controls what a browser can see. It SHALL apply only when a check depends on a markup convention that the pinned fixture does not mandate, and the evaluator finds no instance of any convention it recognises. The absence of something a reader must be able to see or do, including an active step title, step numbering derived from position, a caption in browse mode, or an operable navigation control, SHALL be positive evidence of a violation and SHALL be recorded as `fail`. An unreadable page state, an adapter diagnostic, and an ambiguous control SHALL remain resumable harness failures as already specified and SHALL NOT be recorded as not observed.

A criterion that combines a reader-visible fact with a convention-dependent fact SHALL be judged in that order: a violation of the reader-visible fact SHALL be recorded as `fail` regardless of whether the convention-dependent fact was observed. Finding a recognised convention on some steps SHALL NOT be treated as proof that a step without one lacks content: when the convention-dependent fact cannot be established for every step it concerns, that fact is not observed. A convention-dependent `fail` SHALL rest on what positively identified objects show, such as identified objects being replaced rather than persisting between steps.

A not-observed record SHALL retain the same bounded observation as any other probe, and SHALL state which conventions the evaluator looked for and that it found none.

#### Scenario: Scene objects use an attribute name the evaluator does not know
- **WHEN** the demo renders the required scene and marks its scene objects with an attribute name the evaluator does not recognise
- **THEN** `demo-evolving-scene-structure` is recorded as not observed
- **AND** no points are deducted by the deterministic evaluator for that criterion
- **AND** the record lists the conventions the evaluator looked for

#### Scenario: Captions are wrong and scene objects are not found
- **WHEN** a step's caption differs from the normative caption and the evaluator also finds no scene objects
- **THEN** `demo-required-scene-content` is recorded as `fail` on the caption evidence
- **AND** it is not recorded as not observed

#### Scenario: Captions are right and scene objects are not found
- **WHEN** every step's caption matches the normative caption and the evaluator finds no scene objects under any convention it recognises
- **THEN** `demo-required-scene-content` is recorded as not observed

#### Scenario: Scene objects are recognised on only some steps
- **WHEN** every caption matches and the evaluator recognises scene objects on some steps and none on others
- **THEN** `demo-required-scene-content` is recorded as not observed
- **AND** it is not recorded as `fail` for the steps where nothing was recognised

#### Scenario: Identified scene objects are replaced between steps
- **WHEN** the evaluator identifies scene objects on consecutive steps and none of the identified objects persists from one step to the next
- **THEN** `demo-evolving-scene-structure` is recorded as `fail` on that evidence

#### Scenario: A reader-visible element is hidden
- **WHEN** the presentation hides its active step title from readers in present mode
- **THEN** `demo-present-mode-behavior` is recorded as `fail`
- **AND** it is not recorded as not observed

#### Scenario: Scene objects are found
- **WHEN** the evaluator finds scene objects under a convention it recognises
- **THEN** the scene criteria are judged `pass` or `fail` from what it observed
- **AND** no fallback judge is consulted for them

### Requirement: Declared fallback judge for not-observed criteria
The automated rubric SHALL declare, for each deterministic criterion that can be recorded as not observed, at most one fallback judge. The fallback declaration SHALL NOT make the fallback judge an owner of the criterion: the criterion SHALL keep its single owning evaluator, its identifier, and its points, and the rubric SHALL continue to reject duplicate criterion ownership. A deterministic criterion with no declared fallback SHALL NOT be recordable as not observed by a conforming evaluator; if one is nevertheless returned, scoring SHALL treat its component as incomplete.

When a criterion with a declared fallback is recorded as not observed, the harness SHALL ask the declared fallback judge for a verdict on that criterion in that run only. The judge SHALL receive the criterion's requirement and guidance, the bounded browser observation, and the statement of which conventions were looked for. The judge SHALL return `pass` or `fail` with a rationale. A `pass` SHALL cite delivered candidate source that establishes the requirement; a `pass` without such a citation SHALL be rejected as invalid judge output. The judge SHALL treat the browser observation as a lead rather than an authoritative verdict, consistent with existing source-review rules.

Exact criterion coverage SHALL continue to hold in both directions for every evaluator. In a run with not-observed criteria, the fallback judge's expected criterion set SHALL be its owned criteria plus exactly the not-observed criteria that name it as fallback; a fallback verdict for a criterion that was observed, or a missing fallback verdict, SHALL be invalid coverage.

Points SHALL only ever be awarded from a binary `pass` or `fail` verdict; not observed is an unresolved state, never a scored verdict. The scorer SHALL award a fallback-resolved criterion the same points it would award for the same verdict from its owner. It SHALL record, for every scored criterion, whether the verdict came from the owning evaluator or from the fallback judge, and SHALL retain the fallback judge's source citations. An unresolved criterion SHALL make only its own subcomponent and component incomplete; other deterministic subcomponents SHALL keep their scores. When the fallback verdict is missing after the judge's retry budget is exhausted, the criterion's component SHALL be incomplete and the existing missing-judge-output outcome SHALL apply; a missing fallback verdict SHALL never be scored as `fail`.

Hard-gate handling of unobserved evidence SHALL NOT change. Hard gates SHALL NOT have fallback judges.

#### Scenario: A not-observed criterion is resolved by its fallback judge
- **WHEN** `demo-evolving-scene-structure` is recorded as not observed and its declared fallback judge returns `pass` citing the delivered source that keeps scene objects across steps
- **THEN** the criterion is awarded its full points
- **AND** the score records that the verdict came from the fallback judge
- **AND** the evaluation proceeds without waiting for a maintainer

#### Scenario: The fallback judge finds the requirement unmet
- **WHEN** a criterion is recorded as not observed and its fallback judge returns `fail` with a rationale
- **THEN** the criterion is awarded no points
- **AND** the score records that the verdict came from the fallback judge

#### Scenario: A fallback pass cites no source
- **WHEN** the fallback judge returns `pass` for a not-observed criterion without citing delivered candidate source
- **THEN** the harness rejects the output as invalid judge output
- **AND** the criterion is not awarded points on that output

#### Scenario: The fallback verdict never arrives
- **WHEN** a criterion is recorded as not observed and the fallback judge produces no valid verdict within its retry budget
- **THEN** the criterion's component is incomplete
- **AND** the criterion is not scored as `fail`

#### Scenario: One unresolved criterion does not erase its siblings
- **WHEN** one deterministic criterion is not observed and unresolved, and every other deterministic criterion was observed
- **THEN** only the subcomponent containing the unresolved criterion is incomplete
- **AND** the other deterministic subcomponents report their awarded points

#### Scenario: A fallback judge answers for an observed criterion
- **WHEN** a judge returns a verdict for a deterministic criterion that the browser evaluator observed
- **THEN** scoring rejects the judge output as invalid criterion coverage

#### Scenario: A candidate suppresses hooks to avoid a browser failure
- **WHEN** a candidate removes every recognised scene-object hook and its source does not keep scene objects across steps
- **THEN** the criterion is recorded as not observed and the fallback judge returns `fail`
- **AND** the candidate gains no points by having hidden the hooks

#### Scenario: A criterion without a fallback cannot be observed
- **WHEN** a deterministic criterion with no declared fallback is returned as not observed
- **THEN** its component is incomplete
- **AND** the official verdict is unavailable rather than failed

From `openspec/changes/make-evals-really-great/specs/evaluation-metrics-reporting/spec.md`. This
task delivers the verdict-source and fallback portion (first paragraph, last paragraph, and the
scenarios "A fallback-resolved criterion is reported", "No criterion needed a fallback", and "An
earlier published result is rendered"); contradiction and hold reporting is outside this task:

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

- **INT-001: a not-observed criterion flows from browser evaluation to a scored, tagged verdict**
  (`test/not-observed-flow.test.mjs`, CI). Boundary: `runBrowserEvaluation` → `runProductJudging`
  (`productJudgeJobs`, `buildJudgeRequest`, `parseJudgeOutput`) → `scoreProduct`, using the real
  `automated-rubric.json`. Fake driver with correct captions and no entity ids on any step; fake
  judge invoker answering `demo-integration`. Repeat with the invoker returning `fail`, a `pass`
  with no source citation, no verdict for the fallback id, and a fallback verdict for an observed
  criterion. Assert: both scene criteria are not observed with `looked_for` populated; the
  `demo-integration` request's criteria are its owned ids plus exactly those two, and its prompt
  carries the fallback requirement, guidance, and observation; a cited `pass` awards full criterion
  points with `verdict_source: 'fallback'`; `fail` awards zero; an uncited `pass` raises
  `JudgeOutputError` and consumes a retry; an exhausted job leaves the deterministic subcomponent
  incomplete with `points_awarded: null` and no `fail`; when the fallback is unresolved, only the
  subcomponent containing that criterion is incomplete and the other deterministic subcomponents
  keep their awarded and observed points; a verdict for an observed criterion is rejected as
  invalid coverage; `fallback.criteria` and `fallback.points` match; the fallback judge's
  `source_citations` are retained on the criterion record; every other criterion is
  `verdict_source: 'owner'`. A second driver with recognised scene objects on some steps only
  yields not observed, not `fail`; a third whose identified objects are all replaced between two
  steps yields `fail`.
- **INT-002: judge-job caching and resume stay correct when the not-observed set changes**
  (`test/not-observed-flow.test.mjs`, CI). `runProductJudging` with real `loadJob`/`saveJob`
  persistence in a temporary run directory: one run with no not-observed criteria, saved; then the
  same inputs with one not-observed criterion; then the second rerun unchanged. Assert: the
  `demo-integration` input hash differs between configurations so the cached job is not reused
  across them; the unchanged rerun reuses the cached job and invokes no judge; jobs that are not a
  fallback target keep their hash in both configurations.
- **INT-007 page (c): real browser, suppressed hooks.** Add to `test/real-browser/pages/` a correct
  scene with no recognised scene-object hook and extend `test/real-browser/adversarial.test.mjs`
  (outside the CI glob; needs Chrome and `chrome-devtools-axi`; serves each static page on a local
  port and runs the production evaluator). Assert both scene criteria are recorded as not observed
  with `looked_for` listing the conventions. Rerun the whole file locally, including the existing
  page whose hidden present-mode step title must still `fail` `demo-present-mode-behavior` and not
  be recorded as not observed.
- **E2E-001: a candidate with unrecognised scene markup is evaluated to a pending result
  unattended** (`test/controller.test.mjs`, CI). Drive the controller entry point as the existing
  controller tests do: temporary artifact directory; fake driver with correct content and no
  recognised scene objects; fake judge invoker returning a cited `pass` for the fallback criteria;
  other phases faked. Run the automated phases to completion without input, then resume the same
  directory. Assert: the run ends `pending-human-review` with a zero exit and no prompt;
  `result.json` marks the two criteria fallback-resolved with their not-observed records and judge
  citations and reports the fallback count and points; `report.html` contains the "decided by the
  LLM because the browser check could not observe it" marking for exactly those criteria; resume
  invokes no judge and produces an equal result.

## Done When

- A direct `scoreProduct` test supplies a not-observed row for a deterministic criterion with no
  declared fallback and shows its component incomplete and the official verdict unavailable, not
  failed; a separate evaluator-level test shows the probe runner refusing such a return as a
  harness defect.
- Every scenario of the two product-quality-scoring requirements above, and the three assigned
  reporting scenarios, is covered by a passing test, including adversarial candidates that suppress
  hooks, accessibility semantics, titles, and object identity.
- INT-001, INT-002, and E2E-001 pass in CI conditions; INT-007 passes locally with page (c) added
  (state in the final report whether it was run and its result).
- A result with no verdict-source data renders with no fallback marking.
- The corpus replay records are regenerated from real replays and `test/corpus.test.mjs` passes.
- `npm run check` passes. Nothing under `results/` changed.
