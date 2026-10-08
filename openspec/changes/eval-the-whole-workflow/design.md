## Context

This change adds `evals/agent-runner/and-scene-define/`, a suite that runs Agent Runner's interactive define workflow (`openspec:change --until define`) from a short prompt, with an eval-owned simulated user, and scores the produced proposal, specifications, design, and test plan against a hidden reference. The specifications under `specs/` define the behavior; this document fixes the architecture.

Relevant current state:

- **Agent Runner external-user mode** is implemented on the `external-user-mode` branch, in the worktree `/Users/paul/codagent/agent-runner/worktrees/external-user-mode`. Its contract is `docs/external-user-mode.md` and `openspec/changes/archive/2026-10-05-external-user-mode/` there. The mode:
  - runs each interactive step as headless turns on one CLI session;
  - writes `<step-key>-<attempt>-<turn>.request.json` into an exchange directory and waits for the matching `.reply.json`;
  - replays recorded replies on resume;
  - accepts `--resume <run-id> --until <step>`;
  - lists every invocation's `cli` and `session_id` in `run-metrics.json`;
  - keeps per-turn raw output under the run's `output/` directory.

  A smoke run proved it on Claude and Codex leads through `proposal`, including its crosscheck, in a one-commit repository with no remote.
- **The `and-scene` suite** runs its controller and judges inside the sandbox, and mounts its whole suite directory at `/eval-input`. That is acceptable there but not here: this suite's data includes the hidden reference.
- **`and-scene` judging after agent-evals PR #81** (merged as `cd7a3fc`, rubric 12.3.0, protocol `dual-sample-majority-v4`) runs every scored job as two `gpt-6-sol` samples with per-sample closed-world source audits. A blind third sample settles disagreements, and its pass is line-cited and span-audited. Contradictions turn a vote only when a targeted check confirms them. It also has strict schemas, capacity backoff, zero-token rejection records, and protocol-versioned caches. Its judge calls are Codex-only and run inside the `and-scene` sandbox. The peer audit found that residual variance came from undefined terms and from single calls deciding splits.
- **`scripts/sandbox-run.sh`** in Agent Runner:
  - builds the Runner from `/agent-runner-source`, which stays mounted read-only for the container's lifetime;
  - with `--mount-claude-auth`, also mounts the host's `~/.claude/settings.json` and `settings.local.json`.

  The maintainer's Claude settings name `Codagent-AI/and-scene` and enable its plugin. The Runner source contains the archived external-user-mode change, which names this suite and its hidden reference. Both are readable by the evaluated agent today.
- **The proof of concept** in `poc/` (`README.md`, `headless-turns-poc.mjs`, four recorded runs) is the reference for:
  - the simulated-user invocation;
  - whole-turn relay;
  - the clean-setup lessons: the run contaminated by the host's and-scene plugin, and Codex putting its question in a middle message.
- **The hidden reference** is the and-scene fixture's `create-and-scene` change at fixture commit `ad667a9`. The reconciled inventory is `inventory/inventory.json`: 24 mandatory, 48 acceptable-alternative, and 48 preference items.

## Goals / Non-Goals

**Goals:**
- Implement the six capabilities so a maintainer can run a paid candidate run, dry run, resume, rescore, and calibration locally.
- Keep every hidden input on the host. The evaluated sandbox sees only the starting repository, its runtime, and the conversation.
- Give both suites one panel-judging approach and one shared implementation, `evals/lib/panel-judging/`, built from `and-scene`'s post-#81 judging.
- Reuse other proven and-scene mechanics by copying them, without changing `and-scene` beyond its judging.

**Non-Goals:**
- Running on Fly or Agent Factory. Their shared-Machine boundary is out of scope.
- An enforced network allowlist or a private fixture. Both are recorded only as residual risk.
- Cursor leads. The external-user mode supports only Claude and Codex leads.
- Sharing anything with `and-scene` beyond panel judging (persistence, checkpoints, publication, reporting).

## Approach

### Process layout

```
host: run.sh → controller.mjs (Node 22, no third-party dependencies)
  preflight · materialize · canary check · stage sandbox input
  responder loop → simulated user (claude -p, no tools)
  collection · reconciliation · contamination audit · disclosure audit · gates and judges
  discovery · metrics · result and report · publication
      │
      │ <run>/sandbox-input/ → /eval-input (read-only)
      │ <run>/sandbox/       → /artifacts  (read-write)
      ▼
sandbox: Agent Runner sandbox-run.sh --no-default-secrets --auth-only --hide-source
  in-sandbox driver (sandbox-driver.sh)
  → agent-runner run openspec:change --external-user /artifacts/exchange --until define
```

The controller runs `sandbox-run.sh` as a child process and runs the responder loop concurrently. Only the evaluated workflow runs in the sandbox.

### Run directory

The run directory is host-owned. Only `sandbox-input/` and `sandbox/` are mounted.

```
<run>/
  run-state.json, result.json, report.html
  conversation.jsonl          simulated-user exchanges (write-ahead)
  collected/                  collected change directory and hashes
  audits/, judges/, discovery/, logs/
  phases/eval-owned-usage.jsonl
  sandbox-input/              staged by the host, read-only in the sandbox
    starting-repo.bundle
    sandbox-driver.sh, bootstrap-agent-skills.sh, prepare-agent-session-state.sh
    runner-config.yaml, runner-settings.yaml
  sandbox/                    /artifacts inside the sandbox
    exchange/                 the external-user transport only
    workspace/repo/           the evaluated repository
    .runtime/                 Agent Runner state and CLI session state
    logs/
```

The repository and all session state live under `/artifacts`, so a replacement container can resume. Agent Runner state lives in `~/.agent-runner/projects`, and CLI session state in `~/.claude` and `~/.codex`. `prepare-agent-session-state.sh` (copied from and-scene) and an and-scene-style link redirect both into `/artifacts/.runtime`.

### In-sandbox driver

`sandbox-driver.sh` is the only suite code that runs in the sandbox. It:

1. links session state into `/artifacts/.runtime`;
2. writes the Agent Runner config (an `eval` profile with `lead` and `crosscheck` agents from the run's profiles) and settings (`autonomous_permission_mode: yolo`) into the sandbox home;
3. installs Agent Skills from the read-only checkout mount for the selected CLIs (adapted `bootstrap-agent-skills.sh`; the host already checked the required skills);
4. on a fresh run, clones `starting-repo.bundle` into `/artifacts/workspace/repo`, creating `main` and `add-presentation-skill` at the starting commit and checking out `add-presentation-skill` with no remote;
5. runs one of these in that repository:
   - `agent-runner run openspec:change --external-user /artifacts/exchange --until define` with the pinned change name;
   - `agent-runner --resume <run-id> --until define`.

   It writes the exit status to `/artifacts/logs/runner-exit.json`.

The driver contains no pattern, reference text, or suite path.

### Responder loop and simulated user

The controller polls `<run>/sandbox/exchange/` every 250 ms while the sandbox runs. For each request file:

1. It parses the request and checks that `run_id` matches the recorded Agent Runner run. If no run ID is recorded yet, it records the first request's ID. A mismatch fails the run as `evaluation-harness-failed`. Identity comes from the JSON `step`, `step_id`, `attempt`, and `turn` fields, never from the file name.
2. If `conversation.jsonl` already has a reply for that identity (a resumed run), it writes the recorded reply again without a model call.
3. For the run's first request, the reply is the pinned starting prompt, verbatim, with reply type `answer` and no model call.
4. Otherwise it calls the simulated user:

   ```sh
   claude -p --model <pinned> --tools '' --setting-sources '' --strict-mcp-config \
     --disable-slash-commands --no-session-persistence \
     --system-prompt "<policy vN + reference proposal, specs, design, test plan>" \
     --json-schema '<{reply_type, text}>' --output-format stream-json --verbose \
     -- "<whole conversation so far + this request's agent_message>"
   ```

   - The call runs in an empty scratch directory with the host's Claude auth.
   - It is stateless: whole-run memory comes from replaying the conversation every time.
   - The harness verifies that the `init` tool list and every `tool_use` contain only the synthetic `StructuredOutput` tool.
   - Malformed output, a tool check failure, or a CLI error is retried up to 3 times. After that the controller writes an abort reply and the run ends `evaluation-harness-failed`.
   - A model-capacity or rate-limit response does not use up a retry. The call backs off and tries again, bounded only by the elapsed-time limit. This is the same rule as the judges.
5. It appends the exchange to `conversation.jsonl` and fsyncs it **before** writing the reply. The exchange carries identity, agent message, reply, reply type, `simulated_approval`, and usage. The reply is written as a temporary file renamed to `<stem>.reply.json`, mode 0644.

The simulated-user profile is pinned in the suite as `claude-opus-5-5`, along with the policy text and version. The system prompt carries the reference's proposal, specifications, design, and test plan, never tasks, inventory classes, or the rubric. Only its SHA-256 goes into the result. Simulated-user usage goes to `phases/eval-owned-usage.jsonl`.

### Elapsed-time limit and stopping

One whole-run limit, pinned at 3 hours by default and configurable with `--time-limit`, starts when the workflow phase starts.

- **Reached while a request is pending:** the controller writes `{"action": "abort", "reason": "elapsed-time limit"}`.
- **Reached mid-turn:** it terminates the sandbox child, and `docker run` forwards the signal.

Either way the run ends `definition-workflow-failed`, naming the last active step, which comes from the last request or Agent Runner state.

The external-user timeout is not used: the controller owns timing.

### Outcome of the workflow phase

After the sandbox exits, the controller reads Agent Runner `state.json` and `audit.log` from `.runtime`:

- **Capped stop:** `currentStep` is `define` with `completed: true` and the run is not completed. This is success.
- **Interrupted:** an incomplete `define` (or earlier) step with no successful capped stop. This is resumable.
- **Failed:** the step failed or was aborted. The result is `definition-workflow-failed` with the audit error.

Resume never calls `--resume` for a run already stopped after `define`.

### Conversation reconciliation

`exchange/` and `.runtime/` sit under `/artifacts`, which the yolo agent can write. The Runner does not authenticate the writer of a reply file. The controller therefore treats both as untrusted and, after collection, reconciles three records of every reply:
- its own `conversation.jsonl`, which never enters the sandbox;
- Agent Runner's `external-user/exchanges.jsonl`, matched by `step`, `step_id`, `attempt`, and `turn`;
- the user turns of the lead's native session transcript. The Runner sends the reply text as the turn's prompt and may append its completion instruction, so the check is that the user turn contains the reply text.

A missing, extra, or differing reply in any record ends the run `evaluation-harness-failed`, naming the exchange and the record. This does not stop deliberate tampering with all three records, which needs a write boundary inside the container. That would require the Runner to run as a separate user, which is not justified yet. The residual-risk statement names it.

### Collection, gates, and judging

**Collection.** The controller copies `sandbox/workspace/repo/openspec/changes/<change>/` to `collected/`. It records each file's SHA-256 and the repository HEAD. Everything later reads `collected/` only.

**Gates.**
- The four artifacts are present: `proposal.md`, at least one `specs/**/spec.md`, `design.md`, and `test-plan.md`.
- `openspec validate <change> --strict` passes on a scratch copy.

**Judges** run on the host, under one pinned judge profile, through the shared panel-judging module (see "Shared panel judging"):

| Role | Model | Invocation |
|---|---|---|
| Claude-family panel judge | `claude-sonnet-5-5`, high effort | shared Claude invoker, host mode: `claude -p` with `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, and `--json-schema`; the job's inputs are inlined in the prompt |
| two Codex-family panel judges | `gpt-6-luna`, high effort; two independent calls | shared Codex invoker, host mode: `codex exec --sandbox read-only --json --output-schema`; a private `CODEX_HOME` containing only a copy of `auth.json`, deleted afterward; the working directory is a scratch copy of only that job's inputs |
| decider, targeted checks | `claude-opus-5-5`, high effort | as the Claude-family panel judge |

**Scoring jobs** (coverage, fidelity, artifact quality) run on the cross-family panel and settle under the shared rule:
1. All three panel judges run every scoring job independently, with identical inputs.
2. A verdict all three give stands.
3. A verdict two give stands when the two include the Claude-family judge. The exception is a backed dissent: a higher verdict than the majority's (`met` over `partial` or `missing`, or `partial` over `missing`) whose artifact citations pass validation. A backed dissent goes to a targeted check: the decider judges only whether the dissent's stated reason holds against its cited lines and the item's anchors. If it holds, the dissent's verdict stands; otherwise the majority's does.
4. A verdict the two Codex-family judges give against the Claude-family judge, and a three-way split, go to the decider. It sees the item, the job's inputs, and all three verdicts with their citations, labelled only "A", "B", and "C". It must rule one of the three verdicts, with citations that pass validation, or the decider output is retried.
5. **Fidelity:** a contradicted exchange counts as agreed when the judges cite the same exchange. A deduction stands when the Claude-family judge and at least one Codex-family judge cite it. When only the two Codex-family judges cite it, the decider rules. When one judge alone cites it with valid citations, it is a backed dissent and gets a targeted check.
6. Decider calls and targeted checks are batched per job. A job with no split makes neither.

The result records every panel verdict, each item's settlement basis (`consensus`, `majority`, `checked-dissent`, or `decider`), every targeted check, and every ruling.

The **disclosure audit** also runs on the panel, because it changes the score. Each panel judge returns flags per exchange, and each over-disclosure flag names the inventory items disclosed without being asked. Each item's leak settles under the same rule:
- leaked when the Claude-family judge and a Codex-family judge name it;
- decided by the decider when only the two Codex-family judges name it;
- a backed dissent when one judge alone names it with a valid exchange citation.

Leaked items are excluded from coverage (see Rubric). Inconsistent-withholding and contradiction flags are report-only; they settle the same way but change no score.

The **discovery** judge is non-scoring and is a single call to the decider model.

Every judge prompt carries the shared scope rule (`JUDGE_SCOPE_RULE`, adapted to definitions: judge only what the cited artifacts establish, add nothing the item and its anchors do not state, plain reference meaning for undefined terms). For each item it also carries the statement or intent, every source quote with its heading, and the item's anchors.

| Job | Inputs | Output |
|---|---|---|
| coverage × inventory area | collected artifacts; that area's mandatory and acceptable-alternative items (statement, intent, class, anchors, and each source quote with its reference heading) | per-item `met` / `partial` / `missing` with artifact citations |
| fidelity | collected artifacts; preference items; conversation | contradictions of the simulated user's answers about preference items or matters outside the inventory, citing artifact and exchange; added-scope list |
| artifact quality | collected artifacts only | the four quality criteria with citations |
| discovery | conversation; mandatory and acceptable-alternative items | per-item asked yes/no, with a cited exchange when yes |
| disclosure audit | conversation; the reference (as the simulated user saw it); policy; mandatory and acceptable-alternative items | flags citing exchanges; inventory items named per over-disclosure flag |

Each job's output is validated against a JSON schema and citation rules. Every criterion must be present, and each verdict needs the citation its kind requires:
- `met` and `partial` coverage verdicts, quality findings, and fidelity deductions cite a collected file and line range; fidelity deductions also cite an exchange identity;
- a `missing` verdict cites the list of collected files inspected. Where the artifact the item would belong in is absent, it cites the gate's absence record (for example `gate:required-artifact:design`) instead of a line;
- discovery and disclosure flags cite an exchange identity.

Every citation must resolve to a collected file and line range, a collected file name, a gate record, or an exchange identity. A failing output is retried up to 2 times and is never scored. A job that still fails ends the run as `evaluation-harness-failed`.

Every schema sent to a judge (`codex exec --output-schema`) or to the simulated user (`--json-schema`) is strict-mode valid:
- every object sets `additionalProperties: false`;
- every object lists all of its properties in `required`.

A test walks every such schema and asserts these rules. An `invalid_json_schema` response is a non-retryable harness failure.

A model-capacity response backs off without using up an attempt. A rejected call still writes a zero-token usage record, so the eval-owned cost ledger is complete.

Quality and fidelity guidance is pinned in the rubric with concrete pass and fail examples. Two rules keep the judges from rewarding the reference's shape:
- an artifact organized differently from the reference is never marked down for its structure;
- an artifact that records an open question or an unresolved gap never scores below one that silently omits it.

The scorer is deterministic code over the validated verdicts. Discovery outcomes are computed in code from the asked decisions and the coverage verdicts.

### Rubric

`rubric.json` declares:
- its version and the inventory version it applies to;
- components and points: coverage 60, artifact quality 25, fidelity 15 (provisional);
- per-item weights: mandatory 2, acceptable-alternative 1;
- verdict values: `met` 1, `partial` 0.5, `missing` 0. `partial` means the artifacts commit to the item's intent but leave out or weaken part of what the item requires;
- leaked items: an item the disclosure audit marks leaked is dropped from both earned and possible coverage points, and coverage is scaled to its 60 points over the remaining items;
- fidelity deductions, quality criteria, gates, the pass threshold, and the calibration evidence.

Each coverage criterion carries its item's anchors from `inventory.json` (`anchors.met`, `anchors.partial`, `anchors.missing`). They are written in the reference's words where possible, and against the intent for acceptable-alternative items. An agent drafts them from each item's statement, intent, and source quotes. A maintainer reviews them, and the review is recorded in the inventory (`anchors_review`: reviewer, date, and the inventory version reviewed). Preflight refuses a candidate run whose anchors are unreviewed. Adding anchors bumps the inventory version.

Rubric guidance is limited to what the reference states. Each omission is owned by exactly one criterion: a contradicted graded item is a coverage verdict, and fidelity covers only the simulated user's answers that coverage does not grade.

`scripts/build-rubric.mjs` generates the coverage criteria from `inventory.json`, and the generated file is committed. A test fails when they diverge.

`versions.json` records the content hash of every versioned input under its version:
- the rubric;
- the contamination-pattern list;
- the simulated-user policy;
- the inventory;
- the starting prompt.

A test fails when any content changes without a version bump, so two different contents can never claim one version.

Preflight refuses candidate runs while the rubric has no calibrated pass threshold.

### Contamination audit and evidence

After collection, the controller builds the evaluated-invocation list from `run-metrics.json`, which lists `cli` and `session_id` for every lead step and every `call_agent` crosscheck child. It locates each transcript under `.runtime`:
- Claude: `projects/**/<session>.jsonl`;
- Codex: `sessions/**/rollout-*-<thread>.jsonl`.

A missing or truncated transcript ends the run as `evaluation-harness-failed`. A truncated transcript has no final turn record for the last recorded turn. The Runner's per-turn output copies (`output/<prefix>.attempt-<a>.turn-<t>.out`) are a second source and are scanned too.

The scan is deterministic. It extracts every tool call's input and output, including Codex `web_search` events and their results, then matches each against `contamination-patterns.json`. Patterns are case-insensitive literal strings or anchored regular expressions, and the list is versioned. Any match makes the run `contaminated` and records the session, call, pattern, and excerpt.

The pattern list contains:
- `Codagent-AI/and-scene` and `Codagent-AI/agent-evals` with their URLs;
- the and-scene skill name `and-scene:presentation` and its plugin and marketplace paths;
- `and-scene-define` and the suite's hidden data paths;
- transport and runtime fragments, so absolute and relative spellings both match: `exchange/` followed by a `.request.json` or `.reply.json` name, `external-user/exchanges.jsonl`, `/artifacts/.runtime` and `../.runtime`, and `eval-input`. Reading the transport, runtime state, or staged input is out of bounds for the agent;
- canary phrases chosen from the reference.

Locator patterns are everything but the canary phrases: repository names, URLs, skill and plugin names, and paths. They match every tool call's input and output.

Canary phrases are narrower, because the simulated user legitimately discloses reference content and the agent then writes it into artifacts:
- a canary phrase that occurs in any simulated-user reply in the run's conversation is excluded for that run;
- the remaining canary phrases are not matched against the content an agent writes with a file-writing or editing tool. They still match reads, shell commands and their output, and web search and fetch queries and results.

Both rules depend only on the retained transcripts and conversation, so the audit stays deterministic and a rescore reproduces it.

A test checks the list against the starting snapshot and against a recorded clean run in which the simulated user disclosed requirements.

### Canary check

The canary check is host-side and runs before the sandbox starts. The pattern list never enters the sandbox. It scans every file that will be readable inside the sandbox:
- `sandbox-input/`, including the starting-repository tree;
- the Agent Skills checkout's tracked files at the pinned commit;
- the credential files forwarded with `--auth-only`.

The Runner's binary is built from source that the sandbox no longer exposes. The Runner Docker image is not scanned: it is built from the Runner's Dockerfile with generic tooling, and the report says so.

### Agent Runner sandbox changes

These are made in the `external-user-mode` worktree during implementation, with that repository's tests. They are product infrastructure, so they belong there per this repository's rules.

- **`--auth-only`:** with `--mount-claude-auth`, mount only `.credentials.json`, not `settings.json` or `settings.local.json`. Codex and Cursor already mount only their auth files.
- **`--hide-source`:**
  1. build the Runner in a first container, writing the binary to a host temporary directory;
  2. run the command in a second container that mounts that binary and not `/agent-runner-source`;
  3. drop `/tmp/agent-runner-local`.

  Workflows are embedded in the binary, so nothing else from the source is needed. `--dev-audit` is not used by this suite.

Both are opt-in, so existing callers keep today's behavior.

### Starting repository

`starting-repo/` in the suite holds:
- the allowlisted file tree, built from the fixture's pre-change scaffold by `scripts/build-starting-snapshot.mjs` from the pinned fixture commit and an explicit allowlist, with neutral rewrites;
- `manifest.json`, with the allowlist, rewrites, per-file hashes, and the tree hash.

The tree includes a minimal neutral `.validator/config.yml` with `base_branch: main`. Without that line, `agent-validator detect` diffs against `origin/main` and the `create` step fails. A maintainer reviews the tree before it is pinned.

Materialization is deterministic:
- `git init`, add the tree, and commit once with a fixed author, committer, and date;
- create `main` and `add-presentation-skill` at that commit, with no remote;
- verify the tree hash;
- `git bundle create --all`.

The change name is pinned as `add-presentation-skill`.

### Hidden data in the suite

`hidden/` in the suite holds:
- `reference/`: the fixture change's proposal, specifications, design, and test plan, copied from the pinned fixture commit with SHA-256 hashes. The copy is refreshed by `scripts/refresh-reference.mjs`.
- `inventory.json` and its labelling inputs, moved from this change's `inventory/` directory.
- `simulated-user-policy.md` (versioned).

`calibration/` holds the calibration inputs with expected per-item verdicts. None of these paths is ever staged into `sandbox-input/`; a test enforces it.

### Profiles, preflight, and identity

`run.sh` requires `--lead-cli/model/effort` and `--crosscheck-cli/model/effort`.
- The lead CLI must be `claude` or `codex`.
- The crosscheck CLI may be `claude`, `codex`, or `cursor`.
- Credentials are mounted only for the selected evaluated CLIs.

Preflight runs before any model call:
- Agent Runner checkout:
  - it is clean, with commit recorded;
  - its `agent-runner --help` (from a host build, or the sandbox dry run) lists `--external-user`;
  - `openspec:change` declares `create` and `define`;
  - `core:define-change` declares `proposal`, `specs`, `design`, `test-plan`, and `approach-review`. These are read from the Runner checkout on the host.
- Agent Skills checkout: clean, with every required `codagent:*` skill present.
- Docker is available.
- Auth for the evaluated CLIs, for host `claude` (simulated user), and for host `codex` (judges).
- Every pinned hash matches.
- The rubric's inventory version matches the pinned inventory, and the rubric has a threshold.
- The mount set is exactly `sandbox-input/`, `sandbox/`, the Agent Skills checkout, and auth files, checked from the dry-run docker command.
- The canary check passes.

The series identity contains only evaluator and fixture inputs:
- the starting prompt and starting tree;
- the reference and inventory versions;
- the rubric and contamination-pattern versions;
- the simulated-user profile and policy versions;
- the judge profile, including the shared panel-judging protocol version.

The candidate record holds what a comparison varies:
- the lead and crosscheck profiles;
- the Agent Runner commit and the `openspec:change` and `core:define-change` workflow file hashes;
- the Agent Skills commit.

Reports pair runs only within one series identity, and list each candidate component that differs. Resume requires the same series identity and candidate.

### Retained evidence and rescore

`evidence-manifest.json` in the run directory lists the files a rescore needs:
- `collected/` and its hashes;
- `conversation.jsonl`;
- Agent Runner's `run-metrics.json`, `state.json`, and `audit.log`;
- the native transcript of every evaluated invocation;
- the per-turn output copies.

The manifest records each file's hash. Collection copies the transcripts and Runner files out of `sandbox/.runtime/` into `evidence/`, so nothing a rescore needs lives only in runtime state.

`--rescore-from` reads only the manifest's files. It verifies their hashes and runs entirely on the host, with no Docker.

Rescore applies the suite's **current** evaluator inputs: rubric, inventory, patterns, policies, and judge profile. That is its purpose, the same as in and-scene. Its result records the current series identity as its own, and the original run's series identity and candidate alongside. To reproduce an original score exactly, run the rescore from the suite commit that pinned the original versions; `versions.json` makes those versions checkable. With the same pattern version, the rerun contamination audit reproduces the original outcome. Any future slimming of run directories, for example by the factory, must keep the manifest's files.

### Controller-to-sandbox interface

`lib/sandbox.mjs` is the only module that knows how the evaluated environment is provided. It exposes:
- `stage(inputDir)`;
- `start(profiles, mode)`;
- `wait()`;
- `stop()`;
- an exchange directory handle;
- `retrieve(paths)`, which brings files back into the host run directory.

Locally it wraps `sandbox-run.sh` with bind mounts. The controller relies only on the staged input, the work directory, and the exchange contract (atomic file appearance, polling), never on shared-filesystem semantics beyond that. A later Fly or end-to-end variant can then sync the exchange and work directories without changing the controller.

### Shared panel judging

`evals/lib/panel-judging/` holds the judging both suites use. It is extracted from `and-scene`'s post-#81 `lib/judge-jobs.mjs` and `lib/judge-invoker.mjs`. Suites own their criteria, anchors or definitions, prompts, verdict scale, evidence views, and job lists. The module owns how verdicts are produced, checked, and settled:
- `text.mjs`: `bounded` and `normalizeEvidence` (moved from `and-scene`'s `browser-eval.mjs`, which re-exports them);
- `hash.mjs`: canonical `hashJson` and `hashString` (moved from `and-scene`'s `persistence.mjs`, which re-exports them);
- `codex-invoker.mjs`: the Codex judge invoker (moved from `and-scene`'s `judge-invoker.mjs`, which re-exports it), with an option for a private `CODEX_HOME` in host mode;
- `claude-invoker.mjs`: a Claude judge invoker with two modes:
  - host mode, with no tools and inputs inlined;
  - in-sandbox mode, with read-only `Read`, `Grep`, and `Glob` only, a working directory at the job's read-only root, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, and `--json-schema`.

  Both modes check that only allowed tools were used and record usage like the Codex invoker. They back off on capacity rejections without spending an attempt, record zero-token rejection records, and fail fast on schema rejection. They use the suite's Claude-quota wait for an identified subscription limit with a reset within six hours;
- `protocol.mjs`: the post-#81 mechanics:
  - strict schemas;
  - output parsing with missing-criterion retries;
  - citation and line-span validation;
  - closed-world audits, targeted contradiction checks, and re-cites;
  - the scope rule;
  - cache reproduction checks;
- `panel.mjs`: `runPanelJob({ job, criteria, verdicts, order, panel: [{ family, model, effort, invoke }], decider, buildPrompt, schema, validateCitations, audit, cache })`. It runs the panel concurrently, applies each suite's optional per-judge audit, and settles every criterion under the cross-family rule. It returns per-criterion results with `votes`, `basis`, `checks`, `ruling`, and usage by stage. `verdicts` and `order` give the suite's scale: `pass`/`fail` for `and-scene`, `met`/`partial`/`missing` for this suite.

Migration happens in three steps, each its own task and commit series:
1. **Extract with no behavior change.**
   - The code moves verbatim, and `and-scene` imports and re-exports it, so every existing import path and test keeps working. Request fields the shared code needs, such as marking an evidence-view job, are set by `and-scene`'s request builder.
   - Proof that nothing changed:
     - the full existing test suite passes unchanged;
     - a cache-replay test loads recorded `and-scene` judge records through `verifyCachedRobustJob` and the scorer, and asserts identical results, consensus, and scores before and after.
2. **Add the Claude invoker and `runPanelJob` with the cross-family rule,** with unit tests on stub CLIs and canned votes. Neither suite uses them yet.
3. **Switch `and-scene` to the cross-family panel:**
   - the panel is `claude-sonnet-5-5` plus two `gpt-6-sol` samples at the pinned medium effort; `claude-opus-5-5` decides and runs the targeted and contradiction checks;
   - each panel judge keeps its own closed-world source audit and one re-cite;
   - the blind third sample is replaced by the decider. The decider's line-span rules, span audit, and contradiction check are the third sample's, unchanged;
   - Claude judges run inside the `and-scene` sandbox in in-sandbox mode, so every `and-scene` run forwards Claude credentials (`--mount-claude-auth`);
   - the judging protocol becomes `cross-family-panel-v1`, cache keys include it, and the rubric version gets a major bump recorded in `rubric-history.json`. Earlier results stay as published and form the earlier series;
   - the browser second opinion, the pricing search, and other single-purpose judge calls keep the Codex judge authority, because they are evidence checks, not scoring votes;
   - acceptance re-scores the baseline reps (claim `cc572181`) under the new panel and audits the paired verdicts (`E2E-004`).

This suite then uses `runPanelJob` for coverage, fidelity, quality, and the disclosure audit.

### Other reused and-scene code

These are copied into `and-scene-define/lib/` and adapted:
- `persistence.mjs`, `checkpoint.mjs`, `orchestrator.mjs`, `phases.mjs`;
- `runner-metrics.mjs`, `runner-state.mjs`, `publication.mjs`, `subprocess.mjs`.

`state-machine.mjs`, `outcomes.mjs`, `profiles.mjs`, and `report.mjs` are rewritten for this lifecycle.

## Decisions

1. **Evaluator and evaluated are split across the sandbox boundary.**
   - Rationale: the simulated user, judges, and pattern list need hidden material, and anything inside the sandbox is readable by a yolo agent.
   - Alternatives rejected:
     - a user or process boundary inside the container, which is fragile and unproven;
     - and-scene's in-sandbox controller, which mounts the suite.
2. **File-exchange transport through a subdirectory of `/artifacts`.**
   - It needs no new mount type, and the exchange directory holds only conversation the agent already saw.
   - The directory is agent-writable, so it is untrusted. The Runner fails on a pre-existing reply, agent access is caught by the contamination patterns, and reconciliation against the host's conversation and the lead transcript catches an altered reply.
3. **Two opt-in Runner sandbox flags rather than eval-side workarounds.**
   - The host settings and Runner source leaks happen in `sandbox-run.sh`.
   - Replacing files inside the container cannot hide a read-only bind mount.
   - Running `docker` directly from the eval would duplicate product infrastructure.
4. **Stateless simulated-user calls with whole-conversation input.**
   - This matches the whole-run-memory requirement and makes replies a function of recorded inputs, which helps rescore and audit.
   - It was proven in the proof of concept.
5. **Write-ahead conversation and reply replay by identity.**
   - This keeps the eval's conversation identical to what the agent received across crashes and resumes.
   - The Runner already replays its own record. The responder only has to be idempotent.
6. **The controller owns time; no Runner timeout and no turn cap.**
   - The single elapsed-time limit is the spec's contract.
   - An abort or stop is enough to end a stuck run.
7. **A three-judge cross-family panel (one Claude judge, two Codex samples), where only a majority that includes the Claude judge settles a verdict, and Opus decides otherwise.**
   - Both suites compare Claude and Codex agents, and a panel from one family could favor its own family's writing. The maintainer requires a Claude model in every verdict.
   - Requiring unanimity would send a large share of items to a single decider call. The labellers disagreed on about 19% of items, and three judges on a three-level scale disagree more often. In PR #81, every score difference on identical evidence came from such single-call decisions. A cross-family majority settles most splits without one.
   - The decider must pick a verdict a panel judge gave, so every final verdict has two agreeing signals.
   - Audits and dissents only mark a verdict disputed. A targeted check of the one stated claim resolves it, never an open-ended re-audit. PR #81 showed that one call overturning a vote produced its worst false fails.
   - Expected cost is three cheap calls per job, plus Opus calls for Codex-only majorities, three-way splits, and backed dissents.
8. **Host-side canary check over mount sources.**
   - Running it in the sandbox would put canary phrases into the evaluated environment.
9. **Native session files as audit evidence**, located through `run-metrics.json`, with per-turn output as a second source.
   - Only native transcripts carry every tool input and output.
10. **Starting repository committed as a reviewed tree, plus a deterministic bundle.**
   - A maintainer can review exactly what the agent sees.
   - Fixed metadata keeps the tree and commit hashes stable across runs.
11. **Committed, generated rubric and calibration inputs.**
    - They are pinned and reviewable.
    - Calibration makes real judge calls and is a maintainer diagnostic, never a gate.
12. **Share panel judging; copy everything else.**
    - Two suites now need the same judging behavior, which meets the repository rule for a shared module, and the maintainer wants one way of panel judging.
    - Extraction lands first with no behavior change, proven by cache replay, so the later protocol switch is the only behavioral change to `and-scene`'s scores.
    - Other mechanics stay copied, because their behavior differs per suite.
13. **The Runner comes from the `external-user-mode` worktree until it merges.**
    - Implementation runs and tests against `/Users/paul/codagent/agent-runner/worktrees/external-user-mode`.
    - Runner defects found during implementation, including the two sandbox flags, are fixed there.
14. **Candidate versions are compared, not part of the series.**
    - The suite exists to measure define-workflow, skill, and lead-model changes. Putting the Runner and Skills commits in the series identity would make exactly those runs incomparable.
    - Evaluator and fixture inputs stay in the series identity, because changing them changes what a score means.
15. **Leaked items are neutralized, not the whole run.**
    - A leak would otherwise inflate coverage for a requirement the agent never discovered.
    - Dropping only the leaked items keeps the rest of a paid run's score valid.
    - Because the audit now changes the score, it uses the panel and decider rather than a single call.
16. **Anchors per graded item, and lessons from PR #81 in both suites.**
    - In PR #81, most remaining splits came from undefined or borderline terms, and each definition added removed the split it targeted. Anchors are the definition step for intent-graded items.
    - The fixture or reference text in every prompt, the shared scope rule, and rubric guidance traced to the fixture stopped judges from adding requirements or inventing scenarios.
    - Scoring each omission once avoids charging one fault under two criteria.

## Risks / Trade-offs

- **The network-enabled sandbox and public reference.** Contamination is detected, not prevented. Every result states the residual risk and names an outbound allowlist and a private fixture as hardening options.
- **Simulated-user variance and leakage.** The simulated user is a second stochastic component, alongside the agent and the judges.
  - The model and policy are pinned.
  - The scripted policy-test diagnostic sends each case 3 times and reports both policy compliance and whether the disclosure decision was consistent across the three replies.
  - The disclosure audit removes leaked items from coverage and shows every flag next to the scores. A run with many leaked items scores over fewer items, so the report shows the leaked count for comparisons.
  - Conclusions need repeated runs.
- **Judge reliance on intent.** Calibration with a restructured reference and degraded variants checks that judges credit alternatives and catch removals. The provisional weights and threshold are fixed only after calibration.
- **Cheaper panel models.** Sonnet 5.5, `gpt-6-luna`, and `gpt-6-sol` are weaker than the decider at intent judgments.
  - Cross-family splits, backed dissents, and three-way splits go to Opus 5.5, and the two families make different mistakes, so a shared blind spot is the residual risk.
  - Families read borderline terms differently, and systematically. Calibration reports each family's verdict distribution, the share of items settled by each basis, and a per-item diff of two identical rescores.
  - The decider is still one stochastic call on the items it decides. Calibration re-runs it 3 times on the same recorded panel outputs and reports its flip rate. A high flip rate on an item means its anchors need sharpening, not that more judges are needed.
  - If the panel fails calibration's accuracy or spread checks, the maintainer changes the pinned judge profile. That starts a new series.
- **`and-scene` series break and quota.**
  - Switching `and-scene` to the panel changes its scores, so it starts a new series. Earlier results are not edited, and the baseline reps are re-scored under the new panel.
  - Claude judge calls inside the `and-scene` sandbox share the Claude subscription quota with the evaluated agent's Claude sessions. An identified limit with a reset within six hours waits; any other limit leaves the job a resumable harness failure.
- **Shared module couples the suites.** A change to `evals/lib/panel-judging/` affects both suites' scores. Its protocol identifier is part of both suites' cache keys and series identity, and both suites' tests run in `npm run check`.
- **Unscanned Docker image.** It is built from the Runner Dockerfile with generic tooling and recorded by image ID. The report states the gap.
- **Runner changes outside this repository.** The two sandbox flags and any fixes land on the `external-user-mode` branch. The suite records the Runner commit in each run's candidate record, so results stay attributable.
- **Host CLI configuration bleeding into eval-owned calls.** The simulated user runs with `--setting-sources ''`, `--strict-mcp-config`, and no tools. Judges use a private `CODEX_HOME`. Claude still attaches its small automatic environment block, which carries no hidden material.
- **Long runs.** The define workflow has five interactive steps with crosschecks; expect tens of minutes. The 3-hour default leaves headroom, and resume is per phase.

## Migration Plan

This suite is new. `and-scene` migrates its judging in the three steps under "Shared panel judging"; its earlier results stay published as the earlier series.

- Move `inventory/` from this change into `evals/agent-runner/and-scene-define/hidden/` when implementing.
- Keep `poc/` with this change as implementation reference, but do not commit `poc/runs/claude-20261004T022704Z/`, the run contaminated by the host plugin. It records the maintainer's personal Claude setup, and `poc/README.md` already documents its finding. Leave the directory on disk, untracked.
- The root `AGENTS.md` gains a short section on running the suite.

## Open Questions

- The pass threshold, final weights, and pinned tolerance and spread come from the first calibration.
