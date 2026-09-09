# Agent Evals current work list

Last reconciled: 2026-09-08.

This file tracks unfinished work only. Completed harness work and historical
plans belong in Git history and archived OpenSpec changes, not in this backlog.

## 1. Integrate corrected `skip_validator` semantics

Agent Runner commit `17a55a4` changes `skip_validator=true` to skip task-level
compliance, the final Validator, and acceptance-remediation Validator calls
while allowing draft-PR creation, acceptance preparation, and the rest of the
workflow to continue. At reconciliation time, that clean commit was on the
local Agent Runner `dev` branch and was one commit ahead of `origin/dev`.

The originating handoff is
`/Users/paul/.agent-skills/changes/skip-validator-all/handoff.md`.

- [ ] Confirm the final pushed Agent Runner revision and pin that exact clean revision for the suite.
- [ ] Report both task-level compliance and final Validator as skipped when `skip_validator=true`, and required when false.
- [ ] In skip mode, require the final `run-validator` step's explicit skipped audit outcome; never accept an absent or interrupted step as an intentional skip.
- [ ] Preserve the successful-final-Validator requirement when `skip_validator=false`.
- [ ] Update candidate delivery, workflow-history checks, resume, metrics classification, result/report terminology, CLI help, the runbook, and active OpenSpec requirements.
- [ ] Add regression coverage for enabled and skipped modes, including resume and missing-versus-explicitly-skipped evidence.

## 2. Integrate Agent Validator metrics

Agent Validator instrumentation is being developed separately. When its
versioned metrics artifact lands, consume it without reconstructing usage from
logs or transcripts.

- [ ] Pin compatible Agent Validator and Agent Runner revisions and artifact schemas.
- [ ] Ingest invocation and attempt identities, requested and effective model identity, token categories, timing, completeness, and provider-reported cost when available.
- [ ] Keep implementation, Validator, and eval-owned usage and cost separately attributable, with a combined total only when components are complete and non-overlapping.
- [ ] Preserve unavailable, partial, approximate, and unallocated measurements instead of converting them to zero or assigning them to an unsupported model.
- [ ] Apply the suite's pinned pricing snapshot independently of Validator; preserve provider-reported and estimated cost as distinct values.
- [ ] Add fixture coverage for retries, failed attempts, zero-dispatch invocations, multiple models, stale or missing telemetry, and schema-version rejection.
- [ ] Show per-role and per-model token, cost, and timing breakdowns in `result.json` and the HTML report.

## 3. Validate the integrations with a fresh eval

- [ ] Run targeted tests for each change, followed by `npm run check`.
- [ ] Pin the fixture, Agent Runner, Agent Skills, Agent Validator, workflow, rubric, pricing snapshot, judge configuration, and role profile used by the run.
- [ ] Run a fresh candidate using the current intended profile, including Astra as lead and implementor if that remains the configured nightly profile.
- [ ] Confirm the automated verdict lets Agent Factory decide whether to post the human-review command without reimplementing suite policy.
- [ ] If eligible, leave the candidate server available, complete human review, and publish the official result.
- [ ] Record newly discovered harness or product-infrastructure defects as focused follow-ups with regression coverage.

## Deferred

- Repeated statistical trials and confidence reporting.
- Isolated lead-only and implementor-only evaluations.
- Harbor parity investigation.
- Making estimated cost affect score rather than remaining report-only.
