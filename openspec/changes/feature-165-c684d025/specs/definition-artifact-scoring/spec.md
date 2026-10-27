## MODIFIED Requirements

### Requirement: Requirement coverage
The rubric SHALL contain one coverage criterion for each `mandatory` and `acceptable-alternative` inventory item and none for `preference` items. Each criterion SHALL be judged `met`, `partial`, or `missing`, where `partial` means the artifacts commit to the item's intent but leave out or weaken part of what the item requires: a `mandatory` item against its statement, and an `acceptable-alternative` item against its intent only, so a different mechanism that achieves the intent is `met`. An item SHALL count as captured only where an artifact commits to it in a specification requirement or scenario, a design decision, or a proposal scope statement; a mention only in the test plan or in passing SHALL NOT count. A `scope-exclusion` item SHALL be `met` when the definition does not include the excluded scope, without requiring an explicit exclusion statement. Each criterion SHALL be judged against its item's pinned anchors, which state in the reference's own words what counts as `met`, `partial`, and `missing`. A definition that contradicts a graded item SHALL be scored under that item's coverage criterion only. An item the disclosure audit marks leaked SHALL be excluded from both the earned and the possible coverage points and reported as `leaked`. When every graded item is leaked, coverage and the total SHALL be reported as unavailable rather than zero, with that reason.

An item the disclosure audit settles `corrected` SHALL be judged as usual. It SHALL then earn the rubric's declared correction fraction of the coverage points its verdict would otherwise earn, and its possible points SHALL be unchanged. It SHALL be reported with its verdict, marked `corrected`, and with the points it earned. The rubric SHALL declare the correction fraction, greater than zero and less than one. The first rubric version that declares it SHALL set it to one half. Coverage SHALL be the primary component.

#### Scenario: Alternative mechanism meets the intent
- **WHEN** a definition specifies a different mechanism that achieves an `acceptable-alternative` item's intent
- **THEN** that criterion is `met`

#### Scenario: Item appears only in the test plan
- **WHEN** a requirement appears only as a test-plan case with no corresponding specification, design decision, or scope statement
- **THEN** that criterion is not `met`

#### Scenario: Anchor decides a borderline item
- **WHEN** a definition commits to an item in a way its `partial` anchor describes
- **THEN** that criterion is `partial`, and the verdict cites the artifact location

#### Scenario: Every graded item leaked
- **WHEN** the disclosure audit marks every `mandatory` and `acceptable-alternative` item leaked
- **THEN** the coverage score and the total are reported as unavailable, not zero, with the reason that coverage could not be measured

#### Scenario: Excluded scope is simply absent
- **WHEN** a definition neither includes nor mentions an excluded scope item
- **THEN** that `scope-exclusion` criterion is `met`

#### Scenario: Corrected item earns partial credit
- **WHEN** the disclosure audit settles an item `corrected`, its coverage verdict is `met`, and the rubric's correction fraction is one half
- **THEN** the item earns half of its `met` points, its possible points are unchanged, and it is reported as `met` and `corrected`

#### Scenario: Corrected item the definition still misses
- **WHEN** the disclosure audit settles an item `corrected` and its coverage verdict is `missing`
- **THEN** the item earns no points, its possible points are unchanged, and it is reported as `missing` and `corrected`

#### Scenario: End-to-end definition score carries the penalty
- **WHEN** an end-to-end run's disclosure audit settles an item `corrected` and the collected definition covers it
- **THEN** that run's definition score gives the item the same partial credit the define suite would
- **AND** the run's product score is computed as if the item had not been corrected

#### Scenario: Run without corrections
- **WHEN** the disclosure audit settles no item `corrected`
- **THEN** every item's coverage points are computed exactly as they would be without the correction fraction

### Requirement: Fidelity
The fidelity component SHALL deduct for a definition that contradicts an answer the simulated user gave in the run's conversation, when that answer concerns a `preference` item or a matter outside the inventory. A contradiction of a `mandatory` or `acceptable-alternative` item, including one the simulated user stated, SHALL be scored once, under that item's coverage criterion, and SHALL NOT also be deducted under fidelity. Each deduction SHALL cite both the artifact location and the contradicted exchange. Fidelity SHALL NOT deduct for a definition that departs from a simulated-user correction, meaning the part of a reply that corrects an exclusion or contradiction the agent's turn stated, unsolicited, outside any question it asked or option or proposed default it offered. A correction concerns a graded item, which is scored under its coverage criterion; a correction that strays into a `preference` or a matter outside the inventory is an over-correction, which creates no fidelity obligation. The exemption SHALL cover only that correcting part: an answer to a question the agent asked, and a choice or rejection of an option or proposed default it offered, SHALL create fidelity obligations as before, including in the same reply as a correction. Scope a definition adds beyond the inventory SHALL NOT be deducted unless it contradicts the simulated user; included excluded scope is scored by its `scope-exclusion` coverage criterion.

#### Scenario: Definition ignores the user's answer
- **WHEN** the simulated user stated a preference that the inventory does not grade, and the definition specifies the opposite
- **THEN** fidelity is deducted, citing the artifact location and the exchange

#### Scenario: Contradiction of a graded item is scored once
- **WHEN** a definition contradicts a `mandatory` item that the simulated user also stated in an answer
- **THEN** the item's coverage criterion is not `met`, and fidelity makes no deduction for it

#### Scenario: Definition departs from an over-correction
- **WHEN** the simulated user corrected a canvas size the agent stated and the definition keeps the agent's canvas size
- **THEN** fidelity makes no deduction for it

#### Scenario: Mixed reply keeps its preference answer
- **WHEN** one reply corrects an excluded matter and also answers the agent's question about a preference, and the definition specifies the opposite of that preference answer
- **THEN** fidelity is deducted for the preference answer, citing that exchange

#### Scenario: Rejected offered default still binds
- **WHEN** the agent offered a canvas size as a proposed default, the simulated user rejected it, and the definition keeps the rejected default
- **THEN** fidelity is deducted, citing the artifact location and that exchange

#### Scenario: Reasonable added scope
- **WHEN** a definition adds behavior the inventory does not contain, which neither falls under a scope exclusion nor contradicts the simulated user
- **THEN** no score is deducted for it

