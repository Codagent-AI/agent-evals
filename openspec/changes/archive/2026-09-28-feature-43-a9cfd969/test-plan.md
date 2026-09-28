## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional
integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only
obligations.

The following unit-level behavior is not repeated here. It is pinned by unit tests derived from the
specs and from `design.md`'s test plan:

- source-format derivation;
- the cache-write and context-tier assumptions;
- exact-match rules and the source chain;
- verification ordering;
- fallback-table validation;
- step-path parsing and the rollup arithmetic;
- report escaping.

The obligations below cover the places where real modules and real files must work together. A defect
at those seams would pass isolated unit tests. The main examples are:

- normalization handing envelopes and source formats to pricing;
- the checked-in fallback file reaching the resolver;
- the controller's rescore path actually repricing;
- `result.json` reaching `report.html`.

Every automated obligation runs in `npm run check` (`node --test test/*.test.mjs`). None needs network
access, Docker, or model calls. models.dev and the pricing judge are replaced with the injected
`fetchImpl`/`pricingFetch` and `judgeInvoke` seams that the suite already uses.

**Shared fixture.** The fixture is a trimmed copy of
`evals/agent-runner/and-scene/results/d7f384ba-0e94-4926-852e-6662fec752be-rep-1/result.json`, placed
under `test/fixtures/`. It contains:

- one Runner Codex `generate-code` attempt (implementor, `codex:turn.completed`);
- one Runner Codex tester attempt (`prepare-acceptance`);
- two Claude lead attempts with Runner-reported cost (`complete-task-index` and a top-level
  `run-validator/…/fix-violations`);
- two Agent Validator attempts (`codex-exec-jsonl-turn.completed`, null model, cache writes marked
  `codex_usage_not_observed`) attributed under `implement-tasks:0/…`;
- one synthetic copy of the Runner Codex attempt whose usage collection is partial (its
  `normalized_total` envelope is unavailable, and the category counts are left intact).

A models.dev excerpt pins the three observed models as retrieved on 2026-09-27, including both tier
representations for `gpt-6-luna` (`tiers[].size: 272000` and `context_over_200k`).

## Integration Tests

### INT-001: Retained Runner and Validator measurements price and roll up end to end through the real modules
- **Covers:**
  - Estimated attempt pricing (source-established uncached input, the cache-write assumption, and the
    context-tier assumption for totals over the threshold).
  - Real-time pricing resolution (models.dev `estimated`; `reported` is kept; the identity reason for
    Validator attempts).
  - Agent-and-model implementation cost aggregation (single-identity row attribution, row and total
    verification, unresolved Validator attempts blocking the total).
  - Per-step implementation cost (steps, Validator attribution, weakest-state rollup, unavailable
    child).
- **Boundary:** real `runner-metrics` normalization and `refreshBillingTokens` over retained attempt
  records, then real `pricing.resolveImplementationPricing` with a catalog from `fetchPricingCatalog`
  (injected `fetchImpl` serving the models.dev excerpt bytes), then real
  `cost.aggregateImplementationCost`.
- **Setup:** the shared fixture's attempts, with billing fields stripped so they must be re-derived from
  `token_envelopes`; the fallback table loaded from the checked-in file; no judge invoker.
- **Action:** refresh billing tokens, resolve pricing, aggregate cost.
- **Assertions:**
  - The Runner Codex `generate-code` attempt resolves with `source: models.dev` and
    `verification: estimated`. Its amount is 0.03062482 USD (±1e-9). Its assumptions include both
    `cache_write_not_reported_priced_as_input` and `context_tier_unknown_priced_at_base`.
  - Claude attempts keep `agent-runner-reported`/`reported`.
  - Validator attempts are unavailable with reason
    `exact provider and model identity are required for pricing`.
  - The partial-collection Codex copy is unavailable. Its reason states that token usage collection is
    incomplete, not `no reported token usage to price this attempt with`.
  - `cost.rows` has an `implementor/openai/gpt-6-luna` `attempt` row with a numeric amount and
    `verification: estimated`. The lead row carries its reported amount.
  - `cost.total` is unavailable. Its known subtotal equals the sum of resolved amounts, and it states
    that it includes estimated figures.
  - `cost.steps` has one entry per CLI attempt.
  - The `implement-tasks` rollup contains the Codex implementor attempt and both Validator attempts. Its
    amount is null, its known subtotal is numeric, and its verification is `estimated`.
  - The `run-validator` rollup contains only the lead fix attempt.
- **Execution:** `test/cost-aggregation.test.mjs` (or a new `test/step-cost-integration.test.mjs`), run
  by `npm run check`.

### INT-002: Complete pricing reconciles steps to the total
- **Covers:**
  - Per-step implementation cost (reconciliation).
  - Pricing verification ordering (total and rollup).
  - Independent completeness reporting (`completeness.pricing` is `estimated`).
- **Boundary:** the same real pipeline as INT-001, then real `result.mjs` result assembly.
- **Setup:** the shared fixture with the Validator attempts given an exact `openai/gpt-6-luna` identity,
  standing in for agent-validator#160.
- **Action:** refresh, price, aggregate, assemble the result.
- **Assertions:**
  - `cost.total` is numeric, with `verification: estimated`, `includes_estimated: true`, and
    `includes_unverified: false`.
  - The sum of `step_rollup[].amount_usd` equals `cost.total.estimated_api_cost_usd` within 1e-9.
  - Every rollup is complete.
  - `pricing.verified` is false.
  - The Validator attempts resolve as `estimated`. Their provenance keeps the original cache-write
    reason `codex_usage_not_observed` next to `cache_write_not_reported_priced_as_input`.
  - `completeness.implementation_cost` is `complete` and `completeness.pricing` is `estimated`.
- **Execution:** `test/result-assembly.test.mjs`, run by `npm run check`.

### INT-003: Checked-in fallback table reaches the resolver when models.dev is unavailable, and an invalid table degrades to the judge
- **Covers:**
  - Pinned fallback pricing table.
  - Real-time pricing resolution (fallback-table source; similar names never match; judge
    fall-through).
  - Pricing schedule disclosure.
- **Boundary:**
  - Real `loadFallbackRates` reading from the filesystem: the checked-in
    `evals/agent-runner/and-scene/pricing/fallback-rates.json` and invalid copies in a temporary
    directory.
  - Real `fetchPricingCatalog` with an injected failing `fetchImpl`.
  - Real `resolveImplementationPricing` with a recording fake judge invoker.
- **Setup:**
  1. The checked-in table; a catalog fetch that throws.
  2. A temporary table with a duplicate `provider/model` row.
  3. An attempt whose model is a near name of a table row (for example `gpt-6-luna-mini`).
- **Action:** resolve pricing for the shared Codex attempt under each setup.
- **Assertions:**
  1. The checked-in table validates. The Codex attempt resolves with `source: fallback-table` and
     `verification: estimated`. Its provenance records the row's `source_url` and `retrieved_date`, and
     the table path and SHA-256 hash. The judge is not invoked. `pricing.catalog.state` is
     `unavailable` with a reason, and `pricing.fallback_table` records the path, state, and hash.
  2. `pricing.fallback_table.state` is `unavailable` with a duplicate-row reason, and the judge is
     invoked.
  3. Neither source matches, and the judge is invoked.
- **Execution:** `test/pricing.test.mjs`, run by `npm run check`.

### INT-004: Evaluator-only rescore reprices imported attempts through the controller
- **Covers:**
  - Pricing re-resolution on evaluator-only rescore.
  - Real-time pricing resolution (Runner-reported costs are kept).
- **Boundary:** the real `controller.mjs` `evaluate()` with `--rescore-from`, the real `metrics-pricing`
  phase, and real `runner-metrics`, `pricing`, and `cost`. It uses the controller's existing injected
  seams: `loadRescoreSource`, `pricingFetch`, `judgeInvoke`, and the browser/judge stubs used by the
  current rescore tests.
- **Setup:**
  - An imported source whose `implementation_metrics.attempts` are the shared fixture and whose
    `pricing` and `cost` are the original unpriced values from the published result.
  - `pricingFetch` serves the models.dev excerpt.
  - The source directory is a temporary directory whose files are hashed before the run.
- **Action:** run the rescore to completion.
- **Assertions:**
  - `phases/metrics-pricing.json` and the result's `pricing` show re-resolution: `repriced_from`
    carries the source run id and provenance hash.
  - The Runner Codex attempts are `estimated`, and the Claude attempts keep their reported amounts.
  - `cost.steps` and `cost.step_rollup` are present.
  - The source directory's file hashes are unchanged.
  - No Agent Runner invocation occurs.
  - A second case passes a directory that contains only the published-result files (`result.json`,
    `report.html`, `ambiguity-ledger.json`, `implementation.diff`, `artifact-manifest.json`) to the real
    `loadCandidateRescoreSource`. It is rejected, and no result is written.
- **Execution:** `test/controller.test.mjs` and `test/rescore.test.mjs`, run by `npm run check`.

### INT-005: `result.json` renders the per-step and pricing sections in a self-contained report, including a pre-feature result
- **Covers:**
  - Per-step cost report.
  - Self-contained HTML report (the role/model table is kept; offline; escaped).
  - Pricing schedule disclosure (rendered).
- **Boundary:** a result assembled by real `result.mjs` from the INT-001 pipeline output, then real
  `report.mjs` HTML generation, written to a temporary run directory.
- **Setup:**
  1. The INT-001 result, with one step path altered to contain `<script>` markup.
  2. The unmodified published
     `results/d7f384ba-0e94-4926-852e-6662fec752be-rep-1/result.json`, read in place and not edited.
- **Action:** generate `report.html` for each.
- **Assertions:**
  1. The report contains the per-step table grouped by top-level step, with each group's attempt count,
     amount or "unavailable", known subtotal, and verification.
     - Child rows show the step path, role, model, tokens, cost or reason, source, verification, and
       assumptions.
     - The agent-and-model table is still present.
     - The Pricing sources section shows the catalog and fallback-table identity.
     - No serialized `pricing.costs` array appears.
     - The markup renders as inert escaped text.
     - The report references no external assets.
  2. The report renders without error, states that per-step cost was not recorded, and still shows the
     role/model table.
- **Execution:** `test/report.test.mjs`, run by `npm run check`.

### INT-006: A multi-model dispatch with only a whole-attempt reported cost reconciles through aggregation and the report
- **Covers:** Agent-and-model implementation cost aggregation (the cost-only `unattributed_cost` row;
  total equal to the sum of rows); Per-step implementation cost; Per-step cost report.
- **Boundary:** real `pricing.resolveImplementationPricing`, then real
  `cost.aggregateImplementationCost`, then real `result.mjs` result assembly, then real `report.mjs`
  HTML generation into a temporary run directory.
- **Setup:** a synthetic schema-v4 attempt with two attributed allocations (`anthropic/claude-opus-5-5`
  and `anthropic/claude-sonnet-5`), each with its own usage. It has a Runner-reported, exhaustive
  whole-attempt USD cost and no per-allocation costs. The shared fixture's resolved Runner Codex
  attempt is included, with the Validator attempts omitted so that the total is complete.
- **Action:** price, aggregate, assemble, and render.
- **Assertions:**
  - Both model rows keep their token usage, have cost state `not_allocated`, and are not listed as
    unresolved.
  - One `unattributed_cost` row for the lead role carries exactly the reported amount, with no tokens.
  - `cost.total` is numeric and equals the sum of all row amounts within 1e-9.
  - The dispatch count counts the attempt once.
  - Its `cost.steps` entry carries the whole amount, and the step rollups sum to the total.
  - `report.html` shows the cost-only row in the role/model table, labelled as a whole-attempt cost
    that is not divided among models.
- **Execution:** `test/cost-aggregation.test.mjs` for the aggregation and `test/report.test.mjs` for
  the rendering, run by `npm run check`.

## End-to-End Tests

None. The public entry point is `evals/agent-runner/and-scene/run.sh`. Every journey through it that
reaches pricing needs one of two things:

- a paid candidate run (Docker, Agent Runner, and model calls); or
- an evaluator-only rescore that reruns the paid LLM product judges and browser evaluation.

Neither is stable or free enough for automated CI. The pricing-relevant journey is covered through the
controller's public `evaluate()` entry, with its existing injected seams, in INT-004. Its report output
is covered in INT-005.

## Acceptance Testing Envelope

- **Environments and sandboxes:**
  - The local repository checkout, with Node and `npm run check`.
  - Temporary directories under the OS temp dir.
  - The retained private run directory
    `~/.agent-factory/artifacts/d7f384ba-0e94-4926-852e-6662fec752be-rep-1`. Use it read-only, and copy
    it to a temporary directory before any tool writes beside it.
  - The published results under `evals/agent-runner/and-scene/results/`, read-only.
  - The pass may write small throwaway Node scripts that call the suite's library modules or
    `evaluate()` with stubbed judges and browser, to exercise pricing, per-step output, and report
    rendering over real retained data.
- **Credentials and secrets:** none are required. Codex, Claude, and GitHub credentials may exist on the
  host, but they are not authorized for use in this pass.
- **Authorized effects:**
  - Unauthenticated GET requests to `https://models.dev/api.json`. These are free and read-only.
  - Creating and deleting temporary files and directories. Clean them up afterwards.
  - Generating `report.html` files in temporary directories and inspecting them, including in a local
    browser through `chrome-devtools-axi`.
- **Off limits:**
  - Paid candidate runs (`run.sh --run-agent`).
  - A full `run.sh --rescore-from`, which invokes paid LLM judges.
  - The live pricing judge's web search.
  - Docker and Agent Runner workflows.
  - Pushing branches, creating PRs, or publishing results.
  - Editing anything under `evals/agent-runner/and-scene/results/**`.
  - Modifying the retained private run directory in place.
  - Changing `fallback-rates.json` rates, other than in temporary copies.
- **Permitted substitutes:**
  - A recorded or stub pricing-judge invoker in place of the live web-search judge.
  - A stubbed `pricingFetch` serving saved models.dev bytes when the live endpoint is unavailable. When
    it is available, prefer one live fetch to check that the tier shapes still parse.
  - Injecting an exact Validator model identity into a copy of the attempts, standing in for
    agent-validator#160, to observe complete-total behavior.
  - Stubbed browser and product judges when driving `evaluate()` for rescore.
- **Known risk areas:**
  - **Row-key change.** Single-identity attempts move from `unallocated/null/null` rows to
    resolved-identity `attempt` rows, a known prior defect in which every row showed a null amount.
    Check that multi-model attempts still split correctly.
  - **models.dev tier shape drift.** `tiers[].size` and `context_over_200k` disagree. Neither is
    preferred. Known sizes in the disputed range must be disclosed as
    `context_tier_ambiguous_priced_at_base`.
  - **Producer reason vocabularies.** Only `not_reported`, and `codex_usage_not_observed` for the
    Validator's Codex format, count as "cache writes not reported". Partial usage collection is never
    priced.
  - **Multi-model dispatches with only a whole-attempt cost** must reconcile through an
    `unattributed_cost` row.
  - **Rounding reconciliation** between step rollups and the total.
  - **`pricing.verified` and `completeness.pricing` semantics.** `estimated` is now distinct from
    `unverified`.
  - **Older published results** must still render without per-step data.
  - **Checkpoint resume of `metrics-pricing`** must restore the new fields.
  - **Unattributed Validator attempts** (no Runner attribution) must appear in the unattributed rollup,
    not vanish.
- **Accepted limitations:**
  - Validator attempts stay unpriced until agent-validator#160, so real runs keep an unavailable total.
  - Cache writes are priced as input.
  - Tier rates are never applied for current producers.

## Human-Only Testing

None.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| Estimated attempt pricing | INT-001, INT-002 | — | — |
| Real-time pricing resolution | INT-001, INT-003, INT-004 | — | — |
| Pinned fallback pricing table | INT-003 | — | — |
| Pricing verification ordering | INT-001, INT-002 | — | — |
| Pricing schedule disclosure | INT-003, INT-005 | — | — |
| Agent-and-model implementation cost aggregation | INT-001, INT-002, INT-006 | — | — |
| Independent completeness reporting | INT-002 | — | — |
| Per-step implementation cost | INT-001, INT-002, INT-006 | — | — |
| Per-step cost report | INT-005, INT-006 | — | — |
| Pricing re-resolution on evaluator-only rescore | INT-004 | — | — |
