# Design

## Context

Agent Runner restructured its change-lifecycle workflows. What was one file is now two:

```
workflows/openspec/implement-change-v2.0.yaml   (wrapper, 1 step)
  params: change_name, skip_validator
  steps:
    - implement  →  ../core/implement-change-v1.0.yaml
                    params: change_name, change_dir, change_label,
                            artifact_validation_instruction, skip_validator

workflows/core/implement-change-v1.0.yaml       (13 top-level steps, plus the per-task
                                                 step nested inside the task loop)
```

Agent Runner's own documentation states the split's intent: *"The shared change-lifecycle workflows
accept an artifact directory and validation instructions; the OpenSpec and spec-driven namespaces
provide those backend-specific values."*

The suite pinned the OpenSpec file. Its preflight contract check now reads a file containing one step
named `implement` and reports all five required final-workflow steps missing, so no evaluation can
start.

## Decision: invoke `core:implement-change` directly

The suite invokes and pins the shared core workflow rather than the OpenSpec wrapper, and supplies the
three backend-specific parameter values itself.

The alternative was to keep invoking `openspec:implement-change` and teach the contract check and
history verification to follow the delegation. That was considered and rejected in favor of the smaller
change.

What this buys:

- The five required steps are top-level steps of the invoked workflow again, so recorded history
  verification continues to work against first-segment step identity with no change. Verified against a
  real `audit.log`: a top-level sub-workflow step emits its own bare `[<step-id>] step_end` entry
  carrying an `outcome`, in addition to the nested entries beneath it.
- The pinned hash covers the file that actually contains the behavior. Pinning the wrapper pinned
  nothing meaningful.
- `agent-runner debug --show-workflow core:implement-change` writes the workflow file's raw bytes, so
  the controller's existing resolved-hash-versus-pinned-hash comparison keeps working once re-pointed.
  Verified: both sides produce `f23e8145129f5dbfd3960bfd74a5d37a9eea8886a771c5e5af295c338c01f36a`.

What it costs, and why it is acceptable:

- **The suite now owns three values Agent Runner's OpenSpec namespace would supply.** `change_dir`,
  `change_label`, and `artifact_validation_instruction` are duplicated into the suite and frozen there.
  If Agent Runner changes them, the suite keeps passing the old values with no preflight error, because
  the suite is now the thing that defines them. This is the real cost of the decision and it is
  deliberate. The values are recorded in the spec so the duplication is intentional and reviewable
  rather than looking like a mistake to the next reader.
- **The suite no longer exercises the entry point a user invokes.** It runs the shared workflow with
  assembled parameters rather than `openspec:implement-change`. The executed step sequence is identical,
  so what is measured is unchanged in substance.

`hidden: true` on the core workflow does not prevent this. It suppresses the workflow from browsing
menus and intake routes only; nothing in the run path rejects a hidden workflow, and
`core:implement-change` resolves normally.

### Parameter values must be passed fully substituted

The wrapper's `artifact_validation_instruction` value contains `{{change_name}}`. That resolves today
because Agent Runner interpolates a sub-workflow's parameter values against the *parent* context before
entering the child (`internal/exec/subworkflow.go:337`).

Invoked directly there is no parent, and `textfmt.Interpolate` is single-pass: it scans the step template
once and does not re-scan substituted text. Passing the wrapper's string verbatim would therefore place a
literal `{{change_name}}` into the agent's prompt, with no error raised — a silent corruption of the
instruction the agent acts on. The suite must substitute the concrete change name before passing the
value. This is easy to hit by copying the wrapper's YAML, so the requirement is stated explicitly in the
spec.

## Decision: role profiles target `lead`, `implementor`, and `tester`

The suite wrote profiles for agents named `planner`, `implementor`, and `reviewer`. Agent Runner has
since canonicalized its roles: `planner` is a deprecated alias for `lead`, and `reviewer` is a
deprecated alias for `crosscheck`.

The consequential half is `reviewer`. The workflow's acceptance session declares `agent: tester`, and
`crosscheck` is never invoked by this workflow. So a selected acceptance profile was written to an agent
the run never used, and acceptance silently ran on the `tester` default. A user passing
`--reviewer-cli codex --reviewer-model gpt-5` got no error and no effect.

The suite's own role names and command-line flags (`lead`, `implementor`, `reviewer` /
`--reviewer-cli`) are unchanged. Only the Agent Runner agent each one resolves to changes. This keeps
the change to the mapping table and avoids churn in the CLI surface, checkpoint fields, and recorded
result keys.

Observed-attempt attribution moves with it. Attribution keyed on an agent call whose `target_name` was
`reviewer`; Agent Runner emits the named session, `acceptance-tester`.

Task-implementor attribution changes shape rather than losing an entry. The current implementation
matches a flat set of step names, which includes `fix-violations`. That step still exists — it is not in
`implement-task-v1.0.yaml` but in the validator sub-workflow that file invokes
(`run-validator-v1.0.yaml:27`, invoked from `implement-task-v1.0.yaml:47`). Matching it by name alone is
now ambiguous, because the same validator sub-workflow runs twice in different role contexts: once
inside each task's validation, which is task-implementor work, and once as the workflow's final
`run-validator` step, which is lead-agent work. A flat name set attributes both to the implementor.

Attribution therefore keys on the recorded structural position — Agent Runner retains a `prefix` on each
metrics attempt (`internal/metrics/collector.go:57-70`) — so attempts beneath the per-task loop are
implementor work and the final validator's remediation is lead work.

## Known risk: the fixture has no test plan

The one substantive behavioral difference between the workflow the suite last ran and the current core
workflow is that acceptance is now test-plan-aware. `prepare-acceptance` gained:

```
- authoritative test plan: `openspec/changes/{{change_name}}/test-plan.md`;

The first pass must exercise every required `AT-*` and every conditional `AT-*` whose activation
condition holds. ... Missing applicable-flow evidence is an impediment, not a limitation, and cannot
produce `ACCEPTANCE_COMPLETE`.
```

Everything else in the diff is parameterization, the two agent renames, and prompt rewording. The step
ids are identical between the workflow the suite last ran and the core file: the same 13 top-level steps
in the same order, plus the same nested per-task step. Direct invocation drops only the wrapper's outer
`implement` delegation step, which does no substantive work.

The pinned and-scene fixture at `729592e921413dea20bd77ccab0284222ef4ad8f` has no
`openspec/changes/create-and-scene/test-plan.md`.

This is assessed as a soft risk. The `codagent:prepare-acceptance` skill documents an explicit fallback:
*"When an approved test plan exists, use its required and activated conditional `AT-*` obligations as
the executable flow inventory... Otherwise derive a concise list of representative user or client flows
from the approved artifacts."* With no test plan there are no `AT-*` obligations, so the "must exercise
every required `AT-*`" rule is vacuously satisfied and the tester falls back to representative flows.

The residual risk is a judgment call by the lead agent: the workflow prompt names an "authoritative test
plan" at a path that does not exist, and the agent may report that as an impediment instead of falling
back. `verify-acceptance-handoff` hard-fails unless the status file reads `ACCEPTANCE_COMPLETE`, so that
outcome would fail the run.

Adding a test plan to the fixture is deliberately out of scope. It requires re-pinning the fixture
commit, which changes the task being measured and further breaks comparability with the recorded
results. Watch this on the first live run; if the lead agent treats the missing plan as an impediment,
handle it as a separate fixture decision rather than by weakening `verify-acceptance-handoff`.

## Known gap left in place: skill preflight is not transitive

`bootstrap-agent-skills.sh` validates that every `codagent:*` skill named by the workflow exists in the
pinned Agent Skills checkout before any model is invoked. It regexes the pinned workflow file only
(`bootstrap-agent-skills.sh:67-70`), so a skill named exclusively by a nested sub-workflow is never
checked. `codagent:session-report` is the live example: it appears in `implement-task-v1.0.yaml:70-73`
and in neither the core file nor the old wrapper.

This predates the workflow split and is unchanged by it — the previously pinned workflow named the same
four skills (`call-agent`, `implement-with-tdd`, `prepare-acceptance`, `push-pr`) and likewise omitted
`session-report`. Closing it requires recursive workflow parsing with cycle protection, which is most of
the work the core-direct decision was chosen to avoid. It is recorded here so the gap is known rather
than rediscovered: a missing `session-report` skill fails during a live run instead of at preflight.

## Why the suite did not catch this

All 690 existing tests pass. They exercise hand-written workflow YAML fixtures; nothing opens Agent
Runner's real files. Agent Runner can restructure freely and this suite stays green until someone starts
a live evaluation and it dies at preflight.

The added contract check closes that gap without making `npm test` depend on a sibling checkout: it
verifies the real pinned workflow when `AGENT_RUNNER_DIR` resolves to a checkout, and skips with an
explicit message otherwise. `AGENT_RUNNER_DIR` already exists in `run.sh` and defaults to
`$EVALS_ROOT/../agent-runner`, so the check reuses the established convention rather than inventing one.

The check reads the workflow file directly. It does not build or invoke Agent Runner, so it stays fast,
hermetic, and offline.
