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

STATE_PARENT="$(dirname -- "$STATE_ROOT")"
if [[ -L "$STATE_PARENT" || (-e "$STATE_PARENT" && ! -d "$STATE_PARENT") ]]; then
  echo "Agent session state parent is not a private directory: $STATE_PARENT" >&2
  exit 2
fi
if [[ -L "$STATE_ROOT" || (-e "$STATE_ROOT" && ! -d "$STATE_ROOT") ]]; then
  echo "Agent session state root is not a private directory: $STATE_ROOT" >&2
  exit 2
fi
mkdir -p "$STATE_ROOT" "$HOME_DIR/.codex" "$HOME_DIR/.claude" "$HOME_DIR/.cursor"
chmod 700 "$STATE_ROOT" "$HOME_DIR/.codex" "$HOME_DIR/.claude" "$HOME_DIR/.cursor" 2>/dev/null || true

link_private_state_dir() {
  local relative="$1" target="$2" persistent parent existing_target
  persistent="$STATE_ROOT/$relative"
  parent="$(dirname -- "$persistent")"

  if [[ -L "$parent" || (-e "$parent" && ! -d "$parent") ]]; then
    echo "Persistent agent session parent is not a private directory: $parent" >&2
    exit 2
  fi
  mkdir -p "$parent"
  if [[ -L "$persistent" || (-e "$persistent" && ! -d "$persistent") ]]; then
    echo "Persistent agent session path is not a private directory: $persistent" >&2
    exit 2
  fi
  mkdir -p "$persistent"
  chmod 700 "$parent" "$persistent" 2>/dev/null || true

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
