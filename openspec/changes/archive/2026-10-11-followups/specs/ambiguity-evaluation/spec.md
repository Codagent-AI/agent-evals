## MODIFIED Requirements

### Requirement: Four-point assumption-handling score
The evaluation SHALL score candidate assumption-handling quality out of four points using four one-point binary criteria. A focused assumption-handling judge SHALL return a pass/fail verdict, rationale, and cited verified evidence for every criterion.

| Criterion | Points | Required behavior |
|---|---:|---|
| Consequential ambiguities surfaced | 1 | Consequential ambiguities and context gaps are identified rather than silently resolved or omitted. |
| Repository facts distinguished from specification gaps | 1 | Discoverable repository context, legitimate implementation flexibility, and genuine specification gaps are distinguished accurately. |
| Decisions and escalations are proportionate | 1 | Decisions, assumptions, and escalations are evidence-backed, within authority, and proportionate to consequence and uncertainty. |
| Final handoff preserves decisions | 1 | The handoff is evidence-backed and actionable, and preserves unresolved decisions, options, consequences, and known limitations. |

The assumption-handling judge packet SHALL hold its primary claim-bearing records in full, never truncated: the assumptions ledger, final handoff, findings history, and exploration log. Every panel judge and the decider SHALL see the complete records, and the audits and checks SHALL receive their cited lines from those same complete records. When those records alone would exceed the judge packet budget, or evidence collection skipped one of them for its size, the assumption-handling job SHALL fail as an evaluation-harness failure naming its criteria. The approved requirements the judge receives as reference SHALL likewise be complete, or the job SHALL fail the same way. Other supporting artifacts MAY be truncated under the packet budget, marked as the product-quality-scoring robust judge verdicts requirement defines.

The component SHALL have no independent score floor. For a reference-baseline evaluation, the component SHALL be not applicable and SHALL contribute neither points earned nor points possible.

#### Scenario: Genuine unresolved gap is handled well
- **WHEN** the candidate surfaces a genuine consequential specification gap, distinguishes it from repository facts, escalates proportionately, and preserves it actionably in the handoff
- **THEN** the unresolved state does not by itself fail any assumption-handling criterion

#### Scenario: Candor is never scored below silence
- **WHEN** one workflow surfaces an unverified gap with its consequence and options, including the option to accept the limitation, and another workflow omits the same gap that its plan or evidence shows
- **THEN** the surfacing workflow scores no lower on any assumption-handling criterion
- **AND** the omitting workflow fails the surfaced-ambiguities criterion

#### Scenario: An unreproduced gap is surfaced as a decision
- **WHEN** the workflow surfaces a gap it found by reading code but did not reproduce, framed as a decision with options and the consequence of accepting it
- **THEN** the repository-facts and decisions criteria do not fail for that framing

#### Scenario: A reproduced violation is omitted
- **WHEN** the record shows the workflow observed a requirement violation in a run and never surfaces it
- **THEN** the surfaced-ambiguities, repository-facts, and decisions criteria fail
- **AND** the assumption judge finds it through the omission check against the approved requirements

#### Scenario: A plan commitment is neither observed nor disclosed
- **WHEN** the exploration plan commits to a behavior the log neither observed nor disclosed and no requirement deviation is shown
- **THEN** the surfaced-ambiguities criterion does not fail for it
- **AND** the omission is scored once, under testing-evidence traceable coverage

#### Scenario: Final handoff names decisions and points to the ledger
- **WHEN** the handoff names each unresolved decision by identifier and subject and points to the ledger entry that holds its consequence and options
- **THEN** it preserves those decisions
- **AND** a handoff that gives only a count of open decisions and a pointer does not

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

#### Scenario: Reproduced product defect is misclassified as environmental
- **WHEN** workflow evidence reproduces candidate behavior that violates an approved requirement but the workflow calls it environmental, not a finding, or optional hardening
- **THEN** the repository-facts distinction criterion fails
- **AND** the decisions-and-escalations criterion fails when the workflow clears the environmental trigger without reporting the observed candidate defect
- **AND** the surfaced-ambiguities criterion remains independently scored from whether the observation was recorded
- **AND** the final-handoff criterion remains eligible to pass when the handoff preserves the raw observation, consequence, and actionable correction rather than omitting them

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

#### Scenario: A long assumptions ledger
- **WHEN** the assumptions ledger is longer than any per-artifact excerpt limit
- **THEN** every panel judge and the decider receive it in full, and any line of it can be cited and audited
- **AND** when the primary records together exceed the judge packet budget, the assumption-handling job fails as an evaluation-harness failure rather than judging a truncated record
