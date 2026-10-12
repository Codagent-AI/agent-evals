#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { extractEvalBlock, parseTomlSubset, validateRequest } from './lib/eval-request.mjs'
import * as github from './lib/github-read.mjs'
import { admitCohorts, checkRequest, planCompares, roleCosts, buildReport } from './lib/experiment-comparison.mjs'
import { formatMarkdown, formatRefusals } from './lib/comparison-format.mjs'
import { identityOf } from './lib/experiment-baseline.mjs'
import { realpathSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJsonAtomic } from './lib/persistence.mjs'
import { SOURCES, emptyRecord, validateRecord, extractRepetition, applySet, applyAddRep, applyAnchor, formatShow } from './lib/experiment-baseline.mjs'

const defaultRecord = fileURLToPath(new URL('./experiments/baseline.json', import.meta.url))
const usage = `Usage: experiments.mjs baseline <command> [options]
  baseline set <result-dir>... --source <accepted-candidate|profile-change|manual> --reason <text> [--allow-mismatch <reason>] [--record <path>]
  baseline add-rep <result-dir> [--allow-mismatch <reason>] [--record <path>]
  baseline anchor --from-current --reason <text> [--record <path>]
  baseline show [--record <path>]
  compare --eval-issue <owner/repo#N> <result-dir>... [--json] [--record <path>] [--baseline-results <dir>]
  baseline --help
`

const VALUE_OPTIONS = ['--record', '--source', '--reason', '--allow-mismatch', '--eval-issue', '--baseline-results']

function rescoreSource(result) {
  return result?.rescored_from ?? result?.workflow?.events?.find(event => event?.event === 'imported-completed-run')?.source_run_id ?? null
}

async function findCarriedReview(result, directory) {
  const visited = new Set([result?.run_id])
  let sourceRunId = rescoreSource(result)
  if (!sourceRunId) return {}
  while (sourceRunId) {
    if (typeof sourceRunId !== 'string' || sourceRunId === '.' || sourceRunId === '..' || sourceRunId.includes('/') || sourceRunId.includes('\\')) return { carryReason: 'invalid source run id' }
    if (visited.has(sourceRunId)) return { carryReason: 'rescore lineage cycle' }
    visited.add(sourceRunId)
    let source
    try { source = await readJson(join(dirname(directory), sourceRunId, 'result.json')) }
    catch { return { carryReason: `source ${sourceRunId} is missing or unreadable` } }
    if (source?.human_review?.complete === true && typeof source?.official_score === 'number') {
      const humanPoints = source?.human_review?.score?.points_awarded ?? source?.human_review?.score?.total
      if (typeof humanPoints !== 'number') return { carryReason: `source ${sourceRunId} has no numeric awarded human points` }
      if (typeof result?.rubrics?.human?.sha256 !== 'string' || source?.rubrics?.human?.sha256 !== result.rubrics.human.sha256) return { carryReason: `human rubric sha256 differs from source ${sourceRunId}` }
      return { carriedReview: { run_id: sourceRunId, result: source } }
    }
    sourceRunId = rescoreSource(source)
  }
  return { carryReason: 'no ancestor has a complete human review' }
}

export function parseArgs(argv) {
  // --help is a flag; a --help that follows a value option is that option's (missing) value.
  if (argv.some((arg, i) => arg === '--help' && !VALUE_OPTIONS.includes(argv[i - 1]))) return { help: true }
  if (argv[0] === 'compare') return parseCompareArgs(argv.slice(1))
  if (argv[0] !== 'baseline') throw Error('Expected baseline command')
  const command = argv[1]
  if (!['set', 'add-rep', 'anchor', 'show'].includes(command)) throw Error(`Unknown baseline command: ${command ?? '(missing)'}`)
  const options = { command, directories: [], record: defaultRecord }
  const seen = new Set()
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (['--record', '--source', '--reason', '--allow-mismatch'].includes(arg)) {
      if (seen.has(arg)) throw Error(`Duplicate option: ${arg}`)
      seen.add(arg)
      const next = argv[++i]
      if (next === undefined || next.startsWith('--') || !next.trim()) throw Error(`Missing value for ${arg}`)
      options[{ '--record': 'record', '--source': 'source', '--reason': 'reason', '--allow-mismatch': 'allowMismatch' }[arg]] = next
    } else if (arg === '--from-current') {
      if (seen.has(arg)) throw Error(`Duplicate option: ${arg}`)
      seen.add(arg); options.fromCurrent = true
    } else if (arg.startsWith('-')) throw Error(`Unknown option: ${arg}`)
    else options.directories.push(arg)
  }
  options.record = resolve(options.record)
  if (command === 'set') {
    if (!options.directories.length) throw Error('set requires at least one result directory')
    if (!SOURCES.includes(options.source)) throw Error('set requires a valid --source')
    if (!options.reason?.trim()) throw Error('set requires --reason')
    if (options.fromCurrent) throw Error('--from-current is only valid for anchor')
  } else if (command === 'add-rep') {
    if (options.directories.length !== 1) throw Error('add-rep requires exactly one result directory')
    if (options.source || options.reason || options.fromCurrent) throw Error('Invalid option for add-rep')
  } else if (command === 'anchor') {
    if (options.directories.length || options.source || options.allowMismatch) throw Error('Invalid option for anchor')
    if (!options.fromCurrent) throw Error('anchor requires --from-current')
    if (!options.reason?.trim()) throw Error('anchor requires --reason')
  } else if (options.directories.length || options.source || options.reason || options.allowMismatch || options.fromCurrent) throw Error('show accepts only --record')
  return options
}

export async function runExperimentsCommand({ argv, now = () => new Date(), stdout = s => process.stdout.write(s), write = writeJsonAtomic, exec = spawnSync } = {}) {
  const errors = []
  const error = (code, message, exitCode) => { const item = { code, message }; errors.push(item); process.stderr.write(`${JSON.stringify(item)}\n`); return { exitCode, errors } }
  let args
  try { args = parseArgs(argv) } catch (cause) { stdout(usage); return error('invalid-arguments', cause.message, 2) }
  if (args.help) { stdout(usage); return { exitCode: 0, errors } }
  if (args.command === 'compare') {
    try { return await runCompare(args, { now, stdout, exec }) }
    catch (cause) { return error('internal-error', cause.stack ?? cause.message, 2) }
  }
  let record
  try { { const raw = await readJson(args.record, undefined); record = validateRecord(raw === undefined ? emptyRecord() : raw) } } catch (cause) { return error('invalid-record', cause.message, 2) }
  if (args.command === 'show') {
    try { stdout(formatShow(record)) } catch (cause) { return error('invalid-record', cause.message, 2) }
    return { exitCode: 0, errors }
  }
  const items = []
  if (args.command === 'set' || args.command === 'add-rep') {
    for (const directory of args.directories) {
      let result
      try { result = await readJson(join(directory, 'result.json')) }
      catch (cause) {
        if (!(cause instanceof SyntaxError) && cause.code !== 'ENOENT') return error('io-error', `${directory}/result.json: ${cause.message}`, 2)
        const code = cause instanceof SyntaxError ? 'invalid-result' : 'missing-result'
        items.push({ entry: null, directory, refusals: [{ directory, run_id: null, code, message: `${directory}/result.json: ${cause.message}` }] })
        continue
      }
      const addedAt = now().toISOString()
      const carry = result?.human_review?.complete === true && typeof result?.official_score === 'number' ? {} : await findCarriedReview(result, directory)
      try { items.push(extractRepetition(result, { directory, addedAt, addedBy: args.command, ...carry })) }
      catch (cause) { items.push({ entry: null, directory, refusals: [{ directory, run_id: null, code: 'invalid-result', message: `${directory}/result.json: ${cause.message}` }] }) }
    }
  }
  let applied
  try {
    if (args.command === 'set') applied = applySet(record, items, { source: args.source, reason: args.reason, allowMismatch: args.allowMismatch, now: now() })
    if (args.command === 'add-rep') applied = applyAddRep(record, items[0], { allowMismatch: args.allowMismatch, now: now() })
    if (args.command === 'anchor') applied = applyAnchor(record, { reason: args.reason, now: now() })
  } catch (cause) { return error('internal-error', cause.stack ?? cause.message, 2) }
  if (applied.refusals) {
    for (const item of applied.refusals) { errors.push(item); process.stderr.write(`${JSON.stringify(item)}\n`) }
    return { exitCode: 1, errors }
  }
  let staged
  try {
    await mkdir(dirname(args.record), { recursive: true })
    await write(args.record, applied.record, { onStage: path => { staged = path } })
  } catch (cause) {
    if (staged) await unlink(staged).catch(() => {})
    return error('io-error', cause.message, 2)
  }
  const current = applied.record.current
  stdout(`baseline ${args.command}: ${current.reps.length} repetitions, median ${current.median_rep}\n`)
  return { exitCode: 0, errors }
}

function parseCompareArgs(argv) {
  const options = { command: 'compare', directories: [], record: defaultRecord, baselineResults: fileURLToPath(new URL('./results/', import.meta.url)) }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('-')) {
      if (seen.has(arg)) throw Error(`Duplicate option: ${arg}`)
      seen.add(arg)
      if (arg === '--json') { options.json = true; continue }
      const key = { '--record': 'record', '--baseline-results': 'baselineResults', '--eval-issue': 'evalIssue' }[arg]
      if (!key) throw Error(`Unknown option: ${arg}`)
      const value = argv[++i]
      if (!value || value.startsWith('-') || !value.trim()) throw Error(`Missing value for ${arg}`)
      options[key] = value
    } else options.directories.push(arg)
  }
  const issue = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(options.evalIssue ?? '')
  if (!issue || issue.slice(1, 3).some(x => x === '.' || x === '..')) throw Error('--eval-issue requires <owner/repo#N>')
  options.issue = { owner: issue[1], repo: issue[2], number: issue[3] }
  options.record = resolve(options.record)
  options.baselineResults = resolve(options.baselineResults)
  return options
}

async function runCompare(args, { now, stdout, exec }) {
  const refusals = [], candidates = [], costs = Object.create(null)
  const emit = (items, exitCode) => {
    for (const item of items) process.stderr.write(JSON.stringify(item) + '\n')
    if (exitCode === 1) stdout(formatRefusals(items, { json: args.json }))
    return { exitCode, errors: items }
  }
  const ioError = (cause, path) => emit([{ code: 'io-error', message: `${path}: ${cause.message}` }], 2)
  let baseline = null
  try {
    const record = await readJson(args.record, undefined)
    if (record !== undefined) baseline = validateRecord(record).current
    if (!baseline) refusals.push({ code: 'no-current', message: 'Set a current experiment baseline first' })
  } catch (cause) {
    if (!(cause instanceof SyntaxError) && cause.code && cause.code !== 'ENOENT') return ioError(cause, args.record)
    refusals.push({ code: 'invalid-record', message: cause.message })
  }
  for (const directory of args.directories) {
    const path = join(directory, 'result.json')
    try {
      const result = await readJson(path)
      const carry = result?.human_review?.complete === true && typeof result?.official_score === 'number' ? {} : await findCarriedReview(result, directory)
      let item
      try { item = extractRepetition(result, { directory, addedAt: now().toISOString(), addedBy: 'compare', ...carry }) }
      catch (cause) { item = { entry: null, refusals: [{ code: 'invalid-result', directory, message: cause.message }] } }
      candidates.push(item)
      if (item.entry) costs[item.entry.run_id] = roleCosts(result)
    } catch (cause) {
      if (!(cause instanceof SyntaxError) && cause.code !== 'ENOENT') return ioError(cause, path)
      candidates.push({ entry: null, refusals: [{ directory, code: cause instanceof SyntaxError ? 'invalid-result' : 'missing-result', message: `${path}: ${cause.message}` }] })
    }
  }
  for (const rep of baseline?.reps ?? []) {
    // Persisted ids must not escape the selected results directory.
    if (rep.run_id === '.' || rep.run_id === '..' || /[/\\]/.test(rep.run_id)) { costs[rep.run_id] = { complete: false }; continue }
    try {
      const result = await readJson(join(args.baselineResults, rep.run_id, 'result.json'))
      costs[rep.run_id] = result?.run_id === rep.run_id ? roleCosts(result) : { complete: false }
    } catch { costs[rep.run_id] = { complete: false } }
  }
  let request
  const issue = github.issueBody(args.issue, { exec })
  if (!issue.ok) refusals.push({ code: 'eval-issue-unreadable', message: issue.message })
  else {
    const block = extractEvalBlock(issue.body)
    const parsed = block.refusals ? block : parseTomlSubset(block.text)
    request = parsed.refusals ? parsed : validateRequest(parsed.settings)
    if (request.refusals) refusals.push(...request.refusals)
  }
  const admission = admitCohorts({ baseline, candidates })
  refusals.push(...admission.refusals)
  if (request?.settings && admission.identity) refusals.push(...checkRequest(request.settings, admission.identity))
  if (refusals.length) return emit(refusals, 1)
  const compares = []
  for (const plan of planCompares(request.settings, identityOf(baseline.reps[0]), admission.identity)) {
    const main = github.resolveMain(plan.repo, { exec, now })
    if (!main.ok) {
      refusals.push({ code: 'github-compare-failed', message: `${plan.repo} ${plan.base}...${plan.head}: main resolution failed: ${main.message}` }); continue
    }
    const perform = range => {
      const result = github.compare(range.repo, range.base, range.head, { exec })
      if (!result.ok) refusals.push({ code: 'github-compare-failed', message: `${range.repo} ${range.base}...${range.head}: ${result.message}` })
      else compares.push({ ...range, ...result, main_sha: main.sha, resolved_at: main.resolved_at })
      return result
    }
    const range = { ...plan, base: plan.base === 'main' ? main.sha : plan.base }
    const result = perform(range)
    if (result.ok && plan.kind === 'primary' && result.merge_base !== plan.baseline_commit) perform({ repo: plan.repo, kind: 'main-moved', base: plan.baseline_commit, head: result.merge_base })
  }
  if (refusals.length) return emit(refusals, 1)
  const report = buildReport({ baseline, candidates, roleCosts: costs, request, compares, eval_issue: args.evalIssue, baseline_mismatches: admission.baseline_mismatches })
  stdout(args.json ? JSON.stringify(report, null, 2) + '\n' : formatMarkdown(report))
  return { exitCode: 0, errors: [], report }
}

// Compare real paths so the command also runs when invoked through a symlink.
function invokedDirectly() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (invokedDirectly()) {
  const outcome = await runExperimentsCommand({ argv: process.argv.slice(2) })
  process.exitCode = outcome.exitCode
}
