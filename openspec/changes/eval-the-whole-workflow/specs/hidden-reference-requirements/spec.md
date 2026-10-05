## ADDED Requirements

### Requirement: Pinned hidden-reference inventory
The suite SHALL own a pinned hidden-reference inventory consisting of the starting prompt, the itemized requirements, each independent label set, the labelling brief, and the reconciled inventory, all derived from the and-scene fixture change at one pinned fixture commit. The reconciled inventory SHALL record the fixture repository, commit, and change name, and the hash of every input it was built from. The inventory SHALL be stored in suite data that is never mounted into or readable from the evaluated agent's environment.

#### Scenario: Inventory identifies its inputs
- **WHEN** a maintainer inspects the reconciled inventory
- **THEN** it names the fixture repository, commit, and change, and records the hash of the starting prompt, items, brief, and each label set

#### Scenario: Recorded input no longer matches
- **WHEN** an input file's hash differs from the hash recorded in the reconciled inventory
- **THEN** the suite's inventory check fails and identifies the changed input

### Requirement: Traceable items
Each inventory item SHALL state one distinct requirement with a stable identifier, an area, a kind (`behavior`, `constraint`, `value`, `scope-inclusion`, `scope-exclusion`, or `decision`), a title, and a statement. Each item SHALL cite at least one verbatim quote from the fixture change, with the source document and heading. The suite's inventory check SHALL verify every quote against the suite's pinned snapshot of the fixture change.

#### Scenario: Quote does not match the snapshot
- **WHEN** an item's quote does not appear under its cited heading in the pinned snapshot
- **THEN** the inventory check fails and names the item and source

### Requirement: Complete coverage of the fixture change
Every requirement and every scenario in the fixture change's specifications SHALL map to at least one inventory item or appear in the inventory's exclusions with a stated reason. The inventory check SHALL fail on any requirement or scenario that is neither mapped nor excluded.

#### Scenario: Unmapped scenario
- **WHEN** a scenario in the pinned fixture change has no inventory item and no exclusion
- **THEN** the inventory check fails and names the scenario

#### Scenario: Excluded entry without a reason
- **WHEN** an exclusion has no stated reason
- **THEN** the inventory check fails and names the exclusion

### Requirement: Prompt-relative classification
Every item SHALL carry exactly one final class, decided relative to the pinned starting prompt by whether a reasonable user who sent that prompt would consider a result that lacks the item, or does it differently, incomplete or incorrect:

| Class | Meaning | Grading |
|---|---|---|
| `mandatory` | Asked for or clearly hinted at by the prompt, or needed by any competent, complete realization of it | Graded as stated |
| `acceptable-alternative` | The underlying need is required, but the reference's mechanism, form, structure, or value is one of several reasonable choices | Graded on its intent only |
| `preference` | Opinion, taste, naming, wording, an incidental value or layout, or another choice whose difference or absence would not make the result less complete or correct | Not graded |

Every `acceptable-alternative` item SHALL have a non-empty intent that states what any acceptable alternative must achieve without the reference's specifics. Items of other classes SHALL have no intent.

#### Scenario: Acceptable alternative without an intent
- **WHEN** an `acceptable-alternative` item has no intent
- **THEN** the inventory check fails and names the item

#### Scenario: Preference item is not graded
- **WHEN** a candidate definition omits or contradicts a `preference` item
- **THEN** that item contributes no criterion to the score

### Requirement: Independent labelling and reconciliation
Final classes SHALL come from two independent label sets produced from the same versioned labelling brief by labellers from different model families, neither of which reads the other's labels. A maintainer SHALL reconcile every item on which the labels disagree, and the reconciled inventory SHALL record for each item both labellers' classes and confidence, the final class, the intent and which labeller's intent it was taken from, whether the class was agreed or reconciled, and, for a reconciled item, the reason. Any general rule the maintainer applies across items SHALL be recorded in the inventory.

#### Scenario: Labellers disagree
- **WHEN** the two label sets give an item different classes
- **THEN** the reconciled inventory records both classes, the maintainer's final class, and the reason for it

#### Scenario: Disagreement left unresolved
- **WHEN** an item's labels disagree and the reconciled inventory gives no final class or no reason
- **THEN** the inventory check fails and names the item

### Requirement: Inventory versioning
A change to the pinned fixture commit, the starting prompt, any item, or any item's final class or intent SHALL produce a new inventory version. The inventory version SHALL be part of the run's series identity, so runs scored against different inventory versions are not compared.

#### Scenario: Final class changes
- **WHEN** a maintainer changes one item's final class
- **THEN** the inventory version changes and runs scored against the earlier version are reported as a different series

### Requirement: Refresh from the fixture
When the fixture pin moves, the suite SHALL provide a maintainer check that compares the inventory against the new fixture change and reports every item whose source quotes no longer match and every requirement or scenario that is newly unmapped. Each reported item SHALL be re-itemized or relabelled through the independent labelling and reconciliation process before the new inventory version can be used for a candidate run.

#### Scenario: Source text changed in the new pin
- **WHEN** the new fixture commit changes the text an item quotes
- **THEN** the refresh check reports that item as needing relabelling
- **AND** preflight rejects a candidate run until the inventory is updated and its new version is pinned
