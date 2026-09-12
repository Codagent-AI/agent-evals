#!/usr/bin/env bash
# Connect only the CLI state required for session continuation to this run's
# private runtime directory. Authentication and configuration remain in the
# disposable sandbox home populated by Agent Runner's sandbox adapter.
set -euo pipefail

STATE_ROOT="${1:?usage: prepare-agent-session-state.sh ABSOLUTE_STATE_ROOT}"
HOME_DIR="${HOME:?HOME must identify the disposable sandbox home}"

if [[ "$STATE_ROOT" != /* || "$STATE_ROOT" == / ]]; then
  echo "Agent session state root must be a specific absolute path: $STATE_ROOT" >&2
  exit 2
fi
if [[ "$HOME_DIR" != /* || "$HOME_DIR" == / ]]; then
  echo "Sandbox HOME must be a specific absolute path: $HOME_DIR" >&2
  exit 2
fi

# Checking only the immediate parent is not enough: mkdir -p follows a symlink
# at any existing ancestor, so a redirected grandparent would place state
# outside the evaluation. Walk up to the first component that already exists,
# which is the only one mkdir -p can traverse, and require it to be a real
# directory. Components above it are the caller's chosen location, not ours.
reject_redirected_path() {
  local label="$1" probe="$2" parent
  # An existing directory can still sit beneath a redirected immediate parent,
  # which the walk below would never examine, so check the parent explicitly.
  parent="$(dirname -- "$probe")"
  if [[ -L "$parent" || (-e "$parent" && ! -d "$parent") ]]; then
    echo "$label parent is not a private directory: $parent" >&2
    exit 2
  fi
  while [[ ! -e "$probe" && ! -L "$probe" ]]; do
    probe="$(dirname -- "$probe")"
    [[ "$probe" == "/" ]] && break
  done
  if [[ -L "$probe" || (-e "$probe" && ! -d "$probe") ]]; then
    echo "$label is not a private directory: $probe" >&2
    exit 2
  fi
}

restrict_private_dir() {
  local path
  for path in "$@"; do
    # A permissive mode leaves transcripts and memories readable beyond the
    # owner. Surface that rather than discard the failure silently.
    chmod 700 "$path" 2>/dev/null \
      || echo "warning: could not restrict agent session state to its owner: $path" >&2
  done
}

reject_redirected_path "Agent session state root" "$STATE_ROOT"
mkdir -p "$STATE_ROOT"
for cli_home in .codex .claude .cursor; do
  # A pre-existing ~/.codex -> /foreign would place every link below it outside
  # this evaluation, so validate each CLI home before creating it.
  reject_redirected_path "Agent CLI home" "$HOME_DIR/$cli_home"
  mkdir -p "$HOME_DIR/$cli_home"
done
restrict_private_dir "$STATE_ROOT" "$HOME_DIR/.codex" "$HOME_DIR/.claude" "$HOME_DIR/.cursor"

link_private_state_dir() {
  local relative="$1" target="$2" persistent parent existing_target
  persistent="$STATE_ROOT/$relative"
  parent="$(dirname -- "$persistent")"

  reject_redirected_path "Persistent agent session parent" "$parent"
  mkdir -p "$parent"
  reject_redirected_path "Persistent agent session path" "$persistent"
  mkdir -p "$persistent"
  restrict_private_dir "$parent" "$persistent"

  if [[ -L "$target" ]]; then
    existing_target="$(readlink "$target" 2>/dev/null || true)"
    if [[ "$existing_target" == "$persistent" ]]; then
      return 0
    fi
    echo "Agent session path already links outside this evaluation: $target" >&2
    exit 2
  fi
  if [[ -e "$target" ]]; then
    if [[ ! -d "$target" || -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
      echo "Agent session path already contains non-persistent state: $target" >&2
      exit 2
    fi
    rmdir "$target"
  fi
  ln -s "$persistent" "$target"
}

# Keep this Codex list aligned with Agent Runner's codexSharedStateDirectories.
# The private integration CODEX_HOME links these directories from ~/.codex.
link_private_state_dir codex/archived_sessions "$HOME_DIR/.codex/archived_sessions"
link_private_state_dir codex/memories "$HOME_DIR/.codex/memories"
link_private_state_dir codex/sessions "$HOME_DIR/.codex/sessions"
link_private_state_dir codex/shell_snapshots "$HOME_DIR/.codex/shell_snapshots"

# Agent Runner's Claude adapter resolves --resume from this exact transcript
# store. Settings and .credentials.json intentionally remain outside it.
link_private_state_dir claude/projects "$HOME_DIR/.claude/projects"

# Agent Runner's Cursor adapter discovers and resumes chats from this store.
# auth.json and cli-config.json intentionally remain outside it.
link_private_state_dir cursor/chats "$HOME_DIR/.cursor/chats"
