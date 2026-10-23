## Why

Agent Evals measures the Codagent lifecycle in two disconnected halves:

- `and-scene-define` starts from a short prompt and scores the definition the interactive define workflow produces. A simulated user answers from the fixture's hidden, reviewed change. No product is built.
- `and-scene` starts from that same fixture change, already defined, and scores the product the implementation workflow delivers.

Neither suite answers the question that matters to a user: **given only a short request, how good is the product the complete workflow delivers?** Each half is graded in isolation, so the evals cannot show:

- whether requirements the user stated, or would have stated if asked, survive from discovery through definition into the delivered product;
- whether a change to the define half (lead model, define skills, crosscheck reviews) helps or hurts the product, not just the artifacts;
- how a user-facing workflow such as `openspec:change` performs as a whole, including its cost and time from prompt to draft pull request.

The pieces now exist to chain the two halves. The define suite provides the pinned prompt, history-free starting repository, simulated user, hidden-reference inventory, isolation boundary, and Agent Runner's external-user mode. `and-scene` provides workflow-agnostic execution, outcome-based delivery checks, browser checks, product judges on the shared panel, and human review. Both suites target the same feature: the define suite's hidden reference is the `create-and-scene` change that `and-scene` implements. The `openspec:change` workflow (v3) now runs define and implement in one run, implementing against an audited behavior checklist without a task plan, so it is the natural default to evaluate.

## What Changes

- Add a new suite, `evals/agent-runner/and-scene-e2e/`, that evaluates a complete Agent Runner workflow from the short prompt to a delivered draft pull request. It compares Codagent configurations, as the other two suites do.
- **Starting input.** The define suite's pinned starting prompt and allowlisted, history-free starting tree, used unchanged.
- **Workflow under test.**
  - One Agent Runner run of a selectable user-facing workflow, from change creation through implementation, stopping before acceptance.
  - The default is `openspec:change` (v3: define, then implement against a crosscheck-audited behavior checklist, open a draft pull request, and run the implementation step's own independent acceptance-test rounds). Other workflows that run define and implement in one run, such as earlier `openspec:change` versions, can be selected for comparison.
  - Only the top-level human `accept` step and what follows it are excluded; acceptance testing owned by the implementation step is part of the run.
  - Role profiles are those the selected workflow uses up to that point; for the default, lead, crosscheck, implementor, and tester.
  - The workflow's Agent Validator runs as configured by the starting tree. Its reviewer CLI's authentication is forwarded to the sandbox independently of the role profiles, verified in preflight, and recorded in provenance.
- **Simulated user.** The define suite's simulated user, disclosure and decision policies, and responder answer the define workflow's interactive turns through the external-user mode; the steps after define are autonomous. Its approvals remain labelled as simulated. A disclosure audit at a define checkpoint, before implementation starts, fails the run as a harness failure when the simulated user leaked a requirement.
- **Delivery.** Each independent candidate run gets a fresh private, eval-owned GitHub repository, seeded with the starting tree and never containing the fixture's history or any other run's work. It receives the candidate branch and draft pull request, and is reused only when resuming that same run. The evaluated agent's GitHub token can reach only that repository. The eval scores the final commit of the delivered branch.
- **Product scoring.** A separate, versioned from-prompt product rubric, adapted from `and-scene`'s:
  - Every fixture-owned criterion and gate maps to hidden-reference inventory items. Mandatory items are graded, acceptable alternatives are graded by intent, and preference items (for example the nine-step sample outline, the `/<slug>` routes, the 880 × 380 canvas) are never graded.
  - Eval-owned criteria, which judge workflow and engineering evidence the fixture does not describe (for example testing evidence and assumption handling), stay scored with their stated reason and grade no reference preference.
  - Criteria and gates that encode reference preferences are rewritten to grade intent, for example "a sample presentation exists, is reachable, and every step renders" instead of a fixed outline. Criteria that already grade intent carry over.
  - Judges read requirements from the pinned hidden reference, quoted per inventory item, never from the candidate's own definition. The definition enters only the testing-evidence and assumption-handling evidence, as the approved requirements those components judge against.
  - Every mandatory item is graded by some criterion or explicitly excluded with a reviewed reason.
  - `and-scene`'s source judges, shared panel judging, replay-based second opinions, testing-evidence and assumption-handling components, and 30-point human review are reused. Its reference-shaped browser probes are not: browser criteria are judged by LLM judges that operate the delivered product as a person would, and a claimed pass counts only when replaying the judge's own actions in a fresh browser reproduces it.
  - The rubric records its own gates and calibration evidence, declares no threshold or floor, and is calibrated independently of `and-scene`'s rubric.
- **Definition scoring.** The intermediate definition is collected when define completes and scored with the define suite's rubric, unchanged. It is reported beside the product score and does not change it.
- **Requirement trace.** A non-scoring ledger records, for each graded hidden requirement, whether the agent asked about it, whether the definition covers it, and whether the product delivers it, so lost requirements can be located by stage.
- **Results.** Provenance, outcomes, both scores, the trace, the simulated-user conversation, contamination and disclosure audits, whole-workflow metrics from `run-metrics.json`, and eval-owned usage recorded separately. Results form their own series, not comparable with either existing suite. Resume, rescore, publication, comparison, and calibration follow the existing suites' patterns.
- **Shared code.** Behavior that this suite needs identically from an existing suite (for example the simulated user and responder, or product judging and replay) moves into `evals/lib/` without changing those suites' behavior. Other mechanics are copied.

## Capabilities

### New Capabilities
- `end-to-end-workflow-evaluation`: the suite lifecycle: preflight, starting input, workflow selection and stop point, role profiles, the private delivery repository, outcome-based delivery checks, outcomes, metrics, results, resume, rescore, publication, and comparison.
- `from-prompt-product-scoring`: the versioned from-prompt product rubric, its mapping of every criterion and gate to hidden-reference inventory items, preference exclusion, the hidden-reference requirement source for judges, gates, browser criteria judged by operating the product with replay confirmation, and calibration.
- `requirement-delivery-trace`: the non-scoring per-requirement ledger of asked, defined, and delivered.

### Modified Capabilities
- `simulated-user`: in an end-to-end run, the disclosure audit runs at the define checkpoint and a leaked requirement fails the run instead of being excluded from coverage.
- `evaluation-isolation`: an end-to-end run's evaluated environment has a remote and a GitHub token scoped to its own private delivery repository, and the Validator reviewer's credentials; isolation and the contamination audit cover those paths and the reference's public locations.

## Technical Approach

- **Own suite and lifecycle.** The lifecycle differs from both existing suites: the controller and simulated user run on the host, as in the define suite, while the product is built, served, and judged as in `and-scene`. The suite therefore owns its runner, controller, evidence, scoring, and runbook, per the repository rule, and composes the other suites' behavior through `evals/lib/` where it must be identical.
- **One Runner run, stopped before human acceptance.** The suite runs the selected workflow with `--until` set to the implementation step and Agent Runner's external-user mode for all interactive turns. A capped run never reports the whole run completed, so delivery is verified from outcomes: a successful capped stop after the implementation step, the pushed branch, the open draft pull request in the run's private repository, and the produced artifacts.
- **Per-run private delivery repository.** Creating a fresh repository per run, seeded from the starting tree, gives the candidate a real remote and pull-request target while keeping the fixture repository, the reference implementation, and every other candidate's branches, pull requests, and definitions out of reach. Repository creation and token minting happen on the host, outside the sandbox, through a GitHub App; a one-time maintainer setup provides it. Preflight verifies the remote's initial contents and the App's reach.
- **Scoring reuse with principled rewrites.** The from-prompt rubric starts from `and-scene`'s calibrated machinery. The inventory mapping decides which fixture-owned criteria carry over and which are rewritten, and lets the trace join discovery, definition coverage, and product delivery per requirement.
- **Key risks.**
  - **Runner prerequisites.** The approach assumes `--until` stops cleanly after the implementation step, and that external-user mode handles any interactive turn in implementation. A gap means a small Agent Runner change first.
  - **Repository provisioning.** Per-run repositories need host credentials able to create repositories and mint repository-scoped tokens, and leave one private repository per run, retained for rescore and review and deleted by hand when no longer needed.
  - **Cost and variance.** Whole-workflow runs are long and costly, and the simulated user adds variance; comparisons need at least three repetitions per arm.
  - **Calibration.** Rewritten criteria and LLM browser judges need calibration, including per-criterion flip rates, before scores are meaningful.
  - **Residual contamination.** As in the define suite, the sandbox is networked and the reference is public, so contamination is detected rather than prevented.
  - **Single fixture.** Results generalize only as far as one feature.

## Out of Scope

- A raw Claude Code (or other non-Codagent) control arm.
- The top-level human `accept` step, archive, and finalize; evaluating the simulated user as an acceptance reviewer.
- Factory and Fly execution of this suite.
- Additional fixtures.
- Any change to the behavior, rubrics, scores, or historical results of `and-scene` and `and-scene-define`, beyond moving identical code into `evals/lib/`.
- Changes to the starting prompt, starting tree, hidden-reference inventory, or simulated-user policies.

## Impact

- **New code:** `evals/agent-runner/and-scene-e2e/` (runner script, controller, delivery-repository handling, from-prompt rubric and scoring, trace, calibration inputs, runbook) and its tests in the existing test suite. Possible extractions into `evals/lib/` from both existing suites.
- **Specs:** three new capabilities and two modified capabilities, listed above.
- **Root `AGENTS.md`:** a short section on running the suite.
- **External setup:** a GitHub App installed on Codagent-AI with no repositories selected, so it reaches only the delivery repositories it creates, and its App id and private key on the host. It creates each private delivery repository and mints installation tokens restricted to that repository.
- **Dependencies:** Agent Runner `main` with `openspec:change` v3, external-user mode, `--until`, and the sandbox options the define suite uses; Agent Skills; Agent Validator and its reviewer CLI's authentication in the sandbox; the pinned and-scene fixture as the hidden reference. No new third-party runtime dependencies.
- **Users:** maintainers can compare Codagent configurations and workflow versions from prompt to delivered product, and see where requirements are lost.
