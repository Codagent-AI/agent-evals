## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional
integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only
obligations.

Unit tests (Vitest; jsdom for kit and viewer, node for scripts) carry the broad base: routing and URL
correction, the navigation reducer, every structure-check problem code, registry and enter/persist/exit
set computation, viewer mode content and key handling, `detect` classification and `plan` output, the
canonical-asset drift check, and the registered-presentation check. The obligations below cover what
jsdom or pure functions cannot prove: real animation and layout in a browser, scripts acting on a real
filesystem and toolchain, the verification harness detecting real failures, and full journeys through
the repository verify command and a fresh bootstrap.

`npm test`, `npm run test:integration`, and `npm run test:e2e` run in `.validator/config.yml`; they need
the local Playwright 1.61.0 Chromium but no network. `npm run verify` and `npm run test:bootstrap` are
npm scripts run during implementation, the skill self-check, and acceptance.

## Integration Tests

### INT-001: Scene transitions in a real browser
- Covers: scene-presentation — Each step defines its full diagram; Scene groups (scene persists); Scene
  primitives (connector attachment, reconnection, departure with an endpoint); Custom motion entities
  (morph, enter, exit, reduced motion); Transitions between steps (move, relabel, enter/exit, across scene
  groups, jump, navigation during a transition); presentation-viewer — Reduced motion.
- Boundary: the scene kit Stage, `motion` animations, and React rendering in real Chromium.
- Setup: the fixture viewer app in `tests/fixtures/viewer-app/` served by the Playwright `webServer`, with
  fixture presentations containing a node that moves, resizes, and is relabeled within a scene group, an
  entity shared across two scene groups, entering and exiting entities, a connector attached to a moving
  node, a connector whose `to` changes between steps, a connector that departs together with its endpoint,
  and a multi-element custom motion entity. The fixture page mounts under `StrictMode`.
- Action: navigate between steps by keyboard and by URL; tag a persisting entity's DOM element with a
  marker property before a transition; navigate again before a transition settles, including while
  entities are exiting; open step N directly and separately reach it by stepping from step 1; repeat the
  custom-entity transition with reduced motion emulated.
- Assertions: the tagged element for a persisting id is the same element after transitions within and
  across scene groups; after `data-animating="false"` each entity's geometry and label equal the target
  step's values; entering ids appear and exiting ids are removed; sampled mid-transition connector
  endpoints lie on the moving node's boundary; a reconnected connector keeps its DOM element and its end
  passes through intermediate positions before reaching the new endpoint's edge; a departing connector's
  sampled end stays on its departing endpoint's boundary until both are removed; after interrupted
  navigation (including during exits) the settled diagram equals the latest target and
  `data-animating` returns to `"false"`; the direct and sequential entity snapshots (ids, geometry,
  labels) are equal; the custom entity's attributes reach their new values, and under reduced motion
  primitives and custom elements take their new values on the next frame with `data-animating` staying
  `"false"`.
- Execution: `tests/e2e/transitions.spec.ts`, `npm run test:e2e` (validator).

### INT-002: Setup scripts on a real filesystem
- Covers: presentation-skill — Read-only project detection; Setup by project type (including `.gitignore`
  extension); Incompatible dependencies block setup; Reuse of existing pieces (non-standard locations,
  second run); Confirmation before writing in non-empty projects (script guard, collision handling,
  accepted alternative paths).
- Boundary: `detect.ts`, `plan.ts`, and `apply.ts` run as Node subprocesses against real directories.
- Setup: temporary fixture directories generated per test: empty, `.git`-only, compatible Vite app,
  Next.js standalone, monorepo with a compatible package, standalone with an existing `package.json`, pnpm
  lockfile, existing scene kit and index, a scene kit at a non-standard path, a project set up by an
  earlier run, an existing `.gitignore`, React 17, a Vite version unsupported by the declared React
  plugin, a compatible older `@playwright/test`, a planned path that already exists, and an ambiguous
  layout with several candidate packages.
- Action: run detection and planning on each fixture, including with a `--path` override for an accepted
  alternative; run `apply.ts --no-install` without and with `--confirmed`, including on a plan with
  blockers; create a colliding file between planning and applying.
- Assertions: content hashes of every fixture are unchanged after detection and planning; classification,
  candidates, pieces, package manager, variant, create list, collisions with alternatives, and
  `requiresConfirmation` match expectations for each fixture; `apply` without `--confirmed` exits with a
  usage error and writes nothing; `apply` aborts without writing when a collision appeared after planning;
  the merged `package.json` keeps every pre-existing key and value and adds only missing dependencies and
  `presentation:*` scripts; plans for incompatible dependencies list each blocker with found and
  supported ranges, and `apply --confirmed` on them exits with the blocker status and writes nothing;
  compatible existing versions are kept; the merged `.gitignore` keeps its original lines and adds the
  screenshot and build-output entries; generated files for the non-standard kit path import it from its
  detected location; the second-run plan reuses the earlier wiring with no collisions and creates only
  presentation files and the index registration; the override plan uses the alternative path in every
  generated reference.
- Execution: `tests/integration/setup.test.ts`, `npm run test:integration` (validator).

### INT-003: Page-entry variant builds, verifies, and is reused
- Covers: presentation-skill — Setup by project type (compatible app and standalone root use a separate
  presentation page without touching host configuration), Reuse of existing pieces (second run, kit without
  the verification protocol), Confirmation before writing (accepted alternative path);
  presentation-verification — Skill self-check target (separate presentation page, missing verification
  protocol), Screenshot helper (separate page).
- Boundary: the bundled `page-entry` assets, the generated `presentation:*` scripts, `tsc`, `vite build`
  and `vite preview` with the presentation config, and the harness in real Chromium.
- Setup: a temporary copy of a compatible-app fixture; `apply.ts --confirmed --no-install` with the
  `page-entry` plan; this repository's `node_modules` symlinked into the copy; a small fixture
  presentation copied in and registered. A second copy uses a plan with an accepted alternative page path.
  A third copy replaces the kit's `PresentationApp` with a fixture that renders presentations but omits
  the verification protocol.
- Action: run the generated `presentation:build`, `presentation:verify`, and `presentation:screenshots`
  scripts in each copy; build the host app with its own config; re-run detection and planning on the first
  copy.
- Assertions: build, verify, and screenshots exit 0 in the first two copies, and verify checks the
  presentation page (its URL path is the page or alternative page) rather than the host page;
  `dist-presentation/` contains the page; the host's `vite.config`, `index.html`, `tsconfig`, and routes
  are byte-identical to before and the host app still builds; the re-run plan reuses the wiring with no
  collisions; in the third copy verify exits 1 with the "does not implement the verification protocol"
  message and no step failures.
- Execution: `tests/integration/page-entry.test.ts`, `npm run test:integration` (validator).

### INT-004: Verification harness detects real failures
- Covers: presentation-verification — Error gate; Functional gate (blank diagram); Repository verify
  command (type error, build failure, failure location); Browser preflight; Screenshot helper; Skill self-check target.
- Boundary: the real `verify.ts` and `screenshot.ts`, Vite build and preview, and Playwright Chromium.
- Setup: `tests/fixtures/harness-app/` with its own Vite config and index registering a presentation that
  logs a console error on step 2, one that throws on step 3, one with a step rendering no entities, a
  clean 8-step presentation, and a type error (step data not matching its scene) and a build error, each
  enabled by an environment variable.
- Action: run `verify.ts --config … --slug <each>`; run with the type error and with the build error
  enabled; run with
  `PLAYWRIGHT_BROWSERS_PATH` pointing to an empty directory; run with invalid arguments; run
  `screenshot.ts` with defaults and with `--steps 1,8 --mode browse --viewport phone`.
- Assertions: exit 1 with the failing step, mode, viewport, and message reported for each faulty
  presentation; exit 1 with the type error output and no browser run for the type error; exit 1 with
  build output and no browser run for the build error; exit 2 with a
  provisioning message for the missing browser; exit 64 for invalid arguments; exit 0 for the clean
  presentation, with only that slug's steps reported; 16 default screenshots at 1440 × 900 and exactly 2
  selected ones at 390 × 844, named by slug, step, mode, and viewport; `git check-ignore` succeeds for
  the output paths.
- Execution: `tests/integration/harness.test.ts`, `npm run test:integration` (validator).

## End-to-End Tests

### E2E-001: Repository verify command on the committed sample
- Covers: presentation-verification — Repository verify command, Error gate, Functional gate;
  presentation-skill — Self-describing sample presentation.
- Surface: `npm run verify`.
- Setup: the repository with dependencies installed and the local Playwright Chromium.
- Journey: build the app, serve the production preview, traverse every sample step forward in browse mode
  with a mode toggle at each step and backward in present mode, at 1440 × 900 and 390 × 844.
- Assertions: exit code 0; no console errors, page errors, or unhandled rejections; every step shows the
  expected marker and title and at least one entity in both modes.
- Execution: `npm run verify`, during implementation and acceptance.

### E2E-002: Viewer behavior in a real browser
- Covers: presentation-viewer — Presentation routes, URL-addressable viewer state, Opening mode, Present
  mode, Browse mode (including a single-step presentation), Step navigation (swipe and tap zones, focused
  controls, modified keys), Mode switching, Responsive layout, Reduced motion; scene-presentation —
  Drawing-area scaling, Invalid presentation display (pending state, throwing scene), Presentation index.
- Surface: the fixture viewer app through its URL, keyboard, pointer, and touch input.
- Setup: `tests/fixtures/viewer-app/` mounted under `StrictMode`, with a dense presentation, a presentation
  with a long title, one declaring present as its opening mode, a single-step presentation, an invalid
  presentation, one whose scene throws on a step, and the index.
- Journey: open the index and a presentation; navigate and use the browser back action; toggle modes by
  key and by tapping the step marker; swipe and tap with touch emulation; open with and without a mode
  in the URL; open an unknown slug, an invalid presentation, and the throwing one; focus the next
  control, a progress segment, and the present-mode step marker and press Space and Enter; press
  Control+Right Arrow and Meta+Left Arrow; repeat layout checks at 390 × 844,
  844 × 390, 768 × 1024, 1024 × 768, 1440 × 900, and 900 × 1440; emulate reduced motion.
- Assertions: no horizontal scrolling at any size; present-mode diagram, marker, and title within the
  viewport with a single-line ellipsized long title; table of contents present only at widths ≥ 1024 px;
  the diagram's rendered box is fully inside its container at every aspect ratio; swipes and tap zones move
  to the expected steps; back returns to the index; document title matches; opening mode follows URL, then
  declared mode, then browse; with reduced motion the next step settles with no running animation;
  invalid presentations show their problem list and no entities; the throwing presentation shows a
  render-failure problem at its step without an uncaught error; a valid presentation shows the pending
  state before its first step with no console errors under StrictMode; the single-step presentation has
  both prev and next disabled; Space or Enter on a focused control activates only that control (exactly one
  step forward from the next control; the step marker switches mode without changing step); modified
  arrow keys leave the step unchanged; unknown slugs show not-found with an index link.
- Execution: `tests/e2e/viewer.spec.ts`, `npm run test:e2e` (validator).

### E2E-003: Fresh bootstrap in an empty directory
- Covers: presentation-skill — Self-contained skill package, Setup by project type (empty directory);
  presentation-verification — Fresh bootstrap test, Skill self-check target.
- Surface: `npm run test:bootstrap`.
- Setup: an empty temporary directory, npm registry access, and `PLAYWRIGHT_BROWSERS_PATH` passed through.
- Journey: plan and apply the full-app setup using only the skill's bundled assets, copy and register the
  sample presentation, install dependencies, build, and run the generated app's `presentation:verify`.
- Assertions: every stage exits 0; the generated app's verify reports the sample as passing; on failure
  the failing stage's output is printed and the command exits nonzero.
- Execution: `npm run test:bootstrap`, during implementation and acceptance (not in the validator because
  it needs network access).

## Acceptance Testing Envelope

- Environments and sandboxes: this container (Node 24, Playwright 1.61.0 Chromium at `/ms-playwright`,
  npm registry reachable); throwaway directories under the system temporary directory for running the
  skill against empty, monorepo, standalone, and compatible-app projects. The acceptance agent may act both
  as the agent executing the skill and as the user answering its confirmation prompts, and may run the
  complete skill workflow from `SKILL.md` there: authoring a new topic, modifying an existing presentation,
  declining a plan, deliberately breaking a generated presentation to exercise the self-check's fix
  attempts and failure report, and performing screenshot review.
- Credentials and secrets: none required; none exist.
- Authorized effects: npm installs into temporary directories (network downloads and disk use), local
  build and preview servers, screenshot files, and deletion of the temporary directories afterward.
- Off limits: downloading Playwright browsers (simulate a missing browser with an empty
  `PLAYWRIGHT_BROWSERS_PATH`); git push or any publishing; global npm or system configuration; running
  `apply.ts --confirmed` against this repository; writing outside this repository and temporary
  directories.
- Permitted substitutes: if the npm registry is unreachable, run build-only checks with a symlinked
  `node_modules` and report the fresh bootstrap as not run rather than passing.
- Known risk areas: the agent not following `SKILL.md` (confirmation, retry limit, screenshot review,
  outcome report), which only an agent-executed run of the skill can reveal; morphing across scene groups; StrictMode double registration; connector attachment
  while nodes move; settling after interrupted navigation; estimated text extents in bounds checks;
  export-statement parsing in scene-kit detection; the dependency compatibility table; `package.json` and
  `.gitignore` merging; path bindings for reused and alternative locations; the fixed settle timer; the Node ≥ 22.18 requirement for
  scripts; `100dvh` and safe areas on mobile; tap versus swipe disambiguation in present mode; the
  Playwright package and browser revision coupling. Accepted limitations: navigation and mode-switch
  failure modes of the harness are covered by unit tests rather than by deliberately broken viewers;
  install-and-build coverage exists only for the empty-directory bootstrap.

## Human-Only Testing

None.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| scene-presentation: Each step defines its full diagram | INT-001 | — | — |
| scene-presentation: Scene groups | INT-001 | — | — |
| scene-presentation: Scene primitives (connectors) | INT-001 | — | — |
| scene-presentation: Custom motion entities | INT-001 | — | — |
| scene-presentation: Transitions between steps | INT-001 | — | — |
| scene-presentation: Drawing-area scaling | — | E2E-002 | — |
| scene-presentation: Invalid presentation display | — | E2E-002 | — |
| scene-presentation: Presentation index | — | E2E-002 | — |
| presentation-viewer: Presentation routes | — | E2E-002 | — |
| presentation-viewer: URL-addressable viewer state | — | E2E-002 | — |
| presentation-viewer: Opening mode | — | E2E-002 | — |
| presentation-viewer: Present mode | — | E2E-002 | — |
| presentation-viewer: Browse mode | — | E2E-002 | — |
| presentation-viewer: Step navigation | — | E2E-002 | — |
| presentation-viewer: Mode switching | — | E2E-002 | — |
| presentation-viewer: Responsive layout | — | E2E-002 | — |
| presentation-viewer: Reduced motion | INT-001 | E2E-002 | — |
| presentation-skill: Self-contained skill package | — | E2E-003 | — |
| presentation-skill: Read-only project detection | INT-002 | — | — |
| presentation-skill: Setup by project type | INT-002, INT-003 | E2E-003 | — |
| presentation-skill: Incompatible dependencies block setup | INT-002 | — | — |
| presentation-skill: Reuse of existing pieces | INT-002, INT-003 | — | — |
| presentation-skill: Confirmation before writing in non-empty projects | INT-002, INT-003 | — | — |
| presentation-skill: Self-describing sample presentation | — | E2E-001 | — |
| presentation-verification: Repository verify command | INT-004 | E2E-001 | — |
| presentation-verification: Error gate | INT-004 | E2E-001 | — |
| presentation-verification: Functional gate | INT-004 | E2E-001 | — |
| presentation-verification: Skill self-check target | INT-003, INT-004 | E2E-003 | — |
| presentation-verification: Browser preflight | INT-004 | — | — |
| presentation-verification: Screenshot helper | INT-003, INT-004 | — | — |
| presentation-verification: Fresh bootstrap test | — | E2E-003 | — |
