#!/usr/bin/env node
// Replays recorded cross-family-panel-v1 judging through the v2 settlement
// rules, with no model call.
//
//   node evals/agent-runner/and-scene/scripts/replay-settlement.mjs \
//     <judging-records.tar.gz> <raw-logs.tar.gz> [--json]
//
// Each archive is extracted into its own temporary directory. The records
// archive holds one or more run directories with `phases/judges/<job>.json`;
// the raw-log archive holds the same run directories with
// `.runtime/judge-claude/<NN>-<job>.events.jsonl`. The decider's first verdicts
// and spans come from those logs (`replay`). Only an absent raw-log archive, or
// a job with no log, falls back to inferring them (`reconstruction`); a
// malformed or mismatched log fails the replay. lib/settlement-replay.mjs
// documents the log contract. Points use the current automated rubric's
// weights. Exit status: 0 on a report, 2 when the inputs are refused.
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadRubrics } from '../lib/rubric.mjs'
import { renderReplay, replaySettlement } from '../lib/settlement-replay.mjs'

const USAGE = 'usage: replay-settlement.mjs <judging-records.tar.gz> <raw-logs.tar.gz> [--json]'

async function extract(archive) {
  const directory = await mkdtemp(join(tmpdir(), 'and-scene-replay-'))
  const result = spawnSync('tar', ['-xzf', archive, '-C', directory], { encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`cannot extract ${archive}: ${result.error?.message ?? result.stderr.trim()}`)
  }
  return directory
}

const exists = (path) => access(path).then(() => true, () => false)

export async function main(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const json = args.includes('--json')
  const [recordsArchive, rawLogsArchive] = args.filter((arg) => arg !== '--json').map((arg) => resolve(arg))
  if (!recordsArchive) throw new Error(USAGE)
  if (!await exists(recordsArchive)) throw new Error(`the judging-records archive does not exist: ${recordsArchive}`)
  const rawPresent = Boolean(rawLogsArchive) && await exists(rawLogsArchive)
  if (!rawPresent) stderr.write(`raw-log archive absent${rawLogsArchive ? `: ${rawLogsArchive}` : ''}; first decider votes are inferred (reconstruction)\n`)
  const directories = []
  try {
    const recordsDir = await extract(recordsArchive)
    directories.push(recordsDir)
    const rawLogsDir = rawPresent ? await extract(rawLogsArchive) : null
    if (rawLogsDir) directories.push(rawLogsDir)
    const { automated } = await loadRubrics()
    const report = await replaySettlement({ recordsDir, rawLogsDir, rubric: automated })
    stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderReplay(report))
    return 0
  } finally {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
