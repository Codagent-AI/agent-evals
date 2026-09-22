## MODIFIED Requirements

### Requirement: Official product score
The evaluation SHALL calculate a candidate implementation-quality score out of 100 from the following components. Automated criteria SHALL award points only from binary pass/fail verdicts. A deterministic evaluator MAY report a criterion as not observed; that criterion is unresolved until a declared fallback judge supplies a pass/fail verdict. For every table row that lists multiple criteria, the row's points SHALL be divided equally among those criteria; the scorer SHALL NOT round intermediate values.

| Candidate component | Points |
|---|---:|
| Demo presentation technical quality | 24 |
| Scene kit correctness | 24 |
| Presentation skill correctness | 7 |
| Verification tool correctness | 7 |
| Testing-evidence quality | 4 |
| Assumption-handling quality | 4 |
| Human review | 30 |

Generic Runner health, workflow completion, build orchestration, cost, timing, retries, and evaluator-owned evidence repair SHALL award or deduct no points. Candidate testing evidence and assumption handling SHALL affect points only through their defined four-point components.

Before candidate human review is complete, the evaluation SHALL report the automated subtotal out of 70 and SHALL NOT report an official score. A candidate SHALL remain eligible for human review only when its complete automated subtotal is at least 40 out of 70, both automated component floors are met, and all four hard gates pass. Failure of any of those complete automated requirements SHALL produce a conclusive product-fail verdict without asking for human review, because no human result can make the candidate pass. A conclusive product-owned inability to install, build, or serve SHALL follow the hard-gate exception below. When product evidence is available for only part of an unsuccessful or incomplete run, the evaluation SHALL preserve completed component evidence without treating unobserved criteria as product failures.

The reference baseline SHALL be evaluated only on the components shared with the candidate:

| Reference component | Applicability | Points |
|---|---|---:|
| Demo presentation technical quality | Applicable | 24 |
| Scene kit correctness | Applicable | 24 |
| Presentation skill correctness | Applicable | 7 |
| Verification tool correctness | Applicable | 7 |
| Testing-evidence quality | Not applicable | 0 |
| Assumption-handling quality | Not applicable | 0 |
| Human review | Applicable | 30 |

The reference SHALL therefore have a score denominator of 92 without rescaling. Before its human review is complete, it SHALL report an applicable automated subtotal out of 62. After human review, it SHALL report its score out of 92 without an official candidate pass/fail verdict. Candidate reports SHALL retain the candidate's official score out of 100 and SHALL separately compare the candidate and reference on the shared 92 points.

When the user explicitly approves a post-run technical adjudication, the harness SHALL preserve the raw automated criterion and component scores, record the approver, time, rationale, consequential findings, and replacement scores for exactly the four shared technical components, and recalculate the automated subtotal using those four replacement scores plus the unchanged raw scores of every other applicable automated component. It MAY additionally replace exactly the two workflow-quality component scores and/or explicitly adjudicate all four observed hard-gate verdicts when the technical review found a deterministic harness defect. It SHALL preserve every raw gate verdict, record the prior and revised gate sets, recalculate the official candidate score from the revised subtotal and applicable human-review score, recalculate the complete pass contract and product verdict, and recalculate the shared-92 comparison using only the four shared replacement scores and applicable human-review scores. An adjudication SHALL NOT masquerade as a new automated judge result or silently replace the raw score or gate evidence. For each gate whose verdict the adjudication changes, the harness SHALL preserve the gate's original rationale and evidence as raw fields and SHALL set its current rationale and evidence to the adjudication's, so a revised verdict is never recorded or reported beside the rationale of the verdict it replaced. Reports SHALL render the revised gate record as current and label the preserved harness output as raw adjudication data.

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
- **WHEN** all six automated candidate components and human review have completed successfully
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
- **WHEN** the user explicitly approves revised scores for all four shared technical components after independently reviewing a completed candidate
- **THEN** the harness preserves the raw automated score and records the approved adjudication separately
- **AND** it recalculates the automated subtotal from the approved shared replacements and unchanged non-shared scores
- **AND** it recalculates the official score and shared-92 comparison from their applicable components

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

The deterministic evaluator SHALL preserve the presentation's initial mode when opening it. Before traversing captions and canonical content, it SHALL explicitly enter browse mode. Before a mode-specific probe, it SHALL explicitly enter that probe's required present or browse mode. It SHALL NOT treat captions intentionally hidden in present mode as missing content. It SHALL change modes through a presentation-exposed mode control when one is discoverable, and SHALL fall back to a keyboard shortcut only when no such control exists. When a presentation exposes more than one mode control, the evaluator SHALL select the control for the mode it is establishing; when it cannot identify exactly one such control, it SHALL raise a resumable harness failure rather than record the unchanged mode as a product deduction.

The deterministic evaluator SHALL drive the browser through primitives every supported chrome-devtools-axi build provides, and SHALL NOT depend on adapter behavior that varies between builds, including the adapter's own wait helper and whether a page callback closes over the driving script's scope. Before asserting responsive presentation chrome, the deterministic evaluator SHALL establish and record a suite-owned viewport. It SHALL discover navigation through either stable presentation-owned hooks or equivalent semantic navigation regions, native interactive descendants, accessible names, and current-state attributes. It SHALL accept any ARIA-valid current-state value for the active step. The absence of one non-normative per-control selector SHALL NOT be treated as a product failure. When a conforming page exposes multiple indistinguishable controls and the evaluator cannot identify the intended target deterministically, it SHALL report the observation as unavailable with a harness diagnostic rather than fabricate a product failure. A page that reports no mode or no step index has not answered at all, so the evaluator SHALL raise a resumable harness failure rather than record a product deduction.

Deterministic criteria SHALL assert only mechanically provable behavior. They SHALL NOT require a design choice the candidate-facing fixture does not state. Specifically, the deterministic browse-mode criterion SHALL require browse mode to be reported, the active step's caption to be exposed, and every step to be reached by operating the discovered navigation, either by activating each direct step control or by advancing through the discovered next control from the first step, asserting the resulting step at each activation. It SHALL NOT infer reachability from the number or visibility of controls alone; it SHALL NOT require the active step title in preference to the deck title, a visible table of contents, or simultaneously visible previous and next controls. The deterministic present-mode criterion SHALL require present mode to be reported and the active step's title to be exposed by any visible title element, and SHALL NOT require one element to carry it, nor judge that title's visual prominence. Whether browse and present chrome are composed well SHALL be judged by `mode-browse-reading-focused`, `mode-present-title-focused`, and human review.

The canonical-content checks SHALL verify the registered demo route, the nine required steps in their specified order, their normative titles, captions, and scene content, and their implementation as one evolving scene. Route registration SHALL be judged by whether the declared demo route is reachable and operable. Landing-page link discovery SHALL be recorded as an observation and SHALL NOT by itself produce a product deduction. Normative title and caption comparison SHALL normalize Unicode punctuation variants and whitespace before comparing.

The evolving-scene check SHALL derive a scene identity only from a candidate-declared scene identity. When no scene identity is declared, the evaluator SHALL record it as undeclared and SHALL judge the criterion on entity persistence alone, rather than comparing a substitute value with itself.

The navigation checks SHALL exercise present and browse modes, mode changes, supported navigation inputs, direct controls, and end boundaries. When a check activates a navigation control, it SHALL activate it the way a pointer does, focusing the control before firing, so that a presentation which suppresses deck keys while its own control holds focus is observable rather than hidden by the probe. A check that needs a control SHALL establish whichever mode exposes one rather than skip itself when the mode it started in has none. Establishing a precondition SHALL remain neutral, so one defect is not charged to every criterion that happens to position the demo. The reliability and accessibility checks SHALL exercise step transitions and mode interactions, monitor browser failures, and inspect control semantics, current-state exposure, focus behavior, and keyboard operability.

Every deterministic probe artifact SHALL retain a bounded observation of what the evaluator saw: the established viewport, mode, step index and count, active title and caption, chrome visibility, the discovered controls, and the selector or strategy that matched each navigation role. The retention bound SHALL cover a full traversal of every step in both modes, and a probe that exceeds it SHALL publish the number of observations it dropped rather than truncate silently. A deduction SHALL be adjudicable from the retained artifact without replaying the run.

Candidate text retained as evidence SHALL be normalized exactly once. The evaluator SHALL separate collapsing and truncating candidate text, which SHALL be idempotent, from escaping it for a rationale or report, which SHALL be applied once at the emitting edge. Retained artifacts SHALL NOT contain repeatedly escaped text. A probe that returns evidence which is not a list SHALL be recorded as a single citation rather than decomposed.

Browser-process and adapter diagnostics SHALL never become candidate failure evidence. The evaluator SHALL classify the adapter's channel, executable-path, and usage-help output as browser infrastructure, SHALL raise a resumable harness failure when a probe observes one, and SHALL NOT record it as a page console failure, an unregistered route, or any other product deduction.

The deterministic browser evaluator SHALL have real-browser regression coverage against the pinned reference presentation. The reference regression SHALL require caption and canonical-content criteria to pass and SHALL NOT rely only on mocked mode state.

Deterministic source facts supplied to an LLM source judge SHALL be treated as leads rather than authoritative verdicts. The judge SHALL inspect cited source and resolve contradictions. Equivalent semantic current-state attributes and stable presentation-owned active hooks SHALL satisfy the active-state contract without requiring one hard-coded hook spelling. Source review of code boundaries SHALL also identify public API inputs or shared constants that are declared but not used by the delivered behavior. A dead or misleading contract consumed by the delivered demo SHALL be scored under `demo-clear-code-boundaries` exactly once even when its declaration lives in shared scene-kit source, and SHALL NOT receive a duplicate deduction in another component.

#### Scenario: Deterministic demo behavior is scored
- **WHEN** the built demo is available to the evaluator
- **THEN** deterministic browser checks exercise every demo criterion assigned to them
- **AND** the scorer applies the listed point allocations to their resolved pass/fail results

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
