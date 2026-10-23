import { readdir, readFile, mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSimulatedUserInputs } from './simulated-user-inputs.mjs'
import { createSimulatedUser, validateReply } from './simulated-user.mjs'
import { appendDurable, atomicJson, optionalText, readConversation, deadlineMs, ElapsedTimeLimit, sleep } from './responder-files.mjs'
export function exchangeIdentity(request) {
  return JSON.stringify([request.step, request.step_id, request.attempt, request.turn])
}
function validateRequest(request) {
  if (request.schema_version !== 1 || !['run_id', 'step', 'step_id', 'cli', 'session_id'].every(key => typeof request[key] === 'string' && request[key]) || !['attempt', 'turn'].every(key => Number.isInteger(request[key]) && request[key] > 0) || typeof request.agent_message !== 'string' || typeof request.empty_turn !== 'boolean') throw new Error('malformed external-user request')
}
// A controller cancels this loop with signal after Runner exits. Deadline expiry
// is reported here; the controller owns terminating a sandbox that is mid-turn.
export async function runResponder({ runDir, exchangeDir, deadline, invoke, inputs, runnerRunId, signal, onExchangeDurable = () => {} }) {
  const until = deadlineMs(deadline)
  const conversationPath = join(runDir, 'conversation.jsonl')
  const statePath = join(runDir, 'responder-state.json')
  let activeStep = null
  let pendingReplyPath
  try {
    await mkdir(runDir, { recursive: true })
    const stateText = await optionalText(statePath)
    const state = stateText ? JSON.parse(stateText) : {}
    if (runnerRunId && state.runner_run_id && runnerRunId !== state.runner_run_id) throw new Error('recorded Runner run_id mismatch')
    runnerRunId ??= state.runner_run_id
    const conversation = await readConversation(conversationPath)
    const recorded = new Map()
    for (const exchange of conversation) {
      validateRequest(exchange)
      validateReply({ text: exchange.text, reply_type: exchange.reply_type })
      runnerRunId ??= exchange.run_id
      if (runnerRunId !== exchange.run_id) throw new Error('conversation Runner run_id mismatch')
      const id = exchangeIdentity(exchange)
      if (recorded.has(id)) throw new Error('duplicate conversation identity')
      recorded.set(id, exchange)
    }
    const knowledge = inputs ?? await loadSimulatedUserInputs()
    invoke ??= createSimulatedUser({ runDir, inputs: knowledge })
    if (runnerRunId) await atomicJson(statePath, { runner_run_id: runnerRunId }, 0o600)
    const processed = new Set()
    while (!signal?.aborted) {
      // The exchange directory exists before Runner starts; no sandbox knowledge.
      for (const name of (await readdir(exchangeDir)).filter(name => name.endsWith('.request.json')).sort()) {
        if (processed.has(name)) continue
        pendingReplyPath = join(exchangeDir, name.replace(/\.request\.json$/, '.reply.json'))
        const path = join(exchangeDir, name)
        if (!(await lstat(path)).isFile()) throw new Error('external-user request must be a regular file')
        const request = JSON.parse(await readFile(path, 'utf8'))
        validateRequest(request)
        activeStep = request.step
        if (runnerRunId && request.run_id !== runnerRunId) throw new Error(`Runner run_id mismatch: expected ${runnerRunId}, received ${request.run_id}`)
        if (!runnerRunId) {
          runnerRunId = request.run_id
          await atomicJson(statePath, { runner_run_id: runnerRunId }, 0o600)
        }
        const identity = exchangeIdentity(request)
        let exchange = recorded.get(identity)
        const existingText = await optionalText(pendingReplyPath)
        if (exchange && exchange.agent_message !== request.agent_message) throw new Error('replayed request message differs from conversation')
        if (existingText) {
          const existing = JSON.parse(existingText)
          if (!exchange || existing.schema_version !== 1 || existing.text !== exchange.text || Object.keys(existing).length !== 2) throw new Error('pre-existing reply differs from durable conversation')
          processed.add(name); pendingReplyPath = undefined; continue
        }
        if (Date.now() >= until) throw new ElapsedTimeLimit()
        if (!exchange) {
          let reply
          if (!conversation.length) reply = { text: knowledge.startingPrompt, reply_type: 'answer', usage: null }
          else {
            const controller = new AbortController()
            let cancel
            const cancelled = new Promise((_, reject) => { cancel = reject })
            const abort = () => { controller.abort(); cancel(new Error('responder stopped')) }
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) abort()
            let timer
            const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ElapsedTimeLimit()) }, Math.max(0, until - Date.now())) })
            try {
              reply = await Promise.race([invoke({ request, conversation: [...conversation], deadline: until, signal: controller.signal }), timeout, cancelled])
            } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
          }
          if (signal?.aborted) return { status: 'stopped', last_active_step: activeStep, runner_run_id: runnerRunId }
          if (Date.now() >= until) throw new ElapsedTimeLimit()
          validateReply({ reply_type: reply.reply_type, text: reply.text })
          exchange = {
            schema_version: 1, run_id: runnerRunId,
            step: request.step, step_id: request.step_id, attempt: request.attempt, turn: request.turn,
            cli: request.cli, session_id: request.session_id, empty_turn: request.empty_turn,
            agent_message: request.agent_message, text: reply.text, reply_type: reply.reply_type,
            simulated_approval: reply.reply_type === 'approval', usage: reply.usage ?? null,
          }
          await appendDurable(conversationPath, exchange)
          conversation.push(exchange); recorded.set(identity, exchange)
          await onExchangeDurable(exchange)
        }
        if (signal?.aborted) return { status: 'stopped', last_active_step: activeStep, runner_run_id: runnerRunId }
        if (Date.now() >= until) throw new ElapsedTimeLimit()
        await atomicJson(pendingReplyPath, { schema_version: 1, text: exchange.text })
        processed.add(name); pendingReplyPath = undefined
      }
      if (Date.now() >= until) throw new ElapsedTimeLimit()
      await sleep(Math.min(250, Math.max(0, until - Date.now())))
    }
    return { status: 'stopped', last_active_step: activeStep, runner_run_id: runnerRunId }
  } catch (error) {
    if (signal?.aborted) return { status: 'stopped', last_active_step: activeStep, runner_run_id: runnerRunId }
    const elapsed = error instanceof ElapsedTimeLimit
    if (pendingReplyPath) {
      try { await atomicJson(pendingReplyPath, { schema_version: 1, action: 'abort', reason: elapsed ? 'elapsed-time limit' : error.message }) }
      catch (publicationError) { return { status: 'evaluation-harness-failed', reason: `${error.message}; abort publication failed: ${publicationError.message}`, last_active_step: activeStep, runner_run_id: runnerRunId } }
    }
    return { status: elapsed ? 'elapsed-time-limit' : 'evaluation-harness-failed', reason: error.message, last_active_step: activeStep, runner_run_id: runnerRunId }
  }
}
