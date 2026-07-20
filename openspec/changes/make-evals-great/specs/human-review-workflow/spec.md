## ADDED Requirements

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
