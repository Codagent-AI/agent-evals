## Context

agent-evals#58 added the experiment baseline record and its CLI:

- `evals/agent-runner/and-scene/experiments.mjs` parses `baseline <set|add-rep|anchor|show>`,
  reads result directories, resolves carried human reviews (`findCarriedReview`), and writes the
  record atomically. `runExperimentsCommand({ argv, now, stdout, write })` is the testable entry
  point; refusals go to stderr as JSON lines and set exit 1, usage and I/O errors exit 2.
- `evals/agent-runner/and-scene/lib/experiment-baseline.mjs` is pure: `extractRepetition` (result →
  repetition entry plus refusals, including the infrastructure-failure rule and carried reviews),
  `identityOf` / `compareIdentity`, the private lineage check `overlapping`, `selectMedian`, the
  private `stats`, and `summarize`. Field lists `WORKFLOW_FIELDS`, `PROFILE_FIELDS` and
  `RUBRIC_FIELDS` are private constants.
- `test/experiment-baseline.test.mjs` builds results with a `makeResult(patch)` helper and drives the
  CLI through `runExperimentsCommand` with temporary directories.

Facts from published results that shape this design:

- `workflow.skip_validator` is recorded as the **string** `"true"`/`"false"`; the eval request's
  `skip_validator` is a TOML boolean.
- Per-role cost lives only in `result.json` `cost.rows[]` (`agent_role`, `cost.state`,
  `cost.amount_usd`); the record keeps per-repetition totals only.
- `product_failure` is `{ phase, reason, gate, failures[] }`; it covers hard gates, component floors,
  and pre-scoring failures (verification, candidate server) whose `automated_subtotal` is
  incomplete, making `extractRepetition` store `points: null`.
- The suite already calls `gh` through `spawnSync` with argument arrays and an injectable `exec`
  (`lib/subprocess.mjs`, `controller.mjs`).

Constraints: no third-party runtime dependencies; tests stay in `node --test test/*.test.mjs`; new
modules join the `check` script's `node --check` list; the record format and `baseline` commands do
not change.

## Goals / Non-Goals

**Goals:**
- Implement `experiments.mjs compare` as specified in `specs/experiment-comparison-report/spec.md`
  and the modified usage requirement in `specs/experiment-baseline-record/spec.md`.
- Keep every decision rule (admission, cohort integrity, differences, bands, flags, medians) in pure
  functions testable without a filesystem or network.
- Read both sides through the same #58 extraction and statistics so they cannot diverge.

**Non-Goals:**
- Posting the report, ledgers, promotion, side-by-side human review (issue out of scope).
- Changing the record schema, `baseline` commands, or reference baseline.
- A general TOML parser or a general GitHub client.

## Approach

### Modules

| Module | Kind | Responsibility |
| --- | --- | --- |
| `experiments.mjs` | CLI / I/O | Parse `compare` arguments, load inputs, call GitHub, assemble refusals, print output. |
| `lib/experiment-baseline.mjs` | pure (existing) | Export the lineage check and field lists; no behavior change. |
| `lib/eval-request.mjs` | pure (new) | Extract the single eval block, parse the TOML subset, validate keys and values, hash the request. |
| `lib/github-read.mjs` | I/O (new) | Read-only `gh api` calls: issue body, `main` SHA, commit compare. Injectable `exec`. |
| `lib/experiment-comparison.mjs` | pure (new) | Cohort admission, request-vs-results check, compare planning, difference classification, metrics, bands, flags, human-review pointers, report object. |
| `lib/comparison-format.mjs` | pure (new) | Render the report object (and refusal list) as Markdown or JSON, enforcing the comment size limit. |

### Data flow

```
argv ─▶ parseArgs ──(usage error: exit 2)
          │
          ├─▶ readJson(record) ─▶ validateRecord ─▶ current baseline (or refusal no-current / invalid-record)
          ├─▶ for each candidate dir: readJson(result.json) ─▶ findCarriedReview ─▶ extractRepetition
          │                                             └─▶ roleCosts(result)          (raw result kept for per-role cost)
          ├─▶ for each baseline rep: readJson(<baseline-results>/<run_id>/result.json) ─▶ roleCosts  (unreadable ⇒ incomplete)
          └─▶ github.issueBody(ref) ─▶ parseEvalRequest           (refusal eval-issue-unreadable / eval-block-*)
                     │
          admitCohorts(baseline, candidates)  ─ refusals: lineage-overlap, too-few-repetitions,
                     │                           candidate-identity-mismatch, not-comparable
          checkRequest(request, candidateIdentity) ─ refusal: request-results-mismatch
                     │   (any refusal so far ⇒ stop here, report all of them, exit 1)
          planCompares(request, baselineIdentity, candidateIdentity) ─▶ [{repo, kind, base, head}]
          github.resolveMain(repo) once per repo; github.compare(repo, base, head)   (failure ⇒ github-compare-failed)
                     │
          buildReport({ baseline, candidates, roleCosts, request, compares, now }) ─▶ report object
                     │
          formatMarkdown(report) | JSON.stringify(report) ─▶ stdout, exit 0
```

Refusals from the independent loading steps (record, candidate directories, baseline result
directories do not refuse, eval issue) are collected together so one run reports all of them.
Admission and request checks run only on the inputs that loaded; GitHub compares run only when no
refusal exists, because a refused comparison has no defined identity to attribute.

### `experiments.mjs` changes

- `parseArgs` accepts `argv[0] === 'compare'` alongside `baseline`. Compare options:
  `--eval-issue`, `--record`, `--baseline-results` (value options) and `--json` (flag); positional
  arguments are candidate directories. The `--eval-issue` value is validated against
  `^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$`. Defaults resolve relative to the suite
  directory via `import.meta.url`, as the record default already does. The usage string gains the
  compare line; `--help` behavior is unchanged.
- `runExperimentsCommand` gains an injectable `exec` (default `spawnSync`) passed to
  `lib/github-read.mjs`, and dispatches `compare` to a new `runCompare(args, deps)`.
- `runCompare` never writes files. It reuses `findCarriedReview` for candidate directories so carried
  human reviews behave exactly as in `baseline set`.
- Refusal output: each refusal is written to stderr as a JSON line (as today), stdout receives
  `formatRefusals(refusals, { json })`, exit 1. I/O errors other than a missing file exit 2 with an
  `io-error` line, matching #58.

### `lib/experiment-baseline.mjs` changes (export only)

- Export `WORKFLOW_FIELDS`, `PROFILE_FIELDS`, `RUBRIC_FIELDS`.
- Rename the private `overlapping(a, b)` to an exported `lineageOverlaps(a, b)` and use it in
  `applySet`/`applyAddRep`; behavior is unchanged.
- Export `stats(values)` so per-role cost statistics match `summarize`'s.

### `lib/eval-request.mjs`

- `extractEvalBlock(body)`: normalize `\r\n` to `\n`, then match the factory's pattern
  ``/```eval[ \t]*\n([\s\S]*?)\n```/g``. Zero matches ⇒ `eval-block-missing`; more than one ⇒
  `eval-block-ambiguous`.
- `parseTomlSubset(text)`: line-based. Each non-blank line, after removing a trailing `#` comment
  outside a string, must be `bare_key = value` with `bare_key` matching `[A-Za-z0-9_-]+`. Values:
  basic strings `"..."` (escapes `\" \\ \b \t \n \f \r \uXXXX \UXXXXXXXX`), literal strings `'...'`,
  `true`, `false`, integers `[+-]?(0|[1-9](_?[0-9])*)`. Tables, arrays, inline tables, dotted or
  quoted keys, floats, dates, multi-line strings and duplicate keys are rejected with
  `eval-block-invalid` naming the line.
- `validateRequest(doc)`: accepted keys and types as the factory's `parse_request` /
  `_validate_overrides` (refs non-empty strings; role profiles exactly three non-empty
  `:`-separated parts; `skip_validator` boolean; `repetitions` positive integer, booleans rejected).
  No defaults are applied: the report needs to know which keys the request **set**.
- `requestHash(settings)`: `hashJson(settings)` from `lib/persistence.mjs` (canonical sorted-key
  JSON, SHA-256).
- Returns `{ settings, hash }` or `{ refusals }`.

### `lib/github-read.mjs`

All calls are `exec('gh', ['api', path, '--jq', projection], { encoding: 'utf8', timeout: 60_000,
maxBuffer: 8 * 1024 * 1024 })`, never through a shell. Every call projects the response with `gh`'s
built-in `--jq` to only the fields used, so stdout stays small: an unprojected compare response
includes file patches and up to 250 commits and was measured above 2 MB for a real
baseline-to-`main` range, which overflows `spawnSync`'s default 1 MiB buffer (`ENOBUFS`). The explicit
`maxBuffer` is a safety margin for projected output, not the mechanism. Paths are built only from
validated parts: owner/repo from the parsed issue reference or the two fixed repository names; commit
SHAs must match `^[0-9a-f]{40}$` before use, otherwise the call is not made and the compare fails.

- `issueBody({ owner, repo, number })` → `GET repos/{o}/{r}/issues/{n}` with `--jq '{body: .body}'`,
  returns the body (string, possibly empty).
- `resolveMain(repo)` → `GET repos/{repo}/commits/main` with `--jq '{sha: .sha}'`, returns
  `{ sha, resolved_at }`.
- `compare(repo, base, head)` → `GET repos/{repo}/compare/{base}...{head}` with
  `--jq '{status, ahead_by, behind_by, merge_base: .merge_base_commit.sha, commits: [.commits[:20][]
  | {sha, subject: (.commit.message | split("\n")[0])}]}'`. `ahead_by` is exact even when the API
  truncates `commits`; the report uses it for counts and the projected first 20 commits for listing.

Each function returns `{ ok: false, message }` on a non-zero exit, a spawn error, or unparseable
JSON; the caller turns that into the matching refusal.

### `lib/experiment-comparison.mjs`

**Admission** — `admitCohorts({ baseline, candidates })`, where `candidates` are the
`extractRepetition` items:

1. Collect the items' own refusals (directory, schema, non-candidate, infrastructure failure).
2. `lineageOverlaps` for every candidate pair and every candidate–baseline pair ⇒ `lineage-overlap`
   naming both run ids.
3. Fewer than two admitted candidates ⇒ `too-few-repetitions`.
4. `compareIdentity(identityOf(first), other)` across candidates; any difference ⇒
   `candidate-identity-mismatch` listing fields.
5. For every baseline repetition and the candidate identity: compare `fixture_commit` and every
   `rubrics.{automated,human}.{rubric_id,version,sha256}`; a difference or a null on either side ⇒
   `not-comparable` naming the field and both values (deduplicated by field and value pair).
6. Within-baseline differences: `compareIdentity(identityOf(baseline.reps[0]), rep)` for every other
   repetition, excluding fields already refused in 5, attached with the repetition's recorded
   `mismatch.reason` (or `null`). These are listed, never refused.

**Request check** — `checkRequest(settings, candidateIdentity)`: for each set role key, compare
`cli:model:effort` with the identity's `roles[key].configured` (a missing role is a mismatch); for
`skip_validator`, normalize the recorded value (`true`/`"true"` ⇒ `true`, `false`/`"false"` ⇒
`false`, anything else ⇒ unknown, which mismatches).

**Compare planning** — `planCompares(settings, baselineIdentity, candidateIdentity)` returns, per
repository (`Codagent-AI/agent-runner` ↔ `runner_commit`, `Codagent-AI/agent-skills` ↔
`skills_commit`):

- requested ref: `primary` = `main...candidateCommit`; then, from its merge base, `main-moved` =
  `baselineCommit...mergeBase` when the merge base differs from the baseline commit;
- not requested and commits differ: `ancillary` = `baselineCommit...candidateCommit`;
- otherwise nothing.

`resolveMain` is called once for every repository with any planned compare (requested or not) and
cached for the run, so every compared repository carries a `main` SHA and resolution time in
provenance. `main` in a primary range is replaced by that SHA; an unrequested repository's
`baselineCommit...candidateCommit` range stays pinned to the two recorded commits. The `main-moved`
compare depends on the primary compare's merge base, so it runs second.

**Differences** — `classifyDifferences(settings, baselineIdentity, candidateIdentity, compares)`:

- Primary repository entries: `{ repo, requested_ref, recorded_commit, main_sha, ahead_by, commits
  (first 20), omitted }`. When `ahead_by === 0`, `note: 'none-missing-from-main'` and, if the
  requested ref is not `main`, `may_have_merged: true`.
- Primary settings: each set role or `skip_validator` whose candidate value differs from the
  baseline's (profile strings compared as `cli:model:effort` only).
- Ancillary: `main-moved` (both SHAs, `ahead_by`, `behind_by`), unrequested repository commit
  changes (both SHAs, ahead/behind), unrequested role fields from `compareIdentity`, the `agent`
  field of every role whose `agent` differs (requested roles included: a requested profile covers
  only `cli:model:effort`), and workflow
  fields other than a requested `skip_validator`. `fixture_commit` and rubric fields never appear
  here because they refuse earlier; `runner_commit`/`skills_commit` raw identity differences are
  represented by the repository entries instead.

**Metrics** — `compareMetrics(baselineReps, candidateReps, roleCosts)`:

- Both sides are re-summarized with #58's `summarize` from their repetitions (the stored record
  summary is not reused, so both sides use the same code path).
- Per-role cost: `roleCosts(result)` returns `{ complete, by_role }`: `complete` mirrors the result's
  `cost.total.complete`; `by_role[role]` sums `cost.amount_usd` over rows with that `agent_role`. A
  baseline repetition whose result directory is unreadable or whose `run_id` differs from the record
  gets `{ complete: false }`. Roles reported: `lead`, `implementor`, `tester`,
  `implementation-validator`, plus any role found in either side's rows; a role absent from a complete
  repetition counts as 0.
- Completeness is joint: a token or cost metric is compared only if every repetition on both sides
  is complete for it; otherwise the metric is `{ status: 'incomplete', missing_run_ids }` (both sides'
  missing ids). Automated score and active time follow #58's `metric` completeness per side; if either
  side is incomplete the band is `incomplete`.
- Each comparable metric yields `{ baseline: stats, candidate: stats, delta, delta_pct, band }`.

**Band** — `band({ kind, base, cand })` where `kind` is `score` or `resource`:

```
s = stddev ?? 0
sd = sqrt(((n1-1)·s1² + (n2-1)·s2²) / (n1+n2-2))         // n1+n2-2 ≥ 1 because n2 ≥ 2
if kind == score: sd = max(sd, 3.0)
se = sd · sqrt(1/n1 + 1/n2)
z  = se > 0 ? Δ/se : (Δ == 0 ? 0 : ±Infinity)
level = |z| ≥ 1.96 ? clear : |z| ≥ 1.28 ? leaning : same
if kind == resource and level == clear and |Δ%| < 15: level = leaning   // undefined Δ% with Δ≠0 passes
direction = level == same ? null : (score: Δ>0 better; resource: Δ<0 better)
```

`Δ%` is `Δ / base.mean × 100`; `null` (undefined) when the base mean is 0 and Δ ≠ 0; 0 when both are
0. `z` is kept in the report (as `null` for infinite in JSON, with `z_infinite: true`) so readers can
audit the band. When the better side contains a product failure, the band carries
`includes_product_failures: true`.

**Flags** — `reliabilityFlags(candidateReps, baselineSummary)`: per candidate repetition, a
`gate` flag when any `gates.verdicts[].verdict === 'fail'`, `gates.passed === false`, or
`failure.product_failure` is non-null (reason from `product_failure.phase`/`reason`, gate ids from
`failures[].id` and failed verdicts); a `score-shortfall` flag when `baseline mean − points > 6`.
When the baseline mean is incomplete, the report records `shortfall_check: 'unavailable'`.

**Human review** — medians with #58's `selectMedian` on both sides; baseline from
`current.human_review` (run id, official score, points/possible, `is_current_median`); candidate
median's `outcome.official_score` and the extracted review snapshot's points/possible when
`outcome.human_review_complete`, else `status: 'pending'`.

**Report object** — `buildReport` returns a plain JSON-serializable object:
`{ schema_version: 1, status: 'compared', eval_issue, request: { settings, hash }, baseline: {
source, set_at, repetitions, run_ids }, candidate: { repetitions, run_ids }, differences: { primary,
ancillary, baseline_mismatches }, metrics, flags, human_review, provenance: { repositories: [{ repo,
main_sha, resolved_at, compares: [{ kind, range, status }] }] } }`. `--json` prints exactly this
object; Markdown renders the same fields.

### `lib/comparison-format.mjs`

- `formatMarkdown(report, { limit = 65_536 })`: sections in spec order — header, primary
  differences, ancillary differences, baseline repetition mismatches (only when any), metrics table
  (metric | baseline mean ± sd [min–max] | candidate mean ± sd [min–max] | Δ | Δ% | band), reliability
  flags, human review, provenance. Units: score 2 decimals, tokens integers with thousands
  separators, active time minutes with 1 decimal, cost USD 2 decimals. Bands render as `same`,
  `leaning better`, `clearly worse`, with `(includes product failures)` when marked.
- Size enforcement: render; if over the limit, re-render with commit lists capped at 5, then 0 (count
  only), then mismatch lists capped at 5, then 0 (count only), each with "… and N more". Metrics,
  bands and flags are never trimmed. A final over-limit result throws (an internal error, exit 2) —
  unreachable in practice given the bounded remaining content, and covered by a test.
- `formatRefusals(refusals, { json })`: Markdown "Comparison refused" heading plus one bullet per
  refusal (`code`, run id or directory, message), or `{ status: 'refused', refusals }`.

## Decisions

1. **Pure core, thin I/O shell.** Matches #58 (`experiment-baseline.mjs` pure, `experiments.mjs`
   I/O) and lets every band, flag and classification rule be unit-tested from literals. GitHub is
   the only network dependency and is isolated in one module with an injectable `exec`.
2. **Recompute both sides' statistics from repetitions** instead of reading `current.summary`. The
   joint-completeness rule and per-role cost need per-repetition values anyway, and using
   `summarize` for both sides guarantees identical semantics. The stored summary stays authoritative
   for `baseline show` only.
3. **Resolve `main` to a SHA first, then compare SHAs.** This makes "once per repository per report"
   true by construction and gives the provenance SHA directly, at the cost of one extra API call per
   repository.
4. **Compare-derived counts for ancillary commit differences** (`ahead_by`/`behind_by`) rather than
   listing commits: ancillary context is for awareness, and counts keep the comment short.
5. **Line-based TOML subset parser** with explicit rejection of everything else. Eval blocks are flat
   by the factory's schema (no table keys are accepted), so the subset is complete for valid
   requests, and rejecting the rest is the issue's "refuse rather than guess".
6. **No default settings applied to the request.** Primary vs ancillary depends on which keys were
   set, so defaults (which live in the factory's configuration) are irrelevant and not duplicated.
7. **`skip_validator` normalization** maps the recorded `"true"`/`"false"` strings to booleans before
   comparing with the request and with the baseline.
8. **Exit codes follow #58:** 0 compared, 1 refused, 2 usage/I/O/internal error.

## Risks / Trade-offs

- **Live `main` drift.** Attribution is computed against `main` at report time; a merged branch
  yields no primary commits. Mitigated by the provenance SHA/time and the `may_have_merged` note;
  using the factory's frozen-input comment was rejected (cross-repository format coupling, and it
  records no admission-time `main` either).
- **GitHub rate limits or auth.** A missing `gh` login fails every comparison. Refusing with
  `eval-issue-unreadable`/`github-compare-failed` and the `gh` message makes the cause visible; at most
  seven API calls per report (the issue, a `main` lookup and up to two compares per repository)
  keeps usage small.
- **Small samples.** With n = 2 the noise floor and the 15% rule do most of the work; the bands are
  conservative by design (issue decision 1). Nothing extra is attempted.
- **Baseline result directories pruned or moved.** Only per-role cost degrades to "incomplete";
  totals still come from the record.
- **Exporting #58 internals** widens that module's surface slightly; the rename of `overlapping` is
  mechanical and covered by the existing #58 tests.

## Verification

New `test/experiment-comparison.test.mjs` (in the existing `node --test test/*.test.mjs` suite),
reusing the `makeResult`-style builder pattern from `test/experiment-baseline.test.mjs`:

- **Pure unit tests:** TOML subset (valid values, each rejected construct, duplicates, CRLF),
  block extraction (0/1/2 blocks), request validation per key; admission (overlap by each lineage
  field, too few, identity mismatch, rubric/fixture on a later baseline repetition, null values);
  request check (profiles, string `skip_validator`); compare planning for requested / unrequested /
  equal repositories; classification including `may_have_merged`, a requested role with only `agent`
  changed, and a requested profile change plus an `agent` change (the `agent` change stays ancillary in
  both); `band` against the spec's worked
  scenarios (60/60 vs 62/62 ⇒ same; Δ = 7 ⇒ clear; 10% resource ⇒ leaning; zero variance; zero base
  mean); joint completeness and per-role zero-fill; unscored product failure ⇒ score incomplete and
  product-failure marks; flags (gate, product failure before scoring, 6.5 shortfall, unavailable);
  medians and pending vs complete candidate review.
- **Integration tests** per `test-plan.md`: INT-001 (real `spawnSync` against a stub `gh`, including a
  compare whose raw JSON exceeds 1 MiB), INT-002 (copied published results), INT-003 (synthetic
  unscored product failure from files to report), and E2E-001 (provenance for requested and
  unrequested repositories).
- **CLI tests** through `runExperimentsCommand` with temp directories and a fake `exec` that answers
  `gh api` paths from a table: successful Markdown and JSON reports with identical content; refusal
  output (stderr JSON lines, stdout summary, exit 1) listing several refusals at once; usage errors
  (exit 2); a GitHub failure; record and result directories byte-identical afterwards; the Markdown
  size cap with an oversized commit list; `--help` listing `compare`.
- Existing `test/experiment-baseline.test.mjs` must pass unchanged after the export refactor.
- `package.json` `check` gains `node --check` for `lib/eval-request.mjs`, `lib/github-read.mjs`,
  `lib/experiment-comparison.mjs` and `lib/comparison-format.mjs`; then `npm run check`.
- No real-browser suite is affected.

## Migration Plan

Additive. No record or result format changes; `baseline` commands keep their behavior. The suite
README's experiment section gains a `compare` subsection (usage, GitHub access requirement, reading
the bands). Rollback is reverting the change.
