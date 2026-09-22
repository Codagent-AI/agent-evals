## Context

All paths are relative to `evals/agent-runner/and-scene/` unless they start with
`openspec/` or `test/`.

The suite scores a candidate in ordered phases (`lib/phases.mjs`): `browser-evaluation`
runs the 14 deterministic criteria through `runBrowserEvaluation` (`lib/browser-eval.mjs`)
over `createAxiBrowserDriver` (`lib/axi-browser-driver.mjs`); `product-judging` then runs
six sequential LLM judge jobs (`lib/judge-jobs.mjs`); `pending-result` assembles
`result.json` (`lib/result.mjs`) from `scoreProduct` (`lib/scorer.mjs`).

Facts the design rests on:

- **Rubric shape.** `automated-rubric.json` (4.0.0) has `components[].subcomponents[]`,
  each with `evaluator`, optional `job`, `points`, `criteria` as **bare string ids**, and
  optional `review_guidance` strings. Criterion points are `points / criteria.length`.
  `rubricCriteria()` flattens this; `validateAutomatedRubric()` rejects duplicate ids.
- **One owner per criterion.** `scoreProduct` indexes each source's results against the
  exact id set the rubric assigns it (`indexResults`), accepts only `pass`/`fail` for
  scored criteria, and allows `verdict: null` only for hard gates (`allowUnobserved`).
- **Probes return tuples.** A probe returns `[ok, rationale, evidence]`; `unobserved()`
  exists but only gates use it.
- **Judge jobs are cached by input hash** (`runProductJudging`: job, criteria, prompt,
  rubric sha). `parseJudgeOutput(text, expectedIds, job, { requireSourceCitations })`
  enforces exact coverage.
- **`result.json` is rewritten on every resume**, so anything a maintainer records must
  live in its own durable file, as `human-review.json` does.
- **Publication** is gated by `publicationEligibility(result)` (`lib/publication.mjs`) and
  happens when `human-review.mjs` finalizes a run.
- **Scene objects** are discovered in the driver's page script from a fixed selector list
  under `STAGE_SELECTOR`, with synthetic ids for `data-presentation-*` hooks.
- **Technical adjudication** has no CLI; approved adjudications are applied by one-off
  operator scripts that call `applyTechnicalAdjudication` (`lib/adjudication.mjs`).
- `lib/reference-browser-regression.mjs` already replays the evaluator against an
  externally built and served presentation with a fixed build/verification stub.

Constraints: no third-party runtime dependencies, no shared framework, TDD, never
hand-edit `results/**`, never rename an OpenSpec `#### Scenario:` header, commit messages
`type: lowercase description`.

## Goals / Non-Goals

**Goals:**
- Remove the four known wrong deductions and restore the five affected records.
- Make "could not find it" impossible to record as a product failure, without giving
  candidates a way to dodge a failure by hiding things.
- Make an evaluator or rubric change unmergeable until real candidates were replayed.
- Make rubric text that contradicts the pinned fixture fail `npm run check`.
- Surface opposing browser and LLM verdicts on one proposition before publication.

**Non-Goals:**
- Changing criteria, points, floors, gates, owners, or the fixture pins.
- Majority-vote judging, a record type for failed runs, re-scoring the six published
  runs under the new rubric, signed manifests, generic DOM discovery of scene objects.
- A general adjudication CLI.

## Approach

### Phase 0: settle the in-flight change

On the feature branch cut from `dev`, first edit
`openspec/changes/2026-09-20-harden-deterministic-browser-judging/specs/product-quality-scoring/spec.md`:

- "A control is activated the way a pointer activates it": keep the focus-before-fire
  THEN line; replace the AND line so it says a presentation that ignores deck keys while
  that control holds focus is observed **and is not deducted for it**.
- "Controls exist only in browse mode": keep the first THEN; replace the AND line so it
  says the check moves focus off the control before requiring a deck key to advance.
- In the requirement paragraph, leave the activation sentence as is; it is neutral.
- In the MODIFIED "Official product score" requirement, replace "Automated criteria SHALL
  use binary pass/fail verdicts." with "Automated criteria SHALL award points only from
  binary pass/fail verdicts. A deterministic evaluator MAY report a criterion as not
  observed; that criterion is unresolved until a declared fallback judge supplies a
  pass/fail verdict." This sentence also exists in `openspec/specs/` today, and an ADDED
  requirement cannot amend it, so it must be corrected before the archive.
- In the scenario "Deterministic demo behavior is scored", change "their pass/fail
  results" to "their resolved pass/fail results".

Headers stay byte-identical. Then run `openspec archive
2026-09-20-harden-deterministic-browser-judging` and commit. This change's deltas are all
`## ADDED Requirements`, so they apply cleanly to the archived specs and cannot clobber
the large "Demo presentation technical quality" block.

### Phase 1: immediate corrections

**Control keys** (`browser-eval.mjs`, probe `demo-navigation-boundaries-and-control-keys`).
Keep the clamp half unchanged. Replace the key half:

1. Establish the mode that exposes controls (unchanged) and `activate(controls[0].name)`,
   which still focuses then clicks.
2. Press `ArrowRight` while the control holds focus. Record `before → after` in the
   observation as `keys_while_control_focused`. It never affects the verdict, in either
   direction; pass-through from a focused button is left to the scene-kit criterion
   `navigation-controls-keep-keys`.
3. Call a new driver primitive `releaseFocus()`, written as an interpolated page script
   like the other build-independent primitives from `cc2a18e`. It focuses the
   presentation root (the `PRESENTATION_SELECTOR` element), adding `tabindex="-1"` only
   when the root is not already focusable and removing it again in `restoreFocusTarget()`
   after the key press, so no candidate DOM change outlives the probe. Focus stays inside
   the presentation, so a key listener on the root and one on `document` both receive
   the event. It returns whether `document.activeElement` is now a non-interactive
   element (not `a`, `button`, `input`, `select`, `textarea`, `summary`, or an element
   with an interactive ARIA role); when it is not, the probe raises a resumable
   `HarnessFailure` instead of a verdict.
4. Press a deck key and require a one-step move: `ArrowRight`, or `ArrowLeft` when the
   deck is already on its last step. Record as `keys_after_focus_released`.

`ok = clampsHold && keysAfterFocusReleased`.

**Canvas size.** `scene-fixed-canvas` guidance becomes 880×380.

**Scene-object conventions.** Add `[data-entity-id]` and `[data-scene-node]` to the
driver's selector list and explicit-id lookup, because a real candidate used them. The
driver's state gains `entityConventions`: the list of selectors it looked for. This keeps
more candidates on the deterministic path; phase 3 covers whatever is still unknown.

**Records.** One operator script per record, modelled on the earlier approved scripts,
applies `applyTechnicalAdjudication` to overturn the `16401c1` deduction, then the report
is regenerated and the record republished as a valid adjudication supersession. Each one
is presented to the user for approval before it runs.

### Phase 2: golden corpus (`corpus/`, `corpus-replay.mjs`, `lib/corpus.mjs`)

```
corpus/
  candidates.json        golden verdicts with their basis and history
  replays/<id>.json      one generated replay record per candidate
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
                    "explanation": "Initial adjudication from the 2026-09-21 audit." }] } } }] }
```

`basis` is required for `fail` and `not-observed`. `outcome` must equal the last `history`
entry's outcome and every entry needs an explanation, so a golden verdict cannot change
without a recorded reason. The explanation lives with the verdict rather than in a
separate log, which keeps validation structural and free of any dependency on a previous
manifest or on git history.

Scope is the 14 deterministic criteria plus the two gates derived from browser
observation, `verification-sample-outline` and `verification-every-produced-step-renders`.
`runBrowserEvaluation` also returns `verification-build-whole-app` and
`verification-clear-outcome`, but the replay feeds those from a fixed stub, exactly as the
reference regression does, so they are kept in the replay record as diagnostics and are
not golden. The eight entries are astra `6273deff…`, config `44c8e817…`, cutover
`785f48d2…`, localcodex `5d5adf57…`, sameprofile `9a2b54d4…`, and the three issue #26
heads (and-scene PRs #21–#23, full SHAs resolved from those PRs). Initial golden values
for the five published candidates come from the 2026-09-21 audit's replay; for the three
repetitions they come from the same audit's per-repetition findings, each with a `basis`
citing the fixture. All are confirmed by the first replay, and any disagreement is
adjudicated against the fixture text before the golden file is committed.

`corpus-replay.mjs --candidate <id> --base-url <url>` replays **one** candidate:

1. Probe `<url>`; if nothing answers, exit nonzero with "candidate unavailable" and write
   nothing.
2. Run `runBrowserEvaluation` with `createAxiBrowserDriver({ baseUrl })` and the fixed
   stub, unmodified production code. A `HarnessFailure` is reported as such and writes
   nothing.
3. Compare each outcome with `golden`. Print every difference (golden, replayed,
   rationale). `--all <map.json>` replays several served candidates sequentially and
   prints one combined difference report.
4. Write `replays/<id>.json`: revision, per-criterion outcome and bounded observation,
   `source_hashes`, `golden_sha256` (a hash of that candidate's `golden` outcomes only,
   excluding `basis` and `history` text), pins parsed from `run.sh`, `node`,
   `chrome-devtools-axi`, and browser versions (`unknown` when the adapter does not
   report one), and the time.
5. Exit nonzero when any outcome differs from golden.

`source_hashes` is computed by `lib/corpus.mjs`: a static walk of relative `import`
specifiers starting at `lib/browser-eval.mjs`, `lib/axi-browser-driver.mjs`,
`lib/corpus.mjs`, and `corpus-replay.mjs`, plus `automated-rubric.json`, each hashed with
SHA-256. No dependency is needed; the suite's modules use plain static relative imports.
`candidates.json` as a whole is deliberately **not** hashed: only each candidate's own
golden outcomes are, so adding a candidate, a `basis`, or an explanation never stales the
other candidates' records, and recording an explanation after a replay does not force a
second replay of the same candidate.

`test/corpus.test.mjs` runs in `npm run check` with no browser and fails, telling the
maintainer to run the replay, when: `candidates.json` is invalid (missing criterion,
duplicate revision, `fail` or `not-observed` without `basis`, `outcome` not matching its
latest `history` entry, an entry without an explanation, a published candidate or
issue #26 repetition missing); a candidate has no replay record; any recorded source hash
differs from the current file; a candidate's `golden_sha256` differs from its current
golden outcomes; or a replay outcome differs from golden.

The cost this imposes is deliberate and bounded: only edits to the evaluator's import
closure or to the rubric require a replay. A branch cannot deadlock, because the replay
needs no network beyond the candidate clones and can always be rerun locally; the README
documents the loop: clone and-scene, check out each revision, `npm ci && npm run build`,
serve, replay, one at a time.

### Phase 3: three outcomes and the fallback judge

**Rubric.** A new top-level map keeps `criteria` arrays as bare ids:

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

`validateAutomatedRubric` requires each key to be a deterministic-browser criterion and
each `job` to be a known judge job. These two are the only fallbacks. Every other
deterministic criterion rests on reader-visible facts, so absence there is a `fail`.

**Evaluator.** Probes may return `notObserved(rationale, evidence, lookedFor)` in place of
a tuple. The probe runner turns it into
`{ id, verdict: null, outcome: 'not-observed', looked_for, rationale, evidence, observed: false }`
and refuses it, as a harness defect, for a criterion with no declared fallback. The two
scene probes change as the spec orders them:

- `demo-required-scene-content`: a caption mismatch is `fail`. Otherwise, when any step
  has no recognised entity ids, the criterion is not observed; a convention seen on some
  steps is not proof that another step lacks content. Otherwise `pass`.
- `demo-evolving-scene-structure`: `fail` only on positive evidence, meaning entities
  were identified on two consecutive steps and none persisted between them, or a
  declared scene identity changed. When any step has no recognised entity ids and no
  such positive evidence exists, not observed. Otherwise judged as today.

**Judging.** `controller.mjs` already has the deterministic results when
`product-judging` starts. It passes `notObserved` (id, rationale, looked_for, bounded
observation) into `runProductJudging`. `productJudgeJobs` appends to a job's `criteria`
the not-observed ids whose fallback names that job; `buildJudgeRequest` appends a
"Browser check could not observe" section with each fallback's requirement, guidance, and
observation. Because the criteria and prompt feed the job's input hash, caching and
resume behave correctly with no new code. `parseJudgeOutput` gains
`requireSourceCitationsFor: [ids]`: a `pass` for those ids without a delivered-source
citation raises `JudgeOutputError`, which consumes a retry like any invalid output. The
existing source audit applies to those citations as it does to owned criteria.

**Scoring.** Resolution is per criterion, in three steps inside `scoreProduct`:

1. Index the deterministic results with exact coverage, accepting a not-observed row only
   for an id in `fallbacks` (`indexResults` gains `allowNotObservedFor: Set`).
2. Index each judge job against its owned ids plus the not-observed ids that name it.
3. Build a resolution map: each deterministic id resolves to `owner` (its own verdict),
   `fallback` (the judge's verdict, with `fallback_job`, the retained `not_observed`
   record, and the judge's `source_citations`), or `unresolved` (the fallback job has no
   results).

`scoreSubcomponent` reads from the resolution map and computes `complete` from its own
criteria, replacing today's `Boolean(indexed)`: a subcomponent is incomplete only when
one of its criteria is unresolved, so sibling deterministic subcomponents keep their
scores. Criterion records for every evaluator gain `source_citations` (today the scorer
drops the judge's `citations` array), which the report and contradiction entries use.

- The fallback job's expected id set is its owned ids plus exactly those not-observed
  ids, so a fallback verdict for an observed criterion is "unknown criterion" and a
  missing one is "missing criterion", both existing `RubricValidationError`s.
- A not-observed row whose fallback job produced no results leaves the deterministic
  subcomponent incomplete (`complete: false`, points `null`); it is never scored `fail`.
  The existing exhausted-judge outcome applies.
- The score gains `fallback: { criteria: n, points: p }`. `SCORE_SCHEMA_VERSION` 3 → 4.

Gate handling is untouched.

### Phase 3b: contradictions and the review hold

**Rubric.** `"contradiction_pairs": [{ "deterministic": "demo-evolving-scene-structure",
"judge": "demo-stable-identity-and-grouping", "proposition": "The demo is one evolving
scene whose objects keep a stable identity across steps." }]`. This is the only pair in
5.0.0: both criteria are about the delivered demo and rest on the same behavior. Every
other candidate pair crosses the demo/kit boundary, where opposite verdicts are
legitimate (a demo can bypass a correct kit), so none is declared. Validation requires
the first id to be deterministic-owned, the second judge-owned, and rejects a pair whose
criteria sit in components with different `reference_applicable` values.

**Detection.** `detectEvaluatorContradictions(score, rubric)` in `lib/evidence.mjs`, next
to `detectEvidenceContradictions`, returns an entry for each pair whose two criteria are
both `verdict_source: 'owner'` with opposite verdicts, carrying both rationales and
evidence. It is pure and runs in `assembleResult`.

**Hold.** `lib/review-hold.mjs` owns a durable `review-hold.json` in the run directory:

```json
{ "schema_version": 1, "contradictions_sha256": "…", "contradictions": [ … ],
  "raised_at": "…", "release": null }
```

At result assembly: no contradictions and no file → nothing. Contradictions whose hash
differs from the file's (or no file) → write a new active hold. Same hash → keep the file
as is, including any release. `result.review_hold` mirrors the file
(`active: release === null`) and `result.evaluator_contradictions` lists the entries,
separate from `result.evidence.contradictions`. `RESULT_SCHEMA_VERSION` 7 → 8. The hold
touches neither `outcomes.mjs` nor any exit status.

**Release.** `review-hold.sh --run-dir PATH --reviewer NAME --decision stand|verdict-wrong
--rationale TEXT`, a thin wrapper over `review-hold.mjs` in the style of
`human-review.sh`. It rejects a missing reviewer or rationale and a run with no active
hold. `stand` writes `release`, rewrites result artifacts, and, when the result is
`complete`, calls the same `publishRun` path human-review finalization uses.
`verdict-wrong` writes `resolution: { decision: 'verdict-wrong', … }` and leaves
`release` null, so the result stays unpublishable for good; the maintainer fixes the
evaluator, rubric, or judge guidance and re-scores with `run.sh --rescore-from` into a
new artifact directory. A held result is never corrected in place, which avoids needing
a durable run-local adjudication that survives the rewrite of `result.json`.

**Publication.** `publicationEligibility` returns
`{ publishable: false, reason: 'an evaluator contradiction holds this result for review', held: true }`
before its other checks pass through to publish. Callers treat `held` as a clean
non-publication: no `PublicationError`, no checkpoint.

**Report.** `lib/report.mjs` adds a "decided by the LLM because the browser check could
not observe it" badge and detail block on fallback criteria, a fallback summary line, a
hold banner, a contradictions section, and the release record. All are keyed on fields
that older results lack, so older results render unchanged.

### Phase 4: fixture traceability (`fixture-snapshot/`, `fixture-snapshot.mjs`, `lib/traceability.mjs`)

**Rubric.** Two more top-level maps:

```json
"criterion_sources": {
  "demo-navigation-boundaries-and-control-keys": { "owner": "fixture",
     "document": "openspec/changes/create-and-scene/specs/evolving-scene-presentations/spec.md",
     "heading": "Scenario: Controls keep their keys",
     "quote": "navigation keys drive that control rather than also advancing the deck" },
  "assumption-…": { "owner": "eval", "reason": "Judges workflow evidence the fixture does not describe." } },
"eval_owned_values": [{ "value": "aria-current", "reason": "ARIA standard attribute." }]
```

Every criterion and gate id needs an entry; `validateAutomatedRubric` enforces presence
and completeness. A criterion may cite more than one heading (`sources: [ … ]`).

**Snapshot.** `fixture-snapshot/snapshot.json` records `fixture_ref`, the repository, and
`files: [{ path, blob }]`; the documents sit beside it under their fixture paths. It
holds exactly these documents from the fixture's `openspec/changes/create-and-scene/`:
`specs/evolving-scene-presentations/spec.md`, `specs/presentation-skill/spec.md`,
`specs/presentation-verification/spec.md`, `proposal.md`, `design.md`, `tasks.md`, and
`test-plan.md` where present, plus the fixture's root `README.md`. They total well under
1 MB. The fixture repository is `Codagent-AI/and-scene`, owned by the same organization,
and carries no licence file; `fixture-snapshot/README.md` states that the documents are
copied verbatim from that repository at the pinned revision for offline verification. `fixture-snapshot.mjs --checkout PATH`
refuses a checkout whose `HEAD` is not `FIXTURE_REF`, copies the documents, and records
each `git ls-tree` blob id.

**Check** (`test/traceability.test.mjs`, offline):
- `fixture_ref` equals `FIXTURE_REF` parsed from `run.sh`.
- Each file's git blob id, computed as SHA-1 of `blob <size>\0<content>`, equals the
  recorded id.
- Each citation's document exists, its heading exists, and its quote appears in the
  section under that heading after whitespace and Unicode punctuation normalization
  (reusing the evaluator's text normalizer).
- Concrete values. For each subcomponent's `review_guidance`, each fallback's text, and
  each gate requirement, extract: dimensions `\d+\s*[×x]\s*\d+`; numbers with a unit
  (`px`, `ms`, `s`, `%`); `data-*` and `aria-*` attribute names; and backticked tokens
  that start with `[`, `.`, or `#`. Criterion ids and bare unitless numbers are ignored, as the spec allows; the quote check
  covers the requirement text itself.
  A value is accepted when its normalized form (`×`→`x`, spaces removed) appears in a
  section cited by any criterion of that subcomponent, or when it is listed in
  `eval_owned_values`. Anything else fails, naming the subcomponent and value. Because
  acceptance looks only inside cited sections, a hook the fixture merely offers as an
  example elsewhere does not count.

### Phase 5: Fly repetitions

For repetitions 1 and 2: `run.sh --rescore-from
~/.agent-factory/artifacts/ef8dafa5-…-rep-N` into a fresh artifact directory under rubric
5.0.0, which re-runs browser evaluation and judging. Check that the uniform-fit verdicts
agree across 1 and 2 and the attribution verdicts agree across 2 and 3. The user then
runs `human-review.sh` on each, which publishes them. Repetition 3 is rescored the same
way for verification only; its corrected figures go on issue #26.

### Rubric version

`automated-rubric.json` → 5.0.0 with a new sha256. `test/rubric.test.mjs`, calibration
fixtures, and any test that pins the sha are updated. The version becomes 5.0.0 in phase 1's first rubric-changing commit, because that is
where scoring behavior first changes; later phases add the new maps under the same
version and update only the pinned sha. Every commit on the branch is therefore
truthfully versioned, and there is still a single version bump.

## Decisions

- **Top-level rubric maps, not richer criterion objects.** Criteria are bare ids
  everywhere (`rubricCriteria`, judge prompts, scorer, reports, published results).
  Turning them into objects would touch every consumer and every historical reader.
- **Fallback verdicts are substituted in the scorer, not in the evaluator's output.** The
  browser artifact stays a faithful record of what the browser saw; the substitution is
  visible and tagged where points are computed.
- **Only two criteria get fallbacks.** The narrow definition in the spec, applied to the
  14 criteria, leaves only the two that depend on scene-object markup. Adding a fallback
  later is a rubric change that the corpus check forces through a replay.
- **Known conventions are still extended.** A deterministic verdict is cheaper and more
  consistent than an LLM one, so conventions seen in real candidates are added; the
  fallback covers the unknown remainder.
- **The focused-key press is observed but never scored.** Native buttons ignore arrow
  keys, so a deck that advances from a focused button and one that does not are both
  defensible readings of the fixture for a button; the kit criterion judges the source.
- **One declared contradiction pair.** The mechanism is general; the list is honest about
  where two judges really answer one question.
- **The hold is a file plus a hash.** It survives the rewrite of `result.json`, makes
  "same contradiction, already released" and "new contradiction" distinguishable, and
  needs no new outcome state.
- **Per-candidate replay records instead of one manifest file.** Replays run one at a
  time against separately served builds; per-candidate files need no finalize step and
  produce smaller diffs. Together they are the spec's manifest.
- **Explanations live in each golden verdict's history.** A separate change log hashed
  into every replay record would go stale the moment an explanation was added, and a
  "moved since the previous replay" marker is lost on the next replay.
- **A wrong verdict under a hold is fixed by re-scoring, not in place.** A held result is
  by definition unpublished, so nothing needs superseding; fixing the evaluator or rubric
  and re-scoring is the honest correction and needs no run-local adjudication file.
- **Focus is released to the presentation root, not to `body`.** A presentation may
  listen for keys on its own root; focusing `body` would fail it for a reader action no
  reader performs.
- **No adjudication CLI.** Five one-off approved scripts match existing practice; a CLI
  is a separate change.

## Risks / Trade-offs

- **Fallback points rest on a less consistent judge.** Bounded to two criteria (2 of 70
  points), flagged per criterion and summed in the result, and a `pass` must cite source.
- **A candidate strips its hooks to dodge a failure.** It gains nothing unless its source
  genuinely satisfies the requirement; tests cover suppressed hooks, accessibility
  semantics, titles, and identity.
- **`releaseFocus()` could mask a real defect** where keys die after any control use until
  the reader clicks elsewhere. Focusing the presentation root is what a reader's next
  click on the scene does, and the clamp and navigation criteria still exercise keys
  without controls. A temporary `tabindex` is removed after the key press.
- **Static import walk misses a dynamic import.** The suite has none in the evaluator
  path; the test asserts that the walked set contains the known core modules.
- **Value extraction is heuristic.** It is deliberately narrow (units, attribute names,
  selectors) to avoid noise; it catches the 880×495 class of error, not every paraphrase.
  Quote verification covers the citation itself.
- **Authoring ~90 citations is tedious and can be done carelessly.** The quote must match
  the snapshot, so a careless citation fails rather than rots.
- **The corpus check makes every evaluator edit cost a manual eight-candidate replay.**
  That cost is the point; the README keeps the loop scripted.

## Migration Plan

One feature branch from `dev`, PR into `dev`, commits in phase order so each phase is
green under `npm run check` before the next. Phase 2 lands before phases 3–4 so they are
verified against real candidates. Expected deterministic replay results after phase 1: 14/14 for the five published
candidates and for repetitions 1 and 2; repetition 3 fails `demo-present-mode-behavior`
and the `verification-sample-outline` gate for its hidden step titles and passes the
rest. Repetition 1's scene-identity result and repetition 3's step-number and canvas
deductions are LLM-owned and are checked by rescoring, not by the corpus.

Older `result.json` files (schema 7, score schema 3) remain readable: every new field is
optional on read, reports render them unchanged, and adjudication supersession
validation of an older published result is unaffected. A CI test loads one committed
published result read-only to hold this. Rollback is a revert of the branch;
the five adjudications and two publications are separate commits and revert separately.

After merge, the next factory run must freeze an `evals` revision that contains this
change.

## Open Questions

None.
