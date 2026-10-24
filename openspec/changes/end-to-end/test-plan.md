## Coverage Strategy

Specifications remain the source of unit-test requirements. This plan records only:
- additional integration and end-to-end obligations;
- the acceptance testing envelope;
- exceptional human-only obligations.

**Automated tests:** they are added to the existing `node --test` suite as new `test/and-scene-e2e-*.test.mjs` files, and run by `npm run check` and CI.
- They follow the define suite's lifecycle-test pattern: a fake sandbox, temporary run directories, and real git.
- External boundaries that CI cannot reach are replaced by controlled local substitutes: a local fake GitHub REST server, local bare Git remotes, a stub `agent-runner` and `gh` on `PATH`, and fake judges.

**Real Docker, real GitHub, real models and real Chrome** are exercised by the acceptance pass's live run and by the manual real-browser suites, not by CI.

**Not tested:**
- Prompt, brief or skill text. No test asserts prompt contents.
- The quality of LLM browser judges' verdicts. Calibration (INT-011, HT-003) and the identical rescore of the live run measure it; tests cover the replay and settlement mechanics around them (INT-012 and the real-browser cases).

## Integration Tests

### INT-001: Extraction preserves the existing suites
- Covers: proposal "Shared code" (moving code into `evals/lib/` without changing `and-scene` or `and-scene-define` behavior); design Migration Plan step 1.
- Boundary: and-scene's rubric validation, settlement replay, scoring and result assembly, and the define suite's modules, all through their new `evals/lib/` locations.
- Setup: before the refactor, record golden outputs from several retained and-scene runs under `test/fixtures/`, from their recorded judge records and phase artifacts: rubric validation output, settlement replay, `score.json`, and the assembled result.
- Action: rerun the same computations through the extracted modules with and-scene's policy objects.
- Assertions:
  - The outputs are byte-identical to the goldens.
  - Every existing `and-scene-*` and `and-scene-define-*` test passes unchanged.
- Execution: `test/and-scene-e2e-extraction.test.mjs`; `npm run check`.

### INT-002: Sandbox driver wires the delivery remote and refreshable token
- Covers: Per-run delivery repository (only remote; token reaches only that repository); Workflow execution and stop points (two capped invocations; resume without `--external-user`); evaluation-isolation Simulated-user boundary.
- Boundary: the real `sandbox-driver.sh` under bash, with real git, a stub `agent-runner` and the driver's real `gh` wrapper and credential helper over a stub `gh` binary.
- Setup:
  - a temporary `/artifacts`-like directory and a starting bundle;
  - a dummy token file in a read-only directory;
  - inherited `GH_TOKEN`, `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN` set to sentinel values.
- Action:
  1. Run the driver in `fresh` mode.
  2. Replace the token file mid-run.
  3. Run the driver in `resume` mode.
- Assertions:
  - The workspace has one commit on `add-presentation-skill`, and `origin` is the delivery URL and the only remote.
  - The stub `gh` and git credential requests receive the current file's token on each call, and the replaced value after replacement.
  - The sentinel variables never reach the stub `agent-runner`.
  - Fresh argv is `run <workflow> --external-user /artifacts/exchange --until define --param change_name=add-presentation-skill`.
  - Resume argv is `--resume <id> --until <phase>`, with the phase the controller passes (`define` or `implement`), and no `--external-user`.
  - No token value appears in any log written by the driver.
- Execution: `test/and-scene-e2e-driver.test.mjs`; `npm run check`.

### INT-003: Sandbox mount plan admits exactly the e2e additions
- Covers: evaluation-isolation Simulated-user boundary; Preflight.
- Boundary: the shared mount-plan verifier against `sandbox-run.sh --dry-run` output shapes.
- Setup: recorded dry-run outputs:
  - a plan with the define suite's allowed set plus the Validator reviewer's Claude auth (or `CLAUDE_CODE_OAUTH_TOKEN` by name) and `<runDir>/.github-auth:/github-auth:ro`;
  - variants adding one extra host path, a writable token mount, or another environment variable.
- Action: run preflight's mount verification on each plan.
- Assertions:
  - The e2e plan passes.
  - Each variant fails with `evaluation-harness-failed`, naming the path or variable.
  - The Validator reviewer auth is planned even when every role profile uses `codex`.
- Execution: `test/and-scene-e2e-sandbox-plan.test.mjs`; `npm run check`.

### INT-004: Repository provisioning and token minting
- Covers: Per-run delivery repository; Preflight (provisioning credentials and their reach); evaluation-isolation Pinned contamination patterns (delivery repository name).
- Boundary: `provisioning.mjs` over HTTP to a local fake GitHub REST server, and git over a local bare remote that stands in for the created repository.
- Setup: a test RSA key and App id, and a fake server implementing these routes with programmable state:
  - installation lookup;
  - installation repository listing;
  - organization repository creation;
  - access-token minting;
  - ref, pull and issue listing.
- Action:
  1. Run preflight's reach check.
  2. Provision, seed and verify a repository.
  3. Mint run tokens and run the refresher.
  4. Repeat with a reachable non-`e2e-run-` repository, a pre-existing extra ref, an open PR, an issue, and a repository name that matches a contamination pattern.
- Assertions:
  - The JWT verifies with the test public key.
  - The created repository is private, named `e2e-run-<run-id>`, and holds only the starting commit on `main`.
  - Each bad state fails before any evaluated model call, with `evaluation-harness-failed` naming the repository, content or pattern.
  - The run-token request lists exactly one repository and exactly the designed permissions.
  - The refresher atomically replaces `.github-auth/token` before expiry.
  - After the invocation, no token value exists in the run directory, logs, evidence, `run-state.json` or the result.
  - A resume reuses the recorded repository and creates none.
- Execution: `test/and-scene-e2e-provisioning.test.mjs`; `npm run check`.

### INT-005: Two-stage lifecycle, define checkpoint and watchdogs
- Covers: Workflow execution and stop points; Define checkpoint; Elapsed-time limit; Stalled workflow; Durable checkpoints and resume; Evaluation status and scores; simulated-user Disclosure audit (end-to-end leak rule); evaluation-isolation Contamination audit (first pass) and Conversation reconciliation (at the checkpoint).
- Boundary: `controller.mjs` with a fake sandbox that writes Runner state, audit logs, `run-metrics.json`, transcripts and exchange files into the real run-directory layout, plus the real responder over the exchange directory.
- Setup: fake judges that return programmed disclosure, definition and product records; fake provisioning; fake delivery verification where not under test.
- Action: run fresh and resumed evaluations through these scenarios:
  - the happy path to the pending result;
  - a leaked item;
  - a reconciliation mismatch;
  - a first-pass contamination match;
  - a `*.request.json` written during implement;
  - the elapsed limit reached during define and during implement;
  - a stall during define and during implement;
  - a stall after ten hours of workflow time, resumed after a simulated overnight gap;
  - a Claude limit event with an explicit reset two hours away, and a 429 with no reset;
  - an over-disclosure flag from one judge alone that the decider rejects;
  - a controller interruption at each workflow phase, including during define, then `--resume`.
- Assertions:
  - The define invocation completes before any implement dispatch, and the checkpoint units run in the order reconciliation, contamination, disclosure.
  - A leak ends `evaluation-harness-failed` with `owning_phase: disclosure-audit`, not resumable, with no implement dispatch, no score and no publication.
  - Reconciliation failure ends `evaluation-harness-failed` with no implement dispatch.
  - First-pass contamination ends `contaminated` with no implement dispatch.
  - An implement-phase request receives an abort reply and ends `evaluation-harness-failed`, naming the request's step.
  - Limits and stalls report `definition-workflow-failed` or `implementation-workflow-failed` by stage, naming the last active step and the applied value. A stall is resumable and the time limit is not.
  - Resume dispatches the recorded Runner id with the phase's `--until` and never a second fresh run. A run interrupted during define resumes with `--until define`, then runs collection and the checkpoint before any implement dispatch.
  - The gap before a resume does not count toward the time limit: the resumed invocation gets the remaining two hours.
  - The near-reset Claude limit is waited for and resumed, outside the active-time count. The 429 with no reset ends as a resumable workflow failure.
  - A single-judge flag the decider rejects does not fail the run.
  - A leak-failed run refuses `--resume`.
  - A workflow failure after define still reports the definition score and a trace with `delivery-unavailable` for every defined item.
- Execution: `test/and-scene-e2e-lifecycle.test.mjs`; `npm run check`.

### INT-006: Remote-only delivery verification and retention
- Covers: Delivery verification; Definition collection (no host Git in the workspace); Per-run delivery repository (identity recorded); end-to-end-workflow-evaluation "Rescore without GitHub".
- Boundary: `delivery.mjs`, definition collection and the shared delivery verifier in remote-only mode, using real git against a local bare remote, a stub `gh` serving programmed PR JSON, and the injected throwaway-container runner.
- Setup: a sandbox workspace with a delivered branch pushed to the bare remote, a matching open draft PR, and Runner session `output/` acceptance artifacts. The workspace's `.git/config` sets `core.fsmonitor`, a `core.hooksPath` hook and an `alias` to a script that writes a marker file. Variants:
  - branch not pushed;
  - no PR;
  - PR not draft;
  - PR head behind;
  - change archived;
  - PR marked ready, merged or closed;
  - branch deleted;
  - an extra branch and an extra PR beside a correct delivery;
  - missing acceptance artifacts.
- Action: run definition collection, delivery verification and retention; delete the bare remote and the sandbox workspace; then run a phase that clones from the bundle and reads the acceptance evidence.
- Assertions:
  - The marker file is never written on the host, and no host Git process runs with the workspace as its repository.
  - The happy path records the repository identity, the delivered commit, a bundle whose head equals the PR head with its SHA-256 in the manifest, and acceptance evidence recorded against that commit.
  - Each missing outcome, including ready, merged, closed, deleted and archived, ends `implementation-workflow-failed`, naming it, records the prohibited effect, and leaves the run ineligible for publication.
  - The extra branch and PR are reported, and the run proceeds to scoring.
  - The bundle clone and the acceptance evidence read succeed with the remote and workspace gone.
- Execution: `test/and-scene-e2e-delivery.test.mjs`; `npm run check`.

### INT-007: Audit evidence covers every evaluated role in two passes
- Covers: evaluation-isolation Contamination audit (all roles, two passes, delivery-repository calls) and Complete audit evidence; Evaluated role profiles (`cursor` only for crosscheck).
- Boundary: shared `collectEvidence` with the e2e invocation filters, transcript parsing and `auditContamination`, over retained-format files.
- Setup:
  - a `run-metrics.json` with define-phase lead and crosscheck invocations and implement-phase lead, crosscheck, implementor and tester invocations, across `claude`, `codex` and a `cursor` crosscheck;
  - matching native transcripts;
  - a Validator reviewer Claude session present on disk but absent from metrics;
  - the e2e pattern list.
- Action: collect and audit pass 1 and pass 2; repeat with a missing implementor transcript, a tester call fetching the fixture repository, a lead `git push` and `gh pr create` naming the delivery repository, and a `cursor` implementor profile.
- Assertions:
  - Pass 1 audits only the define-phase invocations and writes `evidence/define/`; pass 2 audits all of them and writes `evidence/final/`. The define snapshot's hashes are unchanged after pass 2.
  - A missing implementor transcript ends `evaluation-harness-failed`, naming it.
  - The tester fetch makes the run `contaminated`, listing the call.
  - Delivery-repository calls are not matches.
  - The Validator reviewer session is neither required nor audited.
  - A `cursor` implementor fails preflight.
- Execution: `test/and-scene-e2e-contamination.test.mjs`; `npm run check`.

### INT-008: Product rubric validation and inventory requirement source
- Covers: from-prompt-product-scoring Versioned from-prompt product rubric and score, Fixture-owned criteria map to the hidden inventory, Every graded item is covered, and Hidden requirements are the judging source.
- Boundary: `product-rubric.mjs` and `requirements.mjs` with the real `product-rubric.json`, `preference-values.json` and define-suite inventory, feeding the shared judge-packet builder.
- Setup: the pinned real inputs, plus mutated rubric copies:
  - a criterion citing a `preference` item;
  - guidance containing `880 × 380`;
  - a fixture-owned criterion with no inventory citation;
  - an eval-owned criterion without a reason, and one whose `presumes` lists a preference item;
  - a mandatory item cited by nothing and absent from `exclusions`;
  - a criterion with no tier, and one weighted above 2 points;
  - a criterion whose cited items exceed `max_requirement_chars`;
  - a `pass_threshold` or component floor.

  Also a fixture candidate worktree whose `openspec/changes/` contains a weakened specification, and a collected definition.
- Action:
  1. Validate each rubric.
  2. Run preflight with the threshold variant.
  3. Build the requirement documents and every judge job's packet.
- Assertions:
  - The real rubric validates, with 70 automated points, and every mandatory item is cited or excluded with a reason.
  - Each mutation is rejected, naming the criterion and the item or value.
  - Preflight fails before any model call on a threshold or floor.
  - Every `preference-values.json` value occurs in some preference item's quote.
  - Requirement documents exist exactly for the mandatory and acceptable-alternative items and contain only statements, intents and quotes.
  - The packet for the criterion citing INV-032 (fixed-canvas scaling) contains no `880` or `380`, though INV-033 shares its reference section.
  - The scope-discipline criterion cites INV-105 to INV-108.
  - No judge packet contains preference-only item text or content from the candidate's `openspec/changes/`, except that the testing-evidence and assumption-handling packets contain the collected definition.
- Execution: `test/and-scene-e2e-product-rubric.test.mjs`; `npm run check`.

### INT-009: Product evaluation pipeline on the host
- Covers: Building and serving the product; Reused robust judging; Gates; Human review (unbuildable product, floor reported); Evaluation status and scores; design "Build plan, in a container".
- Boundary: e2e product-evaluation phases over the extracted product-scoring engine, with an injected build-container runner, the shared host candidate server, an injected browser-judging phase and fake judge invokers.
- Setup:
  - small fixture candidates committed into test bundles: one at the repository root with `dist/`, one in a workspace subdirectory with its own build script and a non-default output directory, and one with no resolvable application;
  - a recording build-container runner that returns the output or a failure;
  - fake judge records, including an exhausted job, a `packet-overflow` testing-evidence job, and a failed criterion that triggers a second opinion;
  - a human review below the human rubric's floor.
- Action: run product evaluation for these cases:
  - buildable, at the root and in the subdirectory;
  - unresolvable build plan;
  - build failure;
  - a failing gate;
  - judge exhaustion, then resume;
  - packet overflow.
- Assertions:
  - Both buildable layouts are served from their own output and yield a score out of 70 automated points with a per-component breakdown, every criterion's verdict and citations, gate outcomes, and the rubric version and hash, with no verdict field.
  - The unresolvable plan ends `evaluation-harness-failed`, resumable, reported as not evaluable, with no product score.
  - A build failure scores every browser-dependent criterion 0 with no fallback job invoked, fails the build gate, and ends with human component 0, the reason, and status `complete`.
  - A failing gate leaves the score unchanged.
  - Judge exhaustion ends `evaluation-harness-failed`, resumable, with no product score, and resume reuses the completed units.
  - Packet overflow marks only the testing-evidence component incomplete; the other components are scored.
  - A human review below the floor is reported as below it, and its points still count.
  - The build runner receives only the worktree copy and no credential, auth mount or host environment variable.
- Execution: `test/and-scene-e2e-product.test.mjs`; `npm run check`.

### INT-010: Trace, results, publication, comparison and rescore
- Covers: requirement-delivery-trace (all requirements); Result and report; Permanent result publication; Run comparison; Series identity and candidate; Suite entry point and modes (rescore).
- Boundary: `trace.mjs`, `result.mjs`, `report.mjs`, `publication.mjs`, `compare.mjs` and the rescore path, over retained run directories, with a temporary Git repository and a local bare upstream for publication.
- Setup:
  - completed and failed retained run directories built by INT-005 and INT-006 helpers;
  - discovery, coverage and product verdicts designed to hit every trace outcome, including a partly delivered item, a shared failing criterion and an unmapped covered item;
  - three repetitions each of two candidates in one series, a single-run candidate, and a pair across series;
  - a publication upstream that rejects the first push.
- Action:
  1. Build the trace, result and report.
  2. Publish, with a retry.
  3. Compare.
  4. Rescore a completed run with the delivery remote unreachable and the product rubric version bumped.
- Assertions:
  - Each item gets exactly the outcome the spec table defines, items sharing a failed criterion name it, and a run without a product records `delivery-unavailable` for every defined item.
  - The result and report show no combined definition-plus-product total.
  - Identical verdicts with different asked parts give identical scores.
  - `report.html` is offline and contains every required section.
  - Publication commits only `results/<run-id>/` with the required message and never force-pushes.
  - A rejected push preserves the result and retries reusing the same commit.
  - Failed, contaminated, rescore and calibration runs are not published.
  - Compare reports mean, standard deviation and worst repetition per group, classifies the three-repetition groups' differences with the and-scene bands, labels the single run a screen without classifying it, never pairs across series, and names the differing candidate components.
  - The rescore uses the bundle, the recorded build plan, the retained acceptance evidence and the current rubric, records the current and the source series identity, reproduces both contamination passes, and does not publish.
- Execution: `test/and-scene-e2e-results.test.mjs`; `npm run check`.

### INT-011: Calibration mechanics
- Covers: from-prompt-product-scoring Calibration; Suite entry point and modes (`--calibrate`).
- Boundary: `calibrate.mjs` with the real `calibration/` patches applied to the pinned reference bundle, and the product-evaluation phases with fake judges.
- Setup:
  - the pinned reference bundle;
  - the preference-shifted and degraded patches;
  - the expected-verdicts file;
  - fake judges programmed to drift between repeats, have deciders reverse panels, penalize the preference-shifted copy beyond tolerance, and pass a removed mandatory behavior.
- Action: run calibration with 0 repeats (refused), with 1 repeat and named inputs, then with the default 3 repeats.
- Assertions:
  - Every patch applies cleanly, and the preference-shifted copy contains none of the reference-only page hooks such as `data-step-count`.
  - Zero repeats is refused; one is accepted; `--inputs` judges only the named inputs and refuses an unknown one.
  - A degraded variant is judged only on the subcomponents holding its expected failures and their fallback job.
  - The report shows per-input scores, spread, accuracy, per-criterion flip rates and decider reversals.
  - The tolerance, removed-mandatory and spread failures are reported, naming the criteria.
  - No output is published.
  - A candidate result scored while the rubric is marked provisional states "provisional".
- Execution: `test/and-scene-e2e-calibration.test.mjs`; `npm run check`.

### INT-012: Browser judging with replay confirmation
- Covers: from-prompt-product-scoring Browser criteria judged by operating the product.
- Boundary: `browser-judging.mjs` with the shared panel settlement and the replay executor, over an injected browser driver that records actions and returns programmed page states, and fake browser-judge invokers.
- Setup: programmed judges and page states for:
  - a pass whose replay reproduces;
  - a settled pass where the first passing judge's replay mismatches and the second reproduces;
  - a settled pass where no replay reproduces;
  - a settled fail;
  - no judge able to locate the sample.
- Action: run browser judging for each case, recording every job's packet and the order of driver sessions.
- Assertions:
  - The reproducing pass is counted and marked replay-confirmed.
  - The second judge's replay confirms the second case.
  - The unreproduced pass counts as failed, with the mismatch recorded.
  - The settled fail goes to a replay-based second opinion.
  - The unlocatable case goes to its fallback job, marked fallback-judged, and an unconfirmed fallback pass fails.
  - No packet contains a preference value from `preference-values.json`.
  - Driver sessions never overlap.
- Execution: `test/and-scene-e2e-browser-judging.test.mjs`; `npm run check`.

## End-to-End Tests

### E2E-001: Dry run and help from the public entry point
- Covers: Suite entry point and modes (`--dry-run`, `--help`); Preflight ordering.
- Surface: `evals/agent-runner/and-scene-e2e/run.sh` from the repository root.
- Setup:
  - temporary clean Agent Runner and Agent Skills checkouts with a recorded `sandbox-run.sh --dry-run` substitute;
  - the fake GitHub server URL and a test App key in the environment;
  - explicit profiles for all four roles.
- Journey: run `--help`, then `--dry-run --lead-* --crosscheck-* --implementor-* --tester-*`.
- Assertions:
  - Help documents every mode and option.
  - The dry run prints the planned provisioning (repository name, permissions) and the sandbox invocation, and exits 0.
  - The fake server receives no write request.
  - No container is started and no model CLI is invoked.
  - No token value is printed.
- Execution: `test/and-scene-e2e-entry.test.mjs`; `npm run check`.

### Manual real-browser suites (extraction PR)
The extraction moves `axi-browser-driver.mjs`, `browser-eval.mjs` dependencies and second-opinion replay. Run the following by hand, per `AGENTS.md`, one at a time on the shared Chrome:
- `test/real-browser/candidate.test.mjs`, on the base commit first and then after the extraction;
- `driver-primitives.test.mjs` and `input-hygiene.test.mjs`;
- `adversarial.test.mjs`, once at the end of the extraction PR.

### Real-browser cases for browser judging (suite PR)
Add cases to the existing `test/real-browser/adversarial.test.mjs`, which already holds hand-made trick pages. They drive the real replay executor and the new `rendered-state-changes` and `rendered-state-matches` expectations against hand-made pages:
- a presentation on a route the reference does not use;
- a presentation advanced only by an on-screen Next button;
- a five-step presentation;
- a recorded pass whose replay does not reproduce on the page, which must count as failed.

Run the adversarial suite once at the end of the suite PR, after running it on the base commit.

## Acceptance Testing Envelope

- **Prerequisite:** HT-001 is done before acceptance starts. The live run cannot be replaced by fakes.
- **Environments and sandboxes:**
  - Paul's Mac: Docker, and clean `main` checkouts of Agent Runner and Agent Skills.
  - Host Chrome for product evaluation, human review and calibration, one headless job at a time.
  - Host `claude` and `codex` for the simulated user and judges.
  - Agent Runner's sandbox image for the evaluated workflow and the throwaway build container.
- **Credentials and secrets:**
  - Paul's existing Claude and Codex CLI logins (setup-token by name where Claude uses the Keychain).
  - The GitHub App id and private-key file in host environment variables (`AND_SCENE_E2E_APP_ID`, `AND_SCENE_E2E_APP_KEY_FILE`), from HT-001.
  - Paul's Git credentials for pushing this feature branch.
  - Never print tokens or credential files, and never read `~/.agent-factory/private/`.
- **Authorized effects:**
  - One paid `--run-agent` run with the runner-config default profiles. Model usage is on subscriptions; expect several hours. It creates one private `Codagent-AI/e2e-run-<run-id>` repository with its branch and draft PR, retained and never deleted. Within that run:
    - the token refresh interval is set to a few minutes, so several refreshes happen during implement and the tester rounds;
    - the controller is interrupted once during implement and resumed with `--resume`;
    - a read of another private Codagent-AI repository with the run token is attempted and must be refused.
  - A `--resume` of that run at the human-review handoff.
  - A `--rescore-from` of it into a new run directory with identical inputs, with differences attributed per criterion by `and-scene/scripts/compare-rescores.mjs`.
  - `--dry-run` and `--help`.
  - One real `--calibrate` run (three or more inputs, three repeats, host judging), after HT-003's expected verdicts are approved.
  - Publication of the live run's human-reviewed result to this feature branch's `evals/agent-runner/and-scene-e2e/results/`, kept as a real result.
- **Off limits:**
  - the `Codagent-AI/and-scene` fixture repository and its PRs;
  - writes to any other repository's branches or PRs;
  - `main` of any repository;
  - force pushes;
  - deleting repositories;
  - the factory, its deployment and `~/.agent-factory/state.sqlite3`;
  - Chrome or candidate-server processes started by other sessions.
- **Permitted substitutes:** none for Docker, GitHub or the models in the live run.
- **Known risk areas:**
  - Whether the App gains access to repositories it creates on github.com (only Enterprise Server documentation found; the fallback is adding each repository to the installation).
  - Token refresh across a multi-hour implement invocation and the tester's acceptance rounds.
  - `validate-feature-branch` and `gh repo view` with the delivery remote.
  - Validator reviewer auth when Claude uses a setup-token.
  - Stall detection while the simulated user is answering.
  - Byte-for-byte preservation of and-scene during extraction.
  - Browser-judge verdict stability, and how often criteria fall back to source judges.
  - The build-plan resolver on the delivered layout, inside the throwaway container.

## Human-Only Testing

### HT-001: Create and install the GitHub App
- Reason: creating a GitHub App on Codagent-AI and installing it needs Paul's organization-owner authority and produces a private key only he can hold.
- Prerequisites: INT-004 passing; the design's permission list. This is a prerequisite of acceptance.
- Instructions:
  1. Create the App with Administration write, Contents write, Pull requests write, Checks read, Commit statuses read and Metadata read, and organization permission to create repositories.
  2. Install it on Codagent-AI with "Only select repositories" and none selected.
  3. Store the key file on the host, and export `AND_SCENE_E2E_APP_ID` and `AND_SCENE_E2E_APP_KEY_FILE`.
  4. Run `run.sh --dry-run`.
- Required decision or observation: the dry-run preflight reach check passes and lists no repositories.

### HT-002: Human review of the live run
- Reason: the 30 human-review points are subjective quality ratings. Placeholder ratings would publish a false result.
- Prerequisites: the live run reached `pending-human-review` with a complete automated product score.
- Instructions: run `evals/agent-runner/and-scene-e2e/human-review.sh --run-dir <run-dir>`, review the served candidate, and answer the questions.
- Required decision or observation: the review completes, the run becomes `complete`, and the result is published to this branch.

### HT-003: Approve calibration expectations and the rubric
- Reason: only Paul can decide that a degraded variant should fail a given criterion, that a preference shift should be score-neutral, and whether calibration evidence is good enough to drop the provisional label.
- Prerequisites: INT-008 and INT-011 passing; the patches and the expected-verdicts file written.
- Instructions:
  1. Review `calibration/` patches and expected verdicts before the real calibration run.
  2. After the run, review the report: scores, spread, accuracy, flip rates, decider reversals and tolerance failures, together with the live run's identical-rescore attribution.
- Required decision or observation: the expected verdicts approved (or corrected), then the rubric either approved or left provisional, with the reason.

## Coverage Map

| Requirement or journey | INT | E2E | HT |
| --- | --- | --- | --- |
| Suite entry point and modes | INT-010, INT-011 | E2E-001 | none |
| Evaluated workflow selection | INT-005 | none | none |
| Evaluated role profiles | INT-007 | E2E-001 | none |
| Series identity and candidate | INT-010 | none | none |
| Preflight | INT-003, INT-004, INT-008 | E2E-001 | HT-001 |
| Per-run delivery repository | INT-002, INT-004, INT-006 | none | HT-001 |
| Workflow execution and stop points | INT-002, INT-005 | none | none |
| Elapsed-time limit | INT-005 | none | none |
| Stalled workflow | INT-005 | none | none |
| Quota limits in the evaluated environment | INT-005 | none | none |
| Definition collection | INT-006, INT-007 | none | none |
| Define checkpoint | INT-005 | none | none |
| Delivery verification | INT-006 | none | none |
| Evaluation status and scores | INT-005, INT-009 | none | none |
| Durable checkpoints and resume | INT-005, INT-009 | none | none |
| Result and report | INT-010 | none | none |
| Permanent result publication | INT-010 | none | HT-002 |
| Run comparison | INT-010 | none | none |
| Versioned from-prompt product rubric and score | INT-008, INT-009 | none | HT-003 |
| Fixture-owned criteria map to the hidden inventory | INT-008 | none | none |
| Every graded item is covered | INT-008 | none | HT-003 |
| Hidden requirements are the judging source | INT-008 | none | none |
| Browser criteria judged by operating the product | INT-012, real-browser cases | none | none |
| Building and serving the product | INT-009 | none | none |
| Gates | INT-009 | none | none |
| Reused robust judging | INT-009 | none | none |
| Human review | INT-009 | none | HT-002 |
| Calibration | INT-011 | none | HT-003 |
| Requirement trace (all requirements) | INT-010 | none | none |
| simulated-user Disclosure audit (end-to-end leak) | INT-005 | none | none |
| evaluation-isolation Contamination audit and Complete audit evidence | INT-005, INT-007 | none | none |
| evaluation-isolation Conversation reconciliation | INT-005 | none | none |
| evaluation-isolation Simulated-user boundary | INT-002, INT-003 | none | none |
| evaluation-isolation Pinned contamination patterns | INT-004 | none | none |
| Shared code extraction preserves existing suites | INT-001 | none | none |
