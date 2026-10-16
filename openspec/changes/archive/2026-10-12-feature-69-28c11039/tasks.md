# Tasks

Implement on the change's feature branch. The task must leave `npm run check` green.

- [x] 1. Comparison report: `experiments.mjs compare` against the experiment baseline

These are not implementor tasks. They run after this task:

- the exploratory acceptance pass, under the envelope in `test-plan.md`;
- posting the report on the eval issue (a later agent-factory ticket).

## Task 1: Comparison report — `experiments.mjs compare`

### Goal

Add `node evals/agent-runner/and-scene/experiments.mjs compare --eval-issue <owner/repo#N>
<result-dir>... [--json] [--record <path>] [--baseline-results <dir>]`. It compares two or more
candidate repetitions (published result directories) with the experiment baseline record's `current`
baseline, refuses comparisons that cannot be trusted, lists primary and ancillary differences using
the candidate's eval issue and the GitHub compare API, reports metrics with same / leaning / clear
bands, raises reliability flags, names the median repetitions for human review, and prints Markdown
that fits one GitHub comment (or the same content as JSON). It is read-only.

### Sources of truth

Read these first. They are normative; this section only orients you.

- `openspec/changes/feature-69-28c11039/specs/experiment-comparison-report/spec.md`: every
  requirement and scenario to satisfy (refusal codes, admission, cohort integrity, eval-block parsing,
  request-vs-results check, primary/ancillary differences, provenance, metrics, bands, product
  failures, flags, human review, output).
- `openspec/changes/feature-69-28c11039/specs/experiment-baseline-record/spec.md`: the modified usage
  requirement (`compare` accepted, `--help` lists it).
- `openspec/changes/feature-69-28c11039/design.md`: modules and their functions, data flow, the
  `gh api … --jq` projections, compare planning, classification rules, band algorithm, report object
  shape, Markdown size enforcement, exit codes, verification.
- `openspec/changes/feature-69-28c11039/test-plan.md`: INT-001, INT-002, INT-003 and E2E-001.
- `openspec/changes/feature-69-28c11039/decisions.md`: rationale. Later entries win over earlier ones
  (for example decision 9 supersedes 6; AR-002/AR-003 entries 33–34 refine the design's agent-field
  and `main`-resolution rules).
- `openspec/changes/feature-69-28c11039/proposal.md`: scope and out-of-scope items.

### Background

- Existing code from agent-evals#58: `evals/agent-runner/and-scene/experiments.mjs` (CLI,
  `parseArgs`, `runExperimentsCommand({ argv, now, stdout, write })`, `findCarriedReview`) and
  `evals/agent-runner/and-scene/lib/experiment-baseline.mjs` (pure: `extractRepetition`,
  `identityOf`, `compareIdentity`, private `overlapping`, `selectMedian`, private `stats`,
  `summarize`, private `WORKFLOW_FIELDS` / `PROFILE_FIELDS` / `RUBRIC_FIELDS`). Tests:
  `test/experiment-baseline.test.mjs` (its `makeResult(patch)` builder is a good pattern).
- Facts about published `result.json` files (verified in `evals/agent-runner/and-scene/results/`):
  - `workflow.skip_validator` is a **string** (`"false"`); the eval request's value is a boolean.
  - Per-role cost exists only in `cost.rows[]` (`agent_role`, `cost.amount_usd`); the record keeps
    totals only, so baseline per-role cost is re-read from `<baseline-results>/<run_id>/result.json`.
  - `cost.total.complete` is `false` on every published result; only
    `aab6fbe4-c5d1-4ab8-a169-e71500370a30-rep-1` has a completed human review.
  - `product_failure` is `{ phase, reason, gate, failures[] }`; unscored product failures have
    `automated_subtotal: null`. None matching a reviewed baseline are published; build them
    synthetically.
- The factory's eval-request parser (agent-factory `src/agent_factory/work_kinds/eval/__init__.py`)
  accepts keys `agent_runner_ref`, `agent_skills_ref`, `fixture_ref`, `lead`, `crosscheck`,
  `implementor`, `tester`, `skip_validator`, `repetitions`; role profiles are `cli:model:effort`.
- An unprojected GitHub compare response can exceed 2 MB; always use the design's `--jq`
  projections (a real range projected to about 2.5 KB).

### What to build

1. `lib/experiment-baseline.mjs`: export `WORKFLOW_FIELDS`, `PROFILE_FIELDS`, `RUBRIC_FIELDS`,
   `stats`; rename `overlapping` to exported `lineageOverlaps` and use it in `applySet`/`applyAddRep`.
   No behavior change.
2. `lib/eval-request.mjs`: `extractEvalBlock` (CRLF-normalized, factory pattern, missing/ambiguous),
   `parseTomlSubset` (flat `key = value`; strings, booleans, integers; reject everything else and
   duplicates), `validateRequest` (factory keys and types, no defaults), `requestHash` (`hashJson`).
3. `lib/github-read.mjs`: `issueBody`, `resolveMain`, `compare`, each `gh api <path> --jq
   <projection>` via injectable `exec` (default `spawnSync`, argv array, 60 s timeout, 8 MiB
   `maxBuffer`), validated owner/repo and 40-hex SHAs, `{ ok: false, message }` on any failure.
4. `lib/experiment-comparison.mjs` (pure): `admitCohorts`, `checkRequest`, `planCompares`,
   `classifyDifferences`, `roleCosts`, `compareMetrics`, `band`, `reliabilityFlags`, human-review
   pointers, `buildReport` — exactly as the design specifies.
5. `lib/comparison-format.mjs`: `formatMarkdown(report, { limit = 65_536 })` with the design's
   trimming order, and `formatRefusals(refusals, { json })`.
6. `experiments.mjs`: `parseArgs` accepts `compare` and its options; usage/`--help` list it;
   `runExperimentsCommand` gains injectable `exec` and dispatches to a read-only `runCompare`
   (collect all loading refusals, admission and request checks, then GitHub compares only when no
   refusal exists; exit 0 compared, 1 refused, 2 usage/I/O/internal).
7. `package.json` `check`: add `node --check` for the four new modules.
8. `evals/agent-runner/and-scene/README.md`: add a `compare` subsection (usage, `gh` read access to
   Codagent-AI/agent-runner, Codagent-AI/agent-skills and the eval issue's repository, how to read the
   bands and flags, refusals).

### Tests

In a new `test/experiment-comparison.test.mjs` (existing `node --test test/*.test.mjs` suite):

- Unit tests for every spec scenario and the design's verification list (TOML subset, block
  extraction, request validation, admission and lineage, cohort integrity on every baseline
  repetition, request check with string `skip_validator`, compare planning, classification including
  the `agent`-field and `may_have_merged` cases, bands against the spec's worked numbers and edge
  cases, joint completeness and per-role zero-fill, unscored product failures, flags, medians,
  Markdown size trimming, JSON/Markdown parity).
- INT-001, INT-002, INT-003 and E2E-001 exactly as `test-plan.md` describes (stub `gh` on `PATH`
  that honors the `--jq` projection and emits raw >1 MiB output otherwise; copies of the named
  published results; synthetic schema-9 results; the real entry point as a child process).
- `test/experiment-baseline.test.mjs` must pass unchanged.
- No network or GitHub credentials in tests.

### Constraints

- No third-party runtime dependencies.
- Read-only: never write the record, any result directory, or GitHub.
- Do not change the record schema, the `baseline` commands' behavior, or the reference baseline.
- Do not edit anything under `evals/agent-runner/and-scene/results/**`.
- Subprocesses only through argv arrays, never a shell.

### Done When

- Every requirement and scenario in both spec files is implemented and covered by a test.
- INT-001, INT-002, INT-003 and E2E-001 exist and pass.
- `npm run check` passes, including the new `node --check` entries.
- The README documents `compare`.
- `agent-validator run` passes before the pull request is opened.
