# Tasks

Implement on the change's feature branch. The task must leave `npm run check` green.

- [ ] 1. Simulated-user corrections of stated exclusions and contradictions, with scoring, ledger, trace, and diagnostics in both suites

These are not implementor tasks. They run after this task:

- the exploratory acceptance pass, under the envelope in `test-plan.md`, including:
  - the paid `policy-test.mjs` run;
  - the paid correction audit stability run;
  - the paid fidelity check;
  - the optional define rescore;
- `openspec archive` of this change. It must follow the archive of PR #152's `end-to-end` change.

## Task 1: Correct stated exclusions and contradictions; give corrected items partial credit

### Goal

Do the following in both `and-scene-define` and `and-scene-e2e`:

- **Policy.** Let the shared simulated user correct an agent statement that explicitly excludes, or directly contradicts, the intent of a private requirement, when that statement was unsolicited. Keep it silent about omissions. Never correct a different mechanism, value, name, size, route, layout, or sample. Keep answers to asked questions and replies to offered options and defaults as they are on PR #152.
- **Audit.** Have the disclosure-audit panel settle `corrected` items and report-only `over-correction` flags.
- **Scoring.** Give a corrected item half its coverage points: the fraction is declared in the rubric, possible points are unchanged, and the item's verdict is unchanged. Exempt corrections from fidelity.
- **Outputs.** Show corrected items in the discovery ledger, the e2e requirement trace, results, and reports.
- **Diagnostics.** Extend the policy diagnostic, and add a correction audit stability diagnostic.

### Precondition

This change builds on PR #152 (`end-to-end`, head `aa3583c` at definition time). None of the files named below exist on `main` until #152 merges.

- Start from `main` after #152 has merged, or from the `end-to-end` branch if #152 is still open.
- If #152's final head differs from `aa3583c` in any file named below, follow the final code. Re-check that the copied `MODIFIED` text in this change's `simulated-user` and `requirement-delivery-trace` specs still matches #152's final requirement text, apart from this change's edits.
- If #152 has neither merged nor been made available as a base, stop and report. Do not re-implement #152.

### Sources of truth

Read these first. They are normative; this section only orients you.

- **Specs** in `openspec/changes/feature-165-c684d025/specs/`:
  - `simulated-user/spec.md`: Disclosure policy, Disclosure audit, Decision policy, Simulated-user policy tests, and Reply check (MODIFIED); Correction audit and Correction audit stability diagnostic (ADDED).
  - `definition-artifact-scoring/spec.md`: Requirement coverage and Fidelity.
  - `requirement-discovery-diagnostic/spec.md`: Discovery ledger.
  - `requirement-delivery-trace/spec.md`: Requirement trace and Trace inputs.
- **`openspec/changes/feature-165-c684d025/design.md`**:
  - §1: the policy v5 text;
  - §3: the audit criteria and rules;
  - §4: scoring, rubric, fidelity, and the ledger;
  - §4a: the stability diagnostic;
  - §5: the trace and reports;
  - §6: the policy diagnostic cases;
  - Migration Plan: version bumps.
- **`openspec/changes/feature-165-c684d025/test-plan.md`**: INT-001 to INT-005 and the acceptance envelope.
- **`openspec/changes/feature-165-c684d025/decisions.md`**: rationale. Later sections win over earlier ones. In particular, the approach-review entries supersede the earlier rules on these points:
  - AR-002: `corrected` requires that the position was not *established* earlier, not merely that no earlier turn *asked*;
  - AR-001: the intent-only filter, `over-correction`, and the fidelity exemption apply only to *unsolicited* corrections.
- **`openspec/changes/feature-165-c684d025/proposal.md`**: scope and out-of-scope items.

### Background

- The motivating run is `and-scene-e2e` `91aaa628983b`, on #152. Its proposal turn said themes were tempting and that it would exclude them, and policy v4 let that exclusion through. The hidden reference requires presentation-owned visual style.
- Relevant code on #152:
  - **Policy:** `evals/agent-runner/and-scene-define/hidden/simulated-user-policy.md` (v4). It includes a "Reply check" section, which `CHECK_REQUEST` in `evals/lib/define-run/simulated-user.mjs` tells the model to apply.
  - **Audit and judging:**
    - `evals/lib/define-run/judge-jobs.mjs`: `makeJobs` builds the `disclosure-audit` job from `leak:<id>` and per-exchange criteria; the prompt text is in `rules.disclosure` and `rules.fidelity`; job validation is per kind.
    - `evals/lib/define-run/judging.mjs`: `disclosureReport`, and the `disclosure-audit`, `gates-and-judging`, and `discovery` phase functions. The audit is read before the fidelity job is built.
  - **Scoring and rubric:**
    - `evals/lib/define-run/scoring.mjs`: `scoreDefinition` and `discoveryLedger`.
    - `evals/lib/define-run/rubric.mjs`: `RUBRIC_SETTINGS_DEFAULTS`, `validateRubricSettings`, `buildRubric`, and `checkRubric`. `checkRubric` requires `rubric.json` to equal a rebuild exactly.
    - `evals/agent-runner/and-scene-define/rubric.json` is version 10, regenerated by `scripts/build-rubric.mjs`.
  - **Policy diagnostic:** `evals/agent-runner/and-scene-define/policy-test.mjs`, with `POLICY_CASES`, `assessPolicyReply` (`matches` and `unraised`), and 3 trials per case.
  - **e2e:**
    - `evals/agent-runner/and-scene-e2e/lib/trace.mjs` (`buildTrace`);
    - `lib/report.mjs`, which prints `asked: yes/no`;
    - `lib/result.mjs`, `lib/comparison.mjs` (`OUTCOMES`), and `lib/rescore.mjs`;
    - the define checkpoint in `controller.mjs`, which fails the run only on `disclosure.leaked_items`.
  - **Define results:** `evals/agent-runner/and-scene-define/lib/result.mjs`, `report.mjs`, `comparison.mjs`, and `rescore.mjs`.
  - **Version ledgers:**
    - Define `versions.json`: `simulated-user-policy` (v4) and `rubric` (v10).
    - e2e `versions.json`: `define-inputs`, which pins the define `versions.json` (v4), and `define-rubric` (v1).
- Panel settlement for binary criteria is generic, so new binary criteria inherit the decider, overrule-check, and dissent-check rules.
- The existing `approval-drafted` diagnostic case's line 2 ("asks about audience or depth only when the topic is too vague") contradicts the reference's rule to ask when the visual style is omitted.

### What to build

1. **Policy v5.** Edit `hidden/simulated-user-policy.md` as design §1 specifies:
   - title: version 5;
   - a new disclosure bullet for unsolicited exclusions and contradictions;
   - an exception in the approval decision bullet;
   - an amended reply check, which keeps required corrections and keeps answers or rejections of offered options and defaults, but strips:
     - corrections of omissions;
     - unsolicited corrections of different mechanisms or values;
     - replacement details.

   Do not mention the inventory, classifications, the rubric, or the evaluation. `simulated-user.mjs` needs no logic change. Keep the reply types unchanged.
2. **Audit.** In `judge-jobs.mjs`:
   - add `corrected:<id>` for each graded item and `over-correction:<exchange>` for each exchange;
   - extend `rules.disclosure` with the design §3 rules: "not established earlier", unsolicited-only over-correction, and stated-exclusion corrections not counting as leaks;
   - validate both new criteria as binary, with exchange citations.

   In `judging.mjs`, `disclosureReport` adds:
   - `corrected_items`: settled corrected items, minus leaked ones;
   - `corrections`: `[{ id, citations }]`;
   - `over-correction` entries in `flags` and `panel_flags`;
   - `panel_corrections`.

   Status depends on flags only.
3. **Rubric v11.**
   - Add `correction_fraction` (default 0.5) to the settings.
   - Make `validateRubricSettings` require `0 < f < 1`.
   - Have `buildRubric` emit `correction_fraction` and a `corrected_items` rule string.
   - Regenerate `rubric.json` with `scripts/build-rubric.mjs` as `rubric_version: 11`, keeping its existing `calibration_evidence`.
4. **Scoring.** `scoreDefinition({ ..., corrected = [] })`:
   - rejects unknown ids;
   - lets leaks win;
   - multiplies a corrected item's earned points by the fraction and leaves its possible points unchanged;
   - annotates coverage entries with `corrected`, `correction_citations`, and `earned_points`;
   - returns `corrected_items`.

   With no corrections, the arithmetic must be exactly as before.

   `gates-and-judging` passes `audit.corrections` into scoring. It also passes `correction_exchanges` into the fidelity job's inputs: the exchanges cited by `corrections` and by settled over-correction flags. Extend `rules.fidelity` so that the correcting part of an unsolicited correction is exempt, while answers to questions and replies to offered defaults still bind, including inside mixed replies.
5. **Ledger.** `discoveryLedger`:
   - `leaked` takes precedence;
   - a corrected item is `corrected` when its verdict is `met` or `partial`, and `corrected-not-captured` when it is `missing`, with correction citations;
   - add both keys to `counts`;
   - add `corrected` to each item, keeping the boolean `asked`.
6. **e2e trace.** `buildTrace` adds:
   - `asked_part` (`yes`, `corrected`, or `no`; `corrected` wins);
   - `correction_citations`.

   `discovered-not-defined` applies when `asked_part !== 'no'`, and `not-discovered` only when `asked_part === 'no'`. Keep the boolean `asked` and the outcome names. The e2e report prints `asked_part`. The e2e rescore rebuilds the trace from the rescored coverage.
7. **Results and reports.**
   - Define and e2e `result.mjs` add `corrected_items` and `corrected_count`, treating missing fields in old results as none.
   - Both `report.mjs` files add a "Corrected items" row and list over-correction flags with the other audit flags.
   - Define `comparison.mjs` adds `corrected_count` per run.
   - The e2e define checkpoint stays unchanged: it fails only on leaks.
8. **Policy diagnostic.**
   - Replace `approval-drafted` line 2 with a line that neither mentions nor contradicts styling or asking behavior.
   - Add these cases, as design §6 lists:
     - `exclusion`, `contradiction`, `approval-exclusion`, and `exclusion-bait`;
     - `different-canvas`, `different-route`, and `alternative-mechanism`;
     - the paired `offered-canvas` and `offered-route`.
   - Add a `forbidden` pattern to `assessPolicyReply` for "must not correct".
   - Update the `--help` case count.
9. **Stability diagnostic.** Add `evals/agent-runner/and-scene-define/scripts/correction-audit-stability.mjs`, per design §4a and the spec:
   - **Arguments:** `--policy-test <policy-test.json>`, `--output <dir outside the repo>`, and `--repetitions` (default 3).
   - **Input:** assemble a conversation, labelled synthetic, from the retained replies. Refuse to run if a required shape is missing.
   - **Run:** use the real panel settlement through `runDefinitionPanel` with fresh calls. Apply each repetition through `scoreDefinition` to a fixed all-`met` coverage set.
   - **Output:** write `stability.json` with per-item and per-exchange flip counts, per-repetition scores, the spread, and the versions.
   - **Refusals:** refuse output paths inside the repository. Never write run directories or `results/**`, and never publish.
   - Add `node --check` for the script to `package.json` `check`.
10. **Versions.**
    - Define `versions.json`: `simulated-user-policy` version 5 and `rubric` version 11, with their hashes appended.
    - e2e `versions.json`: `define-inputs` version 5 (the new hash of the define `versions.json`) and `define-rubric` version 2.
    - Keep all earlier hashes.
11. **Docs.**
    - `evals/agent-runner/and-scene-define/README.md`: policy v5 behavior; the `corrected` and `corrected-not-captured` ledger outcomes; the correction fraction; the stability diagnostic's usage, cost, and private output; the new policy-diagnostic case and call counts.
    - `evals/agent-runner/and-scene-e2e/README.md`: the trace's `asked_part`, and the fact that corrections never end a run.

### Tests

These go in the existing `node --test test/*.test.mjs` suite:

- **Unit tests** for every spec scenario that code can decide:
  - rubric fraction validation and the rebuild;
  - `scoreDefinition` arithmetic, precedence, and the no-corrections case;
  - `discoveryLedger` outcomes, including the qualified "Requirement found by asking", "Requirement never raised", and "Correction not captured" cases;
  - `buildTrace` `asked_part`, including the "Corrected requirement not written down" case;
  - `disclosureReport` fields and flags;
  - `makeJobs` criteria and validation of the new votes;
  - fidelity job inputs;
  - `assessPolicyReply` with `forbidden`, run through a scripted `invoke`;
  - the report rows.
- **INT-001 to INT-005**, exactly as `test-plan.md` describes:
  - `test/and-scene-define-scoring.test.mjs`;
  - `test/and-scene-e2e-lifecycle.test.mjs` and `test/and-scene-e2e-results.test.mjs`;
  - `test/and-scene-define-results.test.mjs`;
  - `test/and-scene-define-inputs.test.mjs` and `test/and-scene-e2e-units.test.mjs`;
  - a new `test/and-scene-define-correction-stability.test.mjs`.
- **Existing tests** that pin hashes or versions are updated only for the intended bumps. Existing scenarios must otherwise pass unchanged.
- **No live calls:** tests make no model, network, or GitHub calls. Do not test prompt or policy text by string matching.

### Constraints

- No third-party runtime dependencies. No Agent Runner change.
- Do not edit `evals/agent-runner/*/results/**`, the hidden reference, `hidden/inventory.json`, the starting prompt, or the and-scene fixture.
- Do not change the product rubric or product score, or add a combined score.
- Result fields stay additive. Do not change the type of the existing `asked` field or rename any outcome.
- Do not rename `#### Scenario:` headers inside `MODIFIED` requirements in this change's specs.
- Do not run paid diagnostics, rescores, or candidate runs. These belong to the acceptance pass.
- Subprocesses only through argv arrays, never a shell.

### Done When

- Every requirement and scenario in the four spec files is implemented and covered by a test, apart from model-behavior scenarios. Those are measured by the policy and stability diagnostics in acceptance.
- INT-001 to INT-005 exist and pass.
- `rubric.json` (v11), policy v5, and both `versions.json` files verify, and earlier hashes remain.
- `npm run check` passes, including the new `node --check` entry.
- Both suite READMEs document the new behavior.
- `agent-validator run` passes before the pull request is opened.
