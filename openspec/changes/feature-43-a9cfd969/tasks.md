# Tasks

Implement on the change's feature branch. The task must leave `npm run check` green. It follows the
issue's two delivery slices in order: estimated pricing first, then per-step cost. Each slice ends at
a commit with a green `npm run check`, so the work can be split across two pull requests when the
issue's PR 1 / PR 2 plan is followed.

- [ ] [Estimated pricing, fallback rates, and per-step cost for and-scene results](tasks/01-estimated-per-step-cost.md)

These are not implementor tasks. They run after this task:

- the exploratory acceptance pass, under the envelope in `test-plan.md`;
- the agent-factory comment rendering, a follow-up in the agent-factory repository;
- pricing Validator attempts, which is waiting on agent-validator#160.
