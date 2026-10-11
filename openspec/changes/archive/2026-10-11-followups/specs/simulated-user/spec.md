## MODIFIED Requirements

### Requirement: Disclosure audit
After the define workflow, eval-owned judges SHALL audit every simulated-user reply against the agent turn it answered and the conversation before it, flagging over-disclosure, inconsistent withholding, and contradiction of an earlier answer. Each flag SHALL cite the exchange. Each over-disclosure flag SHALL name the `mandatory` and `acceptable-alternative` inventory items the reply disclosed without being asked. The audit SHALL use the same cross-family panel and settlement rule as scoring jobs, judging for each item whether it was leaked. An item named in an over-disclosure flag by the Claude-family judge and at least one Codex-family judge SHALL be leaked. An item named by both Codex-family judges but not the Claude-family judge SHALL be decided by the decider. A decider ruling that such an item was not leaked overrules both Codex-family judges and SHALL go to the targeted overrule check that the definition-artifact-scoring capability defines. The item SHALL be leaked unless that check confirms the ruling, and a check that cannot decide SHALL leave it leaked. A leak vote the ruling rejects SHALL also take the targeted dissent check that capability defines for rejected votes, and the item SHALL be leaked when that check confirms the vote. An item named by one judge alone SHALL be a dissent, checked by the decider when that judge's flag cites a valid exchange. A leaked item SHALL be excluded from that run's coverage score and SHALL be reported as `leaked` in place of its coverage verdict. Inconsistent-withholding and contradiction flags SHALL be report-only. Every flag and every leaked item SHALL be shown in the result and report, and a run with flags SHALL still be scored and published.

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
