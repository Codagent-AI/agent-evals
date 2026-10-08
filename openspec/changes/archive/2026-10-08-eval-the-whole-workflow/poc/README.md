# Headless-turn PoC: driving an interactive define step without a TTY

This proof of concept checks whether Agent Runner can run an **interactive** define step as a loop of
**headless turns**, with a simulated user answering the lead agent. Each loop iteration:

1. Starts the step headlessly (first iteration only).
2. When the lead ends a turn without completing the step, sends its turn to a simulated user.
3. Continues the same lead session, with the simulated user's reply as the next user turn
   (`claude -p --resume <id> "<reply>"` or `codex exec resume <id> "<reply>"`).
4. Repeats until the lead signals completion.

The main risk was `codagent:ask-questions`'s headless branch ("In a headless session, report the
unresolved decision… Never continue past a question by inventing the user's answer"). If the lead
concluded from `-p` / `exec` that it was headless, it would stop asking. **It did not, in any of the
four runs.** See [Findings](#findings).

The PoC is kept as a reference for whoever builds the real Runner integration and the eval.

## Files

| Path | What it is |
|---|---|
| `headless-turns-poc.mjs` | The harness: Node 22 ESM with no dependencies. |
| `runs/<cli>-<UTC timestamp>/` | One directory per run (see [Run outputs](#run-outputs)). |

The hidden reference (proposal, specs, design, test plan; never tasks) is read from its directory by
path at run time. It is never copied into this directory.

## Running it

```sh
cd openspec/changes/eval-the-whole-workflow/poc
node headless-turns-poc.mjs --cli claude            # clean Claude lead (default)
node headless-turns-poc.mjs --cli claude --claude-lead-setup host   # the user's own Claude setup
node headless-turns-poc.mjs --cli codex
node headless-turns-poc.mjs --cli claude --print-prompt   # show the lead step prompt; no model calls
node headless-turns-poc.mjs --help
```

Prerequisites:

- `claude` (2.1.289 was used) and `codex` (codex-cli 0.160.0) with working auth;
- `openspec` 1.6.0 and `git`;
- local checkouts of Agent Runner (step prompt source) and Agent Skills (codagent skills);
- the scrubbed fixture change, which is the hidden reference.

Every path has a flag; the defaults are this machine's paths. `POC_SCRATCH_DIR` overrides the scratch
directory. A run costs roughly $1–2 for Claude and takes 2–4 minutes.

Each run does the following:

1. Creates a throwaway target repository at `<scratch>/poc-target-<cli>-<ts>/`, outside the agent-evals
   worktree. It mirrors the change workflow up to its define step:
   1. `git init -b main`;
   2. a README ("Presentation tools repository");
   3. `openspec init --tools none .`, so OpenSpec installs none of its own agent skills;
   4. an initial commit;
   5. `git checkout -b add-presentation-skill`;
   6. `openspec new change add-presentation-skill`, left uncommitted as `create-change.sh` leaves it.
2. Builds the lead's step prompt (see [Step prompt](#step-prompt-and-the-two-substitutions)).
3. Runs the loop. It stops when the marker file exists, after 30 lead turns (`--max-turns`), when a
   lead turn exceeds 15 minutes (`--turn-timeout-minutes`), or when a lead or simulated-user call fails.
4. Records whether `proposal.md` exists, whether the marker was created, and the result of
   `openspec validate add-presentation-skill`. The validation is informational only and always fails
   after only the proposal step: "Change must have at least one delta".

## Exact flag sets

All children get the parent environment minus every `CLAUDE*` variable. This harness was itself
launched from Claude Code, and variables such as `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDECODE`, and
`CLAUDE_EFFORT` would otherwise leak a nested-session context into the lead. stdin is always
`/dev/null`; without that, Codex prints "Reading additional input from stdin...".

### Claude lead

The working directory is the target repo.

```sh
# first turn
claude -p --session-id <uuid> \
  [clean-setup flags] \
  --model claude-opus-5-5 --permission-mode acceptEdits \
  --allowedTools Read Edit Write Glob Grep Skill 'Bash(openspec:*)' 'Bash(git:*)' 'Bash(touch:*)' \
                 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(mkdir:*)' 'Bash(find:*)' 'Bash(head:*)' 'Bash(wc:*)' 'Bash(pwd)' \
  --disallowedTools AskUserQuestion \
  --output-format stream-json --verbose \
  --append-system-prompt "<step prompt>" \
  -- "Let's start the proposal step"

# every later turn: identical except the session selector and no system prompt
claude -p --resume <uuid> [same flags] -- "<simulated-user reply>"

# clean-setup flags (default; --claude-lead-setup host omits them)
  --setting-sources '' --strict-mcp-config \
  --plugin-dir /Users/paul/codagent/agent-skills \
  --settings '{"permissions":{"deny":["Read(/<scratch>/fixture-scrub/**)","Read(/<reference dir>/**)",
              "Read(//Users/paul/codagent/**)","Read(~/.claude/**)","Read(~/.agents/**)","Read(~/.codex/**)"]}}'
```

Why each choice:

- **`--append-system-prompt` on the first turn only.** This matches the Runner's Claude adapter. Claude
  Code's system-prompt snapshot (on by default since 2.1.267) records the prompt on the first request
  and replays it on `--resume`. The turn-4 marker `touch` in every run proves the resumed session kept
  the step instructions.
- **`--permission-mode acceptEdits` plus an allowlist, never `bypassPermissions`.** Under `-p`, any tool
  outside the allowlist is denied and never prompted for. The denials are recorded per turn.
- **`--disallowedTools AskUserQuestion`.** In a TTY-less session, the question has to arrive as plain
  text in the turn output. This is what the Runner already does for autonomous contexts.
- **`--output-format stream-json --verbose` instead of the suggested `json`.** This also matches the
  Runner's headless Claude invocation. It still yields the final `result` event, and it adds the `init`
  event (tools, skills, plugins, model) and every `tool_use`. That is how the PoC verifies that
  `codagent:propose` and `codagent:ask-questions` were available and actually invoked.
- **The `--` before the prompt.** `--allowedTools` and `--disallowedTools` are variadic and would
  otherwise swallow the prompt. The Runner adapter does the same.
- **Clean setup.** Run 1, on the host setup, was contaminated (see [Findings](#findings)). Clean mode
  loads no user or project settings, hooks, plugins, or MCP servers. It loads only the codagent plugin,
  from the local Agent Skills checkout through `--plugin-dir`, and denies built-in reads of the hidden
  reference and of directories that would reveal it. OAuth from the keychain still works without
  `--bare`; `--bare` would require `ANTHROPIC_API_KEY`.

### Codex lead

```sh
# first turn
CODEX_HOME=<private> HOME=<private> \
codex exec --json --skip-git-repo-check -C <target> --sandbox workspace-write \
  -m gpt-6.1-sol -c model_reasoning_effort="high" \
  "<system>\n<step prompt>\n</system>\n\nLet's start the proposal step"

# every later turn (cwd = target); `exec resume` has no -C/--sandbox, so the sandbox is a top-level flag
CODEX_HOME=<private> HOME=<private> \
codex --sandbox workspace-write exec resume --json --skip-git-repo-check \
  -m gpt-6.1-sol -c model_reasoning_effort="high" <thread_id> "<simulated-user reply>"
```

- **Session id.** It comes from the first `thread.started` event's `thread_id`.
- **Model.** The model passed is `gpt-6.1-sol` with high effort, matching the user's `~/.codex/config.toml`
  default. It is passed on every resume, because Codex otherwise resumes with its default model. The
  session rollouts in the private home record `"model":"gpt-6.1-sol"` on every turn, and
  `sandbox_policy` `workspace-write` with `network_access:false`.
- **Private homes.** Codex does not have the codagent plugin installed in the user's setup. The only
  copies are stale May 2026 `propose` and `ask-questions` skills in `~/.agents/skills`, which differ from
  the current skills. Each run therefore creates `<scratch>/poc-codex-<ts>/codex-home` and installs the
  plugin there:
  1. copy `~/.codex/auth.json` in;
  2. `codex plugin marketplace add /Users/paul/codagent/agent-skills`;
  3. `codex plugin add codagent@codagent`, which installs 0.12.3, identical to the local `skills/`.

  This mirrors `bootstrap-agent-skills.sh`. `HOME` is also private, so the stale `~/.agents/skills`
  copies and the user's `notify` hook are invisible. The `auth.json` copy is deleted when the run exits.
  `~/.codex` and `~/.claude` are never modified.
- **`<system>` wrapper.** Codex has no system-prompt flag. Note that the Runner's Codex path only adds
  this wrapper when there is engine enrichment or a profile system prompt; otherwise it sends the bare
  full prompt. The PoC adds the same "Let's start the proposal step" line that the Claude path sends.

### Simulated user

A fresh, stateless call is made for every reply. It runs in an empty scratch directory.

```sh
claude -p --model claude-opus-5-5 \
  --tools '' --setting-sources '' --strict-mcp-config --disable-slash-commands --no-session-persistence \
  --system-prompt "<policy + hidden reference>" \
  --json-schema '{"type":"object","properties":{"reply_type":{"enum":[answer,approval,decision,decline,clarification]},"text":{...}},...}' \
  --output-format stream-json --verbose \
  -- "<whole conversation so far + the lead's latest turn>"
```

What each part does:

- **No tools.** `--tools ''` removes every built-in tool. `--json-schema` is delivered through a
  synthetic `StructuredOutput` tool, which is the only entry in the `init` tool list and the only
  `tool_use`. The harness checks both on every call (`toolCheck.ok`); all checks passed.
- **No user context.** `--setting-sources ''` loads no user, project, or local settings: no hooks, no
  plugins, no permissions. `--strict-mcp-config` loads no MCP servers. `--disable-slash-commands` loads
  no skills. The model confirmed it received no CLAUDE.md, memory, or hook output. Claude Code still
  attaches a small automatic `userEmail` context block and its environment block; there is no flag to
  drop those short of `--bare`.
- **The first reply** is the pinned starting prompt, inserted verbatim by the harness without a model
  call.
- **The system prompt** is the policy in `simulatedUserPolicy()`, which implements
  `specs/simulated-user/spec.md`: disclosure and decision policy, never volunteer, never mention
  notes/reference/evaluation. It is followed by the reference files as "private requirements notes".
  Only its SHA-256 is stored in the run directory.
- **Policy versions.** Policy `poc-1` (Claude run 1) let option answers carry extra detail. Policy
  `poc-2` tightens rule 7 ("name the matching option and stop; at most one corrective sentence") and
  adds rule 8 ("no unasked commands, paths, numbers, tool choices, or pass/fail rules").

## Step prompt and the two substitutions

The prompt is the `proposal` step prompt from `agent-runner/workflows/core/define-change-v1.0.yaml`, copied
verbatim. The harness extracts the YAML block scalar at run time; see `step-prompt.txt` in each run for
the exact text. It is assembled the way `internal/exec/agent.go` `buildAdapterInput()` does for a fresh
interactive step:

```
buildStepPrefix()   You are running in the "change" workflow: <change-v2.0 description>
                    The current step is "proposal".
                    Before doing anything else, announce that you are starting this step.
step prompt         interpolated with change-v2.0.yaml's values:
                      change_name = add-presentation-skill
                      change_dir  = openspec/changes/add-presentation-skill
                      change_label = OpenSpec change
                      artifact_location_instruction = "Keep every OpenSpec definition and planning artifact
                        under the repository-local `openspec/changes/add-presentation-skill/` directory."
completion          (substitution a)
```

The prefix reads `change`, not `define-change`, because a sub-workflow context inherits the parent's
`WorkflowName`. No engine enrichment is added, because neither `change-v2.0` nor `define-change` declares
an `engine:`. The default lead profile has no system prompt.

The prompt has exactly two substitutions. Both are recorded in each run's `conversation.json` under
`stepPrompt.substitutions`.

- **(a) Completion instruction.** The Runner's `completionInstruction()` ("…You MUST run the absolute
  path command `<agent-runner> step complete`…") is replaced with:
  > When you or the user determine this step is complete, run `touch <target>/.step-complete` with your
  > shell tool as your final action when the step is done. Run that exact command with no extra arguments
  > as the final action before finishing the current response. Do not merely say that the step is complete.
- **(b) Crosscheck review.** Only the paragraph beginning "Once the proposal draft is complete, use the
  codagent:call-agent skill with a fresh `agent: crosscheck`…" is replaced with:
  > The crosscheck review is skipped in this run: do not use the codagent:call-agent skill or request an
  > adversarial review. Treat the proposal review as having produced no findings.

  The following paragraph ("Follow codagent:call-agent's verification and user-facing reporting
  rules…") is kept verbatim, as instructed. It becomes vacuous, and no lead was confused by it.

## Run outputs

Each `runs/<cli>-<UTC ts>/` directory contains:

| File | Content |
|---|---|
| `conversation.json` | Run metadata and the spec-shaped exchanges: `step`, `attempt`, `turn`, `agentMessage`, `reply`, `replyType`, `replySource`, `simulatedApproval`. |
| `turns.json` | Detailed per-turn records: the lead's invocation (prompt redacted), session id, duration, exit code, final message, all agent messages, the analysis (ends in a question, invites a reply, headless-signal matches with context), tool uses, skills invoked, permission denials, files in the change directory, and the marker. Also the simulated user's reply, type, duration, tool check, and leak-word flags. |
| `turns/NN-lead.stdout.jsonl`, `turns/NN-lead.stderr.txt` | Raw lead output for each turn. |
| `turns/NN-simuser.stdout.jsonl`, `turns/NN-simuser.stderr.txt` | Raw simulated-user output (turns 2 and later). |
| `summary.json` | Stop reason, turn counts, reply types, turns waiting for input, headless signals, skills, denials, durations, costs, `proposalExists`, `markerCreated`, `openspecValidate`, and the target's git status. |
| `step-prompt.txt` | The exact lead step prompt. |
| `artifacts/proposal.md` | A copy of the lead's proposal. |
| `codex-plugin-list.txt` | Codex runs only: the private home's plugin list. |

## Findings

Four runs were made, two attempts per CLI, and every run directory was kept. Every run ended with
`stopReason: marker-created`: the proposal was written, the marker was created, and validation failed
only for "no deltas", as expected.

| Run | Setup | Turns | Wall | Reply types | Notes |
|---|---|---|---|---|---|
| `claude-20261004T022704Z` | host Claude setup, policy poc-1, last message only | 4 | 120 s | answer ×2, approval | Contaminated: the lead found the user's installed `and-scene` plugin. |
| `claude-20261004T023042Z` | clean, poc-2 | 4 | 102 s | answer ×2, approval | Lead $0.93, simulated user $0.26. |
| `codex-20261004T023044Z` | private home, poc-2, last message only | 3 | 160 s | answer, approval | The question was in a middle message, so the responder missed it. |
| `codex-20261004T023437Z` | private home, poc-2, whole turn | 4 | 206 s | answer ×2, approval | |

### The headless branch was never taken

In all 15 lead turns, no lead said or implied that it was headless, unattended, or without a user. None
reported an unresolved decision in place of asking, and none invented an answer. The headless-signal
grep has two hits in run 1, both "headless Chromium" in the proposal content. The pattern now excludes
that phrase. Every non-final turn ended by asking and stopping; every final turn wrote the proposal and
ran the marker `touch`.

The step prompt's interactive framing apparently outweighs `-p`/`exec`: "Help the user write…",
"first ask what the change is about and do not guess", "Keep this phase interactive…". So does the
absence of the Runner's autonomy preamble.

Each lead invoked the skills, then asked in plain text and waited:

- **Claude, turn 1 (clean).** It invoked `codagent:propose` and `codagent:ask-questions`, explored the
  repo, then asked four numbered questions: "**What is the "presentation skill"?** … **What should it
  produce, and from what?** …" and stopped.
- **Claude, turn 2.** "## Decisions I need from you 1. **Tech stack.** I recommend **TypeScript + React
  + Vite, rendering SVG** … Go with React?"
- **Claude, turn 3.** "Here's the full proposal draft for your approval." It wrote only after the
  simulated "Looks good, approved."
- **Codex, turn 2.** It read `propose/SKILL.md` and `ask-questions/SKILL.md` from the plugin cache,
  then asked bounded-option questions: "What technology should generated presentations target? I
  recommend a small React + TypeScript browser app… - React + TypeScript with SVG scenes - Standalone
  HTML, CSS, and JavaScript - Follow each project's existing stack".
- **Codex, turn 3.** "Approve writing the proposal to `openspec/changes/add-presentation-skill/proposal.md`
  with this scope: … - Approve and write this proposal - Revise the scope before writing", ending with
  "Approval is pending in the question above."

### Surprises and the fixes they forced

1. **Host-setup contamination (Claude run 1).** The user's Claude has the `and-scene` plugin installed,
   and that plugin is the hidden reference's own product. The lead noticed `and-scene:presentation` in
   its skill list, used Glob and Read on `~/.claude/plugins/marketplaces/and-scene/…/SKILL.md` (Bash was
   denied, but Read was not), and built the proposal around "port the existing skill". This led to
   `--claude-lead-setup clean`, which is now the default. An eval must never run the lead with the
   operator's plugins.
2. **Codex spreads a turn over several messages.** Codex emits several `agent_message` items per turn.
   It puts the question in a middle message, formatted like its request-user-input fallback (a question
   plus "- option" lines), and then ends on a status line ("I'll use your description to evaluate…",
   "Approval is pending…"). With last-message-only input, the simulated user never saw the scope it was
   approving (codex run 1, turn 2). This led to `--responder-input turn`, now the default: the responder
   gets every agent message of the turn. The Runner's `CodexAdapter.FilterOutput` (`extractCodexAgentMessages`)
   already joins them; use that, not "last message". For Claude, `result.result` is only the last text
   block. That happened to contain the questions in every Claude turn, but an integration should use all
   assistant text since the last user message.
3. **Simulated-user over-disclosure (policy poc-1).** Asked to pick option (a), the simulated user added
   `npm run verify`, "against a production preview", and screenshots that are advisory rather than gates.
   Policy poc-2 cut this down: "1. (a)…", "One scene with a browsable step index." It still adds one
   corrective sentence when an option is only partly right ("not necessarily SVG… use Motion"). The
   planned disclosure audit is needed.
4. **The reference is reachable from the target.** The mandated target location is a sibling of
   `fixture-scrub/` and of earlier runs' targets. Codex ran `find .. -name AGENTS.md` and listed
   `../fixture-scrub/AGENTS.md`; it did not read it. Claude's clean deny rules cover the built-in tools
   only: `Bash(cat:*)` / `Bash(find:*)` could still reach the reference. Codex's `workspace-write`
   sandbox limits writes, not reads.
5. **Codex web search with networking off.** Codex used `web_search` (Vite, Playwright, Motion docs)
   even with `network_access:false`; the search tool is model-side. Claude's WebSearch and WebFetch were
   not in the clean lead's allowlist, so `-p` would have denied them.
6. **Minor.** The Claude lead's sessions persist under `~/.claude/projects/<target path>/`, which is
   needed for `--resume`. Codex sessions stay in the private home.

## Gaps versus a real Agent Runner integration

- **Completion signal.** The PoC polls a marker file after each turn. The Runner uses
  `agent-runner step complete` over its control channel. For headless contexts,
  `completionExecutableForContext` returns `""` and `validateCompletionIntegration` rejects any
  completion command. The new headless-interactive context needs a completion command, plus a check
  after each turn.
- **Do not prepend the autonomy preamble.** `buildAdapterInput` adds "You are running autonomously with
  no human in the loop. Do not stop to ask…" whenever `IsAutonomous()` is true. A headless-interactive
  context must not get it, or it would trigger exactly the headless branch the PoC shows is otherwise
  avoided. It should still get `--disallowedTools AskUserQuestion`.
- **No `call_agent`.** The crosscheck review was substituted away. A real run needs the Runner's
  `call_agent` MCP integration (`--plugin-dir` / Codex private home) available across resumed headless
  turns. Review-finding decisions by the simulated user were therefore not exercised.
- **Only one step was run.** Step transitions on the same session (proposal → specs → … over
  `lead-agent`) were not exercised. For resumed sessions, the Runner puts the new step's instructions
  and the `Continuing to step…` prefix in the user message, because the system-prompt snapshot only
  holds the first step's prompt.
- **Prompt shape for Codex.** The PoC used the `<system>` wrapper plus a start line. The Runner's
  current interactive Codex path sends the bare full prompt. Either works; pick one deliberately.
- **Isolation.** A real eval needs the lead in the Agent Runner sandbox container, with no operator
  plugins, the hidden reference nowhere on its filesystem, and no earlier runs' targets nearby. Read
  denies are not a boundary. Decide explicitly whether Codex `web_search` is allowed.
- **Responder turn payload.** Use all agent text since the last user turn (see surprise 2). A turn that
  asks nothing gets "continue as you think best" (policy) and is counted as approval.
- **Robustness not exercised.** The following are coded but were not triggered:
  - timeouts and the turn cap;
  - lead failure on resume;
  - simulated-user retry and JSON-from-text fallback;
  - quota and 429 handling.

  The real loop also needs durable per-turn state so an interrupted step can resume mid-conversation.
- **The heuristics are only heuristics.** The "waits for input" and "headless signal" detection is regex
  on text. It was cross-checked by reading every message, and it should not gate anything.

## Verdict

**Viable for both Claude and Codex.** With the step prompt delivered once (Claude's system-prompt
snapshot, or Codex's first message) and continued through `--resume` / `exec resume`, both leads:

- used the codagent skills;
- asked material questions in plain text and stopped;
- presented an approval gate and wrote only after a (simulated) approval;
- signalled completion with the substituted shell command.

They did this in 3–4 turns and about 2–3.5 minutes. The work for the Runner integration is a
completion channel for headless-interactive turns, no autonomy preamble, whole-turn responder input,
and real isolation for the lead.
