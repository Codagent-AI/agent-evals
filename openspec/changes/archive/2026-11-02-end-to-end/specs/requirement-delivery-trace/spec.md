## ADDED Requirements

### Requirement: Requirement trace
For each `mandatory` and `acceptable-alternative` hidden-reference inventory item, the suite SHALL record whether the agent asked about it, whether the collected definition covers it, and whether the delivered product delivers it, and SHALL combine them into exactly one outcome (`not-graded-in-product` and `delivery-unavailable` are defined under Trace inputs and Trace without a delivered product):

| Outcome | Asked | Definition coverage | Product delivery |
|---|---|---|---|
| `delivered` | Any | `met` or `partial` | delivered |
| `partially-delivered` | Any | `met` or `partial` | partly delivered |
| `not-discovered` | No | `missing` | Any |
| `discovered-not-defined` | Yes | `missing` | Any |
| `defined-not-delivered` | Any | `met` or `partial` | not delivered |
| `not-graded-in-product` | Any | `met` or `partial` | not graded |
| `delivery-unavailable` | Any | `met` or `partial` | unavailable |

The trace SHALL cite the exchange for an asked item, and SHALL show for each item its definition coverage verdict and product delivery status alongside its outcome.

#### Scenario: Requirement survives every stage
- **WHEN** the agent asked about an item, the definition covers it, and every product criterion mapped to it passes
- **THEN** the trace records `delivered` and cites the exchange

#### Scenario: Requirement never raised
- **WHEN** no agent turn asked about an item and the definition does not cover it
- **THEN** the trace records `not-discovered`

#### Scenario: Requirement heard but not written down
- **WHEN** the agent asked about an item and the definition does not cover it
- **THEN** the trace records `discovered-not-defined` and cites the exchange

#### Scenario: Requirement partly built
- **WHEN** the definition covers an item and some, but not all, product criteria mapped to it pass
- **THEN** the trace records `partially-delivered`

#### Scenario: Requirement defined but not built
- **WHEN** the definition covers an item and every product criterion mapped to it fails
- **THEN** the trace records `defined-not-delivered`

### Requirement: Trace inputs
The asked part SHALL come from the define suite's discovery judge, and the definition coverage SHALL come from the definition score's coverage verdicts, both unchanged. Product delivery SHALL be derived from the verdicts of the product criteria mapped to the item, without a further judgment: delivered when every mapped criterion passes, partly delivered when some pass, and not delivered when none pass. When a product criterion is mapped to more than one item, each of those items SHALL name that shared criterion beside its product delivery, so that one failed check is not read as several independent misses. An item that no product criterion maps to SHALL show its product delivery as not graded; when the definition covers such an item, its outcome SHALL be `not-graded-in-product` in place of `delivered`, `partially-delivered`, or `defined-not-delivered`.

#### Scenario: Item not graded in product
- **WHEN** the definition covers an item and no product criterion maps to it
- **THEN** the trace records `not-graded-in-product` and does not record `delivered`, `partially-delivered`, or `defined-not-delivered`

#### Scenario: Shared criterion fails
- **WHEN** one failing product criterion is the only criterion mapped to three items
- **THEN** each of those items shows product delivery as not delivered and names the shared criterion

### Requirement: Trace without a delivered product
When `define` completed and the run has no product score, the trace SHALL still report the asked part and definition coverage for every item, SHALL report product delivery as unavailable, SHALL record `delivery-unavailable` for every item the definition covers, and SHALL NOT record `delivered`, `partially-delivered`, `defined-not-delivered`, or `not-graded-in-product`.

#### Scenario: Implementation failed
- **WHEN** a run ends `implementation-workflow-failed` after `define` completed
- **THEN** its result's trace reports asked and definition coverage for every item, product delivery as unavailable, and `delivery-unavailable` for every item the definition covers

### Requirement: Non-scoring diagnostic
The requirement trace SHALL NOT change any score or gate. The result SHALL NOT combine the definition score and the product score into one total. The result and report SHALL show the count of each outcome and each item's outcome, the trace SHALL be included in the published result, and `--rescore-from` SHALL rebuild it from the rescored verdicts.

#### Scenario: Trace does not affect scores
- **WHEN** two runs have identical definition and product verdicts but different asked parts
- **THEN** they receive identical definition and product scores

#### Scenario: No combined total
- **WHEN** a run completes with a definition score and a product score
- **THEN** the result and report show the two scores separately and no combined total
