#!/usr/bin/env bash
# The host has verified the pinned skill tree and all workflow requirements.
set -euo pipefail
SOURCE_DIR="${1:?agent skills source directory is required}"
shift
if (($# == 0)); then
  echo "At least one CLI is required" >&2
  exit 2
fi
seen=" "
for adapter in "$@"; do
  if [[ "$seen" == *" $adapter "* ]]; then
    continue
  fi
  seen+="$adapter "
  case "$adapter" in
    claude)
      # Host settings may name a local marketplace path that does not exist
      # inside the container. Replace only that disposable-home entry.
      claude plugin marketplace remove codagent >/dev/null 2>&1 || true
      claude plugin marketplace add "$SOURCE_DIR"
      claude plugin install codagent@codagent
      claude plugin list
      ;;
    codex)
      codex plugin marketplace add "$SOURCE_DIR" --json
      codex plugin add codagent@codagent --json
      codex plugin list
      ;;
    cursor)
      mkdir -p "$HOME/.cursor/plugins"
      # ln -sfn descends into an existing real directory and links inside it,
      # leaving the pinned source uninstalled at the expected path. Replace an
      # existing symlink, and refuse anything else rather than load stale plugins.
      cursor_plugin="$HOME/.cursor/plugins/codagent"
      if [[ -e "$cursor_plugin" && ! -L "$cursor_plugin" ]]; then
        echo "refusing to replace existing Cursor plugin path: $cursor_plugin" >&2
        exit 2
      fi
      rm -f "$cursor_plugin"
      ln -s "$SOURCE_DIR" "$cursor_plugin"
      ;;
    *)
      echo "unsupported agent adapter for Codagent skills: $adapter" >&2
      exit 2
      ;;
  esac
done
