## Overview

The repository is a small Vite, React 19, and TypeScript app with a single
plain-CSS page, no router, and no styling framework; `react`, `react-dom`,
`motion`, and `lucide-react` are already dependencies. This design adds four
parts that work together:

- a **scene runtime** that every presentation imports and that knows nothing
  about any particular topic;
- a **`presentation` skill** whose procedure collects a brief, readies the
  project, writes or edits a presentation, and checks its own output;
- a **bundled sample**, produced by the skill, that explains the skill;
- a **release check**, `npm run release-check`, and a capture command for
  visual review.

Specifications: `scene-runtime`, `viewer-controls`, `presentation-authoring`,
and `release-checks`.

## Architecture

```
src/
  main.tsx                    # reads location.pathname; "/" → redirect to the sample, "/<slug>" → lazy entry, else NotFound
  NotFound.tsx                # plain message with a link back to "/"
  presentations.json          # hand-edited manifest: [{ slug, title, entry }]
  scene-runtime/              # canonical runtime source (the only copy humans edit)
    index.ts                  # public surface: Presentation, Positioned, useEntity, primitives, types
    contract.ts               # Step<S>, Chapter, PresentationProps<S>
    Presentation.tsx          # owns the step index and mode; mounts the scene once
    SceneRoot.tsx             # SVG viewBox canvas + ResizeObserver fit; sets data-settled
    continuity.ts             # keyed FLIP for continuing entities; dissolve before reveal
    RevealLayer.tsx           # staggered entrance for newcomers
    input.ts                  # keys, swipe, P/N shortcuts, focus guard, clamping
    chrome/                   # LowerThird, SidePanel, ProgressBar (role="progressbar"), Outline, Attribution, LiveRegion
    primitives/               # Node, Text, Connector, Enclosure, Highlight, Badge
  presentations/
    how-to-make-a-presentation/
      entry.tsx               # <Presentation steps=… chapters=… initialMode="browse" />
      steps.ts, entities.ts
      brief.md, completion-report.md   # provenance of the skill run that produced the sample
skills/presentation/
  SKILL.md                    # procedure and definition of done
  bootstrap.mjs               # generated: embeds every template inline
scripts/
  release-check/index.mjs     # build → sample conformance → render pass → summary
  release-check/sample-outline.json
  release-check/static-server.mjs
  capture.mjs                 # per-step captures and advisory warnings
  sync-templates.mjs          # regenerates bootstrap.mjs from src/scene-runtime
```

### Runtime flow

`Presentation` holds the current index and mode. It renders `SceneRoot` once
and passes `steps[index].state` down; the scene component is never keyed by
step, so React updates it instead of remounting. `continuity.ts` compares the
entity ids of the outgoing and incoming states: continuing ids are animated
with FLIP, dropped ids dissolve and unmount, and only then does `RevealLayer`
stagger in new ids. When every running animation has reported completion,
`SceneRoot` sets `data-settled="true"`; it clears the attribute on the next
change. Chrome reads narration from the current step; a missing `headline` is
derived from the first sentence of `body`.

### Skill procedure (`skills/presentation/SKILL.md`)

1. **Brief**: ask one question per turn for whatever the prompt lacks; derive
   style directions from existing stylesheets; offer "build now" after each
   batch of step answers; optionally sketch pivotal steps in ASCII.
2. **Readiness**: probe the three pieces (build tooling, scene runtime,
   manifest); choose root, `presentations/`, or a plan for approval; run
   `bootstrap.mjs` from the skill's own directory for whatever is missing.
3. **Write**: create `src/presentations/<slug>/` and one manifest entry, or
   make a scoped edit to an identified presentation.
4. **Check**: build, first-step render, capture review, `review-log.md`; repeat
   until clean.

Monorepo detection uses `workspaces` in `package.json`, a
`pnpm-workspace.yaml`, or a `packages/` or `apps/` directory.

## Decisions

1. **Single persistent scene instead of per-step scene groups.** Mounting the
   scene once and feeding it state means every adjacent pair of steps keeps
   entity continuity without authors having to declare which steps belong
   together. *Alternative considered:* grouping steps under a shared key and
   cross-fading between groups; rejected because forgetting a group key
   silently turns a morph into a remount.
2. **Keyed FLIP for continuing entities, dissolve-then-reveal for the rest.**
   Measuring first and last boxes lets an entity keep its DOM node while it
   moves, and separating exits from entrances keeps stale content off the
   stage. *Alternative:* layout-projection by shared layout ids; workable, but
   it couples continuity to one animation library's internals.
3. **SVG `viewBox` canvas.** Letting the browser scale a fixed coordinate space
   guarantees uniform scaling with no reflow and no manual transform maths;
   `foreignObject` keeps HTML text possible. *Alternative:* a CSS transform
   computed per mode from constants; rejected because constant geometry drifts
   when chrome sizes change.
4. **Styling through a slot class map, never through defaults.** A single
   `classNames` map gives presentations one obvious place to style every
   runtime element while keeping the runtime free of visual decisions, so it
   cannot become an accidental design system. *Alternative:* shipping a
   default theme with overridable tokens; rejected because defaults leak into
   every presentation.
5. **Generic primitives.** `Node`, `Text`, `Connector`, `Enclosure`, `Highlight`,
   and `Badge` take a stable id and slot classes and know nothing about any
   topic, so any presentation can compose them; `Positioned` and `useEntity`
   cover shapes the primitives do not. *Alternative:* topic-specific node
   components per talk; rejected because they tie the runtime to one talk.
6. **Hand-edited JSON manifest and a pathname switch.** One manifest line per
   presentation keeps registration explicit and reviewable in diffs, and a
   twenty-line switch in `main.tsx` avoids adding a routing library.
   *Alternatives:* `react-router` (extra dependency for one level of routes);
   glob-based discovery (registration changes without a visible diff).
7. **Hybrid skill.** `SKILL.md` describes the procedure and definition of done;
   the runtime, `bootstrap.mjs`, and the release-check scripts make output
   consistent and checkable across presentations. *Alternative:* a prompt-only
   skill; rejected because every run would reinvent the runtime.
8. **Puppeteer and headless Chrome over the production bundle.** A real browser
   on the built output executes layout, SVG scaling, and animation exactly as
   viewers see them, which a simulated DOM cannot. *Alternative:* a jsdom test
   that mounts each step component; faster, but blind to layout and motion.
9. **ARIA progressbar as the tooling interface.** Reading `aria-valuemax` and
   `aria-valuenow` from `role="progressbar"` lets the render pass and capture
   command count and track steps through an accessibility contract that also
   serves screen-reader users, without depending on markup structure.
   *Alternative:* bespoke test-only attributes, which serve no viewer.
10. **One generated bootstrap script with enforced parity.** The canonical
    runtime lives in `src/scene-runtime/`; `scripts/sync-templates.mjs`
    regenerates `bootstrap.mjs` from it and records a content hash of every
    embedded file. A unit test and the release check fail when any hash differs
    from the canonical source, so bootstrapped projects cannot silently receive
    a runtime that differs from the repository's. Embedding the templates also
    removes any need to look templates up at run time. *Alternative:* the app
    importing the runtime from the skill directory; rejected as an unusual
    layout for contributors.
11. **Icons as components from `lucide-react`.** Adding a glyph is one import
    and no SVG authoring; the package is already a dependency.
12. **`P` toggles mode and the sample opens in browse mode.** A single key
    makes switching quick for speakers, and the sample is mostly read alone, so
    browse is its better starting point.

## Risks and Mitigations

- **`foreignObject` text rendering differences between browsers.** The render
  pass runs in Chrome; captures at two sizes catch clipping early.
- **Puppeteer download size in CI.** Cache the browser between runs; the cost is
  accepted for a faithful render.
- **Monorepo detection is a heuristic.** The plan-approval step in non-empty
  projects lets the user correct a wrong target before anything is written.
- **Self-check time inside the skill.** The skill runs the build and first-step
  render on every iteration and the capture review once the build is clean,
  and never reports success with a failing check.
- **Process leaks when the release check is interrupted.** The server and
  browser are tracked and stopped in a `finally` block and in `SIGINT` and
  `SIGTERM` handlers.

## Rollout

1. Add Puppeteer; keep the runtime free of styling frameworks.
2. Build `src/scene-runtime/` and its tests.
3. Add `main.tsx` routing (with `/` redirecting to the sample), `NotFound.tsx`,
   and the manifest.
4. Write `skills/presentation/SKILL.md`, `scripts/sync-templates.mjs`, and the
   generated `bootstrap.mjs`.
5. Run the skill on the sample brief to produce the sample; commit its output,
   brief, and completion report.
6. Add `scripts/release-check/` and `scripts/capture.mjs` with their npm
   scripts, then run `npm run release-check`.

Reverting the branch removes everything; there is no data to migrate.

## Open Questions

- Whether the skill should be named `presentation` or something longer is
  undecided; renaming the directory is cheap.
- The exact list of monorepo signals may be extended during implementation; the
  placement behavior is fixed.
