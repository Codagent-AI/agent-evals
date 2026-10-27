## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only obligations.

**Unit tests (not inventoried here).** Tests in the existing `test/and-scene-define-*.test.mjs` and `test/and-scene-e2e-*.test.mjs` files cover the isolated logic:

| Area | Unit coverage |
|---|---|
| Rubric | `correction_fraction` validation and the rubric v11 build |
| `scoreDefinition` | partial-credit arithmetic; leak precedence; arithmetic unchanged when nothing is corrected |
| `discoveryLedger` | the new outcomes |
| `buildTrace` | `asked_part` |
| `disclosureReport` | `corrected_items`, `corrections`, and the over-correction flags |
| Disclosure-audit job | criteria built by `makeJobs`; validation of `corrected:` and `over-correction:` votes |
| Fidelity job | receives `correction_exchanges` |
| Policy diagnostic | its case list and `forbidden` assessment, run with a scripted `invoke` |
| Reports | the new rows |

**What is not tested automatically.** Policy and judge prompt wording is never tested by text matching. Whether the live simulated user corrects at the right boundary is model behavior. The paid policy diagnostic measures it during acceptance (see the envelope); automated tests do not.

**Where tests run.** Every automated obligation below runs offline, with stubbed panel members and simulated-user invokers, in `npm run check`, which CI runs. This change adds no real-browser suite work.

## Integration Tests

### INT-001: Define judging lifecycle settles corrections and scores them
- **Covers:**
  - `simulated-user`: Correction audit (settlement, leak precedence, over-correction is report-only);
  - `definition-artifact-scoring`: Requirement coverage (partial credit) and Fidelity (correction exemption);
  - `requirement-discovery-diagnostic`: Discovery ledger.
- **Boundary:** the real `disclosure-audit`, `gates-and-judging`, and `discovery` phase functions in `evals/lib/define-run/judging.mjs`, writing and reading `audits/disclosure.json`, `judges/score.json`, and `discovery/*.json` on disk. Only the panel members and the decider are stubbed. This follows the existing "INT-003 lifecycle neutralizes settled leaks" test.
- **Setup:** a run directory with a collected definition and a conversation. Stub votes cover these cases:
  - item A is marked `corrected:` by Claude and one Codex judge;
  - item B is marked `corrected:` by both Codex judges only, and the decider rules corrected;
  - item C is marked both `leak:` and `corrected:`;
  - one exchange has an `over-correction:` flag;
  - coverage votes give A `met`, B `missing`, and C `met`;
  - the discovery stub marks A and B not asked, and marks a further item D, with no correction and `missing`, not asked;
  - a fidelity stub records the `correction_exchanges` it received.
- **Action:** run the three phases in order.
- **Assertions:**
  - The audit file lists A and B as corrected, C as leaked only, and the over-correction flag in `flags`. Its status is `flagged`.
  - In the score file, A earns `weight × 1 × 0.5` with its possible points unchanged; B earns 0 and its possible points stay included; C is excluded.
  - `corrected_items` is `[A, B]`.
  - The fidelity job input contains A's correcting exchange.
  - The ledger records A as `corrected` and B as `corrected-not-captured` (not `missed`), with the correcting exchange cited for both, C as `leaked`, and D as `missed`.
  - The total differs from an otherwise identical run with no corrections only by A's halved points.
- **Execution:** `test/and-scene-define-scoring.test.mjs`, under `npm run check`.

### INT-002: End-to-end define checkpoint, trace, and result with a corrected item
- **Covers:**
  - `simulated-user`: Correction audit (a corrected item does not stop an end-to-end run);
  - `definition-artifact-scoring`: the end-to-end definition score carries the penalty;
  - `requirement-delivery-trace`: Requirement trace and Trace inputs.
- **Boundary:** the e2e controller's define checkpoint, implement step, scoring, trace, and result assembly with real phase wiring. The Runner, sandbox, product judges, and panel use the existing INT-005 lifecycle stubs.
- **Setup:**
  - The existing INT-005 happy-path harness, with the audit stub settling one mandatory item as `corrected` and raising one `over-correction` flag, with no leaks.
  - The definition covers that item, and its mapped product criteria pass.
  - In a second case, the discovery stub marks the corrected item as asked.
  - In a third case, a second corrected item is not covered by the definition, and the discovery stub marks it not asked.
- **Action:** run the run to its pending result.
- **Assertions:**
  - Implementation starts, and the run is not `evaluation-harness-failed`.
  - `result.json` reports the definition score with the item's earned points halved and its possible points unchanged. The product score equals that of the same run without the correction.
  - The trace item has outcome `delivered`, `asked_part: "corrected"`, the correcting exchange in `correction_citations`, and the boolean `asked` still present.
  - With the discovery stub marking the item asked, `asked_part` is still `corrected`.
  - The uncovered corrected item is `discovered-not-defined`, not `not-discovered`, with `asked_part: "corrected"`, raw `asked: false`, and the correcting exchange cited.
  - The report shows the corrected item and the over-correction flag.
  - `comparison.mjs` trace counts are unaffected by the additive fields.
- **Execution:** `test/and-scene-e2e-lifecycle.test.mjs` and `test/and-scene-e2e-results.test.mjs`, under `npm run check`.

### INT-003: Rescore and old results under the new evaluators
- **Covers:**
  - `definition-artifact-scoring`: Requirement coverage, the run-without-corrections case;
  - the design's additive-field and versioning decisions.
- **Boundary:** define `--rescore-from` (the real `rescore.mjs`), which reruns the audit, judging, and discovery from a retained run directory whose `audits/disclosure.json` and `judges/score.json` predate this change (no `corrected_*` fields), plus result, report, and comparison assembly. The panel is stubbed.
- **Setup:** a retained run fixture under policy v4 and rubric v10, and a stub panel that settles no corrections.
- **Action:** rescore into a new directory, then build the report and the comparison.
- **Assertions:**
  - The rescored score equals the score the v10 arithmetic gives for the same verdicts.
  - `corrected_items` is empty and `corrected_count` is 0.
  - The rescore records rubric version 11 and is never published.
  - The original directory's result and report still render, with a missing `corrected_*` field treated as no corrections.
  - The comparison pairs the two runs only when their series match, and otherwise lists the series differences.
- **Execution:** `test/and-scene-define-results.test.mjs`, under `npm run check`.

### INT-004: Version ledgers pin the new policy and rubric in both suites
- **Covers:** `simulated-user`: the pinned, versioned disclosure and decision policies; and the configuration-to-runtime wiring of policy v5, rubric v11, e2e `define-inputs` v5, and e2e `define-rubric` v2.
- **Boundary:**
  - the real `checkVersions` and preflight version checks of both suites, against the committed `versions.json` files;
  - `loadSimulatedUserInputs`;
  - `verifyJudgingInputs` with the committed `rubric.json`.
- **Setup:** copies of the committed suite inputs in a temporary suite root, as the existing inputs and invokers tests do.
- **Action:**
  1. Run the version checks and input loading on the copy as committed.
  2. Then edit the policy without a version bump.
  3. Then change the rubric's `correction_fraction` to 1 without a version bump.
- **Assertions:**
  - The committed inputs pass, and the loaded policy reports version 5.
  - Earlier hashes remain in the ledger.
  - The e2e `define-inputs` hash matches the committed define `versions.json`.
  - Each tampered input fails, naming the input.
  - A fraction of 1 is rejected by rubric validation.
- **Execution:** `test/and-scene-define-inputs.test.mjs` and `test/and-scene-e2e-units.test.mjs`, under `npm run check`.

### INT-005: Correction audit stability diagnostic wiring
- **Covers:** `simulated-user`: Correction audit stability diagnostic.
- **Boundary:** the real `correction-audit-stability.mjs` script, including:
  - reading a retained `policy-test.json` and assembling the synthetic conversation;
  - the real panel settlement path, with stubbed panel members;
  - `scoreDefinition` with the committed rubric;
  - writing `stability.json` to the filesystem.
- **Setup:**
  - A scratch `policy-test.json` with replies for every required shape.
  - Stub panel members that settle item A `corrected` in repetitions 1 and 3 but not in 2, and settle the other items the same way every time.
  - A second, incomplete `policy-test.json` that lacks the mixed-reply shape.
  - An output path inside the repository.
- **Action:** run the script with `--repetitions 3` and an output directory outside the repo; then rerun it with the incomplete input; then rerun it with the output path inside the repository.
- **Assertions:**
  - The assembled conversation is labelled synthetic and contains every required shape.
  - `stability.json` reports one flip for A and none for the other items, and a coverage-score spread equal to A's half-credit difference.
  - The policy, rubric, and judge-profile versions are recorded.
  - No run directory or `results/**` file is written.
  - The incomplete input is refused before any panel call.
  - The output path inside the repository is refused.
- **Execution:** a new `test/and-scene-define-correction-stability.test.mjs`, under `npm run check`.

## End-to-End Tests

No new automated end-to-end obligation.

- A real define or e2e candidate run takes hours, costs model and GitHub resources, and is nondeterministic, so it cannot give a stable CI assertion.
- INT-001 and INT-002 exercise the full scoring and reporting journey through the real phase wiring. The model's correction behavior is measured by the paid diagnostic in acceptance.

## Acceptance Testing Envelope

- **Environments and sandboxes:**
  - the local checkout, rebased on `main` after PR #152 merges (or the stacked `end-to-end` branch);
  - `npm run check`;
  - `node evals/agent-runner/and-scene-define/policy-test.mjs --output <new dir outside the repo>`;
  - define `run.sh --dry-run` and e2e `run.sh --dry-run`;
  - define `--rescore-from <retained run> --run-dir <new dir>` on an existing retained define run directory.
- **Credentials and secrets:** host Claude CLI authentication, used for the simulated user and Claude judges, and host Codex CLI authentication, used for Codex judges. No GitHub, GitHub App, or Fly credentials are needed.
- **Authorized effects:**
  - **Paid policy diagnostic:** one run of the policy diagnostic. That is about 21 cases × 3 trials × 2 Claude Opus calls. Up to two re-runs are allowed if a policy-text fix is needed. The output stays in a scratch directory outside the repo.
  - **Paid rescore:** at most one define rescore of an existing retained run, with panel judge calls. It never publishes.
  - **Paid stability diagnostic:** one run of `correction-audit-stability.mjs` with 3 repetitions, built from that policy diagnostic's retained output. That is about 3 × (3 panel judges plus the decider and any checks) audit calls. Output goes to a scratch directory outside the repo. Review its flip counts and score spread before claiming that the correction penalty is stable.
  - **Paid fidelity check:** one run of the fidelity panel job on the same synthetic conversation, with a minimal hand-written scratch definition. The definition contradicts both the mixed reply's correcting part and its preference answer, and also keeps a rejected offered default. This checks that fidelity deducts for the preference answer and the rejected default, but not for the correction.
  - **Cleanup:** delete the scratch directories when done.
  - **Inspection:** retained diagnostic replies may be read to judge semantic compliance at the correction boundary.
- **Off limits:**
  - `--run-agent` candidate runs of either suite, e2e runs that need the GitHub App, and any publication or push to `results/**`;
  - editing historical `results/**`;
  - pushing to `Codagent-AI/and-scene` or changing the pinned fixture, hidden reference, or inventory;
  - the shared real Chrome.
- **Permitted substitutes:**
  - If Claude auth is unavailable or the quota is exhausted, the policy diagnostic may be run with a scripted `invoke` to check wiring only. The result must then be reported as not measuring model behavior.
  - If no retained define run directory is available, the rescore may be skipped and reported as skipped.
- **Known risk areas:**
  - **The correction boundary.** The live simulated user may fail to correct an exclusion: this is the v4 behavior the reply check enforced, so watch whether the check still strips required corrections. It may also correct a different canvas size, route, or mechanism, or name replacement details.
  - **The `approval-drafted` case** must stay a pure omission after its line 2 is replaced.
  - **Leak/corrected precedence** and **the audit's larger output** relative to the judge packet and output limits (PR #159).
  - **Readers of older results** must treat missing `corrected_*` fields as no corrections.
  - **Version ledger chain:** the e2e `define-inputs` hash must follow the define `versions.json` change.
  - **Drift from PR #152's final head** affects both the code and the copied `MODIFIED` spec text.
  - **Unsolicited versus solicited:** the reply check and the over-correction flag must leave answers to asked questions and rejections of offered defaults intact. Compare the paired canvas and route cases.
  - **Accepted limitations:** the stability measurement uses a synthetic conversation. The first real v5 runs should be rescored repeatedly to confirm it. The correction fraction is declared, not calibrated.

## Human-Only Testing

None.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| simulated-user: Correction audit | INT-001, INT-002 | — | — |
| simulated-user: Correction audit stability diagnostic | INT-005 | — | — |
| simulated-user: Disclosure audit (correction not a leak, omission over-disclosure; settlement wiring) | INT-001 | — | — |
| simulated-user: Disclosure policy and Decision policy (versioned, pinned) | INT-004 | — | — |
| definition-artifact-scoring: Requirement coverage | INT-001, INT-002, INT-003 | — | — |
| definition-artifact-scoring: Fidelity | INT-001 | — | — |
| requirement-discovery-diagnostic: Discovery ledger | INT-001 | — | — |
| requirement-delivery-trace: Requirement trace and Trace inputs | INT-002 | — | — |
