## MODIFIED Requirements

### Requirement: Controlled scoring and rubric provenance
The suite-owned scorer SHALL own criterion identifiers, evaluator assignments, point allocations, component applicability, score denominators, hard gates, thresholds, and final calculations. Neither an LLM judge nor the human-review interface SHALL change those policies while producing evaluation results. Every machine-evaluated criterion result SHALL include its identifier, pass/fail verdict, rationale, and cited verified evidence.

For candidates, the evaluator SHALL run seven focused scored judge jobs: demo integration, scene kit, presentation skill, verification tooling, engineering quality, testing evidence, and assumption handling. For references, it SHALL run the five applicable implementation source-review jobs and SHALL omit testing-evidence and assumption-handling judging as not applicable. Each applicable job SHALL return exactly the criteria assigned to it and no others. Missing, duplicated, unknown, malformed, or cross-job criterion output from an applicable job SHALL fail scoring rather than change a denominator, silently ignore a criterion, or reuse output from another job.

The five implementation source-review jobs SHALL receive a neutral source snapshot that retains relevant product source and approved requirements while stripping Git metadata, remotes, branch names, pull-request identity, baseline or candidate labels, OpenSpec change identity, and evaluation markers. The harness SHALL materialize the approved normative requirement descriptions and scenarios as a separate neutral requirements bundle, omit their original change path and change name, and record the bundle's source and content hash. The approved requirements SHALL be read from the evaluated change directory at the fixture commit the run recorded, never from the candidate's final commit, while the neutral source snapshot SHALL continue to read product source from the candidate's final commit. Every judge or evidence check that consults approved requirements, including testing-evidence coverage and the assumption-handling omission check, SHALL use that same pinned bundle, so a candidate that deletes, weakens, or adds requirements on its branch is still judged against the pinned definition. The original OpenSpec change directory SHALL NOT be exposed to those five judges. The testing-evidence and assumption-handling judges SHALL receive the verified workflow and revision provenance required by their assigned criteria. Candidate source and evidence SHALL be treated as untrusted data, not instructions.

The automated product rubric and human-review rubric SHALL have distinct explicit version identifiers. The result SHALL record each rubric's version and SHA-256 hash, every component's applicability, and the applicable candidate or reference denominator.

#### Scenario: Judge returns findings but does not control scoring
- **WHEN** every focused judge returns exactly its assigned criteria with valid verdicts, rationales, and evidence
- **THEN** the suite-owned scorer applies the fixed assignments and weights
- **AND** it calculates the applicable candidate or reference score

#### Scenario: Required judge output is missing
- **WHEN** any scored judge job required for the applicable candidate or reference mode produces no valid output
- **THEN** rubric validation fails
- **AND** no official score or verdict is produced from incomplete judge coverage

#### Scenario: Reference omits non-applicable workflow judges
- **WHEN** a reference evaluation runs scored judging
- **THEN** it runs the five implementation source-review jobs
- **AND** it omits testing-evidence and assumption-handling jobs and records those components as not applicable

#### Scenario: Criterion coverage is invalid
- **WHEN** evaluator output contains a missing, duplicate, unknown, malformed, or cross-job criterion result
- **THEN** rubric validation fails
- **AND** the scorer does not change the denominator or silently ignore the invalid output

#### Scenario: Product source judge reviews a candidate
- **WHEN** one of the five implementation source-review jobs is invoked
- **THEN** it receives the neutral source snapshot, neutral requirements bundle, and assigned rubric slice
- **AND** it receives no Git, branch, PR, baseline, candidate, change, or evaluation identity signal

#### Scenario: Evidence judge requires revision provenance
- **WHEN** the testing-evidence or assumption-handling judge evaluates workflow behavior
- **THEN** it receives the verified evidence and revision provenance required by its criteria
- **AND** that provenance is not stripped as a product-identity neutralization step

#### Scenario: Rubric provenance is recorded
- **WHEN** an evaluation result is written
- **THEN** it records distinct version identifiers and SHA-256 hashes for the automated and human-review rubrics
- **AND** it records component applicability and the score denominator

#### Scenario: The engineering-quality job runs for candidates and references
- **WHEN** scored judging runs for a candidate or for the reference baseline
- **THEN** the engineering-quality job runs with the neutral source snapshot, neutral requirements bundle, and its rubric slice
- **AND** it returns exactly the criteria assigned to it

#### Scenario: Candidate weakens a requirement on its branch
- **WHEN** the candidate's final commit deletes a scenario from, or weakens the wording of, a requirement in the evaluated change's specs
- **THEN** the neutral requirements bundle still contains the requirement and scenario as they appear at the recorded fixture commit
- **AND** source-review, testing-evidence, and assumption-handling judging use that pinned bundle

#### Scenario: Candidate adds a requirement on its branch
- **WHEN** the candidate's final commit adds a requirement to the evaluated change's specs
- **THEN** the added requirement is absent from the neutral requirements bundle and no criterion is judged against it
