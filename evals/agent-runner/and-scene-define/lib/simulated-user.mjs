import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSimulatedUserInputs } from './simulated-user-inputs.mjs'
import { appendDurable, deadlineMs, ElapsedTimeLimit, sleep as defaultSleep } from './responder-files.mjs'
export const SIMULATED_USER_PROFILE = Object.freeze({ cli: 'claude', model: 'claude-opus-5-5' })
export const MAX_CLI_OUTPUT_BYTES = 10 * 1024 * 1024
const CLAUDE_AUTH_VARIABLES = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY'])
export const REPLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply_type', 'text'],
  properties: { reply_type: { type: 'string', enum: ['answer', 'approval', 'decision', 'decline', 'clarification'] }, text: { type: 'string', minLength: 1 } },
}
export function validateReply(reply) {
  if (!reply || Object.keys(reply).some(key => !['reply_type', 'text'].includes(key)) || !REPLY_SCHEMA.properties.reply_type.enum.includes(reply.reply_type) || typeof reply.text !== 'string' || !reply.text.trim()) throw new Error('malformed simulated-user reply')
  return reply
}
export function formatConversation(conversation = [], request) {
  // JSON framing preserves arbitrary multi-line messages and step boundaries.
  return JSON.stringify({ conversation: conversation.map(({ step, step_id, attempt, turn, agent_message, text, reply_type }) => ({ step, step_id, attempt, turn, agent_message, text, reply_type })), current_agent_turn: request.agent_message })
}
function runClaude(command, args, { cwd, env, signal, deadline, maxOutputBytes }) {
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let finished = false; let timedOut = false
    let bufferedBytes = 0; let outputError; let stopping = false
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let killTimer
    const stop = () => {
      if (stopping || finished) return
      stopping = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, Math.max(0, deadline - Date.now()))
    const abort = () => stop()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) stop()
    const collect = (stream, chunk) => {
      if (outputError) return
      const remaining = maxOutputBytes - bufferedBytes
      const retained = chunk.subarray(0, remaining)
      if (stream === 'stdout') stdout += retained.toString('utf8')
      else stderr += retained.toString('utf8')
      bufferedBytes += retained.length
      if (chunk.length > remaining) {
        outputError = `simulated-user CLI output exceeded ${maxOutputBytes} bytes`
        stop()
      }
    }
    child.stdout.on('data', chunk => collect('stdout', chunk))
    child.stderr.on('data', chunk => collect('stderr', chunk))
    const finish = (code, error) => {
      if (finished) return
      finished = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort)
      resolve({ stdout, stderr, code, error: outputError ?? error, timedOut })
    }
    child.on('error', error => finish(null, error.message))
    child.on('close', code => finish(code))
  })
}
function parseOutput(proc) {
  if (proc.code !== 0 || proc.error) throw new Error(proc.error ?? 'simulated-user CLI failed')
  const events = proc.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const init = events.find(event => event.type === 'system' && event.subtype === 'init')
  if (!Array.isArray(init?.tools) || init.tools.some(tool => tool !== 'StructuredOutput')) throw new Error('simulated-user init tool check failed')
  function checkTools(value) {
    if (!value || typeof value !== 'object') return
    if (value.type === 'tool_use' && value.name !== 'StructuredOutput') throw new Error('simulated-user tool_use check failed')
    Object.values(value).forEach(checkTools)
  }
  events.forEach(checkTools)
  const result = events.findLast(event => event.type === 'result')
  if (proc.code !== 0 || proc.error || !result || result.is_error || result.subtype !== 'success') throw new Error('simulated-user CLI failed')
  const reply = validateReply(result.structured_output)
  return { reply, result }
}
function stderrDiagnostic(stderr, env) {
  let text = stderr
  // Auth diagnostics must not publish the credentials that made the call.
  const secrets = Object.entries(env).filter(([key, value]) => /TOKEN|API_KEY|SECRET|PASSWORD/i.test(key) && typeof value === 'string' && value)
    .map(([, value]) => value).sort((a, b) => b.length - a.length)
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
  return text.replace(/\s+/g, ' ').trim().slice(0, 1024)
}
export function createSimulatedUser({ runDir, command = 'claude', inputs, env = process.env, sleep = defaultSleep, now = Date.now, maxOutputBytes = MAX_CLI_OUTPUT_BYTES } = {}) {
  if (!runDir) throw new Error('simulated user requires runDir for usage evidence')
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('maxOutputBytes must be a positive byte count')
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^CLAUDE/.test(key) || CLAUDE_AUTH_VARIABLES.has(key)))
  return async ({ conversation = [], request, deadline, signal } = {}) => {
    const until = deadlineMs(deadline)
    const knowledge = inputs ?? await loadSimulatedUserInputs()
    let failures = 0; let calls = 0; let lastRejection
    while (failures < 3) {
      if (now() >= until) throw new ElapsedTimeLimit()
      if (signal?.aborted) throw new Error('simulated-user invocation cancelled')
      const scratch = await mkdtemp(join(tmpdir(), 'define-simuser-'))
      const startedAt = new Date().toISOString(); calls++
      let proc
      try {
        const promptPath = join(scratch, 'system-prompt.md')
        await writeFile(promptPath, knowledge.systemPrompt, { flag: 'wx', mode: 0o600 })
        proc = await runClaude(command, [
          '-p', '--model', SIMULATED_USER_PROFILE.model, '--tools', '', '--setting-sources', '',
          '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
          '--system-prompt-file', promptPath, '--json-schema', JSON.stringify(REPLY_SCHEMA),
          '--output-format', 'stream-json', '--verbose', '--', formatConversation(conversation, request),
        ], { cwd: scratch, env: cleanEnv, deadline: until, signal, maxOutputBytes })
      } finally { await rm(scratch, { recursive: true, force: true }) }
      // Classify error responses, never successful answer text that happens to
      // discuss limits or schema errors. Tool violations retain their retry cap.
      const errorEvents = proc.stdout.split('\n').flatMap(line => {
        try {
          const event = JSON.parse(line)
          return event.is_error || event.type === 'error' || event.error ? [event] : []
        } catch { return [] }
      })
      const raw = `${proc.code !== 0 ? proc.stdout : JSON.stringify(errorEvents)}\n${proc.stderr}\n${proc.error ?? ''}`
      const invalidSchema = !proc.error && /invalid_json_schema/i.test(raw)
      const capacity = !proc.error && !invalidSchema && /(?:rate_limit_error|rate limit|rate[-_ ]limited|overloaded(?:_error)?|capacity_error|model.{0,40}capacity|\b429\b|\b529\b)/i.test(raw)
      let parsed; let error
      try { parsed = parseOutput(proc) } catch (e) { error = e }
      const accepted = Boolean(parsed) && !invalidSchema && !capacity && !proc.timedOut && !signal?.aborted
      const diagnostic = stderrDiagnostic(proc.stderr, cleanEnv)
      lastRejection = accepted ? null : invalidSchema ? 'invalid_json_schema' : capacity ? 'capacity' : proc.timedOut ? 'elapsed-time limit' : `${error?.message ?? 'cancelled'}${diagnostic ? `; stderr: ${diagnostic}` : ''}`
      const usage = {
        role: 'simulated-user', cli: SIMULATED_USER_PROFILE.cli, model: SIMULATED_USER_PROFILE.model,
        started_at: startedAt, call: calls, accepted,
        system_prompt_sha256: knowledge.systemPromptSha256, policy_version: knowledge.policyVersion,
        input_tokens: accepted ? (parsed.result.usage?.input_tokens ?? 0) : 0,
        output_tokens: accepted ? (parsed.result.usage?.output_tokens ?? 0) : 0,
        cache_read_input_tokens: accepted ? (parsed.result.usage?.cache_read_input_tokens ?? 0) : 0,
        cache_creation_input_tokens: accepted ? (parsed.result.usage?.cache_creation_input_tokens ?? 0) : 0,
        cost_usd: accepted ? (parsed.result.total_cost_usd ?? null) : 0,
        rejection: lastRejection,
        identity: { step: request.step, step_id: request.step_id, attempt: request.attempt, turn: request.turn },
      }
      await appendDurable(join(runDir, 'phases/eval-owned-usage.jsonl'), usage)
      if (invalidSchema) throw new Error('simulated-user invalid_json_schema (non-retryable harness failure)')
      if (proc.timedOut || now() >= until) throw new ElapsedTimeLimit()
      if (signal?.aborted) throw new Error('simulated-user invocation cancelled')
      if (accepted) return { ...parsed.reply, usage }
      if (capacity) { await sleep(Math.min(1000 * 2 ** Math.min(calls - 1, 5), until - now())); continue }
      failures++
    }
    throw new Error(`simulated-user failed after three attempts: ${lastRejection}`)
  }
}
