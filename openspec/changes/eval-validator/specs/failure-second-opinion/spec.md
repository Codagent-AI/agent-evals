## MODIFIED Requirements

### Requirement: Verifier inputs and answer
For each failure, the verifier SHALL receive:

- the criterion or gate identifier and requirement text, and its declared requirement source, including the fixture quote when it is fixture-owned;
- for a browser-decided failure, the probe's retained observations and trace: the recorded sessions, states, and the basis of each reading, together with the recorded verdict and rationale;
- the recorded runtime evidence that bears on the failure, such as page errors, console failures, and build or serve logs;
- read access to the candidate's verified neutral source.

The verifier SHALL decide whether the candidate meets the requirement as quoted, not whether the probe ran as written. It SHALL answer exactly one of `uphold` or `overturn`, with a rationale. An `uphold` SHALL name the part of the requirement the candidate does not meet (`unmet_requirement`). An `overturn` SHALL cite candidate source. An `overturn` of a failure that was not measured in a browser SHALL also name the probe step or recorded observation it says was mismeasured and explain how the measurement went wrong; for a browser-derived failure, the replay may stand in for that explanation. For a fallback-judged outline input, the relevant recorded observation is the fallback judge's verdict and cited source rather than a failed browser probe.

For a browser-derived criterion or gate, the answer SHALL include a structured replay with 1–12 actions, starting with navigation to a candidate path, and one expected observation. A navigation path SHALL begin with one `/` and SHALL NOT contain `//` at its start, `..`, or a backslash, and the harness SHALL refuse any navigation whose resolved URL, or any replay observation whose page origin, differs from the candidate server's origin. Remaining actions are limited to clicking a selector, pressing a key optionally while holding any of Alt, Control, and Meta, sending keys, swiping left or right by touch or pointer, optionally starting the swipe on a selector, and waiting up to 2000 ms. Expected observations are limited to a step index equaling a specified value, a changed step index or step count, a `present` or `browse` mode, selector visibility, or text present in a selector. A change or hide expectation compares the state after navigation with the state after the remaining actions. An uphold and a build or serve terminal answer MAY use `replay: null`.

The verifier SHALL use the same judge authority and invocation path as the other product judges, including the configured judge model, the bounded retry budget, and checkpointed reuse of completed calls. A completed verifier call SHALL be reused on resume when its inputs are unchanged, and SHALL be re-run when they changed.

#### Scenario: The verifier is given the failure's evidence
- **WHEN** the verifier is called for a browser criterion that failed
- **THEN** its request contains the criterion requirement, its fixture quote, the probe's retained observations and trace, the recorded verdict and rationale, and access to the neutral source

#### Scenario: A run resumes after the verifier finished
- **WHEN** an interrupted evaluation resumes and a verifier call for an unchanged failure has already completed
- **THEN** the harness reuses that call's recorded result instead of calling the verifier again

#### Scenario: A replay presses a modified key
- **WHEN** a verifier's replay presses `ArrowRight` while holding Alt
- **THEN** the harness accepts the action as well-formed and dispatches the key with the Alt modifier

#### Scenario: A replay swipe starts on a selector
- **WHEN** a verifier's replay swipes left starting on a selector
- **THEN** the harness begins the single-touch swipe at that element's centre

## ADDED Requirements

### Requirement: Input-hygiene probe overturns
The harness's replay allowlist SHALL contain these entries, admitted on the same terms as the existing entries:

| Target and recorded failure | Admitted inputs | Admitted expectation and harness check |
| --- | --- | --- |
| `input-modifier-keys-pass-through`, when a modified press changed the step | unmodified `press` of `ArrowRight` to leave the first step, then `press` of the recorded key holding the recorded modifier | `step-index-equals` with the step before the first modified press; at least one modified press SHALL use the key and modifier of the recorded failing observation, no unmodified press SHALL follow a modified press, and the final step SHALL equal that step |
| `input-swipe-from-control-ignored` | unmodified `press` of `ArrowRight` to leave the first step, `press` or `click` to establish the recorded mode, then one `swipe` that starts on a selector matching the recorded control and uses the input path of the recorded failing observation | `step-index-equals` with the step before the swipe; the swipe SHALL start on an element matching the recorded control in the recorded mode, SHALL use the touch or pointer input path that changed the step in the recorded failure, SHALL be the last input action, and the final step SHALL equal that step |

A replay outside these entries SHALL follow the existing audited-replay path.

The harness SHALL NOT overturn an `input-modifier-keys-pass-through` failure that the probe recorded on a prevented default, through either an admitted or an audited replay, because no replay observation can show whether a default was prevented. It SHALL record such an overturn as rejected, with that reason, before running any replay or audit. When the recorded failure includes both a step change and a prevented default, the prevented default alone SHALL keep the failure standing.

#### Scenario: A modifier-key step change is overturned by an admitted replay
- **WHEN** the probe recorded that Alt+ArrowRight changed the step, and the verifier's replay leaves the first step, presses Alt+ArrowRight, and expects the step to stay unchanged
- **AND** the replay observes exactly that, and the cited spans are valid
- **THEN** the overturn is accepted as confirmed by browser replay

#### Scenario: A prevented-default failure cannot be overturned
- **WHEN** `input-modifier-keys-pass-through` failed because the page prevented the default of Control+ArrowLeft
- **AND** a verifier proposes an overturn whose replay shows that the step does not change
- **THEN** the harness rejects the overturn without running the replay or an audit, and the failure stands

#### Scenario: A swipe replay that uses a different input path
- **WHEN** the probe recorded that a touch swipe starting on the mode control changed the step, and a verifier's replay performs the same swipe by pointer
- **THEN** the replay is outside the admitted entry and can confirm an overturn only through the audited-replay path

#### Scenario: A swipe replay that does not start on the recorded control
- **WHEN** a verifier's replay for `input-swipe-from-control-ignored` swipes from the stage rather than from the recorded control
- **THEN** the replay is outside the admitted entry and can confirm an overturn only through the audited-replay path
