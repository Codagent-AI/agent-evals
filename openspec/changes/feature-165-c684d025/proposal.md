## Why

In and-scene-e2e run `91aaa628983b`, the lead's proposal turn said that an authoring GUI, PDF/PPTX export, and themes "are all tempting. I'd exclude them." The simulated user answered only the questions that turn asked. Simulated-user policy version 4 (on the `end-to-end` branch, draft PR #152) approves drafts as written. It "never add[s], remove[s] or rewrite[s] drafted items, even where they differ from the private requirements", and its reply check strips any correction from a reply to an approval request. So the exclusion went through unchallenged.

The hidden reference requires presentation-owned visual style: the skill establishes each presentation's visual style, and every presentation can customize the look of kit elements and chrome. That requirement was never discovered. The delivered product had no styling at all, and human review gave it 6.75 of 30.

A real product owner would have objected to "exclude themes". The current policy makes the simulated user more passive than any real user, so two different failures look the same:

- **Omission.** The agent never raised a requirement. This is what the discovery evals are meant to measure.
- **Explicit exclusion or contradiction.** The agent stated, in front of the user, something that rules a requirement out. A real user would correct this in the same conversation.

The second case now costs a candidate the whole requirement in both suites. In and-scene-e2e it can also cost most of the product score, so a single sentence in a proposal turn decides a run. The evals then under-report what the workflow would deliver with a real user, and they reward a workflow that hides its scope decisions from the user over one that states them openly.

This matters now because and-scene-e2e is about to become the main way Codagent workflows are compared from prompt to product. Its first runs already show the problem.

## What Changes

- **Simulated-user policy, new version (v5, shared by both suites).** When an agent turn explicitly excludes something the private requirements require, or states something that directly contradicts them, the simulated user corrects that statement, as a real user would. This applies whether the statement appears in a question, an option, a proposed default, a status update, or a draft put up for approval. The correction:
  - names only the excluded or contradicted matter, in the agent's terms (for example, "don't exclude themes; each presentation needs its own look"). It adds no details, commands, numbers, or further requirements, as the version 4 rule for wrong defaults already requires;
  - is applied only to what the agent's turns actually say. The simulated user still sees no artifact files.
- **Required intent, not reference choices.** The correction applies only when a turn rules out what a private requirement requires, meaning its intent. It does not apply when the agent picks a different admissible implementation. The simulated user does not correct:
  - a different mechanism that achieves the same intent (for example class hooks instead of CSS custom properties for presentation-owned styling);
  - a different specific value, name, or layout (for example a canvas size other than 880 × 380, or a route shape other than `/<slug>`);
  - sample or illustrative content.

  The simulated user cannot see the inventory classification. So the version 5 policy text makes the distinction in terms of its existing knowledge: required behavior and its purpose are grounds for a correction; examples, sample content, specific values, and mechanisms where another would serve are not. When the agent explicitly asks about one of those choices, the existing narrow-answer rules still apply, unchanged.
- **Corrections create no fidelity obligation.** A correction concerns a required item, which is already scored once under that item's coverage criterion. So the fidelity component does not deduct for a definition that departs from a correction reply. This means that if the simulated user over-corrects a preference-level detail, the agent's definition is not held to it.
- **Omissions stay silent.** When a draft or turn simply doesn't mention a private requirement, the simulated user says nothing about it. Broad-question, volunteering, and approval behavior are otherwise unchanged. An approval request that contains an exclusion or contradiction gets the correction plus approval of the rest.
- **Reply check.** The second-pass reply check keeps a correction of an explicit exclusion or contradiction. It still removes additions, corrections of omissions, and details the agent's message did not raise.
- **Disclosure audit.** The panel distinguishes a correction from a leak:
  - **Corrected.** A reply that corrects an exclusion or contradiction the agent stated is answering a matter the agent raised. The items it states on that matter are classified `corrected`, not leaked.
  - **Leaked.** Items a reply adds outside that matter can still be leaked.
  - **Corrections of omissions.** A reply that "corrects" an omission is over-disclosure.
  - **Settlement.** Corrected items are settled by the existing cross-family panel and settlement rule.
- **and-scene-define scoring.** A requirement covered only because the simulated user corrected the draft earns partial credit. Such an item is one whose position had not been established earlier in the conversation, by a substantive answer or by the user confirming the agent's correct statement, before the correction. It earns a fixed fraction of the coverage points its verdict would otherwise earn, declared in the rubric; this proposal suggests half. The discovery ledger gains a `corrected` outcome. This is a new define rubric version, and its results form a new comparison series.
- **and-scene-e2e penalty.** The e2e definition score already uses the define rubric unchanged, so a corrected item carries the same partial-credit penalty there. The requirement trace records the item as corrected instead of asked. At the define checkpoint, a corrected item does not fail the run; only a settled leak does. The product score is not changed: it grades what was delivered.
- **Policy tests.** The maintainer diagnostic, `policy-test.mjs`, already runs three trials per case. It gains these scripted cases:
  - **Corrected:** an explicit exclusion; a direct contradiction; an approval request with a contradicting drafted item, which gets the correction and the approval.
  - **Left silent:** an omission; a different canvas size; a different route shape; a valid alternative styling mechanism.
  - **Over-disclosure:** a same-topic correction that adds replacement details, which the policy and reply check must avoid.

  Retained replies are inspected for whether they actually follow the policy, not just for their reply type.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `simulated-user`: the disclosure policy, decision policy, reply check, and disclosure audit gain the exclusion/contradiction correction and the `corrected` classification. The policy tests gain the new cases, and a correction audit stability diagnostic is added.
- `definition-artifact-scoring`: requirement coverage gives partial credit for items covered only because of a correction. Fidelity does not deduct for departing from a correction reply.
- `requirement-discovery-diagnostic`: the discovery ledger gains a `corrected` outcome.
- `requirement-delivery-trace` (added by `end-to-end`): the asked part distinguishes corrected items.

## Technical Approach

- **Sequenced after `end-to-end` (#152).** The shared policy, the responder, the reply check, and the e2e suite exist only on the `end-to-end` branch. That branch has already claimed policy versions 2–4 and the define `versions.json` entries that pin them. Version 4's reply check removes exactly the corrections this change needs.
  - Building a define-only version on `main` now would collide with those version numbers. It would also be silently reverted when #152 merges, and it would leave the two suites inconsistent, which the issue rules out.
  - So this change is defined against `main` as it will be after #152 merges. Its implementation must start from that `main`, or be stacked on the `end-to-end` branch. The new policy is version 5.
  - Spec deltas must copy each `MODIFIED` requirement from the post-#152 text, per the repository's OpenSpec rule.
- **Policy, not a new component.** The correction is a policy-text change plus a reply-check change in the existing shared simulated user (`evals/lib/define-run/`). Detection and scoring reuse the existing disclosure audit panel and settlement, and the existing coverage criteria. No new judge, model, or dependency is added.
- **Scoring by subtraction.** Coverage judges still return `met`/`partial`/`missing` against the anchors. Scoring then applies the rubric's correction fraction to settled corrected items, the same way leaked items are excluded today. This keeps coverage judging unchanged and makes rescoring deterministic.
- **Key risks.**
  - **Over-correction and leakage.** A looser policy could turn the simulated user into a reviewer that steers drafts toward the reference. Mitigations:
    - the correction is limited to explicit exclusion or direct contradiction, named in the agent's terms without replacement details;
    - the reply check enforces that limit;
    - the audit still catches leaks outside the matter;
    - the new policy-test cases cover both directions.
  - **Exclusion vs. omission vs. a different choice.** The hardest boundary is between ruling out a required intent and choosing a different admissible mechanism or value. The policy text draws it in terms of required behavior versus examples, values, and mechanisms, without exposing the inventory classification. Policy-test cases cover both sides.
    - An over-broad reading would otherwise reach scores in two ways. Fidelity deducts against simulated-user answers about preferences, for example the 880 × 380 canvas (`INV-033`) or `/<slug>` routes (`INV-113`). And an acceptable-alternative item accepts other mechanisms.
    - Exempting correction replies from fidelity closes the first path. The policy's acceptance of alternative mechanisms closes the second.
  - **Variance.** Two sources must be measured separately, because a rescore reuses the retained `conversation.jsonl` and never calls the simulated user again:
    - **Audit stability:** a maintainer diagnostic reruns the real disclosure-audit panel several times on one fixed, private, synthetic correction-bearing conversation built from retained policy-diagnostic replies. It measures how often the `corrected` classification flips, and the resulting score spread. Until that measurement has been reviewed, results do not claim the penalty is stable.
    - **Correction stability:** repeated `policy-test.mjs` trials on identical agent turns and conversation prefixes measure how consistently the correction and the reply check behave.

    Neither measurement is a gate for candidate runs.
  - **Comparability.** Policy, audit, and rubric version changes start new define and e2e series. Earlier results stay valid but are not paired with new ones.

## Out of Scope

- Correcting omissions, or any change to the broad-question, volunteering, or act-request rules.
- Giving the simulated user access to artifact files or the inventory classification.
- Editing the pinned hidden reference or inventory to mark which wording is required and which is illustrative. The version 5 policy text makes that distinction instead.
- Changing the e2e product rubric or product score, or adding a combined score.
- Changing `and-scene` (the implementation-only suite) or its rubric.
- Rescoring or editing historical results; the experiment baseline is not re-cut.
- Choosing the partial-credit fraction by calibration. The rubric declares it, and later calibration can revise it.
- Landing any part of this change on `main` before #152 merges.

## Impact

- **Code (post-#152 paths):**
  - the shared simulated user and reply check in `evals/lib/define-run/`;
  - `evals/agent-runner/and-scene-define/hidden/simulated-user-policy.md` and `versions.json`;
  - the disclosure-audit judge job and settlement;
  - define coverage scoring and the rubric;
  - the discovery ledger;
  - the e2e trace and its `versions.json` pin of the define inputs;
  - `policy-test.mjs`;
  - reports and result schemas, which gain the `corrected` classification additively;
  - the tests for each.
- **Specs:** the four modified capabilities above.
- **Results:** new rubric, policy, and audit versions. Existing published results are untouched, and rescoring an old run applies current evaluators as today.
- **Dependencies:** PR #152 must merge first, or this change must be stacked on its branch. There are no new third-party dependencies and no changes to Agent Runner.
- **Users:** maintainers get define and e2e scores that reflect what a workflow would deliver with a real user who objects to explicit exclusions. Discovery of unmentioned requirements is measured the same as before.
