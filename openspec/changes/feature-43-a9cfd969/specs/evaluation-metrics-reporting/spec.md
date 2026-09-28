## MODIFIED Requirements

### Requirement: Agent-and-model implementation cost aggregation
The harness SHALL assign each Agent Runner agent attempt to its workflow agent role and actual provider/model using workflow, step, role-configuration, and usage source-and-version details. It SHALL aggregate attempts by the exact tuple `agent role + provider + model`, preserving token categories and summing every attempt and retry.

Each aggregate row SHALL contain its agent role, tool, provider, model, allocation kind, participating-attempt count, available token-category totals, canonical token totals, cost amount, cost source, verification state, and completeness. A row's verification state SHALL be `unverified` when any contributing resolved cost is `unverified`, otherwise `estimated` when any contributing resolved cost is `estimated`, and otherwise `verified`. A multi-model dispatch SHALL remain one dispatch while producing separate attributed model rows and, when applicable, an explicit unallocated row; row participation counts are non-additive. When a multi-model dispatch's cost is resolved only as a whole-attempt amount that is not divided among its allocations, the harness SHALL report that amount in a separate cost-only row for the attempt's agent role with allocation kind `unattributed_cost`, no provider, no model, and no token usage; it SHALL NOT divide the amount among the model rows, and those model rows SHALL keep their usage and mark their cost as not allocated rather than unresolved. When the total is complete, it SHALL equal the sum of all row amounts, including cost-only rows. The result SHALL count the authoritative attempt total once and SHALL also report canonical total tokens across all implementation attempts when complete. The result SHALL report a numeric total estimated API cost only when every Agent Runner agent attempt that invoked a CLI has a resolved cost. If any such attempt remains unresolved, it SHALL report a known-cost subtotal and an unavailable/incomplete total; it SHALL NOT obtain a numeric total by treating unresolved attempts as zero.

The total SHALL disclose its pricing verification: the weakest attempt verification state among resolved attempts under the ordering defined by Pricing verification ordering, and whether it includes `estimated` figures and whether it includes `unverified` figures. This disclosure SHALL be present whether the total is numeric or unavailable.

#### Scenario: Repeated attempts use the same agent and model
- **WHEN** an agent role invokes the same provider/model more than once through retries or resume
- **THEN** all attempts appear in one aggregate row and all reported usage and resolved costs contribute to that row

#### Scenario: One role uses different models
- **WHEN** attempts for one agent role use different actual models
- **THEN** the result reports a separate aggregate row for each provider/model

#### Scenario: One dispatch uses several models
- **WHEN** one authoritative attempt contains attributed model allocations and an unallocated remainder
- **THEN** the result reports each allocation and the unallocated remainder separately while keeping the dispatch count at one
- **AND** it counts the attempt-level usage only once in the implementation total

#### Scenario: Every implementation attempt has resolved cost
- **WHEN** every Agent Runner agent attempt that invoked a CLI has a reported or calculated cost
- **THEN** the result reports the sum of all agent-and-model rows as the total estimated API cost

#### Scenario: One implementation attempt has unresolved cost
- **WHEN** any Agent Runner agent attempt that invoked a CLI has no defensible cost
- **THEN** the result reports the sum of resolved rows as a known-cost subtotal
- **AND** the total estimated API cost remains unavailable and is marked incomplete

#### Scenario: Complete total includes estimated figures
- **WHEN** every CLI attempt is resolved and at least one attempt resolved as `estimated` while none resolved as `unverified`
- **THEN** the total is numeric
- **AND** the total's verification is `estimated` and it states that it includes estimated figures and no unverified figures

#### Scenario: Single-identity attempt lacks per-model attribution
- **WHEN** an attempt reports one resolved provider and model, no observed per-model allocation, and a resolved attempt cost
- **THEN** the attempt contributes its usage and cost to the row for its role and resolved provider and model
- **AND** it does not appear in an unallocated row

#### Scenario: Single attributed allocation carries a whole-attempt cost
- **WHEN** an attempt's usage is entirely one attributed allocation and the attempt cost is resolved at attempt level
- **THEN** that allocation's row includes the attempt's cost

#### Scenario: Multi-model dispatch has only a whole-attempt reported cost
- **WHEN** one attempt has several attributed allocations and a resolved whole-attempt reported cost without per-allocation costs
- **THEN** each allocation's model row keeps its usage and marks its cost as not allocated
- **AND** a cost-only `unattributed_cost` row for the attempt's role carries the whole-attempt amount
- **AND** the complete total equals the sum of all row amounts

#### Scenario: Row mixes catalog and estimated attempts
- **WHEN** one agent-and-model row contains an attempt resolved as `catalog` and another resolved as `estimated`
- **THEN** the row's verification is `estimated`

#### Scenario: Unresolved Validator attempts block the total
- **WHEN** all Runner Codex attempts resolve as `estimated` and one or more Agent Validator attempts are unresolved because they lack an exact provider and model
- **THEN** the total remains unavailable with a known-cost subtotal that includes the estimated Runner attempts
- **AND** the total's verification disclosure states that the known subtotal includes estimated figures

### Requirement: Real-time pricing resolution
For each Agent Runner agent attempt without exhaustive, non-overlapping reported USD cost, the harness SHALL resolve cost from the following sources in order, stopping at the first that yields a defensible price: an exact provider/model lookup in the current `https://models.dev/api.json` catalog; an exact provider/model row in the checked-in fallback pricing table; and an LLM judge pricing search. A successful catalog or fallback-table calculation SHALL require billing tokens for the attempt and a compatible rate for every billed token category, where billing tokens are either an exact reported partition or the estimate defined by Estimated attempt pricing. A fully attributed multi-model attempt SHALL be priced from its exact allocations separately; an unallocated remainder prevents a complete allocation-derived estimate. The harness SHALL record the retrieval time, response SHA-256 hash, requested and matched provider/model identifiers, rates, units, token categories used, and any pricing assumptions.

A catalog or fallback-table price SHALL have verification `catalog` when it rests on an exact reported partition at base rates that need no context-tier assumption, and `estimated` when any pricing assumption applies. A price from the fallback table SHALL be labelled with the source `fallback-table`, distinct from `models.dev`.

Provider-reported cost SHALL remain distinct evidence with its attempt or allocation scope, currency, coverage, and overlap. Only an exhaustive full-attempt USD cost or exhaustive, disjoint full allocation costs MAY resolve an attempt directly, with verification `reported`. Partial, unknown-currency, unknown-scope, or potentially overlapping amounts MAY contribute a labeled known subtotal only when doing so cannot double count; they SHALL NOT be promoted to a full-attempt cost.

If neither models.dev nor the fallback table provides an exact usable match, the LLM judge SHALL be authorized to search for another pricing source and return a pricing finding. A judge-found rate SHALL have verification state `unverified`, MAY contribute to the total, and SHALL record the source URL, retrieval time, extracted rates and units, applicable token categories, requested and matched model identifiers, model-matching rationale, and judge model. Pricing lookup SHALL NOT affect product scoring.

If no exact defensible match or sufficient usage can be established, the attempt's cost SHALL remain unavailable. When an attempt has billing tokens but no exact provider and model identity, its reason SHALL be `exact provider and model identity are required for pricing`. The harness SHALL NOT infer a price from a similar model name, from a default or configured model that the attempt did not report, or by omitting an unpriced token category to manufacture a complete estimate.

#### Scenario: Agent Runner reports cost
- **WHEN** an Agent Runner agent attempt contains a non-null reported USD cost
- **THEN** the harness uses that value without performing a pricing lookup for the attempt
- **AND** it labels the cost as Agent Runner reported with verification `reported`

#### Scenario: Provider reports allocation costs
- **WHEN** one multi-model attempt reports exhaustive, disjoint, full USD costs for every allocation and no unallocated work
- **THEN** the harness resolves the attempt from their sum while retaining every scoped cost record
- **AND** partial, overlapping, unknown-scope, or unknown-currency evidence does not become a complete attempt cost

#### Scenario: Models.dev provides an exact usable match
- **WHEN** Agent Runner does not report cost and models.dev contains exact provider/model rates compatible with an exact reported token partition for an untiered model
- **THEN** the harness calculates the attempt cost from those rates and tokens with source `models.dev` and verification `catalog`
- **AND** it records the catalog response and matching details

#### Scenario: Codex attempt is priced from models.dev as an estimate
- **WHEN** a Codex attempt has reported total input, cached input, and output tokens, no cache-write figure, and an exact models.dev match
- **THEN** the harness calculates its cost with source `models.dev` and verification `estimated`
- **AND** the pricing provenance lists the assumption `cache_write_not_reported_priced_as_input`

#### Scenario: Fallback table prices a model models.dev lacks
- **WHEN** models.dev is unavailable or lacks an exact usable match and the fallback table has a row with the attempt's exact provider and model id
- **THEN** the harness calculates the cost from that row with source `fallback-table`
- **AND** it records the row's source URL, retrieved date, rates, unit, and the table's SHA-256 hash
- **AND** it does not invoke the LLM judge for that attempt

#### Scenario: Similarly named model is not matched
- **WHEN** an attempt's model differs from every models.dev and fallback-table model id, even if a listed id differs only by a suffix, prefix, version, or case
- **THEN** neither source prices the attempt and resolution continues to the LLM judge

#### Scenario: Models.dev and fallback table cannot price an attempt
- **WHEN** models.dev is unavailable or lacks an exact usable provider/model match and the fallback table has no exact usable row
- **THEN** the harness asks the LLM judge to search for another pricing source

#### Scenario: Judge finds another pricing source
- **WHEN** the LLM judge returns a source, exact model match, rates, units, and matching rationale sufficient to calculate the attempt cost
- **THEN** the harness calculates the cost and labels it `unverified`
- **AND** it preserves the complete pricing finding and source URL

#### Scenario: Attempt lacks model identity
- **WHEN** an attempt has billing tokens but a null provider or model
- **THEN** its cost is unavailable with reason `exact provider and model identity are required for pricing`
- **AND** no catalog, fallback-table, or judge price is applied

#### Scenario: Pricing remains ambiguous
- **WHEN** neither models.dev, the fallback table, nor the LLM judge establishes a defensible exact price or the required token usage is unavailable
- **THEN** the attempt cost remains unavailable and the overall total-cost completeness reflects the gap

### Requirement: Independent completeness reporting
The evaluation SHALL report score, implementation usage, implementation cost, pricing, timing, candidate evidence, evaluator evidence, final-revision alignment, candidate-reported CI evidence when present, workflow provenance, judge coverage, and metric-history completeness independently. An unavailable, incomplete, or defective value in one dimension SHALL NOT be represented as zero or silently alter another dimension's completeness.

#### Scenario: Usage is unavailable but Runner reports cost
- **WHEN** Agent Runner reports an attempt cost while token usage is unavailable
- **THEN** cost completeness is determined from the available cost inputs while usage remains explicitly unavailable

#### Scenario: Price is unverified
- **WHEN** a judge-found price contributes to a complete numeric total
- **THEN** total-cost completeness is determined independently from pricing verification
- **AND** pricing verification states that the total contains unverified pricing

#### Scenario: Price is estimated
- **WHEN** an estimated price contributes to a complete numeric total and no price is unverified
- **THEN** total-cost completeness is `complete`
- **AND** pricing completeness is `estimated`, and the pricing summary states that the total contains estimated pricing and is not reported as verified

#### Scenario: Runner metric history was lost
- **WHEN** Agent Runner reports `history_complete=false`
- **THEN** the result preserves that state independently of the usage and cost coverage calculated from the remaining records

#### Scenario: Candidate evidence is incomplete
- **WHEN** candidate-produced evidence omits required coverage, provenance, or proof while the required artifact set exists
- **THEN** candidate-evidence completeness identifies the defect
- **AND** evaluator-evidence completeness remains independent

#### Scenario: Evaluator evidence is incomplete
- **WHEN** an independent deterministic probe or evaluator capture is unavailable
- **THEN** evaluator-evidence completeness identifies the gap
- **AND** it does not present candidate evidence as a replacement

#### Scenario: Evidence applies to the wrong revision
- **WHEN** candidate-produced evidence is present but its lineage does not terminate at the final evaluated SHA
- **THEN** the result marks final-revision alignment defective rather than absent
- **AND** it preserves the evidence for diagnosis

#### Scenario: Product evidence is incomplete
- **WHEN** some product criteria were never observed
- **THEN** score completeness identifies the gap without turning the missing observations into product failures

## ADDED Requirements

### Requirement: Estimated attempt pricing
When an attempt does not report an exact billing-token partition, the harness SHALL derive estimated billing tokens only through the rules in this requirement, and SHALL record every assumption applied in the attempt's pricing provenance.

Collection completeness: token pricing, whether exact or estimated, SHALL require the attempt's usage collection to be complete. When collection is partial or unavailable, the attempt SHALL have no billing tokens even if individual category counts are present, because missing collection can undercount any category; its cost SHALL remain unavailable with a reason stating that usage collection is incomplete and carrying the producer's reason when one is reported. Usage and history completeness SHALL continue to be reported independently.

Uncached input: a producer-supplied `input_uncached` count SHALL be used when available. Otherwise, only when the attempt's usage source format establishes that reported input includes cached input (`codex:turn.completed` and `codex-exec-jsonl-turn.completed`), the harness SHALL derive uncached input as total input minus cache reads. For any other source format, a missing `input_uncached` SHALL leave the attempt without billing tokens. A derivation that requires an unavailable total input or cache-read count, or that yields a negative count, SHALL leave the attempt without billing tokens.

Cache writes: when uncached input is established, usage collection is complete, and the source marks the cache-write count unavailable with a reason that means the producer's usage record has no cache-write field, the harness SHALL price all uncached input at the exact model's input rate, record the assumption `cache_write_not_reported_priced_as_input` together with the producer's original reason, and resolve the attempt as `estimated`. The recognized reasons are `not_reported` and, for source format `codex-exec-jsonl-turn.completed` only, Agent Validator's `codex_usage_not_observed`. Any other unavailability reason SHALL leave the attempt without billing tokens and SHALL preserve that reason. Reasoning tokens that the source establishes are included in output SHALL be billed only within output.

Context tiers: when the exact rate source defines a context-size tier, the harness SHALL apply the tier's rates only when the attempt's prompt size is known to exceed the tier threshold, and SHALL use base rates without an assumption when the prompt size is known not to exceed it. An attempt's reported total input, including cached input, is an upper bound on any single request's prompt size: when that total does not exceed the threshold, the prompt size is known not to exceed it. A reported per-request maximum above the threshold proves that at least one request crossed it, but does not identify the billed tokens for that request. The harness SHALL apply tier rates to an attempt's aggregate tokens only when those tokens belong to one request and that request's prompt is known to exceed the threshold. When a maximum is known but the token partition is not, the harness SHALL use base rates with `context_tier_ambiguous_priced_at_base`. When prompt size is unknown, it SHALL use base rates with `context_tier_unknown_priced_at_base`. Both assumptions resolve the attempt as `estimated`.

When one rate source declares several context-tier definitions whose thresholds or rates disagree, the harness SHALL NOT choose one by precedence. Base rates without an assumption SHALL apply only when the prompt size is known not to exceed the lowest declared threshold. Tier rates without an assumption SHALL apply only when the billed tokens belong to one request, that request's prompt is known to exceed the highest declared threshold, and every definition specifies the same tier rates. For any other known prompt size, the harness SHALL price at base rates, record the assumption `context_tier_ambiguous_priced_at_base`, and resolve the attempt as `estimated`; an unknown prompt size SHALL be handled as above.

#### Scenario: Codex source establishes uncached input
- **WHEN** an attempt with source format `codex:turn.completed` or `codex-exec-jsonl-turn.completed` reports total input, cache-read, and output counts but no `input_uncached`
- **THEN** its billing tokens contain uncached input equal to total input minus cache reads, cached input equal to cache reads, and output
- **AND** the attempt is eligible for exact-model pricing

#### Scenario: Validator Codex attempt omits cache writes
- **WHEN** a `codex-exec-jsonl-turn.completed` attempt with complete usage collection marks cache writes unavailable with reason `codex_usage_not_observed`
- **THEN** it is priced with the assumption `cache_write_not_reported_priced_as_input`
- **AND** its pricing provenance preserves the original reason `codex_usage_not_observed`

#### Scenario: Cache writes are unavailable for another reason
- **WHEN** a Codex-format attempt marks cache writes unavailable with a reason other than a recognized not-reported reason
- **THEN** it has no billing tokens and its cost remains unavailable with a reason that carries the original cache-write reason

#### Scenario: Producer supplies uncached input
- **WHEN** a Codex-format attempt reports `input_uncached` directly
- **THEN** the harness uses the reported value rather than the derived one

#### Scenario: Non-Codex source lacks uncached input
- **WHEN** an attempt whose source format does not establish that input includes cached input reports total input and cache reads but no `input_uncached`
- **THEN** it has no billing tokens and its cost remains unavailable

#### Scenario: Usage collection is incomplete
- **WHEN** a Codex-format attempt reports total input, cache-read, and output counts but its usage collection is partial
- **THEN** it has no billing tokens
- **AND** its cost is unavailable with a reason stating that usage collection is incomplete, rather than that no usage was reported

#### Scenario: Derived uncached input would be negative
- **WHEN** a Codex-format attempt reports more cache reads than total input
- **THEN** it has no billing tokens and its cost remains unavailable with a reason naming the unusable count

#### Scenario: Full partition with an untiered model
- **WHEN** an attempt reports uncached input, cache reads, cache writes, and output, and its exact model has no context tier
- **THEN** it resolves with verification `catalog` and records no pricing assumption

#### Scenario: Prompt size unknown for a tiered model
- **WHEN** an attempt's exact rate source defines a context tier, its total input exceeds the tier threshold, and no per-request prompt size is reported
- **THEN** the attempt is priced at base rates with verification `estimated`
- **AND** its pricing provenance lists `context_tier_unknown_priced_at_base`

#### Scenario: Total input is within a tier threshold
- **WHEN** an attempt's exact rate source defines one or more context tiers and the attempt's total input, including cached input, does not exceed the lowest declared threshold
- **THEN** the attempt is priced at base rates and no context-tier assumption is recorded

#### Scenario: Prompt size known to exceed a tier
- **WHEN** an attempt's billed tokens belong to one request, its producer reports that request's prompt size above every declared context-tier threshold of its exact model, and all declared definitions agree on the tier rates
- **THEN** the attempt is priced at those tier rates and no context-tier assumption is recorded

#### Scenario: One long request among several
- **WHEN** an attempt has aggregate billing tokens for several requests and the producer reports a maximum prompt size above every tier threshold
- **THEN** the attempt is priced at base rates with verification `estimated`
- **AND** its pricing provenance lists `context_tier_ambiguous_priced_at_base`

#### Scenario: Known prompt size falls between conflicting tier thresholds
- **WHEN** a rate source declares context-tier thresholds of 200,000 and 272,000 tokens for one model and the attempt's producer reports a per-request prompt size of 240,000 tokens
- **THEN** the attempt is priced at base rates with verification `estimated`
- **AND** its pricing provenance lists `context_tier_ambiguous_priced_at_base`

### Requirement: Pinned fallback pricing table
The suite SHALL include a checked-in fallback pricing table at `evals/agent-runner/and-scene/pricing/fallback-rates.json`. Each row SHALL state provider, exact model id, per-category rates, unit, source URL, and retrieved date. A row SHALL match an attempt only when both its provider and model id equal the attempt's exactly. A table that cannot be read, fails validation, or contains more than one row for the same provider and model id SHALL be treated as unavailable for pricing, with its reason recorded, and resolution SHALL continue to the LLM judge. The repository's automated checks SHALL reject an invalid table.

#### Scenario: Valid table row prices an attempt
- **WHEN** models.dev cannot price an attempt and the table contains exactly one row for its provider and model id
- **THEN** the attempt is priced from that row with source `fallback-table`

#### Scenario: Table is invalid at evaluation time
- **WHEN** the fallback table is missing, malformed, or has duplicate provider and model rows
- **THEN** pricing records the table as unavailable with a reason
- **AND** attempts that models.dev cannot price proceed to the LLM judge

#### Scenario: Invalid table is committed
- **WHEN** a change introduces a fallback-table row missing a required field or duplicating another row's provider and model id
- **THEN** the repository's automated checks fail

### Requirement: Pricing verification ordering
Attempt pricing verification states SHALL be ordered from strongest to weakest as `reported`, `catalog`, `estimated`, `unverified`. Wherever the harness combines resolved costs into one figure, the combined verification SHALL be the weakest state among the resolved parts. An unresolved part SHALL NOT be assigned a verification state; it SHALL instead make the combined amount unavailable while the known subtotal of resolved parts is retained. The pricing summary SHALL report as verified only when pricing is complete and every resolved cost is `reported` or `catalog`.

#### Scenario: Weakest state wins
- **WHEN** a combined figure has resolved parts with verifications `reported`, `catalog`, and `estimated`
- **THEN** the combined verification is `estimated`

#### Scenario: One part is unverified
- **WHEN** any resolved part of a combined figure is `unverified`
- **THEN** the combined verification is `unverified`

#### Scenario: One part is unavailable
- **WHEN** one part of a combined figure is unresolved
- **THEN** the combined amount is null, its known subtotal sums the resolved parts, and it is marked incomplete

### Requirement: Pricing schedule disclosure
Every result that performs pricing SHALL record the pricing schedule it used: the models.dev URL, state, retrieval time, and response SHA-256 hash, and the fallback table's path, state, and file SHA-256 hash. Costs SHALL reflect public prices at evaluation time in the pricing source order; two results SHALL be comparable on pricing schedule by these recorded identities.

#### Scenario: Pricing uses the live catalog
- **WHEN** a result prices any attempt
- **THEN** the result records the catalog retrieval time and hash and the fallback table hash

#### Scenario: Catalog is unavailable
- **WHEN** the models.dev request fails or times out
- **THEN** the result records the catalog state as unavailable with a reason and still records the fallback table identity

### Requirement: Per-step implementation cost
`result.json` SHALL contain `cost.steps` with exactly one entry for every Agent Runner agent attempt that invoked a CLI, including Agent Validator attempts attributed to Runner steps. Each entry SHALL state the attempt id, full step path, top-level workflow step, producer, agent role, CLI, provider, model, billing tokens, amount in USD, cost state, source, verification, pricing assumptions, unresolved reason, and duration in milliseconds, each null when unavailable. An unresolved entry SHALL have a null amount and SHALL NOT be counted as zero.

`result.json` SHALL also contain `cost.step_rollup` with one row per top-level workflow step that has at least one CLI attempt, in first-observed workflow order. Each row SHALL state the top-level step, attempt count, known subtotal, amount, completeness, and combined verification under Pricing verification ordering. A row's amount SHALL be null when any of its attempts is unresolved. The top-level step of an Agent Runner attempt SHALL be the first segment of its step path without any iteration suffix. An Agent Validator attempt SHALL roll up under the top-level step of the Runner step that invoked it, identified by its Runner attribution. A CLI attempt whose top-level step cannot be established SHALL appear in an explicit unattributed rollup row rather than being omitted. Every CLI attempt SHALL belong to exactly one rollup row.

When the implementation cost total is complete, the rollup amounts SHALL sum to `cost.total` within the result's rounding precision.

#### Scenario: Runner Codex attempt is recorded per step
- **WHEN** a Runner implementor attempt at `implement-tasks:0/implement-single-task/sub:implement-task/generate-code` is priced as `estimated`
- **THEN** its `cost.steps` entry records that step path, top-level step `implement-tasks`, its role, CLI, provider, model, billing tokens, amount, source, verification `estimated`, and the assumption `cache_write_not_reported_priced_as_input`

#### Scenario: Validator attempt rolls up under its invoking step
- **WHEN** an Agent Validator attempt's Runner attribution prefix begins with `implement-tasks:0/`
- **THEN** its cost is included in the `implement-tasks` rollup row

#### Scenario: Validator attempt has no Runner attribution
- **WHEN** an Agent Validator attempt carries no Runner attribution
- **THEN** it appears in `cost.steps` and in the unattributed rollup row

#### Scenario: Step has an unresolved attempt
- **WHEN** a top-level step contains one attempt without a defensible cost and other resolved attempts
- **THEN** that rollup row's amount is null, its known subtotal sums the resolved attempts, and it is marked incomplete
- **AND** its verification is the weakest state among its resolved attempts

#### Scenario: Complete cost reconciles across steps
- **WHEN** every CLI attempt is resolved
- **THEN** the sum of rollup amounts equals `cost.total` within rounding precision

#### Scenario: Multi-model attempt is recorded per step
- **WHEN** one attempt contains several attributed model allocations
- **THEN** it has exactly one `cost.steps` entry whose amount equals the attempt's resolved cost
- **AND** the entry lists each allocation's id, provider, model, amount, source, and verification

### Requirement: Per-step cost report
`report.html` SHALL render a per-step cost table built from `cost.steps` and `cost.step_rollup`, grouped by top-level step. Each group SHALL show the rollup's attempt count, amount or unavailable state, known subtotal, and verification, followed by one row per attempt showing step path, role, model, token counts, cost or unavailable reason, source, verification, and assumptions. The report SHALL keep the existing agent-and-model cost table and SHALL display the pricing schedule identity. It SHALL NOT render the raw per-attempt pricing records as a JSON dump. A result that predates per-step cost SHALL render with a statement that per-step cost was not recorded, and without failing.

#### Scenario: Per-step table is rendered
- **WHEN** a result contains `cost.steps` and `cost.step_rollup`
- **THEN** the report shows the per-step table grouped by top-level step alongside the agent-and-model table

#### Scenario: Estimated and unavailable costs are distinguishable
- **WHEN** a step contains an estimated attempt and an unavailable attempt
- **THEN** the report labels the estimated cost with its verification and assumptions and shows the unavailable attempt's reason instead of a number

#### Scenario: Earlier published result is rendered
- **WHEN** a report is regenerated for a result without `cost.steps`
- **THEN** the report states that per-step cost was not recorded and renders the remaining sections

### Requirement: Pricing re-resolution on evaluator-only rescore
An evaluator-only rescore SHALL re-resolve implementation pricing and cost from the source run's retained attempts, rederiving billing tokens from their retained token envelopes and source formats, rather than copying the source result's pricing and cost. It SHALL record that pricing was re-resolved and the pricing schedule used, and SHALL NOT modify the source run. Re-resolved pricing SHALL NOT affect product scoring. Rescore SHALL require a retained private run directory; a published result directory alone SHALL be rejected as a rescore source.

#### Scenario: Previously unpriced Codex attempts are repriced
- **WHEN** a rescore imports a completed run whose Runner Codex attempts were unpriced and whose models are listed in models.dev
- **THEN** the new result prices those attempts with verification `estimated` and the cache-write assumption
- **AND** attempts that were Agent Runner reported keep their reported cost

#### Scenario: Published result directory is given as rescore source
- **WHEN** the rescore source is a published result directory without the retained run state
- **THEN** the harness rejects the source without producing a result
