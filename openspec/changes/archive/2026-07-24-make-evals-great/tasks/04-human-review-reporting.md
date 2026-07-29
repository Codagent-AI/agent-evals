# Task: Finalize human review and reporting

## Goal

Deliver the separate resumable literal-human review workflow and make `result.json` plus an escaped offline `report.html` the authoritative final evaluation artifacts. Support paired reference/candidate review and comparison without rerunning valid automated work.

## Background

Add `evals/agent-runner/and-scene/human-review.sh` as a thin host command into the suite-local controller. Add `evals/agent-runner/and-scene/human-rubric.json` and focused modules under `evals/agent-runner/and-scene/lib/` for human response persistence/scoring, candidate-server identity/lifecycle, result assembly, baseline comparison, and HTML rendering.

The command accepts a stable pending run directory; paired mode accepts a pending reference baseline plus candidate and completes the baseline first. It must restore or start the exact frozen candidate, print its URL, obtain non-scoring readiness confirmation, save every valid answer atomically, resume at the first unanswered question, permit revision, and finalize only after explicit summary confirmation.

`result.json` is assembled only from validated phase artifacts. `report.html` is a pure rendering of the current result, embeds no candidate markup or external asset, escapes every untrusted value, and uses relative artifact links. Result assembly also creates and updates `artifact-manifest.json` as the durable inventory of deliberate run artifacts, excluding `.runtime`, so `tasks/05-publication-calibration-cutover.md` can copy an existing manifest into its curated snapshot. This artifact inventory is distinct from the candidate source manifest used to freeze scoring identity in `tasks/02-product-evaluation-scoring.md`. The reference baseline uses the identical product and human rubrics while marking Runner roles/cost/timing not applicable.

Implement test-first with injected input/output and process controls so all 13 questions, interruption/resume, revision, provenance mismatch, candidate-server PID reuse, baseline comparison, and rendering can be verified noninteractively. Do not add runtime dependencies.

## Spec

Source: `specs/human-review-workflow/spec.md`

### Requirement: Human-review handoff
After automated browser evaluation and LLM judging complete, the main evaluation command SHALL set the run state to `pending-human-review`, write the automated result and HTML report, attempt candidate-server cleanup, and exit successfully without asking human-review questions, an official total score, or a pass verdict.

The separate `human-review.sh` command SHALL accept a pending run directory, keep or restore the evaluated candidate server, print its URL, and wait for an explicit non-scoring readiness confirmation before asking the first human-review question. The candidate served to the reviewer SHALL be the same candidate revision evaluated by the automated rubric and LLM judge. If the candidate server is unavailable or does not match the evaluated candidate, the command SHALL NOT collect ratings and SHALL report an evaluation-harness failure.

#### Scenario: Automated evaluation reaches human handoff
- **WHEN** automated browser evaluation and LLM judging complete
- **THEN** the main evaluation command durably records `pending-human-review`, writes the automated result and report, attempts cleanup, and exits successfully
- **AND** it does not ask human-review questions or issue an official total or pass verdict

#### Scenario: Human-review command opens a pending run
- **WHEN** a reviewer invokes `human-review.sh` for a pending run with matching candidate and rubric provenance
- **THEN** the command restores or starts the evaluated candidate server, prints its URL, and waits for readiness confirmation before asking question 1

#### Scenario: Candidate server is unavailable
- **WHEN** `human-review.sh` cannot serve and verify the evaluated candidate for human review
- **THEN** it does not collect human ratings
- **AND** it reports an evaluation-harness failure rather than a product failure

#### Scenario: Paired baseline and candidate review
- **WHEN** `human-review.sh` receives a pending reference-baseline run and a pending Agent Runner candidate run
- **THEN** it completes the 13 reference-baseline questions before the 13 candidate questions
- **AND** it preserves independent candidate, rubric, response, score, and completion state for each run

### Requirement: Versioned v1 human-review questions
The v1 human-review rubric SHALL ask exactly the following 13 questions, one at a time and in the listed order. Each question SHALL collect one rating and its rationale before the next question is displayed.

| # | Dimension | Question |
|---:|---|---|
| 1 | Step 1 | Rate step 1, "You have a topic." Considering its initial composition and entrance, how clearly and intentionally does it present the required content? |
| 2 | Step 2 | Rate step 2, "The skill interviews you." Considering its composition and the transition into it from the previous step, how clearly, intentionally, and coherently does it present the required content and continuity? |
| 3 | Step 3 | Rate step 3, "Answers become steps." Considering its composition and the transition into it from the previous step, how clearly, intentionally, and coherently does it present the required content and continuity? |
| 4 | Step 4 | Rate step 4, "The deck grows." Considering its composition and the transition into it from the previous step, how clearly, intentionally, and coherently does it present the required content and continuity? |
| 5 | Step 5 | Rate step 5, "You set the depth." Considering its composition and the transition into it from the previous step, how clearly, intentionally, and coherently does it present the required content and continuity? |
| 6 | Step 6 | Rate step 6, "It assembles the scene." Considering its composition and the transition into it from the previous step, how clearly, intentionally, and coherently does it present the required content and continuity? |
| 7 | Step 7 | Rate step 7, "It checks its own work." Considering its composition and the transition into it from the previous step, how clearly, intentionally, and coherently does it present the required content and continuity? |
| 8 | Step 8 | Rate step 8, "Changed your mind? Loop it." Considering its composition and the transition into it from the previous step, how clearly, intentionally, and coherently does it present the required content and continuity? |
| 9 | Step 9 | Rate step 9, "You're looking at one." Considering its composition and the transition into it from the previous step, how clearly, intentionally, and coherently does it present the required content and continuity? |
| 10 | Readability and visual hierarchy | Rate the presentation's readability and visual hierarchy, including typography, contrast, legibility, scanning order, emphasis, labels, and captions across the presentation. |
| 11 | Navigation and interaction usability | Rate the presentation's navigation and interaction usability, including discoverability, current-step feedback, controls, present/browse switching, and supported navigation methods. |
| 12 | Responsive visual quality | Rate the presentation's responsive visual quality: whether it remains readable, composed, and usable across desktop and narrow viewports without problematic clipping, overlap, or chrome interference. |
| 13 | Overall cohesion and polish | Rate the presentation's overall cohesion and polish, including consistency, visual rhythm, intentionality, detail quality, and whether it feels finished as a whole. |

#### Scenario: Questions are asked in order
- **WHEN** a reviewer completes a valid response to a question
- **THEN** the harness displays only the next numbered question in the v1 sequence

#### Scenario: First step has no incoming transition
- **WHEN** the harness asks question 1
- **THEN** it asks about the step's initial composition and entrance rather than a transition from a previous step

#### Scenario: Later steps include transition quality
- **WHEN** the harness asks any question from 2 through 9
- **THEN** the question asks the reviewer to consider both that step's composition and its transition from the previous step

#### Scenario: Global dimensions follow slide questions
- **WHEN** all nine per-step questions have valid responses
- **THEN** the harness asks readability, navigation, responsive quality, and overall cohesion questions in that order

### Requirement: Anchored human responses
Every human-review question SHALL accept a whole-number rating from 1 through 5 and a rationale together. The v1 rubric SHALL use the following anchors for every question.

| Rating | Anchor |
|---:|---|
| 1 | Unacceptable — broken, unusable, or severely deficient |
| 2 | Poor — major visible or usability issues materially hurt the experience |
| 3 | Adequate — functional and understandable, with noticeable issues |
| 4 | Strong — clear and polished, with only minor issues |
| 5 | Excellent — highly intentional and cohesive, with no meaningful problems |

A rationale SHALL be required for ratings of 1, 2, or 3 and SHALL be optional for ratings of 4 or 5. The harness SHALL reject a rating outside the integer range 1 through 5 or a rating of 3 or lower without a non-empty rationale, and SHALL repeat the same question without advancing.

#### Scenario: Low or adequate rating includes rationale
- **WHEN** the reviewer submits a rating of 1, 2, or 3 with a non-empty rationale
- **THEN** the harness accepts and saves the response

#### Scenario: Required rationale is missing
- **WHEN** the reviewer submits a rating of 1, 2, or 3 without a non-empty rationale
- **THEN** the harness rejects the response and repeats the same question

#### Scenario: Strong rating omits rationale
- **WHEN** the reviewer submits a rating of 4 or 5 without a rationale
- **THEN** the harness accepts and saves the response

#### Scenario: Rating is outside the rubric
- **WHEN** the reviewer submits a value other than a whole number from 1 through 5
- **THEN** the harness rejects the response and repeats the same question

### Requirement: Human-review score
The harness SHALL calculate the human-review score out of 30 using the following point allocation.

| Dimension | Points |
|---|---:|
| Average of the nine per-step ratings | 10 |
| Readability and visual hierarchy | 5 |
| Navigation and interaction usability | 4 |
| Responsive visual quality | 4 |
| Overall cohesion and polish | 7 |

For each rating `r`, the harness SHALL calculate its earned fraction as `(r - 1) / 4`, mapping ratings 1 through 5 to 0%, 25%, 50%, 75%, and 100% respectively. The per-step subtotal SHALL equal the average earned fraction of questions 1 through 9 multiplied by 10. Each global-dimension subtotal SHALL equal that question's earned fraction multiplied by its listed points. The harness SHALL sum the five subtotals without intermediate rounding.

The human-review component gate SHALL pass only when the score is at least 15 out of 30 and no individual rating is 1.

#### Scenario: Human score is calculated
- **WHEN** all 13 questions have valid responses
- **THEN** the harness applies the anchored conversion and listed dimension weights without intermediate rounding
- **AND** it reports the five subtotals and their sum out of 30

#### Scenario: Human component passes
- **WHEN** the human-review score is at least 15 and every rating is at least 2
- **THEN** the human-review component gate passes

#### Scenario: Rating of one blocks the component gate
- **WHEN** any human-review response has a rating of 1
- **THEN** the human-review component gate fails regardless of the total human-review score

#### Scenario: Human score misses its floor
- **WHEN** the human-review score is below 15
- **THEN** the human-review component gate fails

### Requirement: Review confirmation and finalization
After question 13 has a valid response, the harness SHALL display every rating and rationale, each dimension subtotal, the total human-review score, and the human component-gate result. The reviewer SHALL be able to select and revise an answer, after which the harness SHALL recalculate and redisplay the summary. The human review SHALL become final only after the reviewer explicitly confirms the complete summary.

#### Scenario: Reviewer confirms the summary
- **WHEN** the reviewer explicitly confirms the displayed responses and calculated score
- **THEN** the harness finalizes the human-review artifact and makes the human score available to official product scoring

#### Scenario: Reviewer revises an answer
- **WHEN** the reviewer chooses a prior question and submits a valid replacement response
- **THEN** the harness saves the replacement, recalculates all affected subtotals and gates, and displays the updated summary before requesting confirmation again

#### Scenario: Summary is not confirmed
- **WHEN** the review process exits before the reviewer confirms the summary
- **THEN** the run remains `pending-human-review`
- **AND** no official total score or pass verdict is produced

### Requirement: Durable human-review progress
The human-review command SHALL durably save each valid response immediately after accepting it. On resume, it SHALL verify that the saved review belongs to the same candidate and human-review rubric, restore every completed response, present the candidate URL and readiness confirmation again, and continue at the first unanswered question. It SHALL NOT rerun completed automated evaluation or LLM judging solely because human review was interrupted.

The finalized `human-review.json` artifact SHALL record the evaluated candidate identity, human-review rubric version and SHA-256 hash, all question identifiers and text, ratings, rationales, dimension subtotals, final score, component-gate result, and completion state.

#### Scenario: Review resumes after interruption
- **WHEN** `human-review.sh` resumes a pending review with matching candidate and rubric provenance
- **THEN** it restores all saved valid responses and continues at the first unanswered question

#### Scenario: Paired review resumes after interruption
- **WHEN** a paired baseline and candidate review is interrupted
- **THEN** the next invocation resumes the first run with an unanswered question and does not repeat finalized answers from either run

#### Scenario: Review provenance does not match
- **WHEN** the saved human-review state names a different candidate or human-review rubric
- **THEN** the harness refuses to reuse the saved responses
- **AND** it reports a clear resume-provenance error

#### Scenario: Completed phases are preserved
- **WHEN** a run resumes solely to continue pending human review
- **THEN** the harness reuses the completed automated and LLM-judge artifacts whose provenance still matches

### Requirement: Candidate-server lifecycle
The main evaluation command and human-review command SHALL attempt to shut down the candidate server whenever either command exits, including after automated deferral, completed review, and interrupted review. Cleanup success or failure SHALL be recorded diagnostically and SHALL neither award nor deduct product points.

On resume, the harness SHALL check the recorded server identity and candidate provenance. It SHALL reuse the process only when it can verify that the process is the recorded server for the evaluated candidate; otherwise it SHALL start a new candidate server. It SHALL NOT terminate or reuse an unrelated process based only on a recycled process identifier or occupied port.

#### Scenario: Review completes normally
- **WHEN** human review is finalized and downstream result artifacts have been written
- **THEN** the harness attempts to stop the candidate server and records the cleanup outcome

#### Scenario: Review is interrupted
- **WHEN** the human-review command exits before human review is finalized
- **THEN** it attempts to stop the candidate server while preserving completed review responses

#### Scenario: Automated command defers review
- **WHEN** the main evaluation command writes a pending-human-review result
- **THEN** it attempts to stop the candidate server before exiting

#### Scenario: Recorded server is still running on resume
- **WHEN** resume verifies that the recorded process is serving the same evaluated candidate
- **THEN** the harness reuses that server for the remaining evaluation steps

#### Scenario: Recorded server is absent on resume
- **WHEN** the recorded candidate server is not running
- **THEN** the harness starts a new server for the same evaluated candidate and records its identity

#### Scenario: Process identity does not match
- **WHEN** the recorded process identifier or port now belongs to an unrelated process
- **THEN** the harness leaves that process untouched and starts or selects a safe server endpoint for the evaluated candidate

Source: `specs/evaluation-metrics-reporting/spec.md`

### Requirement: Detailed result artifact
The harness SHALL atomically write a versioned `result.json` containing run kind; evaluation status and product verdict; `official_score` when complete; `automated_subtotal` when all automated scoring is complete; `available_component_scores` for individually completed components; component, subcomponent, criterion, and gate results; automated and human rubric provenance; human responses and rationales; Agent Runner workflow and agent-role provenance; per-agent/model implementation usage and costs; pricing evidence and verification state; machine phase timing; checkpoint and resume history; independent completeness fields; artifact references; and reference-baseline identity and score deltas when applicable.

The harness SHALL NOT rescale `automated_subtotal` or `available_component_scores` into a score out of 100. In human-facing output, provenance SHALL be labeled in plain language as "source and version details."

#### Scenario: Complete result is written
- **WHEN** official scoring completes
- **THEN** `result.json` contains `official_score`, the full scoring breakdown, metrics, source and version details, and completeness

#### Scenario: Human review is pending
- **WHEN** all automated scoring completes without finalized human review
- **THEN** `result.json` contains `automated_subtotal` out of 70 and no `official_score`

#### Scenario: Evaluation stops after some components complete
- **WHEN** an incomplete evaluation has evidence-backed completed component results
- **THEN** `result.json` preserves them as `available_component_scores`
- **AND** it does not convert them into an unofficial total

#### Scenario: Result is updated after resume
- **WHEN** resumed evaluation produces additional durable results
- **THEN** the harness atomically replaces `result.json` with a version containing both preserved and newly completed work

#### Scenario: Reference baseline result is written
- **WHEN** the existing implementation completes automated and human scoring as a `reference-baseline` run
- **THEN** `result.json` contains the same product score breakdown and gates as an Agent Runner candidate
- **AND** it marks Agent Runner roles, implementation cost, and implementation timing not applicable rather than zero

#### Scenario: Candidate is linked to its baseline
- **WHEN** a completed Agent Runner candidate was reviewed against a completed reference baseline
- **THEN** its result records the baseline run identity plus total, component, subcomponent, and gate comparisons

### Requirement: Self-contained HTML report
Every evaluation SHALL produce a self-contained static artifact named `report.html`, including evaluations that complete, fail, remain incomplete, or await human review. The report SHALL be viewable offline without a server or external assets, SHALL escape untrusted content, and SHALL NOT execute candidate-provided markup or scripts. Artifact links SHALL be relative to the report's run directory.

The report SHALL lead with `PASS` or `FAIL` when a product verdict is available, `EVALUATION FAILED` when a workflow or harness failure prevents a product verdict, or `PENDING HUMAN REVIEW` while awaiting review. When a product verdict is available but a later harness failure leaves the evaluation status failed, the report SHALL display both facts prominently. It SHALL present a concise score and outcome summary followed by expandable details for component and subcomponent scores, thresholds, gates, every automated criterion and its rationale and evidence, human ratings and rationales, workflow and harness outcomes, agent roles and models, implementation usage and cost, pricing sources, machine timing, completeness, and source and version details. A candidate linked to a reference baseline SHALL also display total, component, subcomponent, and gate comparisons without treating not-applicable baseline implementation metrics as zero.

The harness SHALL generate or update the report whenever `result.json` reaches a durable pending, terminal, resumed, or finalized state.

#### Scenario: Completed product passes
- **WHEN** official scoring produces a pass verdict
- **THEN** `report.html` prominently displays `PASS` and the official score

#### Scenario: Completed product fails
- **WHEN** official scoring produces a fail verdict
- **THEN** `report.html` prominently displays `FAIL` and the official score

#### Scenario: Evaluation infrastructure fails
- **WHEN** workflow or harness failure prevents an official product verdict
- **THEN** `report.html` prominently displays `EVALUATION FAILED`
- **AND** it states that the product verdict is unavailable while showing completed diagnostic results

#### Scenario: Harness fails after product scoring
- **WHEN** an official product verdict was durably recorded before a later harness failure
- **THEN** `report.html`, when available, prominently displays both the `PASS` or `FAIL` product verdict and the harness-failure status
- **AND** it does not erase or change the product score

#### Scenario: Human review is pending
- **WHEN** automated evaluation completes without finalized human review
- **THEN** `report.html` prominently displays `PENDING HUMAN REVIEW` and the automated subtotal

#### Scenario: Candidate content contains markup
- **WHEN** report content includes candidate-controlled HTML or script-like text
- **THEN** the report renders it as inert text rather than executable content

#### Scenario: Baseline comparison is rendered
- **WHEN** a completed candidate result references a completed reference baseline produced by the same rubric versions
- **THEN** `report.html` displays the baseline and candidate totals, components, subcomponents, gates, and deltas

#### Scenario: Baseline rubric does not match
- **WHEN** a candidate and proposed reference baseline use different automated or human rubric versions or hashes
- **THEN** the report refuses to present their scores as a direct comparison

### Requirement: Independent completeness reporting
The evaluation SHALL report score, implementation usage, implementation cost, pricing, timing, evidence, workflow provenance, and metric-history completeness independently. An unavailable value in one dimension SHALL NOT be represented as zero or silently alter another dimension's completeness.

#### Scenario: Usage is unavailable but Runner reports cost
- **WHEN** Agent Runner reports an attempt cost while token usage is unavailable
- **THEN** cost may be complete while usage remains explicitly unavailable

#### Scenario: Price is unverified
- **WHEN** a judge-found price contributes to a complete numeric total
- **THEN** total-cost completeness may be complete
- **AND** pricing verification states that the total contains unverified pricing

#### Scenario: Runner metric history was lost
- **WHEN** Agent Runner reports `history_complete=false`
- **THEN** the result preserves that state independently of the usage and cost coverage calculated from the remaining records

#### Scenario: Product evidence is incomplete
- **WHEN** some product criteria were never observed
- **THEN** score completeness identifies the gap without turning the missing observations into product failures

Source: `specs/evaluation-outcomes/spec.md`

### Requirement: Pending human-review outcome
The evaluation SHALL use `pending-human-review` when all required automated scoring has completed but the required human review has not been finalized. This state SHALL contain the automated subtotal and available completed diagnostics but SHALL NOT contain an official score or pass/fail product verdict.

#### Scenario: Automated scoring awaits reviewer
- **WHEN** automated scoring is complete and no finalized human-review record is available
- **THEN** `evaluation_status` is `pending-human-review`, `product_verdict` is `unavailable`, and no official score is issued

#### Scenario: Human review is finalized
- **WHEN** a pending evaluation resumes and finalizes valid human-review responses
- **THEN** the evaluation replaces the pending state with `complete` and calculates the applicable `pass` or `fail` product verdict

#### Scenario: Noninteractive run reaches human review
- **WHEN** the main evaluation command completes automated scoring
- **THEN** it exits successfully with a durable `pending-human-review` result rather than attempting human review or reporting failure

#### Scenario: Handoff cleanup is incomplete
- **WHEN** the main evaluation command cannot complete candidate-server cleanup after durably writing the pending result artifacts
- **THEN** `evaluation_status` remains `pending-human-review`, the cleanup error is recorded diagnostically for review or resume, and the command exits successfully

#### Scenario: Separate review command finalizes pending result
- **WHEN** `human-review.sh` completes and confirms all required responses for a pending run
- **THEN** the evaluation transitions to `complete` with the applicable product verdict without rerunning automated scoring

### Requirement: Preserve a durable product verdict across later harness failure
Once the official score and product verdict have been computed from complete required scoring inputs and durably recorded, a later harness failure SHALL NOT erase or alter them. The evaluation SHALL change `evaluation_status` to `evaluation-harness-failed`, preserve `product_verdict` as `pass` or `fail`, and present the harness failure alongside the valid product result.

#### Scenario: Cleanup fails after a passing verdict
- **WHEN** a passing official score and verdict are durably recorded and candidate-server cleanup subsequently fails
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` remains `pass`, and the cleanup failure is prominently reported

#### Scenario: Report generation fails after a failing verdict
- **WHEN** a failing official score and verdict are durably recorded and HTML report generation subsequently fails
- **THEN** `evaluation_status` is `evaluation-harness-failed`, `product_verdict` remains `fail`, and `result.json` records the missing required report

#### Scenario: Failure occurs before durable verdict
- **WHEN** a harness failure occurs after some scoring work but before an official product verdict is durably recorded
- **THEN** `product_verdict` remains `unavailable` and completed component results are preserved diagnostically

### Requirement: Consistent outcome presentation
`result.json` SHALL be the authoritative machine-readable outcome and `report.html` SHALL render the same current evaluation status, product verdict, official score availability, failed or pending phase, and reason. Human-facing output SHALL use prominent `PASS` or `FAIL` labels when a product verdict is available, `PENDING HUMAN REVIEW` when review is outstanding, and `EVALUATION FAILED` when workflow or harness failure leaves the product verdict unavailable.

When a harness failure coexists with a valid product verdict, human-facing output SHALL display both, such as `PASS — HARNESS FAILURE` or `FAIL — HARNESS FAILURE`, and SHALL explain the harness failure separately from product findings.

#### Scenario: Product verdict is available
- **WHEN** `product_verdict` is `pass` or `fail`
- **THEN** the result artifacts display the matching `PASS` or `FAIL` label and official score

#### Scenario: Failure leaves verdict unavailable
- **WHEN** workflow or harness failure leaves `product_verdict` unavailable
- **THEN** the result artifacts display `EVALUATION FAILED` and identify the owning phase and reason

#### Scenario: Harness failure follows valid verdict
- **WHEN** `evaluation_status` is `evaluation-harness-failed` and `product_verdict` is `pass` or `fail`
- **THEN** the result artifacts prominently display both statuses without converting the product verdict to unavailable

#### Scenario: Report and result disagree
- **WHEN** report generation detects that its rendered outcome would differ from the current `result.json`
- **THEN** the harness fails report generation rather than publishing contradictory outcome information

## Done When

- The automated command durably stops at `pending-human-review`, writes the automated result/report, attempts cleanup, and exits successfully without prompting or inventing an official verdict.
- `human-review.sh` asks the exact 13 versioned questions in order, enforces anchors/rationales, persists each accepted answer, supports revision and interruption, and finalizes the approved 30-point calculation only after confirmation.
- Candidate server reuse/cleanup is provenance-safe and never kills or reuses a process based only on a recycled PID or occupied port.
- `result.json` contains the approved scoring, provenance, diagnostic, completeness, history, artifact, human, and baseline fields without rescaling or zero substitution.
- Result assembly creates and updates `artifact-manifest.json` alongside the durable result/report artifacts, excludes `.runtime`, and leaves the manifest ready for the six-file publication snapshot.
- `report.html` renders every pending/complete/failed/coexisting-verdict state offline, escapes candidate-controlled content, matches `result.json`, and shows valid baseline deltas only for identical rubric versions and hashes.
- Tests cover synthetic human answers, paired resume, candidate/rubric mismatch, cleanup failures before and after durable verdict, report/result disagreement, markup injection, and not-applicable baseline metrics; targeted tests and `npm run check` succeed.
