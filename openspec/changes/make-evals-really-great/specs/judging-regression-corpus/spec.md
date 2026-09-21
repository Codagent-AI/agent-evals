## ADDED Requirements

### Requirement: Golden verdict corpus of real candidates
The `and-scene` suite SHALL keep a committed corpus of real candidate presentations. Each corpus entry SHALL identify a candidate by its repository and full commit revision, and SHALL record the adjudicated correct outcome, `pass`, `fail`, or not observed, for every deterministic browser criterion and for the two hard gates derived from browser observation, `verification-sample-outline` and `verification-every-produced-step-renders`. Hard gates derived from build or verification output are outside the corpus, because a replay supplies them as fixed inputs. Every golden `fail` and every golden not observed SHALL cite the pinned fixture text or rubric requirement it rests on and state the observed fact that justifies it, so that the corpus cannot silently preserve a misreading of the fixture. The corpus SHALL include every distinct candidate behind a published result and the three issue #26 factory repetitions, and SHALL NOT contain two entries for one revision.

Every golden verdict SHALL carry its own history: an ordered list of the outcomes it has held, each with a date and an explanation that names the fixture text or the evaluator defect that justifies it. The current outcome SHALL equal the outcome of the latest history entry, so a golden verdict cannot be changed without recording why.

#### Scenario: The corpus covers every published candidate
- **WHEN** the corpus is validated
- **THEN** it contains one entry for each distinct candidate revision behind a published result and one for each issue #26 repetition

#### Scenario: A golden failure has no justification
- **WHEN** a corpus entry records `fail` for a criterion without citing the requirement it rests on
- **THEN** corpus validation fails and names the entry and criterion

#### Scenario: A golden verdict is changed without recording why
- **WHEN** a golden verdict's outcome differs from the outcome of its latest history entry, or that entry has no explanation
- **THEN** corpus validation fails and names the entry and criterion

#### Scenario: A golden verdict is incomplete
- **WHEN** a corpus entry omits a deterministic criterion
- **THEN** corpus validation fails and names the missing criterion

### Requirement: Replay against the production evaluator
The suite SHALL provide a maintainer replay command that runs the production deterministic browser evaluator, unmodified, against an already built and served corpus candidate and compares the resulting outcome of every criterion with the golden verdict. Building and serving a candidate SHALL remain outside the replay, consistent with the pinned reference regression. The replay SHALL process one candidate at a time, because replays share a browser.

The replay SHALL report every criterion whose outcome differs from its golden verdict, with the golden outcome, the replayed outcome, and the replayed rationale. It SHALL exit nonzero when any outcome differs. A harness failure during replay SHALL be reported as a harness failure for that candidate and SHALL NOT be recorded as an outcome or compared with a golden verdict. The replay SHALL NOT modify any published result.

#### Scenario: Every outcome matches
- **WHEN** a maintainer replays every corpus candidate and each criterion's outcome equals its golden verdict
- **THEN** the replay reports no differences and exits zero

#### Scenario: An evaluator change moves a verdict
- **WHEN** a replay produces `fail` for a criterion whose golden verdict is `pass`
- **THEN** the replay reports the candidate, criterion, both outcomes, and the replayed rationale
- **AND** it exits nonzero

#### Scenario: One change moves several candidates at once
- **WHEN** an evaluator change flips the same criterion on four corpus candidates
- **THEN** the replay reports all four differences in one run

#### Scenario: The browser cannot be driven during replay
- **WHEN** the browser adapter fails while a candidate is replayed
- **THEN** the replay reports a harness failure for that candidate
- **AND** no outcome is recorded or compared for it

#### Scenario: A candidate is not being served
- **WHEN** the replay is pointed at an address where no candidate responds
- **THEN** the replay reports that the candidate is unavailable and exits nonzero
- **AND** it does not report product failures for that candidate

### Requirement: Replay manifest and staleness check
A completed replay SHALL write a generated manifest that records: each candidate revision replayed; every criterion outcome with its bounded observation; a content hash of every source file the deterministic evaluator transitively loads, the automated rubric, that candidate's golden verdicts, and the replay command itself; the fixture and reference pins; the Node, browser, and `chrome-devtools-axi` versions used; and the replay time. The manifest SHALL be committed with the change that required the replay. Recording an explanation, or adding a corpus candidate, SHALL NOT by itself require candidates whose golden verdicts did not change to be replayed again.

The repository check that runs in continuous integration SHALL fail, without needing a browser or a built candidate, when: the manifest is missing or malformed; any recorded source hash differs from the current source; the manifest does not cover every corpus candidate and criterion; a manifest outcome differs from its golden verdict; or a candidate's golden verdicts changed after its replay was recorded. The failure message SHALL tell the maintainer to run the replay.

The manifest is a guard against forgetting the replay. It SHALL NOT be presented as proof against deliberate forgery.

#### Scenario: The evaluator changes without a replay
- **WHEN** a change edits a source file the deterministic evaluator loads and does not regenerate the manifest
- **THEN** the repository check fails and tells the maintainer to run the replay

#### Scenario: The rubric changes without a replay
- **WHEN** a change edits the automated rubric and does not regenerate the manifest
- **THEN** the repository check fails

#### Scenario: A replay was run and committed
- **WHEN** the manifest's source hashes match the current sources, it covers every corpus candidate and criterion, and its outcomes equal the golden verdicts
- **THEN** the repository check passes without starting a browser

#### Scenario: A golden verdict changed after the replay
- **WHEN** a candidate's golden verdict is changed and that candidate is not replayed again
- **THEN** the repository check fails and names the candidate

#### Scenario: A new candidate is added
- **WHEN** a candidate is added to the corpus and replayed
- **THEN** the replay records of the other candidates remain current

#### Scenario: An unrelated file changes
- **WHEN** a change edits only files the deterministic evaluator does not load
- **THEN** the manifest remains current and the repository check does not require a replay
