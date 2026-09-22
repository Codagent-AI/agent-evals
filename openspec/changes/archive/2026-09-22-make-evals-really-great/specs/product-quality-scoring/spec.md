## ADDED Requirements

### Requirement: Deterministic criteria fail only on positive evidence
A scored deterministic browser criterion SHALL have exactly three outcomes: `pass`, `fail`, and not observed. The evaluator SHALL record `fail` only when it holds positive evidence that the candidate violates the requirement the criterion enforces, such as visible text that differs from the normative text, an input that lands on the wrong step, or a browser failure raised by the page. The evaluator SHALL NOT record `fail` because it could not locate the thing it needed to inspect.

Not observed SHALL be deliberately narrow, because the candidate controls what a browser can see. It SHALL apply only when a check depends on a markup convention that the pinned fixture does not mandate, and the evaluator finds no instance of any convention it recognises. The absence of something a reader must be able to see or do, including an active step title, step numbering derived from position, a caption in browse mode, or an operable navigation control, SHALL be positive evidence of a violation and SHALL be recorded as `fail`. An unreadable page state, an adapter diagnostic, and an ambiguous control SHALL remain resumable harness failures as already specified and SHALL NOT be recorded as not observed.

A criterion that combines a reader-visible fact with a convention-dependent fact SHALL be judged in that order: a violation of the reader-visible fact SHALL be recorded as `fail` regardless of whether the convention-dependent fact was observed. Finding a recognised convention on some steps SHALL NOT be treated as proof that a step without one lacks content: when the convention-dependent fact cannot be established for every step it concerns, that fact is not observed. A convention-dependent `fail` SHALL rest on what positively identified objects show, such as identified objects being replaced rather than persisting between steps.

A not-observed record SHALL retain the same bounded observation as any other probe, and SHALL state which conventions the evaluator looked for and that it found none.

#### Scenario: Scene objects use an attribute name the evaluator does not know
- **WHEN** the demo renders the required scene and marks its scene objects with an attribute name the evaluator does not recognise
- **THEN** `demo-evolving-scene-structure` is recorded as not observed
- **AND** no points are deducted by the deterministic evaluator for that criterion
- **AND** the record lists the conventions the evaluator looked for

#### Scenario: Captions are wrong and scene objects are not found
- **WHEN** a step's caption differs from the normative caption and the evaluator also finds no scene objects
- **THEN** `demo-required-scene-content` is recorded as `fail` on the caption evidence
- **AND** it is not recorded as not observed

#### Scenario: Captions are right and scene objects are not found
- **WHEN** every step's caption matches the normative caption and the evaluator finds no scene objects under any convention it recognises
- **THEN** `demo-required-scene-content` is recorded as not observed

#### Scenario: Scene objects are recognised on only some steps
- **WHEN** every caption matches and the evaluator recognises scene objects on some steps and none on others
- **THEN** `demo-required-scene-content` is recorded as not observed
- **AND** it is not recorded as `fail` for the steps where nothing was recognised

#### Scenario: Identified scene objects are replaced between steps
- **WHEN** the evaluator identifies scene objects on consecutive steps and none of the identified objects persists from one step to the next
- **THEN** `demo-evolving-scene-structure` is recorded as `fail` on that evidence

#### Scenario: A reader-visible element is hidden
- **WHEN** the presentation hides its active step title from readers in present mode
- **THEN** `demo-present-mode-behavior` is recorded as `fail`
- **AND** it is not recorded as not observed

#### Scenario: Scene objects are found
- **WHEN** the evaluator finds scene objects under a convention it recognises
- **THEN** the scene criteria are judged `pass` or `fail` from what it observed
- **AND** no fallback judge is consulted for them

### Requirement: Declared fallback judge for not-observed criteria
The automated rubric SHALL declare, for each deterministic criterion that can be recorded as not observed, at most one fallback judge. The fallback declaration SHALL NOT make the fallback judge an owner of the criterion: the criterion SHALL keep its single owning evaluator, its identifier, and its points, and the rubric SHALL continue to reject duplicate criterion ownership. A deterministic criterion with no declared fallback SHALL NOT be recordable as not observed by a conforming evaluator; if one is nevertheless returned, scoring SHALL treat its component as incomplete.

When a criterion with a declared fallback is recorded as not observed, the harness SHALL ask the declared fallback judge for a verdict on that criterion in that run only. The judge SHALL receive the criterion's requirement and guidance, the bounded browser observation, and the statement of which conventions were looked for. The judge SHALL return `pass` or `fail` with a rationale. A `pass` SHALL cite delivered candidate source that establishes the requirement; a `pass` without such a citation SHALL be rejected as invalid judge output. The judge SHALL treat the browser observation as a lead rather than an authoritative verdict, consistent with existing source-review rules.

Exact criterion coverage SHALL continue to hold in both directions for every evaluator. In a run with not-observed criteria, the fallback judge's expected criterion set SHALL be its owned criteria plus exactly the not-observed criteria that name it as fallback; a fallback verdict for a criterion that was observed, or a missing fallback verdict, SHALL be invalid coverage.

Points SHALL only ever be awarded from a binary `pass` or `fail` verdict; not observed is an unresolved state, never a scored verdict. The scorer SHALL award a fallback-resolved criterion the same points it would award for the same verdict from its owner. It SHALL record, for every scored criterion, whether the verdict came from the owning evaluator or from the fallback judge, and SHALL retain the fallback judge's source citations. An unresolved criterion SHALL make only its own subcomponent and component incomplete; other deterministic subcomponents SHALL keep their scores. When the fallback verdict is missing after the judge's retry budget is exhausted, the criterion's component SHALL be incomplete and the existing missing-judge-output outcome SHALL apply; a missing fallback verdict SHALL never be scored as `fail`.

Hard-gate handling of unobserved evidence SHALL NOT change. Hard gates SHALL NOT have fallback judges.

#### Scenario: A not-observed criterion is resolved by its fallback judge
- **WHEN** `demo-evolving-scene-structure` is recorded as not observed and its declared fallback judge returns `pass` citing the delivered source that keeps scene objects across steps
- **THEN** the criterion is awarded its full points
- **AND** the score records that the verdict came from the fallback judge
- **AND** the evaluation proceeds without waiting for a maintainer

#### Scenario: The fallback judge finds the requirement unmet
- **WHEN** a criterion is recorded as not observed and its fallback judge returns `fail` with a rationale
- **THEN** the criterion is awarded no points
- **AND** the score records that the verdict came from the fallback judge

#### Scenario: A fallback pass cites no source
- **WHEN** the fallback judge returns `pass` for a not-observed criterion without citing delivered candidate source
- **THEN** the harness rejects the output as invalid judge output
- **AND** the criterion is not awarded points on that output

#### Scenario: The fallback verdict never arrives
- **WHEN** a criterion is recorded as not observed and the fallback judge produces no valid verdict within its retry budget
- **THEN** the criterion's component is incomplete
- **AND** the criterion is not scored as `fail`

#### Scenario: One unresolved criterion does not erase its siblings
- **WHEN** one deterministic criterion is not observed and unresolved, and every other deterministic criterion was observed
- **THEN** only the subcomponent containing the unresolved criterion is incomplete
- **AND** the other deterministic subcomponents report their awarded points

#### Scenario: A fallback judge answers for an observed criterion
- **WHEN** a judge returns a verdict for a deterministic criterion that the browser evaluator observed
- **THEN** scoring rejects the judge output as invalid criterion coverage

#### Scenario: A candidate suppresses hooks to avoid a browser failure
- **WHEN** a candidate removes every recognised scene-object hook and its source does not keep scene objects across steps
- **THEN** the criterion is recorded as not observed and the fallback judge returns `fail`
- **AND** the candidate gains no points by having hidden the hooks

#### Scenario: A criterion without a fallback cannot be observed
- **WHEN** a deterministic criterion with no declared fallback is returned as not observed
- **THEN** its component is incomplete
- **AND** the official verdict is unavailable rather than failed

### Requirement: Focused controls keep their keys
The deterministic control-key check SHALL follow the pinned fixture scenario "Controls keep their keys": while focus is on an interactive control, navigation keys drive that control rather than also advancing the deck. After activating a navigation control the way a pointer does, the check SHALL NOT require a deck navigation key pressed while that control still holds focus to advance the deck, and SHALL NOT deduct when the deck stays on its step. The check SHALL deduct when it holds positive evidence of a violation: the deck fails to clamp at its first or last step, or deck navigation keys do not advance the deck once focus rests on a non-interactive part of the presentation itself. The check SHALL keep focus inside the presentation when it releases a control, so that a presentation which listens for keys on its own root is not failed, and SHALL verify that focus is no longer on an interactive control. When it cannot establish that state, it SHALL raise a resumable harness failure rather than record a product deduction.

The check SHALL continue to establish whichever mode exposes a navigation control rather than skip itself, and SHALL continue to activate a control by focusing it before firing.

#### Scenario: The deck ignores a deck key while a control holds focus
- **WHEN** the check activates a navigation control and presses a deck navigation key while that control still holds focus, and the deck stays on its step
- **THEN** `demo-navigation-boundaries-and-control-keys` is not deducted for that observation

#### Scenario: Deck keys stop working after a control was used
- **WHEN** the check activates a navigation control, moves focus to a non-interactive part of the presentation, and presses a deck navigation key, and the deck does not advance
- **THEN** `demo-navigation-boundaries-and-control-keys` is recorded as `fail`

#### Scenario: The presentation listens for keys on its own root
- **WHEN** a presentation handles deck keys only while focus is inside its root, and the check releases a control
- **THEN** focus rests inside the presentation and the deck key advances the deck
- **AND** the criterion is not deducted

#### Scenario: Focus cannot be released from a control
- **WHEN** the check cannot move focus off the interactive control
- **THEN** it raises a resumable harness failure
- **AND** no criterion is deducted

#### Scenario: The deck does not clamp at a boundary
- **WHEN** a deck navigation key pressed on the last step moves the deck off the last step
- **THEN** `demo-navigation-boundaries-and-control-keys` is recorded as `fail`

#### Scenario: A control passes arrow keys through to the deck
- **WHEN** a presentation lets a deck navigation key advance the deck even while a button holds focus
- **THEN** the check records the observation and does not deduct for it
- **AND** whether that pass-through conforms is left to the scene-kit criterion `navigation-controls-keep-keys`
