# Harden Deterministic Browser Judging

## Why

A criterion-by-criterion audit of the five published `and-scene` runs scored under
automated rubric 3.10.0 and 3.11.0 found thirteen deterministic browser deductions.
Every one of them was a harness defect rather than a product defect, and two of them
failed hard gates and produced a conclusive product-fail verdict.

Three root causes recur:

- The evaluator asserted **implementation shape** rather than observable behavior. It
  required one non-normative per-control selector spelling, one directional-control
  hook, one English accessible-name pattern, and one `aria-current` value. Candidates
  that exposed the same behavior through equivalent accessible semantics were failed.
- The evaluator asserted **design choices the fixture never states**. Browse mode was
  required to show the active step title rather than the deck title, to show a table of
  contents, and to show previous and next controls simultaneously at a boundary
  position. None of that is in the candidate-facing brief, and all of it is already
  judged by `mode-browse-reading-focused` and by human-review item 6.
- The evaluator could not be **audited after the fact**. A probe artifact records a
  one-line rationale and no observation, so adjudicating a single deduction required
  reconstructing the driver source as of the run date. Adapter diagnostics also leaked
  into candidate evidence: a `chrome-devtools-axi` "Could not find Google Chrome
  executable" message was recorded as a page console error and as an unregistered route,
  failing both the `verification-sample-outline` and
  `verification-every-produced-step-renders` hard gates on a run whose other twelve
  probes drove that exact route successfully.

## What Changes

- Judge `demo-route-and-registration` by reachability. Landing-page link discovery
  becomes a recorded observation, and an adapter diagnostic in the route list is a
  harness failure rather than a product deduction.
- Classify `chrome-devtools-axi` channel, executable-path, and usage-help output as
  browser infrastructure diagnostics so it can never enter candidate failure evidence.
- Normalize candidate evidence exactly once, so retained text is no longer
  double-escaped, and guard against a probe returning non-array evidence.
- Compare normative titles and captions after Unicode punctuation and whitespace
  normalization.
- Stop deriving a scene identity from the document path or from an unrelated attribute.
  An undeclared scene identity is recorded as undeclared, and the evolving-scene verdict
  rests on entity persistence instead of a comparison that always agreed with itself.
- Record a bounded observation for every probe: viewport, mode, step index and count,
  title, caption, chrome visibility, discovered controls, and the selector that matched
  each role.
- Accept `aria-current="true"` alongside `aria-current="step"`.
- Change modes through the presentation's own exposed mode control, falling back to the
  `p` key only when no control is discoverable.
- Narrow `demo-browse-mode-behavior` and `demo-present-mode-behavior` to mechanically
  provable facts, and move `canvas-uniform-scaling` to LLM source review.

## Impact

- Affected specs: `product-quality-scoring`
- Affected code: `lib/browser-eval.mjs`, `lib/axi-browser-driver.mjs`,
  `lib/browser-diagnostics.mjs`, `automated-rubric.json`
- Automated rubric version 3.12.0 → 4.0.0. Point allocations, criterion identifiers, and
  component floors are unchanged, but deterministic verdict semantics changed, so
  deterministic subcomponent scores are not comparable across the boundary.
