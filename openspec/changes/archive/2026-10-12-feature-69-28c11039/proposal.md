## Why

The eval loop (Factory and eval loop strategy, 2026-09-27) runs a candidate Agent Runner or Agent
Skills change through the and-scene eval several times and has to decide whether the change helped.
agent-evals#58 gave the suite a recorded experiment baseline
(`evals/agent-runner/and-scene/experiments/baseline.json`), but nothing yet compares a candidate's
repetitions against it. Today someone reads each `result.json` by hand, eyeballs means across noisy
two- or three-repetition samples, and has to work out separately what actually differed between the
candidate and the baseline. That is slow, inconsistent, and easy to get wrong: a 4-point score swing
is within run-to-run noise, a rubric or fixture change makes scores incomparable, and a difference on
`main` can masquerade as the effect of the branch under test.

A comparison report closes the loop. It tells the person (and later the factory) whether the
candidate is the **same**, **leaning** better or worse, or **clearly** better or worse on each
metric, refuses comparisons that cannot be trusted, separates what the eval request put under test
from incidental drift, and names the one repetition to review by hand. Its output fits in one GitHub
comment so a later agent-factory ticket can post it on the eval issue. The baseline record it depends
on (#58) is merged, so this is the next step on the plan.

**Verdict: go.** The inputs exist (baseline record, published result directories, the factory's eval
request format), the statistics are fixed by the issue's decisions, and the alternative—manual
comparison per eval—is exactly the cost the eval loop is meant to remove. Maintenance cost is one
command module plus its library; it reuses #58's repetition extraction rather than duplicating it.

## What Changes

- Add `experiments.mjs compare --eval-issue <owner/repo#N> <result-dir>... [--json]` to the and-scene
  suite. It compares the experiment baseline record's `current` baseline with two or more candidate
  repetitions read from published result directories.
- Admission of candidate repetitions follows #58: an infrastructure failure (`failure` set,
  `product_failure` null), an unsupported or non-candidate result, or no `current` baseline is
  refused. Product failures are kept. A rescored repetition is read from its rescored result.
  Admission is all-or-nothing and also refuses **lineage overlap**—the same execution passed twice,
  an original together with its rescore, or a candidate repetition that shares a lineage with a
  baseline repetition (by `run_id`, `rescored_from`, or non-null `execution_run_id`). The minimum of
  **two** counts distinct admitted executions.
- **Cohort integrity.** Each side is compared as one configuration. Candidate repetitions must share
  one recorded identity (runner and skills commits, workflow settings, role profiles, rubrics,
  fixture); otherwise the report refuses. The baseline may hold repetitions admitted with #58's
  `--allow-mismatch`; the report checks rubrics and fixture on **every** repetition of both sides,
  not only the baseline's first-repetition identity, and lists any other within-baseline mismatch
  with its recorded reason.
- Refuse to compare when any candidate repetition and any baseline repetition differ in the
  automated or human rubric (`rubric_id`, `version`, `sha256`) or the fixture commit, or when either
  is unknown.
- Read the candidate's eval issue, parse its single fenced `eval` TOML block with the keys the
  factory accepts, and list every other difference as **primary** (what the request put under test:
  branch commits not on `main` for `agent_runner_ref` / `agent_skills_ref`, from the GitHub compare
  API against the recorded commit; requested role profiles and `skip_validator` that differ from the
  baseline) or **ancillary** (everything else, including `main` moving between the baseline commit
  and the branch's merge base). An unreadable issue or missing/invalid eval block is a refusal, and
  so is a request whose role profiles or `skip_validator` disagree with what the results record
  (for example, an issue edited after the eval ran).
- **Attribution provenance.** `main` is resolved once per repository per report, and the report
  keeps the resolved `main` SHA, the compare status, and a hash of the parsed request, so a later
  reader can see what the attribution was computed against. When the recorded commit is already on
  `main` (the branch has merged since the eval ran), the report says the branch-only commits can no
  longer be recovered from live `main` rather than listing none.
- Report per-side mean, standard deviation, min and max, and the absolute and percentage difference
  with a band, for the automated score; tokens, total and per provider; active time; and cost, total
  and per role (lead, implementor, tester, implementation-validator). Token and cost metrics print
  "incomplete" unless every repetition on both sides reports them complete.
- Bands use a pooled standard deviation (floored at 3.0 for the automated score only),
  `SE = SD × sqrt(1/n1 + 1/n2)`, `z = Δ / SE`: **clear** at |z| ≥ 1.96, **leaning** at
  1.28 ≤ |z| < 1.96, else **same**; tokens, active time and cost also need |Δ%| ≥ 15% to be
  **clear**.
- Flag the candidate when any repetition failed a gate or scored more than 6 points below the
  baseline's mean automated score. A conclusive product failure counts as a failed gate even when it
  stopped the run before scoring (for example a verification or candidate-server failure recorded in
  `product_failure`), and the flag names the run and its failure phase and reason.
- **Unscored product failures.** A product failure without automated points stays in its side: it is
  never imputed as zero and never dropped. That side's automated-score statistics and band print
  "incomplete" with the unscored run ids. Resource metrics are still compared, but a favorable
  resource band on a side that includes product failures is marked as such, so a cheaper or faster
  failed delivery cannot read as an unqualified improvement.
- Name the median repetition on each side, show the baseline's human score, and show the candidate
  median's human score when it has a complete review (information only, never banded or required).
- Print Markdown sized for one GitHub comment; `--json` prints the same content as JSON.
- `experiments.mjs` usage and `--help` grow the `compare` command; the `baseline` commands and the
  record format are unchanged.

## Capabilities

### New Capabilities
- `experiment-comparison-report`: comparing a candidate eval's repetitions with the experiment
  baseline—admission and refusals, the eval-request reading and primary/ancillary differences,
  metrics, bands, reliability flags, human-review pointers, and Markdown/JSON output.

### Modified Capabilities
- `experiment-baseline-record`: the "Command-line usage errors" requirement, so `experiments.mjs`
  accepts `compare` alongside `baseline <set|add-rep|anchor|show>` and `--help` covers it.

## Technical Approach

- **Module fit.** Keep `experiments.mjs` as the single entry point and add a `compare` dispatch.
  Put the comparison logic in a new pure library (for example `lib/experiment-comparison.mjs`) that
  takes already-loaded inputs and returns a report object; Markdown and JSON are two renderings of
  that object, so they cannot drift. The CLI layer does the I/O: reading the record and result
  directories, the eval issue, and GitHub compare data.
- **Reuse #58.** Candidate repetitions go through `extractRepetition` (including rescore and
  carried-human-review handling) and `summarize`/`selectMedian`, so both sides are read and
  summarized the same way. Cohort admission (lineage overlap within the candidates and against the
  baseline, within-side identity, rubric/fixture on every repetition) is a pure step built on #58's
  `compareIdentity` and lineage check, exported or generalized rather than reached through
  `applySet`, which mutates the record and requires a reviewed median. The baseline record schema
  does not change.
- **Per-role cost on the baseline side.** The record stores only cost totals per repetition. The
  comparison re-reads each baseline repetition's published result directory
  (`results/<run_id>/result.json` under the suite's results directory by default, overridable with
  `--baseline-results`) for per-role
  cost rows (`cost.rows[].agent_role`). A baseline result that cannot be read makes per-role cost
  "incomplete" rather than refusing the whole report. This avoids a persisted-format change.
- **Eval request parsing.** The factory parses the block with Python `tomllib`; this repository
  allows no new runtime dependencies, and eval blocks are flat `key = value` documents (strings,
  booleans, integers). Implement a strict parser for that subset that refuses anything outside it,
  plus the factory's checks: exactly one ```` ```eval ```` block, only accepted keys
  (`agent_runner_ref`, `agent_skills_ref`, `fixture_ref`, `lead`, `crosscheck`, `implementor`,
  `tester`, `skip_validator`, `repetitions`), and the same value types.
- **GitHub access.** Use the `gh` CLI (already used by the suite) for the issue body and
  `repos/<repo>/compare/main...<commit>`, behind an injectable executor so tests run offline. The
  compare uses the commit recorded in the results, never the branch name. A failed GitHub call is a
  refusal, not a silently shorter list. The results do not record the `main` SHA at admission, so
  attribution is computed against live `main` and labeled with the SHA and time it was resolved.
  Reading the factory's "Frozen evaluation inputs" comment is left out: its format belongs to the
  agent-factory repository, and checking the request against the results covers edited issues.
- **Statistics.** Sample standard deviation per side as in #58; pooled SD from both sides' sums of
  squares; floor and thresholds as specified. Small-n and zero-variance cases (for example identical
  token counts) are defined explicitly in the spec so the band is never NaN.
- **Tests.** Unit tests in the existing `node --test test/*.test.mjs` suite with fixture result
  objects and a fake `gh`; the new module is added to the `check` script's `node --check` list.
  No new suites or CI jobs.

## Out of Scope

- Posting the report on the eval issue (a later agent-factory ticket).
- The experiment ledger, accept/reject decisions, and promoting a candidate into the baseline.
- Side-by-side human review, and any band or requirement on the candidate's human score.
- Changing the experiment baseline record format, the `baseline` commands, or the reference
  baseline.
- Comparing against the `anchor` or historical baselines.

## Impact

- **Code:** `evals/agent-runner/and-scene/experiments.mjs` (new `compare` command and usage), a new
  comparison library under `evals/agent-runner/and-scene/lib/`, a small TOML-subset parser, tests
  under `test/`, `package.json` `check` list, and the suite README's experiment section.
- **External systems:** read-only GitHub API calls via `gh` for the eval issue and branch compare;
  the command needs GitHub read access to Codagent-AI/agent-runner and Codagent-AI/agent-skills.
- **Data:** reads the baseline record and published result directories; writes nothing.
- **Dependencies:** none added.
- **Users:** eval-loop operators now; the agent factory later, when it posts the report.
