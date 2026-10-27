## MODIFIED Requirements

### Requirement: Discovery ledger
For each `mandatory` and `acceptable-alternative` inventory item, the suite SHALL record whether any agent turn in the simulated-user conversation asked about it, citing the exchange, and SHALL combine that with the item's coverage verdict into one outcome:

| Outcome | Asked | Coverage verdict |
|---|---|---|
| `discovered` | Yes | `met` or `partial` |
| `inferred` | No | `met` or `partial` |
| `missed` | No | `missing` |
| `asked-not-captured` | Yes | `missing` |
| `corrected` | Corrected | `met` or `partial` |
| `corrected-not-captured` | Corrected | `missing` |
| `leaked` | Any | `leaked` (disclosed without being asked) |

The asked part SHALL be `Corrected` for an item the disclosure audit settles `corrected`, whatever the discovery judge decided. The ledger SHALL cite the correcting exchange for such an item. `leaked` SHALL take precedence over every other outcome. The captured part SHALL come from the coverage verdicts, not from a second judgment.

#### Scenario: Requirement found by asking
- **WHEN** the agent asked about an item, the disclosure audit settled it neither leaked nor `corrected`, and its coverage verdict is `met`
- **THEN** the ledger records `discovered` and cites the exchange

#### Scenario: Requirement never raised
- **WHEN** no agent turn asked about an item, the disclosure audit settled it neither leaked nor `corrected`, and its coverage verdict is `missing`
- **THEN** the ledger records `missed`

#### Scenario: Requirement captured after a correction
- **WHEN** the disclosure audit settles an item `corrected` and its coverage verdict is `partial`
- **THEN** the ledger records `corrected` and cites the correcting exchange

#### Scenario: Correction not captured
- **WHEN** no agent turn asked about an item, the disclosure audit settles it `corrected`, and its coverage verdict is `missing`
- **THEN** the ledger records `corrected-not-captured`, not `missed`, and cites the correcting exchange
