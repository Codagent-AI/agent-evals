#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { createAxiBrowserDriver } from './lib/axi-browser-driver.mjs'
import { runBrowserEvaluation } from './lib/browser-eval.mjs'
import { goldenHash, IN_SCOPE_IDS, sourceHashes } from './lib/corpus.mjs'
import { writeJsonAtomic } from './lib/persistence.mjs'

function outcome(entry) { return entry?.verdict === null || entry?.observed === false ? 'not-observed' : entry?.verdict }
function pin(source, name) { return source.match(new RegExp(`${name}="\\$\\{${name}:-([^}]+)\\}"`))?.[1] ?? 'unknown' }
function version(command, args = ['--version']) { try { return execFileSync(command, args, { encoding: 'utf8' }).trim() || 'unknown' } catch { return 'unknown' } }

export async function replayCandidate({ candidateId, baseUrl, suiteRoot = fileURLToPath(new URL('.', import.meta.url)), sourceRoot = suiteRoot, driverFactory = ({ baseUrl: url }) => createAxiBrowserDriver({ baseUrl: url }), evaluate = ({ driver, revision }) => runBrowserEvaluation({ driver, revision, evidenceArtifacts: { probe: (id) => `corpus-replay:${id}`, verification: 'corpus-replay:verification' }, build: { ok: true, log: 'built before corpus replay' }, verification: { machine_readable: true, passed: true, artifact: 'fixed corpus replay verification stub' } }), probe, fetchFn = fetch } = {}) {
  let corpus
  try { corpus = JSON.parse(await readFile(join(suiteRoot, 'corpus/candidates.json'), 'utf8')) } catch (error) { throw new Error(`cannot read corpus: ${error.message}`) }
  const candidate = corpus.candidates.find((entry) => entry.id === candidateId)
  if (!candidate) throw new Error(`unknown candidate ${candidateId}`)
  let served
  try {
    if (probe && !await probe(baseUrl)) throw new Error('candidate unavailable')
    const response = await fetchFn(new URL('/build-info.json', baseUrl))
    if (!response.ok) throw new Error('candidate revision unavailable')
    served = await response.json()
    if (served?.revision !== candidate.revision) throw new Error('served candidate revision mismatch')
  } catch (error) {
    return { ok: false, kind: 'candidate unavailable', report: `${candidateId}: candidate unavailable at ${baseUrl}: ${error.message}` }
  }
  let evaluation
  try { evaluation = await evaluate({ driver: driverFactory({ baseUrl }), revision: candidate.revision }) } catch (error) { return { ok: false, kind: 'harness failure', report: `${candidateId}: harness failure: ${error.message}` } }
  const entries = new Map([...evaluation.criteria ?? [], ...evaluation.gates ?? []].map((entry) => [entry.id, entry]))
  const replayed = Object.fromEntries(IN_SCOPE_IDS.map((id) => [id, { outcome: outcome(entries.get(id)), observation: String(entries.get(id)?.rationale ?? '').slice(0, 200), observations: entries.get(id)?.observations ?? null }]))
  const differences = IN_SCOPE_IDS.filter((id) => replayed[id].outcome !== candidate.golden[id].outcome).map((id) => `${candidate.id} ${id}: golden=${candidate.golden[id].outcome} replayed=${replayed[id].outcome} rationale=${replayed[id].observation}`)
  const runSh = await readFile(join(suiteRoot, 'run.sh'), 'utf8').catch(() => '')
  const record = { schema_version: 1, candidate: candidate.id, revision: served.revision, outcomes: replayed, source_hashes: Object.fromEntries(await sourceHashes({ suiteRoot: sourceRoot })), golden_sha256: goldenHash(candidate.golden), pins: { FIXTURE_REF: pin(runSh, 'FIXTURE_REF'), REFERENCE_REF: pin(runSh, 'REFERENCE_REF') }, node: process.version, 'chrome-devtools-axi': version('chrome-devtools-axi'), browser: 'unknown', replayed_at: new Date().toISOString() }
  await mkdir(join(suiteRoot, 'corpus/replays'), { recursive: true })
  await writeJsonAtomic(join(suiteRoot, 'corpus/replays', `${candidate.id}.json`), record)
  return { ok: differences.length === 0, differences, report: differences.join('\n'), record }
}

async function main() {
  const args = process.argv.slice(2); const at = (flag) => args[args.indexOf(flag) + 1]
  if (args.includes('--candidate')) { const result = await replayCandidate({ candidateId: at('--candidate'), baseUrl: at('--base-url') }); console.log(result.report || 'replay matched golden verdicts'); process.exitCode = result.ok ? 0 : 1; return }
  if (args.includes('--all')) { const map = JSON.parse(await readFile(at('--all'), 'utf8')); const corpus = JSON.parse(await readFile(new URL('./corpus/candidates.json', import.meta.url), 'utf8')); const expected = corpus.candidates.map((candidate) => candidate.id); if (!map || Array.isArray(map) || typeof map !== 'object' || Object.keys(map).length !== expected.length || expected.some((id) => !Object.hasOwn(map, id) || typeof map[id] !== 'string' || !map[id])) throw new Error('--all requires a URL for every corpus candidate'); let failed = false; for (const [candidateId, baseUrl] of Object.entries(map)) { const result = await replayCandidate({ candidateId, baseUrl }); console.log(result.report || `${candidateId}: replay matched golden verdicts`); failed ||= !result.ok } process.exitCode = failed ? 1 : 0; return }
  throw new Error('usage: corpus-replay.mjs --candidate <id> --base-url <url> | --all <map.json>')
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1 })
