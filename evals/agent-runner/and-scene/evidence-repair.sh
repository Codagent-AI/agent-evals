#!/usr/bin/env bash

# Run one evidence capture, then exactly one repair attempt and recapture when
# capture fails or the manifest reports incomplete coverage.
#
# Evidence repair is diagnostic, not punitive. It is harness activity, and
# harness activity awards and deducts no product points, so this policy records
# what happened and exports no penalty.
#
# The repair job is confined to a temporary workspace holding only a copy of the
# capture helper, so it can never edit the candidate's delivered source — which
# would let the harness rewrite the implementation it is scoring.
#
# The caller supplies capture/repair function names so the policy is
# integration-testable without a browser or a model call.

prepare_repair_workspace() {
  local helper="$1"
  local workspace
  workspace="$(mktemp -d "${TMPDIR:-/tmp}/and-scene-evidence-repair-XXXXXX")"
  if [ -n "$helper" ] && [ -f "$helper" ]; then
    cp "$helper" "$workspace/"
  fi
  printf '%s\n' "$workspace"
}

ensure_complete_evidence() {
  local capture_function="$1"
  local repair_function="$2"
  local manifest="$3"
  local helper="${4:-}"

  EVIDENCE_REPAIR_ATTEMPTED=false
  EVIDENCE_REPAIR_SUCCEEDED=false
  EVIDENCE_REPAIR_WORKSPACE=""

  if "$capture_function" && jq -e '.complete == true' "$manifest" >/dev/null 2>&1; then
    return 0
  fi

  EVIDENCE_REPAIR_ATTEMPTED=true
  EVIDENCE_REPAIR_WORKSPACE="$(prepare_repair_workspace "$helper")"
  export EVIDENCE_REPAIR_WORKSPACE

  if "$repair_function" && "$capture_function" && jq -e '.complete == true' "$manifest" >/dev/null 2>&1; then
    EVIDENCE_REPAIR_SUCCEEDED=true
    return 0
  fi
  return 1
}
