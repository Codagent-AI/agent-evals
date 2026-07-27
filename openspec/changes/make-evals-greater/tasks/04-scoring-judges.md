# Task: Replace scoring and judge orchestration

## Goal

Implement the approved applicability-aware 24/24/7/7/4/4/30 rubric, six isolated scored judges, separate ambiguity diagnostics, and shared-92 reference comparison. Make missing or malformed judging a harness failure, preserve complete negative findings, and calibrate every component, gate, denominator, and workflow-quality criterion before benchmark cutover.

## Background

Read `proposal.md`, `design.md`, every approved delta under `specs/product-quality-scoring/`, `specs/testing-evidence-evaluation/`, and `specs/ambiguity-evaluation/`, plus the scoring-related outcome requirements. Update `evals/agent-runner/and-scene/automated-rubric.json`, `lib/rubric.mjs`, `lib/scorer.mjs`, `lib/judge-jobs.mjs`, `lib/judge-invoker.mjs`, `lib/ambiguity.mjs`, `lib/baseline.mjs`, `lib/calibration.mjs`, `calibrate.mjs`, the operator-facing `score.mjs` rescoring wrapper, controller integration, and the associated tests. Keep the existing 13-question `human-rubric.json` unchanged except for provenance integration required by the unified score model.

Every component record has `applicable`, `points_awarded`, and `points_possible`; derive totals and denominators from applicability instead of mode-specific constants. Candidate automated scoring is 70 and the completed score is 100. Reference testing-evidence and assumption-handling components are not applicable, yielding automated 62 and completed 92 without rescaling or an official candidate pass/fail verdict. The shared comparison uses the four common automated product components plus human review and reports totals, components, subcomponents, gates, and deltas only when both automated and human rubric provenance match.

Replace the four-job source judge path with six independently hashed and checkpointed scored jobs: demo integration, scene kit, presentation skill, verification tooling, testing evidence, and assumption handling. Each job receives only its rubric slice and permitted neutral/evidence view, returns exactly its assigned criteria with pass/fail, rationale, and verified citations, and retries within a fixed bound. Preserve the judge process environment allowlist in `lib/judge-invoker.mjs` and continue passing `shell_environment_policy.inherit="none"` (or its proven equivalent) so model-generated commands inherit none of the parent process environment; evidence-view rewiring must not expose harness, provider, GitHub, cloud, or other credentials to candidate-influenced judge commands. Missing, duplicate, unknown, malformed, cross-job, or exhausted output is a harness failure, never zero points or denominator adjustment. Testing-evidence credit comes only from verified candidate-produced evidence; evaluator evidence can disprove a claim but cannot add credit. The four product-source jobs never score visual taste.

Keep the ambiguity judge as a seventh, non-scoring diagnostic process with a stable durable ledger. Its classification severity and fixture proposals cannot award/deduct points, create gates, change verdicts, publish changes, or mutate specifications. Only the four fixed assumption-handling criteria affect the four-point component.

Validate the exact legacy disposition: 59 direct scored criteria, four hard gates, two replaced by testing-evidence quality, and three removed. The new four testing-evidence and four assumption-handling criteria each appear exactly once. Keep candidate pass policy at 70 overall, 15/24 demo, 15/24 scene kit, 15/30 human, no human rating of 1, and all four hard gates, with no floor for presentation skill, verification, testing evidence, or assumption handling.

Expand calibration to prove the reference earns all 62 applicable automated points and opens every hard gate. Include targeted degradations for evidence ownership/lineage/contradictions, visual warning disposition, assumption handling, missing judge output, N/A arithmetic, shared-92 comparison, and the retained Runner streaming, native failure-detail, run-identity, and process-identity regressions. Calibration output is diagnostic-only and must block expensive candidate cutover when the harness fingerprint or rubric provenance is stale.

## Spec

Source: `specs/product-quality-scoring/spec.md`

### Requirement: Official product score
The evaluation SHALL calculate a candidate implementation-quality score out of 100 from the following components. Automated criteria SHALL use binary pass/fail verdicts. For every table row that lists multiple criteria, the row's points SHALL be divided equally among those criteria; the scorer SHALL NOT round intermediate values.

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

Before candidate human review is complete, the evaluation SHALL report the automated subtotal out of 70 and SHALL NOT report an official score or ordinary pass/fail verdict. A conclusive product-owned inability to build or serve SHALL follow the hard-gate exception below. When product evidence is available for only part of an unsuccessful or incomplete run, the evaluation SHALL preserve completed component evidence without treating unobserved criteria as product failures.

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

#### Scenario: Complete candidate score
- **WHEN** all six automated candidate components and human review have completed successfully
- **THEN** the evaluator reports every component score and their sum out of 100

#### Scenario: Candidate human review is pending
- **WHEN** candidate automated scoring has completed but human review has not
- **THEN** the evaluator reports the automated subtotal out of 70
- **AND** it does not report an official candidate score or pass verdict

#### Scenario: Harness activity does not change candidate points
- **WHEN** evidence repair, retries, workflow execution, pricing, or other generic harness activity occurs
- **THEN** that activity is recorded diagnostically
- **AND** it neither awards nor deducts points outside the defined testing-evidence and assumption-handling criteria

#### Scenario: Partial candidate evidence is preserved
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

#### Scenario: Shared comparison is reported
- **WHEN** both the reference and candidate have complete applicable scores
- **THEN** the candidate report retains its official score out of 100
- **AND** it separately reports candidate-versus-reference component and total differences on the shared 92 points

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

The deterministic evaluator SHALL preserve the presentation's initial mode when opening it. Before traversing captions and canonical content, it SHALL explicitly enter browse mode. Before a mode-specific probe, it SHALL explicitly enter that probe's required present or browse mode. It SHALL NOT treat captions intentionally hidden in present mode as missing content.

The canonical-content checks SHALL verify the registered demo route, the nine required steps in their specified order, their normative titles, captions, and scene content, and their implementation as one evolving scene. The navigation checks SHALL exercise present and browse modes, mode changes, supported navigation inputs, direct controls, and end boundaries. The reliability and accessibility checks SHALL exercise step transitions and mode interactions, monitor browser failures, and inspect control semantics, current-state exposure, focus behavior, and keyboard operability.

The deterministic browser evaluator SHALL have real-browser regression coverage against the pinned reference presentation. The reference regression SHALL require caption and canonical-content criteria to pass and SHALL NOT rely only on mocked mode state.

#### Scenario: Deterministic demo behavior is scored
- **WHEN** the built demo is available to the evaluator
- **THEN** deterministic browser checks exercise every demo criterion assigned to them
- **AND** the scorer applies the listed point allocations to their pass/fail results

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

### Requirement: Scene kit correctness
The evaluation SHALL score the reusable scene kit out of 24 using LLM review of delivered source and structured browser evidence. The judge SHALL assess implementation of the technical contracts rather than the aesthetic quality of the demo that uses them.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Step model, stable identity, and typed boundary | 4 | `scene-step-narration-and-identity`, `scene-order-derived-numbering`, `scene-typed-payload-boundary` |
| Entity transitions and persistent grouped scenes | 7 | `entity-persisting-morph`, `entity-newcomer-after-settle`, `entity-departing-exit`, `grouped-scene-updates-in-place`, `grouped-continuing-entities-not-newcomers`, `grouped-intentional-composition` |
| Present/browse modes, navigation, controls, and boundaries | 6 | `mode-present-title-focused`, `mode-browse-reading-focused`, `mode-toggle-preserves-position`, `navigation-keyboard`, `navigation-touch-swipe`, `navigation-direct-jump`, `navigation-active-state`, `navigation-controls-keep-keys`, `navigation-clamp-start`, `navigation-clamp-end` |
| Fixed-canvas behavior | 2 | `canvas-uniform-scaling`, `canvas-default-dimensions` |
| Style ownership, hooks, framework neutrality, and attribution | 5 | `style-kit-hooks`, `style-unstyled-kit-output`, `style-framework-optional`, `style-coordinate-heavy-diagrams`, `attribution-default-link`, `attribution-styling-hook`, `attribution-top-left-opt-in` |

#### Scenario: Scene-kit contracts are scored
- **WHEN** the LLM judge evaluates the reusable scene kit
- **THEN** it returns a pass/fail verdict, rationale, and cited evidence for every listed scene-kit criterion
- **AND** the scorer divides each subcomponent's points equally among that subcomponent's criteria

#### Scenario: Technical continuity is distinguished from perceived quality
- **WHEN** the judge evaluates entity identity, grouping, or transition implementation
- **THEN** it scores whether the required technical mechanism and behavior are present
- **AND** it leaves perceived transition smoothness and visual composition quality to human review

### Requirement: Presentation skill correctness
The evaluation SHALL score the delivered presentation skill out of seven points using LLM review of the skill, its templates, delivered source, and workflow evidence.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Requirement gathering and proceeding with partial detail | 1 | `skill-missing-details-one-at-a-time`, `skill-partial-detail-proceeds`, `skill-complete-prompt-proceeds` |
| Scaffold detection, location, dependencies, and style neutrality | 3 | `skill-empty-directory-scaffold`, `skill-already-scaffolded`, `skill-partial-scaffold`, `skill-scaffold-style-neutral`, `skill-template-path-resolution`, `skill-monorepo-target`, `skill-standalone-target`, `skill-nonempty-confirmation` |
| Create, modify, route, and preserve presentations | 2 | `skill-new-presentation-routed`, `skill-presentation-owns-style`, `skill-existing-presentations-preserved`, `skill-modify-ambiguous-target`, `skill-scoped-modification` |
| Automated self-verification and fixing failures before completion | 1 | `skill-checks-run-before-done`, `skill-failures-fixed-before-success` |

Visual-composition inspection and visual-warning review SHALL NOT receive presentation-skill points. The candidate's observable proof that those activities occurred and were handled SHALL be evaluated by the testing-evidence component.

#### Scenario: Skill contracts are scored
- **WHEN** the LLM judge evaluates the presentation skill
- **THEN** it returns a pass/fail verdict, rationale, and cited evidence for every listed skill criterion
- **AND** the scorer divides each subcomponent's points equally among that subcomponent's criteria

#### Scenario: Dogfooded demo provides skill evidence
- **WHEN** the workflow task builds the demo by following the delivered skill or its prompt file
- **THEN** the judge SHALL be permitted to cite the resulting implementation and workflow record as evidence of skill behavior
- **AND** it still evaluates the delivered skill contract directly

#### Scenario: Visual inspection evidence is reviewed
- **WHEN** the candidate records visual inspection or warning dispositions
- **THEN** that record is evaluated under testing-evidence quality
- **AND** it does not award presentation-skill points

### Requirement: Verification tool correctness
The evaluation SHALL score the delivered verification tooling out of seven points using LLM review of its source, executable behavior, and produced artifacts. The four hard-gate criteria SHALL remain outside this point allocation.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Detects a missing reference sample | 1 | `verification-missing-sample-fails` |
| Preview addressing and runtime/step error detection | 2 | `verification-ipv4-loopback`, `verification-console-page-error-fails`, `verification-step-error-fails` |
| Complete, settled screenshot capture | 2 | `quality-project-local-screenshot-helper`, `visual-helper-captures-steps`, `visual-helper-settled-screenshots` |
| Overlap, active-state, attribution, and warning handling | 2 | `visual-helper-overlap-warning`, `visual-helper-allow-overlap`, `visual-helper-active-state-warning`, `visual-helper-attribution-warning` |

#### Scenario: Verification contracts are scored
- **WHEN** the LLM judge evaluates the verification tooling
- **THEN** it returns a pass/fail verdict, rationale, and cited evidence for every listed verification criterion
- **AND** the scorer divides each subcomponent's points equally among that subcomponent's criteria

#### Scenario: Hard-gate behavior is excluded from verification points
- **WHEN** the scorer calculates the verification-tool component
- **THEN** it does not award points for `verification-build-whole-app`, `verification-sample-outline`, `verification-every-produced-step-renders`, or `verification-clear-outcome`

### Requirement: Existing criterion disposition
The revised rubric SHALL classify each of the 68 legacy rubric criteria exactly once. It SHALL retain 59 as directly scored product criteria, use four exclusively as hard gates, remove three from scoring, and replace two presentation-skill evidence criteria with the broader testing-evidence criteria.

| Disposition | Count | Criteria |
|---|---:|---|
| Demo presentation technical quality | 2 | `quality-captions-and-navigation`, `quality-active-chrome-and-attribution-local` |
| Scene kit correctness | 28 | `scene-step-narration-and-identity`, `scene-order-derived-numbering`, `scene-typed-payload-boundary`, `entity-persisting-morph`, `entity-newcomer-after-settle`, `entity-departing-exit`, `grouped-scene-updates-in-place`, `grouped-continuing-entities-not-newcomers`, `grouped-intentional-composition`, `style-kit-hooks`, `style-unstyled-kit-output`, `style-framework-optional`, `style-coordinate-heavy-diagrams`, `attribution-default-link`, `attribution-styling-hook`, `attribution-top-left-opt-in`, `mode-present-title-focused`, `mode-browse-reading-focused`, `mode-toggle-preserves-position`, `navigation-keyboard`, `navigation-touch-swipe`, `navigation-direct-jump`, `navigation-active-state`, `navigation-controls-keep-keys`, `navigation-clamp-start`, `navigation-clamp-end`, `canvas-uniform-scaling`, `canvas-default-dimensions` |
| Presentation skill correctness | 18 | `skill-missing-details-one-at-a-time`, `skill-partial-detail-proceeds`, `skill-complete-prompt-proceeds`, `skill-empty-directory-scaffold`, `skill-already-scaffolded`, `skill-partial-scaffold`, `skill-scaffold-style-neutral`, `skill-template-path-resolution`, `skill-monorepo-target`, `skill-standalone-target`, `skill-nonempty-confirmation`, `skill-new-presentation-routed`, `skill-presentation-owns-style`, `skill-existing-presentations-preserved`, `skill-modify-ambiguous-target`, `skill-scoped-modification`, `skill-checks-run-before-done`, `skill-failures-fixed-before-success` |
| Verification tool correctness | 11 | `quality-project-local-screenshot-helper`, `verification-missing-sample-fails`, `verification-ipv4-loopback`, `verification-console-page-error-fails`, `verification-step-error-fails`, `visual-helper-captures-steps`, `visual-helper-settled-screenshots`, `visual-helper-overlap-warning`, `visual-helper-allow-overlap`, `visual-helper-active-state-warning`, `visual-helper-attribution-warning` |
| Hard gates | 4 | `verification-build-whole-app`, `verification-sample-outline`, `verification-every-produced-step-renders`, `verification-clear-outcome` |
| Replaced by testing-evidence quality | 2 | `quality-visual-composition-inspected`, `quality-visual-warnings-reviewed` |
| Removed from scoring | 3 | `skill-optional-ascii-mockup`, `quality-builds-clean`, `quality-renders-without-errors` |

The replaced concerns SHALL remain observable through the testing-evidence criteria and SHALL NOT be scored under their legacy identifiers. The revised rubric SHALL additionally define four testing-evidence and four assumption-handling criteria, each assigned exactly once to its focused judge.

#### Scenario: Legacy criteria are completely classified
- **WHEN** the revised rubric is validated
- **THEN** all 68 legacy criterion IDs appear in exactly one disposition
- **AND** the disposition counts are 59 directly scored, four gates, two replaced, and three removed

#### Scenario: New workflow-quality criteria are classified
- **WHEN** the revised rubric is validated
- **THEN** four testing-evidence and four assumption-handling criteria appear exactly once
- **AND** none duplicates a replaced legacy criterion

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

### Requirement: Hard gates and official pass
The evaluation SHALL apply the following four product hard gates separately from point scoring.

| Gate criterion | Required behavior |
|---|---|
| `verification-build-whole-app` | The complete application builds successfully |
| `verification-sample-outline` | The canonical nine-step sample exists, is registered and reachable, and matches its required outline |
| `verification-every-produced-step-renders` | Every produced step renders without runtime or console errors |
| `verification-clear-outcome` | Verification produces an unambiguous machine-readable pass/fail result |

An official candidate pass SHALL require all of the following: a total score of at least 70 out of 100; at least 15 out of 24 for demo technical quality; at least 15 out of 24 for scene-kit correctness; at least 15 out of 30 for human review; no individual human rating of 1; all four hard gates passing; and successful completion of the evaluation phases required to establish those results. The presentation-skill, verification-tool, testing-evidence, and assumption-handling components SHALL have no separate minimum scores.

Failure of a hard gate SHALL prevent an official candidate pass but SHALL NOT erase the numerical score supported by available evidence. A workflow failure, evaluation-harness failure, or pending human review that prevents the official pass contract from being evaluated SHALL make the candidate product verdict unavailable rather than converting unobserved behavior into a product failure. As a narrow exception, a reproducible product-owned inability to install dependencies, build, or serve the frozen final candidate SHALL conclusively fail the applicable hard gate and candidate product verdict even when it prevents browser or human evidence from being collected. That exception SHALL preserve completed component results, leave unobserved criteria unscored, and SHALL NOT fabricate an official score or human ratings. A harness failure after an official score and verdict have been durably recorded SHALL preserve that product result under the evaluation-outcomes rules.

The reference baseline SHALL NOT receive an official candidate pass/fail verdict, candidate total threshold, component-floor gate, or human-rating gate.

#### Scenario: Candidate satisfies the official pass contract
- **WHEN** a candidate scores at least 70 overall, meets the demo, scene-kit, and human floors, has no human rating of 1, passes all four hard gates, and completes every required evaluation phase
- **THEN** the official candidate pass verdict is true

#### Scenario: Candidate misses the numerical threshold
- **WHEN** a completed candidate scores below 70 overall
- **THEN** the official candidate pass verdict is false

#### Scenario: Candidate misses a component floor
- **WHEN** a completed candidate scores at least 70 overall but misses the demo, scene-kit, or human-review floor
- **THEN** the official candidate pass verdict is false

#### Scenario: Candidate has no points in a floorless component
- **WHEN** a candidate earns zero points for presentation skill, verification, testing evidence, or assumption handling but otherwise satisfies the pass contract
- **THEN** that component creates no additional independent gate

#### Scenario: Hard gate fails
- **WHEN** a completed candidate fails any hard gate
- **THEN** the official candidate pass verdict is false
- **AND** the evaluator still reports the numerical score supported by available evidence

#### Scenario: Product cannot build or serve
- **WHEN** deterministic verification establishes that reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **THEN** the applicable hard gate fails and the candidate product verdict is conclusively `fail`
- **AND** the evaluator preserves available component results without assigning points or human ratings to unobserved behavior
- **AND** it reports no official score

#### Scenario: Required evaluation phase is incomplete
- **WHEN** workflow failure, harness failure, or pending human review prevents the official candidate pass contract from being evaluated
- **THEN** the evaluator does not report an official candidate pass or fail verdict
- **AND** it reports the applicable incomplete outcome separately

#### Scenario: Reference score is complete
- **WHEN** the reference's applicable automated and human components are complete
- **THEN** the evaluator reports its score out of 92
- **AND** it applies no official candidate pass/fail verdict or candidate component floor

### Requirement: Controlled scoring and rubric provenance
The suite-owned scorer SHALL own criterion identifiers, evaluator assignments, point allocations, component applicability, score denominators, hard gates, thresholds, and final calculations. Neither an LLM judge nor the human-review interface SHALL change those policies while producing evaluation results. Every machine-evaluated criterion result SHALL include its identifier, pass/fail verdict, rationale, and cited verified evidence.

The evaluator SHALL run six focused scored judge jobs: demo integration, scene kit, presentation skill, verification tooling, testing evidence, and assumption handling. Each job SHALL return exactly the criteria assigned to it and no others. Missing, duplicated, unknown, malformed, or cross-job criterion output SHALL fail scoring rather than change a denominator, silently ignore a criterion, or reuse output from another job.

The four implementation source-review jobs SHALL receive a neutral source snapshot that retains relevant product source and approved requirements while stripping Git metadata, remotes, branch names, pull-request identity, baseline or candidate labels, OpenSpec change identity, and evaluation markers. The harness SHALL materialize the approved normative requirement descriptions and scenarios as a separate neutral requirements bundle, omit their original change path and change name, and record the bundle's source and content hash. The original OpenSpec change directory SHALL NOT be exposed to those four judges. The testing-evidence and assumption-handling judges SHALL receive the verified workflow and revision provenance required by their assigned criteria. Candidate source and evidence SHALL be treated as untrusted data, not instructions.

The automated product rubric and human-review rubric SHALL have distinct explicit version identifiers. The result SHALL record each rubric's version and SHA-256 hash, every component's applicability, and the applicable candidate or reference denominator.

#### Scenario: Six focused jobs return valid findings
- **WHEN** every focused judge returns exactly its assigned criteria with valid verdicts, rationales, and evidence
- **THEN** the suite-owned scorer applies the fixed assignments and weights
- **AND** it calculates the applicable candidate or reference score

#### Scenario: Required judge output is missing
- **WHEN** any of the six required scored judge jobs produces no valid output
- **THEN** rubric validation fails
- **AND** no official score or verdict is produced from incomplete judge coverage

#### Scenario: Criterion coverage is invalid
- **WHEN** evaluator output contains a missing, duplicate, unknown, malformed, or cross-job criterion result
- **THEN** rubric validation fails
- **AND** the scorer does not change the denominator or silently ignore the invalid output

#### Scenario: Product source judge reviews a candidate
- **WHEN** one of the four implementation source-review jobs is invoked
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

Source: `specs/testing-evidence-evaluation/spec.md`

### Requirement: Candidate and evaluator evidence separation
The evaluation SHALL use candidate-produced acceptance evidence as the primary record of workflow testing. It SHALL label candidate-produced and evaluator-produced evidence separately in every durable artifact and report. Evaluator-produced deterministic checks, probes, and screenshots SHALL remain available to corroborate or contradict candidate claims, but SHALL NOT add credit to the candidate's testing-evidence score.

The evaluator SHALL NOT perform another subjective visual-quality review. The separate 13-question human review SHALL remain the authoritative visual-quality assessment.

#### Scenario: Candidate evidence supports its own score
- **WHEN** the testing-evidence judge evaluates a candidate
- **THEN** it assigns credit only from verified candidate-produced evidence
- **AND** it identifies every cited item as candidate-produced

#### Scenario: Evaluator evidence is captured
- **WHEN** the harness runs deterministic checks or captures its own screenshots
- **THEN** it stores them in a distinct evaluator-evidence namespace
- **AND** those artifacts cannot increase the candidate's testing-evidence score

#### Scenario: Evaluator evidence contradicts a candidate claim
- **WHEN** verified evaluator evidence contradicts candidate-produced evidence
- **THEN** the contradiction is provided to the testing-evidence judge
- **AND** the judge fails each applicable criterion that the contradiction disproves

#### Scenario: Visual quality is assessed
- **WHEN** subjective visual quality must be scored
- **THEN** the evaluator uses the separate human-review workflow
- **AND** it does not invoke a third subjective visual-review job

### Requirement: Four-point testing-evidence score
The evaluation SHALL score candidate testing-evidence quality out of four points using four one-point binary criteria. A focused testing-evidence judge SHALL return a pass/fail verdict, rationale, and cited verified evidence for every criterion.

| Criterion | Points | Required behavior |
|---|---:|---|
| Traceable coverage | 1 | Requirements, user flows, and representative visual states are covered and traceable. |
| Usable proof | 1 | Actions, observed outcomes, screenshots, and warning dispositions provide usable proof. |
| Final-revision applicability | 1 | Evidence, candidate-reported CI status when present, and pull-request identity apply through a valid lineage to the final evaluated SHA. |
| Complete and honest record | 1 | Limitations, unexercised flows, failures, fixes, and retesting are complete and honest enough for independent judging. |

The component SHALL have no independent score floor. For a reference-baseline evaluation, the component SHALL be not applicable and SHALL contribute neither points earned nor points possible.

#### Scenario: Candidate evidence satisfies every criterion
- **WHEN** the focused judge passes all four testing-evidence criteria
- **THEN** the candidate receives four of four testing-evidence points

#### Scenario: One evidence criterion fails
- **WHEN** the focused judge fails one criterion and passes the other three
- **THEN** the candidate receives three of four testing-evidence points
- **AND** the failed criterion retains its rationale and cited evidence

#### Scenario: Component misses every criterion
- **WHEN** required artifacts exist but none of the four evidence-quality criteria passes
- **THEN** the candidate receives zero of four testing-evidence points
- **AND** the absence of a component floor does not create an additional pass gate

#### Scenario: Reference baseline is evaluated
- **WHEN** the evaluator scores the reference baseline
- **THEN** it marks testing-evidence quality not applicable
- **AND** it excludes the component's four points from the reference denominator

Source: `specs/ambiguity-evaluation/spec.md`

### Requirement: Observable ambiguity capture
The evaluation harness SHALL create a structured ambiguity ledger from assumption and context-gap information present in Agent Runner session reports, the acceptance assumptions ledger, findings history, final acceptance handoff, and relevant delivered-product evidence. The harness SHALL capture findings explicitly reported by implementation or acceptance agents and consequential ambiguity evidence discovered by the evaluation judge.

Each finding SHALL identify the originating run, workflow step, agent role, and task when available; state the assumption or context gap; reference the supporting artifacts or product evidence; and record the observable handling and consequence. The harness SHALL distinguish absent evidence from an explicit, evidence-backed statement that no unresolved assumptions or context gaps remain. It SHALL NOT require Agent Runner agents to perform evaluation-owned diagnostic classification.

If required assumption or handoff artifacts are absent, the harness SHALL preserve ambiguity coverage as incomplete and defer to the implementation-workflow outcome rules. If the required artifacts exist but contain missed, inaccurate, false-positive, or poorly handled assumptions, the harness SHALL preserve those defects for assumption-handling scoring and diagnostic classification.

#### Scenario: Implementor reports an assumption
- **WHEN** an Agent Runner implementation or acceptance artifact reports an assumption or missing-context concern
- **THEN** the harness records it in the ambiguity ledger with its origin, evidence, observable handling, and consequence

#### Scenario: Judge discovers a consequential unreported assumption
- **WHEN** the evaluation judge finds evidence that an unreported assumption materially affected the delivered product or implementation workflow
- **THEN** the harness records a judge-discovered finding and links it to the supporting evidence
- **AND** the unreported finding remains available to the scored surfacing criterion

#### Scenario: Workflow reports no unresolved assumptions
- **WHEN** the required workflow artifacts explicitly report no unresolved assumptions or context gaps and available evidence supports that statement
- **THEN** the ledger records that no findings were observed for the evaluated artifacts
- **AND** the absence of findings does not prevent full assumption-handling credit

#### Scenario: No-findings statement is inaccurate
- **WHEN** required artifacts claim that no unresolved assumptions remain but verified evidence establishes a consequential unreported ambiguity
- **THEN** the harness records the contradiction and judge-discovered finding
- **AND** the scored assumption judge evaluates the applicable handling criteria

#### Scenario: Expected workflow artifacts are unavailable
- **WHEN** required assumption, findings, or handoff artifacts are unavailable
- **THEN** the ledger marks ambiguity coverage incomplete rather than claiming that no ambiguity occurred
- **AND** the implementation-workflow outcome rules determine whether scored judging can begin

### Requirement: Non-scoring ambiguity diagnostics
The detailed ambiguity ledger, its classifications, and its fixture-improvement proposals SHALL remain diagnostic-only. They SHALL NOT directly add or subtract points, create a scoring gate, or independently change the official candidate verdict. The separate assumption-handling judge SHALL score only its four fixed criteria from verified evidence.

An ambiguity-related product defect SHALL affect the applicable product-quality criterion. Poor ambiguity handling SHALL affect only the applicable fixed assumption-handling criterion rather than create an additional discretionary deduction. An ambiguity-related interruption that prevents completion SHALL also follow the applicable implementation-workflow outcome rule. A genuine specification gap SHALL remain diagnostic, and proportionate handling of that gap SHALL be eligible for full assumption-handling credit.

#### Scenario: Incorrect assumption causes a product defect
- **WHEN** an ambiguity finding is associated with behavior that fails a scored product criterion and also demonstrates poor assumption handling
- **THEN** the product criterion determines the product-quality effect
- **AND** only the applicable fixed assumption-handling criterion determines the handling-quality effect

#### Scenario: Needless escalation stops implementation
- **WHEN** an unnecessary escalation prevents the Agent Runner workflow from completing
- **THEN** the evaluation uses the implementation-workflow outcome rules
- **AND** the diagnostic classification creates no additional score or gate

#### Scenario: Genuine fixture gap is handled proportionately
- **WHEN** a genuine specification gap is surfaced, distinguished from discoverable context, escalated proportionately, and preserved in the handoff
- **THEN** the diagnostic ledger reports the gap
- **AND** the candidate remains eligible for full assumption-handling credit

#### Scenario: Diagnostic ledger contains a severe finding
- **WHEN** the non-scoring ambiguity judge records a severe classification
- **THEN** that classification does not itself change points or verdicts
- **AND** any scoring effect must come from a defined product, assumption-handling, or outcome rule

### Requirement: Durable ambiguity ledger
The harness SHALL write the non-scoring ambiguity ledger durably with the evaluation artifacts and reference it separately from the four-point assumption-handling result in `result.json` and `report.html`. Each finding SHALL have a stable identifier. On resume, the harness SHALL preserve prior findings, add newly supported evidence or findings, and avoid duplicating a finding already recorded for the same origin and concern.

Each persisted finding SHALL retain its source evidence, observed handling, consequence, diagnostic classification, rationale, resolution state, and any unapproved fixture-improvement proposal. The ledger SHALL NOT embed or replace the scored assumption-handling verdicts.

#### Scenario: Evaluation resumes with existing findings
- **WHEN** an evaluation resumes after ambiguity findings were recorded
- **THEN** the harness preserves the existing stable findings and adds only new findings or evidence

#### Scenario: Same finding appears in resumed artifacts
- **WHEN** resumed workflow artifacts repeat an already recorded assumption or context gap
- **THEN** the harness updates or references the existing finding rather than creating a duplicate

#### Scenario: Evaluation report is generated
- **WHEN** `result.json` and `report.html` are written or updated
- **THEN** they present the assumption-handling score separately from ambiguity-ledger coverage, classifications, consequences, and unapproved fixture-improvement proposals

#### Scenario: Scored and diagnostic findings overlap
- **WHEN** the same evidence supports a scored assumption-handling verdict and a diagnostic ambiguity finding
- **THEN** both artifacts retain their distinct purpose and provenance
- **AND** the ledger classification does not create points beyond the fixed scored criterion

### Requirement: Four-point assumption-handling score
The evaluation SHALL score candidate assumption-handling quality out of four points using four one-point binary criteria. A focused assumption-handling judge SHALL return a pass/fail verdict, rationale, and cited verified evidence for every criterion.

| Criterion | Points | Required behavior |
|---|---:|---|
| Consequential ambiguities surfaced | 1 | Consequential ambiguities and context gaps are identified rather than silently resolved or omitted. |
| Repository facts distinguished from specification gaps | 1 | Discoverable repository context, legitimate implementation flexibility, and genuine specification gaps are distinguished accurately. |
| Decisions and escalations are proportionate | 1 | Decisions, assumptions, and escalations are evidence-backed, within authority, and proportionate to consequence and uncertainty. |
| Final handoff preserves decisions | 1 | The handoff is evidence-backed and actionable, and preserves unresolved decisions, options, consequences, and known limitations. |

The component SHALL have no independent score floor. For a reference-baseline evaluation, the component SHALL be not applicable and SHALL contribute neither points earned nor points possible.

#### Scenario: Genuine unresolved gap is handled well
- **WHEN** the candidate surfaces a genuine consequential specification gap, distinguishes it from repository facts, escalates proportionately, and preserves it actionably in the handoff
- **THEN** the unresolved state does not by itself fail any assumption-handling criterion

#### Scenario: No consequential ambiguity exists
- **WHEN** required artifacts explicitly report no unresolved assumptions and verified evidence supports that conclusion
- **THEN** the candidate remains eligible to pass all four assumption-handling criteria

#### Scenario: Consequential ambiguity is silently resolved
- **WHEN** the workflow makes a consequential unsupported decision without surfacing or preserving the ambiguity
- **THEN** the surfaced-ambiguities criterion fails
- **AND** any other affected criterion is scored from its own evidence

#### Scenario: Discoverable fact is reported as a gap
- **WHEN** relevant repository context resolves a claimed specification gap
- **THEN** the repository-facts distinction criterion fails
- **AND** the judge cites the discoverable context

#### Scenario: Escalation is disproportionate
- **WHEN** an agent escalates or stops despite sufficient authority and evidence for a requirement-conforming decision
- **THEN** the decisions-and-escalations criterion fails

#### Scenario: Final handoff is incomplete
- **WHEN** unresolved decisions, known consequences, or material limitations are omitted from the final handoff
- **THEN** the final-handoff criterion fails

#### Scenario: Candidate satisfies every criterion
- **WHEN** the focused judge passes all four assumption-handling criteria
- **THEN** the candidate receives four of four assumption-handling points

#### Scenario: Component earns no points
- **WHEN** required artifacts exist but none of the four assumption-handling criteria passes
- **THEN** the candidate receives zero of four assumption-handling points
- **AND** the absence of a component floor creates no additional pass gate

#### Scenario: Reference baseline is evaluated
- **WHEN** the evaluator scores the reference baseline
- **THEN** it marks assumption-handling quality not applicable
- **AND** it excludes the component's four points from the reference denominator

Source: `specs/evaluation-outcomes/spec.md`

### Requirement: Pending human-review outcome
The evaluation SHALL use `pending-human-review` when all required applicable automated scoring has completed but the required human review has not been finalized. This state SHALL contain the applicable automated subtotal, score denominator, and completed diagnostics but SHALL NOT contain an official candidate score or pass/fail verdict.

A pending candidate SHALL report its automated subtotal out of 70. A pending local reference SHALL report its applicable automated subtotal out of 62 and SHALL mark testing evidence and assumption handling not applicable.

#### Scenario: Candidate automated scoring awaits reviewer
- **WHEN** candidate automated scoring is complete and no finalized human-review record is available
- **THEN** `evaluation_status` is `pending-human-review`, `product_verdict` is `unavailable`, and no official score is issued
- **AND** the result reports the automated subtotal out of 70

#### Scenario: Reference automated scoring awaits reviewer
- **WHEN** local reference automated scoring is complete and no finalized human-review record is available
- **THEN** `evaluation_status` is `pending-human-review`, `product_verdict` is `unavailable`, and no final reference score is issued
- **AND** the result reports the applicable automated subtotal out of 62

#### Scenario: Candidate human review is finalized
- **WHEN** a pending candidate resumes and finalizes valid human-review responses
- **THEN** the evaluation replaces the pending state with `complete`
- **AND** it calculates the applicable `pass` or `fail` candidate verdict

#### Scenario: Reference human review is finalized
- **WHEN** a pending local reference resumes and finalizes valid human-review responses
- **THEN** the evaluation replaces the pending state with `complete`
- **AND** it reports the reference score out of 92 with `product_verdict=not-applicable`

#### Scenario: Noninteractive run reaches human review
- **WHEN** the main evaluation command completes applicable automated scoring
- **THEN** it exits successfully with a durable `pending-human-review` result rather than attempting human review or reporting failure

#### Scenario: Handoff cleanup is incomplete
- **WHEN** the main evaluation command cannot complete candidate-server cleanup after durably writing the pending result artifacts
- **THEN** `evaluation_status` remains `pending-human-review`, the cleanup error is recorded diagnostically for review or resume, and the command exits successfully

#### Scenario: Separate review command finalizes pending result
- **WHEN** `human-review.sh` completes and confirms all required responses for a pending run
- **THEN** the evaluation transitions to `complete` with the verdict applicability required by that run kind
- **AND** it does not rerun valid automated scoring

### Requirement: Evaluation-harness failure outcome
The evaluation SHALL use `evaluation-harness-failed` when eval-owned setup, candidate-identity verification, non-CI evidence verification, candidate-server management, browser evaluation, evidence processing, scored judging, human-review persistence, scoring, result persistence, report generation, or cleanup fails in a way that prevents required evaluation work or finalization. A candidate-server failure established to result from reproducible product behavior SHALL follow the conclusive product-failure rule rather than this harness-failure rule.

The result SHALL identify the failed eval phase, observed error, completed checkpoints, and whether the phase can be resumed. A harness failure SHALL NOT be reported as a product defect or implementation-workflow defect.

#### Scenario: Browser evaluator cannot collect required evidence
- **WHEN** an eval-owned browser or evidence phase fails before sufficient product evidence is produced
- **THEN** `evaluation_status` is `evaluation-harness-failed` and `product_verdict` is `unavailable`

#### Scenario: Candidate server failure is product-owned
- **WHEN** the harness operates correctly but reproducible product behavior prevents the frozen final candidate from building or serving
- **THEN** the evaluation applies the conclusive product-failure outcome
- **AND** it does not report `evaluation-harness-failed`

#### Scenario: Required scored judge output is missing
- **WHEN** any required demo, scene-kit, presentation-skill, verification, testing-evidence, or assumption-handling judge job returns missing or invalid output
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the scorer does not substitute zero points or change the score denominator

#### Scenario: Scorer cannot produce a reliable score
- **WHEN** an eval-owned scoring failure prevents reliable applicability, denominator, criterion coverage, or official scoring
- **THEN** `evaluation_status` is `evaluation-harness-failed` and no official score or candidate pass/fail verdict is issued

#### Scenario: Harness cannot process valid candidate evidence
- **WHEN** required valid candidate evidence exists but an eval-owned defect prevents it from being read or validated
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the failure is not attributed to Agent Runner

#### Scenario: Required finalization cleanup fails
- **WHEN** the separate human-review command cannot complete its required candidate-server cleanup during finalization
- **THEN** `evaluation_status` is `evaluation-harness-failed` and the result records the cleanup error

## Done When

- The rubric validates the exact 24/24/7/7/4/4/30 allocation, all legacy and new criterion dispositions, four hard gates, component floors, and distinct automated/human provenance.
- Applicability drives arithmetic: candidates report automated 70 and final 100; references report automated 62 and final 92 with both workflow-quality components marked not applicable and no rescaling or candidate verdict.
- All six scored jobs are isolated by rubric slice, evidence permissions, and the existing judge process environment allowlist; model-generated commands inherit none of the parent environment, while only explicitly allowlisted process variables reach the judge CLI. Jobs checkpoint independently and return exactly their required verdicts, rationales, and verified citations; invalid or exhausted output becomes a harness failure without fabricated zeroes.
- Testing-evidence scoring uses only verified candidate proof, applies contradictions from evaluator evidence, and has no independent floor; assumption scoring uses only its four fixed criteria and remains separate from the non-scoring ambiguity ledger.
- Candidate pass/fail applies the unchanged total threshold, three floors, human rating-one rule, and four gates; partial observations and complete negative findings retain their approved incomplete/reusable behavior.
- Shared-92 comparison refuses mismatched rubric provenance and otherwise reports unscaled candidate/reference totals, components, subcomponents, gates, and deltas separately from the candidate score.
- Calibration awards the reference all 62 applicable automated points, opens all gates, and detects each approved degradation without collateral component movement or infrastructure misclassification.
- Targeted rubric, scorer, judge, ambiguity, baseline, calibration, controller, and rescoring-command tests pass. The command coverage executes `score.mjs` against durable candidate and reference inputs and verifies the new applicability-aware scorer contract and denominators rather than only syntax-checking the wrapper. `test/judge-invoker.test.mjs` also proves secret parent variables are excluded from the judge process and model-generated commands receive `shell_environment_policy.inherit="none"` (or a proven equivalent). The full calibration command and `npm run check` pass.
