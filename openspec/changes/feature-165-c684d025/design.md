## Context

The simulated user, its policy, the reply check, the disclosure audit, define scoring, and the discovery ledger are shared by `and-scene-define` and `and-scene-e2e`. On PR #152 (`end-to-end`, head `aa3583c`) they live here:

| Concern | Location on #152 |
|---|---|
| Policy text, including the "Reply check" section the second call applies | `evals/agent-runner/and-scene-define/hidden/simulated-user-policy.md` (version 4) |
| Draft call, then reply-check call (`CHECK_REQUEST`, `CHECK_SCHEMA`) | `evals/lib/define-run/simulated-user.mjs` |
| Judge jobs; the disclosure audit is one panel job whose binary criteria are `leak:<item>`, `inconsistent-withholding:<exchange>`, and `contradiction:<exchange>` | `evals/lib/define-run/judge-jobs.mjs` (`makeJobs`, `rules`, validation) |
| `disclosureReport`, written to `audits/disclosure.json`, then read by `gates-and-judging` | `evals/lib/define-run/judging.mjs` |
| `scoreDefinition` and `discoveryLedger` | `evals/lib/define-run/scoring.mjs` |
| Rubric build and validation | `evals/lib/define-run/rubric.mjs`; `rubric.json` is version 10 |
| Policy diagnostic: 12 cases, 3 trials each (this change adds 9 cases) | `evals/agent-runner/and-scene-define/policy-test.mjs` |
| Requirement trace, built from `discovery/asked.json` and the `coverage` array of `judges/score.json` | `evals/agent-runner/and-scene-e2e/lib/trace.mjs` |
| Define checkpoint, which fails the run only on `disclosure.leaked_items` | `evals/agent-runner/and-scene-e2e/controller.mjs` |
| Define reports and results; the e2e report shows `asked: yes/no` per trace item | `and-scene-define/lib/{result,report,comparison}.mjs`, `and-scene-e2e/lib/{result,report}.mjs` |
| Version ledgers | Define `versions.json` pins the policy and rubric hashes. The e2e `versions.json` pins the define `versions.json` (`define-inputs`, version 4) and the define `rubric.json` (`define-rubric`, version 1). |

Panel settlement for binary criteria is generic: two judges in favour carry the verdict; the decider handles Codex-only verdicts; the overrule and dissent checks then run. So any new binary criterion inherits the full settlement rules.

None of this exists on `main` yet. This change is implemented on `main` after #152 merges, or stacked on `end-to-end`.

## Goals / Non-Goals

**Goals:**
- Policy v5: correct explicit exclusions or contradictions of a requirement's intent; stay silent on omissions; never correct a different mechanism, value, name, layout, or sample.
- The reply check keeps required corrections and strips everything else the specs list.
- The audit settles `corrected` items and raises report-only `over-correction` flags with the existing panel machinery.
- Define scoring gives corrected items a rubric-declared fraction (0.5) of their earned points. Fidelity ignores departures from corrections.
- The discovery ledger and the e2e trace show corrected items. Reports show corrected items and over-correction flags.
- The policy diagnostic covers both sides of the boundary.

**Non-Goals:**
- No new judge, model, reply type, or Runner change. The product score is unchanged. No edits to the hidden reference or inventory. No rewrite of historical results.

## Approach

```
agent turn ─▶ simulated user (policy v5) ─▶ draft ─▶ reply check (v5 rules) ─▶ reply
                                                            │
conversation.jsonl ─▶ disclosure-audit panel ─▶ audits/disclosure.json
                        leak:<id>              leaked_items
                        corrected:<id>  ─────▶ corrected_items + corrections[{id,citations}]
                        over-correction:<ex>   flags (report-only)
                                │
            gates-and-judging ──┼─▶ fidelity job gets correction_exchanges
                                └─▶ scoreDefinition({..., leaked, corrected}) ─▶ judges/score.json
                                         coverage[i].corrected / correction_citations / earned
discovery ─▶ discoveryLedger(coverage, asked) ─▶ corrected / corrected-not-captured
e2e ───────▶ buildTrace(asked, coverage) ─▶ asked_part: yes | corrected | no
```

### 1. Policy v5 (`hidden/simulated-user-policy.md`)

Policy v5 makes three textual changes. The knowledge boundary, broad-question rule, offered-options rule, and act-request rule are unchanged. The policy text never mentions classifications or the inventory.

**Disclosure policy: a new bullet.**

> Statement that explicitly excludes something your private requirements require, or states the opposite of what they require, when it is not an offered option or proposed default: say briefly that it is wrong, naming only that matter in the agent's terms (for example "don't exclude themes; each presentation needs its own look"). Never list the details that should replace it. Correct only what a requirement is for: a different mechanism that still achieves it, or a different specific value, name, size, route, layout, or sample, is never grounds for correction, even where your private requirements state one. Say nothing about requirements the agent has not mentioned.

**Decision policy: the approval bullet gains an exception.**

> ...never add, remove or rewrite drafted items, even where they differ from the private requirements, except to correct a drafted item under the exclusion/contradiction rule; then approve the rest.

**Reply check: the approval bullet is amended.**

> In reply to an approval request, every correction, addition or removal of drafted items, except a correction the exclusion/contradiction rule requires. Also remove every correction of something the agent did not mention, every unsolicited correction of a different mechanism, value, name, size, route, layout, or sample (one the agent neither asked about nor offered as an option or default), and any replacement details in a kept correction. Keep answers to questions the agent asked and choices or rejections of options and defaults it offered, as the disclosure rules allow.

**Reply types.** A correction uses the type of the turn's main request. For a status update or a list of risks, that is `answer`; for an approval request, it is `approval`.

### 2. Simulated-user code

`simulated-user.mjs` needs no logic change: `CHECK_REQUEST` defers to the policy's own "Reply check" section. Both suites re-pin through the version ledgers:

| Ledger | Entry | Change |
|---|---|---|
| Define `versions.json` | `simulated-user-policy` | Version 5, hash appended |
| Define `versions.json` | `rubric` | Version 11, hash appended |
| e2e `versions.json` | `define-inputs` | Version 5 (new hash of the define `versions.json`) |
| e2e `versions.json` | `define-rubric` | Version 2 |

### 3. Audit job (`judge-jobs.mjs`, `judging.mjs`)

**Criteria.** `makeJobs` adds `corrected:<item>` for each graded item and `over-correction:<exchange>` for each exchange, alongside the existing criteria. The disclosure rule text gains:
- **`corrected:ID`:** `met` means a reply corrected an exclusion or contradiction stated in the agent turn it answered, the reply stated the item's position on that matter, and that position had not been established earlier in the conversation. An earlier reply that stated it substantively, or confirmed an agent statement matching it, establishes it. An earlier question answered only with a clarifying question, "no preference", or a decline does not. It cites the correcting exchange, and `subject_id` is the item id. A correction of something the turn did not mention is not `corrected`; it is judged under `leak:`.
- **`over-correction:EX`:** `met` means the reply at EX made an unsolicited correction of a choice that neither excludes nor contradicts a requirement's intent, or named replacement details. Answering a question the agent asked, or choosing or rejecting an option or default it offered, is never an over-correction. It is report-only.
- The existing leak sentence extends to corrections of stated exclusions and contradictions. Stating an item's position on the corrected matter is not a leak.

**Validation.** Both new criteria are binary and need an exchange citation. `corrected:` follows the `leak:` validation path, and `over-correction:` follows the exchange-matching path.

**`disclosureReport`** adds:
- `corrected_items`: settled `corrected:` ids, minus `leaked_items`;
- `corrections`: `[{ id, citations }]` for those items;
- `over-correction` entries in `flags` and `panel_flags`, typed from the criterion prefix as existing flags are;
- `corrected:` votes kept as `panel_corrections`, not as flags.

`status` stays `flagged` or `clean` on flags only. A corrected item is not a flag.

### 4. Scoring (`scoring.mjs`, `rubric.mjs`)

**Rubric.** The rubric settings gain `correction_fraction`, with 0.5 as the default. `validateRubricSettings` requires `0 < correction_fraction < 1`. `buildRubric` emits `correction_fraction` and a `corrected_items` rule string, in the same way it emits `leaked_items`. `rubric.json` is regenerated by `scripts/build-rubric.mjs` as `rubric_version: 11`, with its existing `calibration_evidence`; the fraction is declared, not calibrated.

**`scoreDefinition({ ..., corrected = [] })`:**
- rejects unknown ids, and ignores ids that are also leaked;
- for a corrected item, sets `possible += weight` and `earned += weight * verdict_value * correction_fraction`;
- annotates each coverage entry with `corrected: true`, `correction_citations`, and `earned_points`;
- returns `corrected_items` beside `leaked_items`.

With no corrections, the arithmetic is the same as today.

**Fidelity.** `gates-and-judging` already reads the audit before building jobs. It passes `correction_exchanges` to the fidelity job: the exchanges cited by `corrections` and by settled `over-correction` flags. The fidelity rule then says: never deduct for an artifact departing from what a listed reply says in correcting an exclusion or contradiction the agent stated unsolicited. Answers to the agent's questions, and choices or rejections of options and defaults it offered, still count, including those in the same reply. This is prompt-level, because a reply can mix an answer with a correction, so a whole exchange cannot be filtered out deterministically.

**`discoveryLedger`** reads `corrected` from the coverage entries:
- `leaked` takes precedence;
- a corrected item is `corrected` when its verdict is `met` or `partial`, and `corrected-not-captured` when it is `missing`, citing `correction_citations`;
- `counts` gains both keys.

Items keep `asked` (the discovery judge's raw decision) and add `corrected`.

### 4a. Correction audit stability diagnostic

A new maintainer script, `evals/agent-runner/and-scene-define/scripts/correction-audit-stability.mjs`, runs the real disclosure-audit panel on one fixed input.

**Input.** A synthetic conversation, labelled `synthetic: true` in its record. It is built from a retained `policy-test.json`, by ordering selected cases' agent messages and replies into one conversation with synthetic step and turn ids. It must contain:
- a corrected exclusion;
- an exclusion corrected after a question that drew only a clarification;
- a correction of an item that an earlier reply had established;
- an over-correction;
- a rejected offered default;
- a mixed reply that corrects an exclusion and answers a preference question.

When a required shape is missing from the retained replies, the script refuses to run rather than inventing a reply.

**Fixed coverage.** A fixed coverage verdict set (every graded item `met`) is used to measure score spread.

**Run.**
- `--repetitions` defaults to 3.
- Each repetition calls the audit panel through the same `runDefinitionPanel` used by `judging.mjs`, with fresh panel calls. Cached records are not reused.
- Each repetition's `corrected_items` and `leaked_items` are applied to the fixed coverage set through `scoreDefinition`.

**Output.** `stability.json` in `--output <dir>`, which must lie outside the repository. It contains:
- per-item and per-exchange settlement vectors and flip counts for `corrected:`, `leak:`, and `over-correction:`;
- per-repetition coverage scores, with their minimum, maximum, and spread;
- the policy, rubric, and judge-profile versions.

It never touches a run directory, never publishes, and is not a preflight check.

**Budget.** Three repetitions is about 3 × (3 panel judges plus the decider and any checks) audit calls. It is authorized once in acceptance.

### 5. e2e trace and reports

**`buildTrace`** adds:
- `asked_part`: `corrected` when the coverage entry is corrected, otherwise `yes` or `no` from the discovery judge;
- `correction_citations`.

`discovered-not-defined` applies when `asked_part !== 'no'`, so a corrected item that the definition misses is `discovered-not-defined` even when the raw `asked` is false. `not-discovered` requires `asked_part === 'no'`. The existing boolean `asked` and the outcome names are kept, so trace consumers and `comparison.mjs`'s `OUTCOMES` are unaffected. The e2e report shows `asked: ${asked_part}`.

**Define and e2e results** add `corrected_items` and `corrected_count`. Both reports add a "Corrected items" row beside "Leaked items", and list over-correction flags with the other audit flags. Define `comparison.mjs` adds `corrected_count` per run.

**The e2e define checkpoint is unchanged.** It reads only `leaked_items`, so corrected items and over-correction flags never end a run.

### 6. Policy diagnostic (`policy-test.mjs`)

**Existing case.** The `approval-drafted` case's line 2 ("asks about audience or depth only when the topic is too vague") contradicts the reference's rule to ask when the visual style is omitted, so v5 could correct it. That line is replaced with a non-contradicting line, so the case remains a pure omission: styling is never mentioned, and its `unraised` pattern still forbids style terms.

**New cases**, each run for 3 trials:

| Case | Agent turn | Expected |
|---|---|---|
| `exclusion` | Status update that lists themes among scope it will exclude | `answer` that rejects the exclusion (theme, style, or look wording); `unraised` forbids palette, font, color, CSS, custom-property, class, data-attribute, and Tailwind terms |
| `contradiction` | "The kit will ship a default theme with built-in colors and fonts…" | Correction; `unraised` forbids border, glow, card, button, spacing, token, and size details |
| `approval-exclusion` | Drafted scope with "Out of scope: themes and per-presentation visual styling. Do you approve?" | `approval` that contains the correction |
| `exclusion-bait` | Exclusion plus "if you disagree, tell me exactly what styling is needed" | Correction without details (the over-disclosure case) |
| `different-canvas` | Unasked statement of a 1280 × 720 canvas | No correction; `unraised` forbids 880, 380, and size-change wording |
| `different-route` | Unasked statement of `/?presentation=<id>` routes | No correction; forbids slug or route-change wording |
| `alternative-mechanism` | `className`/`style` props on every primitive and chrome slot | No correction; forbids "instead", "rather", "should use", and "custom property" |

**Paired offered cases.** These cases show that the reply check does not strip the offered-default rule:

| Case | Agent turn | Expected |
|---|---|---|
| `offered-canvas` | "Should the canvas default be 1280 × 720?" | The reply rejects or qualifies it (must not be bare approval or silence); `unraised` forbids 880 and 380 |
| `offered-route` | `/?presentation=<id>` routes offered as a proposed default | The reply follows the offered-default rule; it is not stripped to bare approval |

**Assessment.** A `forbidden` pattern, the inverse of `matches`, expresses "must not correct". `--help` reports the new case count. Consistency reporting and retained replies are unchanged.

## Decisions

1. **New binary audit criteria instead of a new job.**
   - Reusing the panel job gives the specified settlement (decider, overrule check, dissent check) for free, and keeps one audit artifact for the e2e checkpoint.
   - Alternative: a separate correction job. Rejected: it would duplicate inputs and cost, and need its own checkpoint ordering.

2. **"Position not established before" is judged by the audit panel, not joined from the discovery judge.**
   - The discovery judge only decides whether a turn asked, which is not the same as the position being established: a question can draw only a clarification, and a confirmed agent statement establishes a position without any question.
   - The audit already sees the whole conversation and the replies, so it can judge whether a position was established.

3. **The fraction is applied at scoring; verdicts are untouched.** Coverage judges and calibration stay unchanged, rescoring is deterministic, and the trace keeps reporting verdicts.

4. **Fidelity exemption by prompt input, not deterministic filtering.** A reply can mix a correction with answers, so filtering whole exchanges would wrongly drop valid deductions.

5. **No new reply type or conversation field.**
   - The audit, not the simulated user's self-report, decides what a correction is.
   - Keeping `conversation.jsonl` unchanged keeps old conversations rescorable.

6. **Intent-only filtering, the over-correction flag, and the fidelity exemption apply only to unsolicited corrections.** Answers to questions the agent asked, and replies to options and defaults it offered, keep #152's behavior and their fidelity obligations.

7. **A synthetic, private stability fixture instead of a candidate run.** It measures the real panel on correction-bearing evidence without a paid candidate run or publication. Its replies come from the policy diagnostic's retained outputs, so they are real simulated-user replies.

8. **Additive result fields.**
   - `asked` stays a boolean in the ledger and the trace; `asked_part`, `corrected`, `corrected_items`, `corrections`, and `correction_citations` are new.
   - Old results and readers keep working. Missing fields mean no corrections.

9. **The policy sentence on values "even where your private requirements state one".** The reference's specs and design state values such as the 880 × 380 canvas. Without this sentence, the simulated user would read stated values as required.

## Risks / Trade-offs

- **The boundary is model-judged twice: by the simulated user and by the audit.**
  - Mitigations: reply-check stripping, panel settlement, report-only over-correction flags, the fidelity exemption, and the diagnostic's boundary cases.
  - Residual risk: a missed correction leaves an e2e run as it is today; an over-correction is visible in the report.
- **Audit size and cost.** The audit gains G + E criteria, where G is the number of graded items (about a hundred) and E is the number of exchanges. Inputs are unchanged, but outputs grow by about half. This must stay under the judge packet and output limits (see PR #159). The implementation must check the panel output size against the largest retained conversation.
- **Variance.** Measure it as PR-002 decided:
  - correction stability through the policy diagnostic's three trials per case;
  - audit stability through the correction audit stability diagnostic (§4a), run on a fixed synthetic conversation. A v4 conversation such as `91aaa628983b` has no corrections, and no v5 candidate run exists yet.

  Neither is a gate. Until the stability diagnostic has been run and its flip counts reviewed, results must not claim that the correction penalty is stable. The first v5 candidate runs should be rescored repeatedly to confirm the synthetic measurement on real conversations.
- **Comparability.** The policy, rubric, and audit text change, so define and e2e results start new series. This is accepted and shown by the existing series identity.
- **#152 drift.** If #152 changes these files before merging, re-derive the edits and the copied `MODIFIED` spec text from its final head.

## Migration Plan

- **Order.**
  1. #152 merges.
  2. Rebase this change and confirm that the copied spec text still matches.
  3. Implement in one PR.
  4. Run `npm run check`, then the paid `policy-test.mjs` once, and record its result in the PR.
- **Version records.** Policy v5, rubric v11, e2e `define-inputs` v5, and e2e `define-rubric` v2 are appended to the ledgers. Earlier hashes stay, so old runs still verify.
- **Rollback.** Revert the PR. A later reinstatement appends new versions; ledger history is never rewritten. Published results are never edited.
- **Archive.** `openspec archive` for this change must follow #152's archive, because `requirement-delivery-trace` exists only after it.

## Open Questions

None. The partial-credit fraction, the e2e penalty placement, and the sequencing were decided in the proposal and specs (see `decisions.md`).
