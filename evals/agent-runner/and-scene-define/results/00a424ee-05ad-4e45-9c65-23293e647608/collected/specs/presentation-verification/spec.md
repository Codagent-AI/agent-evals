## ADDED Requirements

### Requirement: Repository verify command
The repository SHALL provide a verify command that type-checks and builds the whole app, serves its
production preview,
and drives a real browser through every step of the committed sample presentation in both present and
browse modes at a desktop viewport and a phone viewport. The command SHALL succeed only when every check
passes and SHALL otherwise exit unsuccessfully, reporting each failure with its step, mode, viewport, and
message.

#### Scenario: Sample passes
- **WHEN** the verify command is run and the sample builds and passes every check
- **THEN** the command exits successfully

#### Scenario: Build failure
- **WHEN** the app fails to build
- **THEN** the verify command exits unsuccessfully and reports the build failure without running the
  browser check

#### Scenario: Type error fails verification
- **WHEN** a presentation's step data does not conform to its scene's data type
- **THEN** the verify command reports the type error and exits unsuccessfully without running the browser
  check

#### Scenario: Failure is located
- **WHEN** step 4 of the sample fails a check in present mode at the phone viewport
- **THEN** the command exits unsuccessfully and its report identifies step 4, present mode, the phone
  viewport, and the failed check

### Requirement: Error gate
The browser check SHALL fail when the page logs a console error, throws an uncaught error, or has an
unhandled promise rejection at any point while it is loading or stepping through the presentation.
Console warnings SHALL NOT cause failure.

#### Scenario: Console error fails the check
- **WHEN** rendering step 3 logs a console error
- **THEN** the browser check fails and reports the error message with step 3

#### Scenario: Uncaught error fails the check
- **WHEN** navigating to step 5 throws an uncaught error
- **THEN** the browser check fails and reports the error with step 5

#### Scenario: Warning does not fail the check
- **WHEN** the page logs only console warnings
- **THEN** the browser check does not fail because of them

### Requirement: Functional gate
For every step in each mode, the browser check SHALL verify that the step marker shows the step number and
total, that the step's title is displayed, and that the diagram renders at least one entity. It SHALL
verify that next and previous navigation move to the expected adjacent steps and that switching modes
keeps the current step. Visual appearance and layout quality SHALL NOT be pass/fail criteria.

#### Scenario: Blank diagram fails
- **WHEN** step 2 renders no diagram entities
- **THEN** the browser check fails and reports that step 2 rendered no diagram

#### Scenario: Wrong step after navigation
- **WHEN** moving next from step 3 displays step 3 again or any step other than step 4
- **THEN** the browser check fails and reports the navigation failure at step 3

#### Scenario: Mode switch loses the step
- **WHEN** switching from browse to present mode at step 6 displays a different step
- **THEN** the browser check fails and reports the mode-switch failure at step 6

#### Scenario: Wrong marker or title
- **WHEN** step 5 of 8 is displayed with a marker other than "5 / 8" or without step 5's title
- **THEN** the browser check fails and reports the mismatch at step 5

### Requirement: Skill self-check target
The verification harness SHALL let the skill type-check and build the project it set up and run the same
error and functional gates against one named presentation in that project, on the page where the project
serves presentations, including a separate presentation page with its own build configuration. When the
page does not publish the verification protocol of the scene kit, the harness SHALL report that the scene
kit does not implement the verification protocol, distinctly from step failures.

#### Scenario: Self-check targets the authored presentation
- **WHEN** the skill runs the self-check for the presentation it just created in a project that contains
  other presentations
- **THEN** the browser check steps through only that presentation and reports results for it

#### Scenario: Separate presentation page
- **WHEN** the self-check runs in a compatible app whose presentations are served from a separate page with
  its own build configuration
- **THEN** the harness builds, previews, and checks that page rather than the host app's main page

#### Scenario: Missing verification protocol
- **WHEN** the checked page does not publish the scene kit's verification protocol
- **THEN** the harness exits unsuccessfully and reports that the scene kit does not implement the
  verification protocol

### Requirement: Browser preflight
Before running a browser check or capturing screenshots, the harness SHALL verify that a browser matching
the pinned Playwright version is available. When none is available it SHALL stop with a provisioning error
that is reported and exit-coded distinctly from a presentation failure.

#### Scenario: Missing browser
- **WHEN** the verify command is run on a machine without a matching browser
- **THEN** it stops before building or browsing completes, reports a provisioning error naming the missing
  browser, and exits with the provisioning exit status rather than the presentation-failure status

### Requirement: Screenshot helper
The harness SHALL provide a screenshot helper that captures each step of a presentation at a standard
desktop viewport of 1440 × 900 in both modes by default, and accepts optional selections of steps, a single
mode, and a phone viewport of 390 × 844. Screenshots SHALL be written to a git-ignored directory with file
names identifying the presentation, step, mode, and viewport. The helper SHALL NOT pass or fail based on
appearance and SHALL fail only when capturing itself fails.

#### Scenario: Default capture
- **WHEN** the screenshot helper is run for an 8-step presentation with no selection
- **THEN** it writes 16 screenshots, one per step per mode, at 1440 × 900

#### Scenario: Selected capture
- **WHEN** the helper is run for steps 1 and 8 in browse mode at the phone viewport
- **THEN** it writes exactly those two screenshots at 390 × 844

#### Scenario: Screenshots are not committed
- **WHEN** screenshots have been captured
- **THEN** git status does not list them as untracked files

### Requirement: Unit test gate
The repository's unit test command, run by the validator, SHALL fail when any registered presentation
fails the structure check, when this repository's installed scene kit differs from the skill's canonical
assets, or when detection or setup planning produces an unexpected result for any setup case. These tests
SHALL NOT install dependencies or require a browser.

#### Scenario: Invalid registered presentation
- **WHEN** a registered presentation has a step with an empty caption
- **THEN** the unit test command fails and identifies the presentation and step

#### Scenario: Installed kit drift
- **WHEN** a file in this repository's installed scene kit differs from its canonical counterpart in the
  skill's assets
- **THEN** the unit test command fails and names the differing file

#### Scenario: Setup planning per case
- **WHEN** the unit tests run detection and setup planning against empty, compatible-app, monorepo, and
  standalone fixture directories
- **THEN** each produces the expected classification and planned changes without writing to the fixtures

### Requirement: Fresh bootstrap test
The repository SHALL provide a separate end-to-end test command, outside the validator, that uses the
skill's setup to scaffold an app in an empty temporary directory, installs its dependencies, builds it, and
runs the browser check against the generated presentation.

#### Scenario: Fresh app works
- **WHEN** the bootstrap test is run with network access and a matching browser available
- **THEN** it scaffolds, installs, builds, and passes the browser check in the temporary directory, then
  reports success

#### Scenario: Bootstrap failure is reported
- **WHEN** the scaffolded app fails to build
- **THEN** the bootstrap test fails and reports the build output
