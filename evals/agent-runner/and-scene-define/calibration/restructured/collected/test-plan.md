## Approach

Unit tests follow the specifications directly for isolated logic: the step
contract and headline derivation, continuity diffing, input handling and
clamping, canvas fitting, manifest parsing, readiness probes, and template hash
parity. They are not listed individually here. This plan lists the checks that
need real files, child processes, a real browser, or an agent following the
skill. All of them run against disposable copies, publish nothing, and incur no
paid effects.

## Integration Checks

### IC-1: Bootstrap script prepares a fresh project
- Requirements: Project readiness; Scaffold placement (standalone); styling ownership; template parity.
- Setup: Run `skills/presentation/bootstrap.mjs` by absolute path from a working directory outside the repository, targeting a new temporary directory, then install from the generated lock data.
- Checks: `npm run build` succeeds; the three pieces are detected by the readiness probes; React, ReactDOM, Motion, lucide-react, Vite and its React plugin, TypeScript and type packages, the ESLint configuration, and Puppeteer are installed; no styling framework, default colors, fonts, or theme tokens exist; every embedded runtime file hashes identically to `src/scene-runtime/`.
- Runs on: every pull request.

### IC-2: Readiness probes ignore cosmetic differences
- Requirements: Project readiness (probe-based detection); Scaffold placement (partial).
- Setup: Fixture projects with (a) all pieces under unusual file names and formatting, (b) build tooling only.
- Checks: (a) the skill's readiness step adds nothing and leaves files byte-identical; (b) only the runtime and manifest are added and the build tooling files are unchanged.
- Runs on: every pull request.

### IC-3: Capture command produces settled images and warnings
- Requirements: Step captures for review.
- Setup: A test presentation with an unmarked text/chrome collision, an overlap inside `data-overlap-ok`, an indistinct current segment, and an unstyled attribution link.
- Checks: one image per step, each written after `data-settled="true"`; warnings name the collision step and elements, the indistinct chrome, and the attribution slot; none for the marked overlap; exit status 0 despite warnings.
- Runs on: every pull request with Chrome available.

## Release-Check Tests

### RC-1: The sample passes
- Requirements: Release-check command; Bundled sample; Browser render pass; Outcome and cleanup.
- Journey: `npm run release-check` in a clean checkout.
- Checks: the whole app builds; the sample is in the manifest and its nine chapters, headlines, and bodies match `sample-outline.json` in order; the server, readiness probe, and browser URLs all use `127.0.0.1`; all nine `aria-valuenow` values are observed with no console or page errors; the summary reads `PASS` and the exit status is 0.
- Runs on: every pull request.

### RC-2: Each failure is reported precisely
- Requirements: Release-check command; Bundled sample (missing sample); Browser render pass (error and stall); Outcome and cleanup.
- Journey: Run the release check on separate throwaway copies containing a type error, a removed sample, a reordered sample step, a console error on step 6, and a step whose forward key does not advance.
- Checks: each copy exits non-zero with `FAIL` naming the failed check, and for browser faults the step number; the missing-sample case names the sample; after every run, including one interrupted with `SIGINT`, no server or browser process it started remains.
- Runs on: every pull request with Chrome available.

### RC-3: Sample provenance is present
- Requirements: Bundled sample (produced by the skill).
- Checks: the sample directory contains `brief.md` and `completion-report.md`, and the report lists the files that match the committed sample.
- Runs on: every pull request.

## Agent-Run Acceptance

### AR-1: Brief collection and preparation in two kinds of project
- Requirements: Collecting the brief; Project readiness; Scaffold placement; Creating a presentation; Checks before declaring done.
- Setup: An empty directory, and a non-empty monorepo that has only build tooling. Give a subject, a look, and some of the steps; leave the rest undescribed.
- Steps: Invoke the skill in each project; answer one question at a time; take "build now" with steps still undescribed; in the monorepo, review and approve the plan; open the resulting routes.
- Expected: the skill asks rather than invents; placeholders marked `TODO` appear for undescribed steps; the empty project is prepared at the root; the monorepo gets a self-contained `presentations/` app after plan approval, with its root files untouched; each presentation is styled in its own CSS Module, built, rendered, and reviewed (with `review-log.md`) before success is reported.
- Evidence: transcripts, the approved plan, changed-file lists, check output, and captures of first, last, and densest steps at both sizes.
- Effects: local files and processes only, inside disposable directories that are removed afterwards.

### AR-2: Coexistence and focused edits
- Requirements: Creating a presentation (existing presentations survive); Editing a presentation.
- Setup: A prepared app with two presentations.
- Steps: Create a third; then ask to change "the presentation" without naming it, pick one when asked, and request a visible change.
- Expected: no readiness work is repeated; both original presentations still load; the skill lists candidates before editing; only the chosen presentation and its review log change; checks run before completion.
- Evidence: before/after diffs, route checks, transcript, captures of the edited step.

### AR-3: Viewing the sample
- Requirements: Step sequence; Step narration; Entity continuity; Persistent scene instance; Styling ownership; Attribution link; Fitted canvas; Viewing modes; Moving between steps; Sequence ends.
- Setup: Serve the production bundle on `127.0.0.1`; drive it through `chrome-devtools-axi` at 1440 × 900 and at 390 × 844.
- Steps: Navigate with each key, swipe, progress segments, and outline; try to go before step 1 and past step 9; focus the mode switch and press `Space`; switch modes on step 5 in both directions; press `N` in present mode; resize the window during a transition.
- Expected: navigation never wraps and edge cues appear; focused controls keep their keys; the step survives mode switches; the scene root node is unchanged across navigation; continuing entities keep their nodes, dropped entities leave the document before newcomers appear; `aria-current` and announcements match the current step; the diagram scales without reflow; attribution is legible and linked; the current step is visibly distinct; no content collides with chrome at either size.
- Evidence: accessibility snapshots, node-identity observations, step-index log per input method, and settled captures.

### AR-4: Repair before completion
- Requirements: Checks before declaring done; Step captures for review.
- Setup: A presentation seeded with a build error, an accidental collision, indistinct current chrome, weak attribution, and one deliberate legible overlap.
- Steps: Ask for a small edit and let the skill run its checks to completion.
- Expected: no success report while a check fails; the build error is fixed and checks rerun; accidental issues are fixed; only the deliberate overlap is marked `data-overlap-ok`, with its reason in `review-log.md`.
- Evidence: transcript, failing and passing check output, warnings before and after, final diff.

## Human-Only Testing

None.

## Coverage Matrix

| Specification area | Unit | IC | RC | AR |
| --- | --- | --- | --- | --- |
| Step sequence, narration, continuity, persistent scene, fitted canvas | yes | — | — | AR-3 |
| Styling ownership and attribution | yes | IC-1, IC-3 | — | AR-3, AR-4 |
| Viewing modes, moving between steps, sequence ends | yes | — | — | AR-3 |
| Collecting the brief | — | — | — | AR-1 |
| Project readiness and scaffold placement | yes | IC-1, IC-2 | — | AR-1, AR-2 |
| Creating and editing presentations | — | — | — | AR-1, AR-2 |
| Checks before declaring done | — | — | — | AR-1, AR-4 |
| Release-check command, bundled sample, render pass, outcome and cleanup | yes | — | RC-1, RC-2, RC-3 | — |
| Step captures for review | — | IC-3 | — | AR-4 |
