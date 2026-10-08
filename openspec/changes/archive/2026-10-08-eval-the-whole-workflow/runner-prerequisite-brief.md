# Brief: Agent Runner change `external-user-mode`

This brief is for the agent that defines and builds the Agent Runner prerequisite of the agent-evals change
`eval-the-whole-workflow`. It assumes no prior conversation. All paths are absolute.

## Why this change exists

agent-evals is adding a suite, `evals/agent-runner/and-scene-define/`, that evaluates Agent Runner's
**interactive define workflow** (`openspec:change --until define`): proposal, specs, design, test plan, and
approach review, with their crosscheck reviews.

The eval starts from a short prompt and no artifacts. An eval-owned **simulated user** plays the human: a
pinned role-play model with no tools, holding a hidden reference change. It answers the lead agent's
questions under a disclosure policy, so the eval measures which requirements the lead discovers. Judges then
score the produced artifacts against the hidden reference.

That needs interactive steps to run **without a terminal**, with each user turn supplied by an external
responder. Agent Runner cannot do this today. This change adds that capability.

Read for full context:
- the eval proposal: `/Users/paul/codagent/agent-evals.eval-the-whole-workflow/openspec/changes/eval-the-whole-workflow/proposal.md`.
  The "Prerequisite" section is the contract this change must satisfy;
- the eval specs under `.../eval-the-whole-workflow/specs/`, especially `simulated-user/spec.md` and
  `evaluation-isolation/spec.md`;
- the proof of concept: `.../eval-the-whole-workflow/poc/README.md` and `headless-turns-poc.mjs`, with
  four recorded runs in `poc/runs/`.

## The approach, proven by the PoC

Run each interactive step as a **loop of headless turns** on one named session:

1. Start the step headlessly, with the same step prompt, skills, and session the interactive launch uses.
2. When the agent ends a turn without requesting step completion, send the turn to the responder.
3. Continue the same session with the responder's reply as the next user turn:
   - Claude: `claude -p --resume <session> -- "<reply>"`
   - Codex: `codex exec resume <thread> "<reply>"`
4. Repeat until the agent requests completion through the existing control channel.

The PoC ran the real `proposal` step prompt from `workflows/core/define-change-v1.0.yaml` this way:
- two runs each on Claude (`claude-opus-5-5`) and Codex (`gpt-6.1-sol`, high effort);
- every run asked plain-text questions, waited for answers, wrote the proposal after approval, and signalled
  completion;
- no lead took the `codagent:ask-questions` headless branch ("In a headless session, report the unresolved
  decision…");
- the working flag sets and their rationale are in `poc/README.md` under "Exact flag sets".

## Contract the eval needs

These come from the eval proposal's Prerequisite section, refined by the PoC.

- **Turn exchange.** When an interactive turn ends without step completion, the agent's turn reaches the
  responder, and the reply continues the same session as the next user turn.
  - **Relay the whole turn**, not just the last message. Codex emits several agent messages per turn and
    often puts the question in a middle one, ending on a status line. In the PoC, relaying only the last
    message made the simulated user approve a scope it never saw. `extractCodexAgentMessages` already
    joins a turn's messages.
- **Question capture.** Questions must reach the responder as text.
  - Disable `AskUserQuestion` in this mode, as autonomous contexts already do (`internal/exec/agent.go`
    around 713-717). The skills then ask in plain text. Translating the tool is an alternative, but it
    wasn't needed.
- **Identity.** Every exchange carries step, attempt, and turn identity.
- **Completion.** Step completion stays a control-channel action (`agent-runner step complete` →
  `complete_step`), never reply text.
  - Headless launches currently get no completion command; this mode must provide one.
  - The PoC proved the step prompt survives `--resume`: completion happened on turn 4.
- **Replay.** On resume, recorded replies are replayed identically by exchange identity, so a resumed run
  does not re-ask the responder for turns it already has.
- **Transport.** The channel between the sandbox and the responder must never make responder-side material
  readable to the evaluated agent. The responder holds the hidden reference.
  - Locally, the eval runs the responder on the host and only Agent Runner inside the Docker sandbox
    (`scripts/sandbox-run.sh`).
  - On Fly, harness and agent currently share one Machine, so a user or process boundary is needed later.
    That is Agent Factory work and out of scope here.
  - **The eval side would prefer a file exchange.** The Runner writes
    `<exchange-dir>/<step>-<attempt>-<turn>.request.json` into a directory mounted from outside, then waits
    for the matching `.reply.json`. The directory holds only the conversation, so exposing it is safe.
  - The transport is this change's decision. The eval will adapt through one adapter module.
- **No autonomy preamble.** Do not prepend the Runner's autonomous "no human in the loop" text to these
  turns. It would likely push the agent into the skills' headless branch.

## Other gaps found in research

All of these must be fixed or handled for the eval's run to work.

1. **`--until` is ignored on resume.** `--resume` passes no `Until` (`cmd/agent-runner/main.go` around
   936-941), so resuming a `--until define` run continues into `plan`.
2. **`validate-feature-branch` needs GitHub.** It runs `gh repo view`. The eval's starting repo has one
   commit, **no remote, and no GitHub credential**. That step needs a path that works without gh or a
   remote, for example validating the branch locally when there is no GitHub remote.
3. **`call_agent` approval.** Interactive parents (`proposal` and `approach-review` declare
   `tools: [call_agent]`) go through the CLI's normal MCP approval prompt. In this mode that approval must
   be pre-granted. The crosscheck child itself already runs autonomous and headless.
4. **Cursor has no turn-end signal.** Claude has its Stop hook (`turn_committed`) and Codex has `notify`.
   The eval's v1 only needs **Claude and Codex**, so Cursor can be deferred, provided the mode rejects it
   clearly.
5. **Permissions.** Headless turns cannot prompt. The PoC used `--permission-mode acceptEdits` plus an
   allowlist on the host. Inside the sandbox, the Runner's existing autonomous permission handling is
   likely fine; decide and document it.
6. **Usage.** Interactive steps currently report usage as `unavailable` (`interactive-context`).
   Headless turns could report real per-turn usage, which the eval would welcome. This is not required.
7. **`create-change.sh`** expects `agent-validator detect` to exit 2 before running `openspec new change`.
   Confirm this works in a fresh one-commit repo with no remote.

## Relevant Runner code

- `internal/interactive/runner.go:285-302`: the TTY requirement for interactive steps.
- `internal/exec/agent.go`:
  - mode selection: 125-127 and 482-485;
  - adapter input and step prefix: around 700-860;
  - the completion instruction: 812-818;
  - headless failure on AskUserQuestion: 955-964;
  - interactive usage marked unavailable: 1123-1155.
- `internal/cli/claude.go`, `codex.go`, `cursor.go`: the adapter argv builders.
- `internal/control/control.go:36-41`: the control message types. There is no user-turn message today.
- `docs/direct-terminal-handoff.md`: the current interactive design and turn-commit proofs.
- `docs/agent-calls.md` and `internal/exec/agent_call.go`: `call_agent` children.
- `internal/runner/runner.go:168-177` and `746-751`: `--until`.
- `workflows/openspec/change-v2.0.yaml` and `workflows/core/define-change-v1.0.yaml`: the workflows under test.
- `cmd/agent-runner/real_agent_e2e_test.go`: the existing PTY-driven test harness, for comparison.

## Acceptance the eval needs before it is built

The eval proposal requires the mode to be proven **end to end** before the scored suite is built:
- through the `proposal` step **with its crosscheck review**, and through `approach-review`;
- for both Claude and Codex lead profiles;
- inside `sandbox-run.sh` with `--no-default-secrets` and no GitHub credential;
- with a scripted or simple responder.

Also show that a resumed `--until define` run stops after `define` and replays recorded replies.

## Out of scope for this change

- The eval suite, the simulated user's policy, judging, and the contamination audit. Those belong to
  agent-evals.
- The Fly/Agent Factory boundary.
- Cursor support in this mode, unless it turns out to be cheap.
