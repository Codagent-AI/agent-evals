## ADDED Requirements

### Requirement: Review hold for evaluator contradictions
When automated scoring records one or more evaluator contradictions, the harness SHALL place the result under a review hold. The review hold SHALL be durable run state recorded in `result.json`, separate from `evaluation_status` and from the product verdict. It SHALL NOT change `evaluation_status`, the product verdict, any score, or any gate, and it SHALL NOT be reported as an evaluation-harness failure or an implementation-workflow failure.

A held result SHALL follow its normal outcome transitions: it MAY become `pending-human-review`, human review MAY be completed, and it MAY become `complete`. Only permanent publication SHALL wait for the hold. A noninteractive run that reaches a hold SHALL NOT wait for input; it SHALL finish with the exit status its outcome would otherwise have, and `result.json` SHALL name the hold, the contradictions that caused it, and the maintainer action that releases it.

A maintainer SHALL resolve a hold through an explicit review action that records the reviewer, the time, a decision, and a rationale. The decision SHALL be one of two. When the verdicts stand as scored, the hold is released. When a verdict is wrong, the hold SHALL stay in place permanently, the result SHALL never be published, and the correction SHALL be made where the error lives, in the evaluator, the rubric, or the judge guidance, followed by re-scoring the candidate into a new evaluation record; a held result SHALL NOT be corrected in place. Either decision SHALL retain the original contradiction record unchanged. A release SHALL be rejected when it names no reviewer or no rationale, or when the run has no active hold. A released hold SHALL NOT be re-raised by resume or by regenerating the report from the same scored evidence; re-scoring that produces a new contradiction SHALL raise a new hold.

Resume SHALL preserve an active hold and a recorded release. Resuming a held run SHALL NOT rerun scoring solely because of the hold.

#### Scenario: A contradiction holds a result that is otherwise eligible
- **WHEN** automated scoring of a candidate records an evaluator contradiction and the candidate reaches automated eligibility
- **THEN** `evaluation_status` becomes `pending-human-review` as it otherwise would
- **AND** `result.json` records an active review hold naming the contradiction and the release action

#### Scenario: An unattended run reaches a hold
- **WHEN** a noninteractive run records an evaluator contradiction
- **THEN** the run does not wait for input
- **AND** it exits with the status its outcome would otherwise have
- **AND** the hold is recorded in `result.json`

#### Scenario: Human review completes under a hold
- **WHEN** a maintainer completes human review of a held result
- **THEN** the result becomes `complete` with its official score and product verdict
- **AND** the review hold remains active

#### Scenario: A maintainer releases a hold
- **WHEN** a maintainer records a review decision that the verdicts stand, with a reviewer and rationale
- **THEN** the hold is released
- **AND** the original contradiction record is retained unchanged alongside the release

#### Scenario: A maintainer finds a verdict wrong
- **WHEN** a maintainer reviewing a hold decides one of the contradicting verdicts is wrong
- **THEN** the decision and rationale are recorded and the hold stays in place
- **AND** the result is never published
- **AND** the candidate is re-scored into a new evaluation record after the evaluator, rubric, or judge guidance is corrected

#### Scenario: A release is incomplete
- **WHEN** a release action names no reviewer or no rationale
- **THEN** the release is rejected and the hold remains active

#### Scenario: A held run is resumed
- **WHEN** a run with an active review hold is resumed
- **THEN** the hold and its contradictions are preserved
- **AND** scoring is not rerun because of the hold

#### Scenario: A released run is resumed
- **WHEN** a run whose hold was released is resumed without re-scoring
- **THEN** the hold stays released
