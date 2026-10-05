## Why

Every current Codagent eval starts from a reviewed, planning-only fixture change: a finished proposal, specifications, design, and test plan. It therefore measures only how well agents *implement* near-perfect requirements. The interactive define workflow is never evaluated, though it is where Codagent is expected to add the most value. That workflow turns a short, underspecified request into a proposal, specifications, design, and test plan through questions and approvals. Changes to the define-change workflow, its skills (`propose`, `spec`, `design`, `test-plan`), the crosscheck reviews, or the lead model go unmeasured today.

Definition quality is also the hardest stage to judge by eye. A plan can read well yet miss requirements the user would have stated if asked. Measuring it means starting from a plain prompt with no artifacts and having something play the user. A role-play agent that answers from the fixture's hidden, reviewed change turns the define workflow into a test of requirement discovery: a requirement the lead agent never identifies or asks about is not volunteered, so it is missing from the artifacts, and grading against the hidden reference exposes the gap.

The result is a **repeatable define-workflow benchmark** for comparing Codagent configurations on one fixture. It is not evidence that the workflow adds value over an alternative; that comparison belongs to the follow-up change `eval-end-to-end-workflow`. This change is the first step toward that end-to-end eval. It establishes the simulated user, the hidden-reference boundary, and requirement-level grading on the cheapest, fastest stage: no product is built, so runs need no implementation, browser checks, or human product review.

## What Changes

- Add a new suite, `evals/agent-runner/and-scene-define/`, that evaluates Agent Runner's interactive define workflow.
- **Starting input.**
  - A pinned, eval-owned short prompt describing what to build.
  - A pinned, hash-recorded starting repository built from an explicit allowlist of the fixture's pre-change scaffold files. Files that describe the target product or the evaluation are rewritten neutrally or excluded; the fixture's `AGENTS.md` and `README.md`, for example, currently name the hidden change and the target project map. A maintainer reviews the resulting tree as the evaluated agent will see it.
  - The repository has a single local history and no remote, so neither the fixture change, the reference implementation, nor prior candidate branches are reachable through Git.
- **Workflow under test.** The suite runs `openspec:change` with `--until define` in the Agent Runner sandbox. That covers the proposal, specifications, design, test-plan, and approach-review steps, including the crosscheck reviews. It is driven by lead and crosscheck profiles. The evaluated agent receives no GitHub credentials.
- **Simulated user.** An eval-owned role-play agent with a fixed profile. It is the only evaluation participant with access to the hidden reference (the and-scene fixture's reviewed `create-and-scene` change).
  - Its first reply is the pinned starting prompt.
  - After that it follows a pinned **disclosure policy**. The policy answers what was asked from the hidden reference and defines handling for broad ("tell me everything"), compound, ambiguous, repeated, and out-of-reference questions. It never volunteers unasked requirements, critiques the artifacts, or reveals the reference.
  - A separate pinned **decision policy** governs crosscheck-finding decisions and artifact approvals. It decides by hidden intent where the reference applies, and otherwise defers to the agent's recommendation.
  - Both policies are tested with scripted conversations. Every exchange is retained as a transcript, approvals are labelled as simulated, and an audit flags over-disclosure and inconsistent withholding. A requirement the simulated user disclosed without being asked earns no coverage in that run.
- **Hidden reference inventory.** A pinned list of requirements derived from the fixture change, each traced to its source. Items are classified **relative to the pinned prompt**, by what a reasonable user asking for this would require:
  - **mandatory:** needed for a complete, correct product; graded.
  - **acceptable-alternative:** intent graded, and alternative designs that meet it pass.
  - **preference:** opinion, judgment, or an incidental reference choice, such as the exact 880 × 380 canvas or the prescribed nine-step sample; not graded.
  - Two agents from different model families label independently from a versioned brief, and a maintainer reconciles their disagreements.
- **Artifact scoring.** Eval-owned judges score the produced proposal, specifications, design, and test plan under a versioned rubric with explicit criteria, points, gates, and pass threshold:
  - **Requirement coverage** of mandatory and acceptable-alternative items, judged by intent rather than wording or structure. This is the primary component.
  - **Fidelity:** no contradiction of hidden intent or of the simulated user's answers. Added scope is reported but not penalized unless it falls under a scope exclusion or contradicts the user.
  - **Artifact quality:** testable specification scenarios, cross-artifact consistency, sound design decisions, and a test plan that covers the requirements.
  - **Gates:** passing `openspec validate`, and a completed define workflow.
- **Calibration.** Weights and the pass threshold are set only after calibration against three kinds of input:
  - human-rated good definitions organized differently from the reference, such as a strong earlier agent definition that a maintainer rates;
  - the fixture's own reviewed change, and a restructured rewrite of it that keeps every requirement;
  - deliberately degraded variants.
  Judges must credit sound alternatives, not just recognize the reference.
- **Requirement-discovery diagnostic.** A non-scoring ledger. For each graded hidden requirement it records whether the agent asked about it, with a cited exchange, and combines that with the requirement's coverage verdict: discovered, inferred, missed, or asked but not captured.
- **Isolation and contamination audit.**
  - Nothing hidden is mounted or readable in the evaluated agent's environment.
  - A contamination audit scans every retained agent tool call, including shell commands, web fetches, and web searches, for access to the fixture repository, the reference implementation, hidden paths, or `agent-evals` content. A run with a hit is reported invalid rather than scored.
  - The sandbox keeps network access, and `agent-evals` and `and-scene` are public. The audit therefore detects rather than prevents contamination, and every result states this residual risk.
  - An enforced outbound-network allowlist and a private, never-published fixture are recorded as open hardening options, not prerequisites.
- **Results.** Each run produces a result with provenance, outcome, scores, the discovery ledger, the simulated-user transcript, the contamination-audit outcome, workflow metrics and cost from Agent Runner's `run-metrics.json`, and eval-owned usage (simulated user and judges) recorded separately.
  - Paired comparisons require the same CLI, model, and effort settings wherever the compared configurations do not deliberately differ.
  - Conclusions rest on repeated runs.

**Prerequisite (separate Agent Runner change `external-user-mode`):** a supported external-user mode for interactive steps that needs no terminal, for Claude and Codex leads. Its contract must cover:
- **Turn exchange:** when an interactive agent turn ends without step completion, the agent's message reaches the responder and the reply continues the same session as the next user turn.
- **Question capture:** every question reaches the responder as text. Question tools such as `AskUserQuestion` are disabled in this mode, so the skills ask in plain text.
- **Identity:** step, attempt, and turn identity on every exchange.
- **Completion:** step completion stays a control-channel action, never reply text.
- **Replay:** recorded replies are replayed identically on resume.
- **Transport:** a channel between the sandbox and the responder that never makes responder-side hidden material readable to the evaluated agent. The implemented mode uses a file exchange: request and reply files in a directory the caller provides, which holds only the conversation. The responder runs on the host, outside the sandbox. On Fly, the harness and the agent currently share one Machine, so this needs a user or process boundary, or a responder outside the Machine.

The suite also needs two opt-in Agent Runner sandbox options: forwarding Claude credentials without the host's Claude settings, and hiding the Agent Runner source from the running workflow. Without them, the host's settings and the Runner's own change history would expose the fixture to the evaluated agent. They are added to the same Agent Runner branch during implementation. Before the scored suite is built, the mode must be proven end to end through the proposal step with its crosscheck review and through approach review, inside the sandbox. This proposal depends on that mode but does not specify or build it.

## Capabilities

### New Capabilities
- `define-workflow-evaluation`: the suite's lifecycle, covering preflight, the allowlisted starting repository and prompt, running `openspec:change --until define` with provenance, profiles and paired-comparison parity, outcomes, metrics, and results.
- `simulated-user`: role-play behavior, the knowledge boundary, the disclosure and decision policies and their scripted tests, responder integration, transcript evidence, and the disclosure audit.
- `hidden-reference-requirements`: the pinned, traceable, prompt-relative, independently labelled inventory of hidden requirements, and how it is refreshed from the fixture.
- `definition-artifact-scoring`: judges, the versioned rubric and score contract, gates, and calibration against alternative, reference, and degraded definitions.
- `requirement-discovery-diagnostic`: the non-scoring per-requirement ledger of whether each graded requirement was asked about and whether it was captured.
- `evaluation-isolation`: keeping hidden material out of the evaluated environment, the tool-call contamination audit that invalidates contaminated runs, and the stated residual risk.

### Modified Capabilities
- None. The `and-scene` suite and its specifications are unchanged.

## Technical Approach

- **New suite, own lifecycle.** Scoring targets artifacts rather than a product, and the lifecycle stops after define, so this is a separate suite under the repository rule that suites own their runner, evidence, and scoring. It reuses the same sandbox entry point (`sandbox-run.sh -- <command>`), profile conventions, and Agent Skills bootstrap pattern as `and-scene`. Unlike `and-scene`, only the evaluated workflow runs in the sandbox; the controller, simulated user, and judges run on the host. Generic `and-scene` mechanics are copied into the new suite rather than extracted, so `and-scene` is untouched; extracting a shared library is a follow-up once both suites are stable.
- **Hidden-knowledge boundary.**
  - The hidden reference and inventory live in this suite's pinned data, outside anything the evaluated agent can read.
  - The simulated user answers through the Agent Runner external-user mode's file exchange, running on the host outside the sandbox.
  - Judges read the candidate's artifacts from the run's collected output. The candidate's branch is never pushed.
- **Simulated user and judges are eval-owned.** Each uses a fixed CLI and model, independent of the evaluated profiles, and their usage is recorded apart from workflow cost.
- **Requirement-level grading.** The inventory is derived from the fixture's 20 requirements and 68 scenarios, then labelled into the three classes. Judges check intent against each item rather than wording, cite artifact locations for every verdict, and are audited like the existing focused judges.
- **Key risks.**
  - The simulated user adds variance and can leak or withhold requirements inconsistently. Mitigations are a fixed model, pinned policies with scripted tests, and the transcript audit.
  - The prompt-relative classification decides what the eval measures, and the starting prompt's wording biases coverage. Both need careful maintainer review, and changing the prompt starts a new results series.
  - Contamination is detected, not prevented, because the sandbox is networked and the reference is public.
  - A single fixture limits generality.

## Out of Scope

- The Agent Runner external-user mode itself; it is specified and built in the Agent Runner repository.
- Enforced outbound-network filtering and a private fixture; both are recorded as open hardening options.
- Planning, implementation, acceptance, archive, and finalize stages, product building and judging, and human product review. These move to the follow-up change `eval-end-to-end-workflow`.
- A raw Claude Code control arm; deferred to `eval-end-to-end-workflow`.
- Making the discovery diagnostic score-affecting.
- Additional fixtures beyond and-scene.
- Any change to the `and-scene` suite, its rubric, or its historical results.

## Impact

- **New code:** `evals/agent-runner/and-scene-define/`, containing the runner script, controller, simulated-user responder and policies, judges, scoring, discovery diagnostic, contamination audit, pinned prompt, allowlisted starting-repository snapshot, hidden-reference inventory, rubric, calibration inputs, runbook, and tests. The root `AGENTS.md` gains a short section on running the suite.
- **Specs:** six new capabilities, listed above.
- **Dependencies:**
  - Agent Runner's external-user mode, `--resume` with `--until`, the two sandbox options above, plus the existing sandbox, `run-metrics.json`, and retained session transcripts for the audit.
  - The pinned and-scene fixture as the source of the hidden reference.
  - No new third-party runtime dependencies.
- **Agent Factory:** Fly execution must accommodate the external-user transport's boundary before factory runs of this suite are possible.
- **Users:** maintainers gain a cheap eval for define-workflow, skill, and lead-model changes, with results kept as a separate series from implementation evals.
