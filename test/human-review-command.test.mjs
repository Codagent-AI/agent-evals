import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runHumanReview } from '../evals/agent-runner/and-scene/human-review.mjs'
import { assembleResult } from '../evals/agent-runner/and-scene/lib/result.mjs'
import { createCheckpoint, saveCheckpoint } from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'
import { createOutcome, applyOutcomeEvent } from '../evals/agent-runner/and-scene/lib/outcomes.mjs'
import { hashJson, readJson, writeJsonAtomic } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { loadRubrics, rubricCriteria, rubricProvenance } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { scoreProduct } from '../evals/agent-runner/and-scene/lib/scorer.mjs'

const rubrics = await loadRubrics()
const humanRubric = rubrics.human.rubric

// A fully observed automated evaluation, generated from the rubric itself so
// the fixture cannot drift away from the criterion set the scorer requires.
function automatedEvidence(verdict = 'pass') {
  const rows = rubricCriteria(rubrics.automated.rubric)
  const result = (id) => ({ id, verdict, rationale: 'fixture evidence', evidence: ['fixture'] })
  return {
    criteria: rows.filter((row) => row.evaluator === 'deterministic-browser').map(({ id }) => result(id)),
    judges: Object.fromEntries(
      [...new Set(rows.filter(({ job }) => job).map(({ job }) => job))].map((job) => [
        job, rows.filter((row) => row.job === job).map(({ id }) => result(id)),
      ]),
    ),
    gates: rubrics.automated.rubric.gates.map(({ id }) => result(id)),
  }
}

async function pendingRun({
  root,
  name = 'run-1',
  mode = 'agent-runner',
  candidate = 'candidate-abc',
  server = { pid: 4242, url: 'http://127.0.0.1:4173/' },
  humanRubricProvenance = null,
} = {}) {
  const runDir = join(root, name)
  await mkdir(join(runDir, 'phases'), { recursive: true })

  const evidence = automatedEvidence()
  await writeJsonAtomic(join(runDir, 'phases/browser-evaluation.json'), {
    criteria: evidence.criteria, gates: evidence.gates, bounds_exceeded: [],
  })
  await writeJsonAtomic(join(runDir, 'phases/product-judging.json'), {
    judges: evidence.judges, retries: {}, failed_jobs: [],
  })

  const score = scoreProduct({
    rubrics,
    deterministic: evidence.criteria,
    judges: evidence.judges,
    gates: evidence.gates,
    humanReview: null,
    mode,
  })
  await writeJsonAtomic(join(runDir, 'phases/score.json'), score)

  const provenance = humanRubricProvenance
    ? { ...rubricProvenance(rubrics), human: humanRubricProvenance }
    : rubricProvenance(rubrics)

  await saveCheckpoint(join(runDir, 'checkpoint.json'), {
    ...createCheckpoint({
      run_id: name,
      identity: { candidate_identity: candidate, rubric_provenance: hashJson(provenance) },
    }),
    candidate_server: server,
    phases: {},
  })

  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'automated-scoring-complete',
    automated_subtotal: score.automated_subtotal.points,
  })
  await writeJsonAtomic(join(runDir, 'result.json'), assembleResult({
    runId: name, mode, outcome, rubrics: provenance, score,
  }))

  return { runDir, name, candidate, score }
}

function scriptedIo(inputs) {
  const written = []
  const asked = []
  const remaining = [...inputs]
  return {
    written,
    asked,
    io: {
      write: (line) => { written.push(line) },
      // A closed input stream, exactly as a reviewer walking away produces.
      ask: (prompt) => {
        asked.push(prompt)
        return remaining.length === 0 ? null : remaining.shift()
      },
    },
  }
}

function answers({ rating = 5, tail = ['confirm'] } = {}) {
  return ['yes', ...Array(13).fill(0).flatMap(() => [String(rating), rating <= 3 ? 'noted' : '']), ...tail]
}

function servers({
  live = new Set([4242]),
  identity = 'candidate-abc',
  urls = ['http://127.0.0.1:4173/'],
  serves = true,
} = {}) {
  const stopped = []
  const started = []
  return {
    stopped,
    started,
    isProcessAlive: (pid) => live.has(pid),
    candidateServer: {
      probe: async (url) => (urls.includes(url)
        ? { ok: true, candidate_identity: identity }
        : { ok: false, error: 'connection refused' }),
      start: async (request) => {
        started.push(request)
        const server = { pid: 5150, url: 'http://127.0.0.1:4180/' }
        live.add(server.pid)
        if (serves) urls.push(server.url)
        return server
      },
      stop: async (server) => { stopped.push(server.pid); live.delete(server.pid) },
    },
  }
}

async function root() {
  return mkdtemp(join(tmpdir(), 'agent-evals-human-review-'))
}

test('a pending run is opened with its evaluated candidate served and its URL printed', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })
  const { io, written } = scriptedIo(answers())
  const infra = servers()

  const result = await runHumanReview({ argv: ['--run-dir', run.runDir], io, ...infra })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const transcript = written.join('\n')
  assert.ok(transcript.includes('http://127.0.0.1:4173/'), transcript)
  assert.ok(
    transcript.indexOf('http://127.0.0.1:4173/') < transcript.indexOf(humanRubric.questions[0].text),
    'the URL and readiness confirmation come before question 1',
  )
  assert.deepEqual(infra.started, [], 'a verified recorded server is reused')
})

test('a confirmed review finalizes the official score without rerunning automated scoring', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })
  const before = await readJson(join(run.runDir, 'phases/product-judging.json'))
  const { io } = scriptedIo(answers())

  const outcome = await runHumanReview({ argv: ['--run-dir', run.runDir], io, ...servers() })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  const result = await readJson(join(run.runDir, 'result.json'))
  assert.equal(result.evaluation_status, 'complete')
  assert.ok(['pass', 'fail'].includes(result.product_verdict))
  assert.equal(result.official_score, run.score.automated_subtotal.points + 30)
  assert.equal(result.human_review.score.total, 30)
  assert.deepEqual(await readJson(join(run.runDir, 'phases/product-judging.json')), before)
  assert.match(await readFile(join(run.runDir, 'report.html'), 'utf8'), /PASS|FAIL/)
  const manifest = await readJson(join(run.runDir, 'artifact-manifest.json'))
  assert.ok(manifest.artifacts.some(({ path }) => path === 'report.html'))
  assert.ok(manifest.artifacts.some(({ path }) => path === 'human-review.json'))
})

test('an unavailable candidate server collects no ratings and fails as a harness failure', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })
  const { io, asked } = scriptedIo(answers())
  // Nothing is alive and nothing a new server could bind would answer.
  const infra = servers({ live: new Set(), urls: [], serves: false })

  const outcome = await runHumanReview({ argv: ['--run-dir', run.runDir], io, ...infra })

  assert.equal(outcome.exitCode, 1)
  assert.deepEqual(asked, [], 'no human-review question is asked')
  const result = await readJson(join(run.runDir, 'result.json'))
  assert.equal(result.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.product_verdict, 'unavailable')
  assert.equal(result.official_score, null)
  assert.equal(result.failed_phase, 'candidate-server')
})

test('an unconfirmed review leaves the run pending with no official score', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })
  const { io } = scriptedIo(answers({ tail: ['quit'] }))

  const outcome = await runHumanReview({ argv: ['--run-dir', run.runDir], io, ...servers() })

  assert.equal(outcome.exitCode, 0)
  const result = await readJson(join(run.runDir, 'result.json'))
  assert.equal(result.evaluation_status, 'pending-human-review')
  assert.equal(result.official_score, null)
  const review = await readJson(join(run.runDir, 'human-review.json'))
  assert.equal(review.complete, false)
  assert.equal(review.responses.length, 13, 'valid answers are preserved')
})

test('an interrupted review still attempts candidate-server cleanup', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })
  const { io } = scriptedIo(answers({ tail: ['quit'] }))
  const infra = servers()

  await runHumanReview({ argv: ['--run-dir', run.runDir], io, ...infra })

  assert.deepEqual(infra.stopped, [4242])
})

test('a review resumes at the first unanswered question after an interruption', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })

  const first = scriptedIo(['yes', ...Array(4).fill(0).flatMap(() => ['5', ''])])
  await runHumanReview({ argv: ['--run-dir', run.runDir], io: first.io, ...servers() })
  assert.equal((await readJson(join(run.runDir, 'human-review.json'))).responses.length, 4)

  const second = scriptedIo(['yes', ...Array(9).fill(0).flatMap(() => ['4', '']), 'confirm'])
  const outcome = await runHumanReview({ argv: ['--run-dir', run.runDir], io: second.io, ...servers() })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  const review = await readJson(join(run.runDir, 'human-review.json'))
  assert.equal(review.responses.length, 13)
  assert.deepEqual(review.responses.slice(0, 4).map(({ rating }) => rating), [5, 5, 5, 5])
  assert.deepEqual(review.responses.slice(4).map(({ rating }) => rating), Array(9).fill(4))
})

test('a saved review naming a different candidate is refused with a resume-provenance error', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })

  const first = scriptedIo(['yes', '5', ''])
  await runHumanReview({ argv: ['--run-dir', run.runDir], io: first.io, ...servers() })

  const review = await readJson(join(run.runDir, 'human-review.json'))
  await writeJsonAtomic(join(run.runDir, 'human-review.json'), {
    ...review,
    candidate: { ...review.candidate, candidate_identity: 'candidate-other' },
  })

  const second = scriptedIo(answers())
  const outcome = await runHumanReview({ argv: ['--run-dir', run.runDir], io: second.io, ...servers() })

  assert.equal(outcome.exitCode, 1)
  assert.ok(outcome.errors.some(({ code }) => code === 'resume-provenance'), JSON.stringify(outcome.errors))
  assert.deepEqual(second.asked, [], 'the saved responses are not reused and no question is asked')
})

test('a saved review naming a different human rubric is refused', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })

  const first = scriptedIo(['yes', '5', ''])
  await runHumanReview({ argv: ['--run-dir', run.runDir], io: first.io, ...servers() })

  const review = await readJson(join(run.runDir, 'human-review.json'))
  await writeJsonAtomic(join(run.runDir, 'human-review.json'), {
    ...review, rubric: { ...review.rubric, sha256: 'f'.repeat(64) },
  })

  const outcome = await runHumanReview({ argv: ['--run-dir', run.runDir], io: scriptedIo(answers()).io, ...servers() })

  assert.equal(outcome.exitCode, 1)
  assert.ok(outcome.errors.some(({ field }) => field === 'rubric_sha256'), JSON.stringify(outcome.errors))
})

// --- Paired reference-baseline and candidate review ------------------------

test('a paired review completes the baseline questions before the candidate questions', async () => {
  const directory = await root()
  const baseline = await pendingRun({
    root: directory, name: 'baseline-1', mode: 'reference-baseline', candidate: 'reference-xyz',
  })
  const candidate = await pendingRun({ root: directory, name: 'run-1' })

  const { io, written } = scriptedIo([...answers({ rating: 5 }), ...answers({ rating: 4 })])
  const infra = servers({ live: new Set([4242]), identity: 'reference-xyz' })
  // The two runs are served in turn; each probe answers for the run being served.
  let serving = 'reference-xyz'
  // Whichever endpoint is up serves the run currently being reviewed.
  infra.candidateServer.probe = async () => ({ ok: true, candidate_identity: serving })
  const outcome = await runHumanReview({
    argv: ['--run-dir', candidate.runDir, '--baseline-run-dir', baseline.runDir],
    io,
    ...infra,
    onRunStart: (run) => { serving = run.candidate },
  })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  assert.deepEqual(outcome.runs.map(({ runId }) => runId), ['baseline-1', 'run-1'])

  const transcript = written.join('\n')
  assert.ok(transcript.indexOf('baseline-1') < transcript.indexOf('run-1'))

  const baselineReview = await readJson(join(baseline.runDir, 'human-review.json'))
  const candidateReview = await readJson(join(candidate.runDir, 'human-review.json'))
  assert.equal(baselineReview.score.total, 30)
  assert.equal(candidateReview.score.total, 22.5)
  assert.equal(baselineReview.candidate.candidate_identity, 'reference-xyz')
  assert.equal(candidateReview.candidate.candidate_identity, 'candidate-abc')
})

test('a paired review resumes the first run with an unanswered question', async () => {
  const directory = await root()
  const baseline = await pendingRun({
    root: directory, name: 'baseline-1', mode: 'reference-baseline', candidate: 'reference-xyz',
  })
  const candidate = await pendingRun({ root: directory, name: 'run-1' })

  let serving = 'reference-xyz'
  const infra = servers()
  // Whichever endpoint is up serves the run currently being reviewed.
  infra.candidateServer.probe = async () => ({ ok: true, candidate_identity: serving })
  const argv = ['--run-dir', candidate.runDir, '--baseline-run-dir', baseline.runDir]
  const onRunStart = (run) => { serving = run.candidate }

  // Finish the baseline, then stop three questions into the candidate.
  const first = scriptedIo([...answers({ rating: 5 }), 'yes', ...Array(3).fill(0).flatMap(() => ['4', ''])])
  await runHumanReview({ argv, io: first.io, ...infra, onRunStart })

  const second = scriptedIo(['yes', ...Array(10).fill(0).flatMap(() => ['4', '']), 'confirm'])
  const outcome = await runHumanReview({ argv, io: second.io, ...infra, onRunStart })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  // The finalized baseline is never re-asked; the second invocation resumes the
  // candidate at question 4.
  assert.ok(!second.written.join('\n').includes('Question 1 of'), 'no finalized answer is repeated')
  const candidateReview = await readJson(join(candidate.runDir, 'human-review.json'))
  assert.equal(candidateReview.complete, true)
  assert.equal(candidateReview.responses.length, 13)
})

test('a candidate reviewed against a completed baseline records the comparison', async () => {
  const directory = await root()
  const baseline = await pendingRun({
    root: directory, name: 'baseline-1', mode: 'reference-baseline', candidate: 'reference-xyz',
  })
  const candidate = await pendingRun({ root: directory, name: 'run-1' })

  let serving = 'reference-xyz'
  const infra = servers()
  // Whichever endpoint is up serves the run currently being reviewed.
  infra.candidateServer.probe = async () => ({ ok: true, candidate_identity: serving })

  await runHumanReview({
    argv: ['--run-dir', candidate.runDir, '--baseline-run-dir', baseline.runDir],
    io: scriptedIo([...answers({ rating: 5 }), ...answers({ rating: 3 })]).io,
    ...infra,
    onRunStart: (run) => { serving = run.candidate },
  })

  const result = await readJson(join(candidate.runDir, 'result.json'))
  assert.equal(result.baseline.comparable, true)
  assert.equal(result.baseline.baseline_run_id, 'baseline-1')
  assert.equal(result.baseline.totals.delta, -15)
  assert.equal(result.baseline.implementation_cost.baseline, null)
  assert.match(await readFile(join(candidate.runDir, 'report.html'), 'utf8'), /Reference baseline comparison/)

  const baselineResult = await readJson(join(baseline.runDir, 'result.json'))
  assert.equal(baselineResult.role_configuration, 'not-applicable')
  assert.equal(baselineResult.cost, 'not-applicable')
  assert.equal(baselineResult.implementation_timing, 'not-applicable')
})

test('a cleanup failure after a durable verdict preserves the verdict and reports both', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })
  const infra = servers()
  infra.candidateServer.stop = async () => { throw new Error('permission denied') }

  const outcome = await runHumanReview({
    argv: ['--run-dir', run.runDir], io: scriptedIo(answers()).io, ...infra,
  })

  assert.equal(outcome.exitCode, 1)
  const result = await readJson(join(run.runDir, 'result.json'))
  assert.equal(result.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.product_verdict, 'pass')
  assert.equal(result.official_score, run.score.automated_subtotal.points + 30)
  assert.match(result.label, /PASS — HARNESS FAILURE/)
  const report = await readFile(join(run.runDir, 'report.html'), 'utf8')
  assert.match(report, /PASS — HARNESS FAILURE/)
  assert.match(report, /permission denied/)
})

test('a report that cannot be rendered records the missing report without erasing the verdict', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })

  const outcome = await runHumanReview({
    argv: ['--run-dir', run.runDir],
    io: scriptedIo(answers()).io,
    ...servers(),
    renderReportImpl: () => { throw new Error('template exploded') },
  })

  assert.equal(outcome.exitCode, 1)
  const result = await readJson(join(run.runDir, 'result.json'))
  assert.equal(result.product_verdict, 'pass')
  assert.equal(result.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.report.written, false)
  assert.match(result.report.error, /template exploded/)
})

test('a run that is not pending human review is refused', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })
  const result = await readJson(join(run.runDir, 'result.json'))
  await writeJsonAtomic(join(run.runDir, 'result.json'), {
    ...result, evaluation_status: 'implementation-workflow-failed',
  })

  const outcome = await runHumanReview({
    argv: ['--run-dir', run.runDir], io: scriptedIo(answers()).io, ...servers(),
  })

  assert.equal(outcome.exitCode, 1)
  assert.ok(outcome.errors.some(({ code }) => code === 'not-pending-human-review'))
})

test('a human rubric edited since the automated run is refused before any question', async () => {
  const directory = await root()
  const run = await pendingRun({
    root: directory,
    humanRubricProvenance: { rubric_id: 'and-scene-human-review', version: '0.9.0', sha256: 'e'.repeat(64) },
  })
  const { io, asked } = scriptedIo(answers())

  const outcome = await runHumanReview({ argv: ['--run-dir', run.runDir], io, ...servers() })

  assert.equal(outcome.exitCode, 1)
  assert.ok(outcome.errors.some(({ code }) => code === 'resume-provenance'), JSON.stringify(outcome.errors))
  assert.deepEqual(asked, [])
})

test('a corrupted saved review is refused before any question is asked', async () => {
  const directory = await root()
  const run = await pendingRun({ root: directory })

  const first = scriptedIo(['yes', '5', '', '4', ''])
  await runHumanReview({ argv: ['--run-dir', run.runDir], io: first.io, ...servers() })

  // An out-of-range rating can only arrive by editing the artifact, and it must
  // never reach the point arithmetic.
  const review = await readJson(join(run.runDir, 'human-review.json'))
  review.responses[0].rating = 999
  await writeJsonAtomic(join(run.runDir, 'human-review.json'), review)

  const second = scriptedIo(answers())
  const outcome = await runHumanReview({ argv: ['--run-dir', run.runDir], io: second.io, ...servers() })

  assert.equal(outcome.exitCode, 1)
  assert.ok(outcome.errors.some(({ code }) => code === 'invalid-saved-review'), JSON.stringify(outcome.errors))
  assert.deepEqual(second.asked, [])
  const untouched = await readJson(join(run.runDir, 'result.json'))
  assert.equal(untouched.evaluation_status, 'pending-human-review')
  assert.equal(untouched.official_score, null)
})

test('a paired review serves each run from its own run directory', async () => {
  const directory = await root()
  const baseline = await pendingRun({
    root: directory, name: 'baseline-1', mode: 'reference-baseline', candidate: 'reference-xyz',
  })
  const candidate = await pendingRun({ root: directory, name: 'run-1' })

  const built = []
  // An adapter per run: each serves the frozen build inside its own directory.
  const factory = (run) => ({
    probe: async (url) => (url === `http://127.0.0.1/${run.runId}/`
      ? { ok: true, candidate_identity: run.candidate }
      : { ok: false, error: 'connection refused' }),
    start: async ({ candidate: identity }) => {
      built.push([run.runDir, identity])
      return { pid: 6000 + built.length, url: `http://127.0.0.1/${run.runId}/` }
    },
    stop: async () => {},
  })

  const outcome = await runHumanReview({
    argv: ['--run-dir', candidate.runDir, '--baseline-run-dir', baseline.runDir],
    io: scriptedIo([...answers({ rating: 5 }), ...answers({ rating: 4 })]).io,
    isProcessAlive: () => true,
    candidateServer: factory,
  })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  assert.deepEqual(built, [
    [baseline.runDir, 'reference-xyz'],
    [candidate.runDir, 'candidate-abc'],
  ])
})
