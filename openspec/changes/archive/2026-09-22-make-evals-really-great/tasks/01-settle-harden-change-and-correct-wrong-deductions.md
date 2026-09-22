# Task: Settle the in-flight change and correct the known wrong deductions

## Goal

Archive the unarchived OpenSpec change `2026-09-20-harden-deterministic-browser-judging` with its
inverted scenario bodies corrected, then fix the three evaluator and rubric errors that deduct
points from spec-conforming candidates: the inverted control-keys check, the wrong canvas size in
rubric guidance, and the closed list of scene-object attribute names. The automated rubric becomes
5.0.0 here, because this is where scoring behavior first changes.

## Background

The `and-scene` suite lives in `evals/agent-runner/and-scene/` (all code paths below are relative
to it unless they start with `openspec/` or `test/`). A candidate is scored in ordered phases
(`lib/phases.mjs`): `browser-evaluation` runs 14 deterministic criteria through
`runBrowserEvaluation` (`lib/browser-eval.mjs`) over `createAxiBrowserDriver`
(`lib/axi-browser-driver.mjs`, which drives Chrome through `chrome-devtools-axi`);
`product-judging` runs six LLM judge jobs; `pending-result` assembles `result.json`.

An audit of three Fly.io factory repetitions (issue #26) and the six published runs found these
wrong deductions:

- **Control keys are inverted.** The pinned fixture scenario "Controls keep their keys" says that
  while focus is on an interactive control, navigation keys drive that control *rather than* also
  advancing the deck. The probe `demo-navigation-boundaries-and-control-keys` activates a control
  (which since commit `cc2a18e` focuses it and then clicks it) and then requires the deck to
  advance on a key press. It deducts from every candidate that follows the fixture.
- **Wrong canvas size.** `scene-fixed-canvas` guidance in `automated-rubric.json` says 880×495.
  The fixture spec, design, tasks, and test plan all say 880×380.
- **Closed attribute list.** The driver's page script finds scene objects only through
  `data-layout-id`, `data-scene-entity`, and `data-node` under `STAGE_SELECTOR` (with synthetic ids
  for `data-presentation-*` hooks). A real candidate used `data-entity-id` and `data-scene-node`,
  zero objects were found, and two criteria failed on a correct scene.

Work on one feature branch cut from `dev` (PR base `dev`). Commit in the order below; each commit
must leave `npm run check` green. Commit messages are `type: lowercase description`.

### Step 1: settle the in-flight change (first commit)

Edit
`openspec/changes/2026-09-20-harden-deterministic-browser-judging/specs/product-quality-scoring/spec.md`.
**Every `#### Scenario:` header must stay byte-identical**; renaming one makes `openspec archive`
abort with no recovery path. Change bodies only:

- Scenario "A control is activated the way a pointer activates it": keep the focus-before-fire
  THEN line; replace the AND line so it says a presentation that ignores deck keys while that
  control holds focus is observed **and is not deducted for it**.
- Scenario "Controls exist only in browse mode": keep the first THEN; replace the AND line so it
  says the check moves focus off the control before requiring a deck key to advance.
- Leave the activation sentence in the requirement paragraph as it is; it is neutral.
- In the MODIFIED "Official product score" requirement, replace "Automated criteria SHALL use
  binary pass/fail verdicts." with "Automated criteria SHALL award points only from binary
  pass/fail verdicts. A deterministic evaluator MAY report a criterion as not observed; that
  criterion is unresolved until a declared fallback judge supplies a pass/fail verdict."
- In the scenario "Deterministic demo behavior is scored", change "their pass/fail results" to
  "their resolved pass/fail results".

Then run `openspec archive 2026-09-20-harden-deterministic-browser-judging` and commit the result.
Do not edit any file under `openspec/changes/make-evals-really-great/`.

### Step 2: control-keys probe

In `lib/browser-eval.mjs`, probe `demo-navigation-boundaries-and-control-keys`, keep the clamp half
unchanged and replace the key half:

1. Establish the mode that exposes controls (unchanged) and `activate(controls[0].name)`.
   `activate()` keeps focusing then clicking, because that is what a real activation does.
2. Press `ArrowRight` while the control holds focus. Record `before → after` in the observation as
   `keys_while_control_focused`. It never affects the verdict in either direction; pass-through
   from a focused button is left to the scene-kit criterion `navigation-controls-keep-keys`.
3. Call a new driver primitive `releaseFocus()` in `lib/axi-browser-driver.mjs`, written as an
   interpolated page script like the other build-independent primitives added in `cc2a18e`. It
   focuses the presentation root (the `PRESENTATION_SELECTOR` element), adding `tabindex="-1"`
   only when the root is not already focusable. A companion `restoreFocusTarget()` removes that
   temporary `tabindex` after the key press, so no candidate DOM change outlives the probe. Focus
   goes to the presentation root, not `body`, so a key listener on the root and one on `document`
   both receive the event. `releaseFocus()` returns whether `document.activeElement` is now a
   non-interactive element (not `a`, `button`, `input`, `select`, `textarea`, `summary`, or an
   element with an interactive ARIA role). When it is not, the probe raises a resumable
   `HarnessFailure` instead of recording a verdict.
4. Press a deck key and require a one-step move: `ArrowRight`, or `ArrowLeft` when the deck is
   already on its last step. Record as `keys_after_focus_released`.

`ok = clampsHold && keysAfterFocusReleased`.

### Step 3: canvas size, scene-object conventions, rubric version

- `scene-fixed-canvas` guidance in `automated-rubric.json` becomes 880×380. This is the only
  guidance text that changes. Criteria, point allocations, floors, hard gates, and owners do not
  change.
- Add `[data-entity-id]` and `[data-scene-node]` to the driver's scene-object selector list and
  explicit-id lookup. The driver's state gains `entityConventions`: the list of selectors it
  looked for. Do not add any generic DOM heuristic for discovering scene objects.
- `automated-rubric.json` → version `5.0.0` in the first commit that changes scoring behavior.
  The corrected control-keys probe (Step 2) is a scoring-behavior change, so it must not be
  committed while the rubric still says 4.0.0: land the probe change, the 880×380 guidance
  correction, the 5.0.0 bump, and the sha/version pin updates in the same commit (the
  scene-object convention change may share it or follow it). Every commit on the branch must be
  truthfully versioned, and there is a single version bump. Update
  `test/rubric.test.mjs`, calibration fixtures, and any test or document that pins the rubric
  version or sha256 (the 4.0.0 sha was
  `bc6db3280931bf8753e3c5c3bcff17b980457053b4f5d2ee39cda28ad6c7ce37`). Published records under
  `results/**` keep their original rubric provenance and must not be touched by this task.

### Constraints

- Test-driven: write a failing test in `test/browser-eval.test.mjs`,
  `test/axi-browser-driver.test.mjs`, or `test/rubric.test.mjs` first, then the fix, then targeted
  tests, then `npm run check`.
- No third-party runtime dependencies, no shared framework outside the suite.
- Never hand-edit `evals/agent-runner/and-scene/results/**`; no test may write there.
- Add every new `.mjs` entry point or library module to the `node --check` list in the `check`
  script of `package.json`, as existing modules are.
- Restoring the five published records that carry the `16401c1` deduction is **not** part of this
  task; it requires the user's approval of each record.

## Spec

From `openspec/changes/make-evals-really-great/specs/product-quality-scoring/spec.md`:

### Requirement: Focused controls keep their keys
The deterministic control-key check SHALL follow the pinned fixture scenario "Controls keep their keys": while focus is on an interactive control, navigation keys drive that control rather than also advancing the deck. After activating a navigation control the way a pointer does, the check SHALL NOT require a deck navigation key pressed while that control still holds focus to advance the deck, and SHALL NOT deduct when the deck stays on its step. The check SHALL deduct when it holds positive evidence of a violation: the deck fails to clamp at its first or last step, or deck navigation keys do not advance the deck once focus rests on a non-interactive part of the presentation itself. The check SHALL keep focus inside the presentation when it releases a control, so that a presentation which listens for keys on its own root is not failed, and SHALL verify that focus is no longer on an interactive control. When it cannot establish that state, it SHALL raise a resumable harness failure rather than record a product deduction.

The check SHALL continue to establish whichever mode exposes a navigation control rather than skip itself, and SHALL continue to activate a control by focusing it before firing.

#### Scenario: The deck ignores a deck key while a control holds focus
- **WHEN** the check activates a navigation control and presses a deck navigation key while that control still holds focus, and the deck stays on its step
- **THEN** `demo-navigation-boundaries-and-control-keys` is not deducted for that observation

#### Scenario: Deck keys stop working after a control was used
- **WHEN** the check activates a navigation control, moves focus to a non-interactive part of the presentation, and presses a deck navigation key, and the deck does not advance
- **THEN** `demo-navigation-boundaries-and-control-keys` is recorded as `fail`

#### Scenario: The presentation listens for keys on its own root
- **WHEN** a presentation handles deck keys only while focus is inside its root, and the check releases a control
- **THEN** focus rests inside the presentation and the deck key advances the deck
- **AND** the criterion is not deducted

#### Scenario: Focus cannot be released from a control
- **WHEN** the check cannot move focus off the interactive control
- **THEN** it raises a resumable harness failure
- **AND** no criterion is deducted

#### Scenario: The deck does not clamp at a boundary
- **WHEN** a deck navigation key pressed on the last step moves the deck off the last step
- **THEN** `demo-navigation-boundaries-and-control-keys` is recorded as `fail`

#### Scenario: A control passes arrow keys through to the deck
- **WHEN** a presentation lets a deck navigation key advance the deck even while a button holds focus
- **THEN** the check records the observation and does not deduct for it
- **AND** whether that pass-through conforms is left to the scene-kit criterion `navigation-controls-keep-keys`


## Test Plan

- **INT-007 (pages a, b, d, e, f): real-browser driver behavior on adversarial pages.** Create
  small static presentations under `test/real-browser/pages/` and a runner
  `test/real-browser/adversarial.test.mjs` that serves each on a local port and runs the
  production evaluator (`createAxiBrowserDriver` + `runBrowserEvaluation`) over real
  `chrome-devtools-axi` and Chrome. The file sits outside the `test/*.test.mjs` glob so CI does
  not run it; run it locally before the control-keys commit is finalized. Pages and assertions:
  - (a) conforming, ignores deck keys while a button holds focus → passes
    `demo-navigation-boundaries-and-control-keys`; the observation records
    `keys_while_control_focused` with no move and `keys_after_focus_released` with a one-step move.
  - (b) deck keys stay dead after any control use even once focus returns to the body → fails
    that criterion.
  - (d) active step title hidden in present mode → fails `demo-present-mode-behavior` and is not
    recorded as not observed.
  - (e) conforming, deck-key listener attached to the presentation root only → passes the
    criterion, and the page's DOM carries no leftover `tabindex` after the probe.
  - (f) a page that forces focus back onto its control so focus cannot be released → raises a
    resumable harness failure and records no verdict.
  Structure the runner so a further page (a correct scene with no recognised scene-object hook)
  can be added later without reshaping it.

## Done When

- The harden change is archived under `openspec/changes/archive/` with the corrected bodies,
  unchanged scenario headers, and the amended "Official product score" sentence present in
  `openspec/specs/product-quality-scoring/spec.md`.
- Every scenario of "Focused controls keep their keys" is covered by a passing unit test with a
  fake driver, including the pass-through observation that never affects the verdict and the
  harness failure when focus cannot be released.
- A driver test shows `[data-entity-id]` and `[data-scene-node]` objects are recognised and that
  state carries `entityConventions`.
- `automated-rubric.json` is 5.0.0, states 880×380, and all version/sha pins in tests,
  calibration fixtures, and the suite `README.md` are updated.
- INT-007 pages (a), (b), (d), (e), (f) pass locally against real Chrome; state in the final
  report whether they were run and their result.
- `npm run check` passes. Nothing under `results/` changed.
