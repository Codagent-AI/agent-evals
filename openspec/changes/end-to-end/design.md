## Context

Agent Evals has two suites for the and-scene feature, which cover the two halves of the lifecycle.

`evals/agent-runner/and-scene-define/` evaluates the definition half:
- Its host-side controller (`controller.mjs`, `lib/`) materializes a history-free starting repository from `starting-repo/`.
- It starts Agent Runner's sandbox (`scripts/sandbox-run.sh`) with `agent-runner run openspec:change --external-user <exchange> --until define`.
- A host responder answers through the exchange directory. It runs the simulated user (`lib/simulated-user.mjs`, `lib/responder.mjs`).
- It then collects the change directory and reconciles the conversation (`lib/reconciliation.mjs`).
- It runs the deterministic contamination audit (`lib/contamination.mjs`, `contamination-patterns.json`) and the disclosure audit.
- It scores the definition (`lib/judging.mjs`, `lib/judge-jobs.mjs`, `lib/scoring.mjs`, `rubric.json`) and builds the discovery ledger.
- Its hidden inputs (`hidden/inventory.json`, `hidden/reference/`, the starting prompt and the simulated-user policy) never enter the sandbox.

`evals/agent-runner/and-scene/` evaluates the implementation half:
- Its controller (`controller.mjs`, about 2,500 lines) normally runs inside the Docker sandbox, next to Agent Runner.
- It starts from the fixture's definition and verifies delivery from outcomes (`lib/candidate.mjs`).
- It freezes the source, builds and verifies the product (`lib/candidate-verification.mjs`), serves it (`lib/candidate-server*.mjs`), runs deterministic browser probes (`lib/browser-eval.mjs`, `lib/axi-browser-driver.mjs`), and judges the product with the shared panel (`evals/lib/panel-judging/`, `lib/judge-jobs.mjs`, `lib/second-opinion.mjs`, `lib/scorer.mjs`).
- It hands off to `human-review.sh`.
- `--rescore-from <run> --host` runs the same evaluator on the host.

Much of and-scene's product scoring is hard-wired to the reference:
- The rubric validator encodes and-scene's component policy, gate set and judge job names (`lib/rubric.mjs`).
- Judge requirement text comes from the fixture change's `specs/**/spec.md` (`lib/neutral-source.mjs`, `criterionRequirement` in `lib/judge-jobs.mjs`, `SNAPSHOT_DIR`).
- The browser probes assume the reference's route, nine step titles and captions, and DOM hooks (`lib/demo-contract.mjs`, `lib/browser-eval.mjs`, `lib/axi-browser-driver.mjs`).
- The publication path, branch naming and `loadRubrics()` paths are module constants.
- No Git bundle of the candidate is retained; rescores re-clone from GitHub.

Agent Runner `main` provides `openspec:change` v3 (`workflows/openspec/change-v3.0.yaml`):
- **Top-level steps:** `validate-feature-branch`, `create`, `define`, `implement`, `accept`, `archive`, `finalize`. The only parameter is `change_name`, and `skip_validator` is hard-coded `"false"`.
- **define:** five interactive sub-steps (`proposal`, `specs`, `design`, `test-plan`, `approach-review`) on the `lead` session, with `crosscheck` children through `call_agent`. Its artifacts are left uncommitted.
- **implement** (`core/implement-change-v2.0` → `core/verify-change-v1.0`) is entirely autonomous:
  - It commits the definition and implements against an audited checklist.
  - It runs Agent Validator, pushes with `git push --set-upstream origin <branch>`, and opens a draft PR with `gh pr create --draft`.
  - It runs up to three tester acceptance rounds (`acceptance-tester` session, role `tester`), which push follow-up commits.
- **`--until`** is inclusive.
  - A capped stop exits 0 and logs `run_end` with `completed:false`, and `state.json` keeps `currentStep.stepId` with `completed:true`.
  - `agent-runner --resume <id> --until implement` continues a run that was capped at `define`.
  - The external-user setting is persisted in `state.json`. Passing `--external-user` again on `--resume` is rejected.
- **Sandbox:** each `sandbox-run.sh` invocation is a fresh `docker run --rm`. Run state survives only through `/artifacts`, which the define suite's `prepare-agent-session-state.sh` symlinks into.
- **Image:** the sandbox image includes `agent-validator`, `gh`, `claude` and `codex`.
- **Validator reviews:** the starting tree's `.validator/config.yml` reviews with the `claude` CLI.

## Goals / Non-Goals

**Goals:**
- One host-controlled run, starting from the define suite's prompt and tree and ending at a draft PR in a fresh, private, per-run repository.
- A define checkpoint before implementation, so that leaks, reconciliation failures and define-phase contamination stop the run before implementation is paid for.
- Product scoring with a from-prompt rubric whose fixture-owned criteria are judged against the hidden inventory, never against reference preferences or the candidate's own definition.
- Reuse of and-scene's calibrated product-scoring engine and the define suite's simulated user, audits and definition scoring, without changing either suite's behavior.

**Non-Goals:**
- Factory and Fly execution, or a control arm.
- The top-level `accept`, `archive` and `finalize` steps.
- Changes to the starting prompt, tree, inventory or policies.
- Agent Runner changes. None are needed: `--until`, resume after a cap, and persisted external-user mode already exist.
- Deleting delivery repositories automatically. They are kept for rescore and review, and the runbook documents manual deletion.

## Approach

### Components

```
evals/agent-runner/and-scene-e2e/
  run.sh                 entry point; --calibrate goes to calibrate.mjs, all else to controller.mjs
  controller.mjs         host lifecycle (phases below), argument parsing, help
  human-review.sh/.mjs   completes pending runs, then publishes
  compare.mjs            groups runs by series and candidate, compares groups with noise bands
  calibrate.mjs          product-rubric calibration diagnostic
  sandbox-driver.sh      in-sandbox entry (fresh | resume), push-capable variant of the define driver
  product-rubric.json    from-prompt product rubric (70 automated points)
  preference-values.json reviewed list of preference-only concrete values
  contamination-patterns.json  define list + e2e additions
  versions.json          pins: define-suite hidden inputs, rubrics, patterns, by version and hash
  calibration/           reference pin, preference-shifted and degraded variants as patches
  lib/                   e2e-owned modules (listed below)
  results/               published runs
```

E2e-owned modules in `lib/`:
- `provisioning.mjs` creates and verifies the GitHub App repository, and mints and refreshes the token.
- `workflow.mjs` resolves and checks the workflow.
- `delivery.mjs` handles remote-only delivery verification, the bundle and acceptance-evidence retention.
- `requirements.mjs` builds the inventory-based requirement source.
- `product-rubric.mjs` validates the e2e rubric.
- `product-evaluation.mjs` holds the product phases.
- `build-plan.mjs` resolves how to build and serve the delivered application.
- `browser-judging.mjs` runs the LLM browser judges and replays their passes.
- `trace.mjs` builds the requirement trace.
- `metrics.mjs` handles workflow metrics.
- `result.mjs` and `report.mjs` assemble the result and the report.
- `publication.mjs` publishes.
- `outcomes.mjs` defines the statuses.

### Shared code moved to `evals/lib/`

The move is done in a preparatory PR with no behavior change (see Migration Plan). Each existing suite imports from the new location, and its data stays in place.

- `evals/lib/define-run/`: from `and-scene-define/lib/`, unchanged except for added parameters. It contains:
  - simulated user, responder, responder files, simulated-user inputs, reconciliation;
  - canary, contamination, transcripts, evidence collection, mount plan;
  - starting-repo materialization, sandbox, Runner state;
  - checkpoint, persistence, files;
  - definition judge jobs, judge invoker, judging phases, gates, scoring, rubric, inventory.

  Added parameters, each defaulting to today's value:
  - `suiteRoot` for hidden inputs and the rubric (already present in `judging.mjs`);
  - an invocation filter for `collectEvidence`, which today uses `effectiveDefineInvocations`;
  - the staged-file allowlist and extra mounts for `LocalSandbox`;
  - the accepted workflow-file pattern for the Runner-state reader.
- `evals/lib/product-scoring/`: from `and-scene/lib/`, with injection points. It contains:
  - judge jobs and settlement, second opinion (including its replay executor), scorer;
  - evidence and judge views (the parts the product phases use);
  - candidate verification and candidate server (host);
  - axi browser driver primitives and host browser;
  - the human-review interview and Runner-activity stall detection;
  - full-workflow Runner metrics ingestion and pricing.

  What can be injected, with and-scene passing its current constants:
  - the rubric object and its validator policy (and-scene's `COMPONENT_POLICY`, gate and replaced/removed counts, legacy IDs and `OUTLINE_GATE_INPUTS` move into an and-scene policy object);
  - the job list and briefs (`PRODUCT_JUDGE_JOB_IDS`, `JOB_BRIEFS`, `JUDGE_INPUT_POLICIES`);
  - the criterion-requirement resolver (replacing the global `SNAPSHOT_DIR`);
  - the requirement-document source (replacing `requirementSource()`);
  - criterion and gate special cases in second opinion and the scorer, passed as a policy;
  - the browser contract and probe set (e2e passes none), and the replay expectation set;
  - the verification command list;
  - delivery naming (repository, branch, change directory), and a remote-only delivery mode that never runs Git in a workspace;
  - the publication results directory.

and-scene-specific browser probes, `demo-contract.mjs`, `deterministic-checks.mjs` and the controller stay in and-scene.

### Lifecycle

`controller.mjs` runs phases in order with durable per-phase and per-unit checkpoints, in the same pattern as the define controller (`run-state.json`, `beginUnit`/`completeUnit`/`verifyUnit`, a controller lock, and a symlink guard on every run path).

1. **preflight**
   - Checks profiles (explicit for every role through implement; `lead` must be claude or codex; `cursor` only for crosscheck).
   - Checks the workflow: it reads the workflow definition from the clean Runner checkout, requires the top-level `create`, `define` and `implement` steps and the five define sub-steps, and records the reference, reported name and hash.
   - Checks clean Runner and Skills checkouts, Runner capabilities, and the `codagent:*` skills the workflow names.
   - Checks auth for every role CLI, for the Validator reviewer CLI (parsed from the starting tree's `.validator/config.yml`), and for the simulated-user and judge CLIs.
   - Checks Docker, and the App provisioning credentials and their reach (see Delivery repository).
   - Checks that every pinned input matches `versions.json`, and that the run directory is unused unless resuming.
   - It then stages the sandbox input and checks the `--dry-run` sandbox plan against the mount allowlist, then runs the canary scan.
2. **provisioning**: create, seed and verify the delivery repository, and mint the first token. A resume verifies that the recorded repository still exists and skips creation.
3. **materialization**: as in the define suite (bundle of the starting tree, tree hash recorded).
4. **define-workflow**
   - Starts the sandbox with `fresh` mode: `agent-runner run <workflow> --external-user /artifacts/exchange --until define --param change_name=add-presentation-skill`.
   - The host responder answers, as in the define suite. The token refresher runs, along with the elapsed-time and stall watchdogs.
   - Success means the sandbox exits 0 and Runner state shows `define` completed and the run not completed.
5. **definition-collection**
   - Copies `openspec/changes/add-presentation-skill/` from the sandbox workspace as plain files, with the symlink guard, and records file hashes.
   - Reads HEAD with Git in a throwaway container of the kind the build plan uses (see Product evaluation), over a copy of the workspace repository, never with host Git: the workspace's `.git/config` was written by the evaluated agents, and repository-local settings such as `core.fsmonitor` run commands.
   - Writes the define evidence snapshot (Runner evidence, define-phase transcripts) to `evidence/define/`. It is hashed into the manifest and never rewritten.
6. **define-checkpoint**, which runs three units in order and stops on the first failure:
   - **reconciliation** (unchanged module). A failure is `evaluation-harness-failed`.
   - **contamination pass 1**, over invocations whose top-level step is `create` or `define` (or earlier). A match makes the run `contaminated`, not resumable.
   - **disclosure audit** (unchanged panel and settlement). Any item settled as leaked, after the decider and checks, makes the run `evaluation-harness-failed` with `owning_phase: disclosure-audit`, `resumable: false`, no score and no publication. Withholding and contradiction flags are report-only.
7. **implement-workflow**
   - Starts the sandbox with `resume` mode: `agent-runner --resume <runner-run-id> --until implement`, with no `--external-user` flag.
   - The responder runs in watch-only mode. Any `*.request.json` gets an abort reply, and the run ends `evaluation-harness-failed`, naming `request.step`.
   - The token refresher and watchdogs run.
8. **delivery-verification**, which also retains the bundle and the acceptance evidence.
9. **contamination pass 2**: collects every evaluated transcript into `evidence/final/` and rescans them, including whole sessions that continued from define. A match makes the run `contaminated`, with no score.
10. **definition-scoring**: the define suite's `gates-and-judging` and `discovery` units over the collected copy and `evidence/define/`, with `leaked: []`, since a leak would already have failed the run.
11. **product-evaluation**: the host phases build-plan, verification, candidate-server, browser-judging (with replay), product-judging (with second opinions and fallbacks) and ambiguity diagnostics (see Product evaluation).
12. **requirement-trace**
13. **metrics**: Runner `run-metrics.json`, accumulated across both invocations, ingested by the shared full-workflow ingester and grouped by top-level step (the first `prefix` segment) and role. Eval-owned usage stays in `phases/eval-owned-usage.jsonl`.
14. **result-and-report**
15. **handoff**: the run becomes `pending-human-review` when the product built and served. If it did not, the human component is 0 with the reason, and the run is `complete` and published.

`human-review.sh --run-dir <dir>` does the rest:
- It restarts the host candidate server from the build output the build plan recorded.
- It runs the shared interview with `human-rubric.json` from and-scene, pinned by hash. The rubric's `floor` and `min_individual_rating` are reported and not applied.
- It writes the official result and report, sets `complete`, and publishes.

When the workflow fails after `define` completed, definition scoring still runs, and its score and trace (with `delivery-unavailable` for every defined item) are reported.

### Sandbox driver and environment

`sandbox-driver.sh` is the define driver with these differences:

- **In `fresh` mode,** after cloning the starting bundle it sets `origin` to `https://github.com/Codagent-AI/<repo>.git` and checks out `add-presentation-skill`. It verifies that there is one commit and that `origin` is the only remote. The remote exists from the first invocation, so `validate-feature-branch` takes its remote path and `gh repo view` succeeds.
- **GitHub auth** comes from a read-only mount `/github-auth` holding only a `token` file.
  - The driver installs `/tmp/e2e-bin/gh`, a wrapper that sets `GH_TOKEN` from the file on each call and execs the real `gh`, and puts it first on `PATH`.
  - It sets the repository-local `credential.helper` to a script that prints the token from the same file.
  - It unsets every inherited GitHub token variable.
  - `gh` must not be pointed at a read-only `GH_CONFIG_DIR`, because it fails rewriting `hosts.yml`. This was verified with `gh` 2.88.1.
- **Global and system Git config, and hooks,** stay disabled as in the define driver.
- **Validator reviewer auth:** `LocalSandbox.args` always adds the mount for each Validator reviewer CLI (today `--mount-claude-auth`, falling back to `CLAUDE_CODE_OAUTH_TOKEN` by name), whatever the role profiles are.
- **Extra mount:** `<runDir>/.github-auth:/github-auth:ro` is passed through `--docker-run-arg`.
- **Mount check:** `verifyMountPlan` allows exactly these two additions beyond the define suite's set.

### Delivery repository and token

- **One-time setup:** a GitHub App installed on Codagent-AI with "Only select repositories" and none selected.
  - Repository permissions: Administration write, Contents write, Pull requests write, Checks read, Commit statuses read, Metadata read. There is no Workflows permission, so a candidate cannot push `.github/workflows/`.
  - Organization permission to create repositories.
  - GitHub grants an App access to the repositories it creates, so the installation only ever reaches delivery repositories.
  - The host supplies `AND_SCENE_E2E_APP_ID` and `AND_SCENE_E2E_APP_KEY_FILE`.
- **Minting:** `provisioning.mjs` signs an RS256 App JWT with Node `crypto` (no new dependency), resolves the Codagent-AI installation, and mints installation tokens.
  - **Provisioning token:** unrestricted within the installation and used only on the host.
  - **Run token:** `repositories: [<repo>]` with Contents write, Pull requests write, Checks read, Statuses read and Metadata read.
  - Tokens are never logged, never written under the run directory except `.github-auth/token` (mode 0600, removed after each invocation), and never retained in evidence.
- **Preflight reach check:** it lists the installation's repositories and fails if any name lacks the `e2e-run-` prefix.
- **Creation:** `POST /orgs/Codagent-AI/repos` creates `e2e-run-<run-id>`, private, with issues, projects and wiki disabled. The name matches no contamination pattern, and preflight asserts this against the pinned list.
- **Seeding:** the host pushes the materialized starting commit to `main` using a `GIT_ASKPASS` helper that reads the provisioning token from the process environment.
- **Verification:** all refs equal `refs/heads/main` at the starting commit, with zero pull requests and zero issues. The repository's full name, id and creation time are recorded in `run-state.json` and the result.
- **Refresh:** while a sandbox invocation runs, the controller re-mints the run token every 30 minutes and atomically replaces `.github-auth/token`. A bind-mounted directory sees the rename.

### Delivery verification and retention

`delivery.mjs` runs on the host and never runs Git against the sandbox workspace. It uses the shared `verifyCandidateDelivery` in its remote-only mode, with the repository, branch `add-presentation-skill`, base `main` and change directory injected:
- It creates a private bare repository under the run directory with a harness-written config, and fetches `main` and the branch from the delivery repository's explicit HTTPS URL, using the provisioning token through `GIT_ASKPASS`.
- Through the API, it checks for exactly one PR for the branch, open and draft, whose base is `main` and whose head equals the fetched branch head.
- In the bare repository, it checks that `openspec/changes/add-presentation-skill/` is present and unarchived at that commit.
- It copies the acceptance artifacts from the Runner session `output/` under `/artifacts` as plain files with the symlink guard, checks them with and-scene's readiness check, and writes them to `evidence/final/acceptance/`, recorded against the delivered commit with their hashes.

It then writes `source/candidate.bundle`, containing `main` and the branch, with its SHA-256 recorded in the evidence manifest. Every later phase clones from this bundle or reads the retained acceptance evidence; GitHub and the sandbox runtime files are not read again.

One rule covers prohibited effects. The PR marked ready, merged or closed, the branch deleted, or the change archived at the delivered commit each mean a required outcome is missing. The run ends `implementation-workflow-failed`, naming the outcome, and the effect is also recorded as a prohibited effect. Any other branch or PR in the repository is reported and does not change the status.

### Contamination patterns and audit evidence

- **Patterns:** `contamination-patterns.json` holds the define list plus `and-scene-e2e`, e2e-only hidden paths (`product-rubric.json`, `preference-values.json`, `calibration/`) and the e2e staged-input path. It is versioned in `versions.json` and part of the series identity.
- **Evidence:** `collectEvidence` takes an invocation filter and an output directory, and the e2e controller calls it once per pass. Pass 1 uses invocations whose first `prefix` segment is at or before `define` and writes `evidence/define/`; pass 2 uses all invocations and writes `evidence/final/`. Neither overwrites the other.
  - Every evaluated invocation must have a complete transcript, or the run is `evaluation-harness-failed`.
  - Validator reviewer CLI sessions are not invocations in `run-metrics.json`, so they are not collected. Their output reaches the audit through the invoking agent's tool-call output.
- **Delivery-repository calls:** calls naming the run's own delivery repository are not matches. The repository name avoids every pattern, so in practice this rule only documents intent.

### Product evaluation (host)

- **Requirement source:** `requirements.mjs` turns each `mandatory` and `acceptable-alternative` inventory item into one requirement document: id, class, statement, intent, and the `quote` of each of its `sources`. Whole hidden-reference sections never enter a document, because a requirement section can hold items of different classes (for example, the fixed-canvas section holds both the scaling alternative and the 880 × 380 preference).
  - For an `acceptable-alternative` item the document says that the intent takes precedence over any mechanism its quotes describe.
  - These documents replace the fixture `specs/**/spec.md` snapshot as `neutral/judge/requirements/`.
  - The criterion-requirement resolver returns, for a fixture-owned criterion, the concatenated documents of its cited items, and for an eval-owned criterion its reason.
  - Preference items never enter a judge packet. The candidate's collected definition enters only the testing-evidence and assumption-handling packets, as the approved requirements those jobs judge against, as in and-scene. Define misses are scored once, by the definition score and the trace.
  - The candidate's `openspec/changes/` stays excluded from the source snapshot as in and-scene.
- **Rubric:** `product-rubric.json` reuses and-scene's schema with these changes:
  - `criterion_sources[id]` becomes `{owner: "fixture", inventory: ["INV-..."]}` or `{owner: "eval", reason, presumes: ["INV-..."]}`.
  - `exclusions` lists inventory items deliberately left ungraded, each with a reason and the reviewer who approved it.
  - There are no `pass_threshold`, `automated_pass_threshold` or component `floor` fields.
  - Every criterion carries an importance tier and earns its component's tier weight, under and-scene's 15.0.0 tier rules (no weight above 2 points).
  - Calibration tolerance, spread and flip-rate limits are declared, as is `max_requirement_chars`, and there is a `provisional` flag.
  - Its 70 automated points start from and-scene's split: product technical quality 20, demo technical quality 20, then 7, 7, 8, 4 and 4.
  - It declares four gates: whole app builds; sample presentation explaining the skill exists and is reachable; every produced step renders; verifier reports a clear outcome.
  - Criteria that already grade intent carry over. Preference-encoding criteria are rewritten to their intent. The scope-discipline criterion cites the scope-exclusion items INV-105 to INV-108 instead of judging "requested scope", since judges never see the define conversation.
- **Rubric validation:** `product-rubric.mjs` validates:
  - every fixture-owned criterion and gate cites at least one mandatory or alternative item and no preference item;
  - every eval-owned criterion has a reason, and its `presumes` list holds no preference item (for example, criteria about bootstrap scripts or an out-of-scope section must list the items they assume);
  - every mandatory item is cited by some criterion or gate or is in `exclusions`, and an alternative item is uncited only through `exclusions`;
  - no wording or guidance contains a `preference-values.json` value unless a cited mandatory or alternative item's quote also contains it;
  - each criterion's requirement text fits `max_requirement_chars`, which sits below and-scene's 40,000-character requirement-document limit;
  - every browser criterion has a fallback source-review job;
  - tiers, weights and point sums are correct;
  - there is no threshold or floor.

  `preference-values.json` is maintainer-reviewed, and a script checks that each value occurs in a preference item's quote. INT-008 runs validation against the real inventory's mixed sections.
- **Build plan, in a container:** `build-plan.mjs` never assumes `npm ci`, `npm run build` or `dist/`. In a throwaway container from Agent Runner's sandbox image, with no credentials, no auth mounts, no network after install, and only a copy of the bundle-cloned worktree mounted, it:
  - finds the application root: the package that depends on `vite` and has a build script, at the root or in a workspace the root manifest names;
  - picks the package manager from the lockfile and installs;
  - runs the build, and takes as the output the directory where the build wrote an `index.html`.

  When no single application root or output can be determined, the product is "not evaluable": the run is `evaluation-harness-failed`, resumable once the resolver is fixed, with no product score. When the determined build fails, it is a conclusive product failure: the build gate fails, every browser-dependent criterion scores 0 with no fallback judging, and the human component is 0. The plan (root, commands, output) is recorded and reused by rescore and human review.
  - The verifier command is named by the source-review judge from the delivered skill and package scripts, and run in the same container.
- **Serving:** the shared host candidate server serves the recorded output directory as static files with SPA fallback.
- **Browser judging:** `browser-judging.mjs` runs LLM browser judges that operate the served product through `chrome-devtools-axi` as a person would.
  - Each job receives the criterion's requirement text and the served URL. It is told no route, step count, step title, era or canvas size.
  - The judge finds the presentations and the sample, steps through them with the product's own controls (keys, buttons, swipes), and returns a verdict per criterion.
  - For each pass, it returns a replay: the browser actions it took and the results it expected, in second opinion's closed replay schema. E2e injects an expectation set without and-scene's demo-contract hooks: `selector-visible`, `selector-hidden`, `text-present`, and two new variants, `rendered-state-changes` and `rendered-state-matches <label>`, which compare DOM-and-screenshot fingerprints.
  - Jobs use the shared panel and settlement. A settled pass counts only when the replay executor, in a fresh browser context, reproduces a passing judge's expected results; each passing judge's replay is tried in turn, and if none reproduces, the criterion fails with the mismatch recorded.
  - A settled fail goes to the usual replay-based second opinion.
  - A criterion whose evidence no judge could locate goes to its fallback source-review job, where an unconfirmed browser fallback pass fails.
  - The result marks each browser criterion replay-confirmed or fallback-judged.
  - The Mac runs one Chrome job at a time, so browser judges run serially, and product evaluation, rescores and human review never overlap in a session.
- **Judging:** the shared panel, settlement, second opinions, source audits, dissent and overrule checks, and fallback judges, with the e2e job list and briefs.
  - Missing evidence or an exhausted judge job means `evaluation-harness-failed`, resumable.
  - A `packet-overflow` failure, which is deterministic and would recur on resume, marks only that job's component incomplete; the other components are scored.
  - Gates are reported and never change the score.

### Requirement trace

`trace.mjs` joins three inputs:
- the define suite's discovery `asked.json` (asked);
- the definition score's coverage verdicts (defined);
- the product criterion verdicts mapped through `criterion_sources[].inventory` (delivered: all pass, some pass, none pass, not graded, or unavailable).

It assigns each item exactly one outcome, following the spec's table, names any criterion an item shares with other items, and changes no score. The result shows the definition and product scores separately and never a combined total.

### Watchdogs

- **Elapsed-time limit:** one whole-run limit with a default of 12h of active time. The controller accumulates the time each sandbox invocation runs, persists the total, and gives a resumed invocation only the remainder. Time between an interruption and its resume does not count.
- **Stall:** the shared Runner-activity detector watches the run store, CLI transcripts and worktree, with a default window of 45 minutes, persisted.
- **Quota:** the and-scene narrow recovery applies to evaluated invocations. Only an identified Claude limit event with an explicit UTC reset within six hours is waited for, outside the active-time count, and then resumed. Any other 429 or ambiguous quota evidence is a normal resumable failure or a stall.
- **Outcome:** either watchdog stops the sandbox, then reads Runner state to name the last active step.
  - The status is `definition-workflow-failed` or `implementation-workflow-failed`, by whether `define` completed.
  - The time limit is not resumable; a stall is resumable.

### Resume and rescore

- **Resume:** `--resume --run-dir <dir>` verifies the recorded identity, series, candidate, profiles and delivery repository, reuses every proven unit, and dispatches the sandbox with the `--until` of the phase it was in.
  - A run interrupted before `define` completed resumes with `--until define`, then runs definition collection and the define checkpoint before any implement invocation.
  - A run past the define checkpoint resumes with `--until implement`. It refuses if a container for the run is active or more than one Runner run exists.
  - Runs that are contaminated, leak-failed or timed out are not resumable.
  - A publication failure resumes publication only.
- **Rescore:** `--rescore-from <run> --run-dir <new>` verifies the retained manifest hashes (collected definition, conversation, `evidence/define/`, `evidence/final/` including acceptance evidence, bundle, build plan). It then reruns, under current evaluator inputs: reconciliation, both contamination passes, the disclosure audit, definition scoring, product evaluation from the bundle, and the trace.
  - It never starts Runner or reads GitHub, and is never published.
  - It records the current series identity and the source's series identity and candidate.

### Calibration

`calibrate.mjs` judges, `--repeats` times each (three by default, at least one), all inputs or only those `--inputs` names:
- the pinned reference (and-scene `REFERENCE_REF`, read from a retained bundle under `calibration/`);
- the reference with `calibration/preference-shifted.patch` (route, step count, step titles, canvas size) and with `calibration/preference-shifted-chrome.patch` (attribution text and placement, mode-toggle key, opening mode), each keeping mandatory and alternative behavior and every page hook the reference's own verification reads (such as `data-step-count`);
- degraded variants, each a patch removing named mandatory behavior. Each is judged only on the subcomponents holding the criteria it is expected to fail, plus the source job its browser criteria fall back to, since a full pass costs about an hour of judging.

It reports per-input scores and spread, accuracy against expected verdicts, each criterion's verdict flip rate across repeats, decider reversals, tolerance failures, and the provisional status. It is never published.

The `provisional` flag is cleared only after calibration passes and the first live candidate run has been rescored with identical inputs, with differences attributed per criterion by `and-scene/scripts/compare-rescores.mjs`.

### Comparison

`compare.mjs` groups scored runs by series identity and candidate, and reports each group's mean, standard deviation and worst repetition for the definition and product scores, and its mean trace counts. Two groups in one series are compared only when each has at least three scored repetitions, using the same/leaning/clear bands from and-scene's `lib/experiment-comparison.mjs`. A smaller group is labelled a screen.

## Decisions

- **Host controller, with only the evaluated workflow in Docker.** The simulated user, audits and judges must stay outside the evaluated environment, as in the define suite. Product evaluation also runs on the host, by Paul's choice, which keeps one controller process and one run directory. Untrusted candidate commands are confined to a throwaway build container instead.
- **One Runner run, two capped invocations.** These Runner behaviors are already supported, so no Agent Runner change is needed: resume after a capped stop, `--until` on resume, and the persisted external-user mode. The pause gives the define checkpoint a clean point to stop the run before implementation.
- **Remote and token from the first invocation.** `validate-feature-branch` takes a different path when no remote exists, and the PR target must be the delivery repository. Adding the remote later risks a base-branch mismatch.
- **GitHub App on Codagent-AI, with no repositories selected.** Fine-grained PATs cannot be minted by API, and installation tokens can be restricted to one repository. Selecting no repositories means the App only reaches repositories it creates, and preflight enforces that. Hourly expiry is handled by host refresh through a file.
- **Token through a file plus wrapper, not `GH_CONFIG_DIR` or an environment variable.** A container's environment cannot be refreshed, and `gh` fails on a read-only config directory.
- **Shared engine, suite-owned checks.** The generic parts of and-scene's calibrated judging move to `evals/lib/product-scoring/` behind injection points. Everything reference-shaped (rubric policy, probes, briefs, demo contract) stays with its suite. This is the smallest change that lets both suites share fixes without duplicating about 10k lines.
- **The define suite's modules move unchanged.** E2e needs them identically, which satisfies the repository rule for sharing. Their data stays in `and-scene-define/`, and e2e pins it by hash so a change there starts a new e2e series.
- **Bundle retention.** Rescore and human review must work after the delivery repository is gone, and the bundle is the authoritative delivered commit.
- **Cursor only for crosscheck.** Complete transcripts are required for the audit, and the transcript reader supports Cursor only for crosscheck.
- **LLM browser judges, confirmed by replay.** Presentations in a from-prompt product can sit on any route with any controls, so fixed probes cannot find them. Judges operate the product as a person would, and code replays every claimed pass, so a judge cannot pass a criterion on something it did not see. This keeps replay, the only mechanism that has overturned false gate verdicts in and-scene. A crawler in plain code was rejected because it can detect only that a page changes, not what it shows.
- **Remote-only delivery verification.** Host Git never touches the agent-written workspace repository. The delivered commit is what was pushed, so the remote is the authoritative source anyway.
- **Requirement text from quotes, not sections.** Reference sections mix item classes, so quotes are the only way to keep preferences out of judge packets.

## Risks / Trade-offs

- **Regressing and-scene during the extraction.** Mitigations:
  - a separate behavior-preserving PR, merged first;
  - before refactoring, record golden outputs of rubric validation, settlement replay, scoring and result assembly for several retained and-scene runs, then require byte-identical outputs afterwards;
  - `npm run check`, the candidate real-browser suite (run on the base commit first), and the adversarial suite once at the end;
  - extract only what e2e uses.
- **App reach.** If GitHub does not grant the App access to the repositories it creates (the documentation found is for Enterprise Server), the first live provisioning fails the reach or creation check. The fallback is to add each repository to the installation through the installation-repositories API after creation, with the same preflight check.
- **Token handling.** The run token is readable by evaluated agents, which is accepted: it reaches only their own repository, and the residual-risk statement records it. The token is never logged or retained.
- **Candidate code on the Mac.** Only the throwaway build container executes candidate commands. Chrome renders the served build output in its own sandbox.
- **Hung or long runs.** The 45-minute stall window and 12h limit bound the cost. Stalls stay resumable.
- **Browser-judge variance and time.** Browser judges are a model step on about a fifth of the automated points. Replay confirmation catches false passes; per-criterion flip rates in calibration, and the identical rescore of the first live run, measure the rest. Serial Chrome jobs lengthen each evaluation.
- **Build-plan resolver gaps.** An unusual but valid layout may not resolve. That is reported as "not evaluable", a harness failure to fix and resume, never as a zero score.
- **Variance and single fixture.** Comparisons need at least three repetitions per arm, and single runs are screens. Results generalize only as far as one feature.
- **Calibration.** Rewritten criteria start provisional, and results say so until a maintainer approves the rubric from calibration.

## Migration Plan

1. **PR 1, extraction with no behavior change:**
   - Move the define-suite modules to `evals/lib/define-run/`.
   - Move the and-scene engine to `evals/lib/product-scoring/` with injection points.
   - Mount `evals/lib` for and-scene's in-sandbox controller instead of only `panel-judging`.
   - Add the golden-output tests, then run `npm run check` and the real-browser suites.
2. **PR 2, the e2e suite:** controller, driver, provisioning, delivery, rubric and validator, requirement source, trace, report, human review, compare, calibration, tests in the existing test suite, the runbook, and the root `AGENTS.md` section.
3. **One-time setup:** create the GitHub App with the permissions above and install it with no repositories selected. Then run a dry run, and a first paid run to confirm App reach, token refresh and delivery. The runbook documents how a maintainer deletes retained delivery repositories by hand.

Rollback: PR 2 is additive. PR 1 can be reverted on its own, since nothing outside the two suites imports the moved modules.

## Open Questions

None. Browser discovery was settled in approach review: LLM browser judges with replay confirmation.
