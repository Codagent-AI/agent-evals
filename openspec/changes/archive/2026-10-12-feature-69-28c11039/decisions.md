# Decisions

## propose

1. **Verdict: go.**
   - Alternatives: no-go (keep comparing results by hand); defer.
   - Why: the dependency agent-evals#58 is merged (`experiments.mjs`, `lib/experiment-baseline.mjs`,
     `experiment-baseline-record` spec), the issue fixes the statistics and scope, and manual
     comparison is the cost the eval loop exists to remove.
   - Decision-bearing: yes.

2. **Baseline per-role cost is read from the baseline repetitions' published result directories**,
   not from the record; an unreadable baseline result makes per-role cost "incomplete".
   - Alternatives: add per-role cost to the record (changes a persisted data format — a stop
     trigger); report per-role cost for the candidate only (not a comparison); refuse the whole
     report when a baseline result is missing.
   - Why: the record stores only per-repetition cost totals; published results are committed under
     `results/<run_id>/` and already carry `cost.rows[].agent_role`.
   - Decision-bearing: yes.

3. **Accept `crosscheck` as an eval-block key and treat it like the other role profiles.**
   - Alternatives: accept only the keys listed in the issue's parenthetical (would refuse valid
     factory requests); accept but ignore it.
   - Why: the issue says "the same keys the factory accepts"; the factory's `parse_request` accepts
     `lead`, `crosscheck`, `implementor`, `tester`, `skip_validator`, `repetitions`,
     `agent_runner_ref`, `agent_skills_ref`, `fixture_ref`. The parenthetical is read as illustrative.
   - Decision-bearing: no (follows the issue's governing rule).

4. **Strict in-repo parser for the flat TOML subset used by eval blocks.**
   - Alternatives: add a TOML dependency (needs explicit approval per AGENTS.md); shell out to
     Python `tomllib`.
   - Why: no new runtime dependencies; eval blocks are flat `key = value` with strings, booleans and
     integers; anything outside the subset is refused, matching "refuse rather than guess".
   - Decision-bearing: no.

5. **A failed GitHub compare call is a refusal.**
   - Alternatives: list primary differences as unknown and continue.
   - Why: the issue requires refusing rather than guessing when the request cannot be read; an
     incomplete primary list would misattribute effects in the same way.
   - Decision-bearing: no.

6. **(Superseded by 9.) Candidate repetitions must share one identity (runner, skills, workflow, roles, rubrics,
   fixture); otherwise refuse.**
   - Alternatives: compare a mixed set.
   - Why: they come from one frozen eval request; mixed identities would make the primary/ancillary
     list ambiguous. Mirrors #58's one-runner-commit rule.
   - Decision-bearing: no.

7. **Modify `experiment-baseline-record` "Command-line usage errors"** so `experiments.mjs` accepts
   `compare`; the `baseline` commands and record format are unchanged.
   - Alternatives: a separate `compare.mjs` entry point (contradicts the issue's CLI).
   - Decision-bearing: no.

8. **Use the `gh` CLI behind an injectable executor** for the issue body and compare API.
   - Alternatives: raw `fetch` with a token.
   - Why: the suite already depends on `gh` for GitHub access; injection keeps tests offline.
   - Decision-bearing: no.

## proposal-review

9. **PR-001 (cohort integrity) — applied.** Candidate repetitions must share one recorded identity
   (refuse otherwise); rubrics and fixture are checked on every repetition of both sides, not only
   the baseline's first-repetition identity; other within-baseline mismatches admitted by #58's
   `--allow-mismatch` are listed with their recorded reason rather than refused.
   - Alternatives: refuse any heterogeneous baseline (would make baselines #58 deliberately accepts
     unusable); suppress the band for heterogeneous baselines (hides a comparison the operator
     already accepted when setting the baseline).
   - Decision-bearing: yes (listing, not refusing, waived within-baseline differences).

10. **PR-002 (lineage overlap) — applied.** Admission refuses duplicate executions and
    original-plus-rescore pairs among candidates and against baseline repetitions (by `run_id`,
    `rescored_from`, non-null `execution_run_id`); the two-repetition minimum counts distinct admitted
    executions; admission is a pure, all-or-nothing step generalized from #58's lineage check, not
    `applySet`.
    - Alternatives: none credible; overlap breaks the independent-samples SE.
    - Decision-bearing: no.

11. **PR-003 (attribution provenance) — partially applied.** Applied: refuse when the request's role
    profiles or `skip_validator` disagree with the recorded results; resolve `main` once per
    repository; keep the resolved `main` SHA, compare status and a request hash in the report; when the
    recorded commit is already on `main`, say branch-only commits are no longer recoverable instead of
    listing none. Rejected: reading the factory's "Frozen evaluation inputs" issue comment — its format
    is owned by the agent-factory repository (a cross-repository coupling) and the issue specifies the
    eval block; it also records no admission-time `main` SHA, so it would not fix the merged-branch
    case. Not direction-level: live-`main` attribution with recorded provenance is what the issue asks
    for.
    - Decision-bearing: yes.

12. **PR-004 (unscored product failures) — applied.** Unscored product failures stay in their side,
    are never imputed or dropped, and make that side's automated-score statistics and band
    "incomplete" with the run ids; a conclusive product failure counts as a failed gate for the
    reliability flag, naming phase and reason; favorable resource bands on a side with product
    failures are qualified.
    - Alternatives: impute zero (invents a score); drop unscored runs from the score average (biases
      toward success, contradicts "keep product failures").
    - Decision-bearing: yes (treating a pre-scoring product failure as a failed gate).

## spec

13. **Compare options `--record` and `--baseline-results`.** `--record` mirrors the `baseline`
    commands' default record; `--baseline-results` (default: the suite's `results/` directory) is
    where baseline repetitions' published results are re-read for per-role cost. The proposal's earlier
    "alongside the candidate directories" default was replaced, because candidate directories can live
    anywhere while published baseline results live in the suite results directory.
    - Alternatives: derive the location from the candidate directories; no override.
    - Decision-bearing: no.

14. **Refusal output.** Exit 1 with every refusal reported at once: JSON lines on stderr (as #58 does)
    plus a short Markdown refusal summary on stdout, or `{status: "refused", refusals: [...]}` with
    `--json`, so a later factory ticket can post refusals too. Usage errors and I/O errors exit 2.
    - Alternatives: stderr only; stop at the first refusal.
    - Decision-bearing: no.

15. **Band edge cases.** A side with one repetition contributes zero variance to the pooled SD; zero SE
    gives z = 0 for Δ = 0 and infinite otherwise; a zero baseline mean gives an undefined percentage,
    which satisfies the 15% rule when Δ ≠ 0; better/worse direction is higher score, lower tokens,
    time and cost.
    - Alternatives: refuse or print n/a in these cases (would hide real differences in, for example,
      identical-token runs).
    - Decision-bearing: no.

16. **Per-role cost and per-provider tokens.** Report the four named roles plus any other role found
    in cost rows (for example `crosscheck`); a role without a row in a repetition whose total cost is
    complete counts as zero; per-provider tokens follow #58 (absent provider counts as zero).
    - Alternatives: report only the four named roles (would hide crosscheck spend).
    - Decision-bearing: no.

17. **"Failed a gate" includes every product failure**, including component-floor failures and
    failures before scoring, besides `fail` verdicts and `gates_passed: false`.
    - Alternatives: only `score.gates` verdicts (misses component floors and pre-scoring failures).
    - Decision-bearing: no (extends decision 12).

18. **Comment size.** Markdown is capped at GitHub's 65,536-character comment limit; commit lists show
    at most 20 commits per repository; when still too long, commit and mismatch lists are shortened
    with omitted counts, never metrics, bands or flags.
    - Decision-bearing: no.

19. **Ancillary commit detail.** For a repository the request did not set, report both SHAs and
    ahead/behind counts; for a requested repository, report `main` moving between the baseline commit
    and the merge base with the commit count. Both use the GitHub compare API and its failure refuses.
    - Decision-bearing: no.

20. **No open pull requests touch `experiment-baseline-record`** (checked 2026-10-12), so the MODIFIED
    "Command-line usage errors" block was copied from `main` with its scenario header unchanged.
    - Decision-bearing: no.

## design

21. **Module split: pure core, thin I/O shell.** New `lib/eval-request.mjs`, `lib/github-read.mjs`,
    `lib/experiment-comparison.mjs`, `lib/comparison-format.mjs`; `experiments.mjs` gains `compare`
    dispatch with an injectable `exec`. `lib/experiment-baseline.mjs` only exports existing internals
    (field lists, `stats`, `overlapping` renamed `lineageOverlaps`).
    - Alternatives: one large comparison module; a separate `compare.mjs` entry point.
    - Decision-bearing: no.

22. **Both sides re-summarized from repetitions with #58's `summarize`**; the stored `current.summary`
    is not reused.
    - Alternatives: read the baseline's stored summary (would need separate joint-completeness and
      per-role logic and could drift from the candidate's path).
    - Decision-bearing: no.

23. **Resolve `main` to a SHA once per requested repository, then compare SHA ranges**; the
    `main-moved` compare uses the primary compare's merge base.
    - Alternatives: compare `main...<commit>` by name each time (no single SHA for provenance).
    - Decision-bearing: no.

24. **Normalize recorded `workflow.skip_validator` strings (`"true"`/`"false"`) to booleans** before
    comparing with the request and the baseline; any other recorded value mismatches a request.
    - Why: published results record the string form; the request uses a TOML boolean.
    - Decision-bearing: no.

25. **No factory defaults applied to the parsed request**; only keys the request set matter for the
    primary/ancillary split.
    - Decision-bearing: no.

26. **Eval-block extraction normalizes CRLF** before the factory's block pattern.
    - Alternatives: match the factory byte-for-byte (would refuse GitHub bodies saved with CRLF).
    - Decision-bearing: no.

27. **Band audit fields:** the report keeps `z` (null plus `z_infinite: true` when SE is zero and
    Δ ≠ 0); exit codes follow #58 (0 compared, 1 refused, 2 usage/I/O/internal).
    - Decision-bearing: no.

28. **Markdown size enforcement trims commit lists (20 → 5 → count only), then mismatch lists**, never
    metrics, bands or flags; an unreachable final overflow is an internal error.
    - Decision-bearing: no.

## test-plan

29. **Automated obligations: INT-001 (real `gh` subprocess against a stub on `PATH`), INT-002 (copies
    of real published schema-8 results through the CLI), E2E-001 (operator journey through the real
    entry point as a child process).** Everything else is unit-tested in pure modules.
    - Alternatives: injected `exec` only (never exercises argv/spawn/JSON boundary); live GitHub in CI
      (needs credentials and network, flaky).
    - Decision-bearing: no.

30. **Synthetic results for complete-cost and reviewed-candidate paths.** Published schema-8 results
    all report incomplete cost and only `aab6fbe4…-rep-1` has a completed human review, so real data
    can only exercise incomplete and refusal paths.
    - Decision-bearing: no.

31. **Acceptance envelope:** read-only `gh api` calls with the host login are authorized; creating or
    commenting on issues/PRs, writing the in-repo `experiments/baseline.json`, touching `results/**`,
    paid runs and pushes are off limits; a stub `gh` and synthetic results are permitted substitutes
    when real eval issues or data cannot reach a path. Human-only testing: none.
    - Decision-bearing: no.

## approach-review

32. **AR-001 (compare response overflows `spawnSync` buffer) — applied.** Every `gh api` call projects
    its response with `--jq` to the fields used (status, exact ahead/behind, merge base, first 20
    SHA/subject pairs; issue body; `main` SHA), with an explicit 8 MiB `maxBuffer` as a margin only.
    Verified read-only on the cited real range: projected output was about 2.5 KB (`ahead_by` 329).
    INT-001 now includes a successful compare whose raw JSON exceeds 1 MiB.
    - Alternatives: only raise `maxBuffer` (still unbounded); stream with a size cap (more code for no
      benefit given `--jq`).
    - Decision-bearing: no.

33. **AR-002 (`agent` field classification) — applied.** Spec and design now state that a differing
    configured `agent` is ancillary for every role, including requested ones; only the requested
    `cli:model:effort` triple can be primary. Added two spec scenarios and matching classification
    tests.
    - Decision-bearing: no.

34. **AR-003 (provenance for unrequested repositories) — applied.** `main` is resolved once for every
    repository with any planned compare, so each compared repository has a `main` SHA and resolution
    time; unrequested ranges stay pinned to `baselineCommit...candidateCommit`. E2E-001 asserts
    provenance for both repositories. The spec already required this; the design was brought into line.
    - Alternatives: allow null `main_sha` for direct ranges (would change the spec's provenance
      contract).
    - Decision-bearing: no.

35. **AR-004 (unscored product failure lacked a file-to-report test) — applied in part.** Applied:
    `19b861fd-…-rep-1` is now used only for the fixture-mismatch refusal in INT-002, INT-002 no longer
    claims unscored-failure coverage, and new INT-003 drives a synthetic unscored verification-phase
    product failure from result files through the CLI (run counted, score incomplete naming the run,
    flag with phase/reason, qualified favorable cost band). Rejected: using
    `ed89e53e-e0a4-4cec-9998-91f0905447f3-rep-1/-rep-2` as a real scored-failure variant — those
    results use automated rubric 5.0.0 while the reviewed baseline `aab6fbe4…-rep-1` uses 6.0.0, so
    they would be refused as `not-comparable`; E2E-001's synthetic hard-gate failure already covers the
    scored-failure flag.
    - Decision-bearing: no.

## tasks

36. **One implementation task covering the whole change**, written inline in `tasks.md` (goal, sources
    of truth, background facts, build steps, tests, constraints, done-when), as instructed. Acceptance
    and posting the report are listed as non-implementor follow-ups.
    - Alternatives: split per module (instruction requires exactly one task); a separate `tasks/` file
      (only `tasks.md` was requested).
    - Decision-bearing: no.
