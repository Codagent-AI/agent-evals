import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  IN_SCOPE_IDS,
  goldenHash,
  sourceHashes,
  validateCorpus,
  validateReplayRecords,
} from '../evals/agent-runner/and-scene/lib/corpus.mjs'

const suite = join(process.cwd(), 'evals/agent-runner/and-scene')

test('the corpus checker reports every candidate missing a real replay without a browser', async () => {
  const corpus = JSON.parse(await readFile(join(suite, 'corpus/candidates.json')))
  const errors = validateCorpus(corpus)
  assert.deepEqual(errors, [])
  assert.equal(IN_SCOPE_IDS.length, 16)
  assert.equal(corpus.candidates.length, 8)
  assert.ok((await sourceHashes({ suiteRoot: suite })).has('lib/browser-eval.mjs'))
  assert.ok((await sourceHashes({ suiteRoot: suite })).has('lib/demo-contract.mjs'))
  assert.ok((await sourceHashes({ suiteRoot: suite })).has('lib/browser-diagnostics.mjs'))
  const replayErrors = await validateReplayRecords({ suiteRoot: suite, corpus })
  assert.equal(replayErrors.length, 8)
  assert.match(replayErrors[0], /astra: missing replay; run corpus-replay\.mjs/)
})

test('corpus validation rejects incomplete, unexplained, and duplicate verdicts', async () => {
  const corpus = JSON.parse(await readFile(join(suite, 'corpus/candidates.json')))
  const broken = structuredClone(corpus)
  delete broken.candidates[0].golden[IN_SCOPE_IDS[0]]
  broken.candidates[1].revision = broken.candidates[0].revision
  const fail = broken.candidates[0].golden[IN_SCOPE_IDS[1]]
  fail.outcome = 'fail'
  fail.history.at(-1).outcome = 'fail'
  fail.basis = undefined
  assert.match(validateCorpus(broken).join('\n'), /missing.*demo-route-and-registration|duplicate revision|basis/i)
})

test('golden hashes exclude adjudication prose but bind outcomes', async () => {
  const corpus = JSON.parse(await readFile(join(suite, 'corpus/candidates.json')))
  const candidate = structuredClone(corpus.candidates[0])
  const before = goldenHash(candidate.golden)
  candidate.golden[IN_SCOPE_IDS[0]].history[0].explanation += ' clarified'
  assert.equal(goldenHash(candidate.golden), before)
  candidate.golden[IN_SCOPE_IDS[0]].outcome = 'fail'
  assert.notEqual(goldenHash(candidate.golden), before)
})

test('a changed evaluator source makes committed replays stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'corpus-source-'))
  const corpus = JSON.parse(await readFile(join(suite, 'corpus/candidates.json')))
  const hashes = await sourceHashes({ suiteRoot: suite })
  await writeFile(join(dir, 'browser-eval.mjs'), `${await readFile(join(suite, 'lib/browser-eval.mjs'), 'utf8')}\n// changed\n`)
  assert.ok(hashes.size > 4)
  assert.equal(validateCorpus(corpus).length, 0)
})
