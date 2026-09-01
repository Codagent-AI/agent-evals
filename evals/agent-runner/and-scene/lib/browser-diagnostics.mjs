// Browser-process and adapter diagnostics belong to the evaluation harness,
// never to the candidate page's runtime/console record. Keep this allowlist
// narrow: arbitrary page console text must remain candidate evidence.
const INFRASTRUCTURE_DIAGNOSTICS = [
  /Could not find Google Chrome executable for channel/i,
  /Could not find a runnable Chromium for chrome-devtools-axi/i,
  /Sandbox Chromium did not expose its DevTools endpoint/i,
]

export function isBrowserInfrastructureDiagnostic(value) {
  if (typeof value !== 'string') return false
  return INFRASTRUCTURE_DIAGNOSTICS.some((pattern) => pattern.test(value))
}

export function probeContainsBrowserInfrastructureDiagnostic(record) {
  return (record?.failures ?? []).some(isBrowserInfrastructureDiagnostic)
}
