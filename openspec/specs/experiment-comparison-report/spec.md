# experiment-comparison-report Specification

## Purpose
TBD - created by archiving change feature-69-28c11039. Update Purpose after archive.
## Requirements
### Requirement: Compare command
The and-scene suite SHALL provide
`experiments.mjs compare --eval-issue <owner/repo#N> <result-dir>... [--json] [--record <path>] [--baseline-results <dir>]`.

- `--eval-issue` is required and SHALL have the form `<owner>/<repo>#<positive integer>`.
- Each positional argument is a candidate result directory.
- `--record` selects the experiment baseline record; it defaults to the same record the `baseline`
  commands use (`evals/agent-runner/and-scene/experiments/baseline.json`, resolved relative to the
  suite directory).
- `--baseline-results` selects where the baseline repetitions' published result directories are
  read from; it defaults to `evals/agent-runner/and-scene/results/`, resolved relative to the suite
  directory.

The command SHALL be read-only: it SHALL NOT write or change the record, any result directory, or the
eval issue. A malformed option, a missing `--eval-issue`, a duplicated option, or an unknown option
SHALL produce a usage message and exit 2.

#### Scenario: Missing eval issue
- **WHEN** `experiments.mjs compare` runs with result directories but no `--eval-issue`
- **THEN** it prints a usage message and exits 2

#### Scenario: Malformed eval issue reference
- **WHEN** `--eval-issue` is `Codagent-AI/agent-evals-58`
- **THEN** it prints a usage message naming the expected `<owner/repo#N>` form and exits 2

#### Scenario: Comparison writes nothing
- **WHEN** a comparison completes or is refused
- **THEN** the record file and every result directory are byte-for-byte unchanged

### Requirement: Refusals
When the comparison cannot be trusted, the command SHALL refuse instead of printing a partial
comparison. A refusal SHALL exit 1 and SHALL report every refusal found, not only the first. Each
refusal SHALL carry a stable code, a message, and the directory or run id it concerns when there is
one. Each refusal SHALL be written to stderr as one JSON line. Stdout SHALL carry a short refusal
summary listing the reasons: Markdown by default, or, with `--json`, a JSON object whose `status` is
`refused` and whose `refusals` array lists them.

Unreadable inputs that are not refusals of the evidence (an I/O error other than a missing file) SHALL
exit 2.

#### Scenario: Several refusals are reported together
- **WHEN** one candidate directory has no `result.json` and another candidate has an infrastructure
  failure
- **THEN** the command exits 1 and reports both refusals, each naming its directory

#### Scenario: JSON refusal
- **WHEN** the comparison is refused and `--json` is given
- **THEN** stdout is a JSON object with `status` `refused` and a non-empty `refusals` array

### Requirement: Baseline side
The baseline side SHALL be the record's `current` baseline and its repetitions as recorded. The
command SHALL refuse with `no-current` when the record has no `current` baseline or does not exist,
and with `invalid-record` when the record fails the experiment baseline record validation.

#### Scenario: No baseline is set
- **WHEN** `compare` runs and the record has `current` `null`
- **THEN** it refuses with `no-current`

#### Scenario: Anchor is ignored
- **WHEN** the record has both a `current` and an `anchor`
- **THEN** the comparison uses only `current`

### Requirement: Candidate repetition admission
Candidate result directories SHALL be read the same way `baseline set` reads them: the same
directory refusals (missing or invalid `result.json`, unsupported `schema_version`, not an Agent
Runner candidate run), the same infrastructure-failure rule (refuse when `failure` is set and
`product_failure` is null, or when there is no product failure and the automated score is
incomplete), and the same rescore handling (a rescored repetition is read from its rescored result,
including a human review carried from its source). Product failures SHALL be kept.

The command SHALL refuse with `lineage-overlap` when two admitted candidate repetitions, or a
candidate repetition and a baseline repetition, share a lineage: equal `run_id`, either one's
`rescored_from` equal to the other's `run_id` or `rescored_from`, or equal non-null
`execution_run_id`.

After these rules, the command SHALL refuse with `too-few-repetitions` when fewer than **2**
candidate repetitions remain.

#### Scenario: One repetition is refused
- **WHEN** `compare` is given one candidate result directory
- **THEN** it refuses with `too-few-repetitions`

#### Scenario: Infrastructure failure is refused
- **WHEN** a candidate result has `failure` set and `product_failure` null
- **THEN** it is refused with `infrastructure-failure` naming that directory

#### Scenario: Product failure is kept
- **WHEN** a candidate result has a `product_failure` from a failed hard gate and a complete
  automated score
- **THEN** it is admitted and counted as a candidate repetition

#### Scenario: Same directory twice
- **WHEN** the same candidate result directory is passed twice
- **THEN** the command refuses with `lineage-overlap` rather than counting two repetitions

#### Scenario: Original and its rescore
- **WHEN** a candidate result and its rescore are both passed
- **THEN** the command refuses with `lineage-overlap`

#### Scenario: Candidate overlaps the baseline
- **WHEN** a candidate repetition's `execution_run_id` equals a baseline repetition's
- **THEN** the command refuses with `lineage-overlap` naming both run ids

### Requirement: Cohort integrity
All candidate repetitions SHALL share one recorded identity: runner commit, skills commit, workflow
settings (`workflow`, `workflow_path`, `task_level_compliance`, `final_validator`,
`skip_validator`), each role's configured profile (`cli`, `model`, `effort`, `agent`), fixture
commit, and both rubrics. Otherwise the command SHALL refuse with `candidate-identity-mismatch`,
naming the differing fields.

The command SHALL refuse with `not-comparable` when, for **any** baseline repetition and **any**
candidate repetition, the automated or human rubric (`rubric_id`, `version`, or `sha256`) or the
fixture commit differs, or when any of those values is missing on either side. The refusal SHALL name
the field and both values.

Baseline repetitions that differ from each other in other fields (admitted through
`--allow-mismatch`) SHALL NOT cause a refusal. The report SHALL list each such repetition, the
differing fields, and its recorded mismatch reason.

#### Scenario: Candidates from different runner commits
- **WHEN** two candidate repetitions record different runner commits
- **THEN** the command refuses with `candidate-identity-mismatch` naming `runner_commit`

#### Scenario: Automated rubric version differs
- **WHEN** the candidate's automated rubric version differs from the baseline's
- **THEN** the command refuses with `not-comparable` naming `rubrics.automated.version` and both
  values

#### Scenario: Mismatched baseline repetition under another fixture
- **WHEN** the baseline's first repetition matches the candidate's fixture commit but a later
  baseline repetition, admitted with `--allow-mismatch`, has a different fixture commit
- **THEN** the command refuses with `not-comparable`

#### Scenario: Baseline repetition with a waived profile difference
- **WHEN** one baseline repetition was admitted with `--allow-mismatch` for a different tester
  model, and rubrics and fixture match the candidate everywhere
- **THEN** the comparison proceeds and the report lists that repetition, `roles.tester.configured.model`,
  and its mismatch reason

### Requirement: Eval request reading
The command SHALL read the body of the issue named by `--eval-issue` from GitHub. The body SHALL
contain exactly one fenced block opened by ```` ```eval ```` (optionally followed by spaces or tabs)
on its own line and closed by ```` ``` ````. The block SHALL be parsed as TOML limited to top-level
`key = value` lines, blank lines and `#` comments, where a value is a basic or literal string, `true`
or `false`, or a decimal integer. Any other TOML construct SHALL be treated as invalid.

The accepted keys SHALL be the ones the agent factory accepts: `agent_runner_ref`,
`agent_skills_ref`, `fixture_ref`, `lead`, `crosscheck`, `implementor`, `tester`,
`skip_validator`, `repetitions`. Values SHALL be validated as the factory does: refs are non-empty
strings; role profiles are strings of three non-empty `:`-separated parts (`cli:model:effort`);
`skip_validator` is a boolean; `repetitions` is a positive integer.

The command SHALL refuse, rather than guess, with:
- `eval-issue-unreadable` when the issue cannot be fetched;
- `eval-block-missing` when there is no eval block, or `eval-block-ambiguous` when there is more than
  one;
- `eval-block-invalid` when the block is not valid in the subset above, repeats a key, uses an
  unsupported key, or has a value of the wrong type.

#### Scenario: Valid request
- **WHEN** the issue body has one eval block setting `agent_runner_ref = "feature-x"` and
  `lead = "codex:gpt-5.6-sol:high"`
- **THEN** the request is read with those two settings and every other key unset

#### Scenario: Two eval blocks
- **WHEN** the issue body contains two ```` ```eval ```` blocks
- **THEN** the command refuses with `eval-block-ambiguous`

#### Scenario: Unsupported key
- **WHEN** the eval block sets `agent_validator_ref`
- **THEN** the command refuses with `eval-block-invalid` naming the key

#### Scenario: Table header
- **WHEN** the eval block contains a `[roles]` table header
- **THEN** the command refuses with `eval-block-invalid`

#### Scenario: Issue cannot be read
- **WHEN** fetching the eval issue fails
- **THEN** the command refuses with `eval-issue-unreadable`

### Requirement: Request matches the results
For every role profile the request sets, the candidate repetitions' configured `cli`, `model` and
`effort` for that role SHALL equal the requested profile's three parts. When the request sets
`skip_validator`, the candidates' recorded `workflow.skip_validator` SHALL equal it. Otherwise the
command SHALL refuse with `request-results-mismatch`, naming the setting, the requested value and the
recorded value.

#### Scenario: Issue edited after the eval ran
- **WHEN** the request sets `implementor = "claude:opus:high"` but the candidates recorded
  implementor `codex:gpt-5.6-terra:high`
- **THEN** the command refuses with `request-results-mismatch` naming `implementor`

### Requirement: Primary differences
The report SHALL list as **primary** the differences the eval request put under test:

- For each of `agent_runner_ref` (repository `Codagent-AI/agent-runner`) and `agent_skills_ref`
  (repository `Codagent-AI/agent-skills`) that the request sets: the commits reachable from the
  candidates' recorded commit (runner commit or skills commit) and not from `main`, from the GitHub
  compare of `main...<recorded commit>`. The recorded commit SHALL be used, never the requested ref.
  Each listed commit SHALL show its short SHA and the first line of its message. At most 20 commits
  SHALL be listed per repository, followed by the count of the rest.
- Each role profile (`lead`, `crosscheck`, `implementor`, `tester`) and `skip_validator` that the
  request sets and whose value differs from the baseline's, with both values.

When the compare shows no commits ahead of `main`, the report SHALL say that no commits on the
recorded commit are missing from `main` as resolved; when the requested ref is not `main`, it SHALL
add that the branch may have merged since the eval ran, so its commits can no longer be recovered
from `main`. It SHALL NOT present this as "no changes under test" without that qualification.

A requested setting whose value equals the baseline's SHALL NOT be listed as a difference.

If a needed GitHub compare fails, the command SHALL refuse with `github-compare-failed`, naming the
repository and the compared range.

#### Scenario: Runner branch under test
- **WHEN** the request sets `agent_runner_ref = "feature-x"` and the candidates' recorded runner
  commit is 3 commits ahead of `main`
- **THEN** the primary differences list those 3 commits for `Codagent-AI/agent-runner`, computed from
  the recorded commit

#### Scenario: Branch merged since the eval
- **WHEN** the request sets `agent_skills_ref = "feature-y"` and the recorded skills commit is
  already reachable from `main`
- **THEN** the report says no recorded-commit commits are missing from `main` and that the branch may
  have merged since the eval ran

#### Scenario: Requested profile differs from the baseline
- **WHEN** the request sets `tester` and the candidates' tester profile differs from the baseline's
- **THEN** `tester` is a primary difference showing the baseline and candidate profiles

#### Scenario: Requested profile equals the baseline
- **WHEN** the request sets `lead` to the baseline's lead profile
- **THEN** `lead` is not listed as a difference

#### Scenario: Compare call fails
- **WHEN** the GitHub compare for `Codagent-AI/agent-runner` fails
- **THEN** the command refuses with `github-compare-failed`

### Requirement: Ancillary differences
Every other difference between the candidate identity and the baseline identity SHALL be listed as
**ancillary**, each with the baseline and candidate values:

- for a repository whose ref the request sets: when the merge base of `main` and the recorded commit
  differs from the baseline's commit for that repository, that `main` moved, with both SHAs and the
  number of commits between them;
- for a repository whose ref the request does not set: a recorded commit that differs from the
  baseline's, with both SHAs and the commit counts each is ahead of the other;
- role profiles the request does not set that differ, field by field (`cli`, `model`, `effort`,
  `agent`);
- for every role, including roles the request sets, a configured `agent` that differs. A requested
  profile covers only `cli:model:effort`, so an `agent` change is never primary;
- workflow settings that differ (`workflow`, `workflow_path`, `task_level_compliance`,
  `final_validator`, and `skip_validator` when the request does not set it).

Differences among baseline repetitions are listed separately (see Cohort integrity). When there are no
primary or no ancillary differences, the report SHALL say so. Commit counts come from the GitHub
compare API; a failed compare SHALL refuse with `github-compare-failed`.

#### Scenario: Main moved under a branch
- **WHEN** the request sets `agent_runner_ref`, and the branch's merge base with `main` is 5 commits
  after the baseline's runner commit
- **THEN** an ancillary difference reports that `main` moved by 5 commits, with both SHAs

#### Scenario: Unrequested skills commit differs
- **WHEN** the request does not set `agent_skills_ref` and the candidates' skills commit differs
  from the baseline's
- **THEN** the skills commit is an ancillary difference, not a primary one

#### Scenario: Unrequested profile differs
- **WHEN** the request does not set `crosscheck` and the candidates' crosscheck model differs from
  the baseline's
- **THEN** it is listed as an ancillary difference

#### Scenario: Requested role with only its agent changed
- **WHEN** the request sets `tester` to the baseline's tester profile and the candidates' tester
  `agent` differs from the baseline's
- **THEN** `tester` is not a primary difference, and the `agent` change is listed as ancillary

#### Scenario: Requested profile and agent both changed
- **WHEN** the request sets `tester` to a profile that differs from the baseline's and the candidates'
  tester `agent` also differs
- **THEN** the profile change is primary and the `agent` change is listed as ancillary

### Requirement: Attribution provenance
The report SHALL record, for each repository it compared: the `main` SHA it resolved, the time it was
resolved, the compared range, and the compare status. The `main` of each repository SHALL be resolved
once per report and used for every compare against that repository. The report SHALL also record the
eval issue reference and the SHA-256 of the parsed request (its set keys and values serialized as
canonical JSON with sorted keys).

#### Scenario: Provenance is shown
- **WHEN** a report lists branch commits for `Codagent-AI/agent-runner`
- **THEN** it shows the resolved `main` SHA and resolution time used for that list

### Requirement: Metrics
For each side, the report SHALL show the repetition count and, for each metric, the mean, sample
standard deviation (`n/a` for one repetition), min and max; then the difference (candidate mean minus
baseline mean), the difference as a percentage of the baseline mean, and a band. The metrics are:

- automated score (`automated_subtotal` points);
- tokens: total, and per provider;
- active time (`implementation_metrics.active_duration_ms`);
- estimated cost in USD: total, and per role for `lead`, `implementor`, `tester` and
  `implementation-validator`, plus any other role present in a repetition's cost rows.

Per-provider tokens SHALL be taken as in the baseline record (a provider absent from a repetition
counts as zero for it). Per-role cost SHALL come from each repetition's `cost.rows[]` by `agent_role`;
a role without a row in a repetition whose total cost is complete counts as zero. Baseline per-role
cost SHALL be read from each baseline repetition's published result directory under
`--baseline-results`.

A token or cost metric SHALL be compared only when every repetition on **both** sides reports it
complete (tokens: complete usage with a numeric total; cost: complete total cost; per-role cost:
complete total cost and a readable result). Otherwise the report SHALL print "incomplete" for that
metric with the run ids that lack it, and SHALL NOT average a subset. Active time SHALL likewise be
"incomplete" when any repetition lacks it.

When the baseline mean is zero, the percentage SHALL be 0% if the difference is zero and otherwise
reported as not defined.

#### Scenario: Complete metrics
- **WHEN** every repetition on both sides has complete tokens and cost
- **THEN** each token and cost metric shows both sides' statistics, the difference, percentage and a
  band

#### Scenario: One repetition lacks cost
- **WHEN** one baseline repetition's total cost is incomplete
- **THEN** total cost and every per-role cost print "incomplete" naming that run id, and no averages
  are shown for them

#### Scenario: Baseline result directory missing
- **WHEN** a baseline repetition's published result directory cannot be read under
  `--baseline-results`
- **THEN** per-role cost prints "incomplete" naming that run id, and the rest of the report is still
  produced

### Requirement: Unscored product failures
A product failure without automated points SHALL remain in its side's repetitions. It SHALL NOT be
imputed as zero or dropped. That side's automated-score statistics and the automated-score band SHALL
print "incomplete" with the unscored run ids. Its resource metrics SHALL be compared normally.

When a side that includes any product failure would be **better** on a token, active-time or cost
metric (a leaning or clear band), the report SHALL mark that band as including product failures.

#### Scenario: Candidate failure before scoring
- **WHEN** one candidate repetition is a product failure recorded in the verification phase with no
  automated points
- **THEN** the automated score shows "incomplete" naming that run, and tokens, active time and cost
  are still compared

#### Scenario: Cheaper because it failed
- **WHEN** a candidate side containing a product failure is clearly better on cost
- **THEN** the cost band is shown as clearly better and marked as including product failures

### Requirement: Bands
For each comparable metric the band SHALL be computed as follows, with `n1` and `n2` the two sides'
repetition counts and `s1`, `s2` their sample standard deviations (zero for a side with one
repetition):

- pooled standard deviation `SD = sqrt(((n1 − 1)·s1² + (n2 − 1)·s2²) / (n1 + n2 − 2))`;
- for the automated score only, `SD = max(SD, 3.0)`;
- `SE = SD × sqrt(1/n1 + 1/n2)` and `z = Δ / SE`, where `Δ` is candidate mean minus baseline mean;
- when `SE` is zero, `z` is zero if `Δ` is zero and otherwise infinite with the sign of `Δ`.

The band SHALL be **clear** when |z| ≥ 1.96, **leaning** when 1.28 ≤ |z| < 1.96, and **same**
otherwise. For tokens, active time and cost, **clear** SHALL also require |Δ%| ≥ 15% (an undefined
percentage with a non-zero `Δ` satisfies it); otherwise a would-be clear band SHALL be **leaning**.

A non-same band SHALL be labeled **better** or **worse**: a higher automated score is better; fewer
tokens, less active time and lower cost are better.

#### Scenario: Score difference within the noise floor
- **WHEN** the baseline automated scores are 60 and 60 and the candidate's are 62 and 62
- **THEN** SD is floored at 3.0, z = 2 / (3.0 × 1) ≈ 0.67, and the band is **same**

#### Scenario: Clearly better score
- **WHEN** the floored SD is 3.0, n1 = n2 = 2, and the candidate mean is 7 points higher
- **THEN** z ≈ 2.33 and the band is **clearly better**

#### Scenario: Large z but small percentage
- **WHEN** token totals have |z| ≥ 1.96 but differ by 10%
- **THEN** the token band is **leaning**, not **clear**

#### Scenario: Identical values
- **WHEN** every repetition on both sides has the same active time
- **THEN** the active-time band is **same**

### Requirement: Reliability flags
The report SHALL flag the candidate when any candidate repetition:

- failed a gate: any recorded gate verdict is `fail`, `gates_passed` is false, or the repetition is a
  product failure (including one that stopped before scoring); or
- has automated points more than 6 below the baseline's mean automated score.

Each flag SHALL name the run id and the reason: the failed gate ids, or the product failure's phase
and reason, or the score and the shortfall. When the baseline's mean automated score is incomplete,
the report SHALL say the score-shortfall check could not be made. When nothing is flagged, the report
SHALL say so.

#### Scenario: Hard gate failure
- **WHEN** a candidate repetition failed the `verification-sample-outline` gate
- **THEN** the candidate is flagged naming that run and gate

#### Scenario: Low-scoring repetition
- **WHEN** the baseline mean is 55.0 and a candidate repetition scored 48.5
- **THEN** the candidate is flagged naming that run and a 6.5-point shortfall

#### Scenario: Within six points
- **WHEN** the baseline mean is 55.0 and every candidate repetition scored at least 49.0 with no
  failed gates or product failures
- **THEN** no reliability flag is raised

### Requirement: Human review pointers
The report SHALL name the median repetition on each side by automated score, chosen as the baseline
record chooses its median (unscored repetitions order lowest, ties broken by run id), and SHALL say
that the candidate's median is the one to review by hand.

It SHALL show the baseline's human-reviewed repetition, its official score and its human points out
of possible, and note when that repetition is not the baseline's current median.

It SHALL show the candidate median's official score and human points when that repetition has a
complete human review (directly or carried from its rescore source), and otherwise say the review is
pending. The candidate's human score SHALL be information only: it SHALL have no band, and its
absence SHALL NOT prevent the comparison.

#### Scenario: Candidate median not yet reviewed
- **WHEN** the candidate median repetition has no complete human review
- **THEN** the report names it as the repetition to review, says its review is pending, and the
  comparison is otherwise complete

#### Scenario: Candidate median reviewed
- **WHEN** the candidate median repetition has a complete human review
- **THEN** the report shows its official score and human points, with no band

### Requirement: Report output
On success the command SHALL exit 0 and print the report on stdout:

- by default as Markdown no longer than 65,536 characters (one GitHub comment), with sections for the
  header (eval issue, candidate and baseline repetition counts, baseline source and set time),
  primary differences, ancillary differences, baseline repetition mismatches when any, metrics,
  reliability flags, human review, and provenance;
- with `--json`, as one JSON object with `status` `compared` that holds the same content as the
  Markdown, including the per-metric statistics, differences, bands and their product-failure marks,
  flags, human-review pointers and provenance.

When the Markdown would exceed the limit, the report SHALL shorten the commit and mismatch lists and
state how many entries were omitted, never dropping a metric, band or flag.

#### Scenario: Markdown fits one comment
- **WHEN** a comparison succeeds
- **THEN** stdout is Markdown of at most 65,536 characters containing every listed section

#### Scenario: JSON matches Markdown
- **WHEN** the same comparison runs with and without `--json`
- **THEN** the JSON holds the same bands, flags, differences and median repetitions as the Markdown

