# engineering-quality-scoring Specification

## Purpose
Define the 8-point "Engineering quality beyond the spec" automated component: its narrow, eval-owned criteria for qualities a good and-scene implementation has although the fixture's planning documents do not require them, the deterministic input-hygiene browser probes and focused LLM source-review job that score them, and how the component applies to candidates and the reference baseline.
## Requirements
### Requirement: Engineering quality component
The automated product rubric SHALL contain an `engineering-quality` component, titled "Engineering quality beyond the spec", worth 8 points with no floor. It SHALL score qualities that a good implementation has even though the pinned fixture's planning documents do not require them. Every criterion in it SHALL be eval-owned. Its recorded reason SHALL state the complete pass condition, because judges and second-opinion verifiers read the reason as the criterion's requirement. Each criterion SHALL test one narrow quality, so that its verdict discriminates between implementations rather than failing almost every run.

| Subcomponent | Points | Evaluator | Criteria |
|---|---:|---|---|
| Input hygiene | 2 | Deterministic browser | `input-modifier-keys-pass-through`, `input-swipe-from-control-ignored` |
| Verification tooling robustness | 3 | LLM source review (`engineering-quality` job) | `engineering-preview-terminated-on-every-exit`, `engineering-preview-readiness-bounded`, `engineering-bootstrap-scripts-generic`, `engineering-inspect-fails-loudly`, `engineering-checks-read-rendered-page`, `engineering-diagnostics-cover-presentation` |
| Skill instructions and templates | 1.5 | LLM source review (`engineering-quality` job) | `engineering-templates-build-at-destination`, `engineering-skill-description-triggers`, `engineering-skill-out-of-scope-redirects`, `engineering-skill-completion-report` |
| Presentation code and tests | 1.5 | LLM source review (`engineering-quality` job) | `engineering-presentation-css-scoped`, `engineering-typed-kit-primitives`, `engineering-tests-wait-on-state`, `engineering-tests-isolate-resources` |

The component SHALL apply to both candidates and the reference baseline. The scorer SHALL divide each subcomponent's points equally among its criteria without rounding intermediate values.

#### Scenario: Engineering quality is scored for a candidate
- **WHEN** a candidate's automated scoring completes
- **THEN** the result reports the engineering-quality component out of 8, with each of its sixteen criteria carrying a pass/fail verdict
- **AND** the automated subtotal remains out of 70

#### Scenario: Engineering quality is scored for the reference
- **WHEN** the reference baseline is evaluated
- **THEN** the engineering-quality component is applicable and counts toward the reference's shared denominator of 92

#### Scenario: Engineering quality has no floor
- **WHEN** a candidate earns zero engineering-quality points but otherwise satisfies the official pass contract
- **THEN** the engineering-quality component creates no additional gate

#### Scenario: Every criterion is eval-owned with a full pass condition
- **WHEN** the rubric's traceability is validated
- **THEN** each engineering-quality criterion is recorded with owner `eval` and a reason that states its pass condition

### Requirement: Engineering-quality judge job
The evaluator SHALL run a focused `engineering-quality` source-review judge job. The job SHALL return exactly the fourteen LLM-judged engineering-quality criteria. The job SHALL receive the same neutral source snapshot, neutral requirements bundle, and untrusted-data handling as the other implementation source-review jobs, and SHALL use the same judging protocol they use: the cross-family panel (`cross-family-panel-v1`) of one Claude-family and two Codex-family judges with the line-cited decider, for candidates and for the reference baseline alike. Like every other deterministic browser criterion, `input-modifier-keys-pass-through` and `input-swipe-from-control-ignored` SHALL each declare the `demo-integration` judge as their fallback.

#### Scenario: The job returns exactly its criteria
- **WHEN** the engineering-quality job completes
- **THEN** it returns exactly the fourteen LLM-judged engineering-quality criteria, whether or not either input-hygiene probe was observed

#### Scenario: The job is judged by the cross-family panel
- **WHEN** the engineering-quality job runs for a candidate or for the reference baseline
- **THEN** its criteria are judged by the same cross-family panel as the other scored judge jobs, and a criterion the panel disputes is settled by the line-cited decider

#### Scenario: A not-observed input-hygiene probe falls back to demo integration
- **WHEN** `input-swipe-from-control-ignored` is recorded as not observed
- **THEN** the demo-integration judge's expected criterion set includes that criterion, and the engineering-quality job's does not

### Requirement: Modifier-key shortcuts pass through
The deterministic browser evaluator SHALL score `input-modifier-keys-pass-through`. From a step that is neither the first nor the last, it SHALL press `ArrowRight` and `ArrowLeft` while holding each of Alt, Control, and Meta in turn. It SHALL detect a prevented default by instrumenting `KeyboardEvent.prototype.preventDefault` in the loaded presentation document before the probe's first key press, and SHALL install the instrumentation again whenever it reloads the presentation, so that a page that stops propagation cannot hide the call. Because the instrumentation is installed after the page's own scripts have run, a page that has already replaced or wrapped `preventDefault` before installation is out of its reach. The criterion SHALL fail when any modified press changes the step index, or when the page calls `preventDefault` on a modified press's keydown, and SHALL pass otherwise. For each press, the retained observation SHALL record the key, the modifier, the step before and after, whether the page prevented the default, and whether the document unloaded.

A modified press that makes the browser leave the presentation document, for example Alt+ArrowLeft navigating history, shows that the page let the shortcut through. The evaluator SHALL record that press as passing through, reload the presentation, return to the step the press started from, and continue with the remaining presses. It SHALL raise a resumable harness failure only when the presentation cannot be reloaded or the starting step cannot be re-established. The criterion SHALL be recorded as not observed only when the deck has no step that is neither the first nor the last, and the record SHALL say so.

#### Scenario: Alt+Arrow changes the slide
- **WHEN** pressing Alt+ArrowRight on a middle step advances the deck
- **THEN** `input-modifier-keys-pass-through` fails, and the retained observation names the key, the modifier, and the step before and after

#### Scenario: The page prevents a modified key's default
- **WHEN** the step does not change but the page called `preventDefault` on a Control+ArrowLeft keydown
- **THEN** `input-modifier-keys-pass-through` fails, and the retained observation records the prevented default

#### Scenario: The page stops propagation and prevents the default
- **WHEN** the page's keydown handler calls `stopPropagation` and `preventDefault` on Meta+ArrowRight
- **THEN** the prevented default is still detected and the criterion fails

#### Scenario: A modified press leaves the document
- **WHEN** Alt+ArrowLeft makes the browser navigate back, away from the presentation document, and the page did not prevent the default
- **THEN** the evaluator records that press as passing through with the unload retained, reloads the presentation at the starting step, and continues the probe

#### Scenario: The presentation cannot be reloaded after an unload
- **WHEN** a modified press leaves the document and the presentation then fails to load
- **THEN** the evaluator raises a resumable harness failure and records no verdict

#### Scenario: Modified keys are ignored
- **WHEN** no modified press changes the step or has its default prevented
- **THEN** `input-modifier-keys-pass-through` passes

### Requirement: Swipes that start on a control do not navigate
The deterministic browser evaluator SHALL score `input-swipe-from-control-ignored`. In whichever mode exposes an interactive control inside the presentation, it SHALL perform a predominantly horizontal single-touch swipe that starts on such a control, from a step that is neither the first nor the last. It SHALL prefer a control whose activation does not change the step, such as a mode control. It SHALL deliver the swipe as touch events and, when the step does not change, again as pointer events, with the same pacing as the existing touch-swipe check.

The criterion SHALL fail when the swipe changes the step index under either input path. There is one exception: when the only control available is a step control, a resulting step equal to that control's own activation target SHALL NOT count as a failure. The criterion SHALL pass when the step does not change. It SHALL be recorded as not observed only when the deck has no step that is neither the first nor the last, or when the evaluator discovers no interactive control in either mode under any convention it recognises, and the record SHALL say which, stating the conventions looked for when no control was discovered. Its declared fallback judge is the `demo-integration` job. The retained observation SHALL record the control's selector or hook, the mode, the input paths tried, and the step before and after each.

#### Scenario: A swipe starting on the mode control changes the slide
- **WHEN** a horizontal swipe that starts on the mode control advances the deck
- **THEN** `input-swipe-from-control-ignored` fails, and the retained observation names the control, the mode, the input path, and the steps before and after

#### Scenario: A swipe on a step button lands on that button's step
- **WHEN** the only discoverable controls are step buttons, and a swipe that starts on the button for step 6 leaves the deck on step 6
- **THEN** the criterion does not fail on that observation

#### Scenario: A swipe starting on a control is ignored
- **WHEN** the swipe leaves the deck on its step
- **THEN** `input-swipe-from-control-ignored` passes

#### Scenario: No control is discoverable
- **WHEN** the evaluator finds no interactive control in either mode
- **THEN** the criterion is recorded as not observed and resolved by the demo-integration fallback judge

### Requirement: Preview terminated on every exit path
`engineering-preview-terminated-on-every-exit` SHALL pass only when the delivered verify and inspect scripts terminate and await the preview server process itself on every exit path, including success, a browser launch failure, and an error after the preview started. This applies to the repository copies and the skill's bootstrap template copies. Killing only an `npm` or `npx` wrapper while the server keeps running SHALL fail the criterion. A preview started through Vite's `preview()` API and closed on every exit path SHALL satisfy the criterion.

#### Scenario: Only the npx wrapper is killed
- **WHEN** cleanup kills the `npx` wrapper process and the Vite preview it spawned keeps running
- **THEN** `engineering-preview-terminated-on-every-exit` fails

#### Scenario: A browser launch failure leaks the preview
- **WHEN** Chromium fails to launch after the preview started and that exit path does not stop the preview
- **THEN** `engineering-preview-terminated-on-every-exit` fails

#### Scenario: The preview is closed in a finally path
- **WHEN** the scripts start the preview through Vite's `preview()` API and close it in a `finally` path that every exit passes through
- **THEN** `engineering-preview-terminated-on-every-exit` passes

### Requirement: Preview readiness is bounded
`engineering-preview-readiness-bounded` SHALL pass only when the delivered verify and inspect scripts meet all three of these:
- every wait for preview readiness has a timeout;
- verification starts the preview only after the build it verifies has completed;
- when readiness relies on the server's printed ready URL, the parsing tolerates ANSI colour codes and output split across chunks.

Whether readiness is connected to the scripts' own child process remains scored only by `verification-preview-process-ownership`.

#### Scenario: Readiness waits forever
- **WHEN** the readiness wait has no timeout
- **THEN** `engineering-preview-readiness-bounded` fails

#### Scenario: The preview starts before the build finishes
- **WHEN** verify starts the preview while the build it verifies is still running
- **THEN** `engineering-preview-readiness-bounded` fails

#### Scenario: Ready-URL parsing breaks on colour codes
- **WHEN** ready-URL matching fails if the server's output contains ANSI colour codes
- **THEN** `engineering-preview-readiness-bounded` fails

### Requirement: Generic bootstrap scripts
`engineering-bootstrap-scripts-generic` SHALL pass only when the skill's bootstrap template copies of verify and inspect meet all three of these:
- they take the target presentation from an argument, or verify every registered route;
- they reject an unregistered slug with a clear non-zero failure, rather than timing out or accepting the landing-page fallback;
- they contain no titles, captions, routes, or defaults specific to the repository's reference sample.

#### Scenario: The template verifies a hardcoded route
- **WHEN** the bootstrap verify script checks only a hardcoded sample route or only the first registry entry
- **THEN** `engineering-bootstrap-scripts-generic` fails

#### Scenario: The template embeds sample captions
- **WHEN** the bootstrap verify script asserts the reference sample's titles or captions
- **THEN** `engineering-bootstrap-scripts-generic` fails

#### Scenario: Unknown slug fails clearly
- **WHEN** the bootstrap scripts take a slug argument, reject an unregistered slug with a clear non-zero failure, and contain no sample-specific content
- **THEN** `engineering-bootstrap-scripts-generic` passes

### Requirement: Inspect fails loudly
`engineering-inspect-fails-loudly` SHALL pass only when the delivered inspect helper meets all three of these:
- it rejects a missing, zero, or non-numeric step count or step index;
- before capturing each step, it confirms that the reported step index equals the step it meant to reach;
- it never reports success with zero captures.

Verify's detection of a non-advancing step remains scored by the existing verification criteria.

#### Scenario: Inspect accepts a NaN step count
- **WHEN** inspect proceeds and reports success after reading a non-numeric `data-step-count`
- **THEN** `engineering-inspect-fails-loudly` fails

#### Scenario: Inspect succeeds with no captures
- **WHEN** inspect captures no step and still exits successfully
- **THEN** `engineering-inspect-fails-loudly` fails

### Requirement: Content checks read the rendered page
`engineering-checks-read-rendered-page` SHALL pass only when the delivered verification checks of the sample's titles, captions, outline order, and registration read the rendered page at each step, rather than matching regular expressions over source text. Hardening a source parser against syntax that never occurs SHALL NOT earn credit.

#### Scenario: Titles are checked by source regex
- **WHEN** verify validates the sample's titles by matching regular expressions over source files
- **THEN** `engineering-checks-read-rendered-page` fails

#### Scenario: Titles are read from the rendered page
- **WHEN** verify reads each step's title and caption from the rendered DOM
- **THEN** `engineering-checks-read-rendered-page` passes

### Requirement: Diagnostics cover the presentation
`engineering-diagnostics-cover-presentation` SHALL pass only when the visual inspection diagnostics run on every captured step, not only one, and when the captures and diagnostics include the presentation's chrome rather than only a cropped scene. Whether individual warnings fire, and the scope of intentional-overlap suppression, remain scored by the existing `visual-helper-*` criteria. The performance of the overlap scan SHALL NOT affect the verdict.

#### Scenario: Diagnostics run only on the last step
- **WHEN** the inspect helper captures every step but runs its diagnostics only on the final step
- **THEN** `engineering-diagnostics-cover-presentation` fails

#### Scenario: Captures crop out the chrome
- **WHEN** captures include only the scene canvas, so the caption, table of contents, and controls are never inspected
- **THEN** `engineering-diagnostics-cover-presentation` fails

### Requirement: Templates build at their documented destination
`engineering-templates-build-at-destination` SHALL pass only when every step, presentation, and inspect template that the skill materializes would type-check and build at the destination the skill documents for it. The judge SHALL establish this either by tracing each template's relative imports, CSS imports, required props, and field names against the bootstrapped project layout and the kit's types, or by citing a focused test that materializes the templates and builds them. Whether the skill resolves its template paths remains scored by `skill-template-path-resolution`.

#### Scenario: A template import resolves outside src
- **WHEN** a step template's relative import of the kit resolves outside the project's `src` directory from its documented destination
- **THEN** `engineering-templates-build-at-destination` fails

#### Scenario: A template omits a required prop
- **WHEN** a template renders a kit primitive without a prop the kit's types require
- **THEN** `engineering-templates-build-at-destination` fails

#### Scenario: Templates are built by a focused test
- **WHEN** a test materializes every template into a fresh bootstrap and runs the type check and build successfully
- **THEN** `engineering-templates-build-at-destination` passes

### Requirement: Skill description states its triggers
`engineering-skill-description-triggers` SHALL pass only when the delivered `SKILL.md` frontmatter description is written in the third person, states when to use the skill, and quotes at least two example user phrases that should trigger it.

#### Scenario: A first-person description without triggers
- **WHEN** the description reads "I help you make presentations" and quotes no trigger phrases
- **THEN** `engineering-skill-description-triggers` fails

#### Scenario: A third-person description with quoted triggers
- **WHEN** the description reads "Creates and modifies evolving-scene presentations. Use when the user asks to \"create a presentation\" or \"add steps\""
- **THEN** `engineering-skill-description-triggers` passes

### Requirement: Skill states what is out of scope
`engineering-skill-out-of-scope-redirects` SHALL pass only when the delivered `SKILL.md` has a section listing each of the proposal's exclusions, which are PowerPoint or Keynote output, PDF or image export, a visual editor, and hosting, and gives each a redirect telling the agent what to do or suggest instead.

#### Scenario: Exclusions are missing
- **WHEN** `SKILL.md` has no section listing the proposal's exclusions
- **THEN** `engineering-skill-out-of-scope-redirects` fails

#### Scenario: Exclusions lack redirects
- **WHEN** `SKILL.md` lists the exclusions but gives no redirect for hosting
- **THEN** `engineering-skill-out-of-scope-redirects` fails

### Requirement: Skill defines its completion report
`engineering-skill-completion-report` SHALL pass only when the delivered `SKILL.md` gives a completion-report template. The template SHALL name the presentation route, the files changed, the build, render, and inspect results, and the advisory warnings that remain. Whether the skill requires those checks to run and pass before reporting completion remains scored by `skill-checks-run-before-done` and `skill-failures-fixed-before-success`. This criterion scores only the report the skill asks the agent to give.

#### Scenario: No report template
- **WHEN** `SKILL.md` tells the agent to report completion but defines no report contents
- **THEN** `engineering-skill-completion-report` fails

#### Scenario: A complete report template
- **WHEN** `SKILL.md` gives a template with the route, files changed, build, render, and inspect results, and remaining advisory warnings
- **THEN** `engineering-skill-completion-report` passes

### Requirement: Presentation CSS is scoped
`engineering-presentation-css-scoped` SHALL pass only when every selector in a stylesheet owned by a presentation is scoped under that presentation's own root class or hook, or comes from a CSS module. This includes selectors that target the kit's hook classes or attributes, such as `.presentation-attribution`. Unscoped rules in a presentation-owned stylesheet leak to other presentations after client-side navigation. A host-owned global stylesheet MAY style kit hooks without a presentation scope. Readability and narrow-viewport layout SHALL NOT be scored here.

#### Scenario: A presentation restyles a kit hook unscoped
- **WHEN** a presentation-owned stylesheet styles `.presentation-attribution` without the presentation's root scope
- **THEN** `engineering-presentation-css-scoped` fails

#### Scenario: A host stylesheet styles a kit hook
- **WHEN** the host application's global stylesheet styles `.presentation-attribution`, and every presentation-owned selector is scoped under its presentation root
- **THEN** `engineering-presentation-css-scoped` passes

### Requirement: Typed kit primitives
`engineering-typed-kit-primitives` SHALL pass only when the kit's public primitives meet all three of these:
- they type their props as the rendered element's props rather than an untyped bag such as `Record<string, unknown>`;
- they apply the kit's own identity hooks (`data-presentation-*` attributes, `layoutId`, entity identifiers) after caller props, so callers cannot override them;
- they keep props meant only for the kit off the DOM.

#### Scenario: A caller can override a kit identity hook
- **WHEN** a primitive spreads caller props after setting its `layoutId` or `data-presentation-*` hook
- **THEN** `engineering-typed-kit-primitives` fails

#### Scenario: Typed primitives protect their hooks
- **WHEN** primitives are typed as their element's motion props, apply identity hooks last, and strip kit-only props
- **THEN** `engineering-typed-kit-primitives` passes

### Requirement: Tests wait on observable state
`engineering-tests-wait-on-state` SHALL pass only when the delivered automated tests that drive a browser wait for observable state before asserting on it, using a polling or auto-waiting assertion on, for example, the step index or a settled signal. They SHALL NOT use fixed sleeps. A call that returns immediately but is used as if it waited, such as reading an element count, SHALL count as a fixed sleep.

#### Scenario: E2E tests sleep instead of waiting
- **WHEN** an end-to-end test waits a fixed number of milliseconds for a transition before asserting the step
- **THEN** `engineering-tests-wait-on-state` fails

#### Scenario: Tests poll the step index
- **WHEN** browser tests wait with an auto-waiting assertion until the step index reaches the expected value
- **THEN** `engineering-tests-wait-on-state` passes

### Requirement: Tests isolate their resources
`engineering-tests-isolate-resources` SHALL pass only when the delivered automated tests that start a preview server or a browser allocate ports dynamically rather than sharing fixed ports, and terminate every process they start.

#### Scenario: Tests share a fixed port
- **WHEN** two test files each start a preview on the same hardcoded port
- **THEN** `engineering-tests-isolate-resources` fails

#### Scenario: Tests leave a preview running
- **WHEN** an end-to-end test kills the `npx` wrapper and leaves the preview server running
- **THEN** `engineering-tests-isolate-resources` fails

### Requirement: Validator noise is not rewarded
No engineering-quality criterion, and no review guidance added by this change, SHALL reward behaviour that issue #77 classified as noise or harmful. Specifically:
- hardening for runtime step-list changes beyond clamping at the ends;
- registry or source-parser hardening against syntax that never occurs;
- routing hardening for hosting concerns the proposal excludes;
- longer fixed settle delays;
- arrow keys driving the deck while an interactive control holds focus.

#### Scenario: Global keys work while a button holds focus
- **WHEN** a presentation lets deck navigation keys advance the deck while a button holds focus
- **THEN** no engineering-quality criterion awards credit for it

#### Scenario: A longer fixed settle delay
- **WHEN** a candidate lengthens a fixed screenshot settle delay to exceed the kit's animation duration
- **THEN** no engineering-quality criterion awards credit for it

