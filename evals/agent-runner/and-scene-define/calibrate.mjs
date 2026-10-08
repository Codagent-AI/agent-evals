#!/usr/bin/env node
// `run.sh --calibrate`: the maintainer judge-calibration diagnostic.
//
// Each calibration input is judged `--repeats` times (at least 3) through the
// same gates-and-judging phase a candidate run uses, every repeat in its own
// fresh run directory so no judged unit is reused. Up to `--concurrency`
// repeats are judged at once. The decider alone is then
// re-run 3 times on each first-repeat panel record that went to it, and the
// report (lib/calibration.mjs) is written to the output directory together
// with the eval-owned usage ledger.
//
// Calibration is never published and never a prerequisite or runtime gate for
// a candidate run: candidate preflight reads only rubric.json. Real model calls
// are refused until the inventory's anchors are reviewed (HT-003).
import { mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SUITE_ROOT, contained } from './lib/files.mjs'
import { readJson, writeJsonAtomic } from './lib/persistence.mjs'
import { createCheckpoint } from './lib/checkpoint.mjs'
import { createJudgingPhases, loadJudgingInputs } from './lib/judging.mjs'
import { makeJobs, rerunDefinitionDecider, PANEL_PROTOCOL, JUDGE_PROFILE } from './lib/judge-jobs.mjs'
import { createDefinitionJudges } from './lib/judge-invoker.mjs'
import { verifyJudgingInputs } from './lib/rubric.mjs'
import { RESULTS_RELATIVE_DIR } from './lib/publication.mjs'
import { loadCalibrationSet, aggregateCalibration, renderCalibrationMarkdown, MIN_REPEATS, DECIDER_RERUNS } from './lib/calibration.mjs'

export const REPO_ROOT = resolve(SUITE_ROOT, '../../..')
export const DEFAULT_CALIBRATION_DIR = join(SUITE_ROOT, 'calibration')
// Each repeat's panel already runs its three seats together, so six repeats
// keep about eighteen judge CLIs in flight.
export const CALIBRATION_CONCURRENCY = 6
export const calibrationOutputRoot = (repoRoot = REPO_ROOT) => join(repoRoot, 'artifacts/evals/and-scene-define-calibration')

export const CALIBRATE_HELP = `Usage: evals/agent-runner/and-scene-define/run.sh --calibrate [options]
Judges every calibration input repeatedly with the pinned judge panel and writes
calibration-report.json, calibration-report.md, and the eval-owned usage ledger.
Maintainer diagnostic only: never published, never required by candidate runs.
Options:
  --out DIR                Output directory (default artifacts/evals/and-scene-define-calibration/<timestamp>).
  --repeats N              Judgings per input, at least ${MIN_REPEATS} (default ${MIN_REPEATS}).
  --concurrency N          Repeats judged at once, at least 1 (default ${CALIBRATION_CONCURRENCY}).
  --rescore-input ID       Input whose two identical judgings are diffed per item (default reference).
  --calibration-dir DIR    Calibration set (default the suite's calibration/).
  --dry-run                Load and validate the set and print the plan; no model calls.
Real judging requires reviewed anchors (HT-003) in hidden/inventory.json.`

export function parseCalibrateArguments(argv, { now = new Date(), repoRoot = REPO_ROOT } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const options = { repeats: MIN_REPEATS, concurrency: CALIBRATION_CONCURRENCY, dryRun: false, calibrationDir: DEFAULT_CALIBRATION_DIR, rescoreInput: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--calibrate') continue
    if (['--run-agent', '--resume', '--rescore-from'].includes(arg)) throw new Error('select exactly one mode')
    if (arg === '--dry-run') { options.dryRun = true; continue }
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    if (arg === '--out') options.outDir = resolve(value)
    else if (arg === '--repeats') {
      if (!/^\d+$/.test(value) || Number(value) < MIN_REPEATS) throw new Error(`--repeats must be an integer of at least ${MIN_REPEATS}`)
      options.repeats = Number(value)
    } else if (arg === '--concurrency') {
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error('--concurrency must be an integer of at least 1')
      options.concurrency = Number(value)
    } else if (arg === '--rescore-input') options.rescoreInput = value
    else if (arg === '--calibration-dir') options.calibrationDir = resolve(value)
    else throw new Error(`unknown calibrate option ${arg}`)
  }
  options.outDir ??= join(calibrationOutputRoot(repoRoot), now.toISOString().replace(/[:.]/g, '-'))
  return options
}

const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }

export function assertAnchorsReviewed(inventory) {
  const review = inventory.anchors_review
  if (!review?.reviewer?.trim?.() || !review.date || review.inventory_version !== inventory.inventory_version) {
    throw new Error(`calibration refused before any model call: the verdict anchors need maintainer review (HT-003) for inventory version ${inventory.inventory_version}; hidden/inventory.json anchors_review is ${review ? `for inventory version ${review.inventory_version}` : 'null'}`)
  }
}

async function usageSummary(outDir) {
  const ledger = join(outDir, 'phases/eval-owned-usage.jsonl')
  const text = await readFile(ledger, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const entries = text.split('\n').filter(x => x.trim()).map(line => { try { return JSON.parse(line) } catch { return null } })
  const byStage = {}
  for (const entry of entries) { const stage = entry?.stage ?? 'unknown'; byStage[stage] = (byStage[stage] ?? 0) + 1 }
  return { ledger: relative(outDir, ledger), invocations: entries.length, by_stage: byStage, note: 'Eval-owned calibration usage; not implementation cost.' }
}

// One repeat: a fresh run directory laid out like a candidate run's collected
// evidence, judged by the candidate gates-and-judging phase. Calibration inputs
// have no simulated-user disclosure audit, so nothing is leaked.
async function judgeRepeat({ input, runDir, suiteRoot, judges, gateCommand, repeat }) {
  for (const dir of ['collected', 'phases', 'audits', 'judges']) await mkdir(join(runDir, dir), { recursive: true })
  for (const [name, text] of Object.entries(input.artifacts)) {
    const target = contained(join(runDir, 'collected'), name)
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, text)
  }
  await writeJsonAtomic(join(runDir, 'phases/collection.json'), { head: null, source: 'calibration', input_id: input.input_id, files: input.files })
  await writeFile(join(runDir, 'conversation.jsonl'), input.conversation_text)
  await writeJsonAtomic(join(runDir, 'audits/disclosure.json'), { status: 'not-run', reason: 'calibration inputs have no simulated-user conversation to audit for disclosure', flags: [], panel_flags: [], leaked_items: [] })
  let checkpoint = createCheckpoint({ run_id: `calibration-${input.input_id}-${repeat}`, kind: 'calibration', identity: { series_identity: { calibration: input.input_id, input_hash: input.input_hash } } })
  const persist = () => writeJsonAtomic(join(runDir, 'run-state.json'), checkpoint)
  const phases = createJudgingPhases({ runDir, suiteRoot, judges, gateCommand, persist, getCheckpoint: () => checkpoint, setCheckpoint: value => { checkpoint = value } })
  await phases['gates-and-judging']()
  return readJson(join(runDir, 'judges/score.json'))
}

async function rerunDeciders({ input, runDir, suiteRoot, scored, judges, reruns }) {
  const data = await loadJudgingInputs({ runDir, suiteRoot })
  const gates = (await readJson(join(runDir, 'judges/gates.json'))).gates
  const jobs = makeJobs({ ...data, gates })
  const entries = []
  for (const { record } of scored.panel_records) {
    if (!record.rulings?.length && !record.checks?.some(c => c.stage === 'dissent-check')) continue
    const job = jobs.find(x => x.name === record.job)
    if (!job) throw new Error(`no judge job for recorded panel record ${record.job} (${input.input_id})`)
    const runs = []
    for (let n = 0; n < reruns; n++) runs.push(await rerunDefinitionDecider({ job, decider: judges.decider, record }))
    entries.push({ input_id: input.input_id, repeat: 1, job: record.job, runs })
  }
  return entries
}

export async function runCalibration(options, dependencies = {}) {
  const suiteRoot = options.suiteRoot ?? SUITE_ROOT
  const log = dependencies.log ?? (() => {})
  const repeats = options.repeats ?? MIN_REPEATS
  if (!Number.isInteger(repeats) || repeats < MIN_REPEATS) throw new Error(`calibration needs at least ${MIN_REPEATS} repeats per input`)
  const inventory = await readJson(join(suiteRoot, 'hidden/inventory.json'))
  const rubric = await readJson(join(suiteRoot, 'rubric.json'))
  verifyJudgingInputs({ inventory, rubric, candidate: false })
  const set = await loadCalibrationSet(options.calibrationDir ?? join(suiteRoot, 'calibration'), { rubric })
  const outDir = resolve(options.outDir)
  for (const root of [join(suiteRoot, 'results'), join(options.repoRoot ?? REPO_ROOT, RESULTS_RELATIVE_DIR)]) if (inside(root, outDir)) throw new Error('calibration output must never be written under the published results directory')
  const plan = { mode: 'calibration', output_directory: outDir, repeats, decider_reruns: DECIDER_RERUNS,
    inputs: set.inputs.map(x => ({ input_id: x.input_id, variant: x.expectations.variant, artifacts: x.files.length, conversation_exchanges: x.conversation.length, input_hash: x.input_hash })),
    judge_profile: JUDGE_PROFILE, panel_protocol: PANEL_PROTOCOL }
  if (options.dryRun) return { dryRun: true, plan, exitCode: 0 }
  assertAnchorsReviewed(inventory)
  if (set.inputs.some(x => x.input_id === options.rescoreInput) === false && options.rescoreInput) throw new Error(`unknown --rescore-input ${options.rescoreInput}`)
  const existing = await readdir(outDir).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing?.length) throw new Error(`calibration output directory is not empty: ${outDir}`)
  if ((await lstat(dirname(outDir)).catch(() => null))?.isSymbolicLink()) throw new Error('calibration output parent must not be a symlink')
  await mkdir(outDir, { recursive: true })
  await writeJsonAtomic(join(outDir, 'calibration-plan.json'), plan)
  // One judge authority for the whole calibration so the eval-owned usage
  // ledger lands in the output directory, never in a candidate run.
  const judges = dependencies.judges ?? createDefinitionJudges({ runDir: outDir })
  // Repeats are independent: each has its own run directory and checkpoint,
  // and the shared usage ledger is append-only. Results are stored by input
  // and repeat, so the report does not depend on which repeat finishes first.
  // After a failure no new repeat starts; in-flight repeats finish first so no
  // judge call outlives the calibration.
  const concurrency = options.concurrency ?? CALIBRATION_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('calibration concurrency must be an integer of at least 1')
  const tasks = set.inputs.flatMap((input, index) => Array.from({ length: repeats }, (_, n) => ({ index, input, repeat: n + 1 })))
  const results = set.inputs.map(() => [])
  const rerunsByInput = set.inputs.map(() => [])
  let next = 0; let failure = null
  const worker = async () => {
    while (!failure && next < tasks.length) {
      const { index, input, repeat } = tasks[next++]
      try {
        log(`judging ${input.input_id} repeat ${repeat}/${repeats}`)
        const runDir = join(outDir, 'inputs', input.input_id.replace(/[^A-Za-z0-9._-]/g, '-'), `repeat-${repeat}`)
        const scored = await judgeRepeat({ input, runDir, suiteRoot, judges, gateCommand: dependencies.gateCommand, repeat })
        results[index][repeat - 1] = scored
        if (repeat === 1) {
          log(`re-running the decider on ${input.input_id} repeat 1`)
          try { rerunsByInput[index] = await rerunDeciders({ input, runDir, suiteRoot, scored, judges, reruns: options.deciderReruns ?? DECIDER_RERUNS }) }
          catch (error) { throw Object.assign(error, { message: `decider re-run for ${input.input_id} repeat 1: ${error.message}` }) }
        }
      } catch (error) {
        // Every failure is logged as it happens; the first one fails the calibration.
        log(`calibration failed: ${input.input_id} repeat ${repeat}: ${error.message}`)
        failure ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  if (failure) throw failure
  const judged = set.inputs.map((input, index) => ({ input_id: input.input_id, description: input.expectations.description ?? null, expectations: input.expectations, input_hash: input.input_hash, repeats: results[index] }))
  const reruns = rerunsByInput.flat()
  const report = aggregateCalibration({ inputs: judged, rubric, reruns, rescoreInput: options.rescoreInput, judgeProfile: JUDGE_PROFILE, panelProtocol: PANEL_PROTOCOL, usage: await usageSummary(outDir), outDir })
  await writeJsonAtomic(join(outDir, 'calibration-report.json'), report)
  await writeFile(join(outDir, 'calibration-report.md'), renderCalibrationMarkdown(report))
  return { report, plan, exitCode: report.passed ? 0 : 1 }
}

async function main() {
  let options
  try { options = parseCalibrateArguments(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 2; return }
  if (options.help) { console.log(CALIBRATE_HELP); return }
  try {
    const outcome = await runCalibration(options, { log: line => console.error(line) })
    if (outcome.dryRun) { console.log(JSON.stringify(outcome.plan, null, 2)); return }
    for (const failure of outcome.report.failures) console.error(`calibration failure: ${failure.message}`)
    console.log(JSON.stringify({ output_directory: options.outDir, passed: outcome.report.passed, failures: outcome.report.failures.length }, null, 2))
    process.exitCode = outcome.exitCode
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
