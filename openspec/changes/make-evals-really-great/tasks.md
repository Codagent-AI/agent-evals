# Tasks

Implement in order on one feature branch cut from `dev`. Each task must leave `npm run check`
green; from task 2 onward the corpus replay must also match before the next task begins.

- [x] [Settle the in-flight change and correct the known wrong deductions](tasks/01-settle-harden-change-and-correct-wrong-deductions.md)
- [x] [Golden-verdict regression corpus, replay command, and staleness check](tasks/02-golden-verdict-regression-corpus.md)
- [x] [Not-observed outcome for deterministic criteria, resolved by a declared fallback judge](tasks/03-not-observed-outcome-and-fallback-judge.md)
- [x] [Hold publication when the browser evaluator and an LLM judge contradict each other](tasks/04-evaluator-contradiction-review-hold.md)
- [x] [Link every rubric criterion to the pinned fixture and check the link](tasks/05-rubric-fixture-traceability.md)

Not implementor tasks: agent acceptance (`AT-001`–`AT-005`) and the human-only steps in
`test-plan.md` — the user's approval and application of the five record adjudications (`HT-001`),
and re-judging and human review of the issue #26 repetitions (`AT-003`, `HT-002`) — run after
these tasks.
