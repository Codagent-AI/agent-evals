# Task: Experiment baseline record and `experiments.mjs baseline` CLI

## Goal

Add a committed **experiment baseline** record for the and-scene eval, and a CLI to maintain it.

The record lives at `evals/agent-runner/and-scene/experiments/baseline.json`. It names the published
repetitions that form the current baseline, what they ran on, and their aggregated score, tokens,
active time and cost. It also holds an optional frozen anchor and a history of replaced baselines.

The CLI is `node evals/agent-runner/and-scene/experiments.mjs baseline <set|add-rep|anchor|show>`.

This is unrelated to the existing **reference baseline** (`lib/baseline.mjs`,
`--reference-baseline`, `result.json.baseline`). Do not read, reuse or change that code.

## Sources of truth

Read these first. They are normative, and this file only orients you:

- `openspec/changes/feature-58-f9c0fad6/specs/experiment-baseline-record/spec.md`: every
  requirement and scenario to satisfy.
- `openspec/changes/feature-58-f9c0fad6/design.md`: the components, exported functions, record and
  entry shapes, identity field order, admission flow, median and summary algorithms, refusal codes,
  exit codes, `show` layout, and test strategy.
- `openspec/changes/feature-58-f9c0fad6/test-plan.md`: the integration and end-to-end obligations
  INT-001, INT-002 and E2E-001.
- `openspec/changes/feature-58-f9c0fad6/decisions.md`: the rationale for every choice, including
  the proposal-review findings PR-1 to PR-4 and the approach-review findings AR-1 to AR-4. Where an
  earlier spec-step entry conflicts with a later review entry, the later entry and the current spec
  win. For example, AR-1 supersedes the spec-step note that product failures need a complete
  automated score.
- `openspec/changes/feature-58-f9c0fad6/proposal.md`: scope and out-of-scope items.

## Background

The suite lives in `evals/agent-runner/and-scene/`. Tests live in the repository-root `test/`
directory and run through `npm test` (`node --test test/*.test.mjs`) and `npm run check`.

Facts about published schema-8 `result.json` files, verified in `results/`:

- **Runner commit and skills commit.** The runner commit is `workflow.provenance.commit`. The
  skills commit is `workflow.agent_skills_provenance.commit`.
- **Workflow settings.** These are top-level fields of `workflow`. `skip_validator` is a string,
  for example `"false"`.
- **Role profiles.** Each role is under `role_configuration.roles.<role>`. The configured profile is
  `.configured` (`cli`, `model`, `effort`, `agent`). Each attempt's observed model is
  `.attempts[].observed.model`.
- **Cost rows.** `cost.rows[].provider` can be `null`, for example on tester and Validator rows.
  Group those rows under `unknown`.
- **Usage and cost completeness.**
  - `cost.usage.complete` is often `false`.
  - `cost.usage.token_totals` is `null` when usage is unavailable.
  - `cost.total.complete` is `false` on every published result so far.
- **Active time.** `implementation_metrics.active_duration_ms` can be `null`.
- **Unscored product failures.** These come from verification or the candidate server, and have
  `automated_subtotal: null` (`lib/result.mjs`). None are published yet, so build them
  synthetically.
- **Unreviewed results** have no `human_review` key and no `official_score`. A reviewed result has
  `human_review.complete === true`, a numeric `official_score`, `human_review.score.total` and
  `.possible`, `human_review.rubric`, and `human_review.completed_at`.
- **Rescores.** A rescored result has
  `workflow.events[] = { event: 'imported-completed-run', source_run_id, provenance_sha256 }`.
- **Reference values for INT-001.** `results/aab6fbe4-c5d1-4ab8-a169-e71500370a30-rep-1/result.json`
  has:
  - runner commit `aed680076ecb35a1871c20306f3872e3cd915e8f`;
  - skills commit `aae772244c80f8a0b9b4e128ac816db2bbad28f4`;
  - fixture commit `892dfbcf3762bc95cdbae6f05b18cc2b168a5fab`;
  - lead model `claude-sonnet-5-5`;
  - automated rubric `6.0.0`, sha256
    `291738a326b479387b0114aafad134f6d15953869d16f856a50a074f3c960891`;
  - automated points `56.56071428571428`;
  - a complete human review;
  - provider token totals that sum to `28996374`, which equals `cost.usage.token_totals.total`.

Existing helpers and patterns to reuse:

- `lib/persistence.mjs`:
  - `readJson(path, fallback)`;
  - `writeJsonAtomic(target, value, { onStage })`, which writes a same-directory temp file, fsyncs,
    renames, and pretty-prints with two-space JSON plus a newline. It only unlinks the temp file
    when the rename fails, so the command must unlink the staged path captured through `onStage`
    when `write` throws.
- `calibrate.mjs` and `score.mjs` show the command style:
  - an exported `parseArgs`;
  - an exported `run…Command({ argv, … })` returning `{ exitCode, errors }`;
  - errors printed as JSON lines on stderr;
  - a `main` guard of the form `import.meta.url === pathToFileURL(process.argv[1]).href`.

## What to build

1. **`evals/agent-runner/and-scene/lib/experiment-baseline.mjs`.** A pure module with no
   filesystem access, as specified in design.md "Components". It covers:
   - `RECORD_SCHEMA_VERSION = 1`, `SUPPORTED_RESULT_SCHEMA_VERSIONS = [8]`, and `emptyRecord`;
   - `validateRecord` and `validateBaseline`, with the full invariants from AR-4 and the spec's
     "Experiment baseline record file" requirement;
   - `extractRepetition`, with the field mapping. The automated `points` are `null` unless the
     subtotal is complete and numeric. It returns a private review snapshot for the median's review;
   - `identityOf` and `compareIdentity`, with the fixed field order. A runner-commit difference is
     never waivable;
   - lineage-overlap duplicate detection, covering `run_id` and `rescored_from`;
   - `selectMedian`: unscored repetitions first, then points ascending, ties broken by run id with
     `<`, taking index `floor((n - 1) / 2)`;
   - `summarize`, using the sample standard deviation, `null` for one repetition, and per-metric
     completeness with `missing_run_ids`;
   - `applySet`, `applyAddRep` and `applyAnchor`. These never mutate their input. `anchor` is
     refused when `is_current_median` is false;
   - `formatShow`.

   Refusals are `{ directory, run_id, code, message }`, using the codes in the design table.

2. **`evals/agent-runner/and-scene/experiments.mjs`.** The CLI, starting with `#!/usr/bin/env node`
   and marked executable (`chmod +x`). It does all the I/O:
   - `parseArgs`, covering `--record`, `--source`, `--reason`, `--allow-mismatch`, `--from-current`,
     `--help`, and the positional directories;
   - `runExperimentsCommand({ argv, now, stdout, write })`;
   - the default record path resolved from `import.meta.url`;
   - `mkdir -p` of the record directory before writing;
   - exit codes: 0 for success, `show` or `--help`; 1 for refusals; 2 for usage errors, invalid
     records or I/O errors;
   - every refusal printed as a JSON line on stderr;
   - a one-line confirmation on stdout after a write.

3. **`package.json`.** Add `node --check evals/agent-runner/and-scene/experiments.mjs` and
   `node --check evals/agent-runner/and-scene/lib/experiment-baseline.mjs` to the `check` script,
   before `node --test test/*.test.mjs`.

4. **`evals/agent-runner/and-scene/README.md`.** Add an "Experiment baseline" section after
   "Publication". Cover:
   - the purpose, and the distinction from the reference baseline;
   - the four commands, with examples;
   - the admission rules: runner commit never waivable, `--allow-mismatch`, infrastructure
     failures refused, product failures (including unscored ones) kept, rescore lineage, and human
     review of the median required for `set` and `anchor`;
   - the exit codes;
   - incomplete metrics;
   - the identity limitation: the agent-evals and Agent Validator revisions are not recorded in
     `result.json`;
   - the manual seeding procedure for agent-evals#67.

Do **not** create `experiments/baseline.json`. Seeding is manual and happens after merge.

## Tests

Put all tests in `test/experiment-baseline.test.mjs`.

- **Unit tests.** Derive them from every scenario in the spec, and from the design's
  "Testing Strategy" list, using a `makeResult(overrides)` builder for a minimal schema-8 candidate
  result. They must include:
  - unscored product failures, from verification and from the candidate server:
    - admitted with `points: null`;
    - ranked lowest for the median;
    - making `automated_points` incomplete;
    - refused as an unreviewable median;
  - rescore lineage overlap in both orders, for `set` and `add-rep`;
  - `anchor` refused after divergence;
  - `validateRecord` rejecting `current: {}`, a dangling `median_rep` or `human_review.run_id`,
    duplicate repetition ids, and a bad history `kind`;
  - a runner-commit mismatch refused even with `--allow-mismatch`;
  - an observed-model difference that is not a mismatch;
  - median for odd, even and tied counts;
  - sample standard deviation;
  - history and the `profile-change` anchor reset.
- **INT-001.** Real published results, read only:
  - `aab6fbe4-…-rep-1`, with the reference values above;
  - `3938f16c-…-rep-1`, which has an `unknown` provider bucket and no human review;
  - `19b861fd-…-rep-1`, which is admitted as a product failure, with `tokens.complete: false` and
    `active_duration_ms: null`.

  Assert that the file hashes are unchanged afterwards.
- **INT-002.** Persistence through `runExperimentsCommand`, with a temp `--record` path:
  - the first `set` creates the parent directory and a pretty-printed record;
  - a refused `set` leaves the bytes unchanged and exits 1;
  - invalid JSON exits 2;
  - parseable but structurally invalid records (`current: {}`, a dangling `median_rep`) make
    `show` and `set` exit 2, with the files unchanged;
  - an injected throwing `write` leaves no `.tmp` file;
  - `show` does not change the record's bytes or modification time;
  - the default record path is untouched.
- **E2E-001.** A child-process journey through `experiments.mjs`, exactly as in `test-plan.md`
  steps 1 to 9:
  1. `set`;
  2. `anchor`;
  3. `add-rep` with a 45-point control repetition, which moves the median to the 49.81
     repetition and sets `is_current_median: false`;
  4. `show`, which reports the divergence;
  5. `anchor` refused;
  6. a rescore `add-rep` refused;
  7. a runner-commit refusal;
  8. usage errors;
  9. a `profile-change` reset.

## Constraints

- Node built-ins only. No new runtime dependencies.
- Do not modify anything under `evals/agent-runner/and-scene/results/**`.
- Do not touch the reference-baseline code path, `result.json` assembly, publication, or
  human-review code.
- Do not create or commit `evals/agent-runner/and-scene/experiments/baseline.json`. Tests must
  always use `--record`, or the injected path, under a temp directory.
- Do not change `writeTextAtomic` or `writeJsonAtomic` in `lib/persistence.mjs`. Handle staged-file
  cleanup in the command.
- Store unrounded statistics. Only `show` rounds.
- Use test-driven development: write failing tests first, then implement.
- Use commit messages of the form `type: lowercase description`, for example
  `feat: add experiment baseline record and cli`.

## Done When

- Every scenario in `specs/experiment-baseline-record/spec.md` is covered by a passing test.
- INT-001, INT-002 and E2E-001 pass in `test/experiment-baseline.test.mjs`.
- `npm run check` passes, including the two new `node --check` entries.
- `node evals/agent-runner/and-scene/experiments.mjs baseline --help` prints usage and exits 0.
- `experiments.mjs` is executable.
- The README has the "Experiment baseline" section.
- Nothing under `results/` changed, and no `experiments/baseline.json` exists in the repository.
