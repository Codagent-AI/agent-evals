## MODIFIED Requirements

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

## ADDED Requirements

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
