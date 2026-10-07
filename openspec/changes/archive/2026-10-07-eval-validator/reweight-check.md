# Re-weighting check

> **FLIP: one known run changes eligibility. It is not one of the baseline, #71 or #78 runs.**
> `d249aaa4-5b6a-4f36-8f95-f42d684f044c-rep-3` (agent-evals #57, task-compliance opt-in, rubric 6.0.0) meets the old demo floor exactly (15.00/24) but misses the new one (12.43/20 against 12.5). It goes from automated-eligible to not eligible, whatever its engineering score. Per design.md ("If a known run's eligibility flips, stop and surface it before merging"), the flip was surfaced to the maintainer. **Decision (2026-10-06): accept the flip and keep both floors at 12.5** (the 62.5% ratio). The run is old and sat exactly on the old boundary. See "Flip analysis" below.
>
> None of the target runs flips its floor status or eligibility: the three baseline runs (#67), the #78 run, and the two #71 no-validator runs.

This is arithmetic over recorded criterion verdicts only. It makes no model calls and does no rescoring. It applies the new demo technical quality and scene kit correctness points and floors from `design.md` ("Point funding") to existing verdicts. The new 8-point engineering-quality component is unscored for every run here and is excluded.

## Runs and result files used

The baseline, #78 and #71 runs are not in `evals/agent-runner/and-scene/results/`. Their factory comments show that publication to agent-evals failed ("results could not be saved"). The result files therefore come from the factory artifact directories on this Mac:

| Run | Issue / role | Rubric scored with | Result file (sha256 prefix) |
|---|---|---|---|
| `cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-1` | #67 baseline | 6.0.0 | `/Users/paul/.agent-factory/artifacts/cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-1/result.json` (`cc76bd8d1a71`) |
| `cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-2` | #67 baseline | 6.0.0 | `/Users/paul/.agent-factory/artifacts/cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-2/result.json` (`90e4331e6288`) |
| `cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-3` | #67 baseline | 6.0.0 | `/Users/paul/.agent-factory/artifacts/cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-3/result.json` (`ca684dd560bc`) |
| `4a0ed9e3-c9c9-4c74-bf18-ca5d5bc43ff1-rep-1` | #78 (baseline + task-compliance); rep-2 failed technically, rep-3 not started | 7.0.0 | `/Users/paul/.agent-factory/artifacts/4a0ed9e3-c9c9-4c74-bf18-ca5d5bc43ff1-rep-1/result.json` (`e451f103ead7`) |
| `c08f12bb-4305-45cf-a9d7-cb46b01c1358-rep-1` | #71 no-validator (bonus) | 6.0.0 | `/Users/paul/.agent-factory/artifacts/c08f12bb-4305-45cf-a9d7-cb46b01c1358-rep-1/result.json` (`798628c52e8c`) |
| `c08f12bb-4305-45cf-a9d7-cb46b01c1358-rep-2` | #71 no-validator (bonus) | 6.0.0 | `/Users/paul/.agent-factory/artifacts/c08f12bb-4305-45cf-a9d7-cb46b01c1358-rep-2/result.json` (`52d82b57f940`) |
| `d249aaa4-5b6a-4f36-8f95-f42d684f044c-rep-3` | #57 (the flip) | 6.0.0 | `evals/agent-runner/and-scene/results/d249aaa4-5b6a-4f36-8f95-f42d684f044c-rep-3/result.json` (`4a253a55d714`) |

#78 asked for the baseline to be rescored at 7.0.0 before comparing. No such rescore exists in the factory artifacts, so the baseline rows use their 6.0.0 verdicts.

## Method

The arithmetic was done by a one-off script, which is not committed; a second pass of the same script produced the bonus sweep. It used exact rational arithmetic and mirrored `lib/scorer.mjs`:

- **Splitting points.** A subcomponent's points are divided equally among its criteria, with no intermediate rounding (`scoreSubcomponent` / `sumShares`).
- **Earning points.** A criterion earns its share only when its recorded final `verdict` is `pass`. The script uses the verdict the result records: `scorer.mjs` writes it after fallback resolution and after an accepted second opinion has replaced a failing verdict. Nothing is re-adjudicated.
- **Eligibility.** A run is automated-eligible (`automated_pass`) when its subtotal is at least 40, every floored component meets its floor, and every hard gate passes. Gate verdicts are carried over unchanged.
- **Self-check.** For every run, the script recomputed the old component scores, the old subtotal and the old `automated_pass`, and checked them against the recorded values. All seven runs above match exactly, which validates the arithmetic.
- **Criterion sets.** For every run used, each subcomponent's recorded criterion IDs and order match rubric 12.4.0's exactly. The new subcomponent points therefore apply one-to-one. The verdicts, however, come from 6.0.0/7.0.0 guidance. A rescore under 12.4.0 (or 13/14.0.0) could change them; that is the paid follow-up the proposal places out of scope.

New points: demo 20 (canonical content 4, navigation and modes 4, runtime reliability 3, scene-kit integration 4, identity and grouping 3, code boundaries 2), floor 12.5. Scene kit 20 (step model 3, entity transitions 6, modes and navigation 5, uniform fit 1, fixed canvas 1, style and attribution 4), floor 12.5.

### Comparing eligibility fairly without the engineering component

At the new weights, the rescored automated subtotal is out of 70, but the 8 engineering points are unknown for these runs. The table therefore reports:

- **Subtotal excluding engineering**, out of 62: the four unchanged components (22 points) plus the re-weighted demo and scene kit components (20 + 20).
- **Engineering points needed for 40**: `max(0, 40 − subtotal excluding engineering)`. A run that needs 0 is eligible at any engineering score, because engineering has no floor and only adds points. A run that needs more than 8 is ineligible at any engineering score. Between those, eligibility depends on the unscored component.
- **Floors and hard gates.** These do not depend on engineering, so a floor miss or a gate failure decides eligibility whatever the engineering score.

"Eligible (new)" below is the conservative reading at engineering = 0. It is also exact for every comparable run in this document: each one either has a subtotal excluding engineering of 40 or more, or already fails a floor or a gate.

## Target runs


### cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-1 (rubric 6.0.0)

| Measure | Old (24/24, floors 15) | New (20/20, floors 12.5) |
|---|---:|---:|
| Demo technical quality | 17 / 24 | 14.5 / 20 |
| Scene kit correctness | 19.352 / 24 | 15.929 / 20 |
| Other automated components (unchanged) | 13.458 / 22 | 13.458 / 22 |
| Automated subtotal | 49.811 / 70 | 43.887 / 62 (engineering unscored) |
| Demo floor | met (≥15) | met (≥12.5) |
| Scene kit floor | met (≥15) | met (≥12.5) |
| Hard gates | FAIL | FAIL (unchanged) |
| Engineering points needed for 40 | — | 0 of 8 |
| Automated eligibility (40/70) | NOT eligible | NOT eligible for any engineering score |

### cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-2 (rubric 6.0.0)

| Measure | Old (24/24, floors 15) | New (20/20, floors 12.5) |
|---|---:|---:|
| Demo technical quality | 23 / 24 | 19.2 / 20 |
| Scene kit correctness | 16.705 / 24 | 13.857 / 20 |
| Other automated components (unchanged) | 16.583 / 22 | 16.583 / 22 |
| Automated subtotal | 56.288 / 70 | 49.64 / 62 (engineering unscored) |
| Demo floor | met (≥15) | met (≥12.5) |
| Scene kit floor | met (≥15) | met (≥12.5) |
| Hard gates | pass | pass (unchanged) |
| Engineering points needed for 40 | — | 0 of 8 |
| Automated eligibility (40/70) | eligible | eligible even at engineering 0 |

### cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-3 (rubric 6.0.0)

| Measure | Old (24/24, floors 15) | New (20/20, floors 12.5) |
|---|---:|---:|
| Demo technical quality | 24 / 24 | 20 / 20 |
| Scene kit correctness | 19.352 / 24 | 15.929 / 20 |
| Other automated components (unchanged) | 13.458 / 22 | 13.458 / 22 |
| Automated subtotal | 56.811 / 70 | 49.387 / 62 (engineering unscored) |
| Demo floor | met (≥15) | met (≥12.5) |
| Scene kit floor | met (≥15) | met (≥12.5) |
| Hard gates | pass | pass (unchanged) |
| Engineering points needed for 40 | — | 0 of 8 |
| Automated eligibility (40/70) | eligible | eligible even at engineering 0 |

### 4a0ed9e3-c9c9-4c74-bf18-ca5d5bc43ff1-rep-1 (rubric 7.0.0)

| Measure | Old (24/24, floors 15) | New (20/20, floors 12.5) |
|---|---:|---:|
| Demo technical quality | 24 / 24 | 20 / 20 |
| Scene kit correctness | 20.467 / 24 | 17 / 20 |
| Other automated components (unchanged) | 14.458 / 22 | 14.458 / 22 |
| Automated subtotal | 58.925 / 70 | 51.458 / 62 (engineering unscored) |
| Demo floor | met (≥15) | met (≥12.5) |
| Scene kit floor | met (≥15) | met (≥12.5) |
| Hard gates | pass | pass (unchanged) |
| Engineering points needed for 40 | — | 0 of 8 |
| Automated eligibility (40/70) | eligible | eligible even at engineering 0 |

### c08f12bb-4305-45cf-a9d7-cb46b01c1358-rep-1 (rubric 6.0.0)

| Measure | Old (24/24, floors 15) | New (20/20, floors 12.5) |
|---|---:|---:|
| Demo technical quality | 23 / 24 | 19.333 / 20 |
| Scene kit correctness | 20.352 / 24 | 16.929 / 20 |
| Other automated components (unchanged) | 11.467 / 22 | 11.467 / 22 |
| Automated subtotal | 54.819 / 70 | 47.729 / 62 (engineering unscored) |
| Demo floor | met (≥15) | met (≥12.5) |
| Scene kit floor | met (≥15) | met (≥12.5) |
| Hard gates | pass | pass (unchanged) |
| Engineering points needed for 40 | — | 0 of 8 |
| Automated eligibility (40/70) | eligible | eligible even at engineering 0 |

### c08f12bb-4305-45cf-a9d7-cb46b01c1358-rep-2 (rubric 6.0.0)

| Measure | Old (24/24, floors 15) | New (20/20, floors 12.5) |
|---|---:|---:|
| Demo technical quality | 22 / 24 | 18.533 / 20 |
| Scene kit correctness | 20.519 / 24 | 16.929 / 20 |
| Other automated components (unchanged) | 13.292 / 22 | 13.292 / 22 |
| Automated subtotal | 55.811 / 70 | 48.754 / 62 (engineering unscored) |
| Demo floor | met (≥15) | met (≥12.5) |
| Scene kit floor | met (≥15) | met (≥12.5) |
| Hard gates | pass | pass (unchanged) |
| Engineering points needed for 40 | — | 0 of 8 |
| Automated eligibility (40/70) | eligible | eligible even at engineering 0 |


### Summary

| Run | Demo old → new | Scene kit old → new | Subtotal /70 → excl. eng /62 | Floors old → new | Gates | Eligible old → new |
|---|---:|---:|---:|---|---|---|
| #67 baseline rep-1 | 17.00 → 14.50 | 19.35 → 15.93 | 49.81 → 43.89 | met → met | **fail** (`verification-sample-outline`) | no → no |
| #67 baseline rep-2 | 23.00 → 19.20 | 16.70 → 13.86 | 56.29 → 49.64 | met → met | pass | yes → yes |
| #67 baseline rep-3 | 24.00 → 20.00 | 19.35 → 15.93 | 56.81 → 49.39 | met → met | pass | yes → yes |
| #78 rep-1 | 24.00 → 20.00 | 20.47 → 17.00 | 58.93 → 51.46 | met → met | pass | yes → yes |
| #71 rep-1 | 23.00 → 19.33 | 20.35 → 16.93 | 54.82 → 47.73 | met → met | pass | yes → yes |
| #71 rep-2 | 22.00 → 18.53 | 20.52 → 16.93 | 55.81 → 48.75 | met → met | pass | yes → yes |

There are no flips. Each subtotal excluding engineering is 43.89 or more, so no target run needs any engineering points to stay above 40. The smallest floor margin is baseline rep-2's scene kit score: 16.70 against 15 (+1.70, 7.1% of 24) becomes 13.86 against 12.5 (+1.36, 6.8% of 20).

The baseline comparison is unchanged in direction. The #71 no-validator mean, excluding engineering, is 48.24. The #67 baseline's eligible-rep mean is 49.51, and its all-rep mean is 47.64. That is the same "within noise" picture as at the old weights. The engineering component is what this change adds to separate them.

## Flip analysis

### d249aaa4-5b6a-4f36-8f95-f42d684f044c-rep-3 (rubric 6.0.0)  **FLIP**

| Measure | Old (24/24, floors 15) | New (20/20, floors 12.5) |
|---|---:|---:|
| Demo technical quality | 15 / 24 | 12.433 / 20 |
| Scene kit correctness | 18.752 / 24 | 15.429 / 20 |
| Other automated components (unchanged) | 12.417 / 22 | 12.417 / 22 |
| Automated subtotal | 46.169 / 70 | 40.279 / 62 (engineering unscored) |
| Demo floor | met (≥15) | MISSED (≥12.5) |
| Scene kit floor | met (≥15) | met (≥12.5) |
| Hard gates | pass | pass (unchanged) |
| Engineering points needed for 40 | — | 0 of 8 |
| Automated eligibility (40/70) | eligible | NOT eligible for any engineering score |

Demo subcomponent detail for `d249aaa4-…-rep-3`, given as passed/criteria, then old points → new points: canonical content 4/5, 4 → 3.2; navigation and modes 3/5, 3 → 2.4; runtime reliability 2/4, 2 → 1.5; scene-kit integration 1/1, 4 → 4; identity and grouping **0/1**, 0 → 0; code boundaries 2/3, 2 → 1.33. The total is 15.00 → 12.43.

**Why it flips.** The floor ratio, 62.5%, is preserved only when a run's losses are spread in proportion to the cuts. The cuts leave scene-kit integration (4), identity and grouping (3) and the two 1-point canvas subcomponents unchanged, so a loss there weighs more at the new weights. Failing the 3-point identity subcomponent costs 12.5% of the old 24-point component and 15% of the new 20-point one. A loss in a cut subcomponent weighs less: one of three code-boundary criteria costs 4.2% before and 3.3% after. This run sat exactly on the old floor, and its single largest loss was in an uncut subcomponent, so it falls 0.067 below the new floor.

**Decision.** The run is pending human review and was scored with rubric 6.0.0. Its current-rubric verdicts are unknown until it is rescored. On 2026-10-06 the maintainer decided to **accept the flip** and keep both floors at 12.5. The run is old and sat exactly on the old boundary, and the rubric's emphasis on identity and grouping becomes slightly stronger. The alternatives considered and not taken were lowering the floors to 12.4 or 12.0, which breaks the clean 62.5% ratio, and taking the 4 demo points from different subcomponents (for example identity and grouping 3 → 2.5 instead of code boundaries 3 → 2), which would cut the subcomponents with the most guidance and calibration history.

## Bonus sweep: every other recorded run

The sweep applied the same arithmetic to every `results/*/result.json` and every factory `*-rep-*` `result.json` not in `results/`, covering every result with a complete automated subtotal. When a run appears in both places, the `results/` copy is used. Rubric 3.x runs are not comparable: their scene kit component lacks `scene-fixed-canvas-uniform-fit`, and their recorded scores do not match a recomputation from their own criteria. The **Notes** column flags them, and they should be ignored. Every 4.0.0–7.0.0 run recomputes exactly.

| Run | Rubric | Demo old → new | Scene kit old → new | Subtotal /70 → /62 | Gates | Eligible old → new (eng 0) | Flip | Notes |
|---|---|---:|---:|---:|---|---|---|---|
| 0f35011d-abaa-4f93-b1cf-db5e355c4a50-rep-1 | 5.0.0 | 24.00 → 20.00 | 20.35 → 16.93 | 55.14 → 47.72 | pass | yes → yes | — |  |
| 19b861fd-0efc-4476-bcc1-b73ef46e86f2-rep-1 | 6.0.0 | 21.00 → 17.60 | 20.52 → 16.93 | 54.35 → 47.36 | fail | no → no | — |  |
| 19b861fd-0efc-4476-bcc1-b73ef46e86f2-rep-2 | 6.0.0 | 21.00 → 17.73 | 21.69 → 17.93 | 56.85 → 49.83 | fail | no → no | — |  |
| 1d0dbdaf-64ac-455a-8d88-ae88260cc9ce-rep-1 | 5.0.0 | 21.00 → 17.00 | 19.87 → 16.50 | 51.33 → 43.96 | pass | yes → yes | — |  |
| 1d0dbdaf-64ac-455a-8d88-ae88260cc9ce-rep-2 | 5.0.0 | 23.00 → 19.20 | 19.75 → 16.43 | 57.04 → 49.92 | pass | yes → yes | — |  |
| 215c3182-0290-44f0-b249-67e8d9240c29-rep-1 | 6.0.0 | 17.00 → 14.50 | 22.40 → 18.50 | 54.48 → 48.08 | fail | no → no | — |  |
| 3938f16c-81f7-4334-9bbd-ad215d88f112-rep-1 | 6.0.0 | 23.00 → 19.20 | 22.23 → 18.50 | 57.65 → 50.12 | pass | yes → yes | — |  |
| 3938f16c-81f7-4334-9bbd-ad215d88f112-rep-2 | 6.0.0 | 24.00 → 20.00 | 19.13 → 16.00 | 56.05 → 48.92 | pass | yes → yes | — |  |
| 3938f16c-81f7-4334-9bbd-ad215d88f112-rep-3 | 6.0.0 | 23.00 → 19.33 | 21.07 → 17.50 | 58.98 → 51.75 | pass | yes → yes | — |  |
| 77be1e45-cdf2-4a05-bc1d-c668d7df06f0-rep-1 | 6.0.0 | 24.00 → 20.00 | 20.35 → 16.93 | 59.81 → 52.39 | pass | yes → yes | — |  |
| 77be1e45-cdf2-4a05-bc1d-c668d7df06f0-rep-2 | 6.0.0 | 22.00 → 18.40 | 19.35 → 15.93 | 53.81 → 46.79 | pass | yes → yes | — |  |
| aab6fbe4-c5d1-4ab8-a169-e71500370a30-rep-1 | 6.0.0 | 23.00 → 19.20 | 20.35 → 16.93 | 56.56 → 49.34 | pass | yes → yes | — |  |
| astra-lead-20260909T142250Z-rescore-20260909T211038Z | 3.11.0 | 24.00 → 20.00 | 20.07 → 16.00 | 55.48 → 47.42 | pass | yes → yes | — | demo-technical-quality: recomputed 24 != recorded 23; scene-kit-correctness: missing subcomponents scene-fixed-canvas-uniform-fit; subtotal: recomputed 55.483333333333334 != recorded 54.483333333333 |
| bcf2554b-713b-4876-ab8a-bd71b4dd2855-rep-1 | 5.0.0 | 23.00 → 19.20 | 20.47 → 17.00 | 57.05 → 49.78 | pass | yes → yes | — |  |
| candidate-rescore-20260728-browser-fixed-4 | 3.0.0 | 23.00 → 19.33 | 23.40 → 18.50 | 67.90 → 59.33 | pass | yes → yes | — | demo-technical-quality: recomputed 23 != recorded 22; scene-kit-correctness: recomputed 23.4 != recorded 21.233333333333334; scene-kit-correctness: missing subcomponents scene-fixed-canvas-uniform-fit; presentation-skill-correctness: recomputed 7 != recorded 5.125; verification-tool-correctness: recomputed 6.5 != recorded 4.333333333333333; assumption-handling-quality: recomputed 4 != recorded 2; subtotal: recomputed 67.9 != recorded 58.691666666667; recorded automated_pass undefined != recomputed true |
| candidate-rescore-20260729-rubric-3.10-cumulative-final-1 | 3.10.0 | 23.00 → 19.33 | 20.07 → 16.00 | 53.61 → 45.88 | pass | yes → yes | — | demo-technical-quality: recomputed 23 != recorded 22; scene-kit-correctness: missing subcomponents scene-fixed-canvas-uniform-fit; subtotal: recomputed 53.608333333333334 != recorded 52.608333333333; recorded automated_pass undefined != recomputed true |
| config-20260828T201451Z | 3.10.0 | 18.00 → 15.30 | 18.75 → 14.93 | 49.04 → 42.52 | pass | yes → yes | — | demo-technical-quality: recomputed 18 != recorded 23; scene-kit-correctness: missing subcomponents scene-fixed-canvas-uniform-fit; testing-evidence-quality: recomputed 2 != recorded 3; assumption-handling-quality: recomputed 1 != recorded 2; subtotal: recomputed 49.04404761904762 != recorded 56.044047619048; recorded automated_pass undefined != recomputed true |
| d249aaa4-5b6a-4f36-8f95-f42d684f044c-rep-1 | 6.0.0 | 12.00 → 9.10 | 19.35 → 15.93 | 46.14 → 39.82 | pass | no → no | — |  |
| d249aaa4-5b6a-4f36-8f95-f42d684f044c-rep-3 | 6.0.0 | 15.00 → 12.43 | 18.75 → 15.43 | 46.17 → 40.28 | pass | yes → no | **FLIP** |  |
| d7f384ba-0e94-4926-852e-6662fec752be-rep-1 | 5.0.0 | 18.00 → 14.65 | 19.35 → 15.93 | 49.31 → 42.54 | pass | yes → yes | — |  |
| d7f384ba-0e94-4926-852e-6662fec752be-rep-2 | 5.0.0 | 23.00 → 19.20 | 19.13 → 16.00 | 56.09 → 49.16 | pass | yes → yes | — |  |
| d7f384ba-0e94-4926-852e-6662fec752be-rep-3 | 5.0.0 | 24.00 → 20.00 | 19.75 → 16.43 | 53.67 → 46.35 | pass | yes → yes | — |  |
| ed89e53e-e0a4-4cec-9998-91f0905447f3-rep-1 | 5.0.0 | 20.00 → 16.20 | 20.35 → 16.93 | 53.02 → 45.80 | pass | yes → yes | — |  |
| ed89e53e-e0a4-4cec-9998-91f0905447f3-rep-2 | 5.0.0 | 15.00 → 12.95 | 22.23 → 18.50 | 50.27 → 44.49 | fail | no → no | — |  |
| ef8dafa5-c808-4584-8f2f-28038f68c1fe-rep-1 | 4.0.0 | 20.00 → 16.20 | 18.35 → 14.93 | 48.56 → 41.34 | pass | yes → yes | — |  |
| ef8dafa5-c808-4584-8f2f-28038f68c1fe-rep-2 | 4.0.0 | 21.00 → 17.60 | 18.73 → 15.50 | 47.57 → 40.93 | pass | yes → yes | — |  |
| ef8dafa5-c808-4584-8f2f-28038f68c1fe-rep-3 | 4.0.0 | 21.00 → 17.60 | 15.82 → 12.93 | 46.86 → 40.57 | fail | no → no | — |  |
| local-codex-tester-20260901T030537Z | 3.10.0 | 19.00 → 16.10 | 19.04 → 14.86 | 51.12 → 44.04 | pass | yes → yes | — | demo-technical-quality: recomputed 19 != recorded 23; scene-kit-correctness: missing subcomponents scene-fixed-canvas-uniform-fit; subtotal: recomputed 51.121428571428574 != recorded 55.121428571429; recorded automated_pass undefined != recomputed true |
| same-profile-claude-tester-20260831T023728Z | 3.10.0 | 22.00 → 18.40 | 20.92 → 16.43 | 55.59 → 47.50 | pass | yes → yes | — | demo-technical-quality: recomputed 22 != recorded 24; scene-kit-correctness: missing subcomponents scene-fixed-canvas-uniform-fit; subtotal: recomputed 55.58571428571429 != recorded 57.585714285714; recorded automated_pass undefined != recomputed true |
| 4a0ed9e3-c9c9-4c74-bf18-ca5d5bc43ff1-rep-1 | 7.0.0 | 24.00 → 20.00 | 20.47 → 17.00 | 58.92 → 51.46 | pass | yes → yes | — |  |
| c08f12bb-4305-45cf-a9d7-cb46b01c1358-rep-1 | 6.0.0 | 23.00 → 19.33 | 20.35 → 16.93 | 54.82 → 47.73 | pass | yes → yes | — |  |
| c08f12bb-4305-45cf-a9d7-cb46b01c1358-rep-2 | 6.0.0 | 22.00 → 18.53 | 20.52 → 16.93 | 55.81 → 48.75 | pass | yes → yes | — |  |
| cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-1 | 6.0.0 | 17.00 → 14.50 | 19.35 → 15.93 | 49.81 → 43.89 | fail | no → no | — |  |
| cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-2 | 6.0.0 | 23.00 → 19.20 | 16.70 → 13.86 | 56.29 → 49.64 | pass | yes → yes | — |  |
| cc572181-d7fc-4d64-a4f3-59c9a41fea45-rep-3 | 6.0.0 | 24.00 → 20.00 | 19.35 → 15.93 | 56.81 → 49.39 | pass | yes → yes | — |  |
| df1f4c4e-e183-4614-889f-29687ad8a740-rep-1-rescore-2 | 3.12.0 | 24.00 → 20.00 | 18.47 → 15.00 | 56.88 → 49.42 | pass | yes → yes | — |  |

Among comparable runs, the only flip is `d249aaa4-…-rep-3`. Other runs close to a floor at the new weights do not flip:

- `ed89e53e-…-rep-2`: demo 15.00 → 12.95, already ineligible on a hard gate;
- `ef8dafa5-…-rep-3`: scene kit 15.82 → 12.93, already ineligible on a hard gate;
- `d249aaa4-…-rep-1`: demo 12.00 → 9.10 and subtotal excluding engineering 39.82, already ineligible on the old demo floor.

## Reproduce

The script is not committed. To reproduce, apply the method above to the seven result files in "Runs and result files used": split each subcomponent's new points equally among its criteria, credit each criterion whose recorded final `verdict` is `pass`, carry gate verdicts over, and compare the demo and scene kit totals with the 12.5 floors and the subtotal excluding engineering with 40. Check the recomputation at the old points against the recorded component scores first.

The factory artifact directories are subject to retention pruning. The sha256 prefixes above identify the exact inputs.
