## MODIFIED Requirements

### Requirement: Whole-run conversation memory
The simulated user SHALL receive the full conversation of the run across every define step when producing each reply, so its answers remain consistent between steps. It SHALL keep one model session for the whole run and send each new agent turn into that session. Each call SHALL continue from the last successful call, so a failed call leaves no partial turn in the session. When the session cannot be continued, including after a harness restart that lost it, the simulated user SHALL start a new session from the full recorded conversation.

#### Scenario: Earlier answer is reused in a later step
- **WHEN** the agent in the design step asks a question the simulated user answered during the proposal step
- **THEN** the simulated user gives an answer consistent with its earlier answer

#### Scenario: Later turn continues the run session
- **WHEN** the agent sends a new turn after an earlier reply in the same run
- **THEN** the simulated user continues its run session and receives only the new agent turn

#### Scenario: Session cannot be continued
- **WHEN** continuing the run session fails
- **THEN** the simulated user starts a new session from the full recorded conversation and replies normally

### Requirement: Disclosure policy
The simulated user SHALL follow a pinned, versioned disclosure policy:

| Agent turn | Simulated-user reply |
|---|---|
| Specific question | Answers only that question from the hidden reference |
| Broad question (for example "what else should I know?" or "list all requirements") | Restates the goal only at the level of the starting prompt |
| Compound question | Answers each part under these rules |
| Ambiguous question | Asks a brief clarifying question |
| Repeated question | Gives an answer consistent with the earlier one |
| Question the reference does not settle | States no preference and leaves the choice to the agent |
| Offered options or proposed defaults | Chooses or approves the one matching the reference; for a wrong one, says what is wrong with it without listing its replacement's details; states the reference's intent in one sentence, without specifics, when no option matches |

It SHALL NOT volunteer information that was not asked for, critique or review the artifacts, or mention a reference document, a hidden specification, or the evaluation.

#### Scenario: Specific question is answered narrowly
- **WHEN** the agent asks a specific question the hidden reference answers
- **THEN** the reply answers that question and adds no other requirement

#### Scenario: Broad question does not reveal the reference
- **WHEN** the agent asks the simulated user to list all its requirements
- **THEN** the reply restates the goal at the level of the starting prompt and enumerates no requirement beyond it

#### Scenario: Reference is silent
- **WHEN** the agent asks about a choice the hidden reference does not settle
- **THEN** the simulated user states that it has no preference and leaves the choice to the agent

#### Scenario: No offered option matches
- **WHEN** the agent offers options none of which matches the hidden reference
- **THEN** the simulated user states the reference's intent for that decision

#### Scenario: Ambiguous question
- **WHEN** the agent asks a question with more than one plausible reading
- **THEN** the simulated user asks a brief clarifying question instead of choosing a reading

#### Scenario: Wrong proposed default
- **WHEN** the agent proposes a default that does not match the hidden reference
- **THEN** the simulated user says what is wrong with that default and does not list the details that should replace it

### Requirement: Disclosure audit
After the define workflow, eval-owned judges SHALL audit every simulated-user reply against the agent turn it answered and the conversation before it, flagging over-disclosure, inconsistent withholding, and contradiction of an earlier answer. Each flag SHALL cite the exchange. Each over-disclosure flag SHALL name the `mandatory` and `acceptable-alternative` inventory items the reply disclosed without being asked. The audit SHALL use the same cross-family panel and settlement rule as scoring jobs, judging for each item whether it was leaked. An item named in an over-disclosure flag by the Claude-family judge and at least one Codex-family judge SHALL be leaked. An item named by both Codex-family judges but not the Claude-family judge SHALL be decided by the decider. A decider ruling that such an item was not leaked overrules both Codex-family judges and SHALL go to the targeted overrule check that the definition-artifact-scoring capability defines. The item SHALL be leaked unless that check confirms the ruling, and a check that cannot decide SHALL leave it leaked. A leak vote the ruling rejects SHALL also take the targeted dissent check that capability defines for rejected votes, and the item SHALL be leaked when that check confirms the vote. Only a simulated-user reply SHALL count as disclosing an item: text the agent wrote, in its turns or artifacts, SHALL NOT, and a reply that accepts or chooses what the agent proposed SHALL disclose nothing beyond it. A reply correcting a default or option the agent offered SHALL count as answering a question about that matter, so stating an item's position on that matter SHALL NOT be a leak; only items outside the matters the agent raised can leak. An item named by one judge alone SHALL be a dissent, checked by the decider when that judge's flag cites a valid exchange. A leaked item SHALL be excluded from that run's coverage score and SHALL be reported as `leaked` in place of its coverage verdict. Inconsistent-withholding and contradiction flags SHALL be report-only. Every flag and every leaked item SHALL be shown in the result and report, and a run with flags SHALL still be scored and published. In an end-to-end run, the audit SHALL run at the define checkpoint, before implementation starts, and any leaked item SHALL end the run `evaluation-harness-failed` instead of being excluded from coverage: the run SHALL receive no definition or product score, SHALL NOT be published, and SHALL NOT be resumable. Only an item settled as leaked by the rules above SHALL end the run; an item named by one judge alone, or a dissent the decider rejects, SHALL NOT. The define suite's handling of leaked items is unchanged.

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

#### Scenario: Correcting an offered default is not a leak
- **WHEN** the agent proposes a default and the simulated user's reply corrects it by stating the item's position on that matter
- **THEN** that item is not leaked, while an item the reply adds outside that matter can be

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
The simulated user SHALL follow a pinned, versioned decision policy. It SHALL approve every request to approve an artifact, a draft, or a list of drafted requirements, or to proceed, as written, and each approval SHALL be recorded as simulated. In such a turn it SHALL answer only the questions, decisions, offered options, and labelled defaults the turn puts to it, and SHALL NOT add, remove, or rewrite drafted items, even where they differ from the hidden reference. For a decision about a crosscheck finding, it SHALL decide according to the hidden reference where the reference applies and otherwise accept the agent's recommendation. When it rejects or narrows a finding or proposal, it SHALL say only which part to drop or keep, and SHALL NOT state a command, path, number, tool, pass/fail rule, or other requirement the agent did not propose or ask about. For a request to run, test, inspect, or otherwise act on something, it SHALL decline and tell the agent to proceed as it thinks best.

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

#### Scenario: Approval request lists drafted requirements
- **WHEN** the agent asks the simulated user to approve a list of drafted requirements, some of which differ from the hidden reference
- **THEN** the simulated user approves the list as written and adds no requirement the list does not contain

### Requirement: Simulated-user policy tests
The suite SHALL provide a maintainer diagnostic that sends a fixed set of scripted agent turns to the pinned simulated user, covering at least a specific question, a broad question, a compound question, an ambiguous question, a repeated question, a question the reference does not settle, an approval request, an approval request listing drafted requirements that differ from the reference, a crosscheck-finding decision, a crosscheck finding the reference narrows, and a request to act, and SHALL report for each whether the reply met the policy. The diagnostic SHALL NOT be a prerequisite or runtime gate for a candidate run.

#### Scenario: Policy test reports a violation
- **WHEN** the scripted broad question receives a reply that enumerates requirements beyond the starting prompt
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Candidate run does not require policy tests
- **WHEN** a candidate run starts without a recent policy-test result
- **THEN** the run proceeds normally

#### Scenario: Narrowing reply that volunteers specifics
- **WHEN** the scripted narrowing finding receives a reply that states a command, number, or tool the finding did not raise
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Approval reply that adds a requirement
- **WHEN** the scripted approval request listing drafted requirements receives a reply that adds a requirement the list does not contain
- **THEN** the diagnostic reports that case as a policy violation

## ADDED Requirements

### Requirement: Reply check
Before a reply is sent, the simulated user SHALL check its draft against its pinned policy in the same session and send the checked reply instead of the draft. The check SHALL remove every statement that answers nothing the agent asked or put to it, every detail the agent did not raise, and, in reply to an approval request, every change to drafted items; it SHALL add nothing. The draft and the removed statements SHALL be retained only in private runtime state, since they can quote the hidden reference. The usage of both calls SHALL be recorded as eval-owned usage.

#### Scenario: Check removes a volunteered requirement
- **WHEN** the simulated user's draft adds a requirement the agent's turn did not raise
- **THEN** the reply sent to the agent omits that requirement

#### Scenario: Removed statements stay private
- **WHEN** the reply check removes a statement from a draft
- **THEN** the removed statement appears in private runtime state and in no published evidence
