// Claude structured-output adapter. Suites supply quota policy; no suite imports.
import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CAPACITY_BASE_DELAY_MS, CAPACITY_RETRIES, judgeEnvironment, openAttemptFiles, runAttempt } from './codex-invoker.mjs'

const inside = (root, path) => {
  const offset = relative(root, path)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}
// Without ~/.claude/.credentials.json (a macOS Keychain login), a sandbox
// authenticates Claude with a `claude setup-token` token; only Claude judges get it.
const claudeJudgeEnvironment = env => ({ ...judgeEnvironment(env),
  ...(typeof env?.CLAUDE_CODE_OAUTH_TOKEN === 'string' ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN } : {}) })
const harnessError = (message, extra = {}) => Object.assign(new Error(message), { owner: 'evaluation-harness', ...extra })

export function createClaudeJudgeInvoker({
  runDir, mode = 'host', allowedRoots = [], command = 'claude', spawnImpl = spawn,
  env = process.env, timeoutMs = 600000, killGraceMs = 10000, maxStdoutBytes = 16 * 1024 * 1024,
  openFile = open, sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  detectQuotaReset = () => null, waitForQuotaReset = async () => ({ waited: false }), now = () => new Date(),
} = {}) {
  if (!['host', 'in-sandbox'].includes(mode)) throw new Error(`unknown Claude judge mode: ${mode}`)
  const runtimeDir = join(resolve(runDir), '.runtime', 'judge-claude')
  const usagePath = join(resolve(runDir), 'phases', 'eval-owned-usage.jsonl')
  const memory = []
  let sequence = 0
  const invoke = async request => {
    await mkdir(runtimeDir, { recursive: true })
    // Evidence and closed-world packets always use a scratch directory, even in sandbox mode.
    const readTools = mode === 'in-sandbox' && request.input_roots?.source != null
    const tools = readTools ? ['Read', 'Grep', 'Glob'] : []
    let cwd
    if (mode === 'in-sandbox' && request.cwd) {
      const requested = resolve(request.cwd)
      if (!allowedRoots.some(root => inside(resolve(root), requested))) throw harnessError(`Claude judge cwd is not an approved read-only root: ${requested}`)
      // Seats start together, so a Codex seat may not have created the shared
      // workspace yet. Create an approved root itself, never a path beneath one.
      if (allowedRoots.some(root => resolve(root) === requested)) await mkdir(requested, { recursive: true })
      const canonical = await realpath(requested)
      const approved = await Promise.all(allowedRoots.map(root => realpath(root).catch(() => null)))
      if (!approved.some(root => root && inside(root, canonical))) throw harnessError('Claude judge cwd escapes approved read-only root')
      cwd = requested
    }
    const scratch = !readTools ? await mkdtemp(join(runtimeDir, 'scratch-')) : null
    cwd = scratch ?? cwd
    if (!cwd) throw harnessError('Claude judge requires an approved read-only cwd')
    const stem = `${String(++sequence).padStart(2, '0')}-${String(request.job ?? 'judge').replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const args = ['-p', '--model', request.authority.model, '--effort', request.authority.effort,
      '--tools', tools.join(','), ...(readTools ? ['--allowedTools', tools.join(',')] : []),
      '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
      '--json-schema', JSON.stringify(request.schema), '--output-format', 'stream-json', '--verbose']
    let capacityWaits = 0
    let quotaWaits = 0
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const files = await openAttemptFiles(openFile, runtimeDir, stem)
        let final = null
        let modelOutput = false
        let invalidTool = null
        const readIds = new Set()
        const observeLine = line => {
          let event
          try { event = JSON.parse(line) } catch { return }
          if (event.type === 'result') final = event
          if (event.type === 'assistant') modelOutput = true
          const names = event.type === 'init' || event.type === 'system' && event.subtype === 'init' ? [...(event.tools ?? [])] : []
          const inspect = value => {
            if (!value || typeof value !== 'object') return
            if (value.type === 'tool_use') {
              names.push(value.name)
              if (value.name === 'Read') readIds.add(value.id)
            }
            for (const child of Object.values(value)) if (typeof child === 'object') inspect(child)
          }
          inspect(event)
          for (const name of names) if (![...tools, 'StructuredOutput'].includes(name)) invalidTool = name
        }
        const persistLine = line => {
          let event
          try { event = JSON.parse(line) } catch { return line }
          const redact = value => {
            if (!value || typeof value !== 'object') return
            if (value.type === 'tool_result' && readIds.has(value.tool_use_id)) value.content = '[Read file contents omitted]'
            if (value.type === 'tool_result' && value.name === 'Read') value.content = '[Read file contents omitted]'
            for (const child of Object.values(value)) if (typeof child === 'object') redact(child)
          }
          const content = event.message?.content ?? event.content ?? []
          if (Array.isArray(content) && content.some(block => block.type === 'tool_result' && readIds.has(block.tool_use_id)) && event.tool_use_result) {
            event.tool_use_result = '[Read file contents omitted]'
          }
          redact(event)
          return JSON.stringify(event)
        }
        let execution
        try {
          execution = await runAttempt({ spawnImpl, command, args, options: { cwd, env: claudeJudgeEnvironment(env) },
            prompt: request.prompt, files, timeoutMs, killGraceMs, maxStdoutBytes, label: `Claude judge ${request.job}`, observeLine, persistLine })
        } finally { await Promise.all([files.events.close(), files.stderr.close()]) }
        const diagnostic = [final?.errors, !final?.structured_output ? final?.result : null, final?.subtype?.startsWith('error') ? final.subtype : null, execution.stderr, execution.error?.message].flat().filter(Boolean).join('\n')
        const rejected = !modelOutput && (final?.is_error || final?.subtype?.startsWith('error') || execution.status !== 0 || !final?.structured_output && diagnostic.length > 0)
        const failed = Boolean(rejected || final?.is_error || final?.subtype?.startsWith('error') || execution.status !== 0 || execution.error)
        const raw = final?.usage
        const categories = { input_tokens: 'input', cache_read_input_tokens: 'cached_input', cache_creation_input_tokens: 'cache_write', output_tokens: 'output' }
        const tokens = raw ? Object.fromEntries(Object.entries(categories).flatMap(([from, to]) => Number.isFinite(raw[from]) ? [[to, raw[from]]] : []))
          : rejected ? { input: 0, cached_input: 0, cache_write: 0, output: 0 } : null
        const complete = tokens && ['input', 'output'].every(key => Number.isFinite(tokens[key]))
        const input = complete ? tokens.input + (tokens.cached_input ?? 0) + (tokens.cache_write ?? 0) : null
        const entry = { invocation_id: `${files.attemptStem}-${Date.now()}`, phase: request.job ?? null, stage: request.usage_phase ?? null,
          provider: 'anthropic', model: request.authority.model,
          usage: { state: raw || rejected ? 'available' : 'unavailable', source: 'claude:result', reason: rejected ? `Claude turn rejected before any model output: ${diagnostic}` : raw ? null : 'Claude emitted no result usage' },
          tokens, token_totals: complete ? { input, output: tokens.output, total: input + tokens.output } : null }
        memory.push(entry)
        await mkdir(dirname(usagePath), { recursive: true })
        await appendFile(usagePath, `${JSON.stringify(entry)}\n`)
        if (execution.writeError) throw harnessError(`Claude judge could not persist attempt evidence: ${execution.writeError.error.message}`)
        if (execution.outputLimitExceeded) throw harnessError('Claude judge exceeded stdout limit')
        if (failed && /invalid_json_schema|invalid (?:json )?schema|schema.*(?:invalid|reject|validation failed|not supported)/i.test(diagnostic)) throw harnessError(`Claude judge output schema rejected: ${diagnostic}`, { code: 'judge-schema-invalid', retryable: false, resumable: false })
        if (rejected && /at capacity/i.test(diagnostic) && capacityWaits < CAPACITY_RETRIES) {
          await sleep(CAPACITY_BASE_DELAY_MS * 2 ** capacityWaits++)
          attempt--
          continue
        }
        if (failed && /hit your.*limit|usage limit|rate.?limit|quota|\b429\b|organization.*limit/i.test(diagnostic)) {
          const audit = `${now().toISOString()} {"cli":"claude","provider":"anthropic"} ${diagnostic.replace(/\n/g, ' ')}`
          const reset = detectQuotaReset({ audit, now: now() })
          if (quotaWaits < 2 && reset && reset.wait_ms > 0 && reset.wait_ms <= 6 * 60 * 60 * 1000 + 60000 && (await waitForQuotaReset({ audit, now })).waited) { quotaWaits++; attempt--; continue }
          throw harnessError(`Claude judge limit requires resume: ${diagnostic}`, { code: 'claude-quota', resumable: true, retryable: false })
        }
        if (invalidTool) throw harnessError(`Claude judge used forbidden tool: ${invalidTool}`)
        if (execution.timedOut && attempt < 2) continue
        if (execution.timedOut || execution.error || execution.status !== 0 || final?.is_error || !final?.structured_output) throw harnessError(`Claude judge produced no valid final response: ${diagnostic}`)
        return JSON.stringify(final.structured_output)
      }
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
  }
  invoke.readUsageEntries = async () => {
    const ledger = await readFile(usagePath, 'utf8').catch(() => null)
    if (ledger === null) return [...memory]
    return ledger.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return { provider: null, tokens: null, usage: { state: 'unavailable', reason: 'eval-owned usage ledger contains malformed JSON' } } }
    })
  }
  return invoke
}
