# and-scene-define workflow evaluation

This suite defines `add-presentation-skill` from the short starting prompt. Its
fixture is `https://github.com/Codagent-AI/and-scene.git` at
`ad667a965a0e1ea0b028c36c04d57bf0411d30d9`, change `create-and-scene`.
The host controller runs `openspec:change --until define` through Agent Runner's
sandbox and answers interactive turns using the host-side simulated user.
The host retains native transcripts and conversation evidence, audits contamination
and disclosure, applies gates and panel judging, and writes a discovery ledger.
Every outcome produces `result.json` and an offline, self-contained `report.html`.
A plan receives a score out of 100, with no pass/fail verdict. Completed, scored
candidate runs are published as a separate definition results series.
Contamination stops scoring and publication. All commands run from the repository root.

Run from the repository root:

```sh
node evals/agent-runner/and-scene-define/scripts/check-inventory.mjs
node --test test/and-scene-define-*.test.mjs
npm run check
```

Refresh the host-only reference and neutral starting scaffold using a local
fixture clone containing the pinned commit (its checked-out HEAD may differ):

```sh
node evals/agent-runner/and-scene-define/scripts/refresh-reference.mjs --checkout /path/to/fixture
node evals/agent-runner/and-scene-define/scripts/build-starting-snapshot.mjs --checkout /path/to/fixture
```

Omit `--checkout` to fetch the pin into a temporary bare repository. Both tools
accept `--output HOST_DIR`. These outputs are maintainer inputs, never sandbox
staging directories. The reference snapshot contains only proposal, specs,
design, and test plan. Four unchanged inventory items additionally cite two task
documents; `hidden/citation-supplements/` pins these separately and
`reference.json` hashes them under `citation_files`. The inventory checker checks
these quotes too. No inventory item, class, or intent was altered during migration.

Compare quotes and coverage against a new fixture commit without overwriting
the committed snapshot:

```sh
node evals/agent-runner/and-scene-define/scripts/refresh-reference.mjs --check --ref FULL_COMMIT_SHA --checkout /path/to/fixture
```

This reports stale quotes and newly unmapped requirements and scenarios. A pin
change requires re-itemization, independent labelling, and reconciliation of
reported items, then a new inventory version. Update the suite fixture constant,
reference snapshot, and starting snapshot together. `assertPinnedInventory()` is
the preflight API: it rejects stale quotes, invalid coverage, input hash changes,
fixture pin mismatches, and unpinned versions.

An `acceptable-alternative` item's intent is copied verbatim from one labeller
(`intent_source`). A maintainer may instead write the intent, with
`intent_source: "maintainer"` and an `intent_reason`; the check rejects a
maintainer intent without a reason. Inventory versions 4 and later do this for
the navigation-boundary and production-build render items.

`starting-repo/manifest.json` records the explicit allowlist, neutral rewrites,
source and output SHA-256 hashes, and Git tree hash. Unlisted fixture files,
including hidden change artifacts, review guidance, and branded assets, are
excluded. The scaffold retains the fixture's existing dependency pins; this
suite adds no runtime dependencies. The starting tree still requires maintainer
review under HT-001; that review has not been performed by this task.

`materialize(outDir)` in `lib/starting-repo.mjs` requires a new output directory
whose parent exists. It writes only `repository/` and `starting.bundle`, returning
`{ repoDir, bundlePath, commit, treeHash }`. Author, committer, date, commit text,
Git object format, and branches are fixed; user Git configuration and hooks are
disabled. `main` and `add-presentation-skill` point to the sole commit, the feature
branch is checked out, and there is no remote. The manifest remains on the host.

Before any evaluated model call, the controller calls
`scanCanaries({ stagedDir, skillsDir, credentialFiles })` on the host. It scans
all staged files, Git repository and bundle objects, the Agent Skills HEAD's
tracked blobs and working copies, and forwarded credential/configuration files.
Symlinks, submodules, and unsupported file types cause a scan error instead of
silently omitting readable content. Matches return `{ file, pattern, kind }`.
The controller turns matches or scan errors into `evaluation-harness-failed` and
stops before starting the sandbox. Never stage `hidden/`, `calibration/`, the
pattern list, or any suite manifest. Credential isolation and preventing push/PR
operations are enforced by the sandbox invocation.

`versions.json` records current versions and immutable historical content hashes.
For a content change, bump the input's version, retain its old hashes, and append
the new hash. JSON inputs carry their own version field; the starting prompt's
version lives in the ledger. The check also compares Git's committed ledger to
catch changing a recorded hash without a version bump. Git or baseline lookup
failures reject the check; incomplete shallow history must be fetched before
preflight. Only a genuinely new, uncommitted ledger needs no baseline. The
rubric and simulated-user policy are both recorded as versioned inputs.

The simulated user is pinned to `claude-opus-5-5`. Its versioned disclosure and
decision policy is `hidden/simulated-user-policy.md`. `loadSimulatedUserInputs()`
checks the pins and constructs a system prompt from an explicit allowlist of
proposal, specs, design and test plan; citation supplements, task files, inventory
classes and rubric never enter the prompt. Only the system prompt hash is retained
in usage evidence. Each call starts in a private temporary directory (0700), writes
the system prompt to a file (0600), and passes its path with `--system-prompt-file`
so the reference text never enters process arguments. The directory and prompt
are removed after the call. Host auth is retained, including
`CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_API_KEY`; other `CLAUDE*` behaviour
overrides are removed. Calls use no settings sources, no MCP servers, no real
tools and no session persistence. Combined stdout and stderr buffering is capped
at 10 MiB; overflow terminates the child and records a rejected call.
Every call appends to `phases/eval-owned-usage.jsonl`; rejected calls record zero
tokens and a rejection reason, with a bounded, credential-redacted stderr excerpt
for ordinary failures. Ordinary failures allow three attempts; schema
errors fail immediately and capacity errors back off until the caller's deadline.

The controller can call `runResponder({ runDir, exchangeDir, deadline, signal,
invoke, runnerRunId })` from `lib/responder.mjs`. `deadline` is an absolute epoch
millisecond number or Date. `exchangeDir` must exist. `invoke` is optional and
injectable; it receives `{ conversation, request, deadline, signal }` and returns
`{ text, reply_type, usage }`. Cancel `signal` when Runner exits. Cancellation leaves
pending requests resumable; expiry reports `elapsed-time-limit` and publishes an
abort for a pending request. Other failures report `evaluation-harness-failed`.
Outcomes also carry `last_active_step` and `runner_run_id`. The controller owns
sandbox termination and final evaluation status. The loop uses no external-user
timeout and has no policy-test prerequisite.

`responder-state.json` retains the Runner run ID on the host. A controller with an
already recorded ID should pass `runnerRunId`; any discrepancy fails. Conversation
identity uses JSON `step`, `step_id`, `attempt`, and `turn`, regardless of filename.
`conversation.jsonl` is fsynced before atomic reply publication (0644). Restarting
replays recorded replies without another model call, including after a stop in
the write-ahead window. A torn final JSON record is truncated and fsynced before
the pending request is processed again; corruption in earlier records fails the
run. A complete final record missing only its newline is retained and durably
separated from later appends. Run only one responder per artifact directory.

Run the optional maintainer policy diagnostic manually (30 paid Claude calls):

```sh
node evals/agent-runner/and-scene-define/policy-test.mjs --output /absolute/diagnostic-dir
```

Its own directory holds `policy-test.json` and its eval-owned usage ledger.
Ten fixed cases each run three times, covering disclosure, repetition across
steps, approval, settled and unsettled crosscheck findings, and refusal to act.
The report checks expected reply types and intent patterns, known over-disclosure,
and private-reference mentions. `consistent` compares these intent checks, while
`exact_text_consistent` compares wording. These are heuristics: inspect the retained
replies to assess nuanced semantic compliance and consistency. This diagnostic is
never a candidate gate. Automated tests use a stub CLI and clean PoC stream replays;
no paid calls are required by `npm run check`.


Run `run.sh --help` before constructing a new invocation. Node 22, Git, and Go
are needed on the host: preflight builds a temporary Runner from the selected
checkout to probe `--external-user`, then deletes the binary. Dry runs do not
need Docker or host evaluator auth, but the real Runner script requires each
selected CLI's credential file to exist. A Claude login kept in the macOS
Keychain has no `~/.claude/.credentials.json`; export a `claude setup-token`
token as `CLAUDE_CODE_OAUTH_TOKEN` instead, which the sandbox receives by name,
for example
`export CLAUDE_CODE_OAUTH_TOKEN="$(sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' ~/codagent/agent-runner/.sandbox-secrets.env)"`. They verify clean checkouts, workflow
steps, plugin manifests, snapshot and inventory pins, mount isolation, and the
canary check; they start no container and make no model call.

```sh
AGENT_RUNNER_DIR=/path/to/clean/agent-runner \
AGENT_SKILLS_DIR=/path/to/clean/agent-skills \
evals/agent-runner/and-scene-define/run.sh --dry-run \
  --run-dir /absolute/new-run-dir \
  --lead-cli codex --lead-model gpt-6 --lead-effort high \
  --crosscheck-cli claude --crosscheck-model claude-opus-5-5 --crosscheck-effort high \
  --time-limit 3h
```

Use `--run-agent` with the same options for a paid candidate. That mode also
checks Docker availability and host Claude/Codex auth (`claude auth status`
for the host Claude login, which may live in the Keychain). Use an unused directory;
even a dry run reserves its directory. `--resume --run-dir` reuses the exact
existing directory and requires identical profiles, evaluator inputs, candidate
commits/workflow hashes, and time limit. The original deadline survives resume,
including downtime. Active containers are refused. Inactive unfinished runs use
the exact saved Runner ID; a capped stop is collected without resuming it. An
ambiguous crash without recoverable Runner state is refused rather than starting
a duplicate. `result.json` names the owning failure phase and resumability.
Filesystem failures or incomplete JSON encountered while reading an already
started Runner run remain resumable after its evidence is made readable again;
resumption still requires valid, matching Runner state. Runner's `-v` mount syntax
cannot represent colons in run or checkout directory paths.

Only six allowlisted files enter `sandbox-input/`: the deterministic starting
bundle, driver, CLI/session bootstrap scripts, and Runner config/settings. The
script obtains its own input directory without evaluator paths or patterns.
Preflight regenerates these inputs on resume and refuses changed hashes. Every
Docker command is checked: the build container may mount Runner source, while
the command container receives only input, sandbox artifacts, the Skills checkout,
selected credential files (or the Claude setup-token by name), and the Runner
binary's named volume. Host settings and GitHub credentials are excluded. The inherited canary checker rejects tracked
symlinks in a Skills checkout; such a checkout must be corrected before a run.
The Docker image is not canary-scanned; this gap is retained in preflight evidence.

The private `sandbox/.runtime/` retains Runner projects, Codex session stores,
Claude projects, and Cursor chats. Credentials and CLI configuration stay in the
disposable home. Do not publish `.runtime/`. Workflow state, audit, and metrics
and every evaluated invocation's native transcript, exchange records, and per-turn
outputs are copied into host `evidence/`. `evidence-manifest.json` hashes every
retained input needed for rescore, including `conversation.jsonl` and `collected/`.
Collection rejects missing, truncated, or incomplete native transcripts. Cursor
crosschecks require the host `sqlite3` CLI; collection uses `VACUUM INTO` and atomic replacement to
retain a consistent snapshot including uncheckpointed WAL data.

`collected/` freezes definition artifacts and
`phases/collection.json` records HEAD and every file's SHA-256. Later evaluation
phases read the frozen collection. Workflow metrics ingestion is registered only
after discovery; its unit-tested implementation preserves native provenance,
partial usage, unknown costs, and per-step/per-role attribution. Eval-owned usage
remains separate in `phases/eval-owned-usage.jsonl`.

Reconciliation and contamination audit read retained evidence only and are
checkpointed as separate phases. `phases/reconciliation.json` records successful
one-to-one reconciliation; a mismatch names the exchange and record in
`result.json`. `phases/contamination-audit.json` has deterministic matches with
session, tool call, pattern, and excerpt, plus excluded disclosed canaries and
the residual-risk statement. Locator patterns scan every tool input and output;
undisclosed canaries skip file-writing tools. A match has no override and blocks
all later phases, including on resume. The result carries the audit and residual
risks: public network access, agent-writable evidence, the unscanned Runner
image, and the open network/private-fixture/separate-user hardening options.

The default checkout-independent tests exercise the driver with stub CLIs and
the lifecycle with a fake sandbox, without paid calls. Test INT-006 invokes the
real Runner sandbox dry-run script using isolated test auth and Skills inputs:

```sh
AGENT_RUNNER_DIR=/path/to/clean/agent-runner \
node --test test/and-scene-define-sandbox-plan.test.mjs
```

Without `AGENT_RUNNER_DIR`, that integration test skips with an explicit reason.
`--calibrate` is a maintainer diagnostic (see Calibration below). It is never a
candidate prerequisite or gate.

## Definition judging and calibration prerequisites

Inventory version 4 drafted `met`, `partial`, and `missing` anchors for all 72
graded items. The maintainer approved them in **HT-003 (anchor review)**, and
inventory version 5 records that review as `anchors_review: { reviewer, date,
inventory_version }`; the anchors themselves are unchanged. Any later change to
the anchors needs a new inventory version and a new review, recorded the same
way under the versioning rules above, before calibration or a candidate run.
Inventory version 6 (rubric version 10) tightens the INV-093 anchors: the
non-zero exit must be stated, and a command or check that is only said to fail
leaves the item `partial`. Calibration showed a decider, and the overrule check
behind it, reading "fails" as a non-zero exit.
Preference items have no coverage anchors.

`rubric.json` is generated from the inventory. Its coverage criteria and
anchors, quality and fidelity wording, guidance, and gates are always
regenerated; its scoring settings are recorded in the file and round-trip
through the builder:

| Setting | Field in `rubric.json` | Default |
| --- | --- | --- |
| Component points (sum to 100) | `components` | coverage 70, artifact_quality 15, fidelity 15 |
| Item weight per class | `weights` | mandatory 2, acceptable-alternative 1 |
| Quality criterion points (sum to artifact_quality) | `quality[].points` | 3 each |
| Fidelity deduction and floor | `fidelity.deduction_per_exchange`, `fidelity.floor` | 3 per contradicted exchange, floor 0 |
| Restructured-reference tolerance | `calibration.restructured_tolerance_items` | 3 (total coverage weight lost) |
| Repeat-judging spread limit | `calibration.max_spread` | 5 total-score points |
| Calibration evidence | `calibration_evidence` | `null` |

The maintainer approved these settings as they are (HT-002) after the E2E-003
calibration, and `rubric.json` records that approval (`provisional: false`) and a
summary of the calibration run in `calibration_evidence`. There is no pass
threshold: a rubric that sets `pass_threshold` is refused. Extra keys in
`calibration` are preserved. To change a setting, edit it, bump `rubric_version`
and `versions.json`, and run the builder. `--check` still refuses any coverage
criterion, anchor, or item weight that diverges from the inventory and the
recorded class weights, and any inconsistent settings.

Fidelity deducts only for contradicted preference or outside-inventory answers.
A fidelity finding whose `subject_id` names a graded item is not invalid judge
output: that contradiction is scored only under coverage, so the finding is
normalized to no deduction and listed in the score's
`excluded_graded_contradictions` (criterion, subject id, judged verdict, judge
and rationale). A `subject_id` outside the inventory remains invalid output. Candidate preflight
refuses unreviewed anchors and rubric/inventory mismatches. Dry runs verify
rubric consistency without requiring review.

```sh
node evals/agent-runner/and-scene-define/scripts/build-rubric.mjs
node evals/agent-runner/and-scene-define/scripts/build-rubric.mjs --check
```

The host judges use the shared `cross-family-panel-v2` protocol with Sonnet
5.5, two independent `gpt-6-luna` samples, and Opus 5.5 for decisions and
checks, all at high effort. Claude receives inlined inputs with no tools;
Codex receives only the job packet in a scratch working directory and a private
auth-only home outside the run directory, both removed afterward. Refreshed
authentication is saved atomically to the host auth file; private calls sharing
that file are serialized. On startup the invoker removes legacy `home-*`
credential copies from the run runtime directory. Calls write eval-owned usage to
`phases/eval-owned-usage.jsonl`.

The decider rules the criteria the panel did not settle in one batched call.
A ruling that differs from a verdict exactly two judges gave overrules them, so
it gets an `overrule-check`: the decider's model checks the ruling's stated
reason against its citations. The ruling stands only when the check is
`confirmed`. Otherwise, including `insufficient`, the two judges' verdict
stands with basis `majority-<verdict>`, and the result's `overrule_check`
records whether the ruling was upheld or rejected. A three-way split has no
two-judge verdict, so its ruling stands unchecked. A check that needs missing
material, or whose packet cannot fit, fails the job as a harness failure. Every
define panel job gets the check, including the disclosure audit, where a
not-leaked ruling against two Codex judges leaves the item leaked unless the
check confirms it.

The disclosure audit runs first, because its leaked items change coverage:
`gates-and-judging` reads `audits/disclosure.json` before it starts any job.
The coverage (one job per area), quality and fidelity jobs then run through the
shared bounded pool (`evals/lib/panel-judging/job-pool.mjs`), three at a time.
Checkpoint updates are written one at a time, results are recorded in job
order, and after a failed job or checkpoint no new job starts; jobs already
running finish before the phase fails.

`audits/disclosure.json` records settled and dissenting flags and leaked item
ids. Leaks are excluded from both earned and possible coverage. If every item
is leaked, coverage is zero. `judges/score.json` holds the component
scores and total, gates, citations and panel records. Gates are reported beside the
score and never change it: a failed artifact or OpenSpec gate still yields a
complete, scored result. If every item leaked, there is no total and
`score_unavailable` says why.
`discovery/asked.json` and `discovery/ledger.json` record asked decisions and the
five non-scoring outcomes. Each judge job is an independent durable checkpoint,
so a resumed judging failure reuses jobs whose provenance and hashes still
match. No hidden input, rubric, or judge packet is staged into the evaluated
sandbox.


## Retained-ruling check

`scripts/check-retained-ruling.mjs` runs the overrule check against one
decider ruling already recorded in a retained calibration record, of any
protocol: the recorded ruling, its stated reason and citations, with the
recorded votes. It prints the check's classification and the verdict v2
settlement would give, such as `partial (majority-partial)`. It makes at most
one decider call, on the pinned decider model, and only reads the record, its
run directory and the suite inputs: no judging record or cache entry is
written, so a retained record is never reused as v2 judging. The decider's raw
logs and usage go to a fresh temporary directory, which the output names.

```sh
node evals/agent-runner/and-scene-define/scripts/check-retained-ruling.mjs \
  --record <calibration-out>/inputs/<input_id>/repeat-<n>/judges/coverage-<area>.json \
  --criterion INV-093 [--run-dir DIR] [--suite-root DIR] [--scratch-dir DIR] [--json]
```

`--run-dir` defaults to two levels above the record. A ruling that overrules no
two-judge verdict needs no check, and the script says so without a model call.

## Calibration set

`calibration/` is the host-only input set for `--calibrate`, and it is never
staged or published. It contains:
- the fixture's own change (`reference`);
- a `restructured` rewrite that swaps acceptable-alternative mechanisms;
- six degraded variants, each with planted problems;
- an empty `real-candidates/` slot.

Each input pairs a `collected/` change directory with `expectations.json`, which
gives verdicts for all 72 graded items. Two inputs also carry a synthetic
`conversation.jsonl` that plants fidelity contradictions. `manifest.json` hashes
every input file. See
[`calibration/README.md`](calibration/README.md).

## Calibration (`--calibrate`)

A maintainer diagnostic. It is never a prerequisite or runtime gate for a
candidate run (candidate preflight reads only `rubric.json`), and its output is
never published: the report carries `mode: "calibration"`, which publication
refuses, and an output directory under `results/` is refused.

```sh
evals/agent-runner/and-scene-define/run.sh --calibrate --dry-run
evals/agent-runner/and-scene-define/run.sh --calibrate [--out DIR] [--repeats N] [--concurrency N] [--rescore-input ID]
```

- `--dry-run` loads the set, verifies `manifest.json` hashes and expectations,
  and prints the plan. It makes no model call and writes nothing.
- A real run refuses before any model call until `hidden/inventory.json` has
  an `anchors_review` for the current inventory version (HT-003).
- `--repeats` is at least 3 (default 3). Each repeat of each input is judged in
  its own fresh directory, `<out>/inputs/<input_id>/repeat-<n>/`, through the
  candidate `gates-and-judging` phase (OpenSpec gates, coverage per area,
  quality, and fidelity when the input has a conversation). No judged unit is
  reused between repeats. Inputs have no disclosure audit, so nothing is leaked.
- `--concurrency` is how many repeats are judged at once (default 6, at
  least 1). Each repeat judges its jobs one at a time, and each job's panel
  runs its three judges together, so the default keeps about eighteen judge
  CLIs in flight. The report is the same
  whatever order repeats finish in. After a failed repeat no new repeat
  starts, and the calibration fails once in-flight repeats finish.
- For each input's first repeat, the decider alone is re-run 3 times on every
  recorded panel record that reached it: the batched decider ruling, the
  overrule check of each re-run ruling that overrules a two-judge verdict, and
  every targeted dissent check, rebuilt exactly as the panel built them
  (`rerunDecider` in the shared panel module). A ruling counts as flipped when
  the verdict it settles after its overrule check differs from the recorded one.
- `--out` defaults to `artifacts/evals/and-scene-define-calibration/<timestamp>`
  (ignored by Git). Eval-owned usage is recorded in
  `<out>/phases/eval-owned-usage.jsonl`.

`calibration-report.json` (and the readable `calibration-report.md`) gives:
- per input: score (per repeat, mean, min, max), accuracy against
  `expected`, `expected_quality`, and `expected_fidelity` (agreement rate,
  confusion counts, per-item judged verdicts), stability (total-score spread
  and items whose verdict differs across repeats), settlement-basis shares, and
  per-family verdict distribution;
- overall accuracy, basis shares, and each model family's `met`/`partial`/
  `missing` rates beside the expected distribution, with an agreement rate and
  a signed leniency (mean judged minus expected value);
- `decider_flips`: the ruling-flip rate on fixed recorded panel outputs,
  separate from panel spread, measured on each ruling's verdict after its
  overrule check, naming each flipped item;
- `identical_rescore`: repeats 1 and 2 of `--rescore-input` (default
  `reference`), two judgings under identical conditions, diffed per item;
- `failures`, each naming the input and items: a removed mandatory item judged
  `met` in any repeat; the restructured reference (a `reference` variant whose
  id starts with `restructured`) losing more weighted coverage than
  `calibration.restructured_tolerance_items` against its expectations in any
  repeat; and a total-score spread above `calibration.max_spread`;
- `proposed_weights`: the current rubric settings, retained (calibration
  evaluates them; it does not fit new weights).

The exit status is 0 only when there are no failures. Calibration proposes no
pass threshold, because a plan receives a score only.

## Results, resume, and rescore

The paid run needs a clean Agent Runner checkout of `main`, which supports
`--external-user`, `--until define`, and sandbox `--auth-only`, `--hide-source`,
`--no-default-secrets`, `--input-dir`, and `--artifact-dir`. Use clean Agent Skills,
Docker, Go, Git, Node 22, OpenSpec on the host, and valid Claude and Codex host auth
for the simulated user and panel. Cursor crosschecks also need host SQLite.
Publication needs Git author configuration and a configured upstream with push
permission; GitHub credentials remain on the host.

```sh
# Paid candidate (the dry-run example above shows checkout overrides).
evals/agent-runner/and-scene-define/run.sh --run-agent \
  --run-dir /absolute/candidate-run \
  --lead-cli codex --lead-model gpt-6 --lead-effort high \
  --crosscheck-cli claude --crosscheck-model claude-opus-5-5 --crosscheck-effort high

# Interrupted workflow or evaluator phase: retain the same profiles and time limit.
evals/agent-runner/and-scene-define/run.sh --resume \
  --run-dir /absolute/candidate-run \
  --lead-cli codex --lead-model gpt-6 --lead-effort high \
  --crosscheck-cli claude --crosscheck-model claude-opus-5-5 --crosscheck-effort high

# Publication failure: retries delivery alone; no Runner checkout or profiles needed.
evals/agent-runner/and-scene-define/run.sh --resume --run-dir /absolute/candidate-run

# Current evaluator inputs; new output directory; no Docker or evaluated agents.
evals/agent-runner/and-scene-define/run.sh \
  --rescore-from /absolute/candidate-run --run-dir /absolute/rescore-run

# JSON comparison: pairs complete scored runs; identical series get paired scores/leak counts.
node evals/agent-runner/and-scene-define/compare.mjs \
  /absolute/candidate-run /absolute/another-run /absolute/rescore-run
```

The run directory retains:

```text
run-state.json              phase/job checkpoints, series identity and candidate
result.json, report.html    all outcomes, citations, panels and provenance
publication.json            delivery stage, result commit and retryable error
conversation.jsonl          simulated-user write-ahead conversation
evidence-manifest.json      retained file hashes and original identity
collected/                  frozen definition artifacts
evidence/                   Runner state/metrics/audit/exchanges, transcripts, turns
audits/                     disclosure flags, leaked items and panel decisions
judges/                     gates, scores and criterion panel records
discovery/ledger.json        non-scoring item outcomes and counts
phases/                     collection, reconciliation, contamination, workflow metrics
phases/eval-owned-usage.jsonl simulated-user, panel, decider and audit usage
logs/                       operational diagnostics
sandbox-input/, sandbox/    isolated inputs, workspace, private session recovery state
.runtime/                   private host evaluator scratch
```

`complete` is a finished evaluation with its score; failed gates are reported
beside the score. `contaminated` has no score, records every match, and is not
published. `definition-workflow-failed` identifies the failed
define step; `evaluation-harness-failed` identifies the evaluator phase. Both
failure statuses record the observed error and whether resume is possible. Read
`result.json` first, then the owning phase's checkpoint and evidence. A failed
publication leaves the complete evaluation untouched, exits nonzero, and records
the delivery error in `publication.json` and the publication unit in `run-state.json`.

Reports include all criteria/citations, each family's votes, settlement bases,
checks and decider rulings; gates, leaked count/items, added scope, disclosure flags,
contamination matches and residual risk; discovery counts and each item's outcome;
configured/effective profiles, identities and hashes. Workflow metrics preserve
completeness per define step and role. Eval-owned usage is separate from workflow
cost; missing metrics are unavailable, never estimated as complete totals.

Rescore verifies every retained hash before running any evaluator. It reads original
files only through the manifest, copies validated bytes into a fresh directory, and
reruns reconciliation, contamination, disclosure, gates, judging and discovery using
current host evaluator inputs. Original judgments, workspace, runtime and logs are
unused. It requires host OpenSpec and evaluator CLI auth, and can make paid judge
calls. Its result records the current series identity and the original identity and
candidate under `original`. The manifest must contain the original identity;
older incomplete manifests are refused. Identical patterns reproduce deterministic
contamination matches. To reproduce old scoring inputs, use the suite commit that
pinned their versions. Rescores are never published and cannot reuse an output
directory; rerun a failed rescore into a new directory.

Changing the starting prompt, starting tree, reference, inventory, rubric,
contamination patterns, simulated-user policy/profile, or judge profile starts a
new series. Comparison labels those pairs **not comparable** and omits paired
scores. Within a series it lists every changed candidate component: evaluated
profiles, Runner commit, workflow hashes, and Skills commit. Leaked count appears
alongside total/component scores; discovery remains non-scoring.
Only complete runs with a score are paired; failed, contaminated, or unscored
runs are listed under `unscored` with their status and owning phase.

## Publication

Only complete, scored candidate results enter
`evals/agent-runner/and-scene-define/results/<run-id>/`. A run with a failed gate
is published like any other scored run, with the failed gate in its result. The snapshot contains
`result.json`, `report.html`, `collected/`, `conversation.jsonl`,
`discovery/ledger.json`, and `artifact-manifest.json` with SHA-256 hashes.
Runtime/session state, credentials, raw judge output and full logs are excluded.
Contaminated, workflow/harness-failed, rescore and calibration runs create no
result commit. Generated results are historical records excluded from Validator
reviews; correct an erroneous publication with a later revert.

Publication commits only named files in that directory with
`chore: record and-scene-define eval <run-id>`, then runs ordinary `git push` to the
current branch's configured upstream. It preserves unrelated staged changes.
Commit/push failures retain the completed result and a retryable checkpoint.
Resume reuses an existing commit and retries its push, with no force-push or
second candidate execution. Keep the run directory and publication checkpoint
until delivery completes.

The residual contamination risk is present even on clean results: the sandbox has
network access to a public reference, and evaluated agents can write exchange/audit
evidence. Reconciliation and deterministic audit detect known patterns; they do
not prevent all contamination. The Runner image is not scanned. Future hardening
options remain an outbound allowlist, private fixture and separate Runner OS user.
