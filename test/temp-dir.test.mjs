import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { makeTempDir } from './temp-dir.mjs'

const execFileAsync = promisify(execFile)
// A nested Node test runner must not inherit the parent's worker context.
const childEnv = { ...process.env }
delete childEnv.NODE_TEST_CONTEXT

for (const outcome of ['success', 'failure', 'setup failure', 'already removed']) {
  test(`temporary directories are cleaned after ${outcome}`, async () => {
    const root = await makeTempDir(join(tmpdir(), 'agent-evals-temp-cleanup-'))
    const fixture = join(root, 'fixture.test.mjs')
    await writeFile(fixture, `
import { test } from 'node:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTempDir } from ${JSON.stringify(new URL('./temp-dir.mjs', import.meta.url).href)}
const root = ${JSON.stringify(root)}
await makeTempDir(join(root, 'agent-evals-module-'))
async function setup() {
  const dir = await makeTempDir(join(root, 'agent-evals-fixture-'))
  await writeFile(join(dir, 'evidence.txt'), 'fixture')
  if (${JSON.stringify(outcome)} === 'setup failure') throw new Error('forced setup failure')
  return dir
}
test('fixture', async () => {
  const dir = await setup()
  if (${JSON.stringify(outcome)} === 'already removed') await rm(dir, { recursive: true })
  if (${JSON.stringify(outcome)} === 'failure') throw new Error('forced test failure')
})
`)
    const result = await execFileAsync(process.execPath, ['--test', fixture], { env: childEnv }).catch(error => error)
    const fails = outcome === 'failure' || outcome === 'setup failure'
    assert.equal(result.code ?? 0, fails ? 1 : 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# tests 1/)
    if (fails) assert.match(result.stdout, /forced (test|setup) failure/)
    assert.deepEqual(await readdir(root), ['fixture.test.mjs'])
  })
}
