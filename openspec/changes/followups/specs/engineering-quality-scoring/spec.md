## MODIFIED Requirements

### Requirement: Engineering quality component
The automated product rubric SHALL contain an `engineering-quality` component, titled "Engineering quality beyond the spec", worth 8 points with no floor. It SHALL score qualities that a good implementation has even though the pinned fixture's planning documents do not require them. Every criterion in it SHALL be eval-owned. Its recorded reason SHALL state the complete pass condition, because judges and second-opinion verifiers read the reason as the criterion's requirement. Each criterion SHALL test one narrow quality, so that its verdict discriminates between implementations rather than failing almost every run.

The component's criteria SHALL carry importance tiers like every other scored criterion, with tier weights critical 1.375, major 0.625, and minor 0.375.

| Subcomponent | Points | Evaluator | Criteria |
|---|---:|---|---|
| Input hygiene | 0.75 | Deterministic browser | Minor: `input-modifier-keys-pass-through`, `input-swipe-from-control-ignored` |
| Verification tooling robustness | 3 | LLM source review (`engineering-quality` job) | Major: `engineering-preview-terminated-on-every-exit`, `engineering-preview-readiness-bounded`, `engineering-bootstrap-scripts-generic`. Minor: `engineering-inspect-fails-loudly`, `engineering-checks-read-rendered-page`, `engineering-diagnostics-cover-presentation` |
| Skill instructions and templates | 2.5 | LLM source review (`engineering-quality` job) | Critical: `engineering-templates-build-at-destination`. Minor: `engineering-skill-description-triggers`, `engineering-skill-out-of-scope-redirects`, `engineering-skill-completion-report` |
| Presentation code and tests | 1.75 | LLM source review (`engineering-quality` job) | Major: `engineering-presentation-css-scoped`. Minor: `engineering-typed-kit-primitives`, `engineering-tests-wait-on-state`, `engineering-tests-isolate-resources` |

The component SHALL apply to both candidates and the reference baseline. The scorer SHALL award each criterion its tier weight, under the tier rules of the product-quality-scoring capability, without rounding intermediate values. A subcomponent's points SHALL be the sum of its criteria's weights.

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

#### Scenario: A critical engineering criterion outweighs a minor one
- **WHEN** a candidate fails `engineering-templates-build-at-destination` and passes every other engineering-quality criterion
- **THEN** the component reports 6.625 of 8

### Requirement: Engineering-quality judge job
The evaluator SHALL run a focused `engineering-quality` source-review judge job. The job SHALL return exactly the fourteen LLM-judged engineering-quality criteria. The job SHALL receive the same neutral source snapshot, neutral requirements bundle, and untrusted-data handling as the other implementation source-review jobs, and SHALL use the same judging protocol they use: the cross-family panel (`cross-family-panel-v2`) of one Claude-family and two Codex-family judges with the line-cited decider, for candidates and for the reference baseline alike. Like every other deterministic browser criterion, `input-modifier-keys-pass-through` and `input-swipe-from-control-ignored` SHALL each declare the `demo-integration` judge as their fallback.

#### Scenario: The job returns exactly its criteria
- **WHEN** the engineering-quality job completes
- **THEN** it returns exactly the fourteen LLM-judged engineering-quality criteria, whether or not either input-hygiene probe was observed

#### Scenario: The job is judged by the cross-family panel
- **WHEN** the engineering-quality job runs for a candidate or for the reference baseline
- **THEN** its criteria are judged by the same cross-family panel as the other scored judge jobs, and a criterion the panel disputes is settled by the line-cited decider

#### Scenario: A not-observed input-hygiene probe falls back to demo integration
- **WHEN** `input-swipe-from-control-ignored` is recorded as not observed
- **THEN** the demo-integration judge's expected criterion set includes that criterion, and the engineering-quality job's does not
