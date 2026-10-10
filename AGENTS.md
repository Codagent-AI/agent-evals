# Agent Evals

Agent Evals contains evaluation suites for Codagent tools.

## Repository rules

- Keep suites under `evals/<product>/<suite>/`.
- Let each suite own its fixture pins, runner, evidence, scoring, and runbook.
- Do not introduce shared frameworks until at least two suites need the same behavior.
- Keep evaluated product infrastructure in the product repository. For Agent Runner, this includes the sandbox image, local build, authentication forwarding, and devcontainer.
- For behavior changes, run targeted tests, then `npm run check`.
- Do not add third-party runtime dependencies without explicit approval.
- Use `chrome-devtools-axi` when an agent needs to inspect or operate a browser. Prefer it over direct Chrome DevTools MCP use.
- Run `agent-validator run` before archiving an OpenSpec change or opening a pull request. Treat a review that returns only a one-line pass on a large diff as unreviewed, and review that area by hand.

## Real-browser test suites

`npm run check`, which CI runs, covers only `test/*.test.mjs` and takes about a minute. The suites in `test/real-browser/` drive real Chrome, so they sit outside that glob and CI never runs them. Run them by hand; each file header has its command, and the suite README describes the candidate and adversarial suites.

| Suite | Covers | Rough time | Run before merging a change to |
| --- | --- | --- | --- |
| `driver-primitives.test.mjs` | the axi browser driver's key presses, swipes, and keydown instrumentation | a few minutes | `lib/axi-browser-driver.mjs` |
| `input-hygiene.test.mjs` | the modifier-key and swipe-from-control probes | about 3 minutes | those probes, or the driver primitives they use |
| `candidate.test.mjs` | the whole browser evaluation against one real candidate (build and serve steps in its header) | about 5 minutes | any browser probe or gate, or `lib/browser-eval.mjs` |
| `adversarial.test.mjs` | probes and second-opinion replays against hand-made trick pages | about 70 minutes | the probes the README lists, or second-opinion replay in `lib/second-opinion.mjs` |

- They share one Chrome, so run them one at a time, and never while another agent or session is using that browser. Concurrent use produces spurious failures.
- Run the adversarial suite once, at the end of a change, not after every edit.
- Before relying on a suite for a change, run it on the base commit, so an existing failure is not mistaken for a new one.

## OpenSpec deltas

- A `MODIFIED` requirement replaces the whole requirement when archived. Copy it from the current text on `main`, and check open pull requests that change the same requirement; a stale copy silently reverts their update.
- Never rename a `#### Scenario:` header inside a `MODIFIED` requirement: `openspec archive` then aborts with no recovery path.

## Running the Agent Runner `and-scene` suite

Run commands from the repository root. The suite runbook is
[`evals/agent-runner/and-scene/README.md`](evals/agent-runner/and-scene/README.md);
consult `run.sh --help` before constructing an unfamiliar invocation.

- The Validator configuration an eval reviews with is the and-scene fixture's
  `.validator/config.yml`, at the pinned fixture commit. To change the eval's
  reviewer CLI or model, commit the new config to `Codagent-AI/and-scene`, then
  update the fixture commit everywhere it is pinned: `FIXTURE_REF` in `run.sh`
  (default and `--help`), `controller.mjs`, the suite `README.md`,
  `fixture-snapshot/snapshot.json`, and `test/and-scene.test.mjs`.
- Factory evals fetch this repository's `main` at admission, along with Agent
  Runner and Agent Skills `main` (and Agent Validator `main` on Fly). A change merged here applies
  to the next eval with no factory deploy.

- Start with `evals/agent-runner/and-scene/run.sh --proof-browser` when checking
  a local Runner/sandbox/browser setup. It does not run implementation agents.
- Use `--calibrate` only when changing or reviewing the rubric, scoring, gates,
  or reporting. Calibration is a maintainer diagnostic, not a prerequisite or
  runtime gate for a candidate evaluation.
- When a rubric change moves points onto LLM-judged criteria, measure how often
  each new criterion's verdict flips across repeated rescores of the same code
  before relying on calibration or comparing scores across rubric versions.
- A paid candidate run needs `--run-agent`, all three role profiles
  (`--lead-*`, `--implementor-*`, and `--tester-*`), a clean Agent Runner
  checkout, a clean pinned Agent Skills checkout, Docker, valid CLI auth, and
  GitHub credentials permitted to push a candidate branch and create a draft
  PR. Use `--dry-run` to inspect the planned sandbox invocation without Docker
  or model calls.
- To continue an interrupted run, reuse its exact artifact directory with
  `--resume` and the same profiles and score-affecting inputs. Do not start a
  second run in that directory. `result.json` and `run-state.json` explain the
  owning failed phase and whether it is resumable.
- The run's `.runtime/` directory is private recovery state, not a published
  artifact. It retains allowlisted Codex, Claude, and Cursor session data so a
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
  its completeness/provenance rather than inventing totals. Eval-owned Claude and Codex
  panel, decider, and audit usage lives separately in `phases/eval-owned-usage.jsonl` and is not
  implementation cost.

## Commit messages

Use `type: lowercase description` with one of: `fix`, `feat`, `chore`, `refactor`, `test`, or `docs`.

## Maintaining the Agent Runner `and-scene-define` inputs

The pinned-input runbook is
[`evals/agent-runner/and-scene-define/README.md`](evals/agent-runner/and-scene-define/README.md).
Run `scripts/check-inventory.mjs` from that suite via Node to verify the reference,
inventory, and versions. Keep `hidden/`, citation supplements, `calibration/`,
and contamination patterns on the host. Materialize only the allowlisted
starting tree; the starting repository has no remote and needs no GitHub credential.


## Running the Agent Runner `and-scene-define` suite

Run from the repository root; consult
[`evals/agent-runner/and-scene-define/README.md`](evals/agent-runner/and-scene-define/README.md)
and `run.sh --help` before constructing an invocation.

- Start with `--dry-run`; paid candidates use `--run-agent` with lead and
  crosscheck profiles and a clean Agent Runner `main` checkout (it includes the
  external-user mode, `--auth-only`, and `--hide-source`). Evaluator inputs remain on the host.
- Resume in the exact run directory with unchanged profiles and pinned inputs.
  Publication failures resume delivery alone, using the existing result commit.
- `--rescore-from <run-dir> --run-dir <new-dir>` verifies retained manifest hashes
  and runs current host evaluators without Docker or Runner. Rescores never publish.
- Compare with `node evals/agent-runner/and-scene-define/compare.mjs <run-dir>...`.
  Only identical series are paired; changing evaluator/fixture inputs starts a new series.
- Read `result.json` first; publication errors live in `publication.json` and
  `run-state.json`. Workflow metrics and eval-owned usage remain separate.
- `results/**` are historical output excluded from Validator reviews. Never edit
  them to change a past result; use a later revert for erroneous publication.
