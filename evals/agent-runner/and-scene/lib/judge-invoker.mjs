// Production Codex adapter for all evaluation-owned model jobs.
//
// The caller supplies a schema and an explicit web-search policy for each job.
// Codex receives the candidate checkout read-only, writes only its final answer
// and schema under the run's excluded `.runtime` directory, and runs without
// project instructions or user configuration influencing the evaluator.
//
// Each call attempt streams Codex's JSON events and stderr to disk as they
// arrive, so a stalled or killed call leaves evidence of what it was waiting
// on. A call that exceeds its timeout is stopped and retried once.
import { spawn } from 'node:child_process'
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const JUDGE_ENV_ALLOWLIST = [
  'HOME',
  'CODEX_HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
]

function judgeEnvironment(source) {
  return Object.fromEntries(JUDGE_ENV_ALLOWLIST.flatMap((name) => (
    typeof source?.[name] === 'string' ? [[name, source[name]]] : []
  )))
}

function safeJobName(value) {
  return String(value ?? 'judge').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'judge'
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_KILL_GRACE_MS = 10 * 1000
const MAX_ATTEMPTS = 2
const DIAGNOSTIC_TAIL_CHARS = 64 * 1024
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024

// Shell command output can carry any file the read-only sandbox can read, so
// persisted events keep the command, status, and exit code but not its output.
function persistableEventLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return line
  }
  const output = event?.item?.aggregated_output
  if (typeof output !== 'string') return line
  event.item.aggregated_output = `[omitted ${output.length} characters]`
  return JSON.stringify(event)
}

// Claims the first unused attempt slot so neither a retry nor a later process
// recovering the same call overwrites an earlier attempt's evidence.
async function openAttemptFiles(openFile, runtimeDir, stem) {
  for (let slot = 1; ; slot += 1) {
    const attemptStem = slot === 1 ? stem : `${stem}.attempt-${slot}`
    const eventsPath = join(runtimeDir, `${attemptStem}.events.jsonl`)
    const stderrPath = join(runtimeDir, `${attemptStem}.stderr.log`)
    let events
    try {
      events = await openFile(eventsPath, 'wx')
      const stderr = await openFile(stderrPath, 'wx')
      return {
        attemptStem,
        events,
        stderr,
        pathOf: (handle) => (handle === events ? eventsPath : stderrPath),
      }
    } catch (error) {
      await events?.close()
      if (error.code !== 'EEXIST') throw error
    }
  }
}

function tail(text) {
  return text.length > DIAGNOSTIC_TAIL_CHARS ? text.slice(-DIAGNOSTIC_TAIL_CHARS) : text
}

function runAttempt({
  spawnImpl, command, args, options, prompt, files, timeoutMs, killGraceMs, maxStdoutBytes, label,
}) {
  return new Promise((resolveAttempt) => {
    // Complete output is on disk; memory keeps only usage and a short tail.
    let usageLine = ''
    let stdoutBytes = 0
    let outputLimitExceeded = false
    let stopping = false
    let stdoutTail = ''
    let stderrTail = ''
    let pendingLine = ''
    let timedOut = false
    let killTimer = null
    let settled = false
    let writeError = null
    let eventWrites = Promise.resolve()
    let stderrWrites = Promise.resolve()
    const persist = (previous, handle, text) => previous
      .then(() => handle.write(text))
      .catch((error) => {
        writeError ??= { error, path: files.pathOf(handle) }
      })
    const writeEvents = (text) => {
      eventWrites = persist(eventWrites, files.events, text)
      return eventWrites
    }
    const writeStderr = (text) => {
      stderrWrites = persist(stderrWrites, files.stderr, text)
      return stderrWrites
    }
    // Reading resumes only once the chunk is written, so a noisy call cannot
    // queue unbounded writes.
    const throttle = (stream, written) => {
      stream.pause()
      written.then(() => { if (!stream.destroyed) stream.resume() })
    }
    const note = (message) => writeStderr(`[judge-invoker ${new Date().toISOString()}] ${label} ${message}\n`)

    // Codex leads its own process group so a timeout also stops the shell
    // commands it started, which would otherwise hold its output pipes open.
    const child = spawnImpl(command, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stop = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall back to the direct child when its group is already gone.
        }
      }
      child.kill(signal)
    }
    const finish = async (status, signal, error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (pendingLine.includes('"turn.completed"')) usageLine = pendingLine
      if (pendingLine) writeEvents(persistableEventLine(pendingLine))
      await Promise.all([eventWrites, stderrWrites])
      resolveAttempt({
        status,
        signal,
        error,
        usageLine,
        stdout: stdoutTail,
        stderr: stderrTail,
        timedOut,
        outputLimitExceeded,
        writeError,
      })
    }
    const halt = (reason) => {
      if (stopping) return
      stopping = true
      note(`${reason}; sent SIGTERM`)
      stop('SIGTERM')
      killTimer = setTimeout(() => {
        note(`did not exit within ${killGraceMs} ms of SIGTERM; sent SIGKILL`)
        stop('SIGKILL')
      }, killGraceMs)
    }
    const timer = setTimeout(() => {
      timedOut = true
      halt(`timed out after ${timeoutMs} ms`)
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (outputLimitExceeded) return
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes > maxStdoutBytes) {
        outputLimitExceeded = true
        halt(`wrote more than ${maxStdoutBytes} bytes to stdout`)
        return
      }
      stdoutTail = tail(stdoutTail + chunk)
      const lines = (pendingLine + chunk).split('\n')
      pendingLine = lines.pop()
      if (lines.length === 0) return
      for (const line of lines) {
        if (line.includes('"turn.completed"')) usageLine = line
      }
      throttle(child.stdout, writeEvents(lines.map((line) => `${persistableEventLine(line)}\n`).join('')))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrTail = tail(stderrTail + chunk)
      throttle(child.stderr, writeStderr(chunk))
    })
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (status, signal) => finish(status, signal))
    // A stopped call must not wait on output pipes held by an escaped
    // descendant; its evidence up to the stop is already on disk.
    child.on('exit', (status, signal) => {
      if (!stopping) return
      child.stdout.destroy()
      child.stderr.destroy()
      finish(status, signal)
    })
    // Codex may exit before reading its prompt; that failure is reported by
    // its exit status rather than an unhandled stdin error.
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

function detail(result) {
  return (result.stderr || result.stdout || result.error?.message || 'no diagnostic output').trim()
}

function extractCodexUsage(stdout, { request, invocationId }) {
  let usage = null
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
        usage = event.usage
      }
    } catch {
      // Non-JSON diagnostics are not usage evidence.
    }
  }

  const categoryMap = {
    input_tokens: 'input',
    cached_input_tokens: 'cached_input',
    cache_write_input_tokens: 'cache_write',
    output_tokens: 'output',
    reasoning_output_tokens: 'reasoning',
  }
  const tokens = usage
    ? Object.fromEntries(Object.entries(categoryMap).flatMap(([source, target]) => (
        Number.isFinite(usage[source]) ? [[target, usage[source]]] : []
      )))
    : null
  const input = usage?.input_tokens
  const output = usage?.output_tokens
  const tokenTotals = Number.isFinite(input) && Number.isFinite(output)
    ? { input, output, total: input + output }
    : null

  return {
    invocation_id: invocationId,
    phase: request.job ?? null,
    provider: 'openai',
    model: request.authority?.model ?? null,
    usage: usage
      ? { state: 'available', reason: null, source: 'codex:turn.completed' }
      : { state: 'unavailable', reason: 'Codex emitted no turn.completed usage', source: 'codex:turn.completed' },
    tokens,
    token_totals: tokenTotals,
  }
}

export function createCodexJudgeInvoker({
  runDir,
  candidateWorktree,
  defaultCwd = candidateWorktree,
  allowedRoots = null,
  // The sandbox installs `codex` as a yolo wrapper for implementation agents.
  // Judges must bypass that wrapper and invoke the real, sandboxed CLI.
  command = '/usr/bin/codex',
  spawnImpl = spawn,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
  openFile = open,
} = {}) {
  const runtimeDir = join(resolve(runDir), '.runtime', 'judge')
  const usagePath = join(resolve(runDir), 'phases', 'eval-owned-usage.jsonl')
  const fallbackCwd = resolve(defaultCwd)
  const approvedRoots = (allowedRoots ?? [fallbackCwd]).map((root) => resolve(root))
  let sequence = 0

  const inMemoryUsage = []

  const invoke = async function invoke(request) {
    const cwd = resolve(request.cwd ?? fallbackCwd)
    const approved = approvedRoots.some((root) => {
      const offset = relative(root, cwd)
      return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
    })
    if (!approved) {
      throw new Error(`Codex judge ${request.job ?? 'job'} cwd is not an approved read-only root: ${cwd}`)
    }
    await mkdir(cwd, { recursive: true })
    sequence += 1
    const stem = `${String(sequence).padStart(2, '0')}-${safeJobName(request.job)}`
    const schemaPath = join(runtimeDir, `${stem}.schema.json`)
    const outputPath = join(runtimeDir, `${stem}.output.json`)
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(schemaPath, `${JSON.stringify(request.schema, null, 2)}\n`)

    const args = [
      'exec',
      '--json',
      '--cd', cwd,
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      // Codex itself receives the isolated home so it can authenticate, but
      // model-generated shell commands inherit none of the parent environment.
      // Candidate prompt injection therefore cannot print evaluator or harness
      // credentials with `env`.
      '--config', 'shell_environment_policy.inherit="none"',
      '--config', `web_search="${request.web_search === true || request.web_search === 'authorized' ? 'live' : 'disabled'}"`,
      '--output-schema', schemaPath,
      '--output-last-message', outputPath,
      '--color', 'never',
    ]
    const model = request.authority?.model
    if (model && model !== 'codex-default') args.push('--model', model)
    args.push('-')

    let result
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await rm(outputPath, { force: true })
      const files = await openAttemptFiles(openFile, runtimeDir, stem)
      try {
        result = await runAttempt({
          spawnImpl,
          command,
          args,
          options: { cwd, env: judgeEnvironment(env) },
          prompt: request.prompt,
          files,
          timeoutMs,
          killGraceMs,
          maxStdoutBytes,
          label: `Codex judge ${request.job ?? 'job'} attempt ${attempt}`,
        })
      } finally {
        await Promise.all([files.events.close(), files.stderr.close()])
      }
      const usageEntry = extractCodexUsage(result.usageLine, {
        request,
        invocationId: `${files.attemptStem}-${Date.now()}`,
      })
      if (result.timedOut && usageEntry.usage.state !== 'available') {
        usageEntry.usage.reason = `Codex judge attempt timed out after ${timeoutMs} ms without turn.completed usage`
      }
      inMemoryUsage.push(usageEntry)
      try {
        await mkdir(dirname(usagePath), { recursive: true })
        await appendFile(usagePath, `${JSON.stringify(usageEntry)}\n`)
      } catch {
        // Usage diagnostics must not replace an otherwise valid judge result.
      }
      if (result.writeError) {
        throw new Error(
          `Codex judge ${request.job ?? 'job'} could not record its attempt evidence at ${result.writeError.path}: ${result.writeError.error.message}`,
        )
      }
      if (result.outputLimitExceeded) {
        throw new Error(
          `Codex judge ${request.job ?? 'job'} exceeded the ${maxStdoutBytes}-byte stdout limit`,
        )
      }
      if (!result.timedOut) break
    }
    if (result.timedOut) {
      throw new Error(
        `Codex judge ${request.job ?? 'job'} timed out after ${timeoutMs} ms on ${MAX_ATTEMPTS} attempts`,
      )
    }
    if (result.error || result.status !== 0) {
      throw new Error(
        `Codex judge ${request.job ?? 'job'} exited ${result.status ?? -1}: ${detail(result)}`,
      )
    }
    try {
      return await readFile(outputPath, 'utf8')
    } catch (error) {
      throw new Error(`Codex judge ${request.job ?? 'job'} produced no final response: ${error.message}`)
    }
  }

  invoke.readUsageEntries = async () => {
    let text
    try {
      text = await readFile(usagePath, 'utf8')
    } catch {
      return [...inMemoryUsage]
    }
    return text.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line)]
      } catch {
        return [{
          phase: 'usage-ledger', provider: null, model: null, tokens: null,
          usage: { state: 'unavailable', reason: 'eval-owned usage ledger contains malformed JSON' },
        }]
      }
    })
  }

  return invoke
}
