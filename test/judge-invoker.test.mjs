import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createCodexJudgeInvoker } from '../evals/agent-runner/and-scene/lib/judge-invoker.mjs'

// Asynchronous stand-in for `child_process.spawn`. `run` receives the child
// and the spawn arguments and decides when (or whether) the child exits.
function fakeSpawn(run) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.input = ''
    child.stdin.on('data', (chunk) => { child.input += chunk })
    child.kills = []
    child.kill = (signal) => {
      child.kills.push(signal)
      child.emit('kill', signal)
      return true
    }
    child.exit = (status, signal = null) => {
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => child.emit('close', status, signal))
    }
    const call = { command, args, options, child }
    calls.push(call)
    setImmediate(() => run(child, call, calls.length))
    return child
  }
  spawnImpl.calls = calls
  return spawnImpl
}

function writeFinalOutput(args, text) {
  writeFileSync(args[args.indexOf('--output-last-message') + 1], text)
}

test('Codex judge invoker enforces the schema and scopes web access per job', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const candidateWorktree = join(runDir, 'candidate')
  const spawnImpl = fakeSpawn((child, { args }) => {
    writeFinalOutput(args, '{"results":[]}')
    child.stdout.write([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1200,
          cached_input_tokens: 800,
          cache_write_input_tokens: 50,
          output_tokens: 300,
          reasoning_output_tokens: 75,
        },
      }),
    ].join('\n'))
    child.exit(0)
  })
  const calls = spawnImpl.calls
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree,
    spawnImpl,
    env: {
      HOME: '/isolated/home',
      CODEX_HOME: '/isolated/home/.codex',
      PATH: '/safe/bin',
      LANG: 'C.UTF-8',
      GITHUB_TOKEN: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
    },
  })

  const output = await invoke({
    job: 'scene-kit',
    authority: { cli: 'codex', model: 'gpt-5.2' },
    schema: { type: 'object' },
    prompt: 'judge this',
    web_search: false,
  })

  assert.equal(output, '{"results":[]}')
  assert.equal(calls[0].command, '/usr/bin/codex')
  assert.equal(calls[0].options.cwd, candidateWorktree)
  assert.equal(calls[0].child.input, 'judge this')
  assert.deepEqual(calls[0].options.env, {
    HOME: '/isolated/home',
    CODEX_HOME: '/isolated/home/.codex',
    PATH: '/safe/bin',
    LANG: 'C.UTF-8',
  })
  assert.ok(calls[0].args.includes('web_search="disabled"'))
  assert.ok(calls[0].args.includes('shell_environment_policy.inherit="none"'))
  assert.ok(calls[0].args.includes('gpt-5.2'))
  assert.ok(calls[0].args.includes('--json'))
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

  const usage = await invoke.readUsageEntries()
  assert.equal(usage.length, 2)
  assert.equal(usage[0].phase, 'scene-kit')
  assert.equal(usage[0].provider, 'openai')
  assert.equal(usage[0].model, 'gpt-5.2')
  assert.equal(usage[0].usage.state, 'available')
  assert.deepEqual(usage[0].tokens, {
    input: 1200,
    cached_input: 800,
    cache_write: 50,
    output: 300,
    reasoning: 75,
  })
  assert.deepEqual(usage[0].token_totals, { input: 1200, output: 300, total: 1500 })
})

test('eval-owned usage survives a new invoker process for the same run directory', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const candidateWorktree = join(runDir, 'candidate')
  const first = createCodexJudgeInvoker({
    runDir,
    candidateWorktree,
    spawnImpl: fakeSpawn((child, { args }) => {
      writeFinalOutput(args, '{}')
      child.stdout.write(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
      }))
      child.exit(0)
    }),
  })
  await first({ job: 'scene-kit', authority: { model: 'gpt-5.2' }, schema: {}, prompt: 'x' })

  const resumed = createCodexJudgeInvoker({ runDir, candidateWorktree })
  const usage = await resumed.readUsageEntries()

  assert.equal(usage.length, 1)
  assert.equal(usage[0].phase, 'scene-kit')
  assert.equal(usage[0].tokens.input, 10)
})

test('Codex judge invoker reports a failed CLI without accepting stale output', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl: fakeSpawn((child) => {
      child.stderr.write('model unavailable')
      child.exit(7)
    }),
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

test('Codex judge invoker accepts only explicitly allowed read-only judge roots', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const neutralRoot = join(runDir, 'neutral')
  await mkdir(neutralRoot)
  const calls = []
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    allowedRoots: [neutralRoot],
    spawnImpl: fakeSpawn((child, { args, options }) => {
      calls.push(options.cwd)
      writeFinalOutput(args, '{"results":[]}')
      child.exit(0)
    }),
  })

  await invoke({
    job: 'scene-kit',
    cwd: neutralRoot,
    schema: { type: 'object' },
    prompt: 'judge neutral source',
  })
  assert.deepEqual(calls, [neutralRoot])

  await assert.rejects(
    invoke({
      job: 'scene-kit',
      cwd: join(runDir, '..', 'unbounded'),
      schema: { type: 'object' },
      prompt: 'escape',
    }),
    /approved read-only root/,
  )
})

async function waitFor(predicate, message) {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  assert.fail(message)
}

async function readOrEmpty(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

test('Codex judge invoker streams events and stderr to disk while the call runs', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const judgeDir = join(runDir, '.runtime', 'judge')
  const started = JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl: fakeSpawn(async (child, { args }) => {
      child.stdout.write(`${started}\n`)
      child.stderr.write('Reading prompt from stdin...\n')
      // The call is still running: its evidence must already be on disk.
      await waitFor(
        async () => (await readOrEmpty(join(judgeDir, '01-scene-kit.events.jsonl'))).includes(started)
          && (await readOrEmpty(join(judgeDir, '01-scene-kit.stderr.log'))).includes('Reading prompt'),
        'judge events and stderr were not streamed before Codex exited',
      )
      writeFinalOutput(args, '{"results":[]}')
      child.exit(0)
    }),
  })

  assert.equal(
    await invoke({ job: 'scene-kit', schema: { type: 'object' }, prompt: 'judge this' }),
    '{"results":[]}',
  )
  assert.deepEqual((await readdir(judgeDir)).sort(), [
    '01-scene-kit.events.jsonl',
    '01-scene-kit.output.json',
    '01-scene-kit.schema.json',
    '01-scene-kit.stderr.log',
  ])
})

test('Codex judge invoker omits shell command output from persisted events', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl: fakeSpawn((child, { args }) => {
      child.stdout.write(`${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'cat /home/judge/.codex/auth.json',
          aggregated_output: '{"OPENAI_API_KEY":"sk-secret"}',
          exit_code: 0,
          status: 'completed',
        },
      })}\nnot json\n`)
      writeFinalOutput(args, '{}')
      child.exit(0)
    }),
  })

  await invoke({ job: 'scene-kit', schema: {}, prompt: 'x' })

  const events = await readFile(join(runDir, '.runtime/judge/01-scene-kit.events.jsonl'), 'utf8')
  assert.equal(events.includes('sk-secret'), false)
  const [first, second] = events.trim().split('\n')
  const item = JSON.parse(first).item
  assert.equal(item.command, 'cat /home/judge/.codex/auth.json')
  assert.equal(item.exit_code, 0)
  assert.equal(item.aggregated_output, '[omitted 30 characters]')
  assert.equal(second, 'not json')
})

test('Codex judge invoker stops a stalled call and retries it once', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const judgeDir = join(runDir, '.runtime', 'judge')
  const spawnImpl = fakeSpawn((child, { args }, attempt) => {
    if (attempt === 1) {
      child.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`)
      child.on('kill', (signal) => child.exit(null, signal))
      return
    }
    writeFinalOutput(args, '{"results":["retried"]}')
    child.stdout.write(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 5, output_tokens: 1 },
    }))
    child.exit(0)
  })
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl,
    timeoutMs: 20,
  })

  const output = await invoke({ job: 'testing-evidence', schema: {}, prompt: 'judge' })

  assert.equal(output, '{"results":["retried"]}')
  assert.equal(spawnImpl.calls.length, 2)
  assert.deepEqual(spawnImpl.calls[0].child.kills, ['SIGTERM'])
  assert.equal(spawnImpl.calls[1].child.input, 'judge')
  // The stalled attempt's evidence survives beside the retry's.
  assert.match(
    await readFile(join(judgeDir, '01-testing-evidence.events.jsonl'), 'utf8'),
    /turn\.started/,
  )
  assert.match(
    await readFile(join(judgeDir, '01-testing-evidence.stderr.log'), 'utf8'),
    /timed out after 20 ms; sent SIGTERM/,
  )
  assert.match(
    await readFile(join(judgeDir, '01-testing-evidence.attempt-2.events.jsonl'), 'utf8'),
    /turn\.completed/,
  )
  const usage = await invoke.readUsageEntries()
  assert.equal(usage.length, 2)
  assert.equal(usage[0].usage.state, 'unavailable')
  assert.match(usage[0].usage.reason, /timed out after 20 ms/)
  assert.equal(usage[1].usage.state, 'available')
  assert.notEqual(usage[0].invocation_id, usage[1].invocation_id)
})

test('Codex judge invoker keeps usage a timed-out call reported before stalling', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    timeoutMs: 20,
    spawnImpl: fakeSpawn((child) => {
      child.stdout.write(`${JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 7, output_tokens: 3 },
      })}\n`)
      child.on('kill', (signal) => child.exit(null, signal))
    }),
  })

  await assert.rejects(
    invoke({ job: 'scene-kit', schema: {}, prompt: 'x' }),
    /Codex judge scene-kit timed out after 20 ms on 2 attempts/,
  )
  const usage = await invoke.readUsageEntries()
  assert.equal(usage.length, 2)
  assert.deepEqual(usage.map((entry) => entry.usage.state), ['available', 'available'])
  assert.deepEqual(usage[0].token_totals, { input: 7, output: 3, total: 10 })
})

test('Codex judge invoker force-kills a timed-out call that ignores SIGTERM', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const spawnImpl = fakeSpawn((child) => {
    child.on('kill', (signal) => { if (signal === 'SIGKILL') child.exit(null, signal) })
  })
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl,
    timeoutMs: 10,
    killGraceMs: 10,
  })

  await assert.rejects(invoke({ job: 'scene-kit', schema: {}, prompt: 'x' }), /timed out/)
  assert.deepEqual(spawnImpl.calls.map((call) => call.child.kills), [
    ['SIGTERM', 'SIGKILL'],
    ['SIGTERM', 'SIGKILL'],
  ])
  assert.match(
    await readFile(join(runDir, '.runtime/judge/01-scene-kit.stderr.log'), 'utf8'),
    /did not exit within 10 ms of SIGTERM; sent SIGKILL/,
  )
})

test('Codex judge invoker keeps an earlier process attempt evidence for the same call', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const judgeDir = join(runDir, '.runtime', 'judge')
  await mkdir(judgeDir, { recursive: true })
  writeFileSync(join(judgeDir, '01-scene-kit.events.jsonl'), 'killed attempt\n')
  writeFileSync(join(judgeDir, '01-scene-kit.stderr.log'), 'killed stderr\n')
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl: fakeSpawn((child, { args }) => {
      child.stdout.write('recovered\n')
      writeFinalOutput(args, '{}')
      child.exit(0)
    }),
  })

  await invoke({ job: 'scene-kit', schema: {}, prompt: 'x' })

  assert.equal(await readFile(join(judgeDir, '01-scene-kit.events.jsonl'), 'utf8'), 'killed attempt\n')
  assert.equal(await readFile(join(judgeDir, '01-scene-kit.stderr.log'), 'utf8'), 'killed stderr\n')
  assert.equal(await readFile(join(judgeDir, '01-scene-kit.attempt-2.events.jsonl'), 'utf8'), 'recovered\n')
})

test('Codex judge invoker reports a Codex launch failure', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl: fakeSpawn((child) => {
      child.emit('error', Object.assign(new Error('spawn /usr/bin/codex ENOENT'), { code: 'ENOENT' }))
      child.stdout.end()
      child.stderr.end()
    }),
  })

  await assert.rejects(
    invoke({ job: 'scene-kit', schema: {}, prompt: 'x' }),
    /Codex judge scene-kit exited -1: spawn \/usr\/bin\/codex ENOENT/,
  )
})

test('Codex judge invoker does not wait on pipes a stopped call left open', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const spawnImpl = fakeSpawn((child, { args }, attempt) => {
    if (attempt === 1) {
      // A descendant still holds stdout, so Codex exits without `close`.
      child.on('kill', (signal) => setImmediate(() => child.emit('exit', null, signal)))
      return
    }
    writeFinalOutput(args, '{}')
    child.exit(0)
  })
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl,
    timeoutMs: 10,
  })

  assert.equal(await invoke({ job: 'scene-kit', schema: {}, prompt: 'x' }), '{}')
  assert.equal(spawnImpl.calls[0].options.detached, true)
  assert.equal(spawnImpl.calls[0].child.stdout.destroyed, true)
})

test('Codex judge invoker fails a call whose evidence cannot be written', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    openFile: async (path, flags) => {
      const handle = await open(path, flags)
      if (!path.endsWith('.events.jsonl')) return handle
      return {
        write: async () => { throw new Error('ENOSPC: no space left on device') },
        close: () => handle.close(),
      }
    },
    spawnImpl: fakeSpawn((child, { args }) => {
      child.stdout.write('{"type":"turn.started"}\n')
      writeFinalOutput(args, '{}')
      child.exit(0)
    }),
  })

  await assert.rejects(
    invoke({ job: 'scene-kit', schema: {}, prompt: 'x' }),
    /Codex judge scene-kit could not record its attempt evidence at .*01-scene-kit\.events\.jsonl: ENOSPC/,
  )
})

test('Codex judge invoker stops reading output until it is written', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  let release
  const blocked = new Promise((resolveBlocked) => { release = resolveBlocked })
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    openFile: async (path, flags) => {
      const handle = await open(path, flags)
      if (!path.endsWith('.events.jsonl')) return handle
      return {
        write: async (text) => { await blocked; return handle.write(text) },
        close: () => handle.close(),
      }
    },
    spawnImpl: fakeSpawn(async (child, { args }) => {
      child.stdout.write('{"type":"turn.started"}\n')
      await waitFor(() => child.stdout.isPaused(), 'stdout kept flowing during a pending write')
      release()
      await waitFor(() => !child.stdout.isPaused(), 'stdout did not resume after the write')
      writeFinalOutput(args, '{}')
      child.exit(0)
    }),
  })

  assert.equal(await invoke({ job: 'scene-kit', schema: {}, prompt: 'x' }), '{}')
  assert.equal(
    await readFile(join(runDir, '.runtime/judge/01-scene-kit.events.jsonl'), 'utf8'),
    '{"type":"turn.started"}\n',
  )
})

test('Codex judge invoker stops a call that exceeds its stdout limit', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'and-scene-judge-'))
  const spawnImpl = fakeSpawn((child) => {
    child.on('kill', (signal) => child.exit(null, signal))
    child.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`)
    child.stdout.write('x'.repeat(64))
  })
  const invoke = createCodexJudgeInvoker({
    runDir,
    candidateWorktree: join(runDir, 'candidate'),
    spawnImpl,
    maxStdoutBytes: 50,
  })

  await assert.rejects(
    invoke({ job: 'scene-kit', schema: {}, prompt: 'x' }),
    /Codex judge scene-kit exceeded the 50-byte stdout limit/,
  )
  assert.equal(spawnImpl.calls.length, 1)
  assert.deepEqual(spawnImpl.calls[0].child.kills, ['SIGTERM'])
  assert.match(
    await readFile(join(runDir, '.runtime/judge/01-scene-kit.stderr.log'), 'utf8'),
    /wrote more than 50 bytes to stdout; sent SIGTERM/,
  )
  assert.equal((await invoke.readUsageEntries()).length, 1)
})
