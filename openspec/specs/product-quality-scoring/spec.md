# product-quality-scoring Specification

## Purpose
Define the versioned automated and human product-quality rubrics, gates, thresholds, evidence contracts, and score calculation.
## Requirements
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

When the user explicitly approves a post-run technical adjudication, the harness SHALL preserve the raw automated criterion and component scores, record the approver, time, rationale, consequential findings, and replacement scores for exactly the four shared technical components, and recalculate the automated subtotal using those four replacement scores plus the unchanged raw scores of every other applicable automated component. It SHALL recalculate the official candidate score from that subtotal and the applicable human-review score, and SHALL recalculate the shared-92 comparison using only the four shared replacement scores and applicable human-review scores. An adjudication SHALL NOT masquerade as a new automated judge result or silently replace the raw score.

#### Scenario: Complete product score
- **WHEN** all six automated candidate components and human review have completed successfully
- **THEN** the evaluator reports every component score and their sum out of 100

#### Scenario: Human review is pending
- **WHEN** candidate automated scoring has completed but human review has not
- **THEN** the evaluator reports the automated subtotal out of 70
- **AND** it does not report an official candidate score or pass verdict

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

The deterministic evaluator SHALL preserve the presentation's initial mode when opening it. Before traversing captions and canonical content, it SHALL explicitly enter browse mode. Before a mode-specific probe, it SHALL explicitly enter that probe's required present or browse mode. It SHALL NOT treat captions intentionally hidden in present mode as missing content.

The canonical-content checks SHALL verify the registered demo route, the nine required steps in their specified order, their normative titles, captions, and scene content, and their implementation as one evolving scene. The navigation checks SHALL exercise present and browse modes, mode changes, supported navigation inputs, direct controls, and end boundaries. The reliability and accessibility checks SHALL exercise step transitions and mode interactions, monitor browser failures, and inspect control semantics, current-state exposure, focus behavior, and keyboard operability.

The deterministic browser evaluator SHALL have real-browser regression coverage against the pinned reference presentation. The reference regression SHALL require caption and canonical-content criteria to pass and SHALL NOT rely only on mocked mode state.

Deterministic source facts supplied to an LLM source judge SHALL be treated as leads rather than authoritative verdicts. The judge SHALL inspect cited source and resolve contradictions. Equivalent semantic current-state attributes and stable presentation-owned active hooks SHALL satisfy the active-state contract without requiring one hard-coded hook spelling. Source review of code boundaries SHALL also identify public API inputs or shared constants that are declared but not used by the delivered behavior. A dead or misleading contract consumed by the delivered demo SHALL be scored under `demo-clear-code-boundaries` exactly once even when its declaration lives in shared scene-kit source, and SHALL NOT receive a duplicate deduction in another component.

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

#### Scenario: Source contradicts a deterministic token scan
- **WHEN** deterministic source evidence reports that a technical hook is missing but the delivered source implements the required semantics through an equivalent stable hook
- **THEN** the LLM judge resolves the contradiction from source behavior
- **AND** it does not inherit the token scan's verdict

#### Scenario: Demo consumes a dead shared contract
- **WHEN** the demo supplies a required public scene-kit input that the reusable implementation ignores
- **THEN** `demo-clear-code-boundaries` fails
- **AND** the same defect is not deducted again from a scene-kit criterion

### Requirement: Scene kit correctness
The evaluation SHALL score the reusable scene kit out of 24 using LLM review of delivered source and structured browser evidence. The judge SHALL assess implementation of the technical contracts rather than the aesthetic quality of the demo that uses them.

For transition sequencing, the judge SHALL require persisting motion and newcomer delay to share one settlement contract or executable proof that newcomers wait until continuing entities settle; the presence of timing constants or named primitives alone SHALL NOT earn credit. Sharing or importing a timing value SHALL be insufficient unless persistent motion consumes that exact configuration, or newcomer admission waits on an observable completion signal from persistent motion. Touch navigation SHALL distinguish predominantly horizontal single-touch swipes from vertical scrolling and multi-touch gestures.

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

#### Scenario: Newcomer timing is disconnected from persistent motion
- **WHEN** the kit delays newcomers using a duration that is not applied to persistent layout motion and supplies no executable settlement proof
- **THEN** `entity-newcomer-after-settle` fails

#### Scenario: Vertical gesture has horizontal drift
- **WHEN** a touch gesture moves primarily vertically while also exceeding the horizontal distance threshold
- **THEN** the kit does not navigate

### Requirement: Presentation skill correctness
The evaluation SHALL score the delivered presentation skill out of seven points using LLM review of the skill, its templates, delivered source, and workflow evidence.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Requirement gathering and proceeding with partial detail | 1 | `skill-missing-details-one-at-a-time`, `skill-partial-detail-proceeds`, `skill-complete-prompt-proceeds` |
| Scaffold detection, location, dependencies, and style neutrality | 3 | `skill-empty-directory-scaffold`, `skill-already-scaffolded`, `skill-partial-scaffold`, `skill-scaffold-style-neutral`, `skill-template-path-resolution`, `skill-monorepo-target`, `skill-standalone-target`, `skill-nonempty-confirmation` |
| Create, modify, route, and preserve presentations | 2 | `skill-new-presentation-routed`, `skill-presentation-owns-style`, `skill-existing-presentations-preserved`, `skill-modify-ambiguous-target`, `skill-scoped-modification` |
| Automated self-verification and fixing failures before completion | 1 | `skill-checks-run-before-done`, `skill-failures-fixed-before-success` |

Visual-composition inspection and visual-warning review SHALL NOT receive presentation-skill points. The candidate's observable proof that those activities occurred and were handled SHALL be evaluated by the testing-evidence component.

For scaffold scenarios that can be exercised deterministically, prose instructions alone SHALL NOT establish correctness. The judge SHALL require focused executable tests or verified workflow evidence covering empty, already-scaffolded, partial-scaffold, monorepo, standalone, and ambiguous nonempty targets, including template resolution and dependency handling from the resolved target. Acceptable proof SHALL include either a temporary-directory driver that materializes the target state and verifies resulting files and dependencies, or a revision-bound workflow transcript recording the inputs, user choice when interactive confirmation is required, mutations, and observed outcome. An interactive branch SHALL NOT require a live human in a unit test, but prose that merely directs an agent to ask SHALL NOT prove the branch.

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

#### Scenario: Scaffold edge cases exist only as instructions
- **WHEN** the skill describes partial-scaffold and monorepo behavior without executable tests or verified workflow evidence for those cases
- **THEN** the affected scaffold criteria fail

#### Scenario: Interactive scaffold confirmation is exercised
- **WHEN** a test driver or revision-bound workflow record supplies the ambiguous nonempty target, records the simulated or actual user choice, and verifies the resulting mutations
- **THEN** that evidence is eligible for `skill-nonempty-confirmation`

### Requirement: Verification tool correctness
The evaluation SHALL score the delivered verification tooling out of seven points using LLM review of its source, executable behavior, and produced artifacts. The four hard-gate criteria SHALL remain outside this point allocation.

The verifier SHALL prove that browser checks connect to the preview process it started and SHALL fail if that process exits; an unrelated stale process on a fixed port SHALL NOT satisfy readiness. This behavior SHALL be scored only under `verification-preview-process-ownership`; `verification-ipv4-loopback` SHALL score only consistent use of `127.0.0.1` for preview binding, readiness probes, and browser URLs. Screenshot settlement SHALL observe animation completion or consume the exact transition configuration used by persistent scene motion; a duplicated fixed delay or an imported value that persistent motion does not consume SHALL NOT satisfy settlement. Warning criteria SHALL require executable regression or verified browser evidence that each warning fires and that intentional-overlap suppression does not hide unrelated collisions; token presence alone SHALL NOT earn credit. Evidence from an earlier revision MAY satisfy a warning criterion only when verified lineage establishes it as an ancestor of the final SHA, hashes show the relevant warning implementation is unchanged, and retained raw executable output demonstrates the behavior; a narrative assertion about an earlier pass SHALL NOT suffice.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Detects a missing reference sample | 1 | `verification-missing-sample-fails` |
| Preview addressing, ownership, and runtime/step error detection | 2 | `verification-ipv4-loopback`, `verification-preview-process-ownership`, `verification-console-page-error-fails`, `verification-step-error-fails` |
| Complete, settled screenshot capture | 2 | `quality-project-local-screenshot-helper`, `visual-helper-captures-steps`, `visual-helper-settled-screenshots` |
| Overlap, active-state, attribution, and warning handling | 2 | `visual-helper-overlap-warning`, `visual-helper-allow-overlap`, `visual-helper-active-state-warning`, `visual-helper-attribution-warning` |

#### Scenario: Verification contracts are scored
- **WHEN** the LLM judge evaluates the verification tooling
- **THEN** it returns a pass/fail verdict, rationale, and cited evidence for every listed verification criterion
- **AND** the scorer divides each subcomponent's points equally among that subcomponent's criteria

#### Scenario: Hard-gate behavior is excluded from verification points
- **WHEN** the scorer calculates the verification-tool component
- **THEN** it does not award points for `verification-build-whole-app`, `verification-sample-outline`, `verification-every-produced-step-renders`, or `verification-clear-outcome`

#### Scenario: Stale preview occupies the configured port
- **WHEN** the verifier's own preview process exits because its port is occupied while another server responds on that port
- **THEN** `verification-preview-process-ownership` fails
- **AND** `verification-ipv4-loopback` remains independently scored from consistent loopback addressing

#### Scenario: Warning implementation is not exercised
- **WHEN** warning-related tokens or helper functions exist but no executable regression or verified browser evidence demonstrates the warning behavior
- **THEN** the affected warning criteria fail

#### Scenario: Earlier warning evidence remains applicable
- **WHEN** warning evidence comes from an ancestor revision, the relevant implementation hashes are unchanged through the final SHA, and retained raw executable output demonstrates the warning
- **THEN** the evidence remains eligible for that warning criterion
- **AND** a narrative assertion without the retained output is ineligible

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

The replaced concerns SHALL remain observable through the testing-evidence criteria and SHALL NOT be scored under their legacy identifiers. The revised rubric SHALL additionally define four testing-evidence and four assumption-handling criteria, each assigned exactly once to its focused judge.

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

#### Scenario: Judge returns findings but does not control scoring
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

