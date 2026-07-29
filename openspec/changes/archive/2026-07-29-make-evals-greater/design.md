## Context

The `and-scene` suite currently assumes that Agent Runner stops at a pre-acceptance boundary, freezes a detached checkout, and then runs four source judges before a separate human review. The approved proposal and specifications replace that boundary with a complete `implement-change-v2.0` delivery: the harness creates a candidate branch, Agent Runner completes its final Validator, draft-PR, acceptance, and handoff steps, and the evaluator establishes one final revision before any scored judging begins.

That change cuts across candidate setup, Runner resumption, delivery verification, evidence ownership, browser state, judge inputs, scoring, calibration, results, and publication. The current controller has not produced a successful benchmark, and its checkpoint identity is defined before the branch, PR, final SHA, and acceptance evidence exist. Preserving that internal structure would make evolving delivery identity and fine-grained resume behavior harder to reason about than a deliberate rewrite.

Constraints include:

- The suite remains self-contained under `evals/agent-runner/and-scene/`; no shared evaluation framework or third-party runtime dependency is introduced.
- Agent Runner continues to own workflow execution, sessions, process identity, and its product-side infrastructure.
- The fixture commit, Runner revision, profiles, arguments, rubrics, branch, PR, final SHA, and evidence hashes must remain reproducible across resume.
- GitHub credentials are required for the Runner-owned branch and draft-PR workflow. The harness may inspect only the minimum PR metadata needed to verify delivery identity and must not inspect CI.
- Candidate branches and draft PRs are preserved for diagnosis and manual cleanup.
- Candidate-produced evidence is untrusted input. Evaluator-produced evidence may contradict it but cannot improve its evidence-quality score.
- The separate 13-question human review remains the only subjective visual-quality assessment.

The stakeholders are benchmark operators, implementation agents being evaluated, literal human reviewers, and maintainers who must diagnose failed or interrupted runs without conflating product, workflow, and harness failures.

## Goals / Non-Goals

### Goals

- Model one candidate lifecycle from pinned fixture through final draft-PR SHA, acceptance evidence, automated judging, human review, and candidate publication.
- Make every phase and independently reusable work unit depend on explicit, hashed inputs and emit explicit, hashed outputs.
- Distinguish implementation-workflow failures, evaluation-harness failures, and completed product findings.
- Keep candidate evidence, evaluator evidence, neutral judge source, and published artifacts in separate namespaces.
- Support candidate scoring out of 100, reference scoring out of 92, and a non-rescaled comparison over the shared 92 points from one applicability-aware score model.
- Correct browser-mode handling while retaining independent deterministic checks and a real-browser regression against the pinned reference.
- Preserve the operator-facing CLI, separate human-review command, and stable top-level result artifact names where practical.

### Non-Goals

- Changing Agent Runner to emit a new delivery-manifest format.
- Changing or automating the 13-question human review.
- Publishing a standalone reference report.
- Inspecting, waiting for, or gating on CI.
- Automatically closing PRs, deleting branches, merging, releasing, archiving the evaluated change, or applying ambiguity findings to benchmark specifications.
- Preserving internal compatibility with the unsuccessful boundary-based controller or resuming its historical run directories.
- Creating a reusable cross-suite framework before another suite needs the same behavior.

## Decisions

### Decision: Replace the controller with a manifest-driven state machine

The suite will replace the boundary-oriented controller and phase checkpoint model with a versioned, suite-local state machine. A single atomic `run-state.json` will be the authoritative durable record. It will contain:

- immutable run inputs and their hashes;
- evolving delivery identity;
- phase and work-unit states;
- input, dependency, and output hashes;
- typed lifecycle events and failure ownership;
- artifact references; and
- resume eligibility.

A reducer will validate typed transitions, and an orchestrator will schedule only units whose dependencies are complete and whose score-affecting inputs still match.

```text
candidate:
  initialized → candidate-branch-ready → runner-active → workflow-complete
              → delivery-verified → source-frozen

reference:
  initialized → source-frozen
  (branch, Runner, delivery, testing evidence, and assumptions are N/A)

shared:
  source-frozen → verification → candidate-server → evaluator-evidence-complete
                → automated-scoring-complete → pending-human-review → finalized

terminal branches:
  product-owned build/serve failure → complete product fail, unscored and local
  finalized candidate score         → published
  finalized reference score         → local only
```

Workflow and harness failures are durable terminal states that retain diagnostics and may remain resumable. Candidate and reference runs use the same reducer, with inapplicable states and work units recorded explicitly rather than simulated as zero-valued work. A scored product-fail verdict and a conclusive product-owned build or serve failure are successful terminal evaluation outcomes, not failed harness units, so their valid negative findings are reused.

On resume, the orchestrator will:

1. Revalidate the fixture, branch, Runner revision and workflow, arguments, profiles, evaluator configuration, and rubric provenance.
2. Consult Runner's persisted run and live process identity before deciding to start, wait, resume, or continue.
3. Rehash the outputs of each completed work unit before reuse.
4. Restart a unit or its enclosing phase when completion cannot be proved.
5. Refuse reuse when the candidate branch, PR, final SHA, required evidence identity, or another score-affecting input changed.
6. Preserve independently checkpointed browser probes, screenshots, judge jobs, and human responses whose provenance still matches.

Operator-facing `run.sh` arguments, the separate human-review entry point, and top-level artifacts such as `result.json` and `report.html` remain stable. Internal phase paths and schemas may change with explicit version increments.

**Alternatives considered**

- Extend the existing phase booleans and controller handler. Rejected because the current identity is frozen at the old stop boundary and cannot cleanly express evolving delivery identity, dependency hashes, or typed failure ownership.
- Introduce a generic shared event framework. Rejected because only this suite needs the behavior today.

### Decision: Establish the candidate branch before Runner and verify full delivery afterward

For a fresh candidate run, the harness will create `eval/and-scene/<run-id>` locally at the exact pinned fixture commit before Agent Runner starts. A collision or an unexpected existing identity will be refused rather than reused implicitly. The harness will run the exact workflow source at `workflows/openspec/implement-change-v2.0.yaml` without `--until`, record its Runner commit and content hash, and preflight its required steps; `--skip-validator` will map only to `skip_validator=true`, which skips task-level compliance while retaining the final Validator and all later workflow steps.

After Runner reports full completion, a delivery verifier will establish:

- the expected repository and branch;
- a clean committed worktree descending from the fixture;
- completed final Validator and acceptance-handoff workflow steps;
- the final local `HEAD`;
- an open draft PR with a non-empty base and the expected head branch;
- a PR head SHA equal to local `HEAD`.

The workflow contract will be rejected if it declares a merge, ready, close, archive, release, or branch-deletion step. The harness will perform one narrow PR metadata lookup for URL or number, open or closed state, draft state, base, head branch, and head SHA. It will also verify the remote candidate branch, unarchived change location, and recorded workflow history. It will not request check runs, statuses, or any CI endpoint. A detected prohibited effect produces `implementation-workflow-failed` with reason `workflow-side-effect-violation`; other missing or mismatched delivery outputs produce a typed `implementation-workflow-failed` result. Unexpected evaluator exceptions remain `evaluation-harness-failed`.

Only after delivery verification succeeds will the harness freeze the final candidate commit and allow evaluator work to begin. The verified branch and draft PR remain untouched after success or failure.

**Alternatives considered**

- Trust the workflow's prose claim about the PR without checking its current identity. Rejected because the evaluator could attach evidence and scores to a different revision.
- Treat a missing or stale PR as a point deduction. Rejected because the complete workflow did not deliver an unambiguous candidate; no official product score is issued in that state.
- Query CI alongside PR metadata. Rejected because CI review is not an eval-harness responsibility or a prerequisite in the approved workflow contract.

### Decision: Build a verified candidate-evidence manifest from artifact roles

The harness will build `evidence/candidate/manifest.json` after delivery verification. The final acceptance handoff is the anchor. A suite-owned registry will recognize required semantic roles and documented filename aliases rather than requiring one brittle filename. Roles include:

- acceptance flow record;
- screenshot files and capture metadata;
- findings and retest history;
- final acceptance handoff;
- acceptance assumptions ledger; and
- referenced session reports or audit material needed by assumption evaluation.

The manifest builder will resolve safe references within the candidate worktree or recorded Runner session, copy exact bytes into the candidate-evidence namespace, and record origin, ownership, media type, size, SHA-256 hash, claimed revision, capture metadata, and references. It will never repair, rewrite, or silently reinterpret candidate artifacts.

Structural readiness and evidence quality are separate:

- An absent required role or delivery identity is an implementation-workflow failure and blocks scoring.
- A readable artifact that is stale, incomplete, misleading, weakly traceable, or tied to the wrong revision remains judgeable candidate evidence and may lose testing-evidence points.

Evidence lineage will be represented as a graph of evidence items and revisions terminating at the verified final PR SHA. Deterministic validation will establish integrity, Git ancestry, claimed revision identity, screenshot metadata, and change bounds. A trustworthy ancestor full-flow pass may combine with final targeted retesting when the intervening product change and dependent flows are explicitly bounded. Evidence-only final verification is accepted only when no tracked product content changed. The focused judge, rather than the parser, decides whether the verified facts satisfy each scored criterion.

Candidate-reported CI claims are preserved verbatim with their claimed revision when present. Absence, pending state, or unavailability remains evidence content; the harness performs no independent CI lookup.

**Alternatives considered**

- Hard-code one filename such as `acceptance-flow-evidence.md`. Rejected because the current workflow and skill already use different names for the same role.
- Require Agent Runner to emit a new machine-readable delivery manifest. Rejected for this change because it crosses repository ownership and couples benchmark cutover to a separate Runner release.

### Decision: Separate candidate evidence, evaluator evidence, and neutral source

Evaluator browser probes, screenshots, runtime results, and contradiction findings will live under `evidence/evaluator/`. Durable artifacts and reports will label ownership explicitly. Evaluator evidence may disprove a candidate claim, but it will not be presented as affirmative support for testing-evidence credit.

The harness will materialize the verified final commit into a separate immutable neutral-source snapshot and neutral requirements bundle for judging. It will:

- contain no Git metadata;
- exclude delivery, acceptance, the original OpenSpec change directory, evaluation configuration, and other benchmark bookkeeping;
- replace exact recorded run, branch, PR, and baseline identity strings in remaining text with typed placeholders;
- retain product paths and source structure needed for technical review; and
- copy the approved normative requirement descriptions and scenarios into identity-free requirement paths without changing their behavioral text; and
- record the included source, requirement origins, transformations, and content hashes in a manifest.

The actual candidate, original requirements, and copied evidence remain unchanged. The four product-source judges receive only neutral source, the neutral requirements bundle, their rubric slice, and allowed deterministic technical facts. The testing-evidence and assumption-handling judges additionally receive the verified candidate-evidence views required by their criteria. Candidate material remains bounded, read-only, and explicitly delimited as untrusted input.

**Alternatives considered**

- Let every judge inspect the live worktree and rely on prompt instructions to ignore identity and evidence ownership. Rejected because paths, Git metadata, acceptance artifacts, and branch state would still identify the implementation and could leak evaluator evidence into candidate credit.
- Redact the live candidate. Rejected because judging must not mutate delivered bytes.

### Decision: Use one applicability-aware score model

Every component will record `applicable`, `points_awarded`, and `points_possible`. Totals and denominators will be derived from applicable components rather than hard-coded by mode.

| Component | Candidate | Reference |
|---|---:|---:|
| Demo technical quality | 24 | 24 |
| Scene-kit correctness | 24 | 24 |
| Presentation skill | 7 | 7 |
| Verification tool | 7 | 7 |
| Testing-evidence quality | 4 | N/A |
| Assumption-handling quality | 4 | N/A |
| Human review | 30 | 30 |
| Total | 100 | 92 |

The shared-92 comparison selects the four shared automated implementation components and human review from each result. It does not rescale either side. The reference has no candidate pass/fail verdict. Candidate pass rules remain 70 overall, 15/24 demo, 15/24 scene kit, 15/30 human, no individual human rating of 1, and all existing hard gates; the two new four-point components have no floors. If reproducible product behavior prevents the frozen candidate from installing, building, or serving, the failed hard gate is a conclusive product fail: completed component evidence is preserved, unobserved behavior remains unscored, and no official score or human rating is fabricated.

**Alternatives considered**

- Maintain separate candidate and reference scorers. Rejected because applicability, denominators, and comparison arithmetic would drift across two implementations.
- Rescale the reference to 100. Rejected because it would imply performance on workflow components that do not apply.

### Decision: Run six isolated scored judges and one diagnostic ambiguity judge

The automated score will use six independently checkpointed judge processes:

1. demo integration;
2. scene-kit correctness;
3. presentation skill;
4. verification tooling;
5. testing-evidence quality; and
6. assumption-handling quality.

Each job receives only its rubric slice and permitted evidence view, returns a verdict, rationale, and verified citations for every owned criterion, and records its own input and output hashes. A valid criterion failure is completed scoring evidence. Invalid or missing judge output is retried within a fixed bound and then becomes an evaluation-harness failure; it is never converted to zero candidate points.

The ambiguity judge remains a seventh, non-scoring diagnostic process. Its stable ledger may overlap with assumption evidence but cannot add points, subtract points, create a gate, publish fixture changes, or mutate benchmark specifications.

**Alternatives considered**

- Use one large judge for all automated criteria. Rejected because evidence permissions, failure attribution, retry scope, and checkpoint reuse differ by component.
- Fold the ambiguity ledger into the four-point assumption score. Rejected because diagnostic severity and fixture proposals are not scoring policy.

### Decision: Make browser mode and probe state explicit

The browser driver will observe and record the presentation's initial mode without changing it during open. Each probe will declare its required mode:

- captions and canonical-content traversal enter browse mode explicitly;
- present-mode and browse-mode probes select their mode explicitly;
- navigation probes begin from an explicit position and mode; and
- shared sessions restore the recorded state when reuse requires it.

Intentionally hidden presenter-mode captions are not treated as missing canonical content. Routing, captions, step order, navigation, modes, runtime failures, accessibility, and revision identity remain deterministic evaluator checks. Probes and captures will be independently hashed work units so valid passes and failures can both be reused on resume.

Mocked driver tests will cover state transitions, but cutover also requires a real-browser regression against the pinned reference presentation and a passing caption criterion from the corrected deterministic evaluator. No additional subjective visual judge will be added. Candidate inspection and disposition of visual warnings will be scored under testing-evidence quality; literal human review remains authoritative for visual quality.

Candidate verification will distinguish command execution from product behavior. Failure to launch evaluator tooling or manage an otherwise viable server is a harness failure. A reproducible candidate-owned install, build, or serve failure instead records the applicable failed hard gate and completes as an unscored product fail without attempting dependent browser or human-review work.

**Alternatives considered**

- Force browse mode globally on open. Rejected because it destroys the product's initial-mode behavior and invalidates mode-specific probes.
- Infer caption absence from the currently rendered presenter view. Rejected because captions may be intentionally hidden there.

### Decision: Derive results and publication from authoritative state

`result.json` and `report.html` will be projections of `run-state.json`, not independently updated state. Their schema will include:

- evaluation status and product-verdict applicability;
- official score only when complete scoring produced one;
- score denominator and component applicability;
- available independently completed component scores;
- candidate branch, draft PR, base, final local and PR SHA;
- final Validator result and candidate-reported CI when present;
- candidate and evaluator evidence ownership, hashes, coverage, and lineage;
- judge, rubric, cost, timing, retry, and resume provenance; and
- the shared-92 comparison when available.

Incomplete and failed results retain diagnostics without fabricating a score. The static HTML report will escape candidate content and link only to artifacts retained in the run directory.

Only a finalized scored candidate result with completed human review is eligible for permanent publication. Reference and calibration results remain local. A conclusive product fail without an official score or human review also remains local rather than becoming the finalized benchmark result. Publication excludes raw screenshots, logs, traces, sessions, and copied candidate evidence while retaining the integrity and summary fields needed to understand the official result.

**Alternatives considered**

- Continue updating result, report, and checkpoint as separate sources of truth. Rejected because interrupted writes can describe different run identities or completion states.
- Publish the reference independently. Rejected because the reference exists only to calibrate and provide the candidate's shared-92 comparison.

## Risks / Trade-offs

- **[Free-form acceptance artifacts vary]** → Anchor discovery on the final handoff, support documented role aliases, validate facts conservatively, and treat content defects as scored findings rather than repairing candidate evidence.
- **[Identity redaction changes what a judge sees]** → Redact only exact recorded identity tokens in the separate snapshot, record every transformation, and preserve the untouched candidate and evidence bytes.
- **[GitHub state changes during or after workflow completion]** → Verify and checkpoint the minimum PR identity at delivery freeze, then refuse a resume whose branch, PR, or final SHA differs.
- **[Fine-grained resume combines incompatible outputs]** → Include immutable run identity, unit input hashes, dependency hashes, and output hashes in every reusable work-unit record.
- **[Structural-readiness and quality defects are confused]** → Encode the required-role table and typed outcomes deterministically; test missing artifacts separately from present-but-poor artifacts.
- **[Candidate text attempts to influence judges]** → Bound inputs, delimit them as untrusted quoted evidence, use read-only neutral snapshots, validate complete structured outputs, isolate jobs by rubric slice, preserve the judge process environment allowlist, and continue preventing model-generated commands from inheriting the parent environment.
- **[Real-browser checks are flaky]** → Use explicit modes and positions, settled-state capture, bounded retries, durable per-probe evidence, and a pinned real-reference regression.
- **[The rewrite introduces broad regression risk]** → Implement behavior in TDD slices, run targeted tests after each slice, then run `npm run check`, OpenSpec validation, and the full Agent Validator before evaluation cutover.
- **[Old run state cannot resume]** → Version the new state explicitly, preserve old directories as diagnostics, and require fresh reference and candidate runs.
- **[External branches and PRs accumulate]** → Record them in every outcome and document manual retention and cleanup; never perform automatic destructive cleanup.

## Migration Plan

1. Introduce the new run-state schema, reducer, artifact records, and typed outcome ownership with unit tests.
2. Replace detached-checkout and stop-boundary behavior with candidate-branch setup, full `implement-change-v2.0` execution, process-aware resume, delivery verification, and final candidate freezing.
3. Add role-based candidate-evidence intake, integrity and lineage validation, evaluator-evidence separation, and neutral-source materialization.
4. Correct browser mode handling and add independently checkpointed probes plus a real-reference browser regression.
5. Replace rubric, judge orchestration, scorer, baseline comparison, result projection, report rendering, and publication filtering with the approved applicability-aware contracts.
6. Extend calibration with degraded evidence, warning, assumption, missing-judge, N/A arithmetic, and shared-92 cases while retaining regression coverage for Runner streaming, native failure detail, run identity, and stale process identity.
7. Develop each behavior change with failing tests first, run its targeted tests, then run `npm run check`.
8. Validate `make-evals-greater` with OpenSpec and run the full Agent Validator.
9. Run the corrected deterministic evaluator against the real pinned reference and require caption criteria to pass.
10. Recreate the local reference baseline with fresh neutral judge processes and complete its literal human review without publishing a standalone reference report.
11. Start a completely fresh candidate evaluation on a new `eval/and-scene/<run-id>` branch, complete Runner delivery and acceptance evidence before judging, then complete literal human review and publish only the finalized candidate report with its shared-92 comparison.

Old run directories are not migrated into the new state schema and cannot be resumed. Rollback consists of reverting the harness code and beginning another fresh run; it does not close or delete any preserved branch or PR.

## Open Questions

None. The proposal, specifications, and approved decisions establish the remaining architectural boundaries.
