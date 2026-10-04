## Why

The and-scene eval can now measure an Agent Runner candidate end to end, but there is no committed
answer to "what are we comparing it against?". Each candidate's published `result.json` stands
alone. Before this change, deciding whether a candidate beats the current state means someone picks
earlier runs by hand, eyeballs scores, tokens, time and cost across several files, and hopes the
runs were comparable. Single-repetition noise is large (published repetitions of one configuration
already differ by many points), so a single run is not a usable reference either.

This change is ticket 2 of the eval-loop plan in the Factory and eval loop strategy (2026-09-27).
The later tickets need one durable source of truth for the current state:

- the comparison report compares a candidate against it;
- the experiment ledger promotes accepted candidates into it.

That source of truth is the **experiment baseline**. It is a committed record of which published
repetitions make up the baseline, what they ran on, and their aggregated score, cost and time. It
also holds a frozen **anchor** for detecting slow drift later. The first baseline (agent-evals#67)
is ready to be recorded as soon as this ships. It cannot be recorded faithfully until the record and
its refusal rules exist.

The audience is the eval maintainer (Paul) and the agent factory, which will later read and promote
into the record.

**Verdict: go.** The problem is real and blocks the next two tickets. The scope is small and
self-contained in this repository, and every product decision is settled in the issue. There is no
credible alternative to building it: a README table or git tags cannot enforce the mismatch,
failure and human-review rules, and those rules are what make the record trustworthy. One caveat:
today's published results often have incomplete cost (`cost.total.complete: false`). So the cost
summary will usually report "incomplete" until cost capture improves. That is the intended honest
behavior, not a defect of this change.

## What Changes

- Add a committed record file, `evals/agent-runner/and-scene/experiments/baseline.json`, holding:
  - `current`: the baseline. It contains:
    - per-repetition entries;
    - an aggregate summary (mean, min, max and standard deviation of automated score, tokens in total
      and per provider, active time, and cost);
    - the median repetition;
    - the required human review;
    - source and reason;
    - the time it was set;
    - the identity values the repetitions share.
  - `anchor`: an optional frozen copy of a baseline.
  - `history[]`: every replaced `current` and `anchor`, with the replacement time and reason.
- Add a CLI, `evals/agent-runner/and-scene/experiments.mjs baseline <command>`, with four commands:
  - `set <result-dir>... --source <accepted-candidate|profile-change|manual> --reason <text> [--allow-mismatch <reason>]`
  - `add-rep <result-dir> [--allow-mismatch <reason>]`
  - `anchor --from-current --reason <text>`
  - `show`
- Enforce the issue's admission rules when reading published result directories:
  - Supported `result.json` schema versions only. Version 8 is the only one today.
  - **One runner commit.** Every repetition must share the same runner commit. This is unconditional
    and `--allow-mismatch` cannot waive it (issue decision 1: other runner commits never join a
    baseline).
  - **Mismatch rule.** Every repetition must also share the same skills commit, workflow settings,
    fixture commit, role profiles and rubrics. A repetition that differs in any of these is refused
    unless `--allow-mismatch <reason>` is given. The reason and the waived fields are stored on
    that repetition.
  - **Infrastructure failures are refused.** These are repetitions with `failure` set and
    `product_failure` null. Product failures are kept. This includes an unscored conclusive
    product failure (the candidate could not be built or served). It keeps a `null` score, ranks
    lowest for the median, and makes the automated-score summary incomplete instead of being given
    an invented number.
  - **One execution, one repetition.** A repetition and its rescore cannot both be in a baseline.
  - **Human review is required.** `set` requires a complete human review on the median repetition.
    There is no override. A later `add-rep` can move the median away from the reviewed repetition;
    the record then marks the review as not the current median's (see Technical Approach). An
    anchor can only be taken while the median is the reviewed repetition.
  - **The record is validated before use.** A malformed record is refused by every command and is
    never archived or rewritten.
- Write the record atomically (temp file plus rename), pretty-printed for reviewable diffs.
- Add unit tests to the existing `node --test test/*.test.mjs` suite. Add the new modules to the
  `check` script's `node --check` list.

There are no breaking changes. The existing **reference baseline** (`lib/baseline.mjs`,
`--reference-baseline`, `result.json`'s `baseline` field) is not touched or reused.

## Capabilities

### New Capabilities
- `experiment-baseline-record`: The committed experiment baseline record for the and-scene eval. It
  covers:
  - the record's contents and how they are derived from published `result.json` files;
  - the admission rules (schema support, mismatch, failed repetitions, required human review);
  - summary statistics and median selection;
  - anchor and history management;
  - the `baseline set | add-rep | anchor | show` commands;
  - atomic, reviewable writes.

### Modified Capabilities
- None. The `evaluation-outcomes`, `human-review-workflow` and `evaluation-metrics-reporting`
  requirements are read as inputs and do not change.

## Technical Approach

- **Placement.** The CLI is a thin entry point, `evals/agent-runner/and-scene/experiments.mjs`. It
  parses arguments and dispatches to a pure library module, `lib/experiment-baseline.mjs`. That
  module does:
  - repetition extraction from a parsed `result.json` (the issue's field mapping);
  - identity comparison;
  - admission checks;
  - summary statistics;
  - median selection;
  - record transitions (`set`, `add-rep`, `anchor`).

  Filesystem I/O (reading result directories, atomic record write) stays at the edge, reusing the
  suite's existing persistence helpers where they fit. This matches the suite pattern of thin
  commands over tested `lib/` modules (`score.mjs`, `human-review.mjs`). It uses Node built-ins
  only, with no new dependencies, so most behavior is unit-testable on in-memory records.
- **Record location.** The default record path resolves relative to the suite directory, not the
  working directory. Tests point the module at a temporary path; the CLI may expose a record-path
  override for that purpose.
- **Repetition entries copy, not reference.** Each repetition stores the mapped values, including:
  - observed models per role;
  - the gate verdicts;
  - the failure triple (`failure`, `failed_phase`, `product_failure`);
  - the score and cost completeness flags.

  The record stays meaningful even if a result directory is later reverted. Per-provider tokens
  are computed by summing `cost.rows[]` grouped by `provider`.
- **Input source.** The input is a published result directory as the agent factory saves it to
  `results/<run_id>/`. The factory saves automated results without waiting for a human review,
  and adds a completed review on a later tick. So product-failure and `pending-human-review`
  repetitions are present there alongside reviewed ones; for example, `results/` today holds both
  kinds. The README's Publication section describes only the separate `human-review.sh` publish
  path. Seeding #67 therefore needs no publication change. It does need the factory's pending
  saves of the three #67 repetitions (currently retrying a failed push) to land, with rep 2's
  review. That is an operational step outside this change.
- **Identity.** The mismatch rule compares one normalized identity per repetition:
  - runner commit (unconditional; never waivable);
  - skills commit;
  - `workflow` and `workflow_path`;
  - the `task_level_compliance`, `final_validator` and `skip_validator` settings;
  - fixture commit;
  - configured role profiles (cli, model, effort, agent per role);
  - automated and human rubric id, version and sha256.

  Observed models are recorded but are not part of the identity. They come from execution and are
  reported, not matched.

  The baseline's shared identity is defined as follows:
  - For `set`, it is the identity of the first result directory given. Every other repetition is
    compared against it.
  - For `add-rep`, the new repetition is compared against the stored `current` identity.
  - A repetition admitted with `--allow-mismatch` keeps its own identity values plus
    `mismatch: { fields, reason }`. The shared identity is never rewritten to absorb a waived
    difference.
- **Measurement identity limit.** The identity covers the evaluated product setup and the rubric
  bytes. It does not cover the agent-evals scoring code (checker and metrics fixes) or the Agent
  Validator revision, because `result.json` does not record either. Those revisions live only in
  the factory's frozen-input comments on the eval issue. The record therefore does not claim that
  the measurement machinery was identical across repetitions. Repetitions of one baseline normally
  come from one factory eval issue, which freezes both revisions for all of its repetitions. The
  `reason` text is the place to note anything else. Recording evaluator and Validator provenance in
  `result.json` is follow-up work.
- **Median.** The median repetition is selected by automated score (`automated_subtotal.points`).
  For an even count it takes the lower median. Ties are broken by run id, so the choice is
  deterministic.
- **Human review.** At `set` time, `current.human_review` is copied from the median repetition's
  `human_review`, together with that repetition's run id and `official_score`. The rest follows the
  issue:
  - `add-rep` recomputes `median_rep` but keeps the recorded review and its run id.
  - The record states the divergence explicitly, as a stored flag (for example,
    `human_review.is_current_median: false`), so a reader never has to infer it. `show` reports it.
  - `current.human_review` is always the score of the named reviewed repetition, never "the
    current median's score".
  - Whether the comparison and ledger tickets refuse a divergent baseline is decided in those
    tickets.
  - A fresh `set` that includes a review of the new median is the way to clear the divergence.
- **Rescored repetitions.** The operator passes the rescored result directory. Its `result.json` is
  the corrected record. When the result carries the `imported-completed-run` workflow event, the
  entry records the source run id (`rescored_from`), so the link to the original repetition is
  visible.
- **Cost.** The cost summary is computed only when every repetition's `cost.total.complete` is true.
  Otherwise it is reported as incomplete, with no partial averages. The same rule applies to any
  metric missing on some repetition; the summary never averages over a silent subset.

Technical design details (exact record schema, statistics conventions such as population vs.
sample standard deviation, `show` layout, error codes) are left to `design.md` and the specs.

## Out of Scope

- Comparing a candidate against the experiment baseline (the separate comparison ticket).
- The experiment ledger and promoting accepted candidates into the baseline.
- The `eval-baseline` git tag on agent-runner.
- Seeding the record. The first baseline (agent-evals#67, rep 2 as the human-reviewed median, then
  `anchor --from-current`) is set by hand after this ships. That happens once the factory has saved
  all three #67 result directories to `results/`.
- Recording agent-evals or Agent Validator revisions in `result.json`, which would be a schema
  change. Until then, the identity limit above applies.
- Drift-check control repetitions on a later agent-runner `main`. These have a different runner
  commit and can never join the baseline.
- Any change to the reference baseline code path, `result.json` schema, publication, or the
  human-review command.
- New test suites or CI jobs.

## Impact

- **New files:**
  - `evals/agent-runner/and-scene/experiments.mjs`;
  - `evals/agent-runner/and-scene/lib/experiment-baseline.mjs`;
  - `test/experiment-baseline.test.mjs`, with small synthetic `result.json` fixtures under
    `test/fixtures/` as needed.
- **Changed files:**
  - `package.json`: the `check` script's `node --check` list;
  - the suite `README.md`: a short section on the experiment baseline and its commands, explicitly
    distinguished from the reference baseline.
- **Not created by this change:** `evals/agent-runner/and-scene/experiments/baseline.json`. It is
  first written by the manual seeding step.
- **Dependencies:** none added.
- **Systems:**
  - The agent factory and future tickets will read this record. Its shape becomes a persisted format
    those tickets depend on, so the design should version it (`schema_version`).
  - Published `results/**` are read only, never modified.
