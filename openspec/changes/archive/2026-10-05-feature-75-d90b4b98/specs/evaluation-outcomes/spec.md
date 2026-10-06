## MODIFIED Requirements

### Requirement: Separate evaluation status and product verdict
The evaluation SHALL report execution status independently from candidate product quality. `evaluation_status` SHALL be exactly one of `complete`, `pending-human-review`, `implementation-workflow-failed`, or `evaluation-harness-failed`. `product_verdict` SHALL be exactly one of `pass`, `fail`, `unavailable`, or `not-applicable`.

A candidate product verdict SHALL be `pass` only after all required automated scoring, human scoring, and product gates have been completed from sufficient evidence. A candidate product verdict SHALL ordinarily be `fail` only after the same inputs establish that the pass contract was missed. Complete automated evidence SHALL also be sufficient for a conclusive `fail` without human review when the candidate scores below 40 out of 70, misses either automated component floor, or fails any required hard gate, because no human result can satisfy the official pass contract. As a further narrow exception, deterministic evidence that reproducible product behavior prevents the frozen final candidate from installing, building, or serving, once its second opinion upholds it, SHALL be sufficient for a conclusive `fail` verdict without an official score or fabricated human ratings. A completed local reference SHALL use `product_verdict=not-applicable` because the candidate pass contract does not apply. The evaluation SHALL NOT infer product failure from incomplete automated evidence, a failed workflow, failed harness, unfinished eligible human review, or candidate-reported CI state.

#### Scenario: Complete product passes
- **WHEN** all required candidate evaluation work completes and the official score and product gates satisfy the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `pass`

#### Scenario: Complete product fails
- **WHEN** all required candidate evaluation work completes but the official score or a product gate fails the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`

#### Scenario: Conclusive product failure prevents full scoring
- **WHEN** deterministic verification establishes that reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **AND** the failure's second opinion upholds it
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`
- **AND** `official_score` and human ratings remain unavailable while completed component and hard-gate evidence is preserved

#### Scenario: Complete automated result cannot pass
- **WHEN** complete candidate automated scoring is below 40 out of 70, misses an automated component floor, or fails a required hard gate
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`
- **AND** the result preserves the automated score and structured failures but contains no `official_score` or human ratings

#### Scenario: Complete local reference is reported
- **WHEN** all applicable reference scoring and human review complete
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `not-applicable`
- **AND** the result reports the reference score out of 92

#### Scenario: Non-product failure prevents scoring
- **WHEN** an implementation-workflow or evaluation-harness failure prevents reliable completion of required product scoring
- **THEN** `product_verdict` is `unavailable` rather than `fail`

### Requirement: Evaluation-harness failure outcome
The evaluation SHALL use `evaluation-harness-failed` when eval-owned setup, candidate-identity verification, non-CI evidence verification, candidate-server management, browser evaluation, evidence processing, scored judging, human-review persistence, scoring, result persistence, report generation, or cleanup fails in a way that prevents required evaluation work or finalization. A candidate-server failure established to result from reproducible product behavior SHALL follow the conclusive product-failure rule rather than this harness-failure rule, unless its second opinion overturns it. An install, build, or serve failure whose second-opinion overturn is accepted SHALL be reported as a resumable `evaluation-harness-failed` outcome owned by the phase that recorded the failure. The result SHALL record the raw product-owned failure, the accepted overturn, its rationale, and its log and source citations. A missing or invalid second opinion SHALL be treated as missing required judge output.

The result SHALL identify the failed eval phase, observed error, completed checkpoints, and whether the phase can be resumed. A harness failure SHALL NOT be reported as a product defect or implementation-workflow defect.

#### Scenario: Browser evaluator cannot collect required evidence
- **WHEN** an eval-owned browser or evidence phase fails before sufficient product evidence is produced
- **THEN** `evaluation_status` is `evaluation-harness-failed` and `product_verdict` is `unavailable`

#### Scenario: Candidate installation, build, or server failure is product-owned
- **WHEN** the harness operates correctly but reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **AND** the failure's second opinion upholds it
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

#### Scenario: A terminal failure is overturned
- **WHEN** a build or serve failure was recorded as product-owned and its second-opinion overturn is accepted
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` is `unavailable`, and the failed phase is resumable
- **AND** the result shows the raw failure, the accepted overturn, and its citations

#### Scenario: A failed criterion's second opinion is missing
- **WHEN** a verifier call required for a criterion or hard gate fails within its retry budget
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the unchecked failure is not used to issue a product verdict
