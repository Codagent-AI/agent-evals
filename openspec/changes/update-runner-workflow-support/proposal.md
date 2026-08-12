# Update Runner Workflow Support

## Why

The and-scene suite pins Agent Runner's implementation workflow at
`workflows/openspec/implement-change-v2.0.yaml`. Agent Runner has since split that workflow: the
OpenSpec file is now a thin wrapper whose only step delegates to
`workflows/core/implement-change-v1.0.yaml`, which supplies the backend-specific artifact directory,
change label, and artifact-validation instruction. Every real step now lives in the core file.

As a result the suite cannot run at all. Its preflight contract check reads the wrapper, finds a single
step named `implement`, and reports all five required final-workflow steps missing, so the evaluation
aborts before Agent Runner starts. Two further defects sit behind that one: the recorded workflow hash
now pins a wrapper that contains none of the behavior it is meant to pin, and the suite's role profiles
name agents the workflow no longer invokes, so a selected acceptance model is silently discarded and
acceptance runs on the `tester` default instead.

None of this is visible from the test suite, which exercises hand-written workflow fixtures and never
reads Agent Runner's real files.

## What Changes

- Invoke `core:implement-change` directly instead of `openspec:implement-change`, and supply the
  OpenSpec-specific `change_dir`, `change_label`, and `artifact_validation_instruction` parameter values
  from the suite alongside the existing `change_name` and `skip_validator`.
- Verify the workflow contract and record workflow provenance against
  `workflows/core/implement-change-v1.0.yaml`, requiring all five parameters and the five required
  final-workflow steps as direct top-level steps.
- Pass every parameter value fully substituted, because a value supplied on the command line is not
  itself interpolated.
- Strip the `sub:` workflow-name prefix from recorded step-path segments before prohibited-step
  matching, so a sub-workflow that merges, closes, archives, releases, or deletes the branch is
  detected rather than shielded by its prefix.
- Map the three role profiles onto the agents the workflow actually invokes: `lead`, `implementor`, and
  `tester`. The suite's role names and command-line flags are unchanged.
- Attribute observed acceptance attempts through the `acceptance-tester` named session rather than a
  `reviewer` agent-call target, and attribute task-implementation attempts by their position beneath
  the task loop rather than by a flat step-name set, because `fix-violations` now occurs both inside
  each task's validator and inside the final validator.
- Require all three role profiles for a new run, matching what the host entry point already enforces.
- Add an opt-in check that verifies the contract against a real Agent Runner checkout when one is
  available, so the next restructuring is reported instead of discovered during a live run.
- Update `run.sh`'s host-side workflow-presence check, `agent-runner-capabilities.json`, and the README
  to match.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runner-workflow-execution`: the pinned workflow identity, its required parameters, the contract and
  provenance source, and prohibited-step matching over recorded step paths.
- `agent-role-configuration`: the agent names the three role profiles resolve to, and how observed
  acceptance attempts are attributed back to the configured role.

## Out of Scope

- Adding a `test-plan.md` to the pinned and-scene fixture or re-pinning the fixture commit. The current
  core workflow makes acceptance test-plan-aware; the pinned fixture has no test plan, and
  `codagent:prepare-acceptance` documents a representative-flow fallback for exactly that case. Changing
  the fixture would change the task being measured and is a separate decision. See `design.md`.
- Migrating the two recorded runs under `results/`. They are historical records of a workflow revision
  that no longer exists.
- Extending the Codagent skill preflight to skills named only by nested sub-workflows. The bootstrap
  check reads the pinned workflow file alone, so `codagent:session-report` — named only in
  `implement-task-v1.0.yaml` — has never been verified. This predates the workflow split and is
  unchanged by it. See `design.md`.
- Supporting the `spec-driven` workflow namespace. The fixture is an OpenSpec change.
- Any change to scoring, rubrics, judging, or the human-review command.

## Impact

- `evals/agent-runner/and-scene/lib/workflow.mjs`: workflow identity, inspection reference, pinned path,
  required parameters, boundary arguments, prohibited-segment matching.
- `evals/agent-runner/and-scene/lib/provenance.mjs`: pinned relative path.
- `evals/agent-runner/and-scene/lib/profiles.mjs`: role-to-agent mapping.
- `evals/agent-runner/and-scene/lib/runner-metrics.mjs`: acceptance attribution and position-based
  task-implementor attribution.
- `evals/agent-runner/and-scene/run.sh`: host-side workflow-presence check.
- `evals/agent-runner/and-scene/agent-runner-capabilities.json`: pinned role names.
- `evals/agent-runner/and-scene/README.md`: workflow references.
- `test/`: fixtures updated to the delegated shape, plus the new opt-in live contract check.

No change to the evaluated product, the rubrics, or the scoring pipeline. Existing `result.json`
consumers see a different `workflow_relative_path` and `workflow_sha256` for new runs.
