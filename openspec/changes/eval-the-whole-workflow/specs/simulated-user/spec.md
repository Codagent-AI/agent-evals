## ADDED Requirements

### Requirement: Knowledge boundary
The simulated user SHALL be the only evaluation participant given the hidden reference during the define workflow. Its knowledge SHALL consist of the pinned fixture change's proposal, specifications, design, and test plan, the pinned starting prompt, its disclosure and decision policies, and the run's conversation so far. It SHALL NOT receive the fixture's task files, the rubric, or the hidden-reference inventory classification. It SHALL have no file, shell, network, or other tool access and SHALL answer only from that knowledge.

#### Scenario: Simulated user cannot use tools
- **WHEN** the simulated user produces a reply
- **THEN** no tool invocation is available to or recorded for it

#### Scenario: Inventory classification is withheld
- **WHEN** the simulated user is invoked
- **THEN** its input contains no rubric criterion or inventory classification

### Requirement: Whole-run conversation memory
The simulated user SHALL receive the full conversation of the run across every define step when producing each reply, so its answers remain consistent between steps.

#### Scenario: Earlier answer is reused in a later step
- **WHEN** the agent in the design step asks a question the simulated user answered during the proposal step
- **THEN** the simulated user gives an answer consistent with its earlier answer

### Requirement: Opening reply
The simulated user's first reply in a run SHALL be the pinned starting prompt, verbatim.

#### Scenario: Agent asks what the change is about
- **WHEN** the proposal step's first agent turn asks what to build
- **THEN** the simulated user replies with the pinned starting prompt exactly

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
| Offered options | Chooses the option matching the reference, or states the reference's intent when no option matches |

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

### Requirement: Decision policy
The simulated user SHALL follow a pinned, versioned decision policy. It SHALL approve every request to approve an artifact or proceed, and each approval SHALL be recorded as simulated. For a decision about a crosscheck finding, it SHALL decide according to the hidden reference where the reference applies and otherwise accept the agent's recommendation. For a request to run, test, inspect, or otherwise act on something, it SHALL decline and tell the agent to proceed as it thinks best.

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

### Requirement: Conversation evidence
Every exchange SHALL be recorded in the run's simulated-user conversation with its define step, attempt, and turn identity, the agent's message, the reply, and the reply type (`answer`, `approval`, `decision`, `decline`, or `clarification`). The conversation SHALL be retained with the run and SHALL be the input to the disclosure audit and the discovery diagnostic.

#### Scenario: Exchange is recorded
- **WHEN** the simulated user replies to an agent turn
- **THEN** the conversation records the step, attempt, turn, agent message, reply, and reply type

### Requirement: Disclosure audit
After the define workflow, eval-owned judges SHALL audit every simulated-user reply against the agent turn it answered and the conversation before it, flagging over-disclosure, inconsistent withholding, and contradiction of an earlier answer. Each flag SHALL cite the exchange. Each over-disclosure flag SHALL name the `mandatory` and `acceptable-alternative` inventory items the reply disclosed without being asked. The audit SHALL use the same cross-family panel and settlement rule as scoring jobs, judging for each item whether it was leaked. An item named in an over-disclosure flag by the Claude-family judge and at least one Codex-family judge SHALL be leaked. An item named by both Codex-family judges but not the Claude-family judge SHALL be decided by the decider. An item named by one judge alone SHALL be a dissent, checked by the decider when that judge's flag cites a valid exchange. A leaked item SHALL be excluded from that run's coverage score and SHALL be reported as `leaked` in place of its coverage verdict. Inconsistent-withholding and contradiction flags SHALL be report-only. Every flag and every leaked item SHALL be shown in the result and report, and a run with flags SHALL still be scored and published.

#### Scenario: Over-disclosure is flagged
- **WHEN** a reply states a requirement the agent's turn did not ask about
- **THEN** the audit flags over-disclosure, cites that exchange, and names the disclosed inventory item
- **AND** the run is still scored and the flag appears in the result and report

#### Scenario: Leaked item does not earn coverage
- **WHEN** the audit marks a `mandatory` item leaked and the definition captures that item
- **THEN** the item contributes neither earned nor possible coverage points and is reported as `leaked`

#### Scenario: Panel disagrees about a leak
- **WHEN** both Codex-family judges name an item in an over-disclosure flag and the Claude-family judge does not
- **THEN** the decider rules whether the item is leaked and the result records the disagreement and ruling

#### Scenario: Withholding flag does not change the score
- **WHEN** the audit flags only inconsistent withholding
- **THEN** the score is unchanged and the flag appears in the result and report

#### Scenario: Clean conversation
- **WHEN** no reply exceeds, withholds, or contradicts relative to the policy
- **THEN** the result reports the disclosure audit as clean

### Requirement: Simulated-user policy tests
The suite SHALL provide a maintainer diagnostic that sends a fixed set of scripted agent turns to the pinned simulated user, covering at least a specific question, a broad question, a compound question, an ambiguous question, a repeated question, a question the reference does not settle, an approval request, a crosscheck-finding decision, and a request to act, and SHALL report for each whether the reply met the policy. The diagnostic SHALL NOT be a prerequisite or runtime gate for a candidate run.

#### Scenario: Policy test reports a violation
- **WHEN** the scripted broad question receives a reply that enumerates requirements beyond the starting prompt
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Candidate run does not require policy tests
- **WHEN** a candidate run starts without a recent policy-test result
- **THEN** the run proceeds normally
