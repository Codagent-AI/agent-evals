## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional
integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only
obligations.

Unit tests cover the settlement rules, the tier scorer, weight validation, the claim-map parser and
bounds, `batchClaims`, the overrule-check decision and the attribution classifier. The integration
tests below join those pieces through the real modules with canned invokers, and run in
`npm run check` unless stated otherwise. The end-to-end tests are the proposal's evidence steps:
they use real models on retained runs and are run by hand on the host, in the order given, because
later steps depend on earlier results.

## Integration Tests

### INT-001: v2 settlement through the shared panel module
- Covers: product-quality-scoring "Robust judge verdicts"; engineering-quality-scoring protocol pin.
- Boundary: `runPanelJob` → `resolvePanel` → `runTiebreak`, span audits, contradiction and dissent
  checks, fail audits, re-cite, and record persistence and replay through `resolveLineCitedRecord()`.
- Setup: canned seat, decider and audit invokers that return scripted outputs per stage; temporary
  run directory with a small verified inventory.
- Action: run panel jobs for the active-state route; a contradicted browser-fallback pass with an
  `insufficient` check; a decider fail citing a counterexample, one citing a search scope, and one
  citing neither; an inadequate absence scope; a confirmed contradiction that turns a vote; a re-cite
  that tries to change the verdict; the INV-093 shape; a single-claim packet overflow; a decider request
  that needs criterion batching; a decider whose shared evidence alone overflows; a contradiction
  check whose cited files total more than half the packet limit but fit, and one whose single
  claim's material cannot fit; a vote citing a path outside the inventory; an audit citing one; an
  inventory file that cannot be read; a check returning `missing-material`; an absence fail whose
  scope is repaired to confirmed, to inconclusive and to still inadequate; a ruling whose audit parts
  are mixed (confirmed and `insufficient`); a pass with two contradicted parts; a fail contradicted
  in one part; an inventory of more than 200 paths including one longer than 200 characters; a
  browser-fallback pass whose check returns `missing-material`, and a browser-fallback fail reversed
  with and without cited delivered source; then replay every persisted record, including a record
  whose parts come from two cycles, a valid record with an inconclusive initial-cycle check followed
  by a confirmed re-cite cycle, and a record reversed by the confirmed-pass-contradiction exception
  beside a `missing-material` part.
- Assertions:
  - each case reaches the verdict, basis and stage sequence the spec scenarios require;
  - check requests contain the union of voter citations and audit `citations`; a vote's path outside
    the inventory appears as `[not in inventory: …]`; an audit citation outside it is retried as
    invalid output; an unreadable inventory file raises `missing-material` naming the criterion;
  - a `missing-material` or final `scope-inadequate` outcome fails the job, non-retryable, naming the
    criterion, and never leaves a vote or ruling standing, except that a confirmed contradiction of a
    pass still reverses it;
  - scope repair runs exactly once, never alongside a re-cite, and yields confirmed, `insufficient`
    (fail stands) or `scope-inadequate` (harness failure) as scripted;
  - mixed parts leave the ruling undecided and trigger one re-cite that re-runs every part as a new
    cycle; each of two contradicted parts gets its own check, in a stable order; a fail's check
    receives every part's material;
  - every inventory path appears in full in seat, decider and absence-audit requests;
  - a fail citing neither spans nor scope is retried, then fails the job when retries are exhausted;
  - a batched decider records one decision with every criterion's ruling, and shared-evidence
    overflow fails the job with non-retryable `packet-overflow` naming every pending criterion;
  - the large-but-fitting check receives every file in full with no size-omission marker; the
    oversized claim raises `packet-overflow` and is never settled as `insufficient`;
  - successful records reproduce their outcome on replay, including the prior-cycle-check and
    exception-reversal records; a record mixing cycles or missing a required part is rejected and
    re-judged;
  - exhausted, invalid and `packet-overflow` records stay failures and are never reused as cached
    successes;
  - persisted records name `cross-family-panel-v2`.
- Execution: `test/panel-judging-settlement.test.mjs` (or a new `test/panel-judging-v2.test.mjs`), in
  `npm run check`.

### INT-002: second-opinion audit contract is unchanged
- Covers: failure-second-opinion "Zero-point gate inputs keep their second opinion"; design decision
  that `SOURCE_AUDIT_RESULT_SCHEMA` is unchanged.
- Boundary: `second-opinion.mjs` source-pass replay audit request building and result parsing,
  alongside the panel audit's new schema.
- Setup: the existing second-opinion fixtures; a recorded audit response in today's shape.
- Action: build a second-opinion source-pass audit request and parse the recorded response; build a
  panel audit request; target a second opinion at a zero-point gate input.
- Assertions:
  - the second-opinion request's schema deep-equals the base commit's `SOURCE_AUDIT_RESULT_SCHEMA`
    (snapshotted in the test) and has no `citations` field;
  - today's response parses to the same result as on the base commit;
  - the panel audit request uses `PANEL_AUDIT_RESULT_SCHEMA` with required `citations`;
  - a zero-point gate input still receives its second opinion.
- Execution: `test/second-opinion.test.mjs`, in `npm run check`. Its result decides whether INT-009
  runs the adversarial suite.

### INT-003: define overrule check and disclosure audit
- Covers: definition-artifact-scoring "Eval-owned judges"; simulated-user "Disclosure audit".
- Boundary: define `judging.mjs` batched decider → `overrule-check` → coverage, quality, fidelity and
  disclosure results, plus `rerunDecider` and calibration.
- Setup: canned invokers for two-vote agreements, a three-way split, and decider rulings that agree,
  differ with a confirmed check, differ with an unconfirmed check, and differ with an `insufficient`
  check.
- Action: judge a define run; run the disclosure audit with leaked items accepted, rejected and
  `insufficient`; rerun the decider; run a canned calibration repeat.
- Assertions:
  - an overrule check runs only when a batched ruling differs from a two-vote verdict;
  - unconfirmed or `insufficient` checks leave the two-vote verdict standing; three-way splits settle
    as today;
  - disclosure outcomes change the coverage denominator as the spec states;
  - `rerunDecider` and calibration apply the same check.
- Execution: `test/and-scene-define-scoring.test.mjs` and `test/and-scene-define-calibration.test.mjs`,
  in `npm run check`.

### INT-004: rubric 15.0.0 through scoring and gates
- Covers: product-quality-scoring "Official product score", component tier tables, "Existing criterion
  disposition", "Declared fallback judge"; engineering-quality-scoring tier table.
- Boundary: the real `automated-rubric.json` 15.0.0 → rubric validation → `scoreSubcomponent` → floors, gates and
  eligibility → report.
- Setup: the real rubric file; canned verdict sets.
- Action: validate the rubric; score verdict sets that pass everything, fail one critical, fail one
  minor, fail a zero-point gate input, and leave a gate input unjudged.
- Assertions:
  - weights are strictly decreasing, ≤2, multiples of 1/16, and sum to each component;
  - points match the tier tables, including 6.625 of 8 for the engineering scenario;
  - gate inputs add no points and do not block completeness, but still drive the outline gate and
    browser-fallback validation;
  - the morph criterion is present as major (or absent with scene kit critical 1.75, if cut).
- Execution: `test/rubric.test.mjs` and `test/scoring.test.mjs`, in `npm run check`.

### INT-005: testing-evidence claim map through decider, audits and checks
- Covers: testing-evidence-evaluation "Four-point score" and claim-map scenarios; ambiguity-evaluation
  plan-commitment scenario.
- Boundary: evidence-view construction with the full claim-bearing records in `packet.txt` → panel
  seats → line-cited decider with `claim_map` → row audits and completeness audit → contradiction
  check → settlement and scoring.
- Setup: a fixture evidence view whose handoff, exploration log, findings history and acceptance flow
  record hold one deliberately omitted material claim placed beyond the packet's 50,000-character
  excerpt, and one false claim of a scenario outside the 68-scenario basis; a second fixture whose
  record claims all 68 basis scenarios with separate claim and evidence locations, plus CI and
  limitation claims; a third fixture whose claim-bearing records alone exceed the packet budget;
  canned seat, decider, audit and check invokers that force
  `testing-evidence-usable-proof` and `testing-evidence-complete-honest-record` to the decider, plus
  canned unanimous-pass and Claude-backed-majority seat outcomes.
- Action: judge both mapped criteria on each fixture, through the decider and through the
  unanimous and majority paths; judge traceable coverage and the plan-commitment omission as
  separate cases.
- Assertions:
  - `packet.txt` holds the four claim-bearing records in full and first, including the line beyond
    the old 50,000-character excerpt, and every seat request, the decider request and the audits
    contain it; a map span into that line validates;
  - the unanimous-pass and majority cases' seat requests contain the deep claim (the canned seats
    cannot prove a model would act on it; E2E-004 is the model-level check);
  - row audits arrive in whole-row batches with the referenced lines; the completeness audit request
    holds the full records and the location index, without quoted evidence;
  - a canned `contradicted` completeness audit citing the omitted line reaches the contradiction
    check with that line in its material, and the pass is withdrawn only when the check confirms;
  - the out-of-basis claim earns no usable-proof credit and is judged under complete and honest
    record;
  - the 68-scenario map validates and settles without overflow; bounds (one row per scenario,
    24 other rows, 6 claims per row, 1 claim span and 4 evidence spans per claim, 40 lines per span)
    are enforced;
  - claim-bearing records over the packet budget, or one skipped at collection, fail the job with
    `packet-overflow` naming the testing-evidence criteria, and no truncated view is judged;
  - the assumption-handling packet holds its four primary records in full, and a requirement
    document over 40,000 characters fails the job;
  - a supporting artifact cut or dropped by the budget carries an in-place marker and appears in the
    packet's index; a canned check that depends on it returns `missing-material`;
  - an evidence view with more than 500 files still gives seats and the decider `packet.txt`;
  - unanimous evidence seats where one reports `missing_material` for a marked log, and a decider
    reporting it, each fail the criterion before settlement; a report naming an unknown marker is
    retried as invalid output;
  - a row audit whose cited lines lie in a cut log, without the marker in range, receives those
    lines labelled with the marker and the packet's cut index;
  - the row audits and completeness audit are recorded as parts of one cycle;
  - traceable coverage scores the plan-commitment omission once, and complete and honest record does
    not fail for it.
- Limitation: canned audits prove the material is delivered, not that a model would catch the
  defects; E2E-004's known answers are the model-level check.
- Execution: a new `test/testing-evidence-claim-map.test.mjs`, in `npm run check`.

### INT-006: job-filtered diagnostic through the controller
- Covers: product-quality-scoring "Job-filtered judging diagnostic".
- Boundary: `run.sh --rescore-from … --run-dir … --judge-jobs … --expected …` → controller →
  `diagnostic.json` → judging → `judge-diagnostic.mjs`.
- Setup: a retained-run fixture with manifest hashes; canned judge invokers; an expected file.
- Action: start a diagnostic, interrupt it after one job's checkpoint, resume it; resume with a
  changed job list, changed expected file, changed judge profile, changed evaluator commit, and
  uncommitted edits to an audit prompt, to `controller.mjs` and to a fixture-snapshot requirement
  file, each leaving the protocol and rubric version unchanged; run the comparison.
- Assertions:
  - `diagnostic.json` is written before judging with mode, jobs, source provenance, evaluator commit,
    evaluator content hash, judge profiles, rubric hash and the expected file's SHA-256;
  - resume restores it; each mismatched resume, including each uncommitted edit, is rejected naming
    the changed field before any checkpoint is reused;
  - only the named jobs are judged and only diagnostic artifacts are written (no `result.json`
    score, no publication);
  - `judge-diagnostic.mjs` rejects a hash mismatch and reports verdict, basis and match per criterion
    and repeat.
- Execution: `test/controller.test.mjs` and `test/and-scene.test.mjs`, in `npm run check`.

### INT-007: shared job pool in both suites
- Covers: design §6.
- Boundary: `evals/lib/panel-judging/job-pool.mjs` used by and-scene `runProductJudging()` and define
  `judging.mjs`.
- Setup: canned jobs with controllable delays; a checkpoint that throws.
- Action: run each suite's judging through the pool.
- Assertions: at most `concurrency` in flight (3 for both suites, 1 per repeat for define
  calibration while repeats keep 6); checkpoints serialized; no new jobs after a checkpoint throws;
  in-flight jobs settle before the first error is rethrown; results in job order; define's disclosure
  audit completes before coverage starts.
- Execution: `test/judge-jobs.test.mjs` and `test/and-scene-define-scoring.test.mjs`, in
  `npm run check`.

### INT-008: settlement replay and flip attribution
- Covers: design §7; proposal attribution rule.
- Boundary: `scripts/replay-settlement.mjs` over archive inputs → pure settlement functions → report;
  the rescore comparison's attribution classifier.
- Setup: small fixture archives of judging records and raw `judge-claude` logs with known first
  votes; variants with the raw-log archive missing, one job's log missing, a malformed log, and a log
  whose job or provenance does not match. Canned rescore pairs for each attribution class.
- Action: run the replay on each variant; classify the canned pairs.
- Assertions:
  - exact counterfactual verdicts, bases and point totals per criterion and in total;
  - the header says `partial settlement counterfactual` and `replay`, or `reconstruction` only when
    the archive or a job's log is absent;
  - malformed or mismatched logs fail the script and never fall back to reconstruction;
  - attribution records original seat verdicts, audits and checks, effective votes and ruling
    separately; a check or decider present in only one rescore counts as a difference;
  - the canned regression — identical original seat verdicts whose effective votes differ through a
    check — is classified `settlement`, not seat noise; a pair differing in both is `mixed`;
  - the #78 rep 2 blocker sums settlement and mixed points, excluding engineering quality.
- Execution: a new `test/replay-settlement.test.mjs`, in `npm run check`.

### INT-009: real-browser suites
- Covers: the outline gate's scoring integration; second-opinion replay if its contract changed.
- Boundary: real Chrome over `chrome-devtools-axi` against a real candidate and the trick pages.
- Setup: host Chrome, used by nothing else; candidate build and serve per the file header.
- Action: run `test/real-browser/candidate.test.mjs` on the base commit and on the final
  implementation, serially. Run `test/real-browser/adversarial.test.mjs` the same way unless INT-002
  passes and `second-opinion.mjs` and its other dependencies are unchanged in behavior.
- Assertions: no new failures relative to the base commit.
- Execution: by hand on the host; outside `npm run check` and CI.

## End-to-End Tests

All run on the host in this order against retained runs, using `run.sh --rescore-from` or the
diagnostic path. None publish or write `results/**`.

### E2E-001: preflight
- Covers: proposal evidence step 1.
- Surface: the retained run directories and research archives.
- Journey: verify the retained baseline reps 1–3 and #78 reps 1–2 manifests; confirm the #78 rep 2
  judging records and raw logs archives are present; confirm whether baseline rep 1's round-0 tester
  log was collected.
- Assertions: manifest hashes verify; both archives extract; the tester-log finding is recorded, and
  an evidence-view drop is fixed before the freeze.
- Execution: by hand.

### E2E-002: settlement replay on #78 rep 2
- Covers: proposal evidence step 2.
- Surface: `scripts/replay-settlement.mjs`.
- Journey: run it on the retained #78 rep 2 archives.
- Assertions: the output is labelled `replay`; its computed total is recorded beside the research's
  hand-worked 0.5 points, and a large gap is explained before step E2E-007.
- Execution: by hand, no model calls.

### E2E-003: INV-093 retained-ruling check
- Covers: proposal targeted check; definition-artifact-scoring overrule check.
- Surface: the define suite's `scripts/check-retained-ruling.mjs` on the retained r7 INV-093
  calibration record.
- Journey: run the overrule check against the recorded `met` ruling, its stated reason and its
  citations, with the recorded seat votes (Claude `met`, both Codex seats `partial`).
- Assertions: the check executes (a model response is recorded); it does not confirm the overrule;
  the printed v2 verdict is the two-seat `partial` with basis `majority-partial`; no judging record or
  cache entry is written.
- Execution: by hand; about one Opus call.

### E2E-004: known answers
- Covers: proposal known-answer check; diagnostic journey.
- Surface: the job-filtered diagnostic and `judge-diagnostic.mjs`.
- Setup: the agent writes the expected file. Each entry names the candidate revision, criterion,
  expected verdict and evidence covering the whole revised criterion. A historical majority verdict
  is not proof, and an expected pass needs more than refuting one failure reason. Starting cases:
  active-state Previous button `fail` and overlap `pass` on #78 rep 2. The file is frozen and hashed
  before judging; changing an expectation invalidates the checks that used it.
- Assertions: every judged verdict matches. A wrong verdict blocks the freeze.
- Execution: by hand.

### E2E-005: morph calibration and final rubric
- Covers: scene kit morph criterion; proposal evidence step 4.
- Surface: the diagnostic path for the morph criterion, then `npm run check` and the and-scene
  `--calibrate` with canned invokers.
- Assertions: the morph shipping rule is applied and recorded; the final weights validate; both free
  checks pass against the final rubric.
- Execution: by hand.

### E2E-006: define calibration
- Covers: definition-artifact-scoring overrule check in calibration.
- Surface: `and-scene-define/calibrate.mjs` at r7's size.
- Setup: job concurrency 1 within each repeat; repeats keep concurrency 6.
- Assertions: no loss of spread or agreement against r7; INV-093 never judged `met` (weak evidence).
- Execution: by hand; about 2 hours and 20M tokens at r7's measurement.

### E2E-007: frozen rescores and attribution
- Covers: proposal evidence steps 6–7.
- Surface: `run.sh --rescore-from` and the rescore comparison.
- Setup: freeze the evaluator revision, judge profiles, prompts, rubric and input manifests. Check
  subscription headroom before each batch of five rescores.
- Journey: three rescores each of baseline reps 1–3 and #78 reps 1–2 (15 rescores, three pairs per
  rep).
- Assertions:
  - per pair, total flipped points (sum of every changed verdict's points, under rubric 15.0.0's
    weights) are reported, with engineering quality excluded from the 1.0-point budget and reported
    separately;
  - each flip is classified settlement, seat noise or mixed from the four recorded layers;
  - for #78 rep 2, settlement plus mixed points above 1.0 blocks merge;
  - other misses are reported and trigger E2E-008 and HT-001;
  - each rep reports gate, floor and eligibility changes and per-criterion disagreement counts with
    denominators, including all 14 engineering-quality criteria.
- Execution: by hand; about 70M tokens and 8–15 hours.

### E2E-008: accuracy review
- Covers: proposal evidence step 8.
- Surface: the rescore records and the old judging of the same code.
- Journey: review every criterion whose verdict differs between old and new judging, every decider
  pass whose span audit stayed undecided, and a sample of engineering-quality verdicts.
- Assertions: each verdict is recorded correct or wrong, and each change tagged as revised wording or
  settlement rules. An unresolved accuracy regression fails acceptance.
- Execution: by the agent, recorded with the change's evidence.

## Acceptance Testing Envelope

- Environments and sandboxes: the host only. Rescores, diagnostics and calibration need no Docker or
  Runner. Chrome is used serially, by one suite or browser evaluation at a time.
- Credentials and secrets: Claude and Codex CLI subscriptions on the host; GitHub read access for the
  retained runs and pull requests.
- Authorized effects: model calls on subscriptions, about 110M tokens (mostly cached) and 15–30 hours
  in total; rescores run in batches of five after a headroom check. New run directories for rescores,
  diagnostics and calibration under the usual artifact locations.
- Off limits: publishing results; editing `results/**`; touching draft pull requests or vault
  archives; paid candidate runs (`--run-agent`).
- Permitted substitutes: if the raw logs are lost, the replay runs as a `reconstruction` and is
  labelled so. If the morph criterion fails its shipping rule, it is cut and the scene kit's critical
  weight becomes 1.75.
- Known risk areas: span-audit `insufficient` handling; re-cite overwriting decider verdicts; packet
  size on large evidence views; the round-0 tester log; resume of interrupted rescores. Accepted
  limitations: 15 pairs are a diagnostic, not a reliable rate; the replay excludes contradiction
  routing, fail audits and auditor citations; attribution labels where outputs differ, not causation;
  no retrieval of cut supporting logs and no screenshot inspection, so a criterion that needs either
  is a harness failure. New harness failures from `missing-material`, `scope-inadequate` or
  `packet-overflow` during rescores are a risk area to report, not to suppress.

## Human-Only Testing

### HT-001: vote-share scoring follow-up
- Reason: whether to pursue vote-share scoring is Paul's product decision about the eval's direction.
- Prerequisites: E2E-007 and E2E-008 complete, with a target miss that does not block merge.
- Instructions: read the per-pair flipped points, their attribution, and the accuracy review.
- Required decision or observation: whether to file vote-share scoring as the follow-up.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| product-quality-scoring: Robust judge verdicts | INT-001, INT-005 | E2E-002, E2E-004, E2E-007, E2E-008 | — |
| product-quality-scoring: Official product score and component tiers | INT-004 | E2E-005, E2E-007 | — |
| product-quality-scoring: Existing criterion disposition (morph) | INT-004 | E2E-005 | — |
| product-quality-scoring: Declared fallback judge | INT-004 | — | — |
| product-quality-scoring: Job-filtered judging diagnostic | INT-006 | E2E-004, E2E-005 | — |
| engineering-quality-scoring: tiers and v2 protocol | INT-001, INT-004 | E2E-007 | — |
| testing-evidence-evaluation: Four-point score and claim map | INT-005 | E2E-007, E2E-008 | — |
| ambiguity-evaluation: plan-commitment scenario and full primary records | INT-005 | — | — |
| failure-second-opinion: zero-point gate inputs | INT-002 | — | — |
| definition-artifact-scoring: Eval-owned judges | INT-003, INT-007 | E2E-003, E2E-006 | — |
| simulated-user: Disclosure audit | INT-003 | E2E-006 | — |
| Settlement replay and flip attribution | INT-008 | E2E-002, E2E-007 | HT-001 |
| Outline gate and second-opinion replay in real Chrome | INT-009 | — | — |
