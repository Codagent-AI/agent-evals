# Tasks

Implement on the change's feature branch. The task must leave `npm run check` green.

- [x] [Experiment baseline record and `experiments.mjs baseline` CLI](tasks/01-experiment-baseline-record.md)

These are not implementor tasks. They run after this task:

- the exploratory acceptance pass, under the envelope in `test-plan.md`;
- seeding the first baseline from agent-evals#67 (`set --source profile-change`, then
  `anchor --from-current`). This is a manual step after merge, once the factory has saved the three
  #67 result directories;
- recording agent-evals and Agent Validator revisions in `result.json`, a follow-up schema change.
