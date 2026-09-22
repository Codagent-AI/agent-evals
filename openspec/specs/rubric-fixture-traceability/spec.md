# rubric-fixture-traceability Specification

## Purpose
TBD - created by archiving change make-evals-really-great. Update Purpose after archive.
## Requirements
### Requirement: Every criterion states where its requirement comes from
Every criterion and hard gate in the `and-scene` automated rubric SHALL declare its requirement source as either fixture-owned or eval-owned. A fixture-owned criterion SHALL cite the pinned fixture with a structured citation: the fixture document, the requirement, scenario, or section heading within it, and a quoted fragment of the normative text the criterion enforces. An eval-owned criterion, such as one that judges workflow evidence the fixture does not describe, SHALL state the reason it is eval-owned. Rubric validation SHALL reject a criterion that declares neither, and SHALL reject a fixture-owned criterion whose citation is incomplete.

#### Scenario: A fixture-owned criterion is cited
- **WHEN** the rubric is validated and `demo-navigation-boundaries-and-control-keys` cites the fixture scenario "Controls keep their keys" with a quoted fragment
- **THEN** validation accepts the criterion's requirement source

#### Scenario: A criterion declares no source
- **WHEN** a rubric criterion declares neither a fixture citation nor an eval-owned reason
- **THEN** rubric validation fails and names the criterion

#### Scenario: A citation is incomplete
- **WHEN** a fixture-owned criterion cites a document without a heading or quoted fragment
- **THEN** rubric validation fails and names the criterion

### Requirement: Citations are verified against the pinned fixture
The suite SHALL keep a committed snapshot of the normative fixture documents at the pinned fixture revision. The repository check SHALL verify every fixture citation against that snapshot without network access: the cited document SHALL exist in the snapshot, the cited heading SHALL exist in that document, and the quoted fragment SHALL appear under that heading after whitespace and Unicode punctuation normalization. A citation that fails any of these SHALL fail the check and name the criterion and the part that did not match.

#### Scenario: A quoted fragment no longer matches
- **WHEN** a criterion's quoted fragment does not appear under its cited heading in the snapshot
- **THEN** the repository check fails and names the criterion and the unmatched fragment

#### Scenario: A cited heading does not exist
- **WHEN** a criterion cites a scenario heading that the snapshot document does not contain
- **THEN** the repository check fails and names the criterion and heading

#### Scenario: A fragment differs only in punctuation style
- **WHEN** a quoted fragment differs from the fixture text only in apostrophe style or whitespace
- **THEN** the citation is accepted

### Requirement: Concrete values in guidance are accounted for
Every concrete value in a criterion's requirement or guidance text, meaning a dimension, a number that carries a unit, an attribute name, or a selector, SHALL be accounted for. Bare numbers without a unit are outside this check; the quoted-fragment check covers the requirement itself. Guidance MAY apply to a group of criteria; a value SHALL be accepted when it appears in the normative text under a heading cited by a criterion that guidance applies to. Any other value SHALL be declared eval-owned in the rubric with a stated reason, such as a suite-owned inspection viewport or a web-standard attribute name. A value that appears in the fixture only as an example, outside the cited normative text, SHALL NOT be accepted as fixture-owned. The repository check SHALL fail and name the guidance's criteria and the value when a concrete value is neither.

#### Scenario: Guidance states a dimension the fixture does not
- **WHEN** a criterion's guidance states a canvas size of 880×495 and the cited fixture text states 880 × 380
- **THEN** the repository check fails and names the criterion and the value 880×495

#### Scenario: Guidance states the fixture's dimension
- **WHEN** a criterion's guidance states a canvas size of 880×380 and its cited fixture text states 880 × 380
- **THEN** the value is accepted

#### Scenario: Guidance requires an example hook
- **WHEN** a criterion's guidance names an attribute that the fixture mentions only as an example and that does not appear in the criterion's cited normative text
- **THEN** the repository check fails unless the value is declared eval-owned with a reason

#### Scenario: An inspection viewport is eval-owned
- **WHEN** a criterion's guidance names a viewport width the suite uses for inspection and declares it eval-owned with a reason
- **THEN** the value is accepted

### Requirement: The snapshot matches the fixture pin
The fixture snapshot SHALL record the fixture revision it was taken from and the git blob identifier of every included document. The repository check SHALL fail when the recorded revision differs from the suite's fixture pin, or when a snapshot document's content does not match its recorded blob identifier. The suite SHALL provide a maintainer refresh command that regenerates the snapshot from a checkout of the fixture at the pinned revision and verifies each blob identifier against that checkout. Changing the fixture pin without refreshing the snapshot SHALL fail the repository check.

#### Scenario: The fixture pin moves without a refresh
- **WHEN** the suite's fixture pin is changed and the snapshot still records the previous revision
- **THEN** the repository check fails and tells the maintainer to refresh the snapshot

#### Scenario: A snapshot document is edited by hand
- **WHEN** a snapshot document's content no longer matches its recorded blob identifier
- **THEN** the repository check fails and names the document

#### Scenario: The snapshot is refreshed from the pinned checkout
- **WHEN** a maintainer runs the refresh command against a checkout at the pinned revision
- **THEN** the snapshot and its recorded blob identifiers match that checkout
- **AND** the repository check passes

#### Scenario: The refresh checkout is at the wrong revision
- **WHEN** the refresh command is run against a checkout that is not at the pinned revision
- **THEN** the refresh fails without changing the snapshot

