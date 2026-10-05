## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional
integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only
obligations.

Unit tests derived from the specs and from `design.md`'s test strategy pin the isolated logic, which
this plan does not repeat:

- reading-basis computation and the `decide()` routing;
- text-basis title and caption rules;
- swipe input ordering;
- second-opinion target selection;
- overturn validation (citation shape, inventory, line bounds, span limits, audit classification);
- retry and exhaustion handling;
- scorer substitution and the derived outline gate;
- result fields and report escaping;
- rubric fallback validation and the `7.0.0` version.

The obligations below cover seams where real modules must work together, and where a defect would
pass isolated unit tests:

- the browser evaluator's not-observed records reaching the fallback judge request through the
  controller;
- the verifier running between judging and scoring, against the controller's real neutral source
  snapshot and checkpoint store;
- terminal verification interacting with the phase lifecycle and outcome events;
- `result.json` reaching `report.html`;
- rescore and reference-baseline wiring;
- the real AXI driver dispatching pointer and touch events into a real page.

INT-001 to INT-005 run in `npm run check` (`node --test test/*.test.mjs`), through the public
`runEvaluation` entry point in `controller.mjs`. They use the injected seams the suite already uses:
- `judgeInvoke` returns scripted judge, verifier, and audit JSON chosen by `request.job` and
  `request.audit_stage`;
- `verifyCandidate` stands in for the build;
- the mock browser driver comes from `test/controller.test.mjs`;
- fake Runner state.

None of them needs network access, Docker, Chrome, or model calls. INT-006 and INT-007 drive real
Chrome through chrome-devtools-axi. Like the existing `test/real-browser/` tests, they sit outside
the CI glob, because CI has no browser.

## Integration Tests

### INT-001: A guessed browser reading reaches the fallback judge, and the outline gate follows the fallback verdict
- **Covers:**
  - Deterministic criteria fail only on positive evidence (heuristic readings).
  - Demo presentation technical quality (an undeclared mode inferred wrongly; swipes handled by
    pointer events).
  - Declared fallback judge for not-observed criteria (all deterministic criteria have a fallback).
  - Hard gates and official pass (derived `verification-sample-outline`).
  - Verdict source reporting.
- **Boundary:** `runBrowserEvaluation` with a mock driver, then the controller's `product-judging`
  handler, then real `runProductJudging` request building, then real `scoreProduct`, then
  `assembleResult`, then `renderReport`.
- **Setup:**
  - A mock driver whose `state()` reports `modeBasis: 'heuristic'` and keeps reporting `browse`
    after `setMode('present')`.
  - The same driver's `swipe()` changes the step only for `{ input: 'pointer' }`.
  - Titles and captions are present in `textPresence`, with `complete: true`.
  - `judgeInvoke` answers the `demo-integration` job with `pass` and a valid path citation for every
    requested criterion, and confirms the audit.
  - The checked-in `automated-rubric.json` is used.
- **Action:** run a candidate evaluation to the pending result.
- **Assertions:**
  - The present-mode-dependent criteria and the outline inputs are recorded with
    `outcome: 'not-observed'`, `verdict: null`, and a `looked_for` list. None is `fail`.
  - `demo-supported-navigation`'s probe record shows the touch path unchanged and the pointer path
    moving.
  - The `demo-integration` judge request's `criteria` contains exactly its owned criteria plus those
    not-observed ids.
  - In `phases/score.json`, the criteria have `source: 'fallback'`, the derived outline gate is
    `pass`, and `raw_browser_gate` is unobserved.
  - Automated eligibility is computed rather than left unavailable.
  - `report.html` marks the fallback-resolved criteria.
  - No `second-opinion` request was made, because nothing failed.
- **Execution:** `test/controller.test.mjs` (`npm run check`).

### INT-002: A browser failure gets a second opinion against the real neutral source, and the result and report carry both verdicts
- **Covers:**
  - Failures that receive a second opinion.
  - Verifier inputs and answer.
  - Overturn acceptance.
  - Second-opinion verdict.
  - Second-opinion reporting.
  - Evaluation-harness failure outcome (a missing second opinion).
- **Boundary:** the controller's `source-freeze` neutral snapshot, then the `product-judging`
  handler running real `runProductJudging`, then the real `lib/second-opinion.mjs` (span validation
  against the snapshot on disk, the closed-world span audit packet, checkpoint units), then real
  `scoreProduct`, `assembleResult`, and `renderReport`.
- **Setup:**
  - A candidate fixture source tree with a known file, for example a swipe handler at known lines.
  - A mock driver that makes `demo-supported-navigation` and `demo-browse-mode-behavior` fail on
    declared or semantic readings.
  - `judgeInvoke` scripted by criterion. The verifier returns:
    - for criterion A: `overturn` with a valid span, and the audit returns `confirmed`;
    - for criterion B: `overturn` with a span past the file's end;
    - for any further failure: `uphold`.
- **Action:**
  1. Run a candidate evaluation.
  2. Run `--resume` on the same run directory.
  3. In a separate run, script the verifier to return malformed JSON on every attempt for one
     target.
- **Assertions:**
  - Exactly one `second-opinion` request per failed criterion. Each request prompt contains the
    criterion requirement, its fixture quote, and the probe's recorded observations, and its `cwd`
    is the neutral judge root.
  - **Criterion A:** raw `fail`, second-opinion `pass`, decision `overturn`; it earns its points in
    `phases/score.json`.
  - **Criterion B:** `overturn-rejected` with a line-range reason; the final verdict is `fail`.
  - The upheld criterion stays `fail`.
  - `result.json` records `second_opinions.checked`, `overturned: 1`, and the overturned points.
  - `report.html` has an "Overturned failures" section listing only criterion A, with escaped
    `path:start-end` spans.
  - Criterion A's audit request packet contains the cited spans, criterion A's probe record (with
    `reading_basis`), and the page and console failures recorded for that probe.
  - `phases/second-opinions/<id>.json` artifacts exist, and the checkpoint records the
    `second-opinion:criterion:<id>` units.
  - **Resume:** makes no new `second-opinion` request.
  - **Malformed run:** ends `evaluation-harness-failed` and resumable. `score.json` leaves that
    target's component incomplete, and no product verdict is issued.
- **Execution:** `test/controller.test.mjs` (`npm run check`).

### INT-003: Outline-gate follow-up and the renders gate through the real scorer
- **Covers:**
  - Failures that receive a second opinion (the outline gate's inputs; failed renders gate).
  - Hard gates and official pass (re-derivation after an overturn).
  - Second-opinion verdict (a gate overturn).
- **Boundary:** the controller's `product-judging` handler, from the first round of second opinions
  through `resolveDeterministic`, the follow-up round, and `scoreProduct`.
- **Setup:**
  - `demo-nine-step-content-and-order` is not observed in the browser, and the `demo-integration`
    fallback returns `fail`.
  - The page reports a console failure, so `verification-every-produced-step-renders` fails.
  - The verifier overturns the outline input on the gate's behalf, with a confirmed span, and
    upholds the renders gate.
- **Action:** run a candidate evaluation.
- **Assertions:**
  - The verifier calls are, in order: the renders gate in round 1, then
    `demo-nine-step-content-and-order` with `on_behalf_of: 'verification-sample-outline'` in
    round 2.
  - No call is made for fallback failures outside the outline inputs.
  - The derived outline gate is `pass`.
  - The renders gate stays `fail`, with `raw_verdict` recorded.
  - Automated eligibility fails on the renders gate alone.
- **Execution:** `test/controller.test.mjs` (`npm run check`).

### INT-004: Terminal build and serve failures are second-opinioned before the conclusive outcome
- **Covers:**
  - Terminal build and serve failure contract.
  - Separate evaluation status and product verdict.
  - Evaluation-harness failure outcome.
  - Detailed result artifact (via second-opinion reporting).
- **Boundary:** the `verification` and `candidate-server` handlers, `runTerminalSecondOpinion`,
  `runPhases`, and `applyOutcomeEvent`, then the result.
- **Setup:**
  - `verifyCandidate` returns a build `product_failure`. Its full command output has more than
    4,000 characters of standard output before the decisive harness-fault line, persisted under
    `phases/command-output/`.
  - A separate case makes the server start throw `CandidateProductServeError`.
  - The verifier is scripted three ways:
    - (a) `uphold`;
    - (b) an overturn citing log lines and the fixture's `package.json` script lines, with the audit
      confirmed;
    - (c) an overturn citing source only.
  - A further case has no `judgeInvoke`.
- **Action:** run candidate evaluations for each case.
- **Assertions:**
  - **(a) and (c):** `evaluation_status: complete`, `product_verdict: fail`, and
    `product_failure.second_opinion` recorded. Case (c) is recorded as `overturn-rejected`.
  - **(b):** `evaluation-harness-failed`, resumable, `product_verdict: unavailable`, with the
    accepted overturn and its log and source citations in the result.
  - `phases/terminal-evidence/<gate>.log` holds the complete command output, including the
    harness-fault line after 4,000 characters.
  - The verifier prompt and the audit packet include that line.
  - **No invoker:** a harness failure with code `judge-output`, and no conclusive product failure.
  - Later phases are skipped only in the conclusive cases.
- **Execution:** `test/controller.test.mjs` and `test/phases.test.mjs` (`npm run check`).

### INT-005: Rescore applies the second opinion; reference baselines and calibration do not
- **Covers:** Failures that receive a second opinion (rescore, reference-baseline and calibration
  exclusion).
- **Boundary:** the `--rescore-from` path (`loadCandidateRescoreSource` and the fresh evaluator
  phases), the `--reference-baseline` path, and `lib/calibration.mjs` calling `scoreProduct`.
- **Setup:**
  - A completed source run fixture, as in the existing rescore tests, with a mock driver that makes
    one criterion fail.
  - A reference-baseline run with the same driver.
  - One calibration case.
- **Action:** run the rescore, the reference-baseline evaluation, and the calibration case.
- **Assertions:**
  - The rescore issues exactly one `second-opinion` request, and its result carries the second
    opinion.
  - The reference baseline issues none, records the raw `fail` as final, and its result has no
    second-opinion fields.
  - Calibration output contains no second-opinion data.
- **Execution:** `test/controller.test.mjs` and `test/calibration.test.mjs` (`npm run check`).

### INT-006: The real driver and evaluator on adversarial pages
- **Covers:**
  - Demo presentation technical quality (pointer-event swipes; an undeclared mode inferred wrongly;
    a declared `data-mode`).
  - Deterministic criteria fail only on positive evidence.
  - The issue's required real-browser adversarial pages.
- **Boundary:** the real `createAxiBrowserDriver` running through chrome-devtools-axi into real
  Chrome, then real `runBrowserEvaluation`. This is the only place the `PointerEvent` dispatch,
  frame pacing, `modeBasis`, and `textPresence` page scripts actually execute.
- **Setup:** new variants in `test/real-browser/pages/presentation.html`, served by
  `test/real-browser/serve-page.mjs`:
  - **(q) pointer-only swipe:** `onPointerDown`/`onPointerUp` navigation, with touch events ignored.
  - **(r) no declared mode:** present mode shows an unhooked footer paragraph carrying the deck
    title. This is the #67 rep 1 shape without `data-mode`.
  - **(p):** keep PR #70's declared-`data-mode` variant, or add it if PR #70 has not merged.
  - **A negative control:** no swipe handling at all.
  - **(s) nested caption spans:** browse mode is declared and each normative caption is split
    across nested inline elements, with no caption hook.
  - **(t) hidden labelledby title:** present mode is declared and the active step title is exposed
    only through `aria-labelledby` pointing at a visually hidden element.
- **Action:** `evaluate(variant)` for each.
- **Assertions:**
  - **(q):** `demo-supported-navigation` is `pass`, and its observation records the touch path
    unchanged and the pointer path moving.
  - **(r):** no mode, title, or outline criterion, and not the raw `verification-sample-outline`
    gate, has verdict `fail`. Each is `pass` or `not-observed` with `looked_for` populated.
  - **(p):** the title and mode criteria pass.
  - **Negative control:** `demo-supported-navigation` is `not-observed`, both swipe paths are
    recorded, and the verdict is never `pass`.
  - **(s) and (t):** no caption or title criterion has verdict `fail`, and `textPresence` reports
    the text as present with `complete: true`.
  - Existing variants (a)–(o) keep their current assertions.
- **Execution:** run manually with `node --test test/real-browser/adversarial.test.mjs`, with Chrome
  and chrome-devtools-axi installed. Run it once after changing the driver or evaluator, and report
  the outcome in the PR.

### INT-007: Reference and real-candidate browser regression stay definite
- **Covers:**
  - Demo presentation technical quality (reference regression).
  - Deterministic criteria fail only on positive evidence: genuine absence still fails.
- **Boundary:** the real driver and evaluator against the pinned reference presentation
  (`lib/reference-browser-regression.mjs`), and against the real issue #26 rep 3 candidate
  (`test/real-browser/candidate.test.mjs`).
- **Setup:** as documented at the top of each test, building and serving the pinned revisions
  locally.
- **Action:** run both regressions.
- **Assertions:**
  - Every reference caption and canonical-content criterion is `pass` from the browser owner, with
    no not-observed result and no fallback.
  - The candidate's known genuine failures remain `fail`. Any expectation that changes to
    not-observed is justified in the PR by the heuristic reading it rested on.
- **Execution:** the programmatic part runs in `test/reference-browser-regression.test.mjs`
  (`npm run check`). The real-browser parts run manually with Chrome.

## End-to-End Tests

None. A true end-to-end run is a paid `run.sh --run-agent` candidate evaluation. It needs Docker,
model credentials, and GitHub push rights, and it is not reproducible in CI. INT-001 to INT-005
already drive the public `runEvaluation` entry point through the changed phases with realistic
on-disk run directories. The real-world check of record is the post-merge rescore of the three
agent-evals #67 reps, which the issue schedules after merge and which is outside this plan.

## Acceptance Testing Envelope

- **Environments and sandboxes:**
  - A local clone of this repository and Node 22.
  - `npm run check`.
  - Temporary run directories under the OS temp directory.
  - Local Chrome with chrome-devtools-axi, for `test/real-browser/` and
    `run.sh --proof-browser`, when installed.
  - The pinned reference and issue #26 candidate, built and served on localhost as each real-browser
    test documents.
  - `run.sh --dry-run`, to inspect planned invocations.
- **Credentials and secrets:**
  - Host Codex, Claude, and GitHub CLI authentication may exist on the machine. The acceptance pass
    must not use them for model calls or pushes.
  - No secrets are needed: model judges are replaced by scripted `judgeInvoke` seams.
- **Authorized effects:**
  - Local processes and files only: the test suite, local static servers on localhost ports, local
    Chrome sessions, and temporary run directories.
  - The pass must stop the servers and Chrome sessions it starts, and delete the temporary
    directories afterwards.
  - No spend is authorized.
- **Off limits:**
  - Paid evaluations (`run.sh --run-agent`).
  - Any real Codex or Claude judge or verifier call, including a real `--rescore-from` of the #67
    runs. That rescore is the post-merge step the issue owns.
  - Publishing results, or editing anything under `evals/agent-runner/and-scene/results/**`.
  - Pushing branches, or opening PRs other than the change's own.
  - Modifying `Codagent-AI/and-scene` or other product repositories.
  - Using Paul's retained private run directories, other than read-only inspection.
- **Permitted substitutes:**
  - Scripted `judgeInvoke` responses for judges, verifiers, and audits.
  - The mock browser drivers already in `test/`, when Chrome or chrome-devtools-axi is unavailable.
    In that case, report INT-006 and INT-007's real-browser parts as not run, with the reason.
  - Hand-made adversarial pages in place of real candidates.
- **Known risk areas:**
  - **False passes from overturns.** Check that an overturn without positive, audited source proof
    never passes.
  - **The heuristic-versus-definite boundary in each probe.** A genuinely missing caption or title
    under a declared mode must still fail; a layout-chosen element must never cause a fail.
  - **Supported navigation.** Swipe double-stepping when a candidate handles both touch and pointer
    input; the touch-unchanged-then-pointer ordering.
  - **Text-presence completeness and accessible-name resolution.** An incomplete walk is treated as
    heuristic. The simplified ARIA name computation is an accepted limitation.
  - **PR #70 merge conflicts** in the driver's mode-reading scripts and the adversarial page.
  - **Checkpoint and resume churn** from the rubric `7.0.0`, evaluator fingerprint, score schema 5,
    and result schema 9 changes. Older runs are expected to rescore, not resume.
  - **Rendering older results.** Schema 8 results must still render without second-opinion
    markings.
  - **Report escaping** of verifier rationales and cited paths.
  - **Prior defect clusters:** captions misread from markers (PR #65), `data-mode` (PR #70), and
    touch-only swipes. These are the exact shapes the adversarial pages reproduce.

## Human-Only Testing

None.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| failure-second-opinion: Failures that receive a second opinion | INT-002, INT-003, INT-005 | — | — |
| failure-second-opinion: Verifier inputs and answer | INT-002 | — | — |
| failure-second-opinion: Overturn acceptance | INT-002, INT-003 | — | — |
| failure-second-opinion: Second-opinion verdict | INT-002, INT-003 | — | — |
| failure-second-opinion: Terminal build and serve failure contract | INT-004 | — | — |
| failure-second-opinion: Verifier failure handling | INT-002, INT-004 | — | — |
| product-quality-scoring: Demo presentation technical quality | INT-001, INT-006, INT-007 | — | — |
| product-quality-scoring: Hard gates and official pass | INT-001, INT-003 | — | — |
| product-quality-scoring: Deterministic criteria fail only on positive evidence | INT-001, INT-006, INT-007 | — | — |
| product-quality-scoring: Declared fallback judge for not-observed criteria | INT-001 | — | — |
| evaluation-outcomes: Separate evaluation status and product verdict | INT-004 | — | — |
| evaluation-outcomes: Evaluation-harness failure outcome | INT-002, INT-004 | — | — |
| evaluation-metrics-reporting: Verdict source reporting | INT-001 | — | — |
| evaluation-metrics-reporting: Second-opinion reporting | INT-002, INT-004 | — | — |
