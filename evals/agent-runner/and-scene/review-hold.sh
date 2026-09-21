#!/usr/bin/env bash
set -euo pipefail
SUITE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: evals/agent-runner/and-scene/review-hold.sh --run-dir PATH --reviewer NAME --decision stand|verdict-wrong --rationale TEXT"
  exit 0
fi
exec node "$SUITE_DIR/review-hold.mjs" "$@"
