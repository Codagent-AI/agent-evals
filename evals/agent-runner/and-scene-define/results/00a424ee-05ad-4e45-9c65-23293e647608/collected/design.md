## Context

The repository is a minimal Vite 8, React 19, and TypeScript 6 scaffold (`src/App.tsx` renders a
placeholder) with `motion` 12 and `lucide-react` 1 already declared as dependencies. It has no test runner,
no test script, and no existing OpenSpec specifications. Validation runs through `.validator/config.yml`
(`npm run build`, `npm run lint`, `npx tsc -b --noEmit`). ESLint applies browser and React rules to every
`**/*.{ts,tsx}` file; TypeScript project references cover `src` (`tsconfig.app.json`) and only
`vite.config.ts` (`tsconfig.node.json`). Both TypeScript configs already set `erasableSyntaxOnly` and
`allowImportingTsExtensions`. The development environment runs Node 24 and has Playwright 1.61.0 browsers
(Chromium revision 1228) preinstalled at `/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`). Vitest 5.0.3
supports Vite 8.

This change adds an agent skill under `skills/presentation/` that turns a topic into an evolving-diagram
presentation, sets up the target project, and verifies its output. The specifications are
`specs/scene-presentation`, `specs/presentation-viewer`, `specs/presentation-skill`, and
`specs/presentation-verification`.

## Goals / Non-Goals

**Goals:**
- A scene kit where each step renders a scene component with typed data, entities with stable ids morph
  in place within and across scene groups, and a structure check validates presentations.
- A viewer with present and browse modes, hash routes, keyboard, swipe, and tap navigation, responsive
  layout, reduced motion, and accessible announcements.
- A self-contained skill package with read-only detection, a reviewable setup plan, guarded application,
  and bundled assets that work without this repository.
- A verification harness with an error and functional browser gate, distinct provisioning failures, and a
  screenshot helper; unit tests in the validator; a fresh-bootstrap end-to-end test.
- One canonical copy of the kit and harness, installed into this repository and guarded against drift.

**Non-Goals:**
- Automatic layout, exports, presenter tooling, deployment, and upgrades or migration of previously
  installed pieces (see proposal).
- Installing into non-Vite React toolchains; those receive a self-contained app.
- Automated visual or layout gating.

## Approach

### Repository and package layout

```
skills/presentation/
  SKILL.md                    workflow, confirmation and retry rules, commands, report format
  references/
    authoring.md              step outlining, scene groups, stable ids, grid layout, title/caption rules
    components.md             primitive and API catalog with examples
    setup.md                  detection classes, plan format, confirmation protocol
    verification.md           self-check commands, exit codes, screenshot review checklist
  assets/
    scene-kit/                → <app>/src/presentation/        (canonical kit)
    presentations-index/      → <app>/src/presentations/index.ts (empty registry)
    harness/                  → <app>/scripts/presentation/    (verify + screenshot scripts)
    app-template/             full Vite + React + TS app (empty directory, monorepo presentations/)
    page-entry/               separate page for existing projects: presentation.html,
                              vite.presentation.config.ts, tsconfig.presentation.json,
                              src/presentation-main.tsx
  scripts/
    detect.ts  plan.ts  apply.ts  lib/…

this repository:
  src/presentation/           installed kit (byte-identical to assets/scene-kit)
  src/presentations/index.ts  registry: export const presentations = [usingThePresentationSkill]
  src/presentations/using-the-presentation-skill/   sample (scenes.tsx, index.ts)
  scripts/presentation/       installed harness (byte-identical to assets/harness)
  src/App.tsx                 renders <PresentationApp presentations={presentations} />
  tests/bootstrap/run.ts      fresh bootstrap end-to-end test
  vitest.config.ts
```

The kit and harness are installed into this repository with the skill's own `apply.ts` using a plan
restricted to those pieces plus the index; `src/App.tsx` is wired by hand exactly as the app template's
`main.tsx` is.

### Scene kit

**Public contract.** `src/presentation/index.ts` exports `definePresentation`, `sceneGroup`,
`PresentationApp`, `checkPresentation`, and the primitives `Node`, `Connector`, `Label`, `Region`, `Icon`,
`Chip`, `Emphasis`, and `Custom`, plus the types `Presentation`, `SceneGroup`, `StepDef`, `Mode`, and
`Problem`. Detection treats a module exporting these names as the scene kit. The full operational contract,
documented in `references/components.md`, also includes the signatures below and the **verification
protocol** that `PresentationApp` publishes in the browser: hash routes as described under Viewer,
`window.__presentationManifest`, `data-mode` and `data-step` on the viewer root, `data-entity-id` on each
entity, and `data-animating` on the Stage. Detection stays name-based; signature mismatches surface in the
self-check's type check, and a missing protocol surfaces as a distinct harness error.

**Definitions.**

```ts
type Mode = 'present' | 'browse'
interface StepDef<D> { title: string; caption: string; data: D }
function sceneGroup<D>(scene: ComponentType<{ data: D }>, steps: StepDef<D>[]): SceneGroup
function definePresentation(p: {
  slug: string; title: string; summary?: string
  canvas: { width: number; height: number }
  defaultMode?: Mode
  groups: SceneGroup[]
}): Presentation
```

`sceneGroup` infers `D` from the scene's props, so a step whose `data` does not conform fails type
checking at that step's literal. `SceneGroup` is opaque after construction, so a presentation can mix
groups with different data types. Steps are flattened in group order and numbered from 1.

**Rendering model: primitives declare, the Stage draws.**

```
Viewer ──▶ Stage: one persistent <svg viewBox="0 0 W H" preserveAspectRatio="xMidYMid meet">
             │  entity registry: id → { kind, props, emphasized, owner token }
             │  draws every registered entity keyed by id inside <AnimatePresence initial={false}>
             └─ hidden scene slot: <Scene key={groupIndex} data={step.data} />
                   └─ primitives render no DOM; in a layout effect they register their descriptor
                      under their id (with a useId owner token) and unregister on unmount
```

- Within a scene group the scene element keeps its key, so it stays mounted and only `data` changes;
  primitives update their descriptors. Across groups scene A unmounts and scene B mounts in the same
  commit; registry updates are batched before paint, so an id present in both steps keeps the same Stage
  child and morphs instead of exiting and re-entering. Ids present only in the old step exit through
  `AnimatePresence`; new ids enter.
- Composite author components work naturally because registration goes through React context; only the
  primitives and `Custom` contribute visible output.
- Duplicate ids are detected when a second owner token registers an id already held by another owner.
  StrictMode's mount/unmount/mount cycle is handled by effect cleanup.
- `Custom` takes `id`, optional `bounds`, and children made of raw `motion` SVG elements. The Stage draws
  the children inside a persistent `<motion.g data-entity-id={id}>` wrapped in
  `<MotionConfig transition={kitTransition}>`, so children animate with the kit's timing (zero duration
  under reduced motion); because element identity persists, changes to the children's `animate` props
  between steps morph. Enter and exit animate the group's opacity. Children must not set their own
  `transition` or any `repeat`; the structure check walks the `Custom` children element tree (props only,
  without rendering) and reports any element whose props include `transition`, or `repeat` inside
  `animate`/`transition`. The raw motion elements themselves are always allowed.
- `Emphasis` provides a context flag; primitives inside it register `emphasized: true`, and the Stage draws
  a focus treatment (outline and glow) for that step only.

**Animation.**
- The Stage keeps a per-entity geometry record of motion values (`x`, `y`, `w`, `h`). When a descriptor's
  target changes, the Stage calls `animate(value, target, transition)`. Motion starts from the current
  on-screen value, so navigation during a transition always settles on the latest target.
- Connectors derive their path with `useTransform` from the live motion values of both endpoints and clip
  to each endpoint's box edge, so they stay attached while nodes move. Connectable kinds are node, region,
  label, icon, chip (text boxes use estimated extents), and `Custom` with `bounds`. Each connector keeps its
  own endpoint motion values; when `from` or `to` changes, those values animate from the old endpoint's
  current box to the new one, so the end slides instead of snapping. A new connector animates `pathLength`
  from 0 to 1.
- Geometry records of exiting entities are retained until their exit animation completes, so connectors
  exiting with them stay attached; records are released in `AnimatePresence`'s exit-complete callback.
- Label changes cross-fade: label text is keyed by its string inside a nested `AnimatePresence`.
- Enter is opacity 0→1 with scale 0.9→1; exit is opacity 1→0.
- Reduced motion: the kit reads `useReducedMotion()` and uses zero-duration transitions everywhere,
  including the `MotionConfig` default passed to custom children. `MotionConfig reducedMotion="user"` alone
  would still animate SVG attribute values and opacity.
- Settle signal: a fixed timer rather than animation counting. Every kit transition, enter, exit,
  cross-fade, and custom child uses the kit's fixed timing (one duration constant, no delays beyond a known
  maximum), so the longest possible animation is a known constant `SETTLE_MS`. On each step change the
  Stage sets `data-animating="true"` on its root and schedules it back to `"false"` `SETTLE_MS` later,
  restarting the timer on further navigation; under reduced motion it stays `"false"`. This is robust to
  interruptions and cancellations, which counting is not.
- Each entity's root element carries `data-entity-id`.

**Structure check.** `checkPresentation(presentation, registered?)` returns `Problem[]`
(`{ code, message, step?, entityId? }`).
- Definition-level checks: no steps, empty scene group, title empty, containing a line break, or longer
  than 60 characters, empty caption, and missing, invalid (`^[a-z0-9]+(-[a-z0-9]+)*$`), or duplicate slug
  across the registered list.
- Entity-level checks: for each step, render the step's scene with its data into a detached container with
  `createRoot` + `flushSync`, inside a collecting registry provider and an error boundary; unmount each
  root immediately after collecting. A scene that throws becomes a `scene-render-error` problem at that
  step with the error message, and checking continues with the next step. From the collected descriptors,
  report duplicate ids, connectors whose `from` or `to` is absent in that step, connectors whose endpoint
  is a `Custom` without `bounds`, custom children overriding transitions, and entities outside the
  canvas. Bounds come from geometry props; text extents for `Label` and `Chip` are estimated as
  `0.6 × fontSize × characters`; `Custom` is checked only when `bounds` is given. Any DOM left in the
  detached container after rendering means the scene rendered markup outside kit entities and is
  reported. `Custom` children are not rendered in the collection pass, so raw motion elements inside a
  custom entity never trigger this.
- Lifecycle: `checkPresentation` must never run during React render or commit, because `flushSync` cannot
  flush there. When a presentation opens, `PresentationApp` renders a pending state and, from an effect,
  schedules the check in a `setTimeout(0)` callback (outside React's lifecycle). Results are stored with
  the slug they belong to and ignored if the user has navigated to another presentation (stale-result
  guard); the effect's cleanup cancels the pending timeout. Results are cached per slug for the session.
  The viewer is rendered only after a check with no problems; otherwise the problem list is shown. This
  works unchanged under StrictMode's double effects because a cancelled timeout never starts a check and
  a completed one is cached. Unit tests call `checkPresentation` directly in jsdom (outside render).

### Viewer

- **Routing** (`routing.ts`, pure): `#/` shows the index; `#/<slug>` and `#/<slug>/<step>` with optional
  `?mode=present|browse` show a presentation. Unknown slugs show not-found with a link to `#/`. A missing
  or non-numeric step resolves to 1, an out-of-range step clamps to the nearest valid step, and the
  corrected URL is written with `history.replaceState`. Index links are ordinary hash links and create a
  history entry; step and mode changes always use `replaceState`. Mode resolution order: URL, then
  `defaultMode`, then `browse`. `document.title` is `"<step title> — <presentation title>"`.
- **Layout:** one CSS grid in which the Stage keeps the same position in the React tree for both modes, so
  toggling modes never remounts it or replays transitions. Present mode is a `100dvh` grid with a header
  row (step-marker button showing `i / N` and the title on one line with `text-overflow: ellipsis`) and
  the diagram filling the remaining space. Browse mode adds the caption region (below the diagram on
  narrow viewports, beside it on wide ones), prev/next buttons, a segmented progress indicator, a mode
  toggle, and, at `min-width: 1024px`, a table of contents. No region may cause horizontal overflow;
  `min-width: 0` is applied to grid children.
- **Input:** a window `keydown` handler for the navigation keys (Right Arrow, Down Arrow, Space, Page Down;
  Left Arrow, Up Arrow, Shift+Space, Page Up; Home, End), plus P (toggle) and Escape (present → browse).
  The handler ignores events with `ctrlKey`, `metaKey`, or `altKey`; ignores Space and Enter when the event
  target is a button, link, form field, or `contenteditable` element, leaving native activation to that
  control; ignores all keys in form fields and `contenteditable`; and calls `preventDefault()` only for
  keys it handles.
  Navigation is a pure reducer that clamps without wrapping. Swipe uses pointer events on the diagram: a
  horizontal travel of at least 50 px that exceeds vertical travel. In present mode, a pointer release
  with less than 10 px travel counts as a tap: x in the left third goes back, otherwise forward.
- **Accessibility:** controls are native buttons or links with accessible names; the Stage's `<svg>` has
  `role="img"` and `aria-label` set to the presentation title; an `aria-live="polite"` region announces
  the step title, plus the caption in browse mode.
- **Test hooks:** `PresentationApp` sets `window.__presentationManifest` to
  `[{ slug, title, steps: [{ title }] }]`. The viewer root exposes `data-mode` and `data-step`.

### Skill setup scripts

All scripts are TypeScript run directly by Node (type stripping, Node ≥ 22.18), invoked from the skill
directory with `--target <dir>`; they emit JSON on stdout and diagnostics on stderr. `SKILL.md` instructs
the agent to check `node --version` first and report an unsupported Node version.

- **`detect.ts`** (read-only) returns:
  - `classification`: `empty` (no entries other than `.git`), `compatible-app` (a `package.json` with
    `vite`, `react` and `react-dom` at 18 or 19, `typescript`, and `@vitejs/plugin-react` or
    `@vitejs/plugin-react-swc`, plus a Vite config file), `monorepo` (`package.json` `workspaces`,
    `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, or `turbo.json`), or `standalone`;
  - `candidates`: candidate target locations when more than one is plausible, for example several
    compatible packages under the target directory without a workspace root;
  - `pieces`: `buildSetup`, `sceneKit` (a module under `src/` exporting the contract names, matched by
    parsing its export statements), and `index` (a module exporting `presentations` that imports from the
    kit), each with the path found;
  - `packageManager`: from `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`/`bun.lockb`, or
    `package-lock.json`, defaulting to npm;
  - `wiring`: an existing presentation page (an HTML entry whose script imports the kit's
    `PresentationApp`), its Vite config and tsconfig, and `presentation:*` scripts, from an earlier setup;
    these count as part of the build setup;
  - `dependencies`: each relevant existing dependency with its declared range and a compatibility verdict
    against the supported ranges: `react`/`react-dom` 18–19, `vite` 6–8 with a `@vitejs/plugin-react` or
    `@vitejs/plugin-react-swc` major that declares support for that Vite major (a table bundled with the
    scripts), and `@playwright/test` 1.x.
- **`plan.ts`** turns detection output into a plan
  `{ targetDir, variant, paths, create[], merge[], dependencies, collisions[], blockers[],
  requiresConfirmation }`. It is a pure function of detection plus file-existence reads, with optional
  `--path <role>=<path>` overrides.
  - `paths` binds every role to a concrete location: `kit`, `index`, `page`, `viteConfig`, `tsconfig`,
    `harness`, and `presentationsDir`. Reused pieces bind to their detected locations; new pieces to the
    bundled defaults or overrides. Asset files are templates whose import specifiers and config entries
    are rendered from `paths` (relative imports computed per file), so nothing assumes the default layout.
  - `blockers` lists each incompatible dependency with its found range and the supported range. A plan
    with blockers is reported but can never be applied; `apply.ts` exits with a blocker error regardless of
    `--confirmed`.
  - Accepting a collision's suggested alternative re-runs `plan.ts` with the corresponding `--path`
    override, producing a revised plan whose `paths`, generated imports, scripts, and configs all use the
    alternative; the agent presents and confirms that revised plan.
  - Variants: `full-app` (empty directory → root; monorepo → `presentations/`) uses `app-template`;
    `page-entry` (compatible app, or standalone root) adds `page-entry`; both add whichever of kit, index,
    and harness are missing. Present pieces are never planned.
  - `merge` covers `package.json` (missing dependencies and `presentation:dev`, `presentation:build`,
    `presentation:verify`, and `presentation:screenshots` scripts; existing keys are never replaced; for
    `full-app`, the template's own `dev` and `build` scripts are also included) and `.gitignore` (append
    `presentation-screenshots/` and `dist-presentation/` when absent, creating the file if needed, keeping
    existing lines). Existing presentation wiring and `presentation:*` scripts are reused, so a second run
    plans only presentation files and the index registration.
  - Dependencies: `react`, `react-dom` (^19), `motion`, `lucide-react`; dev: `vite`,
    `@vitejs/plugin-react`, `typescript`, `@types/react`, `@types/react-dom`, `@types/node`, and
    `@playwright/test@1.61.0`, each only when missing. Compatible existing versions are kept.
  - A collision is a planned create path that already exists; each collision carries a suggested
    alternative path (for example `presentation-2.html`).
  - `requiresConfirmation` is true for every target that is not `empty`.
- **`apply.ts --plan <file> [--confirmed] [--no-install]`** refuses with a blocker error (exit 3) when the
  plan has blockers, refuses with a usage error when the plan requires confirmation and `--confirmed` is
  absent, re-checks that no planned create path now exists,
  writes files, merges `package.json`, and runs the detected package manager's install unless
  `--no-install` is given (a test-only flag used by offline integration tests; `SKILL.md` never uses it). The agent presents the plan together
  with the step outline, waits for the user's answer, and passes `--confirmed` only after approval; the
  flag guards against a skipped confirmation.
- The `page-entry` variant builds with `vite.presentation.config.ts` (root at the project, input
  `presentation.html`, output `dist-presentation/`) and type-checks with `tsconfig.presentation.json`
  (`strict: true`), so the host's `vite.config`, `index.html`, `tsconfig`, and router are untouched. Its
  `presentation:*` scripts pass `--config`, `--page`, and `--tsconfig` (from `paths`) to the harness. The
  app template's tsconfig also sets `strict: true`.

### Verification harness

`scripts/presentation/` (canonical in `assets/harness/`) uses the Playwright library API from
`@playwright/test`, not the test runner, so it controls its report format and exit codes.

Shared options for both scripts: `--slug <slug>`, `--config <vite config>` (default: Vite's own
resolution), `--page <html path>` (default `/`, for example `/presentation.html`), and
`--tsconfig <path>` (default: run `tsc -b`; when given, run `tsc -p <path> --noEmit`). `--config` is passed
to both `vite build` and `vite preview`, so preview serves the configured output directory; every URL is
`<origin><page>#/<slug>/…`.

- **`verify.ts`**
  1. Preflight: if `chromium.executablePath()` does not exist, print a provisioning error naming the
     installed `@playwright/test` version's Chromium and the install command, and exit 2.
  2. Type-check with the project's local `tsc` as above, then build with the local `vite build`. On either
     failure, print the output and exit 1 without starting a browser.
  3. Start `vite preview --port <free port> --strictPort` (with `--config`) and wait until `<page>` answers
     HTTP 200.
  4. For each viewport, 1440 × 900 and 390 × 844, open a fresh browser context, collect `console` messages
     of type `error` and `pageerror` events (which include unhandled rejections), and read
     `window.__presentationManifest` for the slug. If the manifest is absent after the page loads, report
     "scene kit does not implement the verification protocol" and exit 1 with that message, without step
     failures; if the slug is not in the manifest, report it as not registered.
  5. Open `#/<slug>/1?mode=browse`. For each step i from 1 to N: wait for `data-animating="false"`, assert
     marker `i / N`, the manifest title, and at least one `[data-entity-id]`; press P and repeat the
     assertions in present mode with the step unchanged; press P to return; then, if i < N, press Right
     Arrow and assert step i + 1. Then, in present mode from step N, press Left Arrow repeatedly and assert
     each step i − 1.
  6. Print each failure as `step / mode / viewport / message`, stop the preview server, and exit 1 if any
     failure or error was collected, otherwise 0. Invalid arguments exit 64. The browser steps wait on
     `data-animating="false"` and on the pending state disappearing.
- **`screenshot.ts`** additionally accepts `[--steps 1,8] [--mode present|browse] [--viewport phone]`,
  shares the preflight, type-check, build, and preview steps, uses `reducedMotion: 'reduce'`, navigates directly to each step URL,
  waits for the settle signal, and writes
  `presentation-screenshots/<slug>/<slug>-step-<NN>-<mode>-<desktop|phone>.png`. The defaults are all
  steps, both modes, and desktop at 1440 × 900; the phone viewport is 390 × 844. It exits nonzero only
  when capture fails.

### Repository tooling

- `package.json` scripts: `test` (`vitest run`), `verify`
  (`node scripts/presentation/verify.ts --slug using-the-presentation-skill`), `screenshots`
  (`node scripts/presentation/screenshot.ts --slug using-the-presentation-skill`), and `test:bootstrap`
  (`node tests/bootstrap/run.ts`), `test:integration` (`vitest run --config vitest.integration.config.ts`),
  and `test:e2e` (`playwright test`). New dev dependencies: `vitest`, `jsdom`, `@testing-library/react`,
  `@testing-library/user-event`, and `@playwright/test@1.61.0`.
- `vitest.config.ts`: includes `src/**/*.test.{ts,tsx}`, `scripts/**/*.test.ts`,
  `skills/presentation/scripts/**/*.test.ts`, and `tests/unit/**/*.test.ts`. Kit and viewer tests opt into
  jsdom with a `// @vitest-environment jsdom` docblock; script tests use node.
- Unit tests:
  - kit: `checkPresentation` for each problem code, registry and transition-set behavior, routing, the
    navigation reducer, and viewer modes, keys, and table-of-contents visibility through Testing Library
    with a `matchMedia` stub;
  - registered presentations: every entry of `src/presentations/index.ts` has no problems;
  - drift: byte comparison of `skills/presentation/assets/scene-kit/**` with `src/presentation/**` and of
    `assets/harness/**` with `scripts/presentation/**`, naming any differing or missing file;
  - setup: `detect` and `plan` against fixture directories generated in a temporary directory for empty,
    `.git`-only, compatible app, Next.js standalone, monorepo with a compatible package, standalone with
    `package.json`, a pnpm lockfile, collisions, existing kit and index, a kit at a non-standard path, an
    earlier setup's page and scripts (second run), `--path` overrides for an accepted alternative, React
    17, a Vite/plugin mismatch, a compatible older `@playwright/test`, and an existing `.gitignore`, and
    ambiguous candidates; tests assert fixtures are unchanged afterward and that plans with blockers list
    each incompatible dependency.
- Integration tests (`tests/integration/**/*.test.ts`, node environment, long timeouts):
  - setup scripts on a real filesystem: `apply` refusal without `--confirmed`, refusal of a plan with
    blockers even with `--confirmed`, the collision re-check, `package.json` and `.gitignore` merging, and
    template rendering for a non-standard kit path and an alternative page path, using `--no-install`;
  - page-entry: apply the `page-entry` variant to a temporary copy of a compatible-app fixture with
    `--no-install`, symlink this repository's `node_modules`, copy in and register a small fixture
    presentation, then run the generated `presentation:build`, `presentation:verify`, and
    `presentation:screenshots` scripts (exercising `--config`, `--page`, and `--tsconfig`); repeat with an
    accepted alternative page path; then re-run detection and planning to confirm a second run reuses the
    wiring; also run verify against a fixture kit that omits the verification protocol;
  - harness: run the real `verify.ts` and `screenshot.ts` with `--config` against
    `tests/fixtures/harness-app/`, whose index registers deliberately faulty presentations (console error,
    thrown error, blank step, build error and type error toggled through environment variables) and a
    clean 8-step one, asserting exit codes 0, 1, 2 (via an empty `PLAYWRIGHT_BROWSERS_PATH`), and 64, failure
    locations, screenshot counts and names, and `git check-ignore` on the output.
- Browser end-to-end tests (`tests/e2e/*.spec.ts`, Playwright Test, `playwright.config.ts` whose
  `webServer` runs `vite --config tests/fixtures/viewer-app/vite.config.ts` on a fixed port): a fixture page
  mounting `PresentationApp` with fixture presentations covering transitions within and across scene
  groups, custom entities (including a multi-element one), connector reconnection,
  resizing, and endpoint departure, long titles, a declared opening mode, a single-step presentation, an
  invalid presentation, a scene that throws, and dense steps. The fixture page mounts under `StrictMode`.
  Specs cover entity identity and settled geometry across transitions, mid-transition navigation and
  navigation during exits, direct-versus-sequential equivalence, reduced motion for primitives and custom
  entities, layout at phone, tablet, and desktop sizes in both orientations, touch swipe and tap zones,
  keyboard precedence for focused controls and modifier keys, history and document title, the pending
  state, invalid, throwing, and not-found views.
- Fixture app sources under `tests/fixtures/` and type tests under `tests/typetests/` are type-checked by
  `tsconfig.app.json` (which adds both); node-side tests are covered by `tsconfig.node.json`.
- `tests/bootstrap/run.ts`: creates a temporary directory, runs `plan.ts` and `apply.ts`, copies the sample
  presentation into the generated app and registers it, installs dependencies with
  `PLAYWRIGHT_BROWSERS_PATH` passed through, runs the generated app's `presentation:verify` for the
  sample's slug, prints the output of any failing step, and exits with its status.
- `.validator/config.yml` gains `test` (`npm test`), `test-integration` (`npm run test:integration`), and
  `test-e2e` (`npm run test:e2e`) checks; these need a local Playwright browser but no network. `verify`
  and `test:bootstrap` remain npm scripts run by the skill workflow and during acceptance.
- ESLint: `skills/presentation/assets/**` is added to `globalIgnores` (those files are linted through
  their installed copies and compiled by the bootstrap test), and a block with `globals.node` applies to
  `scripts/**`, `skills/**/scripts/**`, `tests/**`, and `vitest.config.ts`.
- TypeScript: `tsconfig.node.json` includes `vite.config.ts`, `vitest.config.ts`,
  `vitest.integration.config.ts`, `playwright.config.ts`, `scripts`, `skills/presentation/scripts`, and
  `tests` excluding `tests/fixtures` and `tests/typetests`; `tsconfig.app.json` includes `src`,
  `tests/fixtures`, and `tests/typetests`, with kit and viewer tests importing Vitest explicitly.
- ESLint's browser rules apply to `tests/fixtures/**` and `tests/typetests/**`; the Node-globals block covers the rest of `tests/**`
  and `vitest.integration.config.ts` and `playwright.config.ts`.
- `.gitignore` gains `presentation-screenshots/` and `dist-presentation/`.
- `tsconfig.app.json` gains `"strict": true`; the existing scaffold code is adjusted if needed. A type test
  file `tests/typetests/scene-data.tsx` (included by `tsconfig.app.json`) uses `// @ts-expect-error` on a
  step whose data mismatches its scene, so `tsc -b` fails if the mismatch ever stops being an error.

### Sample presentation

`using-the-presentation-skill` (about 8 to 10 steps across 3 or 4 scene groups) follows one diagram from
"topic" through outline, detection, confirmed setup, authoring with scene components and scene groups,
self-check, screenshot review, and finally presenting versus browsing, reusing entity ids so the same
nodes persist and morph throughout. It is authored by following `SKILL.md` and is the fixture for
`verify`, the registered-presentation unit test, and the bootstrap test.

## Decisions

- **Registry Stage over per-scene DOM or `layoutId`.** Motion's `layoutId` shared-element morphing targets
  HTML boxes and does not handle SVG geometry under a scaled `viewBox`. Owning the drawn entities in one
  persistent Stage provides cross-group morphing, deterministic settling, and cheap structure checks.
  Trade-off: scenes cannot draw arbitrary markup outside primitives and `Custom`, which the structure
  check reports.
- **SVG with `viewBox` scaling** gives uniform, uncropped scaling for free; text is not auto-wrapped, and
  multi-line labels are given as explicit line arrays.
- **Hash routing** works on static hosting and `vite preview` without server configuration, and on a
  separate page it cannot collide with a host router.
- **Separate page entry and Vite config for existing projects** leaves host configuration untouched; the
  cost is separate `presentation:*` scripts and output directory.
- **Plan and apply split with a `--confirmed` guard** keeps detection and planning pure and testable, and
  makes the confirmation rule enforceable rather than purely instructional.
- **Playwright library rather than the test runner** for the harness, to control exit codes (0, 1, 2,
  64) and the step/mode/viewport report format.
- **TypeScript scripts run by Node type stripping** to match the repository's `erasableSyntaxOnly`
  convention and avoid a build step; this requires Node ≥ 22.18.
- **Canonical assets plus byte-equality drift test** for this repository, while other projects reuse
  detected pieces at the contract level without comparing contents.

## Risks / Trade-offs

- Estimated text extents can miss slight label overflow → screenshot review catches it.
- The structure check renders every step when a presentation opens → negligible for diagrams of this
  size; it runs once per presentation per session, outside React's lifecycle, behind a pending state.
- The fixed settle timer assumes all animation uses kit timing → enforced for custom children by
  `MotionConfig` defaults plus the structure check's transition and repeat rule.
- Contract-level reuse means an adapted or outdated kit in another project is used as-is → documented in
  `setup.md`; authors work against the detected kit's API; signature mismatches fail the self-check's type
  check and a missing verification protocol is reported specifically.
- The Vite/plugin compatibility table can go stale as new majors ship → unknown newer majors are treated as
  blockers with a message naming the supported ranges, rather than guessed compatible.
- The Playwright package and browser revision are coupled → both are pinned and upgraded together; the
  preflight reports mismatches as provisioning errors.
- The bootstrap test needs network access and takes minutes → kept out of the validator and run during
  acceptance.
- Text-based detection of the kit contract can be fooled by unusual export styles → the detector parses
  named exports and re-exports, and ambiguous results are surfaced to the user rather than guessed.

## Migration Plan

Additive change. `src/App.tsx` switches from the placeholder to the presentation index. Rollback is
reverting the change; there is no persisted data.
