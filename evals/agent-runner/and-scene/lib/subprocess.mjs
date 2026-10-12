// Subprocess execution with active machine timing.
//
// Commands are always invoked as an argument array, never through a shell, so
// candidate- or fixture-controlled strings cannot become commands.
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export function runTimed(command, args = [], options = {}) {
  // `exec` is injectable so the controller's lifecycle can be tested without
  // launching Agent Runner.
  const {
    label = command,
    exec = spawnSync,
    outputPath = null,
    ...spawnOptions
  } = options
  const startedAt = new Date().toISOString()
  const start = process.hrtime.bigint()
  let outputFd = null
  let result
  try {
    outputFd = openLog(outputPath, label, startedAt)
    result = exec(command, args, {
      encoding: 'utf8',
      ...spawnOptions,
      ...(outputFd === null ? {} : { stdio: ['ignore', outputFd, outputFd] }),
    })
    preserveBuffered(outputFd, result)
  } finally {
    if (outputFd !== null) closeSync(outputFd)
  }
  return timingRecord({ label, command, args, outputPath, startedAt, start, result })
}

function openLog(outputPath, label, startedAt) {
  if (!outputPath) return null
  mkdirSync(dirname(outputPath), { recursive: true })
  const fd = openSync(outputPath, 'a')
  writeSync(fd, `\n[${startedAt}] ${label}\n`)
  return fd
}

function preserveBuffered(outputFd, result) {
  // Injected executors return buffered strings even when given stdio. Preserve
  // those strings in the same durable log production subprocesses stream to.
  if (outputFd === null) return
  if (result.stdout) writeSync(outputFd, result.stdout)
  if (result.stderr) writeSync(outputFd, result.stderr)
}

// The asynchronous form, for executors that must keep running while the
// controller watches them (Agent Runner under a pseudo-terminal). stdin is a
// pipe so such an executor can hold it open; a synchronous executor still
// works, since awaiting its plain result is harmless.
export async function runTimedAsync(command, args = [], options = {}) {
  const {
    label = command,
    exec,
    outputPath = null,
    ...spawnOptions
  } = options
  if (typeof exec !== 'function') throw new Error('runTimedAsync requires an executor')
  const startedAt = new Date().toISOString()
  const start = process.hrtime.bigint()
  let outputFd = null
  let result
  try {
    outputFd = openLog(outputPath, label, startedAt)
    result = await exec(command, args, {
      encoding: 'utf8',
      ...spawnOptions,
      ...(outputFd === null ? {} : { stdio: ['pipe', outputFd, outputFd] }),
    })
    preserveBuffered(outputFd, result)
  } finally {
    if (outputFd !== null) closeSync(outputFd)
  }
  return timingRecord({ label, command, args, outputPath, startedAt, start, result })
}

function timingRecord({ label, command, args, outputPath, startedAt, start, result }) {
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6

  // Preserve a command-launch failure's native null status and error code.
  // Replacing it with a synthetic -1 discards the diagnostic needed to tell an
  // output-buffer failure from a missing executable or signal termination.
  const status = result.status ?? null

  return {
    label,
    command,
    args,
    status,
    ok: !result.error && status === 0,
    stdout: outputPath ? '' : (result.stdout ?? ''),
    stderr: outputPath ? '' : (result.stderr ?? ''),
    error: result.error ? result.error.message : null,
    error_code: result.error?.code ?? null,
    signal: result.signal ?? null,
    output_path: outputPath,
    started_at: startedAt,
    duration_ms: durationMs,
    // Set only when the executor ended the command itself: 'stalled' or
    // 'timed-out'.
    ...(result.ended ? { ended: result.ended } : {}),
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
