import assert from 'node:assert/strict'
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createCandidateServer } from '../evals/agent-runner/and-scene/serve-candidate.mjs'

test('the candidate server never follows a build symlink outside its root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'and-scene-server-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'and-scene-server-secret-'))
  await writeFile(join(root, 'index.html'), '<h1>candidate</h1>')
  await writeFile(join(outside, 'secret.txt'), 'outside secret')
  await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt'))

  const server = createCandidateServer({ root, identity: 'candidate-1' })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const response = await fetch(`http://127.0.0.1:${server.address().port}/leak.txt`)
  const body = await response.text()

  assert.notEqual(body, 'outside secret')
})
