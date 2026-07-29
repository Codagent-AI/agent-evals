# Task: Project results and cut over

## Goal

Derive every durable result and report from authoritative run state, finalize candidate/reference human review and publication safely, and complete the fresh calibrated benchmark cutover. Preserve applicability, evidence ownership, delivery identity, independent completeness, and valid product verdicts across pending, failed, resumed, and finalized outcomes.

## Background

Read `proposal.md`, `design.md`, `specs/evaluation-metrics-reporting/spec.md`, `specs/evaluation-outcomes/spec.md`, and the reporting/lifecycle requirements copied below. Update `evals/agent-runner/and-scene/lib/result.mjs`, `lib/report.mjs`, `lib/outcomes.mjs`, `lib/human-review.mjs`, `human-review.mjs`, `lib/baseline.mjs`, `lib/publication.mjs`, `lib/calibration.mjs`, `run.sh`, `human-review.sh`, `README.md`, `package.json` checks, controller projections, and focused tests under `test/`.

`result.json` and `report.html` are projections of the current versioned run state, never parallel state stores. Atomically project stable top-level artifact names whenever the run becomes pending, failed, resumed, terminal, or finalized. Record status separately from verdict applicability; only include an official score when complete applicable scoring exists. Preserve independently completed components without totaling them, and preserve a durably recorded candidate verdict or complete reference score across a later report, cleanup, or publication failure.

The JSON and static offline HTML must expose applicability and denominators, full score/gate/criterion detail, candidate repository/branch/draft PR/base/final local and PR SHA, final Validator and candidate-reported CI, candidate/evaluator evidence summaries and contradictions, acceptance lineage, ambiguity coverage, rubric/judge/workflow/resume provenance, implementation metrics/cost/pricing/timing, independent completeness, artifact links, and the shared-92 comparison. Escape all untrusted content, execute no candidate markup, use relative links only for retained run-directory artifacts, and render the exact approved headline for candidate, reference, pending, workflow failure, harness failure, conclusive unscored product failure, and preserved-verdict-plus-harness-failure states.

Keep the literal 13-question human review as a separate resumable command. It must restore or start the same frozen candidate server, preserve validated responses by provenance, finalize the local reference before the candidate in paired mode, calculate candidate 100/reference 92 with the shared comparison, attempt required cleanup, and update final artifacts without rerunning valid automated work.

Permanent publication is eligible only for a finalized scored Agent Runner candidate pass or product-fail result with completed human review. Copy exactly `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`; include summaries and hashes but exclude raw evidence/runtime state. From the agent-evals worktree stage only those exact files, commit `chore: record and-scene eval <run-id>`, and ordinary-push the configured upstream. Preserve the completed product result on commit/push failure and resume only unfinished publication without duplicate commits or force-push.

Update the runbook for credentials, complete workflow behavior, `--skip-validator`, fresh/resume/reference modes, evidence namespaces, no-CI policy, browser regression, calibration, paired review, external branch/PR retention and manual cleanup, result states, and curated publication. After all targeted tests, `npm run check`, OpenSpec validation, and the full Agent Validator pass, run the corrected real-reference browser regression; recreate the local reference and require all 62 applicable automated points plus open gates; run a completely fresh candidate on a new `eval/and-scene/<run-id>` branch with `--skip-validator`; complete the separate literal paired human review; and publish only the finalized candidate with its shared-92 comparison. Never reuse damaged historical runs, fabricate human ratings, publish a standalone reference, or automatically close/delete preserved external resources.

## Spec

Source: `specs/evaluation-metrics-reporting/spec.md`

### Requirement: Detailed result artifact
The harness SHALL atomically write a versioned `result.json` containing run kind; evaluation status and candidate product verdict when applicable; score denominator; component applicability; `official_score` when complete candidate scoring produced one; `automated_subtotal` when all applicable automated scoring is complete; `available_component_scores` for individually completed components; component, subcomponent, criterion, and gate results; automated and human rubric provenance; human responses and rationales; Agent Runner workflow and agent-role provenance; candidate repository, branch, draft-PR URL, base, draft state, final local SHA, and final PR SHA; final Validator results and candidate-reported CI status when present; verified acceptance-evidence lineage; separate candidate-produced and evaluator-produced evidence summaries; per-agent/model implementation usage and costs; pricing evidence and verification state; machine phase timing; checkpoint and resume history; independent completeness fields; artifact references; and the shared-92 reference comparison when applicable.

The harness SHALL NOT rescale `automated_subtotal`, `available_component_scores`, a reference score, or the shared comparison. In human-facing output, provenance SHALL be labeled in plain language as "source and version details."

#### Scenario: Complete candidate result is written
- **WHEN** official candidate scoring completes
- **THEN** `result.json` contains the official score out of 100, full scoring breakdown, candidate and PR identity, metrics, source and version details, and completeness

#### Scenario: Candidate human review is pending
- **WHEN** all candidate automated scoring completes without finalized human review
- **THEN** `result.json` contains the automated subtotal out of 70 and no `official_score`

#### Scenario: Evaluation stops after some components complete
- **WHEN** an incomplete evaluation has evidence-backed completed component results
- **THEN** `result.json` preserves them as `available_component_scores`
- **AND** it does not convert them into an unofficial total

#### Scenario: Conclusive product failure is written without a score
- **WHEN** product-owned installation, build, or serve failure conclusively fails the candidate before complete scoring
- **THEN** `result.json` records `evaluation_status=complete`, `product_verdict=fail`, the failed hard gate, and available component results
- **AND** it contains no `official_score` or fabricated human responses

#### Scenario: Result is updated after resume
- **WHEN** resumed evaluation produces additional durable results
- **THEN** the harness atomically replaces `result.json` with a version containing both preserved and newly completed work

#### Scenario: Local reference result is written
- **WHEN** the existing implementation completes applicable automated and human scoring as a `reference-baseline` run
- **THEN** its local `result.json` records a denominator of 92 and marks testing evidence and assumption handling not applicable
- **AND** it marks Agent Runner roles, implementation cost, and implementation timing not applicable rather than zero

#### Scenario: Candidate is linked to its local reference
- **WHEN** a completed candidate was reviewed against a completed reference with matching rubric provenance
- **THEN** its result records the reference run identity plus the shared-92 total, component, subcomponent, and gate comparisons
- **AND** it keeps the candidate's official score out of 100 separate from that comparison

#### Scenario: Candidate delivery identity is recorded
- **WHEN** a candidate reaches scored judging
- **THEN** `result.json` records its repository, `eval/and-scene/<run-id>` branch, draft-PR URL and base, draft state, matching final local and PR SHA, final Validator result, and any candidate-reported CI status

### Requirement: Self-contained HTML report
Every evaluation SHALL produce a self-contained static artifact named `report.html`, including evaluations that complete, fail, remain incomplete, or await human review. The report SHALL be viewable offline without a server or external assets, SHALL escape untrusted content, and SHALL NOT execute candidate-provided markup or scripts. Artifact links SHALL be relative to the report's run directory and SHALL be rendered as links only when the linked artifact is included in that directory.

A candidate report SHALL lead with `PASS` or `FAIL` when a product verdict is available, `EVALUATION FAILED` when a workflow or harness failure prevents a product verdict, or `PENDING HUMAN REVIEW` while awaiting review. When a candidate product verdict is available but a later harness failure leaves the evaluation status failed, the report SHALL display both facts prominently. A local reference report SHALL display its score out of 92 and SHALL NOT display a candidate pass/fail label.

The report SHALL present a concise score and outcome summary followed by expandable details for score denominator; component applicability; component and subcomponent scores; thresholds; gates; every automated criterion and its rationale and evidence; human ratings and rationales; candidate repository, branch, draft PR, final SHA, Validator results, and candidate-reported CI status when present; separate candidate-produced and evaluator-produced evidence sections; workflow and harness outcomes; agent roles and models; implementation usage and cost; pricing sources; machine timing; completeness; and source and version details. A candidate linked to a local reference SHALL display the shared-92 totals, components, subcomponents, gates, and deltas separately from the candidate's official score, without treating not-applicable reference components or implementation metrics as zero.

The harness SHALL generate or update the report whenever `result.json` reaches a durable pending, terminal, resumed, or finalized state.

#### Scenario: Completed candidate passes
- **WHEN** official candidate scoring produces a pass verdict
- **THEN** `report.html` prominently displays `PASS` and the official score out of 100

#### Scenario: Completed candidate fails
- **WHEN** official candidate scoring produces a fail verdict
- **THEN** `report.html` prominently displays `FAIL` and the official score out of 100

#### Scenario: Conclusive unscored candidate fails
- **WHEN** product-owned installation, build, or serve failure conclusively produces a fail verdict before official scoring
- **THEN** `report.html` prominently displays `FAIL`, explains that the product could not install, build, or serve, and shows available component and hard-gate evidence
- **AND** it displays no official score or fabricated human ratings

#### Scenario: Evaluation infrastructure fails
- **WHEN** workflow or harness failure prevents an official candidate verdict
- **THEN** `report.html` prominently displays `EVALUATION FAILED`
- **AND** it states that the candidate verdict is unavailable while showing completed diagnostic results

#### Scenario: Harness fails after candidate scoring
- **WHEN** an official candidate verdict was durably recorded before a later harness failure
- **THEN** `report.html`, when available, prominently displays both the `PASS` or `FAIL` product verdict and the harness-failure status
- **AND** it does not erase or change the candidate score

#### Scenario: Human review is pending
- **WHEN** automated evaluation completes without finalized human review
- **THEN** `report.html` prominently displays `PENDING HUMAN REVIEW` and the applicable automated subtotal and denominator

#### Scenario: Candidate content contains markup
- **WHEN** report content includes candidate-controlled HTML or script-like text
- **THEN** the report renders it as inert text rather than executable content

#### Scenario: Evidence ownership is rendered
- **WHEN** the report contains candidate-produced and evaluator-produced evidence
- **THEN** it renders the two sources in visibly separate labeled sections
- **AND** it does not present evaluator evidence as proof produced by the candidate

#### Scenario: Shared comparison is rendered
- **WHEN** a completed candidate references a completed local reference produced by matching automated and human rubric versions and hashes
- **THEN** `report.html` displays their shared-92 totals, applicable components, subcomponents, gates, and deltas
- **AND** it keeps the candidate's official score out of 100 visually separate

#### Scenario: Reference rubric does not match
- **WHEN** a candidate and proposed local reference use different automated or human rubric versions or hashes
- **THEN** the report refuses to present their scores as a direct comparison
- **AND** it explains the provenance mismatch

#### Scenario: Local reference report is rendered
- **WHEN** the reference's applicable automated and human scoring is complete
- **THEN** its local report displays the score out of 92 and component applicability
- **AND** it displays no candidate pass/fail verdict

### Requirement: Permanent result publication
After human review finalizes an Agent Runner candidate with `evaluation_status=complete` and product verdict `pass` or `fail`, the harness SHALL copy exactly `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`. The candidate's `result.json` and `report.html` SHALL contain verified evidence summaries, ownership labels, hashes, final-revision provenance, coverage findings, and any shared-92 comparison. From the agent-evals working directory, the harness SHALL stage and commit only that exact result directory with message `chore: record and-scene eval <run-id>` and SHALL run an ordinary `git push` on the current branch's configured upstream.

The only eligible run kind SHALL be an Agent Runner candidate with a finalized scored pass or product-fail result and completed human review. A conclusive product failure without an official score or human review SHALL remain a local diagnostic and SHALL NOT be published as the finalized benchmark result. The permanent snapshot SHALL exclude runtime state, cloned repositories, dependency and build output, Agent Runner session state and transcripts, raw LLM output, full logs, raw acceptance or evaluator screenshots, traces, raw pricing catalogs, credentials, and unrelated working-tree files. A commit or push failure SHALL preserve the completed candidate result, record a retryable publication checkpoint, and exit nonzero. Resume SHALL retry only the unfinished publication work, reuse an existing result commit, and SHALL NOT rerun evaluation or human review, create a duplicate commit, or force-push.

#### Scenario: Completed candidate result is published permanently
- **WHEN** human review finalizes an Agent Runner candidate with `evaluation_status=complete` and product verdict `pass` or `fail`
- **THEN** the harness copies `result.json`, `report.html`, `human-review.json`, `ambiguity-ledger.json`, `implementation.diff`, and `artifact-manifest.json` into `evals/agent-runner/and-scene/results/<run-id>/`
- **AND** from the agent-evals working directory it commits only that exact result directory and runs `git push` on the current branch's configured upstream

#### Scenario: Ineligible result is not published
- **WHEN** a run is not a finalized scored Agent Runner candidate pass or product-fail result with completed human review
- **THEN** the harness does not create or push a permanent result commit for that run

#### Scenario: Published report retains evidence audit data
- **WHEN** the harness prepares a permanent candidate result
- **THEN** its result and report include evidence summaries, ownership, hashes, final-revision provenance, coverage findings, and contradictions
- **AND** an auditor can distinguish candidate proof from evaluator diagnostics

#### Scenario: Permanent snapshot excludes raw evidence and runtime data
- **WHEN** the harness prepares a permanent result directory
- **THEN** it excludes `.runtime`, cloned repositories, dependency and build output, Agent Runner session state and transcripts, raw LLM output, full logs, raw screenshots, traces, raw pricing catalogs, credentials, and unrelated working-tree files

#### Scenario: Publication fails after evaluation completes
- **WHEN** the path-limited commit or ordinary push fails for an otherwise completed candidate pass or product-fail run
- **THEN** the completed product result remains unchanged, the publication checkpoint records the error, and the command exits nonzero
- **AND** resume retries publication without rerunning automated evaluation or human review

#### Scenario: Publication is retried after commit
- **WHEN** the result commit exists locally but its push did not complete
- **THEN** resume reuses that exact commit and retries the ordinary push without creating a duplicate result commit or force-pushing

### Requirement: Independent completeness reporting
The evaluation SHALL report score, implementation usage, implementation cost, pricing, timing, candidate evidence, evaluator evidence, final-revision alignment, candidate-reported CI evidence when present, workflow provenance, judge coverage, and metric-history completeness independently. An unavailable, incomplete, or defective value in one dimension SHALL NOT be represented as zero or silently alter another dimension's completeness.

#### Scenario: Usage is unavailable but Runner reports cost
- **WHEN** Agent Runner reports an attempt cost while token usage is unavailable
- **THEN** cost completeness is determined from the available cost inputs while usage remains explicitly unavailable

#### Scenario: Price is unverified
- **WHEN** a judge-found price contributes to a complete numeric total
- **THEN** total-cost completeness is determined independently from pricing verification
- **AND** pricing verification states that the total contains unverified pricing

#### Scenario: Runner metric history was lost
- **WHEN** Agent Runner reports `history_complete=false`
- **THEN** the result preserves that state independently of the usage and cost coverage calculated from the remaining records

#### Scenario: Candidate evidence is incomplete
- **WHEN** candidate-produced evidence omits required coverage, provenance, or proof while the required artifact set exists
- **THEN** candidate-evidence completeness identifies the defect
- **AND** evaluator-evidence completeness remains independent

#### Scenario: Evaluator evidence is incomplete
- **WHEN** an independent deterministic probe or evaluator capture is unavailable
- **THEN** evaluator-evidence completeness identifies the gap
- **AND** it does not present candidate evidence as a replacement

#### Scenario: Evidence applies to the wrong revision
- **WHEN** candidate-produced evidence is present but its lineage does not terminate at the final evaluated SHA
- **THEN** the result marks final-revision alignment defective rather than absent
- **AND** it preserves the evidence for diagnosis

#### Scenario: Product evidence is incomplete
- **WHEN** some product criteria were never observed
- **THEN** score completeness identifies the gap without turning the missing observations into product failures

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

Source: `specs/evaluation-outcomes/spec.md`

### Requirement: Separate evaluation status and product verdict
The evaluation SHALL report execution status independently from candidate product quality. `evaluation_status` SHALL be exactly one of `complete`, `pending-human-review`, `implementation-workflow-failed`, or `evaluation-harness-failed`. `product_verdict` SHALL be exactly one of `pass`, `fail`, `unavailable`, or `not-applicable`.

A candidate product verdict SHALL be `pass` only after all required automated scoring, human scoring, and product gates have been completed from sufficient evidence. A candidate product verdict SHALL ordinarily be `fail` only after the same inputs establish that the pass contract was missed. As a narrow exception, deterministic evidence that reproducible product behavior prevents the frozen final candidate from installing, building, or serving SHALL be sufficient for a conclusive `fail` verdict without an official score or fabricated human ratings. A completed local reference SHALL use `product_verdict=not-applicable` because the candidate pass contract does not apply. The evaluation SHALL NOT infer product failure from a failed workflow, failed harness, unfinished human review, or candidate-reported CI state.

#### Scenario: Complete candidate passes
- **WHEN** all required candidate evaluation work completes and the official score and product gates satisfy the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `pass`

#### Scenario: Complete candidate fails
- **WHEN** all required candidate evaluation work completes but the official score or a product gate fails the pass rules
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`

#### Scenario: Conclusive product failure prevents full scoring
- **WHEN** deterministic verification establishes that reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `fail`
- **AND** `official_score` and human ratings remain unavailable while completed component and hard-gate evidence is preserved

#### Scenario: Complete local reference is reported
- **WHEN** all applicable reference scoring and human review complete
- **THEN** `evaluation_status` is `complete` and `product_verdict` is `not-applicable`
- **AND** the result reports the reference score out of 92

#### Scenario: Non-product failure prevents scoring
- **WHEN** an implementation-workflow or evaluation-harness failure prevents reliable completion of required product scoring
- **THEN** `product_verdict` is `unavailable` rather than `fail`

### Requirement: Pending human-review outcome
The evaluation SHALL use `pending-human-review` when all required applicable automated scoring has completed but the required human review has not been finalized. This state SHALL contain the applicable automated subtotal, score denominator, and completed diagnostics but SHALL NOT contain an official candidate score or pass/fail verdict.

A pending candidate SHALL report its automated subtotal out of 70. A pending local reference SHALL report its applicable automated subtotal out of 62 and SHALL mark testing evidence and assumption handling not applicable.

#### Scenario: Candidate automated scoring awaits reviewer
- **WHEN** candidate automated scoring is complete and no finalized human-review record is available
- **THEN** `evaluation_status` is `pending-human-review`, `product_verdict` is `unavailable`, and no official score is issued
- **AND** the result reports the automated subtotal out of 70

#### Scenario: Reference automated scoring awaits reviewer
- **WHEN** local reference automated scoring is complete and no finalized human-review record is available
- **THEN** `evaluation_status` is `pending-human-review`, `product_verdict` is `unavailable`, and no final reference score is issued
- **AND** the result reports the applicable automated subtotal out of 62

#### Scenario: Candidate human review is finalized
- **WHEN** a pending candidate resumes and finalizes valid human-review responses
- **THEN** the evaluation replaces the pending state with `complete`
- **AND** it calculates the applicable `pass` or `fail` candidate verdict

#### Scenario: Reference human review is finalized
- **WHEN** a pending local reference resumes and finalizes valid human-review responses
- **THEN** the evaluation replaces the pending state with `complete`
- **AND** it reports the reference score out of 92 with `product_verdict=not-applicable`

#### Scenario: Noninteractive run reaches human review
- **WHEN** the main evaluation command completes applicable automated scoring
- **THEN** it exits successfully with a durable `pending-human-review` result rather than attempting human review or reporting failure

#### Scenario: Handoff cleanup is incomplete
- **WHEN** the main evaluation command cannot complete candidate-server cleanup after durably writing the pending result artifacts
- **THEN** `evaluation_status` remains `pending-human-review`, the cleanup error is recorded diagnostically for review or resume, and the command exits successfully

#### Scenario: Separate review command finalizes pending result
- **WHEN** `human-review.sh` completes and confirms all required responses for a pending run
- **THEN** the evaluation transitions to `complete` with the verdict applicability required by that run kind
- **AND** it does not rerun valid automated scoring

### Requirement: Implementation-workflow failure outcome
The evaluation SHALL use `implementation-workflow-failed` when Agent Runner or an implementation-owned workflow step fails before completing the full `implement-change-v2.0` workflow and the harness cannot continue to an evaluable delivered candidate. An evaluable delivery SHALL require the recorded candidate branch, clean committed worktree, draft pull request with non-empty base, matching local and PR heads, final Validator results, required acceptance artifacts, final acceptance handoff, and assumptions ledger.

The result SHALL identify the failed workflow step, attempt or session when available, observed error, Agent Runner run identity, missing delivery output or identity, and whether the workflow can be resumed. Product defects, failed acceptance flows, limitations, unresolved assumptions, and candidate-reported CI states contained in a structurally complete handoff SHALL remain judgeable evidence and SHALL NOT by themselves cause this outcome.

#### Scenario: Agent Runner terminates before delivering a candidate
- **WHEN** the recorded `implement-change-v2.0` run terminates unsuccessfully before completing the required candidate delivery
- **THEN** `evaluation_status` is `implementation-workflow-failed` and `product_verdict` is `unavailable`

#### Scenario: Required candidate delivery output is missing
- **WHEN** Agent Runner finishes without a required branch, draft-PR identity, matching final head, Validator result, acceptance artifact, handoff, or assumptions ledger
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

### Requirement: Evaluation-harness failure outcome
The evaluation SHALL use `evaluation-harness-failed` when eval-owned setup, candidate-identity verification, non-CI evidence verification, candidate-server management, browser evaluation, evidence processing, scored judging, human-review persistence, scoring, result persistence, report generation, or cleanup fails in a way that prevents required evaluation work or finalization. A candidate-server failure established to result from reproducible product behavior SHALL follow the conclusive product-failure rule rather than this harness-failure rule.

The result SHALL identify the failed eval phase, observed error, completed checkpoints, and whether the phase can be resumed. A harness failure SHALL NOT be reported as a product defect or implementation-workflow defect.

#### Scenario: Browser evaluator cannot collect required evidence
- **WHEN** an eval-owned browser or evidence phase fails before sufficient product evidence is produced
- **THEN** `evaluation_status` is `evaluation-harness-failed` and `product_verdict` is `unavailable`

#### Scenario: Candidate installation, build, or server failure is product-owned
- **WHEN** the harness operates correctly but reproducible product behavior prevents the frozen final candidate from installing, building, or serving
- **THEN** the evaluation applies the conclusive product-failure outcome
- **AND** it does not report `evaluation-harness-failed`

#### Scenario: Required scored judge output is missing
- **WHEN** any judge job required for the applicable candidate or reference mode returns missing or invalid output
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the scorer does not substitute zero points or change the score denominator

#### Scenario: Scorer cannot produce a reliable score
- **WHEN** an eval-owned scoring failure prevents reliable applicability, denominator, criterion coverage, or official scoring
- **THEN** `evaluation_status` is `evaluation-harness-failed` and no official score or candidate pass/fail verdict is issued

#### Scenario: Harness cannot process valid candidate evidence
- **WHEN** required valid candidate evidence exists but an eval-owned defect prevents it from being read or validated
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the failure is not attributed to Agent Runner

#### Scenario: Required finalization cleanup fails
- **WHEN** the separate human-review command cannot complete its required candidate-server cleanup during finalization
- **THEN** `evaluation_status` is `evaluation-harness-failed` and the result records the cleanup error

### Requirement: Preserve a durable product verdict across later harness failure
Once an official candidate score and product verdict have been computed from complete required scoring inputs and durably recorded, a later harness failure SHALL NOT erase or alter them. The evaluation SHALL change `evaluation_status` to `evaluation-harness-failed`, preserve `product_verdict` as `pass` or `fail`, and present the harness failure alongside the valid candidate result.

Once a complete local reference score out of 92 has been durably recorded with `product_verdict=not-applicable`, a later harness failure SHALL preserve that score and verdict applicability. A failure before a candidate verdict or complete reference score is durably recorded SHALL preserve completed components diagnostically while leaving the verdict unavailable.

#### Scenario: Cleanup fails after a passing candidate verdict
- **WHEN** a passing candidate score and verdict are durably recorded and candidate-server cleanup subsequently fails
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` remains `pass`, and the cleanup failure is prominently reported

#### Scenario: Report generation fails after a failing candidate verdict
- **WHEN** a failing candidate score and verdict are durably recorded and HTML report generation subsequently fails
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` remains `fail`, and `result.json` records the missing required report

#### Scenario: Failure follows a complete reference score
- **WHEN** the local reference score out of 92 was durably recorded before a later harness failure
- **THEN** `evaluation_status` is `evaluation-harness-failed`
- **AND** the reference score and `product_verdict=not-applicable` remain unchanged

#### Scenario: Failure occurs before durable scoring
- **WHEN** a harness failure occurs after some scoring work but before the applicable candidate verdict or complete reference score is durably recorded
- **THEN** `product_verdict` remains `unavailable`
- **AND** completed component results are preserved diagnostically

### Requirement: Durable outcome transitions and resume
The harness SHALL checkpoint evaluation status, product-verdict applicability, score denominator, completed component results, failed phase, failure reason, run kind, candidate and PR identity when applicable, evidence hashes, rubric and judge provenance, and resume eligibility. Resuming SHALL update the same evaluation result and SHALL preserve all still-valid completed work under the resume rules. A recovered pending or failed state SHALL be replaced by the current state while its transition remains in the checkpoint and resume history.

#### Scenario: Workflow failure is resumed successfully
- **WHEN** an `implementation-workflow-failed` evaluation resumes the same Agent Runner run, candidate branch, and draft pull request and completes candidate delivery
- **THEN** the harness records the transition and continues with the next required eval phase

#### Scenario: Harness phase is retried successfully
- **WHEN** an `evaluation-harness-failed` phase is safely resumed and completes
- **THEN** the harness records the transition and proceeds without duplicating preserved work

#### Scenario: Pending human review resumes
- **WHEN** a pending candidate or reference resumes with matching run, evidence, rubric, and human-review provenance
- **THEN** the harness preserves valid automated work
- **AND** it continues the applicable human review

#### Scenario: Failure is not recoverable
- **WHEN** provenance or checkpoint evidence cannot establish a safe resume point
- **THEN** the result remains failed and identifies why resume is unavailable

### Requirement: Consistent outcome presentation
`result.json` SHALL be the authoritative machine-readable outcome and `report.html` SHALL render the same current evaluation status, product-verdict applicability, score denominator, official score availability, failed or pending phase, and reason. Candidate-facing output SHALL use prominent `PASS` or `FAIL` labels when a candidate verdict is available, `PENDING HUMAN REVIEW` when review is outstanding, and `EVALUATION FAILED` when workflow or harness failure leaves the verdict unavailable. A conclusive unscored product failure SHALL display `FAIL`, state that the official score and human review are unavailable because the delivered product could not install, build, or serve, and preserve the available evidence. A complete local reference SHALL use `REFERENCE — COMPLETE`, its score out of 92, and no candidate pass/fail label.

When a harness failure coexists with a valid candidate verdict or complete reference score, human-facing output SHALL display both facts prominently and SHALL explain the harness failure separately from product findings.

#### Scenario: Candidate verdict is available
- **WHEN** `product_verdict` is `pass` or `fail`
- **THEN** the result artifacts display the matching `PASS` or `FAIL` label
- **AND** they display the official score out of 100 when complete scoring produced one

#### Scenario: Conclusive product failure has no official score
- **WHEN** `evaluation_status` is `complete`, `product_verdict` is `fail`, and product-owned installation, build, or serve failure prevented complete scoring
- **THEN** the result artifacts display `FAIL`, no official score, and no fabricated human ratings
- **AND** they explain the conclusive product failure and display available component and hard-gate evidence

#### Scenario: Complete reference is presented
- **WHEN** `evaluation_status` is `complete` and `product_verdict` is `not-applicable`
- **THEN** the local result artifacts display `REFERENCE — COMPLETE` and the score out of 92
- **AND** they display no `PASS` or `FAIL` label

#### Scenario: Failure leaves verdict unavailable
- **WHEN** workflow or harness failure leaves `product_verdict` unavailable
- **THEN** the result artifacts display `EVALUATION FAILED` and identify the owning phase and reason

#### Scenario: Harness failure follows valid scoring
- **WHEN** `evaluation_status` is `evaluation-harness-failed` after a valid candidate verdict or complete reference score
- **THEN** the result artifacts prominently display both the preserved scoring result and harness-failure status
- **AND** they do not convert the preserved verdict or applicability

#### Scenario: Report and result disagree
- **WHEN** report generation detects that its rendered outcome, applicability, or denominator would differ from the current `result.json`
- **THEN** the harness fails report generation rather than publishing contradictory outcome information

Source: `specs/runner-workflow-execution/spec.md`

### Requirement: Ordered evaluation lifecycle
For an Agent Runner candidate, the main evaluation command SHALL execute phases in this order: preflight the pinned fixture, unique candidate branch, Agent Runner checkout, workflow contract, credentials, profiles, evaluator, and run directory; run or resume the complete Agent Runner workflow; verify candidate delivery and acceptance-handoff completeness; install dependencies, build, and run non-browser verification; start the evaluated final candidate server; run deterministic browser checks and capture evaluator evidence; run the six focused product judge jobs; run the separate non-scoring ambiguity diagnostic; ingest metrics and resolve pricing; write the pending-human-review result and HTML report; attempt candidate-server cleanup; update the pending artifacts with the cleanup outcome; and exit successfully.

The separate human-review command SHALL later restore or start the same evaluated final candidate server; collect or resume human review; calculate the official candidate result; generate the final HTML report; attempt candidate-server cleanup; update the final artifacts; and publish a curated permanent result for a completed scored candidate pass or product-fail run. The candidate server SHALL be running before every browser-dependent phase and SHALL NOT be required to remain running between the automated and human-review commands. If verified product behavior makes the final candidate unable to install, build, or serve, dependent browser and human-review phases SHALL NOT run, and the conclusive product-failure outcome rules SHALL apply instead.

#### Scenario: Automated candidate evaluation follows the phase order
- **WHEN** every automated candidate-evaluation phase completes successfully
- **THEN** each phase begins only after its required predecessor has completed
- **AND** scored product judging begins only after complete candidate delivery and acceptance-handoff evidence are verified

#### Scenario: Human review finalizes later
- **WHEN** the separate human-review command completes a pending candidate review
- **THEN** it calculates the official result, writes the final report, attempts cleanup, updates the cleanup outcome, and then publishes the completed result

#### Scenario: Paired fresh benchmark
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

### Requirement: Workflow execution provenance
The evaluation result SHALL record the evaluation run identifier; the distinct Agent Runner run identifier; the Agent Runner commit and clean-worktree result, CLI version, workflow path and SHA-256 hash; workflow arguments; task-level Validator choice; session directory; candidate repository and branch; draft-PR URL and base; final local and PR head SHA; every observed workflow step and outcome; final Validator result; candidate-reported CI status when present; acceptance attempt history; and hashes of required acceptance artifacts. It SHALL also record start, wait, resume, completion, and retry events without treating those events as product points.

#### Scenario: Fresh Agent Runner run is recorded
- **WHEN** the harness starts a new Agent Runner run
- **THEN** it records the run identity, workflow provenance, arguments, candidate branch, and subsequent observed step outcomes
- **AND** it adds PR, final-SHA, Validator, candidate-reported CI, and acceptance provenance as those values become available

#### Scenario: Agent Runner run is resumed
- **WHEN** the harness waits for or resumes an existing Agent Runner run
- **THEN** it appends the wait or resume event
- **AND** it preserves the original run, branch, PR, and start provenance

#### Scenario: Workflow provenance is incomplete
- **WHEN** the harness cannot determine the Agent Runner revision, workflow hash, arguments, candidate identity, executed-step history, final Validator result, or acceptance-artifact identity
- **THEN** it marks workflow provenance incomplete
- **AND** it does not present the run as reproducible or ready for scored judging

Source: `specs/ambiguity-evaluation/spec.md`

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

## Done When

- `result.json`, `report.html`, and `artifact-manifest.json` are regenerated atomically from current run state and agree on status, verdict applicability, denominator, score availability, failed/pending phase, and reason for every durable transition.
- Candidate, reference, pending, workflow-failed, harness-failed, conclusive unscored product-fail, and preserved-verdict-plus-harness-failure projections contain exactly the approved score/verdict semantics and headlines.
- JSON and offline HTML contain the full required score, delivery, Validator, candidate-CI, evidence ownership/lineage/contradiction, ambiguity, provenance, metric, timing, completeness, artifact, and shared-92 detail; untrusted content is inert and links cannot escape retained artifacts.
- Paired human review resumes safely, finalizes the reference before the candidate, never reruns valid automated work, preserves response provenance, and computes reference 92/candidate 100 plus a provenance-matched shared-92 comparison.
- Publication includes exactly the six approved files and verified evidence summaries, excludes all raw/runtime material, stages no unrelated changes, and resumes commit/push failures without altering the product result, duplicating commits, or force-pushing.
- Runbook and CLI help fully replace boundary-era guidance and document credentials, full workflow delivery, no-CI behavior, evidence namespaces, state/resume, browser proof, calibration, paired review, publication, retention, and manual cleanup.
- Targeted result/report/outcome/human-review/publication tests, disposable-repository push tests, `npm run check`, OpenSpec validation, and full Agent Validator all pass.
- A fresh real-reference browser regression passes captions and canonical content; a recreated local reference earns all 62 applicable automated points and opens all gates; a fresh `--skip-validator` candidate reaches pending review on a unique branch and draft PR.
- Literal paired human review completes both fresh runs, only the finalized scored candidate is published, and its permanent result contains the unscaled shared-92 comparison; preserved candidate/reference branches and draft PRs remain available for diagnosis and manual cleanup.
