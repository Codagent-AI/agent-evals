## Why

The and-scene eval keeps reporting failures the candidate did not cause. The deterministic browser
evaluator (`lib/browser-eval.mjs` with the AXI driver in `lib/axi-browser-driver.mjs`) records a
definite `fail` whenever its own guess goes wrong, and a definite `fail` is final: only probes that
come back *not observed* reach the LLM browser-fallback judge (`fallbackEntriesFor` in
`lib/judge-jobs.mjs`). Recent baseline runs show the pattern:

- **Present mode** (agent-evals #67 rep 1, #61 rep 1): the candidate declared its mode as `data-mode`.
  The driver reads only `data-presentation-mode`, so it inferred the mode from what was visible. It
  took the footer deck title for a caption and reported "browse" as fact. Seven probes and the
  `verification-sample-outline` hard gate failed. PR #70 (still open) fixes that one hook.
- **Swipe** (#67 rep 2, `demo-supported-navigation`, "swipe 0/0"): the driver sends only synthetic
  `TouchEvent`s. A candidate that handles swipes with pointer events never sees them, although a real
  finger produces both.
- **Earlier**: a `<p data-presentation-marker>` was read as a caption (fixed by PR #65).

Each fix so far patches one heuristic after a run is already lost. A hard-gate or floor failure
denies the candidate an official pass, so a single wrong guess can turn a conforming implementation
into a recorded product failure. Evals are on hold until this is fixed, and the three #67 reps are
waiting to be re-checked. The cause is structural: a probe that is guessing reports its guess as
fact, and nothing reviews a failure before it counts.

## What Changes

1. **Probes report uncertainty.** Whether a probe is certain now depends on how it read the result,
   not on how it found the element.
   - A verdict read from a declared hook, or from a directly measured effect of operating a control
     uniquely found by role or accessible name, stays definite.
   - A result that depends on a heuristic fallback becomes **not observed**, along with what the
     probe looked for. Heuristic fallbacks are deciding *which element* is the mode, caption, or title
     from visibility or layout, and a convention search that found nothing.
   - Absence that the live page establishes without that judgement stays a definite `fail`.
     Examples: the step's full visible text and accessibility tree contain no instance of the
     required normative title or caption, or the page exposes no operable control of the needed role
     at all. Specifications define this split for each affected probe, along with the rendered-state
     evidence that suffices. The affected probes are present and browse mode, mode position,
     canonical content, captions and navigation, and supported navigation.
   - Ambiguous controls and unreadable page state remain resumable harness failures, as today.
   - PR #70's declared `data-mode` handling is kept: it is reused if PR #70 merges first, and carried
     here otherwise.
2. **Input probes try every allowed input path.** Swipe tries touch events and then pointer events
   before it concludes. If no path changes the step, swipe is not observed rather than failed. A
   wrong-step result from any path is still a definite `fail`.
3. **Not-observed results reach the existing fallback judge.** The automated rubric gains fallback
   declarations for each deterministic criterion that can now be not observed. Source citations and
   the source audit are unchanged.
4. **`verification-sample-outline` follows its criteria.** The gate is derived during scoring from
   the *final* verdicts of `demo-route-and-registration` and `demo-nine-step-content-and-order`. That
   is the browser verdict, or the fallback verdict, after any second opinion. The raw browser gate
   is kept beside the derived one. Without this, a candidate with no declared mode hook would end
   with an unobserved gate and no verdict.
5. **Every failure gets a second opinion.** One LLM verifier call checks each of these failures:
   - every deterministic browser criterion with verdict `fail`;
   - every failed hard gate, whatever decided it.

   The verifier sees the criterion or gate text and its spec source quote, the probe's recorded
   observations and trace, and the candidate's neutral source. It answers `uphold` or `overturn`,
   with a rationale. An overturn says two things: the raw fail was a measurement problem, and the
   candidate meets the requirement. It is accepted only when all of these hold:
   - it names the probe step that was mismeasured and explains how;
   - it cites candidate source, as path plus line range, that establishes the requirement is met.
     This is the same positive bar a fallback `pass` must clear today;
   - each cited range is inside a file of the verified delivery, and the source audit confirms both
     the citations and the claim that the requirement is met.

   Showing only that the probe was unsound, without positive evidence that the requirement is met,
   is not an overturn: the fail stands. A failure that the recorded runtime evidence (page errors,
   console failures, build log) supports is upheld unless the overturn explains that evidence as a
   measurement fault.

   Hard gates follow the same rule, with these differences:
   - `verification-sample-outline` has no verifier call of its own, because it is derived from its
     criteria. When it fails, each failing input criterion not already checked gets a call on the
     gate's behalf, including an input that failed under its fallback judge. The gate is then
     derived again.
   - An accepted overturn of `verification-every-produced-step-renders` or
     `verification-clear-outcome` makes that gate `pass`.
   - Build and serve failures follow the terminal-gate contract below. Their overturn is never a
     pass.
6. **Results keep both verdicts.** For every checked failure, `result.json` keeps the raw verdict, the
   second-opinion verdict, the rationale, and the citations. An overturn's second-opinion verdict is
   `pass`; an uphold's is `fail`. Points still come only from binary pass/fail verdicts. Scores,
   floors, gates, and eligibility use the second-opinion verdict. The HTML report lists overturned
   failures in their own short section.
7. **Rescore re-checks finished runs.** The second opinion is part of evaluation, so the
   evaluator-only rescore path applies it to finished runs without re-running the agent.

This change amends `product-quality-scoring` in two places:

- It widens the rule that keeps "not observed" deliberately narrow. Today, any caption, title, or
  navigation the probe cannot find is recorded as `fail`. After this change, only absence the live
  page positively establishes is a `fail`; a result that depends on picking the element by heuristic
  is not observed.
- It replaces "hard gates SHALL NOT have fallback judges" with the second-opinion rule. A gate still
  has no fallback judge.

Neither amendment is **BREAKING** for persisted artifacts: the new result fields are additive, and
older runs remain readable and rescorable.

## Capabilities

### New Capabilities
- `failure-second-opinion`: the verifier, covering its inputs, the uphold and overturn contract, the
  path-and-line citation shape, validation and audit, the separate log-citing contract for
  terminal build and serve failures, checkpointing and resume, failure handling,
  the modes it runs in, and how both verdicts are recorded.

### Modified Capabilities
- `product-quality-scoring`: the rules for not observed and for certainty; trying every input path
  (swipe by touch, then pointer); new fallback declarations; `verification-sample-outline` derived
  from final criterion verdicts; scores, floors, and gates using second-opinion verdicts; and the
  rule that hard gates have no second judge.
- `evaluation-outcomes`: build and serve failures get a second opinion before the run becomes a
  conclusive product failure. An overturned terminal failure becomes a resumable harness failure.
- `evaluation-metrics-reporting`: `result.json` keeps both raw and second-opinion verdicts, the
  report gains an "Overturned failures" section, and verifier usage is counted as eval-owned usage.

## Technical Approach

- **Probes.** Probe functions in `browser-eval.mjs` return the existing `notObserved(...)` outcome
  wherever the driver state says it was inferred. The driver already reports what it searched for
  (for example `entityConventions`); it will also report the basis for each reading of mode,
  caption, and title: declared hook, semantic control, or heuristic. Swipe gains a pointer-event
  path in `axi-browser-driver.mjs` with the same render-frame pacing the touch path uses. To support
  the definite-absence rule, the driver also reports each step's full visible text, accessible names,
  and the operable controls by role. A probe can then fail on positively established absence without
  deciding which element is the caption or title.
- **Fallbacks.** Any deterministic browser criterion can now be not observed when its fail would
  rest on a heuristic reading, so every deterministic browser criterion gets a `demo-integration`
  fallback entry in `automated-rubric.json`. The rubric version goes up. Criteria, owners, points, and weights do not
  change.
- **Verifier placement.** The verifier runs after product judging and fallback resolution, and before
  final scoring. It reuses the product-judge call path (`runJudgeJob` with the Codex judge
  authority and `--judge-model`), the neutral source, and checkpointed per-unit reuse. The verifier
  has its own schema with `{path, start_line, end_line}` citations. Validation checks that the path
  is in the verified source inventory and that the lines are within the file, then sends exactly
  those spans to the source auditor. Existing path-only fallback citations are unchanged. Gate and
  criterion rows in the scorer take the second-opinion verdict when one exists.
- **Terminal gates.** A build or serve failure today emits `conclusive-product-failure` in
  `controller.mjs`, and `lib/phases.mjs` then skips product judging. A verifier step at that point
  reviews the gate using the frozen source and the failure log, under its own overturn contract. An
  overturn must:
  - cite exact lines of the recorded build or serve log, or another harness artifact, that show the
    measurement fault;
  - give a checkable explanation of the fault, such as a wrong invocation, an outage, or a launch
    error;
  - cite candidate source showing what the harness should have run, such as the declared build or
    start script and its configuration. The issue requires every overturn to cite candidate source.

  Log citations are validated against the recorded artifact and audited the same way as source
  spans. The outcomes are:
  - **Uphold:** the product failure stands as it does today.
  - **Overturn:** the run becomes a resumable evaluation-harness failure, never a pass, because no
    built app exists to score.
- **Failure handling.** If the verifier produces no valid output after its retries, the run takes the
  normal resumable missing-judge-output path, like any other judge. It never upholds or overturns
  silently.
- **Modes.** The verifier runs for candidate evaluations and on rescore. It does not run in
  reference-baseline mode or calibration, because there a deterministic failure is a signal about
  the evaluator, and an overturn would hide it.
- **Cost.** Each failure costs one verifier call, plus a source audit for each proposed overturn.
  This usage is recorded in `phases/eval-owned-usage.jsonl` and is not counted as implementation
  cost.

## Out of Scope

- Second-guessing LLM judge verdicts that are not failed hard gates.
- Changing rubric criteria, owners, points, or weights. Adding fallback declarations and bumping the
  rubric version are the only rubric edits.
- An independent browser replay inside the verifier. It is a possible later step if overturns prove
  unreliable.
- New test suites or CI jobs.
- Editing published `results/**` records. The #67 reps are re-checked through rescore after merge.

## Impact

- **Code:**
  - `lib/browser-eval.mjs`, `lib/axi-browser-driver.mjs`: certainty basis and the pointer swipe path.
  - `automated-rubric.json`, `lib/rubric.mjs`: fallbacks and the version bump.
  - `lib/judge-jobs.mjs`: verifier job, citation shape, and audit.
  - `lib/scorer.mjs`: derived outline gate and second-opinion verdicts.
  - `controller.mjs`, `lib/phases.mjs`, `lib/outcomes.mjs`: the verifier step and terminal-gate
    verifier.
  - `lib/result.mjs`, `lib/report.mjs`, `lib/cost.mjs`: recording and reporting.
  - `lib/rescore.mjs`: the verifier runs on rescore.
- **Tests:**
  - New real-browser adversarial pages in `test/real-browser/`: a pointer-event-only swipe, and a mode
    with no declared hook. Neither may produce a definite `fail`.
  - New unit tests in `test/*.test.mjs`: routing to not observed, the citation rule (an overturn
    without valid citations is rejected), raw and second-opinion verdicts in the result, the derived
    outline gate, and the terminal-gate overturn path.
  - The reference regression must still pass every caption and canonical-content criterion
    definitively.
- **Runs:** extra Codex judge calls when failures occur. Score-affecting inputs change through the
  rubric version, so resuming a run started before this change is refused by the existing input
  checks. Rescore is the supported way to re-check those runs.
- **Dependencies:** none added. PR #70 must merge before this change or be folded into it, and
  either path may need a merge-conflict resolution in `axi-browser-driver.mjs`.
