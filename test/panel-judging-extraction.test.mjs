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
  const replay = await runProductJudging({ ...inputs,
    loadJob: async ({ id, inputHash }) => {
      const record = baseline.records.find((entry) => entry.id === id)
      assert.equal(inputHash, record.inputHash, id)
      return record
    },
    invoke: async () => { assert.fail('a valid recorded job must be reused') },
  })
  assert.deepEqual(replay.reused_jobs, baseline.outcome.expected_jobs)
  assert.equal(bytes(replay), bytes(baseline.replay))
  assert.equal(bytes(score(replay)), bytes(baseline.replay_score))
})

test('INT-009: live stub replay preserves prompts, schemas, records, scores and former exports', async () => {
  const recorded = await capture()
  // New shared helper exports may be added; every former export must survive.
  for (const [name, names] of Object.entries(baseline.exports)) {
    for (const key of names) assert.ok(key in modules[name], `${name}.${key}`)
  }
  assert.equal(bytes({ ...recorded, exports: baseline.exports }), bytes(baseline))
})

test('and-scene re-exports the shared panel judging implementations', async () => {
  const shared = {
    jobs: await import('../evals/lib/panel-judging/protocol.mjs'),
    browser: await import('../evals/lib/panel-judging/text.mjs'),
    persistence: await import('../evals/lib/panel-judging/hash.mjs'),
    invoker: await import('../evals/lib/panel-judging/codex-invoker.mjs'),
  }
  for (const [name, module] of Object.entries(shared)) {
    for (const [key, value] of Object.entries(module)) assert.equal(modules[name][key], value, `${name}.${key}`)
  }
})
