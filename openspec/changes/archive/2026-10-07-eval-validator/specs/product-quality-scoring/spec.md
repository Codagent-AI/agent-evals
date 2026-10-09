## MODIFIED Requirements
### Requirement: Official product score
The evaluation SHALL calculate a candidate implementation-quality score out of 100 from the following components. Automated criteria SHALL award points only from binary pass/fail verdicts. A deterministic evaluator MAY report a criterion as not observed; that criterion is unresolved until a declared fallback judge supplies a pass/fail verdict. For every table row that lists multiple criteria, the row's points SHALL be divided equally among those criteria; the scorer SHALL NOT round intermediate values.

| Candidate component | Points |
|---|---:|
| Demo presentation technical quality | 20 |
| Scene kit correctness | 20 |
| Presentation skill correctness | 7 |
| Verification tool correctness | 7 |
| Engineering quality beyond the spec | 8 |
| Testing-evidence quality | 4 |
| Assumption-handling quality | 4 |
| Human review | 30 |

Generic Runner health, workflow completion, build orchestration, cost, timing, retries, and evaluator-owned evidence repair SHALL award or deduct no points. Candidate testing evidence and assumption handling SHALL affect points only through their defined four-point components.

Before candidate human review is complete, the evaluation SHALL report the automated subtotal out of 70 and SHALL NOT report an official score. A candidate SHALL remain eligible for human review only when its complete automated subtotal is at least 40 out of 70, both automated component floors are met, and all four hard gates pass. Failure of any of those complete automated requirements SHALL produce a conclusive product-fail verdict without asking for human review, because no human result can make the candidate pass. A conclusive product-owned inability to install, build, or serve SHALL follow the hard-gate exception below. When product evidence is available for only part of an unsuccessful or incomplete run, the evaluation SHALL preserve completed component evidence without treating unobserved criteria as product failures.

The reference baseline SHALL be evaluated only on the components shared with the candidate:

| Reference component | Applicability | Points |
|---|---|---:|
| Demo presentation technical quality | Applicable | 20 |
| Scene kit correctness | Applicable | 20 |
| Presentation skill correctness | Applicable | 7 |
| Verification tool correctness | Applicable | 7 |
| Engineering quality beyond the spec | Applicable | 8 |
| Testing-evidence quality | Not applicable | 0 |
| Assumption-handling quality | Not applicable | 0 |
| Human review | Applicable | 30 |

The reference SHALL therefore have a score denominator of 92 without rescaling. Before its human review is complete, it SHALL report an applicable automated subtotal out of 62. After human review, it SHALL report its score out of 92 without an official candidate pass/fail verdict. Candidate reports SHALL retain the candidate's official score out of 100 and SHALL separately compare the candidate and reference on the shared 92 points.

When the user explicitly approves a post-run technical adjudication, the harness SHALL preserve the raw automated criterion and component scores, record the approver, time, rationale, consequential findings, and replacement scores for exactly the five shared technical components, and recalculate the automated subtotal using those five replacement scores plus the unchanged raw scores of every other applicable automated component. It MAY additionally replace exactly the two workflow-quality component scores and/or explicitly adjudicate all four observed hard-gate verdicts when the technical review found a deterministic harness defect. It SHALL preserve every raw gate verdict, record the prior and revised gate sets, recalculate the official candidate score from the revised subtotal and applicable human-review score, recalculate the complete pass contract and product verdict, and recalculate the shared-92 comparison using only the five shared replacement scores and applicable human-review scores. An adjudication SHALL NOT masquerade as a new automated judge result or silently replace the raw score or gate evidence. For each gate whose verdict the adjudication changes, the harness SHALL preserve the gate's original rationale and evidence as raw fields and SHALL set its current rationale and evidence to the adjudication's, so a revised verdict is never recorded or reported beside the rationale of the verdict it replaced. Reports SHALL render the revised gate record as current and label the preserved harness output as raw adjudication data.

#### Scenario: A deterministic hard gate is technically adjudicated
- **WHEN** a user-approved technical review proves that a harness defect produced an incorrect observed gate verdict
- **THEN** the adjudication supplies verdicts for exactly all four recorded hard gates
- **AND** the result preserves the raw gate verdicts and records the prior and revised sets
- **AND** the harness recalculates threshold, floor, rating, and hard-gate pass failures plus the product verdict

#### Scenario: An adjudicated gate keeps its harness output as raw data
- **WHEN** a technical adjudication changes a recorded hard-gate verdict
- **THEN** the gate's original rationale and evidence are preserved as raw fields
- **AND** its current rationale and evidence describe the adjudicated record
- **AND** the report shows the revised record as current and labels the harness output as raw adjudication data

#### Scenario: Complete product score
- **WHEN** all seven automated candidate components and human review have completed successfully
- **THEN** the evaluator reports every component score and their sum out of 100

#### Scenario: Human review is pending
- **WHEN** candidate automated scoring has completed, the subtotal is at least 40 out of 70, both automated component floors are met, all four hard gates pass, and human review has not
- **THEN** the evaluator reports the automated subtotal out of 70
- **AND** it does not report an official candidate score or pass verdict

#### Scenario: Automated subtotal cannot reach the official threshold
- **WHEN** complete candidate automated scoring produces 37 out of 70
- **THEN** the evaluator records `product_verdict=fail` and explains `Automated score below minimum: 37/70; required 40/70`
- **AND** it does not request human review or report an official score out of 100

#### Scenario: Automated subtotal exactly reaches eligibility
- **WHEN** complete candidate automated scoring produces exactly 40 out of 70, both automated component floors are met, and all four hard gates pass
- **THEN** the evaluator records the candidate as eligible for human review
- **AND** it does not issue an official score or product verdict before that review

#### Scenario: Harness activity does not change product points
- **WHEN** evidence repair, retries, workflow execution, pricing, or other generic harness activity occurs
- **THEN** that activity is recorded diagnostically
- **AND** it neither awards nor deducts points outside the defined testing-evidence and assumption-handling criteria

#### Scenario: Partial product evidence is preserved
- **WHEN** a workflow or evaluation-harness failure prevents some criteria from being observed
- **THEN** the evaluator preserves completed evidence and component results
- **AND** it marks the remaining score incomplete rather than assigning failures to unobserved criteria

#### Scenario: Reference automated evaluation is pending human review
- **WHEN** all applicable automated reference components are complete but human review is not
- **THEN** the evaluator reports the reference subtotal out of 62
- **AND** it marks testing evidence and assumption handling not applicable

#### Scenario: Complete reference score
- **WHEN** the recreated reference's applicable automated components and human review are complete
- **THEN** the evaluator reports its score out of 92 without rescaling
- **AND** it does not issue an official candidate pass/fail verdict for the reference

#### Scenario: Reference baseline uses the same product rubric
- **WHEN** the existing implementation is evaluated as a reference baseline
- **THEN** the evaluator applies the same automated criteria, human questions, weights, gates, thresholds, rubric versions, and score calculation used for Agent Runner candidates on every component shared with the candidate
- **AND** it marks the candidate-only components not applicable rather than scoring them against the reference

#### Scenario: Shared comparison is reported
- **WHEN** both the reference and candidate have complete applicable scores
- **THEN** the candidate report retains its official score out of 100
- **AND** it separately reports candidate-versus-reference component and total differences on the shared 92 points

#### Scenario: User approves technical adjudication
- **WHEN** the user explicitly approves revised scores for all five shared technical components after independently reviewing a completed candidate
- **THEN** the harness preserves the raw automated score and records the approved adjudication separately
- **AND** it recalculates the automated subtotal from the approved shared replacements and unchanged non-shared scores
- **AND** it recalculates the official score and shared-92 comparison from their applicable components

### Requirement: Demo presentation technical quality
The evaluation SHALL score the delivered demo presentation out of 20 using the following rubric. Deterministic browser evaluation SHALL inspect the built, running demo. LLM source review SHALL inspect the delivered source and supporting evidence. The LLM SHALL assess technical implementation and SHALL NOT assess visual taste, perceived motion quality, or responsive aesthetics, which belong to human review.

| Subcomponent | Points | Evaluator | Criteria |
|---|---:|---|---|
| Canonical content, routing, and technical structure | 4 | Deterministic browser | `demo-route-and-registration`, `demo-nine-step-content-and-order`, `demo-required-scene-content`, `demo-evolving-scene-structure`, `quality-captions-and-navigation` |
| Navigation, modes, boundaries, and controls | 4 | Deterministic browser | `demo-present-mode-behavior`, `demo-browse-mode-behavior`, `demo-mode-position-preservation`, `demo-supported-navigation`, `demo-navigation-boundaries-and-control-keys` |
| Runtime reliability and accessibility baseline | 3 | Deterministic browser | `demo-step-and-transition-reliability`, `demo-mode-interaction-reliability`, `demo-control-semantics`, `demo-focus-and-keyboard-accessibility` |
| Uses scene-kit APIs without bypassing or duplicating them | 4 | LLM source review | `demo-scene-kit-api-use` |
| Uses stable identities and appropriate grouped-scene architecture | 3 | LLM source review | `demo-stable-identity-and-grouping` |
| Maintains clear boundaries and scope discipline | 2 | LLM source review | `demo-clear-code-boundaries`, `quality-active-chrome-and-attribution-local`, `demo-scope-discipline` |

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

### Requirement: Scene kit correctness
The evaluation SHALL score the reusable scene kit out of 20 using LLM review of delivered source and structured browser evidence. The judge SHALL assess implementation of the technical contracts rather than the aesthetic quality of the demo that uses them.

For transition sequencing, the judge SHALL require persisting motion and newcomer delay to share one settlement contract or executable proof that newcomers wait until continuing entities settle; the presence of timing constants or named primitives alone SHALL NOT earn credit. Sharing or importing a timing value SHALL be insufficient unless persistent motion consumes that exact configuration, or newcomer admission waits on an observable completion signal from persistent motion. Newcomer sequencing SHALL follow the fixture design's timing mechanism: a newcomer entry delay at least as long as the continuing layout transition, applied to the newcomer only, SHALL satisfy `entity-newcomer-after-settle`; the same delay applied to the continuing motion, an entry that can start early, or no entry motion SHALL fail it. A step id SHALL be stable only when it survives inserting, removing, or reordering steps; a position-derived id fails `scene-step-narration-and-identity`. Newcomer timing SHALL be judged on the visible entry, so a zero-delay wrapper around an inner node whose entry is delayed past the layout transition passes. A warning SHALL identify an element by its visible text, or for a textless element by its accessible name, a stable hook, or a selector path. In present mode the marker is a visible indicator of the active step's position or section beside the title. Uniform fit SHALL be judged at the eval-owned reference viewports 1280×720 and 390×844 in both modes. Touch navigation SHALL be judged against the fixture scenario only: a horizontal swipe to the left advances one step and a swipe to the right goes back one step. The judge SHALL NOT require rejection of vertical scrolling or multi-touch gestures, which the fixture does not state.

The step number SHALL count as on screen only when it is rendered visibly; an `aria-label`, other attribute, or visually hidden text SHALL NOT satisfy `scene-order-derived-numbering`. The default attribution SHALL link to the and-scene GitHub repository, `https://github.com/Codagent-AI/and-scene`; a link to another owner or repository path SHALL fail `attribution-default-link`. The deterministic attribution fact SHALL report the GitHub targets the source contains so the judge sees a wrong target by name. No network request decides the link; a reachability probe would make identical evidence score differently.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Step model, stable identity, and typed boundary | 3 | `scene-step-narration-and-identity`, `scene-order-derived-numbering`, `scene-typed-payload-boundary` |
| Entity transitions and persistent grouped scenes | 6 | `entity-persisting-morph`, `entity-newcomer-after-settle`, `entity-departing-exit`, `grouped-scene-updates-in-place`, `grouped-continuing-entities-not-newcomers`, `grouped-intentional-composition` |
| Present/browse modes, navigation, controls, and boundaries | 5 | `mode-present-title-focused`, `mode-browse-reading-focused`, `mode-toggle-preserves-position`, `navigation-keyboard`, `navigation-touch-swipe`, `navigation-direct-jump`, `navigation-active-state`, `navigation-controls-keep-keys`, `navigation-clamp-start`, `navigation-clamp-end` |
| Fixed-canvas behavior | 2 | `canvas-uniform-scaling`, `canvas-default-dimensions` |
| Style ownership, hooks, framework neutrality, and attribution | 4 | `style-kit-hooks`, `style-unstyled-kit-output`, `style-framework-optional`, `style-coordinate-heavy-diagrams`, `attribution-default-link`, `attribution-styling-hook`, `attribution-top-left-opt-in` |

#### Scenario: Scene-kit contracts are scored
- **WHEN** the LLM judge evaluates the reusable scene kit
- **THEN** it returns a pass/fail verdict, rationale, and cited evidence for every listed scene-kit criterion
- **AND** the scorer divides each subcomponent's points equally among that subcomponent's criteria

#### Scenario: Technical continuity is distinguished from perceived quality
- **WHEN** the judge evaluates entity identity, grouping, or transition implementation
- **THEN** it scores whether the required technical mechanism and behavior are present
- **AND** it leaves perceived transition smoothness and visual composition quality to human review

#### Scenario: Newcomer timing is disconnected from persistent motion
- **WHEN** the kit delays newcomers using a duration that is not applied to persistent layout motion and supplies no executable settlement proof
- **THEN** `entity-newcomer-after-settle` fails

#### Scenario: Horizontal swipe navigation is credited
- **WHEN** the kit maps a left swipe to the next step and a right swipe to the previous step through its navigation
- **THEN** `navigation-touch-swipe` passes
- **AND** the absence of vertical-scroll or multi-touch rejection does not fail it

#### Scenario: Step number exists only as an accessible name
- **WHEN** the position-derived step number appears only in an `aria-label`
- **THEN** `scene-order-derived-numbering` fails

#### Scenario: Attribution links to a guessed repository
- **WHEN** the default attribution links to a GitHub path other than `https://github.com/Codagent-AI/and-scene`
- **THEN** `attribution-default-link` fails

### Requirement: Existing criterion disposition
The revised rubric SHALL classify each of the 68 legacy rubric criteria exactly once. It SHALL retain 59 as directly scored product criteria, use four exclusively as hard gates, remove three from scoring, and replace two presentation-skill evidence criteria with the broader testing-evidence criteria. It SHALL additionally define `verification-preview-process-ownership` as one new directly scored product criterion so preview ownership is not charged against the legacy IPv4-addressing criterion.

| Disposition | Count | Criteria |
|---|---:|---|
| Demo presentation technical quality | 2 | `quality-captions-and-navigation`, `quality-active-chrome-and-attribution-local` |
| Scene kit correctness | 28 | `scene-step-narration-and-identity`, `scene-order-derived-numbering`, `scene-typed-payload-boundary`, `entity-persisting-morph`, `entity-newcomer-after-settle`, `entity-departing-exit`, `grouped-scene-updates-in-place`, `grouped-continuing-entities-not-newcomers`, `grouped-intentional-composition`, `style-kit-hooks`, `style-unstyled-kit-output`, `style-framework-optional`, `style-coordinate-heavy-diagrams`, `attribution-default-link`, `attribution-styling-hook`, `attribution-top-left-opt-in`, `mode-present-title-focused`, `mode-browse-reading-focused`, `mode-toggle-preserves-position`, `navigation-keyboard`, `navigation-touch-swipe`, `navigation-direct-jump`, `navigation-active-state`, `navigation-controls-keep-keys`, `navigation-clamp-start`, `navigation-clamp-end`, `canvas-uniform-scaling`, `canvas-default-dimensions` |
| Presentation skill correctness | 18 | `skill-missing-details-one-at-a-time`, `skill-partial-detail-proceeds`, `skill-complete-prompt-proceeds`, `skill-empty-directory-scaffold`, `skill-already-scaffolded`, `skill-partial-scaffold`, `skill-scaffold-style-neutral`, `skill-template-path-resolution`, `skill-monorepo-target`, `skill-standalone-target`, `skill-nonempty-confirmation`, `skill-new-presentation-routed`, `skill-presentation-owns-style`, `skill-existing-presentations-preserved`, `skill-modify-ambiguous-target`, `skill-scoped-modification`, `skill-checks-run-before-done`, `skill-failures-fixed-before-success` |
| Verification tool correctness | 12 | `quality-project-local-screenshot-helper`, `verification-missing-sample-fails`, `verification-ipv4-loopback`, `verification-preview-process-ownership`, `verification-console-page-error-fails`, `verification-step-error-fails`, `visual-helper-captures-steps`, `visual-helper-settled-screenshots`, `visual-helper-overlap-warning`, `visual-helper-allow-overlap`, `visual-helper-active-state-warning`, `visual-helper-attribution-warning` |
| Hard gates | 4 | `verification-build-whole-app`, `verification-sample-outline`, `verification-every-produced-step-renders`, `verification-clear-outcome` |
| Replaced by testing-evidence quality | 2 | `quality-visual-composition-inspected`, `quality-visual-warnings-reviewed` |
| Removed from scoring | 3 | `skill-optional-ascii-mockup`, `quality-builds-clean`, `quality-renders-without-errors` |

The replaced concerns SHALL remain observable through the testing-evidence criteria and SHALL NOT be scored under their legacy identifiers. The revised rubric SHALL additionally define four testing-evidence and four assumption-handling criteria, each assigned exactly once to its focused judge. It SHALL additionally define the sixteen engineering-quality criteria listed by the engineering-quality-scoring capability, each assigned exactly once to the engineering-quality component and none counted among the 68 legacy criteria.

#### Scenario: Existing criteria are completely classified
- **WHEN** the revised rubric is validated
- **THEN** all 68 legacy criterion IDs appear in exactly one disposition
- **AND** the disposition counts are 59 directly scored, four gates, two replaced, and three removed

#### Scenario: New workflow-quality criteria are classified
- **WHEN** the revised rubric is validated
- **THEN** four testing-evidence and four assumption-handling criteria appear exactly once
- **AND** none duplicates a replaced legacy criterion

#### Scenario: Preview ownership has an explicit criterion
- **WHEN** the revised rubric is validated
- **THEN** `verification-preview-process-ownership` appears exactly once under verification-tool correctness
- **AND** it is not counted among the 68 legacy criteria

#### Scenario: Optional behavior is not scored
- **WHEN** the skill does not produce an ASCII mockup
- **THEN** the implementation-quality score is unchanged

#### Scenario: Visual evidence concerns are not double-counted
- **WHEN** visual inspection or warning-review evidence is evaluated
- **THEN** the testing-evidence criteria determine the applicable points
- **AND** the replaced presentation-skill criteria award no additional points

#### Scenario: Removed duplicate criteria are not double-counted
- **WHEN** build or every-step rendering is evaluated
- **THEN** the applicable hard gate determines pass eligibility
- **AND** no duplicate point criterion awards or deducts points for the same baseline outcome

#### Scenario: Engineering-quality criteria are classified
- **WHEN** the revised rubric is validated
- **THEN** each of the sixteen engineering-quality criteria appears exactly once, under the engineering-quality component
- **AND** none is counted among the 68 legacy criteria or duplicates an existing criterion identifier

### Requirement: Hard gates and official pass
The evaluation SHALL apply the following four product hard gates separately from point scoring.

| Gate criterion | Required behavior |
|---|---|
| `verification-build-whole-app` | The complete application builds successfully |
| `verification-sample-outline` | The canonical nine-step sample exists, is registered and reachable, and matches its required outline |
| `verification-every-produced-step-renders` | Every produced step renders without runtime or console errors |
| `verification-clear-outcome` | Verification produces an unambiguous machine-readable pass/fail result |

An official candidate pass SHALL require all of the following: a total score of at least 70 out of 100; at least 12.5 out of 20 for demo technical quality; at least 12.5 out of 20 for scene-kit correctness; at least 15 out of 30 for human review; no individual human rating of 1; all four hard gates passing; and successful completion of the evaluation phases required to establish those results. The presentation-skill, verification-tool, engineering-quality, testing-evidence, and assumption-handling components SHALL have no separate minimum scores.

Before human review, a complete candidate automated result SHALL pass automated eligibility only when the automated subtotal is at least 40 out of 70, both 12.5-out-of-20 automated component floors are met, and all four hard gates pass. The 40-point threshold SHALL equal the 70-point official threshold minus the maximum 30 human-review points. A failed automated eligibility requirement SHALL conclusively fail the candidate without human review or an official score. An incomplete automated score, floor, or gate SHALL leave automated eligibility unavailable and SHALL NOT be converted into a product failure.

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
- **WHEN** a candidate earns zero points for presentation skill, verification, engineering quality, testing evidence, or assumption handling but otherwise satisfies the pass contract
- **THEN** that component creates no additional independent gate

#### Scenario: Hard gate fails
- **WHEN** a completed candidate fails any hard gate
- **THEN** the official candidate pass verdict is false
- **AND** the evaluator still reports the numerical score supported by available evidence

#### Scenario: Automated component floor fails before human review
- **WHEN** complete automated scoring misses either 12.5-out-of-20 automated component floor
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

### Requirement: Controlled scoring and rubric provenance
The suite-owned scorer SHALL own criterion identifiers, evaluator assignments, point allocations, component applicability, score denominators, hard gates, thresholds, and final calculations. Neither an LLM judge nor the human-review interface SHALL change those policies while producing evaluation results. Every machine-evaluated criterion result SHALL include its identifier, pass/fail verdict, rationale, and cited verified evidence.

For candidates, the evaluator SHALL run seven focused scored judge jobs: demo integration, scene kit, presentation skill, verification tooling, engineering quality, testing evidence, and assumption handling. For references, it SHALL run the five applicable implementation source-review jobs and SHALL omit testing-evidence and assumption-handling judging as not applicable. Each applicable job SHALL return exactly the criteria assigned to it and no others. Missing, duplicated, unknown, malformed, or cross-job criterion output from an applicable job SHALL fail scoring rather than change a denominator, silently ignore a criterion, or reuse output from another job.

The five implementation source-review jobs SHALL receive a neutral source snapshot that retains relevant product source and approved requirements while stripping Git metadata, remotes, branch names, pull-request identity, baseline or candidate labels, OpenSpec change identity, and evaluation markers. The harness SHALL materialize the approved normative requirement descriptions and scenarios as a separate neutral requirements bundle, omit their original change path and change name, and record the bundle's source and content hash. The original OpenSpec change directory SHALL NOT be exposed to those five judges. The testing-evidence and assumption-handling judges SHALL receive the verified workflow and revision provenance required by their assigned criteria. Candidate source and evidence SHALL be treated as untrusted data, not instructions.

The automated product rubric and human-review rubric SHALL have distinct explicit version identifiers. The result SHALL record each rubric's version and SHA-256 hash, every component's applicability, and the applicable candidate or reference denominator.

#### Scenario: Judge returns findings but does not control scoring
- **WHEN** every focused judge returns exactly its assigned criteria with valid verdicts, rationales, and evidence
- **THEN** the suite-owned scorer applies the fixed assignments and weights
- **AND** it calculates the applicable candidate or reference score

#### Scenario: Required judge output is missing
- **WHEN** any scored judge job required for the applicable candidate or reference mode produces no valid output
- **THEN** rubric validation fails
- **AND** no official score or verdict is produced from incomplete judge coverage

#### Scenario: Reference omits non-applicable workflow judges
- **WHEN** a reference evaluation runs scored judging
- **THEN** it runs the five implementation source-review jobs
- **AND** it omits testing-evidence and assumption-handling jobs and records those components as not applicable

#### Scenario: Criterion coverage is invalid
- **WHEN** evaluator output contains a missing, duplicate, unknown, malformed, or cross-job criterion result
- **THEN** rubric validation fails
- **AND** the scorer does not change the denominator or silently ignore the invalid output

#### Scenario: Product source judge reviews a candidate
- **WHEN** one of the five implementation source-review jobs is invoked
- **THEN** it receives the neutral source snapshot, neutral requirements bundle, and assigned rubric slice
- **AND** it receives no Git, branch, PR, baseline, candidate, change, or evaluation identity signal

#### Scenario: Evidence judge requires revision provenance
- **WHEN** the testing-evidence or assumption-handling judge evaluates workflow behavior
- **THEN** it receives the verified evidence and revision provenance required by its criteria
- **AND** that provenance is not stripped as a product-identity neutralization step

#### Scenario: Rubric provenance is recorded
- **WHEN** an evaluation result is written
- **THEN** it records distinct version identifiers and SHA-256 hashes for the automated and human-review rubrics
- **AND** it records component applicability and the score denominator

#### Scenario: The engineering-quality job runs for candidates and references
- **WHEN** scored judging runs for a candidate or for the reference baseline
- **THEN** the engineering-quality job runs with the neutral source snapshot, neutral requirements bundle, and its rubric slice
- **AND** it returns exactly the criteria assigned to it
