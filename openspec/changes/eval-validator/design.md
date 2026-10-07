## Context

Issue agent-evals#77 is the source of every criterion here. Its body lists the qualities, and its comments hold the per-run inventory and the full text of each finding. Read it before writing judge guidance, because the variants it lists are what each criterion must catch. The automated rubric is `evals/agent-runner/and-scene/automated-rubric.json`, at version 12.4.0 when this change started.

## Decisions

### Point funding

| Component | Before | After | Subcomponent changes |
|---|---:|---:|---|
| Demo technical quality | 24 (floor 15) | 20 (floor 12.5) | canonical content 5→4, navigation and modes 5→4, runtime reliability 4→3, scene-kit integration 4, identity and grouping 3, code boundaries 3→2 |
| Scene kit correctness | 24 (floor 15) | 20 (floor 12.5) | step model 4→3, entity transitions 7→6, modes and navigation 6→5, canvas 1 + 1, style and attribution 5→4 |
| Engineering quality | — | 8 (no floor) | input hygiene 2, verification tooling robustness 3, skill instructions and templates 1.5, presentation code and tests 1.5 |

- The cuts take whole points from the larger subcomponents, so the rubric file keeps readable numbers.
- They leave the source-reviewed scene-kit integration and identity subcomponents alone, because those carry the most guidance and calibration history.
- Both floors keep their 62.5% ratio. Everything that reads the floor values changes together: the rubric, the scorer's eligibility checks, reports, the README, and the tests.

### Narrow criteria

Each criterion tests one quality with at most three closely related clauses. A broad conjunction worth well under a point would fail almost every run, with or without the validator, and stop discriminating, which is the purpose of #77. Clauses that were vague, or that overlapped existing skill criteria, were dropped:
- SKILL.md routing between create and modify, which overlaps `skill-new-presentation-routed` and `skill-modify-ambiguous-target`;
- the modify discovery step, which overlaps `skill-scoped-modification` and `skill-existing-presentations-preserved`;
- "completion gates do not contradict";
- the hardcoded browser path and browser installation in tests.

**Reversal (2026-10-07).** Browser installation is still not an engineering criterion, but after review Paul decided to score it as the class A item it is (B7 in `class-a-coverage.md`). The fixture requires the scaffold to install the dependencies render verification needs, and its design installs Chromium in the verify step. Dropping it while adopting the P5–P7 guidance, which restates fixture requirements in the same way, was inconsistent. `skill-empty-directory-scaffold` now carries review guidance that fails a delivery in which neither SKILL.md, the bootstrap scripts, nor the verify step installs Playwright Chromium or checks that it is available before the render check.

### A new judge job, not spread across existing jobs

The fourteen LLM criteria form one new `engineering-quality` job. The alternative was to add each criterion to the existing job whose source area it touches. That was rejected for two reasons:
- the existing jobs' prompts stay unchanged, so their guidance and calibration history stay valid;
- the cost of the new criteria can be measured on its own.

Both browser probes still declare `demo-integration` as their fallback, as the existing rule and `lib/rubric.mjs` require of every deterministic browser criterion. The engineering-quality job therefore always judges exactly fourteen criteria.

It is a source-review job, so it receives the neutral snapshot and the requirements bundle, and it runs for the reference too. Its judging protocol is whatever the other implementation source-review jobs use. On main that is the robust-verdict protocol; on eval-the-whole-workflow it is the cross-family panel. Wire it through the same code path rather than naming a protocol.

### Criterion boundaries that prevent double counting

Put each boundary into the new criterion's review guidance.

| New criterion | Existing criterion it must not re-score | Boundary |
|---|---|---|
| `engineering-preview-terminated-on-every-exit`, `engineering-preview-readiness-bounded` | `verification-preview-process-ownership` | Ownership means readiness is connected to the scripts' own child, and verification fails when that child exits. The new criteria cover termination on every exit path, bounded readiness, building before previewing, and ready-URL parsing. |
| `engineering-inspect-fails-loudly` | `verification-step-error-fails`, hard gates | Verify detecting a non-advancing step stays where it is. The new criterion covers only the inspect helper. |
| `engineering-diagnostics-cover-presentation` | `visual-helper-*` | Whether each warning fires, and how far allow-overlap suppression reaches, stay where they are. The new criterion covers the steps and the area that the diagnostics run over. |
| `engineering-templates-build-at-destination` | `skill-template-path-resolution` | Path resolution is whether the skill finds its templates. The new criterion is whether the materialized templates compile where they land. |
| `engineering-skill-completion-report` | `skill-checks-run-before-done`, `skill-failures-fixed-before-success` | Those criteria cover whether the checks run and pass. The new criterion covers only the report template. |
| `engineering-skill-description-triggers`, `engineering-skill-out-of-scope-redirects` | presentation-skill criteria | No existing criterion scores the description or the out-of-scope section. |
| `engineering-presentation-css-scoped` | `attribution-styling-hook`, `skill-presentation-owns-style` | Rubric 12.4.0 lets presentation CSS restyle kit hooks. This criterion adds only that a presentation-owned rule targeting a kit hook is scoped under the presentation root. Host-owned global CSS is exempt. |
| `input-modifier-keys-pass-through`, `input-swipe-from-control-ignored` | `navigation-controls-keep-keys`, `demo-navigation-boundaries-and-control-keys`, `navigation-touch-swipe` | The existing criteria cover focused controls keeping their own keys, clamping, and rejecting vertical or multi-touch swipes. The new probes cover modified keys and swipes that start on a control. |

### Eval-owned reasons are requirements

Every judge, audit, and second-opinion verifier receives an eval-owned criterion's `reason` as its requirement. Each new `criterion_sources` entry therefore states the full pass condition from the spec, not a provenance note. The rule "Concrete values in guidance are accounted for" applies. Examples of concrete values here are the SKILL.md exclusions (PowerPoint, Keynote, PDF or image export, visual editor, hosting) and hook names such as `data-presentation-*`, `layoutId`, and `.presentation-attribution`. Account for each one the way that rule already provides: an eval-owned value entry or a fixture citation.

### Browser probes

**Driver.** `lib/axi-browser-driver.mjs` needs three additions. Use only primitives that every supported chrome-devtools-axi build provides.
- **Modifier presses.** On 2026-10-06, the local build's `press "Alt+ArrowRight"` delivered a keydown with `altKey=true`, and Meta chords worked the same way. Confirm this on every supported build in a real-browser test.
- **Swipes from an element.** Swipes are synthesized page-side touch events, so starting at an element's centre is a change to the target setup.
- **`preventDefault` instrumentation.** Install it before the page's scripts run, for example through an init script or by navigating after registering it. If no portable primitive can do that, install it before the probe's first key press, and record that a page wrapping `preventDefault` itself is out of reach.
  - **Outcome.** chrome-devtools-axi 0.1.34 has no portable primitive that runs a script before a document's own scripts: no init script, and no on-navigation hook. The fallback was taken. The driver installs the instrumentation into the loaded presentation document before the probe's first key press, and installs it again after every reload. The wrapper on `KeyboardEvent.prototype.preventDefault` still sees a handler that calls `stopPropagation` and then `preventDefault`, so the stopped-propagation guarantee holds. A window capture listener added by the driver also reads `defaultPrevented` once dispatch is over, which covers a page that calls a cached `Event.prototype.preventDefault`.
  - **Known gap.** A page that replaced or wrapped `preventDefault` before installation is out of reach. So is a page that hides the event from the driver's capture listener with an earlier `stopImmediatePropagation` and also calls a cached `Event.prototype.preventDefault`, because neither the wrapper nor the listener then sees the call.
  - **Spec amendment.** The "Modifier-key shortcuts pass through" requirement was reworded after implementation to describe this installation point and gap, instead of installation "before the page's scripts run". The "Swipes that start on a control do not navigate" requirement now also records the swipe probe as not observed when the deck has no step that is neither the first nor the last, as the modifier probe does, because neither probe has a step to start from.

**Modifier keys.**
- Move to a middle step. Press ArrowRight and ArrowLeft holding each of Alt, Control, and Meta: six presses.
- Read the prevented-default count from the instrumentation, which wraps `KeyboardEvent.prototype.preventDefault`, so a page that stops propagation cannot hide the call.
- Listen for `pagehide`. An unload means the shortcut reached the browser, which is the desired behaviour, so record the press as passing through, reload the presentation, return to the starting step, and continue. Raise a resumable harness failure only when the reload or the return fails.
- Retain each press's key, modifier, step before and after, prevented flag, and unload flag.
- Record not observed only for a deck with no middle step. The fallback judge is `demo-integration`.

**Swipe from a control.**
- Use the existing control discovery. Prefer a control whose activation doesn't change the step, such as the mode control. Fall back to a step control only when nothing else is available, and then exempt a resulting step equal to that control's target.
- Move to a middle step, then swipe horizontally with one finger from the control's centre, over the existing swipe probe's distance and pacing: touch events first, then pointer events if the step did not change.
- Retain the control's selector or hook, the mode, the input paths tried, and the steps before and after each.
- Record not observed, with the conventions looked for, only when no control can be discovered. The fallback judge is `demo-integration`.

Add both criteria to `DETERMINISTIC_BROWSER_CRITERIA` and `PROBE_REQUIREMENTS`. Give each focused real-browser regression pages under `test/real-browser/` covering pass, fail, the stopped-propagation case, and not observed.

### Second-opinion replay

PR #82 changed overturn handling. A replay inside a target's admitted entry decides on its own (`confirmed_by: 'browser-replay'`). Any other replay that the page passes goes to an independent span audit (`confirmed_by: 'audited-browser-replay'`). Main's spec text still says "no allowlist entry ... stands", which is stale. The runner-evals-strategy session is correcting it separately, so this change adds a new requirement rather than modifying that text.

- **Schema.** Add an optional `modifiers` field (any of `Alt`, `Control`, `Meta`) on `press`, and an optional start `selector` on `swipe`. The schema must stay valid under OpenAI strict structured output, so represent absent values as nullable required fields or something else strict mode accepts.
- **Policy.** Add the two admitted entries in `replayPolicy`, and the plan and evidence checks in `replayPlanRefusal` and `replayEvidenceRefusal`. The admitted swipe must use the input path, touch or pointer, that changed the step in the recorded failure; a different path goes to the audited path.
- **Prevented-default refusal.** No replay expectation can observe a prevented default, so an audited replay could otherwise overturn a real defect. Add a harness check before any replay or audit: when the target is `input-modifier-keys-pass-through` and its failing record includes a prevented default, reject the overturn with that reason. This is code, not prompt guidance.

### Rubric version

Bump to the next major version after main's at merge time. The eval-the-whole-workflow branch already ships 13.0.0 with different content, and `test/rubric.test.mjs` allows one hash per version, so check main immediately before merging. Use 13.0.0 if this lands first, and 14.0.0 otherwise. Record the version and the reason the points moved in the README.

### Re-weighting check

Before finalizing, re-weight the existing criterion verdicts from the current baseline runs and the #78 run under the new points and floors. This is arithmetic over recorded results, with no model calls. The engineering-quality component is unscored for those runs, so report the demo technical quality and scene kit correctness components, the automated subtotal, and whether any run's floor status or 40/70 eligibility would change at the new weights, excluding the new component. Record the table in `openspec/changes/eval-validator/reweight-check.md`. If a known run's eligibility flips, stop and surface it before merging.

### Class A audit

Check each item in issue #77's "Already required by the spec (class A)" section against the current criteria and their guidance. Also check item 2a, item 3's drift clause, item 4's verify clause, item 5, and item 7's narrow-viewport clause. `navigation-controls-keep-keys` is now judged on the controls the presentation renders. For each item, record in `openspec/changes/eval-validator/class-a-coverage.md` either the criterion that covers it or the review guidance added to an existing criterion. Added guidance must not introduce a requirement the fixture doesn't state. Record an item that is truly uncovered as an open gap.

## Risks and trade-offs

- **Cost and time.** Each run adds one more source-review job.
- **Comparability.** Rubric 12.x and the new major version aren't comparable until old runs are rescored. Reports record the rubric version and hash.
- **Softer judgments.** LLM-judged engineering quality is softer than spec compliance. Narrow criteria with explicit fail cases, plus the "don't reward" rule in guidance, limit judge drift.
- **Easier floors.** The demo and scene-kit floors become 12.5 out of 20 instead of 15 out of 24. The ratio is unchanged, and the re-weighting check shows the effect on known runs.
- **Merge conflicts.** Expect textual conflicts in `lib/judge-jobs.mjs` with `feat/parallel-judge-jobs` and `eval-the-whole-workflow`.
- **Spec merge.** Commit 5fe2a6d on `feat/parallel-judge-jobs` rewrites main's failure-second-opinion "Verifier inputs and answer" and "Overturn acceptance" to match #82. This change's delta modifies "Verifier inputs and answer", so whichever branch lands second merges that requirement's text, keeping 5fe2a6d's wording and this change's extended action-grammar sentence. That sentence is unchanged in 5fe2a6d.

## Verification

Use test-driven development, then run `npm run check`. At minimum, the tests cover:
- rubric validation: component sums, floors, sixteen classified criteria, eval-owned reasons, and the traceability of concrete values;
- scorer arithmetic and eligibility at the new floors;
- judge-job coverage for candidates (seven jobs) and references (five);
- fallback coverage: both probes declare `demo-integration`, and a not-observed probe joins that job's expected set;
- the modifier probe's unload handling, including the failed-reload harness failure;
- both probes against real-browser pages;
- replay schema strictness, and acceptance and refusal for both admitted entries;
- the prevented-default overturn refusal on both the admitted and the audited path;
- report rendering of the new component.

There's no paid calibration or rescoring in this change. The re-weighting check is required.
