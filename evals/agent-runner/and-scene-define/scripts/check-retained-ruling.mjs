#!/usr/bin/env node
// The retained-ruling check (proposal evidence step 3, E2E-003): run the
// overrule check against one retained calibration record's own decider ruling,
// its stated reason and its citations, with the recorded votes, and print the
// check's classification and the verdict v2 settlement would give.
//
// The record may be of any protocol. Everything is read-only: the record, its
// run directory and the suite inputs are only read, and no judging record or
// cache entry is written, so a retained record is never reused as v2 judging.
// The real decider writes its raw logs and usage ledger only under a fresh
// scratch directory outside the run, which the output names.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SUITE_ROOT, readJson } from '../lib/files.mjs'
import { loadJudgingInputs } from '../lib/judging.mjs'
import { makeJobs, checkRetainedDefinitionRuling, JUDGE_PROFILE } from '../lib/judge-jobs.mjs'
import { createClaudeJudgeInvoker } from '../../../lib/panel-judging/claude-invoker.mjs'

export const RETAINED_RULING_HELP = `Usage: node evals/agent-runner/and-scene-define/scripts/check-retained-ruling.mjs --record <run-dir>/judges/<job>.json --criterion <id> [options]

Runs the overrule check against the retained decider ruling for one criterion and
prints the check's classification and the verdict v2 settlement would give.
Makes at most one decider call (Claude, the pinned decider model) and writes
nothing under the record's run directory.

Options:
  --record PATH        A retained panel record, such as a calibration repeat's judges/coverage-<area>.json.
  --criterion ID       The criterion whose decider ruling is checked, such as INV-093.
  --run-dir DIR        The record's run directory (default: two levels above the record).
  --suite-root DIR     The define suite root holding hidden/ and rubric.json (default: this suite).
  --scratch-dir DIR    Where the real decider writes raw logs and usage (default: a new temporary directory).
  --json               Print the result as JSON.
  --help               Show this help.`

export function parseRetainedRulingArguments(argv) {
  const options = { json: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help') { options.help = true; continue }
    if (arg === '--json') { options.json = true; continue }
    const key = { '--record': 'record', '--criterion': 'criterion', '--run-dir': 'runDir', '--suite-root': 'suiteRoot', '--scratch-dir': 'scratchDir' }[arg]
    if (!key) throw new Error(`unknown argument: ${arg}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    options[key] = value
  }
  if (!options.help && (!options.record || !options.criterion)) throw new Error('--record and --criterion are required')
  return options
}

async function realDecider(scratchDir) {
  const runDir = scratchDir ? resolve(scratchDir) : await mkdtemp(join(tmpdir(), 'define-retained-ruling-'))
  return { runDir, decider: { ...JUDGE_PROFILE.decider, family: 'claude', invoke: createClaudeJudgeInvoker({ runDir, mode: 'host' }) } }
}

function summary(result, recordPath, scratch) {
  const lines = [
    `record: ${recordPath}`,
    `protocol: ${result.recorded_protocol ?? 'unrecorded'}; job: ${result.job}`,
    `criterion: ${result.id}`,
    `votes: ${[...result.votes].sort((a, b) => a.panel_index - b.panel_index).map(v => `${v.family} ${v.verdict}`).join(', ')}`,
    `recorded ruling: ${result.ruling.verdict}${result.recorded_basis ? ` (recorded settlement: ${result.recorded_verdict}, ${result.recorded_basis})` : ''}`,
    `ruling reason: ${result.ruling.rationale}`,
  ]
  if (result.check) {
    lines.push(`overrule check: ${result.check.classification} (the ruling overrules the two-vote ${result.overruled_verdict})`)
    lines.push(`check reason: ${result.check.rationale}`)
  } else lines.push('overrule check: not needed (the ruling overrules no two-vote verdict)')
  lines.push(`v2 settlement: ${result.verdict} (${result.basis})`)
  if (scratch) lines.push(`decider logs: ${scratch}`)
  return lines
}

// `decider` replaces the real Claude decider (tests pass a canned invoker).
export async function main(argv, { decider = null, log = line => console.log(line) } = {}) {
  let options
  try { options = parseRetainedRulingArguments(argv) } catch (error) { log(`${error.message}\n\n${RETAINED_RULING_HELP}`); return { exitCode: 2 } }
  if (options.help) { log(RETAINED_RULING_HELP); return { exitCode: 0 } }
  const recordPath = resolve(options.record)
  const runDir = resolve(options.runDir ?? dirname(dirname(recordPath)))
  const suiteRoot = resolve(options.suiteRoot ?? SUITE_ROOT)
  const record = await readJson(recordPath)
  const data = await loadJudgingInputs({ runDir, suiteRoot })
  const gates = (await readJson(join(runDir, 'judges/gates.json'))).gates
  const job = makeJobs({ ...data, gates }).find(x => x.name === record.job)
  if (!job) throw new Error(`no define judge job named ${record.job} for this run`)
  if (!(record.rulings ?? []).some(r => r.id === options.criterion)) throw new Error(`retained record ${record.job} holds no decider ruling for ${options.criterion}`)
  const real = decider ? null : await realDecider(options.scratchDir)
  const result = await checkRetainedDefinitionRuling({ job, record, id: options.criterion, decider: decider ?? real.decider })
  if (options.json) log(JSON.stringify({ record: recordPath, ...result, ...(real ? { decider_logs: real.runDir } : {}) }, null, 2))
  else for (const line of summary(result, recordPath, real?.runDir)) log(line)
  return { exitCode: 0, result }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = (await main(process.argv.slice(2))).exitCode } catch (error) { console.error(error.message); process.exitCode = 1 }
}
