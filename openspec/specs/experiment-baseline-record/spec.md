# experiment-baseline-record Specification

## Purpose
TBD - created by archiving change feature-58-f9c0fad6. Update Purpose after archive.
## Requirements
### Requirement: Experiment baseline record file
The and-scene suite SHALL keep the experiment baseline as one JSON record. By default the record
lives at `evals/agent-runner/and-scene/experiments/baseline.json`, resolved relative to the suite
directory, not the working directory. Every `baseline` command SHALL accept `--record <path>` to
use a different record file.

The record SHALL contain:
- `schema_version`;
- `current`: the baseline, or `null` when none is set;
- `anchor`: a frozen baseline, or `null` when none is set;
- `history[]`.

The experiment baseline SHALL be independent of the reference baseline. The commands SHALL NOT
read, write or change the reference baseline (`--reference-baseline`, `lib/baseline.mjs`, or the
`baseline` field in `result.json`).

#### Scenario: First set creates the record
- **WHEN** `baseline set` succeeds and no record file exists
- **THEN** the record file is created with a supported `schema_version`, the new `current`, a
  `null` `anchor`, and an empty `history`

#### Scenario: Record path override
- **WHEN** a `baseline` command is run with `--record <path>`
- **THEN** it reads and writes only the record at `<path>`, and the default record is left
  untouched

Before any command reads or changes it, an existing record SHALL be validated against the
structure and invariants the commands rely on:
- `current` and `anchor` are each `null` or a baseline object. A baseline object has:
  - a non-empty `reps` array of objects, each with a string `run_id` and a string or null
    `execution_run_id`;
  - unique run ids;
  - an `identity` object and a `summary` object. The summary has numeric `repetitions`, and
    `automated_points`, `tokens_total`, `tokens_by_provider`, `active_duration_ms`, and
    `estimated_cost_usd` objects, each with a boolean `complete`;
  - a `median_rep` naming one of its repetitions;
  - a `human_review` object whose `run_id` names one of its repetitions, with a boolean
    `is_current_median` equal to whether its `run_id` is `median_rep`;
  - a `source` that is one of the three allowed values;
  - string `reason` and `set_at`.
- An `anchor` also has string `anchored_at` and `anchor_reason`.
- Every `history` entry has a `kind` of `current` or `anchor`, string `replaced_at` and
  `replacement_reason`, and a baseline object as `record`.

A record that fails validation SHALL be refused by every command, including `show`.

#### Scenario: Unreadable or unsupported record is refused
- **WHEN** the record file exists but is not valid JSON or has an unsupported `schema_version`
- **THEN** the command exits non-zero, names the problem, and does not modify the file

#### Scenario: Structurally invalid record is refused
- **WHEN** the record is valid JSON with a supported `schema_version`, but `current` is `{}`, or
  its `median_rep` names a run id that is not in `current.reps`
- **THEN** `show`, `set`, `add-rep` and `anchor` each exit non-zero, naming the invalid field, and
  the file is unchanged

#### Scenario: Inconsistent review or summary is refused
- **WHEN** a stored record marks a reviewed repetition as the current median when it is not, or
  omits a required summary metric
- **THEN** `show` and `set` refuse it as an invalid record without modifying the file

### Requirement: Atomic, reviewable, all-or-nothing writes
A command that changes the record SHALL write it atomically: a temporary file in the same
directory, then a rename over the record. The record SHALL be pretty-printed JSON with two-space
indentation and a trailing newline.

A command SHALL either apply all of its changes or none of them. If any input is refused, or any
error occurs before the rename, the existing record SHALL be left byte-for-byte unchanged and no
temporary file SHALL remain. `show` SHALL never write the record.

#### Scenario: Refusal leaves the record unchanged
- **WHEN** `baseline set` is given three result directories and one of them is refused
- **THEN** the command exits non-zero, reports each refused repetition with its reason, and the
  record file is unchanged

#### Scenario: Successful write is pretty-printed
- **WHEN** a record-changing command succeeds
- **THEN** the record file is indented JSON ending in a newline, so its git diff shows only the
  changed fields

#### Scenario: Show is read-only
- **WHEN** `baseline show` runs
- **THEN** the record file's bytes and modification time are unchanged

### Requirement: Published result directory input
`set` and `add-rep` SHALL take result directories, as the agent factory saves them under
`evals/agent-runner/and-scene/results/<run_id>/`, and read each directory's `result.json`.

A directory SHALL be refused when:
- it has no readable `result.json`;
- its `result.json` is not valid JSON;
- its `schema_version` is not supported. Version 8 is the only supported version;
- it is not an Agent Runner candidate run (`run_kind` other than `candidate`, or `mode` other than
  `agent-runner`). Reference-baseline runs cannot join an experiment baseline.

A refusal SHALL name the directory and the reason. Directories SHALL be read only and never
modified.

#### Scenario: Missing result.json is refused
- **WHEN** `baseline add-rep` is given a directory without a `result.json`
- **THEN** the command exits non-zero naming that directory, and the record is unchanged

#### Scenario: Unsupported schema version is refused
- **WHEN** a result directory's `result.json` has `schema_version` 7
- **THEN** it is refused with a message naming the unsupported version and the supported version
  8

#### Scenario: Reference run is refused
- **WHEN** a result directory holds a reference-baseline run (`run_kind` `reference`)
- **THEN** it is refused as not being an Agent Runner candidate run

### Requirement: Repetition entry contents
Each admitted repetition SHALL be stored as a self-contained entry copied from its `result.json`.
It SHALL NOT be a reference that must be re-read later. Each entry SHALL record:

- **Run id:** `run_id`.
- **Runner commit:** `workflow.provenance.commit`.
- **Skills commit:** `workflow.agent_skills_provenance.commit`.
- **Workflow:** `workflow.workflow`, `workflow.workflow_path`, `workflow.task_level_compliance`,
  `workflow.final_validator` and `workflow.skip_validator`, as recorded.
- **Fixture commit:** `candidate_source.fixture_commit`.
- **Role profiles:** for each role in `role_configuration.roles`:
  - the configured `cli`, `model`, `effort` and `agent`;
  - the distinct models observed in that role's `attempts[].observed`.
- **Rubrics:** `rubrics.automated` and `rubrics.human`, each as `rubric_id`, `version` and
  `sha256`.
- **Automated score:** `automated_subtotal.points`, `.possible` and `.complete`.
- **Gates:** `score.gates_passed`, and `id` and `verdict` for each of `score.gates[]`.
- **Outcome and review state:** `evaluation_status`, `product_verdict`, `official_score`, and
  whether `human_review` is complete.
- **Tokens:** `cost.usage.token_totals` and `cost.usage.tokens`, with `cost.usage.complete`.
  Per-provider token totals are computed by summing `cost.rows[].token_totals` grouped by
  `provider`. Rows whose `provider` is null are grouped under `unknown`.
- **Active time:** `implementation_metrics.active_duration_ms`.
- **Cost:** `cost.total.state`, `.complete`, `.estimated_api_cost_usd` and
  `.known_cost_subtotal_usd`.
- **Failure:** `failure`, `failed_phase` and `product_failure`.
- **Admission:** the time it was added, and the command that added it (`set` or `add-rep`).

A value missing from `result.json` SHALL be stored as `null`. It SHALL NOT be filled with a
default.

#### Scenario: Entry copies the mapped values
- **WHEN** a schema-8 result is admitted
- **THEN** its entry holds the run id, runner and skills commits, workflow settings, fixture
  commit, role profiles with observed models, rubric identities, automated score, gate verdicts,
  tokens, active time, cost and failure fields with the values found in that `result.json`

#### Scenario: Per-provider tokens include unattributed rows
- **WHEN** a result's `cost.rows[]` holds two `openai` rows, one `anthropic` row, and one row with
  a null provider
- **THEN** the entry's per-provider tokens hold the summed `openai` totals, the `anthropic` totals,
  and an `unknown` bucket for the null-provider row

#### Scenario: Missing active time stays missing
- **WHEN** a result's `implementation_metrics.active_duration_ms` is null
- **THEN** the entry's active time is `null`, not zero

### Requirement: Rescored repetitions
A repetition whose automated score was corrected by a rescore SHALL be admitted from its rescored
result directory, and its values SHALL be read from that rescored `result.json`.

When the result's `workflow.events` contains an `imported-completed-run` event, the entry SHALL
record that event's `source_run_id` as `rescored_from`. Otherwise `rescored_from` SHALL be `null`.
The entry SHALL record `workflow.run_id` as `execution_run_id`, or `null` when absent.
The commands SHALL NOT search for rescores of a given directory.

#### Scenario: Rescored result links to its source
- **WHEN** a rescored result directory is admitted, and its `workflow.events` names
  `source_run_id` `abc-rep-2`
- **THEN** the entry uses the rescored result's run id and scores, and records `rescored_from`
  `abc-rep-2`

#### Scenario: Execution run id is retained
- **WHEN** a result has `workflow.run_id` `execution-1`
- **THEN** its stored repetition has `execution_run_id` `execution-1`

### Requirement: One runner commit per baseline
Every repetition in `current` SHALL have the same runner commit. `set` and `add-rep` SHALL refuse
a repetition whose runner commit differs from the baseline's, even when `--allow-mismatch` is
given. A repetition whose runner commit is missing SHALL also be refused.

#### Scenario: Different runner commit is refused even with override
- **WHEN** `baseline add-rep` is given a repetition from a later runner commit, with
  `--allow-mismatch "drift check"`
- **THEN** the command exits non-zero, explaining that a different runner commit can never join
  the baseline, and the record is unchanged

#### Scenario: Set with mixed runner commits is refused
- **WHEN** `baseline set` is given two repetitions with different runner commits
- **THEN** the command exits non-zero and the record is unchanged

### Requirement: Identity mismatch rule
The baseline's shared identity SHALL consist of:
- the runner commit;
- the skills commit;
- the workflow (`workflow`, `workflow_path`, `task_level_compliance`, `final_validator`,
  `skip_validator`);
- the fixture commit;
- each role's configured `cli`, `model`, `effort` and `agent`;
- the automated and human rubric `rubric_id`, `version` and `sha256`.

Observed models SHALL NOT be part of the identity.

For `set`, the first result directory given SHALL define the identity, and every other repetition
SHALL be compared against it. For `add-rep`, the repetition SHALL be compared against the stored
`current` identity.

A repetition that differs in any identity field other than the runner commit SHALL be refused
unless `--allow-mismatch <reason>` is given. When the override admits a differing repetition:
- the repetition's entry SHALL record `mismatch` with the differing field names and the reason;
- the baseline's shared identity SHALL remain the defining identity.

A matching repetition SHALL record no `mismatch`, even when `--allow-mismatch` is given. The
refusal message SHALL list each differing field with the baseline's value and the repetition's
value.

#### Scenario: Differing role profile is refused
- **WHEN** `baseline add-rep` is given a repetition whose implementor model differs from the
  baseline's
- **THEN** the command exits non-zero, naming the implementor model field and both values

#### Scenario: Override admits and records the mismatch
- **WHEN** the same repetition is added with `--allow-mismatch "provider renamed model alias"`
- **THEN** it is admitted, its entry records `mismatch` naming the implementor model field and the
  reason, and `current`'s shared identity is unchanged

#### Scenario: Different observed model is not a mismatch
- **WHEN** a repetition matches the configured profiles but observed a different model in one
  attempt
- **THEN** it is admitted without `mismatch`, and the observed model is recorded on its entry

#### Scenario: Different rubric hash is a mismatch
- **WHEN** a repetition's automated rubric `sha256` differs from the baseline's
- **THEN** it is refused unless `--allow-mismatch` is given

### Requirement: Failed repetition rule
`set` and `add-rep` SHALL refuse an infrastructure-failed repetition, and the refusal message SHALL
say that it must be rerun. A repetition counts as infrastructure-failed when:
- `failure` is non-null and `product_failure` is null; or
- `product_failure` is null and `automated_subtotal.complete` is not `true` or
  `automated_subtotal.points` is not a number.

A repetition with a non-null `product_failure` SHALL be admitted, together with its failure
fields. Examples are a failed required gate and a score below the automated threshold.

This includes an **unscored product failure**: a conclusive product failure from verification or
the candidate server, before automated scoring. Such a result has `automated_subtotal` null or
incomplete. It SHALL be admitted with its automated points stored as `null`, never as an invented
number. The median and summary requirements define how it is ranked and summarized.

#### Scenario: Infrastructure failure is refused
- **WHEN** a result has `failure` set, for example a harness or usage-limit failure, and
  `product_failure` null
- **THEN** the repetition is refused with a message that it is an infrastructure failure to rerun

#### Scenario: Product failure is kept
- **WHEN** a result has `product_failure` set for a failed required gate, and a complete automated
  score
- **THEN** the repetition is admitted, and its entry records the failure, the gate verdicts and the
  automated score

#### Scenario: Unscored product failure is kept
- **WHEN** a result has `product_failure` set from the verification phase, and `automated_subtotal`
  null
- **THEN** the repetition is admitted with `product_failure` recorded and automated points `null`

#### Scenario: Incomplete automated score is refused
- **WHEN** a result has no product failure and `automated_subtotal.complete` is false
- **THEN** the repetition is refused as an infrastructure failure

### Requirement: Duplicate repetitions are refused
Each execution SHALL be counted at most once in `current.reps`. A repetition's lineage includes
its run id, its `rescored_from` when present, and its Agent Runner execution run id from
`workflow.run_id`. Two repetitions overlap when their run ids or `rescored_from` values overlap,
or when both have the same non-null execution run id. `--allow-mismatch` SHALL NOT waive overlap.

`set` SHALL refuse input directories whose lineages overlap. `add-rep` SHALL refuse a repetition
whose lineage overlaps any repetition already in `current`. The refusal SHALL name both run ids.
When a rescore is involved, it SHALL tell the operator to rebuild the baseline with `set`, using
only the corrected (rescored) directory.

#### Scenario: Re-adding a repetition is refused
- **WHEN** `baseline add-rep` is given a repetition already in `current`
- **THEN** the command exits non-zero naming the duplicate run id, and the record is unchanged

#### Scenario: Original and its rescore are refused together
- **WHEN** `baseline set` is given an original repetition and the rescore of that repetition, in
  either order
- **THEN** the command exits non-zero, naming both run ids and directing the operator to use only
  the rescored directory, and the record is unchanged

#### Scenario: Adding a rescore of a current repetition is refused
- **WHEN** `baseline add-rep` is given a rescore whose `rescored_from` is a run id in `current`
- **THEN** the command exits non-zero and directs the operator to rebuild with `set`, and the
  record is unchanged

#### Scenario: Adding an original whose rescore is current is refused
- **WHEN** `baseline add-rep` is given an original repetition whose run id is the `rescored_from`
  of a repetition in `current`
- **THEN** the command exits non-zero naming both run ids, and the record is unchanged

#### Scenario: Two-hop rescore overlaps the original execution
- **WHEN** original O and R2, a rescore of R1 which is itself a rescore of O, have the same
  `workflow.run_id`
- **THEN** `set` and `add-rep` refuse counting O with R2 as duplicate executions, including
  with `--allow-mismatch`

### Requirement: Median repetition
`current.median_rep` SHALL be the run id of the repetition with the median automated score
(`automated_subtotal.points`). To find it, order the repetitions by ascending points, breaking ties
by ascending run id. The median is the repetition at zero-based position `floor((n - 1) / 2)`.
With an even count, that is the lower of the two middle repetitions. An unscored product failure,
with automated points `null`, SHALL rank below every scored repetition, because it could not be
built or served. Unscored repetitions are ordered among themselves by run id. `set` and `add-rep`
SHALL recompute the median from all current repetitions.

#### Scenario: Odd count picks the middle score
- **WHEN** a baseline has repetitions scoring 49.81, 56.29 and 56.81
- **THEN** `median_rep` is the run id of the repetition scoring 56.29

#### Scenario: Even count picks the lower middle
- **WHEN** a baseline has repetitions scoring 50, 52, 54 and 56
- **THEN** `median_rep` is the run id of the repetition scoring 52

#### Scenario: Unscored product failure ranks lowest
- **WHEN** a baseline has an unscored product failure and repetitions scoring 50 and 55
- **THEN** `median_rep` is the run id of the repetition scoring 50

#### Scenario: Tie broken by run id
- **WHEN** two repetitions in the median position have equal scores
- **THEN** the one with the lexicographically smaller run id is chosen

### Requirement: Summary statistics
`current.summary` SHALL report the count of repetitions. For each of the following metrics, it
SHALL report the mean, minimum, maximum and sample standard deviation (n − 1):
- automated score points;
- total tokens;
- total tokens per provider;
- active time in milliseconds;
- estimated cost in USD.

With one repetition, the standard deviation SHALL be `null`.

A metric SHALL be summarized only when every repetition has a complete value for it:
- automated score points require numeric points, so an unscored product failure makes this metric
  incomplete;
- tokens, including per-provider tokens, require `cost.usage.complete` to be `true`;
- active time requires a numeric `active_duration_ms`;
- cost requires `cost.total.complete` to be `true`, with a numeric `estimated_api_cost_usd`.

Otherwise the metric SHALL be reported as incomplete, listing the run ids that lack a complete
value, with no statistics computed over a subset.

Per-provider statistics SHALL cover every provider that appears in any repetition. A complete
repetition with no row for a provider contributes zero tokens for it. `set` and `add-rep` SHALL
recompute the summary.

#### Scenario: Complete metrics are summarized
- **WHEN** three repetitions all have complete tokens, active time and cost
- **THEN** the summary reports the mean, min, max and sample standard deviation for each metric,
  and for each provider's tokens

#### Scenario: Incomplete cost is not averaged over a subset
- **WHEN** two of three repetitions have complete cost and one has `cost.total.complete` false
- **THEN** the cost summary is reported as incomplete, naming the incomplete repetition, and has
  no mean, min, max or standard deviation

#### Scenario: Unscored product failure makes the automated summary incomplete
- **WHEN** one of three repetitions is an unscored product failure
- **THEN** the automated score summary is reported as incomplete, naming that repetition, and the
  repetition count is still three

#### Scenario: Single repetition has no spread
- **WHEN** a baseline has one repetition
- **THEN** each summarized metric's mean, min and max equal that repetition's value, and its
  standard deviation is `null`

### Requirement: Set replaces the current baseline
`baseline set <result-dir>... --source <accepted-candidate|profile-change|manual> --reason <text>
[--allow-mismatch <reason>]` SHALL build a new `current` from the given repetitions and the
admission rules above. The new `current` SHALL record:
- `reps`;
- `identity`;
- `summary`;
- `median_rep`;
- `human_review`;
- `source`;
- `reason`;
- `set_at`.

`--source` and a non-empty `--reason` SHALL be required, and at least one result directory SHALL
be given.

When a previous `current` exists, it SHALL be appended to `history` as a `current` entry, together
with the replacement time and the new reason. When `--source` is `profile-change` and an `anchor`
exists, that anchor SHALL also be appended to `history` as an `anchor` entry, and `anchor` SHALL be
set to `null`. Other sources SHALL leave `anchor` unchanged.

#### Scenario: Set replaces current and keeps history
- **WHEN** `baseline set` succeeds with `--source accepted-candidate` while a `current` exists
- **THEN** the old `current` is appended to `history` with the replacement time and reason, the
  new `current` holds the given repetitions, and `anchor` is unchanged

#### Scenario: Profile change clears the anchor
- **WHEN** `baseline set --source profile-change` succeeds while an `anchor` exists
- **THEN** the old `current` and the old `anchor` are both appended to `history`, and `anchor` is
  `null`

#### Scenario: Invalid source is refused
- **WHEN** `baseline set` is run with `--source experiment` or without `--reason`
- **THEN** it exits non-zero with a usage error, and the record is unchanged

### Requirement: Human review required for every baseline
`set` SHALL refuse unless the median repetition of the new baseline has a complete human review:
`human_review.complete` must be `true` and `official_score` must be a number. There SHALL be no
override.

For a rescore lacking a complete review and numeric official score, `set` and `add-rep` SHALL
follow its `rescored_from` chain through sibling published result directories to the first
ancestor with a complete human review and numeric official score. When its human rubric sha256
matches the rescore's, the repetition SHALL carry that review and identify the ancestor run id.
Its official score SHALL be the rescored automated points plus the ancestor's awarded human
points. The baseline human-review snapshot and `show` SHALL identify the review source. Missing
or unreadable ancestors, cycles, or a different human rubric SHALL leave the repetition
unreviewed; a median without a usable review SHALL still be refused.

`current.human_review` SHALL record:
- the reviewed repetition's run id and `official_score`;
- the human-review score total and possible points;
- the human rubric identity;
- the completion time.

It SHALL also record `is_current_median`, which `set` sets to `true`.

#### Scenario: Unreviewed median is refused
- **WHEN** `baseline set` is given three repetitions whose median is `pending-human-review`
- **THEN** the command exits non-zero, naming the median run id and stating that a complete human
  review is required, and the record is unchanged

#### Scenario: Reviewed median is recorded
- **WHEN** `baseline set` is given three repetitions whose median has a complete human review,
  and the other two are unreviewed
- **THEN** the baseline is set, and `current.human_review` holds the median's run id, official
  score and review score, with `is_current_median` `true`

#### Scenario: Rescored median carries an existing review
- **WHEN** a median rescore has no review and its source has a complete review under the same
  human rubric
- **THEN** `set` records the source run id, uses its awarded human points, and recomputes the
  official score with the rescored automated points

#### Scenario: Unreviewed rescore lineage is refused
- **WHEN** neither a median rescore nor its ancestors have a compatible complete review
- **THEN** `set` refuses it as `median-not-reviewed` and explains why carry-over did not apply

#### Scenario: A second rescore carries its reviewed ancestor
- **WHEN** R2 is a rescore of unreviewed R1, which is a rescore of reviewed O
- **THEN** R2 carries O's review and records O as its review source

### Requirement: Add a control repetition
`baseline add-rep <result-dir> [--allow-mismatch <reason>]` SHALL append one repetition to
`current.reps`, applying the input, runner-commit, mismatch, failed-repetition and duplicate rules.
It SHALL then recompute `summary` and `median_rep`.

`add-rep` SHALL keep the recorded `human_review` and its run id. It SHALL set
`human_review.is_current_median` to whether the recomputed `median_rep` equals the reviewed run id.
`add-rep` SHALL NOT append to `history`, and SHALL NOT change `source`, `reason`, `set_at`,
`identity` or `anchor`. It SHALL be refused when no `current` exists.

#### Scenario: Added repetition updates summary and median
- **WHEN** `baseline add-rep` admits a fourth repetition
- **THEN** `current.reps` has four entries, and `summary` and `median_rep` reflect all four

#### Scenario: Median moves away from the reviewed repetition
- **WHEN** an added repetition changes `median_rep` to a repetition other than the reviewed one
- **THEN** `current.human_review` still names the originally reviewed run id and score, and
  `is_current_median` is `false`

#### Scenario: No current baseline
- **WHEN** `baseline add-rep` runs and the record has no `current`
- **THEN** it exits non-zero, stating that a baseline must be set first

### Requirement: Anchor from current
`baseline anchor --from-current --reason <text>` SHALL copy `current` into `anchor`. The anchor has
the same shape as `current`, plus `anchored_at` and the anchor reason. When an `anchor` already
exists, it SHALL first be appended to `history` as an `anchor` entry, together with the
replacement time and the new reason.

The command SHALL be refused:
- without `--from-current`;
- without a non-empty `--reason`;
- when no `current` exists;
- when `current.human_review.is_current_median` is `false`. Every anchor must have a reviewed
  median. The refusal SHALL say that a fresh `set`, including a review of the new median, is
  needed first.

A later change to `current` SHALL NOT change the `anchor`.

#### Scenario: First anchor
- **WHEN** `baseline anchor --from-current --reason "first baseline"` runs with a `current` and no
  `anchor`
- **THEN** `anchor` becomes a copy of `current` with the anchor time and reason, and `history` is
  unchanged

#### Scenario: Replacing an anchor
- **WHEN** the command runs while an `anchor` exists
- **THEN** the old anchor is appended to `history` with the replacement time and reason, before the
  new anchor is written

#### Scenario: Anchor refused after median divergence
- **WHEN** `baseline anchor --from-current --reason "drift anchor"` runs after an `add-rep` moved
  the median away from the reviewed repetition
- **THEN** the command exits non-zero, naming both run ids and stating that a fresh `set` with the
  new median's review is required, and the record is unchanged

#### Scenario: Anchor is frozen
- **WHEN** `baseline add-rep` succeeds after an anchor was set
- **THEN** `anchor` is unchanged

### Requirement: Show the baseline
For a valid record, `baseline show` SHALL print a short human-readable summary of the record
and exit zero. When `current` exists, the summary SHALL include:
- its source, reason and set time;
- each repetition's run id, automated score (`unscored` for an unscored product failure),
  product verdict or failure, active time and cost;
- each repetition's mismatch reason and `rescored_from`, when present;
- the mean, min, max and standard deviation of each summarized metric, or "incomplete" with the
  repetitions that lack it;
- the median repetition;
- the human-reviewed repetition and its official score, with a note when it is not the current
  median repetition.

It SHALL then show the anchor status: absent, or the anchor time, reason, repetition count and mean
automated score (or "incomplete"). When the record or its `current` does not exist, `show` SHALL say that no
experiment baseline is set and exit zero.

#### Scenario: Show reports the baseline
- **WHEN** `baseline show` runs with a `current` and an `anchor`
- **THEN** it prints the repetitions, means and spreads, median repetition, human-reviewed
  repetition, and anchor status

#### Scenario: Show flags review divergence
- **WHEN** `current.human_review.is_current_median` is `false`
- **THEN** `show` states that the current median repetition is not the human-reviewed one, and
  names both run ids

#### Scenario: Show with no baseline
- **WHEN** `baseline show` runs and no record exists
- **THEN** it prints that no experiment baseline is set, and exits zero

### Requirement: Command-line usage errors
`experiments.mjs` SHALL accept `baseline <set|add-rep|anchor|show>`. An unknown command, an
unknown option, or a missing required argument SHALL produce a usage message and a non-zero exit
without changing the record. `--help` SHALL print usage for the `baseline` commands.

#### Scenario: Unknown subcommand
- **WHEN** `experiments.mjs baseline promote` runs
- **THEN** it exits non-zero with a usage message, and the record is unchanged
