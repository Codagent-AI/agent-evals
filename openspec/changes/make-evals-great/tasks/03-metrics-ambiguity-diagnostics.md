# Task: Add metrics and ambiguity diagnostics

## Goal

Turn Agent Runner metrics and workflow evidence into independently complete implementation usage, cost, timing, and ambiguity diagnostics. Preserve source provenance and missingness without allowing any diagnostic dimension to change product scoring.

## Background

Add focused suite-local modules under `evals/agent-runner/and-scene/lib/` for schema-v1 Runner metrics ingestion, provider/model aggregation, pricing resolution, active-machine timing, and ambiguity ledger assembly. Persist their schema-versioned phase artifacts beneath the stable run directory and expose validated outputs to the result assembler.

`run-metrics.json` is owned by Agent Runner and is the only supported implementation-attempt metrics source. Preserve it and its SHA-256 hash; do not reconstruct missing values from logs or transcripts. Resolve missing reported cost first against an exact current `https://models.dev/api.json` match, then conditionally through a separately schema-constrained, web-enabled Codex pricing job. Similar-name inference and zero substitution are forbidden.

The prerequisite `tasks/02-product-evaluation-scoring.md` records the single Codex CLI/model authority in `evals/agent-runner/and-scene/judge-manifest.mjs`; this task must reuse that recorded authority for pricing and ambiguity jobs rather than selecting another.

The non-scoring ambiguity job uses Agent Runner workflow artifacts plus product evidence. It records reported and judge-discovered findings, classifies only observable evidence, and may propose unapproved future fixture clarifications without mutating the pinned fixture.

Use built-in Node facilities and the already selected Codex authority; do not add runtime dependencies. Implement test-first with fixture artifacts for retries, missingness, incomplete history, pricing units/categories, duplicated ambiguity findings, and resume.

## Spec

Source: `specs/evaluation-metrics-reporting/spec.md`

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

Source: `specs/ambiguity-evaluation/spec.md`

### Requirement: Observable ambiguity capture
The evaluation harness SHALL create a structured ambiguity ledger from assumption and context-gap information present in Agent Runner workflow artifacts. The harness SHALL capture findings explicitly reported by implementation agents and consequential ambiguity evidence discovered by the evaluation judge while examining the workflow artifacts and delivered product.

Each finding SHALL identify the originating run, workflow step, agent role, and task when available; state the assumption or context gap; reference the supporting artifacts or product evidence; and record the observable handling and consequence. The harness SHALL distinguish absent evidence from evidence that no ambiguity was reported, and SHALL NOT require the Agent Runner lead agent or task implementors to perform evaluation-owned classification work.

#### Scenario: Implementor reports an assumption
- **WHEN** an Agent Runner task-implementor artifact reports an assumption or missing-context concern
- **THEN** the harness records it in the ambiguity ledger with its origin, evidence, observable handling, and consequence

#### Scenario: Judge discovers a consequential unreported assumption
- **WHEN** the evaluation judge finds evidence that an unreported assumption materially affected the delivered product or implementation workflow
- **THEN** the harness records a judge-discovered finding and links it to the supporting evidence

#### Scenario: Agent Runner artifacts contain no ambiguity evidence
- **WHEN** the available workflow artifacts contain no reported or judge-discovered ambiguity evidence
- **THEN** the ledger records that no findings were observed for the evaluated artifacts

#### Scenario: Expected workflow artifacts are unavailable
- **WHEN** assumption or context-gap artifacts needed for evaluation are unavailable
- **THEN** the ledger marks ambiguity coverage incomplete rather than claiming that no ambiguity occurred

### Requirement: Evaluation-owned diagnostic classification
The evaluation judge SHALL classify each ambiguity finding using the available specification, task, repository, workflow, and product evidence. Supported classifications SHALL include genuine specification gap, missing discoverable repository context, legitimate implementation choice, incorrect assumption or false alarm, unnecessary escalation, and unresolved due to insufficient evidence.

The classification SHALL include a concise rationale, the observed resolution or unresolved state, and any associated product defect or implementation-workflow interruption. Classification SHALL describe observable evidence and SHALL NOT prescribe internal behavior for Agent Runner agents.

#### Scenario: Specification leaves required behavior undefined
- **WHEN** the evidence establishes that a required product decision cannot be resolved from the fixture specification, tasks, or relevant repository context
- **THEN** the judge classifies the finding as a genuine specification gap and explains the missing contract

#### Scenario: Relevant context was discoverable
- **WHEN** the reported gap is resolved by relevant repository context available to the implementation workflow
- **THEN** the judge classifies the finding as missing discoverable repository context and cites that context

#### Scenario: Multiple implementations satisfy the contract
- **WHEN** an implementation choice is not uniquely specified and the chosen behavior satisfies all applicable requirements
- **THEN** the judge classifies the finding as a legitimate implementation choice

#### Scenario: Escalation unnecessarily prevents progress
- **WHEN** an agent stops or escalates despite sufficient available context to make a requirement-conforming implementation choice
- **THEN** the judge classifies the finding as an unnecessary escalation and records the observable workflow consequence

#### Scenario: Evidence cannot support a reliable conclusion
- **WHEN** available artifacts are insufficient to distinguish among supported classifications
- **THEN** the judge classifies the finding as unresolved due to insufficient evidence without inventing a conclusion

### Requirement: Non-scoring ambiguity diagnostics
Ambiguity findings and classifications SHALL be diagnostic-only. They SHALL NOT add or subtract product points, create a scoring gate, or independently change the official product verdict.

An ambiguity-related product defect SHALL affect scoring only through the applicable product-quality criterion. An ambiguity-related interruption that prevents completion SHALL affect the result only through the applicable implementation-workflow outcome. A genuine specification gap SHALL remain diagnostic unless another specified scoring or outcome rule applies.

#### Scenario: Incorrect assumption causes a product defect
- **WHEN** an ambiguity finding is associated with behavior that fails a scored product criterion
- **THEN** the product criterion determines the scoring effect and the ambiguity finding adds no separate deduction

#### Scenario: Needless escalation stops implementation
- **WHEN** an unnecessary escalation prevents the Agent Runner workflow from completing
- **THEN** the evaluation uses the implementation-workflow outcome rules and adds no ambiguity score or gate

#### Scenario: Genuine fixture gap is found
- **WHEN** a finding is classified as a genuine specification gap without an independently applicable scoring or outcome rule
- **THEN** the evaluation reports the finding diagnostically without penalizing the candidate

### Requirement: Reviewed fixture-improvement proposals
For findings classified as genuine specification gaps or recurring sources of misleading ambiguity, the harness SHALL be able to record a proposed fixture improvement containing the affected fixture location, the observed problem, the proposed clarification, and the evidence supporting it. Proposed improvements SHALL be clearly marked as unapproved and SHALL require later human review before use in a future fixture version.

The harness SHALL NOT alter the pinned fixture, its specifications, or its tasks during an evaluation run.

#### Scenario: Finding suggests a fixture clarification
- **WHEN** ambiguity evidence supports a concrete improvement to a future fixture version
- **THEN** the ledger records an unapproved fixture-improvement proposal with its target, rationale, proposed clarification, and evidence

#### Scenario: Current run produces an improvement proposal
- **WHEN** an improvement proposal is recorded during an evaluation
- **THEN** the pinned fixture used by that run remains unchanged

#### Scenario: Proposal has not received human approval
- **WHEN** a fixture-improvement proposal has not been reviewed and approved by a human
- **THEN** the harness excludes it from future fixture inputs

### Requirement: Durable ambiguity ledger
The harness SHALL write the ambiguity ledger durably with the evaluation artifacts and reference it from `result.json` and `report.html`. Each finding SHALL have a stable identifier. On resume, the harness SHALL preserve prior findings, add newly supported evidence or findings, and avoid duplicating a finding already recorded for the same origin and concern.

#### Scenario: Evaluation resumes with existing findings
- **WHEN** an evaluation resumes after ambiguity findings were recorded
- **THEN** the harness preserves the existing stable findings and adds only new findings or evidence

#### Scenario: Same finding appears in resumed artifacts
- **WHEN** resumed workflow artifacts repeat an already recorded assumption or context gap
- **THEN** the harness updates or references the existing finding rather than creating a duplicate

#### Scenario: Evaluation report is generated
- **WHEN** `result.json` and `report.html` are written or updated
- **THEN** they reference or present the ambiguity ledger, its coverage, classifications, consequences, and unapproved fixture-improvement proposals as diagnostic information

## Done When

- Matching schema-v1 Runner metrics are preserved and ingested attempt-by-attempt across retries/resumes; mismatched or unsupported artifacts are rejected without transcript reconstruction.
- Usage and cost aggregate by exact `agent role + provider + model`, retain token categories and coverage, and report a numeric total only when every CLI attempt has a defensible cost.
- Models.dev and conditional web-pricing paths record retrieval/hash/match/rate/unit/category provenance; unresolved or unverified pricing is represented exactly as specified.
- Machine timing sums active implementation and automated phase intervals across resumes while excluding stopped-process gaps and all human-review time.
- `ambiguity-ledger.json` has stable deduplicated findings, evidence-backed classifications and consequences, explicit coverage, and clearly unapproved fixture-improvement proposals; it never affects points or gates.
- Tests cover complete, partial, unavailable, mismatched, resumed, and ambiguous cases for every diagnostic dimension, and targeted tests plus `npm run check` succeed.
