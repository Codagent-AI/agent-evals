## Why

Explanations of systems, workflows, and processes land best as a single diagram that builds up step by
step: elements appear, move, connect, and get relabeled while a caption narrates each change. Existing
frameworks support incremental animation — reveal.js has fragments and auto-animate across slides,
Slidev has click-triggered motion, Motion Canvas and Manim animate diagrams for video — but none offers
what this project needs together: a typed React scene model with stable element identity across steps,
a viewer with distinct present and browse modes, and an authoring workflow an agent can run and verify in
any project. Adapting a slide framework would mean fighting its page model and its own runtime and
toolchain for every presentation; a small scene kit built on the React and `motion` stack this repository
already uses fits better.

Agents are increasingly asked to produce explanatory material, but they have no repeatable, verified way
to produce this kind of presentation. Without a shared scene kit and an automated check, every attempt
re-invents rendering, and broken output (build failures, runtime errors, a blank or stuck diagram) is only
discovered by a human. A reusable agent skill that turns a topic into a browser-based evolving-diagram
presentation, sets up whatever project it lands in, and verifies that what it generated builds and
renders makes this repeatable for anyone using the repository or the skill elsewhere.

## What Changes

- Add an agent skill package at `skills/presentation/` containing:
  - `SKILL.md` describing the workflow: topic → step outline → project detection → confirmed setup →
    presentation definition → self-check → screenshot review;
  - reference documentation for the presentation definition format and the scene kit's component
    catalog;
  - assets: the canonical scene kit, a bundled Vite + React + TypeScript app template, and the
    verification harness;
  - scripts for project detection, setup, and verification.
- Project setup that adapts to the target directory:
  - detection is read-only and checks three pieces at the contract level: a compatible build setup
    (Vite + React 18/19 + TypeScript), the scene kit, and the presentation index;
  - pieces that are present are reused as they are; cosmetic or outdated differences do not trigger
    reports or re-scaffolding; only missing pieces are scaffolded;
  - empty directory → scaffold a full Vite + React + TypeScript app from the bundled template;
  - compatible Vite + React + TypeScript app → add only the missing pieces, hosting presentations on
    their own page (a separate Vite entry) so the host app's router and URL are untouched;
  - non-empty project without a compatible app (including React projects on other toolchains such as
    Next.js) → in a monorepo, scaffold a self-contained app in a `presentations/` directory; in a
    standalone project, scaffold at the project root;
  - in any non-empty directory, before writing anything — setup files, dependency installation, or
    presentation files — the skill reports the target location, the files it will create or change, the
    dependency changes, and any collisions with existing files, then waits for user confirmation;
  - existing files are never silently overwritten; when detection cannot determine a target (for
    example, several candidate packages), the skill asks the user to choose one;
  - dependencies are installed with the project's package manager, inferred from its lockfile, defaulting
    to npm; existing dependencies outside the supported ranges block setup, which writes nothing even if
    the user confirms;
  - setup adds screenshot and presentation build output to the target's `.gitignore`.
- A scene kit: a presentation is an ordered list of steps. Each step has a one-line title, a longer
  caption, and defines the full diagram shown while it is active, composed from reusable scene
  components rendered with that step's typed data. Adjacent steps that are successive states of the same
  diagram can share a scene group, so the scene persists and only the step's data changes. The kit
  provides primitives (nodes, connectors, labels, regions, lucide-react icons, symbol chips, and an
  emphasis primitive), and authors can use raw `motion` elements with stable ids when no primitive fits.
  Entities keep stable ids, so entities present in consecutive steps morph in place (move, resize,
  relabel, reconnect), new ones animate in, and departing ones animate out, within and across scene
  groups.
- A presentation index: every presentation is registered in the index and reachable at its own route.
- A presentation viewer with two modes that preserve the current step when toggled:
  - **Present mode** shows only the diagram, a step marker, and the one-line step title; caption, table
    of contents, and prev/next controls are hidden. Navigation is by keyboard, click/tap, and swipe.
  - **Browse mode** shows the title, the longer caption, a table of contents on wide screens, prev/next
    controls, and progress indicators.
  - The layout adapts to phone, tablet, and desktop viewports.
- A sample presentation, produced with the skill, that explains how to use the skill. This repository's
  app serves the presentation index in place of the scaffold placeholder, with the sample at its own
  route.
- Automated verification:
  - unit tests, including a structural check of presentations (unique entity ids within a step, valid
    connector references, primitives within the drawing area, non-empty one-line title and caption on
    every step) and tests of project detection and planned
    setup changes for every setup branch, without installing dependencies;
  - one end-to-end test that bootstraps a fresh app in an empty temporary directory, installs
    dependencies, builds it, and runs the browser check against the generated presentation;
  - a repository verify command that type-checks and builds the whole app, serves the production preview, and drives a
    real browser through every step of the committed sample in both modes. It fails on any console error
    or uncaught page error and on functional failures: each step must show the expected step marker and
    title and render its diagram, prev/next navigation must move between steps, and toggling modes must
    preserve the current step;
  - a skill self-check that type-checks and builds the project it set up and runs the same browser check against
    whatever presentation the skill just generated or modified;
  - a separate screenshot helper that captures each step at a standard desktop viewport, with optional
    step, mode, and phone-width selection, used for visual review rather than as a pass/fail gate. The
    skill reviews the first, last, and dense or key steps, adding a phone width when the presentation is
    sensitive to screen size.

## Capabilities

### New Capabilities
- `presentation-skill`: the skill package, its authoring workflow, read-only contract-level project
  detection, confirmed setup (scaffold missing pieces, reuse present ones, never silently overwrite), and
  the self-describing sample presentation.
- `scene-presentation`: the step-based diagram definition format, the reusable scene components of the
  scene kit, animated transitions between steps, the presentation index, and structural validation of
  definitions.
- `presentation-viewer`: per-presentation routes, present and browse modes, step navigation, mode
  toggling that preserves the step, responsive layout, URL-addressable step state, and reduced-motion
  behavior.
- `presentation-verification`: the repository verify command, the skill self-check, their functional and
  error gates, browser preflight, and the screenshot helper for visual review.

### Modified Capabilities
- None. The repository has no existing specifications.

## Technical Approach

- **Scene components with typed step data.** Each step defines its full diagram by rendering a scene
  component with that step's typed data; adjacent steps can share a scene group so the scene persists
  and only the data changes. Steps are not expressed as changes from the previous step, so any step can
  be opened directly and shows the same diagram as when reached in sequence. Scene components compose
  the kit's primitives and, when needed, raw `motion` elements. Entities keep stable ids across steps and
  scene groups, so the player animates continuity (enter, move, reconnect, relabel, exit) using
  `motion`, which the project already depends on and which supports React 18 and 19. Typed step data
  lets the build catch data that does not match its scene, and the structure check covers what types
  cannot.
- **Explicit grid coordinates, no auto-layout.** Authors place entities on a fixed coordinate grid in an
  SVG `viewBox` that scales to the viewport. Auto-layout engines (dagre, ELK) would reshuffle elements as
  the diagram grows, breaking the "one evolving diagram" model. Layout quality is assured by screenshot
  review rather than by automated geometry gates.
- **Contract-level detection and reuse.** Setup recognizes the build setup, scene kit, and presentation
  index by the contracts they expose rather than by exact file contents or a version marker, reuses
  whatever is present unchanged, and scaffolds only what is missing. This keeps the skill non-invasive in
  projects that have already adopted or adapted the kit.
- **Single canonical source, dogfooded.** The scene kit and verification harness live once under
  `skills/presentation/assets/`. This repository installs its copy (`src/presentation/`) through the
  skill's own setup script, as another project would. A repository test fails if this repository's
  installed copy drifts from the canonical assets, so the committed sample exercises the code the skill
  ships; this repository-level guard is separate from the skill's reuse behavior in other projects.
- **Bundled app template.** Scaffolding copies a template shipped with the skill rather than invoking
  `npm create vite`, keeping output deterministic and independent of upstream template changes.
  Dependency installation still requires network access.
- **Viewer state.** The URL identifies the presentation, the current step, and the mode, so links, the
  browser check, and screenshots can target a specific step. Because presentations live on their own
  page, this state does not compete with a host app's router. Because present mode hides all controls,
  the mode toggle is reachable by keyboard shortcut and by activating the step marker, so it works on
  touch devices. Transitions are disabled when the user prefers reduced motion.
- **Verification tooling.** Add Vitest for unit tests and `@playwright/test` pinned to 1.61.0, matching
  the browser build installed in this environment. Before running, the browser check verifies that a
  matching browser is available; when one is not, it reports a provisioning failure distinct from a
  presentation failure, and the skill installs a matching browser only after user confirmation. The
  Playwright version and browser build are updated together. Unit, integration, and
  fixture-based browser tests are added to `.validator/config.yml`, using the locally installed browser
  without network access; the sample verify command and the fresh bootstrap test stay npm scripts run by
  the skill workflow and during acceptance. Screenshots are written to a git-ignored
  directory.
- **Check coverage.** The canonical scene kit is linted and typechecked through its matching installed
  copy in `src/`; the setup and verification scripts receive lint and typecheck coverage appropriate to
  their Node runtime; the bundled template is checked as a generated application by the end-to-end
  bootstrap test. Exact ESLint and TypeScript project configuration is left to design.

## Out of Scope

- Export to PDF, PPTX, or video.
- Automatic diagram layout.
- Speaker notes, presenter view, multi-screen presenting, or remote control.
- Installing into React apps on toolchains other than Vite; those projects get a self-contained app
  instead.
- Wiring presentations into an existing app's router; presentations are served from their own page.
- Version tracking, migration, or upgrade of a previously installed scene kit, build setup, or index.
- Pass/fail gating on visual or responsive layout quality; that remains screenshot-based review.
- End-to-end install-and-build tests for every setup branch; branches other than the empty-directory
  bootstrap are covered by detection and planning tests.
- Per-presentation custom rendering outside the shared scene kit.
- Hosting, publishing, or deployment of presentations.
- Frameworks other than React for the scene kit.

## Impact

- **New:** `skills/presentation/` (skill, references, assets, scripts), `src/presentation/` (installed
  scene kit), `src/presentations/` (presentation index and sample presentation), unit, end-to-end, and
  bootstrap test files.
- **Modified:** `src/App.tsx` (serves the presentation index instead of the placeholder), `package.json`
  and `package-lock.json` (Vitest, Playwright, test and verify scripts), `.gitignore` (screenshot and test
  output), `.validator/config.yml` (unit, integration, and browser test checks), lint and TypeScript configuration
  (coverage of skill scripts and tests, `strict` mode for the app), `README.md` (skill and verification usage).
- **Dependencies:** the scene kit uses `lucide-react`, already a dependency of this repository; new dev
  dependencies on Vitest and `@playwright/test` 1.61.0; the Playwright version is coupled to the
  available browser build. Projects set up by the skill gain `react`, `react-dom`, `motion`,
  `lucide-react`, and the same verification dev dependencies where missing.
- **Risks:** agent-authored layouts may overlap or crowd at small viewports (mitigated by screenshot
  review); scaffolding, dependency installation, and browser provisioning require network access;
  contract-level reuse means an adapted or outdated scene kit in another project is used as-is; the
  end-to-end bootstrap test is slow and network-dependent; root scaffolding in a standalone non-empty
  project must merge with existing configuration without overwriting it.
