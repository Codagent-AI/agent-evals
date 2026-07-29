# Task: Correct browser and product verification

## Goal

Make installation, build, serving, deterministic browser checks, and evaluator captures revision-safe and mode-explicit. Correct the presenter-caption defect, checkpoint independently reusable probes, and distinguish reproducible product-owned build/serve failures from evaluation infrastructure failures.

## Background

Read `proposal.md`, `design.md`, `specs/product-quality-scoring/spec.md`, `specs/runner-workflow-execution/spec.md`, `specs/testing-evidence-evaluation/spec.md`, and `specs/evaluation-outcomes/spec.md`. Work in `evals/agent-runner/and-scene/lib/candidate-verification.mjs`, `lib/candidate-server.mjs`, `lib/candidate-server-host.mjs`, `lib/axi-browser-driver.mjs`, `lib/browser-eval.mjs`, `deterministic-checks.mjs`, `scene-shots.mjs`, `serve-candidate.mjs`, `controller.mjs`, and their focused tests. Use `chrome-devtools-axi` for real browser operation, consistent with repository policy.

The driver must observe and record the presentation's initial mode without changing it during open. Every probe declares and enters its own required mode and starting position: caption/canonical-content traversal uses browse mode; presenter and browser behavior probes select present or browse mode explicitly; navigation probes set position and mode explicitly; shared sessions restore recorded state when reuse depends on it. Captions intentionally hidden in present mode are not missing canonical content.

Keep routing, canonical nine-step content and order, evolving-scene structure, navigation, modes, controls, end boundaries, runtime/console/page failures, accessibility semantics, focus/keyboard behavior, revision identity, and the four hard gates deterministic and suite-owned. Record each probe and capture as a hashed work unit with explicit inputs, outputs, mode, position, settled state, and evaluator ownership so a matching pass or fail is reusable after interruption. Do not add a subjective visual judge; literal human review remains the only visual-quality assessment.

Candidate verification must separate command execution from product behavior. A harness inability to launch tools, manage a viable server, drive Chrome, or persist otherwise valid evidence is `evaluation-harness-failed`. Reproducible behavior of the frozen final candidate that prevents dependency installation, build, or serving conclusively fails the applicable product gate with `evaluation_status=complete` and `product_verdict=fail`; preserve completed component/gate evidence, do not run dependent browser or human phases, and do not fabricate an official score or human ratings.

Mocked tests must characterize every state transition and failure owner. Add a real-browser regression against the pinned reference commit that exercises actual present/browse modes and requires every caption and canonical-content criterion to pass. Keep proof and regression commands documented and reproducible without moving product infrastructure from the Agent Runner repository.

## Spec

Source: `specs/product-quality-scoring/spec.md`

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

#### Scenario: Product cannot install, build, or serve
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

Source: `specs/runner-workflow-execution/spec.md`

### Requirement: Ordered evaluation lifecycle
For an Agent Runner candidate, the main evaluation command SHALL execute phases in this order: preflight the pinned fixture, unique candidate branch, Agent Runner checkout, workflow contract, credentials, profiles, evaluator, and run directory; run or resume the complete Agent Runner workflow; verify candidate delivery and acceptance-handoff completeness; install dependencies, build, and run non-browser verification; start the evaluated final candidate server; run deterministic browser checks and capture evaluator evidence; run the six focused product judge jobs; run the separate non-scoring ambiguity diagnostic; ingest metrics and resolve pricing; write the pending-human-review result and HTML report; attempt candidate-server cleanup; update the pending artifacts with the cleanup outcome; and exit successfully.

The separate human-review command SHALL later restore or start the same evaluated final candidate server; collect or resume human review; calculate the official candidate result; generate the final HTML report; attempt candidate-server cleanup; update the final artifacts; and publish a curated permanent result for a completed scored candidate pass or product-fail run. The candidate server SHALL be running before every browser-dependent phase and SHALL NOT be required to remain running between the automated and human-review commands. If verified product behavior makes the final candidate unable to install, build, or serve, dependent browser and human-review phases SHALL NOT run, and the conclusive product-failure outcome rules SHALL apply instead.

#### Scenario: Automated candidate evaluation follows the phase order
- **WHEN** every automated candidate-evaluation phase completes successfully
- **THEN** each phase begins only after its required predecessor has completed
- **AND** scored product judging begins only after complete candidate delivery and acceptance-handoff evidence are verified

#### Scenario: Human review finalizes later
- **WHEN** the separate human-review command completes a pending candidate review
- **THEN** it calculates the official result, writes the final report, attempts cleanup, updates the cleanup outcome, and then publishes the completed result

#### Scenario: Paired fresh benchmark
- **WHEN** autonomous evaluation finishes the pending recreated reference and pending fresh Agent Runner candidate
- **THEN** a later paired human-review invocation finalizes the reference before the candidate
- **AND** it generates their shared-92 comparison without rerunning completed automated phases

#### Scenario: Earlier phase cannot complete
- **WHEN** an evaluation phase cannot produce its required outputs
- **THEN** dependent phases do not run with fabricated or stale inputs
- **AND** final outcome reporting and cleanup still run when possible

#### Scenario: Delivered product cannot install, build, or serve
- **WHEN** deterministic verification establishes that the frozen final candidate cannot install, build, or serve because of reproducible product behavior
- **THEN** dependent browser and human-review phases do not run
- **AND** the evaluation applies the conclusive product-failure outcome without classifying the product defect as a harness failure

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

Source: `specs/evaluation-outcomes/spec.md`

### Requirement: Separate evaluation status and product verdict
The evaluation SHALL report execution status independently from candidate product quality. `evaluation_status` SHALL be exactly one of `complete`, `pending-human-review`, `implementation-workflow-failed`, or `evaluation-harness-failed`. `product_verdict` SHALL be exactly one of `pass`, `fail`, `unavailable`, or `not-applicable`.

A candidate product verdict SHALL be `pass` only after all required automated scoring, human scoring, and product gates have been completed from sufficient evidence. A candidate product verdict SHALL ordinarily be `fail` only after the same inputs establish that the pass contract was missed. As a narrow exception, deterministic evidence that reproducible product behavior prevents the frozen final candidate from installing, building, or serving SHALL be sufficient for a conclusive `fail` verdict without an official score or fabricated human ratings. A completed local reference SHALL use `product_verdict=not-applicable` because the candidate pass contract does not apply. The evaluation SHALL NOT infer product failure from a failed workflow, failed harness, unfinished human review, or candidate-reported CI state.

#### Scenario: Complete candidate passes
- **WHEN** all required candidate evaluation work completes and the official score and product gates satisfy the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `pass`

#### Scenario: Complete candidate fails
- **WHEN** all required candidate evaluation work completes but the official score or a product gate fails the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`

#### Scenario: Conclusive product failure prevents full scoring
- **WHEN** deterministic verification establishes that reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`
- **AND** `official_score` and human ratings remain unavailable while completed component and hard-gate evidence is preserved

#### Scenario: Complete local reference is reported
- **WHEN** all applicable reference scoring and human review complete
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `not-applicable`
- **AND** the result reports the reference score out of 92

#### Scenario: Non-product failure prevents scoring
- **WHEN** an implementation-workflow or evaluation-harness failure prevents reliable completion of required product scoring
- **THEN** `product_verdict` is `unavailable` rather than `fail`

### Requirement: Evaluation-harness failure outcome
The evaluation SHALL use `evaluation-harness-failed` when eval-owned setup, candidate-identity verification, non-CI evidence verification, candidate-server management, browser evaluation, evidence processing, scored judging, human-review persistence, scoring, result persistence, report generation, or cleanup fails in a way that prevents required evaluation work or finalization. A candidate-server failure established to result from reproducible product behavior SHALL follow the conclusive product-failure rule rather than this harness-failure rule.

The result SHALL identify the failed eval phase, observed error, completed checkpoints, and whether the phase can be resumed. A harness failure SHALL NOT be reported as a product defect or implementation-workflow defect.

#### Scenario: Browser evaluator cannot collect required evidence
- **WHEN** an eval-owned browser or evidence phase fails before sufficient product evidence is produced
- **THEN** `evaluation_status` is `evaluation-harness-failed` and `product_verdict` is `unavailable`

#### Scenario: Candidate installation, build, or server failure is product-owned
- **WHEN** the harness operates correctly but reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **THEN** the evaluation applies the conclusive product-failure outcome
- **AND** it does not report `evaluation-harness-failed`

#### Scenario: Required scored judge output is missing
- **WHEN** any judge job required for the applicable candidate or reference mode returns missing or invalid output
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

- Opening a presentation preserves and records its initial mode; each canonical-content, caption, present-mode, browse-mode, navigation, and boundary probe explicitly establishes the mode and position it requires.
- Presenter-hidden captions never fail canonical-content checks, while browse traversal still verifies all nine normative titles, captions, order, route, required scene content, and evolving-scene structure.
- Browser reliability and accessibility checks cover transitions, interactions, supported inputs, controls, focus, keyboard operation, current-state semantics, and captured runtime/console/page failures.
- Every probe and screenshot has evaluator ownership, settled-state metadata, revision-safe provenance, hashes, and independently verifiable checkpoint reuse for both pass and fail results.
- Product-owned install/build/serve failures create a conclusive unscored candidate fail and skip dependent browser/human work; tool, server-management, browser, or persistence defects remain harness failures.
- No new subjective visual review exists, and evaluator captures cannot increase the candidate testing-evidence score.
- Mock-driver tests cover mode restoration and all failure boundaries; the documented real-browser regression runs against the pinned reference and passes every caption and canonical-content criterion.
- Targeted candidate verification, server, AXI driver, browser evaluation, and controller tests pass, followed by `npm run check`.
