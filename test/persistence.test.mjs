import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  hashFile,
  hashJson,
  hashString,
  readJson,
  writeJsonAtomic,
} from '../evals/agent-runner/and-scene/lib/persistence.mjs'

async function workdir() {
  return mkdtemp(join(tmpdir(), 'agent-evals-persistence-'))
}

test('writeJsonAtomic writes readable JSON and leaves no temporary files', async () => {
  const dir = await workdir()
  const target = join(dir, 'checkpoint.json')

  await writeJsonAtomic(target, { schema_version: 1, phase: 'preflight' })

  assert.deepEqual(await readJson(target), { schema_version: 1, phase: 'preflight' })
  assert.deepEqual(await readdir(dir), ['checkpoint.json'])
})

test('writeJsonAtomic stages the temporary file in the target directory', async () => {
  const dir = await workdir()
  const target = join(dir, 'nested', 'result.json')
  await mkdir(join(dir, 'nested'), { recursive: true })
  const staged = []

  await writeJsonAtomic(target, { ok: true }, {
    onStage: (path) => staged.push(path),
  })

  assert.equal(staged.length, 1)
  assert.equal(join(dir, 'nested'), staged[0].slice(0, join(dir, 'nested').length))
  assert.notEqual(staged[0], target)
})

test('writeJsonAtomic preserves the previous file when serialization fails', async () => {
  const dir = await workdir()
  const target = join(dir, 'result.json')
  await writeJsonAtomic(target, { keep: 'me' })

  const cyclic = {}
  cyclic.self = cyclic
  await assert.rejects(() => writeJsonAtomic(target, cyclic))

  assert.deepEqual(await readJson(target), { keep: 'me' })
  assert.deepEqual(await readdir(dir), ['result.json'])
})

test('readJson returns the fallback when the file is absent', async () => {
  const dir = await workdir()

  assert.equal(await readJson(join(dir, 'missing.json'), null), null)
})

test('readJson rejects when the file is absent and no fallback is given', async () => {
  const dir = await workdir()

  await assert.rejects(() => readJson(join(dir, 'missing.json')))
})

test('hashString and hashFile agree on identical bytes', async () => {
  const dir = await workdir()
  const target = join(dir, 'workflow.yaml')
  await writeFile(target, 'steps: []\n')

  assert.equal(await hashFile(target), hashString('steps: []\n'))
  assert.match(hashString('steps: []\n'), /^[0-9a-f]{64}$/)
})

test('hashJson is stable across key order', () => {
  assert.equal(
    hashJson({ b: 2, a: 1, nested: { y: 2, x: 1 } }),
    hashJson({ a: 1, nested: { x: 1, y: 2 }, b: 2 }),
  )
})

test('hashJson distinguishes different values', () => {
  assert.notEqual(hashJson({ model: 'opus' }), hashJson({ model: 'sonnet' }))
})

test('hashFile reports null for a missing file', async () => {
  const dir = await workdir()

  assert.equal(await hashFile(join(dir, 'missing.txt')), null)
})
