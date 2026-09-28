# Decisions

## propose

### Verdict: go
- **Decision:** Proceed with the change as scoped by issue #43.
- **Alternatives considered:**
  - Wait for Codex to report cache writes (no timeline).
  - Move pricing into Agent Runner (reverses Runner's deliberate `cost-capture` decision).
  - Report token counts only (does not meet the cost requirement).
- **Decision-bearing:** yes.

### Adopt the issue's settled product decisions verbatim
- **Decision:** Adopt all four settled decisions:
  1. Add the fallback table now.
  2. Price at base rates when prompt size is unknown, and label the attempt `estimated`.
  3. In a rollup, the weakest verification state wins.
  4. Deliver one change in two PRs.
- **Alternatives considered:** Defer the fallback table (the issue body offered this, but decision 1
  overrides it).
- **Decision-bearing:** no. Settled by the issue author.

### Delivery split
- **Decision:** Structure the change as two ordered slices, matching the issue's PR 1 and PR 2:
  - Slice 1: estimated tier, fallback table, and spec delta.
  - Slice 2: `cost.steps`, `cost.step_rollup`, and the report table.

  The single spec delta covers both slices.
- **Alternatives considered:** One combined slice (contradicts decision 4).
- **Decision-bearing:** no.

### Rescoring re-resolves pricing
- **Decision:** `--rescore-from` re-resolves pricing and cost from the imported, retained attempts
  (their token envelopes and source formats are persisted), instead of copying frozen pricing. Without
  this, the acceptance criterion "Re-scoring `d7f384ba-…-rep-1` prices all 11 Runner Codex attempts"
  cannot be met. Pricing is evaluator-owned, so it fits rescore's "re-run evaluator-owned phases"
  contract.
- **Alternatives considered:**
  - Re-read the Runner session metrics from the source artifact directory. These may not be retained.
  - Satisfy the criterion only through a unit fixture. This is weaker than what the issue asks for.
- **Decision-bearing:** yes. It changes rescore behavior, but it is required by the issue's acceptance
  criteria and stays within this repository.

### Fallback-table labelling
- **Decision:** A price from the fallback table uses source `fallback-table`. Its verification is
  `catalog` for an exact token partition and `estimated` when a derivation assumption applies. The
  table's file hash is recorded in the pricing provenance.
- **Alternatives considered:** Label every fallback-table price `estimated` (conflates stale-rate risk
  with partition estimation), or `unverified` (reserved for judge findings).
- **Decision-bearing:** yes. Low risk; revisit in design if needed.

### Row-level verification vocabulary
- **Decision:** Extend the existing `cost.rows[].verification` values (`verified`/`unverified`) with
  `estimated`, using weakest-wins ordering. Do not rename the existing values, so that historical
  results keep reading correctly.
- **Alternatives considered:** Rename to the `reported`/`catalog` vocabulary. This changes the
  persisted meaning for existing consumers.
- **Decision-bearing:** yes. It is an additive persisted-format change that the issue explicitly asks
  for, so it is not a stop.

### Reason-ordering bug stays out of scope
- **Decision:** Do not reorder the checks in `resolveAttemptCost` (filed separately). Once billing
  tokens are derivable, Validator Codex attempts without a model naturally report
  `exact provider and model identity are required for pricing`, which meets the acceptance criterion.
- **Alternatives considered:** Fix the ordering here (duplicates a separately filed Bug).
- **Decision-bearing:** no.

### Context-tier prompt size
- **Decision:** Treat prompt size as known only when the source reports a per-request prompt size.
  Current attempt-level telemetry aggregates turns, so base rates plus the assumption will be the
  normal path for tiered models. The details are deferred to design.
- **Alternatives considered:** Infer prompt size from attempt totals. This is wrong for multi-turn
  attempts.
- **Decision-bearing:** no. It follows directly from issue decision 2.

## proposal-review

### PR-1: run total depends on Validator model identity (agent-validator#160). Applied.
- **Decision:**
  - The proposal now scopes this change's standalone outcome to three things: priced Runner attempts,
    per-step cost, and honest known subtotals.
  - agent-validator#160 is an explicit dependency for a numeric run total whenever Validator attempts
    lack an identity.
  - The exact-identity rule is kept.
  - The overstated "knowable to within cents" framing is narrowed to Runner Codex cost.
- **Alternatives considered:** Price identity-less Validator attempts from the Runner's configured model
  or from a likely default. Rejected, because it infers a price without an exact identity, which the
  spec forbids.
- **Decision-bearing:** yes. It narrows the stated outcome but matches the issue's own acceptance
  criterion that Validator attempts stay unavailable until #160 lands. Not a direction-level stop.

### PR-2: rescore needs a retained private run directory. Applied.
- **Decision:**
  - State that `--rescore-from` repricing requires a retained private run directory.
  - Record that the private directory for `d7f384ba-…-rep-1` still exists in the factory artifacts
    store. It contains `run-state.json`, `phases/delivery-verification.json`, and the other files
    rescore needs.
  - Cover the behavior in tests with a trimmed fixture from the published result's embedded attempts.
- **Alternatives considered:** Add a result-only pricing replay for published result directories.
  Rejected as unnecessary scope: the cited run is retained, and the issue does not ask for replaying
  published results. It is listed as out of scope.
- **Decision-bearing:** yes.

### PR-3: comparisons need a fixed pricing schedule. Recommendation rejected; clarification applied.
- **Decision:** Reject the recommendation to price comparison cohorts from one versioned snapshot ahead
  of the live catalog. Issue decision 1, settled by the issue author, fixes the source order as
  runner-reported, then live models.dev, then the pinned fallback table, then the judge. Putting a
  pinned schedule first would contradict it. Instead:
  - The proposal states that cost reflects prices at evaluation time.
  - Each result records its pricing schedule identity: the models.dev retrieval time and SHA-256, and
    the fallback table's SHA-256.
  - Results priced on different schedules are identifiable rather than silently equated.
  - Fixing a pricing schedule per cohort is listed as out of scope.
- **Alternatives considered:**
  - Adopt the pinned-first order. This would be a direction-level stop, because it contradicts a
    settled issue decision.
  - Ignore the concern.
- **Decision-bearing:** yes. The chosen path stays within the issue's settled direction, so no stop.

## spec

### One spec delta, `evaluation-metrics-reporting`
- **Decision:** All behavior goes in one delta. Three requirements are MODIFIED:
  - Agent-and-model implementation cost aggregation
  - Real-time pricing resolution
  - Independent completeness reporting

  The new behavior is ADDED as focused requirements:
  - Estimated attempt pricing
  - Pinned fallback pricing table
  - Pricing verification ordering
  - Pricing schedule disclosure
  - Per-step implementation cost
  - Per-step cost report
  - Pricing re-resolution on evaluator-only rescore

  The large Self-contained HTML report requirement and the runner-workflow-execution rescore
  requirement are left unmodified. The report and rescore changes are specified as ADDED requirements.
- **Alternatives considered:** MODIFY Self-contained HTML report, and runner-workflow-execution's
  checkpoint/rescore requirement. This copies large unrelated blocks and increases the risk of
  accidental edits.
- **Decision-bearing:** no.

### Row-level verification values
- **Decision:** `cost.rows[].verification` is `unverified` if any contributing cost is unverified,
  else `estimated` if any is estimated, else `verified`. The existing values are kept, and `estimated`
  is added.
- **Alternatives considered:** Switch rows to the attempt vocabulary (`reported`/`catalog`/…). This
  would break readers of historical results.
- **Decision-bearing:** yes. It is an additive enum value.

### `pricing.verified` excludes estimates
- **Decision:** The pricing summary reports verified only when pricing is complete and every resolved
  cost is `reported` or `catalog`. Before this change it was false only for judge-found prices.
- **Alternatives considered:** Keep `verified` true for estimated totals. Rejected: an estimate is not a
  verified price.
- **Decision-bearing:** yes. Low risk, because estimated did not exist before.

### Total verification disclosure
- **Decision:** `cost.total` states the weakest verification state among resolved attempts, plus
  whether it includes estimated figures and whether it includes unverified figures. This holds even
  when the total is unavailable, so the known subtotal's certainty is visible.
- **Alternatives considered:** Disclose only on numeric totals.
- **Decision-bearing:** no.

### Rollup with unavailable children
- **Decision:** An unresolved attempt has no verification state. A rollup's verification is the weakest
  state among its resolved children. The rollup's amount is null and it is marked incomplete.
- **Alternatives considered:** Treat unavailable as a fifth, weakest state. Issue decision 3 lists only
  four states and handles unavailability through a null amount.
- **Decision-bearing:** no.

### Top-level step and unattributed attempts
- **Decision:**
  - The top-level step is the first step-path segment without its `:index` suffix.
  - Validator attempts use the prefix from their Runner attribution.
  - Attempts without an established top-level step go to an explicit unattributed rollup row. They are
    never dropped, so the rollup still reconciles to the total.
- **Alternatives considered:** Omit unattributed attempts from the rollup. This would break the
  sum-to-total property.
- **Decision-bearing:** no.

### Estimation derivation boundaries
- **Decision:**
  - Uncached input is derived only for the Codex source formats `codex:turn.completed` and
    `codex-exec-jsonl-turn.completed`. A producer-supplied value wins.
  - A missing or negative derivation leaves the attempt without billing tokens.
  - The cache-write assumption applies whenever the source reports cache writes as not reported.
- **Alternatives considered:** Skip the cache-write assumption when the model has no cache-write rate.
  This adds a special case for little value, since the estimate label stays honest either way.
- **Decision-bearing:** no.

### Context tiers
- **Decision:** The tier applies only when the prompt size is known to exceed its threshold. Known
  within the threshold means base rates with no assumption. Unknown means base rates, the assumption,
  and `estimated`. The scenarios for how per-request prompt size becomes known are marked
  deferred-to-design, because attempt totals aggregate several requests.
- **Alternatives considered:** Infer prompt size from attempt totals. Rejected as incorrect.
- **Decision-bearing:** no. This is issue decision 2.

### Fallback table validity
- **Decision:** An unreadable, invalid, or duplicate-keyed table is treated as unavailable at evaluation
  time, and resolution continues to the judge. Automated repository checks reject an invalid table.
- **Alternatives considered:**
  - Fail the evaluation. Rejected, because pricing is report-only.
  - Use valid rows from a partially invalid table. Rejected, because it is ambiguous.
- **Decision-bearing:** yes. Low risk.

### No pricing from an unreported model
- **Decision:** The spec explicitly forbids pricing an attempt from a default or configured model that it
  did not report. This keeps Validator attempts unavailable until agent-validator#160 lands.
- **Alternatives considered:** None viable. The alternative is the similar-name inference the spec
  already forbids.
- **Decision-bearing:** no.

### Rescore source
- **Decision:** Rescore reprices from the retained attempts, re-deriving billing tokens from the
  retained envelopes. A published result directory alone is rejected as a rescore source, which
  matches the current `loadCandidateRescoreSource` behavior.
- **Alternatives considered:** A result-only replay. Out of scope per PR-2.
- **Decision-bearing:** no.

### Multi-model attempts in `cost.steps`
- **Decision:** Each attempt gets one step entry that identifies its allocations. How allocations are
  represented is deferred to design.
- **Alternatives considered:** One entry per allocation. This breaks the issue's "cost.steps for every
  attempt" framing and complicates counts.
- **Decision-bearing:** no.

## design

### Fix row attribution for single-identity attempts
- **Decision:** An attempt whose usage is a single allocation, or only an unallocated remainder, becomes
  one `attempt` fragment keyed by the attempt's resolved provider and model. It carries the attempt's
  resolved amount.
- **Why:** In `d7f384ba-…-rep-1`, every `cost.rows` entry, including the fully Runner-reported Claude
  lead row, has `amount_usd: null`. Codex attempts sit in `unallocated/null/null` rows. Pricing Codex
  without this fix would leave the role/model table contradicting `cost.total` and `cost.steps`.
- **Spec:** Two scenarios were added to the aggregation requirement.
- **Alternatives considered:**
  - Leave rows as they are. The kept role/model table would stay wrong.
  - Price unallocated fragments separately. They have no identity of their own.
- **Decision-bearing:** yes. It changes row keys in new results. It is a correctness fix implied by the
  existing requirement, within this repository, and not a stop.

### Derivation location and allowlist
- **Decision:**
  - Derivation lives in `runner-metrics.mjs` as a pure, exported `deriveBillingTokens(envelopes,
    sourceFormat)`.
  - It writes `billing_assumptions` and `billing_derivation` next to `billing_tokens`.
  - The source format comes from `usage_source_version` for Validator attempts and from
    `source_provenance.source_format` for Runner attempts.
  - An explicit allowlist is used instead of the envelopes' `included_in` metadata, which the producers
    set inconsistently.
- **Alternatives considered:** Derive in `pricing.mjs`; use `included_in`.
- **Decision-bearing:** no.

### Context-tier prompt-size knowledge
- **Decision:**
  - The attempt's total input, including cached input, is an upper bound on any request's prompt.
    Total ≤ threshold means base rates with no assumption.
  - The tier applies only when a producer-reported per-request size exceeds the threshold. No producer
    reports one today.
  - Otherwise, base rates plus `context_tier_unknown_priced_at_base`.
  - The deferred spec scenarios were completed on this basis.
- **Alternatives considered:**
  - Treat all tiered models as unknown. This ignores the sound upper bound.
  - Infer the per-request size from totals. This is unsound.
- **Decision-bearing:** no. It follows issue decision 2.

### Lowest tier threshold governs
- **Decision:** When models.dev declares several context thresholds (`tiers[].size` 272,000 and
  `context_over_200k` for the same model), the lowest one governs.
- **Alternatives considered:** Prefer `tiers` alone. This is less conservative about "known within".
- **Decision-bearing:** no.

### Fallback table contents and schema
- **Decision:**
  - The table uses `schema_version: 1`, and its rows reuse the models.dev rate keys, with optional
    `tiers`.
  - It is seeded with `openai/gpt-6-luna`, `openai/gpt-6-sol`, and `anthropic/claude-opus-5-5`, as
    retrieved from models.dev on 2026-09-27 (`source_url` is the models.dev API).
  - A test validates the checked-in file.
- **Alternatives considered:**
  - An empty table. Valid, but it gives no reproducibility when models.dev is down.
  - Vendor pricing-page URLs. Those rates were not independently retrieved for this change.
- **Decision-bearing:** yes. Low risk, because models.dev takes precedence.

### `completeness.pricing` gains `estimated`
- **Decision:** `pricingCompleteness` returns, in order:
  - `incomplete`;
  - `unverified` if the pricing includes unverified figures;
  - `estimated` if it includes estimated figures;
  - `verified`.

  Results without the new fields fall back to the `verified` boolean.
- **Spec:** The "Price is estimated" scenario now states this.
- **Alternatives considered:** Report estimates as `unverified`. This conflates a judge search with a
  disclosed partition estimate.
- **Decision-bearing:** yes. It is an additive enum value.

### Multi-model step entries
- **Decision:** A multi-model attempt has one `cost.steps` entry with an `allocations[]` list (id,
  provider, model, amount, source, verification). This completes the deferred spec scenario.
- **Alternatives considered:** One entry per allocation.
- **Decision-bearing:** no.

### Pricing-sources report section
- **Decision:** Replace the raw `keyValueRows(result.pricing)` dump with a schedule and summary table.
  `pricing.costs` stays in `result.json`.
- **Alternatives considered:** Keep the dump next to the new table. The issue asks for the dump to be
  replaced.
- **Decision-bearing:** no.

### Rescore reprices with a fresh catalog and re-derived billing tokens
- **Decision:** `refreshBillingTokens` runs over the imported attempts, then the normal pricing path
  runs. `pricing.repriced_from` records the source run.
- **Alternatives considered:** Reuse the source catalog response. It is not retained.
- **Decision-bearing:** no.

## test-plan

### No automated E2E
- **Decision:** No `E2E-*` obligation. Every `run.sh` journey that reaches pricing requires paid
  candidate runs or paid LLM product judging. The controller's `evaluate()` with its existing injected
  seams (INT-004) plus report generation (INT-005) cover the journey at a stable, free layer.
- **Alternatives considered:** An automated `run.sh --rescore-from` against the retained d7f384ba run.
  It is paid and non-deterministic because of live judges and the live catalog.
- **Decision-bearing:** yes.

### Five integration obligations on a trimmed d7f384ba fixture
- **Decision:** INT-001 to INT-005 cover the seams between modules and files:
  - normalization → pricing → aggregation;
  - reconciliation and completeness;
  - the checked-in fallback file and its degradation;
  - controller rescore repricing and rejecting a published-only source;
  - result → report, including rendering an unmodified historical result.

  The fixture is a trimmed copy under `test/fixtures/`, with a pinned models.dev excerpt from
  2026-09-27.
- **Alternatives considered:**
  - Unit tests only. These miss the envelope and source-format hand-off, and the controller wiring.
  - The full published result as the fixture. It is large and noisy.
- **Decision-bearing:** no.

### Acceptance envelope excludes paid and publishing effects
- **Decision:**
  - The exploratory pass may use the local checkout, temporary directories, a read-only copy of the
    retained private run directory, free models.dev GETs, and `evaluate()` driven by stubs.
  - Paid runs, a full rescore with live judges, the live pricing judge, Docker, pushes and publication,
    edits to `results/**`, and in-place edits to the retained run are off limits.
  - Injecting a Validator identity into a copy is permitted as a substitute for agent-validator#160.
- **Alternatives considered:** Authorize one paid full rescore. It costs judge spend and exercises
  mostly unchanged product-scoring paths.
- **Decision-bearing:** yes.

### Human-only testing
- **Decision:** None. Every check is observable by an agent with the tools.
- **Decision-bearing:** no.

## approach-review

### AR-001: whole-attempt reported cost across several allocations. Applied.
- **Decision:** For a multi-model dispatch resolved only as a whole-attempt amount:
  - Its model rows keep their exact usage and are marked `not_allocated`, not unresolved.
  - A cost-only `unattributed_cost` row for the role (no provider, model, or tokens) carries the amount.
  - The complete total equals the sum of all rows.
- **Where:** the spec aggregation requirement plus a new scenario; design §4 and Decision 11; test plan
  INT-006, which covers aggregation and report rendering.
- **Alternatives considered:** Split the cost proportionally by tokens. Rejected, because it invents an
  allocation.
- **Decision-bearing:** yes. It is an additive row kind.

### AR-002: cache-write assumption limited to genuine not-reported reasons. Applied.
- **Decision:** The assumption applies only when all of the following hold:
  - usage collection is complete;
  - the uncached input is established;
  - the cache-write reason is recognized: `not_reported`, or `codex_usage_not_observed` for
    `codex-exec-jsonl-turn.completed` only.

  In Agent Validator's Codex adapter source, `codex_usage_not_observed` is the default for fields
  absent from Codex's usage event. After complete collection it therefore means "not reported". The
  producer's original reason is preserved in provenance. Any other reason leaves the attempt unpriced,
  with the reason carried through.
- **Where:** the spec requirement plus two scenarios; design §1 and Decision 10; test plan INT-001 and
  INT-002 assertions.
- **Alternatives considered:** Accept `not_reported` only. Rejected: it would leave every Validator
  Codex attempt unpriced after agent-validator#160 lands, which contradicts the issue's acceptance
  criterion.
- **Decision-bearing:** yes. It relies on the Validator adapter's current reason semantics, which is
  noted as a risk area.

### AR-003: partial usage collection. Applied, choosing "untrustworthy".
- **Decision:** Pricing, exact or estimated, requires complete usage collection. With partial collection,
  counts can undercount any category, so the attempt stays unpriced. Its reason is
  `token usage collection is incomplete: <producer reason>` instead of the generic
  "no reported token usage". Usage and history completeness stay independent.
- **Where:** the spec requirement plus a scenario; design §1, §2 step 4, and Decision 9; test plan
  INT-001 partial-collection case.
- **Alternatives considered:** Price valid category envelopes regardless of completeness. Rejected: it
  risks a confident undercount.
- **Decision-bearing:** yes. Not a direction-level stop: it narrows the spec toward the issue's "no
  attempt is ever counted as zero" posture, and current Codex and Validator attempts have complete
  collection.

### AR-004: conflicting context-tier definitions. Applied.
- **Decision:** The earlier lowest-threshold precedence rule is replaced.
  - Tier definitions are collected without ranking.
  - Base rates with no assumption apply only when the prompt is known to be within the lowest
    threshold.
  - Tier rates apply only when the billed tokens belong to one request, its prompt is known to be
    above the highest threshold, and all definitions agree on rates.
  - Any other known size gets base rates plus `context_tier_ambiguous_priced_at_base` (`estimated`).
    Unknown sizes keep `context_tier_unknown_priced_at_base`.
- **Where:** the spec requirement plus a disputed-range scenario; design §2 and Decision 4; unit tests
  in the design test plan and the test-plan risk areas.
- **Alternatives considered:**
  - Leave the disputed range unavailable. Harsher than issue decision 2's "base rates plus disclosure".
  - Prefer the structured `tiers` entry. No catalog documentation supports that precedence.
- **Decision-bearing:** yes. It supersedes the design decision "Lowest tier threshold governs".

## tasks

### One implementation task covering both delivery slices
- **Decision:** `tasks.md` holds exactly one implementation task, as the factory step instructs. It
  links to `tasks/01-estimated-per-step-cost.md`, following the repository's archived task-file
  convention. The task builds the issue's two slices in order, and each ends at a commit with a green
  `npm run check`. The issue's PR 1 / PR 2 split therefore stays possible without splitting the task.
- **Alternatives considered:** Two tasks, one per PR. This contradicts the step's "exactly one task"
  instruction.
- **Decision-bearing:** no. Delivery packaging is unchanged from issue decision 4, and not a stop.
