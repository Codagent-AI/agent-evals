# Task: Extract `and-scene`'s judging into a shared panel-judging module with no behavior change

## Goal

Move the judging mechanics both suites need out of `evals/agent-runner/and-scene/lib/` into a shared module, `evals/lib/panel-judging/`. `and-scene` must behave exactly as before: same prompts, same input hashes, same verdicts, same scores. A later task changes the protocol; this one only moves code, so any later score change can be traced to that protocol change.

## Background

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Shared panel judging" (step 1) and Decision 12;
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-009`.

Current state:
- This branch has merged `origin/main` with agent-evals PR #81 (`cd7a3fc`). `and-scene` judging is at rubric 12.3.0, protocol `dual-sample-majority-v4`. If `evals/agent-runner/and-scene/lib/judge-jobs.mjs` does not export `JUDGING_PROTOCOL = 'dual-sample-majority-v4'`, stop and report that the merge is missing.
- `evals/agent-runner/and-scene/lib/judge-jobs.mjs` (about 1,840 lines) mixes two kinds of code.
  - **`and-scene`-specific (stays):**
    - `PRODUCT_JUDGE_JOB_IDS`, `JOB_BRIEFS`, `fallbackEntriesFor`, `fixtureDocument`;
    - `criterionRequirement`, `browserLeadSection`, `productJudgeJobs`;
    - `quoteEvidence`, `sourceJudgePrompt`, `evidenceJudgePrompt`, `buildJudgeRequest`, and `runProductJudging`.
  - **Protocol mechanics (move):**
    - limits and constants, `JudgeOutputError`, the result and audit schemas, `judgeResultSchemaFor`;
    - `parseJudgeOutput`, `validateFallbackCitations`, `citationTarget`;
    - `buildSourceAuditRequest`, `parseSourceAuditOutput`, the focused re-cite and missing-criteria requests;
    - `runJudgeJob`;
    - the line-cited tiebreak, span audit, contradiction check, and re-cite;
    - `resolveJudgeSamples`, `disputedCriteria`, `runTiebreak`, `runRobustJudgeJob`, and `verifyCachedRobustJob`.
  - **One dependency to remove:** `isEvidenceJob` reads a hard-coded list of `and-scene` job IDs.
- `lib/judge-invoker.mjs` is the Codex judge invoker. It is generic.
- The moved code also needs `bounded` and `normalizeEvidence` from `lib/browser-eval.mjs`, and `hashJson` and `hashString` from `lib/persistence.mjs`.
- Importers of the judge modules include `controller.mjs`, `score.mjs`, `lib/calibration.mjs`, `lib/publication.mjs`, `lib/second-opinion.mjs`, and tests such as `test/judge-jobs.test.mjs`, `test/judge-invoker.test.mjs`, `test/codex-judge-schemas.test.mjs`, `test/adjudication.test.mjs`, and `test/publication.test.mjs`.

What to build:
- `evals/lib/panel-judging/`:
  - `text.mjs`: `MAX_EVIDENCE_CHARS`, `normalizeEvidence`, `bounded`, and their private helpers, moved verbatim from `browser-eval.mjs`;
  - `hash.mjs`: `hashString` and `hashJson`, with the canonicalization, moved verbatim from `persistence.mjs`;
  - `codex-invoker.mjs`: `judge-invoker.mjs`, moved verbatim;
  - `protocol.mjs`: every protocol mechanic listed above, moved verbatim. `isEvidenceJob(request)` becomes `request.line_citations === 'evidence-view'`.
- `and-scene` keeps working through re-exports:
  - `browser-eval.mjs` and `persistence.mjs` import from and re-export the shared helpers;
  - `judge-invoker.mjs` becomes `export * from` the shared Codex invoker;
  - `judge-jobs.mjs` keeps its suite-specific code, imports what it uses, and does `export *` from `protocol.mjs`;
  - `buildJudgeRequest` sets `line_citations: 'evidence-view'` on evidence-job requests;
  - every former export of these modules is still exported from the same path.
- Prompt text, schemas, limits, protocol identifier, and cache input hashes must not change. Do not edit a string while moving it.
- Add `node --check` entries for the new files to `npm run check`.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development: write `INT-009` first, against the code as it is, and keep it green through the move.
- Do not edit `evals/agent-runner/and-scene/results/**`.
- No paid model calls.

## Spec

This task changes no behavior. `and-scene`'s current `product-quality-scoring` requirement "Robust judge verdicts" (in `openspec/specs/product-quality-scoring/spec.md`) must hold unchanged after the move. Task 07 changes it.

## Test Plan

- `INT-009` (Shared panel-judging extraction changes nothing): `test/panel-judging-extraction.test.mjs`, in `npm run check`.
  - Setup: recorded `and-scene` judge-job records under `dual-sample-majority-v4`, with their expected results, consensus, input hashes, and component scores. Use records from the existing `test/judge-jobs.test.mjs` fixtures, or record them by running `runProductJudging` with a stub invoker before moving any code.
  - Action: replay the records through `verifyCachedRobustJob`, `runProductJudging` with a cache loader, and the scorer.
  - Assert:
    - results, consensus, input hashes, and scores are byte-identical to the values captured before the move;
    - every export `and-scene` modules had before the move still resolves from the same path. Capture the export lists before moving.
- Every existing test passes without modification.

## Done When

- `evals/lib/panel-judging/{text,hash,codex-invoker,protocol}.mjs` exist, and `and-scene` imports them through re-exports.
- `INT-009` passes, and was written and green before the code moved.
- No prompt string, schema, limit, protocol identifier, or input hash changed. Show this with `git diff --stat` and `git diff -M`: the moved blocks appear as moves.
- `npm run check` passes, including the new `node --check` entries, with no existing test modified.
