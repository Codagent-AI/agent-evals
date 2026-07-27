import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { runEvaluation } from '../evals/agent-runner/and-scene/controller.mjs'
import { loadCheckpoint } from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'
import { readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { WORKFLOW_RELATIVE_PATH } from '../evals/agent-runner/and-scene/lib/provenance.mjs'

const workflowYaml = `name: implement-change
params:
  - name: change_name
    required: true
  - name: skip_validator
    default: "false"
steps:
  - id: implement-tasks
  - id: run-validator
  - id: open-draft-pr
  - id: verify-draft-pr
  - id: prepare-acceptance
  - id: verify-acceptance-handoff
`

const history = [
  { step: 'run-validator', outcome: 'success' },
  { step: 'open-draft-pr', outcome: 'success' },
  { step: 'verify-draft-pr', outcome: 'success' },
  { step: 'prepare-acceptance', outcome: 'success' },
  { step: 'verify-acceptance-handoff', outcome: 'success' },
]

const profiles = [
  '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
  '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
]

async function environment({
  workflow = workflowYaml,
  dirty = '',
  commit = 'a'.repeat(40),
  ghAuthenticated = true,
  runnerResult = { status: 0, stdout: '' },
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-evals-controller-'))
  const agentRunnerDir = join(root, 'agent-runner')
  await mkdir(join(agentRunnerDir, 'workflows/openspec'), { recursive: true })
  if (workflow !== null) await writeFile(join(agentRunnerDir, WORKFLOW_RELATIVE_PATH), workflow)
  const runDir = join(root, 'run-1')
  await mkdir(join(runDir, '.runtime/candidate-worktree/src'), { recursive: true })
  await writeFile(
    join(runDir, '.runtime/candidate-worktree/src/index.ts'),
    'export const fixture = true\n',
  )
  const home = join(root, 'home')
  await mkdir(home)

  const invocations = []
  const exec = (command, args, options = {}) => {
    invocations.push({ command, args: [...args], options })
    if (command === 'git') {
      const joined = args.join(' ')
      if (joined.includes('show-ref --verify --quiet')) return { status: 1, stdout: '' }
      if (joined.includes('--is-inside-work-tree')) return { status: 0, stdout: 'true\n' }
      if (joined.includes('remote get-url origin')) {
        return { status: 0, stdout: 'https://github.com/Codagent-AI/and-scene.git\n' }
      }
      if (joined.includes('branch --show-current')) {
        return { status: 0, stdout: 'eval/and-scene/run-1\n' }
      }
      if (joined.includes('status --porcelain')) return { status: 0, stdout: dirty }
      if (joined.includes('merge-base --is-ancestor')) return { status: 0, stdout: '' }
      if (joined.includes('diff --binary')) return { status: 0, stdout: '' }
      if (joined.includes('ls-tree')) return { status: 0, stdout: '' }
      if (joined.includes('rev-parse')) return { status: 0, stdout: `${commit}\n` }
      return { status: 0, stdout: '' }
    }
    if (command === 'gh' && args[0] === 'auth') {
      return ghAuthenticated ? { status: 0, stdout: '' } : { status: 1, stderr: 'not logged in' }
    }
    if (command === 'agent-runner' && args[0] === '--version') {
      return { status: 0, stdout: 'agent-runner 2.4.0\n' }
    }
    if (command === 'agent-runner') return runnerResult
    return { status: 0, stdout: '' }
  }
  return { root, runDir, home, agentRunnerDir, exec, invocations, commit }
}

function runnerInvocations(context) {
  return context.invocations.filter(({ command, args }) => (
    command === 'agent-runner' && args[0] !== '--version'
  ))
}

function completedReader(context) {
  return () => runnerInvocations(context).length === 0
    ? null
    : {
        run_id: 'runner-7',
        session_dir: '/sessions/runner-7',
        workflow_name: 'implement-change',
        workflow_completed: true,
        history,
      }
}

function delivery(context) {
  return {
    verified: true,
    branch: 'eval/and-scene/run-1',
    fixture_commit: context.commit,
    final_sha: context.commit,
    remote_sha: context.commit,
    pull_request: {
      number: 53,
      url: 'https://github.com/Codagent-AI/and-scene/pull/53',
      state: 'OPEN',
      draft: true,
      base: 'main',
      head_branch: 'eval/and-scene/run-1',
      head_sha: context.commit,
    },
    final_validator: history[0],
    workflow_history: history,
    acceptance_artifacts: [
      { role: 'acceptance-handoff', path: '/sessions/runner-7/output/acceptance-handoff.md', sha256: 'b'.repeat(64) },
    ],
  }
}

async function evaluate(context, extra = [], overrides = {}) {
  return runEvaluation({
    argv: [
      '--run-dir', context.runDir,
      '--agent-runner-dir', context.agentRunnerDir,
      '--change-name', 'create-and-scene',
      ...extra,
    ],
    exec: context.exec,
    home: context.home,
    isProcessAlive: () => false,
    isRunnerProcessAlive: () => false,
    readRunnerState: completedReader(context),
    observedSteps: (state) => state.history,
    verifyDelivery: async () => delivery(context),
    verifyResumeDelivery: async () => ({ verified: true }),
    ...overrides,
  })
}

test('--skip-validator runs the full exact workflow without --until', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--skip-validator', ...profiles])

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const [invocation] = runnerInvocations(context)
  assert.deepEqual(invocation.args, [
    'run',
    join(context.agentRunnerDir, WORKFLOW_RELATIVE_PATH),
    'change_name=create-and-scene',
    'skip_validator=true',
  ])
  assert.ok(!invocation.args.includes('--until'))
})

test('task-level validation is included by default while the final Validator remains required', async () => {
  const context = await environment()

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.ok(runnerInvocations(context)[0].args.includes('skip_validator=false'))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.final_validator, 'required')
  assert.equal(written.workflow.full_workflow, true)
  assert.equal(written.workflow.configured_stop_step, null)
})

test('workflow preflight rejects missing required and declared prohibited steps before Runner starts', async () => {
  for (const workflow of [
    workflowYaml.replace('  - id: prepare-acceptance\n', ''),
    `${workflowYaml}  - id: merge-pr\n`,
  ]) {
    const context = await environment({ workflow })
    const result = await evaluate(context, profiles)

    assert.equal(result.exitCode, 2)
    assert.deepEqual(runnerInvocations(context), [])
    assert.match(JSON.stringify(result.errors), /prepare-acceptance|prohibited.*merge-pr/)
  }
})

test('publishing credentials are required before Runner starts', async () => {
  const context = await environment({ ghAuthenticated: false })

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context), [])
  assert.match(JSON.stringify(result.errors), /publishing-credentials/)
})

test('the candidate branch identity exists in run-state before Runner starts', async () => {
  const context = await environment({
    runnerResult: { status: 1, stderr: 'runner stopped' },
  })

  await evaluate(context, profiles, {
    readRunnerState: () => null,
  })

  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.equal(state.delivery.branch, 'eval/and-scene/run-1')
  assert.equal(state.delivery.fixture_commit, context.commit)
  assert.equal(state.delivery.retained_for_manual_cleanup, true)
})

test('Runner identity, delivery identity, and acceptance hashes evolve in one run-state manifest', async () => {
  const context = await environment()

  await evaluate(context, profiles)

  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.equal(state.agent_runner.run_id, 'runner-7')
  assert.equal(state.delivery.runner.run_id, 'runner-7')
  assert.equal(state.delivery.pull_request.number, 53)
  assert.equal(state.delivery.final_sha, context.commit)
  assert.equal(state.delivery.acceptance.artifacts[0].sha256, 'b'.repeat(64))
  await assert.rejects(() => readFile(join(context.runDir, 'checkpoint.json')), /ENOENT/)
})

test('delivery verification finishes before source freeze and product judging', async () => {
  const context = await environment()
  const order = []

  const result = await evaluate(context, profiles, {
    verifyDelivery: async () => {
      order.push('delivery')
      return delivery(context)
    },
    handlers: {
      'source-freeze': async () => { order.push('source-freeze') },
      'product-judging': async () => { order.push('product-judging') },
    },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(order, ['delivery', 'source-freeze', 'product-judging'])
})

test('a typed side-effect violation is an implementation-workflow failure and retains resources', async () => {
  const context = await environment()
  const error = Object.assign(
    new Error('workflow-side-effect-violation: merge-pr'),
    {
      code: 'workflow-side-effect-violation',
      owner: 'implementation-workflow',
      unexpected_action: 'merge-pr',
      pull_request: delivery(context).pull_request,
    },
  )

  const result = await evaluate(context, profiles, {
    verifyDelivery: async () => { throw error },
  })

  assert.equal(result.outcome.evaluation_status, 'implementation-workflow-failed')
  assert.equal(result.outcome.product_verdict, 'unavailable')
  assert.equal(result.outcome.failure.code, 'workflow-side-effect-violation')
  assert.equal(result.outcome.delivery.candidate_branch, 'eval/and-scene/run-1')
  assert.equal(result.outcome.delivery.pull_request.number, 53)
})

test('an active recorded Runner process is waited for rather than duplicated', async () => {
  const context = await environment()
  await evaluate(context, profiles)
  const before = runnerInvocations(context).length
  const waited = []

  const result = await evaluate(context, ['--resume', ...profiles], {
    isRunnerProcessAlive: () => true,
    readRunnerState: () => ({
      run_id: 'runner-7',
      session_dir: '/sessions/runner-7',
      workflow_name: 'implement-change',
      lock: { pid: 99, run_id: 'runner-7' },
    }),
    waitForRun: async (runId) => {
      waited.push(runId)
      return {
        run_id: runId,
        session_dir: '/sessions/runner-7',
        workflow_name: 'implement-change',
        workflow_completed: true,
        history,
      }
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(waited, ['runner-7'])
  assert.equal(runnerInvocations(context).length, before)
})

test('an inactive unfinished Runner resumes only its exact recorded run', async () => {
  const context = await environment()
  await evaluate(context, profiles)
  const before = runnerInvocations(context).length

  const result = await evaluate(context, ['--resume', ...profiles], {
    readRunnerState: () => (
      runnerInvocations(context).length === before
        ? {
            run_id: 'runner-7',
            session_dir: '/sessions/runner-7',
            workflow_name: 'implement-change',
            workflow_completed: false,
          }
        : {
            run_id: 'runner-7',
            session_dir: '/sessions/runner-7',
            workflow_name: 'implement-change',
            workflow_completed: true,
            history,
          }
    ),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(runnerInvocations(context).slice(before).map(({ args }) => args), [
    ['--resume', 'runner-7'],
  ])
})

test('unverifiable recorded identity fails without starting or resuming a duplicate', async () => {
  const context = await environment()
  await evaluate(context, profiles)
  const before = runnerInvocations(context).length

  const result = await evaluate(context, ['--resume', ...profiles], {
    readRunnerState: () => null,
  })

  assert.equal(result.outcome.evaluation_status, 'implementation-workflow-failed')
  assert.equal(runnerInvocations(context).length, before)
})

test('completed work is rehashed and reused while identity-sensitive phases reverify', async () => {
  const context = await environment()
  await evaluate(context, profiles)

  const result = await evaluate(context, ['--resume', ...profiles], {
    readRunnerState: () => ({
      run_id: 'runner-7',
      session_dir: '/sessions/runner-7',
      workflow_name: 'implement-change',
      workflow_completed: true,
      history,
    }),
  })

  assert.ok(result.reused.includes('product-judging'))
  assert.ok(result.completed.includes('agent-runner'))
  assert.ok(result.completed.includes('delivery-verification'))
  assert.ok(result.completed.includes('source-freeze'))
})

test('fresh collisions and legacy checkpoint-only runs are not silently resumed', async () => {
  const context = await environment()
  await evaluate(context, profiles)

  const collision = await evaluate(context, profiles)
  assert.equal(collision.exitCode, 2)
  assert.match(JSON.stringify(collision.errors), /run-directory-collision/)

  const legacy = await environment()
  await writeFile(join(legacy.runDir, 'checkpoint.json'), JSON.stringify({
    schema_version: 1,
    boundary: { stop_step: 'simplify' },
  }))
  const resumed = await evaluate(legacy, ['--resume', ...profiles])
  assert.equal(resumed.exitCode, 2)
  assert.match(JSON.stringify(resumed.errors), /run-state.*does not exist/i)
})

test('reference run-state marks delivery and product verdict not applicable', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--reference-baseline'])

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(runnerInvocations(context), [])
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.equal(state.delivery.applicable, false)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.product_verdict, 'not-applicable')
})
