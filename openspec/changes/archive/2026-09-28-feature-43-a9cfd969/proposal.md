## Why

and-scene results never show a total implementation cost, and no result shows cost per workflow step.
In the three current published results (`d7f384ba-…-rep-1`, `1d0dbdaf-…-rep-1`, `1d0dbdaf-…-rep-2`),
only the Claude lead attempts are priced, because they report their own USD cost. Every Codex attempt
from Agent Runner and from Agent Validator is left unpriced. Each carries the reason `no reported token
usage to price this attempt with`, but usage was reported for all of them (`attempts_missing_usage = 0`).
The models.dev catalog was fetched successfully, and it lists every model involved. As a result,
`cost.total` is always `unavailable`. Runner Codex cost that is knowable to within cents (for example,
about $0.83 for the 11 Runner Codex attempts in `d7f384ba-…-rep-1`) is left out of even the known
subtotal.

The requirement comes from Paul, the Codagent owner and author of issue #43. When an agent CLI does not
report cost, the eval should estimate it from well-known public API pricing, and it should report cost
for every step as well as the run total. The Agent Evals cost-tracking handoff also asks for a pinned
pricing snapshot and for cost by phase. Agent Runner deliberately gave up pricing (see its
`cost-capture` spec), so Agent Evals owns it. The current `evaluation-metrics-reporting` spec cannot
deliver this, for two reasons:

- **It requires an exact partition of billing categories.** Codex never reports cache writes or a
  separate uncached input figure, although its `input_tokens` does include `cached_input_tokens`. Under
  the current rule, a Codex attempt can never be priced, even when we have its exact model rates.
- **It never asks for per-step cost.** Aggregation happens only by role, provider, and model. The HTML
  report prints `pricing.costs` as raw JSON.

This matters now because cost is one of the headline comparisons between candidate harness
configurations. Most roles in current candidates use Codex, so that comparison is effectively blank.

**What this change delivers, and what it depends on.** On its own, this change prices every Runner
attempt whose exact provider and model are known, reports per-step cost, and reports honest known
subtotals. A numeric run total also requires every Agent Validator attempt to carry an exact model
identity. In the cited results, every Validator attempt has a null provider and model, because
Validator does not resolve Codex's default model (agent-validator#160). For those runs, `cost.total`
and the affected step rollups stay unavailable with a known subtotal until #160 lands. A complete
numeric total is available today only for runs whose Validator attempts carry an exact identity, for
example when a candidate's Validator config pins its Codex model. The exact-identity rule is kept on
purpose: an unidentified model must not be priced.

Issue #43 replaces #37, which the factory returned for product decisions. The issue records those
decisions, and this proposal adopts them as given.

## Verdict

**Go.** The problem is real, it is confirmed on `origin/main`, and it blocks a stated requirement. The
fix fits into existing modules (`runner-metrics.mjs`, `pricing.mjs`, `cost.mjs`, `report.mjs`) and adds
no dependencies. The main risk is epistemic: an estimate could be passed off as a measurement. A
distinct, labelled `estimated` verification state addresses that, and the "weakest state wins" rollup
means a total never claims more certainty than its least certain part. No other approach meets the
requirement:

- Waiting for Codex to report cache writes has no timeline.
- Moving pricing back into Agent Runner reverses a deliberate Runner decision.
- Reporting token counts only does not produce cost.

## What Changes

**Slice 1: estimated pricing tier, fallback rates, and spec delta (PR 1)**

- Add a verification state `estimated` alongside `reported`, `catalog`, and `unverified`. A numeric
  total may include estimated figures, and the result says so.
- **Source-established uncached input.** When an attempt's usage source format establishes that input
  includes cached input (`codex:turn.completed`, `codex-exec-jsonl-turn.completed`), derive
  `input_uncached = input_total − cache_read`. A producer-supplied `input_uncached` always takes
  precedence. For any other source, a missing `input_uncached` still yields no billing tokens.
- **Cache-write assumption.** When the source reports `cache_write` as not reported, price the uncached
  input at the exact model's input rate. Record the assumption
  `cache_write_not_reported_priced_as_input` and resolve the attempt as `estimated`. Reasoning stays
  inside `output` for Codex.
- **Context tiers.** Apply a models.dev context tier only when the prompt size is known to exceed the
  tier's threshold. When the model has a tier but the prompt size is unknown, price at base rates,
  record `context_tier_unknown_priced_at_base`, and resolve as `estimated`.
- **Pinned fallback table.** Add `evals/agent-runner/and-scene/pricing/fallback-rates.json`. Each row
  has provider, exact model id, rates, unit, source URL, and retrieved date. It is matched only on the
  exact provider and model id.
- **Pricing source order:** Runner-reported, then a models.dev exact match (`catalog` or `estimated`),
  then the fallback table, then the judge (`unverified`), then unavailable.
- **Totals and verification.** `cost.total`, the `cost.rows` for role, provider, and model, and
  `pricing` all disclose when a figure includes `estimated` or `unverified` pricing. An unresolved
  attempt is never counted as zero.
- **Pricing schedule disclosure.** Cost reflects public prices at evaluation time, in the settled
  source order. Each result records the pricing schedule it used: the models.dev retrieval time and
  response SHA-256, and the fallback table's file SHA-256. Two results can therefore be checked for
  whether they were priced on the same schedule. Comparisons across different schedules are reported
  as such, not silently equated.
- **Rescoring.** `--rescore-from` re-resolves pricing and cost from the imported, retained attempts
  instead of copying the source run's frozen pricing. Rescore needs a retained private run directory
  (`run-state.json`, `phases/delivery-verification.json`, and the acceptance artifacts). A published
  `results/<id>/` directory is not enough. The private run directory for `d7f384ba-…-rep-1` is
  currently retained in the factory artifacts store
  (`~/.agent-factory/artifacts/d7f384ba-0e94-4926-852e-6662fec752be-rep-1`). Automated tests cover
  the same behavior with a trimmed fixture built from that result's embedded attempts.
- Add a spec delta to `evaluation-metrics-reporting` covering all of the above.

**Slice 2: per-step cost (PR 2)**

- **`cost.steps` in `result.json`:** one entry per CLI-invoking attempt, with:
  - attempt id, step path, top-level step, producer, role, CLI, provider, and model;
  - billing tokens, amount, state, source, verification, assumptions, reason, and duration.
- **`cost.step_rollup`:** one row per top-level workflow step, with:
  - attempt count and known subtotal;
  - amount, which is null if any child is unavailable;
  - the weakest verification among its children.

  Validator attempts roll up under the Runner step that invoked them, using
  `source_provenance.runner_attribution.prefix`. When cost is complete, the step amounts sum to
  `cost.total`.
- **`report.html`:** replace the raw `pricing.costs` JSON dump with a per-step table (step, role, model,
  tokens, cost, source and verification), grouped by top-level step. Keep the existing role and model
  table.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `evaluation-metrics-reporting`:
  - **Real-time pricing resolution:** adds the estimated tier, the source-established uncached-input
    derivation, the cache-write and context-tier assumptions, the fallback table, and the new source
    order.
  - **Agent-and-model implementation cost aggregation:** adds verification disclosure for totals and
    rows, and per-step cost and the step rollup.
  - **Independent completeness reporting:** estimated pricing is disclosed separately from
    completeness.
  - **Self-contained HTML report:** adds the per-step table.
  - **Rescoring:** re-resolves pricing from the retained attempts.

## Technical Approach

- **Derivation lives in `runner-metrics.mjs`.** The billing-token builder can already see each
  attempt's source format and token envelopes. It gains an allowlist of source formats that establish
  "input includes cached input", and it marks derived billing tokens with the assumptions they carry
  (unreported cache write). This keeps the rule in `pricing.mjs` intact: never drop a category and
  never match on a similar name. Every reported token is priced at the exact model's published rate,
  and the one unreported split is disclosed.
- **Resolution in `pricing.mjs`** becomes an ordered chain of exact-match sources: catalog, fallback
  table, judge. The fallback table is loaded from the suite directory and hashed into the pricing
  provenance, like the catalog response. A fallback-table price is labelled with source
  `fallback-table`. Its verification is `catalog` when the token partition is exact, and `estimated`
  when a derivation assumption applies.
- **Verification ordering** is `reported`, then `catalog`, then `estimated`, then `unverified`. It is
  one shared helper used by attempt resolution, by `cost.mjs` rows and totals, and by the step rollup.
  The existing row-level `verified`/`unverified` values are extended with `estimated` rather than
  renamed, so historical results still read correctly.
- **Per-step output** is built in `cost.mjs` from the attempts and their cost resolutions. The top-level
  step is the first segment of the attempt's step path, with any `:index` suffix removed. Validator
  attempts use their Runner attribution prefix. `report.mjs` renders the new table from `cost.steps`
  and `cost.step_rollup`, and it falls back gracefully for results that predate those fields.
- **All changes are additive to `result.json`:** new fields plus one new enum value. Published
  historical results are not edited.

The detailed algorithms are left to `design.md`: prompt-size knowledge for context tiers, the
fallback-table schema and validation, step-path parsing, and how allocation-level (multi-model)
attempts appear in `cost.steps`.

## Out of Scope

- Rendering cost in agent-factory comments. That is a follow-up in agent-factory once
  `cost.step_rollup` exists.
- Resolving the Codex default model for Agent Validator, tracked in agent-validator#160. This is an
  explicit dependency for a numeric run total whenever a run contains Validator attempts without an
  identity. Until #160 lands, those attempts stay unavailable with the reason
  `exact provider and model identity are required for pricing`. That reason appears naturally once
  their billing tokens are derivable. The run total and the affected step rollups stay unavailable,
  with known subtotals.
- A result-only pricing replay for published `results/<id>/` directories that no longer have a
  retained private run directory.
- Fixing one pricing schedule for comparison cohorts. Issue decision 1 settles live models.dev ahead
  of the pinned table. This change only discloses which schedule each result used.
- The reason-ordering bug in `resolveAttemptCost` (#37 root cause 2) and Runner emission of
  `input_uncached` for Codex. Both are filed separately.
- Pricing eval-owned judge usage, and any effect of cost on scoring, gates, or pass status.
- Editing or republishing historical `results/**` records.
- Tooling that refreshes the fallback-rates snapshot automatically.

## Impact

- **Code:**
  - `evals/agent-runner/and-scene/lib/runner-metrics.mjs`, `pricing.mjs`, `cost.mjs`, `report.mjs`,
    `result.mjs`, and `rescore.mjs`;
  - the `metrics-pricing` phase in `controller.mjs`;
  - their tests (`pricing.test.mjs`, `runner-metrics.test.mjs`, and the result and report tests),
    using a trimmed fixture from `d7f384ba-…-rep-1`.
- **New data file:** `evals/agent-runner/and-scene/pricing/fallback-rates.json`.
- **Spec:** a delta to `openspec/specs/evaluation-metrics-reporting/spec.md`.
- **Result format:** additive fields (`cost.steps`, `cost.step_rollup`, assumptions and verification
  disclosure) and a new verification value, `estimated`. Consumers that switch on the verification
  vocabulary, such as agent-factory, must tolerate the new value.
- **Dependencies:** none added. Pricing stays report-only.
- **Users:** eval maintainers and the harness owner can see per-step cost and known subtotals for
  Codex-backed Runner roles, with estimates clearly labelled. Complete run totals also need
  agent-validator#160 for runs whose Validator attempts lack a model identity.
