#!/usr/bin/env node
// The separate literal human-review command.
//
// The automated command stops at `pending-human-review`; this command is what
// turns that into an official score. It is deliberately a *separate* entry
// point, because a human review happens on human time: it can be interrupted,
// resumed hours later, and revised, and none of that may cost the completed
// automated work.
//
// It never recomputes automated evidence. Everything it scores comes from the
// durable phase artifacts the automated run already validated, and the only new
// input is the reviewer's 13 answers.
//
// Paired mode reviews a pending reference baseline first and then the Agent
// Runner candidate, keeping independent candidate, rubric, response, score, and
// completion state for each, so one baseline can anchor the candidate's deltas
// without either review contaminating the other.
import { createInterface } from 'node:readline/promises'
import { basename, join, resolve } from 'node:path'

import { compareToBaseline } from './lib/baseline.mjs'
import { ensureCandidateServer, stopCandidateServer } from './lib/candidate-server.mjs'
import { loadCheckpoint, saveCheckpoint } from './lib/checkpoint.mjs'
import {
  checkReviewProvenance,
  createReviewState,
  runInterview,
} from './lib/human-review.mjs'
import { applyOutcomeEvent, createOutcome, outcomeLabel } from './lib/outcomes.mjs'
import { HUMAN_REVIEW_PHASES, runPhases } from './lib/phases.mjs'
import { hashJson, readJson, writeJsonAtomic } from './lib/persistence.mjs'
import { renderReport } from './lib/report.mjs'
import { assembleResult, writeManifest, writeReport, writeResult } from './lib/result.mjs'
import { loadRubrics, rubricProvenance } from './lib/rubric.mjs'
import { scoreProduct } from './lib/scorer.mjs'

const VALUES = new Map([
  ['--run-dir', 'runDir'],
  ['--baseline-run-dir', 'baselineRunDir'],
])

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = VALUES.get(argv[index])
    if (!key) throw new Error(`unknown human-review option: ${argv[index]}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`missing value for ${argv[index]}`)
    options[key] = value
    index += 1
  }
  if (!options.runDir) throw new Error('--run-dir is required')
  return options
}

// Load everything the review depends on and refuse the run before a single
// question is asked if any of it does not belong together.
async function openRun({ runDir, rubrics }) {
  const runId = basename(runDir)
  const result = await readJson(join(runDir, 'result.json'), null)
  if (!result) {
    return { errors: [{ code: 'missing-result', run_id: runId, message: `${runDir} has no result.json` }] }
  }
  // A paired invocation naturally re-opens a run whose review is already
  // finalized — the baseline, once it is done. That is a completed result, not
  // work to redo, so it is carried forward untouched.
  const finalized = result.evaluation_status === 'complete'
    && (await readJson(join(runDir, 'human-review.json'), null))?.complete === true
  if (finalized) {
    return { errors: [], run: { runId, runDir, mode: result.mode ?? 'agent-runner', result, finalized: true } }
  }
  if (result.evaluation_status !== 'pending-human-review') {
    return {
      errors: [{
        code: 'not-pending-human-review',
        run_id: runId,
        message: `${runId} is ${result.evaluation_status}, not pending-human-review`,
      }],
    }
  }

  const checkpoint = await loadCheckpoint(join(runDir, 'checkpoint.json'))
  const candidate = checkpoint?.identity?.candidate_identity ?? result.candidate_identity ?? null

  // A rubric edited between the automated run and the review would change what
  // the score means, so the review stops here rather than blending them.
  const current = rubricProvenance(rubrics)
  if (hashJson(current) !== (checkpoint?.identity?.rubric_provenance ?? null)) {
    return {
      errors: [{
        code: 'resume-provenance',
        run_id: runId,
        field: 'rubric_provenance',
        message: `${runId} was scored against different rubric bytes than the ones now on disk`,
      }],
    }
  }

  const provenance = {
    candidate: { candidate_identity: candidate, run_id: runId },
    rubric: { rubric_id: rubrics.human.rubric_id, version: rubrics.human.version, sha256: rubrics.human.sha256 },
  }

  const saved = await readJson(join(runDir, 'human-review.json'), null)
  if (saved) {
    const mismatches = checkReviewProvenance(saved, provenance)
    if (mismatches.length > 0) {
      return {
        errors: mismatches.map((mismatch) => ({ code: 'resume-provenance', run_id: runId, ...mismatch })),
      }
    }
  }

  return {
    errors: [],
    run: {
      runId,
      runDir,
      candidate,
      mode: result.mode ?? 'agent-runner',
      result,
      checkpoint,
      provenance,
      // Readiness is re-confirmed on every invocation: a review resumed hours
      // later must look at the candidate again before rating it.
      state: saved ? { ...saved, readiness_confirmed: false } : createReviewState(provenance),
      browser: await readJson(join(runDir, 'phases/browser-evaluation.json'), null),
      judging: await readJson(join(runDir, 'phases/product-judging.json'), null),
    },
  }
}

// Rescore the product from the durable automated artifacts plus the finalized
// human review. Nothing automated is re-executed; only the human component is new.
function rescore({ rubrics, run, humanReview }) {
  return scoreProduct({
    rubrics,
    deterministic: run.browser?.criteria ?? null,
    judges: run.judging?.judges ?? {},
    gates: run.browser?.gates ?? null,
    humanReview: humanReview?.complete
      ? { ratings: humanReview.responses.map(({ rating }) => rating), total: humanReview.score.total }
      : null,
    harness: {
      judge_retries: run.judging?.retries ?? {},
      failed_judge_jobs: run.judging?.failed_jobs ?? [],
      browser_bounds_exceeded: run.browser?.bounds_exceeded ?? [],
    },
    mode: run.mode,
  })
}

function buildResult({ run, outcome, rubrics, score, humanReview, baseline }) {
  const previous = run.result
  return assembleResult({
    runId: run.runId,
    mode: run.mode,
    outcome,
    rubrics: rubricProvenance(rubrics),
    score,
    humanReview,
    browser: run.browser,
    sourceEvidence: previous.source_evidence ?? null,
    judging: run.judging,
    workflow: previous.workflow ?? null,
    metrics: previous.implementation_metrics === 'not-applicable' ? null : previous.implementation_metrics,
    cost: previous.cost === 'not-applicable' ? null : previous.cost,
    pricing: previous.pricing ?? null,
    timing: previous.timing ?? null,
    ambiguity: previous.ambiguity ?? null,
    roleConfiguration: previous.role_configuration === 'not-applicable' ? null : previous.role_configuration,
    timings: previous.timings ?? [],
    baseline,
  })
}

// Review one run end to end through the human-review lifecycle.
async function reviewRun({
  run,
  rubrics,
  io,
  candidateServer,
  isProcessAlive,
  baselineResult,
  renderReportImpl,
  log,
}) {
  const reviewPath = join(run.runDir, 'human-review.json')
  const checkpointPath = join(run.runDir, 'checkpoint.json')
  let state = run.state
  let score = null
  let humanReview = null
  let server = run.checkpoint?.candidate_server ?? null
  let assembled = null

  // Start from the outcome the automated run durably recorded, so this command
  // extends that history rather than inventing a fresh one.
  let baseOutcome = applyOutcomeEvent(createOutcome(), {
    type: 'automated-scoring-complete',
    automated_subtotal: run.result.automated_subtotal?.points ?? null,
  })

  const handlers = {
    'candidate-server': async (context) => {
      const outcome = await ensureCandidateServer({
        recorded: server,
        candidate: run.candidate,
        isProcessAlive,
        probe: candidateServer.probe,
        start: candidateServer.start,
      })
      server = outcome.server
      if (outcome.action === 'started') {
        log(`candidate-server: started for ${run.runId} (${outcome.reason})`)
        await saveCheckpoint(checkpointPath, { ...run.checkpoint, candidate_server: server })
      }
      context.serverRunning = true
    },

    'human-review': async () => {
      if (state.complete) {
        // A finalized review is a finished result. Resume never re-asks it.
        humanReview = state
        score = rescore({ rubrics, run, humanReview })
        return
      }
      io.write(`\n=== Human review: ${run.runId} (${run.mode}) ===`)
      const interview = await runInterview({
        rubric: rubrics.human.rubric,
        state,
        candidateUrl: server.url,
        io,
        persist: async (next) => { await writeJsonAtomic(reviewPath, next) },
      })
      state = interview.state
      if (!interview.confirmed) {
        await writeJsonAtomic(reviewPath, state)
        return
      }
      humanReview = interview.state
      score = rescore({ rubrics, run, humanReview })
    },

    'official-result': async (context) => {
      if (!humanReview?.complete) {
        // Unconfirmed: the run stays exactly as the automated command left it.
        return
      }
      const event = {
        type: 'product-verdict',
        verdict: score.official_pass ? 'pass' : 'fail',
        official_score: score.official_score,
      }
      const outcome = applyOutcomeEvent(context.outcome, event)
      assembled = buildResult({
        run,
        outcome,
        rubrics,
        score,
        humanReview,
        baseline: baselineResult ? compareToBaseline({
          candidate: { ...run.result, official_score: score.official_score, score, rubrics: rubricProvenance(rubrics) },
          baseline: baselineResult,
        }) : null,
      })
      await writeResult({ runDir: run.runDir, result: assembled })
      // The lifecycle owns the outcome; the phase only reports the fact it
      // established.
      return [event]
    },

    'final-report': async () => {
      if (!assembled) return
      await writeReport({ runDir: run.runDir, result: assembled, renderReportImpl })
    },

    cleanup: async (context) => {
      const outcome = await stopCandidateServer({
        recorded: server,
        isProcessAlive,
        probe: candidateServer.probe,
        stop: candidateServer.stop,
      })
      context.serverRunning = false
      if (!outcome.completed) {
        throw new Error(`candidate-server cleanup did not complete: ${outcome.error ?? outcome.reason}`)
      }
    },

    // Rewrite all three artifacts from the outcome as it now stands, so a
    // failure recorded after the result was first written — a cleanup that could
    // not finish, for instance — reaches result.json and report.html too.
    'final-artifacts': async (context) => {
      if (!assembled) {
        await writeManifest({ runDir: run.runDir, runId: run.runId })
        return
      }
      const refreshed = {
        ...assembled,
        evaluation_status: context.outcome.evaluation_status,
        product_verdict: context.outcome.product_verdict,
        label: outcomeLabel(context.outcome),
        failed_phase: context.outcome.failed_phase,
        failure: context.outcome.failure,
        cleanup: context.outcome.cleanup,
        history: context.outcome.history,
      }
      await writeResult({ runDir: run.runDir, result: refreshed })
      await writeReport({ runDir: run.runDir, result: refreshed, renderReportImpl })
      await writeManifest({ runDir: run.runDir, runId: run.runId })
      assembled = refreshed
    },

    // Owned by the publication task; registered so the lifecycle stays honest
    // about where it belongs.
    publication: async () => {},
  }

  const lifecycle = await runPhases({
    phases: HUMAN_REVIEW_PHASES,
    handlers,
    outcome: baseOutcome,
  })

  // A phase that failed before the result was ever written still has to leave a
  // durable account of the run behind.
  if (!assembled) {
    const fallback = buildResult({
      run,
      outcome: lifecycle.outcome,
      rubrics,
      score: score ?? run.result.score,
      humanReview: state.complete ? state : (state.responses.length > 0 ? state : null),
      baseline: null,
    })
    await writeResult({ runDir: run.runDir, result: fallback })
    try {
      await writeReport({ runDir: run.runDir, result: fallback, renderReportImpl })
    } catch {
      // The result is already durable; a second report failure adds nothing.
    }
    await writeManifest({ runDir: run.runDir, runId: run.runId })
  }

  return {
    runId: run.runId,
    runDir: run.runDir,
    mode: run.mode,
    confirmed: Boolean(humanReview?.complete),
    outcome: lifecycle.outcome,
    failed: lifecycle.failed,
    result: assembled,
  }
}

export async function runHumanReview({
  argv,
  io,
  candidateServer,
  isProcessAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
  renderReportImpl = renderReport,
  onRunStart = () => {},
  log = () => {},
}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    return { exitCode: 2, errors: [{ code: 'invalid-arguments', message: error.message }], runs: [] }
  }

  let rubrics
  try {
    rubrics = await loadRubrics()
  } catch (error) {
    return { exitCode: 2, errors: [{ code: 'invalid-rubric', message: error.message }], runs: [] }
  }

  // The baseline is reviewed first so the candidate's comparison has something
  // to anchor to in the same invocation.
  const directories = [
    ...(options.baselineRunDir ? [resolve(options.baselineRunDir)] : []),
    resolve(options.runDir),
  ]

  const opened = []
  for (const runDir of directories) {
    const { errors, run } = await openRun({ runDir, rubrics })
    if (errors.length > 0) return { exitCode: 1, errors, runs: [] }
    opened.push(run)
  }

  const runs = []
  let baselineResult = null
  for (const run of opened) {
    if (run.finalized) {
      runs.push({ runId: run.runId, runDir: run.runDir, mode: run.mode, confirmed: true, result: run.result })
      if (run.mode === 'reference-baseline') baselineResult = run.result
      continue
    }
    onRunStart(run)
    const reviewed = await reviewRun({
      run, rubrics, io, candidateServer, isProcessAlive, baselineResult, renderReportImpl, log,
    })
    runs.push(reviewed)
    if (run.mode === 'reference-baseline' && reviewed.result) baselineResult = reviewed.result
    if (reviewed.failed) return { exitCode: 1, errors: [], runs }
  }

  return { exitCode: 0, errors: [], runs }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const result = await runHumanReview({
    argv: process.argv.slice(2),
    io: {
      write: (line) => console.log(line),
      // A closed stdin ends the review where it stands with every saved answer
      // intact, rather than looping on an input that will never arrive.
      ask: async (prompt) => {
        const answer = await rl.question(prompt)
        return answer === undefined ? null : answer
      },
    },
    candidateServer: {
      probe: async () => ({ ok: false, error: 'no candidate-server adapter is configured' }),
      start: async () => { throw new Error('no candidate-server adapter is configured') },
      stop: async () => {},
    },
    log: (line) => console.error(line),
  })
  rl.close()
  for (const error of result.errors ?? []) console.error(JSON.stringify(error))
  process.exit(result.exitCode)
}
