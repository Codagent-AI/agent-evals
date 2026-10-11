## ADDED Requirements

### Requirement: Zero-point gate inputs keep their second opinion
`demo-route-and-registration` and `demo-nine-step-content-and-order` SHALL remain deterministic browser criteria for second-opinion purposes after they become zero-point gate inputs. A browser `fail` of either SHALL receive exactly one verifier call, as for any deterministic browser criterion, and a fallback-judged failure of either SHALL receive one on the outline gate's behalf, as for any outline input. An accepted overturn SHALL change that input's final verdict and the re-derived `verification-sample-outline` gate, and SHALL NOT change any point score. The harness SHALL find these inputs for second opinions from the rubric's gate inputs, not only from its scored criteria.

#### Scenario: A zero-point outline input fails in the browser
- **WHEN** the browser evaluator records `fail` for `demo-route-and-registration` in a candidate evaluation
- **THEN** the harness makes exactly one verifier call for that criterion
- **AND** the outline gate is derived from the criterion's resulting final verdict

#### Scenario: An overturned outline input changes no points
- **WHEN** the verifier overturns a browser `fail` of `demo-nine-step-content-and-order` and the other outline input passed
- **THEN** the derived outline gate passes
- **AND** the demo component's points are the same as before the overturn
