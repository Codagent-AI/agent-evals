#!/usr/bin/env node
// Thin command wrapper over the suite-owned scorer.
//
// The controller scores in-process; this entry point exists so a finalized run
// can be rescored from its durable phase artifacts — for example when a human
// review is supplied later, or when a published result is re-verified.
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { readJson } from './lib/persistence.mjs'
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

  const result = scoreProduct({
    rubrics: await loadRubrics(),
    deterministic: browser?.criteria ?? null,
    judges: judging?.judges ?? {},
    gates: browser?.gates ?? null,
    humanReview,
    harness: {
      judge_retries: judging?.retries ?? {},
      failed_judge_jobs: judging?.failed_jobs ?? [],
      browser_bounds_exceeded: browser?.bounds_exceeded ?? [],
    },
    mode: valueAfter(args, '--mode', false) ?? 'agent-runner',
  })
  await writeFile(valueAfter(args, '--output'), `${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
