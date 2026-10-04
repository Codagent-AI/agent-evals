#!/usr/bin/env node
import { mkdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJson, writeJsonAtomic } from './lib/persistence.mjs'
import { SOURCES, emptyRecord, validateRecord, extractRepetition, applySet, applyAddRep, applyAnchor, formatShow } from './lib/experiment-baseline.mjs'

const defaultRecord = fileURLToPath(new URL('./experiments/baseline.json', import.meta.url))
const usage = `Usage: experiments.mjs baseline <command> [options]
  baseline set <result-dir>... --source <accepted-candidate|profile-change|manual> --reason <text> [--allow-mismatch <reason>] [--record <path>]
  baseline add-rep <result-dir> [--allow-mismatch <reason>] [--record <path>]
  baseline anchor --from-current --reason <text> [--record <path>]
  baseline show [--record <path>]
  baseline --help
`

export function parseArgs(argv) {
  if (argv[0] !== 'baseline') throw Error('Expected baseline command')
  const command = argv[1]
  if (argv.includes('--help')) return { help: true }
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

export async function runExperimentsCommand({ argv, now = () => new Date(), stdout = s => process.stdout.write(s), write = writeJsonAtomic } = {}) {
  const errors = []
  const error = (code, message, exitCode) => { const item = { code, message }; errors.push(item); process.stderr.write(`${JSON.stringify(item)}\n`); return { exitCode, errors } }
  let args
  try { args = parseArgs(argv) } catch (cause) { stdout(usage); return error('invalid-arguments', cause.message, 2) }
  if (args.help) { stdout(usage); return { exitCode: 0, errors } }
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
        items.push({ entry: null, refusals: [{ directory, run_id: null, code, message: `${directory}/result.json: ${cause.message}` }] })
        continue
      }
      items.push(extractRepetition(result, { directory, addedAt: now().toISOString(), addedBy: args.command }))
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outcome = await runExperimentsCommand({ argv: process.argv.slice(2) })
  process.exitCode = outcome.exitCode
}
