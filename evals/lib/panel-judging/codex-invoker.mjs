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
import { constants } from 'node:fs'
import { appendFile, mkdir, mkdtemp, lstat, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const JUDGE_ENV_ALLOWLIST = [
  'HOME',
  // The Claude CLI finds its macOS Keychain login through the user identity.
  'USER',
  'LOGNAME',
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

export function judgeEnvironment(source) {
  return Object.fromEntries(JUDGE_ENV_ALLOWLIST.flatMap((name) => (
    typeof source?.[name] === 'string' ? [[name, source[name]]] : []
  )))
}

function safeJobName(value) {
  return String(value ?? 'judge').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'judge'
}

// The effort every eval-owned judge call runs at, recorded with its authority.
export const JUDGE_REASONING_EFFORT = 'high'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_KILL_GRACE_MS = 10 * 1000
const MAX_ATTEMPTS = 2
const DIAGNOSTIC_TAIL_CHARS = 64 * 1024
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024
// A model-capacity rejection arrives before any work, so it is waited out
// rather than spending one of the judge's limited attempts.
export const CAPACITY_RETRIES = 5
export const CAPACITY_BASE_DELAY_MS = 30 * 1000
const CAPACITY_PATTERN = /at capacity/i

// The turn.failed message when Codex rejected the turn before doing any work.
function rejectedBeforeWork(result) {
  if (result.usageLine || result.workSeen || !result.failedLine) return null
  try {
    const event = JSON.parse(result.failedLine)
    return String(event?.error?.message ?? 'turn failed')
  } catch {
    return 'turn failed'
  }
}

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
export async function openAttemptFiles(openFile, runtimeDir, stem) {
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

export function runAttempt({
  spawnImpl, command, args, options, prompt, files, timeoutMs, killGraceMs, maxStdoutBytes, label, observeLine = () => {}, persistLine = persistableEventLine,
}) {
  return new Promise((resolveAttempt) => {
    // Complete output is on disk; memory keeps only usage and a short tail.
    let usageLine = ''
    let failedLine = ''
    let workSeen = false
    let stdoutBytes = 0
    let outputLimitExceeded = false
    let stopping = false
    let stdoutTail = ''
    let stderrTail = ''
    let pendingLine = ''
    let timedOut = false
    let killTimer = null
    let forceKilled = false
    let exited = null
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
      // A descendant may outlive a stopped Codex. It keeps the group's id from
      // being reused, so the group is force-killed now; a grace timer left
      // armed could later signal a reused id and would hold the loop open.
      if (stopping && !forceKilled) stop('SIGKILL')
      if (pendingLine.includes('"turn.completed"')) usageLine = pendingLine
      if (pendingLine.includes('"turn.failed"')) failedLine = pendingLine
      if (/"type":"item\./.test(pendingLine)) workSeen = true
      if (pendingLine) observeLine(pendingLine)
      if (pendingLine) writeEvents(persistLine(pendingLine))
      await Promise.all([eventWrites, stderrWrites])
      resolveAttempt({
        status,
        signal,
        error,
        usageLine,
        failedLine,
        workSeen,
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
      // Settling clears this timer, so it fires only while Codex still runs.
      killTimer = setTimeout(() => {
        note(`did not exit within ${killGraceMs} ms of SIGTERM; sent SIGKILL`)
        forceKilled = true
        stop('SIGKILL')
      }, killGraceMs)
      // Codex may have exited already, leaving no `exit` event to settle on.
      if (exited) settleExited()
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
        observeLine(line)
        if (line.includes('"turn.completed"')) usageLine = line
        if (line.includes('"turn.failed"')) failedLine = line
        if (/"type":"item\./.test(line)) workSeen = true
      }
      throttle(child.stdout, writeEvents(lines.map((line) => `${persistLine(line)}\n`).join('')))
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
    const settleExited = () => {
      child.stdout.destroy()
      child.stderr.destroy()
      finish(exited.status, exited.signal)
    }
    child.on('exit', (status, signal) => {
      exited = { status, signal }
      if (stopping) settleExited()
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

function extractCodexUsage(stdout, { request, invocationId, rejected = null }) {
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

  if (!usage && rejected !== null) {
    return {
      invocation_id: invocationId,
      phase: request.job ?? null,
      stage: request.usage_phase ?? null,
      provider: 'openai',
      model: request.authority?.model ?? null,
      usage: { state: 'available', reason: `Codex turn rejected before any model output: ${rejected}`,
        source: 'codex:turn.failed' },
      tokens: { input: 0, cached_input: 0, output: 0, reasoning: 0 },
      token_totals: { input: 0, output: 0, total: 0 },
    }
  }
  return {
    invocation_id: invocationId,
    phase: request.job ?? null,
    stage: request.usage_phase ?? null,
    provider: 'openai',
    model: request.authority?.model ?? null,
    usage: usage
      ? { state: 'available', reason: null, source: 'codex:turn.completed' }
      : { state: 'unavailable', reason: 'Codex emitted no turn.completed usage', source: 'codex:turn.completed' },
    tokens,
    token_totals: tokenTotals,
  }
}

// Private copies must not discard rotated refresh tokens. Serialize private
// calls sharing host auth across invoker instances in this process.
const privateAuthLocks = new Map()
async function lockPrivateAuth(path) {
  const previous = privateAuthLocks.get(path) ?? Promise.resolve()
  let release
  const pending = new Promise(resolveLock => { release = resolveLock })
  privateAuthLocks.set(path, pending)
  await previous
  return () => {
    if (privateAuthLocks.get(path) === pending) privateAuthLocks.delete(path)
    release()
  }
}
function authError(error, path) {
  if (error.code === 'ENOENT') return new Error(`Codex authentication not found at ${path}; run codex login`)
  if (error.code === 'ELOOP') return new Error(`Codex authentication refuses symlink: ${path}`)
  return error
}
async function readAuth(path) {
  let handle
  try {
    // O_NOFOLLOW closes the lstat/readFile race for the credential file.
    // O_NONBLOCK also lets fstat reject a FIFO without blocking on open.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await handle.stat()).isFile()) throw new Error(`Codex authentication must be a regular auth.json: ${path}`)
    return await handle.readFile()
  } catch (error) { throw authError(error, path) }
  finally { await handle?.close() }
}
async function verifyAuthRoot(root) {
  let stat
  try { stat = await lstat(root) } catch (error) { throw authError(error, root) }
  if (stat.isSymbolicLink()) throw new Error(`Codex authentication refuses symlink: ${root}`)
  if (!stat.isDirectory()) throw new Error(`Codex authentication home must be a directory: ${root}`)
}
async function persistRefreshedAuth({ privateHome, authPath, originalAuth }) {
  const refreshed = await readAuth(join(privateHome, 'auth.json'))
  if (refreshed.equals(originalAuth)) return originalAuth
  // Never propagate malformed CLI state, or print credential contents in errors.
  try {
    const value = JSON.parse(refreshed)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid auth')
  } catch { throw new Error('Codex judge wrote invalid authentication JSON') }
  const root = dirname(authPath)
  await verifyAuthRoot(root)
  const staging = await mkdtemp(join(root, '.eval-auth-'))
  try {
    const path = join(staging, 'auth.json')
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(refreshed); await handle.sync() } finally { await handle.close() }
    // Another host CLI may have logged in while the judge was running. Do not
    // silently overwrite its credentials with our independently refreshed copy.
    if (!(await readAuth(authPath)).equals(originalAuth)) throw new Error('Codex host authentication changed during the judge call; refusing to overwrite it; run codex login if authentication fails')
    await rename(path, authPath)
    return refreshed
  } finally { await rm(staging, { recursive: true, force: true }) }
}
async function sweepLegacyPrivateHomes(runtimeDir) {
  // Older versions copied auth into the run directory. New private homes live
  // in the OS temp directory, so no current call creates these legacy entries.
  for (const name of await readdir(runtimeDir)) {
    if (/^home-[a-zA-Z0-9]+$/.test(name)) await rm(join(runtimeDir, name), { recursive: true, force: true })
  }
}

export function createCodexJudgeInvoker({
  runDir,
  candidateWorktree,
  defaultCwd = candidateWorktree,
  allowedRoots = null,
  // Host suites may isolate CLI state; sandbox callers keep existing behavior.
  privateCodexHome = false,
  // The sandbox installs `codex` as a yolo wrapper for implementation agents.
  // Judges must bypass that wrapper and invoke the real, sandboxed CLI.
  command = '/usr/bin/codex',
  spawnImpl = spawn,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
  openFile = open,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  const runtimeDir = join(resolve(runDir), '.runtime', 'judge')
  const usagePath = join(resolve(runDir), 'phases', 'eval-owned-usage.jsonl')
  const fallbackCwd = resolve(defaultCwd)
  const approvedRoots = (allowedRoots ?? [fallbackCwd]).map((root) => resolve(root))
  let sequence = 0
  let privateRuntimeReady

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
    if (privateCodexHome) {
      for (const path of [runtimeDir, dirname(runtimeDir)]) {
        const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
        if (stat?.isSymbolicLink()) throw new Error(`private Codex home refuses symlink: ${path}`)
      }
    }
    await mkdir(cwd, { recursive: true })
    sequence += 1
    const stem = `${String(sequence).padStart(2, '0')}-${safeJobName(request.job)}`
    const schemaPath = join(runtimeDir, `${stem}.schema.json`)
    const outputPath = join(runtimeDir, `${stem}.output.json`)
    await mkdir(runtimeDir, { recursive: true })
    if (privateCodexHome) await (privateRuntimeReady ??= sweepLegacyPrivateHomes(runtimeDir))
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
    // Pinned so a change in the CLI's default effort cannot shift verdicts.
    args.push('--config', `model_reasoning_effort="${request.authority?.effort ?? JUDGE_REASONING_EFFORT}"`)
    args.push('-')

    let privateHome = null
    let releaseAuth = null
    let authPath; let originalAuth
    let invocationEnvironment = judgeEnvironment(env)
    try {
      if (privateCodexHome) {
        const authRoot = resolve(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'))
        authPath = join(authRoot, 'auth.json')
        releaseAuth = await lockPrivateAuth(authPath)
        await verifyAuthRoot(authRoot)
        originalAuth = await readAuth(authPath)
        privateHome = await mkdtemp(join(tmpdir(), 'codagent-eval-codex-home-'))
        await writeFile(join(privateHome, 'auth.json'), originalAuth, { mode: 0o600, flag: 'wx' })
        invocationEnvironment = { ...invocationEnvironment, CODEX_HOME: privateHome }
      }
      let result
      let capacityWaits = 0
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await rm(outputPath, { force: true })
        const files = await openAttemptFiles(openFile, runtimeDir, stem)
        try {
          result = await runAttempt({
            spawnImpl,
            command,
            args,
            options: { cwd, env: invocationEnvironment },
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
        const rejected = rejectedBeforeWork(result)
        // A response format OpenAI rejects is rejected identically on every
        // retry (agent-evals #79), so it fails fast as a harness defect.
        const schemaRejection = /invalid_json_schema/.test(`${rejected ?? ''}\n${result.stdout ?? ''}`)
        const usageEntry = extractCodexUsage(result.usageLine, {
          request,
          invocationId: `${files.attemptStem}-${Date.now()}`,
          rejected,
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
        if (privateHome) originalAuth = await persistRefreshedAuth({ privateHome, authPath, originalAuth })
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
        if (schemaRejection) {
          throw Object.assign(new Error(
            `Codex judge ${request.job ?? 'job'} output schema was rejected (invalid_json_schema): ${rejected ?? detail(result)}`,
          ), { code: 'judge-schema-invalid', retryable: false, owner: 'evaluation-harness', resumable: false })
        }
        if (rejected !== null && CAPACITY_PATTERN.test(rejected) && capacityWaits < CAPACITY_RETRIES) {
          await sleep(CAPACITY_BASE_DELAY_MS * 2 ** capacityWaits)
          capacityWaits += 1
          attempt -= 1
          continue
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
    } finally {
      try { if (privateHome) await rm(privateHome, { recursive: true, force: true }) }
      finally { releaseAuth?.() }
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
