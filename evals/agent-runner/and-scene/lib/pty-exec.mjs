// Agent Runner under a pseudo-terminal.
//
// A workflow step may require the autonomous-interactive backend
// (`autonomous_backend: interactive`), which Agent Runner refuses unless stdin
// is a terminal. The sandbox has no terminal, so the controller starts and
// resumes Agent Runner through util-linux `script`, which allocates one.
//
// Three properties matter beyond the terminal itself:
// - stdin stays an open pipe that is never written. At end of input `script`
//   may type an end-of-file character into the terminal, which an interactive
//   CLI can read as "exit".
// - an interactive step has no timeout of its own: an agent that ends its turn
//   without signalling completion waits at its prompt forever. A stall timeout
//   and a hard cap end such a run so it can be resumed.
// - the process group is killed as a whole, so the terminal hangs up and Agent
//   Runner's watchdog cleans up the CLI it launched.
// - that group is separate from the controller's, so a stop signal sent to the
//   controller's group (the factory stops a job that way) is passed on to it.
//   Otherwise the controller would exit and leave Agent Runner running.
import { spawn as defaultSpawn, spawnSync } from 'node:child_process'

export const DEFAULT_ROWS = 50
export const DEFAULT_COLUMNS = 200
export const DEFAULT_POLL_MS = 60 * 1000
export const KILL_GRACE_MS = 30 * 1000
export const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP']

// POSIX single-quoting. `script --command` hands one string to a shell, so this
// is the only place a harness-built argument crosses a shell boundary.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function ptyInvocation(command, args = [], { rows = DEFAULT_ROWS, columns = DEFAULT_COLUMNS } = {}) {
  // Without a size the terminal is 0x0, which full-screen CLIs cannot lay out.
  const inner = `stty rows ${Number(rows)} cols ${Number(columns)} 2>/dev/null; exec ${[command, ...args].map(shellQuote).join(' ')}`
  return {
    command: 'script',
    // --return passes the child's exit status through; without it a failed
    // run would look successful.
    args: ['--quiet', '--return', '--flush', '--command', inner, '/dev/null'],
  }
}

// BSD `script` on macOS takes different arguments, and host mode never starts
// Agent Runner, so only util-linux on Linux is supported.
export function ptyAvailable({ exec = spawnSync, platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') {
    return { ok: false, reason: `a pseudo-terminal for Agent Runner needs util-linux script on Linux, not ${platform}` }
  }
  const probe = exec('script', ['--version'], { encoding: 'utf8', env })
  if (probe.error || probe.status !== 0) {
    return { ok: false, reason: 'util-linux script is not installed; Agent Runner cannot be given a pseudo-terminal' }
  }
  if (!/util-linux/.test(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)) {
    return { ok: false, reason: 'the script command on PATH is not util-linux script' }
  }
  return { ok: true, reason: null }
}

// Runs a command under a pseudo-terminal and resolves with a spawnSync-shaped
// result. `stall.lastActivityMs()` reports the newest durable activity the
// caller can observe; terminal output is deliberately not activity, because a
// CLI's animated status line repaints even while nothing progresses.
export function ptyExec(command, args = [], options = {}) {
  const {
    spawn = defaultSpawn,
    now = () => Date.now(),
    setInterval: startTimer = setInterval,
    clearInterval: stopTimer = clearInterval,
    stall = null,
    killGraceMs = KILL_GRACE_MS,
    rows,
    columns,
    stdio = ['pipe', 'ignore', 'ignore'],
    env = process.env,
    host = process,
    ...spawnOptions
  } = options
  const invocation = ptyInvocation(command, args, { rows, columns })
  return new Promise((resolvePromise) => {
    const startedAt = now()
    let settled = false
    let ended = null
    let killTimer = null
    let timer = null
    let received = null
    let child
    try {
      child = spawn(invocation.command, invocation.args, {
        ...spawnOptions,
        env: { ...env, TERM: env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color' },
        stdio: ['pipe', stdio[1] ?? 'ignore', stdio[2] ?? 'ignore'],
        // Its own process group, so the whole tree is signalled together.
        detached: true,
      })
    } catch (error) {
      resolvePromise({ status: null, signal: null, error, stdout: '', stderr: '' })
      return
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) stopTimer(timer)
      if (killTimer) clearTimeout(killTimer)
      for (const signal of FORWARDED_SIGNALS) host.off(signal, onSignal)
      try { child.stdin?.destroy() } catch {}
      resolvePromise({ stdout: '', stderr: '', ...result, ...(received ? { signal: received } : {}), ...(ended ? { ended } : {}) })
      // Agent Runner has stopped; the controller now ends as the signal asked,
      // unless something else in the controller has taken charge of it.
      if (received && host.listenerCount(received) === 0) host.kill(host.pid, received)
    }

    const signalGroup = (signal) => {
      try { process.kill(-child.pid, signal) } catch {
        try { child.kill(signal) } catch {}
      }
    }

    // The kill timers stay referenced: once a run is being ended, they are
    // what guarantees the promise settles.
    const end = (reason) => {
      if (ended) return
      ended = reason
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL')
        // A process that outlives SIGKILL, or a stream that never closes,
        // must not leave the controller waiting forever.
        killTimer = setTimeout(() => {
          const code = ended === 'stalled' ? 'ESTALLED' : 'ETIMEDOUT'
          finish({ status: null, signal: 'SIGKILL', error: Object.assign(new Error(`Agent Runner did not exit after ${ended === 'stalled' ? 'stalling' : 'reaching its time limit'}`), { code }) })
        }, killGraceMs)
      }, killGraceMs)
    }

    // Handling a signal suppresses its default action, so finish() raises it
    // again once Agent Runner has exited.
    function onSignal(signal) {
      if (received) return
      received = signal
      signalGroup(signal)
      if (!killTimer) {
        killTimer = setTimeout(() => {
          signalGroup('SIGKILL')
          killTimer = setTimeout(() => finish({ status: null, signal: 'SIGKILL' }), killGraceMs)
        }, killGraceMs)
      }
    }
    for (const signal of FORWARDED_SIGNALS) host.on(signal, onSignal)

    if (stall && (stall.timeoutMs || stall.maxMs)) {
      timer = startTimer(() => {
        const current = now()
        if (stall.maxMs && current - startedAt >= stall.maxMs) {
          end('timed-out')
          return
        }
        if (stall.timeoutMs) {
          const observed = stall.lastActivityMs?.() ?? null
          const last = Math.max(startedAt, Number.isFinite(observed) ? observed : startedAt)
          if (current - last >= stall.timeoutMs) end('stalled')
        }
      }, stall.pollMs ?? DEFAULT_POLL_MS)
      timer.unref?.()
    }

    // The pipe is held open and never written: no end of input reaches the
    // terminal while the child runs.
    child.stdin?.on?.('error', () => {})
    child.on('error', (error) => finish({ status: null, signal: null, error }))
    child.on('close', (status, signal) => {
      if (ended) {
        const code = ended === 'stalled' ? 'ESTALLED' : 'ETIMEDOUT'
        const error = Object.assign(new Error(`Agent Runner ${ended === 'stalled' ? 'stalled' : 'reached its time limit'}`), { code })
        finish({ status, signal, error })
        return
      }
      finish({ status, signal })
    })
  })
}
