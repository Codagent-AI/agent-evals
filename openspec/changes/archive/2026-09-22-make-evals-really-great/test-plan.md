## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional
integration, end-to-end, agent-acceptance, and exceptional human-only obligations.

The root cause this change addresses is that fixes passed stub-based unit tests and were
wrong against real candidates. The plan therefore puts its weight on two things unit
tests cannot give: wiring across the evaluator, judge, scorer, result, and publication
modules with the **real rubric**, and acceptance against the **eight real candidates** in
a real browser. Continuous integration runs only `npm run check` on Node 22 with no
browser, no network, and no model calls, so everything marked CI must hold under those
limits. Real-browser and paid work is agent acceptance run by a maintainer-side agent.

All automated tests use `node:test`, temporary directories from `mkdtemp`, and injected
fakes for the browser driver, the judge invoker, and git, as the existing controller,
publication, and human-review tests do. No test may write under
`evals/agent-runner/and-scene/results/`.

## Integration Tests

### INT-001: A not-observed criterion flows from browser evaluation to a scored, tagged verdict
- Covers: "Deterministic criteria fail only on positive evidence"; "Declared fallback judge for not-observed criteria".
- Boundary: `runBrowserEvaluation` → `runProductJudging` (`productJudgeJobs`, `buildJudgeRequest`, `parseJudgeOutput`) → `scoreProduct`, using the real `automated-rubric.json`.
- Setup: a fake driver whose states carry correct captions and no entity ids on any step; a fake judge invoker that answers the `demo-integration` job.
- Action: run browser evaluation, pass its not-observed rows into product judging, score the result. Repeat with the invoker returning `fail`, a `pass` with no source citation, no verdict for the fallback id, and a fallback verdict for an observed criterion.
- Assertions: both scene criteria are not observed with `looked_for` populated; the `demo-integration` request's criteria are its owned ids plus exactly those two, and its prompt carries the fallback requirement, guidance, and observation; a cited `pass` awards full criterion points with `verdict_source: 'fallback'`; `fail` awards zero; an uncited `pass` raises `JudgeOutputError` and consumes a retry; an exhausted job leaves the deterministic subcomponent incomplete with `points_awarded: null` and no `fail`; when the fallback is unresolved, only the subcomponent containing that criterion is incomplete and the other deterministic subcomponents keep their awarded and observed points; a verdict for an observed criterion is rejected as invalid coverage; `fallback.criteria` and `fallback.points` match; the fallback judge's `source_citations` are retained on the criterion record; every other criterion is `verdict_source: 'owner'`. A second driver with recognised scene objects on some steps only yields not observed, not `fail`; a third whose identified objects are all replaced between two steps yields `fail`.
- Execution: `test/not-observed-flow.test.mjs`, CI.

### INT-002: Judge-job caching and resume stay correct when the not-observed set changes
- Covers: "Declared fallback judge for not-observed criteria" (in that run only); "Durable outcome transitions and resume" as it applies to judging.
- Boundary: `runProductJudging` with real `loadJob`/`saveJob` persistence in a temporary run directory.
- Setup: one run with no not-observed criteria, saved; then the same inputs with one not-observed criterion.
- Action: rerun judging in each configuration, then rerun the second unchanged.
- Assertions: the `demo-integration` input hash differs between configurations, so the cached job is not reused across them; the unchanged rerun reuses the cached job and invokes no judge; jobs that are not a fallback target keep their hash in both configurations.
- Execution: `test/not-observed-flow.test.mjs`, CI.

### INT-003: Review hold lifecycle across result assembly, resume, release, and publication
- Covers: "Deterministic and LLM verdicts on one proposition are compared"; "Review hold for evaluator contradictions"; "Held results are not published".
- Boundary: `assembleResult` + `lib/review-hold.mjs` + `review-hold.mjs` CLI + `publicationEligibility`/`publishRun`, on a real temporary run directory with an injected git.
- Setup: scored inputs where `demo-evolving-scene-structure` is an owner `fail` and `demo-stable-identity-and-grouping` is `pass`; a second input set where the first is fallback-resolved; a third where an undeclared demo/kit pair disagrees.
- Action: assemble; assemble again (resume); attempt publication; run the review action with no reviewer, with no rationale, against a run with no hold, then validly with `stand`; assemble again; publish; re-score to a different contradiction set. On a second held run directory, record `verdict-wrong`, assemble again, and attempt publication.
- Assertions: `review-hold.json` is written once and is byte-stable across reassembly; `result.review_hold.active` is true and `evaluation_status`, product verdict, scores, and gates equal those of the same inputs without a contradiction; publication returns `held` with the hold reason, throws no `PublicationError`, and writes no publication checkpoint; invalid releases exit nonzero and leave the file unchanged; a valid release records reviewer, time, decision, and rationale and keeps the contradiction entries unchanged; after release the result publishes and the snapshot's `result.json` contains the contradiction and the release; `verdict-wrong` records reviewer, decision, and rationale, survives reassembly, and leaves the result permanently unpublishable with the hold reason; a changed contradiction set raises a new active hold; the fallback-resolved and undeclared-pair inputs raise none.
- Execution: `test/review-hold.test.mjs`, CI.

### INT-004: Corpus staleness check against the real evaluator source tree
- Covers: "Golden verdict corpus of real candidates"; "Replay manifest and staleness check".
- Boundary: `lib/corpus.mjs` import walk and validation over the actual suite files on disk.
- Setup: the committed `corpus/`; a temporary copy of the suite directory for mutation cases.
- Action: validate the committed corpus; in the copy, append a comment to `lib/browser-eval.mjs`, to a module it imports transitively (`lib/demo-contract.mjs`), to `automated-rubric.json`, and to an unrelated module (`lib/pricing.mjs`); delete a replay record; flip one golden outcome without a history entry; flip one with a history entry but no new replay; add an explanation-only history edit; add a ninth candidate with its own replay record; remove a `basis` from a golden `fail`; drop one criterion; duplicate a revision.
- Assertions: the committed corpus passes with no browser; the walked source set contains `browser-eval.mjs`, `axi-browser-driver.mjs`, `demo-contract.mjs`, and `browser-diagnostics.mjs`; each evaluator, transitive, and rubric edit fails with a message that tells the maintainer to run the replay; the unrelated edit passes; an explanation-only edit and an added candidate leave the other candidates' records current; every other mutation fails naming the candidate and, where it applies, the criterion; the two stub-fed gates are absent from golden verdicts; the corpus lists each distinct published candidate revision and the three issue #26 repetitions.
- Execution: `test/corpus.test.mjs`, CI.

### INT-005: Replay command outcomes without a browser
- Covers: "Replay against the production evaluator".
- Boundary: `corpus-replay.mjs` entry point with an injected driver factory, writing into a temporary corpus directory.
- Setup: a fake driver that matches golden; one that flips a criterion; one that throws a harness failure; a base URL with nothing listening.
- Action: run the command for one candidate in each configuration, and once over four candidates with the same flipped criterion.
- Assertions: a match writes a replay record with outcomes, observations, source hashes, pins, and versions and exits zero; a flip prints candidate, criterion, golden, replayed, and rationale and exits nonzero; four flips are all reported; a harness failure and an unreachable candidate exit nonzero, print the distinct reason, and write no record; no path under `results/` is touched.
- Execution: `test/corpus-replay.test.mjs`, CI.

### INT-006: Traceability check against the real rubric and snapshot, and snapshot refresh against real git
- Covers: all four `rubric-fixture-traceability` requirements.
- Boundary: `lib/traceability.mjs` over the committed `automated-rubric.json`, `fixture-snapshot/`, and `run.sh`; `fixture-snapshot.mjs` against a real temporary git repository.
- Setup: the committed files; in-memory mutated copies; a temporary git repository holding stand-in fixture documents at a known commit.
- Action: run the check on the committed files; mutate guidance to `880×495`, remove a criterion's source entry, truncate a citation, change a quote by one word, change a quote's apostrophe style only, cite a missing heading, add an uncited `data-*` name, add the same name to `eval_owned_values`, edit a snapshot document, and change the parsed `FIXTURE_REF`; run refresh against the temporary repository at the pinned commit and at another commit.
- Assertions: the committed rubric passes offline; each mutation fails naming the criterion or subcomponent and the offending value, heading, or document; the punctuation-only change passes; the eval-owned declaration passes; a moved pin fails telling the maintainer to refresh; refresh at the pin writes blob ids equal to `git ls-tree`; refresh at another commit exits nonzero and leaves the snapshot unchanged.
- Execution: `test/traceability.test.mjs`, CI. The refresh cases need only the `git` binary, which CI has.

### INT-007: Real-browser driver behavior on adversarial pages
- Covers: "Focused controls keep their keys"; "Deterministic criteria fail only on positive evidence" (hidden reader-visible element; suppressed hooks).
- Boundary: `createAxiBrowserDriver` and `runBrowserEvaluation` over real `chrome-devtools-axi` and Chrome against locally served static pages. No corpus candidate exhibits these behaviors, so the corpus cannot cover them.
- Setup: four small static presentations under `test/real-browser/pages/`: (a) conforming, ignores deck keys while a button holds focus; (b) deck keys stay dead after any control use even once focus returns to the body; (c) correct scene with no recognised scene-object hook; (d) active step title hidden in present mode; (e) conforming, with its deck-key listener attached to the presentation root only; (f) a page that forces focus back onto its control so focus cannot be released.
- Action: serve each page on a local port and run the production evaluator.
- Assertions: (a) passes `demo-navigation-boundaries-and-control-keys` and its observation records `keys_while_control_focused` with no move and `keys_after_focus_released` with a one-step move; (b) fails that criterion; (c) records both scene criteria as not observed with `looked_for` listing the conventions; (d) fails `demo-present-mode-behavior` and is not recorded as not observed; (e) passes `demo-navigation-boundaries-and-control-keys`, and the page's DOM carries no leftover `tabindex` after the probe; (f) raises a resumable harness failure and records no verdict.
- Execution: `test/real-browser/adversarial.test.mjs`, outside the `test/*.test.mjs` glob so CI does not run it. Run locally by the implementer before the phase 1 and phase 3 commits, and again in AT-001's session. Needs Chrome and `chrome-devtools-axi`.

### INT-008: Results published before this change still load, render, and validate
- Covers: "Verdict source and review hold reporting" (a result that predates the capability); compatibility of result schema 7 and score schema 3.
- Boundary: `lib/report.mjs`, `lib/result.mjs`, `lib/publication.mjs`, and `lib/adjudication.mjs` reading a committed record under `results/` read-only.
- Setup: one committed published result that carries a technical adjudication, copied into a temporary directory.
- Action: render its report with the new code; run `publicationEligibility`; run technical-adjudication supersession validation against its committed predecessor state as the existing tests do.
- Assertions: rendering succeeds with no fallback marking, hold banner, or contradiction section; eligibility is unchanged; supersession validation passes; the committed record is not modified.
- Execution: `test/legacy-result.test.mjs`, CI.

## End-to-End Tests

### E2E-001: A candidate with unrecognised scene markup is evaluated to a pending result unattended
- Covers: the journey browser evaluation → product judging → pending result → report, for "Declared fallback judge for not-observed criteria" and "Verdict source and review hold reporting".
- Surface: the controller entry point used by `run.sh`, driven as `test/controller.test.mjs` drives it.
- Setup: temporary artifact directory; fake driver with correct content and no recognised scene objects; fake judge invoker returning a cited `pass` for the fallback criteria; all other phases faked as existing controller tests do.
- Journey: run the automated phases to completion without input, then resume the same directory.
- Assertions: the run ends `pending-human-review` with a zero exit and no prompt; `result.json` marks the two criteria fallback-resolved with their not-observed records and judge citations and reports the fallback count and points; `report.html` contains the "decided by the LLM because the browser check could not observe it" marking for exactly those criteria; resume invokes no judge and produces an equal result.
- Execution: `test/controller.test.mjs`, CI.

### E2E-002: A contradiction holds a finalized result until a maintainer releases it
- Covers: the journey automated result → human review → refused publication → release → publication, for "Review hold for evaluator contradictions" and "Held results are not published".
- Surface: the controller, `human-review.mjs`, and `review-hold.mjs` entry points, with an injected git and a temporary repository directory.
- Setup: fakes producing the declared contradiction and an otherwise eligible automated score; a scripted human review.
- Journey: run automated phases; finalize human review; run the release command with `stand`.
- Assertions: the automated run exits as an ordinary pending run and names the hold and release command in `result.json`; human review finalizes to `complete` with an official score while nothing is published and no publication checkpoint exists; the report shows the hold banner and both verdicts; after release exactly one result commit is made and the report shows the release record with the contradiction still visible.
- Execution: `test/review-hold-journey.test.mjs`, CI.

## Agent Acceptance Tests

### AT-001: Replay all eight real candidates against the final evaluator
- Classification: Required.
- Covers: "Replay against the production evaluator"; "Focused controls keep their keys"; the proposal's claim that no real candidate loses a point to a harness error.
- Actor and surface: a maintainer-side agent using `corpus-replay.mjs` and `npm run check`.
- Setup: Chrome and `chrome-devtools-axi`; network access to clone `Codagent-AI/and-scene`; for each of the eight corpus revisions, check out, `npm ci`, `npm run build`, and serve the preview. One candidate at a time, because replays share a browser.
- Steps: run INT-007 first; replay each candidate at the branch head; run `npm run check`.
- Expected: every replay exits zero. The five published candidates and repetitions 1 and 2 are 14/14 on the deterministic criteria. Repetition 2 passes both scene criteria through a recognised convention, not the fallback. Repetition 3 passes control-keys, fails `demo-present-mode-behavior` for its hidden step titles, and fails the `verification-sample-outline` gate. LLM-owned results (repetition 1's scene identity, repetition 3's step numbering and canvas overflow, uniform fit, attribution) are not part of this flow; AT-003 covers them. `npm run check` passes with the committed replay records.
- Evidence: the eight `corpus/replays/*.json` records as committed, the replay console output per candidate, and the `npm run check` summary.
- Effects and cleanup: local clones and preview servers only; stop servers and remove clones afterwards. No model calls, no pushes.
- Permitted substitutes: None. A stubbed driver or a subset of candidates does not satisfy this flow.

### AT-002: The guards stop a careless change
- Classification: Required.
- Covers: "Replay manifest and staleness check"; "Concrete values in guidance are accounted for"; "The snapshot matches the fixture pin".
- Actor and surface: an agent using a scratch worktree and `npm run check`.
- Setup: a scratch git worktree of the branch head.
- Steps: (1) add a comment to `lib/axi-browser-driver.mjs`, run the check; (2) revert, change `scene-fixed-canvas` guidance back to `880×495`, run the check; (3) revert, change `FIXTURE_REF` in `run.sh` by one character, run the check; (4) revert everything, run the check.
- Expected: (1) fails and tells the maintainer to run the replay; (2) fails naming the subcomponent and `880×495`; (3) fails telling the maintainer to refresh the snapshot; (4) passes.
- Evidence: the failing message from each of the three runs and the final pass.
- Effects and cleanup: remove the scratch worktree. Nothing is committed.
- Permitted substitutes: None.

### AT-003: Re-judge the three issue #26 repetitions end to end under the new rubric
- Classification: Required.
- Covers: proposal item 7; consistency of LLM verdicts on identical evidence; "Verdict source and review hold reporting" on a real run.
- Actor and surface: an agent using `run.sh --rescore-from`.
- Setup: the three artifact directories under `~/.agent-factory/artifacts/ef8dafa5-c808-4584-8f2f-28038f68c1fe-rep-{1,2,3}/`; Docker, Chrome, valid judge CLI auth; a fresh artifact directory per repetition outside `results/`.
- Steps: rescore each repetition, one at a time; read each `result.json` and open each `report.html`.
- Expected: rubric provenance is 5.0.0 with the new sha256; `canvas-default-dimensions` passes on all three; `canvas-uniform-scaling` receives the same verdict on repetitions 1 and 2; the attribution-placement verdict is the same on repetitions 2 and 3; automated totals are near 51.56, 50.85, and 48.86 of 70, and any difference over one point from those figures is explained criterion by criterion against the fixture; repetitions 1 and 2 end `pending-human-review`; repetition 3 ends as a conclusive product failure on `verification-sample-outline` with no official score; every criterion shows a verdict source; any review hold is reported rather than silently published.
- Evidence: the three `result.json` summaries, the per-criterion comparison table for the consistency checks, and report screenshots of the score summary for each repetition.
- Effects and cleanup: paid judge calls for three rescoring runs, authorized by the change scope; eval-owned usage is recorded in `phases/eval-owned-usage.jsonl`. No publication happens in this flow. Post repetition 3's corrected figures and reasoning as a comment on issue #26.
- Permitted substitutes: None for repetitions 1 and 2. If a Claude quota limit with an explicit reset interrupts a run, resume the same artifact directory; do not start a second run in it.

### AT-004: Read a fallback-resolved and a held result as a maintainer would
- Classification: Required.
- Covers: "Verdict source and review hold reporting"; the release command's public surface.
- Actor and surface: an agent operating `report.html` in a browser through `chrome-devtools-axi`, and `review-hold.sh` in a terminal.
- Setup: scratch copies of two run directories produced by the E2E fakes or, when AT-003 produced them naturally, by AT-003: one with a fallback-resolved criterion, one with an active hold. A scratch clone of this repository with a local bare remote for the publication step.
- Steps: open each report; find which criteria were decided by the LLM and why; find why the second result is unpublished and what releases it; run `review-hold.sh --help`; attempt a release with no rationale; release with `--decision stand`; on a second scratch copy record `--decision verdict-wrong`; reopen the report; regenerate the report for one existing published result and compare it with the committed one.
- Expected: a reader can tell from the report alone which points rest on a fallback verdict and how many; the hold banner names the release command; the incomplete release is refused with a clear message; after release the report shows reviewer, time, decision, and rationale with the contradiction still visible, and the result publishes to the scratch remote only; the `verdict-wrong` copy states that it is permanently unpublished and superseded by re-scoring, and does not publish; the regenerated older report shows no fallback or hold markings and no other differences.
- Evidence: screenshots of the fallback marking, the hold banner, and the released state in light and dark presentation where the report supports both; the terminal transcript of the refused and accepted release; the diff of the regenerated older report.
- Effects and cleanup: all writes go to scratch copies and the scratch remote; delete them afterwards. The real `results/` directory and the real remote are not touched.
- Permitted substitutes: run directories produced by the E2E fakes are permitted for the hold case when AT-003 produces no natural contradiction.

### AT-005: The five restored records are correct and reproducible
- Classification: Conditional: runs after the user approves the adjudications in HT-001.
- Covers: proposal item 1 (revert of the `16401c1` deductions); existing adjudication and publication supersession rules.
- Actor and surface: an agent reading the committed `results/` records and running `npm test`.
- Setup: the branch after the adjudication commits.
- Steps: for each of the five records, read `result.json` and open `report.html`; run `npm test`.
- Expected: official scores are astra-lead 81.98, candidate-rescore-20260728 80.19, candidate-rescore-20260729 74.11, config 74.04, local-codex-tester 76.62; each record keeps its raw automated result, names the approver, time, and rationale, and cites the fixture scenario "Controls keep their keys"; each record's rubric provenance is unchanged; `same-profile-claude-tester` is untouched; no verdict changed; supersession validation passes; `git log` shows each record changed by an adjudication commit, not a hand edit.
- Evidence: a table of before and after scores per record, the adjudication block from each `result.json`, and the test summary.
- Effects and cleanup: none; read-only.
- Permitted substitutes: None.

## Human-Only Testing

### HT-001: Approve each technical adjudication of a shared published record
- Reason: published results are shared records, and the repository's rule is that the user approves every adjudication of one. An agent cannot grant that approval, and the earlier wrong deductions were approved on an agent's mistaken claim, so the approval must rest on the user's own reading.
- Prerequisites: AT-001 shows all five affected candidates passing `demo-navigation-boundaries-and-control-keys` under the corrected check; the agent presents, per record, the fixture scenario text, the old and new observation, and the proposed score.
- Instructions: read the fixture scenario "Controls keep their keys" and the five proposed adjudications; approve or reject each.
- Required decision or observation: an explicit approval or rejection per record. Only approved adjudications are applied.

### HT-002: Complete human review of issue #26 repetitions 1 and 2
- Reason: 30 of 100 points are human judgment of visual and motion quality, which the suite assigns to a human reviewer by design, and publication requires a completed human review.
- Prerequisites: AT-003 leaves both repetitions `pending-human-review` with no unexplained score difference; any review hold on them has been reviewed.
- Instructions: run `evals/agent-runner/and-scene/human-review.sh --run-dir <artifact-dir>` for each repetition and complete the rubric.
- Required decision or observation: a finalized human review for each, after which the harness publishes the result into `results/`. Confirm both appear there with `complete` status.

## Coverage Map

| Requirement or journey | INT | E2E | AT | HT |
| --- | --- | --- | --- | --- |
| Deterministic criteria fail only on positive evidence | INT-001, INT-007 | E2E-001 | AT-001 | — |
| Declared fallback judge for not-observed criteria | INT-001, INT-002 | E2E-001 | AT-003 | — |
| Focused controls keep their keys | INT-007 | — | AT-001 | — |
| Deterministic and LLM verdicts on one proposition are compared | INT-003 | E2E-002 | — | — |
| Review hold for evaluator contradictions | INT-003 | E2E-002 | AT-004 | — |
| Verdict source and review hold reporting | INT-008 | E2E-001, E2E-002 | AT-003, AT-004 | — |
| Held results are not published | INT-003 | E2E-002 | AT-004 | — |
| Golden verdict corpus of real candidates | INT-004 | — | AT-001 | — |
| Replay against the production evaluator | INT-005 | — | AT-001 | — |
| Replay manifest and staleness check | INT-004 | — | AT-002 | — |
| Every criterion states where its requirement comes from | INT-006 | — | — | — |
| Citations are verified against the pinned fixture | INT-006 | — | — | — |
| Concrete values in guidance are accounted for | INT-006 | — | AT-002 | — |
| The snapshot matches the fixture pin | INT-006 | — | AT-002 | — |
| Restore the five wrongly deducted records | — | — | AT-005 | HT-001 |
| Re-judge and publish the issue #26 repetitions | — | — | AT-003 | HT-002 |
