## Why

The `and-scene` suite measures implementation from a reviewed fixture change. The define-only suite (change `eval-the-whole-workflow`) measures how well the interactive define workflow turns a short prompt into artifacts. Neither answers the question users actually face: **given only a short request, does the complete Codagent workflow deliver a better product than raw Claude Code?**

Every current comparison is between Codagent configurations. There is no control showing what a user would get from Claude Code planning, implementing, and validating the same request without Agent Runner, Agent Validator, or Codagent skills. There is also no measurement of how requirement discovery during definition carries through planning, implementation, and acceptance into the delivered product.

This change is deliberately sequenced after the define-only suite. It reuses that suite's simulated user, hidden-reference inventory, isolation boundary, and Agent Runner external-user mode, and adds the product-level comparison. It is a proposal only and is not implemented in the same change as the define-only suite.

## What Changes

- Add a **from-prompt end-to-end evaluation** that starts from the define-only suite's pinned prompt and history-free starting repository and grades the delivered product against the hidden reference.
- **Two arms under matched conditions:** the same starting input, simulated user, sandbox image, external tools, and Claude model and effort for every evaluated role and session.
  - **Codagent arm:** `openspec:change` runs from creation through `accept`, with lead, crosscheck, implementor, and tester profiles all on the matched Claude configuration, and Agent Validator enabled.
  - **Control arm:** raw Claude Code in two sessions. An interactive plan session with the simulated user is followed by an autonomous implement session. Plain written instructions say how to validate the change. It has no Agent Runner, Agent Validator, or Codagent skills.
  - The comparison is reported as the effect of the complete Codagent bundle. Per-stage effects are left to later variants.
- **Simulated user across the lifecycle.** It answers definition questions and acceptance assumption-resolution questions from the hidden reference.
  - At every other acceptance gate (human review and test, re-acceptance recommendation) it gives an approval explicitly recorded as *simulated, without product testing*, and requests no refinements.
  - The eval's own later human review remains the real human review.
- **Common delivery contract.** Both arms deliver a final commit that the eval builds, serves, and judges through the same product pipeline.
  - Process evidence that only Agent Runner produces (Validator outcomes, acceptance records, handoff, assumptions ledger) is collected where present and marked not applicable to the control. It never counts as a control failure.
- **Product scoring against hidden requirements.** A versioned from-prompt scoring profile with explicit eligible criteria, points, totals, gates, floors, and pass threshold, calibrated independently of the implement-only rubric.
  - Product criteria map to the hidden-reference inventory. Mandatory items are graded, acceptable alternatives are graded by intent, and preferences are excluded.
  - Judges read requirements from the pinned hidden reference, never from the candidate's own specifications.
  - Raw per-criterion results are reported alongside the score.
- **Discovery through to delivery.** The define-only suite's discovery ledger is extended to record, for each hidden requirement, whether it was implemented.
- **Metrics.**
  - The Codagent arm's cost and time cover the whole workflow, from `run-metrics.json`.
  - The control arm's usage comes from Claude Code's structured output.
  - Simulated-user and judge usage are eval-owned.
  - Results and reports identify mode and arm, and from-prompt results form a series separate from implement-only results.

**Open decision: process-evidence components.** Today's `testing-evidence` and `assumption-handling` components (8 of 70 automated points) are judged from Runner acceptance artifacts. Either:
- **(a) product-only scoring.** Exclude them from the from-prompt score for both arms and report them as diagnostics where evidence exists.
- **(b) arm-neutral redefinition.** Score them for both arms from evidence any workflow can produce, such as the candidate's own tests or assumptions stated in the repository or PR.

## Capabilities

### New Capabilities
- `from-prompt-evaluation`: the end-to-end mode, covering starting input, arm selection, parity rules, and the ordered lifecycle for each arm.
- `control-arm-execution`: the raw Claude Code plan-then-implement arm, its validation instructions and tool parity, and its delivery contract.

### Modified Capabilities
- `simulated-user` (from `eval-the-whole-workflow`): add acceptance-phase handling and labelled simulated approvals.
- `requirement-discovery-diagnostic` (from `eval-the-whole-workflow`): add implementation status per hidden requirement.
- `runner-workflow-execution`: run `openspec:change` through `accept` using the external-user mode, with provenance and the workflow contract for the define, plan, implement, and accept sub-workflows.
- `agent-role-configuration`: add crosscheck and control-arm profiles and the matched-configuration rule for paired runs.
- `product-quality-scoring`: add the from-prompt scoring profile against the hidden reference.
- `rubric-fixture-traceability`: map product criteria to hidden-reference inventory items and their classification.
- `testing-evidence-evaluation`: derive the requirement inventory from the hidden reference in from-prompt mode, and apply the open-decision outcome.
- `ambiguity-evaluation`: classify spec gaps relative to the hidden reference in from-prompt mode.
- `human-review-workflow`: add arm identity, eligibility, and final-score applicability for from-prompt runs.
- `evaluation-metrics-reporting`: add whole-workflow cost scope, the control-arm usage source, eval-owned simulated-user usage, and mode and arm labelling.
- `evaluation-outcomes`: add failure outcomes for definition, planning, and control-arm phases and for contaminated runs.

## Technical Approach

- **Extends `and-scene`.** The judged product is the same, so the end-to-end mode reuses fixture pinning, browser checks, product judges, human review, and publication. The simulated user, inventory, and isolation come from the define-only suite, and are extracted for sharing only where both suites need identical behavior.
- **One interaction channel for both arms.**
  - The Codagent arm reaches the simulated user through Agent Runner's external-user mode.
  - The control arm uses an eval-owned turn loop around headless Claude Code sessions run through `sandbox-run.sh -- <command>`.
  - Neither arm gets a richer or poorer user.
- **Delivery.** Both arms commit to a history-free starting repository. The eval collects the final commit for building and judging, with no dependency on a fixture-repository branch or PR that would expose hidden history.
- **Key risks.**
  - The control arm's results depend on its written validation instructions, which must be fair rather than minimal.
  - Whole-workflow runs cost more and take longer, so conclusions need repetitions.
  - Simulated acceptance approvals mean the Codagent arm's acceptance refinements are exercised only through assumption resolution.

## Out of Scope

- The define-only suite, simulated user, inventory, isolation, and the Agent Runner external-user mode; all are delivered by `eval-the-whole-workflow` and its Agent Runner prerequisite.
- Stage-ablation variants, such as plan-only or implementation without a task file.
- Control arms on CLIs other than Claude Code.
- Running `archive` or `finalize` in the Codagent arm.
- Evidence-based simulated acceptance testing of the product.
- Changing the implement-only mode's behavior, rubric scores, or historical results.

## Impact

- **Suite code:** `evals/agent-runner/and-scene/`:
  - `run.sh` and `controller.mjs`: mode, arms, and profiles.
  - `lib/candidate.mjs`: the history-free starting repository and the planning-contract precondition bypassed for this mode.
  - `lib/workflow.mjs`: the whole-workflow contract.
  - `lib/neutral-source.mjs` and `lib/evidence.mjs`: the hidden requirement source and arm-specific evidence.
  - `lib/judge-jobs.mjs`, `lib/rubric.mjs`, `lib/scorer.mjs`, and `score.mjs`: the from-prompt scoring profile.
  - `lib/runner-metrics.mjs` and `lib/cost.mjs`: whole-workflow and control-arm usage.
  - Human-review and reporting updates.
  - New control-arm modules and tests.
- **Rubric data:** a from-prompt scoring profile mapped to the hidden-reference inventory.
- **Specs:** the new and modified capabilities listed above.
- **Dependencies:**
  - The completed `eval-the-whole-workflow` change and Agent Runner's external-user mode.
  - No new third-party runtime dependencies.
- **Users:** maintainers gain a bundle-versus-raw-Claude comparison and a separate end-to-end results series.
