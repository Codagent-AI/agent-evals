# Task: Replace product evaluation and scoring

## Goal

Replace the legacy harness-health reward with the approved 100-point product rubric, deterministic browser evaluation, four focused product judge jobs, strict scorer-owned criterion coverage, and bounded evidence capture/repair. Produce reusable automated scoring artifacts that stop at an automated subtotal until human review is finalized.

## Background

Replace `evals/agent-runner/and-scene/rubric.json` with an explicit versioned automated rubric (use `evals/agent-runner/and-scene/automated-rubric.json`) and evolve `score.mjs`, `deterministic-checks.mjs`, `scene-shots.mjs`, `capture-policy.mjs`, `judge-manifest.mjs`, and `evidence-repair.sh` behind the suite-local controller. Add focused evaluator/judge/scorer modules under `evals/agent-runner/and-scene/lib/` and tests under `test/`.

Freeze candidate identity before scoring from the fixture commit, produced commit, normalized `implementation.diff`, and source manifest. Install, build, and non-browser verification precede server startup and browser evaluation. Product judges run sequentially as four independently retryable Codex jobs—demo integration, scene kit, presentation skill, and verification tooling—using one recorded CLI/model authority and strict JSON schemas.

Product judges receive only their rubric slice, approved fixture specs, relevant deterministic evidence, and read-only candidate source. They do not receive screenshots and do not judge visual taste. The scorer owns IDs, evaluator assignment, points, gates, thresholds, and arithmetic. A single evidence-repair attempt may edit only a temporary helper copy and is diagnostic-only: it no longer changes product points.

Use Node built-ins and existing browser tooling only; do not add runtime dependencies. Implement test-first, retain safe candidate-input boundaries and scan budgets, run targeted tests, and finish with `npm run check`.

## Spec

Source: `specs/product-quality-scoring/spec.md`

### Requirement: Official product score
The evaluation SHALL calculate a 100-point product score from the following components. Automated criteria SHALL use binary pass/fail verdicts. For every table row that lists multiple criteria, the row's points SHALL be divided equally among those criteria; the scorer SHALL NOT round intermediate values.

| Component | Points |
|---|---:|
| Demo presentation technical quality | 25 |
| Scene kit correctness | 25 |
| Presentation skill correctness | 10 |
| Verification tool correctness | 10 |
| Human review | 30 |

Runner health, workflow completion, evidence collection, judge execution, cost, timing, retries, and evidence repair SHALL award or deduct no product points. Before human review is complete, the evaluation SHALL report the automated subtotal out of 70 and SHALL NOT report an official total or pass verdict. When product evidence is available for only part of an unsuccessful or incomplete run, the evaluation SHALL preserve the available component scores without treating unobserved criteria as product failures.

#### Scenario: Complete product score
- **WHEN** automated scoring and human review have completed successfully
- **THEN** the evaluator reports each component score and their sum out of 100

#### Scenario: Human review is pending
- **WHEN** automated scoring has completed but human review has not
- **THEN** the evaluator reports the automated subtotal out of 70
- **AND** it does not report an official total or pass verdict

#### Scenario: Harness activity does not change product points
- **WHEN** evidence repair, retries, workflow execution, or other harness activity occurs
- **THEN** that activity is recorded diagnostically
- **AND** it neither awards nor deducts product points

#### Scenario: Partial product evidence is preserved
- **WHEN** a workflow or evaluation-harness failure prevents some product criteria from being observed
- **THEN** the evaluator preserves scores supported by completed evidence
- **AND** it marks the remaining product score incomplete rather than assigning failures to unobserved criteria

#### Scenario: Reference baseline uses the same product rubric
- **WHEN** the existing implementation is evaluated as a reference baseline
- **THEN** the evaluator applies the same automated criteria, human questions, weights, gates, thresholds, rubric versions, and score calculation used for Agent Runner candidates

### Requirement: Demo presentation technical quality
The evaluation SHALL score the delivered demo presentation out of 25 using the following rubric. Deterministic browser evaluation SHALL inspect the built, running demo. LLM source review SHALL inspect the delivered source and supporting evidence. The LLM SHALL assess technical implementation and SHALL NOT assess visual taste, perceived motion quality, or responsive aesthetics, which belong to human review.

| Subcomponent | Points | Evaluator | Criteria |
|---|---:|---|---|
| Canonical content, routing, and technical structure | 5 | Deterministic browser | `demo-route-and-registration`, `demo-nine-step-content-and-order`, `demo-required-scene-content`, `demo-evolving-scene-structure`, `quality-captions-and-navigation` |
| Navigation, modes, boundaries, and controls | 5 | Deterministic browser | `demo-present-mode-behavior`, `demo-browse-mode-behavior`, `demo-mode-position-preservation`, `demo-supported-navigation`, `demo-navigation-boundaries-and-control-keys` |
| Runtime reliability and accessibility baseline | 4 | Deterministic browser | `demo-step-and-transition-reliability`, `demo-mode-interaction-reliability`, `demo-control-semantics`, `demo-focus-and-keyboard-accessibility` |
| Uses scene-kit APIs without bypassing or duplicating them | 4 | LLM source review | `demo-scene-kit-api-use` |
| Uses stable identities and appropriate grouped-scene architecture | 3 | LLM source review | `demo-stable-identity-and-grouping` |
| Maintains clear demo/kit boundaries and understandable code | 3 | LLM source review | `demo-clear-code-boundaries`, `quality-active-chrome-and-attribution-local` |
| Avoids unnecessary duplication and out-of-scope machinery | 1 | LLM source review | `demo-scope-discipline` |

The canonical-content checks SHALL verify the registered demo route, the nine required steps in their specified order, their normative titles, captions, and scene content, and their implementation as one evolving scene. The navigation checks SHALL exercise present and browse modes, mode changes, supported navigation inputs, direct controls, and end boundaries. The reliability and accessibility checks SHALL exercise step transitions and mode interactions, monitor browser failures, and inspect control semantics, current-state exposure, focus behavior, and keyboard operability.

#### Scenario: Deterministic demo behavior is scored
- **WHEN** the built demo is available to the evaluator
- **THEN** deterministic browser checks exercise every demo criterion assigned to them
- **AND** the scorer applies the listed point allocations to their pass/fail results

#### Scenario: Demo source integration is scored
- **WHEN** the LLM judge reviews the demo implementation
- **THEN** it returns a pass/fail verdict, rationale, and cited source evidence for every demo criterion assigned to it
- **AND** the suite-owned scorer applies the listed weights

#### Scenario: Subjective quality is not assigned to the LLM
- **WHEN** the LLM judge evaluates demo technical quality
- **THEN** it does not score visual composition, perceived transition quality, responsive visual quality, or overall polish

#### Scenario: Live demo and reusable kit are assessed separately
- **WHEN** the demo correctly calls a scene-kit behavior whose reusable implementation is defective
- **THEN** the demo criterion may pass based on correct integration
- **AND** the corresponding scene-kit criterion may fail based on the defective reusable implementation

### Requirement: Scene kit correctness
The evaluation SHALL score the reusable scene kit out of 25 using LLM review of delivered source and structured browser evidence. The judge SHALL assess implementation of the technical contracts rather than the aesthetic quality of the demo that uses them.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Step model, stable identity, and typed boundary | 4 | `scene-step-narration-and-identity`, `scene-order-derived-numbering`, `scene-typed-payload-boundary` |
| Entity transitions and persistent grouped scenes | 7 | `entity-persisting-morph`, `entity-newcomer-after-settle`, `entity-departing-exit`, `grouped-scene-updates-in-place`, `grouped-continuing-entities-not-newcomers`, `grouped-intentional-composition` |
| Present/browse modes, navigation, controls, and boundaries | 6 | `mode-present-title-focused`, `mode-browse-reading-focused`, `mode-toggle-preserves-position`, `navigation-keyboard`, `navigation-touch-swipe`, `navigation-direct-jump`, `navigation-active-state`, `navigation-controls-keep-keys`, `navigation-clamp-start`, `navigation-clamp-end` |
| Fixed-canvas behavior | 2 | `canvas-uniform-scaling`, `canvas-default-dimensions` |
| Style ownership, hooks, framework neutrality, and attribution | 6 | `style-kit-hooks`, `style-unstyled-kit-output`, `style-framework-optional`, `style-coordinate-heavy-diagrams`, `attribution-default-link`, `attribution-styling-hook`, `attribution-top-left-opt-in` |

#### Scenario: Scene-kit contracts are scored
- **WHEN** the LLM judge evaluates the reusable scene kit
- **THEN** it returns a pass/fail verdict, rationale, and cited evidence for every listed scene-kit criterion
- **AND** the scorer divides each subcomponent's points equally among that subcomponent's criteria

#### Scenario: Technical continuity is distinguished from perceived quality
- **WHEN** the judge evaluates entity identity, grouping, or transition implementation
- **THEN** it scores whether the required technical mechanism and behavior are present
- **AND** it leaves perceived transition smoothness and visual composition quality to human review

### Requirement: Presentation skill correctness
The evaluation SHALL score the delivered presentation skill out of 10 using LLM review of the skill, its templates, delivered source, and workflow evidence.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Requirement gathering and proceeding with partial detail | 2 | `skill-missing-details-one-at-a-time`, `skill-partial-detail-proceeds`, `skill-complete-prompt-proceeds` |
| Scaffold detection, location, dependencies, and style neutrality | 4 | `skill-empty-directory-scaffold`, `skill-already-scaffolded`, `skill-partial-scaffold`, `skill-scaffold-style-neutral`, `skill-template-path-resolution`, `skill-monorepo-target`, `skill-standalone-target`, `skill-nonempty-confirmation` |
| Create, modify, route, and preserve presentations | 2 | `skill-new-presentation-routed`, `skill-presentation-owns-style`, `skill-existing-presentations-preserved`, `skill-modify-ambiguous-target`, `skill-scoped-modification` |
| Self-verification and fixing failures before completion | 2 | `skill-checks-run-before-done`, `skill-failures-fixed-before-success`, `quality-visual-composition-inspected`, `quality-visual-warnings-reviewed` |

#### Scenario: Skill contracts are scored
- **WHEN** the LLM judge evaluates the presentation skill
- **THEN** it returns a pass/fail verdict, rationale, and cited evidence for every listed skill criterion
- **AND** the scorer divides each subcomponent's points equally among that subcomponent's criteria

#### Scenario: Dogfooded demo provides skill evidence
- **WHEN** the workflow task builds the demo by following the delivered skill or its prompt file
- **THEN** the judge may cite the resulting implementation and workflow record as evidence of skill behavior
- **AND** it still evaluates the delivered skill contract directly

### Requirement: Verification tool correctness
The evaluation SHALL score the delivered verification tooling out of 10 using LLM review of its source, executable behavior, and produced artifacts. The four hard-gate criteria SHALL remain outside this point allocation.

| Subcomponent | Points | Criteria |
|---|---:|---|
| Detects a missing reference sample | 2 | `verification-missing-sample-fails` |
| Preview addressing and runtime/step error detection | 3 | `verification-ipv4-loopback`, `verification-console-page-error-fails`, `verification-step-error-fails` |
| Complete, settled screenshot capture | 2 | `quality-project-local-screenshot-helper`, `visual-helper-captures-steps`, `visual-helper-settled-screenshots` |
| Overlap, active-state, and attribution warnings | 3 | `visual-helper-overlap-warning`, `visual-helper-allow-overlap`, `visual-helper-active-state-warning`, `visual-helper-attribution-warning` |

#### Scenario: Verification contracts are scored
- **WHEN** the LLM judge evaluates the verification tooling
- **THEN** it returns a pass/fail verdict, rationale, and cited evidence for every listed verification criterion
- **AND** the scorer divides each subcomponent's points equally among that subcomponent's criteria

#### Scenario: Hard-gate behavior is excluded from verification points
- **WHEN** the scorer calculates the verification-tool component
- **THEN** it does not award points for `verification-build-whole-app`, `verification-sample-outline`, `verification-every-produced-step-renders`, or `verification-clear-outcome`

### Requirement: Existing criterion disposition
The revised rubric SHALL classify each of the 68 existing rubric criteria exactly once. It SHALL retain 61 as scored product criteria, use four exclusively as hard gates, and remove three from scoring.

| Disposition | Count | Criteria |
|---|---:|---|
| Demo presentation technical quality | 2 | `quality-captions-and-navigation`, `quality-active-chrome-and-attribution-local` |
| Scene kit correctness | 28 | `scene-step-narration-and-identity`, `scene-order-derived-numbering`, `scene-typed-payload-boundary`, `entity-persisting-morph`, `entity-newcomer-after-settle`, `entity-departing-exit`, `grouped-scene-updates-in-place`, `grouped-continuing-entities-not-newcomers`, `grouped-intentional-composition`, `style-kit-hooks`, `style-unstyled-kit-output`, `style-framework-optional`, `style-coordinate-heavy-diagrams`, `attribution-default-link`, `attribution-styling-hook`, `attribution-top-left-opt-in`, `mode-present-title-focused`, `mode-browse-reading-focused`, `mode-toggle-preserves-position`, `navigation-keyboard`, `navigation-touch-swipe`, `navigation-direct-jump`, `navigation-active-state`, `navigation-controls-keep-keys`, `navigation-clamp-start`, `navigation-clamp-end`, `canvas-uniform-scaling`, `canvas-default-dimensions` |
| Presentation skill correctness | 20 | `skill-missing-details-one-at-a-time`, `skill-partial-detail-proceeds`, `skill-complete-prompt-proceeds`, `skill-empty-directory-scaffold`, `skill-already-scaffolded`, `skill-partial-scaffold`, `skill-scaffold-style-neutral`, `skill-template-path-resolution`, `skill-monorepo-target`, `skill-standalone-target`, `skill-nonempty-confirmation`, `skill-new-presentation-routed`, `skill-presentation-owns-style`, `skill-existing-presentations-preserved`, `skill-modify-ambiguous-target`, `skill-scoped-modification`, `skill-checks-run-before-done`, `skill-failures-fixed-before-success`, `quality-visual-composition-inspected`, `quality-visual-warnings-reviewed` |
| Verification tool correctness | 11 | `quality-project-local-screenshot-helper`, `verification-missing-sample-fails`, `verification-ipv4-loopback`, `verification-console-page-error-fails`, `verification-step-error-fails`, `visual-helper-captures-steps`, `visual-helper-settled-screenshots`, `visual-helper-overlap-warning`, `visual-helper-allow-overlap`, `visual-helper-active-state-warning`, `visual-helper-attribution-warning` |
| Hard gates | 4 | `verification-build-whole-app`, `verification-sample-outline`, `verification-every-produced-step-renders`, `verification-clear-outcome` |
| Removed from scoring | 3 | `skill-optional-ascii-mockup`, `quality-builds-clean`, `quality-renders-without-errors` |

The removed criteria MAY remain fixture requirements. `skill-optional-ascii-mockup` SHALL be excluded because it describes optional behavior. `quality-builds-clean` and `quality-renders-without-errors` SHALL be excluded because stronger hard gates cover those outcomes.

#### Scenario: Existing criteria are completely classified
- **WHEN** the revised rubric is validated
- **THEN** all 68 existing criterion IDs appear in exactly one disposition
- **AND** the disposition counts are 61 scored criteria, four gates, and three removed criteria

#### Scenario: Optional behavior is not scored
- **WHEN** the skill does not produce an ASCII mockup
- **THEN** the product score is unchanged

#### Scenario: Removed duplicate criteria are not double-counted
- **WHEN** build or every-step rendering is evaluated
- **THEN** the applicable hard gate determines pass eligibility
- **AND** no duplicate point criterion awards or deducts product points for the same baseline outcome

### Requirement: Hard gates and official pass
The evaluation SHALL apply the following four product hard gates separately from point scoring.

| Gate criterion | Required behavior |
|---|---|
| `verification-build-whole-app` | The complete application builds successfully |
| `verification-sample-outline` | The canonical nine-step sample exists, is registered and reachable, and matches its required outline |
| `verification-every-produced-step-renders` | Every produced step renders without runtime or console errors |
| `verification-clear-outcome` | Verification produces an unambiguous machine-readable pass/fail result |

An official pass SHALL require all of the following: a total score of at least 70 out of 100; at least 15 out of 25 for demo technical quality; at least 15 out of 25 for scene-kit correctness; at least 15 out of 30 for human review; no individual human rating of 1; all four hard gates passing; and successful completion of the evaluation phases required to establish those results. The skill and verification point components SHALL have no separate minimum scores.

Failure of a hard gate SHALL prevent an official pass but SHALL NOT erase the numerical product score supported by available evidence. A workflow failure, evaluation-harness failure, or pending human review that prevents the official pass contract from being evaluated SHALL make the product verdict unavailable rather than converting unobserved product behavior into a product failure. A harness failure after an official score and verdict have been durably recorded SHALL preserve that product result under the evaluation-outcomes rules.

#### Scenario: Candidate satisfies the official pass contract
- **WHEN** a candidate scores at least 70 overall, meets all three component floors, has no human rating of 1, passes all four hard gates, and completes every required evaluation phase
- **THEN** the official pass verdict is true

#### Scenario: Numerical threshold is missed
- **WHEN** a completed candidate scores below 70 overall
- **THEN** the official pass verdict is false

#### Scenario: Component floor is missed
- **WHEN** a completed candidate scores at least 70 overall but misses the demo, scene-kit, or human-review floor
- **THEN** the official pass verdict is false

#### Scenario: Hard gate fails
- **WHEN** a completed candidate fails any hard gate
- **THEN** the official pass verdict is false
- **AND** the evaluator still reports the numerical score supported by available evidence

#### Scenario: Required evaluation phase is incomplete
- **WHEN** workflow failure, harness failure, or pending human review prevents the official pass contract from being evaluated
- **THEN** the evaluator does not report an official pass or fail verdict
- **AND** it reports the applicable incomplete outcome separately

### Requirement: Controlled scoring and rubric provenance
The suite-owned scorer SHALL own criterion identifiers, evaluator assignments, point allocations, hard gates, thresholds, and final calculations. Neither the LLM judge nor the human-review interface SHALL be permitted to change those policies while producing evaluation results. Every machine-evaluated criterion result SHALL include its identifier, pass/fail verdict, rationale, and cited evidence.

The automated product rubric and human-review rubric SHALL have distinct explicit version identifiers. The result SHALL record each rubric's version and SHA-256 hash. Rubric validation SHALL reject missing, duplicate, unknown, or malformed criterion results rather than changing the scoring denominator or silently ignoring them.

#### Scenario: Judge returns findings but does not control scoring
- **WHEN** the LLM judge completes its review
- **THEN** it returns verdicts, rationales, and cited evidence for the criteria assigned to it
- **AND** the suite-owned scorer applies evaluator assignments, weights, gates, and thresholds

#### Scenario: Criterion coverage is invalid
- **WHEN** evaluator output contains a missing, duplicate, unknown, or malformed criterion result
- **THEN** rubric validation fails
- **AND** no official score or verdict is produced from that output

#### Scenario: Rubric provenance is recorded
- **WHEN** an evaluation result is written
- **THEN** it records distinct version identifiers and SHA-256 hashes for the automated product rubric and human-review rubric

## Done When

- Versioned automated and human rubric provenance is validated and hashed, all 68 legacy criterion IDs have the approved one-time disposition, and every automated criterion has exactly one valid evaluator result.
- Deterministic checks exercise the live built demo, navigation/modes/boundaries, runtime errors, accessibility baseline, canonical nine-step content, and hard gates; source-review jobs cover their four approved components without visual-taste judgments.
- The scorer produces component/subcomponent/criterion/gate breakdowns, an automated subtotal out of 70 while review is pending, and an official 100-point score only when a valid human score is supplied.
- Known negative product findings remain completed reusable evidence, missing or malformed criterion coverage fails validation, and incomplete evidence is never silently converted to a product failure or rescaled score.
- Tests cover all-pass arithmetic, thresholds and component floors, human rating-one behavior, each hard gate, malformed judge output, component-local retry, evidence repair isolation, and candidate-controlled input escaping/bounds.
- Targeted tests and `npm run check` succeed.
