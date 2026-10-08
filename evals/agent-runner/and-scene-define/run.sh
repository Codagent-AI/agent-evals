#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The maintainer calibration diagnostic is a separate entry point; candidate
# runs never load or require it.
for arg in "$@"; do
  if [[ "$arg" == "--calibrate" ]]; then exec node "$SCRIPT_DIR/calibrate.mjs" "$@"; fi
done
exec node "$SCRIPT_DIR/controller.mjs" "$@"
