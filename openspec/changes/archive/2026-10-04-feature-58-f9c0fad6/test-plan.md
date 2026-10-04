## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional
integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only
obligations.

The change is a local, offline CLI over a pure module. Most behavior is covered by unit tests of
`lib/experiment-baseline.mjs` on in-memory results and records, as the spec scenarios require. Those
include:
- extraction;
- identity and mismatch;
- the failure rule;
- duplicates;
- the median;
- statistics;
- `set`, `add-rep` and `anchor` transitions;
- `show` formatting.

The added obligations target the three places where unit tests on in-memory data could pass while
the real tool fails:
1. **The filesystem boundary.** This covers atomic, all-or-nothing writes, the record path and
   corrupt records.
2. **The real `result.json` shape.** Synthetic fixtures would mirror a wrong field path.
3. **The executable entry point.** This covers the shebang, the `main` guard, argument parsing,
   exit codes and stdout/stderr, through the full `set → add-rep → anchor → show` journey.

All tests live in `test/experiment-baseline.test.mjs`, which runs under `npm test` and
`npm run check`. They are local and offline, and need no credentials. No new suites or CI jobs are
added.

## Integration Tests

### INT-001: Field mapping against real published results
- **Covers:** "Repetition entry contents", "Published result directory input", "Failed repetition
  rule", and "Human review required for every baseline" (the reviewed-median check).
- **Boundary:** `extractRepetition` running on real schema-8 `result.json` files that the agent
  factory published, read through the suite's `readJson`.
- **Setup:** The test reads these result files in place and never modifies them:
  - `results/aab6fbe4-c5d1-4ab8-a169-e71500370a30-rep-1/result.json`: reviewed, mixed providers;
  - `results/3938f16c-81f7-4334-9bbd-ad215d88f112-rep-1/result.json`: pending review, with
    null-provider rows;
  - `results/19b861fd-0efc-4476-bcc1-b73ef46e86f2-rep-1/result.json`: product failure, usage
    unavailable, null active time.
- **Action:** Extract one entry per file.
- **Assertions:**
  - **aab6fbe4:**
    - runner commit `aed680076ecb35a1871c20306f3872e3cd915e8f`;
    - skills commit `aae772244c80f8a0b9b4e128ac816db2bbad28f4`;
    - fixture commit `892dfbcf3762bc95cdbae6f05b18cc2b168a5fab`;
    - lead configured model `claude-sonnet-5-5`;
    - automated rubric version `6.0.0` and its sha256;
    - automated points approximately 56.5607;
    - `human_review_complete: true`;
    - per-provider token totals that sum to `cost.usage.token_totals.total`.
  - **3938f16c:** the entry has an `unknown` provider bucket and `human_review_complete: false`.
  - **19b861fd:** the entry is admitted. It records `product_failure`, `tokens.complete: false`,
    and `active_duration_ms: null`.
  - **No mutation:** the hashes of all three files are unchanged after the test.
- **Execution:** `test/experiment-baseline.test.mjs`, run by `npm test` and `npm run check`.

### INT-002: Record persistence is atomic and all-or-nothing
- **Covers:** "Experiment baseline record file" and "Atomic, reviewable, all-or-nothing writes".
- **Boundary:** `runExperimentsCommand` working with the real filesystem, the real
  `writeJsonAtomic`, and the record directory creation.
- **Setup:**
  - A temp directory holds `--record <tmp>/experiments/baseline.json`. Its parent directory does
    not exist yet.
  - Synthetic result directories are written to the temp directory from the test builder: three
    matching repetitions with a reviewed median, plus one infrastructure-failed repetition.
- **Action and assertions:** run in sequence.
  1. **First `set` succeeds.** It creates the parent directory and the record. The file is
     two-space-indented JSON ending in a newline, with `schema_version: 1`, `anchor: null` and
     `history: []`.
  2. **Refused `set` changes nothing.** A second `set` that includes the failed directory exits 1
     and prints one JSON refusal line per bad repetition. The record bytes are identical to before.
  3. **A corrupt record is refused.** The test writes invalid JSON to a separate record path and
     runs `add-rep` against it. It exits 2, and the file still holds the same invalid bytes.
     The test then writes a parseable schema-1 record with `current: {}`, and a second one whose
     `current.median_rep` names a run id that is not in `reps`. `show` and `set` against each
     exit 2, naming the invalid field, and neither file changes. In particular, `set` does not
     archive the malformed `current` into `history`.
  4. **A failed write leaves nothing behind.** The test injects a `write` that stages and then
     throws. The command fails, the record is unchanged, and no `.tmp` file remains in the record
     directory.
  5. **`show` is read-only.** Running `show` leaves the record bytes and modification time
     unchanged.
  6. **The default record is untouched.** The suite default `experiments/baseline.json` does not
     exist before or after the test, or is unchanged if it exists.
- **Execution:** `test/experiment-baseline.test.mjs`, run by `npm test` and `npm run check`.

## End-to-End Tests

### E2E-001: Operator journey through the executable CLI
- **Covers:**
  - the full command lifecycle ("Set replaces the current baseline", "Add a control repetition",
    "Anchor from current", "Show the baseline", "Command-line usage errors");
  - "One runner commit per baseline" and "Duplicate repetitions are refused" (rescore lineage) as
    the operator sees them.
- **Surface:** `node evals/agent-runner/and-scene/experiments.mjs baseline …`, run as a child
  process with `node:child_process`, `execFile` with `process.execPath`. Every invocation passes
  `--record <tmp>/baseline.json`.
- **Setup:** A temp directory holds four synthetic schema-8 result directories built by the test
  helper, all sharing one identity:
  - three for `set`, with automated points 49.81, 56.29 and 56.81. The 56.29 one has a complete
    human review; the others are pending;
  - one control repetition for `add-rep`, scoring 45.

  The setup also includes two extra directories:
  - one with a different runner commit;
  - one rescore of the 49.81 repetition, with a new run id and an `imported-completed-run` event
    naming the original as `source_run_id`.
- **Journey and assertions:**
  1. **`set` succeeds.**
     - Command: `set <three dirs> --source profile-change --reason "seed"`.
     - Exit code 0, and a stdout confirmation names the median.
     - `current.median_rep` is the 56.29 repetition.
     - `human_review.is_current_median` is `true`.
  2. **`anchor` freezes the baseline.**
     - Command: `anchor --from-current --reason "first anchor"`.
     - Exit code 0.
     - `anchor` equals `current` plus `anchored_at` and `anchor_reason`.
  3. **`add-rep` updates current only.**
     - Command: `add-rep <control dir>`.
     - Exit code 0, and four repetitions are recorded.
     - The median becomes the 49.81 repetition. The sorted scores are 45, 49.81, 56.29 and 56.81,
       and the median is the lower of the middle two.
     - `human_review` still names the 56.29 repetition, with `is_current_median: false`.
     - `anchor` is unchanged.
  4. **`show` reports the state.**
     - Command: `show`.
     - Exit code 0.
     - stdout contains the four run ids, the median run id, a note that the median is not the
       human-reviewed repetition naming both run ids, and the anchor status.
  5. **Anchoring a divergent baseline is refused.**
     - Command: `anchor --from-current --reason "re-anchor"`.
     - Exit code 1.
     - stderr has a JSON line with code `median-not-reviewed` naming both run ids.
     - The record bytes are unchanged, so the earlier anchor survives.
  6. **Adding a rescore of a current repetition is refused.**
     - Command: `add-rep <rescore dir>`.
     - Exit code 1.
     - stderr has a `duplicate-run` line naming the rescore and the original, and directing the
       operator to rebuild with `set`.
     - The record bytes are unchanged.
  7. **A different runner commit is refused.**
     - Command: `add-rep <different-runner dir> --allow-mismatch "drift"`.
     - Exit code 1.
     - stderr has a JSON line with code `runner-commit-mismatch`.
     - The record bytes are unchanged.
  8. **Usage errors are rejected.**
     - Commands: `baseline promote`, and `set <dir> --source experiment --reason x`.
     - Exit code 2, a usage message, and the record bytes are unchanged.
  9. **A `profile-change` reset clears the anchor.**
     - Command: `set <three dirs> --source profile-change --reason "reset"`.
     - Exit code 0.
     - `history` gains a `current` entry and an `anchor` entry, both with
       `replacement_reason: "reset"`.
     - `anchor` is `null`.
- **Execution:** `test/experiment-baseline.test.mjs`, run by `npm test` and `npm run check`. It
  takes about one second, because it is a few `node` child processes with no network.

## Acceptance Testing Envelope

- **Environments and sandboxes:** A local checkout of agent-evals with Node 22. Temp directories
  under the OS temp root may be used for records and synthetic or copied result directories. The
  real published `evals/agent-runner/and-scene/results/**` directories may be read and passed to
  `set` or `add-rep`, as long as every write goes to a temp record through `--record`.
- **Credentials and secrets:** None are needed or used. There are no network, GitHub, Docker or
  model calls.
- **Authorized effects:** Creating and deleting temp files and directories only. There is no cost
  and no cleanup beyond removing the temp directories.
- **Off limits:**
  - Creating or editing the committed `evals/agent-runner/and-scene/experiments/baseline.json`.
    Seeding is a separate manual step after merge.
  - Modifying anything under `results/**`.
  - Committing or pushing a record.
  - Running `run.sh`, `human-review.sh`, or any paid eval.
  - Touching the reference-baseline path (`--reference-baseline`, `lib/baseline.mjs`).
- **Permitted substitutes:**
  - Synthetic `result.json` files built to the schema-8 shape.
  - Temp copies of published results, edited to vary identity, failure, review or rescore fields.

  The agent-evals#67 repetitions are not in `results/` yet. Use other published runs, or copies
  edited to share one identity, to exercise multi-repetition baselines.
- **Known risk areas:**
  - Field-path mapping from `result.json`, which is the most likely source of silent errors.
  - `null` provider rows.
  - Usage, cost and active time missing or incomplete. Cost is incomplete on every published
    result today, which is accepted and expected.
  - Median selection with even counts and ties.
  - Unscored conclusive product failures, from verification or the candidate server, which have
    `automated_subtotal: null`. None are published today, so use synthetic results or edited
    copies.
  - Rescore lineage overlaps, in both orders.
  - Records that are parseable but structurally invalid.
  - Rescore linkage through `workflow.events`.
  - The `is_current_median` flag after `add-rep`.
  - Refusal wording that names the fields, values and run ids.
  - All-or-nothing behavior when several directories are given.
  - The documented, accepted limitation that the identity does not cover the agent-evals or Agent
    Validator revision.

## Human-Only Testing

None.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| Experiment baseline record file | INT-002 | E2E-001 | — |
| Atomic, reviewable, all-or-nothing writes | INT-002 | — | — |
| Published result directory input | INT-001 | — | — |
| Repetition entry contents | INT-001 | — | — |
| Failed repetition rule | INT-001 | — | — |
| One runner commit per baseline | — | E2E-001 | — |
| Set replaces the current baseline | — | E2E-001 | — |
| Human review required for every baseline | INT-001 | E2E-001 | — |
| Add a control repetition | — | E2E-001 | — |
| Duplicate repetitions are refused | — | E2E-001 | — |
| Anchor from current | — | E2E-001 | — |
| Show the baseline | INT-002 | E2E-001 | — |
| Command-line usage errors | — | E2E-001 | — |
