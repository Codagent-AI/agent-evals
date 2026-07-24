## ADDED Requirements

### Requirement: Agent Runner metrics ingestion
The evaluation harness SHALL consume schema-version-1 `run-metrics.json` as the supported source for Agent Runner implementation-workflow attempts, token usage, reported cost, and active duration. It SHALL validate that the artifact names the recorded Agent Runner run and workflow, preserve a copy and SHA-256 hash of the source artifact, and retain every attempt across retries and resumed execution sessions.

The harness SHALL preserve reported token categories, usage and cost coverage, unavailable reasons, and `history_complete`. It SHALL NOT reconstruct missing Agent Runner metrics from transcripts, audit-log text, or CLI output, and SHALL NOT represent missing metrics as zero.

#### Scenario: Valid Agent Runner metrics are ingested
- **WHEN** the recorded Agent Runner run provides a schema-version-1 `run-metrics.json` with matching run identity
- **THEN** the harness preserves the source artifact and imports all attempts, usage states, costs, durations, coverage, and history completeness

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

Each aggregate row SHALL contain its agent role, provider, model, attempt count, available token-category totals, cost amount, cost source, verification state, and completeness. The result SHALL report a numeric total estimated API cost only when every Agent Runner agent attempt that invoked a CLI has a resolved cost. If any such attempt remains unresolved, it SHALL report a known-cost subtotal and an unavailable/incomplete total; it SHALL NOT obtain a numeric total by treating unresolved attempts as zero.

#### Scenario: Repeated attempts use the same agent and model
- **WHEN** an agent role invokes the same provider/model more than once through retries or resume
- **THEN** all attempts appear in one aggregate row and all reported usage and resolved costs contribute to that row

#### Scenario: One role uses different models
- **WHEN** attempts for one agent role use different actual models
- **THEN** the result reports a separate aggregate row for each provider/model

#### Scenario: Every implementation attempt has resolved cost
- **WHEN** every Agent Runner agent attempt that invoked a CLI has a reported or calculated cost
- **THEN** the result reports the sum of all agent-and-model rows as the total estimated API cost

#### Scenario: One implementation attempt has unresolved cost
- **WHEN** any Agent Runner agent attempt that invoked a CLI has no defensible cost
- **THEN** the result reports the sum of resolved rows as a known-cost subtotal
- **AND** the total estimated API cost remains unavailable and is marked incomplete

### Requirement: Real-time pricing resolution
For each Agent Runner agent attempt without a reported USD cost, the harness SHALL first attempt an exact provider/model lookup from the current `https://models.dev/api.json` catalog. A successful catalog calculation SHALL require compatible token usage and rates for every billed token category needed by that provider/model. The harness SHALL record the retrieval time, response SHA-256 hash, requested and matched provider/model identifiers, rates, units, and token categories used.

If models.dev is unavailable or does not provide an exact usable match, the LLM judge SHALL be authorized to search for another pricing source and return a pricing finding. A judge-found rate SHALL have verification state `unverified`, MAY contribute to the total, and SHALL record the source URL, retrieval time, extracted rates and units, applicable token categories, requested and matched model identifiers, model-matching rationale, and judge model. Pricing lookup SHALL NOT affect product scoring.

If no exact defensible match or sufficient usage can be established, the attempt's cost SHALL remain unavailable. The harness SHALL NOT infer a price from a similar model name or omit an unpriced token category to manufacture a complete estimate.

#### Scenario: Agent Runner reports cost
- **WHEN** an Agent Runner agent attempt contains a non-null reported USD cost
- **THEN** the harness uses that value without performing a pricing lookup for the attempt
- **AND** it labels the cost as Agent Runner reported

#### Scenario: Models.dev provides an exact usable match
- **WHEN** Agent Runner does not report cost and models.dev contains exact provider/model rates compatible with the attempt's usage
- **THEN** the harness calculates the attempt cost from those rates and tokens
- **AND** it records the catalog response and matching details

#### Scenario: Models.dev cannot price an attempt
- **WHEN** models.dev is unavailable or lacks an exact usable provider/model match
- **THEN** the harness asks the LLM judge to search for another pricing source

#### Scenario: Judge finds another pricing source
- **WHEN** the LLM judge returns a source, exact model match, rates, units, and matching rationale sufficient to calculate the attempt cost
- **THEN** the harness calculates the cost and labels it `unverified`
- **AND** it preserves the complete pricing finding and source URL

#### Scenario: Pricing remains ambiguous
- **WHEN** neither models.dev nor the LLM judge establishes a defensible exact price or the required token usage is unavailable
- **THEN** the attempt cost remains unavailable and the overall total-cost completeness reflects the gap

### Requirement: Implementation-only cost scope
Only agent invocations executed inside the Agent Runner implementation workflow SHALL contribute to agent-and-model costs and the total estimated API cost. Eval-owned judging, evidence or screenshot repair, pricing lookup or parsing, deterministic checks, human review, scoring, and report generation SHALL NOT be priced or included in that total.

The harness MAY report eval-owned usage when available, but SHALL keep it outside implementation cost aggregation. Cost SHALL remain report-only and SHALL NOT affect product points, gates, or pass status.

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
The harness SHALL atomically write a versioned `result.json` containing run kind; evaluation status and product verdict; `official_score` when complete; `automated_subtotal` when all automated scoring is complete; `available_component_scores` for individually completed components; component, subcomponent, criterion, and gate results; automated and human rubric provenance; human responses and rationales; Agent Runner workflow and agent-role provenance; per-agent/model implementation usage and costs; pricing evidence and verification state; machine phase timing; checkpoint and resume history; independent completeness fields; artifact references; and reference-baseline identity and score deltas when applicable.

The harness SHALL NOT rescale `automated_subtotal` or `available_component_scores` into a score out of 100. In human-facing output, provenance SHALL be labeled in plain language as "source and version details."

#### Scenario: Complete result is written
- **WHEN** official scoring completes
- **THEN** `result.json` contains `official_score`, the full scoring breakdown, metrics, source and version details, and completeness

#### Scenario: Human review is pending
- **WHEN** all automated scoring completes without finalized human review
- **THEN** `result.json` contains `automated_subtotal` out of 70 and no `official_score`

#### Scenario: Evaluation stops after some components complete
- **WHEN** an incomplete evaluation has evidence-backed completed component results
- **THEN** `result.json` preserves them as `available_component_scores`
- **AND** it does not convert them into an unofficial total

#### Scenario: Result is updated after resume
- **WHEN** resumed evaluation produces additional durable results
- **THEN** the harness atomically replaces `result.json` with a version containing both preserved and newly completed work

#### Scenario: Reference baseline result is written
- **WHEN** the existing implementation completes automated and human scoring as a `reference-baseline` run
- **THEN** `result.json` contains the same product score breakdown and gates as an Agent Runner candidate
- **AND** it marks Agent Runner roles, implementation cost, and implementation timing not applicable rather than zero

#### Scenario: Candidate is linked to its baseline
- **WHEN** a completed Agent Runner candidate was reviewed against a completed reference baseline
- **THEN** its result records the baseline run identity plus total, component, subcomponent, and gate comparisons

### Requirement: Self-contained HTML report
Every evaluation SHALL produce a self-contained static artifact named `report.html`, including evaluations that complete, fail, remain incomplete, or await human review. The report SHALL be viewable offline without a server or external assets, SHALL escape untrusted content, and SHALL NOT execute candidate-provided markup or scripts. Artifact links SHALL be relative to the report's run directory.

The report SHALL lead with `PASS` or `FAIL` when a product verdict is available, `EVALUATION FAILED` when a workflow or harness failure prevents a product verdict, or `PENDING HUMAN REVIEW` while awaiting review. When a product verdict is available but a later harness failure leaves the evaluation status failed, the report SHALL display both facts prominently. It SHALL present a concise score and outcome summary followed by expandable details for component and subcomponent scores, thresholds, gates, every automated criterion and its rationale and evidence, human ratings and rationales, workflow and harness outcomes, agent roles and models, implementation usage and cost, pricing sources, machine timing, completeness, and source and version details. A candidate linked to a reference baseline SHALL also display total, component, subcomponent, and gate comparisons without treating not-applicable baseline implementation metrics as zero.

The harness SHALL generate or update the report whenever `result.json` reaches a durable pending, terminal, resumed, or finalized state.

#### Scenario: Completed product passes
- **WHEN** official scoring produces a pass verdict
- **THEN** `report.html` prominently displays `PASS` and the official score

#### Scenario: Completed product fails
- **WHEN** official scoring produces a fail verdict
- **THEN** `report.html` prominently displays `FAIL` and the official score

#### Scenario: Evaluation infrastructure fails
- **WHEN** workflow or harness failure prevents an official product verdict
- **THEN** `report.html` prominently displays `EVALUATION FAILED`
- **AND** it states that the product verdict is unavailable while showing completed diagnostic results

#### Scenario: Harness fails after product scoring
- **WHEN** an official product verdict was durably recorded before a later harness failure
- **THEN** `report.html`, when available, prominently displays both the `PASS` or `FAIL` product verdict and the harness-failure status
- **AND** it does not erase or change the product score

#### Scenario: Human review is pending
- **WHEN** automated evaluation completes without finalized human review
- **THEN** `report.html` prominently displays `PENDING HUMAN REVIEW` and the automated subtotal

#### Scenario: Candidate content contains markup
- **WHEN** report content includes candidate-controlled HTML or script-like text
- **THEN** the report renders it as inert text rather than executable content

#### Scenario: Baseline comparison is rendered
- **WHEN** a completed candidate result references a completed reference baseline produced by the same rubric versions
- **THEN** `report.html` displays the baseline and candidate totals, components, subcomponents, gates, and deltas

#### Scenario: Baseline rubric does not match
- **WHEN** a candidate and proposed reference baseline use different automated or human rubric versions or hashes
- **THEN** the report refuses to present their scores as a direct comparison

### Requirement: Permanent result publication
After human review finalizes a run with `evaluation_status=complete` and product verdict `pass` or `fail`, the harness SHALL copy exactly `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`. From the agent-evals working directory, it SHALL stage and commit only that exact result directory with message `chore: record and-scene eval <run-id>` and SHALL run an ordinary `git push` on the current branch's configured upstream.

The harness SHALL NOT publish pending-human-review, implementation-workflow-failed, evaluation-harness-failed, or calibration runs. The permanent snapshot SHALL exclude runtime state, cloned repositories, dependency and build output, Agent Runner session state and transcripts, raw LLM output, full logs, screenshots, traces, raw pricing catalogs, credentials, and unrelated working-tree files. A commit or push failure SHALL preserve the completed product result, record a retryable publication checkpoint, and exit nonzero. Resume SHALL retry only the unfinished publication work, reuse an existing result commit, and SHALL NOT rerun evaluation or human review, create a duplicate commit, or force-push.

#### Scenario: Completed result is published permanently
- **WHEN** human review finalizes a run with `evaluation_status=complete` and product verdict `pass` or `fail`
- **THEN** the harness copies `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`
- **AND** from the agent-evals working directory it commits only that exact result directory with message `chore: record and-scene eval <run-id>` and runs `git push` on the current branch's configured upstream

#### Scenario: Incomplete result is not published
- **WHEN** a run is pending human review or has an implementation-workflow or evaluation-harness failure
- **THEN** the harness does not create or push a permanent result commit for that run

#### Scenario: Permanent snapshot excludes runtime data
- **WHEN** the harness prepares a permanent result directory
- **THEN** it excludes `.runtime`, cloned repositories, dependency and build output, Agent Runner session state and transcripts, raw LLM output, full logs, screenshots, traces, raw pricing catalogs, credentials, and unrelated working-tree files

#### Scenario: Publication fails after evaluation completes
- **WHEN** the path-limited commit or ordinary push fails for an otherwise completed pass or product-fail run
- **THEN** the completed product result remains unchanged, the publication checkpoint records the error, and the command exits nonzero
- **AND** resume retries publication without rerunning automated evaluation or human review

#### Scenario: Publication is retried after commit
- **WHEN** the result commit exists locally but its push did not complete
- **THEN** resume reuses that exact commit and retries the ordinary push without creating a duplicate result commit or force-pushing

### Requirement: Independent completeness reporting
The evaluation SHALL report score, implementation usage, implementation cost, pricing, timing, evidence, workflow provenance, and metric-history completeness independently. An unavailable value in one dimension SHALL NOT be represented as zero or silently alter another dimension's completeness.

#### Scenario: Usage is unavailable but Runner reports cost
- **WHEN** Agent Runner reports an attempt cost while token usage is unavailable
- **THEN** cost may be complete while usage remains explicitly unavailable

#### Scenario: Price is unverified
- **WHEN** a judge-found price contributes to a complete numeric total
- **THEN** total-cost completeness may be complete
- **AND** pricing verification states that the total contains unverified pricing

#### Scenario: Runner metric history was lost
- **WHEN** Agent Runner reports `history_complete=false`
- **THEN** the result preserves that state independently of the usage and cost coverage calculated from the remaining records

#### Scenario: Product evidence is incomplete
- **WHEN** some product criteria were never observed
- **THEN** score completeness identifies the gap without turning the missing observations into product failures
