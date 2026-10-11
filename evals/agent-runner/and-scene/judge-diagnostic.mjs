#!/usr/bin/env node
// Compares job-filtered judging diagnostics with expected verdicts.
//
//   node evals/agent-runner/and-scene/judge-diagnostic.mjs --expected <file> <run-dir>...
//
// Each run directory is one repeat of `run.sh --rescore-from … --judge-jobs …
// --expected <file>`. Every directory must have recorded this exact file's
// SHA-256, or nothing is reported. For every judged criterion in every repeat
// it prints the verdict, its judging basis, and whether it matches.
// Exit status: 0 when every expected verdict matched, 1 when one did not or was
// not judged, 2 when the inputs are refused.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { compareDiagnostics, renderDiagnosticComparison } from './lib/judge-diagnostic.mjs'

export async function main(args, { stdout = process.stdout } = {}) {
  const index = args.indexOf('--expected')
  if (index === -1 || !args[index + 1]) throw new Error('usage: judge-diagnostic.mjs --expected <file> <run-dir>...')
  const expectedPath = resolve(args[index + 1])
  const runDirs = args.filter((_, position) => position !== index && position !== index + 1).map((dir) => resolve(dir))
  if (runDirs.length === 0) throw new Error('usage: judge-diagnostic.mjs --expected <file> <run-dir>...')
  const report = await compareDiagnostics({ expectedPath, runDirs })
  stdout.write(renderDiagnosticComparison(report))
  const { expected, matched } = report.summary
  return matched === expected ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
