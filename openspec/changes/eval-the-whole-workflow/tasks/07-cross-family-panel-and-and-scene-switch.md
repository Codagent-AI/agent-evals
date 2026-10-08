# Task: Add the Claude invoker and cross-family settlement to the shared module, then switch `and-scene` to the panel

## Goal

Give the shared panel-judging module the cross-family panel both suites will use, then move `and-scene` onto it:
- one Claude-family judge and two Codex-family samples;
- a majority settles a verdict only when it includes the Claude judge;
- a Claude decider rules Codex-only majorities, three-way splits, and disputes;
- backed dissents and audit contradictions get targeted checks.

After this task, no `and-scene` criterion is decided by Codex judges alone or by a single model call. `and-scene` starts a new scoring series.

## Background

Read for full context:
- `openspec/changes/eval-the-whole-workflow/design.md`, sections "Shared panel judging" (steps 2 and 3), "Collection, gates, and judging" (the settlement rule), "Risks / Trade-offs" (the `and-scene` series-break and quota bullet), and Decisions 7 and 12;
- `openspec/changes/eval-the-whole-workflow/specs/product-quality-scoring/spec.md` and `specs/evaluation-metrics-reporting/spec.md`;
- `openspec/changes/eval-the-whole-workflow/test-plan.md`, `INT-002` (Claude invoker parts) and `INT-010`.

State to use. If one is missing, stop and report which:
- `evals/lib/panel-judging/{text,hash,codex-invoker,protocol}.mjs` from task 06, re-exported by `and-scene`;
- `evals/agent-runner/and-scene/lib/claude-quota.mjs`: `detectClaudeQuotaReset` and `waitForClaudeQuotaReset`;
- `and-scene`'s `run.sh` and controller support `--mount-claude-auth` for forwarding Claude credentials into its sandbox;
- `and-scene`'s rubric is version 12.3.0, with `rubric-history.json` and its hash guard.

### Step 1: the shared Claude invoker (`evals/lib/panel-judging/claude-invoker.mjs`)

- Same contract as the Codex invoker: `invoke(request)` returns the final JSON text, and `invoke.readUsageEntries()` reads the ledger.
- **Host mode:** `claude -p --model <m> --tools '' --setting-sources '' --strict-mcp-config --disable-slash-commands --no-session-persistence --json-schema <schema> --output-format stream-json --verbose`. Inputs are inlined in the prompt, and the call runs in an empty scratch directory.
- **In-sandbox mode:** as host mode, but with `--tools Read,Grep,Glob` and `--allowedTools Read,Grep,Glob`, and a working directory at the request's read-only root, which must be inside an approved root, as in the Codex invoker.
- Effort is pinned per request (`request.authority.effort`).
- **Rejected output:** the `init` event's tool list, and every `tool_use`, may contain only the allowed tools and the synthetic `StructuredOutput` tool. Anything else is an invalid output.
- **Usage:**
  - parse the result event into the same ledger entry shape, with `provider: 'anthropic'`;
  - a rejection before any model output, including capacity, writes a zero-token record;
  - capacity backs off without spending an attempt, using the Codex invoker's constants;
  - `invalid_json_schema`, or Claude's equivalent schema-rejection error, is non-retryable.
- **Quota:**
  - an identified Claude subscription limit with an explicit reset within six hours waits through an injected `waitForQuotaReset` and retries;
  - any other limit throws a resumable error, `owner: 'evaluation-harness'`;
  - pass `and-scene`'s `claude-quota.mjs` functions in from `and-scene`; do not import suite code into the shared module.
- Persist each attempt's events and stderr like the Codex invoker. Keep tool inputs and outputs, but omit file contents from `Read` results.

### Step 2: `runPanelJob` (`evals/lib/panel-judging/panel.mjs`)

Signature (from the design):

```
runPanelJob({ job, criteria, verdicts, order, panel: [{ family, model, effort, invoke }], decider: { model, effort, invoke }, buildPrompt, schema, validateCitations, audit, cache })
  -> { ok, results: [{ id, verdict, basis, votes, checks, ruling, rationale, citations, evidence }], usage_by_stage, record }
```

- Run the three panel judges concurrently on identical requests.
- `audit`, which is optional, is the suite's per-judge closed-world audit. `and-scene` passes the existing source audit with its one re-cite. A `contradicted` audit marks that vote disputed. A targeted contradiction check by the decider then confirms or refutes the stated contradiction, using the existing `buildContradictionCheckRequest` and running on the decider's invoker. The vote turns only on a confirmed check.
- **Settlement,** per criterion, with `order` ranking the verdicts from highest to lowest credit:
  1. **Unanimous:** stands; basis `consensus-<verdict>`.
  2. **Two-to-one with the Claude-family judge in the majority:** stands; basis `majority-<verdict>`.
     - The exception is a backed dissent: a dissent that ranks higher in `order` and whose citations pass `validateCitations`.
     - It gets a targeted check by the decider: does the dissent's stated reason hold against its cited material and the criterion's requirement?
     - If confirmed, the dissent's verdict stands, basis `checked-dissent-<verdict>`. Otherwise the majority's stands.
  3. **Codex-only majority, a three-way split, or a vote still disputed:** the decider rules; basis `decider-<verdict>`.
     - The decider sees the job's context and all three votes, labelled A, B, and C in a seeded order and never with model identity.
     - It must return a verdict that one of the panel's votes gave. Any other verdict is invalid output and is retried.
     - The decider's citations must pass `validateCitations`. For `and-scene`, a decider `pass` is the former third sample's pass:
       - one to twelve line spans, validated by the existing span validation;
       - a span audit, with one re-cite on `insufficient`;
       - a contradiction check on `contradicted`;
       - an unconfirmed browser-fallback pass fails.
- Exhausted retries on any panel judge or decider call leave the job `ok: false`, which is unobserved.
- Usage records carry `stage` values: `panel-claude`, `panel-codex-1`, `panel-codex-2`, `source-audit`, `contradiction-check`, `dissent-check`, `decider`, `span-audit`, and `decider-recite`.
- **Cache:**
  - a record is reusable only when its `protocol` equals the current protocol, and its results reproduce from its recorded votes, checks, and rulings through a pure `resolvePanel` function;
  - export `PANEL_PROTOCOL = 'cross-family-panel-v1'`;
  - keep `verifyCachedRobustJob` and the dual-sample functions exported for reading old records, but nothing new calls them.

### Step 3: switch `and-scene`

- **Panel:**
  - Claude-family judge `claude-sonnet-5-5`;
  - two Codex-family samples `gpt-6-sol`, at the pinned `JUDGE_REASONING_EFFORT` (medium);
  - decider `claude-opus-5-5`, medium effort.

  Pin these in one judge-profile constant, recorded as the judge authority.
- **Invokers:** Claude judges run in in-sandbox mode inside `and-scene`'s sandbox.
  - Source jobs get the neutral source root.
  - Evidence jobs get their inlined packet, with no tools. This matches today's evidence prompt, which says not to use tools.
  - Every candidate run, rescore, and calibration now forwards Claude credentials. Make `--mount-claude-auth` implied for judging, and fail preflight with a clear message when Claude auth is unavailable.
- **Judging:** `runProductJudging` calls `runPanelJob` for every scored job, with `verdicts: ['pass', 'fail']` and `order: ['pass', 'fail']`.
  - The per-judge source audit, the browser-fallback rules, and every prompt stay as they are, apart from wording that names "both samples" or "third sample".
  - Update that wording to "panel judges" and "decider" where it appears in prompts, and record it.
- **Records:**
  - `JUDGING_PROTOCOL` becomes `cross-family-panel-v1` and is part of each job's input hash;
  - criterion results record the bases listed in the spec, and every vote with its model family;
  - `result.json`'s judging record and the report show the basis and votes per criterion.
- **Rubric:** bump `and-scene`'s rubric to 13.0.0, with a `rubric-history.json` entry: the judging protocol changed to the cross-family panel, no criterion changed, and results before 13.0.0 are a different scoring series. Follow that file's existing hash-guard rules.
- **Unchanged:** the browser second opinion, the pricing search, and other single-purpose judge calls keep the Codex judge authority.
- **Docs:** update `and-scene`'s `README.md` judging section and the root `AGENTS.md` sentence that says eval-owned judge usage is Codex, so they describe the panel.
- `openspec/specs/**` is updated at archive time from this change's deltas. Do not edit it here.

Repository rules:
- Node 22, with no third-party runtime dependencies.
- Test-driven development.
- New modules get `node --check` entries in `npm run check`.
- Do not edit `evals/agent-runner/and-scene/results/**`.
- No paid model calls in this task. Real-evidence verification is `E2E-004`, during acceptance.

## Spec

### Requirement: Robust judge verdicts (`product-quality-scoring`, modified)
No single model call SHALL decide a scored criterion, and no criterion SHALL be decided by Codex-family judges alone. Every scored judge job SHALL be judged by a cross-family panel of three independent judges with identical inputs, run concurrently, each at an explicitly pinned model and reasoning effort: one Claude-family judge and two independent Codex-family samples.

Each source-job panel judge SHALL pass through its own closed-world source audit:
- `contradicted` SHALL mark that judge's vote disputed, and the vote SHALL turn only when an independent contradiction check confirms the audit's stated contradiction;
- `insufficient` SHALL trigger at most one focused re-cite, and a verdict still undecided after the re-cite SHALL stand as the judge's vote. A browser-fallback pass SHALL then fail, because it must be proven from source.

Votes SHALL settle as follows, with no vote disputed:
- a verdict all three judges give SHALL stand, pass or fail;
- a verdict two judges give SHALL stand when the two include the Claude-family judge, unless the dissent is a pass backed by citations that pass validation. Such a backed dissent SHALL go to a targeted check, by a pinned Claude-family decider, of the dissent's stated reason. The dissent's verdict SHALL stand when the check confirms that reason, and the majority's otherwise;
- a verdict the two Codex-family judges give against the Claude-family judge, and a criterion whose vote remains disputed, SHALL be settled by the decider.

The decider SHALL receive the job's unchanged context and all three votes with their rationales and citations, without being told which model gave which. It SHALL rule pass or fail.

A decider pass SHALL cite between one and twelve line spans, each under 200 lines. Their paths SHALL be in the verified neutral source inventory for a source job, or the materialized evidence view for an evidence job, and SHALL resolve inside that root without a symbolic link and lie inside the file. A closed-world span audit SHALL check the quoted lines against every clause of the criterion's requirement and review guidance:
- `insufficient` SHALL ask the decider to re-cite once, and an audit that still cannot decide SHALL leave the decider pass standing with that recorded;
- `contradicted` SHALL be checked by an independent contradiction check that judges that audit's stated contradiction against the quoted lines and the rubric. The decider pass SHALL be withdrawn only when the check confirms that same contradiction, and both SHALL be recorded.

An unconfirmed browser-fallback decider pass SHALL fail. Invalid decider output, including an invalid span, SHALL be retried and, once exhausted, SHALL leave the job unobserved as a harness failure, as SHALL an exhausted panel judge. Contradiction checks and targeted dissent checks SHALL run on the decider's pinned model.

Every panel judge, decider, and audit SHALL see, beside each criterion, the requirement it traces to: the full fixture scenario from the pinned snapshot for a fixture-owned criterion, or the eval-owned reason. A pass SHALL meet every clause of that requirement as clarified by its review guidance, and judges SHALL NOT add requirements the requirement and its guidance do not state. Source judges SHALL trace a constant, member, prop, or input through every use before calling it dead, and SHALL treat shown, visible, or on-screen content as rendered content, not an `aria-label`, attribute, or visually hidden text. Evidence judges SHALL compare every behavior the exploration plan commits to with what the log observed or disclosed, and the assumption judge SHALL receive the full approved requirements as reference for its omission check.

Each criterion result SHALL record:
- its judging basis: `consensus-pass`, `consensus-fail`, `majority-pass`, `majority-fail`, `checked-dissent-pass`, `decider-pass`, or `decider-fail`;
- every panel verdict, with the model family that gave it.

The eval-owned usage ledger SHALL record each call's stage, provider, and model. A Codex or Claude call rejected before any model output, for example a capacity rejection, SHALL be recorded as a call that consumed no tokens. A capacity rejection SHALL be waited out with backoff rather than spending a judge attempt.

A Claude judge call that hits an identified Claude subscription limit with an explicit reset within six hours SHALL wait for the reset and retry. Any other Claude limit SHALL leave the job unobserved as a resumable harness failure.

Every response schema the harness sends SHALL satisfy strict structured-output rules, and a schema rejection (`invalid_json_schema`) SHALL fail fast as a non-retryable harness error. A cached judge job SHALL be reused only under the same judging protocol, and only when its results reproduce from its recorded panel votes, checks, and decider rulings.

The scenarios are in `openspec/changes/eval-the-whole-workflow/specs/product-quality-scoring/spec.md`. Each is a required test case.

### Requirement: Implementation-only cost scope (`evaluation-metrics-reporting`, modified)
The harness SHALL durably capture eval-owned Codex and Claude usage when the CLI reports it, including phase, provider, model, raw token categories, and canonical token totals. Missing eval-owned telemetry SHALL remain explicitly unavailable or partial. Eval-owned usage SHALL stay outside implementation cost aggregation and SHALL NOT be priced.

#### Scenario: Claude judge incurs usage
- **WHEN** a Claude-family panel judge, decider, or check reports token usage
- **THEN** the eval-owned usage ledger records its phase, stage, provider, model, and token categories
- **AND** that usage is not priced or included in the implementation total

## Test Plan

- `INT-002`, the shared-invoker part: `test/panel-judging-invokers.test.mjs`, in `npm run check`.
  - Stub `claude` executables record argv, environment, and working directory, and replay recorded stream-json.
  - Assert:
    - host mode passes `--tools ''` and the isolation flags;
    - in-sandbox mode offers only `Read`, `Grep`, and `Glob`, in an approved root;
    - an out-of-root working directory is refused;
    - a stray tool use is invalid output;
    - a capacity rejection backs off without spending an attempt and records zero tokens with provider `anthropic`;
    - a schema rejection is not retried;
    - a six-hour-or-less subscription limit waits through the injected wait and retries, and any other limit throws a resumable error.
- `INT-010` (Cross-family settlement and the `and-scene` switch): `test/panel-judging-settlement.test.mjs`, plus updates to `test/judge-jobs.test.mjs`, in `npm run check`. Cover every case listed in the test plan's `INT-010`, and every scenario of the modified "Robust judge verdicts" requirement.
- Existing `and-scene` tests that assert the dual-sample protocol are updated to the panel protocol. A test that asserts unrelated behavior must not change.

## Done When

- `claude-invoker.mjs` and `panel.mjs` exist in `evals/lib/panel-judging/`, with `PANEL_PROTOCOL = 'cross-family-panel-v1'`.
- `and-scene` judges every scored job through `runPanelJob` with the pinned Sonnet, `gpt-6-sol` ×2, and Opus profile.
  - Claude judges run inside its sandbox with forwarded Claude credentials.
  - Criterion results record basis and family-labelled votes.
  - The rubric is 13.0.0, with its history entry.
- `INT-002` (shared-invoker part) and `INT-010` pass, with no paid model calls.
- `npm run check` passes.
- The final summary tells the user that `E2E-004` (the paired rescore of the `and-scene` baseline under the new panel) is ready for acceptance, and gives the branch name and worktree path.
