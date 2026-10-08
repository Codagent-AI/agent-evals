## ADDED Requirements

### Requirement: Self-contained skill package
The presentation skill SHALL include everything it needs to set up a project, including the scene kit,
the app template, and the verification harness, so that it works in a project with no access to this
repository.

#### Scenario: Skill used outside this repository
- **WHEN** an agent uses the skill in an empty directory on a machine without this repository
- **THEN** the skill sets up a working app and presentation using only its own bundled assets and
  installed dependencies

### Requirement: Authoring workflow
Given a topic, and optionally an audience and a target directory that defaults to the current directory,
the skill SHALL produce a step outline, detect the target project, set it up subject to the confirmation
rules, author and register the presentation, run its self-check, review screenshots, and report the
outcome.

#### Scenario: Topic becomes a registered presentation
- **WHEN** the skill is asked to explain a topic in a project it can set up
- **THEN** the project contains a presentation on that topic, registered in the presentation index and
  reachable at its own route, and the skill reports how to open it

### Requirement: Read-only project detection
Before writing anything, the skill SHALL classify the target directory without modifying it as empty
(containing nothing other than `.git`), a compatible app (a Vite, React 18 or 19, and TypeScript app), a
monorepo (declaring workspaces, for example through `package.json` workspaces, `pnpm-workspace.yaml`, or
Lerna, Nx, or Turbo configuration), or a standalone project otherwise. React projects on other
toolchains SHALL be treated as having no compatible app. The skill SHALL also detect whether the build
setup, scene kit, and presentation index are present by the contracts they expose rather than by exact
file contents.

#### Scenario: Detection does not write
- **WHEN** the skill detects a target directory
- **THEN** no file in the target directory is created, modified, or deleted by detection

#### Scenario: Next.js project
- **WHEN** the target is a standalone Next.js project
- **THEN** the skill classifies it as a standalone project without a compatible app

#### Scenario: Directory containing only .git
- **WHEN** the target directory contains only a `.git` directory
- **THEN** the skill classifies it as empty

### Requirement: Setup by project type
The skill SHALL set up the target as follows: in an empty directory, scaffold a full Vite, React, and
TypeScript app at its root; in a compatible app, add only the missing pieces and serve presentations from
their own page without changing the app's existing router or routes; in a monorepo, scaffold a
self-contained app in a `presentations/` directory, regardless of whether the monorepo contains a
compatible app; and in a standalone project, scaffold at the project root, merging into existing
configuration files rather than replacing them. Dependencies SHALL be installed with the package manager
indicated by the project's lockfile, defaulting to npm. Setup SHALL add ignore entries for screenshot and
presentation build output to the target's `.gitignore`, creating it if absent and keeping its existing
lines.

#### Scenario: Empty directory
- **WHEN** the target directory is empty
- **THEN** the skill scaffolds a Vite, React, and TypeScript app at its root and the presentation opens at
  its own route

#### Scenario: Compatible app
- **WHEN** the target is a compatible app without the scene kit or presentation index
- **THEN** the skill adds the scene kit, the presentation index, and a separate presentation page, and
  the app's existing pages and routes behave as before

#### Scenario: Monorepo with an existing compatible app
- **WHEN** the target is a monorepo that already contains a compatible app package
- **THEN** the skill plans a self-contained app in `presentations/` and leaves the existing packages
  unchanged

#### Scenario: Standalone project with an existing package manifest
- **WHEN** the target is a standalone project with an existing `package.json` and no compatible app
- **THEN** the skill scaffolds at the root, adding the required dependencies and scripts to the existing
  `package.json` while keeping its existing entries

#### Scenario: Package manager from lockfile
- **WHEN** the target project contains a `pnpm-lock.yaml` and no other lockfile
- **THEN** the skill installs dependencies with pnpm

#### Scenario: Existing ignore file is extended
- **WHEN** the target has a `.gitignore` with existing entries
- **THEN** after setup it contains its original lines plus entries for screenshot and presentation build
  output, and captured screenshots are not listed as untracked files

### Requirement: Incompatible dependencies block setup
Before writing anything, the skill SHALL compare the target's existing dependencies with the supported
ranges: `react` and `react-dom` 18 or 19, `vite` 6 to 8 with a matching `@vitejs/plugin-react` or
`@vitejs/plugin-react-swc`, and `@playwright/test` 1.x. Compatible existing dependencies SHALL be kept.
When any existing dependency falls outside its supported range, the skill SHALL report each incompatible
dependency with its found version and supported range, SHALL write nothing, and user confirmation SHALL
NOT override the block.

#### Scenario: React 17 project
- **WHEN** a standalone target's `package.json` declares `react` 17
- **THEN** the skill reports `react` 17 as incompatible with the supported range 18 or 19 and writes
  nothing

#### Scenario: Confirmation does not override a block
- **WHEN** the plan contains an incompatible dependency and the user confirms anyway
- **THEN** the skill still writes nothing and repeats the blocking report

#### Scenario: Mismatched Vite plugin
- **WHEN** the target declares a `vite` version and a `@vitejs/plugin-react` version that does not
  support it
- **THEN** the skill reports the mismatch as a blocker and writes nothing

#### Scenario: Compatible existing dependencies are kept
- **WHEN** the target already declares `react` 18 and `@playwright/test` 1.55
- **THEN** the plan keeps those versions and adds only missing dependencies

### Requirement: Reuse of existing pieces
When detection finds the build setup, scene kit, or presentation index present, the skill SHALL reuse that
piece as it is, wherever it is located in the project, and scaffold only the missing pieces. Any
presentation page and its build configuration created by an earlier setup count as part of the build
setup. Cosmetic or outdated differences from the skill's bundled assets SHALL NOT cause reports,
replacement, or re-scaffolding. Files the skill generates SHALL reference the reused pieces at their
detected locations. When a reused scene kit does not implement the browser verification protocol, the
self-check SHALL report that specifically rather than as a presentation failure.

#### Scenario: Existing scene kit is reused
- **WHEN** the target already has a scene kit that exposes the expected contract but differs cosmetically
  from the bundled one
- **THEN** the skill uses it unchanged, does not report the difference, and authors the presentation
  against it

#### Scenario: Only the index is missing
- **WHEN** the target has the build setup and scene kit but no presentation index
- **THEN** the skill scaffolds only the presentation index and the wiring needed to reach it

#### Scenario: Scene kit at a non-standard location
- **WHEN** the target's scene kit is located somewhere other than the bundled default path
- **THEN** generated files import it from its detected location and the project builds

#### Scenario: Second run in a set-up project
- **WHEN** the skill is run again in a project it set up earlier
- **THEN** the plan reuses the existing page, build configuration, scene kit, and index, reports no
  collisions with them, and only creates or changes presentation files and the index registration

#### Scenario: Reused kit without the verification protocol
- **WHEN** a reused scene kit exposes the expected exports but does not publish the verification protocol
- **THEN** the self-check reports that the scene kit does not implement the verification protocol

### Requirement: Confirmation before writing in non-empty projects
In any non-empty target, before writing anything, including setup files, dependency installation, and
presentation files, the skill SHALL report the target location, the files it will create or change, the
dependency changes, any collisions with existing files, and the step outline, and SHALL wait for user
confirmation. In an empty directory, the skill SHALL report the same plan and proceed without waiting. The
skill SHALL never overwrite an existing file it does not intend to merge into; for each collision the plan
SHALL propose an alternative path or ask the user. Accepting an alternative path SHALL produce a revised
plan in which every generated reference uses the alternative, and that revised plan is what the user
confirms. When detection finds more than one possible target, the skill SHALL ask the user to choose
before planning.

#### Scenario: Non-empty project waits for confirmation
- **WHEN** the target is non-empty and the skill has reported its plan
- **THEN** no file is created or changed and no dependency is installed until the user confirms

#### Scenario: User declines
- **WHEN** the user declines the reported plan
- **THEN** the skill writes nothing to the target

#### Scenario: Empty directory proceeds
- **WHEN** the target directory is empty
- **THEN** the skill reports its plan and proceeds without waiting for confirmation

#### Scenario: Collision with an existing file
- **WHEN** the scaffold would create a file at a path that already exists and is not a mergeable
  configuration file
- **THEN** the plan lists the collision and proposes an alternative path or asks the user, and the
  existing file is not overwritten

#### Scenario: Alternative path is accepted
- **WHEN** the user accepts an alternative path for a colliding presentation page
- **THEN** the skill reports a revised plan using that path, and after confirmation the generated scripts
  and configuration build and verify the page at the alternative path

#### Scenario: Ambiguous target
- **WHEN** the target contains several candidate locations and detection cannot determine one
- **THEN** the skill asks the user to choose a target before reporting a plan

### Requirement: Presentation authoring
The skill SHALL reuse scene components already present in the project and add new scene components only
when no existing component fits. It SHALL group consecutive steps that are successive states of the same
diagram into a scene group, give entities that persist across steps the same stable ids, and register the
presentation in the index. Modifying an existing presentation SHALL follow the same rules and self-check.

#### Scenario: Persisting entity keeps its id
- **WHEN** the skill authors a presentation in which an entity remains on screen across consecutive steps
- **THEN** that entity has the same id in each of those steps

#### Scenario: Modifying an existing presentation
- **WHEN** the skill is asked to change an existing presentation
- **THEN** it edits that presentation, keeps it registered, and runs its self-check against it

### Requirement: Self-check
After authoring or modifying a presentation, the skill SHALL run the structure check, build the project,
and run the browser check against that presentation. When a check fails, the skill SHALL fix the problem
and re-run the checks, up to three fix attempts. The skill SHALL NOT report success while any check is
failing; if checks still fail after the attempts, it SHALL report the failure with the failing output.
A missing browser SHALL be reported as a provisioning problem distinct from a presentation failure, and the
skill SHALL install a browser only after user confirmation.

#### Scenario: All checks pass
- **WHEN** the structure check, build, and browser check all pass
- **THEN** the skill reports the self-check as passing

#### Scenario: Failure is fixed
- **WHEN** the browser check fails because a step renders no diagram and the skill's fix makes it pass
- **THEN** the skill re-runs all checks and reports success only after they pass

#### Scenario: Persistent failure
- **WHEN** a check still fails after three fix attempts
- **THEN** the skill reports the failure with the failing output and does not report success

#### Scenario: No browser available
- **WHEN** no matching browser is available for the browser check
- **THEN** the skill reports a provisioning problem, asks before installing a browser, and does not report
  the presentation as failing or passing

### Requirement: Screenshot review
After the self-check passes, the skill SHALL capture and review screenshots of the first step, the last
step, and any dense or key steps at a desktop viewport in both modes, adding a phone-width viewport when
the presentation is sensitive to screen size. It SHALL fix overlapping, crowded, clipped, or off-screen
content it finds, re-run the self-check after any fix, and report any visual issues it could not fix.

#### Scenario: Overlap is fixed
- **WHEN** a reviewed screenshot shows two labels overlapping
- **THEN** the skill adjusts the presentation, re-runs the self-check, and re-reviews the affected step

#### Scenario: Narrow viewport for a size-sensitive presentation
- **WHEN** a presentation has dense steps or long labels that may not fit narrow screens
- **THEN** the review includes phone-width screenshots of the selected steps

#### Scenario: Unfixed visual issue
- **WHEN** the skill cannot resolve a visual issue it found
- **THEN** the final report describes the issue and the affected step

### Requirement: Outcome report
On completion, the skill SHALL report how to open the presentation (its route and the command to run the
app), the files created or changed, the self-check result, where the reviewed screenshots are, and any
unresolved visual issues.

#### Scenario: Successful run
- **WHEN** the skill finishes with all checks passing
- **THEN** the report includes the presentation's route, the run command, the changed files, the passing
  self-check result, and the screenshot location

### Requirement: Self-describing sample presentation
This repository SHALL include a sample presentation, produced with the skill, that explains how to use the
skill: giving it a topic, project detection and confirmed setup, authoring steps with scene components and
scene groups, the self-check, screenshot review, and presenting versus browsing. The sample SHALL be
registered in the presentation index, pass the structure check, and pass the repository verify command.

#### Scenario: Sample is available
- **WHEN** the repository app is opened at the presentation index
- **THEN** the sample is listed and opens at its own route

#### Scenario: Sample covers the workflow
- **WHEN** a viewer steps through the sample
- **THEN** its steps cover giving the skill a topic, detection and confirmed setup, authoring with scene
  components and scene groups, the self-check, screenshot review, and presenting versus browsing
