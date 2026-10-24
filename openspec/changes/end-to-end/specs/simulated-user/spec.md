## MODIFIED Requirements

### Requirement: Disclosure audit
After the define workflow, eval-owned judges SHALL audit every simulated-user reply against the agent turn it answered and the conversation before it, flagging over-disclosure, inconsistent withholding, and contradiction of an earlier answer. Each flag SHALL cite the exchange. Each over-disclosure flag SHALL name the `mandatory` and `acceptable-alternative` inventory items the reply disclosed without being asked. The audit SHALL use the same cross-family panel and settlement rule as scoring jobs, judging for each item whether it was leaked. An item named in an over-disclosure flag by the Claude-family judge and at least one Codex-family judge SHALL be leaked. An item named by both Codex-family judges but not the Claude-family judge SHALL be decided by the decider. A decider ruling that such an item was not leaked overrules both Codex-family judges and SHALL go to the targeted overrule check that the definition-artifact-scoring capability defines. The item SHALL be leaked unless that check confirms the ruling, and a check that cannot decide SHALL leave it leaked. A leak vote the ruling rejects SHALL also take the targeted dissent check that capability defines for rejected votes, and the item SHALL be leaked when that check confirms the vote. Only a simulated-user reply SHALL count as disclosing an item: text the agent wrote, in its turns or artifacts, SHALL NOT, and a reply that accepts or chooses what the agent proposed SHALL disclose nothing beyond it. An item named by one judge alone SHALL be a dissent, checked by the decider when that judge's flag cites a valid exchange. A leaked item SHALL be excluded from that run's coverage score and SHALL be reported as `leaked` in place of its coverage verdict. Inconsistent-withholding and contradiction flags SHALL be report-only. Every flag and every leaked item SHALL be shown in the result and report, and a run with flags SHALL still be scored and published. In an end-to-end run, the audit SHALL run at the define checkpoint, before implementation starts, and any leaked item SHALL end the run `evaluation-harness-failed` instead of being excluded from coverage: the run SHALL receive no definition or product score, SHALL NOT be published, and SHALL NOT be resumable. Only an item settled as leaked by the rules above SHALL end the run; an item named by one judge alone, or a dissent the decider rejects, SHALL NOT. The define suite's handling of leaked items is unchanged.

#### Scenario: Over-disclosure is flagged
- **WHEN** a reply states a requirement the agent's turn did not ask about
- **THEN** the audit flags over-disclosure, cites that exchange, and names the disclosed inventory item
- **AND** the run is still scored and the flag appears in the result and report

#### Scenario: Leaked item does not earn coverage
- **WHEN** the audit marks a `mandatory` item leaked and the definition captures that item
- **THEN** the item contributes neither earned nor possible coverage points and is reported as `leaked`

#### Scenario: Agent's own text is not a leak
- **WHEN** the agent's turn states an inventory item and the simulated user's reply only accepts it
- **THEN** that item is not leaked

#### Scenario: Panel disagrees about a leak
- **WHEN** both Codex-family judges name an item in an over-disclosure flag and the Claude-family judge does not
- **THEN** the decider rules whether the item is leaked and the result records the disagreement and ruling

#### Scenario: Withholding flag does not change the score
- **WHEN** the audit flags only inconsistent withholding
- **THEN** the score is unchanged and the flag appears in the result and report

#### Scenario: Clean conversation
- **WHEN** no reply exceeds, withholds, or contradicts relative to the policy
- **THEN** the result reports the disclosure audit as clean

#### Scenario: The decider confirms a leak
- **WHEN** both Codex-family judges name an item in an over-disclosure flag, the Claude-family judge does not, and the decider rules it leaked
- **THEN** no overrule check runs
- **AND** the item is excluded from earned and possible coverage points and reported as `leaked`

#### Scenario: An overrule of a leak is upheld
- **WHEN** both Codex-family judges name an item as leaked, the decider rules it not leaked, the overrule check confirms the decider's reason, and no check of a rejected leak vote confirms that vote
- **THEN** the item is not leaked and is scored for coverage as usual

#### Scenario: An overrule of a leak is rejected
- **WHEN** both Codex-family judges name an item as leaked, the decider rules it not leaked, and the overrule check does not confirm the decider's reason
- **THEN** the item is leaked and excluded from that run's coverage denominator

#### Scenario: An overrule check of a leak cannot decide
- **WHEN** the overrule check of a not-leaked ruling returns `insufficient`
- **THEN** the item is leaked and excluded from that run's coverage denominator

#### Scenario: Leak fails an end-to-end run
- **WHEN** the disclosure audit at an end-to-end run's define checkpoint marks an item leaked
- **THEN** implementation does not start and the run ends `evaluation-harness-failed`, not resumable, with no score and no publication

### Requirement: Decision policy
The simulated user SHALL follow a pinned, versioned decision policy. It SHALL approve every request to approve an artifact or proceed, and each approval SHALL be recorded as simulated. For a decision about a crosscheck finding, it SHALL decide according to the hidden reference where the reference applies and otherwise accept the agent's recommendation. When it rejects or narrows a finding or proposal, it SHALL say only which part to drop or keep, and SHALL NOT state a command, path, number, tool, pass/fail rule, or other requirement the agent did not propose or ask about. For a request to run, test, inspect, or otherwise act on something, it SHALL decline and tell the agent to proceed as it thinks best.

#### Scenario: Approval is requested
- **WHEN** the agent asks the simulated user to approve a drafted artifact
- **THEN** the simulated user approves and the exchange is recorded as a simulated approval

#### Scenario: Crosscheck finding the reference settles
- **WHEN** the agent asks whether to apply a review finding that conflicts with the hidden reference
- **THEN** the simulated user declines that finding

#### Scenario: Crosscheck finding the reference does not settle
- **WHEN** the agent asks whether to apply a review finding the hidden reference does not address
- **THEN** the simulated user accepts the agent's recommendation

#### Scenario: Agent asks the user to act
- **WHEN** the agent asks the simulated user to run a command or inspect a file
- **THEN** the simulated user declines and tells the agent to proceed as it thinks best

#### Scenario: Narrowing a finding discloses nothing new
- **WHEN** the simulated user narrows a crosscheck finding that goes beyond the hidden reference
- **THEN** its reply names the part to drop and states no command, number, tool, or pass/fail rule the agent did not raise

### Requirement: Simulated-user policy tests
The suite SHALL provide a maintainer diagnostic that sends a fixed set of scripted agent turns to the pinned simulated user, covering at least a specific question, a broad question, a compound question, an ambiguous question, a repeated question, a question the reference does not settle, an approval request, a crosscheck-finding decision, a crosscheck finding the reference narrows, and a request to act, and SHALL report for each whether the reply met the policy. The diagnostic SHALL NOT be a prerequisite or runtime gate for a candidate run.

#### Scenario: Policy test reports a violation
- **WHEN** the scripted broad question receives a reply that enumerates requirements beyond the starting prompt
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Candidate run does not require policy tests
- **WHEN** a candidate run starts without a recent policy-test result
- **THEN** the run proceeds normally

#### Scenario: Narrowing reply that volunteers specifics
- **WHEN** the scripted narrowing finding receives a reply that states a command, number, or tool the finding did not raise
- **THEN** the diagnostic reports that case as a policy violation
