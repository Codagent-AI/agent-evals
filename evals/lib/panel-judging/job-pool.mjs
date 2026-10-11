// The bounded job pool both suites judge through. Jobs are independent, so up
// to `concurrency` run together. Checkpoint callbacks run one at a time
// because they rewrite one checkpoint file. After any job or checkpoint throws,
// no new job starts; jobs already running settle before the first error is
// rethrown, so no checkpoint is written after the caller sees the failure.
// Results come back in job order, whatever order the jobs finish in.

// One queue of callbacks run strictly in call order. A failed callback rejects
// only its own promise; the next still runs.
export function serial() {
  let queue = Promise.resolve()
  return (callback) => {
    const next = queue.then(callback)
    queue = next.catch(() => {})
    return next
  }
}

// run(job, index, { checkpoint }) judges one job; `checkpoint` is the pool's
// serial queue for checkpoint writes inside the job. onCheckpoint(result, job,
// index), when given, records each finished job through the same queue.
export async function runJobPool({ jobs, concurrency, run, onCheckpoint = null }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('job pool concurrency must be an integer of at least 1')
  const checkpoint = serial()
  const results = new Array(jobs.length)
  let next = 0
  let failure = null
  const worker = async () => {
    while (!failure && next < jobs.length) {
      const index = next++
      try {
        const result = await run(jobs[index], index, { checkpoint })
        if (onCheckpoint) await checkpoint(() => onCheckpoint(result, jobs[index], index))
        results[index] = result
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
  if (failure) throw failure.error
  return results
}
