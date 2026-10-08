# Task: Reconcile the conversation and audit every evaluated tool call for contamination

## Goal

After the define workflow and artifact collection, establish that a run's evidence is trustworthy and uncontaminated before anything is scored. This task adds three things.

- **Retained evidence.** Copy the Agent Runner files and the native transcript of every evaluated invocation out of runtime state into the run's `evidence/` directory. Record them in a hashed `evidence-manifest.json`.
- **Conversation reconciliation.** Check the host's simulated-user conversation against Agent Runner's exchange record and against the lead's native transcript.
- **Deterministic contamination audit.** Match every lead and crosscheck tool call's input and output against the pinned contamination patterns. Any match makes the run `contaminated` and stops it before gates, judging, and publication.

The sandbox is networked and the hidden reference is public, so contamination can only be detected, not prevented. The exchange directory and runtime state are writable by the evaluated agent. These checks are what make a score credible.

## Background

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Conversation reconciliation", "Contamination audit and evidence", "Retained evidence and rescore" (manifest part), "Run directory", and Decisions 2 and 9;
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-004`;
- `/Users/paul/codagent/agent-runner/worktrees/external-user-mode/docs/external-user-mode.md`, sections "Resume and evidence":
  - `external-user/exchanges.jsonl` is the Runner's replay record;
  - `run-metrics.json` lists `cli` and `session_id` for every invocation, including `call_agent` children;
  - per-turn output files are named `output/<prefix>.attempt-<a>.turn-<t>.out`.

State of the suite `evals/agent-runner/and-scene-define/`. Use these; if one is missing, stop and report which:
- the run controller and ordered phase list (`controller.mjs`, `lib/phases.mjs`, `lib/checkpoint.mjs`, and `lib/outcomes.mjs`). Phases register in this order:
  1. collection
  2. conversation reconciliation
  3. contamination audit
  4. disclosure audit
  5. gates and judging
  6. ...
- the run directory:
  - `<run>/conversation.jsonl` is the host's write-ahead simulated-user record. It never enters the sandbox. Each exchange carries `step`, `step_id`, `attempt`, `turn`, `agent_message`, `reply`, and `reply_type`.
  - `<run>/sandbox/.runtime/` holds Agent Runner state (`projects/...` with `state.json`, `audit.log`, `run-metrics.json`, `external-user/exchanges.jsonl`, and `output/`) and CLI session state (`~/.claude`, `~/.codex`, and `~/.cursor/chats` contents).
  - `<run>/collected/` holds the collected change directory with hashes.
- `contamination-patterns.json`: a versioned list of case-insensitive literals or anchored regular expressions, each with a `locator` or `canary` kind.

Required behavior:

- **Evidence collection:** build the evaluated-invocation list from `run-metrics.json`, then locate each transcript under `.runtime`:
  - Claude: `projects/**/<session>.jsonl`;
  - Codex: `sessions/**/rollout-*-<thread>.jsonl`;
  - Cursor (allowed only as crosscheck): the Cursor chat store linked from `~/.cursor/chats`.

  For Cursor, determine the chat-store format and how to find a session from Agent Runner's Cursor adapter: see `internal/cli/cursor.go` and `internal/cli/testdata/durability/cursor/` in `/Users/paul/codagent/agent-runner/worktrees/external-user-mode`. Then extract every tool call's input and output from it. If a Cursor invocation's session cannot be located, or carries no complete tool-call record, treat it as a missing or incomplete transcript (`evaluation-harness-failed`), never as a clean audit.

  Then:
  - For Cursor, the chat store is SQLite, and the Runner's adapter also reads `store.db-wal`, so recent tool calls may live only in the WAL. Retain a consistent snapshot that includes the WAL content, for example `store.db` together with its `-wal` (and `-shm`) files, or a checkpointed copy made with the `sqlite3` CLI if it is available on the host. Hash that snapshot in the manifest. Never retain `store.db` alone while a WAL exists.
  - Copy each transcript, plus the Runner's `run-metrics.json`, `state.json`, `audit.log`, `external-user/exchanges.jsonl`, and per-turn output copies, into `<run>/evidence/`.
  - Write `<run>/evidence-manifest.json`, listing every file a rescore needs, with its hash: `collected/` and its hashes, `conversation.jsonl`, the Runner files, every transcript, and the per-turn output copies.
  - A missing transcript ends the run as `evaluation-harness-failed`, naming it. So does a truncated one, meaning a transcript with no final turn record for the last recorded turn.
  - Guard every copied path against symlinks that escape the run directory.
- **Reconciliation:** reads only `evidence/` and `conversation.jsonl`. It is a bidirectional, one-to-one match across all three records:
  - **Host conversation and Runner record.** Each reply in `conversation.jsonl` must have exactly one reply in the Runner's `exchanges.jsonl` with the same `step`, `step_id`, `attempt`, and `turn` and identical text. The Runner record must have no reply without a counterpart in `conversation.jsonl`.
  - **Host conversation and lead transcript.** Match replies to the user turns of the lead's native transcript for that exchange's session, in order. Each reply is consumed by exactly one user turn that contains its text; the Runner may append its completion instruction. One user turn can never satisfy two exchanges, even when two replies have identical text.
    - Exclude user turns that the Runner itself originates: the step's initial prompt and its resume prompts. Identify them from the Runner's audit and exchange records, not by guessing.
    - Any other user turn left unmatched is an extra reply.

  A missing, extra, or differing reply in any record ends the run `evaluation-harness-failed`, naming the exchange and the record.
- **Contamination audit:**
  - Extract every tool call's input and output from each transcript and from the per-turn output copies, including Codex `web_search` events and their results.
  - **Locator** patterns match every call's input and output.
  - **Canary** phrases are narrower:
    - one that occurs in any simulated-user reply in the run's conversation is excluded for that run;
    - the rest are not matched against content the agent writes through a file-writing or editing tool, but are matched against reads, shell commands and their output, and web search and fetch queries and results.
  - Any match makes the run `contaminated`, with `definition_verdict=unavailable`, no score, no later gate, judge, or publication phase, and no override option. Record each match with its session, tool call, pattern, and excerpt.
  - The audit is a pure function of the evidence files, the conversation, and the pattern list. Two runs over identical evidence must produce byte-identical output: stable ordering, and no timestamps in the audit body.
- **Clean-run baseline:** add a recorded clean run in which the simulated user disclosed requirements as a test fixture: transcripts, `run-metrics.json`, `exchanges.jsonl`, and the conversation. A test must show that the pattern list produces no match on it. Sources:
  - the Agent Runner external-user smoke run, if its run directory is still on this Mac, for example under `~/.agent-runner/projects` or the Runner worktree's test artifacts;
  - otherwise, the recorded proof-of-concept runs in `openspec/changes/eval-the-whole-workflow/poc/runs/claude-20261004T023042Z/`, `codex-20261004T023044Z/`, and `codex-20261004T023437Z/` (`turns/*-lead.stdout.jsonl` and `conversation.json`).

  Never use `poc/runs/claude-20261004T022704Z/`. Strip anything personal from fixtures.
- **Residual-risk statement:** provide one constant statement, recorded with every audit outcome, clean or not, for the result and report to carry. It says:
  - the sandbox has network access and the reference is publicly reachable, so contamination is detected by audit rather than prevented;
  - the exchange and audit evidence are agent-writable and are checked by reconciliation rather than protected;
  - the open hardening options are an enforced outbound-network allowlist, a private fixture, and a separate OS user for the Runner;
  - the Runner Docker image is not scanned.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development.
- Tests in `test/*.test.mjs` run through `npm run check`; add `node --check` entries for new modules.
- Do not modify the `and-scene` suite.

## Spec

### Requirement: Contamination audit
After artifact collection, the harness SHALL scan every retained lead and crosscheck tool call, including shell commands, file reads, web fetches, and web searches, matching both the call's input and its output against the contamination patterns. Repository, URL, skill, plugin, and path patterns SHALL match every call's input and output. Because the simulated user legitimately discloses reference content, canary phrases SHALL be narrower: a canary phrase that occurs in any simulated-user reply in the run's conversation SHALL be excluded for that run, and the remaining canary phrases SHALL NOT be matched against content the agent writes through a file-writing or editing tool. The canary check and the audit SHALL be deterministic pattern matching, so the same evidence and pattern list always produce the same outcome. Any match SHALL make the run `contaminated`, with no score and no publication, and the result SHALL list every match with its session, tool call, and matched pattern. There SHALL be no option to override a match.

#### Scenario: Agent fetches the fixture repository
- **WHEN** a web fetch or shell command input names the fixture repository
- **THEN** the run is `contaminated` and the result lists that tool call and pattern

#### Scenario: Tool output carries hidden text
- **WHEN** a web search's query matches no pattern but its output contains a canary phrase
- **THEN** the run is `contaminated` and the result lists that tool call and phrase

#### Scenario: Disclosed phrase is written into an artifact
- **WHEN** the simulated user's reply contains a canary phrase and the agent writes that phrase into a specification
- **THEN** that phrase is not a contamination match for the run

#### Scenario: Undisclosed phrase arrives through a read
- **WHEN** a canary phrase that no simulated-user reply contained appears in a file the agent read or a web result it received
- **THEN** the run is `contaminated` and the result lists that tool call and phrase

#### Scenario: Transport is read through a relative path
- **WHEN** a shell command reads a reply file through a relative path such as `../../exchange/<file>.reply.json`
- **THEN** the run is `contaminated` and the result lists that tool call and pattern

#### Scenario: Rescore reproduces the audit
- **WHEN** a run is rescored from its collected evidence with the same pattern list
- **THEN** the contamination outcome and matches are identical to the original

### Requirement: Complete audit evidence
The contamination audit SHALL require a complete retained session transcript for every evaluated invocation. When any evaluated invocation's transcript is missing or incomplete, the run SHALL end with `evaluation_status=evaluation-harness-failed` and SHALL NOT be reported `complete`.

#### Scenario: Crosscheck transcript is missing
- **WHEN** the transcript for one crosscheck invocation is missing
- **THEN** the run ends `evaluation-harness-failed` and identifies the missing transcript

### Requirement: Conversation reconciliation
The exchange directory and Agent Runner's runtime state are writable by the evaluated agent, so the harness SHALL treat them as untrusted. After the define workflow and before scoring, the harness SHALL reconcile every reply in its own simulated-user conversation with Agent Runner's exchange record and with the user turns in the lead's retained session transcript. A reply that is missing from either record, an extra reply in either record, or a reply whose text differs SHALL end the run with `evaluation_status=evaluation-harness-failed` and SHALL identify the exchange and the record that differs.

#### Scenario: Reply altered inside the sandbox
- **WHEN** the reply text in Agent Runner's exchange record differs from the reply in the harness's conversation for the same exchange
- **THEN** the run ends `evaluation-harness-failed` and identifies the exchange

#### Scenario: Reply never reached the lead
- **WHEN** a reply in the harness's conversation does not appear in any user turn of the lead's session transcript
- **THEN** the run ends `evaluation-harness-failed` and identifies the exchange

### Requirement: Pinned contamination patterns
The suite SHALL pin a versioned list of contamination patterns: the fixture and evaluation repositories' qualified names and URLs, the reference implementation's location, hidden paths, and canary phrases taken from the hidden reference that are distinctive enough not to arise in an independent definition. Patterns SHALL be qualified rather than bare words. Path patterns SHALL match a distinctive fragment of the path, such as the exchange directory with its request or reply file suffix, so that a relative or alternate spelling of the path is also matched. The suite's tests SHALL verify that the list produces no match on the starting environment or on a recorded clean run. The pattern-list version SHALL be part of the series identity.

#### Scenario: Pattern matches the clean baseline
- **WHEN** a pattern matches the starting environment or the recorded clean run
- **THEN** the suite's tests fail and name the pattern and the matched location

This task delivers the recorded-clean-run half of "Pattern matches the clean baseline". The starting-environment half is already covered.

### Requirement: Residual-risk statement
Every result and report SHALL state that the evaluated sandbox has network access and the hidden reference is publicly reachable, so contamination is detected by audit rather than prevented, that the exchange and audit evidence are writable by the evaluated agent and checked by reconciliation rather than protected, and SHALL name an enforced outbound-network allowlist and a private fixture as open hardening options.

#### Scenario: Clean run states the risk
- **WHEN** a run completes with a clean contamination audit
- **THEN** its result and report still include the residual-risk statement

This task produces the statement with every audit outcome. Rendering it in `result.json` and `report.html` belongs to result assembly. If a minimal `result.json` writer already exists, include the statement there.

### Requirement: Ordered lifecycle
A candidate run SHALL execute phases in this order: preflight; starting-environment materialization; define workflow; artifact collection; conversation reconciliation; contamination audit; disclosure audit; gates and judging; discovery diagnostic; metrics ingestion; result and report; publication. A phase SHALL start only after its required predecessor completes. A contaminated run SHALL NOT proceed to gates, judging, or publication.

#### Scenario: Contaminated run is not judged
- **WHEN** the contamination audit invalidates a run
- **THEN** no gate, judge, or publication phase runs for it

#### Scenario: Judging waits for collection
- **WHEN** the define workflow has completed but artifact collection has not
- **THEN** no judge job starts

This task delivers "Contaminated run is not judged": a `contaminated` outcome stops the lifecycle before gates, judging, and publication.

### Requirement: Evaluation status and definition verdict
The result SHALL report `evaluation_status` as exactly one of `complete`, `definition-workflow-failed`, `contaminated`, or `evaluation-harness-failed`, and `definition_verdict` as exactly one of `pass`, `fail`, or `unavailable`. A completed define workflow whose collected artifacts are missing a required artifact or fail `openspec validate` SHALL be `complete` with `definition_verdict=fail` through a hard gate, and any artifacts that exist SHALL still be judged as diagnostics. A contaminated run SHALL have `definition_verdict=unavailable` and no score. Workflow and harness failures SHALL have `definition_verdict=unavailable` and SHALL NOT be reported as a definition failure.

#### Scenario: Definition passes
- **WHEN** gates pass and the score meets the pass threshold
- **THEN** `evaluation_status` is `complete` and `definition_verdict` is `pass`

#### Scenario: Required artifact is missing
- **WHEN** the define workflow completes but the collected change lacks a design
- **THEN** `evaluation_status` is `complete` and `definition_verdict` is `fail` through the required-artifact gate
- **AND** the proposal, specifications, and test plan that exist are still judged and reported as diagnostics

#### Scenario: Run is contaminated
- **WHEN** the contamination audit finds access to hidden material
- **THEN** `evaluation_status` is `contaminated`, `definition_verdict` is `unavailable`, and no score is reported

#### Scenario: Workflow fails
- **WHEN** Agent Runner fails or the elapsed-time limit is reached before define completes
- **THEN** `evaluation_status` is `definition-workflow-failed` and `definition_verdict` is `unavailable`

This task delivers the "Run is contaminated" scenario.

## Test Plan

- `INT-004` (Contamination audit over real transcripts): `test/and-scene-define-contamination.test.mjs`, in `npm run check`.
  - Setup: recorded native Claude and Codex transcripts and a Cursor chat-store fixture, located through a `run-metrics.json` manifest, copied into fixtures, with these planted cases:
    - a fixture-repository URL in a Codex `web_search` result;
    - an undisclosed canary phrase in a file-read output;
    - a disclosed canary phrase that the agent writes into a spec through a write tool;
    - a manifest entry whose transcript is missing;
    - a shell command that reads `../../exchange/<file>.reply.json` through a relative path;
    - a reply whose text in the Runner's `exchanges.jsonl` differs from `conversation.jsonl`;
    - a reply in `conversation.jsonl` that no user turn of the lead transcript contains;
    - a lead user turn that is the reply plus the Runner's appended completion instruction;
    - an extra user turn in the lead transcript with no matching exchange;
    - an extra reply in the Runner's `exchanges.jsonl` with no counterpart in `conversation.jsonl`;
    - two exchanges whose replies have identical text, with only one corresponding user turn in the lead transcript;
    - a Cursor crosscheck invocation, with a representative recorded or synthesized chat-store fixture containing a planted locator match in a tool call;
    - a Cursor chat store whose planted tool call exists only in uncheckpointed WAL content.
  - Action: run the audit twice over identical evidence.
  - Assert:
    - the URL and the undisclosed canary make the run `contaminated`, listing session, tool call, and pattern;
    - the disclosed canary written into the spec is not a match;
    - the missing transcript ends the run `evaluation-harness-failed`;
    - the relative-path read makes the run `contaminated`;
    - the altered reply and the undelivered reply each end the run `evaluation-harness-failed`, naming the exchange and the differing record;
    - the reply with the appended completion instruction reconciles;
    - the extra lead user turn, the extra Runner reply, and the repeated reply text with a single user turn each end the run `evaluation-harness-failed`, naming the exchange and the record;
    - the Cursor tool-call match makes the run `contaminated`, and a Cursor invocation whose session is missing ends the run `evaluation-harness-failed`;
    - the WAL-only Cursor tool call is retained in `evidence/` and found by the audit;
    - both runs produce byte-identical audit output.
- A clean-baseline test: the pattern list produces no match on the recorded clean run.
- A lifecycle test: a `contaminated` outcome registers no gate, judge, or publication phase.

## Done When

- Evidence collection writes `evidence/` and `evidence-manifest.json` with hashes for every file a rescore needs.
- Reconciliation and the contamination audit run as lifecycle phases, in order, after collection, and are checkpointed.
- A `contaminated` run stops before gates, judging, and publication, with `definition_verdict=unavailable` and every match listed.
- Every audit outcome carries the residual-risk statement.
- `INT-004` and the clean-baseline test pass.
- `npm run check` passes, with the new modules added to it.
