# testing-evidence-evaluation Specification

## Purpose
TBD - created by archiving change make-evals-greater. Update Purpose after archive.
## Requirements
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

### Requirement: Required evidence before scored judging
Before scored product judging begins, the evaluation SHALL require readable candidate-produced acceptance flow evidence, screenshot evidence, findings history, final handoff, and assumptions ledger. An exploration log SHALL satisfy the acceptance flow evidence requirement. A screenshot capture metadata file SHALL be optional; a screenshot without one SHALL be verified only when a verified candidate record that states what was inspected and observed names its path, its filename, or a per-flow or per-screenshot subdirectory holding it in path form. A shared screenshot root directory, identified by name at any depth, SHALL NOT describe an individual screenshot. It SHALL also require a verifiable candidate repository, draft pull request, final local commit, pull-request head, and pull-request base identity.

If the evaluated workflow fails to produce those required artifacts or identities, the evaluation SHALL report `implementation-workflow-failed`, preserve available diagnostics, and SHALL NOT begin scored product judging or issue an official product score or verdict. If those inputs exist but the harness cannot process otherwise valid inputs because of an evaluator defect, it SHALL report `evaluation-harness-failed`.

#### Scenario: Exploratory acceptance evidence is complete
- **WHEN** the candidate's evidence directory holds an exploration log, findings, handoff, assumptions ledger, and screenshots under `acceptance-screenshots/` that the log or handoff names, with no flow record or screenshot metadata file
- **THEN** the harness reports no missing evidence role
- **AND** it verifies the named screenshots against the records that describe them

#### Scenario: Acceptance did not converge
- **WHEN** Agent Runner's acceptance gate replaced `acceptance-handoff.md` with its generated non-convergence notice and kept the tester's handoff as `acceptance-handoff-tester.md`
- **THEN** the tester handoff fills the final-handoff role
- **AND** the notice is retained under the `acceptance-gate-notice` role and shown to evidence judges as Runner-generated context
- **AND** the notice fills the final-handoff role only when no candidate-written handoff exists

#### Scenario: Per-round screenshot metadata is named by bare filename
- **WHEN** a record names `round-1-screenshot-metadata.md`, which lives in `acceptance-screenshots/`
- **THEN** the harness resolves the bare filename to the one scanned file with that name and keeps it as `screenshot-metadata`
- **AND** an ambiguous bare filename stays unresolved
- **AND** without usable JSON metadata a screenshot stays verified only when a verified record, including a Markdown metadata file, names it

#### Scenario: A record references a file with no evidence role
- **WHEN** a verified record references a file such as a skill or source file that matches no evidence role
- **THEN** the file is retained as `referenced-material` rather than as a session audit

#### Scenario: Required candidate evidence is missing
- **WHEN** the completed workflow omits a required acceptance artifact
- **THEN** the evaluation reports `implementation-workflow-failed`
- **AND** scored product judging does not begin

#### Scenario: Final candidate identity is unverifiable
- **WHEN** the harness cannot establish the required repository, draft-PR, base, local-head, and PR-head identity
- **THEN** the evaluation reports `implementation-workflow-failed`
- **AND** it preserves the available workflow diagnostics without issuing a product score

#### Scenario: Evidence is present but poor
- **WHEN** all required artifacts and identities exist but their contents are stale, incomplete, misleading, or tied to the wrong revision
- **THEN** scored judging proceeds against the established final candidate
- **AND** the testing-evidence judge withholds points for the applicable defects

#### Scenario: Harness cannot process valid evidence
- **WHEN** required valid evidence exists but an evaluator defect prevents it from being read or validated
- **THEN** the evaluation reports `evaluation-harness-failed`
- **AND** it does not classify the failure as an implementation-workflow failure

### Requirement: Final-revision evidence provenance
The evaluation SHALL verify a coherent acceptance-evidence lineage terminating at the final evaluated pull-request SHA. The final handoff, local `HEAD`, and pull-request head SHALL identify that SHA. When candidate-produced acceptance evidence reports CI status, it SHALL identify the revision to which that status applies or explicitly state that CI evidence is absent, pending, or unavailable. The harness SHALL NOT independently query CI or require a particular CI state before judging.

The final-revision criterion SHALL accept a diff-scoped re-test in place of a full re-run. The harness SHALL supply deterministic facts from verified candidate evidence and Git only: the revision the candidate recorded as last tested, whether Git resolves it to the final SHA or an ancestor of it, and the files changed from it to the final SHA, split into product, test-only, and harness-owned paths. For each verified pass record that declares the diff base of its pass, the harness SHALL also supply the files changed between that base and the revision the pass tested. Final-revision applicability SHALL be established when the recorded tested revision is the final SHA, or is an ancestor with no later product changes, and every diff-scoped pass is shown by verified evidence to have explored the product changes since its declared base. It SHALL NOT be established when the final revision has product changes after the last recorded tested revision that no verified pass explored, when no tested revision is recorded, or when the recorded revision is not an ancestor of the final SHA. A candidate record that names an ancestor of the final SHA SHALL be verified as a record of that earlier revision rather than treated as a revision mismatch.

#### Scenario: Last pass tested the final revision
- **WHEN** the verified tested-revision record names the final evaluated SHA
- **THEN** the evaluation accepts the final-revision lineage without requiring a full re-run of earlier passes

#### Scenario: Diff-scoped re-test after a fix
- **WHEN** an earlier pass tested an ancestor SHA, a fix followed, and a later verified pass declares that SHA as its diff base and explores the files changed since
- **THEN** the harness supplies the changed files for that diff
- **AND** the final-revision criterion passes when the verified pass record shows those product changes were explored

#### Scenario: Only tests or harness files changed after the last pass
- **WHEN** the recorded tested revision is an ancestor of the final SHA and every later change is test-only or harness-owned
- **THEN** the evaluation accepts the final-revision lineage

#### Scenario: Product changed after the last tested revision
- **WHEN** product files changed after the last recorded tested revision and no verified pass explored them
- **THEN** the harness records the untested product changes
- **AND** the testing-evidence judge withholds the final-revision evidence point

#### Scenario: Earlier pass records are retained
- **WHEN** the candidate keeps the exploration log, findings, or other records of an earlier acceptance pass
- **THEN** the harness includes them in the bounded testing-evidence view
- **AND** a record naming an ancestor of the final SHA is verified as evidence about that revision

### Requirement: Evidence integrity and contradiction handling
The evaluation SHALL treat candidate evidence as untrusted. Before judging it, the harness SHALL verify referenced files, hashes, screenshot metadata, revision claims, requirement and flow coverage, and pull-request identity. It SHALL preserve missing, malformed, stale, or contradictory evidence as findings and SHALL NOT silently repair, replace, or reinterpret candidate-produced evidence. It SHALL treat CI status as a candidate-produced claim and SHALL NOT query GitHub checks or other CI systems to replace or validate that claim.

#### Scenario: Referenced evidence verifies
- **WHEN** every candidate citation resolves to an artifact with matching integrity and revision metadata
- **THEN** the harness marks those citations verified for judging

#### Scenario: Citation is missing or altered
- **WHEN** a cited file does not exist or its recorded hash does not match
- **THEN** the harness records the integrity failure
- **AND** the affected claim cannot earn testing-evidence credit

#### Scenario: Screenshot metadata is inconsistent
- **WHEN** screenshot metadata does not establish the claimed flow, state, capture identity, or revision
- **THEN** the harness records the inconsistency
- **AND** the screenshot cannot support the affected criterion

#### Scenario: Screenshot has no metadata and no describing record
- **WHEN** no capture metadata file exists and no verified candidate record names a screenshot, its filename, or a per-flow or per-screenshot subdirectory holding it in path form
- **THEN** the harness records the screenshot as defective
- **AND** the screenshot cannot support any criterion

#### Scenario: Candidate claim conflicts with independent evidence
- **WHEN** candidate evidence claims a behavior that verified evaluator evidence disproves
- **THEN** the harness preserves both sources and identifies the contradiction
- **AND** the judge scores the applicable criterion from the contradiction rather than silently reconciling it

#### Scenario: Candidate reports CI status
- **WHEN** candidate acceptance evidence reports passing, failing, pending, absent, or unavailable CI
- **THEN** the harness preserves the reported state and its claimed revision as candidate-produced evidence
- **AND** it does not independently query CI or block judging because of that state

### Requirement: Four-point testing-evidence score
The evaluation SHALL score candidate testing-evidence quality out of four points using four one-point binary criteria. A focused testing-evidence judge SHALL return a pass/fail verdict, rationale, and cited verified evidence for every criterion.

| Criterion | Points | Required behavior |
|---|---:|---|
| Traceable coverage | 1 | Verified evidence shows the user-visible behaviors the approved specs add were exercised, by any testing approach; a disclosed environmental impediment does not count, other disclosed omissions count proportionally, and undisclosed omissions fully. This is the only criterion that scores an omitted behavior. |
| Usable proof | 1 | Each claim that a basis scenario was exercised is backed by verified artifacts, such as logs, captures, transcripts, or recorded observations, in the bounded view; a claim that maps to no basis scenario does not fail this criterion, and a stated limitation is a disclosure and needs no proof. |
| Final-revision applicability | 1 | The recorded last-tested revision is the final SHA, or every product file the last diff-scoped pass's diff lists was explored, meaning the pass exercised the behavior or ran the command that executes it; a byte-identical mirror of an explored file and a command the acceptance workflow forbids running count as explored. |
| Complete and honest record | 1 | Gaps, limitations, self-played or simulated interactions, environment limits, CI status, warning dispositions, and unresolved findings are disclosed, and no completion, coverage, or outcome claim, whether or not it maps to a basis scenario, is shown by the available evidence to be false or overstated; a claim that merely lacks supporting evidence does not fail it. |

The rubric SHALL carry an explicit definition for each criterion, and the testing-evidence judge SHALL receive each definition beside its identifier together with the requirement and scenario headings of the approved specs as reference. Coverage SHALL NOT be measured against a fixed test-plan case inventory.

The evidence basis SHALL be the scenarios of the approved specs, as the harness enumerates them from those headings. It is the same for every candidate and does not depend on the candidate's exploration plan. A claim SHALL be material to usable proof when it asserts that a basis scenario was exercised or observed; whether a claim maps to a basis scenario SHALL be judged per claim. A claim about building or verifying the product counts when it maps to a basis scenario, such as one requiring the build to succeed or checks to run before completion.

- **Usable proof** SHALL fail only on a named material claim. Its fail SHALL identify the basis scenario, the claim, and the evidence that is missing or defective, including a claim with no artifact at all.
- **Complete and honest record** SHALL NOT compare the exploration plan with the log, and SHALL NOT fail for an omitted behavior, which traceable coverage alone scores. A demonstrably false or overstated claim SHALL fail it whether or not the claim is material to usable proof. Missing supporting evidence alone SHALL NOT fail it: usable proof alone scores a material claim without proof, and an unbacked claim that maps to no basis scenario fails neither criterion unless the evidence shows it false or overstated.

For usable proof and complete and honest record, a decider ruling SHALL return a bounded claim mapping with two parts:
- one row for each basis scenario the record claims was exercised, holding every claim the record makes about that scenario, across revisions, viewports, or runs, each with the location of the claim and the location of the evidence offered for it or that none was found;
- rows for claims and disclosures outside the basis that complete and honest record judges, such as CI status, stated limitations, and completion or outcome claims, each with its location and the location of its evidence.

The claim-bearing records SHALL be the record's acceptance flow record, exploration log, final handoff, and findings history. The testing-evidence judge packet SHALL hold them in full, never truncated, so every panel judge and the decider see the complete records and can cite any line of them, the completeness audit receives them in full, and the row audits and contradiction checks receive their cited lines from those same complete records. When those records would exceed the judge packet budget, or the budget would cut or drop a supporting artifact that the per-artifact cap alone would not, the packet SHALL grow to the judge packet's hard limit, and supporting artifacts SHALL fill the room left under the same truncation rules. When they would exceed the judge packet's hard limit, or evidence collection skipped one of them for its size, the testing-evidence job SHALL fail as an evaluation-harness failure naming its criteria. Other artifacts MAY be truncated under the packet budget, marked as the product-quality-scoring robust judge verdicts requirement defines. Both criteria SHALL weigh testing claims in every candidate record the packet holds, including the assumptions ledger, whoever wrote them; the claim-bearing records are the ones held in full. Attributing a result to the implementation run SHALL NOT prove it.

The mapping SHALL hold at most one row per basis scenario and at most 24 rows outside the basis. A row SHALL hold at most six claims, and each claim SHALL cite one claim span and at most four evidence spans, each span at most 40 lines. A record that claims every basis scenario SHALL therefore fit.

The decider's ruling SHALL be audited in two parts:
- **Row audits** SHALL receive the mapping's rows, in batches of whole rows, with the lines each row references, and SHALL judge each claim's evidence.
- **One completeness audit** SHALL receive the claim-bearing records in full and an index of the locations each mapped claim cites, without quoted text. It SHALL check that the mapping is complete against those records, SHALL classify the ruling `contradicted` when the mapping omits a claim that would change it, and SHALL cite the omitted claim's record and line.

The parts SHALL be recorded and settled as one multi-part audit, as the product-quality-scoring robust judge verdicts requirement defines.

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
- **AND** when the claim-bearing records together exceed the judge packet's hard limit, the testing-evidence job fails as an evaluation-harness failure rather than judging a truncated record

#### Scenario: One scenario is claimed several times
- **WHEN** the record claims a basis scenario was exercised at two viewports and at two revisions
- **THEN** that scenario's row holds all four claims, each with its own evidence location

#### Scenario: A CI claim lies outside the basis
- **WHEN** the record states CI passed at the final revision
- **THEN** the mapping lists that claim in its rows outside the basis, with its evidence location, for complete and honest record

