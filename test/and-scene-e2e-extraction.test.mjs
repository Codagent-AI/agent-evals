import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compute } from './fixtures/extraction/compute-define-run.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const goldens = JSON.parse(await readFile(new URL('./fixtures/extraction/define-run-goldens.json', import.meta.url), 'utf8'))
const files = async dir => (await readdir(join(root, dir))).filter(name => name.endsWith('.mjs')).sort()

test('INT-001 the define-run modules produce byte-identical outputs at their new location and through the old import paths', async () => {
  // Originally recorded before extraction; correction-aware rubric, score, ledger,
  // job and report hashes were refreshed for policy v5 / rubric v11. Other hashes remain unchanged.
  // The goldens cover: rubric build and check, scoring, discovery, the contamination
  // audit, reconciliation, Runner metrics ingestion, report rendering, comparison, judge jobs, the starting snapshot,
  // inventory and version checks, canary patterns, transcript parsing and the outcome/publication rules.
  const current = await compute(join(root, 'evals/lib/define-run'))
  assert.deepEqual(current, goldens)
  assert.deepEqual(await compute(join(root, 'evals/agent-runner/and-scene-define/lib')), goldens)
  assert.equal(goldens.suite_root_ends_with_define, true)
  assert.equal(Object.keys(goldens).length >= 20, true)
})
test('C-13 the move keeps every suite\'s data and policy home: shims preserve each old import path, data stays in the define suite', async () => {
  const moved = await files('evals/lib/define-run'); const inSuite = await files('evals/agent-runner/and-scene-define/lib')
  const SUITE_OWNED = ['calibration', 'collection', 'comparison', 'outcomes', 'phases', 'publication', 'report', 'rescore', 'result'].map(name => `${name}.mjs`)
  const shims = inSuite.filter(name => !SUITE_OWNED.includes(name))
  assert.deepEqual(shims, moved, 'every moved module has an old-path re-export')
  assert.deepEqual(inSuite.filter(name => SUITE_OWNED.includes(name)), SUITE_OWNED, 'the define lifecycle, results, publication and comparison policy stays with the define suite')
  for (const name of shims) assert.equal(await readFile(join(root, 'evals/agent-runner/and-scene-define/lib', name), 'utf8'), `// Moved to evals/lib/define-run so the end-to-end suite shares it; this path keeps existing imports working.\nexport * from '../../../lib/define-run/${name}'\n`, name)
  const everything = await readdir(join(root, 'evals/lib/define-run'))
  assert.ok(everything.every(name => name.endsWith('.mjs')), 'no data file moved into the shared library')
  for (const data of ['hidden', 'starting-repo', 'rubric.json', 'versions.json', 'contamination-patterns.json', 'results']) assert.ok((await readdir(join(root, 'evals/agent-runner/and-scene-define'))).includes(data), `${data} stays with the define suite`)
  // Shared modules take the suite's data location through their existing suiteRoot parameters; only the default names the define suite.
  for (const name of moved) {
    const text = await readFile(join(root, 'evals/lib/define-run', name), 'utf8')
    if (name !== 'files.mjs') assert.doesNotMatch(text, /agent-runner\/and-scene(?:-define|-e2e)?\//, `${name} hard-codes a suite path`)
  }
  // and-scene's reference-shaped probes, demo contract and controller stay with and-scene, and nothing in and-scene reaches into
  // the shared define-run library, so its sandbox still needs only the panel-judging mount.
  const scene = await files('evals/agent-runner/and-scene/lib')
  for (const stays of ['demo-contract.mjs', 'browser-eval.mjs', 'rubric.mjs', 'judge-jobs.mjs', 'neutral-source.mjs']) assert.ok(scene.includes(stays), stays)
  for (const name of scene) assert.doesNotMatch(await readFile(join(root, 'evals/agent-runner/and-scene/lib', name), 'utf8'), /define-run|and-scene-e2e/, `and-scene/lib/${name} depends on the new libraries`)
  assert.match(await readFile(join(root, 'evals/agent-runner/and-scene/run.sh'), 'utf8'), /evals\/lib\/panel-judging,target=\/lib\/panel-judging,readonly/)
  // The end-to-end suite imports the shared library, never the old paths.
  for (const name of await files('evals/agent-runner/and-scene-e2e/lib')) assert.doesNotMatch(await readFile(join(root, 'evals/agent-runner/and-scene-e2e/lib', name), 'utf8'), /and-scene-define\/lib/, name)
})
