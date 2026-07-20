import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ensureCandidateServer,
  stopCandidateServer,
} from '../evals/agent-runner/and-scene/lib/candidate-server.mjs'

const CANDIDATE = 'candidate-abc'

function recorded(overrides = {}) {
  return { pid: 4242, url: 'http://127.0.0.1:4173/', candidate_identity: CANDIDATE, ...overrides }
}

function starter(server = { pid: 5150, url: 'http://127.0.0.1:4180/' }) {
  const calls = []
  return {
    calls,
    start: async (request) => {
      calls.push(request)
      return server
    },
  }
}

// A probe that answers for exactly one live endpoint; every other URL is
// unreachable, as an unrelated process on a recycled port would be.
function probeFor(url, identity = CANDIDATE) {
  return async (target) => (
    target === url ? { ok: true, candidate_identity: identity } : { ok: false, error: 'connection refused' }
  )
}

test('a verified recorded server is reused rather than restarted', async () => {
  const { start, calls } = starter()

  const result = await ensureCandidateServer({
    recorded: recorded(),
    candidate: CANDIDATE,
    isProcessAlive: () => true,
    probe: probeFor('http://127.0.0.1:4173/'),
    start,
  })

  assert.equal(result.action, 'reused')
  assert.equal(result.server.pid, 4242)
  assert.deepEqual(calls, [])
})

test('an absent recorded server is replaced with a new server for the same candidate', async () => {
  const { start, calls } = starter()

  const result = await ensureCandidateServer({
    recorded: recorded(),
    candidate: CANDIDATE,
    isProcessAlive: (pid) => pid === 5150,
    probe: probeFor('http://127.0.0.1:4180/'),
    start,
  })

  assert.equal(result.action, 'started')
  assert.match(result.reason, /not running/)
  assert.equal(result.server.pid, 5150)
  assert.equal(result.server.candidate_identity, CANDIDATE)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].candidate, CANDIDATE)
})

test('a live but unrelated process on the recorded pid is left untouched', async () => {
  const { start, calls } = starter()
  const stops = []

  const result = await ensureCandidateServer({
    recorded: recorded(),
    candidate: CANDIDATE,
    // The pid was recycled: the process is alive, but nothing answers its URL.
    isProcessAlive: () => true,
    probe: probeFor('http://127.0.0.1:4180/'),
    start,
    stop: async (server) => { stops.push(server) },
  })

  assert.equal(result.action, 'started')
  assert.match(result.reason, /does not serve the evaluated candidate/)
  assert.deepEqual(stops, [], 'an unverified process must never be terminated')
  assert.equal(calls.length, 1)
  // The safe endpoint is chosen by the starter, not by seizing the occupied one.
  assert.notEqual(result.server.url, 'http://127.0.0.1:4173/')
})

test('a server answering for a different candidate is not reused', async () => {
  const { start } = starter()

  const result = await ensureCandidateServer({
    recorded: recorded(),
    candidate: CANDIDATE,
    isProcessAlive: () => true,
    probe: async (target) => (target === 'http://127.0.0.1:4173/'
      ? { ok: true, candidate_identity: 'candidate-other' }
      : { ok: true, candidate_identity: CANDIDATE }),
    start,
  })

  assert.equal(result.action, 'started')
  assert.match(result.reason, /does not serve the evaluated candidate/)
})

test('a new server that cannot be verified is an evaluation-harness failure', async () => {
  const { start } = starter()

  await assert.rejects(
    ensureCandidateServer({
      recorded: null,
      candidate: CANDIDATE,
      isProcessAlive: () => true,
      probe: async () => ({ ok: false, error: 'connection refused' }),
      start,
    }),
    (error) => {
      assert.equal(error.code, 'candidate-server-unavailable')
      assert.match(error.message, /connection refused/)
      return true
    },
  )
})

test('cleanup stops a verified server and records the outcome', async () => {
  const stops = []

  const result = await stopCandidateServer({
    recorded: recorded(),
    isProcessAlive: () => true,
    probe: probeFor('http://127.0.0.1:4173/'),
    stop: async (server) => { stops.push(server.pid) },
  })

  assert.deepEqual(result, { completed: true, action: 'stopped', reason: null, error: null })
  assert.deepEqual(stops, [4242])
})

test('cleanup of an already-stopped server succeeds without killing anything', async () => {
  const stops = []

  const result = await stopCandidateServer({
    recorded: recorded(),
    isProcessAlive: () => false,
    probe: probeFor('http://127.0.0.1:4173/'),
    stop: async (server) => { stops.push(server.pid) },
  })

  assert.equal(result.completed, true)
  assert.equal(result.action, 'already-stopped')
  assert.deepEqual(stops, [])
})

test('cleanup never kills a process it cannot verify as the recorded server', async () => {
  const stops = []

  const result = await stopCandidateServer({
    recorded: recorded(),
    isProcessAlive: () => true,
    probe: probeFor('http://127.0.0.1:4180/'),
    stop: async (server) => { stops.push(server.pid) },
  })

  assert.equal(result.completed, false)
  assert.equal(result.action, 'skipped')
  assert.match(result.reason, /does not serve the evaluated candidate/)
  assert.deepEqual(stops, [])
})

test('a cleanup failure is recorded rather than thrown', async () => {
  const result = await stopCandidateServer({
    recorded: recorded(),
    isProcessAlive: () => true,
    probe: probeFor('http://127.0.0.1:4173/'),
    stop: async () => { throw new Error('permission denied') },
  })

  assert.equal(result.completed, false)
  assert.equal(result.action, 'failed')
  assert.match(result.error, /permission denied/)
})

test('cleanup with no recorded server is a completed no-op', async () => {
  const result = await stopCandidateServer({
    recorded: null,
    isProcessAlive: () => true,
    probe: async () => ({ ok: true, candidate_identity: CANDIDATE }),
    stop: async () => { throw new Error('nothing to stop') },
  })

  assert.equal(result.completed, true)
  assert.equal(result.action, 'already-stopped')
})

test('a probe that throws is treated as an unverified server, not a crash', async () => {
  const { start } = starter()

  const result = await ensureCandidateServer({
    recorded: recorded(),
    candidate: CANDIDATE,
    isProcessAlive: () => true,
    probe: async (target) => {
      if (target === 'http://127.0.0.1:4173/') throw new Error('socket hang up')
      return { ok: true, candidate_identity: CANDIDATE }
    },
    start,
  })

  assert.equal(result.action, 'started')
  assert.match(result.reason, /socket hang up/)
})
