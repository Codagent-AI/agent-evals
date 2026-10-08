## MODIFIED Requirements

### Requirement: Robust judge verdicts
No single model call SHALL decide a scored criterion, and no criterion SHALL be decided by Codex-family judges alone. Every scored judge job SHALL be judged by a cross-family panel of three independent judges with identical inputs, run concurrently, each at an explicitly pinned model and reasoning effort: one Claude-family judge and two independent Codex-family samples.

Each source-job panel judge SHALL pass through its own closed-world source audit:
- `contradicted` SHALL mark that judge's vote disputed, and the vote SHALL turn only when an independent contradiction check confirms the audit's stated contradiction;
- `insufficient` SHALL trigger at most one focused re-cite, and a verdict still undecided after the re-cite SHALL stand as the judge's vote. A browser-fallback pass SHALL then fail, because it must be proven from source.

Votes SHALL settle as follows, with no vote disputed:
- a verdict all three judges give SHALL stand, pass or fail;
- a verdict two judges give SHALL stand when the two include the Claude-family judge, unless the dissent is a pass backed by citations that pass validation. Such a backed dissent SHALL go to a targeted check, by a pinned Claude-family decider, of the dissent's stated reason. The dissent's verdict SHALL stand when the check confirms that reason, and the majority's otherwise;
- a verdict the two Codex-family judges give against the Claude-family judge, and a criterion whose vote remains disputed, SHALL be settled by the decider.

The decider SHALL receive the job's unchanged context and all three votes with their rationales and citations, without being told which model gave which. It SHALL rule pass or fail.

A decider pass SHALL cite between one and twelve line spans, each under 200 lines. Their paths SHALL be in the verified neutral source inventory for a source job, or the materialized evidence view for an evidence job, and SHALL resolve inside that root without a symbolic link and lie inside the file. A closed-world span audit SHALL check the quoted lines against every clause of the criterion's requirement and review guidance:
- `insufficient` SHALL ask the decider to re-cite once, and an audit that still cannot decide SHALL leave the decider pass standing with that recorded;
- `contradicted` SHALL be checked by an independent contradiction check that judges that audit's stated contradiction against the quoted lines and the rubric. The decider pass SHALL be withdrawn only when the check confirms that same contradiction, and both SHALL be recorded.

An unconfirmed browser-fallback decider pass SHALL fail. Invalid decider output, including an invalid span, SHALL be retried and, once exhausted, SHALL leave the job unobserved as a harness failure, as SHALL an exhausted panel judge. Contradiction checks and targeted dissent checks SHALL run on the decider's pinned model.

Every panel judge, decider, and audit SHALL see, beside each criterion, the requirement it traces to: the full fixture scenario from the pinned snapshot for a fixture-owned criterion, or the eval-owned reason. A pass SHALL meet every clause of that requirement as clarified by its review guidance, and judges SHALL NOT add requirements the requirement and its guidance do not state. Source judges SHALL trace a constant, member, prop, or input through every use before calling it dead, and SHALL treat shown, visible, or on-screen content as rendered content, not an `aria-label`, attribute, or visually hidden text. Evidence judges SHALL compare every behavior the exploration plan commits to with what the log observed or disclosed, and the assumption judge SHALL receive the full approved requirements as reference for its omission check.

Each criterion result SHALL record:
- its judging basis: `consensus-pass`, `consensus-fail`, `majority-pass`, `majority-fail`, `checked-dissent-pass`, `decider-pass`, or `decider-fail`;
- every panel verdict, with the model family that gave it.

The eval-owned usage ledger SHALL record each call's stage, provider, and model. A Codex or Claude call rejected before any model output, for example a capacity rejection, SHALL be recorded as a call that consumed no tokens. A capacity rejection SHALL be waited out with backoff rather than spending a judge attempt.

A Claude judge call that hits an identified Claude subscription limit with an explicit reset within six hours SHALL wait for the reset and retry. Any other Claude limit SHALL leave the job unobserved as a resumable harness failure.

Every response schema the harness sends SHALL satisfy strict structured-output rules, and a schema rejection (`invalid_json_schema`) SHALL fail fast as a non-retryable harness error. A cached judge job SHALL be reused only under the same judging protocol, and only when its results reproduce from its recorded panel votes, checks, and decider rulings.

#### Scenario: Both samples agree
- **WHEN** all three panel judges pass, or all three fail, a criterion
- **THEN** that verdict stands without a decider call

#### Scenario: Samples disagree
- **WHEN** both Codex-family judges pass a criterion and the Claude-family judge fails it
- **THEN** the decider decides it
- **AND** its pass must cite mechanically valid line spans

#### Scenario: Cross-family majority stands
- **WHEN** the Claude-family judge and one Codex-family judge fail a criterion, and the other Codex-family judge also fails it or passes it without citations that pass validation
- **THEN** the criterion fails without a decider call

#### Scenario: Backed dissent is checked
- **WHEN** the Claude-family judge and one Codex-family judge fail a criterion, and the other Codex-family judge passes it with citations that pass validation
- **THEN** the decider checks that dissent's stated reason, and the criterion passes only when the check confirms it

#### Scenario: A sample's own audit contradicts its vote
- **WHEN** all three panel judges pass a criterion and one judge's source audit classifies its pass as contradicted
- **THEN** that vote is marked disputed and an independent check judges the stated contradiction
- **AND** a refuted contradiction leaves all three passes standing, while a confirmed one turns that vote and the remaining votes settle the criterion under the panel rule

#### Scenario: Two audits contradict for different reasons
- **WHEN** a span audit contradicts a decider pass and the contradiction check finds that stated reason does not hold under the rubric
- **THEN** the decider pass stands

#### Scenario: A judge invents a scenario the candidate does not produce
- **WHEN** a judge would fail a criterion on a hypothetical input, file deletion, or rendering that the cited source and evidence do not show
- **THEN** the shared scope rule in every judge, audit, and check prompt directs it not to, unless the criterion's guidance names that scenario

#### Scenario: A check refutes a span contradiction
- **WHEN** the span audit contradicts the decider's quoted lines and the independent check does not confirm that stated contradiction
- **THEN** the decider pass stands

#### Scenario: A check confirms a span contradiction
- **WHEN** the independent check confirms the span audit's stated contradiction of the quoted lines
- **THEN** the criterion fails

#### Scenario: The span audit cannot decide
- **WHEN** the span audit finds the quoted lines insufficient, the decider re-cites, and the audit still cannot decide
- **THEN** the decider pass stands and the evidence records that the audit could not confirm it

#### Scenario: A sample's audit cannot decide after a re-cite
- **WHEN** a panel judge's source audit is still insufficient after one focused re-cite
- **THEN** the judge's verdict stands as its vote and no further citation cycle runs

#### Scenario: Model capacity rejects a judge call
- **WHEN** Codex or Claude rejects a judge turn as at capacity before any model output
- **THEN** the invoker waits and retries without spending a judge attempt
- **AND** the usage ledger records the rejected call with zero tokens

#### Scenario: Claude subscription limit during judging
- **WHEN** a Claude judge call hits an identified subscription limit whose reset is within six hours
- **THEN** the harness waits for the reset and retries the call, and the job is not failed

#### Scenario: OpenAI rejects a response schema
- **WHEN** a judge call fails with `invalid_json_schema`
- **THEN** it is not retried and the owning phase fails as a harness error
