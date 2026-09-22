# Design

## Where each judgment belongs

The deterministic evaluator answers only mechanically provable questions about the
running demo. Anything that depends on a design choice the fixture does not state
belongs to a judge that already owns it.

| Question | Owner before | Owner after | Why |
|---|---|---|---|
| Does browse mode show the step title or the deck title? | `demo-browse-mode-behavior` | `mode-browse-reading-focused` (LLM), human item 6 | The brief states no preference; both readings are defensible. |
| Must a table of contents be visible? | `demo-browse-mode-behavior` | same as above | Responsive by design in at least one audited candidate. |
| Must previous and next both be visible at step 1? | `demo-browse-mode-behavior` | same as above | Hiding versus disabling a boundary control is a design choice. |
| Is the present-mode title *prominent*? | `demo-present-mode-behavior` | `mode-present-title-focused` (LLM), human item 6 | The probe measured visibility and called it prominence. |
| Does the canvas fit uniformly at 64×64? | `canvas-uniform-scaling` (deterministic) | `canvas-uniform-scaling` (LLM source review) | A 64×64 viewport is not a real presentation viewport; uniform-fit intent is readable in source. |
| Is the route reachable? | link scrape plus reachability | reachability | The scrape punished a router-registered route that the landing page does not link. |

The narrowed deterministic probes still fail a demo that genuinely lacks browse mode, a
caption, a reachable step, or an active step title in present mode.

## Discovery stays semantic, and says what it matched

Control discovery already tries presentation-owned hooks, then a semantic progress
region, then accessible names. The remaining defect is that a failure to discover is
indistinguishable from an absent control. Every probe therefore records the selector or
strategy that matched each role, so a zero-control observation is attributable to the
page or to the evaluator without a replay.

## Evidence is normalized once

`bounded()` collapsed control characters and whitespace, HTML-escaped, and truncated in
one step, and was applied both when a failure was collected and again when it was cited.
The result was `&amp;#39;` in retained evidence. The two concerns are now separate:
`normalizeEvidence()` collapses and truncates and is idempotent, and `bounded()` escapes
for a rationale or a report. Retained artifacts hold normalized text; escaping happens
once, at the emitting edge.

## Infrastructure never becomes candidate evidence

`isBrowserInfrastructureDiagnostic` is an allowlist and stays narrow, but it now covers
the adapter's own usage help and executable-path lines, which arrive on the same stderr
as the channel message it already matched. A probe that observes one raises a resumable
harness failure instead of deducting a point.

## Compatibility

Criterion identifiers, point allocations, subcomponent identifiers, and component floors
are unchanged, so stored results remain readable and the scorer is untouched. Only
`scene-fixed-canvas-uniform-fit` changes evaluator, which moves one criterion from the
deterministic set to the `scene-kit` judge job. The rubric major version records that
deterministic verdicts before and after are not comparable.
