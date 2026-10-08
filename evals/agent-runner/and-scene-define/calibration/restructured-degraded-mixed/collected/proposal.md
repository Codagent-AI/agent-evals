## Why

A technical explanation often lands best as a single picture that grows while
the speaker talks: shapes arrive, shift, link up, and get renamed as the story
unfolds. Slide decks break that continuity, and hand-animating such a diagram for
every talk is slow and gives uneven results. We want agents to produce these
diagram-driven talks repeatably, starting from nothing more than a subject.

## What Changes

- Introduce a `presentation` agent skill that turns a subject supplied by the
  user into a presentation viewed in a web browser.
- Treat every presentation as one diagram evolving across a sequence of named
  steps. Independent slides are not the model.
- Let the skill get a project ready on its own: when build tooling, the scene
  runtime, or the presentation manifest is absent, the skill installs what is
  absent before it creates or edits a presentation.
- Ship reusable React building blocks, bootstrap templates, and helper scripts
  that the skill draws on each time it produces a presentation, in this
  repository or in any other project it prepares.
- Provide a release check that runs the bundled sample (itself produced by the
  skill) through a compile step and a real-browser render of every step.
- Let viewers edit a presentation visually in the browser (drag entities,
  retype narration) and save the changes back to its source.
- Keep the skill hybrid: `SKILL.md` carries the agent's procedure and its
  definition of done, while the code assets keep output uniform from one
  presentation to the next and the release check enforces its quality bar.

## Capabilities

### New Capabilities

- `scene-runtime`: the topic-independent engine behind every presentation:
  steps, narration, entity continuity, the persistent scene, the fitted canvas,
  and the styling boundary.
- `viewer-controls`: how a viewer moves through a presentation and switches
  between presenting and reading.
- `presentation-authoring`: the skill's brief collection, project readiness,
  creation, editing, and its checks before declaring work done.
- `release-checks`: the bundled sample, the single release-check command, the
  browser render pass, outcome reporting, and step captures for review.

### Modified Capabilities

- None.

## Non-Goals

- Producing PowerPoint or Keynote files, PDFs, or image exports.
- Production hosting, deployment, or publishing pipelines.
- Treating a subjective taste score as the main verification signal.

## Impact

- New skill directory `skills/presentation/` with its procedure and bootstrap
  script.
- New scene runtime, presentation manifest, and bundled sample in
  the app source.
- New scripts behind `npm run release-check` and `npm run capture`.
