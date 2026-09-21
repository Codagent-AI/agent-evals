import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  IN_SCOPE_IDS,
  goldenHash,
  sourceHashes,
  validateCorpus,
  validatePublishedCoverage,
  validateReplayRecords,
} from '../evals/agent-runner/and-scene/lib/corpus.mjs'

const suite = join(process.cwd(), 'evals/agent-runner/and-scene')

async function loadCorpus() {
  return JSON.parse(await readFile(join(suite, 'corpus/candidates.json'), 'utf8'))
}

test('the committed corpus is current and replayed, checked without a browser', async () => {
  const corpus = await loadCorpus()
  const errors = validateCorpus(corpus)
  assert.deepEqual(errors, [])
  assert.equal(IN_SCOPE_IDS.length, 16)
  assert.equal(corpus.candidates.length, 8)
  assert.ok((await sourceHashes({ suiteRoot: suite })).has('lib/browser-eval.mjs'))
  assert.ok((await sourceHashes({ suiteRoot: suite })).has('lib/demo-contract.mjs'))
  assert.ok((await sourceHashes({ suiteRoot: suite })).has('lib/browser-diagnostics.mjs'))
  assert.deepEqual(await validateReplayRecords({ suiteRoot: suite, corpus }), [])
})

test('a candidate with no replay record tells the maintainer to run the replay', async () => {
  const corpus = await loadCorpus()
  const unreplayed = structuredClone(corpus)
  unreplayed.candidates[0].id = 'never-replayed'
  const errors = await validateReplayRecords({ suiteRoot: suite, corpus: unreplayed })
  assert.deepEqual(errors, ['never-replayed: missing replay; run corpus-replay.mjs'])
})

test('corpus validation rejects incomplete, unexplained, and duplicate verdicts', async () => {
  const corpus = await loadCorpus()
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
  const corpus = await loadCorpus()
  const candidate = structuredClone(corpus.candidates[0])
  const before = goldenHash(candidate.golden)
  candidate.golden[IN_SCOPE_IDS[0]].history[0].explanation += ' clarified'
  assert.equal(goldenHash(candidate.golden), before)
  candidate.golden[IN_SCOPE_IDS[0]].outcome = 'fail'
  assert.notEqual(goldenHash(candidate.golden), before)
})

// A private copy of the suite, so a source file can be edited without touching
// the real one. Published results are large and irrelevant to staleness.
async function suiteCopy() {
  const dir = await mkdtemp(join(tmpdir(), 'corpus-suite-'))
  await cp(suite, dir, {
    recursive: true,
    filter: (source) => !source.startsWith(join(suite, 'results')),
  })
  return dir
}

async function appendTo(root, file, text = '\n// changed\n') {
  await writeFile(join(root, file), `${await readFile(join(root, file), 'utf8')}${text}`)
}

test('editing anything the evaluator loads, or the rubric, makes every replay stale', async () => {
  const corpus = await loadCorpus()
  for (const file of ['lib/browser-eval.mjs', 'lib/demo-contract.mjs', 'lib/axi-browser-driver.mjs']) {
    const root = await suiteCopy()
    await appendTo(root, file)
    const errors = await validateReplayRecords({ suiteRoot: root, corpus })
    assert.equal(errors.length, corpus.candidates.length, file)
    assert.match(errors[0], new RegExp(`astra: ${file.replace('.', '\\.')} is stale; run corpus-replay\\.mjs`))
  }
  const root = await suiteCopy()
  await appendTo(root, 'automated-rubric.json', '\n')
  assert.match(
    (await validateReplayRecords({ suiteRoot: root, corpus })).join('\n'),
    /automated-rubric\.json is stale; run corpus-replay\.mjs/,
  )
})

test('editing a file the evaluator does not load leaves the replays current', async () => {
  const corpus = await loadCorpus()
  const root = await suiteCopy()
  await appendTo(root, 'lib/pricing.mjs')
  assert.deepEqual(await validateReplayRecords({ suiteRoot: root, corpus }), [])
})

test('a golden verdict changed after its replay names only that candidate', async () => {
  const corpus = await loadCorpus()
  const changed = structuredClone(corpus)
  const verdict = changed.candidates[1].golden[IN_SCOPE_IDS[0]]
  verdict.outcome = 'fail'
  verdict.basis = { source: 'fixture', heading: 'x', fact: 'y' }
  verdict.history.push({ outcome: 'fail', date: '2026-09-21', explanation: 'test' })
  const errors = await validateReplayRecords({ suiteRoot: suite, corpus: changed })
  assert.ok(errors.length > 0)
  assert.ok(errors.every((error) => error.startsWith(`${changed.candidates[1].id}:`)), errors.join('\n'))

  // An explanation-only edit does not stale anything.
  const explained = structuredClone(corpus)
  explained.candidates[1].golden[IN_SCOPE_IDS[0]].history[0].explanation += ' (clarified)'
  assert.deepEqual(await validateReplayRecords({ suiteRoot: suite, corpus: explained }), [])
})

test('the corpus covers every distinct candidate behind a published result', async () => {
  const corpus = await loadCorpus()
  assert.deepEqual(await validatePublishedCoverage({ suiteRoot: suite, corpus }), [])

  const uncovered = structuredClone(corpus)
  uncovered.candidates = uncovered.candidates.filter(({ id }) => id !== 'config')
  assert.match(
    (await validatePublishedCoverage({ suiteRoot: suite, corpus: uncovered })).join('\n'),
    /config-20260828T201451Z.*44c8e817ec94d436711cde0a3b00c9c90564cda5.*no corpus candidate/,
  )

  const unlisted = structuredClone(corpus)
  unlisted.candidates.find(({ id }) => id === 'cutover').published_runs = []
  assert.match(
    (await validatePublishedCoverage({ suiteRoot: suite, corpus: unlisted })).join('\n'),
    /cutover: published_runs omits candidate-rescore-20260728-browser-fixed-4/,
  )
})
