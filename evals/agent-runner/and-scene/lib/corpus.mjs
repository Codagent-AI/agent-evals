// The golden-verdict corpus: adjudicated outcomes for real candidates, and the
// offline check that a replay was recorded against the current evaluator.
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, normalize, relative } from 'node:path'

import { DETERMINISTIC_BROWSER_CRITERIA } from './browser-eval.mjs'
import { hashString, readJson } from './persistence.mjs'

// The two gates derived from browser observation. The build and verification
// gates are fed fixed inputs during a replay, so they are never golden.
export const IN_SCOPE_IDS = [
  ...DETERMINISTIC_BROWSER_CRITERIA,
  'verification-sample-outline',
  'verification-every-produced-step-renders',
]
const SHA = /^[0-9a-f]{40}$/
const OUTCOMES = new Set(['pass', 'fail', 'not-observed'])
// Everything the evaluator loads is found by walking imports from these.
const SOURCE_ROOTS = [
  'lib/browser-eval.mjs',
  'lib/axi-browser-driver.mjs',
  'lib/corpus.mjs',
  'corpus-replay.mjs',
]
const RUBRIC_FILE = 'automated-rubric.json'

export function goldenOutcomes(golden) {
  return Object.fromEntries(IN_SCOPE_IDS.map((id) => [id, golden?.[id]?.outcome]))
}

// Outcomes only: adding a basis or an explanation must not stale a replay.
export function goldenHash(golden) {
  return hashString(JSON.stringify(goldenOutcomes(golden)))
}

function verdictErrors(label, id, verdict) {
  if (!verdict) return [`${label}: missing ${id}`]
  const errors = []
  if (!OUTCOMES.has(verdict.outcome)) errors.push(`${label}: ${id} has invalid outcome`)
  const needsBasis = verdict.outcome === 'fail' || verdict.outcome === 'not-observed'
  if (needsBasis && !verdict.basis?.source) errors.push(`${label}: ${id} requires basis`)
  if (!Array.isArray(verdict.history) || verdict.history.length === 0) {
    return [...errors, `${label}: ${id} requires history`]
  }
  // The current outcome has to be the latest recorded one, so a golden verdict
  // cannot change without an explanation of why.
  if (verdict.history.at(-1)?.outcome !== verdict.outcome) {
    errors.push(`${label}: ${id} outcome does not match latest history`)
  }
  for (const entry of verdict.history) {
    if (!entry?.explanation?.trim()) errors.push(`${label}: ${id} history needs explanation`)
  }
  return errors
}

export function validateCorpus(corpus) {
  if (corpus?.schema_version !== 1 || !Array.isArray(corpus?.candidates)) {
    return ['corpus has invalid schema']
  }
  const errors = []
  const revisions = new Set()
  for (const candidate of corpus.candidates) {
    const label = candidate?.id ?? 'unknown candidate'
    if (!SHA.test(candidate?.revision ?? '')) errors.push(`${label}: invalid full revision`)
    if (revisions.has(candidate?.revision)) {
      errors.push(`${label}: duplicate revision ${candidate.revision}`)
    }
    revisions.add(candidate?.revision)
    for (const id of IN_SCOPE_IDS) errors.push(...verdictErrors(label, id, candidate?.golden?.[id]))
  }
  return errors
}

function relativeImports(source) {
  const pattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g
  return [...source.matchAll(pattern)].map((match) => match[1])
}

// A static walk of relative imports: the suite has no dynamic imports on the
// evaluator path, and the corpus test asserts the known core modules are found.
export async function sourceHashes({ suiteRoot }) {
  const found = new Map()
  async function walk(file) {
    if (found.has(file)) return
    const source = await readFile(join(suiteRoot, file), 'utf8')
    found.set(file, hashString(source))
    for (const specifier of relativeImports(source)) {
      const resolved = join(dirname(join(suiteRoot, file)), specifier)
      const target = normalize(relative(suiteRoot, resolved))
      await walk(target.endsWith('.mjs') ? target : `${target}.mjs`)
    }
  }
  for (const root of SOURCE_ROOTS) await walk(root)
  found.set(RUBRIC_FILE, hashString(await readFile(join(suiteRoot, RUBRIC_FILE))))
  return found
}

function replayErrors(candidate, record, hashes) {
  const stale = (message) => `${candidate.id}: ${message}; run corpus-replay.mjs`
  const errors = []
  if (record.revision !== candidate.revision) errors.push(stale('replay revision differs'))
  if (record.golden_sha256 !== goldenHash(candidate.golden)) {
    errors.push(stale('golden verdict changed'))
  }
  for (const [file, hash] of Object.entries(hashes)) {
    if (record.source_hashes?.[file] !== hash) errors.push(stale(`${file} is stale`))
  }
  for (const id of IN_SCOPE_IDS) {
    const replayed = record.outcomes?.[id]
    if (!replayed) errors.push(stale(`${id} missing replay outcome`))
    else if (replayed.outcome !== candidate.golden[id].outcome) {
      errors.push(stale(`${id} replay differs from golden`))
    }
  }
  return errors
}

export async function validateReplayRecords({ suiteRoot, corpus }) {
  const errors = validateCorpus(corpus)
  if (errors.length) return errors
  const hashes = Object.fromEntries(await sourceHashes({ suiteRoot }))
  for (const candidate of corpus.candidates) {
    const record = await readJson(join(suiteRoot, 'corpus/replays', `${candidate.id}.json`), null)
      .catch(() => null)
    if (!record) errors.push(`${candidate.id}: missing replay; run corpus-replay.mjs`)
    else errors.push(...replayErrors(candidate, record, hashes))
  }
  return errors
}

async function publishedRuns(suiteRoot) {
  try {
    const entries = await readdir(join(suiteRoot, 'results'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort()
  } catch {
    return []
  }
}

// Published results are read, never written: they say which candidate revisions
// the corpus owes a golden verdict to.
export async function validatePublishedCoverage({ suiteRoot, corpus }) {
  const errors = []
  const byRevision = new Map((corpus?.candidates ?? []).map((candidate) => [candidate.revision, candidate]))
  for (const run of await publishedRuns(suiteRoot)) {
    const result = await readJson(join(suiteRoot, 'results', run, 'result.json'), null).catch(() => null)
    if (!result) continue
    const revision = result.delivery?.pull_request?.head_sha
    if (!SHA.test(revision ?? '')) {
      errors.push(`${run}: published result records no candidate revision`)
      continue
    }
    const candidate = byRevision.get(revision)
    if (!candidate) errors.push(`${run}: revision ${revision} has no corpus candidate`)
    else if (!(candidate.published_runs ?? []).includes(run)) {
      errors.push(`${candidate.id}: published_runs omits ${run}`)
    }
  }
  return errors
}
