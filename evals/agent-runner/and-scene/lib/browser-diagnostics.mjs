// Browser-process and adapter diagnostics belong to the evaluation harness,
// never to the candidate page's runtime/console record. Keep this allowlist
// narrow: arbitrary page console text must remain candidate evidence.
const INFRASTRUCTURE_DIAGNOSTICS = [
  /Could not find Google Chrome executable for channel/i,
  /Could not find a runnable Chromium for chrome-devtools-axi/i,
  /Sandbox Chromium did not expose its DevTools endpoint/i,
  // The adapter prints its channel message, the paths it searched, and its own
  // usage help on one stream. Every line of that report is harness output, so
  // none of it may be attributed to the candidate page.
  /^-\s*\/\S*(?:chrome|chromium)\S*\.?$/i,
  /^help\[\d+\]:/i,
  /^Run `chrome-devtools-axi\b/i,
]

export function isBrowserInfrastructureDiagnostic(value) {
  if (typeof value !== 'string') return false
  return INFRASTRUCTURE_DIAGNOSTICS.some((pattern) => pattern.test(value))
}

export function probeContainsBrowserInfrastructureDiagnostic(record) {
  return (record?.failures ?? []).some(isBrowserInfrastructureDiagnostic)
}
