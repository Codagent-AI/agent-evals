## ADDED Requirements

### Requirement: Versioned from-prompt product rubric and score
The suite SHALL score the delivered product under a versioned from-prompt product rubric, separate from `and-scene`'s rubrics, that declares its components, criteria, points, gates, the hidden-reference inventory version it applies to, and its calibration evidence. The product score SHALL be out of 100: 70 automated points divided among the automated components, starting from `and-scene`'s component split, and 30 points from human review. Every scored criterion SHALL carry an importance tier and earn its component's weight for that tier, under `and-scene`'s tier rules, so that no single criterion verdict is worth more than 2 points. The score SHALL be the result: the rubric SHALL NOT declare a pass threshold or a component floor, and the result SHALL NOT report a product pass/fail verdict. Preflight SHALL refuse a rubric that declares a pass threshold or floor. The result SHALL report each component's score, every criterion's verdict and citations, every gate's outcome, and the rubric version and hash.

#### Scenario: Product is scored without a verdict
- **WHEN** automated scoring and human review complete
- **THEN** the result reports the product score out of 100 with its breakdown and no pass/fail verdict

#### Scenario: Rubric declares a pass threshold
- **WHEN** a candidate run starts and the pinned from-prompt product rubric declares a pass threshold or component floor
- **THEN** preflight fails before any model call and states that the rubric must not declare one

#### Scenario: Criterion outweighs the cap
- **WHEN** a criterion has no tier, or its tier weight is above 2 points
- **THEN** rubric validation fails and names the criterion

### Requirement: Fixture-owned criteria map to the hidden inventory
Every fixture-owned criterion and gate SHALL cite at least one `mandatory` or `acceptable-alternative` hidden-reference inventory item. Rubric validation SHALL reject a fixture-owned criterion or gate that cites no inventory item, that cites a `preference` item, or whose wording or guidance contains a concrete value supplied only by a `preference` item, such as a canvas size, a route, a step count, or a step title. An eval-owned criterion, which judges workflow or engineering evidence the fixture does not describe, SHALL state the reason it is eval-owned and SHALL list the inventory items whose structure it presumes; rubric validation SHALL reject an eval-owned criterion that lists a `preference` item. A criterion that judges whether the product stays in scope SHALL cite the inventory's out-of-scope `mandatory` items. The rubric SHALL also be validated by the `rubric-fixture-traceability` rules that apply to `and-scene`'s rubric.

#### Scenario: Criterion cites a preference
- **WHEN** a fixture-owned criterion cites the inventory item for the reference sample's nine-step outline
- **THEN** rubric validation fails and names the criterion and the preference item

#### Scenario: Guidance carries a preference value
- **WHEN** a criterion's guidance requires the 880 × 380 default canvas
- **THEN** rubric validation fails and names the criterion and the value

#### Scenario: Eval-owned criterion with a reason
- **WHEN** a testing-evidence criterion is declared eval-owned with its reason, presumes no inventory item, and cites no inventory item
- **THEN** rubric validation accepts it

#### Scenario: Eval-owned criterion presumes a preference
- **WHEN** an eval-owned engineering criterion lists, among the items whose structure it presumes, a `preference` item for the reference's bootstrap scripts
- **THEN** rubric validation fails and names the criterion and the preference item

### Requirement: Every graded item is covered
Rubric validation SHALL reject a rubric under which a `mandatory` inventory item is cited by no criterion or gate, unless the rubric's exclusion list names that item with a reviewed reason. An `acceptable-alternative` item SHALL be left uncited only through the same exclusion list. The result SHALL report the exclusion list beside the rubric version.

#### Scenario: Mandatory item left ungraded
- **WHEN** a `mandatory` item is cited by no criterion and is not in the exclusion list
- **THEN** rubric validation fails and names the item

#### Scenario: Excluded item
- **WHEN** a `mandatory` item describing agent runtime behavior is in the exclusion list with its reason
- **THEN** rubric validation accepts the rubric and the trace shows the item as not graded in product

### Requirement: Hidden requirements are the judging source
Product judges SHALL receive, for each fixture-owned criterion, the statement, intent, and quoted source text of each mapped inventory item, and SHALL NOT receive whole hidden-reference sections. An `acceptable-alternative` item SHALL be judged by its intent, which SHALL take precedence over any mechanism its quoted source describes, so that a design different from the reference's that meets the intent passes. Rubric validation SHALL bound the size of each criterion's requirement text and reject a criterion whose requirement text exceeds the bound. The candidate's own definition SHALL NOT be a requirement source for any criterion; it SHALL enter only the testing-evidence and assumption-handling evidence packets, as the approved requirements those packets judge against.

#### Scenario: Different design meets the intent
- **WHEN** the candidate serves presentations under a routing scheme different from the reference's and each presentation remains separately reachable
- **THEN** the criterion mapped to that intent passes

#### Scenario: Candidate definition weakens a requirement
- **WHEN** the candidate's own specification omits a `mandatory` behavior and the product does not implement it
- **THEN** the criterion mapped to that item fails

#### Scenario: Reference section mixes a preference
- **WHEN** a criterion cites an `acceptable-alternative` item whose reference section also states a `preference` value
- **THEN** the criterion's judge packet contains the item's quoted text and not the preference value

#### Scenario: Requirement text too large
- **WHEN** a criterion's mapped items produce requirement text larger than the rubric's bound
- **THEN** rubric validation fails before any candidate run and names the criterion

### Requirement: Browser criteria judged by operating the product
Browser criteria SHALL be judged by LLM browser judges that operate the served product in a real browser as a person would: finding the presentations, the sample presentation, and their steps from what the product shows and how it responds, and stepping through them with its controls. Browser judges SHALL NOT be told a route, step count, step title, era, or canvas size from the hidden reference, and SHALL NOT fail a criterion because a reference preference is absent. A browser judge SHALL report each pass as the browser actions it took and the results it expected, and the suite SHALL replay those actions in a fresh browser; a pass SHALL count only when the replay reproduces the expected results, and a pass whose replay does not reproduce them SHALL count as a fail. A criterion the browser judges cannot locate the evidence for SHALL be decided by its declared fallback judge, under the rule that an unconfirmed browser fallback pass fails. The result SHALL report, per browser criterion, whether its verdict was replay-confirmed or fallback-judged. Browser judging SHALL run one browser at a time.

#### Scenario: Sample differs from the reference
- **WHEN** the delivered sample has five steps, is served under a route the reference does not use, and advances with an on-screen Next control
- **THEN** the browser judges locate it, step through it, and evaluate it normally

#### Scenario: Pass does not replay
- **WHEN** a browser judge reports a pass whose recorded actions, replayed in a fresh browser, do not produce the expected results
- **THEN** the criterion counts as failed and the result records the replay mismatch

#### Scenario: Judges cannot locate the sample
- **WHEN** no browser judge can locate any sample presentation
- **THEN** the criterion is reported fallback-judged and its fallback judge decides it

### Requirement: Building and serving the product
The suite SHALL determine how to build and serve the delivered application from the delivered tree's own package manifests and build configuration, and SHALL NOT assume a fixed application root, build script, or output directory. When the suite cannot determine how to build or serve the product, the run SHALL end `evaluation-harness-failed`, resumable, with the product reported as not evaluable, and SHALL NOT receive a lower score. When the determined build fails, every browser-dependent criterion SHALL score 0, and no fallback judge SHALL decide it.

#### Scenario: Different but valid layout
- **WHEN** the delivered application lives in a subdirectory with its own build script and output directory
- **THEN** the suite builds and serves it from there and scores it normally

#### Scenario: Build cannot be determined
- **WHEN** the delivered tree has no manifest or configuration from which a build can be determined
- **THEN** the run ends `evaluation-harness-failed`, resumable, with the product reported as not evaluable and no product score

#### Scenario: Build fails
- **WHEN** the determined build command fails
- **THEN** every browser-dependent criterion scores 0, no fallback judge runs for them, and the build gate is reported failed

### Requirement: Gates
The rubric SHALL declare four gates: the whole application builds; a sample presentation that explains how to use the skill exists and is reachable; every step the delivered presentations produce renders; and the delivered verification tool reports a clear outcome. Gates SHALL be reported beside the product score and SHALL NOT change it.

#### Scenario: Gate fails
- **WHEN** one produced step fails to render
- **THEN** that gate is reported failed and the product score is unchanged by the gate

### Requirement: Reused robust judging
Product judging SHALL use `and-scene`'s robust judging unchanged: the same panel composition and settlement rules, source audits, dissent and overrule checks, replay-based second opinions, and declared fallback judges. Evidence that was never observed, including a judge job that never returned usable output, SHALL leave the run `evaluation-harness-failed` and resumable, and SHALL NOT be converted into a lower score. A judge job that fails because its packet overflows SHALL leave only that job's component incomplete, and the run SHALL otherwise finish scoring.

#### Scenario: Judge job never returns
- **WHEN** a product judge job exhausts its attempts without usable output
- **THEN** the run ends `evaluation-harness-failed`, resumable, with no product score

#### Scenario: Packet overflows
- **WHEN** a testing-evidence judge job fails because its evidence packet exceeds the hard limit
- **THEN** the testing-evidence component is reported incomplete and the other components are scored

### Requirement: Human review
Human review SHALL use `and-scene`'s versioned human-review questions, rating scale, and resumable review command unchanged, and SHALL contribute up to 30 points. The human rubric's floor and minimum individual rating SHALL be reported and SHALL NOT be applied. Every run with a complete automated product score whose product can be served SHALL become `pending-human-review`, and SHALL become `complete` when the review finishes. When the delivered product cannot be built or served, human review SHALL NOT run, the human component SHALL score 0, the result SHALL record the reason, and the run SHALL be `complete` once automated scoring finishes.

#### Scenario: Review completes the run
- **WHEN** the human-review command finishes the review of a pending run
- **THEN** the run is `complete` with its product score out of 100

#### Scenario: Human score below the floor
- **WHEN** a finished human review totals fewer points than the human rubric's floor
- **THEN** the result reports that the floor was not reached, and the product score still includes the human points

#### Scenario: Product cannot be served
- **WHEN** the delivered application fails to build
- **THEN** no human review runs, the human component is 0 with the build failure as its reason, and the run is `complete`

### Requirement: Calibration
`--calibrate` SHALL be a maintainer diagnostic that judges a pinned calibration set under the current rubric with at least three repeats per input: the reference implementation; a preference-shifted copy of it that changes reference preferences such as routes, step count, step titles, and canvas size, and removes page hooks only the reference uses, while keeping every `mandatory` and `acceptable-alternative` behavior; and degraded variants that each remove known `mandatory` behavior. It SHALL report per-input scores and spread, accuracy against each input's expected verdicts, each criterion's verdict flip rate across repeats, and how often deciders reversed panel verdicts. It SHALL report a failure when the preference-shifted copy loses more than the rubric's tolerance against the reference, when a removed `mandatory` behavior is judged met, or when an input's score spread exceeds the rubric's limit. The rubric SHALL be marked provisional until a maintainer approves it from calibration evidence and from a rescore of the first live candidate run with identical inputs, and every result scored under a provisional rubric SHALL say so. Calibration output SHALL NOT be published.

#### Scenario: Preference shift is penalized
- **WHEN** calibration judges the preference-shifted copy more than the tolerance below the reference
- **THEN** calibration reports a failure naming the criteria that lost points

#### Scenario: Criterion verdict flips
- **WHEN** a criterion's verdict differs across the repeats of the same calibration input
- **THEN** calibration reports that criterion's flip rate

#### Scenario: Provisional rubric
- **WHEN** a candidate run is scored under a rubric not yet approved from calibration
- **THEN** its result and report state that the rubric is provisional
