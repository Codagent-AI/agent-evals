## Why

The first `and-scene` implementation established a product-centered evaluation, but its initial benchmark exposed a browser-mode defect and stopped before the final Validator, draft PR, and acceptance workflow needed to judge a complete implementation. The suite now needs a corrected end-to-end evaluation that scores implementation quality from trustworthy final-revision evidence while preserving the earlier reference and failed candidate results as historical diagnostics.

## What Changes

- Run the exact versioned `workflows/openspec/implement-change-v2.0.yaml` workflow through completion on a unique `eval/and-scene/<run-id>` candidate branch from the pinned fixture commit, retaining `--skip-validator` only as control of task-level compliance checks rather than as a stop boundary.
- Create candidate branches and draft PRs on the configured fixture origin, and require a clean committed candidate, a draft PR with a non-empty base, matching local and PR heads, final Validator results, and complete acceptance, findings, handoff, and assumptions evidence before scored product judging.
- Persist and verify the fixture, Agent Runner revision, profiles, workflow arguments, branch, PR, final SHA, and evidence hashes across resume; preserve candidate branches and draft PRs for diagnosis and documented manual cleanup.
- Correct deterministic browser evaluation so it preserves the initial presentation mode, explicitly selects the mode required by each probe, and does not treat intentionally hidden presenter-mode captions as missing.
- Use verified candidate-produced acceptance evidence as the primary workflow-testing record while keeping independent deterministic checks and evaluator-produced evidence in a separate namespace; cross-check candidate claims against independent evidence and score material contradictions against testing-evidence quality.
- Rebalance the official 100-point score to 24 demo, 24 scene kit, 7 presentation skill, 7 verification tool, 4 testing evidence, 4 assumption handling, and 30 human review; run six focused scored judge jobs while retaining the non-scoring ambiguity ledger.
- Keep the 70-point pass threshold, 15-point demo and scene-kit floors, 15-point human floor, prohibition on any human rating of 1, and existing hard gates; add no independent floor for testing evidence or assumption handling.
- Evaluate the reference out of 92 with testing evidence and assumption handling marked not applicable, without rescaling or assigning it an official candidate pass/fail verdict, and report a separate candidate-versus-reference comparison on the shared 92 points. Require calibration to award the reference all 62 applicable automated points and open every hard gate before benchmark cutover.
- Provide product judges a neutral source snapshot stripped of Git metadata, remotes, branch names, PR identity, baseline labels, OpenSpec change identity, and evaluation markers. Validate candidate evidence as a coherent provenance chain terminating at the final evaluated PR SHA, allowing a trustworthy earlier full-flow baseline plus final targeted or evidence-only verification when the change impact is explicitly bounded.
- Treat CI status only as candidate-produced acceptance evidence: the harness does not independently query CI or use CI availability as a prerequisite for scored judging.
- Treat a reproducible candidate-owned inability to build or serve as a conclusive product failure rather than a harness failure, preserving available component and hard-gate evidence without fabricating an official score or human ratings.
- Extend JSON and HTML results with applicability and denominator data, candidate branch and draft PR identity, final PR SHA, acceptance-evidence provenance, evidence ownership, and the shared-92 comparison.
- Expand calibration and regression coverage for workflow evidence, assumptions, missing judge output, browser modes, revision identity, baseline arithmetic, and previously fixed Runner streaming, failure-detail, run-identity, and process-identity behavior.
- Recreate the local reference baseline and run a completely fresh candidate evaluation under the corrected rubric, complete both through the separate human-review command, and publish only the finalized candidate report with its shared-92 comparison.

## Capabilities

### New Capabilities

- `testing-evidence-evaluation`: Verification, separation, traceability, consistency checking, scoring, and reporting of candidate-produced acceptance evidence and evaluator-produced evidence through a provenance chain that terminates at the final evaluated revision.

### Modified Capabilities

- `runner-workflow-execution`: Replace the pre-acceptance stop boundary with complete `implement-change-v2.0` execution, reserved candidate branch and draft-PR lifecycle requirements on the configured fixture origin, final revision identity, acceptance handoff, and stronger resume provenance.
- `product-quality-scoring`: Adopt the 24/24/7/7/4/4/30 rubric, six focused scored judge jobs, corrected criterion allocation, unchanged candidate pass gates and floors, and the non-rescaled, comparison-only 92-point reference contract.
- `evaluation-metrics-reporting`: Record component applicability and denominators, candidate branch and PR provenance, final SHA, acceptance evidence, evidence ownership, and shared-92 comparison in JSON and HTML reports.
- `ambiguity-evaluation`: Add a scored assumption-handling component while retaining the detailed ambiguity ledger as a separate non-scoring diagnostic that cannot mutate benchmark specifications automatically.
- `evaluation-outcomes`: Require completed workflow, final Validator results, draft-PR identity, and acceptance evidence before scored product judging begins, require all judge outputs before an official scored candidate result can be finalized, and distinguish conclusive product-owned build or serve failures from harness failures.

## Technical Approach

Extend the suite-owned controller and its durable checkpoints to follow one candidate identity through the complete Agent Runner workflow and subsequent evaluation. Candidate-produced acceptance artifacts enter a verified evidence namespace and form a provenance chain to the final PR SHA; independent deterministic checks and harness captures enter an evaluator namespace; focused judges consume only neutral source and the evidence appropriate to their component.

```text
pinned fixture → candidate branch → complete implement-change-v2.0
      → draft PR + final SHA + Validator + acceptance evidence
      → deterministic checks + six focused judges
      → separate human review
      → candidate /100 + shared-92 reference comparison
```

Keep scoring policy, evidence verification, applicability arithmetic, and report assembly deterministic and suite-owned. Continue using the existing separate human-review workflow for the authoritative 30-point visual assessment rather than adding another subjective automated review.

## Out of Scope

- Changing the existing 13-question human-review rubric or replacing literal human review with an automated visual judge.
- Rescaling the 92-point reference result to 100 or awarding reference points for inapplicable workflow components.
- Automatically closing candidate branches or draft PRs after evaluation.
- Automatically changing fixture requirements from ambiguity-ledger findings.
- Reusing the damaged historical candidate run or treating the earlier 67/70 reference result as the revised benchmark.
- Adding a shared evaluation framework or third-party runtime dependencies.

## Impact

- Affects the `evals/agent-runner/and-scene/` controller, workflow integration, browser driver and deterministic checks, rubric and scorer, judge orchestration, evidence capture and validation, calibration, result schema, HTML reporting, tests, and runbook.
- Changes the existing OpenSpec contracts for workflow execution, product scoring, metrics and reporting, ambiguity evaluation, and outcomes, and adds a testing-evidence evaluation contract.
- Depends on Agent Runner's complete `workflows/openspec/implement-change-v2.0.yaml` workflow, draft-PR and acceptance artifacts, final Validator results, stable run identity, and GitHub credentials with permission to push branches and manage draft PRs on the configured fixture origin.
- Produces and preserves externally visible `eval/and-scene/<run-id>` branches and draft PRs for diagnosis; the runbook owns their manual retention and cleanup policy, while evaluated product infrastructure remains in the Agent Runner repository.
- Adds no third-party runtime dependency and does not alter the archived `make-evals-great` change or its historical results.
