## ADDED Requirements

### Requirement: Verification command
A single command (`npm run verify:presentations`) SHALL discover every presentation in the project and run all presentation checks. It SHALL exit unsuccessfully if any check fails, and report results per presentation and per check.

#### Scenario: All presentations pass
- **WHEN** every discovered presentation passes every check
- **THEN** the command reports each as passed and exits successfully

#### Scenario: One presentation fails
- **WHEN** one of three presentations fails a check
- **THEN** the command exits unsuccessfully, naming that presentation and the failed check, and still reports the other two

#### Scenario: New presentation is picked up
- **WHEN** a presentation is added to the presentations directory
- **THEN** the next run checks it without any change to the command or its configuration

### Requirement: Build check
The command SHALL run the project's production build before the other checks, SHALL fail and report the build errors if the build fails, and SHALL run the browser checks against the built output.

#### Scenario: Build fails
- **WHEN** the project's build fails
- **THEN** the command exits unsuccessfully, reports the build as the failed check with its errors, and does not run the browser checks

#### Scenario: Build passes
- **WHEN** the build succeeds
- **THEN** the build is reported as passed and the remaining checks run against the built output

### Requirement: Data validation
The command SHALL validate each presentation against the scene kit's validity rules and report every problem with the presentation, step and element involved. This SHALL cover duplicate ids, missing captions, references to nonexistent elements, references to invalid element kinds, cyclic or multi-parent group containment, unsupported types or positions, unintended overlap, positions outside the canvas, and the density caps.

#### Scenario: Problems are all reported
- **WHEN** a presentation has a duplicate id and an overlap in step 3
- **THEN** both problems are reported in one run, each with its step and elements

### Requirement: Browser rendering checks
The command SHALL load each presentation in a real browser at 360×640, 768×1024, 1280×800 and 1280×400, and step through every step in both Present and Browse modes. At each step it SHALL check: no console errors or uncaught page errors; no horizontal page scroll and the diagram within the viewport; rendered labels at least 12px at 360×640 and not clipped or colliding; the caption absent in Present mode and visible in Browse mode.

#### Scenario: Healthy presentation
- **WHEN** a valid presentation is checked
- **THEN** every step passes at every viewport in both modes

#### Scenario: Small label detected
- **WHEN** a label would render below 12px at 360×640
- **THEN** the check fails and names the presentation, step, viewport and label

#### Scenario: Caption leaking into Present
- **WHEN** the caption is visible in Present mode
- **THEN** the check fails

### Requirement: Scene correctness checks
For each step the command SHALL check that what is actually drawn matches the elements, labels, positions and connections the presentation defines for that step: the visible text, the on-screen geometry of each element, and the endpoints of each connector, not only metadata attached to the page. It SHALL reach steps by forward navigation, backward navigation, an outline jump and a direct-link reload, and SHALL require the scene for a given step to be identical every way. With motion enabled, it SHALL also check that an element moved by a step is seen at an intermediate position during the transition and at the correct position afterwards.

#### Scenario: Wrong scene detected
- **WHEN** the viewer updates the caption but leaves the previous diagram showing
- **THEN** the check fails for that step

#### Scenario: Stale geometry detected
- **WHEN** an element's metadata is correct but it is drawn at its previous position
- **THEN** the check fails and names the element, step, expected position and observed position

#### Scenario: Teleporting element detected
- **WHEN** a moved element jumps straight to its final position with motion enabled
- **THEN** the check fails for that step

#### Scenario: History-dependent scene detected
- **WHEN** step 4 looks different after going back from step 5 than after loading the link
- **THEN** the check fails and names the two paths

### Requirement: Snapshot drift check
In a project that contains the skill's template snapshot (the canonical-source role), the command SHALL run the template snapshot check, and SHALL fail and name the differing, missing or extra files when the snapshot and the canonical sources differ or the snapshot is missing. In any other project (a consumer project) the command SHALL report the snapshot check as not applicable rather than skipping it silently.

#### Scenario: Drift fails verification
- **WHEN** a canonical kit file changes without a snapshot update in a canonical-source project
- **THEN** the verification command fails naming that file

#### Scenario: Consumer project
- **WHEN** the command runs in a bootstrapped project that has no template snapshot
- **THEN** the snapshot check is reported as not applicable and does not fail the run

### Requirement: Failure details and evidence
Each failure SHALL identify the presentation, check, step, viewport and mode, and what was observed against what was expected. For browser failures the command SHALL save a screenshot of the failing state in a git-ignored output directory.

#### Scenario: Screenshot saved
- **WHEN** a browser check fails at step 3 on a 360×640 viewport
- **THEN** the failure message includes the path to a saved screenshot of that state, and the file is not tracked by git

### Requirement: Browser unavailable
If the verification browser is not installed or cannot start, the command SHALL fail with a clear message and the install command. It SHALL NOT skip the browser checks or pass.

#### Scenario: No browser
- **WHEN** the browser is not installed
- **THEN** the command exits unsuccessfully, saying the browser is missing and how to install it

### Requirement: Detects known defects
The verification SHALL be tested against deliberately broken presentations and against deliberately faulty viewers, each of which MUST fail the matching check, and these fixtures SHALL NOT be discovered as normal presentations.

#### Scenario: Broken presentations fail
- **WHEN** the verification tests run over presentations with an overlap, a missing caption, a duplicate id, or an invalid reference
- **THEN** each one fails the check intended to catch it

#### Scenario: Faulty viewers fail
- **WHEN** the verification tests run a healthy presentation against a viewer deliberately made faulty (a stale or history-dependent scene, a smaller label font, or a caption shown in Present mode)
- **THEN** each fault fails the check intended to catch it

#### Scenario: Fixtures excluded from normal runs
- **WHEN** the verification command runs normally
- **THEN** the broken fixtures are not checked or reported

### Requirement: Mandatory validator gate
The validator SHALL run the verification command as a mandatory check alongside build, lint and typecheck, and a verification failure SHALL fail the validator run.

#### Scenario: Validator fails on a bad presentation
- **WHEN** a presentation fails verification
- **THEN** the validator run fails, even though build, lint and typecheck pass

#### Scenario: Existing checks unchanged
- **WHEN** the validator runs on a valid project
- **THEN** build, lint and typecheck still run and pass as before

### Requirement: Sample is verified
The sample presentation SHALL be discovered and checked like any other presentation.

#### Scenario: Sample passes
- **WHEN** the verification command runs in this repository
- **THEN** the sample is reported as passed
