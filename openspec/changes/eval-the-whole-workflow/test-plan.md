## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only obligations.

Integration tests run in `npm run check` (`node --test test/*.test.mjs`). They make no model calls: they use stub `claude` and `codex` executables on `PATH`, recorded transcripts, and real filesystems and subprocesses. Tests that need an Agent Runner checkout or Docker read the checkout path from `AGENT_RUNNER_DIR`. When it is unset, as in CI, they skip visibly and say why.

End-to-end tests are local, paid, opt-in runs of the suite's public entry point, and never run in CI.

### Ordering constraint: agent-evals PR #81

The judge mechanics are copied from the and-scene suite only after agent-evals PR #81 ("fix: make and-scene judging and scoring robust") merges. These items depend on that copy:
- judges, scoring, and calibration;
- INT-003 and the judge half of INT-002;
- E2E-001, E2E-002, and E2E-003, because candidate runs need a calibrated rubric.

Everything else proceeds first. Before starting the dependent work, check the PR with `gh pr view 81 --repo Codagent-AI/agent-evals --json state`:
- if it is merged, copy from the updated `main`;
- if it is not merged, stop and report the work as blocked on PR #81. Do not copy the pre-#81 versions or poll indefinitely.

## Integration Tests

### INT-001: Responder loop over a real exchange directory
- Covers: simulated-user responder integration, opening reply, conversation evidence, elapsed-time limit, replay on resume (`simulated-user`, `define-workflow-evaluation`).
- Boundary: the controller's responder loop against a real exchange directory, written by a scripted fake Runner process that publishes requests the way Agent Runner does (temp file plus rename, 0644). A stub `claude` stands in for the simulated user.
- Setup: a temporary run directory; recorded request bodies taken from the Agent Runner smoke run and the proof of concept; stub replies, including malformed and capacity-error responses.
- Action: run the loop through several requests, restart the controller mid-run, and let the elapsed-time limit expire while a request is pending.
- Assertions:
  - `conversation.jsonl` is fsynced before the reply file appears;
  - the first reply is the pinned starting prompt with no model call;
  - after the restart, already-answered requests get the recorded reply with no new call;
  - a `run_id` mismatch ends the run `evaluation-harness-failed`;
  - an expired limit with a pending request writes `{"action": "abort"}`;
  - three malformed replies lead to an abort and `evaluation-harness-failed`;
  - a capacity error does not use up a retry.
- Execution: `test/and-scene-define-responder.test.mjs` in `npm run check`.

### INT-002: Eval-owned CLI invocation contracts
- Covers: simulated-user knowledge boundary, eval-owned judges, strict schemas (`simulated-user`, `definition-artifact-scoring`).
- Boundary: the controller's simulated-user, Claude-judge, and Codex-judge invokers spawning stub `claude` and `codex` executables. The stubs record their argv and environment and replay recorded stream-json and `--json` output from the proof-of-concept runs.
- Setup: stub executables on `PATH`; recorded outputs, including one with an unexpected `tool_use` and one `invalid_json_schema` error.
- Action: invoke the simulated user and each judge role once per case.
- Assertions:
  - the simulated user and Claude judges receive `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, and `--no-session-persistence`;
  - the tool check rejects the stray `tool_use`;
  - Codex judges run with `--sandbox read-only` and a private `CODEX_HOME` that holds only `auth.json` and is deleted afterward;
  - every schema sent is strict-mode valid (`additionalProperties: false`, all properties required);
  - `invalid_json_schema` fails the run without retrying.
- Execution: `test/and-scene-define-invokers.test.mjs` in `npm run check`. The judge half is written after PR #81 merges.

### INT-003: Judge panel to score
- Covers: eval-owned judges with the three-judge panel and decider, requirement coverage, fidelity, artifact quality, gates, scoring, discovery outcomes, disclosure audit and leaked items (`definition-artifact-scoring`, `requirement-discovery-diagnostic`, `simulated-user`).
- Boundary: judge-job orchestration, panel consensus, decider routing, citation validation, scorer, and discovery computation, with stub judges returning canned verdicts.
- Setup: a collected definition fixture with known per-item expectations, plus canned panel outputs:
  - unanimous;
  - 2-to-1;
  - a three-way split;
  - fidelity citations that don't match;
  - one uncited `met` verdict;
  - one rejected call;
  - a collected change with no design, where a design-only item is `missing` citing the inspected files and the gate's absence record;
  - disclosure-audit panel outputs where one mandatory item is named by all three, one by two of three, and a withholding flag by all three.
- Action: run the scoring phase.
- Assertions:
  - unanimous items make no decider call;
  - every non-consensus item reaches the decider, with verdicts labelled only A, B, and C;
  - the uncited verdict is retried and never scored;
  - the `missing` verdict for the absent design is accepted without a retry, and the run stays `complete` with `definition_verdict=fail`;
  - the unanimously leaked item and the decider-ruled item, if ruled leaked, are dropped from earned and possible coverage, reported `leaked` in the result and discovery ledger, and coverage is scaled over the remaining items;
  - the withholding flag changes no score;
  - a rejected call writes a zero-token usage record;
  - the result records panel verdicts, non-consensus items, and rulings;
  - component scores, gates, and the four discovery outcomes match the expectations.
- Execution: `test/and-scene-define-scoring.test.mjs` in `npm run check`, written after PR #81 merges.

### INT-004: Contamination audit over real transcripts
- Covers: contamination audit, complete audit evidence, conversation reconciliation, rescore reproducibility (`evaluation-isolation`).
- Boundary: the deterministic audit over native Claude and Codex session files, located through a `run-metrics.json` manifest.
- Setup: recorded transcripts from the Agent Runner external-user smoke run and the proof-of-concept runs, copied into fixtures, with planted cases:
  - a fixture-repository URL in a Codex `web_search` result;
  - an undisclosed canary phrase in a file-read output;
  - a disclosed canary phrase that the agent writes into a spec through a write tool;
  - a manifest entry whose transcript is missing;
  - a shell command that reads `../../exchange/<file>.reply.json` through a relative path;
  - a reply whose text in the Runner's `exchanges.jsonl` differs from `conversation.jsonl`;
  - a reply in `conversation.jsonl` that no user turn of the lead transcript contains;
  - a lead user turn that is the reply plus the Runner's appended completion instruction.
- Action: run the audit twice over identical evidence.
- Assertions:
  - the URL and the undisclosed canary make the run `contaminated`, listing session, tool call, and pattern;
  - the disclosed canary written into the spec is not a match;
  - the missing transcript ends the run `evaluation-harness-failed`;
  - the relative-path read makes the run `contaminated`;
  - the altered reply and the undelivered reply each end the run `evaluation-harness-failed`, naming the exchange and the differing record;
  - the reply with an appended completion instruction reconciles;
  - both runs produce byte-identical audit output.
- Execution: `test/and-scene-define-contamination.test.mjs` in `npm run check`.

### INT-005: Starting repository and canary check
- Covers: starting environment, canary check, pinned contamination patterns (`define-workflow-evaluation`, `evaluation-isolation`).
- Boundary: snapshot materialization with real `git`, bundle creation, and the host-side canary scan over the staged mount sources.
- Setup: the committed `starting-repo/` tree and manifest; a temporary staged input directory; a forwarded-settings fixture containing a fixture-repository name.
- Action: materialize twice, then run the canary check over the clean staging and again with each planted file.
- Assertions:
  - both materializations produce the same commit and tree hash;
  - across all refs there is exactly one commit, with `main` and `add-presentation-skill` at it and HEAD on `add-presentation-skill`;
  - there is no remote;
  - `.validator/config.yml` sets `base_branch: main`;
  - the pattern list finds nothing in the snapshot;
  - each planted match stops the run before the sandbox starts, naming the file and pattern.
- Execution: `test/and-scene-define-starting-repo.test.mjs` in `npm run check`.

### INT-006: Sandbox mount plan against the real Runner script
- Covers: hidden material not mounted, simulated-user boundary preflight, no GitHub credential (`evaluation-isolation`, `define-workflow-evaluation`).
- Boundary: `run.sh --dry-run` invoking the real `scripts/sandbox-run.sh --dry-run` from the configured Agent Runner checkout.
- Setup: `AGENT_RUNNER_DIR` pointing at `agent-runner/worktrees/external-user-mode`; valid lead and crosscheck profiles; a GitHub token set in the host environment.
- Action: run the dry run, and run preflight against a deliberately widened mount plan.
- Assertions:
  - the planned mounts are exactly the staged input, the run's sandbox directory, the Agent Skills checkout, and the selected CLIs' credential files;
  - the suite directory, `/agent-runner-source`, and the Claude settings files are not mounted;
  - `--auth-only`, `--hide-source`, and `--no-default-secrets` are present;
  - no GitHub variable is passed;
  - the widened plan fails preflight, naming the extra path.
- Execution: `test/and-scene-define-sandbox-plan.test.mjs` in `npm run check`; skipped with a stated reason when `AGENT_RUNNER_DIR` is unset.

### INT-007: Agent Runner sandbox flags
- Covers: the `--auth-only` and `--hide-source` options this suite depends on (design, "Agent Runner sandbox changes").
- Boundary: `scripts/sandbox-run.sh` with Docker, in the Agent Runner repository.
- Setup: the `external-user-mode` worktree; Docker available.
- Action: dry-run each flag, then run a real container with both flags that lists the filesystem and runs `agent-runner --help`.
- Assertions:
  - with `--auth-only`, the dry-run command mounts only the credential files, not `settings.json` or `settings.local.json`;
  - with `--hide-source`, the command container has no `/agent-runner-source` mount;
  - in the real container, neither `/agent-runner-source`, `/tmp/agent-runner-local`, nor the host Claude settings exists, and `agent-runner --help` succeeds and lists `--external-user`;
  - existing behavior without the flags is unchanged.
- Execution: the Agent Runner repository's sandbox script tests (`scripts/sandbox_scripts_test.go` or alongside it), following that repository's conventions.

### INT-008: Resume, rescore, and publication
- Covers: durable checkpoints and resume, artifact collection, rescore, permanent result publication (`define-workflow-evaluation`, `requirement-discovery-diagnostic`).
- Boundary: the controller lifecycle with a fake sandbox module, recorded Agent Runner state, and a local bare Git remote.
- Setup: a fake sandbox that is killed mid-workflow; recorded `state.json` for interrupted, capped-stop, and failed runs; a recorded complete run directory with an evidence manifest; a local bare remote, plus one configured to reject the push.
- Action: resume after the kill, resume a run already stopped after `define`, rescore from the recorded run, and publish to both remotes.
- Assertions:
  - resume invokes `--resume <run-id> --until define` and never starts a second Runner run;
  - completed judge and audit units are reused;
  - a run stopped after `define` is not resumed;
  - `--rescore-from` reads only manifest files, runs with no Docker on `PATH`, and reproduces the contamination outcome;
  - rescoring after a rubric version bump uses the current rubric, records the current series identity, and records the original series identity and candidate alongside;
  - resume refuses a changed Agent Skills commit as a candidate mismatch;
  - a comparison of two recorded runs that differ only in the Agent Skills commit is paired and names that component, and one that differs in the rubric version is labelled not comparable;
  - rescore refuses a file whose hash differs;
  - publication commits only `results/<run-id>/`;
  - after a rejected push, resume retries the push using the same commit, with no new commit and no force.
- Execution: `test/and-scene-define-lifecycle.test.mjs` in `npm run check`.

## End-to-End Tests

### E2E-001: Claude-lead candidate run
- Covers: the full candidate journey (all six capabilities).
- Surface: `evals/agent-runner/and-scene-define/run.sh --run-agent`.
- Setup:
  - this Mac with Docker;
  - the Runner from `agent-runner/worktrees/external-user-mode`;
  - the pinned Agent Skills checkout;
  - lead `claude`, crosscheck `codex`;
  - host Claude and Codex subscription auth;
  - the calibrated rubric from E2E-003;
  - a temporary clone of agent-evals whose upstream is a local bare remote.
- Journey: start the run and let it finish, then run `--rescore-from` on the run directory.
- Assertions:
  - `evaluation_status` is `complete`;
  - all four artifacts are collected with hashes, and the gates are evaluated;
  - the contamination audit is clean, with a transcript for every invocation in `run-metrics.json`;
  - `result.json`, `report.html`, the conversation, the discovery ledger, and the evidence manifest exist;
  - the result reports panel verdicts and decider rulings;
  - the result commit lands on the local bare remote;
  - the rescore reproduces the contamination outcome and gate results without Docker.
- Execution: local, opt-in, paid; never in CI. Run after PR #81 merges and E2E-003.

### E2E-002: Codex-lead run, interrupted and resumed
- Covers: resume through the external-user mode, replay, and the `--until define` cap (`define-workflow-evaluation`, `simulated-user`).
- Surface: `run.sh --run-agent`, then `run.sh --resume`.
- Setup: as E2E-001, with lead `codex` and crosscheck `claude`.
- Journey: start the run, stop the sandbox after the first answered `define.proposal` exchange, then resume with the same profiles.
- Assertions:
  - only one Agent Runner run ID exists;
  - no exchange already recorded in `conversation.jsonl` is answered by a new simulated-user call;
  - the workflow stops after `define`, and the run completes;
  - resuming with a different lead profile is refused.
- Execution: local, opt-in, paid; never in CI. Run after E2E-003.

### E2E-003: Calibration
- Covers: calibration, including the decider's test-retest spread (`definition-artifact-scoring`).
- Surface: `run.sh --calibrate`.
- Setup: the committed calibration set, with expected per-item verdicts and expected-fail marks; the pinned judge profile; host Claude and Codex auth.
- Journey: run calibration.
- Assertions:
  - each input is judged at least three times;
  - the report gives accuracy, stability, panel agreement, decider rate, and each input's score;
  - the decider is re-run 3 times on the same recorded panel outputs, and its ruling-flip rate is reported separately;
  - the report names any undetected removed mandatory item, restructured-reference loss beyond tolerance, or spread beyond the pinned limit;
  - it proposes a pass threshold between the expected-fail variants and the expected-pass inputs.
- Execution: local, opt-in, paid; never in CI. Run after PR #81 merges.

## Acceptance Testing Envelope

- **Environments and sandboxes:**
  - this Mac with Docker;
  - Agent Runner from `/Users/paul/codagent/agent-runner/worktrees/external-user-mode` (branch `external-user-mode`);
  - the pinned Agent Skills checkout;
  - the suite's `run.sh` modes: dry run, candidate, resume, rescore, calibrate, and the simulated-user policy-test diagnostic;
  - temporary agent-evals clones with local bare remotes for publication.
- **Credentials and secrets:**
  - host Claude Code auth and `~/.codex/auth.json`, used read-only for the simulated user, judges, and forwarded evaluated-CLI auth;
  - no GitHub credential is forwarded into any sandbox;
  - `gh` on the host may be used read-only, for example to check PR #81.
- **Authorized effects:**
  - paid model calls for the E2E runs, calibration, and policy tests: about $150 in total, covering the three E2E runs plus at most one rerun each after a fix. Stop and ask before exceeding it.
  - local Docker image builds and containers;
  - commits on the `eval-the-whole-workflow` branch;
  - commits on the Agent Runner `external-user-mode` branch, for the two sandbox flags and any defects found.
- **Off limits:**
  - pushing anything, in either repository, without asking;
  - force-pushing;
  - modifying `~/.claude` or `~/.codex`;
  - the `and-scene` suite's code, rubric, and `results/**`;
  - the and-scene fixture repository;
  - publishing eval results to GitHub.
- **Permitted substitutes:**
  - stub CLIs and recorded transcripts, in integration tests only;
  - if a lead family's quota is exhausted, report the gap rather than swap families.
- **Known risk areas:**
  - host configuration leaking into the sandbox: the proof of concept's first run was contaminated by the host's and-scene plugin;
  - Codex placing its question in a middle message;
  - Claude's system prompt surviving `--resume`;
  - model-capacity errors;
  - native transcript locations under `.runtime`;
  - atomic rename and polling across Docker Desktop bind mounts;
  - judge and decider variance on borderline items;
  - the simulated user over-disclosing.

## Human-Only Testing

### HT-001: Starting repository review
- Reason: only the maintainer can judge whether anything in the starting tree reveals the hidden target or the evaluation, and the spec requires a maintainer review before the tree is pinned.
- Prerequisites:
  - INT-005 passes;
  - the canary check finds nothing in the snapshot;
  - the tree and its manifest (allowlist and rewrites) are committed.
- Instructions: read the files under `evals/agent-runner/and-scene-define/starting-repo/` as the evaluated agent will see them.
- Required decision or observation: approve the tree, or list the files or passages to exclude or rewrite.

### HT-002: Calibrated threshold and weights
- Reason: the spec reserves the expected-fail marking of degraded variants and the pass threshold to the maintainer.
- Prerequisites:
  - E2E-003 has completed without failures;
  - its report shows per-input scores, the panel and decider spread, and the proposed threshold.
- Instructions: review the calibration report and the rubric's proposed weights, threshold, and expected-fail marks.
- Required decision or observation: approve the threshold and weights, or name the changes.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| Responder integration, opening reply, conversation evidence | INT-001 | E2E-001 | — |
| Elapsed-time limit | INT-001 | — | — |
| Simulated-user knowledge boundary | INT-002 | E2E-001 | — |
| Eval-owned judges, panel and decider | INT-002, INT-003 | E2E-001 | — |
| Requirement coverage, fidelity, artifact quality, gates | INT-003 | E2E-001 | — |
| Discovery ledger | INT-003 | E2E-001 | — |
| Contamination audit, complete audit evidence, conversation reconciliation | INT-004 | E2E-001 | — |
| Disclosure audit and leaked items | INT-003 | E2E-001 | — |
| Series identity and candidate comparison | INT-008 | — | — |
| Starting environment | INT-005 | E2E-001 | HT-001 |
| Canary check and pinned contamination patterns | INT-005 | E2E-001 | — |
| Hidden material not mounted, simulated-user boundary | INT-006, INT-007 | E2E-001 | — |
| Durable checkpoints and resume | INT-008 | E2E-002 | — |
| Rescore under current evaluator inputs | INT-008 | E2E-001 | — |
| Permanent result publication | INT-008 | E2E-001 | — |
| Define workflow execution and `--until define` | — | E2E-001, E2E-002 | — |
| Calibration | — | E2E-003 | HT-002 |
