## Context

The and-scene suite publishes one `result.json` per repetition under
`evals/agent-runner/and-scene/results/<run_id>/`. Every published result today is schema version 8.
The agent factory writes these directories after automated scoring. It adds a completed human
review on a later tick, so `results/` holds three kinds of repetition:
- reviewed (`human_review.complete: true`, numeric `official_score`);
- `pending-human-review`;
- product failures.

There is no committed notion of "the baseline we compare against". This change adds the
experiment baseline record and a small CLI to maintain it. The specification is
`specs/experiment-baseline-record/spec.md`.

Constraints from the repository and issue:
- Node built-ins only (no new runtime dependencies); ES modules; `node --test` suite under `test/`.
- Suite pattern: thin entry point over tested `lib/` modules. `calibrate.mjs` and `score.mjs` are
  the closest precedents: an exported `parseArgs`, an exported `run…Command({ argv, … })` returning
  `{ exitCode, errors }`, and a `main` guard.
- `lib/persistence.mjs` already provides `readJson` and `writeJsonAtomic` (same-directory temp file,
  `fsync`, rename, two-space JSON plus newline). It also has an `onStage(path)` hook that reports
  the staging path.
- The reference baseline (`lib/baseline.mjs`, `--reference-baseline`, `result.json.baseline`) is a
  different concept and must not be touched.

Observed facts about schema-8 results that shape the design (checked against `results/`):
- `cost.rows[].provider` is sometimes `null` (tester rows, Agent Validator rows).
- `cost.usage.complete` is often `false`, and `cost.usage.token_totals` is `null` when usage is
  `unavailable`.
- `cost.total.complete` is `false` on every published result so far.
- `implementation_metrics.active_duration_ms` is `null` on some results.
- `workflow.skip_validator` is a string (`"false"`).
- A rescore's `workflow.events[]` holds `{ event: "imported-completed-run", source_run_id, … }`.
- Unreviewed results have no `human_review` key and no `official_score`.

## Goals / Non-Goals

**Goals:**
- A pure, unit-testable module that turns parsed `result.json` objects and an existing record into
  a new record, or into a list of refusals.
- A thin CLI, `experiments.mjs baseline <set|add-rep|anchor|show>`, that does all file I/O and
  writes the record atomically, all-or-nothing.
- A versioned record shape that the comparison and ledger tickets can read without re-reading
  result directories.

**Non-Goals:**
- Inventing a numeric score for an unscored product failure.
- Candidate comparison, ledger and promotion, the `eval-baseline` tag, seeding the record, drift
  checks. These are listed in the proposal's Out of Scope.
- Changing `result.json`, publication, human review, or the reference baseline.
- Locking against concurrent writers. The record is maintained by one operator and reviewed in git.

## Approach

### Components

```text
experiments.mjs (CLI, I/O)                     lib/experiment-baseline.mjs (pure)
──────────────────────────                     ──────────────────────────────────
parseArgs(argv) ──────────────┐
runExperimentsCommand({argv,  │
  now, stdout, write}) ───────┼─ read record ─► validateRecord(raw)
                              ├─ read result.json per dir ─► extractRepetition(result, ctx)
                              │                              compareIdentity(base, entry)
                              ├─ apply ───────► applySet / applyAddRep / applyAnchor
                              │                   └─ summarize(reps), selectMedian(reps)
                              ├─ show ────────► formatShow(record)
                              └─ write ───────► writeJsonAtomic(record) (+ staged cleanup)
```

**`evals/agent-runner/and-scene/lib/experiment-baseline.mjs`** has no filesystem access. Its
exports:

- `RECORD_SCHEMA_VERSION = 1` and `SUPPORTED_RESULT_SCHEMA_VERSIONS = [8]`.
- `emptyRecord()` returns `{ schema_version: 1, current: null, anchor: null, history: [] }`.
- `validateRecord(raw)` returns the record, or throws an `Error` naming the first invalid path, for
  example `current.median_rep: "x" is not a repetition`. It checks:
  - an object with `schema_version === 1`, and `history` an array;
  - `current` and `anchor` each `null` or a valid baseline object, checked by
    `validateBaseline(value, path)`;
  - every `history[i]` has `kind ∈ {current, anchor}`, string `replaced_at` and
    `replacement_reason`, and a `record` that passes `validateBaseline`.

  `validateBaseline` checks every field and invariant that some command reads or carries forward:
  - `reps` is a non-empty array of objects with string `run_id`, and the run ids are unique;
  - `identity` and `summary` are objects;
  - `median_rep` is one of the repetition run ids;
  - `human_review` is an object whose `run_id` is one of the repetition run ids, with a boolean
    `is_current_median`;
  - `source` is one of the three allowed values;
  - `reason` and `set_at` are strings;
  - an anchor also has string `anchored_at` and `anchor_reason`.

  It does not re-validate every per-entry metric field, because the tool writes those and git
  reviews them. It does validate what the transitions and `show` dereference, so a malformed
  record is refused before it is archived into `history` or re-published.
- `extractRepetition(result, { directory, addedAt, addedBy })` returns
  `{ entry, refusals: [] }` or `{ entry: null | partialEntry, refusals: [...] }`.
  - It applies the per-result checks:
    - schema version;
    - candidate run (`run_kind === 'candidate' && mode === 'agent-runner'`);
    - infrastructure failure;
    - missing runner commit.
  - It builds the entry using the field mapping below.
  - A partial entry is still returned when the identity fields were readable, so `set` can use the
    first directory's identity for mismatch messages even when that directory is refused for
    another reason.
- `identityOf(entry)` returns the identity object.
- `compareIdentity(baseIdentity, entry)` returns
  `[{ field, baseline, repetition }]`, using dotted field names in a fixed order.
- `selectMedian(reps)` returns a run id.
- `summarize(reps)` returns the summary object.
- `applySet(record, entries, { source, reason, allowMismatch, now })`,
  `applyAddRep(record, entry, { allowMismatch, now })` and `applyAnchor(record, { reason, now })`
  each return `{ record }` or `{ refusals }`. They never mutate their input; they use
  `structuredClone`.
- `formatShow(record)` returns a string.

Each refusal is `{ directory, run_id, code, message }`. Codes:

| Code | Meaning |
|---|---|
| `missing-result` | The directory has no readable `result.json`. |
| `invalid-result` | The `result.json` is not valid JSON. |
| `unsupported-schema` | The `schema_version` is not supported. |
| `not-candidate` | The run is not an Agent Runner candidate run. |
| `infrastructure-failure` | The repetition must be rerun. |
| `missing-runner-commit` | The runner commit is missing. |
| `runner-commit-mismatch` | The runner commit differs from the baseline's. |
| `identity-mismatch` | Another identity field differs and no override was given. |
| `duplicate-run` | The run id or rescore lineage overlaps another repetition. |
| `median-not-reviewed` | The median repetition has no complete human review (`set`), or the current median is not the reviewed repetition (`anchor`). |
| `no-current` | No baseline is set. |

The two `missing-result` and `invalid-result` codes are produced by the CLI, which owns file reads.

**`evals/agent-runner/and-scene/experiments.mjs`** (`#!/usr/bin/env node`, executable) handles
I/O and exit codes:

- `parseArgs(argv)` expects `argv[0] === 'baseline'` and `argv[1]` to be the command. It parses:
  - `--record <path>`;
  - `--source <s>`;
  - `--reason <text>`;
  - `--allow-mismatch <reason>`;
  - `--from-current` (a flag);
  - `--help`;
  - positional result directories, for `set` (one or more) and `add-rep` (exactly one).

  It throws on an unknown command or option, a missing value, an empty `--reason` or
  `--allow-mismatch`, an invalid `--source`, a wrong number of positional arguments, or
  `anchor` without `--from-current`.
- `runExperimentsCommand({ argv, now = () => new Date(), stdout = (s) => process.stdout.write(s),
  write = writeJsonAtomic })` returns `{ exitCode, errors }`. Its steps:
  1. Parse the arguments. On failure it returns exit code 2 with
     `{ code: 'invalid-arguments' }` and the usage text. `--help` prints the usage text and returns
     exit code 0.
  2. Resolve the record path. The default is
     `fileURLToPath(new URL('./experiments/baseline.json', import.meta.url))`, so it is independent
     of the working directory. `--record` is resolved against the working directory.
  3. Read the record with `readJson(path, null)`. A missing file means `emptyRecord()`. A parse or
     validation error returns exit code 2 with `{ code: 'invalid-record' }`, and nothing is
     written.
  4. For `set` and `add-rep`, read `<dir>/result.json` for each directory. `ENOENT` gives a
     `missing-result` refusal and a JSON parse error gives `invalid-result`. Then call
     `extractRepetition`.
  5. Call the pure `apply…` function. Any refusals return exit code 1, and every refusal is
     printed to stderr as one JSON line. This matches `calibrate.mjs`, so the output is both
     human-readable and machine-parsable. Nothing is written.
  6. Otherwise, `mkdir -p` the record's directory, then call `write(path, record, { onStage })`.
     The `onStage` callback captures the staged path. If `write` throws, the command unlinks the
     staged path, ignoring `ENOENT`, and rethrows. This guarantees that no temp file remains,
     because `writeTextAtomic` only cleans up on a rename failure. The shared helper is not
     changed.
  7. On success, print a one-line confirmation, for example
     `baseline set: 3 repetitions, median <run_id>`.
  8. `show` never calls `write`. It prints `formatShow(record)` and returns exit code 0.

The `main` guard is `import.meta.url === pathToFileURL(process.argv[1]).href`, the same as
`score.mjs`. It prints errors and exits with `outcome.exitCode`.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success, `show`, or `--help`. |
| 1 | Admission refusal. The record is valid but the request was refused. |
| 2 | Usage error, invalid record, or unexpected I/O error. |

### Record shape (`schema_version: 1`)

```jsonc
{
  "schema_version": 1,
  "current": {                       // or null
    "source": "profile-change",      // accepted-candidate | profile-change | manual
    "reason": "…",
    "set_at": "2026-10-05T12:00:00.000Z",
    "identity": { /* identity object, from the first directory given to set */ },
    "reps": [ /* repetition entries, in admission order */ ],
    "median_rep": "<run_id>",
    "summary": { /* see Summary */ },
    "human_review": {
      "run_id": "<run_id>",
      "official_score": 76.06,
      "points": 19.5, "possible": 30,             // human_review.score.total / .possible
      "rubric": { "rubric_id": "…", "version": "…", "sha256": "…" },  // human_review.rubric
      "completed_at": "…",                         // human_review.completed_at
      "is_current_median": true
    }
  },
  "anchor": null,                    // or { …same as current…, "anchored_at": "…", "anchor_reason": "…" }
  "history": [
    { "kind": "current" | "anchor", "replaced_at": "…", "replacement_reason": "…", "record": { … } }
  ]
}
```

### Repetition entry

```jsonc
{
  "run_id": "…",
  "added_at": "…", "added_by": "set" | "add-rep",
  "rescored_from": null | "<source_run_id>",
  "runner_commit": "…",                // workflow.provenance.commit
  "skills_commit": "…",                // workflow.agent_skills_provenance.commit
  "workflow": { "workflow", "workflow_path", "task_level_compliance", "final_validator", "skip_validator" },
  "fixture_commit": "…",               // candidate_source.fixture_commit
  "roles": { "<role>": { "configured": { "cli", "model", "effort", "agent" }, "observed_models": ["…"] } },
  "rubrics": { "automated": { "rubric_id", "version", "sha256" }, "human": { … } },
  "automated_score": { "points", "possible", "complete" },      // automated_subtotal
  "gates": { "passed": true, "verdicts": [{ "id", "verdict" }] }, // score.gates_passed, score.gates[]
  "outcome": { "evaluation_status", "product_verdict", "official_score", "human_review_complete" },
  "tokens": {
    "complete": true,                  // cost.usage.complete === true
    "totals": { "input", "output", "total" } | null,   // cost.usage.token_totals
    "detail": { … } | null,            // cost.usage.tokens
    "by_provider": { "openai": { "input", "output", "total" }, "unknown": { … } }
  },
  "active_duration_ms": 6159891 | null,
  "cost": { "state", "complete", "estimated_api_cost_usd", "known_cost_subtotal_usd" },
  "failure": { "failure", "failed_phase", "product_failure" },
  "mismatch": null | { "fields": ["roles.implementor.configured.model"], "reason": "…" }
}
```

Mapping rules:
- **Missing values.** Every source value is read with optional chaining and stored as `null` when
  absent, never with a default.
- **`observed_models`.** These are the sorted distinct non-null `attempts[].observed.model`
  values for the role.
- **`by_provider`.** This is the sum of the numeric `input`, `output` and `total` values of
  `cost.rows[].token_totals`, keyed by `provider ?? 'unknown'`. A row whose `token_totals` is
  null contributes nothing.
- **`rescored_from`.** This is `source_run_id` from the first `workflow.events[]` entry whose
  `event === 'imported-completed-run'`.
- **`automated_score`.** `possible` and `complete` are copied. `points` is copied only when
  `automated_subtotal.complete === true` and `points` is a number; otherwise it is `null`. This
  covers unscored conclusive product failures, where `lib/result.mjs` serializes
  `automated_subtotal: null`. A repetition is **scored** when `automated_score.points` is a number.
- **Admission of failures.** `extractRepetition` refuses `infrastructure-failure` when either:
  - `failure !== null && product_failure === null`; or
  - `product_failure === null` and the repetition is not scored.

  A non-null `product_failure` is admitted whether scored or not.
- **`human_review_complete`.** This is `result.human_review?.complete === true &&
  typeof result.official_score === 'number'`.

### Identity

The identity uses these field names, in this order:

- `runner_commit`
- `skills_commit`
- `workflow.workflow`
- `workflow.workflow_path`
- `workflow.task_level_compliance`
- `workflow.final_validator`
- `workflow.skip_validator`
- `fixture_commit`
- `roles.<role>.configured.<cli|model|effort|agent>`, over the sorted union of role names
- `rubrics.<automated|human>.<rubric_id|version|sha256>`

Values are compared with strict equality, after `?? null`. A role present on one side only shows
up as differences on its configured fields.

`compareIdentity` puts `runner_commit` first. Callers split its result:
- a `runner_commit` difference is always the `runner-commit-mismatch` refusal;
- any other differences produce `identity-mismatch`, unless `allowMismatch` is set. In that case
  the entry gets `mismatch: { fields, reason }`, and `current.identity` is not modified.

### Admission flow

For `set`:
1. Extract every directory's entry.
2. Use the first readable entry's identity as the base.
3. Compare every later entry against the base.
4. Detect lineage overlaps among the inputs. Each entry's lineage is
   `{ run_id } ∪ { rescored_from }`, ignoring `null`. Any shared id between two inputs is a
   `duplicate-run` refusal naming both run ids. When one of the two is a rescore, the message adds
   "use only the rescored directory".
5. If there are any refusals, return all of them.
6. Otherwise, select the median. If its `outcome.human_review_complete` is false, return
   `median-not-reviewed`.
7. Build the new `current`:
   - copy `human_review` from that median's result. `extractRepetition` keeps a private
     `reviewSnapshot` on its return value for this purpose; it is not stored on the entry;
   - set `is_current_median: true`.
8. Push the old `current`, if any, to `history`.
9. If `source === 'profile-change'` and an anchor exists, push the anchor to `history` and set
   `anchor` to `null`.

`history` records are deep copies, and `replacement_reason` is the new `--reason`.

For `add-rep`:
1. Return `no-current` if there is no `current`.
2. Run the same per-result checks.
3. Compare the entry against `current.identity`.
4. Check for a lineage overlap with every entry in `current.reps`, using the same rule. A
   rescore overlap tells the operator to rebuild with `set` from the corrected directory.
5. Append the entry.
6. Recompute `summary` and `median_rep`.
7. Set `human_review.is_current_median = (median_rep === human_review.run_id)`.

`add-rep` changes nothing else.

For `anchor`:
1. Return `no-current` if there is no `current`.
2. Return `median-not-reviewed` if `current.human_review.is_current_median` is `false`. The
   message names `median_rep` and the reviewed run id, and says a fresh `set` including the new
   median's review is required.
3. If an anchor exists, push it to `history`.
4. Set `anchor` to `{ ...structuredClone(current), anchored_at, anchor_reason }`.

### Median

Sort a copy of the repetitions with this ordering:
1. Unscored repetitions (`points === null`) come before all scored ones. An unscored repetition
   is a conclusive product failure that could not be built or served, the worst real outcome.
2. Scored repetitions are ordered by `automated_score.points` ascending.
3. Ties, including ties among unscored repetitions, are broken by `run_id`, using plain `<`
   comparison on code units, which is locale-independent.

Take the repetition at index `Math.floor((n - 1) / 2)`. If that repetition is unscored, it cannot
have a human review (`official_score` is absent), so `set` refuses it with `median-not-reviewed`.

### Summary

```jsonc
"summary": {
  "repetitions": 3,
  "automated_points": { "complete": true, "mean", "min", "max", "stddev" },
  "tokens_total": { … } | { "complete": false, "missing_run_ids": [ … ] },
  "tokens_by_provider": { "complete": true, "providers": { "openai": { "mean", "min", "max", "stddev" }, … } }
                      | { "complete": false, "missing_run_ids": [ … ] },
  "active_duration_ms": { … },
  "estimated_cost_usd": { … }
}
```

The `stats(values)` helper returns the mean, min, max and sample standard deviation:
`sqrt(Σ(x − mean)² / (n − 1))`, or `null` when `n === 1`. Values are stored unrounded.

Completeness per metric:

| Metric | A repetition is complete when |
|---|---|
| `automated_points` | The repetition is scored. An unscored product failure is listed in `missing_run_ids`. |
| `tokens_total` | `tokens.complete && typeof tokens.totals?.total === 'number'`. |
| `tokens_by_provider` | The same condition as `tokens_total`. A missing provider counts as 0 for a complete repetition. |
| `active_duration_ms` | `typeof active_duration_ms === 'number'`. |
| `estimated_cost_usd` | `cost.complete === true && typeof cost.estimated_api_cost_usd === 'number'`. |

`missing_run_ids` preserves admission order.

### `show` output

The output is plain text with numbers rounded for display: two decimals for points and USD,
minutes with one decimal for time, and integers for tokens. Example:

```text
Experiment baseline (source: profile-change, set 2026-10-05T12:00:00.000Z)
Reason: …
Repetitions (3):
  <run_id>  automated 56.29/70  verdict unavailable  active 155.0 min  cost incomplete
  <run_id>  automated 49.81/70  product failure: Required automated gate failed: …  …
  <run_id>  automated unscored  product failure: <reason>  …
  …  [mismatch: <fields> — <reason>]  [rescored from <id>]
Automated points: mean 54.30  min 49.81  max 56.81  sd 3.90
Tokens total: mean …  |  incomplete (missing: <ids>)
Tokens by provider: openai mean … ; anthropic mean … ; unknown mean …
Active time: …   Cost: incomplete (missing: <ids>)
Median repetition: <run_id>
Human review: <run_id>  official 76.06  review 19.5/30
  Note: the current median repetition <median> is not the human-reviewed repetition <reviewed>.
Anchor: none | set <anchored_at> (<anchor_reason>), 3 repetitions, mean automated 54.30 | incomplete
```

With no record, or with `current: null`, the output is `No experiment baseline is set.` followed by
the anchor line when an anchor exists.

## Decisions

- **Pure core plus thin CLI.** The core takes parsed results rather than paths. This lets most tests
  build results in memory and assert on records, matching `calibrate.mjs` and `score.mjs`. The
  alternative was a CLI-only module doing I/O inline; it is simpler but needs filesystem fixtures
  for every rule.
- **Reuse `writeJsonAtomic`, with staged cleanup in the caller.** The `onStage` hook already exists.
  Changing the shared helper's error behavior would touch every checkpoint write in the controller,
  outside this change's scope.
- **Exit codes 1 and 2.** Exit code 1 means "your request was refused, rerun or override". Exit code
  2 means "the invocation or record is broken". This follows the suite's convention of exit code 2
  for invalid arguments.
- **Refusals printed as JSON lines on stderr.** This is consistent with `calibrate.mjs` and
  `controller.mjs` error reporting, and lets a later ledger or factory step parse the reasons.
- **All refusals reported at once for `set`.** The operator sees every bad repetition in one
  attempt, instead of fixing them one per run.
- **Identity from the first directory, never rewritten.** This is deterministic and simple, and
  matches the proposal-review decision PR-2.
- **The record stores copies, not paths.** Directory paths are machine-specific. The run id is the
  stable key into `results/`.
- **`schema_version: 1` for the record**, separate from `result.json`'s version, so the downstream
  tickets can detect shape changes.
- **No locking.** A single maintainer edits the record, and the change goes through review in git.
  Concurrent `set` calls would at worst lose one write, and the git diff would show it.

## Risks / Trade-offs

- **Schema drift in `result.json`.** A future schema 9 is refused until it is added to
  `SUPPORTED_RESULT_SCHEMA_VERSIONS` with tests. This is deliberate: a silent mis-mapping would be
  worse than a refusal.
- **Cost is always incomplete today.** The summary will report cost as incomplete for current
  results. This is honest; improving it belongs to cost capture work, not here.
- **The identity does not cover the evaluator or Validator revision.** `result.json` lacks both.
  This is documented in the proposal and the README section, and mitigated by building baselines
  from one factory eval issue.
- **Record size.** Entries copy roughly 2 KB each. With history this grows linearly, which is
  acceptable for a committed JSON file at the expected cadence of a few baselines per month.
- **Floating-point display.** Statistics are stored unrounded. Only `show` rounds, so stored values
  stay exact for later comparison.

## Testing Strategy

The new test file is `test/experiment-baseline.test.mjs`, run by the existing
`node --test test/*.test.mjs`.

- **Builder.** `makeResult(overrides)` returns a minimal schema-8 candidate result with every mapped
  field. A deep-merge helper applies the overrides.
- **Pure-module tests.** Each spec requirement has at least one test covering its scenarios:
  - extraction mapping, including null-provider rows, missing active time and rescore linkage;
  - unscored product failures, from verification and from the candidate server: admitted with
    `points: null`, ranked lowest for the median, making `automated_points` incomplete, and
    refused as an unreviewable median;
  - rescore lineage overlaps in both orders, for `set` and for `add-rep`;
  - `anchor` refused when `is_current_median` is false;
  - `validateRecord` rejecting each invalid baseline and history shape, including `current: {}`,
    a dangling `median_rep` or `human_review.run_id`, duplicate repetition ids, and a bad history
    `kind`;
  - each refusal code;
  - runner commit refused even with an override;
  - mismatch recorded on the overriding entry;
  - observed-model difference allowed;
  - median for odd, even and tied counts;
  - summary completeness and sample standard deviation, with `null` for one repetition;
  - `set` history and profile-change anchor clearing;
  - unreviewed median refused;
  - `add-rep` divergence flag;
  - anchor replacement and immutability;
  - `formatShow` divergence note and "no baseline" text.
- **Real-result guard.** `extractRepetition` runs on a real published result,
  `results/aab6fbe4-c5d1-4ab8-a169-e71500370a30-rep-1/result.json`, read only. The test asserts
  the runner commit, fixture commit, role models, rubric hashes, automated points and
  `human_review_complete: true`. This catches field-path mistakes that synthetic fixtures would
  mirror.
- **Command tests.** These use a temp directory for `--record` and for the result directories. They
  cover:
  - the first `set` creates a pretty-printed record ending in a newline;
  - a refused `set` leaves the record bytes unchanged and exits 1;
  - a corrupt record exits 2 and is not overwritten;
  - a parseable but structurally invalid schema-1 record (`current: {}`) makes `show` and `set`
    exit 2, with the file unchanged;
  - an injected `write` that throws after staging leaves no `.tmp` file in the directory;
  - `show` does not change the record bytes or modification time;
  - usage errors, including unknown subcommands, `--source experiment` and a missing `--reason`,
    exit 2;
  - `--record` leaves the default path untouched. The test asserts that the default suite record
    file does not exist or is unchanged.
- **`package.json`.** The `check` script adds
  `node --check evals/agent-runner/and-scene/experiments.mjs` and
  `node --check evals/agent-runner/and-scene/lib/experiment-baseline.mjs`, placed before
  `node --test`.

## Migration Plan

This change is purely additive, so no migration is needed. The record file does not exist until the
first manual `set`. That is the seeding step, out of scope: `set --source profile-change` with the
three agent-evals#67 repetitions, then `anchor --from-current`.

The suite `README.md` gets an "Experiment baseline" section after "Publication". It covers:
- the commands;
- the refusal rules;
- the exit codes;
- the identity limitation;
- the distinction from the reference baseline.

Rollback is a revert of the change. No other code reads the record yet.
