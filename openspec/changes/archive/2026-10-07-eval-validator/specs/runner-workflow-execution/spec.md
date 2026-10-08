## MODIFIED Requirements

### Requirement: Ordered evaluation lifecycle
For an Agent Runner candidate, the main evaluation command SHALL execute phases in this order: preflight the pinned fixture, unique candidate branch, Agent Runner checkout, Agent Skills checkout, workflow contract, credentials, lead, implementor, and reviewer profiles, evaluator, and run directory; install the pinned workflow skills for the selected CLIs; run or resume the complete Agent Runner workflow; verify candidate delivery and acceptance-handoff completeness; install dependencies, build, and run non-browser verification; start the evaluated final candidate server; run deterministic browser checks and capture evaluator evidence; run the seven focused product judge jobs; run the separate non-scoring ambiguity diagnostic; ingest metrics and resolve pricing; write either an eligible `pending-human-review` result or a conclusive automated product-fail result and HTML report; attempt candidate-server cleanup; update the artifacts with the cleanup outcome; and exit successfully.

For an eligible pending run, the separate human-review command SHALL later restore or start the same evaluated final candidate server; collect or resume human review; calculate the official candidate result; generate the final HTML report; attempt candidate-server cleanup; update the final artifacts; and publish a curated permanent result for a completed scored candidate pass or product-fail run. The candidate server SHALL be running before every browser-dependent phase and SHALL NOT be required to remain running between the automated and human-review commands. If complete automated scoring proves that the candidate cannot pass, or verified product behavior makes the final candidate unable to install, build, or serve, human review SHALL NOT run and the applicable conclusive product-failure outcome rules SHALL apply instead.

#### Scenario: Automated evaluation follows the phase order
- **WHEN** every automated candidate-evaluation phase completes successfully
- **THEN** each phase begins only after its required predecessor has completed
- **AND** scored product judging begins only after complete candidate delivery and acceptance-handoff evidence are verified

#### Scenario: Automated result determines the next action
- **WHEN** automated scoring completes
- **THEN** an eligible candidate is handed off for human review
- **AND** a candidate that fails a complete automated threshold, floor, or hard gate finishes without invoking human review

#### Scenario: Human review finalizes later
- **WHEN** the separate human-review command completes a pending candidate review
- **THEN** it calculates the official result, writes the final report, attempts cleanup, updates the cleanup outcome, and then publishes the completed result

#### Scenario: Paired first benchmark
- **WHEN** autonomous evaluation finishes the pending recreated reference and pending fresh Agent Runner candidate
- **THEN** a later paired human-review invocation finalizes the reference before the candidate
- **AND** it generates their shared-92 comparison without rerunning completed automated phases

#### Scenario: Earlier phase cannot complete
- **WHEN** an evaluation phase cannot produce its required outputs
- **THEN** dependent phases do not run with fabricated or stale inputs
- **AND** final outcome reporting and cleanup still run when possible

#### Scenario: Delivered product cannot install, build, or serve
- **WHEN** deterministic verification establishes that the frozen final candidate cannot install, build, or serve because of reproducible product behavior
- **THEN** dependent browser and human-review phases do not run
- **AND** the evaluation applies the conclusive product-failure outcome without classifying the product defect as a harness failure
