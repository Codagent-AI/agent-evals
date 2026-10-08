# Class A coverage audit

**Shipped as 14.0.0 (2026-10-07).** The eval-the-whole-workflow change (PR #83) lands first with its own rubric 13.0.0, so this change ships as automated rubric 14.0.0 on top of #83's 13.0.0 content. Its engineering-quality job runs through #83's cross-family panel (`cross-family-panel-v1`). The text below is left as written; where it says 13.0.0 for this change's rubric, read 14.0.0.

This audit checks each item in agent-evals#77's "Already required by the spec (class A)" section against automated rubric 12.4.0 (`evals/agent-runner/and-scene/automated-rubric.json`). It also checks item 2a, item 3's drift clause, item 4's verify clause, item 5, and item 7's narrow-viewport clause.

**Outcome (2026-10-06).** The maintainer adopted P5, P6 and P7; they are applied as `review_guidance` lines in automated rubric 13.0.0. P1, P2, P3 and P4 are not adopted in this change and are deferred follow-ups (see "Deferred proposals"). The open gaps stay open, except B7.

**B7 (2026-10-07).** After review, Paul decided to adopt the optional B7 guidance (Chromium installation) for consistency with P5–P7. It is applied in automated rubric 13.0.0.

Each item gets one of three dispositions:

- **(a) Covered**: the criterion or criteria that cover it, with the guidance that does so.
- **(b) Proposed guidance**: exact text to append to an existing subcomponent's `review_guidance`. Each proposal's status (adopted or deferred) is stated with it.
- **(c) Open gap**: the item is not covered, and no guidance is proposed.

Fixture citations are to the and-scene fixture at `f0695b96c0c23b2d17ecc6cfbaf8be1fcdedd6f8`:

- "spec" means `openspec/changes/create-and-scene/specs/…` and "design" means `design.md`. Both are in `evals/agent-runner/and-scene/fixture-snapshot/`.
- The task files `tasks/0N-*.md` and the root `AGENTS.md` are not in the snapshot. They were read from the fixture repository at the same commit.

Proposed guidance only restates or applies text the fixture already contains, and each proposal cites that text.

## Summary

| # | Item | Disposition | Criterion |
|---|---|---|---|
| A1 | Grouped steps remount | (a) | `grouped-scene-updates-in-place`, `grouped-continuing-entities-not-newcomers` |
| A2 | `AnimatePresence mode="wait"` kills shared `layoutId` morphs | **(b) P1**, deferred | `entity-persisting-morph` |
| A3 | Sync-mode wrappers stack vertically | **(b) P1**, deferred | `entity-persisting-morph` |
| A4 | Newcomer delay not applied, including to opacity | (a) | `entity-newcomer-after-settle` |
| A5 | Exiting scene stays `isActive` | (c) | none |
| A6 | Fit uses window offsets, overflows, or has a negative or zero scale | (a); extreme viewports deliberately excluded | `canvas-uniform-scaling` |
| A7 | TOC active state lost within an era | **(b) P2**, deferred | `navigation-active-state` |
| A8 | Arrow endpoints snap; Arrow `direction` ignored | endpoints **(b) P3**, deferred; `direction` (a) | `entity-persisting-morph`; `demo-clear-code-boundaries` |
| A9 | SceneLayer keys change with position; nested keys collide | (a), optional clarification **P4**, deferred | `grouped-continuing-entities-not-newcomers`, `grouped-scene-updates-in-place` |
| A10 | Optional payloads crash a typed Scene | (c) | none (plain-bug policy) |
| B1 | Missing departing exits or newcomer timing | (a) | `entity-departing-exit`, `entity-newcomer-after-settle` |
| B2 | No scene-continuity tests | (a) to the extent the fixture requires | scene-entity-transitions guidance, testing evidence |
| B3 | No router module or test | (a) behaviour; (c) minor: unit test not scored | `demo-route-and-registration`, `skill-new-presentation-routed` |
| B4 | Missing E2E-001; incomplete E2E-002 fault cases | (a) | hard gates, `verification-*-fails`, new `engineering-preview-terminated-on-every-exit` |
| B5 | Bootstrap verify doesn't step through | (a): the fixture requires only a first-step render here | `skill-checks-run-before-done`, new `engineering-bootstrap-scripts-generic` |
| B6 | No narrow viewport | **(b) P5**, adopted | `skill-checks-run-before-done` |
| B7 | Chromium install missing | **(b)**, adopted by Paul's decision after review | `skill-empty-directory-scaffold` |
| 2a | Keys hijacked on focused controls (Space, contenteditable) | (a); contenteditable deliberately excluded | `navigation-controls-keep-keys` |
| 3 (drift) | Bootstrap copy drifted from root copy | kit **(b) P6**, adopted; scripts (c) | `skill-empty-directory-scaffold` |
| 4 (verify) | Verify passes on missing, zero, or NaN step hooks; non-advancing step | (a) for the non-advancing test, **(b) P7**, adopted, for hook coercion | `verification-step-error-fails` |
| 5 | Templates build at their documented destination | (a) | new `engineering-templates-build-at-destination`; `skill-empty-directory-scaffold` for the bootstrap |
| 7 (narrow) | Narrow-viewport overflow | (a) canvas fit, human review for chrome; process side **P5** | `canvas-uniform-scaling`, human rubric |

## Scene-kit motion and fit

### A1. Grouped steps remount instead of updating in place: (a) covered

- `grouped-scene-updates-in-place`. Fixture quote: "navigating between those steps updates the existing scene instance with the new step state rather than remounting separate scenes". `scene-entity-transitions` guidance: "Require departing and grouped-scene behavior to be exercised by implementation or focused tests, not inferred only from component names."
- `grouped-continuing-entities-not-newcomers`, guidance: "credit an explicit implementation showing that the grouped scene and continuing child state remain mounted across updates and do not replay newcomer state."
- `demo-stable-identity-and-grouping` (demo side), guidance: "For the delivered grouped-scene path, prove grouping by tracing each step's groupKey through Stage".

### A2 and A3. `mode="wait"` kills `layoutId` morphs; sync-mode wrappers stack: (b) P1

Both concern the kit's path for consecutive steps that do not share a scene group. `entity-persisting-morph` is the right criterion, because the fixture scenario applies to any two consecutive steps, grouped or not. Its current guidance credits "an implemented persisting layout-animation mechanism combined with stable entity identity", which a judge can satisfy from `layoutId` alone. In that case neither defect is caught.

**P1 (deferred, not applied).** Proposed for `scene-entity-transitions.review_guidance`:

> For entity-persisting-morph, also judge the scene kit's transition path for consecutive steps that do not share a scene group. The fixture design has that path cross-fade the outgoing and incoming scenes while shared layoutId elements morph, inside a fixed canvas where mounting one layer never reflows another. Fail when that path cannot morph a shared entity because the host finishes unmounting the outgoing scene before mounting the incoming one (for example AnimatePresence mode="wait"). Also fail when the coexisting outgoing and incoming scene wrappers sit in normal document flow, so the incoming scene is displaced (for example stacked below the outgoing one) until the exit completes. Cite the stage's ungrouped branch. Steps that share a scene group are judged under grouped-scene-updates-in-place, not here.

Fixture support:
- design, "Scene kit": "Steps that share a `groupKey` … are not remounted … otherwise `AnimatePresence` cross-fades and shared `layoutId` elements morph."
- design, "Generic node primitives": "`SceneLayer` absolutely positions a step's diagram so mounting one layer never reflows another."
- spec, "Fixed-canvas fit scaling": "composed in a fixed design canvas … so the composition does not reflow and entity morphs stay clean".
- spec, "Persisting entity morphs": "WHEN an entity with the same identity exists in two consecutive steps THEN navigating between them animates that entity … to its new state in place".

Notes:
- **Narrows existing guidance.** P1 narrows G6 ("an implemented persisting layout-animation mechanism … is technical proof").
- **Code the demo may not run.** The canonical sample correctly shares one `groupKey` across all nine steps (G4), so this judges kit code the demo may never exercise. It is still kit behaviour the fixture specifies.
- **Evidence.** Seen in 3938f16c-2, d249aaa4-3 and d7f384ba-3 (wait), and in 0f35011d-1, ed89e53e-2 and d7f384ba-1 (stacking).
- **Possible score drop.** Expect lower `entity-persisting-morph` pass rates; consider calibration before adopting.

### A4. Newcomer delay not applied, including to opacity: (a) covered

`entity-newcomer-after-settle`:
- G1: "Fail … when newcomers have no entry motion at all. Cite the delay value, the layout duration, and the elements each one is applied to."
- G2: "Judge the visible entry, not each wrapper … (for example an outer Appear with delay 0 around a Box whose opacity starts at 0 and is delayed by the entry delay)."
- G5: "inspect the exact continuing-entity motion path and newcomer entry path".

The ed89e53e-2 defect, a delay placed in `initial` so that the opacity fades with the layout transition, is a visible entry that starts before settle, and G2 and G5 catch it.

### A5. Exiting scene stays `isActive`: (c) open gap, no proposal

The fixture never defines an active-scene signal for scenes. `isActive` is a candidate-invented prop. The defect matters only when a scene renders active-only content during its exit, which would then show as a departing-exit or morph problem under the existing criteria. Adding guidance would introduce a requirement the fixture does not state. The item was seen in 3938f16c-2 and 3938f16c-3.

### A6. Fit uses window offsets, overflows, or has a negative or zero scale: (a) covered; extreme viewports deliberately excluded

`canvas-uniform-scaling`, G1: "Fail only when, at a reference viewport, the computed scale places the canvas outside the area the stage actually occupies, for example because the fit is computed from the window instead of that area or reserves less space than the rendered chrome takes". This covers the window-offset, stage-mis-centring (d7f384ba-2) and overflow variants at 1280×720 and 390×844.

A negative or zero scale in a short viewport (1d0dbdaf-1) is deliberately out of scope under G0: "Do not require a particular rendering at an extreme viewport: an unreadably small viewport is not a presentation viewport". It is not a gap.

### A7. TOC active state lost within an era: (b) P2

`navigation-active-state` is the criterion. Its guidance ("Equivalent semantic current-state attributes and stable active hooks satisfy the active-state contract") does not say which TOC entry represents a step that is not the first step of its era.

**P2 (deferred, not applied).** Proposed for `scene-modes-and-navigation.review_guidance`:

> For navigation-active-state, the fixture's table of contents is era-based: a table-of-contents entry stands for its section's era, and activating it jumps to the first step of that era. Such an entry therefore represents the active step whenever the active step belongs to its era. Fail when an entry's semantic current state or stable active hook appears only on its era's first step, or is lost on a later step of the same era. A progress indicator represents only its own step.

Fixture support:
- spec, "Direct jump": "or to the first step of that section's era for a table-of-contents entry".
- spec, "Active navigation state is exposed": "WHEN a progress indicator or table-of-contents entry represents the active step THEN it exposes semantic current-step state and a stable active-state hook".
- design, repository layout: "`Toc.tsx` # era-based table of contents".

Seen in d7f384ba-2 and cc572181-3.

Before adopting P2, check that the deterministic `demo-control-semantics` probe, which requires exactly one current control per step, does not count TOC entries alongside progress controls. Otherwise the correct behaviour P2 asks for could fail that probe.

### A8. Arrow endpoints snap instead of morphing; Arrow `direction` ignored

**Endpoints: (b) P3 (deferred, not applied).** Proposed for `scene-entity-transitions.review_guidance`:

> For entity-persisting-morph, the persisting-morph requirement covers every kit primitive the delivered presentation uses for a persisting entity, including connectors. When a connector such as an Arrow keeps its identity across consecutive steps but its endpoints change, it must animate from its old geometry to its new one. Fail when the kit's connector jumps to its new endpoints, for example because its path is recomputed with no transition while only boxes use layout animation. Cite the connector's rendering path.

Fixture support:
- spec, "Stable entities morph across steps": "Entities that persist between steps SHALL keep a stable identity and animate their change in place rather than disappearing and reappearing".
- scenario: "animates that entity from its old state (position, size, label, emphasis) to its new state in place".
- design, Decision 2: "ship `Box/Label/Arrow/Frame/Emphasis/SymbolChip` parameterized by stable identity".

Seen in 3938f16c-1. This also narrows G6, so the calibration note under P1 applies here too.

**`direction` ignored: (a) covered** by `demo-clear-code-boundaries`. Its G1 reads: "Confirm that public API inputs and shared constants consumed by the delivered demo are actually used. Score a dead or misleading contract under demo-clear-code-boundaries exactly once, even when its declaration lives in shared scene-kit source". This catches an ignored `direction` prop when the demo passes it. The fixture's step 2 also requires "a two-way arrow connects you↔skill", which `demo-required-scene-content` checks from the browser.

### A9. SceneLayer keys change with position; nested keys collide: (a) covered, optional clarification P4

`grouped-continuing-entities-not-newcomers`, G8: "the grouped scene and continuing child state remain mounted across updates". `grouped-scene-updates-in-place`: "rather than remounting separate scenes". A layer keyed by its position remounts when the position changes, so it fails both.

**P4 (optional, low priority; deferred, not applied).** Proposed for `scene-entity-transitions.review_guidance`:

> For grouped-continuing-entities-not-newcomers and grouped-scene-updates-in-place, a scene layer or entity element whose React key is derived from its position, array index, or render order, rather than its stable identity, remounts when that position changes. That is not remaining mounted.

Fixture support: spec, "Scene step model": "Each step SHALL have a stable identity"; spec, "Stable entities morph": "keep a stable identity … rather than disappearing and reappearing".

Seen in 1d0dbdaf-2 and ed89e53e-1. It was re-flagged twice as a regression from earlier fixes.

### A10. Optional payloads crash a typed Scene: (c) open gap, no proposal

`scene-typed-payload-boundary` covers typed payloads reaching `<Presentation>` without casts, not runtime robustness. A crash the delivered demo actually hits is caught by `demo-step-and-transition-reliability` and the `verification-every-produced-step-renders` gate. A latent crash for some other author's optional payload is a plain bug, which falls under the issue's item 12 policy ("score where they break specified behaviour"). Seen in ed89e53e-1.

## Task-compliance findings

### B1. Missing departing exits or newcomer timing: (a) covered

- `entity-departing-exit`, G4: "an opt-in wrapper alone is insufficient when plain conditional removal still disappears synchronously. Require the scene-kit boundary to preserve departing entities".
- `entity-newcomer-after-settle`, G0–G2 and G5: see A4.

### B2. No scene-continuity tests: (a) covered as far as the fixture requires

- `scene-entity-transitions` guidance: "Require departing and grouped-scene behavior to be exercised by implementation or focused tests".
- The fixture places continuity coverage in agent acceptance (test-plan AT-003: "grouped scenes update without whole-scene replacement, persisting entities morph in place, newcomers enter after continuing motion"). It says of unit tests that "this plan does not inventory those tests".
- The acceptance record is judged by `testing-evidence-traceable-coverage`.

### B3. No router module or test: (a) behaviour covered; (c) minor gap for the unit test

- Routing behaviour is covered by:
  - `demo-route-and-registration` (browser): "registered and reachable like any other presentation";
  - `skill-new-presentation-routed`: "reachable at its own route, and registered in the presentation index".
- A missing router or registry unit test is not scored. The test plan says "Focused tests should cover isolated … registry … logic" but does not inventory those tests.
- Not recommended for a criterion: no recurring product defect follows from it.

### B4. Missing E2E-001; incomplete E2E-002 fault cases: (a) covered

- **E2E-001.** The production verification journey is enforced by the four hard gates, which run the real build and sample: `verification-build-whole-app`, `verification-sample-outline`, `verification-every-produced-step-renders` and `verification-clear-outcome`.
- **E2E-002 fault cases.** Each case maps to a criterion:
  - missing or out-of-order sample: `verification-missing-sample-fails` ("A non-zero exit whose output names the build or sample phase satisfies the criterion … A dedicated missing-sample regression test is not required when that check is explicit");
  - browser error: `verification-console-page-error-fails` ("Executable evidence needs one representative browser-error test … that asserts a non-zero exit and the offending step");
  - non-advancing transition: `verification-step-error-fails` ("require a test of a step that fails to render or advance that asserts a non-zero exit and the offending step");
  - "preview subprocesses are cleaned up after each run": this change's `engineering-preview-terminated-on-every-exit`.
- A build-break fault test is not separately scored, but the build gate checks real build behaviour.

### B5. Bootstrap verify doesn't step through: (a) covered; nothing more is fixture-required

- The skill spec requires "at least a first-step render check" (`skill-checks-run-before-done`). The fixture says "the full multi-step render check across every step is defined by the `presentation-verification` capability", whose subject is the committed reference sample.
- INT-001 requires only that the materialized bootstrap's "build and route smoke check pass".
- The genericness of the bootstrap scripts is covered by this change's `engineering-bootstrap-scripts-generic`.

### B6. No narrow viewport: (b) P5

The task-compliance finding (d249aaa4-3) was that the screenshot helper had no narrow viewport. The fixture defines the helper at "a standard desktop viewport", so the helper is not the gap. The fixture's narrow-viewport requirement is on the skill's self-verification, which `skill-checks-run-before-done` judges. Its guidance currently credits "explicit instructions that require build, render, and browser composition checks before success" without the viewport clause.

**P5 (adopted; applied in rubric 13.0.0).** Appended to `skill-self-verification.review_guidance`:

> For skill-checks-run-before-done, the fixture's self-verify requirement says that the visual composition check inspects the first step, the last step, and any dense or key steps, and that responsive-sensitive presentations are also checked at a narrow viewport. Fail when the instructions' visual composition check never directs a narrow-viewport check for a responsive-sensitive presentation. The project-local screenshot helper need not capture the narrow viewport, because the fixture defines it at a standard desktop viewport; any browser view satisfies the narrow check.

Fixture support:
- spec, "Self-verify before reporting completion": "The visual composition check SHALL inspect screenshots or an equivalent browser view of the first step, the last step, and any dense/key steps; responsive-sensitive presentations SHALL also be checked at a narrow viewport."
- fixture `AGENTS.md`: "also inspect a narrow viewport when the presentation is responsive-sensitive".

### B7. Chromium install missing: (b) adopted by Paul's decision after review

The fixture does support it:
- spec, "Self-bootstrapping scaffold": "It SHALL install the runtime and build dependencies needed for … render verification";
- design, Risks: "Playwright browser in Docker/CI → Install Chromium in the verify step".

This change's design had deliberately dropped "browser installation in tests" from the engineering criteria, so the audit first recorded B7 as an open gap with optional text for Paul's decision. After review, Paul adopted it, for consistency with adopting the P5–P7 guidance, which restates fixture requirements in the same way. The design records the reversal. Applied in rubric 13.0.0, appended to `skill-scaffolding.review_guidance`, with both fixture passages added to the criterion's sources:

> For skill-empty-directory-scaffold, the dependencies needed for render verification include the Playwright Chromium browser, which the fixture design installs in the verify step. Credit SKILL.md, the bootstrap scripts, or the verify step when they install Chromium or check that it is available before the render check. Fail when none of them installs it or checks for it.

The adopted text also credits the verify step, because the fixture design places the installation there.

## Additional items

### Item 2a. Keys hijacked on focused controls: (a) covered; contenteditable deliberately excluded

`navigation-controls-keep-keys`, G6:

> presentation navigation must not intercept the step-navigation keys (Right, Space, PageDown, Left, PageUp) while focus is on an interactive control … Judge the interactive controls the delivered presentation renders and any native interactive element the guard covers (buttons, links, form fields); do not fail the criterion for a hypothetical control type, such as an ARIA slider, that the delivered presentation never renders.

- **Space on a focused button** is covered explicitly: Space is listed and buttons are rendered.
- **contenteditable** detection is excluded by the "controls the presentation renders" rule, because the delivered presentation renders no contenteditable element. This follows the rubric's recent choice to judge rendered controls.
- **Item 2b's harmful push** is already guarded: "Do not interpret this criterion as requiring global presentation navigation to run from a focused control."
- **The browser probe.** The `demo-navigation-boundaries-and-control-keys` probe observes focused-control keys but does not score them ("judged from source by `navigation-controls-keep-keys`").

### Item 3, drift clause. Bootstrap copy drifted from the root copy

**Scene kit drift: (b) P6.** No criterion checks canonical and template kit parity. `skill-empty-directory-scaffold` already cites INT-001 for the materialize-and-build test, so it is the natural home.

**P6 (adopted; applied in rubric 13.0.0).** Appended to `skill-scaffolding.review_guidance`:

> For skill-empty-directory-scaffold, the scene kit in the bootstrap template is a snapshot of the canonical src/presentation-kit/, which the fixture requires to stay aligned with it. Fail when a non-test scene-kit file in the bootstrap template differs in behavior or public types from its canonical counterpart. Cite both files. Formatting-only differences do not fail.

Fixture support:
- design, Decision 5: "the skill's `templates/` is a snapshot used only to bootstrap a fresh/empty project", and Risks: "Treat `templates/` as a release snapshot of the kit … Keep the snapshot in sync when the kit changes";
- test-plan INT-001: "canonical and template kit files remain aligned";
- `tasks/02-presentation-skill.md`: "checking canonical/template kit parity";
- fixture `AGENTS.md`: "Keep `src/presentation-kit/` byte-aligned with its bootstrap-template copy."

**Verify and inspect script drift: (c) open gap, no proposal.** The only fixture source is `AGENTS.md`: "Keep root verification and inspection scripts aligned with their bootstrap template copies when changing scaffolded behavior". That file is not in the fixture snapshot or the planning documents. More importantly, the copies must legitimately differ: this change's `engineering-bootstrap-scripts-generic` fails a bootstrap script that contains the reference sample's titles, captions or routes, which belong only in the root `scripts/verify.mjs`. "Aligned" therefore cannot be judged as parity, and a mechanics-only parity rule would be vague. The generic-scripts criterion already covers the practical failure, a bootstrap copy that doesn't work for other presentations.

### Item 4, verify clause. Verify fails loudly on step hooks: (a) covered, plus (b) P7

**Non-advancing step: (a) covered.** `verification-step-error-fails`, G4: "require a test of a step that fails to render or advance that asserts a non-zero exit and the offending step". This matches E2E-002 ("a transition that does not advance the public step index … exits non-zero"). This change's design keeps it there ("Verify detecting a non-advancing step stays where it is").

**Hook coercion: (b) P7.** A NaN step count passing verify (ed89e53e-2), or a missing `data-step-index` read as `Number(null) === 0` (bcf2554b-1), can still pass the focused non-advancing test. No guidance addresses it.

**P7 (adopted; applied in rubric 13.0.0).** Appended to `verification-addressing-and-errors.review_guidance`:

> For verification-step-error-fails, the verifier must not treat a missing, zero, or non-numeric data-step-count or data-step-index as progress. Fail when the transition check converts an absent or non-numeric hook into a number that still satisfies its comparison (for example Number(null) === 0 on the first step). Also fail when an unreadable step count makes the verifier step through no steps and still pass. Cite the comparison. The inspect helper's handling of the same hooks is scored by engineering-inspect-fails-loudly, not here.

Fixture support:
- design, Verification: "The driver reads the step count from a `data-step-count` hook on the chrome, then steps through every step (`ArrowRight`), checking the `data-step-index` advances", and "a failed step transition fails verification and reports the failing step index";
- test-plan E2E-001: "each of the nine step indices is observed";
- E2E-002: "a transition that does not advance the public step index";
- `tasks/03-reference-sample-verification.md`: "enumerate and render every step from the `data-step-count` and `data-step-index` hooks".

The inspect half of item 4 is class B and goes to this change's `engineering-inspect-fails-loudly`. P7 judges the verifier only; the two criteria stay distinct.

P7 names the `data-step-count` and `data-step-index` hooks, which the rubric's traceability rule requires to be accounted for. They are fixture values, so `verification-step-error-fails` gained a second fixture citation, design.md's "Verification" section ("reads the step count from a `data-step-count` hook on the chrome, then steps through every step (`ArrowRight`), checking the `data-step-index` advances"), rather than an eval-owned value.

### Item 5. Templates build at their documented destination: (a) covered

- **Step, presentation and inspect templates.** These are covered by this change's `engineering-templates-build-at-destination` ("every step, presentation, and inspect template that the skill materializes would type-check and build at the destination the skill documents for it").
- **The bootstrap template.** It is already covered by `skill-empty-directory-scaffold`, G4: "a test that materializes the bootstrap template in a fresh temporary location and builds it".
- **Boundary.** `skill-template-path-resolution` stays limited to finding the templates, as the design's boundary table requires.
- **Classification.** The issue calls item 5 class A because of the spec's "Builds clean" quality bar, but this change scores it as an eval-owned engineering criterion. That is consistent with the design and needs no extra guidance.

### Item 7, narrow-viewport clause. Narrow-viewport overflow: (a) covered where automatable; process side P5

- **Canvas fit.** Canvas fit at the narrow reference viewport (390×844, an eval-owned value) is covered by `canvas-uniform-scaling` G1. That includes a footer or chrome that takes more space than the fit reserves ("reserves less space than the rendered chrome takes").
- **Chrome overflow.** Chrome overflow that leaves the canvas fit intact, such as a caption with `white-space: nowrap` overflowing at 375 px (cc572181-2) or a phone footer overflowing (d7f384ba-3), has no automated criterion. It is judged by the human rubric's responsive question: "Compare the presentation at wide and narrow viewport sizes … Judge scaling, density, readability, control accessibility, clipping, overlap". Automating it would need a new narrow-viewport browser probe, which is outside this change.
- **Process.** The skill's obligation to check a narrow viewport is P5 (see B6).

## Other class A items named elsewhere in the issue (not requested; noted for completeness)

- **Item 6, the allow-overlap marker suppressing the whole page or scene.** This is `visual-helper-allow-overlap`. Fixture: "does not report overlap warnings for elements inside that subtree". The design's boundary table keeps "how far allow-overlap suppression reaches" there. The existing G6 credits per-pair skipping and requires a focused test, but does not explicitly fail page-wide suppression. That could be a follow-up guidance line, but it was outside this audit's requested items.
- **Item 11, scaffolding: a partial scaffold overwrites host files.** This is `skill-partial-scaffold`. Fixture: "without disturbing the ones already present". G2: "Fail … when a delivered helper script or template implements that branch differently."
- **Item 12, the step 8 modify arc rendered as an HTML `path`.** This is `demo-required-scene-content` (browser), "Every step renders the scene content the fixture requires for it."

## Proposed guidance additions, collected

| Id | Append to subcomponent `review_guidance` | Criterion it targets | Priority | Status |
|---|---|---|---|---|
| P1 | `scene-entity-transitions` | `entity-persisting-morph` (ungrouped path: no `mode="wait"`, no stacked wrappers) | recommended; calibrate | deferred |
| P2 | `scene-modes-and-navigation` | `navigation-active-state` (TOC entry active across its era) | recommended; check the `demo-control-semantics` probe first | deferred |
| P3 | `scene-entity-transitions` | `entity-persisting-morph` (connectors morph their endpoints) | recommended; calibrate | deferred |
| P4 | `scene-entity-transitions` | `grouped-continuing-entities-not-newcomers`, `grouped-scene-updates-in-place` (keys from identity) | optional | deferred |
| P5 | `skill-self-verification` | `skill-checks-run-before-done` (narrow viewport for responsive-sensitive) | recommended | adopted, rubric 13.0.0 |
| P6 | `skill-scaffolding` | `skill-empty-directory-scaffold` (template kit parity) | recommended | adopted, rubric 13.0.0 |
| P7 | `verification-addressing-and-errors` | `verification-step-error-fails` (no hook coercion) | recommended | adopted, rubric 13.0.0 |
| B7 | `skill-scaffolding` | `skill-empty-directory-scaffold` (Chromium install) | Paul's decision after review | adopted, rubric 13.0.0 |

All P1–P7 texts and the B7 text restate fixture requirements and introduce no new eval-owned values. P5, P6, P7 and B7 ship with the rubric 13.0.0 bump, so the re-weighting check's verdict basis shifts further for rescored runs; that check used recorded 6.0.0/7.0.0 verdicts, not a rescore.

## Deferred proposals

These are follow-ups, not part of this change:

| Id | Why deferred | Before adopting |
|---|---|---|
| P1 | Narrows existing `entity-persisting-morph` guidance (G6) and is expected to lower pass rates. | Calibrate. |
| P2 | The deterministic `demo-control-semantics` probe expects exactly one current control per step. | Check that the probe does not count TOC entries alongside progress controls. |
| P3 | Narrows existing `entity-persisting-morph` guidance (G6). | Calibrate. |
| P4 | Optional, low-priority clarification of behaviour already covered. | None required. |

## Open gaps

| Item | Why no guidance |
|---|---|
| A5 exiting scene `isActive` | The fixture defines no active-scene signal. |
| A10 optional payload crash | A plain bug; scored only where the demo hits it (item 12 policy). |
| B3 router or registry unit test | The test plan doesn't inventory unit tests; behaviour is already covered. |
| Item 3, script drift | The only source is `AGENTS.md`, and the bootstrap copies must legitimately differ from the root copies. |
| Item 7, chrome overflow at narrow width without a canvas-fit failure | Covered only by human review. Automating it needs a new browser probe, which is out of scope. |
