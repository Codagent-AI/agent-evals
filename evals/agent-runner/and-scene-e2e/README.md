# and-scene-e2e workflow evaluation

This suite measures what a user gets from a complete Codagent workflow: one short
request in, a draft pull request out. It runs a selectable workflow (default
`openspec:change`) in Agent Runner's sandbox from the define suite's starting
prompt and history-free starting repository, through `define` and `implement`,
and stops before the top-level `accept` step. A simulated user answers the define
workflow's interactive turns; everything after `define` is autonomous.

It reports two scores, never combined: a **definition score** (the define suite's
rubric over the artifacts collected when `define` completed) and a **product
score** out of 100 (70 automated points under a from-prompt product rubric, plus
30 points of human review). A non-scoring **requirement trace** shows, for each
graded hidden requirement, whether the agent asked about it, whether the
definition covers it, and whether the product delivers it. There is no pass/fail
verdict. All commands run from the repository root.

## How a run works

1. **Preflight** checks the workflow, profiles, clean Runner and Skills checkouts,
   skills, Runner capabilities, Docker, every CLI's authentication (including the
   CLI the starting tree's Agent Validator reviews with), the pinned inputs, the
   product rubric, and the GitHub App credentials and their reach.
2. **Provisioning** creates a fresh private repository `Codagent-AI/e2e-run-<run-id>`
   seeded with the starting commit. The sandbox gets a token that reaches only that
   repository; the host refreshes it.
3. **Define** runs `agent-runner run <workflow> --external-user ... --until define`.
   The host collects the change directory (never running Git on the evaluated
   workspace) and runs the **define checkpoint**: conversation reconciliation,
   contamination pass 1, then the disclosure audit. A settled leak ends the run
   (`evaluation-harness-failed`, not resumable); a contamination match ends it
   `contaminated`. Only a clean checkpoint lets implementation start.
4. **Implement** resumes the same Runner run with `--until implement`. Any
   external-user request is refused and ends the run.
5. **Delivery verification** fetches the delivery repository into a repository the
   harness creates, requires the pushed branch, one open draft pull request at the
   delivered commit, and the unarchived change, and retains a Git bundle plus the
   acceptance evidence. Later phases (and rescore and human review) use only these.
6. **Contamination pass 2**, definition scoring, **product evaluation**
   (build plan and build in a throwaway container, browser judges with replay
   confirmation, the shared judge panel, gates), the requirement trace, metrics,
   then the result and report. A run whose product built becomes
   `pending-human-review`.

## Running

```sh
evals/agent-runner/and-scene-e2e/run.sh --help
evals/agent-runner/and-scene-e2e/run.sh --dry-run --lead-cli claude --lead-model MODEL --lead-effort high \
  --crosscheck-cli codex ... --implementor-cli codex ... --tester-cli claude ...
evals/agent-runner/and-scene-e2e/run.sh --run-agent <the same four profiles> [--run-dir DIR] [--no-publish]
evals/agent-runner/and-scene-e2e/run.sh --resume --run-dir DIR <the same profiles>
evals/agent-runner/and-scene-e2e/run.sh --rescore-from OLD_DIR --run-dir NEW_DIR
evals/agent-runner/and-scene-e2e/run.sh --calibrate [--repeats N] [--inputs ID,...]
evals/agent-runner/and-scene-e2e/human-review.sh --run-dir DIR [--no-publish]
node evals/agent-runner/and-scene-e2e/compare.mjs DIR DIR [...]
```

* **Checkouts and workflow.** `--runner-dir` and `--skills-dir` (or `AGENT_RUNNER_DIR` and `AGENT_SKILLS_DIR`) name clean Agent Runner and Agent Skills checkouts. `--workflow REF` selects the evaluated workflow (default `openspec:change`); any workflow that declares top-level `create`, `define` and `implement` steps and the five define sub-steps can be compared.
* **Profiles.** Every role the workflow uses through `implement` needs an explicit
  CLI, model and effort (default workflow: `lead`, `crosscheck`, `implementor`,
  `tester`). `lead` is `claude` or `codex`; `cursor` is accepted only for
  `crosscheck`. Simulated-user and judge profiles are pinned. Use the runner-config
  profiles (`~/.agent-runner/config.yaml`) for paid runs.
* **Limits.** `--time-limit` is one whole-run limit counting only time an Agent
  Runner invocation runs (default `12h`); `--stall-window` is the inactivity window
  (default `45m`). Both are preserved across resumes. A Claude usage limit with an
  explicit UTC reset within six hours is waited out (outside both limits) and the
  same Runner run resumes with the phase's `--until`; any other 429 is an ordinary
  resumable failure.
* **`--token-refresh-interval MINUTES`** (default 30, from 1 to 50) sets how often
  the host re-mints the delivery token. It is recorded in provenance and is not part
  of the series identity.
* **Resume** reuses every proven unit and never starts a second Runner run. A run
  that ended `contaminated`, leak-failed or out of time cannot be resumed; a leak
  needs a new run. A publication failure resumes publication only.
  A resume may use a different Agent Runner checkout, for example one with a fix
  for the failure it resumes from; every other candidate input must match. The
  candidate keeps the starting commit, and `result.json` (`agent_runner_commits`)
  and the report list each commit with the first unfinished phase it took over.
  A `contaminated` run can be resumed after a contamination-pattern fix with a
  version bump: both passes rerun under the new patterns, and the run continues
  only if they are clean (`contamination_pattern_versions` records each version).
  A `pending-human-review` run can be resumed before its review to recompute
  units a harness fix invalidated; product evaluation reuses its cached judge jobs
  and the workflow is not dispatched again.
* **Rescore** reruns reconciliation, both contamination passes, the disclosure
  audit, definition scoring, product evaluation from the retained bundle with the
  source run's recorded build plan, and the trace, under the current evaluator
  inputs. It starts no Runner, evaluated agent or GitHub operation, and is never
  published. It refuses a source whose retained inputs no longer match their hashes.
* **Human review** serves the retained build (rebuilding it from the bundle and the
  recorded plan when necessary), runs and-scene's unchanged questions and scale, then
  completes and publishes the result. The human floor and the minimum individual
  rating are reported and never applied.
* **Compare** groups scored runs by series and candidate, reports mean, standard
  deviation and worst repetition, and classifies two groups only when each has at
  least three scored repetitions. Smaller groups are screens.

## GitHub App setup (one time, by an organization owner)

Create a GitHub App on `Codagent-AI` with repository permissions Administration
(write), Contents (write), Pull requests (write), Checks (read), Commit statuses
(read) and Metadata (read), and organization permission to create repositories.
Do **not** grant Workflows. Install it on `Codagent-AI` with **Only select
repositories** and none selected, so it reaches only the repositories it creates.
Store the private key on the host (mode 0600) and record the App in
`~/.config/and-scene-e2e/app.json` (mode 0600):

```json
{ "id": 5441507, "slug": "codagent-and-scene-e2e", "key_file": "/Users/paul/.config/and-scene-e2e/app-key.pem" }
```

The suite reads the App id and key path from that record. `AND_SCENE_E2E_APP_ID`
and `AND_SCENE_E2E_APP_KEY_FILE` override it when set.

Claude auth for the sandbox comes from `~/.claude/.credentials.json`, or from
`CLAUDE_CODE_OAUTH_TOKEN`: the environment's, else that one entry of Agent
Runner's `.sandbox-secrets.env` (or `SANDBOX_SECRETS_FILE`), as for the other
suites. The sandbox still runs with `--no-default-secrets`, so that file's
`GITHUB_TOKEN` never reaches the evaluated environment.

`run.sh --dry-run` then proves the reach check: it lists no repository outside the
`e2e-run-` delivery repositories. If GitHub does not grant the App access to
repositories it creates, add each repository to the installation through the
installation-repositories API after creation and keep the same check.

The App key and the unrestricted provisioning token stay on the host. The run token
is written to `<run-dir>/.github-auth/token` (mode 0600) while an invocation runs and
removed after it. Browser judging and human review start host Chrome from
`AND_SCENE_HOST_CHROME`, `CHROME_PATH`, or the standard install, on
`AND_SCENE_HOST_DEVTOOLS_PORT` (default 9333), and drive it with
`chrome-devtools-axi`; preflight fails when either is missing. The harness starts the
AXI bridge itself, with the `chrome-devtools-mcp` installed beside `chrome-devtools-axi`.
Claude browser judges may run only `chrome-devtools-axi` commands. The Codex browser
judge runs outside Codex's sandbox, because the macOS sandbox blocks the process check
AXI uses to find its bridge; it still gets a stripped environment and a private Codex home.

`--no-publish` keeps a complete result in the run directory, for a launcher that
publishes results itself. A run directory holding only a launcher's own output
(`factory-suite.log`, `.factory/`) counts as unused, so a launcher may create it first.
A Claude quota wait prints `Claude <role> quota reached; waiting until <time> before
resuming Agent Runner` to stderr.

## Delivery repositories

Delivery repositories are retained (the harness never deletes one) so a run can be
reviewed or reasoned about later. Delete one by hand when it is no longer needed:

```sh
gh repo delete Codagent-AI/e2e-run-<run-id> --yes
```

Rescore and human review need only the retained bundle, so deleting the repository
does not affect them.

## The product rubric and calibration

`product-rubric.json` is adapted from and-scene's rubric. Every fixture-owned
criterion and gate cites `mandatory` or `acceptable-alternative` inventory items and
is judged against those items' statements, intents and quotes, never against a
reference preference (a route, step count, step title, canvas size) or the
candidate's own definition. `preference-values.json` lists the concrete values that
may not appear in rubric wording unless a cited item's quote also contains them.
`exclusions` lists graded items deliberately left ungraded, each with a reason and
reviewer. The rubric declares no threshold and no floor, and is **provisional**:
every result scored under it says so.

`--calibrate` judges the pinned reference (`calibration/reference.bundle`), two
preference-shifted copies (layout and content; chrome and controls) and three degraded
copies (mode toggle loses position, focused controls lose keys, captions missing)
`--repeats` times each (default 3) and reports
per-input scores and spread, accuracy against `calibration/expected-verdicts.json`,
per-criterion flip rates and decider reversals. A degraded copy is judged only on the
subcomponents holding the criteria it is expected to fail, plus the source job its
browser criteria fall back to, so its score covers that slice. A full pass takes about
an hour of judging; `--inputs` re-judges only the named inputs, and flip rates need at
least two repeats. It is never published and never required. Calibration alone does not clear the provisional flag: a maintainer must
approve the expected verdicts and the rubric after a passing calibration **and** a
rescore of the first live candidate run with identical inputs, with differences
attributed per criterion by
`node evals/agent-runner/and-scene/scripts/compare-rescores.mjs`. Rebuild the
calibration inputs with `node evals/agent-runner/and-scene-e2e/scripts/build-calibration.mjs [and-scene checkout]`.

## Residual risk

The sandbox has network access and the reference is public, so contamination is
detected by audit rather than prevented; the exchange and audit evidence are
writable by the evaluated agent and checked by reconciliation. The sandbox also holds
a token that can push to the run's own delivery repository and to no other.

## Tests

```sh
node --test test/and-scene-e2e-*.test.mjs
npm run check
```

The real-browser cases for the generic replay live in
`test/real-browser/adversarial.test.mjs`; run them by hand, one at a time, per the
repository `AGENTS.md`.
