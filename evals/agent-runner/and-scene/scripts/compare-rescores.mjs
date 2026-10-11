#!/usr/bin/env node
// Compares rescores of the same code and attributes every verdict flip.
//
//   node evals/agent-runner/and-scene/scripts/compare-rescores.mjs \
//     --rep <label> <rescore-dir> <rescore-dir> [<rescore-dir>...] \
//     [--rep <label> <rescore-dir>...] [--blocker-rep <label>] [--json]
//
// Each --rep names the rescores of one retained rep; every pair of them is
// compared. Per pair it reports total flipped points (every changed verdict's
// points, so opposing flips never cancel; engineering quality separately),
// points by attribution class (settlement, seat-noise, mixed), and gate, floor
// and eligibility changes; per rep, per-criterion disagreement counts with
// their denominators. --blocker-rep names the rep whose settlement and mixed
// points, excluding engineering quality, block merge above 1.0 in any pair
// (#78 rep 2 for the followups change). Exit status: 0, 1 when merge is
// blocked, 2 when the inputs are refused.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { blockerCheck, compareRep, loadRescore, renderComparison } from '../lib/flip-attribution.mjs'

const USAGE = 'usage: compare-rescores.mjs --rep <label> <rescore-dir> <rescore-dir>... [--blocker-rep <label>] [--json]'

export function parseCompareArgs(args) {
  const reps = []
  let blockerRep = null
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') json = true
    else if (argument === '--blocker-rep') blockerRep = args[++index] ?? null
    else if (argument === '--rep') reps.push({ label: args[++index], dirs: [] })
    else if (reps.length > 0 && !argument.startsWith('--')) reps.at(-1).dirs.push(resolve(argument))
    else throw new Error(USAGE)
  }
  if (reps.length === 0 || reps.some(({ label, dirs }) => !label || dirs.length < 2)) {
    throw new Error(`${USAGE}\neach --rep needs a label and at least two rescore directories`)
  }
  if (new Set(reps.map(({ label }) => label)).size !== reps.length) throw new Error('each --rep label must be unique')
  if (blockerRep !== null && !reps.some(({ label }) => label === blockerRep)) {
    throw new Error(`--blocker-rep ${blockerRep} names no --rep`)
  }
  return { reps, blockerRep, json }
}

export async function main(args, { stdout = process.stdout } = {}) {
  const { reps, blockerRep, json } = parseCompareArgs(args)
  const reports = []
  for (const { label, dirs } of reps) {
    const rescores = []
    for (const dir of dirs) rescores.push(await loadRescore(dir, dir))
    reports.push(compareRep(label, rescores))
  }
  const blocker = blockerRep === null ? null : blockerCheck(reports.find(({ rep }) => rep === blockerRep))
  stdout.write(json ? `${JSON.stringify({ reps: reports, blocker }, null, 2)}\n` : renderComparison({ reps: reports, blocker }))
  return blocker?.blocked ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
