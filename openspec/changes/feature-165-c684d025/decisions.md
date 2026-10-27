# Decisions

## proposal

1. **Verdict: go with caveats.**
   - Alternatives considered: no-go (keep the passive simulated user, since discovery is what is measured); go without caveats.
   - Reason: the issue's motivating run shows that an explicit exclusion goes unchallenged under policy v4. A real user would object, so the eval under-reports what the workflow would deliver. The caveats are the sequencing after #152, the risk of over-correction or leakage, and the start of new comparison series.
   - Decision-bearing: yes.

2. **Sequence after PR #152 (`end-to-end`). Define the change against `main` as it will be after #152 merges, and implement from that `main` or stacked on the `end-to-end` branch. The new policy is version 5.**
   - Alternatives considered: land a define-only policy v2 on `main` now and do the e2e part later.
   - Reason: the policy is shared, and the e2e branch already claims policy versions 2–4. Version 4's reply check strips exactly these corrections. A define-only change on `main` would collide with those version numbers, would be reverted when #152 merges, and would leave the suites inconsistent, which the issue's "Both suites" request rules out. The issue itself states that the e2e part depends on #152 merging.
   - Decision-bearing: yes.

3. **The correction applies to explicit exclusions and direct contradictions in any agent turn, not only in approval requests.**
   - Alternatives considered: correct only in approval or draft turns.
   - Reason: in run 91aaa628983b, the exclusion appeared in a proposal turn that asked questions, not in an approval request.
   - Decision-bearing: no.

4. **A correction names only the excluded or contradicted matter, in the agent's terms, with no replacement details.**
   - Alternatives considered: a correction that restates the full requirement.
   - Reason: this is consistent with version 4's rule for wrong defaults, and it limits leakage.
   - Decision-bearing: no.

5. **The disclosure audit panel identifies corrected items, using the existing settlement rule.**
   - Alternatives considered: the discovery judge (a single, non-scoring judge); the reply type the simulated user reports for itself.
   - Reason: the result affects the score, so the cross-family panel should settle it.
   - Decision-bearing: no.

6. **Define partial credit is a rubric-declared fraction of the item's verdict points, proposed as one half. It applies when the agent first learned the item's position from a correction.**
   - Alternatives considered: downgrade the item to `partial`; a fixed point deduction; calibrate the fraction first.
   - Reason: the issue says "partial credit" without an amount. A declared fraction keeps coverage judging unchanged and makes rescoring deterministic.
   - Decision-bearing: no (the issue leaves the amount open).

7. **The e2e penalty is carried by the e2e definition score, which uses the define rubric unchanged, and by the trace. The product score is unchanged, and a corrected item does not fail the define checkpoint.**
   - Alternatives considered: deduct from the product score; fail or flag the run.
   - Reason: the issue asks for "some penalty" without saying where. The product rubric grades delivered behavior, and the e2e suite deliberately reports the two scores separately.
   - Decision-bearing: no (the issue leaves the mechanism open; this is recorded as an assumption).

8. **Corrections apply only to drafts stated in agent turns. The simulated user still sees no artifact files.**
   - Alternatives considered: give the simulated user the artifacts.
   - Reason: the knowledge-boundary requirement is unchanged, and the issue does not ask for artifact access.
   - Decision-bearing: no.

## proposal-review

1. **PR-001 (significant): applied.**
   - The correction is now limited to exclusions or contradictions of a requirement's intent. Different admissible mechanisms, specific values, names, layouts, and sample content are not corrected.
   - The version 5 policy text draws this line in terms of required behavior versus examples, values, and mechanisms. It does not expose the inventory classification and does not edit the pinned reference.
   - Narrow answers to explicitly asked preferences are unchanged.
   - Fidelity no longer deducts for departing from a correction reply, so an over-correction cannot create a scoring obligation.
   - Policy-test cases now cover a different canvas size, a different route shape, and a valid alternative styling mechanism.
   - Alternatives considered:
     - annotate the hidden reference to mark which wording is normative and which is illustrative (rejected: it changes pinned fixture inputs and needs re-review of the inventory);
     - pass a filtered "required intents" list to the responder (rejected: that is close to exposing the inventory classification, which the knowledge boundary forbids);
     - leave the boundary for the specs to settle with examples (rejected: the finding correctly shows that this boundary affects scores).
   - Decision-bearing: yes. It narrows the policy and adds a fidelity exemption, but stays within the issue's "exclusions and contradictions" request, so it is not direction-level.

2. **PR-002 (minor): applied.**
   - Variance measurement is now split into two parts:
     - audit-classification stability, measured by repeated rescores of a fixed conversation;
     - correction and reply-check stability, measured by repeated `policy-test.mjs` trials on identical turns and conversation prefixes, with retained replies inspected for policy compliance.
   - A same-topic over-disclosure case is added.
   - Alternatives considered: repeated full candidate runs (rejected as costly, and they mix in agent variance).
   - Decision-bearing: no.

## specs

1. **`MODIFIED` requirements for `simulated-user` and `requirement-delivery-trace` are copied from PR #152's change deltas (`end-to-end` head `aa3583c`), not from `main`. `definition-artifact-scoring` and `requirement-discovery-diagnostic` are copied from `main`, because #152 does not change them.**
   - The other open PRs (#164, #159, #132, #108) touch no OpenSpec files.
   - Scenario headers are kept unchanged.
   - Alternatives considered: copy from `main` (rejected: that would silently revert #152's policy, reply-check, and audit updates).
   - Decision-bearing: yes. Archiving requires #152 to be archived first, because `requirement-delivery-trace` does not exist on `main` yet.

2. **Unsolicited statements that exclude or contradict a requirement's intent are corrected. Offered options and proposed defaults keep their existing #152 rule unchanged.**
   - Alternatives considered: restrict the existing "wrong proposed default" rule to intent as well.
   - Reason: that rule already applies when a matter is put to the user. Narrowing it would change behavior that #152 calibrated, and the issue does not ask for it.
   - Decision-bearing: no.

3. **`corrected` is a new `Correction audit` requirement, settled by the same panel, decider, and check rules as `leaked`. A leak takes precedence. An item is not `corrected` when an agent turn asked about it before the correction.**
   - Alternatives considered: the discovery judge decides; a self-reported reply type.
   - Reason: the classification affects the score, so the panel settles it, as it settles leaks.
   - Decision-bearing: no.

4. **Over-correction is a report-only audit flag. Correcting an omission is judged as over-disclosure, and can therefore leak.**
   - Alternatives considered: score penalties for over-correction.
   - Reason: it is a simulated-user fault, not a candidate fault. This mirrors how withholding flags are report-only.
   - Decision-bearing: no.

5. **Partial credit is applied to earned points only. Possible points and the verdict are unchanged, and the fraction is set to one half in the first rubric version that declares it.**
   - Alternatives considered: downgrade the verdict; exclude the item, as is done for leaks.
   - Reason: excluding the item would reward the candidate; downgrading the verdict would conflate the correction with artifact quality.
   - Decision-bearing: no.

6. **The discovery ledger gains `corrected` and `corrected-not-captured`. In the trace, the asked part is Yes, Corrected, or No, and the trace's outcome names are unchanged.**
   - Alternatives considered: a single `corrected` outcome for any coverage verdict; new trace outcomes.
   - Reason: a correction the definition still drops is worth seeing separately in the define diagnostic, while the trace already locates losses by stage.
   - Decision-bearing: no.

7. **Policy-test stability comes from repeated trials on identical turns, which the diagnostic already runs: three trials per case on PR #152. The spec requires several trials, a per-case consistency report, and retained replies.**
   - Decision-bearing: no.
   - Note for design: PR #152's existing `approval-drafted` case drafts "asks about audience or depth only when the topic is too vague". That may contradict the reference's requirement to ask when the visual style is omitted, so under v5 the case could legitimately draw a correction. Design must re-check that case's draft so it stays a pure omission or mechanism difference.

## design

1. **The audit gains binary `corrected:<item>` and `over-correction:<exchange>` criteria in the existing disclosure-audit panel job.**
   - Alternatives considered: a separate correction job.
   - Reason: reusing the panel job gives the specified settlement unchanged and keeps one audit artifact for the e2e checkpoint.
   - Decision-bearing: no.

2. **The audit panel judges "not asked before the correction" itself, without joining in the discovery judge.**
   - Alternatives considered: join the discovery judge's cited exchange.
   - Reason: the discovery judge is a single, unpanelled judge that runs after scoring.
   - Decision-bearing: no.

3. **The correction fraction (`correction_fraction: 0.5`, rubric v11) is applied in `scoreDefinition`. Coverage verdicts and calibration are unchanged.**
   - Decision-bearing: no.

4. **The fidelity exemption is applied through a `correction_exchanges` prompt input, not by deterministic filtering.**
   - Reason: a reply can mix answers with a correction, so filtering whole exchanges would drop valid deductions.
   - Decision-bearing: no.

5. **No new reply type or conversation field, and all result fields are additive.**
   - The ledger and trace keep the boolean `asked` and add `asked_part`, `corrected`, and the citations.
   - Alternatives considered: change `asked` to a string (rejected: it breaks readers of persisted results).
   - Decision-bearing: no.

6. **Policy v5 says outright that specific values, names, sizes, routes, layouts, and samples are never grounds for correction, even where the private requirements state one.**
   - Reason: the reference's design states such values.
   - Decision-bearing: no.

7. **The `approval-drafted` diagnostic case's line 2 is replaced with a non-contradicting line, so the case stays a pure omission. Seven boundary cases are added.**
   - Decision-bearing: no.

8. **Rollout: implement after #152 merges, with versions appended (policy 5, rubric 11, e2e `define-inputs` 5, e2e `define-rubric` 2) and rollback by revert. Archiving follows #152's archive.**
   - Decision-bearing: no.

## test-plan

1. **There are four offline integration obligations and no new automated E2E test:**
   - INT-001: define judging lifecycle;
   - INT-002: e2e checkpoint, trace, and result;
   - INT-003: rescore and old results;
   - INT-004: version ledgers.

   - Alternatives considered: an automated paid candidate run (rejected: hours of runtime, cost, and nondeterminism).
   - Decision-bearing: no.

2. **Model correction behavior is measured by one authorized paid `policy-test.mjs` run in acceptance, with up to two re-runs. Prompt text is never tested.**
   - Alternatives considered: a CI gate on the live diagnostic (rejected: the spec says the diagnostic is not a gate, and it is paid).
   - Decision-bearing: no.

3. **Acceptance may run one define rescore of an existing retained run. Candidate runs, e2e runs, publication, fixture changes, and `results/**` edits are off limits.**
   - Decision-bearing: no.

4. **No human-only testing.** The agent can judge semantic compliance from the retained diagnostic replies.
   - Decision-bearing: no.

## approach-review

1. **AR-001 (high): applied.**
   - The intent-only filter in the reply check, the `over-correction` flag, and the fidelity exemption now cover only unsolicited corrections: corrections of statements the agent neither asked about nor offered as an option or proposed default.
   - Answers to asked questions, and choices or rejections of offered options and defaults, keep #152's behavior and their fidelity obligations, including inside a mixed reply.
   - Added scenarios:
     - simulated-user: "Check keeps a rejection of an offered default", "Rejecting an offered default is not an over-correction", "Offered default rejection is stripped";
     - definition-artifact-scoring: "Mixed reply keeps its preference answer", "Rejected offered default still binds".
   - Added paired diagnostic cases `offered-canvas` and `offered-route`.
   - Added a paid fidelity check on a mixed reply to the acceptance envelope.
   - Alternatives considered: keep the filter unscoped and document the change (rejected: it would alter ordinary discovery behavior beyond the issue).
   - Decision-bearing: yes, but not direction-level, because it restores scope that the issue and earlier decisions already intended.

2. **AR-002 (medium): applied.**
   - `corrected` now requires that the item's position was not established earlier in the conversation. A position is established by a substantive reply, or by a reply confirming an agent statement that matches it. A question answered only with a clarification, "no preference", or a decline does not establish it.
   - The proposal, the Correction audit requirement, the design (§3 and decision 2), and the timeline scenarios ("Item established before the correction", "Confirmed agent statement establishes the item", "Unanswered question does not establish the item") are aligned to this rule.
   - Alternatives considered: keep the prior-question proxy (rejected: as the finding shows, it diverges from first learning in both directions).
   - Decision-bearing: no.

3. **AR-003 (medium): applied.**
   - Added an ADDED requirement, "Correction audit stability diagnostic", and design §4a: `scripts/correction-audit-stability.mjs`.
     - It runs the real audit panel 3 times by default on a private conversation labelled synthetic, assembled from retained policy-diagnostic replies.
     - It reports per-item flips and the coverage-score spread.
     - Its output goes outside the repository, and it is neither a gate nor a publisher.
   - Added test INT-005 and one authorized paid run in the acceptance envelope.
   - Claims that the penalty is stable are withheld until the result has been reviewed. The first v5 candidate runs are rescored repeatedly to confirm the measurement.
   - Alternatives considered: defer until a v5 candidate run exists (rejected: the score-affecting judgment would ship unmeasured); a paid candidate run in acceptance (rejected: hours of runtime, publication risk, and mixed-in agent variance).
   - Decision-bearing: no. It is a bounded maintainer diagnostic within the proposal's existing variance commitment.

4. **AR-004 (medium): applied.**
   - Existing scenario headers are kept. The WHEN clauses of "Requirement found by asking" and "Requirement never raised" (ledger), and of "Requirement never raised" (trace), now exclude settled corrections and leaks.
   - "Correction not captured" now asserts `corrected-not-captured` rather than `missed`.
   - Added the trace scenario "Corrected requirement not written down" (`discovered-not-defined`, asked part Corrected).
   - Design §5 states the `asked_part` rule for outcomes.
   - INT-001 asserts the ledger counterpart, and INT-002 asserts the corrected-but-missing branch with raw `asked: false`.
   - Decision-bearing: no.

## tasks

1. **One implementation task covers the whole change, as instructed.**
   - It starts with an explicit precondition: build on #152, whether merged or stacked on `end-to-end`, and stop and report if neither is available rather than re-implementing #152.
   - Paid diagnostics and the archive are left to the acceptance pass and to after #152's archive.
   - Alternatives considered: several tasks, split by suite (not allowed by the step instructions).
   - Decision-bearing: no.
