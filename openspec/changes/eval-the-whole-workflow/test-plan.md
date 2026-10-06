## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only additional integration and end-to-end obligations, the acceptance testing envelope, and exceptional human-only obligations.

Integration tests run in `npm run check` (`node --test test/*.test.mjs`). They make no model calls: they use stub `claude` and `codex` executables on `PATH`, recorded transcripts, and real filesystems and subprocesses. Tests that need an Agent Runner checkout or Docker read the checkout path from `AGENT_RUNNER_DIR`. When it is unset, as in CI, they skip visibly and say why.

End-to-end tests are local, paid, opt-in runs of the suite's public entry point, and never run in CI.

### Ordering constraint: shared panel judging first

Agent-evals PR #81 ("fix: make and-scene judging and scoring robust") is merged (`cd7a3fc`), and this branch has merged `main`. Panel judging is built in this order, and each step lands before the next:
1. extract `evals/lib/panel-judging/` from `and-scene` with no behavior change (INT-009);
2. add the Claude invoker and the cross-family settlement to the shared module (INT-002, INT-010);
3. switch `and-scene` to the cross-family panel (INT-010, then E2E-004 during acceptance);
4. build this suite's judging on the shared module (INT-003).

The E2E runs need a calibrated rubric, so E2E-001 and E2E-002 run after E2E-003.

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
- Covers: simulated-user knowledge boundary, eval-owned judges, strict schemas, the shared Claude invoker's host and in-sandbox modes (`simulated-user`, `definition-artifact-scoring`, `product-quality-scoring`, `evaluation-metrics-reporting`).
- Boundary: the controller's simulated-user invoker and the shared panel-judging Claude and Codex invokers spawning stub `claude` and `codex` executables. The stubs record their argv and environment and replay recorded stream-json and `--json` output from the proof-of-concept runs.
- Setup: stub executables on `PATH`; recorded outputs, including one with an unexpected `tool_use` and one `invalid_json_schema` error.
- Action: invoke the simulated user and each judge role once per case.
- Assertions:
  - the simulated user and Claude judges receive `--tools ''`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`, and `--no-session-persistence`;
  - the tool check rejects the stray `tool_use`;
  - Codex judges run with `--sandbox read-only` and a private `CODEX_HOME` that holds only `auth.json` and is deleted afterward;
  - every schema sent is strict-mode valid (`additionalProperties: false`, all properties required);
  - `invalid_json_schema` fails the run without retrying;
  - the in-sandbox Claude mode offers only `Read`, `Grep`, and `Glob`, runs in the job's read-only root, and rejects any other tool use;
  - a Claude capacity rejection backs off without spending an attempt and writes a zero-token usage record with provider `anthropic`;
  - an identified Claude subscription limit with a reset within six hours waits and retries, and any other limit fails the job as resumable.
- Execution: `test/and-scene-define-invokers.test.mjs` and `test/panel-judging-invokers.test.mjs` in `npm run check`.

### INT-003: Judge panel to score
- Covers: eval-owned judges with the three-judge panel and decider, requirement coverage, fidelity, artifact quality, gates, scoring, discovery outcomes, disclosure audit and leaked items (`definition-artifact-scoring`, `requirement-discovery-diagnostic`, `simulated-user`).
- Boundary: this suite's jobs on the shared `runPanelJob`, cross-family settlement, decider and targeted-check routing, citation validation, scorer, and discovery computation, with stub judges returning canned verdicts.
- Setup: a collected definition fixture with known per-item expectations, plus canned panel outputs:
  - unanimous;
  - 2-to-1 with the Claude-family judge in the majority and an unbacked dissent;
  - 2-to-1 with the Claude-family judge in the majority and a backed higher-verdict dissent, once confirmed and once refuted by the targeted check;
  - 2-to-1 with the two Codex-family judges against the Claude-family judge;
  - a three-way split;
  - a decider ruling a verdict no panel judge gave;
  - a definition that contradicts a mandatory item the simulated user also stated, and one that contradicts a stated preference;
  - fidelity citations that don't match;
  - one uncited `met` verdict;
  - one rejected call;
  - a collected change with no design, where a design-only item is `missing` citing the inspected files and the gate's absence record;
  - disclosure-audit panel outputs where one mandatory item is named by the Claude-family judge and one Codex-family judge, one only by both Codex-family judges, and a withholding flag by all three.
- Action: run the scoring phase.
- Assertions:
  - unanimous items and Claude-inclusive majorities with unbacked dissents make no decider call;
  - a backed dissent gets one targeted check, and its verdict stands only when the check confirms it;
  - Codex-only majorities and three-way splits reach the decider, with verdicts labelled only A, B, and C;
  - a decider ruling outside the panel's verdicts is retried and never scored;
  - the contradicted mandatory item is scored only under coverage, and the contradicted preference is a fidelity deduction;
  - every prompt contains the scope rule and each judged item's anchors and source quotes;
  - the uncited verdict is retried and never scored;
  - the `missing` verdict for the absent design is accepted without a retry, and the run stays `complete` with `definition_verdict=fail`;
  - the cross-family leaked item and the decider-ruled item, if ruled leaked, are dropped from earned and possible coverage, reported `leaked` in the result and discovery ledger, and coverage is scaled over the remaining items;
  - the withholding flag changes no score;
  - a rejected call writes a zero-token usage record;
  - the result records panel verdicts, each settlement basis, targeted checks, and rulings;
  - component scores, gates, and the four discovery outcomes match the expectations.
- Execution: `test/and-scene-define-scoring.test.mjs` in `npm run check`.

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

### INT-009: Shared panel-judging extraction changes nothing
- Covers: the no-behavior-change extraction of `evals/lib/panel-judging/` (design, "Shared panel judging", step 1).
- Boundary: `and-scene` judging through the shared module, against recorded judge records.
- Setup: recorded `and-scene` judge-job records under protocol `dual-sample-majority-v4`, taken from the post-#81 baseline rescores or built from the existing judge-jobs test fixtures, with their expected results, consensus, and component scores.
- Action: before the extraction, capture each record's reproduced results, consensus, input hash, and scores. After it, replay the same records through `verifyCachedRobustJob`, `runProductJudging` with a cache loader, and the scorer.
- Assertions:
  - results, consensus, input hashes, and scores are byte-identical before and after;
  - every existing `and-scene` test passes without modification;
  - every former import path from `and-scene/lib/` still resolves to the same exports.
- Execution: `test/panel-judging-extraction.test.mjs` in `npm run check`.

### INT-010: Cross-family settlement and the `and-scene` switch
- Covers: the shared settlement rule, and `and-scene`'s robust judge verdicts under the panel (`product-quality-scoring`).
- Boundary: `runPanelJob` with stub invokers, then `and-scene`'s `runProductJudging` on it, with stub Claude and Codex judges, audits, and checks.
- Setup: canned votes on a pass/fail scale:
  - unanimous pass and unanimous fail;
  - a Claude-inclusive majority with a backed pass dissent, confirmed once and refuted once;
  - both Codex samples against the Claude judge;
  - a vote whose source audit is contradicted, with the contradiction check confirming it once and refuting it once;
  - a decider pass whose span audit is `insufficient`, then `contradicted` with the check confirming;
  - a browser-fallback decider pass the span audit cannot confirm;
  - a Claude subscription-limit event with a reset within six hours.
- Assertions:
  - each criterion's basis and verdict match the `product-quality-scoring` scenarios;
  - no criterion is settled by Codex votes alone;
  - decider passes cite valid line spans, and invalid spans are retried;
  - a cached job is reused only under `cross-family-panel-v1`, and only when it reproduces from its votes, checks, and rulings;
  - a record under `dual-sample-majority-v4` is not reused;
  - the usage ledger records stage, provider, and model for Claude and Codex calls;
  - the rubric's major version bump is recorded in `rubric-history.json`.
- Execution: `test/panel-judging-settlement.test.mjs` and the existing `test/judge-jobs.test.mjs`, updated, in `npm run check`.

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
- Execution: local, opt-in, paid; never in CI. Run after E2E-003.

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
  - the report gives accuracy, stability, each settlement basis's share, each model family's verdict distribution, and each input's score;
  - two identical rescores of one input are diffed per item, and every differing item is listed;
  - the decider is re-run 3 times on the same recorded panel outputs, and its ruling-flip rate is reported separately;
  - the report names any undetected removed mandatory item, restructured-reference loss beyond tolerance, or spread beyond the pinned limit;
  - it proposes a pass threshold between the expected-fail variants and the expected-pass inputs.
- Execution: local, opt-in, paid; never in CI. Run after HT-003.

### E2E-004: `and-scene` baseline re-scored under the cross-family panel
- Covers: the `and-scene` switch on real evidence (`product-quality-scoring`, `evaluation-metrics-reporting`).
- Surface: `evals/agent-runner/and-scene/run.sh` rescore of retained run directories.
- Setup:
  - the `and-scene` baseline reps 1–3 (claim `cc572181`), with their rubric 12.3.0 rescores as the comparison;
  - host Claude and Codex auth, with Claude credentials forwarded to the `and-scene` sandbox;
  - runs strictly one at a time, with one headless Chrome at a time.
- Journey: rescore each rep twice under `cross-family-panel-v1`, then compare per-criterion verdicts against each other and against the 12.3.0 rescores.
- Assertions:
  - every criterion records its basis and its votes by model family, and none is settled by Codex votes alone;
  - repeated rescores of the same rep differ by no more than the pinned spread, and every differing criterion is listed;
  - every verdict that changed from 12.3.0 is listed with its votes and rationale for audit;
  - Claude and Codex judge usage both appear in the eval-owned usage ledger.
- Execution: local, opt-in, paid; never in CI. Run during acceptance. The runner-evals-strategy session or the maintainer audits the changed verdicts.

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
  - paid model calls for the E2E runs, calibration, and policy tests: about $150 in total, covering E2E-001 to E2E-003 plus at most one rerun each after a fix. E2E-004 is budgeted separately at about $50. Stop and ask before exceeding either.
  - local Docker image builds and containers;
  - commits on the `eval-the-whole-workflow` branch;
  - commits on the Agent Runner `external-user-mode` branch, for the two sandbox flags and any defects found.
- **Off limits:**
  - pushing anything, in either repository, without asking;
  - force-pushing;
  - modifying `~/.claude` or `~/.codex`;
  - `and-scene` code outside its judging, its rubric content beyond the version bump and history entry, and its `results/**`;
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

### HT-003: Anchor review
- Reason: the inventory spec requires a maintainer review of every graded item's anchors before they are used for a candidate run, and the anchors decide borderline verdicts.
- Prerequisites: the drafted anchors for all 72 graded items are committed in `hidden/inventory.json`, and the inventory check passes.
- Instructions: read each item's `met`, `partial`, and `missing` anchors beside its statement, intent, and source quotes.
- Required decision or observation: approve the anchors, which records `anchors_review`, or name the items to change.

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
| Verdict anchors | INT-003 | E2E-003 | HT-003 |
| Shared panel judging, extraction | INT-009 | — | — |
| Cross-family settlement, `and-scene` robust judge verdicts | INT-010 | E2E-004 | — |
| Eval-owned Claude and Codex usage | INT-002, INT-010 | E2E-004 | — |
