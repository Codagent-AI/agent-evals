## ADDED Requirements

### Requirement: Release-check command
The project SHALL expose one documented command, `npm run release-check`, that runs every automated check in order: a build of the entire app, including the root redirect, the manifest, and every listed presentation; the sample conformance check; and the browser render pass. The command SHALL fail when the build reports any compile, type, or bundling error in any of those parts.

#### Scenario: Build errors fail the release check
- **WHEN** any presentation listed in the manifest contains a type error
- **THEN** `npm run release-check` fails at the build stage

#### Scenario: Clean app passes the build stage
- **WHEN** the app and every listed presentation compile without errors
- **THEN** the release check proceeds to the sample conformance check

### Requirement: Bundled sample
The repository SHALL include a sample presentation, titled "How to Use This Skill to Make a Presentation", that teaches how to use the skill to make a presentation and ends by revealing that the viewer is watching the skill's own output. The sample SHALL be produced by running the `presentation` skill on the sample brief after the skill exists; the committed sample files are that run's output, and the brief and the skill's completion report SHALL be committed beside them as evidence. Later changes to the sample SHALL go through the skill's editing flow rather than being written by hand. The sample SHALL be listed in the manifest like any other presentation and the app root `/` SHALL redirect to it.

The sample is a single accumulating scene: a conversation row between **you** and **skill** sits at the top, a tray of step cards fills in beneath it, and later steps draw links and a closing reveal frame around content already on screen. Nothing already drawn is rearranged or redrawn. The steps, in order, are below; chapters, headlines, and bodies are normative, while exact shapes, coordinates, colors, and timing are settled in design.

| # | Chapter | Headline (present) | Body (browse) | What appears |
|---|---------|--------------------|---------------|--------------|
| 1 | the ask | "You have a topic" | It starts with you, a topic, and mild overconfidence. | A **you** entity with a **prompt** bubble. |
| 2 | the ask | "The skill interviews you" | One question at a time: the topic, the look, then each beat of the story. | A **skill** node joins; a two-way arrow links you and skill, topped by a **question chip**. |
| 3 | the gathering | "Answers become steps" | Each answer lands as a step card — title, caption, visual — plus what morphs from one step into the next. | A tray opens beneath the conversation and the first **step-card** drops in, showing title, caption, and visual; what morphs is drawn on the link between neighbouring cards. |
| 4 | the gathering | "The deck grows" | Same shapes, new beats. Every answer extends the story without redrawing it. | Further step-cards drop into the tray; earlier content does not move. |
| 5 | the gathering | "You set the depth" | Spell out every step, or sketch a few and see how it looks. You hold the gate. | A dashed **ghost card** stands for undescribed steps; a partial/full control attaches to **you**. |
| 6 | the build | "It assembles the scene" | Your steps are wired into one evolving scene, drawn with a shared scene kit — ready-made boxes, arrows, and motion that make entities morph. | A **scene-kit** socket connects to the lower edge of the tray (the tray gets no frame); its label names the shared kit. |
| 7 | the build | "It checks its own work" | Before saying done, it builds and renders every step — and fixes what breaks. | A **verify** node follows the step cards in the same tray row; build and render checks settle into a green pass mark on it. |
| 8 | the loop | "Changed your mind? Loop it." | Point at a step and ask. The skill edits the scene in place — nothing is redrawn from scratch. | A **modify** arc runs from the conversation down into the route and flags the edited card. |
| 9 | the reveal | "You're looking at one" | This presentation was built exactly this way. Thanks for watching. | A labelled outer frame closes around the entire diagram as the reveal. |

The expected outline (chapters, headlines, and bodies in order) SHALL be stored in `scripts/release-check/sample-outline.json`. The sample conformance check SHALL load the sample's step metadata through its manifest entry and compare it with that file.

#### Scenario: Sample matches its outline
- **WHEN** the release check runs
- **THEN** it confirms the sample is listed in the manifest, its route loads, and its nine steps carry the expected chapters, headlines, and bodies in order

#### Scenario: Sample is missing
- **WHEN** the sample's directory or manifest entry is absent
- **THEN** the release check fails and its output names the missing sample

#### Scenario: Sample provenance is recorded
- **WHEN** a reviewer opens the sample directory
- **THEN** it contains the sample brief and the skill's completion report from the run that produced the committed files

### Requirement: Browser render pass
The release check SHALL build the production bundle, serve `dist/` from a small Node static server bound to `127.0.0.1`, wait for a readiness probe against `127.0.0.1`, and drive headless Chrome with Puppeteer to the sample route on `127.0.0.1`, so the result never depends on how `localhost` resolves. The driver SHALL read the number of steps from the `aria-valuemax` of the presentation's `role="progressbar"` element and the current step from its `aria-valuenow`, and SHALL advance with the keyboard through every step. A console error, an uncaught page exception, an error while rendering a step, or a key press after which `aria-valuenow` does not advance SHALL fail the pass and SHALL name the step at which it happened.

#### Scenario: Every step renders cleanly
- **WHEN** the render pass runs against the sample
- **THEN** it visits each of the nine steps in a real browser and records no runtime or console error

#### Scenario: Loopback address is fixed
- **WHEN** the render pass starts the static server and opens routes
- **THEN** the server address, the readiness probe, and every browser URL use `127.0.0.1`

#### Scenario: Browser error names the step
- **WHEN** the sample logs a console error or throws an uncaught exception on step 6
- **THEN** the render pass fails and reports step 6

#### Scenario: Stalled transition names the step
- **WHEN** pressing the forward key on step 3 leaves `aria-valuenow` at 3
- **THEN** the render pass fails and reports step 3

### Requirement: Outcome and cleanup
The release check SHALL end with a single summary line reading `PASS` or `FAIL` and SHALL exit with status 0 only when every check passed. It SHALL stop the static server and the browser it started at the end of every run, including runs that fail or are interrupted.

#### Scenario: Failure is unambiguous
- **WHEN** the render pass fails
- **THEN** the summary line reads `FAIL` and the process exits with a non-zero status

#### Scenario: Success is unambiguous
- **WHEN** every check passes
- **THEN** the summary line reads `PASS` and the process exits with status 0

#### Scenario: Processes are stopped after a failure
- **WHEN** a run fails during the render pass
- **THEN** no static server or browser process started by that run is still running after it exits

### Requirement: Step captures for review
A project prepared by the skill SHALL include `npm run capture -- <slug>`, which serves the production bundle and saves one image per step of the named presentation, at 1440 × 900, to `.captures/<slug>/<nn>-<step-id>.png`. Before each capture it SHALL wait until the stage root reports `data-settled="true"`, which the runtime sets once every transition of the current step has completed, so no image shows a transition midway. It SHALL print advisory warnings, each naming the step, for: visible text or chrome overlapping other visible text or chrome outside any subtree marked `data-overlap-ok`; a current progress segment or outline entry that looks the same as the others; and an attribution link that is missing, too small, or unstyled. The attribution warning SHALL point authors to the `attribution` slot. Captures and warnings support visual review only and SHALL NOT decide pass or fail.

#### Scenario: One capture per settled step
- **WHEN** `npm run capture -- sample` runs
- **THEN** nine images appear under `.captures/sample/`, each taken after the stage reported `data-settled="true"`

#### Scenario: Unmarked overlap is reported
- **WHEN** a headline overlaps the progress bar on step 2 and no `data-overlap-ok` marker applies
- **THEN** the command prints a warning naming step 2 and both elements

#### Scenario: Marked overlap is exempt
- **WHEN** two labels overlap inside a subtree marked `data-overlap-ok`
- **THEN** no overlap warning is printed for them

#### Scenario: Indistinct current chrome is reported
- **WHEN** the current progress segment is styled identically to the others
- **THEN** the command prints a warning naming that chrome

#### Scenario: Weak attribution is reported
- **WHEN** the attribution link is unstyled or smaller than legible size
- **THEN** the command prints a warning that points to the `attribution` slot

#### Scenario: Warnings never fail the command
- **WHEN** the capture command prints warnings
- **THEN** it still exits with status 0 and the warnings are treated as review input
