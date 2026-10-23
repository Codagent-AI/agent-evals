## MODIFIED Requirements

### Requirement: Detailed result artifact
The harness SHALL atomically write a versioned `result.json` containing run kind; evaluation status and candidate product verdict when applicable; score denominator; component applicability; `official_score` when complete candidate scoring produced one; `automated_subtotal` when all applicable automated scoring is complete; a nullable `score.automated_pass` eligibility decision and structured `score.automated_failures`; `available_component_scores` for individually completed components; component, subcomponent, criterion, and gate results; any user-approved technical adjudication with raw scores, revised scores, approver, time, rationale, and findings; automated and human rubric provenance; human responses and rationales; Agent Runner workflow, agent-role provenance, and linked-audit lifecycle states and warnings; candidate repository, branch, draft-PR URL, base, draft state, final local SHA, and final PR SHA; the requested Validator mode and candidate-reported CI status when present; verified acceptance-evidence lineage; separate candidate-produced and evaluator-produced evidence summaries; per-agent/model/allocation implementation usage and costs with dispatch counts; pricing evidence and verification state; machine phase timing; checkpoint and resume history; independent history, delivery, usage, identity, per-model-attribution, and pricing completeness fields; artifact references; and the shared-92 reference comparison when applicable.

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
- **THEN** `result.json` records its repository, `eval/and-scene/<run-id>` branch, draft-PR URL and base, draft state, matching final local and PR SHA, requested Validator mode, and any candidate-reported CI status

#### Scenario: Technical adjudication is recorded
- **WHEN** the user approves a post-run technical adjudication
- **THEN** `result.json` retains the raw component and criterion results and records the revised shared component scores plus the adjudication audit data
- **AND** its automated subtotal, official score, and shared comparison reflect the approved revision

### Requirement: Implementation-only cost scope
Only agent invocations executed inside the evaluated Agent Runner workflow run SHALL contribute to agent-and-model costs and the total estimated API cost. Every agent invocation in that run SHALL contribute, whatever part of the workflow made it; the total and active duration SHALL cover the whole evaluated run. Eval-owned judging, evidence or screenshot repair, pricing lookup or parsing, deterministic checks, human review, scoring, and report generation SHALL NOT be priced or included in that total.

The harness SHALL durably capture eval-owned Codex and Claude usage when the CLI reports it, including phase, provider, model, raw token categories, and canonical token totals. Missing eval-owned telemetry SHALL remain explicitly unavailable or partial. Eval-owned usage SHALL stay outside implementation cost aggregation and SHALL NOT be priced. Cost SHALL remain report-only and SHALL NOT affect product points, gates, or pass status.

#### Scenario: Implementation agent incurs cost
- **WHEN** a lead-agent, crosscheck, task-implementor, or tester invocation inside the evaluated Agent Runner workflow run has a resolved cost
- **THEN** that cost contributes to its agent-and-model row and the implementation total

#### Scenario: Claude judge incurs usage
- **WHEN** a Claude-family panel judge, decider, or check reports token usage
- **THEN** the eval-owned usage ledger records its phase, stage, provider, model, and token categories
- **AND** that usage is not priced or included in the implementation total

#### Scenario: LLM judge incurs usage
- **WHEN** the eval-owned judge reports token usage
- **THEN** the harness may report that usage diagnostically
- **AND** it does not price the usage or include it in the implementation total

#### Scenario: Cost changes but product quality does not
- **WHEN** two otherwise identical runs have different implementation costs
- **THEN** the cost difference is reported without changing either run's product score or pass conditions
