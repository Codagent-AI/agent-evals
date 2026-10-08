#!/usr/bin/env node
// Thin command wrapper over the suite-owned scorer.
//
// The controller scores in-process; this entry point exists so a finalized run
// can be rescored from its durable phase artifacts — for example when a human
// review is supplied later, or when a published result is re-verified.
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { readJson } from './lib/persistence.mjs'
import { productJudgeJobs } from './lib/judge-jobs.mjs'
import { deterministicCriteria, loadRubrics } from './lib/rubric.mjs'
import { scoreProduct } from './lib/scorer.mjs'

function valueAfter(args, option, required = true) {
  const index = args.indexOf(option)
  if (index === -1 || !args[index + 1]) {
    if (!required) return undefined
    throw new Error(`missing ${option}`)
  }
  return args[index + 1]
}

async function optionalJson(args, option) {
  const path = valueAfter(args, option, false)
  return path ? readJson(path) : null
}

async function main(args) {
  const browser = await optionalJson(args, '--browser-evaluation')
  const judging = await optionalJson(args, '--judging')
  const humanReview = await optionalJson(args, '--human-review')

  const rubrics = await loadRubrics()
  const mode = valueAfter(args, '--mode', false) ?? 'agent-runner'
  const requiredJobs = productJudgeJobs(rubrics, { mode }).map(({ id }) => id)
  const failed = new Set(judging?.failed_jobs ?? [])
  const judges = judging?.judges ?? {}
  // In a recorded judging phase, a job that is neither recorded nor failed was
  // never asked: the run was judged under an older automated rubric without it.
  const recordedJudging = Object.keys(judges).length > 0
  const unjudged = recordedJudging
    ? requiredJobs.filter((job) => !failed.has(job) && !Object.hasOwn(judges, job))
    : []
  const missing = requiredJobs.filter((job) => (
    !unjudged.includes(job) && (failed.has(job) || !Array.isArray(judges[job]))
  ))
  if (missing.length > 0) {
    throw new Error(`required judge jobs failed: ${missing.join(', ')}`)
  }
  const version = rubrics.automated.version
  const rejudge = 'it was judged under an older rubric and must be re-judged with --rescore-from'
  if (unjudged.length > 0) {
    throw new Error(`judging has no verdicts for ${unjudged.join(', ')}, which automated rubric ${version} requires; ${rejudge}`)
  }
  if (browser?.criteria) {
    const recorded = new Set(browser.criteria.map(({ id }) => id))
    const absent = deterministicCriteria(rubrics.automated.rubric).filter((id) => !recorded.has(id))
    if (absent.length > 0) {
      throw new Error(`the browser evaluation has no results for ${absent.join(', ')}, which automated rubric ${version} requires; ${rejudge}`)
    }
  }
  const durableHuman = humanReview?.score
    ? {
        total: humanReview.score.total,
        ratings: (humanReview.responses ?? []).map(({ rating }) => rating),
      }
    : humanReview

  const result = scoreProduct({
    rubrics,
    deterministic: browser?.criteria ?? null,
    judges: judging?.judges ?? {},
    gates: browser?.gates ?? null,
    humanReview: durableHuman,
    harness: {
      judge_retries: judging?.retries ?? {},
      failed_judge_jobs: judging?.failed_jobs ?? [],
      browser_bounds_exceeded: browser?.bounds_exceeded ?? [],
    },
    mode,
  })
  await writeFile(valueAfter(args, '--output'), `${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
