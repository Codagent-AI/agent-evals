## ADDED Requirements

### Requirement: Discovery ledger
For each `mandatory` and `acceptable-alternative` inventory item, the suite SHALL record whether any agent turn in the simulated-user conversation asked about it, citing the exchange, and SHALL combine that with the item's coverage verdict into one outcome:

| Outcome | Asked | Coverage verdict |
|---|---|---|
| `discovered` | Yes | `met` or `partial` |
| `inferred` | No | `met` or `partial` |
| `missed` | No | `missing` |
| `asked-not-captured` | Yes | `missing` |
| `leaked` | Any | `leaked` (disclosed without being asked) |

The captured part SHALL come from the coverage verdicts, not from a second judgment.

#### Scenario: Requirement found by asking
- **WHEN** the agent asked about an item and its coverage verdict is `met`
- **THEN** the ledger records `discovered` and cites the exchange

#### Scenario: Requirement never raised
- **WHEN** no agent turn asked about an item and its coverage verdict is `missing`
- **THEN** the ledger records `missed`

### Requirement: Discovery judge
An eval-owned judge with a pinned profile SHALL decide the asked part from the simulated-user conversation and the inventory items. An `asked` decision without a cited exchange SHALL be retried and SHALL NOT be recorded from that output.

#### Scenario: Asked without a citation
- **WHEN** the discovery judge marks an item asked without citing an exchange
- **THEN** the job is retried and the uncited decision is not recorded

### Requirement: Non-scoring diagnostic
The discovery ledger SHALL NOT change any score, gate, or `definition_verdict`. The result and report SHALL show the count of each outcome and each item's outcome, the ledger SHALL be included in the published result, and `--rescore-from` SHALL rebuild it.

#### Scenario: Ledger does not affect the verdict
- **WHEN** two runs have identical coverage, fidelity, and quality verdicts but different discovery outcomes
- **THEN** they receive the same score and `definition_verdict`
