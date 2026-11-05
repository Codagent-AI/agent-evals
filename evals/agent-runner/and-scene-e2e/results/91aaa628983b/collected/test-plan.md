## Coverage Strategy

Specifications remain the source of unit-test requirements (resolver, validation rules, geometry, key
map, URL parsing, sync detection and similar pure logic). This plan records only additional
integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only
obligations.

All obligations below run in the default `npm test` (and therefore in the validator), not in a separate
command. They require Chromium; a missing browser fails them rather than skipping them. They are
Vitest tests that drive the Playwright library and the real verification library, CLI and bootstrap
script.

Integration and end-to-end test files run serially (Vitest `fileParallelism: false` in a dedicated
project) because several of them build or preview the same checkout; tests that need their own output
use isolated project copies. Each test owns cleanup of the preview servers, browsers and evidence
directories it starts. All new files, including those under `tests/`, are covered by a TypeScript
project that the validator's `npx tsc -b --noEmit` reaches.

Not planned: tests of `SKILL.md` text (prompt content; its behaviors are exercised in acceptance),
automated parsing of `.validator/config.yml` (acceptance runs the validator instead), cross-browser,
performance, and CI-pipeline tests.

## Integration Tests

### INT-001: Bootstrap into a fresh project and verify a presentation there
- Covers: `presentation-authoring-skill` "Bootstrap into a project lacking the scene kit" (Fresh Vite project, Project already has the kit); `presentation-scene-kit` "Presentation host" (Unknown id, Gated host in an existing app) and "Independence from the host application's styles"; `presentation-verification` "Snapshot drift check" (Consumer project).
- Boundary: the real `skills/presentation/bootstrap.ts`, the template snapshot, the target project's `package.json`, entry file, global CSS and Vite build, `vite preview`, and Chromium.
- Setup: copy `tests/fixtures/scratch-app/` (a minimal Vite + React + TypeScript app with realistic global CSS: padded `main`, flex-centered `body`) to a temp directory, symlink this repository's `node_modules` into it, and give the bootstrap access only to `skills/presentation/template/` (never `src/`). Add one healthy presentation. Record the scratch app's own page layout (element boxes at its normal URL) before bootstrapping.
- Action: run the bootstrap with `--skip-install`, run the project build and preview, open the preview, then run `verifyPresentations` on the project. Run the bootstrap a second time.
- Assertions: the scratch app's own page still renders at `/` with the same layout as before bootstrapping; `?presentation=<id>` shows the host and the presentation, and at 360×640 the diagram fits with labels at 12px or larger despite the global CSS; an empty or unknown `presentation` value lists the available presentations; the entry file contains the gate; `package.json` gains the verification script and dependencies; the second bootstrap run changes no file; the healthy presentation passes every check; the snapshot check is reported as not applicable and does not fail the run.
- Execution: Vitest integration test under `tests/`, run by `npm test`.

### INT-002: Bootstrap refusals
- Covers: `presentation-authoring-skill` "Bootstrap into a project lacking the scene kit" (Unsupported project, Entry cannot be wired, Existing kit differs from the snapshot).
- Boundary: the real `bootstrap.ts` against real temp directories on the filesystem; no browser.
- Setup: three temp projects: a non-Vite project, a Vite project whose kit files differ from the template, and a Vite project whose entry file does not match the standard shape.
- Action: run the bootstrap on each.
- Assertions: the non-Vite project is left unchanged and the message says the project type is unsupported; the differing-kit project is left unchanged and the output names the differing files; the non-standard-entry project gets no edit to the entry file and the output prints the exact lines to add.
- Execution: Vitest integration test under `tests/`, run by `npm test`.

### INT-003: Snapshot sync and drift detection against real files
- Covers: `presentation-scene-kit` "Template snapshot stays in sync" (Drift detected, Sync restores agreement); `presentation-verification` "Snapshot drift check" (Drift fails verification).
- Boundary: the real `sync-presentation-template.ts` and the verification library's snapshot check over a temp copy of the real canonical sources and the real template directory.
- Setup: copy the canonical sources and `skills/presentation/template/` to a temp directory.
- Action: run `--check`; modify a canonical file, delete a template file, add an extra template file and run `--check`; delete the whole template directory and run the verification library's snapshot check; run sync; run `--check`.
- Assertions: the initial check passes; after changes it fails and names the modified, missing and extra files; with the template directory removed the check fails because the expected snapshot is missing (a project with a template directory is a canonical-source project); after sync the check passes; `src/presentations/**`, tests, fixtures and the sync CLI are never copied into the template.
- Execution: Vitest integration test under `tests/`, run by `npm test`.

### INT-004: The verifier detects known defects
- Covers: `presentation-verification` "Detects known defects" (Broken presentations fail, Faulty viewers fail), "Data validation", "Browser rendering checks" (Healthy presentation, Small label detected, Caption leaking into Present), "Scene correctness checks" (Wrong scene detected, Stale geometry detected, Teleporting element detected, History-dependent scene detected), "Verification command" (One presentation fails, New presentation is picked up).
- Boundary: the real verification library, the real build, `vite preview` and Chromium over a bootstrapped scratch project (as in INT-001).
- Setup: bootstrapped scratch project plus one healthy presentation. Data faults come from presentations under `tests/fixtures/presentations/`: overlap, missing caption, duplicate id plus overlap, and an invalid reference. Renderer faults come from test-only patches in `tests/fixtures/mutations/` applied to the scratch project's copy of the kit, never to `src/`: keep the previous scene (stale and history-dependent), draw an element at its previous position while its metadata is correct, reduce the label font size, render the caption in Present mode, and make moved elements jump without transition. Each mutation is applied to a fresh scratch copy.
- Action: run `verifyPresentations` over the project for each data fault and each mutated viewer, then add one more healthy presentation and run it again.
- Assertions: each fault fails exactly the check intended to catch it and no other presentation's result changes; every failure names presentation, check, step, viewport and mode (and, for geometry, the expected and observed positions); the duplicate-id-plus-overlap presentation reports both problems in one run; the unmutated healthy run passes; the data fixtures are not discovered in the project's normal presentations directory; the added presentation is checked without any configuration change.
- Execution: Vitest integration test under `tests/`, run by `npm test`.

### INT-005: Verifier environment failures
- Covers: `presentation-verification` "Build check" (Build fails, Build passes), "Browser unavailable".
- Boundary: the real verification library with a real failing project build, and a forced unavailable browser.
- Setup: a scratch project with an intentional type or build error; a healthy scratch project run with the browser executable path set to a non-existent file.
- Action: run `verifyPresentations` in each.
- Assertions: the build failure is reported as the failed check with its errors, and no browser check runs; the missing-browser run exits unsuccessfully with a message that names the missing browser and the `npx playwright install chromium` command, and reports no browser check as passed or skipped.
- Execution: Vitest integration test under `tests/`, run by `npm test`.

### INT-006: Isolated dependency and install test
- Covers: `presentation-authoring-skill` "Bootstrap into a project lacking the scene kit" (Fresh Vite project: dependencies installed, verification command available).
- Boundary: the real bootstrap including its package-manager install and browser provisioning step, in a project with only its own manifest, and the copied verification CLI.
- Setup: copy `tests/fixtures/scratch-app/` to a temp directory with its own `package.json` and lockfile and no symlinked `node_modules`; use a pre-provisioned Chromium when available, otherwise allow the download. Network access to the npm registry is authorized.
- Action: run the real bootstrap without `--skip-install`, then run the copied `npm run verify:presentations` from the project with one healthy presentation.
- Assertions: the install uses the package manager detected from the lockfile; all dependencies the kit and CLI need are declared in the project's manifest (the run succeeds with no repository `node_modules` on the resolution path); the verification command passes on the healthy presentation.
- Execution: Vitest integration test under `tests/`, run by `npm test`; expected to add roughly a minute and to need registry access.

## End-to-End Tests

### E2E-001: Viewer journey in this repository's built app
- Covers: `presentation-scene-kit` "Presentation host", "Step navigation", "Present mode", "Browse mode", "Mode switching", "URL state", "Animated transitions", "Responsive and readable scaling" (Narrow Browse, Resize), "Accessible controls".
- Surface: the built and previewed app served from this repository (`/` and `/?presentation=…`), driven in Chromium through the Playwright library using the sample presentation.
- Setup: `npm run build` then `vite preview` on a free port; a fresh browser context per case.
- Journey: open `/`; open the sample; step with each key in the key map including Home, End and Shift+Space; press a Ctrl combination; focus a step button and press Space; swipe left; toggle mode; jump via the outline; reload; press Back; load a URL with `step=99` and an unknown mode; load an unknown presentation id; move one step that relocates an element with and without reduced motion; resize the window; repeat the Browse view at 360×640; show Present mode at 1280×400.
- Assertions: `/` lists the sample and an unknown id shows a "not found" message with the list; the default is Browse on step 1; each key moves to the expected step; Ctrl combinations do nothing; Space on a focused button advances exactly one step; boundaries disable previous and next; swipe advances; `P` switches mode and keeps the step; Present shows no caption text anywhere on the page; the outline marks the current step and a jump goes to that step; reload restores step and mode; Back leaves the presentation; a bad step shows step 1 and a bad mode shows Browse; a DOM node marked before a step that moves it is the same node afterwards, and with motion enabled its on-screen position is sampled at least once strictly between the start and end positions before settling at the correct end position; with reduced motion the stage is settled immediately; the caption is in a live region and changes with the step; after resize the step is unchanged and the diagram fits; at 360×640 the caption, outline and controls are reachable and none overlaps the diagram; at 1280×400 in Present mode the whole diagram and the controls are visible with no vertical or horizontal scrolling.
- Execution: Vitest end-to-end test under `tests/`, run by `npm test`.

### E2E-002: The verification command through its public entry point
- Covers: `presentation-verification` "Verification command" (All presentations pass, One presentation fails), "Failure details and evidence", "Sample is verified".
- Surface: `npm run verify:presentations` executed as a subprocess.
- Setup: this repository; and a bootstrapped scratch project containing one broken fixture and one healthy presentation.
- Journey: run the command in this repository; run it in the scratch project.
- Assertions: in this repository the exit code is 0 and the output reports the sample as passed, per presentation and per check; in the scratch project the exit code is non-zero, the failing presentation, check, step, viewport and mode and the observed-versus-expected detail are in the output, the healthy presentation is still reported as passed, the output contains a screenshot path, that file exists, and `git check-ignore` confirms it is ignored.
- Execution: Vitest end-to-end test under `tests/`, run by `npm test`.

## Acceptance Testing Envelope

- Environments and sandboxes: this repository checkout; Vite dev and preview servers on localhost; headless Chromium through the Playwright library (a pre-provisioned browser is an acceptable substitute for downloading one); `chrome-devtools-axi` for interactive inspection; scratch project directories under the operating system's temporary directory.
- Credentials and secrets: none are needed or exist.
- Authorized effects: network access to the npm registry and the Playwright download host to install packages and Chromium, at no cost, with cleanup by deleting temporary directories and `verification-output/`; running the presentation skill with a real agent inside a scratch project, which is how the skill's behaviors that only a real run can show are exercised (asking about unspecified details, honoring "you decide", name collision handling, the three-attempt fix loop, honest failure and "verification could not run" reports, bootstrap into a fresh project).
- Off limits: committing or pushing; writes outside this repository and temporary directories; network hosts other than the npm registry, the Playwright download host and localhost; editing canonical sources during acceptance (report defects instead of fixing them).
- Permitted substitutes: if Chromium cannot be installed or provisioned, use `chrome-devtools-axi` for interactive checks, and record that the automated browser checks did not run.
- Known risk areas: font metrics that differ across machines (label size, clipping and collision checks); the entry-file wiring heuristic for non-standard entries; the short stage on portrait phones (about 155 px tall at 360 px wide) in Present mode; Node's native type stripping and the relative `import.meta.glob` behaving identically in dev, build and preview; Space handling when a button is focused; Back-button behavior with `replaceState`; label-capacity limits on dense scenes; mid-transition timing; inherited global CSS from a project's own app leaking into the viewer; wide, short windows; group nesting and reference-rule edge cases. The mandatory validator gate has no automated test, so acceptance runs the validator (or its configured commands) and confirms that a failing presentation fails it.

## Human-Only Testing

None.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| Bootstrap into a project lacking the scene kit | INT-001, INT-002, INT-006 | — | — |
| Gated host in an existing app | INT-001 | — | — |
| Independence from the host application's styles | INT-001 | — | — |
| Template snapshot stays in sync / Snapshot drift check (both roles) | INT-001, INT-003 | — | — |
| Data validation, Browser rendering checks, Scene correctness checks | INT-004 | — | — |
| Detects known defects | INT-004 | — | — |
| Verification command (pass, fail, new presentation) | INT-004 | E2E-002 | — |
| Build check | INT-005 | — | — |
| Browser unavailable | INT-005 | — | — |
| Failure details and evidence | INT-004 | E2E-002 | — |
| Sample is verified | — | E2E-002 | — |
| Presentation host (list, unknown id) | INT-001 | E2E-001 | — |
| Step navigation, Present mode, Browse mode, Mode switching | — | E2E-001 | — |
| URL state | — | E2E-001 | — |
| Animated transitions | — | E2E-001 | — |
| Responsive and readable scaling (including wide and short) | INT-001, INT-004 | E2E-001 | — |
| Accessible controls | — | E2E-001 | — |
