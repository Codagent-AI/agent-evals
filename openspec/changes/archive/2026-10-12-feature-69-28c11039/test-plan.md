## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional
integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only
obligations.

Almost all of this change is decision logic (admission, cohort integrity, request parsing, difference
classification, statistics, bands, flags, medians, rendering) that the design places in pure modules.
Unit tests in `test/experiment-comparison.test.mjs` cover it from literal inputs, per the specs'
scenarios. The obligations below cover only the boundaries unit tests cannot: the real `gh`
subprocess, real published `result.json` files on disk, and the CLI entry point as an operator runs
it. All automated tests run in the existing `node --test test/*.test.mjs` suite (`npm run check`, CI)
with no network and no GitHub credentials; a stub `gh` stands in for GitHub. The existing
`test/experiment-baseline.test.mjs` must keep passing unchanged after #58's internals are exported.

## Integration Tests

### INT-001: GitHub reads through a real `gh` subprocess
- Covers: Eval request reading (issue unreadable), Primary differences (compare failure), Attribution
  provenance; design `lib/github-read.mjs`.
- Boundary: `lib/github-read.mjs` → `spawnSync('gh', [...])` → a stub `gh` executable (a small Node
  script written to a temp directory and placed first on `PATH` for the child) that answers
  `api repos/.../issues/N`, `api repos/.../commits/main` and `api repos/.../compare/A...B` from a JSON
  table and logs its argv. The stub emits the table's raw response unless argv carries `--jq` with the
  adapter's projection, in which case it emits the projected JSON (computed in the stub with plain
  JavaScript), mirroring real `gh`.
- Setup: temp directory with the stub and its table; responses include a multi-line commit message, a
  compare with `ahead_by` 0, a successful compare whose **raw** JSON exceeds 1 MiB (300 commits with
  long messages plus a large `files` array, `ahead_by` 300), a non-zero exit with a stderr message, and
  invalid JSON.
- Action: call `issueBody`, `resolveMain` and `compare` with the default `exec` (real `spawnSync`).
- Assertions: arguments arrive as one argv array with no shell interpretation (a body containing
  `$(...)` and backticks is returned verbatim); parsed fields match the table (`sha`, `status`,
  `ahead_by`, `behind_by`, `merge_base`, first-line `subject`); the over-1-MiB compare succeeds with
  `ahead_by` 300 and exactly 20 listed commits, proving payload size cannot become a
  `github-compare-failed` refusal (without the projection the stub's raw output overflows
  `spawnSync`'s default buffer and this assertion fails); non-zero exit, spawn failure and invalid
  JSON each return `{ ok: false, message }` carrying the stub's stderr; a non-40-hex commit is rejected
  without invoking the stub (argv log stays empty).
- Execution: `test/experiment-comparison.test.mjs`, `npm run check`. Skip only if the platform cannot
  execute a shebang script (not expected on CI's Linux runner or macOS).

### INT-002: Real published results through admission, per-role cost and read-only guarantees
- Covers: Candidate repetition admission, Cohort integrity, Metrics (joint completeness, per-role cost
  from `--baseline-results`), Compare command (writes nothing).
- Boundary: `runExperimentsCommand` reading copies of real published `result.json` files (schema 8)
  from disk, `findCarriedReview`, `extractRepetition`, and baseline re-reads under
  `--baseline-results`; injected `exec` table for GitHub.
- Setup: copy into a temp results directory `aab6fbe4-c5d1-4ab8-a169-e71500370a30-rep-1` (reviewed;
  becomes a one-repetition baseline via `baseline set --record <temp>`),
  `3938f16c-81f7-4334-9bbd-ad215d88f112-rep-1`/`-rep-2` (candidates sharing fixture `892dfbcf` and
  automated rubric 6.0.0), and `19b861fd-0efc-4476-bcc1-b73ef46e86f2-rep-1` (a scored product failure
  under fixture `2262a9f1`) for the fixture-mismatch variant. Record SHA-256 of every file before
  running.
- Action: `compare --eval-issue Codagent-AI/agent-evals#1 <cand-1> <cand-2> --record <temp>
  --baseline-results <temp-results> [--json]`, plus variants: the baseline's result directory removed;
  `19b861fd-…-rep-1` added as a third candidate (different fixture); the same candidate directory
  passed twice.
- Assertions: real files parse without refusals other than intended ones; cost and per-role cost print
  "incomplete" naming the run ids (published results report incomplete cost), and no average of a
  subset appears; removing the baseline result directory changes only per-role cost to "incomplete";
  the fixture variant refuses `not-comparable`; the duplicate refuses `lineage-overlap`; every file's
  SHA-256 and the record bytes are unchanged afterwards. If the human rubric hashes of the chosen
  results differ, pick another reviewed-plus-candidate set from published results with matching
  rubrics and fixture rather than editing the copies.
- Execution: `test/experiment-comparison.test.mjs`, `npm run check`.

### INT-003: Unscored product failure from result files to report
- Covers: Unscored product failures, Reliability flags (pre-scoring product failure), Candidate
  repetition admission (product failures kept).
- Boundary: `runExperimentsCommand` reading `result.json` files from disk through
  `extractRepetition`, admission, metrics, bands, flags and both renderers; injected `exec` table for
  GitHub.
- Setup: synthetic schema-9 results written to a temp directory (no published result has an unscored
  product failure under a fixture and rubrics matching a reviewed baseline): two baseline repetitions
  with complete tokens and cost and a reviewed median; three candidate repetitions with the same
  identity, complete tokens and cost, all cheaper by more than 15% with spread small enough for a
  clear band; one of them has `automated_subtotal: null` (incomplete) and
  `product_failure: { phase: 'verification', reason: 'build failed', gate: null, failures: [] }` with
  `failure: null`.
- Action: `compare … ` with and without `--json`.
- Assertions: exit 0 and the failed run is counted (candidate repetitions = 3); automated-score
  statistics and band are "incomplete" naming that run id, with no score average from the two scored
  runs; the reliability flag names the run with phase `verification` and its reason; the cost band is
  clearly better and marked as including product failures; tokens and active time are still compared;
  JSON carries the same values.
- Execution: `test/experiment-comparison.test.mjs`, `npm run check`.

## End-to-End Tests

### E2E-001: Operator journey from baseline to comparison report via the real entry point
- Covers: Compare command, Refusals, Report output, Human review pointers, Reliability flags, Bands,
  and the modified Command-line usage errors requirement (`--help` lists `compare`).
- Surface: `node evals/agent-runner/and-scene/experiments.mjs …` as a child process (exercising
  `invokedDirectly`, real stdout/stderr and exit codes), with the INT-001 stub `gh` first on `PATH`.
- Setup: temp directory with synthetic schema-9 results built by the test's result builder: two
  baseline repetitions (median reviewed) and three candidate repetitions with complete tokens and cost,
  a requested `agent_runner_ref` whose recorded commit is 3 commits ahead of stubbed `main`, an
  unrequested skills commit change, one candidate failing a hard gate, and a candidate median with a
  complete human review. The stub's issue body contains one valid eval block.
- Journey: `baseline set` (temp `--record`) → `compare` (Markdown) → `compare --json` → `compare` with
  a single candidate directory and an issue body with two eval blocks → `--help`.
- Assertions: Markdown exit 0, at most 65,536 characters, contains each section, the three primary
  commits, the ancillary skills change, the gate flag naming the run and gate, the candidate median
  named for review with its human score, and provenance for **both** repositories (requested
  agent-runner and unrequested agent-skills), each with the stubbed `main` SHA and resolution time and
  the compared range; JSON exit 0 with
  `status: "compared"` and the same bands, flags, medians and differences as the Markdown; the refusal
  run exits 1 with stderr JSON lines for both `too-few-repetitions` and `eval-block-ambiguous` and a
  stdout refusal summary; `--help` exits 0 and lists `compare`. Assertions use codes, run ids, band
  labels and section headings, not full Markdown snapshots.
- Execution: `test/experiment-comparison.test.mjs`, `npm run check`.

## Acceptance Testing Envelope

- Environments and sandboxes: a local checkout of this branch on the host; temp directories for
  records (`--record`) and copied result directories. Published results under
  `evals/agent-runner/and-scene/results/` may be read in place. No Docker, Agent Runner run, or browser
  is needed.
- Credentials and secrets: the host's `gh` login (currently `codagent-llc` via `GH_TOKEN`) with read
  access to Codagent-AI repositories. No other secrets.
- Authorized effects: read-only GitHub API calls through `gh api` (issues, `commits/main`, compare)
  against Codagent-AI/agent-runner, Codagent-AI/agent-skills and Codagent-AI eval issues; free, within
  normal rate limits. No cleanup needed beyond deleting temp directories.
- Off limits: creating, editing or commenting on any GitHub issue or pull request; writing
  `evals/agent-runner/and-scene/experiments/baseline.json` in the checkout (always pass a temp
  `--record`); modifying anything under `results/**`; paid eval runs (`run.sh --run-agent`); pushing.
- Permitted substitutes: when no real eval issue matches the available published results, or `gh` is
  not authenticated, a stub `gh` (as in INT-001) for the issue body and/or compare responses, stated
  as such in the acceptance evidence. Synthetic result files for paths published data cannot reach
  (complete cost, a reviewed candidate median, clear bands), since published schema-8 results all
  report incomplete cost and only one has a completed human review.
- Known risk areas: large compare responses (real baseline-to-`main` ranges exceed 1 MiB unprojected;
  a read-only check on a long real range is authorized); requested roles whose `agent` alone changed
  (ancillary, never primary); live-`main` attribution after a branch merges (accepted limitation: reported with
  provenance and the may-have-merged note); recorded `skip_validator` stored as a string; rescored and
  carried-review lineage (prior #58 defect area); the Markdown size cap with long commit lists; band
  edge cases (one-repetition baseline, zero variance, zero baseline mean).

## Human-Only Testing

None.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| Compare command (read-only, options) | INT-002 | E2E-001 | — |
| Refusals (all reported, stderr + stdout summary, exit 1) | — | E2E-001 | — |
| Candidate repetition admission (real results, lineage overlap) | INT-002 | — | — |
| Cohort integrity (fixture/rubric on every repetition) | INT-002 | — | — |
| Eval request reading (issue fetch, block refusals) | INT-001 | E2E-001 | — |
| Primary / ancillary differences via GitHub compare (including over-1-MiB responses) | INT-001 | E2E-001 | — |
| Attribution provenance (requested and unrequested repositories) | INT-001 | E2E-001 | — |
| Metrics (joint completeness, per-role cost from `--baseline-results`) | INT-002 | — | — |
| Unscored product failures | INT-003 | — | — |
| Bands, reliability flags, human review pointers (rendered) | INT-003 | E2E-001 | — |
| Report output (Markdown size, JSON parity) | — | E2E-001 | — |
| Command-line usage errors (`--help` lists `compare`) | — | E2E-001 | — |
