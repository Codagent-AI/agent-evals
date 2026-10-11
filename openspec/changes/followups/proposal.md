## Why

Two rescores of byte-identical delivered code (#78 rep 2) scored 62.97 and 59.97. That 3.0-point swing is as large as the differences between workflow configurations the and-scene eval exists to measure. The next planned step is rescoring #78 ("Eval: baseline plus task-compliance validator review, 3 repetitions") to decide whether to adopt task-compliance review. If judging is not fixed first, that comparison measures judge noise.

The research behind this change (vault: `Projects/Codagent/Agent Runner/and-scene rubric research 2026-10-07/`) traced the whole 3.0-point gap to four criteria, each worth 1 point or less. It found causes in the shared panel code, all confirmed on `main`:

- **One-sided burden of proof.**
  - The decider's pass rulings get a span audit; its fail rulings are never audited (`protocol.mjs` `tiebreakDecisions`).
  - When the audit of a pass is undecided, the decider re-cites, and the re-cite result replaces its verdict as well as its spans. The re-cite prompt tells it to "change your verdict rather than citing weaker lines".
  - Across four panel runs the decider ruled fail 12 times out of 12.
  - Both testing-evidence flips (2.0 points) were a decider pass turned to fail on re-cite.
- **An undecidable check decides the route.** An `insufficient` contradiction check leaves a vote disputed (`panel.mjs` `effective()`), which sends even a unanimous 3-0 pass to the decider.
  - In the active-state flip (0.5 points), that route was what caught a probable real defect: the decider's pass was contradicted by its span audit and confirmed by an independent check. The defect is a helper that compares the active step against the Previous button.
  - The catch was luck, not design. The same panel passes this criterion whenever no seat audit happens to dispute it.
- **Checks lack the auditor's evidence.** A contradiction check sees only the voter's cited files. When the audit rests on another file, the check can only return `insufficient`.
- **Unprovable or conflicting rubric wording.** Testing-evidence criteria ask the decider to prove something about each behavior, which it cannot do within its 12-span budget. The overlap-warning guidance contradicts the shared rule that which elements a check counted never makes a fail. That conflict accounts for the fourth flip (0.5 points).
- **Oversized packets.** Pretty-printed audit and check packets can exceed the 300,000-character limit and fail a whole judge job. The 28-criterion scene-kit job is most exposed. The decider's inlined evidence packet has the same limit.

The define suite shares the root cause in the opposite direction. Its decider accepted a lenient `met` for removed item INV-093 in one of three calibration repeats, because a define decider ruling is checked only for mechanically valid citations.

Separately, the rubric's points do not follow importance, which is a validity problem rather than a variance one:

- Each subcomponent splits its points equally, so a single verdict is worth anywhere from 0.33 to 4 points. The 15 critical criteria hold 11.9 points while 39 minor ones hold 22.8.
- Two criteria duplicate a hard gate's inputs.
- Several criteria fail nearly every run because of the fixture or the judging rather than the candidate.
- `entity-persisting-morph` passes candidates whose `AnimatePresence mode="wait"` makes persisting entities vanish and reappear instead of morphing.

The validity fixes land here, for three reasons:
- The protocol change already starts a new series.
- The rescores this change runs carry the validity fixes at no extra cost.
- The fixes must be in place before #87's new baseline in any case. Deferring them would only move the same work into #87.

Two smaller follow-ups ride along:

- The define suite still runs its judge jobs one at a time, while and-scene has had a bounded job pool since #85.
- The 14 LLM-judged engineering-quality criteria added by #86 (6 points) have never had their stability measured.

## What Changes

### Steadier panel judging (shared by both suites)

The judging protocol becomes `cross-family-panel-v2`, so no v1 cached record is reused.

- **An undecidable check never decides.** An `insufficient` contradiction check leaves the vote standing as cast and not disputed. The exception is a browser-fallback criterion: there, a pass whose own audit was contradicted and whose check is `insufficient` stays disputed and goes to the decider, as today. Without that exception, an unproven fallback pass would stand.
- **Confirmed negative evidence is adjudicated.** A vote that a confirmed contradiction check turns sends a split criterion to the decider, even when the remaining votes form a majority that includes the Claude seat. Today a fail produced this way loses silently to two unchecked passes, because only a higher dissent gets a targeted check. With this rule, the recorded active-state case reaches the decider through a check that confirmed the defect, not through an undecided one.
- **One burden of proof for the decider.**
  - A re-cite may replace the decider's spans but never its verdict, and the prompt stops telling it to change its verdict. The record keeps the first and the re-cited spans separately.
  - A decider fail gets the same span audit as a pass. When an independent contradiction check confirms the audit's stated contradiction, the fail becomes a pass, mirroring how a confirmed contradiction turns a pass into a fail.
  - A fail must cite either a counterexample's lines or, for a fail about absence such as a missing test, the files that would contain what is missing. The audit checks that scope. A fail citing neither is invalid output and is retried, so a decider cannot avoid the audit by citing nothing.
  - An absence fail whose scope the audit finds inadequate gets one repair round: the audit names the files where the obligation would be found and runs again with them. A scope still inadequate is a harness failure.
  - An undecided audit leaves the ruling standing.
  - An unconfirmed browser-fallback decider pass still fails.
- **Define decider overrules get checked.** A define decider ruling that overrules a two-seat majority gets the same targeted check a backed dissent gets today.
  - This applies to every define panel job, including the simulated-user disclosure audit, where a `met` ruling means a leak and changes the coverage denominator.
  - The check can reject a lenient overrule and restore the majority's verdict. It cannot produce a verdict no seat gave, so INV-093's best outcome is `partial`, not the expected `missing`.
  - Three-way splits keep today's settlement. There is no two-seat verdict to restore, and defaulting an unconfirmed ruling to `partial` would bias results toward the middle.
- **Contradiction checks see the auditor's evidence.** Audits return the paths they rely on as structured citations, and a check's closed-world material includes those files as well as the voter's citations. An audit citing a path outside the verified inventory is invalid output and is retried, and a cited file that cannot be read is a harness failure.
- **Uncertainty is allowed only on complete material.** A verdict may stand under uncertainty only when the required material was supplied and its scope was adequate. Known missing required material produces an explicit harness failure.
  - Audits and checks gain two outcomes, `missing-material` and `scope-inadequate`, both harness failures. `insufficient` then means only that complete, in-scope material is inconclusive.
  - Evidence packets mark every cut and dropped artifact. The primary records of the testing-evidence and assumption-handling judges, and the approved requirements, are supplied in full or the job fails.
  - Audits of a ruling that run in several parts are recorded by part and cycle, and a ruling is confirmed only when every part of one cycle is.
  - Inventory listings are never shortened.
- **Packets fail far less often.**
  - Audit and check packets are serialized compactly.
  - An audit whose combined packet is too large is split into batches, as long as each claim fits on its own.
  - A single claim that cannot fit on its own is recorded as a harness failure for that criterion. It is never decided on silently omitted material.
  - The decider's evidence packet gets the same treatment.

### Rubric 15.0.0

Component totals (20/20/7/7/8/4/4), the 12.5-point floors, the 70 automated points, the 100-point total and the 40/70 eligibility threshold do not change.

- **Points follow importance.** Each criterion carries a tier: critical, major or minor. Within a component, every criterion in a tier gets the same weight, the tiers step down at roughly 4:2:1, and no single verdict is worth more than 2 points. Subcomponents remain reporting groups. This replaces equal division in both product-quality and engineering-quality scoring.
  - Paul reviews the critical list, and the criteria whose weight moves most, during the spec step.
  - The remaining tiers come from the research's per-criterion table.
- **Gate duplicates.**
  - `demo-route-and-registration` and `demo-nine-step-content-and-order` stop earning points. They remain zero-point inputs to the `verification-sample-outline` gate, so they are still observed, fallback-judged, given second opinions on the gate's behalf, traced and reported.
  - `demo-step-and-transition-reliability` stays scored at the minor tier, because it also checks forward and backward step-index progression.
- **Wording fixes for the criteria that flipped:**
  - `visual-helper-overlap-warning`: dropping textless chrome fails only when the candidate's presentation renders textless chrome.
  - `visual-helper-active-state-warning`: comparing the active step against a non-indicator control fails.
  - The two testing-evidence criteria are judged against a finite basis, the 68 scenarios of the approved fixture specs, instead of "each" or "every" behavior. Adding the word "material" is not enough, since the definitions already use it. A decider ruling on them returns a claim mapping (scenario, claim, evidence) that its span audit receives.
- **Eval-side fixes for criteria that fail almost every run.**
  - `entity-departing-exit` credits a kit exit wrapper the sample uses.
  - `testing-evidence-complete-honest-record` stops double-counting omissions that `testing-evidence-traceable-coverage` already scores.
  - Criteria that fail for real reasons are kept.
- **A calibrated morph criterion.** A new major-tier criterion (working name `entity-ungrouped-transition-morph`) fails ungrouped transitions that hide the morph. Its implementation-specific terms (`AnimatePresence`, `mode="wait"`, `popLayout`) are declared eval-owned with reasons, as rubric traceability requires.
  - **Calibration:** seven past reps with known answers are each judged twice, with the expected verdicts fixed before calibration runs.
  - **Shipping rule:**
    - It ships in 15.0.0 only if every judging matches.
    - A completed mismatch cuts it from 15.0.0, as does a known-failing rep that the current harness cannot load. If a known-passing rep cannot be loaded, calibration continues on the rest only while each passing pattern keeps at least two reps.
    - An interrupted calibration resumes rather than cutting the criterion.
  - **Limits:** this is a fit check, not a test of generalization. The seven reps are the cases the criterion was designed from, and all three known failing candidates are among them. None of the reps rescored for #78 has the defect, so the criterion matters for future runs, starting with #87's baseline, not for the #78 decision.

### Parallel judge jobs in the define suite

The define suite's coverage, quality and fidelity jobs run through a bounded pool. It runs up to 3 jobs at once, writes checkpoints one at a time, records results in job order, and starts no new job after a failed checkpoint. The pool moves out of and-scene into the shared panel-judging library, so both suites use one implementation. Calibration keeps job concurrency at 1, because it already judges repeats concurrently.

### Evidence before merge

Claude and Codex run on subscriptions, so model calls are limited by usage, not dollars. Before the rescore batch, which is by far the largest step, acceptance confirms there is enough usage headroom.

1. **Preflight.**
   - **Rescore sources.** Confirm that the baseline reps 1–3, #78 reps 1–2 and the seven morph reps load through the current rescore path: retained evidence matches its manifest, and the workflow-history and workflow-argument checks pass. Their artifacts and open draft PRs exist today. Three morph reps date from rubric 5.0.0 and older Runner revisions, so loading them is the real risk. The morph shipping rule says what happens if one fails.
   - **Replay inputs.** Confirm that the replay's inputs are present and match their provenance:
     - the recorded #78 rep 2 judging records (`e78-rep2-judging-records.tar.gz`);
     - the raw judge logs that hold the decider's first votes before re-cite (`e78-rep2-judge-raw-logs.tar.gz`, preserved in the research folder).
   - **Tester logs.** Confirm that baseline rep 1's testing evidence includes its multi-round tester logs. The research suspects the round-0 log was dropped. If it was never collected, rescoring cannot recover it, and that rep's `testing-evidence-traceable-coverage` result is recorded as partly an eval defect. If it is dropped while the evidence view is built, the fix is an evaluator change and lands before the freeze.
2. **Unit tests and replay.**
   - `npm run check` includes known-answer settlement cases:
     - the active-state route;
     - a contradicted browser-fallback pass with an `insufficient` check;
     - a decider fail citing a counterexample, one citing a search scope, and one citing neither;
     - the INV-093 shape (Claude `met`, both Codex seats `partial`, decider `met` on weak citations);
     - disclosure cases that accept a leak, reject a leak, and get an `insufficient` check, with their effect on the coverage denominator.
   - The replay feeds the recorded #78 rep 2 judging through the new settlement rules.
     - It uses the decider's first votes from the raw logs, because the completed records keep only the re-cited verdicts.
     - If those raw inputs are ever lost, its output is labelled a reconstruction, never a replay.
     - The research's projected 0.5-point result was worked out by hand and has not been computed.
3. **Targeted model checks.**
   - **INV-093 decider.** Run the new overrule check against the retained r7 INV-093 ruling itself: the recorded `met`, its stated reason and its citations (about one Opus call). The check must run, must not confirm the overrule, and must leave the two-seat `partial` standing. A fresh decider re-run would not test the ruling that motivated the fix.
   - **Known answers.** Judge the known-answer accuracy set through the job-filtered judging path. Expected verdicts are fixed in advance, and the set includes the active-state Previous-button case, expected `fail`. A wrong verdict blocks the freeze.
     - Each expectation names the candidate revision, the criterion, the expected verdict and evidence covering the whole revised criterion. A historical majority verdict is not proof, and an expected pass needs more than refuting one failure reason.
     - The expected file is frozen and hashed before judging. Changing an expectation invalidates the checks that used it.
   - **Morph calibration.** Calibrate the morph criterion through the same path. Its result settles whether the criterion ships.
4. **Final rubric and free checks.** Settle whether morph ships, and solve the final weights. Then rerun `npm run check` and the and-scene `--calibrate`, which uses canned invokers and makes no model calls, against that final rubric.
5. **Define calibration.** One `--calibrate` run at r7's size, as a regression check: no loss of spread or agreement against r7. Jobs within each repeat run one at a time; repeats keep their concurrency of 6.
   - INV-093 should never be judged `met`, but this is weak evidence. Before the fix it was judged `met` in 1 of 3 repeats, so an unfixed panel would still pass three repeats about 30% of the time. Step 3 is the stronger evidence.
6. **Freeze the evaluator.** The evaluator revision, judge profiles, prompts, rubric and input manifests are fixed. Any later change to any of them reruns the checks it affects.
7. **Rescores.** Three rescores each of baseline reps 1–3 and #78 reps 1–2, so each rep gives three pairs. That is 15 rescores; one measured 13.0.0 rescore used about 4.5M judge input tokens, mostly cached.
   - **Target:** each pair has at most 1.0 point of total flipped points, measured as the sum of the points of every changed verdict, so opposing flips cannot cancel out.
     - Engineering-quality criteria are excluded from that budget and reported separately, since this change does not address them.
     - #78 rep 2 is the discriminating case: it is the only rep with a measured v1 failure (3.0 points). The baseline reps already varied by 0 to 0.5 points under earlier judging.
   - **Attribution is mechanical.** For each flipped criterion, the comparison records separately whether these differ between the two rescores: the original seat verdicts; the audits and checks; the effective votes; and the decider ruling. A check or decider invoked in only one rescore counts as a difference. Each flip is then:
     - **settlement**, when the original seat verdicts are identical but a check, effective vote or ruling differs;
     - **seat noise**, when the original seat verdicts differ and every check and ruling is the same;
     - **mixed**, when both differ.

     These labels say where the recorded outputs differ. They do not prove which difference caused the flip.
   - **When a pair misses the target:**
     - For #78 rep 2, sum the flipped points classified as settlement or mixed, excluding engineering quality. If that sum exceeds 1.0 point, merge is blocked.
     - Seat-noise-only points, and any miss on another rep, do not block merge on their own. They are reported, trigger an accuracy review of the flipped criteria, and put vote-share scoring to Paul as the follow-up.
   - **Each rep also reports:**
     - changes in gates, floors and eligibility;
     - per-criterion disagreements, including all 14 engineering-quality criteria, as counts with their denominators. Fifteen pairs are a diagnostic, not a reliable rate.
8. **Accuracy review.** Stability alone could hide a panel that became lenient rather than accurate. The review covers:
   - every criterion whose verdict differs between the old and new judging of the same code;
   - decider passes whose span audit stayed undecided, which now stand because a re-cite can no longer change them;
   - a sample of engineering-quality verdicts, which have no older verdicts to compare.

   Each verdict is recorded as correct or wrong, and each change is tagged as coming from revised wording or from the new settlement rules. An unresolved accuracy regression fails acceptance.

The rescores give the baseline and #78 scores under one rubric and protocol, and they feed #78's decision. They cannot by themselves attribute a score difference to task-compliance review: the baseline and #78 ran on different Agent Runner and Agent Skills revisions (`8e6a1ce` and `08fc069` for Runner), which changed implementor validator use and the skills available. Whether that decision needs a matched rerun belongs to #78.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `product-quality-scoring`:
  - tier weights replace equal division;
  - rubric 15.0.0 criteria, zero-point gate inputs and guidance;
  - `cross-family-panel-v2` settlement:
    - insufficient checks no longer dispute, except for contradicted browser-fallback passes;
    - confirmed contradictions reach the decider;
    - decider rulings are audited in both directions, and a re-cite cannot change a verdict;
    - check material includes the auditor's structured citations;
    - oversized-claim handling is defined;
  - evidence judges work against a finite basis rather than every behavior.
- `engineering-quality-scoring`: tier weights replace equal division within its subcomponents, and the job's pinned protocol becomes `cross-family-panel-v2`.
- `testing-evidence-evaluation`: the finite evidence basis, and the honest-record criterion no longer scoring omissions that traceable coverage scores.
- `ambiguity-evaluation`: its rule for material plan commitments follows the testing-evidence change.
- `failure-second-opinion`: outline second opinions target zero-point gate inputs rather than scored criteria.
- `definition-artifact-scoring`: a decider ruling that overrules a two-seat majority gets a targeted check, including in `rerunDecider` and calibration.
- `simulated-user`: disclosure-audit rulings get the same overrule check.

## Technical Approach

All settlement changes live in `evals/lib/panel-judging/` (`panel.mjs`, `protocol.mjs`), so both suites get them through one protocol version bump.

- **Rubric:** `automated-rubric.json` gains a per-criterion tier, and the scorer derives weights from the tier and the component. Rubric validation checks the following, replacing the equal-division and pinned-subcomponent-points checks:
  - component sums;
  - the tier ladder;
  - the 2-point cap.
- **Gate inputs:** the rubric gets a notion of a zero-point gate input. It keeps its deterministic browser observation, its fallback judge and its second-opinion path, so the scorer and the second-opinion code still find it. It does not go into the `removed` list.
- **Weights** are solved per component from the final criterion set. They are multiples of 1/16 (the scene kit needs sixteenths to fit morph; the rest stay in eighths), strictly decreasing by tier, with a 2-point cap. The weights must be re-solved after the gate-input change and the morph decision, so the research's tier table is a starting point, not the final numbers.
- **The define job pool** is lifted from `and-scene/lib/judge-jobs.mjs` into the shared library. It keeps #85's semantics, including the fix that reports a failure only after running jobs settle.
- **The replay** is a host-side script with no model calls. It reads the recorded judging records plus the decider's first votes from the raw logs. Because a re-cite can no longer change a verdict, it can apply the shipped rule to those first votes. It cannot model the new fail audits, the confirmed-contradiction route or the new check material, so it validates settlement logic only, and the rescores remain the real measure.
- **The job-filtered judging path** runs only the named judge jobs, such as the scene-kit and verification-tooling jobs, on a retained run.
  - It serves the morph calibration and the pre-freeze known-answer checks, and later criterion calibrations can reuse it.
  - Its results are calibration diagnostics and are never published.

**Risks:**
- **Leniency.** Symmetric proof and settling undecided checks upstream could make judging lenient. Three things address it:
  - the confirmed-contradiction route;
  - the finite evidence basis;
  - the known-answer and accuracy reviews.
- **A weak first pass now stands.** Because a re-cite can no longer change the verdict, a decider pass on weak evidence stands unless a contradiction is confirmed. This is accepted so that settlement is replayable and the decider's first judgment is final. The accuracy review samples these passes.
- **Invalidated rescores.** Any evaluator change after the rescores invalidates them, not only a rubric change. Hence the freeze in step 6, with every cheaper check run before it.

## Out of Scope

- **Fixture changes in the and-scene repository.** These are the attribution URL and placement, exits inside a grouped scene, and a note that ids survive reordering. Old runs could not fairly be scored against a fixture they never saw, so these land as a separate and-scene change with #87's first new runs.
- **#87.** Starting the eval from the definition artifacts and running the plan workflow is a separate change, as are any new baseline or candidate runs.
- **The experiment baseline record (#73).** Its rescore lineage rules and median human review do not fit acceptance rescores, so it is seeded later from #87's new baseline.
- **A matched-input rerun for the #78 decision.**
- **Acting on engineering-quality disagreement counts.** Sharpening guidance or lowering weights is a follow-up once the data exists.
- **Vote-share scoring over more Codex samples.** It is adopted later only if the rescores show the testing-evidence criteria still flipping.
- **Deterministic visual-helper probes.**
- **Moving `verification-preview-process-ownership`** into engineering quality.
- **Retrieval of cut supporting logs and screenshot inspection.** A judge still sees supporting logs only up to their excerpt and screenshots only as records. A criterion that needs more is a harness failure instead of a guess. A follow-up issue records both.
- **Other variance-report options:** a content-addressed judge cache, a reported score band, and pinning seat reasoning effort.

## Impact

- **Code:**
  - `evals/lib/panel-judging/` (settlement, protocol, audit schema, a new shared job pool);
  - `evals/agent-runner/and-scene/`:
    - rubric and scoring: `automated-rubric.json`, `lib/scorer.mjs`, `lib/rubric.mjs`;
    - gate and second-opinion handling: `lib/second-opinion.mjs`, `lib/browser-eval.mjs`, `lib/traceability.mjs`;
    - judging: `lib/judge-jobs.mjs`, the job-filtered judging path;
    - the replay script and the README;
  - `evals/agent-runner/and-scene-define/` (`lib/judging.mjs`, `lib/judge-jobs.mjs`, README).
- **Tests:** added to existing `test/*.test.mjs` files and run by `npm run check`. No new suite and no CI job.
- **Comparability:**
  - 15.0.0 and `cross-family-panel-v2` results start a new series and are not comparable with 12.x–14.0.0 results unless re-judged with `--rescore-from`.
  - No 15.0.0 reference baseline exists yet, so report comparisons against a reference refuse until one is run.
  - Rescores need the source run's artifacts and open draft PRs, and factory artifacts are subject to retention pruning.
  - One historical run (`ef8dafa5` rep 2, rubric 4.0.0) would fall below the eligibility threshold under the research's tier table. Historical results are not edited.
- **Usage:** model calls run on Claude and Codex subscriptions, so the constraint is the usage limit, not cost.
  - **Rescores:** 15, the largest batch, at roughly 4.5M judge input tokens each, mostly cached.
  - **Morph calibration:** 14 scene-kit judgings.
  - **Known-answer checks:** a few targeted judgings.
  - **Define calibration:** one run at r7's size.
  - **INV-093 check:** one targeted decider check.
