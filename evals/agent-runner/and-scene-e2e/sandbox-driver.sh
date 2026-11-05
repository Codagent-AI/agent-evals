#!/usr/bin/env bash
# Generic runtime entry: no evaluator data is available to this process.
# Usage: sandbox-driver.sh ARTIFACTS SKILLS MODE RUN_ID UNTIL WORKFLOW DELIVERY_URL ADAPTER...
set -euo pipefail
INPUT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ARTIFACTS="${1:?artifact root is required}"
SKILLS="${2:?skill checkout is required}"
MODE="${3:?fresh or resume is required}"
RUN_ID="${4:-}"
UNTIL="${5:?the --until phase is required}"
WORKFLOW="${6:?workflow reference is required}"
DELIVERY_URL="${7:?delivery repository URL is required}"
shift 7
CHANGE_NAME=add-presentation-skill
TOKEN_FILE="${E2E_TOKEN_FILE:-/github-auth/token}"
mkdir -p "$ARTIFACTS/logs"
# Includes Runner projects and only native session stores, never CLI settings/auth.
bash "$INPUT_DIR/prepare-agent-session-state.sh" "$ARTIFACTS/.runtime"
mkdir -p "$HOME/.agent-runner"
cp "$INPUT_DIR/runner-config.yaml" "$HOME/.agent-runner/config.yaml"
cp "$INPUT_DIR/runner-settings.yaml" "$HOME/.agent-runner/settings.yaml"
bash "$INPUT_DIR/bootstrap-agent-skills.sh" "$SKILLS" "$@"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
# GitHub access comes only from the refreshable token file: every inherited token variable is dropped.
unset GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_API_TOKEN GH_HOST GH_CONFIG_DIR GIT_ASKPASS
BIN="${E2E_BIN_DIR:-/tmp/e2e-bin}"
mkdir -p "$BIN"
REAL_GH="$(command -v gh || true)"
# The wrapper reads the token file on every call so a refreshed token is always current.
cat > "$BIN/gh" <<WRAP
#!/usr/bin/env bash
GH_TOKEN="\$(cat "$TOKEN_FILE")"
export GH_TOKEN
exec "$REAL_GH" "\$@"
WRAP
cat > "$BIN/git-credential-e2e" <<HELPER
#!/usr/bin/env bash
if [[ "\${1:-}" == get ]]; then
  printf 'username=x-access-token\npassword=%s\n' "\$(cat "$TOKEN_FILE")"
fi
HELPER
chmod 0755 "$BIN/gh" "$BIN/git-credential-e2e"
export PATH="$BIN:$PATH"
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
  git remote add origin "$DELIVERY_URL"
  git checkout -B "$CHANGE_NAME" HEAD
  git branch -f main HEAD
  if [[ "$(git rev-list --all --count)" != 1 || "$(git remote)" != origin ]]; then
    echo "Starting repository history or remote is invalid" >&2
    exit 2
  fi
  command=(agent-runner run "$WORKFLOW" --external-user "$ARTIFACTS/exchange" --until define --param "change_name=$CHANGE_NAME")
elif [[ "$MODE" == resume && -n "$RUN_ID" && "$RUN_ID" != -* && ( "$UNTIL" == define || "$UNTIL" == implement ) ]]; then
  cd "$REPO"
  command=(agent-runner --resume "$RUN_ID" --until "$UNTIL")
else
  echo "Invalid workflow mode" >&2
  exit 2
fi
git config user.name 'Workflow Agent'
git config user.email 'workflow@example.invalid'
git config credential.helper "$BIN/git-credential-e2e"
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
