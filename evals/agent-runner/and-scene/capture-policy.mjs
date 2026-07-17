const DEFAULT_SETTLE_MS = 1000
const MAX_SETTLE_MS = 10_000

export function parseSettleMs(value) {
  if (value === undefined || value === '') return DEFAULT_SETTLE_MS
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SETTLE_MS
  return Math.min(parsed, MAX_SETTLE_MS)
}
