#!/usr/bin/env bash

# Run one evidence capture, then exactly one penalized repair and recapture when
# capture fails or the manifest reports incomplete coverage. The caller supplies
# capture/repair function names so the policy is integration-testable without a
# browser or model call.
ensure_complete_evidence() {
  local capture_function="$1"
  local repair_function="$2"
  local manifest="$3"

  EVIDENCE_REPAIR_ATTEMPTED=false
  EVIDENCE_REPAIR_PENALTY=0
  if "$capture_function" && jq -e '.complete == true' "$manifest" >/dev/null 2>&1; then
    return 0
  fi

  EVIDENCE_REPAIR_ATTEMPTED=true
  EVIDENCE_REPAIR_PENALTY=5
  if "$repair_function" && "$capture_function" && jq -e '.complete == true' "$manifest" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}
