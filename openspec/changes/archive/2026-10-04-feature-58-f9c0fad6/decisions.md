# Decisions

## propose

### Verdict: go
- **Decision:** Proceed with the change as scoped by issue #58.
- **Alternatives considered:**
  - Hand-maintained README table of baseline runs: cannot enforce the mismatch, failure or
    human-review rules.
  - Git tags only: carry no aggregates and no repetitions.
  - Defer until the comparison ticket: the comparison and ledger tickets both depend on this
    record.
- **Decision-bearing:** yes.

### Adopt the issue's settled product decisions verbatim
- **Decision:** Adopt Paul's four decisions (2026-10-04):
  1. One runner commit per baseline.
  2. Refuse infrastructure failures and keep product failures.
  3. Every baseline requires a complete human review of its median repetition, and the first
     baseline also becomes the anchor.
  4. The first baseline is agent-evals#67 as a `profile-change` reset.
- **Alternatives considered:** None. These are settled by the issue author.
- **Decision-bearing:** no.

### Median for an even repetition count
- **Decision:** Take the lower median by automated score (`automated_subtotal.points`), with ties
  broken by run id.
- **Alternatives considered:**
  - Upper median.
  - Averaging the two middle repetitions: no single repetition to review, so not possible.
- **Decision-bearing:** no. Low-risk default; the issue's first baseline has three repetitions.

### Rescored repetitions
- **Decision:** The operator passes the rescored result directory; its `result.json` is read as-is.
  When the result carries the `imported-completed-run` workflow event, the entry records the source
  run id as `rescored_from`. The CLI does not search `results/` for a newer rescore of a given run.
- **Alternatives considered:**
  - Auto-discover rescores by scanning `results/`: fragile, and rescore run ids are free-form.
  - Refuse an original when a rescore exists: needs that same discovery.
- **Decision-bearing:** no.

### Observed models are recorded but not part of the mismatch identity
- **Decision:** The mismatch identity uses configured role profiles (cli, model, effort, agent).
  Observed models from `.attempts[].observed` are stored for reporting only.
- **Alternatives considered:** Include observed models in the identity. Execution detail would then
  refuse otherwise-identical repetitions, which the issue's mismatch list does not ask for.
- **Decision-bearing:** no.

### Metrics missing on some repetitions
- **Decision:** Extend the issue's cost rule to every summarized metric: a metric missing or
  incomplete on any repetition is reported as incomplete, not averaged over a subset.
- **Alternatives considered:** Average over the available repetitions, which silently biases the
  summary.
- **Decision-bearing:** no.

### Repetition with no complete automated score and no product failure
- **Decision:** Treat it as an infrastructure-style failure and refuse it. There is no real score to
  keep, and the issue's intent is to rerun anything that is not a genuine product result. The exact
  condition is left to the spec.
- **Alternatives considered:** Admit it with an incomplete score. This would poison the summary and
  the median selection.
- **Decision-bearing:** no.

### Module layout and record path
- **Decision:**
  - The thin CLI `experiments.mjs` sits over a pure `lib/experiment-baseline.mjs`.
  - Tests go in `test/experiment-baseline.test.mjs`.
  - The record path resolves relative to the suite directory, with an override for tests.
  - The record carries a `schema_version`.
- **Alternatives considered:** A single-file CLI with inline logic. It is harder to unit test and
  does not match the suite pattern.
- **Decision-bearing:** no.

### The change does not create `experiments/baseline.json`
- **Decision:** Seeding is out of scope per the issue. The file is created by the first manual
  `set`.
- **Alternatives considered:** Commit an empty record.
- **Decision-bearing:** no.

## proposal-review

### PR-1 (structural): the first baseline cannot be seeded from published results
- **Decision:** Rejected the premise, and applied a clarification.
- **Why the premise does not hold:** The finding relies on the README's Publication section,
  which covers only the `human-review.sh` publish path. The agent factory saves automated results
  to `results/<run_id>/` without waiting for a human review, and adds a completed review on a later
  tick. Its comment on #67 says so: "The automated results are saved to the eval repository
  without it". `results/` already holds factory-saved product-failure and `pending-human-review`
  repetitions, for example `19b861fd-…-rep-1` and `3938f16c-…-rep-1..3`.
- **Why the #67 directories are missing:** They are absent only because the factory's push is
  failing and being retried. That is an operational issue outside this repository.
- **What changed in the proposal:**
  - It names the input as factory-saved result directories.
  - It explains why no publication change is needed.
  - It records seeding as dependent on those saves landing.
- **Alternatives considered:**
  - A new publication path for unreviewed results: unnecessary, since the factory path already
    exists.
  - Ingesting local artifact directories: the source would not be durable or reviewable.
- **Decision-bearing:** no.

### PR-2 (significant): `--allow-mismatch` can waive the runner commit
- **Decision:** Applied.
  - Runner-commit equality is unconditional and cannot be waived.
  - `--allow-mismatch` covers only the other identity fields.
  - Shared identity comes from the first directory given to `set`, or from the stored `current`
    for `add-rep`.
  - A waived repetition stores its own values plus `mismatch: { fields, reason }`.

  The issue's Decisions section (decision 1: other runner commits "never join the baseline")
  resolves the tension in its Input section, so this is not a materially different reading.
- **Alternatives considered:** Let the override cover every field, including the runner commit,
  following the literal Input section. That contradicts decision 1 and the out-of-scope drift
  rule.
- **Decision-bearing:** yes. It narrows the issue's literal override rule to match the issue's
  explicit decision.

### PR-3 (significant): the identity omits evaluator and Validator provenance
- **Decision:** Partially applied.
- **Applied:** The proposal now states the limitation explicitly:
  - `result.json` does not record the agent-evals or Agent Validator revision. I verified this:
    the only 40-character commits in a v8 result are runner, skills, fixture and candidate
    revisions.
  - The record therefore does not claim the measurement machinery was identical.
  - A baseline normally comes from one factory eval issue, which freezes both revisions for all its
    repetitions.
- **Rejected:** Persisting that provenance or refusing on it.
  - Persisting it would change the `result.json` schema, a persisted format, or depend on factory
    metadata outside this repository.
  - It would also add an identity field the issue's mismatch list does not include.
  - It is listed as follow-up work, out of scope.
- **Alternatives considered:**
  - Infer the agent-evals revision from the git commit that published the result: that is the
    publication time, not the run time, so it is untrustworthy.
  - Accept operator-supplied revision flags: unverifiable.
- **Decision-bearing:** no. It documents a limitation within the issue's scope; the issue author
  can widen the scope in a follow-up.

### PR-4 (significant): after `add-rep`, the current median may lack the required review
- **Decision:** Partially applied.
- **Applied:**
  - The record stores an explicit divergence flag (for example,
    `human_review.is_current_median: false`) instead of only a `show` warning.
  - `current.human_review` is defined as the score of the named reviewed repetition.
  - A fresh `set` that includes a review of the new median clears the divergence.
- **Rejected:** Requiring a review of the new median before `add-rep` commits. The issue
  explicitly says `add-rep` "keeps the recorded `human_review` and its run id".
- **Deferred:** Whether downstream readers must refuse a divergent baseline belongs to the
  comparison and ledger tickets.
- **Alternatives considered:**
  - Require the review in `add-rep`: contradicts the issue.
  - Mandate refusal by consumers in this change: that decision belongs to the out-of-scope tickets.
- **Decision-bearing:** no.

## spec

### One capability spec
- **Decision:** All behavior goes in `specs/experiment-baseline-record/spec.md`. No existing spec is
  modified.
- **Alternatives considered:** Split the CLI and the record into two capabilities. They are one
  behavioral area.
- **Decision-bearing:** no.

### Only Agent Runner candidate runs are admitted
- **Decision:** Refuse a result whose `run_kind` is not `candidate` or whose `mode` is not
  `agent-runner`.
- **Alternatives considered:** Admit any schema-8 result. A reference-baseline run has no runner,
  roles or cost, and would corrupt the identity and summary.
- **Decision-bearing:** no.

### `null` provider rows
- **Decision:** Group cost rows with a null `provider` under `unknown` in per-provider tokens. I
  observed these in published results: tester rows and Validator rows.
- **Alternatives considered:**
  - Drop those rows: per-provider totals would no longer add up to the total.
  - Infer the provider from the model: unreliable.
- **Decision-bearing:** no.

### Completeness sources
- **Decision:** A repetition's values count as complete as follows:
  - tokens: `cost.usage.complete`;
  - active time: a numeric `active_duration_ms`;
  - cost: `cost.total.complete` with a numeric `estimated_api_cost_usd`.

  An incomplete metric lists the run ids that lack it.
- **Alternatives considered:** Per-row completeness flags. `cost.usage.complete` already rolls
  them up.
- **Decision-bearing:** no.

### Statistics conventions
- **Decision:** Use the sample standard deviation (n − 1), and `null` for a single repetition.
  Per-provider statistics cover the union of providers, with zero for a complete repetition that
  lacks a provider.
- **Alternatives considered:** Population standard deviation, which understates spread for three
  repetitions.
- **Decision-bearing:** no.

### Infrastructure-failure definition
- **Decision:** A repetition is an infrastructure failure when `failure` is set and
  `product_failure` is null, as the issue says. It is also one when there is no product failure and
  the automated score is incomplete or non-numeric. Product failures need a complete automated
  score. Every published product failure has one.
- **Alternatives considered:** Gate on `evaluation_status`. The issue defines the rule by failure
  fields.
- **Decision-bearing:** no.

### `add-rep` does not write history
- **Decision:** `add-rep` amends `current` and does not replace it, so it appends nothing to
  `history`. Each repetition records when it was added and by which command. Git history keeps the
  earlier state.
- **Alternatives considered:** Snapshot `current` into `history` on every `add-rep`. This
  duplicates large entries, and the issue ties history to replacement.
- **Decision-bearing:** no.

### Identity and override details
- **Decision:**
  - The first directory given to `set` defines the identity.
  - `--allow-mismatch` records `mismatch` only on repetitions that actually differ.
  - Refusals list each differing field with both values.
  - Duplicate run ids are refused.
- **Alternatives considered:** Majority identity, which is ambiguous for two repetitions.
- **Decision-bearing:** no.

### Human review contents
- **Decision:** A complete review means `human_review.complete === true` and a numeric
  `official_score`, as the issue says. The recorded review keeps:
  - the reviewed run id and the official score;
  - the review total and possible points;
  - the human rubric identity;
  - the completion time;
  - `is_current_median`.
- **Alternatives considered:** Copy the full `human_review` block, including every response. It is
  large and not needed for comparison.
- **Decision-bearing:** no.

### `show` and usage behavior
- **Decision:**
  - `show` exits zero and says so when no baseline exists.
  - Every command accepts `--record <path>`.
  - Unknown commands or options are usage errors with a non-zero exit.
  - A corrupt record or one with an unsupported schema is refused, never overwritten.
- **Alternatives considered:** Make `show` exit non-zero when empty. An empty record is a valid
  state, not an error.
- **Decision-bearing:** no.

## design

### Pure core plus thin CLI
- **Decision:** `lib/experiment-baseline.mjs` holds the pure extraction, identity, admission,
  statistics, transitions and formatting. `experiments.mjs` owns the I/O, the exit codes and the
  atomic write.
- **Alternatives considered:** A single CLI module with inline I/O. Every rule would then need
  filesystem fixtures to test.
- **Decision-bearing:** no.

### Atomic write and temp-file cleanup
- **Decision:** Reuse `writeJsonAtomic`. The command captures the staged path through `onStage` and
  unlinks it if the write throws, so no temp file remains.
- **Alternatives considered:** Change `writeTextAtomic`'s error handling. That is a shared helper
  used by every controller checkpoint, so it is out of scope.
- **Decision-bearing:** no.

### Exit codes and error reporting
- **Decision:** Exit code 0 means success, `show` or `--help`. Exit code 1 means an admission
  refusal, with every refusal printed as one JSON line on stderr. Exit code 2 means a usage error,
  an invalid record, or an I/O error. `set` reports all refusals at once.
- **Alternatives considered:** A single exit code for every error. That cannot distinguish "rerun
  or override" from "broken invocation".
- **Decision-bearing:** no.

### Record and entry shapes
- **Decision:** The record has `schema_version: 1`. Repetition entries are grouped into these
  sub-objects:
  - `workflow`;
  - `roles`;
  - `rubrics`;
  - `automated_score`;
  - `gates`;
  - `outcome`;
  - `tokens`, with `by_provider`;
  - `cost`;
  - `failure`.

  `mismatch` is `null` when not waived. History entries are
  `{ kind, replaced_at, replacement_reason, record }`. The anchor adds `anchored_at` and
  `anchor_reason`.
- **Alternatives considered:**
  - Flat entries: harder to read in diffs.
  - Storing directory paths: machine-specific.
- **Decision-bearing:** no.

### Real-result regression test
- **Decision:** Exercise `extractRepetition` against the published
  `aab6fbe4-…-rep-1/result.json`, read only, alongside the synthetic builders. This catches
  field-path mistakes.
- **Alternatives considered:** Synthetic fixtures only. They would mirror any mapping mistake.
- **Decision-bearing:** no.

### No locking
- **Decision:** No lock file. There is a single maintainer, and the record is reviewed in git.
- **Alternatives considered:** An advisory lock file. It adds stale-lock handling for no realistic
  concurrency.
- **Decision-bearing:** no.

## test-plan

### Integration and E2E obligations
- **Decision:** Three automated obligations beyond the unit tests:
  - **INT-001:** field mapping against three real published results, read only.
  - **INT-002:** filesystem atomicity, all-or-nothing writes, and corrupt-record handling.
  - **E2E-001:** one operator journey through the executable CLI, as a child process with a temp
    `--record`.

  All three live in `test/experiment-baseline.test.mjs`, with no new suites or CI jobs.
- **Alternatives considered:**
  - Unit tests only: they miss field-path mistakes and entry-point wiring.
  - One E2E per command: duplicates the unit coverage.
- **Decision-bearing:** no.

### Acceptance envelope
- **Decision:** The acceptance pass is local and offline.
  - Records go only to temp paths through `--record`.
  - `results/**` may be read but never modified.
  - The committed `experiments/baseline.json`, paid evals, and the reference-baseline path are off
    limits.
  - Synthetic results and edited temp copies of published results are permitted substitutes. The
    agent-evals#67 repetitions are not yet in `results/`.
- **Alternatives considered:** Seed the real record during acceptance. Seeding is out of scope and
  a manual step after merge.
- **Decision-bearing:** no.

### Human-only testing
- **Decision:** None. Every behavior is observable by an agent through the CLI and the record file.
- **Decision-bearing:** no.

## approach-review

### AR-1 (high): unscored product failures have no defined behavior
- **Decision:** Applied, keeping them rather than refusing them.
- **Verification:** A conclusive product failure from verification or the candidate server
  serializes `automated_subtotal: null` (`lib/result.mjs`, `lib/outcomes.mjs`).
- **What is specified now:**
  - The repetition is admitted with `points: null`, never an invented number.
  - It ranks below every scored repetition for the median, with ties broken by run id.
  - It makes `automated_points` incomplete, listing its run id, under the existing no-subset rule.
  - If it lands at the median, `set` refuses with `median-not-reviewed`, since it cannot have an
    official score.
  - `show` prints `unscored`.
- **Tests:** unit tests for verification and candidate-server cases.
- **Alternatives considered:** The reviewer's preferred option was to refuse with
  `unscored-product-failure`. It is rejected because the issue says "A product failure … is kept,
  because it is real information". Refusing would let an operator drop the worst outcomes and bias
  the baseline upward.
- **Decision-bearing:** yes. It ranks unscored failures lowest and makes the automated summary
  incomplete when one is present. The issue did not foresee unscored failures, and this reading
  follows its "keep product failures" rule and the suite's "absence is not zero" convention. It
  does not contradict the issue, so it is not a stop.

### AR-2 (medium): a rescore and its original can both be counted
- **Decision:** Applied.
  - A repetition's lineage is its `run_id` plus its `rescored_from`.
  - `set` refuses inputs whose lineages overlap. `add-rep` refuses a repetition whose lineage
    overlaps any current repetition. Both use `duplicate-run`, name both run ids, and tell the
    operator to rebuild with `set` from the rescored directory only.
  - Spec scenarios cover both orders. E2E-001 adds a rescore refusal step, and unit tests cover
    both orders for `set` and `add-rep`.
- **Alternatives considered:** Automatically replace the original with its rescore during
  `add-rep`. That is implicit mutation of `current` the issue does not describe.
- **Decision-bearing:** no.

### AR-3 (medium): `anchor` can freeze a baseline whose median was never reviewed
- **Decision:** Applied. `anchor --from-current` is refused with `median-not-reviewed` when
  `current.human_review.is_current_median` is false. The message points to a fresh `set` that
  includes the new median's review. This follows the issue's decision 3, "every baseline requires a
  full human score on its median", and the anchor's role as the drift reference.
- **Tests:** a spec scenario, and step 5 of E2E-001, which anchors after divergence.
- **Alternatives considered:** Allow a divergent anchor and document what it means downstream. A
  drift reference with an unreviewed median undermines decision 3.
- **Decision-bearing:** no.

### AR-4 (medium): record validation is too shallow
- **Decision:** Applied.
  - `validateRecord` and `validateBaseline` now check every field and invariant a command reads or
    carries forward:
    - repetition shape and unique run ids;
    - `median_rep` and `human_review.run_id` naming existing repetitions;
    - the `is_current_median` boolean;
    - `source` values;
    - required strings;
    - anchor extras;
    - history entry shape.
  - Every command, including `show`, refuses an invalid record with exit code 2 before any
    transition, so a malformed `current` is never archived into history.
  - A spec scenario and INT-002 step 3 cover parseable but invalid records for `show` and `set`.
- **Alternatives considered:** Full per-entry schema validation of every metric field. That is
  heavy for tool-written data that git reviews, and the invariants above cover what the commands
  dereference.
- **Decision-bearing:** no.

## tasks

### One implementation task
- **Decision:** One task, `tasks/01-experiment-baseline-record.md`, covering:
  - the pure module;
  - the CLI;
  - the `check` script entries;
  - the README section;
  - all tests (unit, INT-001, INT-002, E2E-001).

  Acceptance, seeding from #67, and the evaluator and Validator provenance follow-up are listed in
  `tasks.md` as non-implementor work.
- **Alternatives considered:** Split the module and the CLI into separate tasks. The workflow asked
  for exactly one task, and the change is small and cohesive.
- **Decision-bearing:** no.

### Superseded spec-step note
- **Decision:** The spec-step entry "Product failures need a complete automated score" is
  superseded by AR-1. Unscored product failures are admitted with `null` points. The task file
  states that later review entries and the current spec take precedence.
- **Decision-bearing:** no. This records an earlier decision being replaced.
