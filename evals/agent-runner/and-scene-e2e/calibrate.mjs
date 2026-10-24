#!/usr/bin/env node
// Maintainer calibration diagnostic: never published, never required by a candidate run.
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SUITE_ROOT, readJson } from './lib/files.mjs'
import { DEFAULT_REPEATS, MIN_REPEATS, referenceRubric, runCalibration } from './lib/calibration.mjs'
import { loadProductInputs } from './lib/product-rubric.mjs'
import { evaluateProduct } from './lib/product-evaluation.mjs'
import { createProductionDeps } from './lib/production-deps.mjs'
export function parseCalibrationArguments(args) {
  const options = { repeats: DEFAULT_REPEATS, inputs: null, calibrationDir: join(SUITE_ROOT, 'calibration'), out: resolve('artifacts/and-scene-e2e-calibration', new Date().toISOString().replace(/[:.]/g, '-')), dryRun: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--calibrate') continue
    if (arg === '--dry-run') { options.dryRun = true; continue }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw Object.assign(new Error(`missing value for ${arg}`), { usage: true })
    if (arg === '--repeats') options.repeats = Number(value)
    else if (arg === '--inputs') options.inputs = value.split(',').map(id => id.trim()).filter(Boolean)
    else if (arg === '--out') options.out = resolve(value)
    else if (arg === '--calibration-dir') options.calibrationDir = resolve(value)
    else throw Object.assign(new Error(`unknown option ${arg}`), { usage: true })
  }
  if (!Number.isInteger(options.repeats) || options.repeats < MIN_REPEATS) throw Object.assign(new Error(`calibration needs at least ${MIN_REPEATS} repeat per input, got ${options.repeats}`), { usage: true })
  return options
}
export async function calibrate(options, deps = {}) {
  const product = await loadProductInputs()
  const rubric = referenceRubric(product.rubric)
  const expected = await readJson(join(options.calibrationDir, 'expected-verdicts.json'))
  const unknown = (options.inputs ?? []).filter(id => !expected.inputs[id])
  if (unknown.length) throw Object.assign(new Error(`unknown calibration input: ${unknown.join(', ')}`), { usage: true })
  if (options.dryRun) return { dry_run: true, inputs: Object.keys(expected.inputs).filter(id => !options.inputs || options.inputs.includes(id)), repeats: options.repeats, model_calls: 0, published: false }
  await mkdir(options.out, { recursive: true })
  const evaluate = deps.evaluate ?? (async ({ inputId, repeat, input, rubric: scoped = rubric }) => {
    const runDir = join(options.out, 'runs', `${inputId}-${repeat}`)
    await mkdir(join(runDir, 'collected'), { recursive: true })
    const evaluated = await evaluateProduct({ runDir, rubric: scoped, inventory: product.inventory, bundlePath: input.bundlePath, commit: input.commit, collectedDir: join(runDir, 'collected'), acceptance: null, deps: createProductionDeps({ runDir }) })
    return { score: evaluated.score, verdicts: evaluated.verdicts, judge_records: evaluated.judge_records, build: { ok: evaluated.build.ok, reason: evaluated.build.reason, record: join(runDir, 'phases/product/build.json') } }
  })
  return runCalibration({ calibrationDir: options.calibrationDir, rubric: product.rubric, repeats: options.repeats, inputs: options.inputs, evaluate, outDir: options.out, log: deps.log ?? (line => console.error(line)) })
}
async function main() {
  try {
    const options = parseCalibrationArguments(process.argv.slice(2))
    console.log(JSON.stringify(await calibrate(options), null, 2))
  } catch (error) { console.error(`and-scene-e2e calibrate: ${error.message}`); process.exitCode = 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
