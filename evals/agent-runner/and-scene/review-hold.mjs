#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJson } from './lib/persistence.mjs'
import { publishRun } from './lib/publication.mjs'
import { reviewHoldProjection, resolveReviewHold } from './lib/review-hold.mjs'
import { writeResultArtifacts } from './lib/result.mjs'

const SUITE_DIR = fileURLToPath(new URL('.', import.meta.url))
const AGENT_EVALS_DIR = resolve(SUITE_DIR, '../../..')

export function parseArgs(argv) {
  const values = new Map([['--run-dir', 'runDir'], ['--reviewer', 'reviewer'], ['--decision', 'decision'], ['--rationale', 'rationale']])
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = values.get(argv[index])
    if (!key) throw new Error(`unknown review-hold option: ${argv[index]}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`missing value for ${argv[index]}`)
    options[key] = value
    index += 1
  }
  for (const field of ['runDir', 'reviewer', 'decision', 'rationale']) {
    if (!options[field]) throw new Error(`--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  }
  return options
}

export async function runReviewHold({ argv, publication = null, log = () => {} }) {
  let options
  try { options = parseArgs(argv) } catch (error) { return { exitCode: 2, error: error.message } }
  const runDir = resolve(options.runDir)
  try {
    const hold = await resolveReviewHold(options)
    const result = await readJson(join(runDir, 'result.json'), null)
    if (!result) throw new Error('run has no result.json')
    const written = await writeResultArtifacts({
      runDir,
      result: {
        ...result,
        evaluator_contradictions: hold.contradictions,
        review_hold: reviewHoldProjection(hold),
      },
    })
    let publicationOutcome = null
    if (hold.release && written.result.evaluation_status === 'complete' && publication) {
      publicationOutcome = await publishRun({
        runDir, runId: written.result.run_id, result: written.result, repoDir: AGENT_EVALS_DIR, log, ...publication,
      })
    }
    return { exitCode: 0, result: written.result, hold, publication: publicationOutcome }
  } catch (error) {
    return { exitCode: 1, error: error.message }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.log('Usage: review-hold.sh --run-dir PATH --reviewer NAME --decision stand|verdict-wrong --rationale TEXT')
  } else {
    const outcome = await runReviewHold({ argv: process.argv.slice(2), publication: { repoDir: AGENT_EVALS_DIR } })
    if (outcome.error) console.error(outcome.error)
    process.exitCode = outcome.exitCode
  }
}
