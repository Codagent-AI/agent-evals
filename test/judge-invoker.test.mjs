import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCodexJudgeInvoker } from '../evals/agent-runner/and-scene/lib/judge-invoker.mjs'

test('Codex judge invoker enforces the schema and scopes web access per job', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const candidateWorktree = join(runDir, 'candidate')
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const outputPath = args[args.indexOf('--output-last-message') + 1]
    writeFileSync(outputPath, '{"results":[]}')
    return { status: 0, stdout: '', stderr: '' }
  }
  const invoke = createCodexJudgeInvoker({ runDir, candidateWorktree, spawnImpl })

  const output = await invoke({
    job: 'scene-kit',
    authority: { cli: 'codex', model: 'gpt-5.2' },
    schema: { type: 'object' },
    prompt: 'judge this',
    web_search: false,
  })

  assert.equal(output, '{"results":[]}')
  assert.equal(calls[0].command, 'codex')
  assert.equal(calls[0].options.cwd, candidateWorktree)
  assert.equal(calls[0].options.input, 'judge this')
  assert.ok(calls[0].args.includes('web_search="disabled"'))
  assert.ok(calls[0].args.includes('gpt-5.2'))
  const schemaPath = calls[0].args[calls[0].args.indexOf('--output-schema') + 1]
  assert.deepEqual(JSON.parse(await readFile(schemaPath, 'utf8')), { type: 'object' })

  await invoke({
    job: 'pricing-fallback',
    authority: { cli: 'codex', model: 'codex-default' },
    schema: { type: 'object' },
    prompt: 'find pricing',
    web_search: 'authorized',
  })
  assert.ok(calls[1].args.includes('web_search="live"'))
  assert.equal(calls[1].args.includes('--model'), false)
})

test('Codex judge invoker reports a failed CLI without accepting stale output', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl: () => ({ status: 7, stdout: '', stderr: 'model unavailable' }),
  })

  await assert.rejects(
    invoke({
      job: 'demo-integration',
      authority: { cli: 'codex', model: 'codex-default' },
      schema: { type: 'object' },
      prompt: 'judge this',
    }),
    /Codex judge demo-integration exited 7: model unavailable/,
  )
})
