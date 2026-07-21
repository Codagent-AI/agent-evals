#!/usr/bin/env bash
# Thin host entry point for the and-scene suite.
#
# This script owns argument parsing, host-side Agent Runner checkout checks,
# container identity, and invocation of Agent Runner's sandbox adapter. The
# evaluation lifecycle itself lives in controller.mjs, which runs inside the
# sandbox against the persistent run directory.
set -euo pipefail

REPO="${REPO:-https://github.com/Codagent-AI/and-scene.git}"
# Pin the fixture to an exact commit, not a moving branch head, so scored runs
# are reproducible. This is the head of eval/create-and-scene-spec-only as of
# 2026-07-17; bump it deliberately when the fixture snapshot changes.
FIXTURE_REF="${FIXTURE_REF:-c11595651dfb3941e39c703c483ed1a92d152a37}"
# Pin the known-good reference used for calibration and judge tiebreaks.
REFERENCE_REF="${REFERENCE_REF:-171c7def1e12aca2a5f605a5e5feafb20d4e4d19}"
CHANGE_NAME="${CHANGE_NAME:-create-and-scene}"
# The implementation workflow is hard-coded for this change. The suite records
# whichever clean Agent Runner revision supplies it rather than pinning a commit.
WORKFLOW_RELATIVE_PATH="workflows/openspec/implement-change2.yaml"
CONTAINER_AGENT_RUNNER_DIR="${CONTAINER_AGENT_RUNNER_DIR:-/tmp/agent-runner-local}"
JUDGE_MODEL="${JUDGE_MODEL:-codex-default}"
CANDIDATE_REF="${CANDIDATE_REF:-}"
ARTIFACT_DIR="${ARTIFACT_DIR:-}"
LEAD_CLI="" LEAD_MODEL="" LEAD_EFFORT=""
IMPLEMENTOR_CLI="" IMPLEMENTOR_MODEL="" IMPLEMENTOR_EFFORT=""
SKIP_VALIDATOR=0
RESUME=0
REFERENCE_BASELINE=0
DRY_RUN=0
PROOF_BROWSER=0
RUN_AGENT=0
CALIBRATE=0
SUITE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EVALS_ROOT="$(cd -- "$SUITE_DIR/../../.." && pwd)"
# The durable record of the last calibration. A full Agent Runner evaluation is
# blocked until it says calibration passed.
CALIBRATION_RECORD="${CALIBRATION_RECORD:-$EVALS_ROOT/artifacts/evals/and-scene-calibration/latest.json}"
AGENT_RUNNER_DIR="${AGENT_RUNNER_DIR:-$EVALS_ROOT/../agent-runner}"
SANDBOX_RUNNER="${SANDBOX_RUNNER:-}"
ENV_ARGS=()
ENV_FILE_ARGS=()
AUTH_ARGS=()
MOUNT_CODEX_AUTH=0
MOUNT_CLAUDE_AUTH=0

usage() {
  cat <<'USAGE'
Usage: evals/agent-runner/and-scene/run.sh (--proof-browser | --run-agent | --calibrate) [options]

Runs the and-scene evaluation through Agent Runner's sandbox adapter.

Credential posture: no host credentials are inherited by default except the
agent auth mounts required by the selected role profiles. Pass only short-lived,
repo-scoped credentials with --env, for example --env GITHUB_TOKEN for a private
fixture clone, or use the sandbox runner's default .sandbox-secrets.env file.
Any env secret passed through is readable by processes inside the container.
Credentials remain in the ephemeral container home and are never written into
the persistent run directory.

Modes:
  --proof-browser        Run the narrow container/browser proof.
  --run-agent            Run the Agent Runner evaluation harness.
  --calibrate            Run autonomous known-good/degraded calibration on the
                          host. It invokes no sandbox, no Agent Runner, no
                          browser, and no human, and its artifacts are ignored
                          diagnostics that are never published. A full
                          --run-agent evaluation is blocked until it passes.

Options:
  --dry-run              Print the sandbox command instead of running it.
  --agent-runner-dir PATH
                          Agent Runner checkout. Must be a clean Git worktree
                          containing workflows/openspec/implement-change2.yaml.
                          Default: sibling ../agent-runner.
  --artifact-dir PATH    Host run directory. Default:
                          proof: artifacts/evals/and-scene-proof/<timestamp>
                          run:   artifacts/evals/and-scene/<timestamp>
  --repo URL             and-scene repository URL.
  --fixture-ref REF      Implementation-ready fixture ref.
                          Default: c11595651dfb3941e39c703c483ed1a92d152a37
  --reference-ref REF    Implemented/reference ref.
                          Default: 171c7def1e12aca2a5f605a5e5feafb20d4e4d19
  --candidate-ref REF    Grade an existing candidate ref.
  --reference-baseline   Evaluate an existing candidate without invoking Agent
                          Runner. Role profiles are not required or applicable.
  --change-name NAME     OpenSpec change name. Default: create-and-scene
  --skip-validator       Pass skip_validator=true and stop the workflow after
                          simplify. Without this flag the eval passes
                          skip_validator=false and stops after verify-validator.
  --resume               Reopen the run directory and continue the recorded
                          evaluation instead of starting a new one.
  --lead-cli CLI         Lead-agent CLI adapter (implement-change2 planner).
  --lead-model MODEL     Lead-agent model.
  --lead-effort EFFORT   Lead-agent effort.
  --implementor-cli CLI  Task-implementor CLI adapter.
  --implementor-model MODEL
                          Task-implementor model.
  --implementor-effort EFFORT
                          Task-implementor effort.
  --judge-model MODEL    Eval-owned judge model. Default: the Codex CLI default.
  --calibration-record PATH
                          Durable calibration pass/fail record. Written by
                          --calibrate and required by --run-agent. Default:
                          artifacts/evals/and-scene-calibration/latest.json
  --env NAME             Pass through one named environment variable.
                          Repeatable.
  --env-file PATH        Read simple NAME=value or export NAME=value entries
                          from a local env file and pass those variable names.
                          The file is parsed by sandbox-run.sh, not sourced.
  --mount-codex-auth     Forward subscription-based Codex auth files into the
                          sandbox via sandbox-run.sh.
  --mount-claude-auth    Forward subscription-based Claude Code auth files into
                          the sandbox via sandbox-run.sh.
  -h, --help             Show this help.
USAGE
}

timestamp() {
  date -u +"%Y%m%dT%H%M%SZ"
}

shell_quote() {
  printf "%q" "$1"
}

while (($#)); do
  case "$1" in
    --proof-browser)
      PROOF_BROWSER=1
      shift
      ;;
    --run-agent)
      RUN_AGENT=1
      shift
      ;;
    --calibrate)
      CALIBRATE=1
      shift
      ;;
    --calibration-record)
      CALIBRATION_RECORD="${2:?missing value for --calibration-record}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --artifact-dir)
      ARTIFACT_DIR="${2:?missing value for --artifact-dir}"
      shift 2
      ;;
    --agent-runner-dir)
      AGENT_RUNNER_DIR="${2:?missing value for --agent-runner-dir}"
      shift 2
      ;;
    --repo)
      REPO="${2:?missing value for --repo}"
      shift 2
      ;;
    --fixture-ref)
      FIXTURE_REF="${2:?missing value for --fixture-ref}"
      shift 2
      ;;
    --reference-ref)
      REFERENCE_REF="${2:?missing value for --reference-ref}"
      shift 2
      ;;
    --candidate-ref)
      CANDIDATE_REF="${2:?missing value for --candidate-ref}"
      shift 2
      ;;
    --reference-baseline)
      REFERENCE_BASELINE=1
      shift
      ;;
    --change-name)
      CHANGE_NAME="${2:?missing value for --change-name}"
      shift 2
      ;;
    --skip-validator)
      SKIP_VALIDATOR=1
      shift
      ;;
    --resume)
      RESUME=1
      shift
      ;;
    --lead-cli)
      LEAD_CLI="${2:?missing value for --lead-cli}"
      shift 2
      ;;
    --lead-model)
      LEAD_MODEL="${2:?missing value for --lead-model}"
      shift 2
      ;;
    --lead-effort)
      LEAD_EFFORT="${2:?missing value for --lead-effort}"
      shift 2
      ;;
    --implementor-cli)
      IMPLEMENTOR_CLI="${2:?missing value for --implementor-cli}"
      shift 2
      ;;
    --implementor-model)
      IMPLEMENTOR_MODEL="${2:?missing value for --implementor-model}"
      shift 2
      ;;
    --implementor-effort)
      IMPLEMENTOR_EFFORT="${2:?missing value for --implementor-effort}"
      shift 2
      ;;
    --judge-model)
      JUDGE_MODEL="${2:?missing value for --judge-model}"
      shift 2
      ;;
    --env)
      ENV_ARGS+=(--env "${2:?missing value for --env}")
      shift 2
      ;;
    --env-file)
      ENV_FILE_ARGS+=(--env-file "${2:?missing value for --env-file}")
      shift 2
      ;;
    --mount-codex-auth)
      MOUNT_CODEX_AUTH=1
      AUTH_ARGS+=(--mount-codex-auth)
      shift
      ;;
    --mount-claude-auth)
      MOUNT_CLAUDE_AUTH=1
      AUTH_ARGS+=(--mount-claude-auth)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ((PROOF_BROWSER + RUN_AGENT + CALIBRATE != 1)); then
  echo "Choose exactly one mode: --proof-browser, --run-agent, or --calibrate." >&2
  usage >&2
  exit 2
fi

# Calibration runs entirely on the host: no sandbox, no Agent Runner checkout,
# no credentials. It is handled before every check those things require.
if [[ "$CALIBRATE" == 1 ]]; then
  if [[ -z "$ARTIFACT_DIR" ]]; then
    ARTIFACT_DIR="$EVALS_ROOT/artifacts/evals/and-scene-calibration/$(timestamp)"
  elif [[ "$ARTIFACT_DIR" != /* ]]; then
    ARTIFACT_DIR="$EVALS_ROOT/$ARTIFACT_DIR"
  fi
  calibrate_command=(node "$SUITE_DIR/calibrate.mjs" --out "$ARTIFACT_DIR" --record "$CALIBRATION_RECORD")
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '%q ' "${calibrate_command[@]}"
    printf '\n'
    exit 0
  fi
  exec "${calibrate_command[@]}"
fi

if [[ ! -d "$AGENT_RUNNER_DIR" ]]; then
  echo "Agent Runner directory does not exist: $AGENT_RUNNER_DIR" >&2
  exit 2
fi
AGENT_RUNNER_DIR="$(cd -- "$AGENT_RUNNER_DIR" && pwd)"
if [[ -z "$SANDBOX_RUNNER" ]]; then
  SANDBOX_RUNNER="$AGENT_RUNNER_DIR/scripts/sandbox-run.sh"
fi
if [[ ! -x "$SANDBOX_RUNNER" ]]; then
  echo "Agent Runner sandbox-run.sh is not executable: $SANDBOX_RUNNER" >&2
  exit 2
fi

AGENT_EVALS_SOURCE_COMMIT="$(git -C "$EVALS_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [[ -n "$(git -C "$EVALS_ROOT" status --porcelain 2>/dev/null)" ]]; then
  AGENT_EVALS_SOURCE_DIRTY=true
else
  AGENT_EVALS_SOURCE_DIRTY=false
fi
export AGENT_EVALS_SOURCE_COMMIT AGENT_EVALS_SOURCE_DIRTY
ENV_ARGS+=(--env AGENT_EVALS_SOURCE_COMMIT --env AGENT_EVALS_SOURCE_DIRTY)

# Reject a role profile that is only partially specified rather than silently
# filling in a default the result would misreport.
require_role_profile() {
  local label="$1" cli="$2" model="$3" effort="$4"
  if [[ -z "$cli" && -z "$model" && -z "$effort" ]]; then
    echo "A $label profile is required. Supply its CLI, model, and effort." >&2
    exit 2
  fi
  if [[ -z "$cli" || -z "$model" || -z "$effort" ]]; then
    echo "The $label profile must specify CLI, model, and effort." >&2
    exit 2
  fi
}

if [[ "$RUN_AGENT" == 1 ]]; then
  # A reference baseline evaluates an existing candidate without invoking Agent
  # Runner, so its workflow contract and worktree cleanliness do not apply. Only
  # the sandbox adapter, checked above, is required to launch it.
  if [[ "$REFERENCE_BASELINE" != 1 ]]; then
    # A full Agent Runner evaluation costs real model time, so it does not start
    # until calibration has proved the harness attributes quality to the right
    # component and gate. The record is read by calibrate.mjs rather than parsed
    # here, so the rule that blocks the run is the code that wrote it.
    if ! node "$SUITE_DIR/calibrate.mjs" --check-record "$CALIBRATION_RECORD"; then
      echo "Run calibration first: evals/agent-runner/and-scene/run.sh --calibrate" >&2
      exit 2
    fi

    # The suite requires a clean recorded Agent Runner revision before any
    # workflow starts or resumes; a dirty checkout stops the run here on the
    # host.
    if ! git -C "$AGENT_RUNNER_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "Agent Runner checkout is not a Git worktree: $AGENT_RUNNER_DIR" >&2
      exit 2
    fi
    if ! git -C "$AGENT_RUNNER_DIR" status --porcelain >/dev/null 2>&1; then
      echo "Cannot determine Agent Runner checkout status: $AGENT_RUNNER_DIR" >&2
      exit 2
    fi
    if [[ -n "$(git -C "$AGENT_RUNNER_DIR" status --porcelain)" ]]; then
      echo "Agent Runner checkout has uncommitted changes: $AGENT_RUNNER_DIR" >&2
      exit 2
    fi
    if [[ ! -f "$AGENT_RUNNER_DIR/$WORKFLOW_RELATIVE_PATH" ]]; then
      echo "Agent Runner checkout does not contain $WORKFLOW_RELATIVE_PATH: $AGENT_RUNNER_DIR" >&2
      exit 2
    fi

    require_role_profile "lead-agent" "$LEAD_CLI" "$LEAD_MODEL" "$LEAD_EFFORT"
    require_role_profile "task-implementor" "$IMPLEMENTOR_CLI" "$IMPLEMENTOR_MODEL" "$IMPLEMENTOR_EFFORT"

    # Forward only the auth the selected role profiles and the judge need.
    for cli in "$LEAD_CLI" "$IMPLEMENTOR_CLI"; do
      case "$cli" in
        claude)
          if [[ "$MOUNT_CLAUDE_AUTH" != 1 ]]; then
            AUTH_ARGS+=(--mount-claude-auth)
            MOUNT_CLAUDE_AUTH=1
          fi
          ;;
        codex)
          if [[ "$MOUNT_CODEX_AUTH" != 1 ]]; then
            AUTH_ARGS+=(--mount-codex-auth)
            MOUNT_CODEX_AUTH=1
          fi
          ;;
        *)
          echo "Unsupported CLI adapter for auth forwarding: $cli; expected claude or codex." >&2
          exit 2
          ;;
      esac
    done
  fi

  if [[ "$REFERENCE_BASELINE" == 1 && -z "$CANDIDATE_REF" ]]; then
    CANDIDATE_REF="$REFERENCE_REF"
  fi

  # Eval-owned judging always runs through Codex.
  if [[ "$MOUNT_CODEX_AUTH" != 1 ]]; then
    AUTH_ARGS+=(--mount-codex-auth)
    MOUNT_CODEX_AUTH=1
  fi
fi

if [[ -z "$ARTIFACT_DIR" ]]; then
  if [[ "$PROOF_BROWSER" == 1 ]]; then
    ARTIFACT_DIR="$EVALS_ROOT/artifacts/evals/and-scene-proof/$(timestamp)"
  else
    ARTIFACT_DIR="$EVALS_ROOT/artifacts/evals/and-scene/$(timestamp)"
  fi
elif [[ "$ARTIFACT_DIR" != /* ]]; then
  ARTIFACT_DIR="$EVALS_ROOT/$ARTIFACT_DIR"
fi

# The run directory basename is the stable run identity. A resume against the
# same directory reuses it, so a restarted outer process addresses the same run
# and the same container identity rather than starting a new one.
AND_SCENE_RUN_ID="$(basename -- "$ARTIFACT_DIR")"
export AND_SCENE_RUN_ID
ENV_ARGS+=(--env AND_SCENE_RUN_ID)

REPO_Q="$(shell_quote "$REPO")"
FIXTURE_REF_Q="$(shell_quote "$FIXTURE_REF")"
REFERENCE_REF_Q="$(shell_quote "$REFERENCE_REF")"
CANDIDATE_REF_Q="$(shell_quote "$CANDIDATE_REF")"
CHANGE_NAME_Q="$(shell_quote "$CHANGE_NAME")"
JUDGE_MODEL_Q="$(shell_quote "$JUDGE_MODEL")"
CONTAINER_AGENT_RUNNER_DIR_Q="$(shell_quote "$CONTAINER_AGENT_RUNNER_DIR")"

# Assemble the controller argument list on the host so the container script
# stays a fixed, quoted invocation rather than string-built shell.
CONTROLLER_ARGS=(--run-dir /artifacts --agent-runner-dir "$CONTAINER_AGENT_RUNNER_DIR" --repo "$REPO")
CONTROLLER_ARGS+=(--change-name "$CHANGE_NAME" --fixture-ref "$FIXTURE_REF" --judge-model "$JUDGE_MODEL")
if [[ -n "$CANDIDATE_REF" ]]; then
  CONTROLLER_ARGS+=(--candidate-ref "$CANDIDATE_REF")
fi
if [[ "$SKIP_VALIDATOR" == 1 ]]; then
  CONTROLLER_ARGS+=(--skip-validator)
fi
if [[ "$RESUME" == 1 ]]; then
  CONTROLLER_ARGS+=(--resume)
fi
if [[ "$REFERENCE_BASELINE" == 1 ]]; then
  CONTROLLER_ARGS+=(--reference-baseline)
else
  CONTROLLER_ARGS+=(--lead-cli "$LEAD_CLI" --lead-model "$LEAD_MODEL" --lead-effort "$LEAD_EFFORT")
  CONTROLLER_ARGS+=(--implementor-cli "$IMPLEMENTOR_CLI" --implementor-model "$IMPLEMENTOR_MODEL")
  CONTROLLER_ARGS+=(--implementor-effort "$IMPLEMENTOR_EFFORT")
fi
CONTROLLER_ARGS_Q=""
for controller_arg in "${CONTROLLER_ARGS[@]}"; do
  CONTROLLER_ARGS_Q+="$(shell_quote "$controller_arg") "
done
proof_script=$(cat <<PROOF
set -euo pipefail
mkdir -p /artifacts/logs /workspace/runs
if [[ " \${NODE_OPTIONS:-} " != *" --dns-result-order="* ]]; then
  export NODE_OPTIONS="\${NODE_OPTIONS:-} --dns-result-order=ipv4first"
fi
# The pinned reference verifier extracts Vite's preview URL from stdout. Keep
# that machine-consumed output free of terminal styling even when the sandbox
# adapter allocates a TTY.
export NO_COLOR=1
export FORCE_COLOR=0

configure_github_https_auth() {
  local token="\${GITHUB_TOKEN:-\${GH_TOKEN:-}}"
  if [ -n "\$token" ]; then
    {
      printf '%s\n' '#!/usr/bin/env sh'
      printf '%s\n' 'case "\$1" in'
      printf '%s\n' '  *Username*) printf "%s\n" x-access-token ;;'
      printf '%s\n' '  *Password*) printf "%s\n" "\${GITHUB_TOKEN:-\${GH_TOKEN:-}}" ;;'
      printf '%s\n' '  *) printf "\n" ;;'
      printf '%s\n' 'esac'
    } > "\$HOME/.git-askpass"
    chmod 700 "\$HOME/.git-askpass"
    export GIT_ASKPASS="\$HOME/.git-askpass"
    export GIT_TERMINAL_PROMPT=0
  fi
}

write_metadata() {
  jq -n \\
    --arg repo $REPO_Q \\
    --arg fixture_ref $FIXTURE_REF_Q \\
    --arg reference_ref $REFERENCE_REF_Q \\
    --arg started_at "\${STARTED_AT}" \\
    --arg ended_at "\$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \\
    --arg agent_runner_commit "\${AGENT_RUNNER_SOURCE_COMMIT:-}" \\
    --arg agent_runner_dirty "\${AGENT_RUNNER_SOURCE_DIRTY:-}" \\
    --arg agent_evals_commit "\${AGENT_EVALS_SOURCE_COMMIT:-}" \\
    --arg agent_evals_dirty "\${AGENT_EVALS_SOURCE_DIRTY:-}" \\
    --arg fixture_commit "\${FIXTURE_COMMIT:-}" \\
    --arg reference_commit "\${REFERENCE_COMMIT:-}" \\
    --arg node_version "\$(node --version 2>/dev/null || true)" \\
    --arg npm_version "\$(npm --version 2>/dev/null || true)" \\
    --arg playwright_browsers_path "\${PLAYWRIGHT_BROWSERS_PATH:-}" \\
    --arg exit_code "\${EXIT_CODE:-0}" \\
    '{
      repo: \$repo,
      fixture_ref: \$fixture_ref,
      reference_ref: \$reference_ref,
      started_at: \$started_at,
      ended_at: \$ended_at,
      agent_runner_commit: \$agent_runner_commit,
      agent_runner_dirty: (\$agent_runner_dirty == "true"),
      agent_evals_commit: \$agent_evals_commit,
      agent_evals_dirty: (\$agent_evals_dirty == "true"),
      fixture_commit: \$fixture_commit,
      reference_commit: \$reference_commit,
      cli_versions: {
        node: \$node_version,
        npm: \$npm_version
      },
      playwright_browsers_path: \$playwright_browsers_path,
      exit_code: (\$exit_code | tonumber)
    }' > /artifacts/proof-metadata.json
}

STARTED_AT="\$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
EXIT_CODE=0
trap 'EXIT_CODE=\$?; write_metadata; exit \$EXIT_CODE' EXIT

configure_github_https_auth

git clone $REPO_Q /workspace/runs/fixture 2>&1 | tee /artifacts/logs/fixture-clone.log
cd /workspace/runs/fixture
git fetch origin 2>&1 | tee -a /artifacts/logs/fixture-clone.log
git checkout $FIXTURE_REF_Q 2>&1 | tee -a /artifacts/logs/fixture-clone.log
FIXTURE_COMMIT="\$(git rev-parse HEAD)"
npm ci 2>&1 | tee /artifacts/logs/fixture-npm-ci.log
npm run build 2>&1 | tee /artifacts/logs/fixture-build.log

git clone $REPO_Q /workspace/runs/reference 2>&1 | tee /artifacts/logs/reference-clone.log
cd /workspace/runs/reference
git fetch origin 2>&1 | tee -a /artifacts/logs/reference-clone.log
git checkout $REFERENCE_REF_Q 2>&1 | tee -a /artifacts/logs/reference-clone.log
REFERENCE_COMMIT="\$(git rev-parse HEAD)"
npm ci 2>&1 | tee /artifacts/logs/reference-npm-ci.log
npm run build 2>&1 | tee /artifacts/logs/reference-build.log
npm run verify 2>&1 | tee /artifacts/logs/reference-verify.log

# Prove the recommended agent-facing browser CLI can launch Chromium, navigate,
# and inspect a real page inside the sandbox.
npm exec vite -- preview --host 127.0.0.1 --port 4173 --strictPort \
  > /artifacts/logs/axi-preview.log 2>&1 &
AXI_PREVIEW_PID="\$!"
for _ in {1..100}; do
  if curl -fsS http://127.0.0.1:4173/ >/dev/null; then break; fi
  sleep 0.1
done
{
  chrome-devtools-axi open http://127.0.0.1:4173/
  chrome-devtools-axi snapshot
} > /artifacts/logs/axi-browser-proof.log 2>&1
grep -q 'Presentations' /artifacts/logs/axi-browser-proof.log
chrome-devtools-axi stop >/dev/null 2>&1 || true
kill "\$AXI_PREVIEW_PID" 2>/dev/null || true

echo "and-scene browser proof passed" | tee /artifacts/tier1-result.txt
PROOF
)

agent_script=$(cat <<AGENT
set -euo pipefail
mkdir -p /artifacts/logs
export AGENT_RUNNER_NO_TUI=1
if [[ " \${NODE_OPTIONS:-} " != *" --dns-result-order="* ]]; then
  export NODE_OPTIONS="\${NODE_OPTIONS:-} --dns-result-order=ipv4first"
fi

# The implementation workflow is fixed for this change; the controller records
# the clean Agent Runner revision that supplies it.
IMPLEMENTATION_WORKFLOW=implement-change2
REPO=$REPO_Q
FIXTURE_REF=$FIXTURE_REF_Q
REFERENCE_REF=$REFERENCE_REF_Q
CANDIDATE_REF=$CANDIDATE_REF_Q
CHANGE_NAME=$CHANGE_NAME_Q
JUDGE_MODEL=$JUDGE_MODEL_Q
AGENT_RUNNER_DIR=$CONTAINER_AGENT_RUNNER_DIR_Q
export REPO FIXTURE_REF REFERENCE_REF CANDIDATE_REF CHANGE_NAME JUDGE_MODEL IMPLEMENTATION_WORKFLOW

token="\${GITHUB_TOKEN:-\${GH_TOKEN:-}}"
if [ -n "\$token" ]; then
  {
    printf '%s\n' '#!/usr/bin/env sh'
    printf '%s\n' 'case "\$1" in'
    printf '%s\n' '  *Username*) printf "%s\n" x-access-token ;;'
    printf '%s\n' '  *Password*) printf "%s\n" "\${GITHUB_TOKEN:-\${GH_TOKEN:-}}" ;;'
    printf '%s\n' '  *) printf "\n" ;;'
    printf '%s\n' 'esac'
  } > "\$HOME/.git-askpass"
  chmod 700 "\$HOME/.git-askpass"
  export GIT_ASKPASS="\$HOME/.git-askpass"
  export GIT_TERMINAL_PROMPT=0
fi

exec node /eval-input/controller.mjs $CONTROLLER_ARGS_Q
AGENT
)

sandbox_args=(--artifact-dir "$ARTIFACT_DIR" --input-dir "$SUITE_DIR")
if [[ "$DRY_RUN" == 1 ]]; then
  sandbox_args=(--dry-run "${sandbox_args[@]}")
fi
sandbox_args+=("${ENV_ARGS[@]+"${ENV_ARGS[@]}"}")
sandbox_args+=("${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"}")
sandbox_args+=("${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}")

if [[ "$PROOF_BROWSER" == 1 ]]; then
  exec "$SANDBOX_RUNNER" "${sandbox_args[@]}" -- "$proof_script"
fi

exec "$SANDBOX_RUNNER" "${sandbox_args[@]}" -- "$agent_script"
