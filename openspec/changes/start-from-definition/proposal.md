## Why

The `and-scene` suite starts from a fixture that already contains hand-written tasks (`tasks.md` and `tasks/*.md`) and runs only `core:implement-change`. Task planning is therefore never evaluated. The suite also cannot compare the current plan-then-implement workflow with its likely successor: a change v3 workflow built on the orchestrated implement-change skill, which starts from the same definition artifacts.

The harness compounds this by encoding one workflow's internals. It requires named final steps at fixed step paths, verifies the Validator mode from a step outcome, scans step names for prohibited actions, and attributes agent roles by step position. Any other workflow would need a harness rewrite before it could be evaluated.

Moving the starting line to the definition artifacts (proposal, design, specs, and test plan), and making the harness treat the evaluated workflow as opaque, gives evaluation coverage end to end. The define suite evaluates definition, and this suite evaluates everything after it, for whichever workflow is selected (GitHub issue #87).

## What Changes

This change is one of three coordinated changes. They land in this order:

1. **Agent Runner**: change `plan-and-implement-change` in `Codagent-AI/agent-runner` adds the hidden built-in `core:plan-and-implement-change`. It runs `core/plan-change`, then `core/implement-change`, as one run. `plan-change` gains an optional `skip_validator` parameter.
2. **Fixture and this suite** (this change):
   - A new `Codagent-AI/and-scene` fixture commit removes the hand-written tasks.
   - This suite pins that commit and becomes workflow-agnostic.
3. **Agent Factory**: change `eval-crosscheck-role` in `Codagent-AI/agent-factory` passes the new crosscheck role. Deploy it immediately after this change merges (see design).

Changes in this repository:

- **Fixture and starting line:**
  - Pin a new and-scene fixture commit whose evaluated change holds only definition artifacts.
  - Preflight requires the proposal, design, test plan, and specs, and rejects any `tasks.md` or `tasks/`.
  - Refresh the fixture snapshot without `tasks.md`.
- **Selectable, opaque workflow:**
  - The evaluated workflow is a harness input, `--workflow <logical-ref>`, defaulting to `core:plan-and-implement-change`.
  - The harness knows only three things about it: its logical reference, its declared parameters, and the `codagent:*` skills its files name.
  - It records the Agent Runner commit, the CLI version, the workflow reference, and the hash of the definition Agent Runner resolves for it.
- **Outcome-based delivery:** delivery is verified from four things: Agent Runner's completion status, the candidate branch, draft pull-request metadata, and the produced acceptance artifacts. No named step, step path, or step outcome is required.
  - Prohibited actions (ready, merge, close, archive, release, branch deletion) are detected only from observable state.
  - The Validator mode is recorded as requested and is no longer verified from a `run-validator` step outcome.
- **Pinned requirements for judging:** judges and evidence checks read approved requirements from the recorded fixture commit, never the candidate's final commit. Today the neutral requirements bundle comes from the candidate, so a candidate that weakens a spec is judged against its own version.
- **Legacy rescores:** evaluator-only rescores keep the source's recorded workflow, fixture, three role profiles, and provenance. They need no crosscheck profile, no new fixture preflight, and no live Runner.
- **Final-state publication check:** prohibited actions are verified only as far as final state shows them, and the result says so.
- **Agent-based role attribution:** roles come from the Agent Runner agent that `run-metrics.json` records for each attempt (`lead`, `crosscheck`, `implementor`, `tester`), not from step position.
- **Fourth role:** require an explicit crosscheck profile, `--crosscheck-cli/-model/-effort`. It is recorded wherever the other role profiles are.
  - A `cursor` lead is rejected before model execution until Cursor agent calls are verified.
  - Quota recovery identifies Claude and the role from recorded CLI and agent, not from session names.
- **Cost:** every agent invocation in the evaluated run counts toward the cost total. The existing per-step rollup is unchanged.
- **New series:** results from the new starting line form a new series. Their recorded workflow and fixture commit differ from earlier results.
- **Docs:** update the README, the runbook in `AGENTS.md` (including the `--skip-validator` note, which says the harness requires an explicit skipped Validator outcome), and the `run.sh --help` text.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `runner-workflow-execution`: changes in this capability:
  - workflow selection and provenance;
  - workflow arguments and the requested Validator mode;
  - the definition-only fixture starting line;
  - outcome-based delivery and publication-boundary checks;
  - a parameter-only regression check.
  It removes the requirements that hard-coded `core:implement-change` and its named steps.
- `agent-role-configuration`: a required crosscheck profile; attribution by recorded agent; recorded identity.
- `product-quality-scoring`: the neutral requirements bundle, and every judge that consults approved requirements, use the recorded fixture commit.
- `evaluation-outcomes`: workflow failure no longer depends on a mode-consistent Validator step outcome.
- `evaluation-metrics-reporting`: the cost total covers the whole evaluated workflow run, and the result records the requested Validator mode.

## Out of Scope

- **Scoring:** no change to the automated or human rubric, gates, or criteria. No criterion cites the task files. Judging changes only where it reads approved requirements.
- **Plain and vendor-native baselines:** a plain Claude Code baseline and a vendor-native baseline on the same definition are planned follow-ups. This change keeps Runner-specific evidence out of the harness's workflow contract so they stay possible, but it does not build a non-Runner candidate path. The design records the minimum a candidate must provide.
- **Cross-workflow comparison:** comparing workflows (for example, the current workflow against change v3) is not done through baseline admission or `--allow-mismatch`. A later compare step will pair series by fixture commit and rubric.
- **Factory workflow selection:** an eval-request key that selects the workflow in Agent Factory.
- **Plan descriptors:** recording plan descriptors (task count, task-review findings) per repetition.
- **History-free fixture:** the deleted tasks remain in fixture git history, the same exposure the reference implementation already has through the repository's other branches.
- **New baseline run:** running the new three-repetition baseline. It follows this change, after the variance follow-up and the #78 task-compliance decision.
- **Other suite:** the `and-scene-define` suite.

## Impact

- **Suite code:** `evals/agent-runner/and-scene/`, mainly:
  - `run.sh` and `controller.mjs`;
  - in `lib/`: `workflow.mjs` (the hard-coded final steps, `lastLeafStep`, `finalStepPrefix`, and `classifyRunnerRun`), `candidate.mjs`, `provenance.mjs`, `profiles.mjs`, `runner-metrics.mjs` (`TASK_LOOP_PREFIX` and position-based roles), `checkpoint.mjs`, `state-machine.mjs`, `pins.mjs`, `rescore.mjs`, `neutral-source.mjs`, `evidence.mjs`, and `claude-quota.mjs`;
  - the Agent Skills bootstrap, `agent-runner-capabilities.json`, the fixture snapshot, the README, and the report.
- **Tests:** tests that pin the workflow name, final steps, step paths, fixture SHA, task fixtures, or three roles.
- **Callers:** `run.sh` gains required `--crosscheck-*` options and an optional `--workflow`.
  - Callers passing only three roles break until Agent Factory is updated.
  - The default workflow requires an Agent Runner checkout that contains `core:plan-and-implement-change`.
- **Fixture:** requires a new `Codagent-AI/and-scene` commit (see design).
- **Coordination:** open PR #93 also edits `run.sh`, `controller.mjs`, `lib/evidence.mjs`, and `lib/rescore.mjs`. Expect merge conflicts. It does not modify the requirements this change modifies.
