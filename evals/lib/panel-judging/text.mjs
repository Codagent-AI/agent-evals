// The candidate controls every string and number that crosses this boundary, so
// both are bounded before they reach a rationale, an artifact, or a report.
export const MAX_EVIDENCE_CHARS = 200

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// Control characters and whitespace runs collapse to a single space, so one
// candidate string cannot reflow a log line, an artifact, or a report cell.
const NOISE = new RegExp('[\\u0000-\\u001f\\u007f\\s]+', 'g')

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

// Collapsing and truncating candidate text is idempotent, so it is safe to
// apply wherever text is collected or retained. Escaping is not, so it lives
// in `bounded` and is applied exactly once, at the edge that emits a rationale
// or a report cell.
export function normalizeEvidence(value, maxChars = MAX_EVIDENCE_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return truncate(text.replace(NOISE, ' ').trim(), maxChars)
}

// Candidate text is evidence, never markup and never a prompt instruction.
export function bounded(value, maxChars = MAX_EVIDENCE_CHARS) {
  const escaped = normalizeEvidence(value, maxChars)
    .replace(/[&<>"']/g, (character) => ESCAPES[character])
  return truncate(escaped, maxChars)
}
