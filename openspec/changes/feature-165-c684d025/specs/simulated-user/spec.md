## MODIFIED Requirements

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
| Statement that explicitly excludes, or directly contradicts, the intent of something the reference requires | Corrects that statement, naming only the excluded or contradicted matter in the agent's terms, and lists no details that should replace it |
| Turn or draft that does not mention something the reference requires | Says nothing about the unmentioned matter |

The correction applies to a statement wherever it appears in an agent turn that is not an offered option or proposed default: a question, a status update, a list of risks or exclusions, or a draft put up for approval. It applies only to a requirement's intent, meaning what the reference requires and its purpose. The simulated user SHALL NOT correct a statement that chooses:

- a different mechanism that achieves the same intent;
- a different specific value, name, or layout;
- different sample or illustrative content.

When the agent asks about such a choice, or offers it as an option or proposed default, the rules above for questions and offered options apply unchanged. The policy SHALL draw this distinction from the reference's own wording, without the inventory classification.

Apart from such a correction, it SHALL NOT volunteer information that was not asked for. It SHALL NOT critique or review the artifacts, or mention a reference document, a hidden specification, or the evaluation.

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

#### Scenario: Explicit exclusion is corrected
- **WHEN** an agent turn says it will exclude themes, and the hidden reference requires each presentation to own its visual style
- **THEN** the reply says not to exclude that, naming the matter in the agent's terms
- **AND** the reply states no palette, mechanism, or other detail of the presentation's styling

#### Scenario: Direct contradiction is corrected
- **WHEN** an agent turn states that the reusable scene kit will ship default colors and fonts, and the hidden reference requires the kit to impose no styling
- **THEN** the reply corrects that statement without listing what the kit must leave out

#### Scenario: Omission is left silent
- **WHEN** an agent turn or draft does not mention a requirement in the hidden reference
- **THEN** the reply says nothing about that requirement

#### Scenario: Different value is not corrected
- **WHEN** an agent turn states, without asking about it or offering it as a default, a canvas size or route shape other than the one in the hidden reference
- **THEN** the reply does not correct it

#### Scenario: Alternative mechanism is not corrected
- **WHEN** an agent turn states a styling mechanism, different from the reference's, that still lets each presentation own its visual style
- **THEN** the reply does not correct it

### Requirement: Disclosure audit
After the define workflow, eval-owned judges SHALL audit every simulated-user reply against the agent turn it answered and the conversation before it, flagging over-disclosure, inconsistent withholding, and contradiction of an earlier answer. Each flag SHALL cite the exchange. Each over-disclosure flag SHALL name the `mandatory` and `acceptable-alternative` inventory items the reply disclosed without being asked. The audit SHALL use the same cross-family panel and settlement rule as scoring jobs, judging for each item whether it was leaked. An item named in an over-disclosure flag by the Claude-family judge and at least one Codex-family judge SHALL be leaked. An item named by both Codex-family judges but not the Claude-family judge SHALL be decided by the decider. A decider ruling that such an item was not leaked overrules both Codex-family judges and SHALL go to the targeted overrule check that the definition-artifact-scoring capability defines. The item SHALL be leaked unless that check confirms the ruling, and a check that cannot decide SHALL leave it leaked. A leak vote the ruling rejects SHALL also take the targeted dissent check that capability defines for rejected votes, and the item SHALL be leaked when that check confirms the vote. Only a simulated-user reply SHALL count as disclosing an item: text the agent wrote, in its turns or artifacts, SHALL NOT, and a reply that accepts or chooses what the agent proposed SHALL disclose nothing beyond it. A reply correcting a default or option the agent offered SHALL count as answering a question about that matter, so stating an item's position on that matter SHALL NOT be a leak; only items outside the matters the agent raised can leak. A reply correcting an exclusion or contradiction the agent's turn stated SHALL likewise count as answering about the excluded or contradicted matter; the Correction audit requirement classifies the items it states on that matter as `corrected`, not leaked. A reply that corrects or adds to something the agent's turn did not mention SHALL be judged as over-disclosure under this requirement. An item named by one judge alone SHALL be a dissent, checked by the decider when that judge's flag cites a valid exchange. A leaked item SHALL be excluded from that run's coverage score and SHALL be reported as `leaked` in place of its coverage verdict. Inconsistent-withholding and contradiction flags SHALL be report-only. Every flag and every leaked item SHALL be shown in the result and report, and a run with flags SHALL still be scored and published. In an end-to-end run, the audit SHALL run at the define checkpoint, before implementation starts, and any leaked item SHALL end the run `evaluation-harness-failed` instead of being excluded from coverage: the run SHALL receive no definition or product score, SHALL NOT be published, and SHALL NOT be resumable. Only an item settled as leaked by the rules above SHALL end the run; an item named by one judge alone, or a dissent the decider rejects, SHALL NOT. The define suite's handling of leaked items is unchanged.

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

#### Scenario: Correcting a stated exclusion is not a leak
- **WHEN** the agent's turn excludes a matter and the simulated user's reply corrects it by stating an item's position on that matter
- **THEN** that item is not leaked
- **AND** an item the reply states outside that matter can still be leaked

#### Scenario: Correcting an omission is over-disclosure
- **WHEN** the agent's turn does not mention a matter and the simulated user's reply corrects the agent about it
- **THEN** the audit flags over-disclosure for that exchange and names the inventory items the reply disclosed

### Requirement: Decision policy
The simulated user SHALL follow a pinned, versioned decision policy. It SHALL approve every request to approve an artifact, a draft, or a list of drafted requirements, or to proceed, as written, and each approval SHALL be recorded as simulated. In such a turn it SHALL answer only the questions, decisions, offered options, and labelled defaults the turn puts to it, and SHALL NOT add, remove, or rewrite drafted items, even where they differ from the hidden reference, except to correct, under the disclosure policy, a drafted item that explicitly excludes or directly contradicts a requirement's intent. A reply that makes such a correction SHALL still approve the rest of the request, and SHALL be recorded as a simulated approval. For a decision about a crosscheck finding, it SHALL decide according to the hidden reference where the reference applies and otherwise accept the agent's recommendation. When it rejects or narrows a finding or proposal, it SHALL say only which part to drop or keep, and SHALL NOT state a command, path, number, tool, pass/fail rule, or other requirement the agent did not propose or ask about. For a request to run, test, inspect, or otherwise act on something, it SHALL decline and tell the agent to proceed as it thinks best.

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
- **WHEN** the agent asks the simulated user to approve a list of drafted requirements, some of which differ from the hidden reference in mechanism, value, or detail, or leave a requirement out, but none of which excludes or contradicts a requirement's intent
- **THEN** the simulated user approves the list as written and adds no requirement the list does not contain

#### Scenario: Approval request drafts an exclusion
- **WHEN** the agent asks the simulated user to approve a draft that explicitly excludes a matter the hidden reference requires
- **THEN** the reply corrects that drafted exclusion under the disclosure policy and approves the rest
- **AND** the exchange is recorded as a simulated approval

### Requirement: Simulated-user policy tests
The suite SHALL provide a maintainer diagnostic that sends a fixed set of scripted agent turns to the pinned simulated user, covering at least a specific question, a broad question, a compound question, an ambiguous question, a repeated question, a question the reference does not settle, an approval request, an approval request listing drafted requirements that differ from the reference, a crosscheck-finding decision, a crosscheck finding the reference narrows, and a request to act. It SHALL also cover the following cases:

- **Must be corrected:**
  - a turn that explicitly excludes a matter the reference requires;
  - a turn that directly contradicts a requirement's intent;
  - an approval request whose draft contains such an exclusion or contradiction, which must receive both the correction and the approval.
- **Must be left uncorrected:**
  - a draft that omits a requirement;
  - an unsolicited statement of a different canvas size;
  - an unsolicited statement of a different route shape;
  - a statement of an alternative styling mechanism that keeps each presentation's visual style its own.
- **Over-disclosure:** a turn whose correction risks naming replacement details.
- **Offered counterparts:** the same canvas size and route shape offered as proposed defaults, whose replies keep the offered-default rule's rejection.

The diagnostic SHALL run each case several times on identical agent turns and conversation prefixes. It SHALL report for each case whether every reply met the policy and whether the replies were consistent with each other, and SHALL retain the replies for inspection of semantic compliance. The diagnostic SHALL NOT be a prerequisite or runtime gate for a candidate run.

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

#### Scenario: Required correction is missing
- **WHEN** the scripted explicit-exclusion case receives a reply that does not correct the exclusion
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Correction of a different value
- **WHEN** the scripted different-canvas-size case receives a reply that corrects the canvas size
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Correction that names replacement details
- **WHEN** the scripted correction case receives a reply that corrects the exclusion and also lists the details that should replace it
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Offered default rejection is stripped
- **WHEN** the scripted offered-canvas case receives a reply that approves the offered canvas or says nothing about it
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Inconsistent trials
- **WHEN** one trial of a case corrects a statement and another trial of the same case does not
- **THEN** the diagnostic reports that case as inconsistent

### Requirement: Reply check
Before a reply is sent, the simulated user SHALL check its draft against its pinned policy in the same session and send the checked reply instead of the draft. The check SHALL remove every statement that answers nothing the agent asked or put to it, every detail the agent did not raise, and, in reply to an approval request, every change to drafted items other than a required correction. It SHALL keep a correction that the disclosure policy requires, of an exclusion or contradiction the agent's turn stated, but SHALL remove from it every replacement detail. It SHALL also remove:

- every correction of something the agent's turn did not mention;
- every unsolicited correction of a choice that neither excludes nor contradicts a requirement's intent. A choice is unsolicited when the agent's turn neither asked about it nor offered it as an option or proposed default.

The check SHALL keep an answer to a question the agent asked, and the choice or rejection of an option or proposed default the agent offered, as the disclosure policy's rules for those turns allow. It SHALL add nothing. The draft and the removed statements SHALL be retained only in private runtime state, since they can quote the hidden reference. The usage of both calls SHALL be recorded as eval-owned usage.

#### Scenario: Check removes a volunteered requirement
- **WHEN** the simulated user's draft adds a requirement the agent's turn did not raise
- **THEN** the reply sent to the agent omits that requirement

#### Scenario: Check keeps a required correction
- **WHEN** the simulated user's draft reply to an approval request corrects a drafted item that explicitly excludes a requirement's intent
- **THEN** the reply sent to the agent keeps that correction and the approval

#### Scenario: Check removes a correction of an omission
- **WHEN** the simulated user's draft corrects the agent about a matter its turn did not mention
- **THEN** the reply sent to the agent omits that correction

#### Scenario: Check removes replacement details
- **WHEN** the simulated user's draft corrects a stated exclusion and lists the details that should replace it
- **THEN** the reply sent to the agent keeps the correction and omits those details

#### Scenario: Check keeps a rejection of an offered default
- **WHEN** the agent offers a 1280 × 720 canvas as a proposed default and the simulated user's draft says what is wrong with it
- **THEN** the reply sent to the agent keeps that rejection

#### Scenario: Removed statements stay private
- **WHEN** the reply check removes a statement from a draft
- **THEN** the removed statement appears in private runtime state and in no published evidence

## ADDED Requirements

### Requirement: Correction audit
The disclosure audit SHALL also judge, for each `mandatory` and `acceptable-alternative` inventory item, whether it was `corrected`.

An item SHALL be `corrected` when both of the following hold:

- a simulated-user reply corrected an exclusion or contradiction that the agent's turn stated, and stated the item's position on the excluded or contradicted matter;
- the item's position had not been established earlier in the conversation.

A position is established by an earlier simulated-user reply that states it substantively, or that confirms an agent statement matching it. An earlier question that received only a clarifying question, a no-preference reply, or a decline does not establish it.

Each `corrected` judgment SHALL cite the correcting exchange. The audit SHALL settle `corrected` with the same panel, decider, overrule-check, and dissent-check rules it uses for `leaked`, with `corrected` in place of `leaked`.

An item settled as leaked SHALL NOT also be `corrected`.

The audit SHALL also raise a report-only `over-correction` flag, citing the exchange, for a reply that:

- makes an unsolicited correction of a choice that neither excludes nor contradicts a requirement's intent; or
- names details that should replace an excluded or contradicted matter.

A reply's answer to a question the agent asked, or its choice or rejection of an option or proposed default the agent offered, SHALL NOT be an over-correction.

Every `corrected` item and every `over-correction` flag SHALL be shown in the result and report. Neither SHALL end an end-to-end run at the define checkpoint, and neither SHALL prevent scoring or publication. Applying the scoring consequence of a `corrected` item is the definition-artifact-scoring capability's responsibility.

#### Scenario: Exclusion corrected before the item was asked about
- **WHEN** the agent's proposal turn excludes themes, no earlier turn asked about presentation styling, and the reply corrects the exclusion
- **THEN** the inventory items for presentation-owned visual style that the correction states are settled `corrected`, citing that exchange

#### Scenario: Item established before the correction
- **WHEN** the agent asked about an item and received a substantive answer, and a later turn contradicts it and is corrected
- **THEN** the item is not `corrected`

#### Scenario: Confirmed agent statement establishes the item
- **WHEN** the agent stated an item's position correctly, the simulated user confirmed it, and a later turn contradicts it and is corrected
- **THEN** the item is not `corrected`

#### Scenario: Unanswered question does not establish the item
- **WHEN** the agent asked about an item, the simulated user replied only with a clarifying question, and a later turn excludes the item and is corrected
- **THEN** the item is settled `corrected`

#### Scenario: Panel disagrees about a correction
- **WHEN** both Codex-family judges mark an item `corrected` and the Claude-family judge does not
- **THEN** the decider rules whether the item is `corrected` and the result records the disagreement and ruling

#### Scenario: Leak takes precedence
- **WHEN** an item is settled as leaked by one reply and as `corrected` by another
- **THEN** the item is reported as `leaked` and not as `corrected`

#### Scenario: Over-correction is report-only
- **WHEN** a reply corrects a canvas size the agent stated
- **THEN** the audit raises an `over-correction` flag citing that exchange
- **AND** the run is still scored and the flag appears in the result and report

#### Scenario: Rejecting an offered default is not an over-correction
- **WHEN** the agent offers a 1280 × 720 canvas as a proposed default and the reply says what is wrong with it
- **THEN** the audit raises no `over-correction` flag for that exchange

#### Scenario: Corrected item does not stop an end-to-end run
- **WHEN** the disclosure audit at an end-to-end run's define checkpoint settles an item `corrected` and settles no item leaked
- **THEN** implementation starts as usual

### Requirement: Correction audit stability diagnostic
The suite SHALL provide a maintainer diagnostic that runs the real disclosure-audit panel repeatedly on one fixed correction-bearing input, and reports how stable its judgments are.

The input SHALL be a private, synthetic conversation labelled as synthetic. It SHALL be assembled from retained policy-diagnostic exchanges and contain at least:

- a corrected exclusion;
- an exclusion corrected after an unanswered question;
- a correction of an item established earlier;
- an over-correction;
- a rejected offered default;
- a mixed reply that corrects an exclusion and also answers a preference question.

The diagnostic SHALL run the audit a fixed number of times on that unchanged input. For each item and exchange, it SHALL report how often the `corrected`, `leaked`, and `over-correction` settlements flipped across repetitions. It SHALL also report the spread of the coverage score that results from applying each repetition's corrected and leaked items to one fixed set of coverage verdicts.

Its evidence SHALL be written only to a maintainer-chosen directory outside the repository, because it can quote the hidden reference. It SHALL NOT start a candidate run, publish, or act as a prerequisite or runtime gate for a candidate run.

#### Scenario: Flip is reported
- **WHEN** one repetition settles an item `corrected` and another does not
- **THEN** the diagnostic reports a flip for that item and the coverage-score spread it causes

#### Scenario: Diagnostic is not a gate
- **WHEN** a candidate run starts without a recent stability result
- **THEN** the run proceeds normally
