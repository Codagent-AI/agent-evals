// One capped Agent Runner invocation: the sandbox, its responder, and the three watchdogs (whole-run active
// time, stall, and the narrow Claude quota recovery). Time is measured only while an invocation runs.
import { ActiveClock, StallDetector } from './watchdogs.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForClaudeQuotaReset } from '../../and-scene/lib/claude-quota.mjs'
export class InvocationError extends Error {
  constructor(message, { kind, step = null, resumable = true, window = null, limit = null } = {}) { super(message); Object.assign(this, { workflow: true, kind, step, resumable, window, limit }) }
}
const sleepReal = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function runInvocation({ sandbox, profiles, mode, until, readOutcome, startResponder, state, limitMs, stallWindowMs, activity, now = () => Date.now(), monitorMs = 1000, signal, quota = waitForClaudeQuotaReset, sleep = sleepReal, persist = async () => {}, onStep = () => {} }) {
  const clock = new ActiveClock({ limitMs, usedMs: state.active_ms ?? 0, now })
  let current = mode
  for (;;) {
    if (clock.exhausted()) throw new InvocationError(`elapsed-time limit reached (${limitMs}ms)`, { kind: 'time-limit', step: state.last_active_step ?? null, resumable: false, limit: limitMs })
    const stall = new StallDetector({ windowMs: stallWindowMs, latestActivityMs: activity, now })
    const abort = new AbortController()
    let stopped = false; let timer; let reason = null
    const stop = async () => { if (!stopped) { stopped = true; await sandbox.stop() } }
    const interrupt = () => { reason ??= 'interrupted'; abort.abort(); void stop() }
    signal?.addEventListener('abort', interrupt, { once: true })
    clock.start()
    let responder
    try {
      if (signal?.aborted) throw new InvocationError('controller interrupted', { kind: 'interrupted', step: state.last_active_step ?? null })
      await sandbox.start(profiles, current)
      responder = startResponder({ signal: abort.signal, deadline: Date.now() + clock.remainingMs() })
      const monitor = new Promise(resolve => {
        timer = setInterval(() => {
          if (clock.exhausted()) resolve({ type: 'deadline' })
          else if (stall.check().stalled) resolve({ type: 'stall' })
        }, monitorMs)
      })
      const finished = await Promise.race([sandbox.wait().then(exit => ({ type: 'exit', exit })), responder.then(response => ({ type: 'responder', response })), monitor])
      if (finished.type === 'deadline') reason ??= 'time-limit'
      if (finished.type === 'stall') reason ??= 'stall'
      if (finished.type === 'responder' && !['stopped'].includes(finished.response.status)) reason ??= finished.response.status === 'elapsed-time-limit' ? 'time-limit' : 'responder'
      if (finished.type !== 'exit') {
        // Give the responder a moment to publish an abort for a pending request before stopping the sandbox.
        if (finished.type === 'deadline') await Promise.race([responder, sleepReal(300)])
        await stop()
      }
      abort.abort()
      const response = await responder
      const exit = await sandbox.wait()
      clock.stop(); state.active_ms = clock.usedMs; await persist()
      const { runnerState, outcome } = await readOutcome()
      const step = response.last_active_step ?? outcome.step ?? state.last_active_step ?? null
      if (step) { state.last_active_step = step; onStep(step) }
      if (reason === 'time-limit') throw new InvocationError(`elapsed-time limit reached (${limitMs}ms)`, { kind: 'time-limit', step, resumable: false, limit: limitMs })
      if (reason === 'stall') throw new InvocationError(`no activity for the ${stallWindowMs}ms stall window`, { kind: 'stall', step, window: stallWindowMs })
      if (response.status === 'evaluation-harness-failed') throw Object.assign(new Error(response.reason), { resumable: false, step, workflow: false, harness: true })
      if (reason === 'interrupted') throw new InvocationError('controller interrupted', { kind: 'interrupted', step })
      if (outcome.kind === 'capped' && exit.code === 0) return { runnerState, outcome, exit, response }
      // A failed invocation may be a Claude usage limit with an explicit near reset: wait it out, outside active time and stall accounting.
      const audit = runnerState?.session_dir ? await readFile(join(runnerState.session_dir, 'audit.log'), 'utf8').catch(() => '') : ''
      const waited = await quota({ audit, now: () => new Date(now()), sleep, log: () => {} })
      if (waited.waited) {
        state.quota_waits = [...(state.quota_waits ?? []), { role: waited.role ?? null, reset_at: waited.reset_at, wait_ms: waited.wait_ms, phase: until }]
        await persist()
        current = { kind: 'resume', runId: runnerState.run_id, until }
        continue
      }
      throw new InvocationError(outcome.reason ?? `Runner exited ${exit.code ?? exit.signal}`, { kind: 'failed', step, resumable: Boolean(runnerState) })
    } finally {
      clearInterval(timer); abort.abort(); signal?.removeEventListener('abort', interrupt); await stop()
      if (responder) await responder.catch(() => {})
      if (clock.startedAt !== null) { clock.stop(); state.active_ms = clock.usedMs }
    }
  }
}
