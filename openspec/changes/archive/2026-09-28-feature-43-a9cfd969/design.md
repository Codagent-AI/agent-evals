## Context

The and-scene suite prices Agent Runner implementation attempts in its `metrics-pricing` phase
(`evals/agent-runner/and-scene/controller.mjs`, around line 1500). The phase works in four steps:

1. `lib/runner-metrics.mjs` normalizes the Runner's native measurements and the Agent Validator's
   measurement heads into attempts. Each attempt carries `usage.token_envelopes` (per-category
   availability, value, and source) and `usage.billing_tokens`. `billingTokensFromEnvelopes` fills
   `billing_tokens` only when `input_uncached`, `cache_read`, `cache_write`, and `output` are all
   available.
2. `lib/pricing.mjs` `resolveAttemptCost` resolves each CLI attempt in this order:
   - the Runner-reported cost;
   - exhaustive provider-reported allocation costs;
   - per-allocation pricing;
   - then, on the attempt's billing tokens, an exact models.dev lookup, then the judge.
3. `lib/cost.mjs` `aggregateImplementationCost` builds `cost.rows` for role, provider, and model,
   plus `cost.usage` and `cost.total`.
4. `lib/report.mjs` renders the rows, and it dumps `result.pricing`, including every `costs[]` record,
   through `keyValueRows`.

These are the facts found in `results/d7f384ba-…-rep-1/result.json` and a live models.dev fetch on
2026-09-27. They shape the design.

- **Runner Codex attempts:**
  - `source_provenance.source_format` and `usage_source` are `codex:turn.completed`.
  - The envelopes report `input_total`, `cache_read`, and `output`. `input_uncached` and
    `cache_write` are `not_reported`.
  - `allocations` is empty. All usage sits in `unallocated_usage`, because the source is limited by
    `model_allocation_unavailable`.
  - `provider` and `model` come from the `launch_resolution` resolved identity (`openai`,
    `gpt-6-luna`).
- **Agent Validator Codex attempts:**
  - `usage_source` is `agent-validator:metrics`. The underlying source format is in
    `usage_source_version`, which is `codex-exec-jsonl-turn.completed`.
  - They have the same envelope gaps as the Runner Codex attempts, and `provider` and `model` are null
    (agent-validator#160).
  - The invoking Runner step is in `source_provenance.runner_attribution.prefix`, which the normalized
    attempt copies to `attempt.prefix`.
- **Claude lead attempts:** they have one attributed `native-observed` allocation and a Runner-reported
  whole-attempt cost.
- **Existing row defect.** In `cost.rows`, every row has `amount_usd: null` and `state: incomplete`.
  This includes the Claude lead row, whose attempts are all resolved. Two things in
  `aggregateImplementationCost` cause it:
  - It gives a row an amount only from `resolution.allocation_costs`, or when the fragment kind is
    `attempt`.
  - Single-identity attempts are always split into `attributed` or `unallocated` fragments. The
    `unallocated` fragments also lose the attempt's provider and model.

  Pricing the Codex attempts without fixing this would leave the role/model table contradicting
  `cost.total` and `cost.steps`.
- **models.dev context tiers.** Entries express tiers in two ways:
  - `cost.tiers: [{ input, output, cache_read, cache_write, tier: { type: 'context', size: 272000 } }]`
  - the legacy key `cost.context_over_200k: { … }`

  Their thresholds disagree for the same model (272,000 vs 200,000). `claude-opus-5-5` has no tier.
- **Rescore.** `--rescore-from` copies `pricing` and `cost` from the source result unchanged. It seeds
  `record.metrics` from the source `implementation_metrics`, which keeps every normalized attempt with
  its envelopes and source formats.
- **Pricing completeness.** `lib/result.mjs` `pricingCompleteness` maps pricing to
  `incomplete`, `verified`, or `unverified` using `pricing.verified`.

## Goals / Non-Goals

**Goals:**
- Price the Runner Codex attempts as `estimated` from exact models.dev rates, with every assumption
  disclosed.
- Add the pinned fallback table, the source chain, the verification ordering, and the pricing schedule
  disclosure.
- Produce `cost.steps` and `cost.step_rollup`, reconciled with `cost.total`, and make `cost.rows`
  consistent with them.
- Render a per-step report table, and reprice on evaluator-only rescore.

**Non-Goals:**
- Resolving the Validator's model identity (agent-validator#160).
- Runner emission of `input_uncached`.
- The reason-ordering bug in `resolveAttemptCost`.
- Agent-factory rendering.
- A result-only replay for published directories.
- Editing historical `results/**`.
- A cohort-fixed pricing schedule.

## Approach

### Data flow

```
Runner/Validator measurements
  └─ runner-metrics.normalize*  ──> attempt.usage.{token_envelopes, billing_tokens, billing_assumptions, billing_derivation}
                                     (same for every allocation / unallocated usage)
rescore: importedRun.implementation_metrics ─> refreshBillingTokens(attempts) ─┘
                                                                              │
loadFallbackRates(path) ─┐   fetchPricingCatalog() (only if needed) ─┐        │
                         └──────────────> resolveImplementationPricing ◀──────┘
                                           per attempt: reported → allocations → models.dev → fallback-table → judge
                                           ──> pricing.{costs[], verification, includes_*, catalog, fallback_table}
                                                              │
                                   aggregateImplementationCost(attempts, costs)
                                   ──> cost.{rows, usage, total(+verification), steps, step_rollup}
                                                              │
                                        result.mjs (completeness.pricing) ─> report.mjs
```

### 1. Billing-token derivation (`lib/runner-metrics.mjs`)

Replace `billingTokensFromEnvelopes(tokens)` with an exported pure function:

```js
deriveBillingTokens(envelopes, sourceFormat, { collectionComplete })
  -> { billing_tokens, billing_assumptions, billing_derivation, billing_reason }
```

It works as follows:

- **Collection completeness gate:**
  - If `collectionComplete` is false, return `billing_tokens: null` with
    `billing_reason: 'token usage collection is incomplete: <producer reason>'`. The producer reason is
    the usage `reason`, or the `normalized_total` envelope reason when there is no usage reason.
  - This applies to exact partitions too. A partial collection can undercount every category.
  - `collectionComplete` is the same condition that already makes `usage.state` `available`:
    - native measurements: the `normalized_total` envelope is available;
    - Validator heads: `completeness.collection === 'complete'` and `normalized_total` is available;
    - allocations: `allocationUsageState(...) === 'available'`.

- `INPUT_INCLUDES_CACHED_SOURCE_FORMATS = new Set(['codex:turn.completed', 'codex-exec-jsonl-turn.completed'])`.
- **Uncached input:**
  - If `input_uncached` is available, use it. `billing_derivation` is `null`.
  - Otherwise, if `sourceFormat` is in the set and `input_total` and `cache_read` are both available,
    compute `input_total − cache_read`. If the result is negative, return
    `billing_tokens: null, billing_reason: 'token category input_uncached has an unusable count'`.
    Otherwise `billing_derivation` is
    `{ input_uncached: 'input_total_minus_cache_read', source_format }`.
  - Otherwise, return `billing_tokens: null`.
- `cache_read` and `output` must be available. For Codex, `output` already includes reasoning, and
  `reasoning` is never added as a billed category. That is today's behavior, and it is kept.
- **Cache writes:**
  - If `cache_write` is available, use it. This is the exact partition.
  - If it is `unavailable` with a recognized not-reported reason, it is omitted,
    `billing_assumptions: ['cache_write_not_reported_priced_as_input']` is set, and `billing_derivation`
    records `cache_write_reason`, the producer's original reason. The recognized reasons come from
    `CACHE_WRITE_NOT_REPORTED_REASONS`:
    - `not_reported` for any allowlisted format;
    - `codex_usage_not_observed` for `codex-exec-jsonl-turn.completed` only.

    Agent Validator's Codex adapter (`src/cli-adapters/codex.ts`) starts every token field at
    `codex_usage_not_observed` and overwrites only the fields present in Codex's `turn.completed` usage.
    So once collection is complete, the reason left on `cache_write` means the usage record has no
    cache-write field.
  - Any other reason gives `billing_tokens: null` with
    `billing_reason: 'cache_write is unavailable: <reason>'`.
  - The assumption is only allowed when the uncached input is established. Otherwise there are no
    billing tokens, as today.
- The output shape and the `> 0` filtering stay as they are:
  `{ input, cached_input, cache_write?, output }`.

**Source format.** The helper `attemptSourceFormat(attempt)` takes the format from:
- `usage_source_version` when `usage_source === 'agent-validator:metrics'`;
- otherwise `source_provenance.source_format ?? usage_source`.

Inside the normalizers, the source format is passed explicitly: `raw.source_format` for native
measurements, and `sourceVersion(raw.provenance)` for Validator heads. `measurementUsage`,
`normalizeAllocation`, `normalizeUnallocated`, and the native allocation all store the four fields.

**Rescore.** An exported `refreshBillingTokens(attempts)` recomputes these fields for each attempt and
for each allocation or unallocated usage from the retained `token_envelopes`. Rescore uses it so that
results produced before this change can be repriced. Legacy attempts (`normalizeAttempt`, schema
without envelopes) keep their existing `billingTokens(rawUsage)` path and are left untouched by the
refresh.

### 2. Pricing chain (`lib/pricing.mjs`)

**Rate sources.** Both are exact-match only, and each returns a `rateSource` object:

```js
{ source: 'models.dev' | 'fallback-table', provider, model, cost /* catalog-shaped */, provenance }
```

- `lookupCatalogEntry(catalog, provider, model)` stays as it is.
- `lookupFallbackRate(table, provider, model)` matches only on `row.provider === provider &&
  row.model === model`. There is no normalization of case or whitespace. It returns the row's `rates`
  as a catalog-shaped `cost`, including any `tiers`.

**Calculation.** `calculateCatalogCost({ entry, tokens })` is generalized to
`calculateRateCost({ cost, tokens, assumptions, promptBounds })`:

1. Choose the rates:
   - **Collect the tier definitions.** `definitions` is every context tier the source declares:
     - `cost.tiers[]` with `tier.type === 'context'`, giving threshold `tier.size` and that entry's
       rates;
     - each `context_over_<N>k` key, giving threshold `N * 1000` and that key's rates.

     No definition is preferred over another.
   - **Classify them.** Let `low` be the minimum threshold and `high` the maximum. `consistent` is true
     when every definition has the same threshold and the same rates.
   - **Pick the rates:**
     - If there are no definitions, use the base rates.
     - If `promptBounds.upper <= low`, use the base rates with no assumption. The prompt is known to be
       within every definition.
     - If the billed tokens belong to one request, `promptBounds.lower > high`, and every definition has identical rates, use those tier rates
       with no assumption.
     - If `promptBounds.lower` is known (the prompt size is known) but neither case above holds, use the
       base rates and add `context_tier_ambiguous_priced_at_base`. This covers a known size between
       disagreeing thresholds, or above them when the rates disagree.
     - Otherwise, when the size is unknown, use the base rates and add
       `context_tier_unknown_priced_at_base`.
   - `consistent` definitions are the ordinary single-tier case of the same rules.
2. Every billed category needs a rate. The existing `CATEGORY_RATE_KEYS` rule and its error text stay.
3. Return `{ state, amount_usd, rates, unit, token_categories, assumptions, context_tier }`.
   `context_tier` is `{ thresholds: [..], applied: 'base' | 'tier', basis: 'no_tier' | 'within_lowest' |
   'above_highest' | 'ambiguous' | 'unknown' }`.

**Prompt bounds.** `promptBoundsOf(attempt | allocation)` returns:
- `upper`: the `input_total` envelope value. If that is unavailable, `input + cached_input +
  cache_write` from the billing tokens.
- `lower`: a producer-reported per-request prompt size. No current producer emits one, so it is `null`.
- `single_request`: true only when the producer establishes that the billed token partition belongs to one request. An aggregate attempt with one long request cannot apply tier rates to its other requests.

This is the only place a future `max_request_prompt_tokens`-style field would be read.

**`resolveAttemptCost` order:**
1. Runner-reported cost (unchanged).
2. Exhaustive reported allocation costs (unchanged).
3. The allocation path. It recurses with each allocation's billing tokens and assumptions. The combined
   verification uses `weakestVerification`.
4. Billing tokens: the malformed check, then the no-billed-categories check. The existing order is
   kept. When `usage.billing_reason` is set (incomplete collection, an unrecognized cache-write reason,
   or a negative derivation), that reason replaces the generic
   `no reported token usage to price this attempt with`. The attempt-level check still requires
   `usage.state === 'available'`. A partial usage state always carries a `billing_reason` from the
   collection gate, so the reason is accurate.
5. The identity check (unchanged reason).
6. For each source in `[models.dev entry, fallback-table row]`: calculate. On the first success, return:

   ```js
   {
     state: 'resolved',
     source,
     verification: assumptions.length ? 'estimated' : 'catalog',
     provenance: {
       /* existing fields */,
       assumptions, billing_derivation, context_tier, rate_source,
     },
   }
   ```

   Fallback-table provenance adds `table_path`, `table_sha256`, `row.source_url`, and
   `row.retrieved_date`. A failure reason for each source is collected.
7. The judge, as today. `verification: 'unverified'`, and `provenance.assumptions` carries the billing
   assumptions. The judge prices at the single rates it found, so no context-tier logic applies.
8. Otherwise, it is unresolved. The reason joins the per-source reasons, for example
   `models.dev: no exact provider/model match; fallback-table: no exact provider/model row`.

**Verification helpers**, exported:

```js
VERIFICATION_ORDER = ['reported', 'catalog', 'estimated', 'unverified']
weakestVerification(states)   // ignores null and undefined
```

`resolveImplementationPricing` additionally returns:
- `verification`: the weakest state across resolved costs;
- `includes_estimated` and `includes_unverified`;
- `verified`: `complete` and every resolved verification is in `{reported, catalog}`;
- `fallback_table`: `{ path, state, sha256, reason, row_count }`.

It takes a new `fallbackTable` argument.

**Fallback table loading.** `loadFallbackRates({ path })` reads the file, hashes its bytes, and
validates it with `validateFallbackRates(json)`. It returns
`{ state: 'available' | 'unavailable', path, sha256, rows, reason }`.
- An unreadable or invalid file, or a duplicate `provider/model` key, gives `state: 'unavailable'` and
  `rows: []`. The first validation error becomes the reason.
- `path` is recorded relative to the repository root.

### 3. Fallback table (`evals/agent-runner/and-scene/pricing/fallback-rates.json`)

```json
{
  "schema_version": 1,
  "rows": [
    {
      "provider": "openai",
      "model": "gpt-6-luna",
      "unit": "usd_per_million_tokens",
      "rates": { "input": 0.1, "cache_read": 0.01, "cache_write": 0.125, "output": 0.5,
                 "tiers": [{ "input": 0.2, "cache_read": 0.02, "cache_write": 0.25, "output": 0.75,
                             "tier": { "type": "context", "size": 272000 } }] },
      "source_url": "https://models.dev/api.json",
      "retrieved_date": "2026-09-27"
    }
  ]
}
```

**Validation rules:**
- `schema_version === 1`.
- Each row has non-empty string `provider` and `model`.
- `unit === 'usd_per_million_tokens'`.
- `rates.input` and `rates.output` are non-negative numbers. `cache_read`, `cache_write`, and
  `reasoning` are optional non-negative numbers.
- `tiers`, when present, uses the models.dev shape.
- `source_url` is an `https:` URL.
- `retrieved_date` is `YYYY-MM-DD`.
- No two rows share the same `provider` and `model`.

The initial rows are the three models observed in current results (`openai/gpt-6-luna`,
`openai/gpt-6-sol`, `anthropic/claude-opus-5-5`), with the models.dev rates retrieved on 2026-09-27.
models.dev takes precedence whenever it has an exact usable match, so these rows only act when
models.dev is down or drops a model.

A unit test loads the checked-in file and asserts that it is valid. `npm run check` runs it, so an
invalid commit fails.

### 4. Aggregation, steps, and rollup (`lib/cost.mjs`)

**Row fragment fix.** When building fragments for an attempt:
- **Multi-allocation attempt:** it has more than one attributed allocation, or attributed allocations
  plus an unallocated remainder. One fragment is made per allocation or remainder, with amounts from
  `resolution.allocation_costs` when the resolution has them.
  - A resolved attempt may have no `allocation_costs`. This happens when a Runner-reported
    whole-attempt cost or a complete reported attempt cost resolved before the allocation path. Then
    each allocation/remainder fragment row records the attempt in a new `not_allocated_attempts` list.
    It is not recorded in `unresolved_attempts`, and the row cost `state` is `not_allocated` when every
    one of its attempts is in this situation.
  - One extra cost-only fragment is added:

    ```js
    { allocation: 'unattributed_cost', provider: null, model: null, usage: null }
    ```

    It carries the whole-attempt amount, source, and verification. Its row key is
    `[agent_role, null, null, 'unattributed_cost']`, and it contributes no tokens.
  - The total therefore always equals the sum of row amounts.
  - The report shows `unattributed_cost` rows in the existing role/model table, with blank token
    columns and the allocation column reading "whole-attempt cost (not divided among models)".
- **Single-identity attempt:** exactly one attributed allocation and no remainder, or no attributed
  allocations and only a remainder. It produces one fragment:

  ```js
  { allocation: 'attempt',
    provider: allocation?.provider ?? attempt.provider,
    model: allocation?.model ?? attempt.model,
    usage: (that allocation's or remainder's) usage }
  ```

  Its amount is the attempt resolution's `amount_usd` when resolved.

This puts Runner Codex attempts in `implementor/openai/gpt-6-luna` and `tester/openai/gpt-6-luna` rows,
and gives the Claude lead row its reported amount. Validator attempts land in an
`implementation-validator/null/null` `attempt` row, which stays unresolved until #160.

**Row verification.** Rows collect each contributing resolution's attempt verification. The row value is
mapped from `weakestVerification`:
- `unverified` stays `unverified`;
- `estimated` stays `estimated`;
- `reported` and `catalog` become `verified`;
- no resolved contribution gives `null`.

The existing `sources` array is kept.

**Total.** `cost.total` gains `verification` (the weakest attempt state among resolved attempts, or
`null`), `includes_estimated`, and `includes_unverified`. These are computed over resolved attempts
whether or not the total is complete.

**Steps.** A new exported
`buildStepCosts({ attempts, costs }) -> { steps, step_rollup }` is called inside
`aggregateImplementationCost`, which spreads the result into its return value.

- `step_path`: `prefix ? `${prefix}/${step}` : step`, or `null` if both are absent.
- `top_level_step`: the first `/`-segment of `prefix`, or `step` when `prefix` is empty. The
  `/:\d+$/` suffix is stripped. `null` becomes the unattributed group (`top_level_step: null`,
  `label: 'unattributed'`).
  - This works for Runner and Validator attempts alike, because Validator `prefix` is already the
    Runner attribution prefix.
  - Examples:
    - `implement-tasks:0/…/generate-code` gives `implement-tasks`.
    - `complete-task-index` gives `complete-task-index`.
    - `run-validator/sub:run-validator/validator-retry:0` + `fix-violations` gives `run-validator`.
    - A Validator attempt with prefix `implement-tasks:0/…` gives `implement-tasks`.
- **Entry fields:**
  - `attempt_id`, `step_path`, `top_level_step`;
  - `producer`: `measurement_producer ?? tool`;
  - `agent_role`, `cli`, `provider`, `model`;
  - `billing_tokens`: `usage.billing_tokens`, or `null`;
  - `amount_usd`: the resolved amount, or `null`;
  - `known_subtotal_usd`: the resolution's known subtotal, including partial provider-reported
    amounts, as the total does;
  - `state`, `source`, `verification`;
  - `assumptions`: `provenance.assumptions ?? []`;
  - `reason`, `duration_ms`;
  - `allocations`: `allocation_costs` mapped to `{ allocation_id, provider, model, amount_usd, source,
    verification }`, taking the provider and model from `attempt.allocations`. It is `[]` for
    single-identity attempts.
- **Rollup rows:** one per `top_level_step`, in first-observed order of `attempts`, with unattributed
  last. Fields:
  - `top_level_step`, `attempt_count`, `attempt_ids`;
  - `known_subtotal_usd`: the rounded sum of the children's `known_subtotal_usd`;
  - `amount_usd`: the rounded sum when every child is resolved, else `null`;
  - `complete`;
  - `verification`: the weakest state over resolved children, using the attempt vocabulary.
- Only `invoked_cli` attempts are included, matching the total's scope. When `cost.total.complete`,
  the sum of `step_rollup[].amount_usd` equals `total.estimated_api_cost_usd` to within `1e-9`. Both
  sum the same unrounded amounts and round at 10 decimal places.

### 5. Result and report

- **`lib/result.mjs`:** `pricingCompleteness` returns:
  - `incomplete` when `pricing.complete === false`;
  - otherwise `unverified` if `includes_unverified`;
  - otherwise `estimated` if `includes_estimated`;
  - otherwise `verified`.

  Results without the new fields fall back to the existing `verified` boolean.
- **`lib/report.mjs`:**
  - Inside `implementationUsageSection`, after the existing role/model table and the total, add a
    **Per-step cost** subsection. For each rollup row, show a group header (step, attempts, amount or
    "unavailable", known subtotal, verification), then one row per child step entry: step path, role,
    model, input/cached/output tokens, cost or the reason, source, verification, and assumptions.
  - When `cost.steps` is absent, show "Per-step cost was not recorded for this result."
  - Replace the **Pricing sources** section's `keyValueRows(result.pricing)` with a schedule and
    summary table: complete, verification, includes estimated/unverified, verified, sources, unresolved
    attempt count, catalog URL/state/retrieved_at/sha256/reason, and fallback table
    path/state/sha256/reason.
  - The raw `pricing.costs` array is no longer rendered. It stays in `result.json`.
  - All values pass through the existing escaping helpers.

### 6. Controller and rescore (`controller.mjs`)

**`metrics-pricing` phase:**
- If this is not a rescore, read the metrics as today.
- If it is a rescore, use `record.metrics` (imported) and apply `refreshBillingTokens` to its attempts.

Both paths then:
1. Load the fallback table.
2. Fetch the catalog if `needsPricingLookup`.
3. Run `resolveImplementationPricing`, then `aggregateImplementationCost` with
   `attemptsComplete: record.metrics.complete`.

A rescore adds `repriced: true` and `imported_from` to `phases/metrics-pricing.json` and to
`pricing.repriced_from = { run_id, provenance_sha256 }`. The source run is only read. Rejecting a
published result directory is existing behavior of `loadCandidateRescoreSource`, which requires
`run-state.json` and `phases/delivery-verification.json`; a test pins it. Checkpoint resume of
`metrics-pricing` restores `record.metrics`, `pricing`, and `cost` from the phase file, as today.

## Decisions

1. **Derive billing tokens in `runner-metrics`, not in `pricing`.**
   - Normalization already owns the envelope-to-billing mapping and sees the source format.
   - Pricing keeps consuming `billing_tokens` plus the new `billing_assumptions`.
   - The function is pure and exported, so rescore can refresh the retained attempts.
   - *Alternative:* derive inside `pricing.mjs` from envelopes. That would split one mapping across two
     modules and require pricing to understand producer source formats.
2. **Use a source-format allowlist, not `included_in` metadata.** The Validator's envelopes mark
   `cache_read.included_in: ['input_total']`, but the Runner's Codex envelopes do not. The spec names
   the formats explicitly, and the allowlist is auditable.
3. **Use the total input as an upper bound for context tiers.** Every request's prompt is at most the
   attempt's total input. So `total ≤ threshold` proves that no request crossed the tier, with no
   assumption needed. Nothing currently proves that a request crossed it, so tier rates are applied
   only for a future producer-reported per-request size. This settles the spec's deferred scenarios
   without new telemetry. Current Codex attempts exceed 200k in total, so they are priced at base rates
   with the assumption. This matches the issue's expected `0.0306` USD for the sample `generate-code`
   attempt.
4. **Conflicting tier definitions are ambiguous, not ranked.** models.dev's `tiers[].size` (272,000)
   and its `context_over_200k` key (200,000) disagree for the same models, and nothing in the catalog
   says which is authoritative.
   - A known prompt size is priced without an assumption only where all definitions agree: within the
     lowest threshold, or above the highest with identical rates.
   - Anywhere else, it is priced at base rates with `context_tier_ambiguous_priced_at_base`, which
     follows the issue's decision 2 policy of base rates plus disclosure under uncertainty.
   - Current producers report no per-request size, so today's attempts either fall within the lowest
     threshold or are `unknown`.
5. **Fix the row fragments for single-identity attempts.** Without the fix, the existing role/model
   table would show every row unresolved while the steps and total are priced. Keying the row by the
   attempt's resolved identity matches exactly the identity pricing used.
6. **Seed the fallback table with the current models.** This satisfies issue decision 1 (the pinned
   snapshot) and keeps runs priceable if models.dev is unavailable. The table only matters when
   models.dev fails, so rates duplicated from models.dev are harmless.
7. **Treat an invalid table as unavailable, not fatal.** Pricing is report-only. The automated checks
   catch a bad commit, so a runtime failure would only hide an unrelated evaluation result.
8. **Repricing on rescore fetches a fresh catalog.** This is consistent with prices at evaluation time.
   The schedule identity is recorded, so the difference from the source result is visible.
9. **Only complete usage collection is priced.** Partial collection can undercount any category, so
   pricing it, even exactly, would publish a number that looks trustworthy but isn't. The attempt stays
   unavailable, with a reason that says why, instead of the generic "no reported token usage".
10. **Recognize cache-write reasons per producer.** `not_reported` is the Runner's vocabulary.
    `codex_usage_not_observed` is recognized only for the Validator's Codex format, where the adapter
    source establishes that the reason means the usage record has no cache-write field. Unknown reasons
    stay unpriced.
11. **Report an undivided whole-attempt cost in a cost-only row.** A multi-model dispatch whose cost is
    known only as a whole-attempt figure keeps its exact per-model usage rows. It adds one
    `unattributed_cost` row, so the model table reconciles to the total without inventing a split.

## Risks / Trade-offs

- **Estimates may diverge from real invoices.** The cache-write assumption undercounts, because the
  input rate is below the cache-write rate. Base-rate pricing of long-context requests undercounts too.
  Both are labelled `estimated` and disclosed per attempt and in the totals. The magnitude is bounded:
  input is the cheapest category for these models.
- **Row key change for Codex attempts.** They move from `unallocated/null/null` to
  `attempt/openai/gpt-6-luna`. Consumers that grouped the old rows will see different rows in new
  results. Historical results are unchanged, and the report renders both shapes.
- **The `completeness.pricing` vocabulary gains `estimated`.** Downstream readers that switch on
  `verified`/`unverified` must tolerate it. agent-factory currently reads only the cost total and
  subtotal.
- **Catalog shape drift.** models.dev may change its tier representation. Unknown tier shapes are
  ignored, so pricing would use base rates without an assumption. This is mitigated by treating any key
  matching `context_over_*` or `tiers[type=context]` as a tier. A test pins both shapes.
- **Rescore of old runs depends on retained envelopes.** Attempts normalized before measurement schema
  v4 have no envelopes. They keep their stored `billing_tokens`, so they are priced exactly as before.

## Migration Plan

The change ships as two slices, matching the issue's PR plan:

1. **PR 1:**
   - derivation, the pricing chain, the verification helpers, the fallback table and its validation;
   - the row fragment fix and the total verification;
   - `completeness.pricing`, the Pricing-sources report section, rescore repricing, and the spec delta.
2. **PR 2:** `buildStepCosts`, `cost.steps`, `cost.step_rollup`, and the per-step report table.

There are no data migrations. Historical results are not rewritten. Rollback is a revert: new result
fields are additive, and old code ignores them.

## Test Plan

- **`test/runner-metrics.test.mjs`:**
  - Codex runner-format and Validator-format envelopes derive `input` and carry the cache-write
    assumption. The original reason (`not_reported` or `codex_usage_not_observed`) is preserved.
  - `codex_usage_not_observed` on a Runner-format attempt, or an unrecognized cache-write reason on
    either format, gives `null` with a `cache_write is unavailable` reason.
  - Partial collection with valid category counts gives `null` with a
    `token usage collection is incomplete` reason. This applies to both exact and derived partitions.
  - A producer-supplied `input_uncached` wins.
  - A non-Codex source without `input_uncached` produces `null`.
  - A negative derivation produces `null` with a reason.
  - `refreshBillingTokens` re-derives attempts from a trimmed `d7f384ba-…-rep-1` fixture.
- **`test/pricing.test.mjs`:**
  - A Codex attempt resolves as `estimated` with the expected amount (`0.0306` for the sample), and
    both assumptions are recorded.
  - A Claude full partition on an untiered model resolves as `catalog`.
  - A total input under the tier threshold gives base rates with no assumption.
  - A lower bound above the threshold gives tier rates.
  - Conflicting definitions (200,000 and 272,000) cover four cases:
    - an upper bound ≤ 200,000 gives base rates with no assumption;
    - a known 240,000 gives `context_tier_ambiguous_priced_at_base`;
    - a known 300,000 with identical rates gives tier rates;
    - a known 300,000 with differing rates gives the ambiguous assumption.
  - A partial-usage attempt reports the collection-incomplete reason, not "no reported token usage".
  - A model missing from models.dev falls through to the fallback table, then to the judge.
  - A near-named model never matches.
  - An invalid or duplicate table is treated as unavailable.
  - The checked-in table is valid.
  - A Validator attempt with a null model returns the identity reason.
  - `weakestVerification` ordering is covered.
- **`test/cost-aggregation.test.mjs`:**
  - A single-identity unallocated attempt is keyed by the resolved identity and carries its amount.
  - A single attributed allocation carries the whole-attempt cost.
  - A multi-allocation attempt with a Runner-reported whole-attempt cost and no allocation costs covers
    three things:
    - the model rows keep their usage and are marked `not_allocated`, not unresolved;
    - an `unattributed_cost` row carries the amount;
    - the complete total equals the sum of row amounts.
  - Row and total verification are covered.
  - `buildStepCosts` covers top-level extraction, Validator attribution, the unattributed group, the
    weakest-state rollup, unavailable children (null amount plus known subtotal), multi-model
    allocations, and reconciliation with `cost.total`.
- **`test/report.test.mjs`:**
  - The per-step table is grouped by step, and the role/model table is kept.
  - The raw `costs` JSON is absent.
  - A pre-feature result renders a "not recorded" line.
  - Escaping of step names is covered.
- **`test/result-assembly.test.mjs`:** `completeness.pricing` is `estimated`.
- **`test/rescore.test.mjs` / `test/controller.test.mjs`:**
  - Rescore reprices the imported Codex attempts.
  - Reported Claude costs are kept.
  - A published-only directory is rejected.
