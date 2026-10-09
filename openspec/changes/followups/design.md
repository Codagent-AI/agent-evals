## Context

The and-scene and and-scene-define suites share cross-family panel judging in `evals/lib/panel-judging/`:

- **`panel.mjs`** owns settlement:
  - `effective()`, `route()`, `turned()`;
  - `resolvePanel()`, a pure function that reproduces results from a record;
  - `runPanelJob()`;
  - `rerunDecider()`;
  - `PANEL_PROTOCOL = 'cross-family-panel-v1'` at line 6.
- **`protocol.mjs`** owns prompts, audits and the line-cited decider:
  - `runTiebreak()`, `tiebreakDecisions()`, `resolveLineCitedRecord()`;
  - `buildSpanAuditRequest()`, `buildContradictionCheckRequest()`, `buildReciteRequest()`;
  - `sourceMaterial()`;
  - the seat-level `runJudgeJob()` with `buildSourceAuditRequest()`;
  - `MAX_AUDIT_PACKET_CHARS = 300_000`.

and-scene uses line-cited deciders (`panel_line_citations`) and seat source audits. Define uses neither: its votes are never disputed, and it uses the batched decider at `panel.mjs:280`.

Current behaviors this change replaces:

- **Undecided checks keep the vote disputed.** In `effective()` an `insufficient` contradiction check leaves the vote disputed (`panel.mjs:33`), so the criterion goes to the decider.
- **Only a higher dissent is checked.** `route()` keeps a dissent for a targeted check only when it ranks above the majority (`panel.mjs:86`).
- **Decider fails are never audited.** `runTiebreak()` audits only passes (`protocol.mjs:1288`).
- **A re-cite can replace the verdict.** The re-cite result overwrites the verdict as well as the spans (`protocol.mjs:1298`), and the re-cite prompt says "change your verdict rather than citing weaker lines" (`protocol.mjs:1126`).
- **Decider fails may cite nothing** (`protocol.mjs:822`).
- **Audits cite no files.** The audit schema has only free-text `evidence` (`protocol.mjs:135`), and `sourceMaterial()` reads only the voter's citations.
- **Packets throw on overflow.** Audit and check packets are pretty-printed JSON and throw a `JudgeOutputError` when they exceed the limit (`protocol.mjs:944`, `:1004`). Seat audits retry the throw three times and then fail the seat; span audits and checks fail the tiebreak. The decider's evidence packet inlines one JSON object per line (`protocol.mjs:1232`).
- **Points are divided equally.** `rubric.mjs:196` (`rubricCriteria`) and `scorer.mjs:151` (`scoreSubcomponent`) give each subcomponent's criteria equal shares. `rubric.mjs:82` and `:404` pin the engineering-quality subcomponent points.
- **Outline inputs are hard-coded.** The two outline inputs appear by name in:
  - `browser-eval.mjs:33` and `:1361`;
  - `second-opinion.mjs:78`;
  - `reference-browser-regression.mjs:16`;
  - `calibration.mjs:82`;
  - `scorer.mjs:249`.
- **Define runs judge jobs one at a time** (`and-scene-define/lib/judging.mjs:78`). and-scene has a bounded pool and `serial()` (`and-scene/lib/judge-jobs.mjs:367`, `:403`, `:497`).
- **A rescore cannot resume.** `controller.mjs:186` rejects `--rescore-from` together with `--resume`.

Tests fake every model call with canned invokers:
- `test/panel-judging-settlement.test.mjs`, `test/panel-judging-material.test.mjs`;
- `test/rubric.test.mjs`, `test/scoring.test.mjs`, `test/second-opinion.test.mjs`, `test/judge-jobs.test.mjs`;
- `test/and-scene-define-calibration.test.mjs`, `test/and-scene-define-scoring.test.mjs`.

## Goals / Non-Goals

**Goals:**
- Implement `cross-family-panel-v2` settlement and rubric 15.0.0 as the specs define them, with pure, replayable settlement.
- Keep every change in settlement inside `evals/lib/panel-judging/`, so both suites change through one protocol bump.
- Give maintainers a job-filtered judging diagnostic and an offline settlement replay.
- Share one bounded job pool between the suites.

**Non-Goals:**
- Changing browser probes or `browser-eval.mjs`.
- Vote-share scoring or extra Codex samples.
- Fixture changes.
- Changing the define three-way split.
- Reporting UI beyond the fields the specs require.

## Approach

### 1. Panel settlement (`panel.mjs`)

- **`effective(vote, checks, order, fallbackIds)`.** A disputed vote whose contradiction check is `contradicted` or `insufficient` returns `{ verdict: vote.verdict, disputed: false }`. The one exception: a pass on a criterion in `fallbackIds` with an `insufficient` check stays disputed. `fallbackIds` comes from `record.fallback_ids`, which is already recorded. A `confirmed` check turns the vote as today.
- **`route()`.** When any vote's check is `confirmed` and the effective votes are not unanimous, it returns `{ kind: 'decider' }` before the majority logic runs. `deciderRequestFor()` already rewrites a turned vote's rationale to "The source contradiction was independently confirmed: …". It also gains the check's rationale, so the decider sees the confirmation.
- **Define overrule check.** This applies only to the batched decider path; and-scene uses line-cited deciders.
  - After the batched rulings return, the panel finds each ruling that differs from a verdict exactly two effective votes gave.
  - For each one it runs an `overrule-check` built by `overruleCheckRequest()`. It mirrors `dissentCheckRequest()`, but checks the decider's stated reason and citations against `sourceMaterial()`.
  - The check is recorded with `stage: 'overrule-check'`.
  - In `resolvePanel()`, an overruling ruling stands only when its overrule check is `confirmed`; otherwise the two-vote verdict stands with basis `majority-<verdict>`. A three-way split (no two-vote verdict) needs no check.
  - `rerunDecider()` runs the same check on re-run rulings and reports `flipped` on the final verdict after the check. It still accepts only complete records under the current protocol.
  - **Retained-ruling check.** `scripts/check-retained-ruling.mjs` (define suite) reads one retained calibration record of any protocol, read-only, and runs `overruleCheckRequest()` against the recorded ruling, its stated reason and citations, with the recorded votes. It prints the check's classification and the verdict v2 settlement would give. It never writes a judging record or cache entry, so a v1 record is never reused as v2 judging.
  - The disclosure audit runs through `runDefinitionPanel()` and so gets the check with no suite code.
- **Protocol bump.** `PANEL_PROTOCOL = 'cross-family-panel-v2'`, plus its copies in `and-scene/lib/judge-profile.mjs:3` and `report.mjs:498`. `verifyCachedPanelJob()` already rejects any other protocol, and the protocol is part of the and-scene judge cache key (`judge-jobs.mjs:415`), so no v1 record is reused.

### 2. Line-cited decider (`protocol.mjs`)

**Decider output.**
- `LINE_CITED_RESULT_SCHEMA` gains:
  - `search_scope`: up to 12 inventory paths;
  - `missing_obligation`: a string;
  - `claim_map`, for the two testing-evidence criteria only (see section 3).
- `parseLineCitedOutput()` accepts a fail only when it has counterexample spans, or a non-empty `search_scope` together with a `missing_obligation`. Any other fail is a `JudgeOutputError`, retried like any invalid output.
- Scope paths are validated against the inventory like span paths.

**Audits of both verdicts.**
- `runTiebreak()` audits every ruling, not only passes.
- `buildSpanAuditRequest()` takes `rulings` and builds one claim per ruling:
  - a counterexample fail carries its quoted spans;
  - an absence fail carries its scope files in full, the missing obligation, and the complete verified inventory, every path unabridged;
  - a pass carries its spans, plus the claim map material for testing evidence.
- The audit prompt states each claim's direction:
  - a pass is confirmed when the lines prove every clause;
  - a counterexample fail is confirmed when the lines show a clause unmet;
  - an absence fail is confirmed when the scope is where the obligation would live and the scope omits it, or when no inventory file could hold the obligation;
  - an absence fail is `scope-inadequate` when the scope is not where the obligation would live; the audit then names, in `scope_repair`, the inventory files where it would;
  - any claim is `contradicted` when the material shows the opposite;
  - any claim is `missing-material` when deciding it needs material marked truncated or omitted, naming the marker.

**Audit outcomes.**
- `PANEL_AUDIT_RESULT_SCHEMA` (see Auditor citations) adds `missing-material` and `scope-inadequate` to the classification enum, plus `marker` (a string, empty unless `missing-material`) and `scope_repair` (up to 12 inventory paths, empty unless `scope-inadequate`). Contradiction, dissent and overrule checks use the same enum, without `scope-inadequate`.
- Missing material is what the harness withheld or could not deliver: a cut or dropped part of an evidence artifact, or an unreadable file. A source file a judge could have cited but did not is not missing; it stays `insufficient`, the judge's burden, handled by the re-cite as today (`protocol.mjs:373`).
- **Evidence seats and deciders.** Their result schema gains a required per-criterion `missing_material` string, empty unless the verdict depends on a cut. Source jobs have no cuts and leave it empty. A non-empty value must name a marker in the packet's cut index, or the output is a `JudgeOutputError` and is retried. `resolvePanel()` checks it before `route()`: any valid report raises `HarnessMaterialError` for that criterion, so neither a unanimous vote, a majority nor a decider ruling settles it.
- `insufficient` now means only that complete, in-scope material is inconclusive. The prompts of every audit and check say so, and say that material marked `[truncated: …]` or `[omitted: …]` is missing, not absent from the candidate.
- A final `missing-material` or `scope-inadequate` raises a non-retryable `HarnessMaterialError` with `code` set to that outcome, `owner: 'evaluation-harness'`, `resumable: false` and the criteria, like `PacketOverflowError`. The one exception: a confirmed contradiction that reverses a pass decides the criterion, whatever another part returned, because no omitted material could restore a pass.

**Scope repair.**
- A first-cycle `scope-inadequate` on an absence fail starts one repair cycle. `scope_repair` paths are validated against the inventory (an invalid path is invalid audit output and is retried), added to the scope files, and the claim is audited again with `cycle: 'repair'`.
- In the repair cycle, an adequate but inconclusive scope is `insufficient` and the fail stands; `scope-inadequate` is final and raises `HarnessMaterialError`; material too large raises `PacketOverflowError`. No further repair runs.
- Absence fails are never re-cited: the repair cycle replaces the re-cite for their scope. Passes and counterexample fails keep the single re-cite.
- Cost: one additional repair round per inadequate absence fail. Batching and invalid-output retries can make that more than one call.

**Re-cite.**
- Re-cite applies to passes and counterexample fails whose audit is undecided.
- `buildReciteRequest()` drops "change your verdict…" and instead says to return the same verdict with better citations.
- The re-cite parser rejects a changed verdict as invalid output, so it is retried.
- The record keeps `first_results` and `first_spans` beside `results` and `spans`.
- A re-cited ruling is audited again, pass or fail.

**Audit parts and cycles.**
- Every audit result is recorded with `criterion`, `cycle` (`initial`, `recite` or `repair`) and `part`. Batching by whole claim gives most rulings one part; the two claim-map criteria have one part per row batch plus `completeness` (section 3).
- `auditState(record, criterion)` takes the latest cycle that has results and aggregates its parts:
  - any part `contradicted` → a contradiction check per contradicted part; a confirmed check on a pass reverses it;
  - for a fail with a contradicted part, one check receives the material of every part of the cycle and confirms only when every clause is met;
  - a contradicted part whose check refutes or cannot decide the contradiction stands, as a one-part audit does today: it neither reverses the ruling nor counts as confirmed, and it triggers no re-cite;
  - every required part present and `confirmed` → confirmed;
  - otherwise any `missing-material` or `scope-inadequate` part, or a missing required part → `HarnessMaterialError`;
  - any `insufficient` part → undecided, which triggers the single re-cite (or, for an absence fail, leaves the fail standing);
  - otherwise the ruling stands unconfirmed, and a browser-fallback pass that is not confirmed fails, as today.
- A re-cite re-runs every part as the `recite` cycle; parts of different cycles are never combined.
- This replaces `audits.at(-1)` in `resolveLineCitedRecord()` (`protocol.mjs:1211`) and in the contested set (`:1313`).

**Contradiction checks.**
- Checks run for every contradicted part of the cycle being settled.
- The check prompt for a fail confirms only when the material meets every clause of the requirement and its guidance, not merely when the decider's reason is wrong.

**`tiebreakDecisions()`.**
- A fail whose state is `contradicted` (audit contradicted and check confirmed) becomes a pass. On a browser-fallback criterion, the reversal additionally requires the check's evidence to cite delivered source; otherwise it stays fail.
- An undecided state leaves the ruling standing.
- An unconfirmed browser-fallback pass still fails.

**Replayability.** The record persists, per criterion, each cycle's `expected_parts` and the `settled_cycle`, and each check records the `cycle` and `part` it checked. `resolveLineCitedRecord()` reproduces pass and fail outcomes by running `auditState()`, the same function live settlement uses, including the confirmed-pass-contradiction exception, on the settled cycle alone. Checks of earlier cycles, such as an inconclusive check before a re-cite, are verified against their own cycle and part and do not affect the outcome. A record whose settled cycle lacks a required part, or whose settlement would combine cycles, is rejected and the job is re-judged.

**Auditor citations.**
- Panel audits get a new `PANEL_AUDIT_RESULT_SCHEMA`: the current `SOURCE_AUDIT_RESULT_SCHEMA` plus `citations`, an array of up to 24 paths. It is required, and may be empty.
- `SOURCE_AUDIT_RESULT_SCHEMA` itself is unchanged. `second-opinion.mjs` imports it (line 5) and uses it for its source-pass replay audit (around line 641), so the second-opinion contract stays as it is.
- `parseSourceAuditOutput()` validates and bounds the paths for panel audits; the second-opinion audit's parsing and result shape are unchanged.
- `mergeSourceAudit()` copies `citations` into `vote.contradiction`.
- `sourceMaterial(request, results, extraPaths)` reads the union of the voter's citations and the audit's `citations`.
  - A path the vote or ruling cites outside the verified inventory is shown as `[not in inventory: <path>]`. It is evidence about that vote, such as an invented path, not missing material.
  - `parseSourceAuditOutput()` rejects an audit `citations` path outside the inventory as a `JudgeOutputError`, retried like any invalid output.
  - An inventory path that cannot be read raises `HarnessMaterialError` with `code: 'missing-material'`, naming the criterion. Today it is silently marked omitted, which under v2 would let an `insufficient` check settle the vote.
- **No size-based omission.** Today `sourceMaterial()` replaces every file after the first 150,000 characters with `[omitted: … exceeds the contradiction-check packet size limit]` (`protocol.mjs:1363`). Under v1 that was harmless, because an `insufficient` check kept the vote disputed. Under v2 an `insufficient` check lets the vote stand, so a check that never saw the decisive file would settle it. `OMITTED_FOR_SIZE` is removed: the material is collected in full, the check request is measured, overflowing requests are batched by whole claim, and a claim whose own material cannot fit raises `PacketOverflowError`.
- Span-audit contradiction checks likewise add the audit's citations to the quoted material.

**Packets.**
- **Compact serialization.** Every packet uses `JSON.stringify(x)` without indentation. Inlined evidence becomes one string per file, `path` followed by `N|text` lines, replacing one object per line. This is several times smaller and keeps line numbers explicit.
- **Batching.** A new `batchClaims(claims, render, limit)` greedily packs whole claims into requests under `MAX_AUDIT_PACKET_CHARS`. It is used by:
  - seat source audits (`buildSourceAuditRequest`, batching by criterion);
  - span audits;
  - contradiction checks;
  - line-cited decider requests, batching the per-criterion part (criterion, retained votes with rationales and citations, any confirmation) while every batch repeats the shared evidence files.

  Results from a criterion's batches are merged in criterion order, and a batched decider's rulings merge into one record as if returned together.
- **Inventory listings.** The seat prompt (`judge-jobs.mjs:200`) and `buildTiebreakRequest()` (`protocol.mjs:826`) list every inventory path in full, dropping `MAX_SOURCE_PATHS` and `bounded()` from those listings, and the absence audit receives the same full list. The listing is shared material, measured with the request. `lineCitationInventory()` (`protocol.mjs:788`) checks that `packet.txt` exists with `stat()` rather than looking for it in `listViewFiles()`, whose 500-file cap (`MAX_EVIDENCE_VIEW_FILES`) could leave it out; evidence seats and deciders are given the packet's path directly.
- **Overflow.** A claim that cannot fit alone raises a non-retryable `PacketOverflowError` with `code: 'packet-overflow'`, `owner: 'evaluation-harness'`, `resumable: false` and `criteria: [id]`. The job fails without spending attempts, and the job's failure names the criterion. Shared material that cannot fit even beside a single criterion, such as a decider's evidence files (`runTiebreak`, `protocol.mjs:1223`, which today throws a retryable `JudgeOutputError`), raises the same error naming every criterion pending for that request.

### 3. Testing-evidence claim map

The decider's `claim_map` is an object:

- **`scenarios`:** `[{ scenario, claims: [{ claim_span, evidence_spans, status }] }]`.
  - `scenario` must exactly match a heading from the evidence index's `approved_requirements`.
  - `status` is `supported`, `defective` or `missing`.
- **`other_claims`:** `[{ kind, claim_span, evidence_spans, status }]`, where `kind` is `ci`, `limitation`, `completion` or `other`.

**Claim-bearing records in full.** Today every evidence stage sees only `packet.txt`: seats are told not to read other files (`judge-jobs.mjs:253`), line-cited deciders may cite only `packet.txt` (`lineCitationInventory()`, `protocol.mjs:788`), and the packet truncates each artifact at 50,000 characters (`evidence.mjs:1495`). A claim past the cut-off is invisible to all three seats, and a unanimous pass never reaches the decider or its completeness audit.

The testing-evidence packet builder therefore places the claim-bearing records first and in full: the artifacts whose index role is `acceptance-flow-record`, `exploration-log`, `final-handoff` or `findings-history`. They are exempt from the per-artifact cap. The remaining roles follow under the existing caps and budget. When the claim-bearing records alone exceed `JUDGE_PACKET_MAX_CHARS`, building the view fails with `packet-overflow` naming the testing-evidence criteria, instead of truncating them.

The three seats and the decider see the full records and can cite any line; the completeness audit receives them in full; the row audits and contradiction checks receive their cited lines from the same records. Citations stay in `packet.txt` lines. On #78 rep 2 these records total about 9 KB against the 220,000-character budget.

**Evidence completeness, both evidence jobs.**
- **Primary records.** The same full-record rule applies to the assumption-handling packet (`assumptionRoles`, `evidence.mjs` ≈1655), whose primary records are `assumptions-ledger`, `final-handoff`, `findings-history` and `exploration-log`. Its other roles (`acceptance-gate-notice`, `acceptance-pass-record`, `session-audit`, `referenced-material`) stay supporting.
- **Skipped records.** A primary-role artifact that collection skipped as `artifact-bounds-exceeded` (over 16 MiB, `evidence.mjs:983`) fails the job with `packet-overflow`.
- **Requirement documents.** Today they are cut at 40,000 characters (`evidence.mjs:1554`). A longer one now fails the job with `packet-overflow`; none in the fixture snapshot exceeds 35 KB.
- **Markers.** `evidenceJudgePacket()` (`evidence.mjs:1570–1590`) today cuts supporting artifacts at 50,000 characters and drops them once the budget is spent, silently. It now writes `[truncated: <id> kept <n> of <m> characters]` after a cut, and `[omitted: <id> (<role>), <m> characters, packet budget]` for a dropped artifact, and lists every cut and drop in a short index at the top of the packet.
- **Labelled spans.** Every quoted `packet.txt` span in an evidence audit or check is labelled with the artifact it lies in (from the packet's artifact boundaries) and, when that artifact was cut, its marker. Every evidence audit and check also receives the cut index. A row audit that sees only the retained start of a cut log therefore still knows it was cut.
- **Consequence.** A stage whose decision depends on a marked supporting artifact returns `missing-material` (seats and deciders report it in `missing_material`), which makes the criterion a harness failure.
- **Accepted limitations.** This change adds no retrieval of the cut parts of supporting logs and no screenshot inspection; judges see a screenshot's record and path, not its image. A criterion that truly needs either becomes a harness failure, or is judged without the image, rather than settled on a guess. Both are recorded as a follow-up issue.

**Bounds:**
- one `scenarios` row per basis scenario (at most 68 today) and at most 24 `other_claims` rows;
- 6 claims per row;
- per claim one `claim_span` and at most 4 `evidence_spans`, each at most 40 lines.

A record claiming every basis scenario with separate claim and evidence locations fits. Spans are validated like decider spans.

**Span audit for these criteria** runs in two parts:
- **Row audits**, batched by whole rows through `batchClaims`, receive each row with the lines it references and judge its evidence.
- **One completeness audit** receives the claim-bearing sections of `packet.txt`, line-numbered, and a compact index of the locations each mapped claim cites (`packet.txt:start-end`, no quoted text). Its prompt adds the completeness duty: a material claim in those records that is missing from the map makes the ruling `contradicted`, and the audit names the record and line in its `citations` and `evidence`. Because it quotes no evidence, its size grows with the records, not with the map.

These are parts of one audit, settled by `auditState()` (section 2): any part that returns `contradicted` goes to its own contradiction check, whose material includes the audit's citations, and a ruling is confirmed only when every row part and the completeness part are confirmed. When the claim-bearing records alone exceed the packet limit, the job fails with `packet-overflow`, naming both criteria.

**Judge wording.**
- `evidenceJudgePrompt()` (`judge-jobs.mjs:216`) replaces "Compare every behavior the exploration plan commits to…" with the basis rules from the testing-evidence spec.
- The rubric definitions of `testing-evidence-usable-proof` and `testing-evidence-complete-honest-record` are rewritten to match.
- The ambiguity guidance that pointed omissions to honest-record now points to traceable coverage.

### 4. Rubric 15.0.0 and scoring

**Rubric data (`automated-rubric.json`).**
- Each component gains `tier_weights`, such as `{ "critical": 2, "major": 1, "minor": 0.5 }`. Test evidence and assumption handling use `{ "major": 1 }`.
- Each subcomponent gains `tiers`, a map from every listed criterion to `critical`, `major`, `minor` or `gate-input`.
- The two outline inputs stay in `demo-canonical-content.criteria`, tiered `gate-input`. Keeping them listed leaves the hard-coded references in browser evaluation, second opinions, calibration and the reference regression valid, and keeps fallback validation (`rubric.mjs:337`) satisfied.
- Subcomponent `points` are kept as declared values, and validation requires them to equal the sum of their criteria's weights.
- `version` becomes `15.0.0`, and `rubric-history.json` records its hash.

**Changes:**
- `entity-ungrouped-transition-morph` is added to `scene-entity-transitions`, with:
  - its `criterion_sources` entry, owned by the fixture and tracing to "Persisting entity morphs";
  - guidance;
  - `eval_owned_values` for `AnimatePresence`, `mode="wait"`, `popLayout` and `sync`.
- The guidance changes for departing-exit, overlap and active-state from the product-quality spec are applied.

**Validation (`rubric.mjs`).**
- Removed: the pinned engineering-quality subcomponent points (`:82`, `:404`).
- New rules:
  - every listed criterion has a tier;
  - `gate-input` is allowed only for the two outline inputs;
  - each component's tier weights decrease strictly from critical to minor, are at most 2, and are multiples of 1/16;
  - every criterion of a tier gets its component's weight for that tier;
  - subcomponent points equal the sum of their weights;
  - component points equal the sum of their subcomponents.
- Kept: the legacy disposition checks and the "59 directly scored" check. A `gate-input` counts as scored for the legacy count, because it remains a listed criterion of the demo component.

**`rubricCriteria()`** returns `criterion_points` from the tier, with 0 for `gate-input`, plus a new `tier` field.

**`scoreSubcomponent()` (`scorer.mjs:148`).**
- `points_possible` and `points_awarded` come from each criterion's `criterion_points`.
- The subcomponent share is the sum of awarded weights, using the existing exact-rational `sumShares`.
- Completeness considers only criteria with nonzero weight.
- `gate-input` criteria are still indexed, resolved, reported and used by `scoreGates()`.
- An unresolved gate input leaves the outline gate unobserved and eligibility unavailable, while the demo component stays complete.

### 5. Job-filtered judging diagnostic

**Invocation.** `run.sh --rescore-from <run-dir> --run-dir <new-dir> --judge-jobs scene-kit[,verification-tooling] --expected <file>` sets diagnostic mode.

**Before judging, the controller:**
1. normalizes the job list (sorted, unique, each a known scored job);
2. hashes the expected-verdict file;
3. writes `diagnostic.json`, holding:
   - `mode: 'judge-diagnostic'`;
   - the jobs;
   - the source run's path and verified manifest hashes;
   - the evaluator commit, and an evaluator content hash: a sorted manifest of path and SHA-256 for every file under `evals/lib/` and `evals/agent-runner/and-scene/`, excluding `results/`. It covers the controller, prompts, `automated-rubric.json`, `human-rubric.json` and the fixture snapshot judges read, committed or not;
   - the judge profiles;
   - the rubric hash;
   - the expected-file SHA-256.

**Pipeline.** The diagnostic then runs the rescore pipeline: input verification, the candidate build and browser evaluation (refreshing the browser facts judges receive), and `runProductJudging()` with `jobs` filtered to the list. It skips second opinions, scoring, human-review setup and publication. It writes judge outputs and `diagnostic-result.json`; it never writes `result.json` or a publication record. Failure and early-exit paths write `diagnostic-result.json` with the failure.

**Resume.** `controller.mjs:186` changes to allow `--resume` with a diagnostic directory. On resume:
- the controller reads `diagnostic.json` and restores the source and mode;
- before any checkpoint is reused, it recomputes the identity and rejects a resume whose `--judge-jobs`, source, expected-file hash, evaluator commit, evaluator content hash, rubric hash or judge profiles differ, or one without diagnostic flags, naming the field that differs;
- completed `product-judging/<job>` checkpoints are reused as today.

An ordinary `--rescore-from --resume` remains rejected.

**Repeats** are separate run directories.

**Comparison.** `judge-diagnostic.mjs --expected <file> <run-dir>...` verifies each directory's recorded expected hash against the file, then reports per criterion and repeat: the verdict, the judging basis, and whether it matches. The expected file is JSON: `{ "<source-run-id>": { "<criterion>": "pass" | "fail" } }`.

### 6. Shared job pool

`runJobPool({ jobs, concurrency, run, onCheckpoint })` and `serial()` move from `and-scene/lib/judge-jobs.mjs:403` and `:497` into `evals/lib/panel-judging/job-pool.mjs`, with #85's semantics:
- at most `concurrency` workers;
- checkpoint callbacks serialized;
- no new jobs after a checkpoint throws;
- in-flight jobs settled before the first error is rethrown;
- results in job order.

and-scene's `runProductJudging()` calls it with concurrency 3. Define's `judging.mjs` runs the coverage, quality and fidelity units through it with concurrency 3; the disclosure audit still runs first, because its leaked items change coverage. Define calibration passes job concurrency 1: the units within each repeat run one at a time, while repeats keep `CALIBRATION_CONCURRENCY` (6).

### 7. Settlement replay

`evals/agent-runner/and-scene/scripts/replay-settlement.mjs <judging-records.tar.gz> <raw-logs.tar.gz>` extracts each archive into its own temporary directory and runs with no model calls:
1. reads each recorded panel job;
2. substitutes the decider's first verdicts and spans parsed from the raw `judge-claude` event logs;
3. applies the v2 `effective()` rule and the immutable-re-cite rule through the pure settlement functions;
4. prints old and new verdicts, basis and points per criterion and in total.

The header labels the output **partial settlement counterfactual**: it excludes confirmed-contradiction routing, fail audits, auditor citations and any new model response. It says `replay` when the raw logs supplied the first votes, and `reconstruction` when they are missing and the first votes were inferred. Only an absent raw-log archive, or an absent log for a job, falls back to reconstruction. A malformed log, or one whose job, criterion or provenance does not match the record, fails the script instead.

## Decisions

- **Gate inputs stay listed, tiered `gate-input`.** Removing them from `criteria` would break fallback validation, browser result indexing, second-opinion targeting, calibration cases and the outline gate (at least five call sites). A zero-weight tier keeps every observation path intact. Only the scorer's completeness and points rules change.
- **A claim too large to fit fails its whole job.** The scorer requires exact, complete job output (`indexResults`). Per-criterion partial jobs would change coverage rules across both suites. A non-retryable `packet-overflow` that names the criteria is explicit and never settles a criterion on omitted material.
- **Re-cite immutability is enforced in the parser, not only the prompt.** The prompt alone was the original failure. Rejecting a changed verdict makes the rule mechanical and the record replayable.
- **An absence fail cites a scope that the audit judges against the inventory.** Requiring spans for absence is impossible, while accepting empty citations recreates the unaudited fail. A judged scope keeps the burden symmetric.
- **The overrule check reuses the dissent-check shape.** It is the same question (does the stated reason hold for the cited material?), and it already runs on the decider's pinned model.
- **The diagnostic reuses the rescore pipeline.** Scene-kit judges consume browser facts, and the seven calibration reps were evaluated by older harness versions. Refreshing facts costs a build and browser run per rep, but judges see current-harness inputs.
- **Known missing material fails explicitly.** A verdict may stand under uncertainty only when the required material was supplied and its scope was adequate. Under v1 an undecided check kept a vote disputed, so missing material only routed a criterion to the decider. Under v2 an undecided check lets the vote stand, so the distinction between "inconclusive" and "not shown" has to be explicit. `missing-material` and `scope-inadequate` keep it so, at the cost of more harness failures where material is genuinely incomplete.
- **The pool is shared now.** Two suites need it, which meets the repository's rule for shared code.

## Risks / Trade-offs

- **Leniency** from settling undecided checks upstream and from fail reversals. Mitigations:
  - confirmed-contradiction routing;
  - the strict reversal rule (every clause met);
  - the inventory-aware absence audit;
  - the pre-freeze known-answer checks and the accuracy review.
- **Larger audit packets** for absence fails (whole scope files) and testing-evidence claim maps (whole claim-bearing records). Compact serialization and batching offset this. A remaining overflow is an explicit harness failure, never a silent pass. The known-answer and rescore runs will show whether the limits bind.
- **More harness failures.** Unreadable files, final `scope-inadequate`, and decisions that depend on cut supporting logs now fail the criterion's job instead of settling. The rescores show how often. A frequent cause is fixed by supplying the material, never by restoring silent settlement.
- **Claim-map size limits** (6, 40, 80) are judgment calls. If a real record needs more, the decider cannot represent it and the output is retried and then fails as a harness failure. Raise the limits rather than let the map drop claims.
- **Hard-coded outline inputs** remain in five places. They are now the only gate inputs the validator allows, so any future gate input needs those places generalized.
- **Diagnostic browser refresh on old reps** may fail to build or serve with the current harness. The morph shipping rule in the proposal handles an unloadable rep.

## Migration Plan

- **No data migration.** The protocol bump invalidates cached v1 judge jobs. Historical `results/**` are not edited.
- **New series.** 15.0.0 results start one; earlier runs compare only after `--rescore-from`.
- **Order of work:**
  1. panel-judging changes and their unit tests;
  2. rubric, validation and scorer;
  3. the testing-evidence map;
  4. the diagnostic and replay;
  5. the shared pool and define;
  6. then the proposal's evidence steps.
- **Real-browser suites.** Run `test/real-browser/candidate.test.mjs` serially on the base commit and on the final implementation, because the outline gate's scoring integration changes. The adversarial suite covers second-opinion replay, which shares the audit schema module. It is skipped only when the integration test proving the second-opinion audit request, schema and parsing are unchanged passes, and the implementation leaves `second-opinion.mjs` and its other dependencies unchanged in behavior. Otherwise it runs on the base commit and on the final implementation.
- **Rollback:** revert the change. The v1 protocol and rubric 14.0.0 return together, because both are pinned in code.

## Open Questions

None. The morph criterion's inclusion is settled by its calibration under the proposal's shipping rule. If it is cut, remove it and set the scene kit's critical weight to 1.75 before archive.
