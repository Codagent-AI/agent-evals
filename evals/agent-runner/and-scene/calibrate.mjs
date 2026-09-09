#!/usr/bin/env node
// The autonomous calibration command.
//
// It runs on the host and needs no Docker, no Agent Runner, no browser, and no
// human: calibration is about whether this harness attributes quality to the
// right component or gate, and everything it needs to answer that is the rubric
// plus suite-owned evidence.
//
// `--out DIR` runs the calibration and writes its diagnostics there. It is an
// explicit maintainer check, not a prerequisite or runtime input for candidate
// evaluations.
//
// Nothing it writes is an official result. Calibration artifacts carry
// `mode: 'calibration'`, live under the ignored artifacts tree, and are refused
// by publication.
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { runCalibration } from './lib/calibration.mjs'
import { loadRubrics } from './lib/rubric.mjs'

const VALUES = new Map([
  ['--out', 'outDir'],
])

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = VALUES.get(argv[index])
    if (!key) throw new Error(`unknown calibrate option: ${argv[index]}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`missing value for ${argv[index]}`)
    options[key] = value
    index += 1
  }
  if (!options.outDir) throw new Error('--out is required')
  return options
}

export async function runCalibrationCommand({ argv, log = () => {} }) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    return { exitCode: 2, errors: [{ code: 'invalid-arguments', message: error.message }] }
  }

  const outDir = resolve(options.outDir)
  await mkdir(outDir, { recursive: true })

  let rubrics
  try {
    rubrics = await loadRubrics()
  } catch (error) {
    return { exitCode: 2, errors: [{ code: 'invalid-rubric', message: error.message }] }
  }

  const ledger = await runCalibration({ rubrics, outDir, log })

  return {
    exitCode: ledger.passed ? 0 : 1,
    errors: ledger.failures.map(({ case: id, problem }) => ({ code: 'calibration', case: id, message: problem })),
    ledger,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outcome = await runCalibrationCommand({
    argv: process.argv.slice(2),
    log: (line) => console.error(line),
  })
  for (const error of outcome.errors ?? []) console.error(JSON.stringify(error))
  process.exit(outcome.exitCode)
}
