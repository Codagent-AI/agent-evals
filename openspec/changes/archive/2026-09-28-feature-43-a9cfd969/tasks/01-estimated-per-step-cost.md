# Task: Estimated pricing, fallback rates, and per-step cost for and-scene results

## Goal

Make and-scene results report defensible cost for Codex-backed attempts and report cost for every
workflow step.

- Codex attempts, whose CLI reports no USD cost and no cache-write split, are priced from exact public
  rates. The price is labelled `estimated`, and every assumption is disclosed.
- A pinned fallback rates table keeps pricing reproducible when models.dev fails.
- `result.json` gains `cost.steps` and `cost.step_rollup`.
- `report.html` shows a per-step cost table.
- An evaluator-only rescore reprices retained attempts.

Cost stays report-only and never affects scoring.

## Sources of truth

Read these first. They are normative, and this file only orients you:

- `openspec/changes/feature-43-a9cfd969/specs/evaluation-metrics-reporting/spec.md`: every requirement
  and scenario to satisfy.
- `openspec/changes/feature-43-a9cfd969/design.md`: the components, interfaces, algorithms, and
  decisions. Follow its numbered sections §1 to §6.
- `openspec/changes/feature-43-a9cfd969/test-plan.md`: integration obligations INT-001 to INT-006.
- `openspec/changes/feature-43-a9cfd969/decisions.md`: the rationale for every choice, including the
  applied review findings AR-001 to AR-004.
- `openspec/changes/feature-43-a9cfd969/proposal.md`: scope and out-of-scope items.

## Background

The suite lives in `evals/agent-runner/and-scene/`. Paths below are relative to it unless they start
with `openspec/` or `test/`. Tests live in the repository-root `test/` directory and run through
`npm run check` (`node --test test/*.test.mjs`).

The evaluation facts to build on come from `results/d7f384ba-0e94-4926-852e-6662fec752be-rep-1/result.json`
and models.dev on 2026-09-27.

- **Runner Codex attempts:**
  - `source_provenance.source_format` and `usage_source` are `codex:turn.completed`.
  - The envelopes report `input_total`, `cache_read`, and `output`. `input_uncached` and
    `cache_write` are `unavailable` with reason `not_reported`.
  - `allocations: []`. All usage is in `unallocated_usage`.
  - `provider` and `model` are `openai`/`gpt-6-luna` from launch resolution.
- **Agent Validator Codex attempts:**
  - `usage_source` is `agent-validator:metrics`. The format is in `usage_source_version`
    (`codex-exec-jsonl-turn.completed`).
  - `cache_write` is `unavailable` with reason `codex_usage_not_observed`, which means the field is
    absent from Codex usage when collection is complete.
  - `provider` and `model` are null (agent-validator#160). `prefix` is the Runner attribution prefix.
- **Claude lead attempts:** one attributed `native-observed` allocation and a Runner-reported
  whole-attempt cost.
- **Existing row defect.** Every `cost.rows` entry has `amount_usd: null`, including the fully
  reported Claude lead row. `aggregateImplementationCost` assigns row amounts only from
  `allocation_costs` or from `attempt` fragments. `design.md` §4 fixes this.
- **models.dev entries** may declare context tiers both as `cost.tiers[]` (`tier.type: 'context'`,
  `size: 272000` for `gpt-6-luna`) and as `cost.context_over_200k`. The thresholds disagree, and
  neither is preferred (design §2, Decision 4).
- **Rescore.** `--rescore-from` currently copies `pricing` and `cost` from the source result
  (the `metrics-pricing` phase in `controller.mjs`, around line 1500). `record.metrics` is seeded from
  the source's `implementation_metrics`.

## What to build

The two slices below are built in order. Each slice ends with a green `npm run check` and its own
commit.

### Slice 1: estimated pricing tier and fallback table

1. **`lib/runner-metrics.mjs`** (design §1):
   - Add `deriveBillingTokens(envelopes, sourceFormat, { collectionComplete })`, which covers:
     - the collection-completeness gate;
     - the Codex source-format allowlist;
     - `input_uncached = input_total − cache_read`, with a producer-supplied value taking precedence;
     - recognized cache-write not-reported reasons (`not_reported`, and `codex_usage_not_observed`
       for `codex-exec-jsonl-turn.completed` only), with the original reason preserved;
     - `billing_assumptions`, `billing_derivation`, and `billing_reason`.
   - Use it for attempt usage, allocations, unallocated usage, and native allocations.
   - Export `refreshBillingTokens(attempts)`. Legacy attempts without envelopes are left unchanged.
2. **`lib/pricing.mjs`** (design §2):
   - Add `VERIFICATION_ORDER` and `weakestVerification`.
   - Add `loadFallbackRates`, `validateFallbackRates`, and `lookupFallbackRate` (exact
     `provider` + `model` only).
   - Add `calculateRateCost` with prompt bounds and the context-tier rules: within the lowest
     threshold, above the highest with identical rates, ambiguous, or unknown.
   - Resolution order: reported, then allocations, then billing tokens (using `billing_reason` when
     set), then identity, then models.dev, then fallback table, then judge. Verification is `catalog`
     or `estimated` based on assumptions. The source is `fallback-table` for table prices.
   - Record provenance: assumptions, derivation, context tier, and the table path, hash, and row
     source.
   - `resolveImplementationPricing` accepts `fallbackTable` and returns `verification`,
     `includes_estimated`, `includes_unverified`, a redefined `verified`, and `fallback_table`.
3. **`pricing/fallback-rates.json`** (design §3): `schema_version: 1`, seeded with
   `openai/gpt-6-luna`, `openai/gpt-6-sol`, and `anthropic/claude-opus-5-5` at the models.dev rates
   from 2026-09-27, including the `gpt-6-*` context `tiers`. Use
   `source_url: https://models.dev/api.json` and `retrieved_date: 2026-09-27`. Add a test that loads
   and validates the checked-in file.
4. **`lib/cost.mjs`** (design §4, first half):
   - Single-identity attempts become one `attempt` fragment keyed by the resolved identity, carrying
     the attempt amount.
   - A multi-model attempt resolved only at attempt level marks its model rows `not_allocated` and adds
     an `unattributed_cost` cost-only row.
   - Row verification is `verified`, `estimated`, or `unverified`.
   - `cost.total` gains `verification`, `includes_estimated`, and `includes_unverified`.
5. **`lib/result.mjs`**: `pricingCompleteness` returns `incomplete`, `unverified`, `estimated`, or
   `verified`, with a fallback for older results.
6. **`controller.mjs`** (design §6):
   - `metrics-pricing` loads the fallback table on every path.
   - On rescore, it calls `refreshBillingTokens` on the imported attempts and runs the normal pricing
     and aggregation, instead of copying.
   - It records `repriced: true`, `imported_from`, and `pricing.repriced_from`. The source run is
     never written.
7. **`lib/report.mjs`** (design §5, pricing part):
   - Replace the `Pricing sources` `keyValueRows(result.pricing)` dump with a schedule and summary
     table (catalog and fallback-table identity, verification, flags).
   - Render `unattributed_cost` rows in the role/model table with blank tokens and a "whole-attempt
     cost (not divided among models)" allocation label.

### Slice 2: per-step cost

8. **`lib/cost.mjs`** (design §4, second half):
   - Add `buildStepCosts({ attempts, costs })`, which returns `steps` and `step_rollup`.
   - `step_path` and `top_level_step` are derived as described, with iteration suffixes stripped.
     Validator attempts attribute through `prefix`, and attempts with no step go to an unattributed
     group placed last.
   - Entry fields include `allocations[]` for multi-model attempts.
   - Rollups use first-observed order, known subtotals, null amounts when incomplete, and the weakest
     verification.
   - `aggregateImplementationCost` returns them as `cost.steps` and `cost.step_rollup`.
9. **`lib/report.mjs`**:
   - Add a Per-step cost subsection after the role/model table: one group header per rollup, then
     child rows showing step path, role, model, tokens, cost or reason, source, verification, and
     assumptions.
   - Show "Per-step cost was not recorded for this result." when `cost.steps` is absent.
   - Escape everything.

## Tests

- **Unit tests:** derive them from every scenario in the spec delta and from the Test Plan section of
  `design.md`, in `test/runner-metrics.test.mjs`, `test/pricing.test.mjs`,
  `test/cost-aggregation.test.mjs`, `test/report.test.mjs`, and `test/result-assembly.test.mjs`. The
  issue's required cases are included:
  - a Codex attempt with no cache-write figure resolves as `estimated` with the expected amount;
  - a Claude full partition resolves as `catalog`;
  - an unknown model goes to the fallback table, then to the judge;
  - a similar name never matches;
  - an unknown prompt size gives base rates plus the assumption;
  - Codex formats derive billing tokens, and a non-Codex source missing `input_uncached` does not.
- **Integration tests INT-001 to INT-006** from `test-plan.md`:
  - Build the trimmed fixture from `results/d7f384ba-0e94-4926-852e-6662fec752be-rep-1/result.json`
    under `test/fixtures/`, plus the pinned models.dev excerpt.
  - Use only the injected `fetchImpl`/`pricingFetch`, judge, and browser seams. No network, Docker, or
    model calls.

Expected sample value: the Runner Codex `generate-code` attempt (input_total 1,643,996; cache_read
1,569,792; output 15,013 on `openai/gpt-6-luna`) prices at 0.03062482 USD. Its source is `models.dev`,
its verification is `estimated`, and its assumptions are
`cache_write_not_reported_priced_as_input` and `context_tier_unknown_priced_at_base`.

## Constraints

- No new runtime dependencies.
- Do not edit anything under `evals/agent-runner/and-scene/results/**`.
- Do not change product scoring, gates, or pass conditions.
- Do not reorder the existing no-billed-tokens and identity checks in `resolveAttemptCost`. That
  ordering bug is filed separately. Only replace the generic reason when `billing_reason` is set.
- Do not price an attempt from a default, configured, or similar model. Validator attempts with null
  identity stay unavailable with `exact provider and model identity are required for pricing`.
- Keep the module header rules in `lib/pricing.mjs` and update its header comment for the new source
  chain and the estimated tier.
- Use commit messages of the form `type: lowercase description`.

## Done When

- Every scenario in `specs/evaluation-metrics-reporting/spec.md` is covered by a passing test.
- INT-001 through INT-006 pass under `npm run check`.
- Replaying pricing over the trimmed `d7f384ba-…-rep-1` fixture gives the following:
  - all Runner Codex attempts, 9 implementor and 2 tester in the full result, resolve from models.dev
    as `estimated`, with the cache-write assumption;
  - Claude attempts keep their Runner-reported cost;
  - Validator attempts stay unavailable with the identity reason;
  - `cost.total` is unavailable with a known subtotal and a verification disclosure.
- When every attempt is resolved, `cost.total` is numeric, and it equals both the sum of the
  `cost.rows` amounts and the sum of the `cost.step_rollup` amounts to within 1e-9.
- The checked-in `pricing/fallback-rates.json` validates, and an invalid table fails `npm run check`.
- `report.html` shows the per-step table and the role/model table, and no longer dumps
  `pricing.costs`. A pre-feature published result still renders.
- An evaluator-only rescore reprices the imported attempts without modifying its source run.
- `npm run check` passes at the end of slice 1 and at the end of slice 2. Nothing under `results/`
  changed.
