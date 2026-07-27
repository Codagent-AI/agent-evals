# Task: Verify evidence and neutral inputs

## Goal

Create trustworthy, ownership-separated evidence and neutral judge inputs tied to the verified final pull-request SHA. Preserve candidate artifacts byte-for-byte as untrusted evidence, independently record evaluator evidence and contradictions, and give each judge only the source and provenance its rubric permits.

## Background

Read `proposal.md`, `design.md`, `specs/testing-evidence-evaluation/spec.md`, `specs/ambiguity-evaluation/spec.md`, `specs/product-quality-scoring/spec.md`, and `specs/evaluation-metrics-reporting/spec.md`. The implementation lives entirely under `evals/agent-runner/and-scene/`, uses only existing Node and shell facilities, and consumes the versioned run state and verified delivery identity exposed by the suite controller.

Add focused suite-local modules and tests for candidate evidence intake, lineage validation, evaluator evidence, contradiction records, and neutral-source materialization. Integrate them through `controller.mjs`, `lib/candidate.mjs`, `lib/ambiguity.mjs`, `lib/judge-invoker.mjs`, and `lib/judge-jobs.mjs`; update `lib/result.mjs` only as needed to expose stable summaries for later projection. New modules such as `lib/evidence.mjs` and `lib/neutral-source.mjs` are appropriate, but keep contracts local instead of introducing a repository-wide framework.

Build `evidence/candidate/manifest.json` only after delivery verification. Anchor discovery on the final acceptance handoff and use a suite-owned role registry with documented filename aliases for the acceptance flow record, screenshots and capture metadata, findings/retest history, final handoff, assumptions ledger, and referenced session/audit material. Resolve references safely within the candidate worktree or recorded Runner session, copy exact bytes into `evidence/candidate/`, and record stable ID, semantic role, origin, ownership, media type, size, SHA-256, claimed revision, capture metadata, coverage, references, verification state, and limitations. Never repair, rewrite, fill in, or silently reinterpret candidate content.

Distinguish structural readiness from evidence quality. Missing required roles or unverifiable delivery identity block scored judging as an implementation-workflow failure. Present but stale, incomplete, misleading, weakly traceable, contradictory, or wrong-revision content remains judgeable evidence and produces findings for the testing-evidence judge. Model lineage as evidence and revision nodes terminating at the verified final PR SHA. Accept a trustworthy ancestor full-flow baseline plus bounded final targeted verification only when affected and dependent flows are covered; allow evidence-only final alignment only when tracked product bytes did not change. Preserve candidate CI claims and their claimed revision verbatim, including absent/pending/unavailable states, without independently querying CI.

Write deterministic checks, probes, screenshots, and contradiction findings under `evidence/evaluator/` with equivalent integrity metadata. Evaluator evidence may corroborate or disprove candidate claims, but cannot increase candidate testing-evidence credit. Extend the ambiguity ledger from session reports, the acceptance ledger, findings history, handoff, and delivered-product evidence with stable IDs, observable handling, consequence, diagnostic classification, resolution, and unapproved fixture proposals; it remains a separate non-scoring diagnostic across resume.

Materialize the final commit as an immutable neutral source snapshot and a neutral requirements bundle. Exclude Git metadata, remotes, delivery/acceptance data, the original OpenSpec change directory, evaluation configuration, and benchmark bookkeeping. Replace exact recorded run, branch, PR, baseline, candidate, change, and evaluation identity tokens with typed placeholders, retain only relevant product structure, copy approved normative requirement descriptions and scenarios without behavioral edits into identity-free paths, and record every origin, transformation, and hash. The four product-source judges receive only the neutral snapshot, neutral requirements, their rubric slice, and allowed deterministic facts; the testing-evidence and assumption-handling judges receive bounded, read-only, explicitly delimited evidence views with the revision provenance their criteria require.

## Spec

Source: `specs/testing-evidence-evaluation/spec.md`

### Requirement: Candidate and evaluator evidence separation
The evaluation SHALL use candidate-produced acceptance evidence as the primary record of workflow testing. It SHALL label candidate-produced and evaluator-produced evidence separately in every durable artifact and report. Evaluator-produced deterministic checks, probes, and screenshots SHALL remain available to corroborate or contradict candidate claims, but SHALL NOT add credit to the candidate's testing-evidence score.

The evaluator SHALL NOT perform another subjective visual-quality review. The separate 13-question human review SHALL remain the authoritative visual-quality assessment.

#### Scenario: Candidate evidence supports its own score
- **WHEN** the testing-evidence judge evaluates a candidate
- **THEN** it assigns credit only from verified candidate-produced evidence
- **AND** it identifies every cited item as candidate-produced

#### Scenario: Evaluator evidence is captured
- **WHEN** the harness runs deterministic checks or captures its own screenshots
- **THEN** it stores them in a distinct evaluator-evidence namespace
- **AND** those artifacts cannot increase the candidate's testing-evidence score

#### Scenario: Evaluator evidence contradicts a candidate claim
- **WHEN** verified evaluator evidence contradicts candidate-produced evidence
- **THEN** the contradiction is provided to the testing-evidence judge
- **AND** the judge fails each applicable criterion that the contradiction disproves

#### Scenario: Visual quality is assessed
- **WHEN** subjective visual quality must be scored
- **THEN** the evaluator uses the separate human-review workflow
- **AND** it does not invoke a third subjective visual-review job

### Requirement: Required evidence before scored judging
Before scored product judging begins, the evaluation SHALL require readable candidate-produced acceptance flow evidence, screenshot evidence and metadata, findings history, final handoff, and assumptions ledger. It SHALL also require a verifiable candidate repository, draft pull request, final local commit, pull-request head, and pull-request base identity.

If the evaluated workflow fails to produce those required artifacts or identities, the evaluation SHALL report `implementation-workflow-failed`, preserve available diagnostics, and SHALL NOT begin scored product judging or issue an official product score or verdict. If those inputs exist but the harness cannot process otherwise valid inputs because of an evaluator defect, it SHALL report `evaluation-harness-failed`.

#### Scenario: Required candidate evidence is missing
- **WHEN** the completed workflow omits a required acceptance artifact
- **THEN** the evaluation reports `implementation-workflow-failed`
- **AND** scored product judging does not begin

#### Scenario: Final candidate identity is unverifiable
- **WHEN** the harness cannot establish the required repository, draft-PR, base, local-head, and PR-head identity
- **THEN** the evaluation reports `implementation-workflow-failed`
- **AND** it preserves the available workflow diagnostics without issuing a product score

#### Scenario: Evidence is present but poor
- **WHEN** all required artifacts and identities exist but their contents are stale, incomplete, misleading, or tied to the wrong revision
- **THEN** scored judging proceeds against the established final candidate
- **AND** the testing-evidence judge withholds points for the applicable defects

#### Scenario: Harness cannot process valid evidence
- **WHEN** required valid evidence exists but an evaluator defect prevents it from being read or validated
- **THEN** the evaluation reports `evaluation-harness-failed`
- **AND** it does not classify the failure as an implementation-workflow failure

### Requirement: Final-revision evidence provenance
The evaluation SHALL verify a coherent acceptance-evidence lineage terminating at the final evaluated pull-request SHA. The final handoff, local `HEAD`, and pull-request head SHALL identify that SHA. When candidate-produced acceptance evidence reports CI status, it SHALL identify the revision to which that status applies or explicitly state that CI evidence is absent, pending, or unavailable. The harness SHALL NOT independently query CI or require a particular CI state before judging.

The evaluation SHALL accept a lineage using a trustworthy full-flow pass from an ancestor commit plus targeted verification at the final SHA only when the candidate evidence identifies the intervening changes, bounds their impact, covers affected and directly dependent flows, and explains why other flows remain supported by the baseline. Evidence-only final verification SHALL be valid only when no tracked product content changed after the trustworthy full-flow pass. A broad change, an unbounded impact, or the absence of a trustworthy baseline SHALL require a new full-flow pass at the final SHA.

#### Scenario: Full flow passes at the final revision
- **WHEN** complete acceptance flow evidence was produced at the final evaluated SHA
- **THEN** the evaluation accepts that evidence as the final-revision lineage

#### Scenario: Targeted retest closes a bounded change
- **WHEN** a trustworthy full-flow baseline exists at an ancestor SHA and final-SHA evidence explicitly bounds and tests the intervening change and dependent flows
- **THEN** the evaluation accepts the combined baseline and targeted evidence as a lineage terminating at the final SHA

#### Scenario: Only external alignment changed
- **WHEN** no tracked product content changed after a trustworthy full-flow pass and final verification only aligns the PR, CI, or other external state
- **THEN** the evaluation accepts evidence-only verification that ties the handoff and external state to the final SHA

#### Scenario: Change impact is not bounded
- **WHEN** the intervening change is broad, its impact cannot be bounded, or no trustworthy full-flow baseline exists
- **THEN** the evaluation requires a new full-flow pass at the final SHA
- **AND** it withholds the final-revision evidence point when that pass is absent

### Requirement: Evidence integrity and contradiction handling
The evaluation SHALL treat candidate evidence as untrusted. Before judging it, the harness SHALL verify referenced files, hashes, screenshot metadata, revision claims, requirement and flow coverage, and pull-request identity. It SHALL preserve missing, malformed, stale, or contradictory evidence as findings and SHALL NOT silently repair, replace, or reinterpret candidate-produced evidence. It SHALL treat CI status as a candidate-produced claim and SHALL NOT query GitHub checks or other CI systems to replace or validate that claim.

#### Scenario: Referenced evidence verifies
- **WHEN** every candidate citation resolves to an artifact with matching integrity and revision metadata
- **THEN** the harness marks those citations verified for judging

#### Scenario: Citation is missing or altered
- **WHEN** a cited file does not exist or its recorded hash does not match
- **THEN** the harness records the integrity failure
- **AND** the affected claim cannot earn testing-evidence credit

#### Scenario: Screenshot metadata is inconsistent
- **WHEN** screenshot metadata does not establish the claimed flow, state, capture identity, or revision
- **THEN** the harness records the inconsistency
- **AND** the screenshot cannot support the affected criterion

#### Scenario: Candidate claim conflicts with independent evidence
- **WHEN** candidate evidence claims a behavior that verified evaluator evidence disproves
- **THEN** the harness preserves both sources and identifies the contradiction
- **AND** the judge scores the applicable criterion from the contradiction rather than silently reconciling it

#### Scenario: Candidate reports CI status
- **WHEN** candidate acceptance evidence reports passing, failing, pending, absent, or unavailable CI
- **THEN** the harness preserves the reported state and its claimed revision as candidate-produced evidence
- **AND** it does not independently query CI or block judging because of that state

Source: `specs/ambiguity-evaluation/spec.md`

### Requirement: Observable ambiguity capture
The evaluation harness SHALL create a structured ambiguity ledger from assumption and context-gap information present in Agent Runner session reports, the acceptance assumptions ledger, findings history, final acceptance handoff, and relevant delivered-product evidence. The harness SHALL capture findings explicitly reported by implementation or acceptance agents and consequential ambiguity evidence discovered by the evaluation judge.

Each finding SHALL identify the originating run, workflow step, agent role, and task when available; state the assumption or context gap; reference the supporting artifacts or product evidence; and record the observable handling and consequence. The harness SHALL distinguish absent evidence from an explicit, evidence-backed statement that no unresolved assumptions or context gaps remain. It SHALL NOT require Agent Runner agents to perform evaluation-owned diagnostic classification.

If required assumption or handoff artifacts are absent, the harness SHALL preserve ambiguity coverage as incomplete and defer to the implementation-workflow outcome rules. If the required artifacts exist but contain missed, inaccurate, false-positive, or poorly handled assumptions, the harness SHALL preserve those defects for assumption-handling scoring and diagnostic classification.

#### Scenario: Implementor reports an assumption
- **WHEN** an Agent Runner implementation or acceptance artifact reports an assumption or missing-context concern
- **THEN** the harness records it in the ambiguity ledger with its origin, evidence, observable handling, and consequence

#### Scenario: Judge discovers a consequential unreported assumption
- **WHEN** the evaluation judge finds evidence that an unreported assumption materially affected the delivered product or implementation workflow
- **THEN** the harness records a judge-discovered finding and links it to the supporting evidence
- **AND** the unreported finding remains available to the scored surfacing criterion

#### Scenario: Workflow reports no unresolved assumptions
- **WHEN** the required workflow artifacts explicitly report no unresolved assumptions or context gaps and available evidence supports that statement
- **THEN** the ledger records that no findings were observed for the evaluated artifacts
- **AND** the absence of findings does not prevent full assumption-handling credit

#### Scenario: No-findings statement is inaccurate
- **WHEN** required artifacts claim that no unresolved assumptions remain but verified evidence establishes a consequential unreported ambiguity
- **THEN** the harness records the contradiction and judge-discovered finding
- **AND** the scored assumption judge evaluates the applicable handling criteria

#### Scenario: Expected workflow artifacts are unavailable
- **WHEN** required assumption, findings, or handoff artifacts are unavailable
- **THEN** the ledger marks ambiguity coverage incomplete rather than claiming that no ambiguity occurred
- **AND** the implementation-workflow outcome rules determine whether scored judging can begin

### Requirement: Non-scoring ambiguity diagnostics
The detailed ambiguity ledger, its classifications, and its fixture-improvement proposals SHALL remain diagnostic-only. They SHALL NOT directly add or subtract points, create a scoring gate, or independently change the official candidate verdict. The separate assumption-handling judge SHALL score only its four fixed criteria from verified evidence.

An ambiguity-related product defect SHALL affect the applicable product-quality criterion. Poor ambiguity handling SHALL affect only the applicable fixed assumption-handling criterion rather than create an additional discretionary deduction. An ambiguity-related interruption that prevents completion SHALL also follow the applicable implementation-workflow outcome rule. A genuine specification gap SHALL remain diagnostic, and proportionate handling of that gap SHALL be eligible for full assumption-handling credit.

#### Scenario: Incorrect assumption causes a product defect
- **WHEN** an ambiguity finding is associated with behavior that fails a scored product criterion and also demonstrates poor assumption handling
- **THEN** the product criterion determines the product-quality effect
- **AND** only the applicable fixed assumption-handling criterion determines the handling-quality effect

#### Scenario: Needless escalation stops implementation
- **WHEN** an unnecessary escalation prevents the Agent Runner workflow from completing
- **THEN** the evaluation uses the implementation-workflow outcome rules
- **AND** the diagnostic classification creates no additional score or gate

#### Scenario: Genuine fixture gap is handled proportionately
- **WHEN** a genuine specification gap is surfaced, distinguished from discoverable context, escalated proportionately, and preserved in the handoff
- **THEN** the diagnostic ledger reports the gap
- **AND** the candidate remains eligible for full assumption-handling credit

#### Scenario: Diagnostic ledger contains a severe finding
- **WHEN** the non-scoring ambiguity judge records a severe classification
- **THEN** that classification does not itself change points or verdicts
- **AND** any scoring effect must come from a defined product, assumption-handling, or outcome rule

### Requirement: Durable ambiguity ledger
The harness SHALL write the non-scoring ambiguity ledger durably with the evaluation artifacts and reference it separately from the four-point assumption-handling result in `result.json` and `report.html`. Each finding SHALL have a stable identifier. On resume, the harness SHALL preserve prior findings, add newly supported evidence or findings, and avoid duplicating a finding already recorded for the same origin and concern.

Each persisted finding SHALL retain its source evidence, observed handling, consequence, diagnostic classification, rationale, resolution state, and any unapproved fixture-improvement proposal. The ledger SHALL NOT embed or replace the scored assumption-handling verdicts.

#### Scenario: Evaluation resumes with existing findings
- **WHEN** an evaluation resumes after ambiguity findings were recorded
- **THEN** the harness preserves the existing stable findings and adds only new findings or evidence

#### Scenario: Same finding appears in resumed artifacts
- **WHEN** resumed workflow artifacts repeat an already recorded assumption or context gap
- **THEN** the harness updates or references the existing finding rather than creating a duplicate

#### Scenario: Evaluation report is generated
- **WHEN** `result.json` and `report.html` are written or updated
- **THEN** they present the assumption-handling score separately from ambiguity-ledger coverage, classifications, consequences, and unapproved fixture-improvement proposals

#### Scenario: Scored and diagnostic findings overlap
- **WHEN** the same evidence supports a scored assumption-handling verdict and a diagnostic ambiguity finding
- **THEN** both artifacts retain their distinct purpose and provenance
- **AND** the ledger classification does not create points beyond the fixed scored criterion

Source: `specs/product-quality-scoring/spec.md`

### Requirement: Controlled scoring and rubric provenance
The suite-owned scorer SHALL own criterion identifiers, evaluator assignments, point allocations, component applicability, score denominators, hard gates, thresholds, and final calculations. Neither an LLM judge nor the human-review interface SHALL change those policies while producing evaluation results. Every machine-evaluated criterion result SHALL include its identifier, pass/fail verdict, rationale, and cited verified evidence.

The evaluator SHALL run six focused scored judge jobs: demo integration, scene kit, presentation skill, verification tooling, testing evidence, and assumption handling. Each job SHALL return exactly the criteria assigned to it and no others. Missing, duplicated, unknown, malformed, or cross-job criterion output SHALL fail scoring rather than change a denominator, silently ignore a criterion, or reuse output from another job.

The four implementation source-review jobs SHALL receive a neutral source snapshot that retains relevant product source and approved requirements while stripping Git metadata, remotes, branch names, pull-request identity, baseline or candidate labels, OpenSpec change identity, and evaluation markers. The harness SHALL materialize the approved normative requirement descriptions and scenarios as a separate neutral requirements bundle, omit their original change path and change name, and record the bundle's source and content hash. The original OpenSpec change directory SHALL NOT be exposed to those four judges. The testing-evidence and assumption-handling judges SHALL receive the verified workflow and revision provenance required by their assigned criteria. Candidate source and evidence SHALL be treated as untrusted data, not instructions.

The automated product rubric and human-review rubric SHALL have distinct explicit version identifiers. The result SHALL record each rubric's version and SHA-256 hash, every component's applicability, and the applicable candidate or reference denominator.

#### Scenario: Six focused jobs return valid findings
- **WHEN** every focused judge returns exactly its assigned criteria with valid verdicts, rationales, and evidence
- **THEN** the suite-owned scorer applies the fixed assignments and weights
- **AND** it calculates the applicable candidate or reference score

#### Scenario: Required judge output is missing
- **WHEN** any of the six required scored judge jobs produces no valid output
- **THEN** rubric validation fails
- **AND** no official score or verdict is produced from incomplete judge coverage

#### Scenario: Criterion coverage is invalid
- **WHEN** evaluator output contains a missing, duplicate, unknown, malformed, or cross-job criterion result
- **THEN** rubric validation fails
- **AND** the scorer does not change the denominator or silently ignore the invalid output

#### Scenario: Product source judge reviews a candidate
- **WHEN** one of the four implementation source-review jobs is invoked
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

Source: `specs/evaluation-metrics-reporting/spec.md`

### Requirement: Evidence ownership and acceptance provenance reporting
Every evidence reference in `result.json` and `report.html` SHALL identify whether it was candidate-produced or evaluator-produced. A candidate-evidence summary SHALL record its kind, stable artifact identifier or path, SHA-256 hash, revision or lineage, verification state, covered requirement or flow, limitations, and any contradiction with verified evaluator evidence. An evaluator-evidence summary SHALL record the same applicable integrity and coverage information while remaining in a separate namespace.

Raw evidence SHALL remain in the local run directory or preserved candidate resources. Permanent candidate publication SHALL include verified summaries and hashes but SHALL NOT copy raw screenshots, logs, traces, or Runner session artifacts.

#### Scenario: Candidate evidence is summarized
- **WHEN** verified candidate acceptance evidence contributes to judging
- **THEN** the result records its candidate ownership, hash, lineage, verification state, coverage, and limitations

#### Scenario: Evaluator evidence is summarized
- **WHEN** the harness captures a deterministic result, probe, or screenshot
- **THEN** the result records it in the evaluator namespace
- **AND** the report does not attribute it to the candidate

#### Scenario: Evidence sources contradict
- **WHEN** candidate-produced and evaluator-produced evidence disagree
- **THEN** both summaries retain their ownership and integrity data
- **AND** the result records the contradiction without merging or rewriting either source

#### Scenario: Published candidate omits raw evidence
- **WHEN** a finalized candidate result is permanently published
- **THEN** the published result and report retain evidence summaries and hashes
- **AND** raw screenshots, logs, traces, and Runner session artifacts remain outside the committed result directory

## Done When

- Required artifact roles are discovered through the handoff and documented aliases, copied byte-for-byte into the candidate namespace, hashed, safely bounded, and represented by a stable manifest tied to the verified delivery.
- Missing roles and identities block judging as workflow failures, while present-but-poor evidence remains available with explicit integrity, provenance, coverage, limitation, and contradiction findings.
- Lineage validation accepts final-SHA full flows, explicitly bounded ancestor-plus-targeted retests, and evidence-only external alignment under exactly the approved conditions; broad or unbounded changes cannot earn final-revision support.
- Candidate CI content is preserved as an untrusted revision-scoped claim and no harness path calls CI APIs, waits for CI, or gates judging on CI state.
- Evaluator artifacts live in their own namespace and can contradict candidate claims without being credited as candidate proof; every durable evidence reference retains ownership.
- The ambiguity ledger merges stable findings across resume without duplication, distinguishes supported no-findings statements from missing coverage, and cannot affect points, gates, verdicts, or approved specifications directly.
- Neutral source and requirements manifests prove included paths, origins, transformations, and hashes; product judges receive no Git, delivery, candidate/reference, PR, change, or evaluation identity signal, and candidate-controlled material remains bounded untrusted data.
- Tests cover alias discovery, traversal refusal, hashes, malformed/stale/missing evidence, screenshot metadata, revision ancestry and change bounds, contradictions, no-findings ambiguity, stable resume merging, identity redaction, and exact judge input permissions; targeted tests and `npm run check` pass.
