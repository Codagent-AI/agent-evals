## ADDED Requirements

### Requirement: Collecting the brief
Before building, the skill SHALL establish the presentation's subject, its look, and what each step says and shows. For anything the invoking prompt leaves out, the skill SHALL ask the user, one question per turn, instead of inventing an answer the user could still give. To settle the look, the skill SHALL offer a short list of style directions derived from the host project's existing stylesheets, or three neutral starting directions when the project has none, and let the user pick one or describe their own. After each batch of step answers, the skill SHALL offer a "build now" checkpoint; when the user takes it, steps not yet described SHALL be drafted as placeholders whose narration is marked `TODO`, the skill SHALL build without demanding a complete brief, and the user MAY refine the result afterwards through the editing flow. When the prompt already supplies the subject, the look, and every step, the skill MAY build without asking anything. The skill MAY sketch a complex or pivotal step in ASCII to confirm its layout, but SHALL NOT do so for every step.

#### Scenario: Missing details are asked for
- **WHEN** a user starts the skill naming only a subject, with no look and no steps described
- **THEN** the skill asks one question per turn about the look and then about each step before building

#### Scenario: Look chosen from derived directions
- **WHEN** the project already has stylesheets and the user has not described a look
- **THEN** the skill offers style directions derived from those stylesheets and builds with the one the user picks

#### Scenario: Build-now checkpoint
- **WHEN** the user takes the "build now" checkpoint after describing three of six planned steps
- **THEN** the skill builds a presentation with the three described steps and three placeholder steps marked `TODO`
- **AND** the user can then change any step through the editing flow

#### Scenario: Complete prompt
- **WHEN** the prompt already gives the subject, the look, and every step
- **THEN** the skill may build without asking questions

#### Scenario: ASCII sketch for a pivotal step
- **WHEN** a step's layout is complex or pivotal
- **THEN** the skill may show an ASCII sketch of that step and ask the user to confirm it before building

### Requirement: Project readiness
Before creating or editing a presentation, the skill SHALL make sure the project has everything a generated presentation needs, SHALL decide where missing pieces belong, and SHALL add whatever is missing, including the dependencies those pieces need. Three pieces are required:

1. **Build tooling**: a Vite, React, and TypeScript app whose `npm run build` produces a static bundle that serves the presentations.
2. **Scene runtime**: the reusable engine, independent of any topic, that defines the step contract, renders the current step and drives entity continuity, handles modes and navigation, renders narration, progress, and the chapter outline, and fits the canvas.
3. **Presentation manifest**: `src/presentations.json`, a hand-edited list giving each presentation's slug, title, and entry module, from which the app derives one route per presentation so any number of presentations coexist.

The skill SHALL decide whether each piece is present by probing what it can do, not by comparing files with a template: the build tooling is present when `package.json` has a `build` script that runs Vite; the runtime is present when its `Presentation` export resolves; the manifest is present when it parses as a list of entries. File names, formatting, and extra dependencies therefore never cause a piece to be added again. The skill SHALL NOT assume any dependency is already installed: when it adds a piece it installs React, ReactDOM, Motion, lucide-react, Vite with its React plugin, TypeScript with the React and Node type packages, the ESLint configuration, and Puppeteer for browser checks. What it adds SHALL build without Tailwind or any other styling framework and SHALL define no default colors, fonts, spacing scale, card or button styles, borders, shadows, theme, or theme tokens; authors or hosts MAY add a styling system later. All bootstrap templates SHALL be embedded in a single script, `skills/presentation/bootstrap.mjs`, so adding pieces needs no template lookup, and the skill SHALL run that script through the absolute path of its own skill directory, never a path relative to the user's working directory.

#### Scenario: Nothing present
- **WHEN** the target directory is empty, or none of the three pieces can be found in it
- **THEN** it adds the build tooling, the scene runtime, and the presentation manifest, installs the full dependency set, and only then creates the presentation

#### Scenario: Everything present
- **WHEN** all three pieces are present
- **THEN** the skill adds nothing and goes straight to creating or editing the presentation

#### Scenario: Some pieces present
- **WHEN** the build tooling is present but the scene runtime and manifest are not
- **THEN** the skill adds only the runtime and the manifest, with their dependencies, and leaves the existing build tooling unchanged

#### Scenario: Cosmetic differences are ignored
- **WHEN** an existing runtime lives under a different file name and uses different formatting from the template but its `Presentation` export resolves
- **THEN** the skill treats the runtime as present and does not overwrite it

#### Scenario: No style system is imposed
- **WHEN** the skill adds the build tooling and runtime
- **THEN** the resulting app builds with no styling framework installed and contains no default colors, fonts, spacing scale, card or button styles, borders, shadows, or theme tokens

#### Scenario: Working directory does not matter
- **WHEN** the user invokes the skill from a directory other than the project root or the skill directory
- **THEN** the skill still runs `bootstrap.mjs` from its own skill directory and writes into the resolved project

### Requirement: Scaffold placement
The skill SHALL choose where to add missing pieces as follows. In an empty or standalone project it SHALL use the repository root. In a monorepo it SHALL create a self-contained app in a `presentations/` directory rather than changing the monorepo root. In a non-empty project that lacks the scene runtime or the manifest, the skill SHALL first show the user a plan naming the target directory and every file it would create or change, and SHALL write nothing until the user approves that plan.

#### Scenario: Standalone project
- **WHEN** the project is empty or is not a monorepo
- **THEN** the pieces are added at the repository root

#### Scenario: Monorepo
- **WHEN** the project is a monorepo
- **THEN** the pieces are added as a self-contained app under `presentations/` and the monorepo root files are unchanged

#### Scenario: Plan approval in a non-empty project
- **WHEN** a non-empty project lacks the scene runtime or the manifest
- **THEN** the skill shows the target directory and file list and writes nothing before the user approves
- **AND** if the user rejects the plan, no file is written

### Requirement: Creating a presentation
The skill SHALL put each new presentation in its own directory `src/presentations/<slug>/` with an entry module, add exactly one manifest entry for it, and make it reachable at `/<slug>` alongside every other presentation. A presentation's designed look SHALL live in a CSS Module inside its own directory or in host-owned stylesheets, never in the scene runtime. Plain CSS SHALL be the default unless the host already uses a styling framework or the user asks for one. Creating a presentation SHALL leave every existing presentation's files and manifest entry untouched and still reachable.

#### Scenario: New presentation gets its own route
- **WHEN** the skill creates presentation `pipelines`
- **THEN** `src/presentations/pipelines/` exists, the manifest has one new entry for `pipelines`, and `/pipelines` serves it

#### Scenario: Look stays with the presentation
- **WHEN** a new presentation is given a designed look
- **THEN** that styling is in the presentation's CSS Module or host stylesheets and the runtime is unchanged
- **AND** it is plain CSS unless the host already uses a styling framework or the user asked for one

#### Scenario: Existing presentations survive
- **WHEN** two presentations already exist and the skill creates a third
- **THEN** both existing presentations keep their files and manifest entries and still load at their routes

### Requirement: Editing a presentation
The skill SHALL support changing an existing presentation's steps, entities, or look. When the request does not clearly identify which presentation to change, the skill SHALL list the presentations in the manifest and ask which one before changing anything. Once the target is known, the skill SHALL ask only about the requested change and edit that presentation without repeating the full creation flow.

#### Scenario: Unclear target
- **WHEN** the user asks to change "the presentation" and the manifest lists three
- **THEN** the skill lists all three and asks which to change, writing nothing before the answer

#### Scenario: Focused edit
- **WHEN** the target is known and the user asks to recolor step 2
- **THEN** the skill asks only about that change and edits only that presentation

### Requirement: Checks before declaring done
After creating or editing a presentation, and before telling the user it is done, the skill SHALL run three checks and SHALL fix any failure itself and rerun the checks; it SHALL NOT report success while any check fails.

1. **Build**: `tsc --noEmit` followed by `vite build`, both exiting with status 0.
2. **First-step render**: opening the presentation's route renders its first step with no runtime error and no console error.
3. **Visual composition review**: the skill reviews captures of every step at 1440 × 900 and of the first, last, and two densest steps at 390 × 844. The capture command flags any entity whose box extends beyond the canvas or intersects a chrome region (narration panel, progress bar, outline, navigation buttons); the skill confirms that important content fits, that deliberate overlaps stay legible, and that nothing collides with chrome by accident.

For captures the skill SHALL use the project's own `npm run capture` command when it exists; otherwise any temporary browser helper it writes SHALL live under the project root. Every warning from the capture command SHALL be recorded in the presentation's `review-log.md` with its resolution: accidental collisions and indistinct current-step chrome SHALL be fixed, and a warning MAY be accepted, with a written reason, only for an overlap that is deliberate and legible and whose subtree carries `data-overlap-ok`.

Every presentation the skill generates SHALL: build without compile or type errors; render its first step without runtime or console errors; show narration for each step; offer next-step and previous-step navigation; follow the single-diagram model of stable entities moving through named steps; and style its outline, progress, navigation, and attribution chrome in presentation-owned or host CSS so the current step is clearly distinguishable and the attribution is legible, while the scene runtime itself keeps no colors, typefaces, borders, button looks, or theme tokens of its own.

#### Scenario: Checks precede completion
- **WHEN** the skill finishes writing a new or edited presentation
- **THEN** it runs the build, the first-step render, and the visual composition review before telling the user it is done

#### Scenario: A failing check is repaired
- **WHEN** any of the three checks fails
- **THEN** the skill fixes the cause and reruns the checks, and does not report success until all pass

#### Scenario: Composition flags are resolved
- **WHEN** the capture command flags an entity crossing the progress bar
- **THEN** the skill makes the layout acceptable

#### Scenario: Deliberate overlap is accepted with a reason
- **WHEN** the capture command flags two labels that the author stacked on purpose and both remain legible
- **THEN** the skill marks their subtree with `data-overlap-ok` and records the reason in `review-log.md`

#### Scenario: Generated presentation meets the bar
- **WHEN** the skill reports a presentation as done
- **THEN** `tsc --noEmit` and `vite build` exit 0, its route renders step 1 with no runtime or console errors, every step shows narration, next and previous navigation work, and the current step is visibly distinct in its chrome
