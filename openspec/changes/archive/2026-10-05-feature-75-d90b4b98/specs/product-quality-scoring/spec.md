## MODIFIED Requirements

### Requirement: Demo presentation technical quality
The evaluation SHALL score the delivered demo presentation out of 24 using the following rubric. Deterministic browser evaluation SHALL inspect the built, running demo. LLM source review SHALL inspect the delivered source and supporting evidence. The LLM SHALL assess technical implementation and SHALL NOT assess visual taste, perceived motion quality, or responsive aesthetics, which belong to human review.

| Subcomponent | Points | Evaluator | Criteria |
|---|---:|---|---|
| Canonical content, routing, and technical structure | 5 | Deterministic browser | `demo-route-and-registration`, `demo-nine-step-content-and-order`, `demo-required-scene-content`, `demo-evolving-scene-structure`, `quality-captions-and-navigation` |
| Navigation, modes, boundaries, and controls | 5 | Deterministic browser | `demo-present-mode-behavior`, `demo-browse-mode-behavior`, `demo-mode-position-preservation`, `demo-supported-navigation`, `demo-navigation-boundaries-and-control-keys` |
| Runtime reliability and accessibility baseline | 4 | Deterministic browser | `demo-step-and-transition-reliability`, `demo-mode-interaction-reliability`, `demo-control-semantics`, `demo-focus-and-keyboard-accessibility` |
| Uses scene-kit APIs without bypassing or duplicating them | 4 | LLM source review | `demo-scene-kit-api-use` |
| Uses stable identities and appropriate grouped-scene architecture | 3 | LLM source review | `demo-stable-identity-and-grouping` |
| Maintains clear boundaries and scope discipline | 3 | LLM source review | `demo-clear-code-boundaries`, `quality-active-chrome-and-attribution-local`, `demo-scope-discipline` |

The deterministic evaluator SHALL preserve the presentation's initial mode when opening it. Before traversing captions and canonical content, it SHALL explicitly enter browse mode. Before a mode-specific probe, it SHALL explicitly enter that probe's required present or browse mode. It SHALL NOT treat captions intentionally hidden in present mode as missing content. It SHALL change modes through a presentation-exposed mode control when one is discoverable, and SHALL fall back to a keyboard shortcut only when no such control exists. When a presentation exposes more than one mode control, the evaluator SHALL select the control for the mode it is establishing; when it cannot identify exactly one such control, it SHALL raise a resumable harness failure rather than record the unchanged mode as a product deduction. The evaluator SHALL read a presentation's declared mode from a `data-presentation-mode` attribute, or failing that from a `data-mode` attribute on the element carrying the `data-step-count` hook or one containing it, whose value is `present` or `browse`, and SHALL ignore either attribute with any other value and a `data-mode` anywhere else. When a presentation declares no such mode, the evaluator SHALL infer browse mode from a visible caption or table of contents, and SHALL NOT count an element carrying a recognised title hook or the step-marker hook (`data-presentation-marker`) as a caption unless it carries an explicit caption hook. An inferred mode is a heuristic reading under "Deterministic criteria fail only on positive evidence": it MAY position the demo and support a `pass`, but a `fail` SHALL NOT rest on it.

The deterministic evaluator SHALL drive the browser through primitives every supported chrome-devtools-axi build provides, and SHALL NOT depend on adapter behavior that varies between builds, including the adapter's own wait helper and whether a page callback closes over the driving script's scope. Before asserting responsive presentation chrome, the deterministic evaluator SHALL establish and record a suite-owned viewport. It SHALL discover navigation through either stable presentation-owned hooks or equivalent semantic navigation regions, native interactive descendants, accessible names, and current-state attributes. It SHALL accept any ARIA-valid current-state value for the active step. The absence of one non-normative per-control selector SHALL NOT be treated as a product failure. When a conforming page exposes multiple indistinguishable controls and the evaluator cannot identify the intended target deterministically, it SHALL report the observation as unavailable with a harness diagnostic rather than fabricate a product failure. A page that reports no mode or no step index has not answered at all, so the evaluator SHALL raise a resumable harness failure rather than record a product deduction.

Deterministic criteria SHALL assert only mechanically provable behavior. They SHALL NOT require a design choice the candidate-facing fixture does not state. Specifically, the deterministic browse-mode criterion SHALL require browse mode to be reported, the active step's caption to be exposed, and every step to be reached by operating the discovered navigation, either by activating each direct step control or by advancing through the discovered next control from the first step, asserting the resulting step at each activation. It SHALL NOT infer reachability from the number or visibility of controls alone; it SHALL NOT require the active step title in preference to the deck title, a visible table of contents, or simultaneously visible previous and next controls. The deterministic present-mode criterion SHALL require present mode to be reported and the active step's title to be exposed by any visible title element, and SHALL NOT require one element to carry it, nor judge that title's visual prominence. Whether browse and present chrome are composed well SHALL be judged by `mode-browse-reading-focused`, `mode-present-title-focused`, and human review.

The canonical-content checks SHALL verify the registered demo route, the nine required steps in their specified order, their normative titles, captions, and scene content, and their implementation as one evolving scene. Route registration SHALL be judged by whether the declared demo route is reachable and operable. Landing-page link discovery SHALL be recorded as an observation and SHALL NOT by itself produce a product deduction. Normative title and caption comparison SHALL normalize Unicode punctuation variants and whitespace before comparing. A step's normative title SHALL be accepted when any visible title-bearing element in either mode exposes it, including that element's own text apart from a nested step marker, and the outline check SHALL NOT require the element the evaluator ranks first as a title to carry it. A step's normative caption SHALL likewise be accepted from any visible caption-bearing element. A title or caption SHALL count as the active step's own only when a traversal of every step shows it on more visible elements at that step than at some other step, so a persistent list of every title or caption, such as a table of contents, never stands in for the active step's title or caption.

The evolving-scene check SHALL derive a scene identity only from a candidate-declared scene identity. When no scene identity is declared, the evaluator SHALL record it as undeclared and SHALL judge the criterion on entity persistence alone, rather than comparing a substitute value with itself.

The navigation checks SHALL exercise present and browse modes, mode changes, supported navigation inputs, direct controls, and end boundaries. When a check activates a navigation control, it SHALL activate it the way a pointer does, focusing the control before firing, so that a presentation which suppresses deck keys while its own control holds focus is observable rather than hidden by the probe. When a check exercises touch navigation, it SHALL deliver a single-finger, predominantly horizontal swipe the way a finger does: a touchstart on the element under the finger within the presentation's stage (or the presentation when it has no stage), a series of touchmove events, and a touchend, all keeping that target, each delivered in its own page task after the page has rendered an animation frame since the previous event, so that a presentation which records the touch start in state committed after a render is observed swiping rather than having its touchend arrive before its touchstart is recorded. A page that renders no frame between touch events within a bounded wait SHALL be reported as a harness failure rather than a product deduction. Because a real finger produces both touch and pointer events, when the touch swipe leaves the step unchanged the check SHALL deliver the same swipe as pointer events: a pointerdown, a series of pointermoves, and a pointerup with pointer type `touch`, a single primary pointer, the same target, path, and per-event render pacing. The swipe observation SHALL record which input paths were tried and the step each produced. A swipe that lands on the wrong step under either path SHALL be positive evidence of a violation. When neither path changes the step, the swipe SHALL be not observed rather than `fail`, so a criterion whose other inputs pass is recorded as not observed with the swipe as its unobserved fact. A check that needs a control SHALL establish whichever mode exposes one rather than skip itself when the mode it started in has none. Establishing a precondition SHALL remain neutral, so one defect is not charged to every criterion that happens to position the demo. The reliability and accessibility checks SHALL exercise step transitions and mode interactions, monitor browser failures, and inspect control semantics, current-state exposure, focus behavior, and keyboard operability.

Every deterministic probe artifact SHALL retain a bounded observation of what the evaluator saw: the established viewport, mode, step index and count, active title and caption, chrome visibility, the discovered controls, the selector or strategy that matched each navigation role, and the basis of each mode, title, and caption reading as defined in "Deterministic criteria fail only on positive evidence". The retention bound SHALL cover a full traversal of every step in both modes, and a probe that exceeds it SHALL publish the number of observations it dropped rather than truncate silently. A deduction SHALL be adjudicable from the retained artifact without replaying the run.

Candidate text retained as evidence SHALL be normalized exactly once. The evaluator SHALL separate collapsing and truncating candidate text, which SHALL be idempotent, from escaping it for a rationale or report, which SHALL be applied once at the emitting edge. Retained artifacts SHALL NOT contain repeatedly escaped text. A probe that returns evidence which is not a list SHALL be recorded as a single citation rather than decomposed.

Browser-process and adapter diagnostics SHALL never become candidate failure evidence. The evaluator SHALL classify the adapter's channel, executable-path, and usage-help output as browser infrastructure, SHALL raise a resumable harness failure when a probe observes one, and SHALL NOT record it as a page console failure, an unregistered route, or any other product deduction.

The deterministic browser evaluator SHALL have real-browser regression coverage against the pinned reference presentation. The reference regression SHALL require caption and canonical-content criteria to pass and SHALL NOT rely only on mocked mode state.

Deterministic source facts supplied to an LLM source judge SHALL be treated as leads rather than authoritative verdicts. The judge SHALL inspect cited source and resolve contradictions. Equivalent semantic current-state attributes and stable presentation-owned active hooks SHALL satisfy the active-state contract without requiring one hard-coded hook spelling. Source review of code boundaries SHALL also identify public API inputs or shared constants that are declared but not used by the delivered behavior. A dead or misleading contract consumed by the delivered demo SHALL be scored under `demo-clear-code-boundaries` exactly once even when its declaration lives in shared scene-kit source, and SHALL NOT receive a duplicate deduction in another component.

#### Scenario: Deterministic demo behavior is scored
- **WHEN** the built demo is available to the evaluator
- **THEN** deterministic browser checks exercise every demo criterion assigned to them
- **AND** the scorer applies the listed point allocations to their resolved pass/fail results

#### Scenario: Swipe start is recorded after a render
- **WHEN** a presentation records a touch start in state that only takes effect after the page renders, and navigates on a sufficiently long horizontal swipe
- **THEN** the navigation check's swipe moves the presentation one step in the swipe's direction
- **AND** a presentation with no swipe handling still records no step change from the swipe

#### Scenario: Swipes are handled with pointer events
- **WHEN** a presentation navigates on a horizontal swipe through `pointerdown` and `pointerup` handlers and ignores touch events
- **THEN** the touch swipe leaves the step unchanged and the pointer swipe moves the presentation one step in the swipe's direction
- **AND** `demo-supported-navigation` is not recorded as `fail` on account of the swipe
- **AND** the observation records that the touch path produced no change and the pointer path did

#### Scenario: No swipe input path changes the step
- **WHEN** keyboard navigation and direct jump behave correctly but neither the touch swipe nor the pointer swipe changes the step
- **THEN** `demo-supported-navigation` is recorded as not observed rather than `fail`
- **AND** the record states that both swipe paths were tried and what each produced

#### Scenario: A swipe lands on the wrong step
- **WHEN** a swipe left under either input path moves the presentation back a step or more than one step
- **THEN** `demo-supported-navigation` is recorded as `fail`

#### Scenario: Presentation opens in present mode
- **WHEN** the presentation's initial mode is present
- **THEN** opening it for evaluation preserves present mode
- **AND** caption checks explicitly enter browse mode before traversing content

#### Scenario: Presentation opens in browse mode
- **WHEN** the presentation's initial mode is browse
- **THEN** opening it for evaluation preserves browse mode
- **AND** present-mode probes explicitly enter present mode before asserting presenter behavior

#### Scenario: Presenter captions are intentionally hidden
- **WHEN** present mode intentionally hides captions that are visible in browse mode
- **THEN** the evaluator does not fail canonical-content or caption criteria from the present-mode state

#### Scenario: Semantic navigation omits optional per-control hooks
- **WHEN** the presentation exposes progress and directional navigation as accessible native controls inside stable semantic regions
- **AND** those controls do not use the evaluator's optional per-control hook spelling
- **THEN** the deterministic evaluator discovers and exercises the controls by their observable semantics

#### Scenario: Responsive chrome is inspected reproducibly
- **WHEN** the evaluator asserts browse-mode table-of-contents, progress, or directional-control visibility
- **THEN** it first establishes the suite-owned viewport
- **AND** the evidence records the observed viewport dimensions

#### Scenario: Pinned reference browser regression runs
- **WHEN** the corrected deterministic browser evaluator is tested against the real pinned reference presentation
- **THEN** it operates the real presentation modes
- **AND** every reference caption and canonical-content criterion passes

#### Scenario: Demo source integration is scored
- **WHEN** the LLM judge reviews the demo implementation
- **THEN** it returns a pass/fail verdict, rationale, and cited source evidence for every demo criterion assigned to it
- **AND** the suite-owned scorer applies the listed weights

#### Scenario: Subjective quality is not assigned to the LLM
- **WHEN** the LLM judge evaluates demo technical quality
- **THEN** it does not score visual composition, perceived transition quality, responsive visual quality, or overall polish

#### Scenario: Live demo and reusable kit are assessed separately
- **WHEN** the demo correctly calls a scene-kit behavior whose reusable implementation is defective
- **THEN** the evaluator scores the demo criterion from the correctness of its integration
- **AND** it independently scores the corresponding scene-kit criterion from the defective reusable implementation

#### Scenario: Source contradicts a deterministic token scan
- **WHEN** deterministic source evidence reports that a technical hook is missing but the delivered source implements the required semantics through an equivalent stable hook
- **THEN** the LLM judge resolves the contradiction from source behavior
- **AND** it does not inherit the token scan's verdict

#### Scenario: Demo consumes a dead shared contract
- **WHEN** the demo supplies a required public scene-kit input that the reusable implementation ignores
- **THEN** `demo-clear-code-boundaries` fails
- **AND** the same defect is not deducted again from a scene-kit criterion

#### Scenario: Browse mode shows the deck title
- **WHEN** browse mode reports browse, exposes the active step's caption, and makes every step reachable from a discovered navigation region
- **AND** its header shows the deck title rather than the active step title
- **THEN** the deterministic browse-mode criterion passes
- **AND** the chrome composition judgment is left to `mode-browse-reading-focused` and human review

#### Scenario: A table of contents is responsive by design
- **WHEN** a presentation shows its table of contents only above a candidate-chosen minimum width
- **THEN** the deterministic browse-mode criterion does not deduct for its absence at the suite-owned viewport

#### Scenario: A boundary control is hidden rather than disabled
- **WHEN** a presentation hides its previous control on the first step instead of disabling it
- **THEN** the deterministic browse-mode criterion does not deduct for the hidden control

#### Scenario: Browse-mode navigation controls are inert
- **WHEN** browse mode exposes one control per step and a next control, but activating them does not change the active step
- **THEN** the deterministic browse-mode criterion fails
- **AND** its rationale records the steps the activations actually reached

#### Scenario: A next control stops after the first step
- **WHEN** browse mode exposes no direct step controls and its next control advances only from the first step to the second
- **THEN** the deterministic browse-mode criterion fails

#### Scenario: Direct controls are inert but the next control reaches every step
- **WHEN** browse mode's direct step controls do not navigate but its next control advances through every step
- **THEN** the deterministic browse-mode criterion passes

#### Scenario: Direct controls are discovered out of step order
- **WHEN** browse mode's direct step controls each reach a different step and together reach every step, but are discovered in an order other than step order
- **THEN** the deterministic browse-mode criterion passes, because reachability is judged by the steps reached
- **AND** control order is left to the control-semantics criterion

#### Scenario: Separate controls select each mode
- **WHEN** a presentation exposes a "Present mode" control and a separate "Browse mode" control
- **THEN** the evaluator activates the control for the mode it is establishing

#### Scenario: No single mode control can be identified
- **WHEN** a presentation exposes several mode controls and none uniquely names the mode being established
- **THEN** the evaluator raises a resumable harness failure
- **AND** no criterion is deducted for the unchanged mode

#### Scenario: Present mode exposes the active step title
- **WHEN** present mode reports present and exposes the active step's title
- **THEN** the deterministic present-mode criterion passes without judging that title's visual prominence

#### Scenario: The deck title and the step title use unexpected elements
- **WHEN** the element the evaluator ranks first as a title carries the deck title
- **AND** another visible title element carries the active step title
- **THEN** the deterministic present-mode criterion passes
- **AND** the probe observation records every visible title text it considered

#### Scenario: Step titles sit in unhooked chrome elements
- **WHEN** in both modes the element the evaluator ranks first as a title carries the deck title or nothing
- **AND** each step title is visible in another title-bearing element, such as an unhooked header `<span>` or `<strong>`
- **THEN** `demo-nine-step-content-and-order` and `verification-sample-outline` pass
- **AND** a step title that no visible element exposes in either mode still fails the outline

#### Scenario: A persistent list of every title is visible
- **WHEN** a visible list shows every step title at every step
- **AND** no other element exposes the active step title
- **THEN** `demo-nine-step-content-and-order` and `verification-sample-outline` fail
- **AND** when another element does expose the active step title beside that list, both pass

#### Scenario: A present-mode title carries its step marker
- **WHEN** present mode shows a title element whose text is a nested step marker followed by the normative step title
- **THEN** the evaluator treats the active step title as exposed

#### Scenario: A deck declares its mode as data-mode
- **WHEN** a presentation declares its mode only as `data-mode="present"` or `data-mode="browse"`
- **AND** its present mode shows a visible footer paragraph that carries no recognised hook, such as the deck title
- **THEN** the evaluator reads the declared mode rather than inferring browse mode from that paragraph
- **AND** a `data-mode` with any other value, such as a theme name, or on an element that neither carries nor contains the `data-step-count` hook, such as a per-mode button, does not declare a presentation mode

#### Scenario: An undeclared mode is inferred as the wrong mode
- **WHEN** a presentation declares no mode and, after the evaluator operates its present-mode control, a visible unhooked footer paragraph leads the evaluator to infer browse mode
- **THEN** `demo-present-mode-behavior` and every other criterion whose `fail` would rest on that inferred mode are recorded as not observed rather than `fail`
- **AND** each record states the mode was inferred and lists the mode declarations the evaluator looked for

#### Scenario: A deck without a mode attribute shows a footer title paragraph in present mode
- **WHEN** a presentation declares no explicit mode attribute
- **AND** its present-mode title is a footer paragraph carrying a recognised title hook
- **THEN** the evaluator infers present mode rather than reading that paragraph as a browse caption

#### Scenario: A deck without a mode attribute shows a footer step-marker paragraph in both modes
- **WHEN** a presentation declares no explicit mode attribute
- **AND** its footer shows a paragraph carrying the step-marker hook, such as `01 / 09 · the ask`, in both modes
- **THEN** the evaluator infers present mode when no caption or table of contents is visible, rather than reading the marker paragraph as a browse caption
- **AND** the marker does not stand in for a step title: when no other visible element exposes the active step title, `demo-nine-step-content-and-order` and `verification-sample-outline` fail

#### Scenario: An unhooked step-title paragraph precedes the caption
- **WHEN** browse mode shows an unhooked step-title paragraph before the caption paragraph
- **THEN** `demo-required-scene-content` accepts the caption from the caption paragraph

#### Scenario: The demo route is reachable but unlinked
- **WHEN** the declared demo route is registered and reachable but the landing page does not link to it
- **THEN** `demo-route-and-registration` passes
- **AND** the probe observation records the discovered landing-page routes

#### Scenario: The route list carries an adapter diagnostic
- **WHEN** the browser adapter returns its own diagnostic output in place of a route list
- **THEN** the evaluator raises a resumable browser infrastructure failure
- **AND** it does not record an unregistered route or a page console failure against the candidate

#### Scenario: A normative title uses a different apostrophe
- **WHEN** a step title matches its normative text apart from a typographic apostrophe or collapsed whitespace
- **THEN** the canonical-outline comparison treats it as matching

#### Scenario: The active step is marked with aria-current="true"
- **WHEN** a navigation control marks the active step with `aria-current="true"`
- **THEN** `demo-control-semantics` accepts it as the current-step marker

#### Scenario: No scene identity is declared
- **WHEN** the presentation declares no scene identity
- **THEN** the probe observation records the scene identity as undeclared
- **AND** `demo-evolving-scene-structure` is judged on entity persistence across steps

#### Scenario: Mode changes use the presentation's own control
- **WHEN** the presentation exposes a mode control
- **THEN** the evaluator activates that control to change modes
- **AND** it uses the keyboard shortcut only when no mode control is discoverable

#### Scenario: A deduction is adjudicated from the retained artifact
- **WHEN** a reviewer audits a deterministic deduction after the run
- **THEN** the probe artifact supplies the established viewport, mode, step index and count, title, caption, chrome visibility, discovered controls, and the matched selector for each navigation role
- **AND** the reviewer does not need to replay the run to attribute the deduction

#### Scenario: A probe walks every step in both modes
- **WHEN** a probe observes each of the nine steps in present mode and again in browse mode
- **THEN** the probe artifact retains an observation for every state its verdict rests on
- **AND** the artifact reports how many observations were dropped, which is zero

#### Scenario: A control is activated the way a pointer activates it
- **WHEN** a check activates a navigation control to test whether deck keys still work
- **THEN** the control is focused before it is fired, as a pointer activation would
- **AND** a presentation that ignores deck keys while that control holds focus is observed and is not deducted for it

#### Scenario: Controls exist only in browse mode
- **WHEN** a presentation exposes its navigation controls in browse mode and none in present mode
- **THEN** the control-key check establishes browse mode and activates a control there
- **AND** the check moves focus off the control before requiring a deck key to advance

#### Scenario: The page reports no step index
- **WHEN** a state read returns no mode or no step index
- **THEN** the evaluator raises a resumable harness failure
- **AND** no criterion is deducted for the unreadable state

#### Scenario: The browser adapter differs from the one the suite was built against
- **WHEN** the installed chrome-devtools-axi build implements its wait helper or callback scoping differently
- **THEN** the evaluator still drives the browser, because it depends on neither

#### Scenario: Retained evidence is escaped once
- **WHEN** candidate text is collected as a failure and later cited as evidence
- **THEN** the retained artifact contains the text escaped at most once

### Requirement: Hard gates and official pass
The evaluation SHALL apply the following four product hard gates separately from point scoring.

| Gate criterion | Required behavior |
|---|---|
| `verification-build-whole-app` | The complete application builds successfully |
| `verification-sample-outline` | The canonical nine-step sample exists, is registered and reachable, and matches its required outline |
| `verification-every-produced-step-renders` | Every produced step renders without runtime or console errors |
| `verification-clear-outcome` | Verification produces an unambiguous machine-readable pass/fail result |

An official candidate pass SHALL require all of the following: a total score of at least 70 out of 100; at least 15 out of 24 for demo technical quality; at least 15 out of 24 for scene-kit correctness; at least 15 out of 30 for human review; no individual human rating of 1; all four hard gates passing; and successful completion of the evaluation phases required to establish those results. The presentation-skill, verification-tool, testing-evidence, and assumption-handling components SHALL have no separate minimum scores.

Before human review, a complete candidate automated result SHALL pass automated eligibility only when the automated subtotal is at least 40 out of 70, both 15-out-of-24 automated component floors are met, and all four hard gates pass. The 40-point threshold SHALL equal the 70-point official threshold minus the maximum 30 human-review points. A failed automated eligibility requirement SHALL conclusively fail the candidate without human review or an official score. An incomplete automated score, floor, or gate SHALL leave automated eligibility unavailable and SHALL NOT be converted into a product failure.

`verification-sample-outline` SHALL be derived during scoring from the final verdicts of `demo-route-and-registration` and `demo-nine-step-content-and-order`: it SHALL pass when both final verdicts are `pass`, fail when either is `fail`, and remain unobserved only while either is unresolved. A criterion's final verdict SHALL be its owner's verdict or, when not observed, its fallback judge's verdict, after any second opinion. The result SHALL retain the browser evaluator's raw outline gate beside the derived gate. The raw gate SHALL pass when both inputs pass, fail only when an input has a definite `fail`, and be unobserved otherwise; a not-observed input SHALL never produce a raw outline failure. Every hard gate SHALL be applied using its second-opinion verdict when it received one, under the failure-second-opinion capability.

Failure of a hard gate SHALL prevent an official candidate pass but SHALL NOT erase the numerical score supported by available evidence. A workflow failure, evaluation-harness failure, or pending human review that prevents the official pass contract from being evaluated SHALL make the candidate product verdict unavailable rather than converting unobserved behavior into a product failure. As a narrow exception, a reproducible product-owned inability to install dependencies, build, or serve the frozen final candidate, upheld by its second opinion, SHALL conclusively fail the applicable hard gate and candidate product verdict even when it prevents browser or human evidence from being collected. That exception SHALL preserve completed component results, leave unobserved criteria unscored, and SHALL NOT fabricate an official score or human ratings. A harness failure after an official score and verdict have been durably recorded SHALL preserve that product result under the evaluation-outcomes rules.

The reference baseline SHALL NOT receive an official candidate pass/fail verdict, candidate total threshold, component-floor gate, or human-rating gate.

#### Scenario: Candidate satisfies the official pass contract
- **WHEN** a candidate scores at least 70 overall, meets the demo, scene-kit, and human floors, has no human rating of 1, passes all four hard gates, and completes every required evaluation phase
- **THEN** the official candidate pass verdict is true

#### Scenario: Numerical threshold is missed
- **WHEN** a completed candidate scores below 70 overall
- **THEN** the official candidate pass verdict is false

#### Scenario: Component floor is missed
- **WHEN** a completed candidate scores at least 70 overall but misses the demo, scene-kit, or human-review floor
- **THEN** the official candidate pass verdict is false

#### Scenario: Candidate has no points in a floorless component
- **WHEN** a candidate earns zero points for presentation skill, verification, testing evidence, or assumption handling but otherwise satisfies the pass contract
- **THEN** that component creates no additional independent gate

#### Scenario: Hard gate fails
- **WHEN** a completed candidate fails any hard gate
- **THEN** the official candidate pass verdict is false
- **AND** the evaluator still reports the numerical score supported by available evidence

#### Scenario: Automated component floor fails before human review
- **WHEN** complete automated scoring misses either 15-out-of-24 automated component floor
- **THEN** automated eligibility fails and the candidate product verdict is conclusively `fail`
- **AND** the evaluator does not request human review or fabricate an official score

#### Scenario: Automated hard gate fails before human review
- **WHEN** complete automated scoring fails any required hard gate
- **THEN** automated eligibility fails and the candidate product verdict is conclusively `fail`
- **AND** the evaluator preserves the automated subtotal without requesting human review or fabricating an official score

#### Scenario: Product cannot install, build, or serve
- **WHEN** deterministic verification establishes that reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **AND** the failure's second opinion upholds it
- **THEN** the applicable hard gate fails and the candidate product verdict is conclusively `fail`
- **AND** the evaluator preserves available component results without assigning points or human ratings to unobserved behavior
- **AND** it reports no official score

#### Scenario: Required evaluation phase is incomplete
- **WHEN** workflow failure, harness failure, or pending human review prevents the official candidate pass contract from being evaluated
- **THEN** the evaluator does not report an official candidate pass or fail verdict
- **AND** it reports the applicable incomplete outcome separately

#### Scenario: Automated eligibility evidence is incomplete
- **WHEN** any required automated component or hard gate cannot be scored reliably
- **THEN** automated eligibility is unavailable rather than pass or fail
- **AND** the evaluator reports the owning workflow or harness failure instead of assigning a low product score

#### Scenario: Reference score is complete
- **WHEN** the reference's applicable automated and human components are complete
- **THEN** the evaluator reports its score out of 92
- **AND** it applies no official candidate pass/fail verdict or candidate component floor

#### Scenario: The outline gate follows fallback-resolved criteria
- **WHEN** `demo-route-and-registration` passes in the browser and `demo-nine-step-content-and-order` is not observed and resolved as `pass` by its fallback judge
- **THEN** the derived `verification-sample-outline` gate passes
- **AND** the result retains the browser's raw outline gate beside it

#### Scenario: An outline input stays unresolved
- **WHEN** an outline input criterion is not observed and its fallback verdict is missing
- **THEN** the derived outline gate is unobserved and automated eligibility is unavailable
- **AND** the gate is not recorded as failed

#### Scenario: An outline input is overturned
- **WHEN** `demo-nine-step-content-and-order` failed in the browser, the other outline input passed, and the criterion's overturn is accepted
- **THEN** the derived outline gate passes

### Requirement: Deterministic criteria fail only on positive evidence
A scored deterministic browser criterion SHALL have exactly three outcomes: `pass`, `fail`, and not observed. The evaluator SHALL record `fail` only when it holds positive evidence that the candidate violates the requirement the criterion enforces, such as visible text that differs from the normative text, an input that lands on the wrong step, or a browser failure raised by the page. The evaluator SHALL NOT record `fail` because it could not locate the thing it needed to inspect.

Every mode, title, caption, and navigation reading a probe relies on SHALL carry its basis, which is one of:

- **declared**: read from a recognised presentation hook or a declared mode attribute;
- **semantic**: the directly measured effect of operating a control uniquely identified by its role, accessible name, or recognised hook;
- **text**: the presence or absence of normative text across the step's full visible text and accessibility tree, which does not depend on choosing which element carries it. Text presence SHALL be judged from the normalized rendered text of visible elements, including text split across descendant elements, and from resolved accessible names, including names supplied by `aria-labelledby` references to hidden elements. A text observation that did not cover the whole presentation SHALL be treated as heuristic, because it cannot prove absence;
- **heuristic**: anything chosen by visibility or layout, including an inferred mode and a title or caption element picked without a hook.

A `fail` SHALL rest only on declared, semantic, or text readings, and on page-raised browser failures. When a probe's `fail` would rest on any heuristic reading, the criterion SHALL be recorded as not observed. The record SHALL state which reading was heuristic and what declared hooks or conventions the evaluator looked for. A heuristic reading MAY support a `pass`.

Not observed SHALL also apply when a check depends on a markup convention that the pinned fixture does not mandate, and the evaluator finds no instance of any convention it recognises. It SHALL also apply when every input path the fixture allows for a navigation input has been tried and none changes the step. Absence that the live page positively establishes SHALL remain positive evidence of a violation and SHALL be recorded as `fail`. This covers:

- in a declared or semantically established mode, a step whose full visible text and accessibility tree contain no instance of its required normative title or caption, or a normative text that appears only in a persistent list shown at every step;
- step numbering that is visibly not derived from position;
- a mode that exposes no control of the needed role, by hook, role, or accessible name;
- discovered controls whose operation produces no step change or the wrong step. An unreadable page state, an adapter diagnostic, and an ambiguous control SHALL remain resumable harness failures as already specified and SHALL NOT be recorded as not observed.

A criterion that combines a reader-visible fact with a convention-dependent fact SHALL be judged in that order: a violation of the reader-visible fact SHALL be recorded as `fail` regardless of whether the convention-dependent fact was observed. Finding a recognised convention on some steps SHALL NOT be treated as proof that a step without one lacks content: when the convention-dependent fact cannot be established for every step it concerns, that fact is not observed. A convention-dependent `fail` SHALL rest on what positively identified objects show, such as identified objects being replaced rather than persisting between steps.

A not-observed record SHALL retain the same bounded observation as any other probe, and SHALL state which conventions the evaluator looked for and that it found none.

#### Scenario: Scene objects use an attribute name the evaluator does not know
- **WHEN** the demo renders the required scene and marks its scene objects with an attribute name the evaluator does not recognise
- **THEN** `demo-evolving-scene-structure` is recorded as not observed
- **AND** no points are deducted by the deterministic evaluator for that criterion
- **AND** the record lists the conventions the evaluator looked for

#### Scenario: Captions are wrong and scene objects are not found
- **WHEN** browse mode is declared, a step's full visible text contains no instance of its normative caption, and the evaluator also finds no scene objects
- **THEN** `demo-required-scene-content` is recorded as `fail` on the caption evidence
- **AND** it is not recorded as not observed

#### Scenario: Captions are right and scene objects are not found
- **WHEN** every step's caption matches the normative caption and the evaluator finds no scene objects under any convention it recognises
- **THEN** `demo-required-scene-content` is recorded as not observed

#### Scenario: Scene objects are recognised on only some steps
- **WHEN** every caption matches and the evaluator recognises scene objects on some steps and none on others
- **THEN** `demo-required-scene-content` is recorded as not observed
- **AND** it is not recorded as `fail` for the steps where nothing was recognised

#### Scenario: Identified scene objects are replaced between steps
- **WHEN** the evaluator identifies scene objects on consecutive steps and none of the identified objects persists from one step to the next
- **THEN** `demo-evolving-scene-structure` is recorded as `fail` on that evidence

#### Scenario: A reader-visible element is hidden
- **WHEN** the presentation declares present mode and hides its active step title from readers, so that no visible element at that step shows it
- **THEN** `demo-present-mode-behavior` is recorded as `fail`
- **AND** it is not recorded as not observed

#### Scenario: Scene objects are found
- **WHEN** the evaluator finds scene objects under a convention it recognises
- **THEN** the scene criteria are judged `pass` or `fail` from what it observed
- **AND** no fallback judge is consulted for them

#### Scenario: A declared mode contradicts the mode being established
- **WHEN** the evaluator operates a present-mode control and the presentation's declared mode attribute still reads `browse`
- **THEN** `demo-present-mode-behavior` is recorded as `fail` on that declared reading

#### Scenario: A caption is read from an unhooked element
- **WHEN** browse mode is declared and the evaluator can identify a caption only by layout, and that element's text differs from the normative caption
- **AND** the normative caption text appears elsewhere in the step's visible text
- **THEN** no caption criterion is recorded as `fail` on the layout-chosen element's text

#### Scenario: The normative caption appears nowhere
- **WHEN** browse mode is declared and a step's full visible text and accessibility tree contain no instance of its normative caption
- **THEN** `demo-required-scene-content` is recorded as `fail` on that text evidence

#### Scenario: A step title is missing only under an inferred mode
- **WHEN** a presentation declares no mode, the evaluator infers present mode, and no visible element shows the active step title
- **THEN** `demo-present-mode-behavior` is recorded as not observed rather than `fail`

#### Scenario: A caption is split across nested elements
- **WHEN** browse mode is declared and a step's normative caption is rendered across several nested inline elements
- **THEN** the caption is present by text
- **AND** no caption criterion is recorded as `fail` for its absence

#### Scenario: A title is announced through a hidden label
- **WHEN** a presentation exposes the active step title only as an accessible name supplied by `aria-labelledby` pointing at a visually hidden element
- **THEN** the title is present by text
- **AND** the title criterion is not recorded as `fail` for its absence

#### Scenario: Navigation has no operable control
- **WHEN** neither mode exposes any control with a navigation role, accessible name, or recognised hook
- **THEN** the criterion that requires the control is recorded as `fail`

### Requirement: Declared fallback judge for not-observed criteria
The automated rubric SHALL declare, for each deterministic criterion that can be recorded as not observed, at most one fallback judge. Because any deterministic browser criterion can be recorded as not observed when its `fail` would rest on a heuristic reading, every deterministic browser criterion SHALL declare the `demo-integration` judge as its fallback. Adding these declarations SHALL change the rubric version and hash, and SHALL NOT change any criterion, owner, subcomponent, point allocation, or threshold. The fallback declaration SHALL NOT make the fallback judge an owner of the criterion: the criterion SHALL keep its single owning evaluator, its identifier, and its points, and the rubric SHALL continue to reject duplicate criterion ownership. A deterministic criterion with no declared fallback SHALL NOT be recordable as not observed by a conforming evaluator; if one is nevertheless returned, scoring SHALL treat its component as incomplete.

When a criterion with a declared fallback is recorded as not observed, the harness SHALL ask the declared fallback judge for a verdict on that criterion in that run only. The judge SHALL receive the criterion's requirement and guidance, the bounded browser observation, and the statement of which conventions were looked for. The judge SHALL return `pass` or `fail` with a rationale. A `pass` SHALL cite delivered candidate source that establishes the requirement; a `pass` without such a citation SHALL be rejected as invalid judge output. The judge SHALL treat the browser observation as a lead rather than an authoritative verdict, consistent with existing source-review rules.

Exact criterion coverage SHALL continue to hold in both directions for every evaluator. In a run with not-observed criteria, the fallback judge's expected criterion set SHALL be its owned criteria plus exactly the not-observed criteria that name it as fallback; a fallback verdict for a criterion that was observed, or a missing fallback verdict, SHALL be invalid coverage.

Points SHALL only ever be awarded from a binary `pass` or `fail` verdict; not observed is an unresolved state, never a scored verdict. The scorer SHALL award a fallback-resolved criterion the same points it would award for the same verdict from its owner. It SHALL record, for every scored criterion, whether the verdict came from the owning evaluator or from the fallback judge, and SHALL retain the fallback judge's source citations. An unresolved criterion SHALL make only its own subcomponent and component incomplete; other deterministic subcomponents SHALL keep their scores. When the fallback verdict is missing after the judge's retry budget is exhausted, the criterion's component SHALL be incomplete and the existing missing-judge-output outcome SHALL apply; a missing fallback verdict SHALL never be scored as `fail`.

Hard-gate handling of unobserved evidence SHALL NOT change, except that `verification-sample-outline` is derived from its input criteria's final verdicts as specified under "Hard gates and official pass". Hard gates SHALL NOT have fallback judges. A failed hard gate's second opinion SHALL be governed by the failure-second-opinion capability; it is not a fallback judge and SHALL NOT resolve an unobserved gate.

#### Scenario: A not-observed criterion is resolved by its fallback judge
- **WHEN** `demo-evolving-scene-structure` is recorded as not observed and its declared fallback judge returns `pass` citing the delivered source that keeps scene objects across steps
- **THEN** the criterion is awarded its full points
- **AND** the score records that the verdict came from the fallback judge
- **AND** the evaluation proceeds without waiting for a maintainer

#### Scenario: The fallback judge finds the requirement unmet
- **WHEN** a criterion is recorded as not observed and its fallback judge returns `fail` with a rationale
- **THEN** the criterion is awarded no points
- **AND** the score records that the verdict came from the fallback judge

#### Scenario: A fallback pass cites no source
- **WHEN** the fallback judge returns `pass` for a not-observed criterion without citing delivered candidate source
- **THEN** the harness rejects the output as invalid judge output
- **AND** the criterion is not awarded points on that output

#### Scenario: The fallback verdict never arrives
- **WHEN** a criterion is recorded as not observed and the fallback judge produces no valid verdict within its retry budget
- **THEN** the criterion's component is incomplete
- **AND** the criterion is not scored as `fail`

#### Scenario: One unresolved criterion does not erase its siblings
- **WHEN** one deterministic criterion is not observed and unresolved, and every other deterministic criterion was observed
- **THEN** only the subcomponent containing the unresolved criterion is incomplete
- **AND** the other deterministic subcomponents report their awarded points

#### Scenario: A fallback judge answers for an observed criterion
- **WHEN** a judge returns a verdict for a deterministic criterion that the browser evaluator observed
- **THEN** scoring rejects the judge output as invalid criterion coverage

#### Scenario: A candidate suppresses hooks to avoid a browser failure
- **WHEN** a candidate removes every recognised scene-object hook and its source does not keep scene objects across steps
- **THEN** the criterion is recorded as not observed and the fallback judge returns `fail`
- **AND** the candidate gains no points by having hidden the hooks

#### Scenario: A criterion without a fallback cannot be observed
- **WHEN** a deterministic criterion with no declared fallback is returned as not observed
- **THEN** its component is incomplete
- **AND** the official verdict is unavailable rather than failed

#### Scenario: A navigation criterion is not observed
- **WHEN** `demo-supported-navigation` is recorded as not observed because no swipe input path changed the step
- **THEN** the `demo-integration` judge is asked for its verdict on that criterion in that run
- **AND** the judge receives the observation stating which swipe paths were tried

#### Scenario: The rubric gains fallback declarations
- **WHEN** the rubric with the added fallback declarations is loaded
- **THEN** every deterministic browser criterion names one fallback judge
- **AND** every criterion's owner, points, and subcomponent are unchanged, while the rubric version and hash differ from the prior rubric
