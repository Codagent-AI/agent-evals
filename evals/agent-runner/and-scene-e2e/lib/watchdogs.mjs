// Whole-run active time: only time during which an Agent Runner invocation is running counts, summed across
// resumes; downtime between an interruption and its resume never does.
export class ActiveClock {
  constructor({ limitMs, usedMs = 0, now = () => Date.now() }) { Object.assign(this, { limitMs, usedMs, now, startedAt: null, pausedMs: 0 }) }
  remainingMs() { return Math.max(0, this.limitMs - this.elapsedMs()) }
  elapsedMs() { return this.usedMs + (this.startedAt === null ? 0 : this.now() - this.startedAt - this.pausedMs) }
  start() { this.startedAt = this.now(); this.pausedMs = 0 }
  // A quota wait is neither active time nor a stall.
  pause(ms) { this.pausedMs += ms }
  stop() { if (this.startedAt !== null) { this.usedMs = this.elapsedMs(); this.startedAt = null; this.pausedMs = 0 } return this.usedMs }
  exhausted() { return this.remainingMs() <= 0 }
}
// Inactivity watch: the latest activity across run store, CLI transcripts and worktree decides a stall.
export class StallDetector {
  constructor({ windowMs, latestActivityMs, now = () => Date.now(), startedMs = now() }) { Object.assign(this, { windowMs, latestActivityMs, now, startedMs, quietSince: startedMs }) }
  check() {
    const activity = Math.max(this.startedMs, this.latestActivityMs() ?? 0, this.quietSince)
    this.quietSince = activity
    const idle = this.now() - activity
    return { stalled: idle >= this.windowMs, idle_ms: idle }
  }
  // Time spent waiting for a quota reset is not inactivity.
  credit(ms) { this.quietSince += ms }
}
