import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { runEvaluation } from '../evals/agent-runner/and-scene/controller.mjs'
import { loadCheckpoint } from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'
import { readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { WORKFLOW_RELATIVE_PATH } from '../evals/agent-runner/and-scene/lib/provenance.mjs'
import { DEMO_CONTRACT } from '../evals/agent-runner/and-scene/lib/demo-contract.mjs'

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
  ghPermission = 'WRITE',
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
      if (joined.includes('ls-remote --symref origin HEAD')) {
        return { status: 0, stdout: 'ref: refs/heads/main\tHEAD\n' }
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
    if (command === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return { status: 0, stdout: `${ghPermission}\n` }
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
    judgeInvoke: async (request) => {
      if (Array.isArray(request.criteria)) {
        return JSON.stringify({
          results: request.criteria.map((id) => ({
            id,
            verdict: 'pass',
            rationale: 'controller fixture evidence supports this criterion',
            evidence: ['controller-fixture:verified'],
          })),
        })
      }
      if (request.job === 'ambiguity-diagnostics') {
        return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      }
      return JSON.stringify({ results: [] })
    },
    ...overrides,
  })
}

function browserDemo({ captions = DEMO_CONTRACT.step_captions } = {}) {
  let index = 0
  let mode = 'present'
  return {
    async routes() { return [DEMO_CONTRACT.route] },
    async open() { index = 0; mode = 'present' },
    async setMode(required) { mode = required },
    async setPosition(required) { index = required },
    async settle() { return { settled: true, strategy: 'mock-idle' } },
    async state() {
      return {
        stepIndex: index,
        stepCount: DEMO_CONTRACT.step_count,
        mode,
        title: DEMO_CONTRACT.step_titles[index],
        caption: mode === 'browse' ? captions[index] : '',
        sceneId: 'reference-scene',
        entityIds: ['persistent', `step-${index}`],
        titleProminent: mode === 'present',
        captionVisible: mode === 'browse',
        controls: DEMO_CONTRACT.step_titles.map((_, position) => ({
          name: `Step ${position + 1}`,
          role: 'button',
          ariaCurrent: position === index,
          focusable: true,
        })),
        focused: null,
      }
    },
    async press(key) {
      if (key === 'ArrowRight') index = Math.min(DEMO_CONTRACT.step_count - 1, index + 1)
      if (key === 'ArrowLeft') index = Math.max(0, index - 1)
    },
    async swipe(direction) {
      await this.press(direction === 'left' ? 'ArrowRight' : 'ArrowLeft')
    },
    async activate(name) { index = Number(name.replace('Step ', '')) - 1 },
    async focus() {},
    async toggleMode() { mode = mode === 'present' ? 'browse' : 'present' },
    async failures() { return [] },
  }
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

test('authenticated read-only GitHub credentials are rejected before Runner starts', async () => {
  const context = await environment({ ghPermission: 'READ' })

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
  assert.equal(state.delivery.base_branch, 'main')
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

test('candidate evidence is frozen after delivery and neutral inputs exist before judging', async () => {
  const context = await environment()
  const order = []

  const result = await evaluate(context, profiles, {
    materializeEvidence: async ({ delivery: verified }) => {
      order.push(`evidence:${verified.final_sha}`)
      return {
        ownership: 'candidate-produced',
        manifest_sha256: 'c'.repeat(64),
        artifacts: [],
        findings: [],
      }
    },
    materializeNeutral: async ({ finalSha }) => {
      order.push(`neutral:${finalSha}`)
      return {
        source: { root: 'neutral/source' },
        requirements: { root: 'neutral/requirements' },
        manifest: { manifest_sha256: 'd'.repeat(64) },
      }
    },
    handlers: {
      'product-judging': async () => { order.push('judging') },
    },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(order, [
    `evidence:${context.commit}`,
    `neutral:${context.commit}`,
    'judging',
  ])
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.equal(state.delivery.acceptance.manifest_sha256, 'c'.repeat(64))
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

test('completed judge units are rehashed and reused while identity-sensitive phases reverify', async () => {
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

  const judging = await readJson(join(context.runDir, 'phases/product-judging.json'))
  assert.deepEqual(judging.reused_jobs.sort(), [
    'assumption-handling', 'demo-integration', 'presentation-skill',
    'scene-kit', 'testing-evidence', 'verification-tooling',
  ])
  assert.ok(result.completed.includes('agent-runner'))
  assert.ok(result.completed.includes('delivery-verification'))
  assert.ok(result.completed.includes('source-freeze'))
})

test('exhausted required judge output is a harness failure that preserves other judge checkpoints', async () => {
  const context = await environment()
  const result = await evaluate(context, profiles, {
    judgeInvoke: async (request) => {
      if (request.job === 'testing-evidence') return '{truncated'
      if (!Array.isArray(request.criteria)) {
        return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      }
      return JSON.stringify({
        results: request.criteria.map((id) => ({
          id,
          verdict: 'pass',
          rationale: 'verified controller fixture',
          evidence: ['controller-fixture:verified'],
        })),
      })
    },
  })

  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.outcome.product_verdict, 'unavailable')
  assert.equal(result.outcome.failure.code, 'judge-output')
  const judging = await readJson(join(context.runDir, 'phases/product-judging.json'))
  assert.deepEqual(judging.failed_jobs, ['testing-evidence'])
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.equal(state.phases['product-judging'].units['testing-evidence'].state, 'failed')
  assert.equal(state.phases['product-judging'].units['scene-kit'].state, 'complete')
  const score = await readJson(join(context.runDir, 'phases/score.json'))
  assert.equal(
    score.components.find(({ id }) => id === 'testing-evidence-quality').points_awarded,
    null,
  )
  assert.equal(
    score.components.find(({ id }) => id === 'scene-kit-correctness').points_awarded,
    24,
  )
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

test('pending reference run-state marks delivery not applicable and verdict unavailable', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--reference-baseline'])

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(runnerInvocations(context), [])
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.equal(state.delivery.applicable, false)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.product_verdict, 'unavailable')
  assert.equal(written.evaluation_status, 'pending-human-review')
})

test('browser probes are durable hashed evaluator-owned work units even when a probe fails', async () => {
  const context = await environment()
  let servedIdentity = null
  const candidateServer = {
    probe: async () => ({ ok: true, candidate_identity: servedIdentity }),
    start: async ({ candidate }) => {
      servedIdentity = candidate
      return { pid: 9876, url: 'http://127.0.0.1:4319/' }
    },
    stop: async () => {},
  }
  const captions = [...DEMO_CONTRACT.step_captions]
  captions[3] = 'wrong caption'

  const result = await evaluate(context, profiles, {
    isProcessAlive: () => true,
    verifyCandidate: async () => ({
      build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true },
      timings: [],
    }),
    candidateServer,
    browserDriver: browserDemo({ captions }),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome))
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  const units = state.phases['browser-evaluation'].units
  assert.equal(Object.keys(units).length, 14)
  assert.ok(Object.values(units).every(({ state: unitState }) => unitState === 'complete'))
  for (const [id, unit] of Object.entries(units)) {
    assert.equal(unit.outputs.length, 1, id)
    const artifact = await readJson(unit.outputs[0].path)
    assert.equal(artifact.ownership, 'evaluator-produced')
    assert.equal(artifact.revision, context.commit)
    assert.match(artifact.input_sha256, /^[a-f0-9]{64}$/)
    assert.match(artifact.output_sha256, /^[a-f0-9]{64}$/)
  }
  const failed = await readJson(units['demo-required-scene-content'].outputs[0].path)
  assert.equal(failed.result.verdict, 'fail')
})

test('the controller converts product-owned serve failure into a conclusive unscored fail', async () => {
  const context = await environment()
  let browserOpened = false

  const result = await evaluate(context, profiles, {
    isProcessAlive: () => true,
    verifyCandidate: async () => ({
      build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true },
      timings: [],
    }),
    candidateServer: {
      probe: async () => ({ ok: false, error: 'not running' }),
      start: async () => {
        throw Object.assign(new Error('candidate has no serveable application shell'), {
          owner: 'product',
          code: 'candidate-product-serve-failed',
          gate: 'verification-every-produced-step-renders',
        })
      },
      stop: async () => {},
    },
    browserDriver: {
      async open() { browserOpened = true },
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome))
  assert.equal(result.outcome.evaluation_status, 'complete')
  assert.equal(result.outcome.product_verdict, 'fail')
  assert.equal(result.outcome.official_score, null)
  assert.equal(result.outcome.product_failure.gate, 'verification-every-produced-step-renders')
  assert.equal(browserOpened, false)
})
