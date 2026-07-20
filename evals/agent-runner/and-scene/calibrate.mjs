#!/usr/bin/env node
// The autonomous calibration command.
//
// It runs on the host and needs no Docker, no Agent Runner, no browser, and no
// human: calibration is about whether this harness attributes quality to the
// right component or gate, and everything it needs to answer that is the rubric
// plus suite-owned evidence.
//
// Two jobs, deliberately in one small entry point:
//
//   * `--out DIR` runs the calibration and writes its diagnostics there,
//     refreshing the durable pass/fail record at `--record`.
//   * `--check-record PATH` is the gate `run.sh` consults before a full Agent
//     Runner evaluation. The JSON lives here rather than in Bash so the rule
//     that blocks an expensive run is the same code the calibration wrote.
//
// Nothing it writes is an official result. Calibration artifacts carry
// `mode: 'calibration'`, live under the ignored artifacts tree, and are refused
// by publication.
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { runCalibration } from './lib/calibration.mjs'
import { readJson, writeJsonAtomic } from './lib/persistence.mjs'
import { loadRubrics } from './lib/rubric.mjs'

const VALUES = new Map([
  ['--out', 'outDir'],
  ['--record', 'recordPath'],
  ['--check-record', 'checkRecordPath'],
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
  if (!options.outDir && !options.checkRecordPath) {
    throw new Error('--out is required unless --check-record is given')
  }
  return options
}

// The gate. A record that is missing, unreadable, or not a pass blocks the run
// and says which, so the operator knows whether to calibrate or to fix a defect
// calibration already found.
export async function checkCalibrationRecord(path) {
  const record = await readJson(path, null)
  if (record === null) {
    return { passed: false, reason: `no calibration record at ${path}` }
  }
  if (record.passed !== true) {
    const failures = (record.failures ?? []).map(({ case: id, problem }) => `${id}: ${problem}`)
    return {
      passed: false,
      reason: `the last calibration failed${failures.length > 0 ? `: ${failures.join('; ')}` : ''}`,
    }
  }
  return { passed: true, reason: null }
}

export async function runCalibrationCommand({ argv, log = () => {} }) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    return { exitCode: 2, errors: [{ code: 'invalid-arguments', message: error.message }] }
  }

  if (options.checkRecordPath) {
    const outcome = await checkCalibrationRecord(resolve(options.checkRecordPath))
    if (!outcome.passed) return { exitCode: 1, errors: [{ code: 'calibration-gate', message: outcome.reason }] }
    return { exitCode: 0, errors: [] }
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

  if (options.recordPath) {
    const recordPath = resolve(options.recordPath)
    await mkdir(dirname(recordPath), { recursive: true })
    await writeJsonAtomic(recordPath, {
      passed: ledger.passed,
      calibration_dir: outDir,
      rubrics: ledger.rubrics,
      failures: ledger.failures,
      completed_at: new Date().toISOString(),
    })
  }

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
