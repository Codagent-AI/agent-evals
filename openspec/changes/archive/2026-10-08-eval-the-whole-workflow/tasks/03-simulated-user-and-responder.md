# Task: Build the simulated user, its pinned policies, and the host-side responder loop

## Goal

Build the eval-owned simulated user that plays the human in Agent Runner's interactive define workflow, and the host-side responder loop that answers the Runner's external-user requests with it:
- the pinned, versioned disclosure and decision policy;
- a tool-less, stateless `claude -p` invocation that carries the hidden reference;
- the write-ahead conversation record;
- reply replay on resume;
- abort handling;
- a scripted policy-test diagnostic.

The eval measures requirement discovery: a requirement the lead never asks about must not be volunteered. So the simulated user's knowledge boundary and its disclosure discipline are what make the scores mean something.

## Background

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Process layout", "Responder loop and simulated user", "Elapsed-time limit and stopping", and Decisions 4 and 5;
- `openspec/changes/eval-the-whole-workflow/poc/README.md` and `poc/headless-turns-poc.mjs`, the proven simulated-user invocation and whole-turn relay. The recorded runs in `poc/runs/claude-20261004T023042Z/`, `poc/runs/codex-20261004T023044Z/`, and `poc/runs/codex-20261004T023437Z/` include `turns/*-simuser.stdout.jsonl` outputs usable as stub replays. Do not use `poc/runs/claude-20261004T022704Z/`; that run was contaminated by the host's plugin;
- `/Users/paul/codagent/agent-runner/worktrees/external-user-mode/docs/external-user-mode.md`, the exchange contract. Requests are `<step-key>-<attempt>-<turn>.request.json`, containing `schema_version`, `run_id`, `step`, `step_id`, `attempt`, `turn`, `cli`, `session_id`, `agent_message`, and `empty_turn`. A reply is `{"schema_version": 1, "text": "..."}` or `{"schema_version": 1, "action": "abort", "reason": "..."}`, written to a temporary file in the same directory and renamed to `<stem>.reply.json`, mode 0644. A pre-existing reply for a new request fails the step;
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-001` and `INT-002`.

Suite: `evals/agent-runner/and-scene-define/`. It already holds, or will hold:
- `hidden/reference/`: the fixture change's proposal, specs, design, and test plan, with `hidden/reference.json`;
- `hidden/starting-prompt.md`: the pinned starting prompt;
- `hidden/inventory.json`.

If they are not present yet, the reference documents are `openspec/changes/create-and-scene/{proposal.md,specs/**/spec.md,design.md,test-plan.md}` at commit `ad667a965a0e1ea0b028c36c04d57bf0411d30d9` of `https://github.com/Codagent-AI/and-scene.git`, and the starting prompt is `openspec/changes/eval-the-whole-workflow/inventory/starting-prompt.md`. Read paths through a single module so that their final locations are a one-line change.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development.
- Tests in `test/*.test.mjs` run through `npm run check`; add `node --check` entries for new modules to `package.json`.
- Do not modify the `and-scene` suite. You may copy and adapt its code. `evals/agent-runner/and-scene/lib/subprocess.mjs` and `lib/claude-quota.mjs` show subprocess and capacity handling.

### Design decisions to implement

- **Policy file:** `hidden/simulated-user-policy.md`, versioned, holding both the disclosure policy and the decision policy below, and the reply-type rules. Record its version and content hash in the suite's `versions.json`. If `versions.json` does not exist yet, create it with a policy entry and a test that fails when content changes without a version bump.
- **Pinned profile:** the simulated user is `claude` with model `claude-opus-5-5`, pinned in the suite and not overridable per run.
- **Invocation** (one stateless call per reply, in an empty scratch directory, with the host's Claude auth):

  ```sh
  claude -p --model claude-opus-5-5 --tools '' --setting-sources '' --strict-mcp-config \
    --disable-slash-commands --no-session-persistence \
    --system-prompt "<policy vN + reference proposal, specs, design, test plan>" \
    --json-schema '<{reply_type, text}>' --output-format stream-json --verbose \
    -- "<whole conversation so far + this request's agent_message>"
  ```

  - The system prompt carries the reference's proposal, specs, design, and test plan. It never carries tasks, inventory classes, or the rubric. Only its SHA-256 is recorded for the result.
  - Whole-run memory comes from replaying the whole conversation every time.
  - Verify that the stream's `init` tool list and every `tool_use` contain only the synthetic `StructuredOutput` tool.
  - The `--json-schema` is strict-mode valid: every object sets `additionalProperties: false` and lists all its properties in `required`. `reply_type` is one of `answer`, `approval`, `decision`, `decline`, or `clarification`.
  - Retries:
    - malformed output, a tool-check failure, or a CLI error is retried up to 3 times; then the loop writes an abort reply and reports `evaluation-harness-failed`;
    - an `invalid_json_schema` response is a non-retryable harness failure;
    - a model-capacity or rate-limit response does not use up a retry; back off and retry, bounded only by the elapsed-time limit.
  - Every call, including a rejected one, appends a usage record to `<run>/phases/eval-owned-usage.jsonl`. A rejected call writes a zero-token record.
- **Responder loop** (`lib/responder.mjs`): it polls an exchange directory every 250 ms. For each `*.request.json`:
  1. Parse it, and check `run_id` against the recorded Agent Runner run ID. If none is recorded, record the first request's ID. A mismatch fails as `evaluation-harness-failed`. Identity comes from the JSON `step`, `step_id`, `attempt`, and `turn` fields, never from the file name.
  2. If `<run>/conversation.jsonl` already has a reply for that identity, write the recorded reply again, with no model call.
  3. The run's first request is answered with the pinned starting prompt, verbatim, with reply type `answer` and no model call.
  4. Otherwise, call the simulated user.
  5. Append the exchange to `conversation.jsonl` and fsync it **before** writing the reply file. The exchange carries identity, `agent_message`, reply text, reply type, `simulated_approval` (true for approvals), and usage. Then write the reply atomically (temporary file plus rename, mode 0644).
- **Elapsed-time interaction:** the loop accepts a deadline from its caller. When the deadline passes while a request is pending, it writes `{"schema_version": 1, "action": "abort", "reason": "elapsed-time limit"}` and reports the limit. Terminating a sandbox that is mid-turn is the caller's job. The external-user timeout is not used.
- **Interface:** the loop takes the run directory, the exchange directory path, a deadline, and an injectable invoker. It does not know how the sandbox is provided, and relies only on atomic file appearance and polling.
- **Policy-test diagnostic:** a maintainer command (`policy-test.mjs`, also reachable as a `run.sh` mode if `run.sh` exists) sends a fixed set of scripted agent turns to the pinned simulated user. Each case is sent 3 times. It covers:
  - a specific question;
  - a broad question;
  - a compound question;
  - an ambiguous question;
  - a repeated question;
  - a question the reference does not settle;
  - an approval request;
  - a crosscheck-finding decision, both settled and unsettled by the reference;
  - a request to act.

  It reports, per case, policy compliance and whether the three replies were consistent. Its usage goes to the eval-owned usage ledger of the diagnostic's own output directory. It is never a prerequisite or gate for a candidate run.

## Spec

### Requirement: Knowledge boundary
The simulated user SHALL be the only evaluation participant given the hidden reference during the define workflow. Its knowledge SHALL consist of the pinned fixture change's proposal, specifications, design, and test plan, the pinned starting prompt, its disclosure and decision policies, and the run's conversation so far. It SHALL NOT receive the fixture's task files, the rubric, or the hidden-reference inventory classification. It SHALL have no file, shell, network, or other tool access and SHALL answer only from that knowledge.

#### Scenario: Simulated user cannot use tools
- **WHEN** the simulated user produces a reply
- **THEN** no tool invocation is available to or recorded for it

#### Scenario: Inventory classification is withheld
- **WHEN** the simulated user is invoked
- **THEN** its input contains no rubric criterion or inventory classification

### Requirement: Whole-run conversation memory
The simulated user SHALL receive the full conversation of the run across every define step when producing each reply, so its answers remain consistent between steps.

#### Scenario: Earlier answer is reused in a later step
- **WHEN** the agent in the design step asks a question the simulated user answered during the proposal step
- **THEN** the simulated user gives an answer consistent with its earlier answer

### Requirement: Opening reply
The simulated user's first reply in a run SHALL be the pinned starting prompt, verbatim.

#### Scenario: Agent asks what the change is about
- **WHEN** the proposal step's first agent turn asks what to build
- **THEN** the simulated user replies with the pinned starting prompt exactly

### Requirement: Disclosure policy
The simulated user SHALL follow a pinned, versioned disclosure policy:

| Agent turn | Simulated-user reply |
|---|---|
| Specific question | Answers only that question from the hidden reference |
| Broad question (for example "what else should I know?" or "list all requirements") | Restates the goal only at the level of the starting prompt |
| Compound question | Answers each part under these rules |
| Ambiguous question | Asks a brief clarifying question |
| Repeated question | Gives an answer consistent with the earlier one |
| Question the reference does not settle | States no preference and leaves the choice to the agent |
| Offered options | Chooses the option matching the reference, or states the reference's intent when no option matches |

It SHALL NOT volunteer information that was not asked for, critique or review the artifacts, or mention a reference document, a hidden specification, or the evaluation.

#### Scenario: Specific question is answered narrowly
- **WHEN** the agent asks a specific question the hidden reference answers
- **THEN** the reply answers that question and adds no other requirement

#### Scenario: Broad question does not reveal the reference
- **WHEN** the agent asks the simulated user to list all its requirements
- **THEN** the reply restates the goal at the level of the starting prompt and enumerates no requirement beyond it

#### Scenario: Reference is silent
- **WHEN** the agent asks about a choice the hidden reference does not settle
- **THEN** the simulated user states that it has no preference and leaves the choice to the agent

#### Scenario: No offered option matches
- **WHEN** the agent offers options none of which matches the hidden reference
- **THEN** the simulated user states the reference's intent for that decision

#### Scenario: Ambiguous question
- **WHEN** the agent asks a question with more than one plausible reading
- **THEN** the simulated user asks a brief clarifying question instead of choosing a reading

### Requirement: Decision policy
The simulated user SHALL follow a pinned, versioned decision policy. It SHALL approve every request to approve an artifact or proceed, and each approval SHALL be recorded as simulated. For a decision about a crosscheck finding, it SHALL decide according to the hidden reference where the reference applies and otherwise accept the agent's recommendation. For a request to run, test, inspect, or otherwise act on something, it SHALL decline and tell the agent to proceed as it thinks best.

#### Scenario: Approval is requested
- **WHEN** the agent asks the simulated user to approve a drafted artifact
- **THEN** the simulated user approves and the exchange is recorded as a simulated approval

#### Scenario: Crosscheck finding the reference settles
- **WHEN** the agent asks whether to apply a review finding that conflicts with the hidden reference
- **THEN** the simulated user declines that finding

#### Scenario: Crosscheck finding the reference does not settle
- **WHEN** the agent asks whether to apply a review finding the hidden reference does not address
- **THEN** the simulated user accepts the agent's recommendation

#### Scenario: Agent asks the user to act
- **WHEN** the agent asks the simulated user to run a command or inspect a file
- **THEN** the simulated user declines and tells the agent to proceed as it thinks best

### Requirement: Conversation evidence
Every exchange SHALL be recorded in the run's simulated-user conversation with its define step, attempt, and turn identity, the agent's message, the reply, and the reply type (`answer`, `approval`, `decision`, `decline`, or `clarification`). The conversation SHALL be retained with the run and SHALL be the input to the disclosure audit and the discovery diagnostic.

#### Scenario: Exchange is recorded
- **WHEN** the simulated user replies to an agent turn
- **THEN** the conversation records the step, attempt, turn, agent message, reply, and reply type

### Requirement: Simulated-user policy tests
The suite SHALL provide a maintainer diagnostic that sends a fixed set of scripted agent turns to the pinned simulated user, covering at least a specific question, a broad question, a compound question, an ambiguous question, a repeated question, a question the reference does not settle, an approval request, a crosscheck-finding decision, and a request to act, and SHALL report for each whether the reply met the policy. The diagnostic SHALL NOT be a prerequisite or runtime gate for a candidate run.

#### Scenario: Policy test reports a violation
- **WHEN** the scripted broad question receives a reply that enumerates requirements beyond the starting prompt
- **THEN** the diagnostic reports that case as a policy violation

#### Scenario: Candidate run does not require policy tests
- **WHEN** a candidate run starts without a recent policy-test result
- **THEN** the run proceeds normally

### Requirement: Define workflow execution
The harness SHALL run Agent Runner's `openspec:change` workflow with `--until define` and a pinned change name, with every interactive turn delivered to the simulated user through Agent Runner's external-user mode. Before starting, it SHALL verify that the workflow declares the top-level `create` and `define` steps and that the define sub-workflow declares the `proposal`, `specs`, `design`, `test-plan`, and `approach-review` steps; a missing step SHALL fail the run before Agent Runner starts. After execution, the harness SHALL record each define step's outcome.

#### Scenario: Workflow contract is incomplete
- **WHEN** the define sub-workflow lacks any of the required steps
- **THEN** the harness fails before starting Agent Runner and identifies the missing step

#### Scenario: Interactive turns reach the simulated user
- **WHEN** an interactive define step ends an agent turn without requesting step completion
- **THEN** the turn is answered by the simulated user and no terminal input is required

This task delivers the responder side of "Interactive turns reach the simulated user": every request in the exchange directory is answered with no terminal input. Verifying the workflow contract and running Agent Runner belong to the sandboxed run controller.

### Requirement: Elapsed-time limit
The workflow phase SHALL be bounded by a single configurable whole-run elapsed-time limit with a pinned default. Reaching the limit SHALL stop the workflow and produce `evaluation_status=definition-workflow-failed`, identifying the last active define step and recording the limit that applied.

#### Scenario: Agent never completes a step
- **WHEN** the define workflow is still running when the elapsed-time limit is reached
- **THEN** the harness stops the workflow and reports `definition-workflow-failed`
- **AND** the result names the last active step and the applied limit

This task delivers the abort reply when the deadline passes while a request is pending, and reports that the limit was reached. Starting the clock, terminating a sandbox that is mid-turn, and producing the final `definition-workflow-failed` result belong to the run controller.

## Test Plan

- `INT-001` (Responder loop over a real exchange directory): `test/and-scene-define-responder.test.mjs`, in `npm run check`.
  - Setup:
    - A scripted fake Runner process publishes requests the way Agent Runner does (temp file plus rename, 0644) into a real temporary exchange directory.
    - A stub `claude` on `PATH` replays recorded stream-json, including malformed and capacity-error responses.
    - Request bodies come from the proof-of-concept runs.
  - Action: run the loop through several requests, restart it mid-run, and let the deadline expire with a request pending.
  - Assert:
    - `conversation.jsonl` is fsynced before the reply file appears;
    - the first reply is the pinned starting prompt with no model call;
    - after the restart, already-answered requests get the recorded reply with no new call;
    - a `run_id` mismatch reports `evaluation-harness-failed`;
    - an expired deadline with a pending request writes the abort reply;
    - three malformed replies lead to an abort and `evaluation-harness-failed`;
    - a capacity error does not use up a retry.
- `INT-002` (Eval-owned CLI invocation contracts), simulated-user portion: `test/and-scene-define-invokers.test.mjs`, in `npm run check`.
  - The stub `claude` records its argv and environment.
  - Assert:
    - the simulated user receives `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, and `--no-session-persistence`;
    - the system prompt contains the reference documents and no inventory class, intent label, rubric, or task file;
    - a recorded output with a stray `tool_use` is rejected by the tool check;
    - the `--json-schema` sent is strict-mode valid, checked by a schema-walking assertion you can reuse for every later schema;
    - an `invalid_json_schema` error fails without retrying.
  - The judge half of `INT-002` is outside this task. Structure the test file so that judge cases can be added.
- Unit tests for the policy-test diagnostic's case set and its report format, using a stub invoker.

## Done When

- `hidden/simulated-user-policy.md` exists, is versioned, and is recorded in `versions.json`.
- The simulated-user invoker and the responder loop exist under `evals/agent-runner/and-scene-define/lib/` with the behavior above.
- The policy-test diagnostic runs against a stub, and against the real pinned model when invoked manually. It is never required by a candidate run.
- `INT-001` and the simulated-user portion of `INT-002` pass.
- `npm run check` passes, with the new modules added to it.
