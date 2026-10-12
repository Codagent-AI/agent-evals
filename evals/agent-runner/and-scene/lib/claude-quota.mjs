import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_QUOTA_WAIT_MS = 6 * 60 * 60 * 1000
const RESET_GRACE_MS = 60 * 1000

// Claude identity comes only from the recorded CLI or provider, or from an
// agent's explicit statement that a role profile is backed by Claude (a child
// agent call reported by its caller). Session and step names are never
// evidence: a workflow may rename them or reuse them for another CLI.
const ROLE_NAMES = 'lead|crosscheck|implementor|tester'
const CLAUDE_IDENTITY = new RegExp(`(?:"cli":"claude"|"provider":"anthropic"|\\b(?:${ROLE_NAMES}) profile is backed by claude)`, 'i')
const STATED_ROLE = new RegExp(`\\b(${ROLE_NAMES}) profile is backed by claude`, 'i')
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

// The recorded Agent Runner agent names the role. Without one the role stays
// unknown rather than being guessed from a session or step name.
const RECORDED_ROLES = {
  lead: 'lead',
  'lead-agent': 'lead',
  crosscheck: 'crosscheck',
  implementor: 'implementor',
  'task-implementor': 'implementor',
  tester: 'tester',
  'acceptance-reviewer': 'tester',
}

function quotaRole(line) {
  const stated = line.match(STATED_ROLE)?.[1]?.toLowerCase()
  if (stated) return stated
  const recorded = line.match(/"(?:role|agent)":"([^"]+)"/i)?.[1]?.toLowerCase()
  return RECORDED_ROLES[recorded] ?? null
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

  log(`Claude ${detected.role ?? 'unattributed'} quota reached; waiting until ${detected.reset_at} before resuming Agent Runner`)
  await sleep(detected.wait_ms)
  return { waited: true, ...detected }
}

const TRANSCRIPT_FILES_SCANNED = 5
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

async function newestTranscripts(projectsDir) {
  const files = []
  const pending = [projectsDir]
  while (pending.length > 0) {
    const path = pending.pop()
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const stats = await stat(child).catch(() => null)
        if (stats?.isDirectory()) pending.push(child)
        else if (stats?.isFile() && entry.name.endsWith('.jsonl')) files.push({ path: child, mtimeMs: stats.mtimeMs })
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stats = await stat(child).catch(() => null)
        if (stats) files.push({ path: child, mtimeMs: stats.mtimeMs })
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, TRANSCRIPT_FILES_SCANNED)
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
}

// An interactive Claude session shows a usage limit in its terminal, so it
// never reaches Agent Runner's audit log. Claude records API errors in the
// session transcript as assistant entries flagged `isApiErrorMessage`; this
// renders the newest such entries as audit-style lines, so the same quota
// rule decides whether the run waits for a reset.
// Only errors recorded at or after `sinceMs` count, so a limit left in a
// transcript by an earlier run never causes a wait.
export async function readTranscriptQuotaAudit({ projectsDir, sinceMs = null }) {
  if (!projectsDir) return ''
  const lines = []
  for (const { path } of await newestTranscripts(projectsDir)) {
    let text
    try {
      const buffer = await readFile(path)
      text = buffer.subarray(Math.max(0, buffer.length - TRANSCRIPT_TAIL_BYTES)).toString('utf8')
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      if (!raw.includes('isApiErrorMessage')) continue
      let entry
      try { entry = JSON.parse(raw) } catch { continue }
      if (entry?.isApiErrorMessage !== true || typeof entry.timestamp !== 'string') continue
      if (Number.isFinite(sinceMs) && !(Date.parse(entry.timestamp) >= sinceMs)) continue
      const message = messageText(entry.message).replace(/\s+/g, ' ').trim()
      if (message) lines.push(`${entry.timestamp} transcript_api_error {"cli":"claude"} ${message}`)
    }
  }
  return lines.sort().join('\n')
}
