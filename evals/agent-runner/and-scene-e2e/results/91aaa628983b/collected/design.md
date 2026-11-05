## Context

The repository is a bare Vite 8 + React 19 + TypeScript 6 scaffold (`react`, `react-dom`, `motion`,
`lucide-react` already installed; `src/App.tsx` is a placeholder). It has no test runner. The validator
(`.validator/config.yml`) runs `npm run build`, `npm run lint` and `npx tsc -b --noEmit`. `tsconfig.app.json`
covers `src` only and sets `erasableSyntaxOnly`, so TypeScript files that avoid enums, namespaces and
parameter properties can run directly under Node's native type stripping (Node >= 22.18; this
environment has Node 24). `.gitignore` already excludes `validator_logs`. `AGENTS.md` requires TDD for
behavior changes, forbids committing generated output, and names `chrome-devtools-axi` for interactive
browser inspection.

The specs (`presentation-scene-kit`, `presentation-authoring-skill`, `presentation-verification`)
define the behavior. This design settles structure, interfaces, and how verification and the template
snapshot work. No `deferred-to-design` markers exist.

## Goals / Non-Goals

**Goals:**
- One pure, shared source of truth for the data model, step resolution, validation, and geometry, used
  identically by the viewer, the Node-side verifier, and the unit tests.
- A viewer whose rendered DOM exposes enough structure for automated checks to compare it with the
  resolved scene.
- A verification library and command that check build, data, snapshot sync, and browser rendering, and
  that are themselves tested against deliberately broken presentations.
- A skill whose template snapshot bootstraps a fresh Vite + React + TypeScript project additively,
  without depending on this repository.

**Non-Goals:**
- Anything listed under the proposal's Out of Scope (authoring GUI, export, themes, presenter tools,
  general-purpose layout, other project types).
- A router, a state-management library, or a UI component library.
- Cross-browser verification; Chromium only.

## Approach

### File layout

```
src/presentation/                 canonical kit (React + pure logic)
  types.ts grid.ts resolve.ts validate.ts geometry.ts icons.ts       pure TS, no React, no DOM
  Stage.tsx elements/*.tsx Viewer.tsx PresentationHost.tsx
  PresentationGate.tsx viewerState.ts index.ts
  *.test.ts                       Vitest unit tests (excluded from snapshot)
src/presentations/<id>/index.ts   presentation modules (user content; never snapshotted)
src/presentations/using-the-presentation-skill/   the sample
src/App.tsx                       renders <PresentationHost /> (this repo only)
scripts/verify-presentations.ts   CLI wrapper around the verification library
scripts/presentation-verify/*.ts  verification library (build, data, snapshot, browser)
scripts/sync-presentation-template.ts   sync CLI (repo-only; the check logic lives in the verification library)
tsconfig.presentation.json        portable: type-checks the kit's scripts (ships in the snapshot)
tsconfig.tests.json               repo-only: type-checks tests/, bootstrap.ts and the sync CLI
tests/fixtures/presentations/     data-invalid presentations (overlap, missing caption, duplicate id, bad reference)
tests/fixtures/mutations/         test-only patches that make the viewer faulty (see Tests)
tests/fixtures/scratch-app/       minimal Vite + React + TS app with realistic global CSS, used to test bootstrap
skills/presentation/SKILL.md      the skill
skills/presentation/reference/authoring.md   authoring guide (primitives, grid, label capacity)
skills/presentation/bootstrap.ts  installs the snapshot into a target project
skills/presentation/template/     snapshot, mirroring project-relative paths
```

Pure modules (`types`, `grid`, `resolve`, `validate`, `geometry`, `icons` names) import each other with
explicit `.ts` extensions and avoid non-erasable TypeScript syntax, so Node can import them directly
for verification while Vite bundles the same files for the browser. Presentation modules use
`import type` only, so they are loadable by Node without React.

### Data model (`types.ts`)

```ts
type Pos = `${ColLetter}${RowNumber}`            // 'A1'..'V10' (22 columns, 10 rows)
type Presentation = { id: string; title: string; steps: Step[] }
type Step = { caption: string; changes: Change[] }
type Change =
  | { op: 'add'; element: Element }
  | { op: 'update'; id: string; patch: Patch }   // any of: at, span, label, from, to, members
  | { op: 'remove'; id: string }
type Element = Node | Group | Connector | Text | Highlight   // each has a unique `id`
```

- `node`: `{ id, type:'node', at: Pos, span:[w,h], label, icon? }` where `icon` is a name from a curated
  set in `icons.ts` (validation rejects unknown names, so bundles do not import all of `lucide-react`).
- `group`: `{ id, type:'group', at, span, title, members: string[] }`; members must lie inside the group.
  Members may be nodes, text, or other groups (nesting is allowed); an element has at most one parent
  group and containment must be acyclic.
- `connector`: `{ id, type:'connector', from, to, label? }`; endpoints reference node, group or text ids
  (never connectors or highlights).
- `text`: `{ id, type:'text', at, span, text }`.
- `highlight`: `{ id, type:'highlight', target }`; the target is a node, group or text id.
- Ids are unique across every `add` in the presentation (this is the spec's "duplicate id" rule). Only
  `remove` deletes an element; there is no re-adding a removed id. Step 1 may use any ops but must
  leave a non-empty scene.

### Resolution (`resolve.ts`)

`resolveScene(presentation, stepIndex) -> Scene` folds `changes` for steps `0..stepIndex` over an
empty scene. It has no other input and no mutable state, which makes the "same scene however the viewer
arrived" requirement true by construction. `Scene` is an ordered list of resolved elements.
The viewer, validation, geometry, and the browser verifier all call this one function.

### Canvas, grid, geometry

- Logical canvas **880 x 380**, drawn in an SVG `viewBox`. The stage scale is
  `min(availableWidth / 880, availableHeight / 380)`, where the available area is the viewport (or the
  Browse stage region) minus the space reserved for controls, so wide and short windows (for example
  1280x400) never overflow vertically and the whole diagram is visible in Present mode without
  scrolling. Proportions are preserved. Grid: **22 columns x 10 rows**, cells **40 x 38** units.
- Labels use **32 units**. At a 360 px viewport with a full-bleed stage the scale is 360/880 = 0.409, so
  labels render at about 13.1 px, above the 12 px floor. Phone layouts therefore give the stage no
  horizontal padding, and the stage must keep at least 330 px of width at 360 px viewports, which is why
  the viewer must not inherit padding from the host application (see Style isolation).
- A typical node spans 5 x 2 cells (200 x 76) with a one-line label, or 5 x 3 (200 x 114) for up to two
  lines. 14 such elements occupy well under the 220-cell grid, leaving room for connectors.
- `geometry.ts` turns each resolved element into a box (cells * unit sizes), computes connector paths
  (straight or single-elbow between the nearest edge midpoints of the endpoints), and estimates text
  boxes with a conservative per-character width (0.6 of font size). The same boxes feed validation and
  rendering, so the overlap check validates what is drawn.
- Validation (`validate.ts`) returns a list of `{ step, element?, code, message }` problems covering
  every rule in the specs: duplicate ids, missing captions, dangling references, references to the wrong
  kind of element (connector endpoints and highlight targets must be nodes, groups or text), cyclic or
  multi-parent group containment, unknown types, icons or positions, boxes outside the canvas, group members outside their group, unintended overlap (AABB on
  element bodies and text boxes, excluding declared containment, connector crossings and highlights),
  label capacity versus box size, and the density caps (14 non-connector elements, 16 connectors).

### Viewer

- `viewerState.ts` parses and writes `presentation`, `step` (1-based) and `mode` in the query string
  with `history.replaceState`; invalid step falls back to 1, unknown mode to Browse. There is no router.
- `Viewer.tsx` holds `{ step, mode }`, renders `Stage` for `resolveScene(...)`, and in Browse mode also
  the caption (inside a polite live region) and the outline. Present mode renders stage plus compact
  prev/next controls, a step indicator and a mode toggle.
- Transitions use `motion` with elements keyed by id (appear, disappear, move, relabel, connector
  re-route). `useReducedMotion()` makes every transition instant. The stage sets `data-settled="true"`
  when no transition is running.
- One window `keydown` listener implements the key map from the spec. It ignores events with
  Ctrl/Alt/Meta and events from text inputs. When a button or link is focused, Space is left to the
  browser's native activation so a step is not advanced twice. `M` is not used; `P` toggles mode.
- Swipe uses pointer events on the stage: horizontal movement over 50 px that dominates vertical
  movement navigates.
- DOM contract for checks: every rendered element carries `data-element-id`, `data-type`, `data-at`,
  `data-label`; connectors carry `data-from` and `data-to`. These attributes identify elements only;
  the checks do not trust them as evidence of what is drawn (see Verification).
- Style isolation: the host renders inside its own scoped container with a dedicated class prefix. Its
  CSS never uses bare element selectors (`main`, `body`, `h1`), declares its own box model, padding,
  font and sizing on its container, and resets properties it relies on, so the project's own global CSS
  (for example padding on `main` or flex centering on `body`) cannot change its layout. The kit's CSS is
  scoped so showing the viewer does not change the project's own app. In this repository `App.tsx` no
  longer imports `App.css`.
- An error boundary, plus the validation result, renders the problems view instead of a diagram.
- Layout: Browse places stage above caption and outline on narrow viewports and stage beside them on
  wide ones; Present uses the full viewport. The page never scrolls horizontally.

### Host and gate

- `PresentationHost` finds presentations with `import.meta.glob('../presentations/*/index.ts', { eager:
  true })`, then renders the list page (no or unknown id), the problems view (invalid presentation), or
  the `Viewer`.
- In this repository `src/App.tsx` renders `<PresentationHost />`, so `/` lists presentations and
  `/?presentation=<id>` shows one.
- For bootstrapped projects the kit also exports `PresentationGate`, which renders the host when the URL
  has a `presentation` parameter and its children (the project's own app) otherwise. The bootstrap wraps
  `<App />` in the project's `src/main.tsx` with the gate. The edit is a small, idempotent text
  transformation targeting the standard Vite template shape; if the entry does not match, the bootstrap
  changes nothing and prints the exact lines to add.

### Discovery in Node

The verification library lists `src/presentations/*/index.ts` and imports each with Node's native
TypeScript support. After the browser step loads the built host's list page, the library asserts the
list shows exactly the ids found by Node, so the two discovery mechanisms (Node directory listing and
the browser glob) cannot drift apart silently.

### Verification library and command

`verifyPresentations({ projectDir, outputDir })` runs these checks in order and returns structured
results; `scripts/verify-presentations.ts` prints them and sets the exit code.

1. **Environment:** Node version, Playwright browser availability (fail with the install command
   `npx playwright install chromium`).
2. **Build:** `npm run build` in the project, then `tsc -p tsconfig.presentation.json --noEmit`. On
   failure, report build errors and stop (browser checks are not run).
3. **Snapshot:** two roles. A project that contains `skills/presentation/template/` is a
   canonical-source project: the check runs there and fails (naming differing, missing and extra files)
   on drift or when the expected snapshot is missing. Any other project is a consumer: the check is
   reported as "not applicable" explicitly, never silently skipped. The check logic lives in the shipped
   verification library; the sync CLI is repo-only.
4. **Data:** validate every presentation in Node and report all problems.
5. **Browser:** start `vite preview` through its programmatic API on a free port, then drive Chromium
   through the Playwright library (no Playwright test runner). For each presentation x viewport (360x640,
   768x1024, 1280x800, 1280x400) x mode:
   - confirm the host list shows the Node-discovered ids;
   - with reduced motion emulated (deterministic), visit every step by forward navigation, backward
     navigation, outline jump, and direct-link reload. Identify elements by `data-element-id`, then
     compare what is actually drawn with expectations derived from `resolveScene` and `geometry.ts`:
     the visible text content, each element's on-screen box (`getBoundingClientRect`, compared with
     the expected box mapped through the stage's screen transform, within a small tolerance), and each
     connector's drawn endpoints (the ends of its path, mapped through the same transform) against its
     endpoint elements' edges. Also require the scene to be identical across the four paths;
   - run one non-reduced-motion pass: record, with an in-page `requestAnimationFrame` recorder, the
     on-screen position of each element a step moves; require at least one sample strictly between the
     start and end positions, then wait for `data-settled` and re-check the final geometry;
   - assert no console errors or page errors, no horizontal overflow, stage within the viewport, each
     label's rendered size (computed font size times the SVG screen scale) is at least 12 px at 360x640,
     labels are inside their element and do not intersect other labels, and the caption is absent in
     Present and visible in Browse.
   Failures save a screenshot under `verification-output/` (added to `.gitignore`) and report the path.

The skill and the validator run the same command. The validator keeps its existing three checks and
gains two: `npm run verify:presentations` (mandatory per the spec) and `npm test`.

### Tests

- **Unit (Vitest, colocated `*.test.ts` in `src/presentation/` plus `scripts/` tests):** resolver
  (hand-written expected scenes, path independence), validation rules (each rule has a failing and a
  passing case, including declared containment and the reference rules: nested groups, connector to
  connector, highlight of highlight, cycles, two parents), geometry, key map, URL parsing, template sync
  detection and repair.
- **Fixture integration (Vitest, needs Chromium):** builds a scratch project by copying
  `tests/fixtures/scratch-app/` (which carries realistic global CSS such as the Vite template's `body`
  flex centering and padded `main`), symlinking this repository's `node_modules`, running the real
  `skills/presentation/bootstrap.ts` against it with `--skip-install` (so it uses only the template
  snapshot, never `src/`), and calling `verifyPresentations`. Two kinds of faults are injected:
  - *Data faults* are presentations under `tests/fixtures/presentations/` (overlap, missing caption,
    duplicate id, invalid reference).
  - *Renderer faults* are test-only patches in `tests/fixtures/mutations/` applied to the scratch
    project's copy of the kit (never to `src/`): keep the previous scene (stale or history-dependent
    geometry), reduce the label font size, render the caption in Present mode, and make moved elements
    jump without transition. A healthy presentation is verified against each mutated viewer.
  Each fault must fail the check meant to catch it, while the unmutated healthy run passes.
- **Isolated dependency test:** a separate scratch project given only its own manifest (no symlinked
  `node_modules`) runs the real bootstrap including the package-manager install (npm, detected from the
  lockfile) and the copied CLI, to prove the bootstrap declares everything the kit needs. It uses a
  pre-provisioned Chromium when available and otherwise downloads one.
- **Execution isolation:** integration and end-to-end test files run serially (Vitest
  `fileParallelism: false` in a dedicated project) because several build or preview this checkout; tests
  that need their own output use isolated project copies. Each test owns cleanup of the preview servers,
  browsers and evidence directories it starts, in `afterAll`/`finally`.
- **Type-checking of tests:** `tsconfig.tests.json` covers `tests/`, `skills/presentation/bootstrap.ts`
  and the sync CLI, and is added to the references in `tsconfig.json` so the validator's existing
  `npx tsc -b --noEmit` covers it. `tsconfig.presentation.json` stays portable and is type-checked by
  the verifier.
- Vitest configuration goes in `vite.config.ts` via `vitest/config`.

### Snapshot sync and bootstrap

- `sync-presentation-template.ts` has a manifest of canonical paths: `src/presentation/**` minus
  `*.test.ts`, the verification library and CLI, `tsconfig.presentation.json`. It excludes tests,
  fixtures, `src/presentations/**`, `src/App.tsx`, and itself (the sync CLI is repo-only). Plain mode copies them to
  `skills/presentation/template/`; `--check` compares bytes and fails naming differing, missing, and
  extra files. `skills/presentation/bootstrap.ts` is not part of the snapshot.
- `bootstrap.ts <target> [--skip-install]` detects a supported project (Vite + React + TypeScript from
  `package.json`), refuses otherwise without changes, compares an existing kit to the template and refuses
  to overwrite a difference (listing files), copies the template, merges `package.json` (script
  `verify:presentations`; dependencies `motion` and `lucide-react`; devDependency `playwright`), wires the entry gate, adds `verification-output` to `.gitignore`, and
  runs the package manager detected from the lockfile plus `playwright install chromium`.
- Targets get Node >= 22.18 documented; the CLI fails clearly on older Node.

### Skill workflow (`SKILL.md`)

1. Detect the project and whether the kit is present (compare with the template).
2. Ask about missing details (audience, scope, key points, length), batching questions; do not generate
   until answered; state any decision the user delegated.
3. Bootstrap when the kit is missing.
4. Write `src/presentations/<slug>/index.ts` following `reference/authoring.md`: labels that carry
   meaning without the caption, grid positions, density and label-capacity limits, one evolving diagram.
   Ask before replacing an existing slug.
5. Run typecheck, lint, build and `npm run verify:presentations`; on failure fix using the report and
   repeat up to three attempts; report failure honestly, report "verification could not run" if the
   browser is missing, and report the link only on full success.
`reference/authoring.md` points at `src/presentation/types.ts` (or the template copy) as the authority
for the data model so documentation cannot silently diverge.

### Sample

`src/presentations/using-the-presentation-skill/` is authored by following the skill workflow. It
shows the skill's own flow (ask, bootstrap, write, verify, fix) as one diagram that evolves.

## Decisions

- **Shared pure core, loaded natively by Node.** Using Node's type stripping avoids adding `tsx` or
  running Vite SSR just to validate. Cost: a Node >= 22.18 requirement and a ban on non-erasable
  syntax, which `erasableSyntaxOnly` already enforces.
- **Resolver is a pure fold, viewer keeps no scene state.** Path-independence is then structural and the
  browser check only needs to confirm the DOM reflects it.
- **Fixed logical canvas with a grid** (880 x 380, 22 x 10 cells, 32-unit labels). Predictable
  geometry makes overlap and readability checkable; the cost is limited expressiveness.
- **App is the host; bootstrapped projects get a gate.** The user asked for the app itself to be the
  host. The gate keeps the user's own app reachable in bootstrapped projects at the price of a small
  edit to their entry file, which is idempotent and falls back to printed instructions.
- **Hardcoded relative glob, no alias and no second Vite config.** The project's own build is the build
  that is verified. Fixtures are tested by assembling a scratch project, not by reconfiguring discovery.
- **Playwright library plus Vitest, not Playwright Test.** One runner for unit and fixture tests; the
  verifier is a library usable from the CLI and from tests.
- **Verification includes the project build and the tools' typecheck.** `tsconfig.presentation.json` is
  type-checked by the verifier itself so bootstrapped projects need no changes to their tsconfig.
- **Tests excluded from the snapshot.** Targets receive only what they need to author and verify
  presentations.
- **Validator runs `npm test` as well as verification.** The unit and fixture tests are the only
  protection for the verifier's own correctness.

## Risks / Trade-offs

- **Font metrics differ across machines.** Text estimates are conservative (0.6 of font size per
  character) and the browser check measures real rendering, but a presentation can pass on one machine
  and fail on another. Mitigation: system-ui font stack, margin in capacity rules, screenshots on failure.
- **A 380-unit-tall stage is short on portrait phones** (about 155 px at 360 px wide). Browse mode
  leaves room for the caption and outline; Present mode shows a small stage. Accepted per the chosen
  canvas.
- **Entry-file wiring is heuristic.** Non-standard entries get instructions instead of an edit, and
  verification fails until wired.
- **The real-install test depends on the npm registry** and adds roughly a minute to `npm test`. It is
  kept in the default run so a bootstrap that forgets a dependency cannot ship unnoticed.
- **Inherited application CSS** can still leak into the viewer through inherited properties; the scoped
  container resets what the layout depends on, and the scratch app with realistic global CSS exercises it.
- **Verification time** grows with presentations, viewports, modes, and paths. Reduced-motion
  emulation keeps individual steps fast; one animated pass per presentation checks transitions finish.
- **Browser provisioning** is required in every validator and CI environment; a missing browser
  fails loudly rather than skipping.
- **Two discovery mechanisms** (Node listing and browser glob) are reconciled by an explicit equality
  check rather than a shared implementation.
- **Alternatives considered:** a separate `presentations.html` entry (rejected by the user in favor of
  the app being the host); SSR or `tsx` for loading TypeScript in Node (heavier, extra dependency);
  Playwright Test as the runner (second runner, duplicates Vitest); raw coordinates (rejected in the
  proposal); an alias-driven glob for fixtures (changes the project's Vite config).

## Migration Plan

Additive. Bootstrapping a project is idempotent and refuses to overwrite a differing kit. Rollback is
removing the added files and reverting the `package.json` and `src/main.tsx` edits (listed in the
bootstrap output). In this repository the change replaces the placeholder `App.tsx`.

## Open Questions

- Confirm during implementation that Node's native type stripping loads the pure modules and the
  presentation modules unchanged (no `tsx` fallback expected).
- Confirm the Vite `import.meta.glob` relative pattern behaves identically in dev, build, and preview;
  if not, switch to a small Vite plugin that generates the registry module.
