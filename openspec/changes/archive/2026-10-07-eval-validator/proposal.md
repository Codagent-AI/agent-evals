## Why

The and-scene automated rubric scores behaviour that the fixture's planning documents require. The implementation validator, however, mostly enforces engineering qualities that those documents never state, and the implementor fixes almost everything it flags. In the stopped no-validator eval (agent-evals#71), automated scores matched the validator-on baseline within noise. A candidate that skips this work currently loses nothing, so the eval cannot show what the validator is worth.

Issue agent-evals#77 catalogues about 290 validator findings from 23 candidate repetitions. It classifies each as (A) already required, (B) not specified but reasonable for a good implementation, or (C) noise. This change scores the class B qualities. A rubric change also keeps the fixture unchanged, so existing runs can be rescored rather than rerun. The issue and its comments hold the full catalogue of findings and the per-run evidence.

## What Changes

- Add an 8-point automated component, "Engineering quality beyond the spec", with sixteen narrow, eval-owned criteria drawn from issue #77's class B qualities. Fourteen are judged by a new focused `engineering-quality` LLM source-review job. Two are new deterministic browser probes:
  - modified arrow keys pass through instead of navigating;
  - a swipe that starts on a control does not navigate.
- Fund the new component by cutting demo technical quality and scene kit correctness from 24 to 20 points each. Their floors drop from 15 to 12.5, keeping the same 62.5% ratio. The 70 automated points, the 100-point total, the 40/70 eligibility threshold, and the reference's shared 92 are unchanged.
- Apply the new component to the reference baseline as well. Technical adjudication therefore replaces five shared components instead of four, candidates run seven focused judge jobs, and the reference runs five source-review jobs.
- Extend the failure second-opinion replay grammar so a key press can hold modifiers and a swipe can start on a selector. Add admitted replay entries for both probes. Refuse, in harness code, any overturn of a modifier-key failure that rests on a prevented default.
- Bump the automated rubric to the next major version after main's at merge time: 13.0.0 if this lands first, 14.0.0 if the eval-the-whole-workflow branch, which also uses 13.0.0, lands first.
- Audit the issue's class A list against the existing rubric, add review guidance to existing criteria where a recurring class A defect is not caught, and record the audit in the change directory.

## Capabilities

### New Capabilities
- `engineering-quality-scoring`: the engineering-quality component, its judge job, its sixteen criteria, and the rule that validator noise and harmful pushes are not rewarded.

### Modified Capabilities
- `product-quality-scoring`: component weights and floors, reference applicability and shared-component adjudication, criterion disposition, and seven candidate judge jobs (five for the reference).
- `failure-second-opinion`: the replay action grammar, admitted replay entries for the two new probes, and the prevented-default overturn refusal.
- `runner-workflow-execution`: the lifecycle runs seven focused product judge jobs.

## Out of Scope

- Rescoring existing runs, including the current baseline and the #71 runs, with `--rescore-from`. That is a separate, paid follow-up. A no-cost arithmetic re-weighting of existing verdicts is in scope.
- A paid `--calibrate` run.
- Fault-injection runs of candidate scripts: an occupied preview port, a bootstrap materialized with a different presentation, or templates built at their destination by the harness.
- Changing the and-scene fixture, its planning documents, or its `.validator` configuration.
- Correcting main's failure-second-opinion spec drift from PR #82, which the runner-evals-strategy session is fixing separately.
- Issue #77's item 10 (settled capture), which is already scored correctly by `visual-helper-settled-screenshots`.
- Issue #77's item 12 (plain bugs), which is scored where it breaks specified behaviour.
- Every class C item.
- The human-review rubric.

## Impact

- `evals/agent-runner/and-scene/automated-rubric.json`: the new component, its sources, the fallback declaration, the cut subcomponent points, the floors, and the version.
- Code and tests:
  - rubric validation, the scorer, and judge jobs and prompts;
  - the deterministic browser probes and their retained observations;
  - the axi browser driver: modifier key presses, swipes that start at an element, and preventDefault instrumentation;
  - the second-opinion replay validator and policy;
  - reports and calibration expectations;
  - tests under `test/`.
- `evals/agent-runner/and-scene/README.md`: floor and component descriptions.
- Judging cost: each run adds one more source-review job under whichever judging protocol the other implementation source-review jobs use at merge time.
- New results aren't directly comparable with rubric 12.x results until those runs are rescored.
- Merges: expect textual conflicts in `lib/judge-jobs.mjs` with `feat/parallel-judge-jobs` and `eval-the-whole-workflow`.
