## MODIFIED Requirements

### Requirement: Implementation-workflow failure outcome
The evaluation SHALL use `implementation-workflow-failed` when Agent Runner reports the evaluated workflow run as failed, or the run ends without completing and the harness cannot continue to an evaluable delivered candidate. An evaluable delivery SHALL require the recorded candidate branch, clean committed worktree, draft pull request with non-empty base, matching local and PR heads, required acceptance artifacts, final acceptance handoff, and assumptions ledger.

The result SHALL identify the failed workflow step, attempt or session as Agent Runner reports them when available, observed error, Agent Runner run identity, missing delivery output or identity, and whether the workflow can be resumed. Product defects, failed acceptance flows, limitations, unresolved assumptions, and candidate-reported CI states contained in a structurally complete handoff SHALL remain judgeable evidence and SHALL NOT by themselves cause this outcome.

#### Scenario: Agent Runner terminates before delivering a candidate
- **WHEN** the recorded evaluated workflow run terminates unsuccessfully before completing the required candidate delivery
- **THEN** `evaluation_status` is `implementation-workflow-failed` and `product_verdict` is `unavailable`

#### Scenario: Required candidate delivery output is missing
- **WHEN** Agent Runner finishes without a required branch, draft-PR identity, matching final head, acceptance artifact, handoff, or assumptions ledger
- **THEN** `evaluation_status` is `implementation-workflow-failed`
- **AND** scored product judging does not begin

#### Scenario: Implementation profile cannot complete a task
- **WHEN** an Agent Runner agent exhausts the workflow's permitted attempts and the implementation run fails
- **THEN** the result classifies the failure as implementation-workflow-owned and records the affected role, step, attempts, and error

#### Scenario: Complete handoff records product findings
- **WHEN** candidate delivery is structurally complete and the handoff honestly records defects, failed flows, limitations, or unresolved assumptions
- **THEN** scored product judging proceeds
- **AND** those findings do not become an implementation-workflow failure

#### Scenario: Harness remains operational after workflow failure
- **WHEN** the harness successfully records and reports an Agent Runner workflow failure
- **THEN** it does not misclassify that failure as an evaluation-harness failure
