import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { replayCandidate } from '../evals/agent-runner/and-scene/corpus-replay.mjs'
import { IN_SCOPE_IDS } from '../evals/agent-runner/and-scene/lib/corpus.mjs'

function evaluation(outcome = 'pass') {
  const entries = IN_SCOPE_IDS.map((id) => ({ id, verdict: outcome === 'not-observed' ? null : outcome, rationale: `${id} rationale`, observed: outcome !== 'not-observed' }))
  return { criteria: entries.slice(0, 14), gates: entries.slice(14).concat([{ id: 'verification-build-whole-app', verdict: 'pass' }, { id: 'verification-clear-outcome', verdict: 'pass' }]) }
}

// The first replay of a fresh corpus has no replays directory yet.
test('replay writes a matching record from injected production evaluation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'corpus-replay-'))
  await mkdir(join(root, 'corpus'), { recursive: true })
  const golden = Object.fromEntries(IN_SCOPE_IDS.map((id) => [id, { outcome: 'pass', history: [{ outcome: 'pass', explanation: 'fixture spec heading' }] }]))
  await writeFile(join(root, 'corpus/candidates.json'), JSON.stringify({ schema_version: 1, repository: 'x', candidates: [{ id: 'one', revision: 'a'.repeat(40), published_runs: [], golden }] }))
  const result = await replayCandidate({ candidateId: 'one', baseUrl: 'http://served/', suiteRoot: root, sourceRoot: join(process.cwd(), 'evals/agent-runner/and-scene'), fetchFn: async () => ({ ok: true, json: async () => ({ revision: 'a'.repeat(40) }) }), driverFactory: () => ({}), evaluate: async () => evaluation() })
  assert.equal(result.ok, true)
  const record = JSON.parse(await readFile(join(root, 'corpus/replays/one.json')))
  assert.equal(Object.keys(record.outcomes).length, 16)
  assert.ok(record.source_hashes)
})

test('replay reports a disagreement and never records unavailable or harness failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'corpus-replay-'))
  await mkdir(join(root, 'corpus/replays'), { recursive: true })
  const golden = Object.fromEntries(IN_SCOPE_IDS.map((id) => [id, { outcome: 'pass', history: [{ outcome: 'pass', explanation: 'fixture spec heading' }] }]))
  await writeFile(join(root, 'corpus/candidates.json'), JSON.stringify({ schema_version: 1, repository: 'x', candidates: [{ id: 'one', revision: 'b'.repeat(40), published_runs: [], golden }] }))
  const flipped = await replayCandidate({ candidateId: 'one', baseUrl: 'http://served/', suiteRoot: root, sourceRoot: join(process.cwd(), 'evals/agent-runner/and-scene'), fetchFn: async () => ({ ok: true, json: async () => ({ revision: 'b'.repeat(40) }) }), driverFactory: () => ({}), evaluate: async () => evaluation('fail') })
  assert.equal(flipped.ok, false); assert.match(flipped.report, /one.*demo-route-and-registration/s)
  const unavailable = await replayCandidate({ candidateId: 'one', baseUrl: 'http://gone/', suiteRoot: root, probe: async () => false })
  assert.equal(unavailable.kind, 'candidate unavailable')
})

test('replay refuses a served revision that does not match the golden candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'corpus-replay-'))
  await mkdir(join(root, 'corpus/replays'), { recursive: true })
  const golden = Object.fromEntries(IN_SCOPE_IDS.map((id) => [id, { outcome: 'pass', history: [{ outcome: 'pass', explanation: 'fixture spec heading' }] }]))
  await writeFile(join(root, 'corpus/candidates.json'), JSON.stringify({ schema_version: 1, repository: 'x', candidates: [{ id: 'one', revision: 'c'.repeat(40), published_runs: [], golden }] }))
  const result = await replayCandidate({ candidateId: 'one', baseUrl: 'http://served/', suiteRoot: root, fetchFn: async () => ({ ok: true, json: async () => ({ revision: 'd'.repeat(40) }) }) })
  assert.equal(result.kind, 'candidate unavailable')
  assert.match(result.report, /revision mismatch/)
})
