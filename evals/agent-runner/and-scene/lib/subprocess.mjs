// Subprocess execution with active machine timing.
//
// Commands are always invoked as an argument array, never through a shell, so
// candidate- or fixture-controlled strings cannot become commands.
import { spawnSync } from 'node:child_process'

export function runTimed(command, args = [], options = {}) {
  // `exec` is injectable so the controller's lifecycle can be tested without
  // launching Agent Runner.
  const { label = command, exec = spawnSync, ...spawnOptions } = options
  const startedAt = new Date().toISOString()
  const start = process.hrtime.bigint()
  const result = exec(command, args, { encoding: 'utf8', ...spawnOptions })
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6

  // A command that never launched has a null status; report it as a failure
  // with its error rather than letting `status === null` read as success.
  const status = result.error ? (result.status ?? -1) : result.status

  return {
    label,
    command,
    args,
    status,
    ok: status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? result.error.message : null,
    started_at: startedAt,
    duration_ms: durationMs,
  }
}

export function summarizeTimings(timings) {
  const byLabel = {}
  let total = 0
  for (const timing of timings) {
    const duration = timing.duration_ms ?? 0
    total += duration
    const existing = byLabel[timing.label] ?? { count: 0, duration_ms: 0 }
    byLabel[timing.label] = { count: existing.count + 1, duration_ms: existing.duration_ms + duration }
  }
  return { total_ms: total, by_label: byLabel }
}
