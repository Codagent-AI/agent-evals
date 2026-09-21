#!/usr/bin/env node
// Replays the production deterministic evaluator against one already built and
// served corpus candidate, compares every outcome with its golden verdict, and
// writes the replay record that `npm run check` later verifies offline.
//
// Building and serving stay outside this command, as they do for the pinned
// reference regression. Candidates are replayed one at a time: they share Chrome.
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createAxiBrowserDriver } from './lib/axi-browser-driver.mjs'
import { runBrowserEvaluation } from './lib/browser-eval.mjs'
import { goldenHash, IN_SCOPE_IDS, sourceHashes } from './lib/corpus.mjs'
import { readJson, writeJsonAtomic } from './lib/persistence.mjs'
import { runShPin } from './lib/pins.mjs'

const SUITE_DIR = fileURLToPath(new URL('.', import.meta.url))
const USAGE = 'usage: corpus-replay.mjs --candidate <id> --base-url <url> | --all <map.json>'
const MAX_OBSERVATION_CHARS = 200

function outcomeOf(entry) {
  return entry?.verdict === null || entry?.observed === false ? 'not-observed' : entry?.verdict
}

function toolVersion(command) {
  try {
    return execFileSync(command, ['--version'], { encoding: 'utf8' }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

// The build and verification gates are fed fixed inputs, so they are recorded
// by the evaluator but never compared with a golden verdict.
function evaluateProduction({ driver, revision }) {
  return runBrowserEvaluation({
    driver,
    revision,
    evidenceArtifacts: {
      probe: (id) => `corpus-replay:${id}`,
      verification: 'corpus-replay:verification',
    },
    build: { ok: true, log: 'built before corpus replay' },
    verification: {
      machine_readable: true,
      passed: true,
      artifact: 'fixed corpus replay verification stub',
    },
  })
}

// A served build has to say which revision it is, so the wrong worktree cannot
// be replayed against another candidate's golden verdicts by mistake.
async function servedRevision({ baseUrl, probe, fetchFn }) {
  if (probe && !await probe(baseUrl)) throw new Error('candidate unavailable')
  const response = await fetchFn(new URL('/build-info.json', baseUrl))
  if (!response.ok) throw new Error('candidate revision unavailable')
  return (await response.json())?.revision
}

function describeDifference(candidate, id, replayed) {
  return `${candidate.id} ${id}: golden=${candidate.golden[id].outcome} `
    + `replayed=${replayed.outcome} rationale=${replayed.observation}`
}

export async function replayCandidate({
  candidateId,
  baseUrl,
  suiteRoot = SUITE_DIR,
  sourceRoot = suiteRoot,
  driverFactory = ({ baseUrl: url }) => createAxiBrowserDriver({ baseUrl: url }),
  evaluate = evaluateProduction,
  probe,
  fetchFn = fetch,
} = {}) {
  let corpus
  try {
    corpus = await readJson(join(suiteRoot, 'corpus/candidates.json'))
  } catch (error) {
    throw new Error(`cannot read corpus: ${error.message}`)
  }
  const candidate = corpus.candidates.find((entry) => entry.id === candidateId)
  if (!candidate) throw new Error(`unknown candidate ${candidateId}`)

  try {
    const revision = await servedRevision({ baseUrl, probe, fetchFn })
    if (revision !== candidate.revision) throw new Error('served candidate revision mismatch')
  } catch (error) {
    return {
      ok: false,
      kind: 'candidate unavailable',
      report: `${candidateId}: candidate unavailable at ${baseUrl}: ${error.message}`,
    }
  }

  let evaluation
  try {
    evaluation = await evaluate({ driver: driverFactory({ baseUrl }), revision: candidate.revision })
  } catch (error) {
    return { ok: false, kind: 'harness failure', report: `${candidateId}: harness failure: ${error.message}` }
  }

  const entries = new Map(
    [...evaluation.criteria ?? [], ...evaluation.gates ?? []].map((entry) => [entry.id, entry]),
  )
  const outcomes = Object.fromEntries(IN_SCOPE_IDS.map((id) => {
    const entry = entries.get(id)
    return [id, {
      outcome: outcomeOf(entry),
      observation: String(entry?.rationale ?? '').slice(0, MAX_OBSERVATION_CHARS),
      observations: entry?.observations ?? null,
    }]
  }))
  const differences = IN_SCOPE_IDS
    .filter((id) => outcomes[id].outcome !== candidate.golden[id].outcome)
    .map((id) => describeDifference(candidate, id, outcomes[id]))

  const pin = (name) => runShPin(name, { suiteRoot }).catch(() => 'unknown')
  const record = {
    schema_version: 1,
    candidate: candidate.id,
    revision: candidate.revision,
    outcomes,
    source_hashes: Object.fromEntries(await sourceHashes({ suiteRoot: sourceRoot })),
    golden_sha256: goldenHash(candidate.golden),
    pins: { FIXTURE_REF: await pin('FIXTURE_REF'), REFERENCE_REF: await pin('REFERENCE_REF') },
    node: process.version,
    'chrome-devtools-axi': toolVersion('chrome-devtools-axi'),
    browser: 'unknown',
    replayed_at: new Date().toISOString(),
  }
  await mkdir(join(suiteRoot, 'corpus/replays'), { recursive: true })
  await writeJsonAtomic(join(suiteRoot, 'corpus/replays', `${candidate.id}.json`), record)
  return { ok: differences.length === 0, differences, report: differences.join('\n'), record }
}

// `--all` takes a JSON object of candidate id to base URL and must name every
// corpus candidate, so a partial replay cannot pass for a complete one.
async function replayAll(mapPath) {
  const map = await readJson(mapPath)
  const corpus = await readJson(join(SUITE_DIR, 'corpus/candidates.json'))
  const expected = corpus.candidates.map((candidate) => candidate.id)
  const isUrlMap = map && typeof map === 'object' && !Array.isArray(map)
  const coversCorpus = isUrlMap
    && Object.keys(map).length === expected.length
    && expected.every((id) => typeof map[id] === 'string' && map[id])
  if (!coversCorpus) throw new Error('--all requires a URL for every corpus candidate')

  let failed = false
  for (const [candidateId, baseUrl] of Object.entries(map)) {
    const result = await replayCandidate({ candidateId, baseUrl })
    console.log(result.report || `${candidateId}: replay matched golden verdicts`)
    failed ||= !result.ok
  }
  return !failed
}

async function main() {
  const args = process.argv.slice(2)
  const valueOf = (flag) => args[args.indexOf(flag) + 1]
  if (args.includes('--candidate')) {
    const result = await replayCandidate({
      candidateId: valueOf('--candidate'),
      baseUrl: valueOf('--base-url'),
    })
    console.log(result.report || 'replay matched golden verdicts')
    process.exitCode = result.ok ? 0 : 1
    return
  }
  if (args.includes('--all')) {
    process.exitCode = await replayAll(valueOf('--all')) ? 0 : 1
    return
  }
  throw new Error(USAGE)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
