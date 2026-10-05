# evaluation-metrics-reporting Specification

## Purpose
Define durable evaluation usage, cost, timing, result, report, reference-comparison, and publication artifacts.
## Requirements
### Requirement: Agent Runner metrics ingestion
The evaluation harness SHALL consume Agent Runner `run-metrics.json` schema versions 1 through 4 as its only supported source for implementation-workflow attempts, token usage, reported cost, and active duration. It SHALL NOT read Validator-private telemetry directly or reconstruct missing metrics from transcripts, audit-log text, or CLI output. It SHALL validate that the artifact names the recorded Agent Runner run and workflow, preserve a copy and SHA-256 hash of the source artifact, and retain every attempt across retries and resumed execution sessions.

For schema v4, `native_measurements`, supported current `measurement_heads`, `measurement_totals`, and `validator_contexts` SHALL be authoritative. The harness SHALL NOT add the `steps` compatibility projection to those measurements. It SHALL preserve the selected record revision and digest, Runner attribution, producer/source versions, invocation records including confirmed zero-dispatch invocations, requested/resolved/observed identities, exact field envelopes, precision and derivation, per-model allocations, unallocated usage, and provider-reported cost evidence. Unsupported outer, aggregate, native, or producer measurement versions and unsupported fields SHALL be rejected rather than replaced with compatibility data or an older head.

History, delivery, usage, identity, per-model attribution, and pricing completeness SHALL remain independent. Delivery gaps, unavailable and partial values, approximate precision, and unknown inclusion or overlap SHALL remain explicit. In particular, an unavailable cache-write value SHALL NOT become zero, uncached input SHALL NOT be derived by subtraction unless the source establishes those semantics, and a grand total SHALL remain unavailable unless its components are complete and non-overlapping. Schemas v1-v3 retain their existing legacy mappings and limitations.

#### Scenario: Valid Agent Runner metrics are ingested
- **WHEN** the recorded Agent Runner run provides a supported `run-metrics.json` with matching run identity
- **THEN** the harness preserves the source artifact and imports all attempts, identities, usage states, canonical totals, costs, durations, coverage, and history completeness

#### Scenario: Schema-version-2 effective identity is available
- **WHEN** an attempt reports requested and effective invocation identity plus stable role and tool fields
- **THEN** the harness attributes and prices the attempt using its effective identity
- **AND** it preserves the requested identity and source fields for diagnosis

#### Scenario: Schema-version-3 execution attribution is available
- **WHEN** the recorded run reports schema-version-3 execution sessions, session rollups, and Git change attribution
- **THEN** the harness preserves those fields alongside every existing identity, usage, cost, duration, and coverage field

#### Scenario: Schema-version-4 authoritative measurements are available
- **WHEN** a matching schema-v4 artifact contains native measurements and supported current Validator measurement heads
- **THEN** the harness counts each dispatched model attempt exactly once from those authoritative sources
- **AND** it preserves invocation, revision, digest, attribution, identity, token-envelope, allocation, cost-evidence, and completeness data
- **AND** it does not add usage from the compatibility `steps` view

#### Scenario: Validator delivery is incomplete
- **WHEN** schema v4 reports a missing, blocked, conflicting, or unsupported Validator measurement delivery
- **THEN** delivery is incomplete with its gaps preserved and totals that could omit work remain incomplete
- **AND** independently established history and usable sibling measurements remain available

#### Scenario: Unsupported nested contract is present
- **WHEN** schema v4 contains an unsupported aggregate, native-measurement, or producer-measurement version or field
- **THEN** the harness rejects the artifact instead of using a stale head or compatibility projection

#### Scenario: Agent Runner metric is unavailable
- **WHEN** a step's usage or cost is explicitly unavailable in `run-metrics.json`
- **THEN** the evaluation result preserves the unavailable value and reason rather than substituting zero

#### Scenario: Metrics artifact does not match the run
- **WHEN** `run-metrics.json` names a different run or workflow, is unreadable, or uses an unsupported schema
- **THEN** the harness rejects it as implementation metrics input
- **AND** it marks implementation metrics incomplete without reconstructing them from unsupported sources

#### Scenario: Resumed attempts are retained
- **WHEN** Agent Runner resumes and appends attempts to `run-metrics.json`
- **THEN** the harness includes both the earlier and resumed attempts in implementation metrics

### Requirement: Agent-and-model implementation cost aggregation
The harness SHALL assign each Agent Runner agent attempt to its workflow agent role and actual provider/model using workflow, step, role-configuration, and usage source-and-version details. It SHALL aggregate attempts by the exact tuple `agent role + provider + model`, preserving token categories and summing every attempt and retry.

Each aggregate row SHALL contain its agent role, tool, provider, model, allocation kind, participating-attempt count, available token-category totals, canonical token totals, cost amount, cost source, verification state, and completeness. A row's verification state SHALL be unverified when any contributing resolved cost is unverified, otherwise estimated when any is estimated, and otherwise verified. A multi-model dispatch SHALL remain one dispatch while producing separate attributed model rows and, when applicable, an explicit unallocated row; row participation counts are non-additive. When a multi-model dispatch's cost is resolved only as a whole-attempt amount that is not divided among its allocations, the harness SHALL report that amount in a separate cost-only row for the attempt's agent role with allocation kind `unattributed_cost`, no provider, no model, and no token usage; it SHALL NOT divide the amount among the model rows, and those model rows SHALL keep their usage and mark their cost as not allocated rather than unresolved. When the total is complete, it SHALL equal the sum of all row amounts, including cost-only rows. The result SHALL count the authoritative attempt total once and SHALL also report canonical total tokens across all implementation attempts when complete. The result SHALL report a numeric total estimated API cost only when every Agent Runner agent attempt that invoked a CLI has a resolved cost. If any such attempt remains unresolved, it SHALL report a known-cost subtotal and an unavailable/incomplete total; it SHALL NOT obtain a numeric total by treating unresolved attempts as zero.

The total SHALL disclose its pricing verification: the weakest attempt verification state among resolved attempts under the ordering defined by Pricing verification ordering, and whether it includes `estimated` figures and whether it includes `unverified` figures. This disclosure SHALL be present whether the total is numeric or unavailable.

#### Scenario: Repeated attempts use the same agent and model
- **WHEN** an agent role invokes the same provider/model more than once through retries or resume
- **THEN** all attempts appear in one aggregate row and all reported usage and resolved costs contribute to that row

#### Scenario: One role uses different models
- **WHEN** attempts for one agent role use different actual models
- **THEN** the result reports a separate aggregate row for each provider/model

#### Scenario: Reported and catalog prices share a row
- **WHEN** an aggregate row has resolved costs with verification `reported` and `catalog`
- **THEN** its verification is `verified`

#### Scenario: One dispatch uses several models
- **WHEN** one authoritative attempt contains attributed model allocations and an unallocated remainder
- **THEN** the result reports each allocation and the unallocated remainder separately while keeping the dispatch count at one
- **AND** it counts the attempt-level usage only once in the implementation total

#### Scenario: Sole unallocated usage takes the attempt identity
- **WHEN** an attempt has only unallocated usage and its attempt-level identity names a selected provider and model
- **THEN** one `attempt` row carries that usage, the resolved provider and model, and any resolved whole-attempt cost

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

A catalog or fallback-table price SHALL have verification `catalog` when it rests on an exact reported partition at base rates that need no context-tier assumption, and `estimated` when any pricing assumption applies. A price from the fallback table SHALL be labelled with the source `fallback-table`, distinct from `models.dev`. When an earlier rate source failed before the fallback table resolved the attempt, pricing provenance SHALL retain each earlier source and failure reason in `prior_source_failures`.

Provider-reported cost SHALL remain distinct evidence with its attempt or allocation scope, currency, coverage, and overlap. Only an exhaustive full-attempt USD cost or exhaustive, disjoint full allocation costs MAY resolve an attempt directly, with verification `reported`. Partial, unknown-currency, unknown-scope, or potentially overlapping amounts MAY contribute a labeled known subtotal only when doing so cannot double count; they SHALL NOT be promoted to a full-attempt cost.

If neither models.dev nor the fallback table provides an exact usable match, the LLM judge SHALL be authorized to search for another pricing source and return a pricing finding. A judge-found rate SHALL have verification state `unverified`, MAY contribute to the total, and SHALL record the source URL, retrieval time, extracted rates and units, applicable token categories, requested and matched model identifiers, model-matching rationale, and judge model. Pricing lookup SHALL NOT affect product scoring.

If no exact defensible match or sufficient usage can be established, the attempt's cost SHALL remain unavailable. When an attempt has billing tokens but no exact provider and model identity, its reason SHALL be `exact provider and model identity are required for pricing`. When all reported billing categories are zero, its reason SHALL be `reported token usage is zero`; `no reported token usage to price this attempt with` SHALL describe missing usage only. Such an attempt SHALL remain unresolved, and the total SHALL remain unavailable with any known subtotal retained. The harness SHALL NOT infer a price from a similar model name, from a default or configured model that the attempt did not report, or by omitting an unpriced token category to manufacture a complete estimate.

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

#### Scenario: Fallback follows an incomplete catalog rate
- **WHEN** models.dev matches the exact model but lacks a rate for a billed category and the fallback table resolves the attempt
- **THEN** the fallback-table pricing provenance includes the models.dev failure in `prior_source_failures`

#### Scenario: Similarly named model is not matched
- **WHEN** an attempt's model differs from every models.dev and fallback-table model id, even if a listed id differs only by a suffix, prefix, version, or case
- **THEN** neither source prices the attempt and resolution continues to the LLM judge

#### Scenario: Models.dev cannot price an attempt
- **WHEN** models.dev is unavailable or lacks an exact usable provider/model match
- **THEN** the harness consults the checked-in fallback pricing table for an exact provider/model row
- **AND** when the fallback table also has no exact usable row, the harness asks the LLM judge to search for another pricing source

#### Scenario: Judge finds another pricing source
- **WHEN** the LLM judge returns a source, exact model match, rates, units, and matching rationale sufficient to calculate the attempt cost
- **THEN** the harness calculates the cost and labels it `unverified`
- **AND** it preserves the complete pricing finding and source URL

#### Scenario: Attempt lacks model identity
- **WHEN** an attempt has billing tokens but a null provider or model
- **THEN** its cost is unavailable with reason `exact provider and model identity are required for pricing`
- **AND** no catalog, fallback-table, or judge price is applied

#### Scenario: All reported billing categories are zero
- **WHEN** an attempt reports billing categories and every category count is zero
- **THEN** its cost is unresolved with reason `reported token usage is zero`
- **AND** the overall total remains unavailable while retaining the known subtotal

#### Scenario: Pricing remains ambiguous
- **WHEN** neither models.dev, the fallback table, nor the LLM judge establishes a defensible exact price or the required token usage is unavailable
- **THEN** the attempt cost remains unavailable and the overall total-cost completeness reflects the gap

### Requirement: Implementation-only cost scope
Only agent invocations executed inside the Agent Runner implementation workflow SHALL contribute to agent-and-model costs and the total estimated API cost. Eval-owned judging, evidence or screenshot repair, pricing lookup or parsing, deterministic checks, human review, scoring, and report generation SHALL NOT be priced or included in that total.

The harness SHALL durably capture eval-owned Codex usage when the CLI reports it, including phase, provider, model, raw token categories, and canonical token totals. Missing eval-owned telemetry SHALL remain explicitly unavailable or partial. Eval-owned usage SHALL stay outside implementation cost aggregation and SHALL NOT be priced. Cost SHALL remain report-only and SHALL NOT affect product points, gates, or pass status.

#### Scenario: Implementation agent incurs cost
- **WHEN** a lead-agent or task-implementor invocation inside Agent Runner has a resolved cost
- **THEN** that cost contributes to its agent-and-model row and the implementation total

#### Scenario: LLM judge incurs usage
- **WHEN** the eval-owned judge reports token usage
- **THEN** the harness may report that usage diagnostically
- **AND** it does not price the usage or include it in the implementation total

#### Scenario: Cost changes but product quality does not
- **WHEN** two otherwise identical runs have different implementation costs
- **THEN** the cost difference is reported without changing either run's product score or pass conditions

### Requirement: Machine-only timing
The result SHALL report Agent Runner implementation active duration, the active duration of each automated eval phase, and total active machine duration across resumes. Automated eval phases SHALL include applicable install, build, verification, candidate-server setup, browser evaluation, evidence capture or repair, LLM judging, scoring, and report-generation work.

Timing SHALL exclude time while the eval process is stopped, time awaiting a human reviewer, and time spent answering, revising, or confirming human-review questions. The harness SHALL NOT record a human-review duration.

#### Scenario: Uninterrupted machine execution
- **WHEN** the automated evaluation runs without interruption
- **THEN** the result reports implementation duration, automated phase durations, and their total active machine duration

#### Scenario: Eval resumes after a pause
- **WHEN** an eval is interrupted and resumed later
- **THEN** total active machine duration sums the recorded machine execution sessions and excludes the interruption gap

#### Scenario: Human review remains pending
- **WHEN** automated evaluation finishes and human review occurs later
- **THEN** pending time and reviewer interaction time do not contribute to any reported duration

### Requirement: Detailed result artifact
The harness SHALL atomically write a versioned `result.json` containing run kind; evaluation status and candidate product verdict when applicable; score denominator; component applicability; `official_score` when complete candidate scoring produced one; `automated_subtotal` when all applicable automated scoring is complete; a nullable `score.automated_pass` eligibility decision and structured `score.automated_failures`; `available_component_scores` for individually completed components; component, subcomponent, criterion, and gate results; any user-approved technical adjudication with raw scores, revised scores, approver, time, rationale, and findings; automated and human rubric provenance; human responses and rationales; Agent Runner workflow, agent-role provenance, and linked-audit lifecycle states and warnings; candidate repository, branch, draft-PR URL, base, draft state, final local SHA, and final PR SHA; the final Validator's successful or intentional skipped result and candidate-reported CI status when present; verified acceptance-evidence lineage; separate candidate-produced and evaluator-produced evidence summaries; per-agent/model/allocation implementation usage and costs with dispatch counts; pricing evidence and verification state; machine phase timing; checkpoint and resume history; independent history, delivery, usage, identity, per-model-attribution, and pricing completeness fields; artifact references; and the shared-92 reference comparison when applicable.

The harness SHALL NOT rescale `automated_subtotal`, `available_component_scores`, a reference score, or the shared comparison. In human-facing output, provenance SHALL be labeled in plain language as "source and version details."

#### Scenario: Complete result is written
- **WHEN** official candidate scoring completes
- **THEN** `result.json` contains the official score out of 100, full scoring breakdown, candidate and PR identity, metrics, source and version details, and completeness

#### Scenario: Human review is pending
- **WHEN** all candidate automated scoring completes, `score.automated_pass=true`, and human review is not finalized
- **THEN** `result.json` contains the automated subtotal out of 70 and no `official_score`

#### Scenario: Automated requirements fail before human review
- **WHEN** complete candidate automated scoring produces `score.automated_pass=false`
- **THEN** `result.json` records `evaluation_status=complete`, `product_verdict=fail`, the automated subtotal, and structured `score.automated_failures`
- **AND** it contains no `official_score` or human-review record

#### Scenario: Automated eligibility is unavailable
- **WHEN** required automated scoring or gate evidence is incomplete
- **THEN** `score.automated_pass` is null and `score.automated_failures` is empty
- **AND** the owning workflow or harness failure is reported instead of a product verdict inferred from missing evidence

#### Scenario: Evaluation stops after some components complete
- **WHEN** an incomplete evaluation has evidence-backed completed component results
- **THEN** `result.json` preserves them as `available_component_scores`
- **AND** it does not convert them into an unofficial total

#### Scenario: Conclusive product failure is written without a score
- **WHEN** product-owned installation, build, or serve failure conclusively fails the candidate before complete scoring
- **THEN** `result.json` records `evaluation_status=complete`, `product_verdict=fail`, the failed hard gate, and available component results
- **AND** it contains no `official_score` or fabricated human responses

#### Scenario: Result is updated after resume
- **WHEN** resumed evaluation produces additional durable results
- **THEN** the harness atomically replaces `result.json` with a version containing both preserved and newly completed work

#### Scenario: Linked audit finishes or fails
- **WHEN** Agent Runner reports a completed or failed linked audit for the source execution session
- **THEN** `result.json` records its run identity, execution-session identity, trigger, terminal state, and warning without changing product scoring

#### Scenario: Reference baseline result is written
- **WHEN** the existing implementation completes applicable automated and human scoring as a `reference-baseline` run
- **THEN** its local `result.json` records a denominator of 92 and marks testing evidence and assumption handling not applicable
- **AND** it marks Agent Runner roles, implementation cost, and implementation timing not applicable rather than zero

#### Scenario: Candidate is linked to its baseline
- **WHEN** a completed candidate was reviewed against a completed reference with matching rubric provenance
- **THEN** its result records the reference run identity plus the shared-92 total, component, subcomponent, and gate comparisons
- **AND** it keeps the candidate's official score out of 100 separate from that comparison

#### Scenario: Candidate delivery identity is recorded
- **WHEN** a candidate reaches scored judging
- **THEN** `result.json` records its repository, `eval/and-scene/<run-id>` branch, draft-PR URL and base, draft state, matching final local and PR SHA, mode-consistent final Validator outcome, and any candidate-reported CI status

#### Scenario: Technical adjudication is recorded
- **WHEN** the user approves a post-run technical adjudication
- **THEN** `result.json` retains the raw component and criterion results and records the revised shared component scores plus the adjudication audit data
- **AND** its automated subtotal, official score, and shared comparison reflect the approved revision

### Requirement: Self-contained HTML report
Every evaluation SHALL produce a self-contained static artifact named `report.html`, including evaluations that complete, fail, remain incomplete, or await human review. The report SHALL be viewable offline without a server or external assets, SHALL escape untrusted content, and SHALL NOT execute candidate-provided markup or scripts. Artifact links SHALL be relative to the report's run directory and SHALL be rendered as links only when the linked artifact is included in that directory.

A candidate report SHALL lead with `PASS` or `FAIL` when a product verdict is available, `EVALUATION FAILED` when a workflow or harness failure prevents a product verdict, or `PENDING HUMAN REVIEW` while awaiting review. When a candidate product verdict is available but a later harness failure leaves the evaluation status failed, the report SHALL display both facts prominently. A local reference report SHALL display its score out of 92 and SHALL NOT display a candidate pass/fail label. The report SHALL treat every technical-adjudication field as untrusted data, render it only as escaped text, and SHALL NOT interpret it as HTML or script.

The report SHALL present a concise score and outcome summary followed by expandable details for score denominator; component applicability; raw and adjudicated component scores when applicable; component and subcomponent scores; thresholds; gates; every automated criterion and its rationale and evidence; human ratings and rationales; candidate repository, branch, draft PR, final SHA, Validator results, and candidate-reported CI status when present; separate candidate-produced and evaluator-produced evidence sections; workflow and harness outcomes; agent roles and models; implementation usage and cost; pricing sources; machine timing; completeness; and source and version details. A candidate linked to a local reference SHALL display the shared-92 totals, components, subcomponents, gates, and deltas separately from the candidate's official score, without treating not-applicable reference components or implementation metrics as zero.

The harness SHALL generate or update the report whenever `result.json` reaches a durable pending, terminal, resumed, or finalized state.

#### Scenario: Completed product passes
- **WHEN** official candidate scoring produces a pass verdict
- **THEN** `report.html` prominently displays `PASS` and the official score out of 100

#### Scenario: Completed product fails
- **WHEN** official candidate scoring produces a fail verdict
- **THEN** `report.html` prominently displays `FAIL` and the official score out of 100

#### Scenario: Conclusive unscored candidate fails
- **WHEN** product-owned installation, build, or serve failure conclusively produces a fail verdict before official scoring
- **THEN** `report.html` prominently displays `FAIL`, explains that the product could not install, build, or serve, and shows available component and hard-gate evidence
- **AND** it displays no official score or fabricated human ratings

#### Scenario: Evaluation infrastructure fails
- **WHEN** workflow or harness failure prevents an official candidate verdict
- **THEN** `report.html` prominently displays `EVALUATION FAILED`
- **AND** it states that the candidate verdict is unavailable while showing completed diagnostic results

#### Scenario: Harness fails after product scoring
- **WHEN** an official candidate verdict was durably recorded before a later harness failure
- **THEN** `report.html`, when available, prominently displays both the `PASS` or `FAIL` product verdict and the harness-failure status
- **AND** it does not erase or change the candidate score

#### Scenario: Human review is pending
- **WHEN** automated evaluation completes with the candidate eligible for human review and no finalized human review
- **THEN** `report.html` prominently displays `PENDING HUMAN REVIEW` and the applicable automated subtotal and denominator

#### Scenario: Automated requirements conclusively fail
- **WHEN** complete automated evidence establishes that the candidate cannot satisfy the official pass contract
- **THEN** `report.html` prominently displays `FAIL`, the automated subtotal, and the automated requirement failure
- **AND** it states that no official score was produced because human review was not required

#### Scenario: Candidate content contains markup
- **WHEN** report content includes candidate-controlled HTML or script-like text
- **THEN** the report renders it as inert text rather than executable content

#### Scenario: Evidence ownership is rendered
- **WHEN** the report contains candidate-produced and evaluator-produced evidence
- **THEN** it renders the two sources in visibly separate labeled sections
- **AND** it does not present evaluator evidence as proof produced by the candidate

#### Scenario: Baseline comparison is rendered
- **WHEN** a completed candidate references a completed local reference produced by matching automated and human rubric versions and hashes
- **THEN** `report.html` displays their shared-92 totals, applicable components, subcomponents, gates, and deltas
- **AND** it keeps the candidate's official score out of 100 visually separate

#### Scenario: Baseline rubric does not match
- **WHEN** a candidate and proposed local reference use different automated or human rubric versions or hashes
- **THEN** the report refuses to present their scores as a direct comparison
- **AND** it explains the provenance mismatch

#### Scenario: Local reference report is rendered
- **WHEN** the reference's applicable automated and human scoring is complete
- **THEN** its local report displays the score out of 92 and component applicability
- **AND** it displays no candidate pass/fail verdict

#### Scenario: Adjudicated score is rendered
- **WHEN** a completed candidate carries an approved technical adjudication
- **THEN** the report clearly distinguishes raw automated results from revised component and aggregate scores
- **AND** it displays the approver, time, rationale, and consequential findings

### Requirement: Permanent result publication
After human review finalizes an Agent Runner candidate with `evaluation_status=complete` and product verdict `pass` or `fail`, the harness SHALL copy exactly `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`. The candidate's `result.json` and `report.html` SHALL contain verified evidence summaries, ownership labels, hashes, final-revision provenance, coverage findings, and any shared-92 comparison. From the agent-evals working directory, the harness SHALL stage and commit only that exact result directory with message `chore: record and-scene eval <run-id>` and SHALL run an ordinary `git push` on the current branch's configured upstream.

The only eligible run kind SHALL be an Agent Runner candidate with a finalized scored pass or product-fail result and completed human review. A conclusive product failure without an official score or human review SHALL remain a local diagnostic and SHALL NOT be published as the finalized benchmark result. A completed publication MAY be superseded without rerunning the evaluation only by its first comparable reference attachment or by a validated user-approved technical adjudication reproducible from the previously published result and the embedded adjudication record; any other score-changing replacement SHALL be rejected. Failed adjudication validation SHALL leave the published snapshot unchanged, record a durable diagnostic identifying the validation failure, and exit nonzero; only publication failures that can succeed without changing the adjudication input SHALL use a retryable publication checkpoint. The permanent snapshot SHALL exclude runtime state, cloned repositories, dependency and build output, Agent Runner session state and transcripts, raw LLM output, full logs, raw acceptance or evaluator screenshots, traces, raw pricing catalogs, credentials, and unrelated working-tree files. A commit or push failure SHALL preserve the completed candidate result, record a retryable publication checkpoint, and exit nonzero. Resume SHALL retry only the unfinished publication work, reuse an existing result commit, and SHALL NOT rerun evaluation or human review, create a duplicate commit, or force-push.

#### Scenario: Completed result is published permanently
- **WHEN** human review finalizes an Agent Runner candidate with `evaluation_status=complete` and product verdict `pass` or `fail`
- **THEN** the harness copies `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`
- **AND** from the agent-evals working directory it commits only that exact result directory and runs `git push` on the current branch's configured upstream

#### Scenario: Incomplete result is not published
- **WHEN** a run is not a finalized scored Agent Runner candidate pass or product-fail result with completed human review
- **THEN** the harness does not create or push a permanent result commit for that run

#### Scenario: Published report retains evidence audit data
- **WHEN** the harness prepares a permanent candidate result
- **THEN** its result and report include evidence summaries, ownership, hashes, final-revision provenance, coverage findings, and contradictions
- **AND** an auditor can distinguish candidate proof from evaluator diagnostics

#### Scenario: Permanent snapshot excludes runtime data
- **WHEN** the harness prepares a permanent result directory
- **THEN** it excludes `.runtime`, cloned repositories, dependency and build output, Agent Runner session state and transcripts, raw LLM output, full logs, raw screenshots, traces, raw pricing catalogs, credentials, and unrelated working-tree files

#### Scenario: Publication fails after evaluation completes
- **WHEN** the path-limited commit or ordinary push fails for an otherwise completed candidate pass or product-fail run
- **THEN** the completed product result remains unchanged, the publication checkpoint records the error, and the command exits nonzero
- **AND** resume retries publication without rerunning automated evaluation or human review

#### Scenario: Publication is retried after commit
- **WHEN** the result commit exists locally but its push did not complete
- **THEN** resume reuses that exact commit and retries the ordinary push without creating a duplicate result commit or force-pushing

#### Scenario: Published result is technically adjudicated
- **WHEN** a user-approved technical adjudication is reproducible from the previously published result and its embedded audit record
- **THEN** publication creates and pushes one superseding curated result commit without rerunning evaluation or human review
- **AND** it rejects score-changing replacements that are not a valid adjudication

#### Scenario: Published adjudication is invalid
- **WHEN** a proposed technical adjudication is malformed, incomplete, inconsistent with raw scores, or not reproducible
- **THEN** publication leaves the existing snapshot unchanged and records a durable diagnostic identifying the validation failure
- **AND** the publication command exits nonzero

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

### Requirement: Evidence ownership and acceptance provenance reporting
Every evidence reference in `result.json` and `report.html` SHALL identify whether it was candidate-produced or evaluator-produced. A candidate-evidence summary SHALL record its kind, stable artifact identifier or path, SHA-256 hash, revision or lineage, verification state, covered requirement or flow, limitations, and any contradiction with verified evaluator evidence. An evaluator-evidence summary SHALL record the same applicable integrity and coverage information while remaining in a separate namespace.

Raw evidence SHALL remain in the local run directory or preserved candidate resources. Permanent candidate publication SHALL include verified summaries and hashes but SHALL NOT copy raw screenshots, logs, traces, or Runner session artifacts.

#### Scenario: Candidate evidence is summarized
- **WHEN** verified candidate acceptance evidence contributes to judging
- **THEN** the result records its candidate ownership, hash, lineage, verification state, coverage, and limitations

#### Scenario: Evaluator evidence is summarized
- **WHEN** the harness captures a deterministic result, probe, or screenshot
- **THEN** the result records it in the evaluator namespace
- **AND** the report does not attribute it to the candidate

#### Scenario: Evidence sources contradict
- **WHEN** candidate-produced and evaluator-produced evidence disagree
- **THEN** both summaries retain their ownership and integrity data
- **AND** the result records the contradiction without merging or rewriting either source

#### Scenario: Published candidate omits raw evidence
- **WHEN** a finalized candidate result is permanently published
- **THEN** the published result and report retain evidence summaries and hashes
- **AND** raw screenshots, logs, traces, and Runner session artifacts remain outside the committed result directory

### Requirement: Verdict source reporting
`result.json` and `report.html` SHALL identify, for every scored deterministic criterion, whether its verdict came from the owning evaluator or from a declared fallback judge, and whether a second opinion was applied to it. A fallback-resolved criterion SHALL be visibly marked in the report as decided by the LLM because the browser check could not observe it, and SHALL show both the browser's not-observed record, including the conventions it looked for, and the fallback judge's verdict, rationale, and source citations. The result SHALL record the count of fallback-resolved criteria and the points they carry, so a reader can see how much of an automated score rests on fallback verdicts.

A result that predates this capability and carries no verdict-source data SHALL render as before and SHALL NOT be shown as fallback-resolved. A result that carries no second-opinion data SHALL render without second-opinion markings.

#### Scenario: A fallback-resolved criterion is reported
- **WHEN** a result contains a criterion resolved by its fallback judge
- **THEN** the report marks that criterion as decided by the LLM because the browser check could not observe it
- **AND** it shows the not-observed record and the fallback verdict with its citations
- **AND** the result records the number of fallback-resolved criteria and their points

#### Scenario: No criterion needed a fallback
- **WHEN** every deterministic criterion was observed
- **THEN** the result records zero fallback-resolved criteria
- **AND** the report shows no fallback marking

#### Scenario: An earlier published result is rendered
- **WHEN** a report is regenerated for a result that carries no verdict-source data
- **THEN** the report renders without fallback markings

#### Scenario: A second-opinion verdict is identified
- **WHEN** a deterministic criterion's owner recorded `fail` and a second opinion was applied
- **THEN** the result and report identify the verdict as coming from the owning evaluator with a second opinion applied

### Requirement: Estimated attempt pricing
When an attempt does not report an exact billing-token partition, the harness SHALL derive estimated billing tokens only through the rules in this requirement, and SHALL record every assumption applied in the attempt's pricing provenance.

Collection completeness: token pricing, whether exact or estimated, SHALL require the attempt's usage collection to be complete. When collection is partial or unavailable, the attempt SHALL have no billing tokens even if individual category counts are present, because missing collection can undercount any category; its cost SHALL remain unavailable with a reason stating that usage collection is incomplete and carrying the producer's reason when one is reported. Usage and history completeness SHALL continue to be reported independently.

Uncached input: a producer-supplied `input_uncached` count SHALL be used when available. Otherwise, only when the attempt's usage source format establishes that reported input includes cached input (`codex:turn.completed` and `codex-exec-jsonl-turn.completed`), the harness SHALL derive uncached input as total input minus cache reads. For any other source format, a missing `input_uncached` SHALL leave the attempt without billing tokens. A derivation that requires an unavailable total input or cache-read count, or that yields a negative count, SHALL leave the attempt without billing tokens.

Cache writes: when uncached input is established, usage collection is complete, and the source marks the cache-write count unavailable with a reason that means the producer's usage record has no cache-write field, the harness SHALL price all uncached input at the exact model's input rate, record the assumption `cache_write_not_reported_priced_as_input` together with the producer's original reason, and resolve the attempt as `estimated`. The recognized reasons are `not_reported` and, for source format `codex-exec-jsonl-turn.completed` only, Agent Validator's `codex_usage_not_observed`. Any other unavailability reason SHALL leave the attempt without billing tokens and SHALL preserve that reason. Reasoning tokens that the source establishes are included in output SHALL be billed only within output.

Context tiers: when the exact rate source defines a context-size tier, the harness SHALL apply the tier's rates only when the attempt's prompt size is known to exceed the tier threshold, and SHALL use base rates without an assumption when the prompt size is known not to exceed it. An attempt's reported total input, including cached input, is an upper bound on any single request's prompt size: when that total does not exceed the threshold, the prompt size is known not to exceed it. A reported per-request maximum at or below the lowest threshold also establishes that every prompt is within it, even if aggregate input exceeds that threshold. A reported per-request maximum above the threshold proves that at least one request crossed it, but does not identify the billed tokens for that request. The harness SHALL apply tier rates to an attempt's aggregate tokens only when those tokens belong to one request and that request's prompt is known to exceed the threshold. When a maximum is known but the token partition is not, the harness SHALL use base rates with `context_tier_ambiguous_priced_at_base`. When prompt size is unknown, it SHALL use base rates with `context_tier_unknown_priced_at_base`. Both assumptions resolve the attempt as `estimated`.

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

#### Scenario: Per-request maximum is within the lowest tier threshold
- **WHEN** total input exceeds the lowest context-tier threshold but the reported maximum prompt for any request is at or below it
- **THEN** the attempt is priced at base rates with no context-tier assumption and verification `catalog` when no other assumption applies

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
The suite SHALL include a checked-in fallback pricing table at `evals/agent-runner/and-scene/pricing/fallback-rates.json`. Each row SHALL state provider, exact model id, per-category rates, unit, the vendor's published pricing page as source URL, and retrieved date. Context tiers SHALL appear only as structured `tiers`; legacy `context_over_*` keys SHALL be rejected. A row SHALL match an attempt only when both its provider and model id equal the attempt's exactly. A table that cannot be read, fails validation, or contains more than one row for the same provider and model id SHALL be treated as unavailable for pricing, with its reason recorded, and resolution SHALL continue to the LLM judge. The repository's automated checks SHALL reject an invalid table.

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

#### Scenario: Legacy context tier appears in a fallback row
- **WHEN** a fallback row contains a `context_over_*` rate key
- **THEN** table validation rejects it even when a structured context tier is also present

### Requirement: Pricing verification ordering
Attempt pricing verification states SHALL be ordered from strongest to weakest as `reported`, `catalog`, `estimated`, `unverified`. The pricing summary, totals, and step rollups SHALL use the weakest state among their resolved parts; aggregate rows SHALL use the row vocabulary defined in Agent-and-model implementation cost aggregation. An unresolved part SHALL NOT be assigned a verification state; it SHALL instead make the combined amount unavailable while the known subtotal of resolved parts is retained. The pricing summary SHALL report as verified only when pricing is complete and every resolved cost is `reported` or `catalog`.

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
`report.html` SHALL render a per-step cost table built from `cost.steps` and `cost.step_rollup`, grouped by top-level step. Each group SHALL show the rollup's attempt count, amount or unavailable state, known subtotal, and verification, followed by one row per attempt showing step path, role, model, token counts, cost or unavailable reason, source, verification, and assumptions. An incomplete rollup SHALL display verification as `partial (resolved: <verification>)`, or `partial` if no child is resolved. The report SHALL keep the existing agent-and-model cost table and SHALL display the pricing schedule identity. It SHALL NOT render the raw per-attempt pricing records as a JSON dump. A result that predates per-step cost SHALL render with a statement that per-step cost was not recorded, and without failing.

#### Scenario: Per-step table is rendered
- **WHEN** a result contains `cost.steps` and `cost.step_rollup`
- **THEN** the report shows the per-step table grouped by top-level step alongside the agent-and-model table

#### Scenario: Estimated and unavailable costs are distinguishable
- **WHEN** a step contains an estimated attempt and an unavailable attempt
- **THEN** the report labels the estimated cost with its verification and assumptions and shows the unavailable attempt's reason instead of a number

#### Scenario: Incomplete rollup has resolved estimated children
- **WHEN** a rollup has an unavailable amount and its resolved children have weakest verification `estimated`
- **THEN** the report shows `partial (resolved: estimated)` beside the unavailable amount

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

### Requirement: Second-opinion reporting
For every criterion and hard gate that received a second opinion, `result.json` SHALL record:

- the raw verdict;
- the second-opinion verdict;
- the verifier decision: `uphold`, accepted `overturn`, or rejected `overturn`;
- the verifier rationale;
- for an overturn, the named mismeasured step or observation, every cited source span with its path, start line, and end line, every cited log or artifact span, the audit classification, and, when rejected, the rejection reason.

The criterion, subcomponent, component, gate, and eligibility results SHALL reflect the second-opinion verdicts. The result SHALL also record the browser evaluator's raw `verification-sample-outline` gate beside the derived gate. It SHALL record the count of checked failures, the count of accepted overturns, and the points the accepted overturns carry. Re-deriving the scores from the raw verdicts alone SHALL remain possible from the recorded data.

`report.html` SHALL show accepted overturns in a short "Overturned failures" section, separate from the criterion details. Each entry SHALL show the criterion or gate, the raw `fail` and its probe rationale, the verifier's explanation of the measurement fault, and the cited spans, all rendered as escaped text. When no failure was overturned, the section SHALL say so or be omitted. Upheld failures and rejected overturns SHALL be shown with their criterion or gate details rather than in that section. A reference-baseline or calibration result, which has no second opinions, SHALL show no second-opinion markings.

Verifier usage SHALL be captured as eval-owned judge usage and SHALL stay outside implementation cost, like other eval-owned judging.

#### Scenario: An accepted overturn is reported
- **WHEN** a result contains a criterion whose raw `fail` was overturned
- **THEN** `result.json` records the raw `fail`, the second-opinion `pass`, the rationale, the mismeasured step, the cited spans, and the audit classification
- **AND** `report.html` lists the criterion in the "Overturned failures" section

#### Scenario: Upheld failures are reported
- **WHEN** every checked failure was upheld
- **THEN** `result.json` records each raw and second-opinion `fail` with its rationale and zero accepted overturns
- **AND** the report's "Overturned failures" section lists no entries

#### Scenario: A rejected overturn is reported
- **WHEN** the verifier overturned a failure but the overturn was rejected
- **THEN** `result.json` records the rejected overturn and the rejection reason
- **AND** the report shows it with the criterion details and does not list it as overturned

#### Scenario: Verifier usage is recorded
- **WHEN** verifier calls report token usage
- **THEN** the usage is recorded as eval-owned judge usage
- **AND** it is not included in implementation cost

#### Scenario: Verifier text contains markup
- **WHEN** a verifier rationale or cited text contains HTML or script-like text
- **THEN** the report renders it as inert text

