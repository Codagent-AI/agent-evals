import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runTimed, summarizeTimings } from '../evals/agent-runner/and-scene/lib/subprocess.mjs'

test('a successful command reports its output and machine duration', () => {
  const result = runTimed('node', ['-e', 'process.stdout.write("ok")'], { label: 'probe' })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'ok')
  assert.equal(result.label, 'probe')
  assert.equal(typeof result.duration_ms, 'number')
  assert.ok(result.duration_ms >= 0)
  assert.equal(typeof result.started_at, 'string')
})

test('a failing command reports its exit status without throwing', () => {
  const result = runTimed('node', ['-e', 'process.exit(3)'], { label: 'fails' })

  assert.equal(result.status, 3)
  assert.equal(result.ok, false)
})

test('a missing executable is reported rather than thrown', () => {
  const result = runTimed('agent-evals-no-such-binary', [], { label: 'missing' })

  assert.equal(result.ok, false)
  assert.notEqual(result.status, 0)
  assert.ok(result.error)
})

test('command arguments are passed as an array without shell interpretation', () => {
  const result = runTimed('node', ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi); rm -rf /'], {})

  assert.equal(result.stdout, '$(echo hi); rm -rf /')
})

test('an injected executor replaces the real subprocess while keeping timing', () => {
  const calls = []
  const exec = (command, args) => {
    calls.push([command, ...args])
    return { status: 0, stdout: 'stubbed' }
  }

  const result = runTimed('agent-runner', ['run', 'flow.yaml'], { label: 'agent-runner', exec })

  assert.deepEqual(calls, [['agent-runner', 'run', 'flow.yaml']])
  assert.equal(result.stdout, 'stubbed')
  assert.equal(result.ok, true)
  assert.equal(typeof result.duration_ms, 'number')
})

test('timings aggregate into a per-label machine duration breakdown', () => {
  const summary = summarizeTimings([
    { label: 'agent-runner', duration_ms: 1000 },
    { label: 'verification', duration_ms: 250 },
    { label: 'verification', duration_ms: 250 },
  ])

  assert.equal(summary.total_ms, 1500)
  assert.deepEqual(summary.by_label, {
    'agent-runner': { count: 1, duration_ms: 1000 },
    verification: { count: 2, duration_ms: 500 },
  })
})

test('an empty timing list summarizes to zero rather than missing data', () => {
  assert.deepEqual(summarizeTimings([]), { total_ms: 0, by_label: {} })
})
