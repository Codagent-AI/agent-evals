import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, normalize, relative } from 'node:path'

import { DETERMINISTIC_BROWSER_CRITERIA } from './browser-eval.mjs'

export const IN_SCOPE_IDS = [...DETERMINISTIC_BROWSER_CRITERIA, 'verification-sample-outline', 'verification-every-produced-step-renders']
const SHA = /^[0-9a-f]{40}$/
const outcomes = new Set(['pass', 'fail', 'not-observed'])

export function goldenOutcomes(golden) {
  return Object.fromEntries(IN_SCOPE_IDS.map((id) => [id, golden?.[id]?.outcome]))
}

export function goldenHash(golden) {
  return createHash('sha256').update(JSON.stringify(goldenOutcomes(golden))).digest('hex')
}

export function validateCorpus(corpus) {
  const errors = []
  if (corpus?.schema_version !== 1 || !Array.isArray(corpus?.candidates)) return ['corpus has invalid schema']
  const revisions = new Set()
  for (const candidate of corpus.candidates) {
    const label = candidate?.id ?? 'unknown candidate'
    if (!SHA.test(candidate?.revision ?? '')) errors.push(`${label}: invalid full revision`)
    if (revisions.has(candidate?.revision)) errors.push(`${label}: duplicate revision ${candidate.revision}`)
    revisions.add(candidate?.revision)
    for (const id of IN_SCOPE_IDS) {
      const verdict = candidate?.golden?.[id]
      if (!verdict) { errors.push(`${label}: missing ${id}`); continue }
      if (!outcomes.has(verdict.outcome)) errors.push(`${label}: ${id} has invalid outcome`)
      if ((verdict.outcome === 'fail' || verdict.outcome === 'not-observed') && !verdict.basis?.source) errors.push(`${label}: ${id} requires basis`)
      if (!Array.isArray(verdict.history) || verdict.history.length === 0) { errors.push(`${label}: ${id} requires history`); continue }
      const latest = verdict.history.at(-1)
      if (latest?.outcome !== verdict.outcome) errors.push(`${label}: ${id} outcome does not match latest history`)
      for (const history of verdict.history) if (!history?.explanation?.trim()) errors.push(`${label}: ${id} history needs explanation`)
    }
  }
  return errors
}

function relativeImports(source) {
  return [...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)].map((match) => match[1])
}

export async function sourceHashes({ suiteRoot }) {
  const roots = ['lib/browser-eval.mjs', 'lib/axi-browser-driver.mjs', 'lib/corpus.mjs', 'corpus-replay.mjs']
  const found = new Map()
  async function walk(file) {
    if (found.has(file)) return
    const source = await readFile(join(suiteRoot, file), 'utf8')
    found.set(file, createHash('sha256').update(source).digest('hex'))
    for (const specifier of relativeImports(source)) {
      let target = normalize(relative(suiteRoot, join(dirname(join(suiteRoot, file)), specifier)))
      if (!target.endsWith('.mjs')) target += '.mjs'
      await walk(target)
    }
  }
  for (const root of roots) await walk(root)
  const rubric = await readFile(join(suiteRoot, 'automated-rubric.json'))
  found.set('automated-rubric.json', createHash('sha256').update(rubric).digest('hex'))
  return found
}

export async function validateReplayRecords({ suiteRoot, corpus }) {
  const errors = validateCorpus(corpus)
  if (errors.length) return errors
  const hashes = Object.fromEntries(await sourceHashes({ suiteRoot }))
  for (const candidate of corpus.candidates) {
    let record
    try { record = JSON.parse(await readFile(join(suiteRoot, 'corpus/replays', `${candidate.id}.json`), 'utf8')) } catch { errors.push(`${candidate.id}: missing replay; run corpus-replay.mjs`); continue }
    if (record.revision !== candidate.revision) errors.push(`${candidate.id}: replay revision differs; run corpus-replay.mjs`)
    if (record.golden_sha256 !== goldenHash(candidate.golden)) errors.push(`${candidate.id}: golden verdict changed; run corpus-replay.mjs`)
    for (const [file, hash] of Object.entries(hashes)) if (record.source_hashes?.[file] !== hash) errors.push(`${candidate.id}: ${file} is stale; run corpus-replay.mjs`)
    for (const id of IN_SCOPE_IDS) {
      if (!record.outcomes?.[id]) errors.push(`${candidate.id}: ${id} missing replay outcome; run corpus-replay.mjs`)
      else if (record.outcomes[id].outcome !== candidate.golden[id].outcome) errors.push(`${candidate.id}: ${id} replay differs from golden; run corpus-replay.mjs`)
    }
  }
  return errors
}

// Published results are read, never written: they say which candidate revisions
// the corpus owes a golden verdict to.
export async function validatePublishedCoverage({ suiteRoot, corpus }) {
  const errors = []
  const byRevision = new Map((corpus?.candidates ?? []).map((candidate) => [candidate.revision, candidate]))
  let runs = []
  try { runs = (await readdir(join(suiteRoot, 'results'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort() } catch { return errors }
  for (const run of runs) {
    let result
    try { result = JSON.parse(await readFile(join(suiteRoot, 'results', run, 'result.json'), 'utf8')) } catch { continue }
    const revision = result?.delivery?.pull_request?.head_sha
    if (!SHA.test(revision ?? '')) { errors.push(`${run}: published result records no candidate revision`); continue }
    const candidate = byRevision.get(revision)
    if (!candidate) { errors.push(`${run}: revision ${revision} has no corpus candidate`); continue }
    if (!(candidate.published_runs ?? []).includes(run)) errors.push(`${candidate.id}: published_runs omits ${run}`)
  }
  return errors
}
