## ADDED Requirements

### Requirement: Verdict source and review hold reporting
`result.json` and `report.html` SHALL identify, for every scored deterministic criterion, whether its verdict came from the owning evaluator or from a declared fallback judge. A fallback-resolved criterion SHALL be visibly marked in the report as decided by the LLM because the browser check could not observe it, and SHALL show both the browser's not-observed record, including the conventions it looked for, and the fallback judge's verdict, rationale, and source citations. The result SHALL record the count of fallback-resolved criteria and the points they carry, so a reader can see how much of an automated score rests on fallback verdicts.

When a result carries evaluator contradictions, `result.json` and `report.html` SHALL present each contradiction with both criterion identifiers, verdicts, rationales, and evidence citations, kept separate from contradictions between candidate-produced and evaluator-produced evidence. When a review hold is active, the report SHALL state prominently that the result is held from publication and what releases it. When a hold has been released, or a maintainer has recorded that a verdict is wrong, the report SHALL show the reviewer, time, decision, and rationale, and SHALL keep the original contradiction visible; a result whose hold records a wrong verdict SHALL state that it is permanently unpublished and superseded by re-scoring.

A result that predates this capability and carries no verdict-source data SHALL render as before and SHALL NOT be shown as fallback-resolved or held.

#### Scenario: A fallback-resolved criterion is reported
- **WHEN** a result contains a criterion resolved by its fallback judge
- **THEN** the report marks that criterion as decided by the LLM because the browser check could not observe it
- **AND** it shows the not-observed record and the fallback verdict with its citations
- **AND** the result records the number of fallback-resolved criteria and their points

#### Scenario: No criterion needed a fallback
- **WHEN** every deterministic criterion was observed
- **THEN** the result records zero fallback-resolved criteria
- **AND** the report shows no fallback marking

#### Scenario: An active hold is reported
- **WHEN** a result is under an active review hold
- **THEN** the report states that the result is held from publication and names the release action
- **AND** each evaluator contradiction is shown with both verdicts, rationales, and citations

#### Scenario: A released hold is reported
- **WHEN** a result's review hold has been released
- **THEN** the report shows the reviewer, time, decision, and rationale
- **AND** the original contradiction remains visible

#### Scenario: An earlier published result is rendered
- **WHEN** a report is regenerated for a result that carries no verdict-source data
- **THEN** the report renders without fallback or hold markings

### Requirement: Held results are not published
Permanent result publication SHALL refuse a result that is under an active review hold, SHALL say that the hold is the reason, and SHALL leave any existing published snapshot unchanged. A result whose hold has been released SHALL be publishable under the existing publication rules, and its permanent snapshot SHALL include the contradiction record and the release. Refusing a held result SHALL NOT be recorded as a retryable publication failure, because retrying without a release cannot succeed. All other publication eligibility rules SHALL remain unchanged; in particular a conclusive product failure without an official score SHALL remain a local diagnostic.

#### Scenario: Publication is attempted under an active hold
- **WHEN** human review finalizes a candidate whose result is under an active review hold
- **THEN** the result is not published
- **AND** the harness reports that the review hold prevents publication
- **AND** no retryable publication checkpoint is recorded for it

#### Scenario: A released result is published
- **WHEN** a finalized result's review hold has been released
- **THEN** the result is published under the existing publication rules
- **AND** the published result retains the contradiction record and the release

#### Scenario: A failed candidate without an official score is not published
- **WHEN** a candidate conclusively fails an automated hard gate and has no official score
- **THEN** it remains a local diagnostic and is not published, whether or not it carries a review hold
