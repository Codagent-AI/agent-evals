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
import { loadRubrics } from './lib/rubric.mjs'
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
  const missing = requiredJobs.filter((job) => (
    failed.has(job) || !Array.isArray(judging?.judges?.[job])
  ))
  if (missing.length > 0) {
    throw new Error(`required judge jobs failed: ${missing.join(', ')}`)
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
