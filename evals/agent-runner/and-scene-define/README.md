# and-scene-define pinned inputs

This suite defines `add-presentation-skill` from the short starting prompt. Its
fixture is `https://github.com/Codagent-AI/and-scene.git` at
`ad667a965a0e1ea0b028c36c04d57bf0411d30d9`, change `create-and-scene`.
The run controller and sandbox invocation are delivered by later tasks.

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

Before any evaluated model call, the later controller must call
`scanCanaries({ stagedDir, skillsDir, credentialFiles })` on the host. It scans
all staged files, Git repository and bundle objects, the Agent Skills HEAD's
tracked blobs and working copies, and forwarded credential/configuration files.
Symlinks, submodules, and unsupported file types cause a scan error instead of
silently omitting readable content. Matches return `{ file, pattern, kind }`.
The caller must turn matches or scan errors into `evaluation-harness-failed` and
stop before starting the sandbox. Never stage `hidden/`, `calibration/`, the
pattern list, or any suite manifest. Credential isolation and preventing push/PR
operations are responsibilities of the later sandbox invocation.

`versions.json` records current versions and immutable historical content hashes.
For a content change, bump the input's version, retain its old hashes, and append
the new hash. JSON inputs carry their own version field; the starting prompt's
version lives in the ledger. The check also compares Git's committed ledger to
catch changing a recorded hash without a version bump. Git or baseline lookup
failures reject the check; incomplete shallow history must be fetched before
preflight. Only a genuinely new, uncommitted ledger needs no baseline. Once the rubric and
simulated-user policy exist, add each to `VERSIONED_INPUTS` with one line and
record its initial version/hash in the ledger.

The simulated user is pinned to `claude-opus-5-5`. Its versioned disclosure and
decision policy is `hidden/simulated-user-policy.md`. `loadSimulatedUserInputs()`
checks the pins and constructs a system prompt from an explicit allowlist of
proposal, specs, design and test plan; citation supplements, task files, inventory
classes and rubric never enter the prompt. Only the system prompt hash is retained
in usage evidence. Each call uses an empty temporary directory, host Claude auth,
no settings sources, no MCP servers, no real tools and no session persistence.
Every call appends to `phases/eval-owned-usage.jsonl`; rejected calls record zero
tokens and a rejection reason. Ordinary failures allow three attempts; schema
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
the write-ahead window. Run only one responder per artifact directory.

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
