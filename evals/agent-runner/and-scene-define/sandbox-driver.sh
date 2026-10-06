#!/usr/bin/env bash
# Generic runtime entry: no evaluator data is available to this process.
set -euo pipefail
INPUT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ARTIFACTS="${1:?artifact root is required}"
SKILLS="${2:?skill checkout is required}"
MODE="${3:?fresh or resume is required}"
RUN_ID="${4:-}"
shift 4
mkdir -p "$ARTIFACTS/logs"
# Includes Runner projects and only native session stores, never CLI settings/auth.
bash "$INPUT_DIR/prepare-agent-session-state.sh" "$ARTIFACTS/.runtime"
cp "$INPUT_DIR/runner-config.yaml" "$HOME/.agent-runner/config.yaml"
cp "$INPUT_DIR/runner-settings.yaml" "$HOME/.agent-runner/settings.yaml"
bash "$INPUT_DIR/bootstrap-agent-skills.sh" "$SKILLS" "$@"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_API_TOKEN
REPO="$ARTIFACTS/workspace/repo"
if [[ "$MODE" == fresh ]]; then
  if [[ -e "$REPO" || -L "$REPO" ]]; then
    echo "Fresh repository already exists" >&2
    exit 2
  fi
  mkdir -p "$ARTIFACTS/workspace" "$ARTIFACTS/exchange"
  git -c core.hooksPath=/dev/null clone --template= "$INPUT_DIR/starting-repo.bundle" "$REPO"
  cd "$REPO"
  git remote remove origin
  git checkout -B add-presentation-skill HEAD
  git branch -f main HEAD
  if [[ "$(git rev-list --all --count)" != 1 || -n "$(git remote)" ]]; then
    echo "Starting repository history or remote is invalid" >&2
    exit 2
  fi
  command=(agent-runner run openspec:change --external-user "$ARTIFACTS/exchange" --until define --param change_name=add-presentation-skill)
elif [[ "$MODE" == resume && -n "$RUN_ID" && "$RUN_ID" != -* ]]; then
  cd "$REPO"
  command=(agent-runner --resume "$RUN_ID" --until define)
else
  echo "Invalid workflow mode" >&2
  exit 2
fi
git config user.name 'Workflow Agent'
git config user.email 'workflow@example.invalid'
git config credential.helper ''
git config core.hooksPath /dev/null
status=0
record_exit() {
  printf '{"exit_code":%s}\n' "$status" > "$ARTIFACTS/logs/.runner-exit.tmp"
  mv "$ARTIFACTS/logs/.runner-exit.tmp" "$ARTIFACTS/logs/runner-exit.json"
}
trap record_exit EXIT
"${command[@]}" &
runner_pid=$!
trap 'kill -TERM "$runner_pid" 2>/dev/null || true; wait "$runner_pid" || status=$?; exit "$status"' TERM INT
wait "$runner_pid" || status=$?
exit "$status"
