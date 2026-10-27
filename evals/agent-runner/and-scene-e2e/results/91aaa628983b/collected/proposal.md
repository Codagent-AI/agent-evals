## Why

Explaining how a system or process works over time is poorly served by slide decks. Each slide redraws
the picture, so the audience has to work out what moved, appeared, or changed meaning between slides.
A single diagram that evolves through a sequence of steps keeps the audience oriented: elements appear,
move, connect, and get relabeled in place, so the change itself is the explanation.

Agents asked to "make a presentation" today produce slide decks or static diagrams. There is no
repeatable way for an agent to turn a topic into an evolving-diagram presentation that is known to
build, render, and fit different screen sizes. Without shared scene components and automated checks, each
generation would reinvent layout and animation, and layout defects (colliding or clipped labels,
off-canvas elements, broken references between steps) would only be found by a human opening the page.

## What Changes

- Add an agent skill at `skills/presentation/SKILL.md` that turns a topic into a browser-based
  presentation: one diagram with persistent elements and an ordered sequence of steps, each step with its
  own caption.
- Add a canonical **scene kit** under `src/`: reusable React components and a typed presentation data
  model for elements, connectors, labels, steps, and the viewer. Elements have stable ids so `motion`
  can animate them appearing, moving, connecting, and being relabeled between steps. A small, fixed set
  of primitives is supported at first, each with defined dimensions, label-wrapping rules, and connector
  behavior.
- Add a viewer with two modes. **Present** mode shows only the diagram, with step navigation and no
  caption. **Browse** mode adds the current step's caption and a step outline for jumping to any step.
  The scene scales to different screen sizes under an explicit readability policy (a supported minimum
  viewport and a minimum rendered label size), not merely "fits without overflow".
- Give the skill its own **template snapshot** so it can bootstrap a project that has no scene kit,
  without depending on this repository. The snapshot is portable end to end: it contains the scene kit,
  the presentation host and discovery, the verification harness, and the scripts, and the skill installs
  the required dependencies. The initial supported target is a Vite + React + TypeScript project. The
  snapshot must stay in sync with the canonical sources, and drift is detected automatically.
- Have the skill verify what it generates: validate the presentation data, run typecheck, lint, and
  build, and render the result in a real browser at multiple viewport sizes.
- Add a **sample presentation** that explains how to use the skill, authored with the skill itself.
- Add an automated **verification command** that discovers every presentation and checks it, plus unit
  tests for the validation and scene-resolution logic.
- Make the verification command a **mandatory check in the validator** (`.validator/config.yml`),
  alongside build, lint, and typecheck.
- Turn the `App` shell into a host that serves the sample and future presentations (selected by URL).
  In a bootstrapped project, whose app is the user's own, the skill instead wraps the app in a
  presentation gate in the project's entry file: a URL with a `presentation` parameter shows the host
  and any other URL shows the project's own app.

## Capabilities

### New Capabilities
- `presentation-authoring-skill`: how the skill turns a topic into a presentation, bootstraps the
  portable snapshot into a project that lacks the scene kit, and verifies its own output before
  reporting success.
- `presentation-scene-kit`: the presentation data model, the deterministic step-to-scene resolution,
  the reusable scene components, and the viewer (step navigation, Present and Browse modes, responsive
  scaling with a readability policy), plus the template-snapshot synchronization rule.
- `presentation-verification`: automated checks for presentations (data validation, build, and
  multi-viewport browser rendering), the command that runs them, its enforcement in the validator, and
  its behavior when the browser environment is unavailable.

### Modified Capabilities
- None. No specifications exist yet.

## Technical Approach

- **Data model and resolution.** A presentation is a typed TypeScript module: a set of elements with
  stable ids, and an ordered list of steps. Each step carries a caption and the state of each element it
  changes (visibility, position, label, connections). Persistent ids are what make the presentation one
  evolving diagram rather than separate slides. A pure, deterministic resolver turns any step into the
  complete scene for that step, independent of navigation history, so forward and backward navigation,
  outline jumps, and direct-link reloads all show the same scene for the same step.
- **Rendering.** SVG scaled through a `viewBox`, animated with `motion` (already a dependency). Elements
  are placed at named grid or anchor positions rather than raw coordinates, because agents place raw
  coordinates unreliably. Named positions reduce authoring mistakes but do not by themselves guarantee a
  readable layout, so the supported primitives have defined sizes and label-wrapping rules, and
  correctness is checked by validation rather than assumed (see Verification). The proposal makes no
  claim of general diagram-layout correctness.
- **Overlap policy.** Not every overlap is a defect. Intentional containment (an element declared inside
  a container or group) and connector crossings are valid. Invalid are unintended overlap between element
  bodies, colliding text labels, text that overflows or is clipped by its element, and elements outside
  the canvas. The specification will define these classes precisely.
- **Readability policy.** The supported minimum viewport is 360×640 CSS pixels and the minimum rendered
  label size is 12px, so fitting the scene to a small screen cannot silently shrink text below legible.
  The diagram fits both the available width and height (including wide, short windows), and the
  viewer is insulated from the styles of the project's own app. Scenes stay under a density limit that
  makes this achievable, with breakpoint layouts where needed. In
  Browse mode the caption, outline, and controls must remain usable alongside the stage. Because Present
  mode has no caption, the diagram's own labels must carry the meaning on their own.
- **Viewer.** Previous/next controls, keyboard and touch navigation, and the current step reflected in
  the URL so a step can be linked and reloaded. Present mode renders the stage only; Browse mode adds
  the caption and step outline.
- **Skill layout and portability.** `skills/presentation/SKILL.md` plus a template snapshot inside the
  skill directory. The snapshot contains the scene kit, host and discovery, verification harness,
  scripts, and configuration needed to run verification. The skill checks whether the target project has
  the kit; if not, it installs the snapshot and the required dependencies (`react`, `motion`, and the
  verification tooling) before generating. The first supported target is Vite + React + TypeScript. The
  bootstrap path is itself exercised in a scratch project with no access to this repository's source
  tree.
- **Canonical source and sync.** The kit and harness under `src/` and the repository scripts are
  canonical. A sync script copies them into the skill's template snapshot and has a check mode that
  fails when the two differ; the check runs as part of verification.
- **Verification.** Vitest covers pure logic: presentation data validation (unique ids, steps reference
  existing elements, every step captioned), geometry checks under the overlap policy, the scene
  resolver (same step resolves to the same scene regardless of history), and the snapshot drift check.
  Playwright (new dev dependency) loads each presentation at several viewport sizes including 360×640,
  steps through every step in both modes, and asserts: no console errors, the diagram fits the viewport
  without overflow, rendered labels meet the minimum size and are not clipped or colliding, the caption
  is absent in Present mode and present in Browse mode, and each step shows its expected elements,
  labels, positions, and connections. It also exercises backward navigation, an outline jump, and a
  direct-link reload. One command, expected to be `npm run verify:presentations`, runs the project
  build first and then these checks over every presentation it discovers, against the built output; the
  skill runs the same command on what it generates.
- **Enforcement and environment.** The verification command is added to `.validator/config.yml` as a
  mandatory check, in addition to the existing build, lint, and typecheck checks, which must keep
  passing. If Chromium is unavailable, verification fails with a clear message and an install hint
  rather than skipping. The validator and CI environments are responsible for provisioning the browser
  (for example `npx playwright install` with system dependencies). TypeScript project configuration is
  extended so the new test, harness, and configuration files are type-checked.

## Out of Scope

- A graphical authoring or editing tool for presentations.
- Export to PDF, PPTX, video, or image sequences.
- Theming and branding systems beyond what the scene kit needs to render legibly.
- Presenter notes, speaker view, remote control, or multi-screen presenting.
- Slide-deck style presentations (independent slides); the model is a single evolving diagram only.
- Hosting or publishing presentations.
- General-purpose diagram layout (automatic graph layout, arbitrary shapes, freeform drawing) beyond
  the fixed set of supported primitives.
- Bootstrap targets other than Vite + React + TypeScript projects.

## Impact

- **New:** `skills/presentation/` (skill and template snapshot), scene kit, host, and viewer under
  `src/`, the sample presentation, the sync script, the verification command and its Vitest and
  Playwright configuration.
- **Changed:** `src/App.tsx` becomes a presentation host (in a bootstrapped project, `src/main.tsx`
  gains the presentation gate instead and the project's own app is untouched); `package.json` gains scripts and the dev
  dependencies Vitest and Playwright (with a browser download for Playwright); `.validator/config.yml`
  gains the mandatory verification check; TypeScript project configuration covers the new files;
  `AGENTS.md` and `README.md` document the new commands.
- **Existing checks:** `npm run build`, `npm run lint`, and `npx tsc -b --noEmit` must keep passing with
  the new code.
- **Environment:** every validator and CI run now needs a provisioned Chromium, so runs are slower and
  depend on environment setup.
- **Users:** agents running the skill, and people viewing generated presentations.
- **Assumptions to confirm:** the sample lives alongside other presentations under `src/`; the 360×640
  minimum viewport and 12px minimum label size are the initial readability thresholds.
