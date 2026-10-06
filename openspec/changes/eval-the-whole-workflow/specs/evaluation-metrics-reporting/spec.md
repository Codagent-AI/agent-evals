## MODIFIED Requirements

### Requirement: Implementation-only cost scope
Only agent invocations executed inside the Agent Runner implementation workflow SHALL contribute to agent-and-model costs and the total estimated API cost. Eval-owned judging, evidence or screenshot repair, pricing lookup or parsing, deterministic checks, human review, scoring, and report generation SHALL NOT be priced or included in that total.

The harness SHALL durably capture eval-owned Codex and Claude usage when the CLI reports it, including phase, provider, model, raw token categories, and canonical token totals. Missing eval-owned telemetry SHALL remain explicitly unavailable or partial. Eval-owned usage SHALL stay outside implementation cost aggregation and SHALL NOT be priced. Cost SHALL remain report-only and SHALL NOT affect product points, gates, or pass status.

#### Scenario: Implementation agent incurs cost
- **WHEN** a lead-agent or task-implementor invocation inside Agent Runner has a resolved cost
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
