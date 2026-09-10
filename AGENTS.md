# Agent Evals

Agent Evals contains evaluation suites for Codagent tools.

## Repository rules

- Keep suites under `evals/<product>/<suite>/`.
- Let each suite own its fixture pins, runner, evidence, scoring, and runbook.
- Do not introduce shared frameworks until at least two suites need the same behavior.
- Keep evaluated product infrastructure in the product repository. For Agent Runner, this includes the sandbox image, local build, authentication forwarding, and devcontainer.
- Use test-driven development for behavior changes. Run targeted tests, then `npm run check`.
- Do not add third-party runtime dependencies without explicit approval.
- Use `chrome-devtools-axi` when an agent needs to inspect or operate a browser. Prefer it over direct Chrome DevTools MCP use.

## Running the Agent Runner `and-scene` suite

Run commands from the repository root. The suite runbook is
[`evals/agent-runner/and-scene/README.md`](evals/agent-runner/and-scene/README.md);
consult `run.sh --help` before constructing an unfamiliar invocation.

- Start with `evals/agent-runner/and-scene/run.sh --proof-browser` when checking
  a local Runner/sandbox/browser setup. It does not run implementation agents.
- Use `--calibrate` only when changing or reviewing the rubric, scoring, gates,
  or reporting. Calibration is a maintainer diagnostic, not a prerequisite or
  runtime gate for a candidate evaluation.
- A paid candidate run needs `--run-agent`, all three role profiles
  (`--lead-*`, `--implementor-*`, and `--reviewer-*`), a clean Agent Runner
  checkout, a clean pinned Agent Skills checkout, Docker, valid CLI auth, and
  GitHub credentials permitted to push a candidate branch and create a draft
  PR. Use `--dry-run` to inspect the planned sandbox invocation without Docker
  or model calls.
- To continue an interrupted run, reuse its exact artifact directory with
  `--resume` and the same profiles and score-affecting inputs. Do not start a
  second run in that directory. `result.json` and `run-state.json` explain the
  owning failed phase and whether it is resumable.
- The run's `.runtime/` directory is private recovery state, not a published
  artifact. It retains allowlisted Codex and Claude session data so a
  replacement container can resume, but must never retain credentials or CLI
  settings. Guard every session-state path and its immediate parent against
  symlinks before creating it; this prevents state escaping the evaluation.
- `--skip-validator` intentionally skips every workflow-owned Agent Validator
  path, including the final Validator; it does not skip eval-owned scoring.
  The harness requires an explicit skipped Validator outcome as evidence.

## Operational diagnostics

- Read `result.json` first for a failed or incomplete evaluation; inspect
  `run-state.json`, `logs/`, `evidence/`, and `phases/` for supporting detail.
  Human review is separate: run `human-review.sh --run-dir <artifact-dir>` only
  after an eligible automated result.
- Agent Runner owns sandbox builds, auth forwarding, workflow execution,
  durable run state, and audit. Changes to those mechanisms belong in the
  Agent Runner repository; this repository owns orchestration, persistence,
  evidence, scoring, and reports.
- Claude quota recovery is deliberately narrow: only an identified Claude
  limit event with an explicit UTC reset within six hours is waited for and
  resumed. Other 429s or ambiguous/stale quota evidence remain normal
  resumable failures.
- Generated `evals/agent-runner/and-scene/results/**` records are historical
  output and are excluded from Validator reviews. Do not edit them to change a
  past result; correct erroneous publication with a later revert.
- Implementation metrics come from Agent Runner's `run-metrics.json`; retain
  its completeness/provenance rather than inventing totals. Eval-owned Codex
  judge usage lives separately in `phases/eval-owned-usage.jsonl` and is not
  implementation cost.

## Commit messages

Use `type: lowercase description` with one of: `fix`, `feat`, `chore`, `refactor`, `test`, or `docs`.
