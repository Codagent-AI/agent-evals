## Context

The suite clones the and-scene fixture at `f0695b9`, which holds the full `create-and-scene` change including `tasks.md` and `tasks/01-03`, and runs `agent-runner run core:implement-change`. The harness hard-codes that workflow in several ways:

- **Delivery evidence:** it requires the final steps `run-validator`, `open-draft-pr`, `verify-draft-pr`, `prepare-acceptance`, and `verify-acceptance-handoff` at `verify-change > sub:verify-change > <step>`.
- **Validator mode:** it checks the mode from the `run-validator` outcome.
- **Prohibited actions:** it scans recorded step names for merge or archive steps.
- **Roles:** it attributes them by step position, through `TASK_LOOP_PREFIX` and the `acceptance-tester` session.

Issue #87 moves the starting line to the definition artifacts and runs planning before implementation. These decisions are settled:

- **Runner composite:** Agent Runner gets a hidden built-in, `core:plan-and-implement-change`, that composes `core/plan-change` and `core/implement-change`. One run means one run id, one resume target, and one `run-metrics.json`.
- **Opaque workflow:** the harness has no knowledge of workflow steps. The evaluated workflow is an input; the harness relies only on the workflow's logical reference, declared parameters, and named skills.
- **Crosscheck role:** crosscheck is an explicit fourth role, because task review calls a fresh `crosscheck` agent.
- **Cost:** every invocation in the evaluated run counts toward the total. Nothing in the harness treats planning and implementation as distinct; the plan/implement structure belongs to the current default workflow and is expected to go away.
- **Fixture:** a new and-scene fixture commit removes the tasks.
- **Definition edits:** no check that the candidate left the definition unchanged. Instead, judging reads approved requirements from the recorded fixture commit, so an edited definition cannot change what the candidate is judged against. Today it does not: `materializeNeutralInputs` reads the requirements bundle from the candidate's final SHA (`lib/neutral-source.mjs:247`). Testing-evidence coverage and the assumption-handling omission check consume that bundle (`lib/evidence.mjs:1625`, `:1682`). This change fixes that.
- **Validator mode:** the baseline's Validator mode and the fixture base are decided together after the #78 task-compliance decision.

## Workflow interface

Any evaluated workflow must:

- resolve through `agent-runner debug --show-workflow <ref>`;
- accept the parameters `change_name`, `change_dir`, `change_label`, `change_kind`, `artifact_validation_instruction`, and `skip_validator`;
- finish with a successful Agent Runner run status;
- leave the delivery outputs the eval already requires:
  - a clean committed candidate on `eval/and-scene/<run-id>`;
  - a draft PR with a non-empty base at the same head;
  - acceptance flow evidence and screenshots;
  - findings history;
  - the final acceptance handoff;
  - the assumptions ledger.

The acceptance artifacts must be under the Runner session's `output/` directory, which is the only discovery anchor (`lib/evidence.mjs:593`). They must match the suite's evidence role registry (`EVIDENCE_ROLE_REGISTRY`, `lib/evidence.mjs:16`): its roles, accepted names, and formats. Repository files enter only through references from those artifacts, at the delivered revision. A change-v3 workflow becomes evaluable by satisfying this interface; it needs no harness code. If it uses different artifact names, the change is to the registry's accepted conventions, not to step knowledge.

**Minimum for any future candidate:** a branch at a recorded head built from the pinned fixture commit, plus the total cost and duration. That is all a later plain Claude Code or vendor-native baseline would need to provide. Runner-specific evidence, such as acceptance artifacts, per-role attribution, and step rollups, is extra detail for Runner runs. The existing reference-baseline path, which marks Runner-only components and roles not applicable, is the precedent such a baseline would extend.

## Harness approach

- **Removing step knowledge:**
  - Delete `REQUIRED_FINAL_STEPS`, the verify-change delegation check, `finalStepPrefix`, `lastLeafStep`'s step-name prefix assumption, and the final-Validator outcome check from `lib/workflow.mjs` and `lib/state-machine.mjs`.
  - Record the requested logical reference, such as `core:plan-and-implement-change`, and separately the expected Runner-reported name: the `name` declared by the resolved definition, such as `plan-and-implement-change`.
  - Source-run discovery, `classifyRunnerRun`, resume, and metrics ingestion (`controller.mjs:1703`, `lib/runner-metrics.mjs:1050`) compare against the expected name, never against a run's own reported name.
  - The harness still treats the Runner run as one opaque unit for start, wait, resume, and continue.
  - Keep recording every observed step and outcome as data in provenance and reports. Just don't interpret it.
- **Workflow and Validator fields:**
  - `result.workflow.workflow` holds the logical reference, and `workflow.provenance` records the resolved-definition hash. Fill `workflow_path` with that same hash, so baseline identity distinguishes workflow versions without a file path.
  - `task_level_compliance` and `final_validator` are derived from the requested mode, so the existing baseline identity fields keep working.
- **Delivery:** `lib/candidate.mjs` delivery verification checks the run status, branch, PR metadata, and artifacts.
  - The publication-boundary check uses observable final state only: draft state, PR state, branch existence and head, and the change directory still present. Today's code already checks this much (`lib/candidate.mjs:832`).
  - It can't see reversed effects or releases, and the result says so.
  - When branch or PR observations are unavailable, report an evaluation-harness failure.
- **Roles:** `lib/runner-metrics.mjs` attributes roles from the recorded agent (`role` in `run-metrics.json`, which Runner sets from the step's agent profile or the `call_agent` target).
  - Agent Validator attempts stay under the Validator role and link to their invoking attempt through Runner attribution.
  - Delete `TASK_LOOP_PREFIX`.
  - `and-scene-define/lib/runner-metrics.mjs` already handles `kind: 'agent-call'` attribution.
- **Preflight:** `assertPlanningReadyFixture` in `lib/candidate.mjs` inverts its task checks. It requires the definition artifacts, rejects any task artifact, and keeps the `fixture-planning-contract` code.
  - Keep its existing test-plan checks.
- **Crosscheck:** add `crosscheck` in four places, following `--crosscheck-*` in `evals/agent-runner/and-scene-define/controller.mjs`:
  - `ROLE_AGENTS` in `lib/profiles.mjs`;
  - the rendered eval config;
  - the roles in `agent-runner-capabilities.json`;
  - the `run.sh` and controller options.
  Emit the crosscheck auth mount in role order `lead`, `crosscheck`, `implementor`, `tester`.
- **Cursor lead:** the planning lead now calls `call_agent` in task review, and nothing has shown that Cursor can make that call in the sandbox. `--proof-browser` and `--dry-run` launch no planning agent, so neither can prove it. The harness rejects a `cursor` lead before model execution, as the define suite already restricts its lead. Lifting that restriction needs a focused Cursor-to-crosscheck integration check, which is a follow-up.
  - Agent Factory still accepts Cursor profiles under Docker. A Cursor lead is then rejected by this suite's preflight before any model call.
- **Quota recovery:** `lib/claude-quota.mjs` treats the `acceptance-tester` session name as evidence of Claude identity and of the tester role, and its role mapping omits crosscheck (`:7`, `:66`).
  - Base identity on the recorded CLI or provider and the recorded agent.
  - Add crosscheck.
  - Keep attribution unknown when the agent is not recorded.
  - Test renamed sessions, crosscheck quota events, and a misleading session name with no Claude identity.
- **Skills bootstrap:** keep the existing transitive scan of `codagent:*` names from the resolved workflow files. Plan adds `codagent:plan-tasks`, `codagent:review-tasks`, and `codagent:call-agent`.
- **Legacy rescores:** `lib/rescore.mjs` calls the step-dependent `checkWorkflowHistory` and requires old history fields (`:60`, `:147`). Imported profiles pass through ordinary role validation (`controller.mjs:393`). The rescore boundary imports arguments without workflow identity (`controller.mjs:407`).
  - Make the rescore import preserve the source's workflow identities, fixture commit, profiles, and provenance.
  - Validate imported profiles against the roles the source recorded, so a three-role source passes without an invented crosscheck.
  - Skip the definition-only fixture preflight.
  - Verify delivery from the retained completion record through the same outcome-based checks.
  - Test both a retained-session source and a reconstructed-evidence source, without starting Agent Runner.
- **Pinned requirements:** change `materializeNeutralInputs` to read the requirements bundle from the evaluated change at the recorded fixture commit. Keep reading product source from the final SHA. Route testing-evidence coverage and the assumption-handling omission check through the same pinned bundle.
  - Test a candidate that deletes a scenario, one that weakens wording, and one that adds a requirement.
  - Open PR #93 changes `lib/evidence.mjs` and `lib/rescore.mjs` but not the `Controlled scoring and rubric provenance` requirement modified here. Rebase onto it if it merges first.

## Fixture preparation

1. **Choose the base.** Paul chose to cut the fixture on `f0695b9` without waiting for #78. If #78 keeps task-compliance review, the fixture is re-cut on that base and re-pinned. The new baseline's Validator mode is chosen when the baseline runs.
   - **Base:** `f0695b9` on `eval/fixture-baseline-scrub`, or `eval/fixture-task-compliance` if #78 adopts it.
   - Under task-compliance, the Validator compares the implementation with tasks the same run wrote. That measures something different from #78's hand-written tasks, so #78's verdict may not carry over directly.
   - With `--skip-validator`, task-compliance never runs and the fixture base makes no difference.
2. **Make the fixture commit.** In `/Users/paul/codagent/and-scene`, create the branch `eval/fixture-definition-only` from the base. Make one commit, `chore: start the fixture from definition artifacts`, that:
   - deletes `openspec/changes/create-and-scene/tasks.md` and `openspec/changes/create-and-scene/tasks/`;
   - in `AGENTS.md` "Source of Truth", replaces the `tasks/` bullet with a `` `openspec/changes/create-and-scene/test-plan.md`: testing obligations `` bullet;
   - replaces "Read the proposal, design, canonical specs, and all task files before editing. Treat the canonical specs as authoritative when task summaries are less detailed." with "Read the proposal, design, canonical specs, and test plan before editing. Treat the canonical specs as authoritative.";
   - keeps the following "Keep implementation work inside the repository." sentence.
   - A second commit, `chore: tell candidates not to add ci configuration`, adds a "Change Guidelines" bullet that forbids CI configuration such as `.github/workflows/`. The eval's GitHub credentials cannot push workflow files, and smoke attempt 1 failed at the draft PR after its plan added CI.
   - The pinned result is `ba19a6a` on `eval/fixture-definition-only`, the commit the passing smoke run used.
3. **Change nothing else.** At `f0695b9`, only those `AGENTS.md` lines refer to tasks: `CLAUDE.md` contains only `AGENTS.md`, and `.validator/config.yml` and `README.md` mention none. Repeat that search on the chosen base.
4. **Check the definition passes planning.** Run `workflows/core/validate-planning-artifacts.sh` with `require_tasks=false` at the Runner commit to be evaluated, and confirm it passes without repair.
   - At Runner `main` `46b92af`, `f0695b9` with the tasks removed printed "Change 'create-and-scene' is valid".
   - A failing check would make the planning lead rewrite the definition. Scoring would still use the pinned definition, but the run would waste planning effort.
5. **Pin the commit.** Push the branch, then pin its commit everywhere the fixture is pinned:
   - `FIXTURE_REF` in `run.sh`, as both the default and the `--help` text;
   - `controller.mjs`, `README.md`, and `fixture-snapshot/snapshot.json`;
   - `test/and-scene.test.mjs`.
   Regenerate the snapshot with `tasks.md` removed from `fixture-snapshot.mjs`'s `DOCUMENTS`.

## Risks and trade-offs

- **Publication check covers final state only.** Effects reversed before completion, and releases, are not detected. The result discloses this.
- **Rescores change for older runs.** A rescore of an earlier run now reads requirements from that run's fixture commit rather than its final SHA. Candidates in those runs rarely edited specs, but a rescore can differ from the original score for that reason, and the comparison should note it.
- **Validator mode is trusted, not verified.** Without step knowledge, the harness can't prove the workflow honored `skip_validator`; it records the requested mode. The Runner change specifies that behavior and its tests cover it.
- **Cross-repository ordering.** Agent Factory fetches agent-evals `main` at admission, and `run.sh` will require `--crosscheck-*`. The landing order:
  1. Agent Runner `plan-and-implement-change` merges first.
  2. This change merges with its fixture commit.
  3. Agent Factory `eval-crosscheck-role` is deployed immediately, with no eval admitted in between.
  Claims admitted before step 2 froze an older harness commit and keep passing three roles.
- **Moved baseline.** Scores from this starting line aren't comparable with earlier `core:implement-change` results. A new three-repetition baseline follows. Three repetitions is a starting point, not a statistical-power claim: generated tasks add variance on top of judging noise.
