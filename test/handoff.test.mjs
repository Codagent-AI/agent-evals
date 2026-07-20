import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runEvaluation } from '../evals/agent-runner/and-scene/controller.mjs'
import { loadCheckpoint } from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'
import { readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { WORKFLOW_RELATIVE_PATH } from '../evals/agent-runner/and-scene/lib/provenance.mjs'

const workflowYaml = `name: implement-change2
parameters:
  change_name:
    required: true
  skip_validator:
    default: false
steps:
  - id: plan
  - id: implement-tasks
  - id: review-assumptions
  - id: simplify
  - id: run-validator
  - id: verify-validator
  - id: acceptance-test
`

const profileArgs = [
  '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
  '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
]

async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-handoff-'))
  const agentRunnerDir = join(root, 'agent-runner')
  await mkdir(join(agentRunnerDir, 'workflows/openspec'), { recursive: true })
  await writeFile(join(agentRunnerDir, WORKFLOW_RELATIVE_PATH), workflowYaml)
  const home = join(root, 'container-home')
  await mkdir(home, { recursive: true })

  const exec = (command, args) => {
    if (command === 'git') {
      const verb = args.join(' ')
      if (verb.includes('--is-inside-work-tree')) return { status: 0, stdout: 'true\n' }
      if (verb.includes('status --porcelain')) return { status: 0, stdout: '' }
      if (verb.includes('rev-parse HEAD')) return { status: 0, stdout: `${'a'.repeat(40)}\n` }
    }
    if (command === 'agent-runner' && args[0] === '--version') return { status: 0, stdout: 'agent-runner 2.4.0\n' }
    return { status: 0, stdout: '' }
  }

  return { root, agentRunnerDir, exec, home, runDir: join(root, 'run-1') }
}

function candidateServer({ stopFails = false } = {}) {
  const started = []
  const stopped = []
  const live = new Set()
  return {
    started,
    stopped,
    isProcessAlive: (pid) => live.has(pid),
    candidateServer: {
      start: async (request) => {
        started.push(request)
        live.add(9001)
        return { pid: 9001, url: 'http://127.0.0.1:4173/' }
      },
      probe: async () => ({ ok: true, candidate_identity: 'candidate-abc' }),
      stop: async (server) => {
        if (stopFails) throw new Error('permission denied')
        stopped.push(server.pid)
        live.delete(server.pid)
      },
    },
  }
}

async function evaluate(context, extra = {}) {
  return runEvaluation({
    argv: [
      '--run-dir', context.runDir,
      '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene',
      '--candidate-ref', 'candidate-abc',
      '--skip-validator',
      ...profileArgs,
    ],
    exec: context.exec,
    home: context.home,
    readRunnerState: () => ({ run_id: 'run-7', session_dir: '/sessions/run-7', status: 'completed', last_step: 'simplify' }),
    observedSteps: () => ['plan', 'implement-tasks', 'review-assumptions', 'simplify'],
    isProcessAlive: () => false,
    ...extra,
  })
}

test('the automated command hands off at pending-human-review with all three artifacts', async () => {
  const context = await environment()
  const infra = candidateServer()

  const result = await evaluate(context, infra)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.evaluation_status, 'pending-human-review')
  assert.equal(written.product_verdict, 'unavailable')
  assert.equal(written.official_score, null)
  assert.equal(written.label, 'PENDING HUMAN REVIEW')
  assert.equal(written.human_review, null)

  const report = await readFile(join(context.runDir, 'report.html'), 'utf8')
  assert.match(report, /PENDING HUMAN REVIEW/)

  const manifest = await readJson(join(context.runDir, 'artifact-manifest.json'))
  assert.ok(manifest.artifacts.some(({ path }) => path === 'result.json'))
  assert.ok(manifest.artifacts.some(({ path }) => path === 'report.html'))
  assert.ok(!manifest.artifacts.some(({ path }) => path.startsWith('.runtime')))
})

test('the candidate server is recorded durably and stopped before the command exits', async () => {
  const context = await environment()
  const infra = candidateServer()

  await evaluate(context, infra)

  const checkpoint = await loadCheckpoint(join(context.runDir, 'checkpoint.json'))
  assert.deepEqual(checkpoint.candidate_server, {
    pid: 9001, url: 'http://127.0.0.1:4173/', candidate_identity: 'candidate-abc',
  })
  assert.deepEqual(infra.stopped, [9001])
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.cleanup.completed, true)
  assert.equal(written.candidate_server.url, 'http://127.0.0.1:4173/')
})

test('a cleanup failure at handoff is diagnostic and still exits successfully', async () => {
  const context = await environment()
  const infra = candidateServer({ stopFails: true })

  const result = await evaluate(context, infra)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.evaluation_status, 'pending-human-review')
  assert.equal(written.cleanup.completed, false)
  assert.match(written.cleanup.error, /permission denied/)
  assert.equal(written.official_score, null)
  assert.match(await readFile(join(context.runDir, 'report.html'), 'utf8'), /permission denied/)
})

test('the handoff never asks a human-review question or invents a verdict', async () => {
  const context = await environment()
  const asked = []

  const result = await evaluate(context, {
    ...candidateServer(),
    io: { ask: (prompt) => { asked.push(prompt); return '5' }, write: () => {} },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(asked, [])
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.official_score, null)
  assert.equal(written.product_verdict, 'unavailable')
})

test('without a candidate-server adapter the run still reaches a durable pending result', async () => {
  const context = await environment()

  const result = await evaluate(context)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.evaluation_status, 'pending-human-review')
  assert.equal(written.candidate_server, null)
})
