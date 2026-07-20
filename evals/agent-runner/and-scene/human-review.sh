#!/usr/bin/env bash
# Thin host entry point for the literal human review.
#
# The automated run ends at `pending-human-review` with the evaluated candidate
# recorded but no official score. This command reopens that run directory,
# serves the same candidate revision, asks the 13 versioned questions, and
# finalizes the official score.
#
# It runs on the host rather than in the sandbox: a human needs the candidate
# URL in their own browser, and a review that spans hours must survive the
# container that produced the run. Like run.sh, this script owns only argument
# handling and invocation; the review lifecycle lives in human-review.mjs.
set -euo pipefail

SUITE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR=""
BASELINE_RUN_DIR=""

usage() {
  cat <<'USAGE'
Usage: evals/agent-runner/and-scene/human-review.sh --run-dir PATH [options]

Completes the literal human review for a run left at pending-human-review and
finalizes its official score, report, and artifact manifest.

Options:
  --run-dir PATH           Run directory to review. Required.
  --baseline-run-dir PATH  Pending reference-baseline run to review first, so
                           the candidate result can record baseline deltas. The
                           baseline is asked its own 13 questions and keeps its
                           own candidate, response, score, and completion state.
  -h, --help               Show this help.

The review is resumable: every accepted answer is saved immediately, and a later
invocation against the same run directory restores the saved answers, presents
the candidate URL and readiness confirmation again, and continues at the first
unanswered question. Nothing is scored officially until the summary is
explicitly confirmed.
USAGE
}

while (($#)); do
  case "$1" in
    --run-dir)
      RUN_DIR="${2:?missing value for --run-dir}"
      shift 2
      ;;
    --baseline-run-dir)
      BASELINE_RUN_DIR="${2:?missing value for --baseline-run-dir}"
      shift 2
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

if [[ -z "$RUN_DIR" ]]; then
  echo "--run-dir is required." >&2
  usage >&2
  exit 2
fi
if [[ ! -d "$RUN_DIR" ]]; then
  echo "Run directory does not exist: $RUN_DIR" >&2
  exit 2
fi
if [[ -n "$BASELINE_RUN_DIR" && ! -d "$BASELINE_RUN_DIR" ]]; then
  echo "Baseline run directory does not exist: $BASELINE_RUN_DIR" >&2
  exit 2
fi

ARGS=(--run-dir "$RUN_DIR")
if [[ -n "$BASELINE_RUN_DIR" ]]; then
  ARGS+=(--baseline-run-dir "$BASELINE_RUN_DIR")
fi

exec node "$SUITE_DIR/human-review.mjs" "${ARGS[@]}"
