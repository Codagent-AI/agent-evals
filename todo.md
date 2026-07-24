# Agent Evals work list

Make the planned harness changes first, then run the extracted suite. During implementation, use targeted tests and `npm run check`; defer the browser proof, calibration runs, and complete eval until the work below is integrated.

## Decisions already made

- The official UI/UX score requires a literal human review.
- The automated run ends with the candidate server still running and provides its URL to the human evaluator.
- An interactive evaluator script asks the human a series of questions and records the answers. The criteria are still TBD.
- "Lead agent" means the `lead-agent` session in `implement-change2`, not the `planning-agent` in `plan-change2`.
- The eval should temporarily use `implement-change2` after [Agent Runner PR #51](https://github.com/Codagent-AI/agent-runner/pull/51) lands.
- The first test run should set `skip_validator=true`. Agent Validator does not report cost yet, so it should not be part of that run.
- After Agent Validator gains cost tracking, rerun the eval with Validator enabled.

## 1. Fix the scoring model

- [ ] Redesign the score around the delivered product. Runner health, build success, and evidence completeness should be gates or diagnostic dimensions rather than easy points for a poor result.
- [x] Give human UI/UX judgment enough weight to be a core part of the result. Decide whether a minimum human rating is also a hard gate.
- [x] Define a short, anchored human rubric for visual quality and usability. The exact criteria and questions are TBD.
- [x] End the automated phase with the candidate server running and print its URL in the terminal and run artifacts.
- [x] Add an interactive evaluator script that asks each human-review question, records the answers and rationale, and completes the official score.
- [x] Keep the result in `pending-human-review` until those answers exist. Provide an explicit server cleanup step after review.
- [ ] Keep deterministic checks for mechanically provable requirements and model judging for evidence that needs interpretation.
- [ ] Review the existing 68 pass/fail scenarios, critical gates, weights, and evidence-repair penalty as part of the same scoring change.
- [ ] Version the rubric and record its hash with every result.

## 2. Switch to `implement-change2`

- [ ] Once PR #51 lands, pin the exact Agent Runner revision and switch the suite from `implement-change.yaml` to `implement-change2.yaml`.
- [ ] Pass `change_name=create-and-scene` explicitly.
- [ ] Add `skip_validator` as an eval runner option and pass it through to the `implement-change2` workflow.
- [ ] Set `skip_validator=true` for the first test run. Keep the stop boundary before draft PR creation and confirm the correct `--until` step against the merged workflow.
- [ ] For later Validator-enabled runs, run through the enforcing validation boundary. Based on the current workflow, the expected stop step is `verify-validator`, not `run-validator`; confirm this against the merged workflow.
- [ ] Record the workflow revision, arguments including `skip_validator`, stop step, and executed steps in the result.
- [ ] Add a focused test that catches workflow changes which move the boundary or add publishing side effects before it.

## 3. Add cost and timing

Use `/Users/paul/.agent-skills/changes/agent-evals-cost-tracking/handoff.md` and the Runner-side metrics now on Agent Runner's `cost-tracking` branch.

- [ ] Consume Runner's `run-metrics.json` instead of reconstructing implementation usage from logs or transcripts.
- [ ] Add eval-owned usage and duration for screenshot repair and judging. Agent Validator usage is excluded from the first run because Validator is skipped.
- [ ] Preserve raw token categories and completeness separately from estimated API cost. Missing data must stay missing rather than becoming zero.
- [ ] Use a pinned pricing snapshot and handle unknown model names explicitly.
- [ ] Add `result.json` for score, usage, cost, timing, phases, provenance, and completeness. Keep `reward.json` as the compact scoring artifact.
- [ ] Show implementation time, total time, cost, and phase breakdown in the human-readable result.

## 4. Capture ambiguities and feed them back into specs

- [ ] Preserve implementor assumptions and context gaps, then have the `implement-change2` lead classify and review them.
- [ ] Record unresolved items in a structured ambiguity ledger with the run, task, implementor evidence, relevant spec text, and lead assessment.
- [ ] Distinguish spec gaps, task-planning gaps, missing repository context, legitimate implementation choices, and false alarms.
- [ ] Grade both failure modes: silently making a product decision and escalating an obvious implementation detail.
- [ ] Give unresolved ambiguity its own eval outcome instead of folding it into a generic workflow failure.
- [ ] Turn confirmed recurring gaps into proposed fixture spec or task changes. Apply them only to a new fixture version after review; never mutate benchmark inputs during a run.

## 5. Test lead and implementor agents independently

### `implement-change2` lead

- [ ] Create a post-implementation fixture with completed task work, task-index state, session reports, and known cross-task or ambiguous findings.
- [ ] Add or pin a Runner-owned lead-only entry point that runs the production lead steps without copying their prompts into Agent Evals.
- [ ] Evaluate task-index completion, cross-task review, ambiguity handling, high-confidence fixes, scope control, simplification, and acceptance handoff quality.
- [ ] Stop before draft PR creation. Include clean cases where the correct action is no change.

The `planning-agent` is a separate role and is outside this lead-agent evaluation.

### Task implementor

- [ ] Run the same core `implement-task` workflow used by `implement-change2` against one pinned task at a time.
- [ ] Evaluate task compliance, tests, regression safety, scope control, patch quality, assumption reporting, and ambiguity escalation.
- [ ] Include clear and underspecified tasks so the eval can distinguish good implementation judgment from guessing.

### Full workflow

- [ ] Keep the end-to-end lead plus implementor eval and compare it with the isolated results to locate planning, implementation, handoff, integration, or grading failures.
- [ ] Record per-role model, session, cost, time, retries, and outcome.

## 6. Finish integration, then run it

- [ ] Make partial failures easy to diagnose and distinguish product, agent, Runner, environment, judge, evidence, and pending-human-review states.
- [ ] Pin the fixture, Runner, workflow, models, pricing, rubric, judge prompt, and tool versions for the first real run.
- [ ] Run targeted tests and `npm run check` throughout implementation.
- [ ] After all changes above are integrated, run the browser proof.
- [ ] Grade the reference and deliberately degraded candidates to calibrate the new scoring model.
- [ ] Run one complete implementation eval in the extracted repository with `skip_validator=true`.
- [ ] Leave the candidate server running, provide the URL, and complete the human evaluator questions.
- [ ] Fix any harness bugs found, add regression tests, and rerun.

Repeated trials and a possible Harbor parity spike can wait until this first revised eval works.

## 7. Agent Validator cost tracking roadmap

This work happens after the first test of the revised eval suite.

- [ ] Add usage, cost, duration, model, phase, and completeness reporting to Agent Validator in the Agent Validator repository.
- [ ] Expose Validator metrics to Agent Runner without reconstructing them from logs or transcripts.
- [ ] Teach the eval runner to include Validator metrics in `result.json` while keeping implementation, Validator, and eval-owned costs separate.
- [ ] Run the eval again with `skip_validator=false` and stop after the enforcing validation boundary.

## Still open

- Should cost remain report-only at first, or affect the score immediately?
- Should lead and implementor isolation reuse `and-scene`, or use smaller purpose-built fixtures?
