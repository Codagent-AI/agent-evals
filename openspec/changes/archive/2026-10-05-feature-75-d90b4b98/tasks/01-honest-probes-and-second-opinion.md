# Task: Honest browser probes and a second opinion on every failure

## Goal

Stop the and-scene eval from recording false product failures.

- **Honest probes.** A deterministic browser probe never records `fail` on a guessed reading, such
  as an inferred mode or a title or caption element chosen by layout. It records "not observed", and
  the existing fallback judge decides from source. Swipe is tried as touch input, then as pointer
  input.
- **Second opinion.** Every owner-decided browser `fail`, and every failed hard gate (including
  terminal build and serve failures), gets one LLM verifier call. It can overturn the failure only
  with audited candidate-source line citations that prove the requirement is met and explain the
  measurement fault.
- **Recording.** The result keeps both the raw and the second-opinion verdict. Scoring uses the
  second opinion, and the report lists overturned failures. Rescore applies it; reference-baseline
  runs and calibration do not.

## Sources of truth

Read these first. They are normative, and this file only orients you:

- `openspec/changes/feature-75-d90b4b98/specs/failure-second-opinion/spec.md`: the new capability,
  covering targets, inputs, overturn acceptance and limits, verdicts, the terminal contract, and
  failure handling.
- `openspec/changes/feature-75-d90b4b98/specs/product-quality-scoring/spec.md`: the modified
  requirements, covering reading basis, text presence, swipe paths, the declared `data-mode`,
  fallbacks for every deterministic criterion, and the derived and three-state raw outline gate.
- `openspec/changes/feature-75-d90b4b98/specs/evaluation-outcomes/spec.md`: the terminal uphold and
  overturn outcomes, and a missing second opinion.
- `openspec/changes/feature-75-d90b4b98/specs/evaluation-metrics-reporting/spec.md`: verdict
  source and second-opinion reporting.
- `openspec/changes/feature-75-d90b4b98/design.md`: components, interfaces, and decisions. Follow
  §1 to §7.
- `openspec/changes/feature-75-d90b4b98/test-plan.md`: integration obligations INT-001 to INT-007.
- `openspec/changes/feature-75-d90b4b98/decisions.md`: the rationale for every choice, including
  the applied review findings (PR-001 to PR-003 and AR-001 to AR-004).
- `openspec/changes/feature-75-d90b4b98/proposal.md`: scope and exclusions.

## Background

The suite lives in `evals/agent-runner/and-scene/`. Paths below are relative to it unless they
start with `openspec/` or `test/`. Tests live in the repository-root `test/` directory and run
through `npm run check` (`node --test test/*.test.mjs`). `test/real-browser/` is outside that glob
and is run by hand with Chrome and chrome-devtools-axi.

- **Present-mode false failure** (agent-evals #67 rep 1). The candidate declared `data-mode`. The
  driver read only `data-presentation-mode`, inferred browse mode from a visible footer paragraph,
  and `session()` in `lib/browser-eval.mjs` threw a plain `Error` ("probe state could not be
  established"). The probe loop recorded that as `fail` for seven probes and the outline gate.
- **Swipe false failure** (#67 rep 2). `swipe()` in `lib/axi-browser-driver.mjs` dispatches only
  `TouchEvent`s, and the candidate used pointer events.
- **PR #70** ("fix: read a declared data-mode as the presentation mode") was still open when this
  change was defined.
  - If it has merged, build on its `declaredModeSource()`.
  - If it has not, port its rule (see the declared-mode paragraph and the "A deck declares its mode
    as data-mode" scenario in the scoring spec delta) and its adversarial page variant (p).
- **Current code to change:**
  - Fallbacks exist only for two criteria (`automated-rubric.json` `fallbacks`, version `6.0.0`).
  - The raw outline gate is `passed(a) && passed(b)` (`runBrowserEvaluation`, around line 975).
  - Scoring happens inside the controller's `product-judging` handler, right after
    `runProductJudging`.
  - Build and serve failures emit `conclusive-product-failure` from the `verification` and
    `candidate-server` handlers.
  - `outputOf` in `lib/candidate-verification.mjs` truncates command output to 4,000 characters.

## What to build

1. **Driver** (`lib/axi-browser-driver.mjs`, design §1):
   - one `modeReadingSource()` returning `{ mode, basis }`, used by `open`, `setMode`,
     `toggleMode`, and `state`;
   - `modeBasis`, `captionBasis`, and `titleBasis` in `state()`;
   - `state({ presenceOf })` returning in-page `textPresence`: minimal visible elements by normalized
     `innerText`, resolved accessible names including hidden `aria-labelledby` targets, and
     `complete`;
   - `swipe(direction, { input: 'pointer' })` with `PointerEvent`s (`pointerType: 'touch'`), using
     the touch path's target and pacing.
2. **Probes** (`lib/browser-eval.mjs`, design §2):
   - `UnobservedPrecondition` for a heuristic mode mismatch in `session()`;
   - a `decide()` helper with `restsOn`;
   - `textActiveAt` over `textPresence`, where an incomplete observation gives `unknown`;
   - the per-probe table in design §2;
   - swipe ordering for `demo-supported-navigation`, with both paths recorded;
   - `reading_basis` in probe records;
   - the three-state raw outline gate;
   - an evaluator fingerprint bump.
3. **Rubric** (design §3):
   - a `demo-integration` fallback for all 14 deterministic-browser criteria, with text free of
     concrete values so `lib/traceability.mjs` passes;
   - version `7.0.0`;
   - `validateAutomatedRubric` requires a fallback for every deterministic-browser criterion.
4. **Verifier** (new `lib/second-opinion.mjs`, design §4):
   - target selection, including outline follow-ups and the reference-baseline exclusion;
   - the request builder;
   - `SECOND_OPINION_SCHEMA`;
   - `runSecondOpinion`, which covers:
     - retries on malformed output;
     - structural and span validation, using an exported `citationTarget` from `lib/judge-jobs.mjs`;
     - the limits of 12 source spans each under 200 lines, and 6 log spans;
     - one closed-world audit whose packet holds the spans, the failing record, the reading basis,
       and the page and console failures;
     - `confirmed` gives an overturn, and anything else gives a rejection;
   - checkpointed units `second-opinion:<kind>:<id>` with artifacts under
     `phases/second-opinions/`.
5. **Product-judging integration** (`controller.mjs`, `lib/scorer.mjs`, design §5):
   - first round, then `resolveDeterministic`, then the outline follow-up round, then
     `scoreProduct({ secondOpinions, pendingSecondOpinions })`;
   - `phases/second-opinions.json`;
   - `judge-output` on exhausted units, after `score.json` is written;
   - score schema 5, with `second_opinion` on rows, a derived outline gate with `raw_browser_gate`,
     and `second_opinions` totals.
6. **Terminal failures** (`controller.mjs`, `lib/candidate-verification.mjs`, `lib/outcomes.mjs`,
   design §6):
   - persist full command output to `phases/command-output/`: lossless up to 1 MiB per stream, then
     head 256 KiB plus tail 768 KiB with a marker and `output_truncated`;
   - `phases/terminal-evidence/<gate>.log`;
   - `runTerminalSecondOpinion` in the `verification` and `candidate-server` handlers:
     - uphold or rejected overturn gives the conclusive product failure, with `second_opinion`;
     - accepted overturn gives a resumable `terminal-failure-overturned` harness failure;
     - a failed call, or no invoker, gives `judge-output`.
7. **Result and report** (`lib/result.mjs`, `lib/report.mjs`, design §7):
   - result schema 9, with a `second_opinions` block and `product_failure.second_opinion`;
   - an "Overturned failures" section;
   - second-opinion lines in criterion details;
   - raw and derived outline gates;
   - escaping throughout;
   - schema 8 results still render.

## Tests

Write each test before its behavior (test-driven development).

- **Unit tests:** derive them from every scenario in the four spec deltas and from the Test Strategy
  in `design.md`. Use the existing files (`test/browser-eval.test.mjs`,
  `test/axi-browser-driver.test.mjs`, `test/judge-jobs.test.mjs`, `test/scoring.test.mjs`,
  `test/rubric.test.mjs`, `test/traceability.test.mjs`, `test/result-assembly.test.mjs`,
  `test/report.test.mjs`, `test/candidate-verification.test.mjs`, `test/phases.test.mjs`). A new
  `test/second-opinion.test.mjs` inside the existing glob is allowed. The issue's required unit
  cases are included:
  - not-observed routing;
  - an overturn without valid citations is rejected;
  - raw versus second-opinion verdicts in the result.
- **Integration tests INT-001 to INT-005** from `test-plan.md`, in `test/controller.test.mjs`,
  `test/phases.test.mjs`, and `test/calibration.test.mjs`. They go through `runEvaluation` with
  scripted `judgeInvoke` (verifier and audit responses chosen by `request.job` and
  `request.audit_stage`), mock drivers, and fake Runner state. No network, Docker, Chrome, or model
  calls.
- **INT-006:** add adversarial variants to `test/real-browser/pages/presentation.html` and tests in
  `test/real-browser/adversarial.test.mjs`:
  - (q) pointer-only swipe;
  - (r) no declared mode, with an unhooked present-mode footer paragraph;
  - (p) declared `data-mode`;
  - (s) nested caption spans;
  - (t) hidden `aria-labelledby` title;
  - a no-swipe negative control.

  Run them by hand when Chrome and chrome-devtools-axi are available.
- **INT-007:** keep `test/reference-browser-regression.test.mjs` green. Run
  `test/real-browser/candidate.test.mjs` by hand when possible. Any expected fail that becomes
  not-observed must be justified in the PR.

## Constraints

- No new runtime dependencies.
- Do not edit anything under `evals/agent-runner/and-scene/results/**`.
- Do not change criteria, owners, points, subcomponents, or thresholds in the rubric. Only add
  fallbacks and bump the version.
- No new test suites or CI jobs.
- Do not make real Codex or Claude calls in tests.
- Keep the evaluated product infrastructure in the Agent Runner repository. Nothing here changes
  the sandbox or the Runner.
- Use commit messages of the form `type: lowercase description`.

## Done When

- Every scenario in the four spec deltas is covered by a passing test.
- INT-001 to INT-005 pass under `npm run check`. INT-006 and INT-007's manual real-browser runs
  either passed, or are reported in the PR as not run, with the reason.
- In a candidate run, a heuristic mode mismatch produces not-observed criteria resolved by the
  `demo-integration` fallback. It never produces a browser `fail` or a raw outline `fail`.
- A pointer-only swipe is never a `fail`.
- Every owner-decided browser `fail` and every failed hard gate has exactly one verifier call:
  - an overturn without valid, audited citations leaves the failure `fail`;
  - an accepted overturn scores as `pass`, with the raw `fail` retained;
  - a terminal overturn ends in a resumable harness failure, never a pass.
- Rescore applies the second opinion. Reference-baseline runs and calibration record none.
- `report.html` shows the "Overturned failures" section, and schema 8 results still render.
- The checked-in rubric is `7.0.0`, validates, and passes traceability.
- `npm run check` passes, and nothing under `results/` changed.
