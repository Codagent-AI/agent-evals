# Tasks

Implement on the change's feature branch (`factory/feature-75-d90b4b98`). The task must leave
`npm run check` green. Work in the order the task file gives, which follows `design.md` §1 to §7.
Commit at coherent points, keeping `npm run check` green at each commit.

- [x] [Honest browser probes and a second opinion on every failure](tasks/01-honest-probes-and-second-opinion.md)

These are not implementor tasks. They run after this task:

- the exploratory acceptance pass, under the envelope in `test-plan.md`;
- the post-merge evaluator-only rescore of the three agent-evals #67 reps (claim `cc572181`), which
  the issue owns and which needs real judge calls.
