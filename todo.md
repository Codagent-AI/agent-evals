# Agent Evals current work list

Last reconciled: 2026-09-09.

This file tracks unfinished work only. Completed harness work and historical
plans belong in Git history and archived OpenSpec changes, not in this backlog.

## 1. Validate the integrations with a fresh eval

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
