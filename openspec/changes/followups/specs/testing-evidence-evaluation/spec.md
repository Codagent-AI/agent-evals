## MODIFIED Requirements

### Requirement: Four-point testing-evidence score
The evaluation SHALL score candidate testing-evidence quality out of four points using four one-point binary criteria. A focused testing-evidence judge SHALL return a pass/fail verdict, rationale, and cited verified evidence for every criterion.

| Criterion | Points | Required behavior |
|---|---:|---|
| Traceable coverage | 1 | Verified evidence shows the user-visible behaviors the approved specs add were exercised, by any testing approach; a disclosed environmental impediment does not count, other disclosed omissions count proportionally, and undisclosed omissions fully. This is the only criterion that scores an omitted behavior. |
| Usable proof | 1 | Each claim that a basis scenario was exercised is backed by verified artifacts, such as logs, captures, transcripts, or recorded observations, in the bounded view; a claim that maps to no basis scenario does not fail this criterion, and a stated limitation is a disclosure and needs no proof. |
| Final-revision applicability | 1 | The recorded last-tested revision is the final SHA, or every product file the last diff-scoped pass's diff lists was explored, meaning the pass exercised the behavior or ran the command that executes it; a byte-identical mirror of an explored file and a command the acceptance workflow forbids running count as explored. |
| Complete and honest record | 1 | Gaps, limitations, self-played or simulated interactions, environment limits, CI status, warning dispositions, and unresolved findings are disclosed, and no completion, coverage, or outcome claim, whether or not it maps to a basis scenario, exceeds what the verified evidence shows. |

The rubric SHALL carry an explicit definition for each criterion, and the testing-evidence judge SHALL receive each definition beside its identifier together with the requirement and scenario headings of the approved specs as reference. Coverage SHALL NOT be measured against a fixed test-plan case inventory.

The evidence basis SHALL be the scenarios of the approved specs, as the harness enumerates them from those headings. It is the same for every candidate and does not depend on the candidate's exploration plan. A claim SHALL be material to usable proof when it asserts that a basis scenario was exercised or observed; whether a claim maps to a basis scenario SHALL be judged per claim. A claim about building or verifying the product counts when it maps to a basis scenario, such as one requiring the build to succeed or checks to run before completion.

- **Usable proof** SHALL fail only on a named material claim. Its fail SHALL identify the basis scenario, the claim, and the evidence that is missing or defective, including a claim with no artifact at all.
- **Complete and honest record** SHALL NOT compare the exploration plan with the log, and SHALL NOT fail for an omitted behavior, which traceable coverage alone scores. A demonstrably false or overstated claim SHALL fail it whether or not the claim is material to usable proof.

For usable proof and complete and honest record, a decider ruling SHALL return a bounded claim mapping with two parts:
- one row for each basis scenario the record claims was exercised, holding every claim the record makes about that scenario, across revisions, viewports, or runs, each with the location of the claim and the location of the evidence offered for it or that none was found;
- rows for claims and disclosures outside the basis that complete and honest record judges, such as CI status, stated limitations, and completion or outcome claims, each with its location and the location of its evidence.

The claim-bearing records SHALL be the record's acceptance flow record, exploration log, final handoff, and findings history. The testing-evidence judge packet SHALL hold them in full, never truncated, so every panel judge and the decider see the complete records and can cite any line of them, the completeness audit receives them in full, and the row audits and contradiction checks receive their cited lines from those same complete records. When those records alone would exceed the judge packet budget, or evidence collection skipped one of them for its size, the testing-evidence job SHALL fail as an evaluation-harness failure naming its criteria. Other artifacts MAY be truncated under the packet budget, marked as the product-quality-scoring robust judge verdicts requirement defines.

The mapping SHALL hold at most one row per basis scenario and at most 24 rows outside the basis. A row SHALL hold at most six claims, and each claim SHALL cite one claim span and at most four evidence spans, each span at most 40 lines. A record that claims every basis scenario SHALL therefore fit.

The decider's ruling SHALL be audited in two parts:
- **Row audits** SHALL receive the mapping's rows, in batches of whole rows, with the lines each row references, and SHALL judge each claim's evidence.
- **One completeness audit** SHALL receive the claim-bearing records in full and an index of the locations each mapped claim cites, without quoted text. It SHALL check that the mapping is complete against those records, SHALL classify the ruling `contradicted` when the mapping omits a claim that would change it, and SHALL cite the omitted claim's record and line.

The parts SHALL be recorded and settled as one multi-part audit, as the product-quality-scoring robust judge verdicts requirement defines.

When the claim-bearing records alone would exceed the packet limit, the job SHALL fail as an evaluation-harness failure naming both criteria.

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

#### Scenario: A build claim maps to a basis scenario
- **WHEN** the record claims the build passed and offers only a bare summary line as evidence
- **THEN** the claim is material, because the approved specs require the build to succeed before completion
- **AND** usable proof fails, naming that scenario, the claim, and the defective evidence

#### Scenario: A claim with no artifact fails usable proof
- **WHEN** the record claims a basis scenario was exercised and no artifact supports it
- **THEN** usable proof fails, naming the scenario, the claim, and the missing evidence

#### Scenario: A claim outside the basis
- **WHEN** the record claims a check that maps to no basis scenario passed, without supporting evidence
- **THEN** usable proof does not fail for that claim
- **AND** complete and honest record fails if verified evidence shows the claim is false

#### Scenario: An omitted behavior is scored once
- **WHEN** the exploration plan commits to a basis scenario that the log neither observed nor disclosed
- **THEN** traceable coverage counts the omission
- **AND** complete and honest record does not fail for that omission

#### Scenario: The span audit receives the claim mapping
- **WHEN** the decider passes usable proof for a record that claims many basis scenarios were exercised
- **THEN** its ruling returns the claim mapping, row audits check each row against the evidence lines it references, and a completeness audit checks the mapping against the full claim-bearing records
- **AND** a record claiming all of the basis scenarios, each with separate claim and evidence locations, fits within the mapping's bounds

#### Scenario: The mapping omits an inconvenient claim
- **WHEN** the decider passes usable proof with a mapping that leaves out a claim, made in the exploration log, that a basis scenario was exercised with no supporting evidence
- **THEN** the completeness audit, reading the exploration log in full, classifies the pass as contradicted and cites the omitted claim's line, even when that line lies beyond the excerpt in the judge packet
- **AND** the pass is withdrawn only when the contradiction check confirms that omission

#### Scenario: Panel judges see a claim deep in a long record
- **WHEN** the exploration log is longer than any per-artifact excerpt limit and claims, near its end, that a basis scenario was exercised with no supporting evidence
- **THEN** every panel judge receives that claim in the judge packet, so a unanimous pass cannot rest on a record the judges never saw
- **AND** when the claim-bearing records together exceed the judge packet budget, the testing-evidence job fails as an evaluation-harness failure rather than judging a truncated record

#### Scenario: One scenario is claimed several times
- **WHEN** the record claims a basis scenario was exercised at two viewports and at two revisions
- **THEN** that scenario's row holds all four claims, each with its own evidence location

#### Scenario: A CI claim lies outside the basis
- **WHEN** the record states CI passed at the final revision
- **THEN** the mapping lists that claim in its rows outside the basis, with its evidence location, for complete and honest record
