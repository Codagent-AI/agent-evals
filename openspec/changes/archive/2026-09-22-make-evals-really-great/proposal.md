# Make Evals Really Great

## Why

Every batch of `and-scene` runs surfaces new wrong deductions. An audit of the three
Fly.io factory repetitions (issue #26, eval `ef8dafa5-c808-4584-8f2f-28038f68c1fe`) and
the six published runs found that most lost points are real, but 2–4 of the 21–23 points
each Fly repetition lost were harness or rubric errors, and five published records carry
a wrong one-point deduction today:

- **The control-keys check is inverted.** The pinned fixture scenario "Controls keep
  their keys" says navigation keys drive a focused control *rather than* also advancing
  the deck. `demo-navigation-boundaries-and-control-keys` activates a control, which
  since `cc2a18e` also focuses it, and then requires the deck to advance. It deducts
  from every candidate that follows the spec. Commit `16401c1` applied that deduction to
  five published runs, and all three Fly repetitions lost the same point.
- **The rubric states the wrong canvas size.** `scene-fixed-canvas` guidance says
  880×495. The fixture spec, design, tasks, and test plan all say 880×380. Every Fly
  repetition built 880×380 and lost a point.
- **Scene objects are found by a closed list of attribute names.** The driver recognises
  only `data-layout-id`, `data-scene-entity`, and `data-node`. The fixture lists DOM
  hooks only as examples. Repetition 2 used `data-entity-id` and `data-scene-node`, the
  evaluator found zero objects, and two criteria failed on a correct scene.
- **The LLM source judge contradicted itself.** It failed repetition 1's uniform canvas
  fit for a `MIN_SCALE` clamp and passed repetition 2 with the same clamp, against
  guidance that says not to require a particular rendering at an extreme viewport.

The wrong deductions keep being new because the design produces them:

1. **Deterministic checks guess implementation conventions, and "could not find it"
   is recorded as "fail".** A scored criterion has only pass and fail. An `unobserved`
   outcome exists, but only for hard gates, and for a scored criterion a null verdict
   makes the whole component incomplete and the official verdict unavailable.
2. **The rubric paraphrases the fixture and the paraphrases drift.** Nothing checks
   rubric text against the pinned fixture, so 880×495 and the inverted key reading both
   shipped.
3. **Fixes are verified against stubs, not real candidates.** Every bad fix passed unit
   tests. Replaying real candidates was manual and optional, so `cc2a18e` shipped while
   flipping four candidates at once.
4. **Nothing reacts when the browser evaluator and an LLM judge disagree about the same
   subject**, for example "no scene objects found" next to full scene-identity marks.

Published scores are the product of this repository. Each wrong deduction costs an
audit, an adjudication of shared records, and trust in every comparison between role
profiles. The factory now runs unattended repetitions, so errors multiply per batch.

## What Changes

This is one change delivered in gated phases. Each phase must pass its tests, and from
phase 2 onward the corpus replay, before the next begins.

0. **Settle the in-flight change first.** Correct the bodies of the two scenarios in the
   unarchived change `2026-09-20-harden-deterministic-browser-judging` that encode the
   inverted key reading ("Controls exist only in browse mode" and "A control is
   activated the way a pointer activates it"), and amend the sentence "Automated criteria
   SHALL use binary pass/fail verdicts" in its "Official product score" requirement so
   that a not-observed outcome is permitted while points still come only from pass/fail
   verdicts. Scenario headers stay unchanged. Then archive that change. Everything below is specified against the archived specs.
1. **Correct the four wrong deductions.**
   - Make the control-keys check match "Controls keep their keys": after activating a
     control, a deck key pressed while focus stays on that control must not be required
     to advance the deck. Boundary clamping stays as it is. `activate()` keeps focusing
     the control, because that is what a real activation does.
   - Correct the `scene-fixed-canvas` guidance to 880×380.
   - Stop failing a candidate because its scene objects use an attribute name the
     driver does not know. No generic DOM heuristic replaces the list: a browser cannot
     reliably infer stable object identity from arbitrary markup. Captions and visible
     rendered content stay deterministic; object identity and persistence between steps
     are judged from source (see items 3 and 6).
   - Revert the five `16401c1` deductions through `applyTechnicalAdjudication`, never by
     hand, with the user's approval of each shared record. Expected restored official
     scores: astra-lead 81.98, candidate-rescore-20260728 80.19,
     candidate-rescore-20260729 74.11, config 74.04, local-codex-tester 76.62.
2. **Add a golden-verdict regression corpus.** Record the adjudicated correct verdict
   for every deterministic criterion on the eight real candidates: the five distinct
   published candidates and the three Fly repetitions. Each golden verdict cites the
   fixture text it rests on, so the corpus cannot silently preserve a shared misreading
   like the inverted key check. A maintainer replay command runs the production
   evaluator, unmodified, against each built and served candidate and writes a generated
   manifest: candidate revisions, verdicts with bounded observations, hashes of every
   source file the evaluator transitively imports plus the rubric and the corpus runner,
   fixture and reference pins, and Node, Chrome, and `chrome-devtools-axi` versions. Each
   golden verdict carries its own history of outcomes with an explanation for each, so
   it cannot change without a recorded reason. A test in `npm run check` fails when the
   manifest is structurally invalid, its source hashes are stale, or a golden verdict
   changed without an explanation or without a fresh replay. CI therefore enforces that the replay was run without
   needing Chrome or built candidates itself. This does not stop a determined maintainer
   from forging a manifest; it stops the replay from being forgotten, which is the
   failure that actually happened.
3. **Give scored deterministic criteria three outcomes: pass, fail, not observed.** A
   check fails only on positive evidence of a violation, such as visible wrong text or a
   key press landing on the wrong step. Not observed is deliberately narrow, because the
   candidate controls what the browser can see:
   - It applies only where a check depends on a markup convention the fixture does not
     mandate. Absence of something a user must be able to see or do (a step title, step
     numbering, a navigation control) is positive evidence of a violation and stays a
     fail. Repetition 3's hidden step titles remain a fail.
   - The rubric declares, per criterion, whether a fallback judge exists and which one.
     A criterion without a declared fallback that cannot be observed leaves the
     component incomplete, as today.
   - The fallback judge receives the bounded browser observation and must cite source
     for a pass. Its verdict is scored so the run finishes unattended.
   - `result.json` and the report flag the criterion as LLM-resolved because the browser
     check could not observe it.
4. **Hold publication on a deterministic-versus-LLM contradiction.** Detect when the
   browser evaluator and an LLM judge reach opposing conclusions about the same
   proposition, record it, and hold the result for maintainer review instead of
   publishing. (Today's `contradictions.json` compares the candidate's own claims with
   evaluator evidence; this is a new comparison alongside it.) The hold is a durable
   review-required marker separate from `evaluation_status`. Scoring and human review
   proceed; only publication waits. An unattended run exits cleanly with a modeled
   result that names the hold. A maintainer resolves it through an audited action that
   records reviewer, decision, and rationale and retains the original contradiction:
   either the verdicts stand and the hold is released, or a verdict is wrong, the result
   stays unpublished for good, and the candidate is re-scored after the evaluator or
   rubric is fixed. Resume behaves the same before and after. Criteria are
   mapped only where both evaluators answer the same question about the same product
   boundary, so the live demo and the reusable kit stay independently judged.
5. **Link every rubric criterion to the fixture, and check the link.** Each criterion
   carries a structured citation: the fixture source file, the scenario or section
   header, and a quoted fragment. A test verifies every citation against a vendored
   snapshot of the pinned fixture. Each concrete number and attribute name in rubric
   guidance is classified as fixture-owned, in which case it must appear in the cited
   normative text and not merely in an example, or eval-owned, in which case it carries
   a stated reason. This would have caught 880×495, and it does not mistake an example
   hook such as `data-node` for a requirement.
6. **Move convention-dependent checks to source review.** Deterministic checks keep what
   a user can see and do: visible text, key presses, clicks, step changes, and console
   errors. Scene-object identity and persistence between steps move to
   `llm-source-review` with browser evidence attached. Any further move is made only
   where the corpus shows a criterion cannot be observed reliably across real
   candidates.
7. **Re-judge the three Fly repetitions end to end.** Expected automated totals are
   about 51.56, 50.85, and 48.86 of 70. Repetitions 2 and 3 must receive the same
   attribution verdict, and repetitions 1 and 2 the same uniform-fit verdict.
   Repetitions 1 and 2 are published into `results/` through the normal path once the
   user completes their human review. Repetition 3 still fails the
   `verification-sample-outline` hard gate; under the existing publication rule a
   conclusive product failure without an official score stays a local diagnostic, so
   its corrected score and reasoning are recorded on issue #26 and it is not published.

The automated rubric moves to a new major version, 5.0.0, in the first commit that
changes scoring behavior. Criteria, point allocations, floors,
and hard gates do not change, and the only guidance text corrected is the canvas size.
How a verdict is reached does change, so scores are not directly comparable across the
version boundary, as with the 4.0.0 bump. The five restored records keep their original
rubric provenance. Re-scoring the published runs under the new version is not part of
this change.

## Capabilities

### New Capabilities
- `judging-regression-corpus`: golden deterministic verdicts for real candidates, the
  maintainer replay command, the rule that a moved verdict must be explained, and the
  staleness check that ties the golden file to the evaluator and rubric sources.
- `rubric-fixture-traceability`: every rubric criterion cites the pinned fixture text it
  enforces, and concrete numbers and attribute names in rubric guidance must appear in
  the pinned fixture.

### Modified Capabilities
- `product-quality-scoring`: scored deterministic criteria gain a not-observed outcome
  that resolves through a flagged LLM verdict; the control-keys behavior follows the
  fixture; canvas guidance is 880×380; scene-object detection no longer fails a
  candidate for an unrecognised attribute name; the rubric version and provenance
  change.
- `evaluation-outcomes`: a deterministic-versus-LLM contradiction holds a result from
  publication until a maintainer reviews it.
- `evaluation-metrics-reporting`: the result and report identify LLM-resolved criteria
  and any contradiction hold.

## Technical Approach

All work stays inside `evals/agent-runner/and-scene/`. No shared framework is
introduced, and no third-party runtime dependency is added.

- **Three outcomes.** `browser-eval.mjs` already has `unobserved()` for hard gates. The
  same record shape extends to scored criteria. Today the scorer accepts only `pass`
  and `fail` for a scored criterion and allows a null verdict only for hard gates; it
  instead resolves a not-observed criterion from its declared fallback judge and marks
  the resolution source. A not-observed criterion with no declared fallback, or with no
  fallback verdict, stays incomplete, which keeps the existing "missing evidence is
  never a product failure" rule. Hard-gate behavior does not change.
- **Judge hand-off.** The rubric assigns each criterion to exactly one evaluator, judge
  jobs return exactly their assigned criteria, and duplicate criterion ownership is
  invalid. The fallback is therefore an explicit secondary-authority field on the
  criterion, not a second owner. The judge manifest adds a not-observed criterion to
  its fallback judge's job only for that run, with the bounded browser observation that
  `74169bc` made every probe retain, and exact-coverage validation accounts for it.
  Tests include adversarial candidates that suppress hooks, accessibility semantics,
  titles, and object identity.
- **Corpus.** `reference-browser-regression.mjs` already replays the evaluator against
  an already built and served presentation and leaves building and serving to the
  product repository. The corpus generalises that pattern to a list of pinned candidate
  revisions. Replays run one at a time because they share Chrome. Building candidates
  needs a clone of `Codagent-AI/and-scene`, `npm ci`, and `npm run build` per revision,
  so the replay is a documented maintainer command and pre-merge step, not a CI job.
  The committed golden file plus the source-hash test is what CI enforces.
- **Traceability check.** A plain `node --test` test reads `automated-rubric.json` and
  a vendored snapshot of the normative fixture documents. A maintainer refresh command
  generates the snapshot from a checkout at `FIXTURE_REF` and records the git blob ID of
  every included file, so the snapshot provably matches the pin; CI verifies internal
  consistency offline.
- **Contradiction hold.** A small declared table maps a deterministic criterion to an
  LLM criterion only where both answer the same proposition. Detection runs at result
  assembly next to `detectEvidenceContradictions`. The review-required marker and its
  audited release are durable run state; `publicationEligibility` refuses a held
  result and says why, and the existing publication checkpoints are unchanged.
- **Record corrections** go through `applyTechnicalAdjudication`, which preserves raw
  scores and makes supersession reproducible. Fly repetitions 1 and 2 are re-scored in
  place from `~/.agent-factory/artifacts/ef8dafa5-…-rep-{1,2}/` with the existing
  rescore path, reviewed with `human-review.sh`, and published by the existing
  publication path. No publication rule changes.

Behavior changes are test-driven: a failing test in `test/browser-eval.test.mjs`,
`test/axi-browser-driver.test.mjs`, `test/rubric.test.mjs`, or a new test file, then the
fix, then targeted tests, then `npm run check`. The corpus is built second so every
later step is verified against real candidates rather than stubs.

Main risks:

- **Points move to a less consistent judge.** The LLM judge is the component that
  contradicted itself across repetitions. The flag, the contradiction hold, and the
  corpus-guided limit on which checks move are the mitigations. Majority-vote judging
  is deferred until the corpus shows how much inconsistency remains.
- **A candidate could try to hide things to avoid a browser fail.** The narrow
  definition of not observed, the per-criterion fallback declaration, the source
  citation required for a fallback pass, and the adversarial tests are the mitigations.
- **Eval-owned constants can become an escape hatch.** Rubric guidance legitimately
  contains eval-owned numbers, such as inspection viewport sizes. Each one carries a
  stated reason, and the list is reviewed like any rubric change.
- **Golden verdicts can encode a shared misreading.** Requiring each golden verdict to
  cite fixture text is the mitigation; independent sign-off is not available in a
  single-maintainer repository.
- **Breadth.** The change touches scoring, judge routing, outcomes, publication, rubric
  governance, and records. The gated phases keep each step verifiable, and phase 0 makes
  the archive ordering real rather than assumed.

## Out of Scope

- Repeated or majority-vote LLM judging.
- Publishing Fly repetition 3, or any new record type for failed runs. The publication
  rules do not change.
- Re-scoring the six published runs under the new rubric version.
- Signed manifests or branch-protection rules for the corpus replay.
- Generic DOM heuristics for discovering scene objects.
- Re-judging the roughly 60 skill, verification, evidence, and assumption LLM verdicts
  that the audit did not independently check.
- A new criterion for the repository the attribution links to (all three Fly
  repetitions link to `github.com/openai/and-scene`).
- Changes to the and-scene fixture, its spec, or the `FIXTURE_REF` and `REFERENCE_REF`
  pins. The fixture is correct; the rubric and evaluator move back in line with it.
- Changes to Agent Runner, Agent Skills, or the factory repository.
- New suites or a shared evaluation framework.
- Running the corpus replay in CI.

## Impact

- **Code:** `lib/browser-eval.mjs`, `lib/axi-browser-driver.mjs`, `lib/scorer.mjs`,
  `lib/judge-jobs.mjs`, `judge-manifest.mjs`, `lib/evidence.mjs`, `lib/result.mjs`,
  `lib/publication.mjs`, `lib/report.mjs`, `lib/rubric.mjs`, `automated-rubric.json`,
  a new corpus replay module and golden file, a vendored fixture snapshot, the suite
  `README.md`, and the `check` script in `package.json`.
- **Specs:** new `judging-regression-corpus` and `rubric-fixture-traceability`; modified
  `product-quality-scoring`, `evaluation-outcomes`, and `evaluation-metrics-reporting`;
  body-only corrections to two scenarios in the harden change, which is then archived
  as phase 0.
- **Published records:** five records regain one point each through adjudication, and
  Fly repetitions 1 and 2 are added to `results/` after the user's human review.
  Repetition 3 is recorded on issue #26. No pass or fail verdict changes.
- **Rubric:** new major version and sha256. Calibration and rubric tests are updated.
- **Delivery:** one feature branch cut from `dev`, with a pull request based on `dev`.
- **Operations:** after merge, the next factory run must freeze an `evals` revision that
  includes these fixes. The Fly runs were frozen at `16401c1`. This is a run input, not
  a factory code change.
