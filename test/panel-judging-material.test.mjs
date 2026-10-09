import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runPanelJob } from '../evals/lib/panel-judging/panel.mjs'
import {
  MAX_AUDIT_PACKET_CHARS, MISSING_MATERIAL_RULE, OMITTED_MATERIAL_RULE, buildContradictionCheckRequest, sourceMaterial,
} from '../evals/lib/panel-judging/protocol.mjs'

async function sourceRoot(t) {
  const root = await makeTempDir(join(tmpdir(), 'panel-material-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'source'))
  await writeFile(join(root, 'source/a'), 'mechanism\n')
  return root
}

// v2: a vote's path outside the verified inventory is evidence about that
// vote, shown as nonexistent; it is no longer marked omitted.
test('cited paths outside the verified inventory are shown as nonexistent beside the inventory files', async (t) => {
  const root = await sourceRoot(t)
  await writeFile(join(root, 'source/unlisted'), 'not delivered\n')
  const request = { job: 'job', input_roots: { source: join(root, 'source') }, verified_source_paths: ['a'] }
  const material = await sourceMaterial(request, [{ id: 'x', citations: ['a', 'unlisted', '../outside'] }])
  assert.deepEqual(material, [
    { path: '../outside', not_in_inventory: '[not in inventory: ../outside]' },
    { path: 'a', content: 'mechanism\n' },
    { path: 'unlisted', not_in_inventory: '[not in inventory: unlisted]' },
  ])
  // An audit's own citation outside the inventory is invalid output, never material.
  await assert.rejects(sourceMaterial(request, [{ id: 'x', citations: ['a'] }], ['unlisted']),
    (error) => error.code === 'judge-output' && /outside the verified neutral source: unlisted/.test(error.message))
})

// v2: an inventory file that cannot be read is known missing material, so the
// check fails the job naming the criterion instead of seeing an omission marker.
for (const [name, prepare] of [['missing', async () => {}], ['symbolic link', async (root) => symlink(join(root, 'source/a'), join(root, 'source/gone'))]]) {
  test(`an inventory file the check cannot read (${name}) is missing material naming the criterion`, async (t) => {
    const root = await sourceRoot(t)
    await prepare(root)
    const request = { job: 'job', input_roots: { source: join(root, 'source') }, verified_source_paths: ['a', 'gone'] }
    await assert.rejects(sourceMaterial(request, [{ id: 'x', citations: ['a', 'gone'] }]), (error) => {
      assert.equal(error.name, 'HarnessMaterialError')
      assert.equal(error.code, 'missing-material')
      assert.equal(error.owner, 'evaluation-harness')
      assert.equal(error.resumable, false)
      assert.equal(error.retryable, false)
      assert.deepEqual(error.criteria, ['x'])
      // A system error's host path stays out of the recorded failure.
      assert.ok(!error.message.includes(root))
      return true
    })
  })
}

test('cited files past half the packet size limit are collected in full, never omitted for size', async (t) => {
  const root = await sourceRoot(t)
  await writeFile(join(root, 'source/b'), 'x'.repeat(MAX_AUDIT_PACKET_CHARS / 2))
  await writeFile(join(root, 'source/c'), 'small\n')
  const material = await sourceMaterial({ job: 'job', input_roots: { source: join(root, 'source') }, verified_source_paths: ['a', 'b', 'c'] },
    [{ id: 'x', citations: ['a', 'b', 'c'] }])
  assert.deepEqual(material, [
    { path: 'a', content: 'mechanism\n' },
    { path: 'b', content: 'x'.repeat(MAX_AUDIT_PACKET_CHARS / 2) },
    { path: 'c', content: 'small\n' },
  ])
})

test('a contradiction check whose material cannot fit raises packet-overflow naming the criterion', async (t) => {
  const root = await sourceRoot(t)
  await writeFile(join(root, 'source/huge'), 'x'.repeat(MAX_AUDIT_PACKET_CHARS + 1))
  const request = { job: 'job', input_roots: { source: join(root, 'source') }, verified_source_paths: ['huge'] }
  const material = await sourceMaterial(request, [{ id: 'x', citations: ['huge'] }])
  assert.throws(() => buildContradictionCheckRequest({ request, claims: [{ id: 'x', verdict: 'pass', rationale: 'reason',
    contradiction: { rationale: 'huge lacks it', evidence: ['huge'] }, material }] }),
  (error) => error.code === 'packet-overflow' && error.retryable === false && error.criteria.join() === 'x')
})

// v2: marked material is missing, not absent from the candidate, and
// insufficient means only that complete, in-scope material is inconclusive.
test('the contradiction check states the v2 missing-material rule and shows a nonexistent citation', async (t) => {
  const root = await sourceRoot(t)
  const request = { job: 'job', input_roots: { source: join(root, 'source') }, verified_source_paths: ['a'] }
  const material = await sourceMaterial(request, [{ id: 'x', citations: ['gone'] }])
  const check = buildContradictionCheckRequest({ request, claims: [{ id: 'x', verdict: 'pass', rationale: 'reason',
    contradiction: { rationale: 'gone lacks the mechanism', evidence: ['gone'] }, material }] })
  assert.ok(check.prompt.includes('[not in inventory: gone]'))
  assert.ok(check.prompt.includes(MISSING_MATERIAL_RULE))
  assert.equal(OMITTED_MATERIAL_RULE, MISSING_MATERIAL_RULE)
  assert.match(MISSING_MATERIAL_RULE, /insufficient means only that the supplied material, complete and in scope, does not decide the claim/)
  assert.match(MISSING_MATERIAL_RULE, /\[truncated: …\] or \[omitted: …\] .* missing, not absent from the candidate/)
  assert.match(MISSING_MATERIAL_RULE, /could have cited but did not is not missing material: that stays insufficient, the judge's burden/)
  assert.ok(check.schema.properties.results.items.required.includes('citations'))
  assert.deepEqual(check.schema.properties.results.items.properties.classification.enum,
    ['confirmed', 'contradicted', 'insufficient', 'missing-material'])
})

test('the dissent check states the v2 missing-material rule', async (t) => {
  const root = await sourceRoot(t)
  const request = { job: 'job', criteria: ['x'], prompt: 'context', schema: {}, input_roots: { source: join(root, 'source') } }
  const vote = (verdict) => ({ results: [{ id: 'x', verdict, rationale: 'reason', evidence: ['a'], citations: ['gone'] }] })
  let prompt = null
  await runPanelJob({ job: 'job', criteria: ['x'], verdicts: ['pass', 'fail'], order: ['pass', 'fail'], schema: {},
    buildPrompt: () => request, validateCitations: async () => true,
    panel: ['fail', 'fail', 'pass'].map((verdict, i) => ({ family: i === 0 ? 'claude' : 'codex', model: `m${i}`, effort: 'medium',
      invoke: async () => JSON.stringify(vote(verdict)) })),
    decider: { model: 'opus', effort: 'medium', invoke: async (next) => {
      prompt = next.prompt
      return JSON.stringify({ results: [{ id: 'x', classification: 'insufficient', rationale: 'r', evidence: ['gone'] }] })
    } } })
  assert.ok(prompt.includes('[not in inventory: gone]'))
  assert.ok(prompt.includes(MISSING_MATERIAL_RULE))
})
