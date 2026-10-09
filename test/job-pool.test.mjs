// INT-007: the shared bounded job pool both suites judge through.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runJobPool, serial } from '../evals/lib/panel-judging/job-pool.mjs'

const wait = ms => new Promise(done => setTimeout(done, ms))

// Canned jobs whose delays make later jobs finish first.
function cannedJobs(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `job-${index}`, delay: (count - index) * 3 }))
}

test('the pool keeps at most `concurrency` jobs in flight and returns results in job order', async () => {
  for (const concurrency of [1, 3]) {
    let inFlight = 0; let peak = 0; const finished = []
    const results = await runJobPool({ jobs: cannedJobs(7), concurrency, run: async job => {
      inFlight++; peak = Math.max(peak, inFlight)
      await wait(job.delay)
      inFlight--; finished.push(job.id)
      return `${job.id} judged`
    } })
    assert.equal(peak, concurrency)
    assert.deepEqual(results, cannedJobs(7).map(job => `${job.id} judged`))
    if (concurrency > 1) assert.notDeepEqual(finished, cannedJobs(7).map(job => job.id), 'completion order must differ from job order')
  }
})

test('checkpoint callbacks run one at a time, both through onCheckpoint and the run\'s own checkpoint', async () => {
  let active = 0; let overlap = 0; const order = []
  const checkpointed = async label => {
    active++; overlap = Math.max(overlap, active)
    await wait(2)
    order.push(label)
    active--
  }
  const results = await runJobPool({ jobs: cannedJobs(6), concurrency: 3,
    run: async (job, index, { checkpoint }) => {
      await checkpoint(() => checkpointed(`start ${index}`))
      await wait(job.delay)
      return index
    },
    onCheckpoint: (result, job, index) => checkpointed(`done ${index}`) })
  assert.equal(overlap, 1)
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5])
  assert.equal(order.filter(x => x.startsWith('done')).length, 6)
})

test('a throwing checkpoint stops new jobs, settles in-flight jobs, then rethrows the first error', async () => {
  const started = []; const settled = []
  let rejectedAt = null
  const run = runJobPool({ jobs: cannedJobs(7), concurrency: 3,
    run: async (job, index) => {
      started.push(index)
      // Job 1 finishes first and its checkpoint throws while 0 and 2 are in flight.
      await wait(index === 1 ? 1 : 20)
      settled.push(index)
      return index
    },
    onCheckpoint: async (result) => {
      if (result === 1) throw new Error('checkpoint disk full')
      if (result === 0) throw new Error('a later checkpoint failure')
    } })
  await assert.rejects(run.finally(() => { rejectedAt = [...settled] }), /checkpoint disk full/)
  assert.deepEqual(started, [0, 1, 2])
  // Both in-flight jobs settled before the error reached the caller.
  assert.deepEqual(rejectedAt.sort(), [0, 1, 2])
})

test('a throwing job is the first error and still lets in-flight jobs settle', async () => {
  const started = []; let inFlight = 0
  await assert.rejects(runJobPool({ jobs: cannedJobs(5), concurrency: 2, run: async (job, index) => {
    started.push(index); inFlight++
    try {
      await wait(index === 0 ? 1 : 15)
      if (index === 0) throw new Error('job 0 failed')
      return index
    } finally { inFlight-- }
  } }), /job 0 failed/)
  assert.equal(inFlight, 0)
  assert.deepEqual(started, [0, 1])
})

test('serial runs callbacks in call order and one failure does not block the next', async () => {
  const checkpoint = serial()
  const seen = []
  const first = checkpoint(async () => { await wait(5); seen.push('first') })
  const failing = checkpoint(async () => { seen.push('failing'); throw new Error('write failed') })
  const third = checkpoint(async () => { seen.push('third'); return 3 })
  await first
  await assert.rejects(failing, /write failed/)
  assert.equal(await third, 3)
  assert.deepEqual(seen, ['first', 'failing', 'third'])
})

test('an empty job list returns no results and an invalid concurrency is refused', async () => {
  assert.deepEqual(await runJobPool({ jobs: [], concurrency: 3, run: async () => assert.fail('no job') }), [])
  await assert.rejects(runJobPool({ jobs: cannedJobs(1), concurrency: 0, run: async () => 1 }), /concurrency/)
})
