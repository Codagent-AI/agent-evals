## Context

All paths below are relative to `evals/agent-runner/and-scene/` unless they start with `test/` or
`openspec/`.

The and-scene evaluation runs these phases in order (`lib/phases.mjs`): `source-freeze` →
`verification` → `candidate-server` → `browser-evaluation` → `product-judging` → … →
`pending-result`.

- **`verification`** (`controller.mjs`, `lib/candidate-verification.mjs`) builds the frozen
  candidate. On an install or build failure it returns
  `product_failure: { owner: 'product', stage, gate: 'verification-build-whole-app', reason }`.
  The handler then emits `conclusive-product-failure`, and `runPhases` skips every non-final phase
  after it.
- **`candidate-server`** catches `CandidateProductServeError` (`owner: 'product'`, gate
  `verification-every-produced-step-renders`, reached when the build output or `index.html` is
  missing) and emits the same event.
- **`browser-evaluation`** runs `runBrowserEvaluation` (`lib/browser-eval.mjs`) with the AXI driver
  (`lib/axi-browser-driver.mjs`). Each probe opens a fresh `session({ mode, position })`.
  - If the mode it reads afterwards differs from the required mode, `session` throws a plain
    `Error`. The probe loop catches it and records `fail` ("browser evaluation failed: probe state
    could not be established…"). This one path turned a single wrong mode inference into seven
    failed probes in the #67 baseline.
  - `driver.state()` reports `mode` as the declared `data-presentation-mode` or, failing that, a
    visibility guess (`browsing = visible(caption) || visible(toc)`). The same guess is duplicated
    in the `setMode`, `open`, and `toggleMode` page scripts.
  - Captions and titles come from selector lists that mix declared hooks
    (`[data-presentation-caption]`, `[data-presentation-step-title]`, …) with layout fallbacks
    (`figcaption`, `[data-presentation-footer] p`, region `h1`…`strong`).
  - `swipe()` sends only `TouchEvent`s.
  - Probes already have a not-observed outcome (`notObserved` / `notObservedCriterion`), used today
    only for missing scene-entity conventions.
- **`product-judging`** runs `runProductJudging` (`lib/judge-jobs.mjs`).
  - Each judge job is a checkpointed unit (`loadJob`, `startJob`, `saveJob`, `failJob`) that runs
    through `runJudgeJob`: bounded attempts, then a closed-world source audit
    (`buildSourceAuditRequest`, `SOURCE_AUDIT_RESULT_SCHEMA`).
  - Not-observed criteria are appended to their declared fallback job (`fallbackEntriesFor`).
  - The same handler then calls `scoreProduct` (`lib/scorer.mjs`), writes `phases/score.json`, and
    returns `automated-scoring-complete`. Exhausted jobs make it throw `code: 'judge-output'`, which
    becomes a resumable harness failure.
- **Judge calls.** The Codex judge invoker (`lib/judge-invoker.mjs`) accepts any request carrying
  `job`, `schema`, `prompt`, `cwd` (it must be an approved read-only root), and `authority.model`.
  It appends usage to `phases/eval-owned-usage.jsonl`.
- **Rubric.** `automated-rubric.json` (version `6.0.0`) declares fallbacks for only two criteria.
  `lib/rubric.mjs` validates fallbacks, and `lib/traceability.mjs` checks concrete values in
  fallback text.
- **Rescore** (`--rescore-from`) imports a finished run and runs every evaluator phase fresh. Any
  change to browser evaluation, judging, or scoring therefore applies to rescore automatically.
- **Calibration** (`lib/calibration.mjs`) calls `scoreProduct` directly with fixture judges, and
  never passes through the controller's product-judging handler.
- **PR #70** (open) adds `declaredModeSource()` to the driver: it reads `data-presentation-mode`,
  then `data-mode` on the step-count chrome.

## Goals / Non-Goals

**Goals:**
- A probe never records `fail` on a heuristic reading. A guessed mode, title, or caption leads to
  not observed and the existing fallback judge.
- Swipe is tried as touch input and then as pointer input.
- Every owner-decided browser `fail`, and every failed hard gate, gets one checkpointed,
  citation-gated LLM second opinion. This applies in candidate runs and rescore, including terminal
  build and serve failures.
- Raw and second-opinion verdicts are both recorded. Scoring uses the second opinion, and the report
  shows overturns.

**Non-Goals:**
- A browser replay inside the verifier.
- Second-guessing LLM verdicts, other than the inputs of a failed outline gate.
- Changing criteria, owners, points, or thresholds.
- New test suites or CI jobs.
- Re-running the #67 reps, which happens after merge.

## Approach

### 1. Reading basis in the driver (`lib/axi-browser-driver.mjs`)

- **One mode reader.** Replace the duplicated mode inference with one page-side helper,
  `modeReadingSource()`, that returns `{ mode, basis }`:
  - `basis: 'declared'` when the mode comes from `data-presentation-mode`, or from `data-mode` on
    the element carrying or containing `[data-step-count]` (PR #70's rule, reused if PR #70 has
    merged, otherwise ported verbatim);
  - `basis: 'heuristic'` when the mode is the visible-caption-or-table-of-contents guess.

  `open`, `setMode`, `toggleMode`, and `state` all use the helper.
- **New `state()` fields:**
  - `modeBasis`: `'declared'` or `'heuristic'`.
  - `captionBasis` and `titleBasis`: `'declared'` when the first visible match comes from a hook
    selector, `'heuristic'` when it comes from a layout selector, and `'none'` when nothing matched.
    Each selector list is split into a hook part and a fallback part, so the basis is known without
    re-querying.
  - `textPresence`: returned when the caller passes `state({ presenceOf: [texts] })`. This is the
    text-basis record of "the step's full visible text and accessibility tree". It is computed
    in the page against the normative texts the probe supplies, rather than as a bounded dump of
    page text, so nothing has to be truncated. For each supplied text it returns:
    - `visibleElements`: the number of *minimal* visible elements whose normalized rendered text
      (`innerText`, covering text split across descendant spans) contains the text. Minimal means
      no visible descendant also contains it, so ancestors are not double-counted;
    - `accessibleNames`: the number of elements whose resolved accessible name contains the text.
      The name is resolved from `aria-labelledby` (concatenating the referenced elements' text,
      including referenced elements that are hidden, as the ARIA name computation does), then
      `aria-label`, then `alt` and `title`, for elements that are visible or referenced by a
      visible element;
    - `complete`: `true` only when the whole presentation scope was walked. It is `false` when the
      walk exceeds a 20,000-element safety cap, or when any part of the evaluation throws.

    Normalization matches `normalizeText` in `lib/browser-eval.mjs` (Unicode punctuation variants
    and whitespace), and is ported into the page script. `walk()` passes the contract's step titles
    and captions, so every walked state carries `textPresence`.
- **Pointer swipe.** `swipe(direction, { input = 'touch' })` gains `input: 'pointer'`, implemented
  by `pointerSwipeEventSource(type, sign, progress)`. It dispatches `pointerdown`, `SWIPE_MOVES` ×
  `pointermove`, and then `pointerup` as `PointerEvent`s with `pointerType: 'touch'`,
  `isPrimary: true`, one fixed `pointerId`, `bubbles` and `cancelable` set, and the same target
  selection, path, and `swipeFrameWaitSource()` pacing as the touch path. The touch code is
  unchanged.

### 2. Not observed instead of guessed failures (`lib/browser-eval.mjs`)

- **Precondition errors.** `session()` throws `UnobservedPrecondition` (a new class carrying
  `not_observed: true`, `rationale`, and `looked_for`) instead of a plain `Error` when both of these
  hold:
  - the established mode differs from the required mode;
  - `established.modeBasis === 'heuristic'`.

  `looked_for` lists the mode declarations sought. The probe loop's `catch` maps it to
  `notObservedCriterion(id, …)`. A mismatch on a declared mode, or a step-index mismatch, still
  throws the plain `Error` and records `fail`, as today.
- **`decide()` helper.** Probes return their outcome through `decide({ pass, rationale, evidence,
  observations, restsOn })`. `restsOn` lists the readings a `fail` would depend on, each tagged with
  its basis. If `pass` is false and any reading in `restsOn` is heuristic, `decide` returns
  `notObserved(...)`. Otherwise it returns the current tuple. A heuristic reading never blocks a
  `pass`.
- **Text-basis helper.** `textActiveAt(states, position, text)` applies the existing `activeAt` rule
  to `textPresence` (visible elements plus accessible names). If any state it compares has
  `complete: false`, it reports `unknown`, which counts as a heuristic reading, so a fail resting on
  it becomes not observed. Otherwise it reports one of three results:
  - `active`: the text is on more elements at this step than at some other step;
  - `persistent-only`: the text is equally present at every step;
  - `absent`.
- **Per-probe changes.** Readings not listed below are already declared or semantic and stay
  definite.

| Probe | Fail stays definite when | Becomes not observed when |
|---|---|---|
| `demo-nine-step-content-and-order` | step count differs (declared `data-step-count`); a normative title is `absent` or `persistent-only` in both modes by text basis | the title is `active` by text basis but no title selector exposes it |
| `demo-required-scene-content` | in a declared browse mode, the normative caption is `absent` or `persistent-only` by text basis | the caption is present by text basis but not on a caption selector, or the browse mode is heuristic (entity rule unchanged) |
| `quality-captions-and-navigation` | the control count differs from the step count; in a declared browse mode, a step's normative caption is `absent` by text basis | no caption selector matched, the mode is heuristic, or `captionBasis` is heuristic and the normative caption is present elsewhere |
| `demo-present-mode-behavior` | a declared mode is not `present`; in a declared present mode, the active title is `absent` by text basis | the mode is heuristic and not `present`; the title is missing under a heuristic mode |
| `demo-browse-mode-behavior` | inert or incomplete navigation (semantic effect); a declared mode is not `browse`; in a declared browse mode, the caption is `absent` by text basis | the mode is heuristic; `captionVisible` is false while the normative caption is present by text basis |
| `demo-supported-navigation` | a keyboard or jump result lands on the wrong step; a swipe path lands on the wrong step | keyboard and jump are correct, and neither swipe path changed the step |

- **Supported navigation.** `demo-supported-navigation` runs
  `swipe('left', { input: 'touch' })`. Only if the step is unchanged does it reset and run
  `swipe('left', { input: 'pointer' })`, and then the same for `right`. It records
  `observations.swipe = { touch: { left, right }, pointer: { left, right } | null }`.
- **Probe records** carry `reading_basis` (mode, title, and caption basis per session) inside
  `probe_observations`. `PROBE_REQUIREMENTS` and `DETERMINISTIC_BROWSER_CRITERIA` are unchanged.
  The evaluator fingerprint changes, so checkpointed probes are rerun on resume rather than reused.
- **Browser gates.** The raw `verification-sample-outline` gate in `runBrowserEvaluation` becomes
  three-state. It is `pass` when both inputs pass, `fail` only when either input has a definite
  `fail`, and `unobserved()` otherwise; a not-observed input never becomes a raw fail. The other
  browser gates are unchanged. The scorer derives the final outline gate from final verdicts
  (section 5) and keeps this raw gate beside it.

### 3. Rubric (`automated-rubric.json`, `lib/rubric.mjs`)

- **Fallback entries.** Add a `fallbacks` entry with `job: 'demo-integration'` for every one of the
  14 `deterministic-browser` criteria. Each entry has a plain-language `requirement` restating the
  criterion, and `guidance` telling the judge to cite the source that implements the behavior and
  to treat the browser observation as a lead.
- **Traceability.** The text must avoid concrete values, such as attribute names and dimensions, so
  the `lib/traceability.mjs` check passes without new eval-owned declarations. If a value is
  unavoidable, it is declared eval-owned with a reason.
- **Version.** Bump `version` to `7.0.0`. Criteria, owners, points, and thresholds are untouched.
- **Validation.** `validateAutomatedRubric` gains a check that every deterministic-browser
  criterion has a fallback, so a future criterion cannot be not observed without one.

### 4. Second opinion (new `lib/second-opinion.mjs`)

**Targets.** `secondOpinionTargets({ rubrics, deterministic, gates, mode })` returns `[]` when
`mode === 'reference-baseline'`. Otherwise it returns:
- `{ kind: 'criterion', id }` for each deterministic criterion whose owner verdict is `fail`;
- `{ kind: 'gate', id }` for each browser gate with verdict `fail`, other than
  `verification-sample-outline`. In practice that means `verification-every-produced-step-renders`
  and `verification-clear-outcome`; a failed build gate here is included defensively.

`outlineFollowUpTargets({ resolutions, checked })` runs after the first round. It returns
`{ kind: 'criterion', id, on_behalf_of: 'verification-sample-outline' }` for each outline input
whose final verdict is `fail` and that has no second opinion yet.

**Request.** `buildSecondOpinionRequest({ target, rubrics, browser, judging, neutral, authority })`
produces an invoker request:
- `job: 'second-opinion'` and `criteria: [target.id]`;
- `cwd: neutral.root` and `audit_cwd: neutral.audit_root`, with the `demo-integration` read
  permissions (`JUDGE_INPUT_POLICIES`);
- `verified_source_paths` taken from the neutral manifest, exactly as `buildJudgeRequest` computes
  them;
- a prompt containing:
  - the requirement text and its `criterion_sources` quote;
  - the probe record: sessions, bounded `probe_observations`, rationale, evidence, and
    `reading_basis`;
  - for a fallback-failed outline input, the fallback verdict and rationale;
  - the page and console failures recorded for that probe;
  - the overturn rules, worded as in the spec;
  - the neutral source file list.

**Schema.** `SECOND_OPINION_SCHEMA` makes every key required and allows no additional properties,
as Codex structured output needs:

```json
{ "decision": "uphold|overturn", "rationale": "…",
  "mismeasured_step": "…|null", "measurement_fault": "…|null",
  "citations": [{ "path": "…", "start_line": 1, "end_line": 9 }],
  "log_citations": [{ "artifact": "…", "start_line": 1, "end_line": 3 }] }
```

`citations` has at most 12 items. `log_citations` is used only by terminal requests and has at most
6 items.

**Run.** `runSecondOpinion({ request, invoke, attempts = JUDGE_ATTEMPTS })`:
1. Invoke and parse. Malformed JSON, a schema violation, or a missing rationale is a
   `JudgeOutputError` and is retried. If attempts run out, the call returns `{ ok: false }`.
2. On `uphold`: return `{ ok: true, decision: 'uphold', verdict: 'fail' }`.
3. On `overturn`: check the structural conditions first:
   - `mismeasured_step` and `measurement_fault` are non-empty;
   - there is at least one citation;
   - each span is valid: `citationTarget()` (exported from `judge-jobs.mjs`) confirms containment,
     no symbolic link, and a regular file; the path is in `verified_source_paths`; and
     `1 ≤ start ≤ end ≤ lineCount` with `end − start < 200`.

   Any failure gives `{ ok: true, decision: 'overturn-rejected', verdict: 'fail', reason }`. There
   is no retry, because the spec says the fail stands.
4. Audit. `buildSpanAuditRequest` builds a closed-world packet. Every item in it is quoted,
   untrusted data:
   - the cited source line ranges, with line numbers, plus any cited log lines;
   - the immutable failing record: for a criterion, the probe's verdict, rationale, evidence,
     `reading_basis`, and bounded `probe_observations`; for a gate, the gate row; for a terminal
     failure, the failure reason and stage;
   - every page error and console failure recorded for that probe or gate.

   The verifier's `mismeasured_step` and `measurement_fault` are included as the claim under
   audit. The packet is bounded by `MAX_AUDIT_PACKET_CHARS`. The source and log spans are never
   trimmed; the failing record and runtime evidence use the existing bounded summaries. Exceeding
   the bound rejects the overturn. The audit uses `SOURCE_AUDIT_RESULT_SCHEMA` with
   `id = target.id`.
   - The auditor may return `confirmed` only when the cited spans establish that the requirement is
     met, the stated fault matches the recorded failing observation, and every contrary runtime
     observation in the packet is accounted for as a measurement fault. Example: a handler that
     exists in source but was not active during the failed probe must not be confirmed.
   - `confirmed` gives `{ decision: 'overturn', verdict: 'pass' }`.
   - `contradicted` or `insufficient` gives `overturn-rejected` with the audit rationale.
   - There is one audit cycle and no focused re-judging.
   - A malformed audit output is retried within `attempts`; if they run out, the call returns
     `{ ok: false }`.

**Checkpointing.** Each target is one unit in the `product-judging` phase, with unit id
`second-opinion:<kind>:<id>`. Its artifact is `phases/second-opinions/<id>.json`. Its input hash
covers the request prompt, the schema, the rubric version and SHA-256, the probe record's
`output_sha256` (or the gate row), and the audit contract version. The unit reuses the existing
`verifyUnit`, `beginUnit`, `completeUnit`, and `failUnit` calls, using the same
`judgeDependencies`.

### 5. Product-judging integration (`controller.mjs`, `lib/scorer.mjs`)

After `runProductJudging`, the handler:
1. Builds first-round targets and runs them sequentially. Like judge jobs, the calls share one
   authority and rate budget.
2. Calls a new exported scorer helper, `resolveDeterministic({ rubrics, deterministic, judges,
   secondOpinions, mode })`. This is the existing resolution loop extracted from `scoreProduct`.
   It gets the final verdicts, then the handler runs `outlineFollowUpTargets` once.
3. Calls `scoreProduct({ …, secondOpinions, pendingSecondOpinions })`.
   - `secondOpinions` maps an id to `{ raw_verdict: 'fail', verdict, decision, … }`.
   - `pendingSecondOpinions` lists targets whose call failed. The scorer treats them as unresolved
     (component incomplete, gate unobserved), so they are never scored from the raw verdict.
4. Writes `phases/second-opinions.json`, a summary of every target and its outcome.
5. Throws `code: 'judge-output'` when any second-opinion unit failed, after `score.json` is written,
   matching today's `failed_jobs` handling.

Scorer changes (`SCORE_SCHEMA_VERSION` 4 → 5):
- A resolved criterion with a second opinion takes `result.verdict = secondOpinion.verdict`. It
  keeps `source` (`owner` or `fallback`) and adds `second_opinion: { raw_verdict, verdict,
  decision, rationale, mismeasured_step, citations, audit, rejection_reason, on_behalf_of }`.
- `scoreGates` replaces the browser outline row with the derived gate:
  - `pass` when both inputs' final verdicts are `pass`;
  - `fail` when either is `fail`;
  - unobserved when either is unresolved.

  It stores `raw_browser_gate` on the row. Other gates apply their second opinion when present and
  keep `raw_verdict`.
- Score totals gain `second_opinions: { checked, overturned, overturned_points }`.

Calibration and reference-baseline runs pass no `secondOpinions`, so their output is unchanged
apart from the derived outline gate. That gate is identical to the browser gate whenever both
inputs are owner-observed.

### 6. Terminal build and serve failures (`controller.mjs`, `lib/second-opinion.mjs`)

`runTerminalSecondOpinion({ gate, stage, evidenceText, neutral, invoke, … })` runs only when
`mode !== 'reference-baseline'`.

- **Evidence.**
  - For install or build: the full command output. `verified.commands` keeps only a
    4,000-character prefix (`outputOf` in `lib/candidate-verification.mjs`), so
    `candidate-verification` now also persists each install and build attempt's complete stdout and
    stderr to `phases/command-output/<stage>-<attempt>.log`, under `=== stdout ===` and
    `=== stderr ===` headers.
    - Each stream is lossless up to 1 MiB. Beyond that, the first 256 KiB and the last 768 KiB are
      kept, with an explicit `[… N bytes omitted …]` marker, and the attempt records
      `output_truncated: true`. The tail carries the decisive stderr.
    - The existing 4,000-character `log` fields stay as they are, for current consumers.
  - For serve: the `CandidateProductServeError` message and the server stage.

  The evidence is assembled from those artifacts and written to
  `phases/terminal-evidence/<gate>.log`, with its truncation status in the prompt. Log citations name
  that artifact and are validated against its line count. The prompt shows the evidence with line
  numbers. The prompt also lists the neutral source files, so the verifier can cite the declared
  `package.json` scripts and configuration.
- **Acceptance** requires all of these:
  - at least one log citation and at least one source citation;
  - non-empty `measurement_fault`;
  - valid spans;
  - audit `confirmed` on a packet holding both the log lines and the source spans.
- **Handlers.**
  - **`verification`**: when `verified.product_failure` is set, the handler runs the terminal
    second opinion before returning.
    - **Uphold or rejected overturn:** write the outcome into `phases/verification.json` as
      `product_failure.second_opinion` and return `conclusive-product-failure`, as today.
    - **Accepted overturn:** record it, then throw
      `{ owner: 'evaluation-harness', code: 'terminal-failure-overturned', resumable: true }`.
    - **Failed call:** throw `code: 'judge-output'`.
  - **`candidate-server`**: the same flow inside its `owner === 'product'` catch.
- **Missing invoker.** With no `judgeInvoke` configured in a candidate run, both handlers throw
  `code: 'judge-output'` rather than recording an unchecked product failure.
- **Checkpointing.** The terminal unit is checkpointed in its own phase, with unit id
  `second-opinion:terminal:<gate>`. The input hash includes the evidence file's SHA-256, so a
  resumed run that rebuilds and fails differently asks again.
- **Outcome event.** `applyOutcomeEvent`'s `conclusive-product-failure` case copies
  `event.second_opinion` into `product_failure` for the result.

### 7. Result and report (`lib/result.mjs`, `lib/report.mjs`)

- **Result.** `RESULT_SCHEMA_VERSION` goes from 8 to 9. `assembleResult` passes through the
  scorer's criterion and gate `second_opinion` and `raw_browser_gate` fields. It adds a top-level
  `second_opinions` block (`checked`, `overturned`, `overturned_points`, and `entries` with the
  per-target record), and adds `product_failure.second_opinion` for terminal cases. Older results
  without these fields still load and render.
- **Report.** `renderReport` adds:
  - an "Overturned failures" section after the score summary, listing accepted overturns only:
    the id, raw rationale, measurement fault, and spans as `path:start-end`. It shows "No failures
    were overturned" when there were checks but no overturns, and is omitted when nothing was
    checked;
  - in the criterion details, a "second opinion: upheld / overturned / overturn rejected (reason)"
    line;
  - the raw versus derived outline gate in the gates table.

  Everything goes through `escapeHtml`. `ReportConsistencyError` checks that the overturn count
  matches the entries.
- **Usage.** Verifier usage reaches `eval-owned-usage.jsonl` through the existing invoker, so the
  cost code needs no change.

### Data flow

```text
browser-evaluation ──► criteria (pass | fail | not-observed + reading_basis), raw gates
        │
product-judging:  runProductJudging (fallback jobs for not-observed criteria)
        │          ├─ round 1: second opinion for owner-fail criteria and failed renders/clear-outcome gates
        │          ├─ resolveDeterministic ─► outline inputs' final verdicts
        │          ├─ round 2: second opinion for outline inputs failing without one
        │          └─ scoreProduct(secondOpinions, pendingSecondOpinions) ─► derived outline gate, eligibility
verification / candidate-server:  product failure ─► terminal second opinion
        ├─ uphold or rejected overturn ─► conclusive-product-failure
        └─ accepted overturn ─► resumable harness failure
```

## Decisions

- **The verifier runs inside `product-judging`, not in a new phase.** Scoring already happens
  there, and the phase is `alwaysVerify`, with per-unit reuse. A new phase would split the scoring
  event, and older checkpoints would need a migration.
- **The verifier is a dedicated module with its own schema, not a rubric judge job.** A judge job
  answers pass or fail per criterion with path-only citations. The verifier answers uphold or
  overturn per failure with line spans and a different audit question. Reusing `runJudgeJob` would
  need flags everywhere. Only the invoker, `citationTarget`, the audit schema, and the checkpoint
  helpers are shared.
- **A rejected overturn does not trigger a retry.** Only malformed output is retried. This follows
  the spec rule that the fail stands, and stops the verifier from fishing for an accepted citation
  set.
- **One audit cycle, with these limits:** at most 12 spans, each under 200 lines, inside the
  existing audit packet bound. This resolves the spec's deferred limits. Line spans keep packets
  small, so focused re-judging is not needed.
- **An exhausted verifier makes the target unresolved in scoring and fails the phase.** This
  prevents `score.json` from carrying an unchecked fail as if it had been checked, while still
  writing diagnostics.
- **The basis is computed in the driver; the decision is made in the probe.** The driver knows
  which selector matched, and the probe knows which reading a fail rests on. A single `decide()`
  helper keeps that rule in one place.
- **The pointer path runs only after an unchanged touch swipe.** This avoids double-stepping
  candidates that handle both inputs.
- **PR #70.** Port `declaredModeSource()` into `modeReadingSource()` if PR #70 has not merged. If
  it has, wrap it.

## Risks / Trade-offs

- **False passes from verifier overturns.** Mitigations: positive source proof is required, at the
  fallback-pass bar; the closed-world audit sees only the cited spans; runtime evidence must be
  explained; reference-baseline and calibration runs are excluded; and every overturn is listed
  visibly in the report. A browser replay remains a later option.
- **More decisions move to the fallback judge.** More candidate criteria may now be decided by LLM
  source review. The "Verdict source reporting" counts make this visible, and the reference
  regression must still pass every caption and canonical-content criterion through the browser.
- **Cost.** Each failure costs one extra Codex call, plus an audit for each overturn. Runs with
  many failures cost more. All of it is eval-owned and reported.
- **Text-presence completeness.** Presence is computed in the page against the supplied normative
  texts, so there is no bounded dump to truncate. A presentation larger than the 20,000-element
  walk cap, or a page-script error, sets `complete: false`, and absence then gives not observed
  rather than `fail`. The accessible-name resolution is a simplified ARIA name computation (no
  CSS-generated content or role-specific name-from-content rules). Where it misses a name, the
  rendered-text count still sees visible text.
- **Checkpoint churn.** The rubric version, the evaluator fingerprint, and the score and result
  schema versions all change. Runs started before this change cannot be resumed under the new
  code: the existing input-hash checks rerun the affected probes and judge units, and the
  score-affecting input check refuses a mismatched resume. Rescore is the supported path.
- **Merge conflict with PR #70.** It is confined to the driver's mode-reading scripts and
  `test/real-browser/pages/presentation.html`.

## Migration Plan

- No data migration. Older `result.json` files (schema 8) render without second-opinion markings.
  `lib/report.mjs` keeps its optional-field guards.
- After merge, rescore the three reps of agent-evals #67 (claim `cc572181`) with
  `run.sh --rescore-from <run-dir>`.
- Rollback is a revert. Published results are never edited.

## Test Strategy

- **Unit tests** (`node --test test/*.test.mjs`, existing files):
  - `test/browser-eval.test.mjs`:
    - a heuristic mode mismatch in `session` gives not observed, and a declared mismatch gives
      `fail`;
    - `decide()` routing;
    - the text-basis title and caption rules;
    - supported navigation with touch unchanged and pointer moving gives no `fail`;
    - both swipe paths unchanged gives not observed;
    - a wrong step gives `fail`.
  - `test/axi-browser-driver.test.mjs`:
    - `modeReadingSource` declared and heuristic outputs (PR #70 cases);
    - the pointer swipe source emits `PointerEvent` with `pointerType: 'touch'` and frame pacing;
    - `state({ presenceOf })` emits `modeBasis`, `captionBasis`, `titleBasis`, and
      `textPresence`, including nested-span text, hidden `aria-labelledby` names, and
      `complete: false` past the walk cap;
    - the three-state raw outline gate;
    - `candidate-verification` persists full command output past 4,000 characters, with head and
      tail kept and `output_truncated` set past the cap.
  - `test/judge-jobs.test.mjs` or a new `test/second-opinion.test.mjs`:
    - target selection, including reference-baseline exclusion and outline follow-ups;
    - an overturn without citations, with an out-of-inventory path, with an out-of-range line, or
      with an unconfirmed audit is rejected and the fail stands;
    - a confirmed overturn gives `pass`;
    - malformed output is retried and then reported as failed;
    - terminal acceptance requires log citations;
    - the span audit packet contains the failing record, its reading basis, and the recorded
      page and console failures.

    A new test file is allowed: it is in the existing glob, not a new suite.
  - `test/scoring.test.mjs`:
    - second-opinion verdicts drive points and gates;
    - the derived outline gate from fallback and overturned inputs;
    - pending second opinions leave the component incomplete;
    - `raw_browser_gate` and `raw_verdict` are kept.
  - `test/controller.test.mjs` and `test/phases.test.mjs`:
    - terminal uphold gives a conclusive product failure;
    - terminal overturn gives a resumable harness failure;
    - a missing invoker gives `judge-output`;
    - second-opinion units are reused on resume.
  - `test/result-assembly.test.mjs` and `test/report.test.mjs`:
    - raw and second-opinion fields;
    - the "Overturned failures" section;
    - escaping;
    - schema 8 results still render.
  - `test/rubric.test.mjs` and `test/traceability.test.mjs`:
    - every deterministic criterion has a fallback;
    - the version is `7.0.0`;
    - the traceability check passes.
- **Real browser** (`test/real-browser/adversarial.test.mjs`, run manually): add page variants to
  `pages/presentation.html`:
  - pointer-only swipe: `demo-supported-navigation` is not `fail` and records that the pointer path
    moved;
  - no declared mode, with an unhooked footer paragraph in present mode: no title or mode criterion,
    and not the outline gate, is a definite `fail`.

  The pinned reference regression (`lib/reference-browser-regression.mjs`, covered by
  `test/reference-browser-regression.test.mjs`) must still pass every caption and canonical-content
  criterion definitively. `test/real-browser/candidate.test.mjs` runs against a real candidate with
  genuine browser failures, and those must stay definite `fail`s. If one of its expected fails turns
  out to rest on a heuristic reading, change the expectation to not observed, and record that change
  in the PR.
- Run `npm run check` last.
