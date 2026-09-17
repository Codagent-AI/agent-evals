import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_QUOTA_WAIT_MS = 6 * 60 * 60 * 1000
const RESET_GRACE_MS = 60 * 1000

const CLAUDE_IDENTITY = /(?:"cli":"claude"|"provider":"anthropic"|acceptance-tester|tester profile is backed by claude)/i
const QUOTA_LIMIT = /(?:hit your(?: org(?:anization)?'s)? (?:monthly spend |session )?limit|organization spend\/rate[- ]limit|organization-level overage disabled)/i

function latestExecution(audit) {
  const marker = audit.lastIndexOf(' run_start ')
  return marker === -1 ? audit : audit.slice(marker)
}

function quotaLine(execution) {
  const lines = execution.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CLAUDE_IDENTITY.test(lines[index]) && QUOTA_LIMIT.test(lines[index])) return lines[index]
  }
  return null
}

function utcDate(year, month, day, hour, minute, second = 0) {
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return Number.isNaN(value.getTime()) ? null : value
}

function hour24(hour, meridiem) {
  if (!meridiem) return hour
  if (hour < 1 || hour > 12) return null
  if (meridiem.toLowerCase() === 'am') return hour === 12 ? 0 : hour
  return hour === 12 ? 12 : hour + 12
}

function parseReset(line) {
  const dated = line.match(
    /reset(?: time)?(?: of| was reported for)?\s+(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:\(utc\)|utc|z)/i,
  )
  if (dated) {
    return utcDate(
      Number(dated[1]), Number(dated[2]), Number(dated[3]),
      Number(dated[4]), Number(dated[5]), Number(dated[6] ?? 0),
    )
  }

  const timed = line.match(
    /(?:resets?|reset (?:time )?(?:is |was )?(?:reported )?for)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(utc\)|utc)/i,
  )
  if (!timed) return null

  const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/)?.[1]
  if (!timestamp) return null
  const eventAt = new Date(timestamp)
  if (Number.isNaN(eventAt.getTime())) return null

  const hour = hour24(Number(timed[1]), timed[3])
  const minute = Number(timed[2] ?? 0)
  if (hour === null || hour > 23 || minute > 59) return null
  let reset = utcDate(
    eventAt.getUTCFullYear(), eventAt.getUTCMonth() + 1, eventAt.getUTCDate(), hour, minute,
  )
  if (reset && reset <= eventAt) reset = new Date(reset.getTime() + 24 * 60 * 60 * 1000)
  return reset
}

function quotaRole(line) {
  if (/acceptance-tester|tester profile/i.test(line)) return 'tester'
  const recorded = line.match(/"role":"([^"]+)"/i)?.[1]?.toLowerCase()
  if (recorded === 'lead' || recorded === 'lead-agent') return 'lead'
  if (recorded === 'tester' || recorded === 'acceptance-reviewer') return 'tester'
  if (recorded === 'implementor' || recorded === 'task-implementor') return 'implementor'
  return null
}

export function detectClaudeQuotaReset({ audit, now = new Date(), maxWaitMs = MAX_QUOTA_WAIT_MS }) {
  if (typeof audit !== 'string' || audit.length === 0) return null
  const line = quotaLine(latestExecution(audit))
  if (!line) return null

  const reset = parseReset(line)
  const current = now instanceof Date ? now : new Date(now)
  if (!reset || Number.isNaN(current.getTime())) return null
  const waitMs = reset.getTime() - current.getTime()
  if (waitMs <= 0 || waitMs > maxWaitMs) return null

  return {
    role: quotaRole(line),
    reset_at: reset.toISOString(),
    wait_ms: waitMs + RESET_GRACE_MS,
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function waitForClaudeQuotaReset({
  sessionDir = null,
  audit = null,
  now = () => new Date(),
  sleep = defaultSleep,
  log = () => {},
}) {
  const durableAudit = audit ?? (
    sessionDir ? await readFile(join(sessionDir, 'audit.log'), 'utf8').catch(() => '') : ''
  )
  const detected = detectClaudeQuotaReset({ audit: durableAudit, now: now() })
  if (!detected) return { waited: false }

  log(`Claude ${detected.role} quota reached; waiting until ${detected.reset_at} before resuming Agent Runner`)
  await sleep(detected.wait_ms)
  return { waited: true, ...detected }
}
