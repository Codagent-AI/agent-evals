# Task: Add opt-in `--auth-only` and `--hide-source` options to the Agent Runner sandbox

## Goal

Give Agent Runner's `scripts/sandbox-run.sh` two opt-in options so a caller can run a workflow in the sandbox without exposing the host's CLI settings or the Agent Runner source tree to the evaluated agent. agent-evals is adding a define-workflow evaluation suite, `evals/agent-runner/and-scene-define/`, whose evaluated agent must not be able to read anything that names its hidden reference. Today two mounts leak it:

- `--mount-claude-auth` also mounts the host's `~/.claude/settings.json` and `settings.local.json`. The maintainer's Claude settings name `Codagent-AI/and-scene` and enable its plugin, which contaminated an earlier proof-of-concept run.
- The Runner is built from `/agent-runner-source`, which stays mounted read-only for the container's lifetime. That source contains the archived `external-user-mode` OpenSpec change, which names the eval suite and its hidden reference.

Both options are product infrastructure, so they belong in the Agent Runner repository, not in agent-evals.

## Background

Work in the Agent Runner worktree `/Users/paul/codagent/agent-runner/worktrees/external-user-mode` (branch `external-user-mode`). Commit there; do not push. Follow that repository's own conventions, `AGENTS.md`, and test setup.

Relevant files:
- `scripts/sandbox-run.sh`: option parsing (`--dry-run`, `--mount-claude-auth`, `--mount-codex-auth`, `--mount-cursor-auth`, `--input-dir`, `--artifact-dir`, `--no-default-secrets`, `--dev-audit`, ...), the image build, the in-container Runner build from `/agent-runner-source` into `/tmp/agent-runner-local`, and `docker run`.
- `scripts/sandbox_scripts_test.go`: the existing tests for the sandbox scripts. Put the new tests there or alongside it, in the same style.
- `docs/external-user-mode.md`: the external-user contract. Add a short note on the two new options to whichever doc already documents `sandbox-run.sh` options, and to the script's `--help`.

Required behavior (from the approved design):

- **`--auth-only`**: modifies the `--mount-*-auth` options so that only credential files are forwarded. With `--mount-claude-auth`, mount only `~/.claude/.credentials.json` (and whatever minimum the Claude CLI needs to authenticate), not `settings.json` or `settings.local.json`. Codex and Cursor are believed to mount only their auth files already. Check this: `--help` says `--mount-codex-auth` mounts "auth/config files". If a Codex config file is mounted, `--auth-only` must drop it too, so that only `auth.json` is forwarded.
- **`--hide-source`**:
  1. build the Runner in a first container, writing the binary to a host temporary directory;
  2. run the command in a second container that mounts that binary and does **not** mount `/agent-runner-source`;
  3. do not leave `/tmp/agent-runner-local` in the command container.

  The eval harness checks that the command container mounts no host path beyond those its caller requested: the `--input-dir`, the `--artifact-dir`, the selected `--mount-*-auth` credential files, and any `--docker-run-arg` mounts it passes itself. So the built binary must reach the command container **without an additional host-path bind mount**. Acceptable mechanisms:
  - a Docker named volume populated by the build container;
  - an image layer derived from the base image;
  - a location under the caller's `--artifact-dir`.

  Choose one, document it in `--help`, and make `--dry-run` show it.

  Workflows are embedded in the binary, so nothing else from the source is needed at runtime. The eval suite does not use `--dev-audit`; if combining `--hide-source` with `--dev-audit` is not straightforward, reject that combination with a clear error.
- Both options are opt-in. Existing callers must see byte-identical behavior and `--dry-run` output without them.
- `--dry-run` must print the full planned commands for both containers when `--hide-source` is set, so a caller can inspect the exact mount set without Docker.
- The eval harness checks `agent-runner --help` for `--external-user`, so the binary produced under `--hide-source` must be the same build the normal path produces.

## Spec

These requirements come from the agent-evals change. This task delivers the Runner-side portion: a sandbox in which the source tree and host Claude settings are absent. The eval harness enforces the remaining mount rules.

### Requirement: Hidden material is not mounted
The evaluated environment SHALL contain only the materialized starting repository and the runtime the evaluated workflow needs. The fixture change, the reference implementation, the hidden-reference inventory, the rubric, calibration inputs, the suite's data, and earlier results SHALL NOT be mounted into or readable from it.

#### Scenario: Suite data is absent from the sandbox
- **WHEN** the evaluated sandbox starts
- **THEN** none of the suite's hidden-reference, inventory, rubric, calibration, or result paths is present in its filesystem

## Test Plan

- `INT-007` (Agent Runner sandbox flags): use the Agent Runner repository's sandbox script tests (`scripts/sandbox_scripts_test.go` or alongside it).
  - Dry-run each flag.
  - Then run a real container with both flags that lists the filesystem and runs `agent-runner --help`.
  - Assert:
    - with `--auth-only`, the dry-run command mounts only the credential files, not `settings.json` or `settings.local.json`;
    - with `--hide-source`, the command container has no `/agent-runner-source` mount, and no host-path bind mount beyond the caller-requested input, artifact, credential, and `--docker-run-arg` mounts;
    - in the real container, none of `/agent-runner-source`, `/tmp/agent-runner-local`, or the host Claude settings exists;
    - `agent-runner --help` succeeds and lists `--external-user`;
    - existing behavior without the flags is unchanged.
  - Gate the Docker-dependent part the way that repository already gates Docker tests.

## Done When

- `scripts/sandbox-run.sh --auth-only` and `--hide-source` behave as described above, and `--help` documents them.
- With `--hide-source`, the binary reaches the command container without any extra host-path bind mount.
- Without the new flags, the existing dry-run output and tests are unchanged.
- The `INT-007` tests pass, including the real-container check on this Mac with Docker.
- The Agent Runner repository's own test and lint commands pass.
- The work is committed on the `external-user-mode` branch with that repository's commit conventions, and not pushed.
