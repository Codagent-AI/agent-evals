import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runPanelJob } from '../evals/lib/panel-judging/panel.mjs'
import {
  MAX_AUDIT_PACKET_CHARS, OMITTED_MATERIAL_RULE, buildContradictionCheckRequest, sourceMaterial,
} from '../evals/lib/panel-judging/protocol.mjs'

async function sourceRoot(t) {
  const root = await makeTempDir(join(tmpdir(), 'panel-material-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'source'))
  await writeFile(join(root, 'source/a'), 'mechanism\n')
  return root
}

test('cited files the contradiction check cannot read are marked omitted with their reason', async (t) => {
  const root = await sourceRoot(t)
  await symlink(join(root, 'source/a'), join(root, 'source/link'))
  const request = { job: 'job', input_roots: { source: join(root, 'source') } }
  const material = await sourceMaterial(request, [{ id: 'x', citations: ['a', 'gone', 'link', '../outside'] }])
  assert.deepEqual(material, [
    { path: '../outside', omitted: '[omitted: ../outside — source citation is outside neutral source root]' },
    { path: 'a', content: 'mechanism\n' },
    { path: 'gone', omitted: '[omitted: gone — source citation cannot be inspected (ENOENT)]' },
    { path: 'link', omitted: '[omitted: link — source citation is a symbolic link]' },
  ])
  // A system error's host path stays out of the model's packet.
  assert.ok(!JSON.stringify(material).includes(root))
})

test('cited files past half the packet size limit are collected in full, never omitted for size', async (t) => {
  const root = await sourceRoot(t)
  await writeFile(join(root, 'source/b'), 'x'.repeat(MAX_AUDIT_PACKET_CHARS / 2))
  await writeFile(join(root, 'source/c'), 'small\n')
  const material = await sourceMaterial({ job: 'job', input_roots: { source: join(root, 'source') } },
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
  const request = { job: 'job', input_roots: { source: join(root, 'source') } }
  const material = await sourceMaterial(request, [{ id: 'x', citations: ['huge'] }])
  assert.throws(() => buildContradictionCheckRequest({ request, claims: [{ id: 'x', verdict: 'pass', rationale: 'reason',
    contradiction: { rationale: 'huge lacks it', evidence: ['huge'] }, material }] }),
  (error) => error.code === 'packet-overflow' && error.retryable === false && error.criteria.join() === 'x')
})

test('the contradiction check carries omission markers and treats omitted material as insufficient', async (t) => {
  const root = await sourceRoot(t)
  const request = { job: 'job', input_roots: { source: join(root, 'source') } }
  const material = await sourceMaterial(request, [{ id: 'x', citations: ['gone'] }])
  const check = buildContradictionCheckRequest({ request, claims: [{ id: 'x', verdict: 'pass', rationale: 'reason',
    contradiction: { rationale: 'gone lacks the mechanism', evidence: ['gone'] }, material }] })
  assert.ok(check.prompt.includes('[omitted: gone — source citation cannot be inspected (ENOENT)]'))
  assert.ok(check.prompt.includes(OMITTED_MATERIAL_RULE))
  assert.match(OMITTED_MATERIAL_RULE, /is insufficient/)
  assert.match(OMITTED_MATERIAL_RULE, /never contradicted/)
})

test('the dissent check treats omitted material as insufficient', async (t) => {
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
  assert.ok(prompt.includes('[omitted: gone — source citation cannot be inspected (ENOENT)]'))
  assert.ok(prompt.includes(OMITTED_MATERIAL_RULE))
})
