# failure-second-opinion Specification

## Purpose
TBD - created by archiving change feature-75-d90b4b98. Update Purpose after archive.
## Requirements
### Requirement: Failures that receive a second opinion
In a candidate evaluation, including an evaluator-only rescore, the harness SHALL obtain a second opinion from an LLM verifier for each of these failures, and for no others:

- every deterministic browser criterion whose owning browser evaluator recorded `fail`;
- every failed hard gate, whatever decided it.

The verifier SHALL be called once per failure. A criterion that failed under its declared fallback judge, and an LLM-judged criterion, SHALL NOT receive a second opinion on its own account.

`verification-sample-outline` SHALL have no verifier call of its own, because it is derived from the final verdicts of `demo-route-and-registration` and `demo-nine-step-content-and-order`. When the derived gate fails, each failing input criterion that has not already received a second opinion SHALL receive one on the gate's behalf; this includes an input that failed under its fallback judge. The gate SHALL then be derived again from the resulting final verdicts.

An input that failed under its fallback judge is a non-browser failure for this follow-up. Its verifier and span audit SHALL receive the fallback judge's recorded `fail`, rationale, and source citations. It remains subject to source-citation validation and the span audit, but it SHALL NOT require browser replay. The harness SHALL re-derive the outline gate only after every required input verifier call and audit has completed. Missing judge output for any input SHALL leave that input unresolved and follow the resumable harness-failure path; one overturned input SHALL NOT make the gate pass while another input remains failed or unresolved.

A build or serve failure that would end the run as a conclusive product failure SHALL receive its second opinion before that outcome is recorded, under the terminal-failure contract.

The second opinion SHALL NOT run in a reference-baseline evaluation or in calibration. In those modes the raw verdicts are final and no second-opinion data is recorded.

#### Scenario: A browser criterion fails
- **WHEN** the browser evaluator records `fail` for `demo-supported-navigation` in a candidate evaluation
- **THEN** the harness makes exactly one verifier call for that criterion

#### Scenario: A criterion passes or is not observed
- **WHEN** a deterministic criterion is recorded as `pass` or as not observed
- **THEN** no verifier call is made for it

#### Scenario: A fallback judge fails a criterion
- **WHEN** a not-observed criterion is resolved as `fail` by its fallback judge
- **AND** that criterion is not an input of a failed `verification-sample-outline` gate
- **THEN** no verifier call is made for it

#### Scenario: The outline gate fails on a fallback verdict
- **WHEN** `demo-nine-step-content-and-order` is resolved as `fail` by its fallback judge and the derived `verification-sample-outline` gate therefore fails
- **THEN** the harness makes one verifier call for `demo-nine-step-content-and-order` on the gate's behalf
- **AND** the gate is derived again from the criterion's resulting final verdict

#### Scenario: A fallback-judged outline input is overturned
- **WHEN** the fallback judge recorded a failed outline input with source citations
- **AND** its follow-up verifier cites valid source spans and the span audit confirms the overturn
- **THEN** the input can pass without browser replay, and the audit includes the fallback verdict and citations

#### Scenario: One outline input remains failed or unresolved
- **WHEN** one failed outline input is overturned and the other remains `fail`
- **THEN** the derived outline gate remains `fail`
- **WHEN** a required input verifier or audit produces no valid output after retries
- **THEN** the gate remains unresolved and the run follows the resumable harness-failure path

#### Scenario: Both outline inputs were already checked
- **WHEN** both outline input criteria failed in the browser and each received its own second opinion
- **THEN** no further verifier call is made for the derived outline gate

#### Scenario: The renders gate fails
- **WHEN** `verification-every-produced-step-renders` fails because runtime or console failures were recorded
- **THEN** the harness makes exactly one verifier call for that gate

#### Scenario: A reference baseline has a failing criterion
- **WHEN** a reference-baseline evaluation records a deterministic `fail`
- **THEN** no verifier call is made
- **AND** the raw verdict is final

#### Scenario: A finished run is rescored
- **WHEN** an evaluator-only rescore produces deterministic criterion fails or failed hard gates
- **THEN** each of them receives a second opinion exactly as in an original candidate evaluation

### Requirement: Verifier inputs and answer
For each failure, the verifier SHALL receive:

- the criterion or gate identifier and requirement text, and its declared requirement source, including the fixture quote when it is fixture-owned;
- for a browser-decided failure, the probe's retained observations and trace: the recorded sessions, states, and the basis of each reading, together with the recorded verdict and rationale;
- the recorded runtime evidence that bears on the failure, such as page errors, console failures, and build or serve logs;
- read access to the candidate's verified neutral source.

The verifier SHALL decide whether the candidate meets the requirement as quoted, not whether the probe ran as written. It SHALL answer exactly one of `uphold` or `overturn`, with a rationale. An `uphold` SHALL name the part of the requirement the candidate does not meet (`unmet_requirement`). An `overturn` SHALL cite candidate source. An `overturn` of a failure that was not measured in a browser SHALL also name the probe step or recorded observation it says was mismeasured and explain how the measurement went wrong; for a browser-derived failure, the replay may stand in for that explanation. For a fallback-judged outline input, the relevant recorded observation is the fallback judge's verdict and cited source rather than a failed browser probe.

For a browser-derived criterion or gate, the answer SHALL include a structured replay with 1–12 actions, starting with navigation to a candidate path, and one expected observation. A navigation path SHALL begin with one `/` and SHALL NOT contain `//` at its start, `..`, or a backslash, and the harness SHALL refuse any navigation whose resolved URL, or any replay observation whose page origin, differs from the candidate server's origin. Remaining actions are limited to clicking a selector, pressing a key, sending keys, swiping left or right by touch or pointer, and waiting up to 2000 ms. Expected observations are limited to a step index equaling a specified value, a changed step index or step count, a `present` or `browse` mode, selector visibility, or text present in a selector. A change or hide expectation compares the state after navigation with the state after the remaining actions. An uphold and a build or serve terminal answer MAY use `replay: null`.

The verifier SHALL use the same judge authority and invocation path as the other product judges, including the configured judge model, the bounded retry budget, and checkpointed reuse of completed calls. A completed verifier call SHALL be reused on resume when its inputs are unchanged, and SHALL be re-run when they changed.

#### Scenario: The verifier is given the failure's evidence
- **WHEN** the verifier is called for a browser criterion that failed
- **THEN** its request contains the criterion requirement, its fixture quote, the probe's retained observations and trace, the recorded verdict and rationale, and access to the neutral source

#### Scenario: A run resumes after the verifier finished
- **WHEN** an interrupted evaluation resumes and a verifier call for an unchanged failure has already completed
- **THEN** the harness reuses that call's recorded result instead of calling the verifier again

### Requirement: Overturn acceptance
An overturn asserts both that the raw `fail` was a measurement problem and that the candidate meets the requirement. The harness SHALL accept an overturn only when all of these hold:

1. for a failure not measured in a browser, it names the mismeasured probe step or observation and explains the measurement fault;
2. it cites candidate source as one or more spans, each a path with a start line and an end line;
3. at least one span is valid: its path is a regular file in the verified delivery's source inventory, inside the neutral source root and not a symbolic link; its start line is at least 1; its end line is not before its start line; and its end line is within the file. An invalid span, or a log citation outside the recorded artifacts, is dropped and recorded with its reason rather than rejecting the overturn, and only the valid spans reach the audit;
4. unless an admitted replay decides the overturn (condition 5), the source audit, shown exactly the cited spans together with the failing record (the probe's or gate's recorded verdict, rationale, observations, and reading basis), every page or console failure recorded for it, and, for a browser-derived failure, the replay plan and the harness's observation of it, confirms all of these: the spans establish that the requirement is met; the stated measurement fault matches the recorded failing observation; and every contrary runtime observation is accounted for as a measurement fault.
5. for a deterministic criterion whose browser evaluator recorded `fail`, or for `verification-every-produced-step-renders`, the replay opens the demo route, and a real-browser replay against the running candidate server completes with its observed result matching the expected observation and no product failure. When the replay also lies inside the harness's replay allowlist for that target and its observations satisfy the allowlist, it decides the overturn without the source audit. Otherwise the source audit decides, shown the replay plan and the harness's observation of it as evidence the harness did not admit. The harness runs the replay before the source audit.

The harness, not the verifier, decides which replay can confirm a browser-derived failure on its own. The allowlist is keyed by the failing target and its recorded failure. An admitted replay, outside its first navigation, which SHALL open the demo route, uses only `wait` and the input actions its entry names, and at least one of them. A target or recorded failure with no allowlist entry, or a replay outside its entry, can still be overturned, but only when its replay passes in a real browser and the source audit confirms that the spans and the replay observations together show the requirement met in the situation the failing record describes:

| Target and recorded failure | Admitted inputs | Admitted expectation and harness check |
| --- | --- | --- |
| `demo-supported-navigation`, when exactly one of keyboard, swipe, or direct jump failed | `press` of `ArrowRight` or `ArrowLeft` for keyboard; `swipe` for swipe; `click` for direct jump | `step-index-changes`, or `step-index-equals` with a value different from the step before the first admitted input; the final step SHALL differ from that step |
| `demo-focus-and-keyboard-accessibility`, when keyboard navigation did not move | `press` of `ArrowRight` or `ArrowLeft` | as above |
| `demo-step-and-transition-reliability`, when a transition stalled | `press` of `ArrowRight` or `ArrowLeft` | as above, and no runtime or console failure during replay |
| `demo-mode-interaction-reliability`, when a toggle left an unreadable state | `press` or `click` | `mode-equals`; the final mode SHALL be declared and differ from the mode before the first mode action, with no runtime or console failure |
| `demo-present-mode-behavior` | `press` or `click` | `text-present` whose text is the normative title of the final step, shown in declared `present` mode |
| `demo-nine-step-content-and-order`, when a named step's title mismatched | `press` or `click` | `text-present` whose text is that step's normative title, on that step |
| `demo-required-scene-content` or `quality-captions-and-navigation`, when a named step's caption was missing | `press` or `click` | `text-present` whose text is that step's normative caption, on that step in declared `browse` mode |
| `verification-every-produced-step-renders` | `press`, `swipe`, or `click` | `step-index-changes`; the replay SHALL visit every produced step and report no runtime or console failure |

For every `text-present` entry, the selected element's text SHALL equal the normative text, and the same element SHALL show different text on another step observed during the replay, so a persistent list of every title or caption cannot confirm it. The harness SHALL collect page and console failures during replay the same way the deterministic probes do. A replay whose first action does not open the demo route SHALL be refused before it reaches the browser, and the overturn SHALL be recorded as rejected with that reason. A replay outside the allowlist, or one whose observations do not satisfy the allowlist check, SHALL be run and recorded with its allowlist refusal, and the source audit SHALL decide the overturn. A replay that does not exercise the failing situation, or skips the behavior the failure names, SHALL NOT be confirmed by the audit. For a target whose entry requires a clean replay, a runtime or console failure during the replay SHALL reject the overturn whether or not the replay is admitted.

The hard gates use these replay rules:

| Gate | Replay requirement |
| --- | --- |
| `verification-build-whole-app` | No replay for terminal install or build failure; use the terminal log and source audit. |
| `verification-sample-outline` | No gate-level verifier. A failed input recorded by the browser requires replay; a fallback-judged failed input does not. |
| `verification-every-produced-step-renders` | Replay required for an overturn of its browser-recorded runtime or console failure. |
| `verification-clear-outcome` | No replay; its failure comes from verification output, not a browser probe. |

The harness SHALL keep the candidate server running through product judging, including evaluator-only rescore. A missing, malformed, or refused replay, or a replay whose candidate page produced contrary evidence (for example a click target that was not found, an observation that does not match, or a runtime failure), SHALL reject the overturn with a reason, leaving the raw fail standing. A harness fault during replay, such as no available browser driver, a browser adapter or Chrome failure, or an invalid replay result, is not evidence about the candidate: it SHALL leave the second opinion pending and resumable, following the missing-judge-output path, and SHALL NOT be recorded as a lasting rejection. Terminal serve overturns also require the terminal log and source audit, not replay. The recorded replay actions, expectation, observations, trace, and pass result SHALL be kept with the raw and second-opinion verdicts in the result and report.

The standard for establishing the requirement SHALL be at least the standard a fallback judge's `pass` must meet. Showing only that the probe was unsound, without positive source evidence that the requirement is met, SHALL NOT be accepted as an overturn.

When the recorded runtime evidence supports the failure, for example a page error raised during the failing step, an overturn SHALL be accepted only when it explains that evidence as a measurement fault and the audit confirms the explanation. Otherwise the failure stands.

An overturn that fails any acceptance condition SHALL be recorded as a rejected overturn with the reason. The failure SHALL then stand as `fail`. Rejection SHALL NOT be treated as missing judge output.

Overturn citations SHALL use this path-and-line shape. Existing fallback-judge citations SHALL remain path-only and SHALL be unchanged.
An overturn SHALL cite at most 12 source spans, each fewer than 200 lines, and a terminal overturn at most 6 log or artifact spans. All cited spans together SHALL fit the existing bounded source-audit packet; an overturn that exceeds any limit SHALL be rejected. Each overturn SHALL receive exactly one source audit. An audit classification other than confirmed SHALL reject the overturn, with no further verifier or audit cycle. A malformed audit output SHALL be retried within the verifier's retry budget, and SHALL then be treated as missing judge output.

#### Scenario: An overturn with valid, confirmed citations is accepted
- **WHEN** the verifier overturns a `demo-supported-navigation` fail, explaining that the probe sent only touch events while the candidate handles swipes with pointer events
- **AND** it cites the source lines of the pointer-event swipe handler
- **AND** the spans are valid and the source audit confirms them
- **AND** a real-browser replay demonstrates the passing navigation
- **THEN** the overturn is accepted and the criterion's final verdict is `pass`

#### Scenario: Source looks right but the browser does not advance
- **WHEN** a verifier cites a plausible navigation handler and the span audit confirms it
- **AND** the proposed replay leaves the presentation on its original step
- **THEN** the overturn is rejected, with the replay observations recorded beside the raw failure

#### Scenario: Browser replay is missing
- **WHEN** a browser-derived failure has valid source spans but no valid replay
- **THEN** the overturn is rejected with a replay reason and the failure remains `fail`

#### Scenario: A trivial replay cannot confirm a navigation failure
- **WHEN** the verifier proposes, for a failed keyboard navigation, a replay that only opens the demo and expects the first step, or one that clicks a control or swipes instead of pressing a key
- **THEN** the harness runs the replay, records that the allowlist did not admit it, and sends the overturn to the source audit
- **AND** the audit does not confirm it, because the replay does not exercise keyboard navigation, so the failure remains `fail`

#### Scenario: A replay outside the allowlist is confirmed by the audit
- **WHEN** a browser-derived failure has no allowlist entry for its recorded failure, and the verifier's replay opens the demo route, exercises the failing input, and passes in a real browser
- **AND** the source audit confirms that the cited spans and the replay observations show the requirement met in the failing situation
- **THEN** the failure is overturned, recorded as confirmed by an audited browser replay with its allowlist refusal

#### Scenario: A replay that does not open the demo route
- **WHEN** a verifier's replay starts by navigating anywhere other than the demo route
- **THEN** the harness refuses it without running it, and the failure stands

#### Scenario: A renders-gate replay meets a runtime error
- **WHEN** the verifier proposes a replay for a failed `verification-every-produced-step-renders` that steps through every produced step
- **AND** the page raises a runtime or console error during the replay
- **THEN** the overturn is rejected and the gate remains failed

#### Scenario: The browser fails during replay
- **WHEN** no browser driver is available, or the browser adapter or Chrome fails while a replay runs
- **THEN** the second opinion is left pending and resumable with the fault as its reason, and is not recorded as a rejected overturn

#### Scenario: An overturn without citations is rejected
- **WHEN** the verifier answers `overturn` but cites no source span
- **THEN** the overturn is rejected
- **AND** the criterion's final verdict remains `fail`

#### Scenario: A cited span is outside the verified delivery
- **WHEN** an overturn cites a path that is not in the verified source inventory, or a line range beyond the end of the file, alongside valid spans
- **THEN** that citation is dropped and recorded with its reason, and the overturn is judged on its valid spans

#### Scenario: No cited span is valid
- **WHEN** every span an overturn cites is outside the verified source inventory or has an invalid line range
- **THEN** the overturn is rejected with that reason
- **AND** the failure stands

#### Scenario: The audit does not confirm the overturn
- **WHEN** an overturn's spans are valid but the source audit does not confirm that they establish the requirement
- **THEN** the overturn is rejected
- **AND** the failure stands

#### Scenario: An overturn shows only that the probe was unsound
- **WHEN** the verifier explains why the probe's reading was unreliable but cites no source establishing that the requirement is met
- **THEN** the overturn is rejected
- **AND** the failure stands

#### Scenario: Runtime evidence supports the failure
- **WHEN** a criterion failed while the page raised an error during the failing step
- **AND** the verifier's overturn cites source but does not explain that error as a measurement fault
- **THEN** the overturn is rejected
- **AND** the failure stands

#### Scenario: An overturn cites too much
- **WHEN** an overturn cites 13 source spans, or a span of 200 lines or more
- **THEN** the overturn is rejected
- **AND** the failure stands

#### Scenario: A source handler exists but was not active during the probe
- **WHEN** an overturn cites a swipe handler that exists in source, but the failing probe record shows a page error during the swipe that the overturn does not account for
- **THEN** the audit does not confirm the overturn
- **AND** the failure stands

#### Scenario: The verifier upholds
- **WHEN** the verifier answers `uphold`
- **THEN** the failure stands as `fail`
- **AND** no citation is required

#### Scenario: Two verifier samples review a failure
- **WHEN** a failure receives a second opinion
- **THEN** two independent verifier samples answer, both are recorded, and each proposed overturn is tried in turn until one is confirmed
- **AND** the failure stands when no sample's overturn is confirmed

#### Scenario: A real-browser replay decides a browser-derived overturn
- **WHEN** a sample's admitted replay observes the passing behavior in a real browser and its source spans validate
- **THEN** the failure is overturned without a further model audit

#### Scenario: The record does not show why a browser probe failed
- **WHEN** a browser-derived failure's record shows no measurement fault but the source establishes the behavior
- **THEN** the verifier overturns with a suspected fault and proposes a replay instead of upholding
- **AND** the span audit may accept the replay's observation of the passing behavior as the explanation of the failure

#### Scenario: A control count includes previous and next controls
- **WHEN** `quality-captions-and-navigation` fails because the counted navigation controls differ from the step count
- **THEN** a replay that clicks through every produced step with the presentation's own controls may confirm the overturn

#### Scenario: The wrong control is reported as current
- **WHEN** `demo-control-semantics` fails because a step marks the wrong control as current
- **THEN** a replay that ends on that step with a visible `aria-current` control labelled with that step's title or number, and shows the current control changing with the active step, may confirm the overturn

### Requirement: Second-opinion verdict
Each failure that received a second opinion SHALL carry two verdicts: the raw verdict, which is always `fail`, and the second-opinion verdict. The second-opinion verdict SHALL be `pass` when an overturn was accepted, and `fail` otherwise. Scores, component floors, hard gates, and automated eligibility SHALL use the second-opinion verdict. A failure that received no second opinion SHALL be scored from its verdict as before.

An accepted overturn of a deterministic criterion SHALL award that criterion the same points its owner's `pass` would award. An accepted overturn of `verification-every-produced-step-renders` or `verification-clear-outcome` SHALL make that gate `pass`. An overturn SHALL never make an unobserved criterion or gate observed, and SHALL never change a verdict that was not `fail`.

#### Scenario: An overturned criterion is scored
- **WHEN** a deterministic criterion's raw verdict is `fail` and its overturn is accepted
- **THEN** the scorer awards it the points its `pass` carries
- **AND** the result keeps the raw `fail` beside the second-opinion `pass`

#### Scenario: An upheld gate blocks eligibility
- **WHEN** a failed hard gate is upheld
- **THEN** automated eligibility fails as it would without a second opinion

#### Scenario: An overturned gate no longer blocks eligibility
- **WHEN** `verification-every-produced-step-renders` failed and its overturn is accepted
- **THEN** the gate is `pass` for automated eligibility and the official pass contract
- **AND** the result keeps the gate's raw `fail`

### Requirement: Terminal build and serve failure contract
When verification or candidate-server management establishes a product-owned inability to install, build, or serve the frozen final candidate, the harness SHALL obtain the second opinion before recording a conclusive product failure. The verifier SHALL receive the failed gate's requirement and source, the recorded build or serve log and other harness artifacts for the failure, and read access to the frozen candidate source.

An overturn of a terminal failure SHALL be accepted only when all of these hold:

1. it cites exact lines of the recorded build or serve log, or another recorded harness artifact, that show the measurement fault;
2. it gives a checkable explanation of the fault, such as a wrong invocation, an infrastructure outage, or a process-launch error;
3. it cites candidate source spans showing what the harness should have run, such as the candidate's declared install, build, or start script and its configuration;
4. every log, artifact, and source span is valid against the recorded artifact or the verified delivery, and the audit, shown the cited spans and the recorded failure reason and stage, confirms the explanation.

The recorded install and build evidence SHALL be the complete command output, kept losslessly up to a bounded size per stream. Beyond that bound, the beginning and the end SHALL be kept with an explicit omission marker, and the evidence SHALL record that it was truncated. A bounded summary log alone SHALL NOT be the evidence the verifier and audit are given.

An upheld terminal failure SHALL proceed to the conclusive product-failure outcome as before. An accepted overturn SHALL NOT produce a pass: because no built and served application exists to score, the evaluation SHALL end as a resumable evaluation-harness failure that records the overturn. An overturn that fails acceptance SHALL be recorded as rejected, and the conclusive product failure SHALL stand.

#### Scenario: A build failure is upheld
- **WHEN** the candidate's build fails on a type error in its own source and the verifier upholds
- **THEN** the build gate fails and the run records the conclusive product failure

#### Scenario: A harness fault caused the build failure
- **WHEN** the recorded build log shows the harness invoked a build command the candidate does not declare
- **AND** the verifier's overturn cites those log lines and the candidate's declared build script, and the audit confirms them
- **THEN** the run ends as a resumable evaluation-harness failure
- **AND** no product verdict and no score is recorded

#### Scenario: The decisive log line follows long output
- **WHEN** a build fails and the line showing a harness fault appears after more than 4,000 characters of standard output
- **THEN** the verifier and the audit are given that line in the recorded build evidence
- **AND** an overturn citing it can be accepted

#### Scenario: A terminal overturn cites no log
- **WHEN** the verifier overturns a serve failure while citing only candidate source
- **THEN** the overturn is rejected
- **AND** the conclusive product failure stands

### Requirement: Verifier failure handling
A verifier call that produces no well-formed `uphold` or `overturn` answer within its retry budget SHALL be treated as missing required judge output. The evaluation SHALL take the existing resumable evaluation-harness failure path. The harness SHALL NOT uphold or overturn the failure silently, and SHALL NOT score it from the raw verdict as if it had been checked.

#### Scenario: The verifier never answers validly
- **WHEN** every attempt of a verifier call returns malformed output
- **THEN** `evaluation_status` is `evaluation-harness-failed` and the failed phase is resumable
- **AND** no product verdict is issued from the unchecked failure
