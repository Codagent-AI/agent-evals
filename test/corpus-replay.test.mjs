import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { replayCandidate } from '../evals/agent-runner/and-scene/corpus-replay.mjs'
import { DETERMINISTIC_BROWSER_CRITERIA } from '../evals/agent-runner/and-scene/lib/browser-eval.mjs'
import { IN_SCOPE_IDS } from '../evals/agent-runner/and-scene/lib/corpus.mjs'

const SUITE = join(process.cwd(), 'evals/agent-runner/and-scene')

// What the production evaluator returns, reduced to the fields a replay reads:
// the scored criteria, then the gates, with the two stub-fed gates last.
function evaluation(outcome = 'pass') {
  const entries = IN_SCOPE_IDS.map((id) => ({
    id,
    verdict: outcome === 'not-observed' ? null : outcome,
    rationale: `${id} rationale`,
    observed: outcome !== 'not-observed',
  }))
  const scored = DETERMINISTIC_BROWSER_CRITERIA.length
  return {
    criteria: entries.slice(0, scored),
    gates: [
      ...entries.slice(scored),
      { id: 'verification-build-whole-app', verdict: 'pass' },
      { id: 'verification-clear-outcome', verdict: 'pass' },
    ],
  }
}

// A one-candidate corpus whose golden verdicts all pass. The replays directory
// is deliberately absent: the first replay of a fresh corpus has none.
async function corpusRoot(revision) {
  const root = await mkdtemp(join(tmpdir(), 'corpus-replay-'))
  await mkdir(join(root, 'corpus'), { recursive: true })
  const golden = Object.fromEntries(IN_SCOPE_IDS.map((id) => [id, {
    outcome: 'pass',
    history: [{ outcome: 'pass', explanation: 'fixture spec heading' }],
  }]))
  await writeFile(join(root, 'corpus/candidates.json'), JSON.stringify({
    schema_version: 1,
    repository: 'x',
    candidates: [{ id: 'one', revision, published_runs: [], golden }],
  }))
  return root
}

const serving = (revision) => async () => ({ ok: true, json: async () => ({ revision }) })

test('replay writes a matching record from injected production evaluation', async () => {
  const revision = 'a'.repeat(40)
  const root = await corpusRoot(revision)
  const result = await replayCandidate({
    candidateId: 'one',
    baseUrl: 'http://served/',
    suiteRoot: root,
    sourceRoot: SUITE,
    fetchFn: serving(revision),
    driverFactory: () => ({}),
    evaluate: async () => evaluation(),
  })

  assert.equal(result.ok, true)
  const record = JSON.parse(await readFile(join(root, 'corpus/replays/one.json')))
  assert.equal(Object.keys(record.outcomes).length, IN_SCOPE_IDS.length)
  assert.ok(record.source_hashes)
})

test('replay reports a disagreement and never records unavailable or harness failures', async () => {
  const revision = 'b'.repeat(40)
  const root = await corpusRoot(revision)
  const flipped = await replayCandidate({
    candidateId: 'one',
    baseUrl: 'http://served/',
    suiteRoot: root,
    sourceRoot: SUITE,
    fetchFn: serving(revision),
    driverFactory: () => ({}),
    evaluate: async () => evaluation('fail'),
  })
  assert.equal(flipped.ok, false)
  assert.match(flipped.report, /one.*demo-route-and-registration/s)

  const unavailable = await replayCandidate({
    candidateId: 'one',
    baseUrl: 'http://gone/',
    suiteRoot: root,
    probe: async () => false,
  })
  assert.equal(unavailable.kind, 'candidate unavailable')
})

test('replay refuses a served revision that does not match the golden candidate', async () => {
  const root = await corpusRoot('c'.repeat(40))
  const result = await replayCandidate({
    candidateId: 'one',
    baseUrl: 'http://served/',
    suiteRoot: root,
    fetchFn: serving('d'.repeat(40)),
  })
  assert.equal(result.kind, 'candidate unavailable')
  assert.match(result.report, /revision mismatch/)
})
