## MODIFIED Requirements

### Requirement: Requirement trace
For each `mandatory` and `acceptable-alternative` hidden-reference inventory item, the suite SHALL record whether the agent asked about it, whether the collected definition covers it, and whether the delivered product delivers it, and SHALL combine them into exactly one outcome (`not-graded-in-product` and `delivery-unavailable` are defined under Trace inputs and Trace without a delivered product):

| Outcome | Asked | Definition coverage | Product delivery |
|---|---|---|---|
| `delivered` | Any | `met` or `partial` | delivered |
| `partially-delivered` | Any | `met` or `partial` | partly delivered |
| `not-discovered` | No | `missing` | Any |
| `discovered-not-defined` | Yes or Corrected | `missing` | Any |
| `defined-not-delivered` | Any | `met` or `partial` | not delivered |
| `not-graded-in-product` | Any | `met` or `partial` | not graded |
| `delivery-unavailable` | Any | `met` or `partial` | unavailable |

The asked part SHALL be Yes, Corrected, or No. The trace SHALL show it for each item, SHALL cite the exchange for an asked item and the correcting exchange for a corrected item, and SHALL show for each item its definition coverage verdict and product delivery status alongside its outcome.

#### Scenario: Requirement survives every stage
- **WHEN** the agent asked about an item, the definition covers it, and every product criterion mapped to it passes
- **THEN** the trace records `delivered` and cites the exchange

#### Scenario: Requirement never raised
- **WHEN** no agent turn asked about an item, the disclosure audit settled no correction of it, and the definition does not cover it
- **THEN** the trace records `not-discovered`

#### Scenario: Requirement heard but not written down
- **WHEN** the agent asked about an item and the definition does not cover it
- **THEN** the trace records `discovered-not-defined` and cites the exchange

#### Scenario: Corrected requirement not written down
- **WHEN** the discovery judge marks an item not asked, the disclosure audit settles it `corrected`, and the definition does not cover it
- **THEN** the trace records `discovered-not-defined`, not `not-discovered`, shows the asked part as Corrected, and cites the correcting exchange

#### Scenario: Requirement recovered by a correction
- **WHEN** the disclosure audit settles an item `corrected`, the definition covers it, and every product criterion mapped to it passes
- **THEN** the trace records `delivered`, shows the asked part as Corrected, and cites the correcting exchange

#### Scenario: Requirement partly built
- **WHEN** the definition covers an item and some, but not all, product criteria mapped to it pass
- **THEN** the trace records `partially-delivered`

#### Scenario: Requirement defined but not built
- **WHEN** the definition covers an item and every product criterion mapped to it fails
- **THEN** the trace records `defined-not-delivered`

### Requirement: Trace inputs
The asked part SHALL come from the define suite's discovery judge, except that an item the disclosure audit settles `corrected` SHALL have the asked part Corrected. The definition coverage SHALL come from the definition score's coverage verdicts, unchanged; a correction lowers an item's earned definition points, not its verdict. Product delivery SHALL be derived from the verdicts of the product criteria mapped to the item, without a further judgment: delivered when every mapped criterion passes, partly delivered when some pass, and not delivered when none pass. When a product criterion is mapped to more than one item, each of those items SHALL name that shared criterion beside its product delivery, so that one failed check is not read as several independent misses. An item that no product criterion maps to SHALL show its product delivery as not graded; when the definition covers such an item, its outcome SHALL be `not-graded-in-product` in place of `delivered`, `partially-delivered`, or `defined-not-delivered`.

#### Scenario: Item not graded in product
- **WHEN** the definition covers an item and no product criterion maps to it
- **THEN** the trace records `not-graded-in-product` and does not record `delivered`, `partially-delivered`, or `defined-not-delivered`

#### Scenario: Shared criterion fails
- **WHEN** one failing product criterion is the only criterion mapped to three items
- **THEN** each of those items shows product delivery as not delivered and names the shared criterion

#### Scenario: Corrected item takes its asked part from the audit
- **WHEN** the discovery judge marks an item asked and the disclosure audit settles it `corrected`
- **THEN** the trace shows the asked part as Corrected

