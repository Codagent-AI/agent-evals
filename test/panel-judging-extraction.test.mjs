import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { buildJudgeRequest, runProductJudging, verifyCachedRobustJob } from '../evals/agent-runner/and-scene/lib/judge-jobs.mjs'
import { capture, inputs, modules, score } from './fixtures/panel-judging/recording.mjs'

const baseline = JSON.parse(await readFile(new URL('./fixtures/panel-judging/baseline.json', import.meta.url), 'utf8'))
const bytes = (value) => JSON.stringify(value)

test('INT-009: recorded robust jobs reproduce identical results, consensus, hashes and scores from cache', async () => {
  assert.equal(baseline.protocol, 'dual-sample-majority-v4')
  for (const record of baseline.records) {
    const request = buildJudgeRequest({ ...inputs, job: record.id })
    const reproduced = verifyCachedRobustJob(record, request)
    assert.equal(bytes(reproduced.results), bytes(record.results), record.id)
    assert.equal(bytes(reproduced.consensus), bytes(record.consensus), record.id)
  }
  // The panel switch intentionally starts a new scoring series. Legacy records
  // remain readable, but are no longer reusable for current product judging.
  const replay = await runProductJudging({ ...inputs,
    loadJob: async ({ id, inputHash }) => {
      const record = baseline.records.find(entry => entry.id === id)
      assert.notEqual(inputHash, record.inputHash)
      return record
    },
    invoke: async request => JSON.stringify({ results: request.criteria.map(id => request.audit_stage
      ? { id, classification: 'confirmed', rationale: 'recorded packet', evidence: ['candidate.txt'] }
      : { id, verdict: 'pass', rationale: 'recorded packet', evidence: ['candidate.txt'], citations: ['candidate.txt'] }) }),
  })
  assert.deepEqual(replay.reused_jobs, [])
  assert.deepEqual(replay.failed_jobs, [])
})

test('panel switch preserves former exports and deterministically replays current records', async () => {
  const recorded = await capture()
  // New shared helper exports may be added; every former export must survive.
  for (const [name, names] of Object.entries(baseline.exports)) {
    for (const key of names) assert.ok(key in modules[name], `${name}.${key}`)
  }
  const repeated = await capture()
  assert.equal(recorded.protocol, 'cross-family-panel-v1')
  assert.equal(bytes(recorded), bytes(repeated))
  assert.deepEqual(recorded.replay.reused_jobs, recorded.outcome.expected_jobs)
})

test('and-scene re-exports the shared panel judging implementations', async () => {
  const shared = {
    jobs: await import('../evals/lib/panel-judging/protocol.mjs'),
    browser: await import('../evals/lib/panel-judging/text.mjs'),
    persistence: await import('../evals/lib/panel-judging/hash.mjs'),
    invoker: await import('../evals/lib/panel-judging/codex-invoker.mjs'),
  }
  for (const [name, module] of Object.entries(shared)) {
    for (const [key, value] of Object.entries(module)) {
      if (name === 'jobs' && ['JUDGING_PROTOCOL', 'JUDGE_SAMPLES'].includes(key)) continue
      assert.equal(modules[name][key], value, `${name}.${key}`)
    }
  }
})
