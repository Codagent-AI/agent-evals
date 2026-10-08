import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { runEvaluation } from '../evals/agent-runner/and-scene/controller.mjs'
import { loadCheckpoint } from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'
import { readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import {
  VERIFICATION_WORKFLOW_RELATIVE_PATH,
  WORKFLOW_RELATIVE_PATH,
} from '../evals/agent-runner/and-scene/lib/provenance.mjs'
import { DEMO_CONTRACT } from '../evals/agent-runner/and-scene/lib/demo-contract.mjs'

const workflowYaml = `name: implement-change
params:
  - name: change_name
    required: true
  - name: change_dir
    required: true
  - name: change_label
    required: true
  - name: change_kind
    required: true
  - name: artifact_validation_instruction
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

// Current Agent Runner delegates final delivery to core:verify-change.
const delegatingWorkflowYaml = `${workflowYaml.slice(0, workflowYaml.indexOf('steps:\n'))}steps:
  - id: implement-tasks
  - id: verify-change
    workflow: verify-change-v1.0.yaml
`

const verificationWorkflowYaml = `name: verify-change
params:
  - name: skip_validator
    default: "false"
steps:
  - id: run-validator
  - id: open-draft-pr
  - id: verify-draft-pr
  - id: prepare-acceptance
  - id: write-acceptance-status
  - id: verify-acceptance-handoff
`

const delegatedHistory = [
  { step: 'implement-tasks', step_path: ['implement-tasks'], outcome: 'success' },
  ...['run-validator', 'open-draft-pr', 'verify-draft-pr', 'prepare-acceptance', 'verify-acceptance-handoff']
    .map((step) => ({ step: 'verify-change', step_path: ['verify-change', 'sub:verify-change', step], outcome: 'success' })),
  { step: 'verify-change', step_path: ['verify-change'], outcome: 'success' },
]

const history = [
  { step: 'run-validator', outcome: 'success' },
  { step: 'open-draft-pr', outcome: 'success' },
  { step: 'verify-draft-pr', outcome: 'success' },
  { step: 'prepare-acceptance', outcome: 'success' },
  { step: 'verify-acceptance-handoff', outcome: 'success' },
]

const planningTestPlan = `# Test plan

## Coverage Strategy
Browser coverage.
## Integration Tests
None.
## End-to-End Tests
None.
## Agent Acceptance Tests
### AT-001: Exercise the demo
- Classification: Required
- Covers: Demo behavior
- Actor and surface: User in a browser
- Setup: Start the built application
- Steps: Open the demo
- Expected: The demo renders
- Evidence: Browser snapshot
- Effects and cleanup: Stop the application
- Permitted substitutes: None
## Human-Only Testing
None.
## Coverage Map
AT-001
`

const profiles = [
  '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
  '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
  '--tester-cli', 'claude', '--tester-model', 'opus', '--tester-effort', 'high',
]

async function environment({
  workflow = workflowYaml,
  resolvedWorkflow = workflow,
  verificationWorkflow = null,
  resolvedVerificationWorkflow = verificationWorkflow,
  dirty = '',
  commit = 'a'.repeat(40),
  ghAuthenticated = true,
  ghPermission = 'WRITE',
  planningReady = true,
  runnerResult = { status: 0, stdout: '' },
  runnerResults = null,
} = {}) {
  const root = await makeTempDir(join(tmpdir(), 'agent-evals-controller-'))
  const agentRunnerDir = join(root, 'agent-runner')
  const agentSkillsDir = join(root, 'agent-skills')
  await mkdir(join(agentRunnerDir, 'workflows/core'), { recursive: true })
  if (workflow !== null) await writeFile(join(agentRunnerDir, WORKFLOW_RELATIVE_PATH), workflow)
  if (verificationWorkflow !== null) {
    await writeFile(join(agentRunnerDir, VERIFICATION_WORKFLOW_RELATIVE_PATH), verificationWorkflow)
  }
  await mkdir(join(agentSkillsDir, '.claude-plugin'), { recursive: true })
  await writeFile(join(agentSkillsDir, '.claude-plugin/marketplace.json'), '{"name":"codagent"}\n')
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
      if (joined.includes('show') && joined.includes('.validator/config.yml')) {
        return { status: 0, stdout: 'entry_points: []\n' }
      }
      if (joined.includes('show') && joined.includes('/test-plan.md')) {
        return planningReady
          ? { status: 0, stdout: planningTestPlan }
          : { status: 1, stderr: 'missing test plan' }
      }
      if (joined.includes('show') && joined.includes('/tasks.md')) {
        return { status: 0, stdout: '- [Demo task](tasks/01-demo.md)\n' }
      }
      if (joined.includes('show') && /\/(?:proposal|design|tasks)\.md/.test(joined)) {
        return { status: 0, stdout: '# Planning artifact\n' }
      }
      if (joined.includes('show') && /\/specs\/[^/]+\/spec\.md/.test(joined)) {
        return { status: 0, stdout: '# Specification\n' }
      }
      if (joined.includes('show') && /\/tasks\/[^/]+\.md/.test(joined)) {
        return { status: 0, stdout: '# Task\n' }
      }
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
      if (joined.includes('ls-tree')) {
        const planningPath = args.at(-1)
        if (planningPath.endsWith('/specs')) {
          return { status: 0, stdout: `${planningPath}/demo/spec.md\n` }
        }
        if (planningPath.endsWith('/tasks')) {
          return { status: 0, stdout: `${planningPath}/01-demo.md\n` }
        }
        return { status: 0, stdout: '' }
      }
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
    if (command === 'agent-runner' && args[0] === 'debug') {
      if (args.includes('core:verify-change')) {
        return resolvedVerificationWorkflow === null
          ? { status: 1, stderr: 'unknown workflow core:verify-change' }
          : { status: 0, stdout: resolvedVerificationWorkflow }
      }
      return { status: 0, stdout: resolvedWorkflow }
    }
    if (command === 'agent-runner') {
      const runnerIndex = invocations.filter(({ command: invoked, args: invokedArgs }) => (
        invoked === 'agent-runner' && (invokedArgs[0] === 'run' || invokedArgs[0] === '--resume')
      )).length - 1
      return runnerResults?.[runnerIndex] ?? runnerResult
    }
    return { status: 0, stdout: '' }
  }
  const sessionDir = join(root, 'sessions/runner-7')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'run-metrics.json'), JSON.stringify({
    sessions: [{
      execution_session_id: 'execution-1',
      started_at: '2026-09-09T14:24:36.000Z',
      last_observed_at: '2026-09-09T18:00:00.000Z',
      ended_at: '2026-09-09T18:00:00.000Z',
      duration_ms: 1,
      status: 'closed',
    }],
  }))
  return { root, runDir, home, agentRunnerDir, agentSkillsDir, exec, invocations, commit, sessionDir }
}

function runnerInvocations(context) {
  return context.invocations.filter(({ command, args }) => (
    command === 'agent-runner' && (args[0] === 'run' || args[0] === '--resume')
  ))
}

function auditReplayInvocations(context) {
  return context.invocations.filter(({ command, args }) => (
    command === 'agent-runner' && args[0] === 'audit' && args[1] === 'replay'
  ))
}

function completedReader(context) {
  return () => runnerInvocations(context).length === 0
    ? null
    : {
        run_id: 'runner-7',
        session_dir: context.sessionDir,
        workflow_name: 'implement-change',
        workflow_completed: true,
        history,
      }
}

function withReplayableSource(context, state) {
  if (!state) return state
  const next = { ...state, session_dir: context.sessionDir }
  if (next.audit?.links?.length > 0 || auditReplayInvocations(context).length === 0) {
    return next
  }
  return {
    ...next,
    audit: {
      links: [{
        auditRunId: 'audit-replay',
        executionSessionId: 'execution-1',
        trigger: 'replay',
        state: 'completed',
      }],
    },
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

function importedRescore(context, { changeName = 'create-and-scene' } = {}) {
  const importedDelivery = delivery(context)
  return {
    source_dir: '/rescore-source',
    source_run_id: 'completed-candidate-run',
    provenance_sha256: '9'.repeat(64),
    change_name: changeName,
    candidate_source: {
      repository: 'github.com/Codagent-AI/and-scene',
      fixture_commit: context.commit,
      branch: importedDelivery.branch,
      base_branch: 'main',
    },
    delivery: importedDelivery,
    runner: { run_id: 'runner-complete', session_dir: context.root },
    role_profiles: {
      lead: { cli: 'claude', model: 'opus', effort: 'high', agent: 'lead' },
      implementor: { cli: 'claude', model: 'sonnet', effort: 'medium', agent: 'implementor' },
      tester: { cli: 'claude', model: 'opus', effort: 'high', agent: 'tester' },
    },
    agent_runner_provenance: {
      commit: '3'.repeat(40),
      workflow_sha256: '4'.repeat(64),
      complete: true,
    },
    agent_skills_provenance: {
      commit: '5'.repeat(40),
      manifest_sha256: '6'.repeat(64),
      complete: true,
    },
    workflow: {
      arguments: [`change_name=${changeName}`, 'skip_validator=true'],
      observed_steps: history,
    },
    implementation_metrics: { active_duration_ms: 1234, attempts: [] },
    cost: { total_usd: 1.25, complete: true },
    pricing: { complete: true },
  }
}

async function evaluate(context, extra = [], overrides = {}) {
  const {
    controllerChangeName = 'create-and-scene',
    readRunnerState,
    waitForRun,
    ...dependencies
  } = overrides
  const readState = readRunnerState ?? completedReader(context)
  return runEvaluation({
    argv: [
      '--run-dir', context.runDir,
      '--agent-runner-dir', context.agentRunnerDir,
      '--agent-skills-dir', context.agentSkillsDir,
      ...(controllerChangeName === null ? [] : ['--change-name', controllerChangeName]),
      ...extra,
    ],
    exec: context.exec,
    home: context.home,
    isProcessAlive: () => false,
    isRunnerProcessAlive: () => false,
    readRunnerState: (runId) => withReplayableSource(context, readState(runId)),
    ...(waitForRun ? {
      waitForRun: async (runId) => withReplayableSource(context, await waitForRun(runId)),
    } : {}),
    observedSteps: (state) => state.history,
    verifyDelivery: async () => delivery(context),
    verifyResumeDelivery: async () => ({ verified: true }),
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') return JSON.stringify({ decision: 'uphold', rationale: 'the recorded failure stands',
        mismeasured_step: null, measurement_fault: null, citations: [], log_citations: [], replay: null })
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
    ...dependencies,
  })
}

function browserDemo({ captions = DEMO_CONTRACT.step_captions } = {}) {
  let index = 0
  let mode = 'present'
  let viewport = { width: 1280, height: 720 }
  let keydowns = []
  return {
    async routes() { return [DEMO_CONTRACT.route] },
    async open() { index = 0; mode = 'present'; viewport = { width: 1280, height: 720 } },
    async resize(width, height) { viewport = { width, height } },
    async canvasGeometry() {
      const scale = viewport.width < 100 ? 0.05 : 1
      const width = 880 * scale
      const height = 495 * scale
      return {
        viewport,
        authored: { width: 880, height: 495 },
        rendered: { left: 0, top: 0, right: width, bottom: height, width, height },
        available: {
          left: 0, top: 0, right: viewport.width, bottom: viewport.height,
          width: viewport.width, height: viewport.height,
        },
        scale: { x: scale, y: scale },
      }
    },
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
    // Modified arrows pass through to the browser, and a swipe that starts on
    // one of the deck's controls leaves the deck alone.
    async press(key, { modifiers = [] } = {}) {
      if (modifiers.length > 0) {
        keydowns.push({ key, altKey: modifiers.includes('Alt'), ctrlKey: modifiers.includes('Control'),
          metaKey: modifiers.includes('Meta'), shiftKey: false, prevented: false, preventDefaultCalls: 0 })
        return
      }
      if (key === 'ArrowRight') index = Math.min(DEMO_CONTRACT.step_count - 1, index + 1)
      if (key === 'ArrowLeft') index = Math.max(0, index - 1)
    },
    async swipe(direction, { selector = null } = {}) {
      if (selector !== null) return true
      await this.press(direction === 'left' ? 'ArrowRight' : 'ArrowLeft')
      return true
    },
    async installKeyInstrumentation() { keydowns = []; return { installed: true } },
    async readKeyInstrumentation({ reset = false } = {}) {
      const read = { installed: true, unloaded: false, url: `http://demo/${DEMO_CONTRACT.route}`, keydowns: [...keydowns] }
      if (reset) keydowns = []
      return read
    },
    async controlTargets() {
      return { controls: [{ kind: 'mode', name: 'Browse mode', selector: '#mode', hook: '[data-presentation-mode-toggle]',
        position: null }], looked_for: ['[data-presentation-mode-toggle]'] }
    },
    async activate(name) { index = Number(name.replace('Step ', '')) - 1 },
    async focus() {},
    async toggleMode() { mode = mode === 'present' ? 'browse' : 'present' },
    async failures() { return [] },
  }
}

test('a complete below-minimum automated score finishes without human review', async () => {
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

  const result = await evaluate(context, profiles, {
    isProcessAlive: () => true,
    verifyCandidate: async () => ({
      build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true },
      timings: [],
    }),
    candidateServer,
    browserDriver: browserDemo(),
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') return JSON.stringify({ decision: 'uphold', rationale: 'the recorded failure stands',
        mismeasured_step: null, measurement_fault: null, citations: [], log_citations: [], replay: null })
      if (Array.isArray(request.criteria)) {
        return JSON.stringify({
          results: request.criteria.map((id) => ({
            id,
            verdict: 'fail',
            rationale: 'the delivered implementation does not satisfy this criterion',
            evidence: ['controller-fixture:verified'],
          })),
        })
      }
      if (request.job === 'ambiguity-diagnostics') {
        return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      }
      return JSON.stringify({ results: [] })
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.evaluation_status, 'complete')
  assert.equal(written.product_verdict, 'fail')
  assert.ok(written.automated_subtotal.points < 40)
  assert.equal('official_score' in written, false)
  assert.equal('human_review' in written, false)
  assert.equal(written.product_failure.phase, 'automated-scoring')
  assert.match(written.product_failure.reason, /Automated score below minimum: .*\/70; required 40\/70/)
})

test('--skip-validator launches the verified workflow by logical name without --until', async () => {
  const context = await environment()
  const skippedHistory = [
    { step: 'run-validator', outcome: 'skipped' },
    ...history.slice(1),
  ]

  const result = await evaluate(context, ['--skip-validator', ...profiles], {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: '/sessions/runner-7',
          workflow_name: 'implement-change',
          workflow_completed: true,
          history: skippedHistory,
        },
    observedSteps: (state) => state.history,
    verifyDelivery: async () => ({
      ...delivery(context),
      final_validator: skippedHistory[0],
      workflow_history: skippedHistory,
    }),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const [invocation] = runnerInvocations(context)
  assert.deepEqual(invocation.args, [
    'run',
    'core:implement-change',
    'change_name=create-and-scene',
    'change_dir=openspec/changes/create-and-scene',
    'change_label=OpenSpec change',
    'change_kind=openspec',
    'artifact_validation_instruction=When an approved artifact changed, run `openspec validate --type change "create-and-scene"`.',
    'skip_validator=true',
  ])
  assert.ok(!invocation.args.includes('--until'))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.task_level_compliance, 'skipped')
  assert.equal(written.workflow.final_validator, 'skipped')
  assert.equal(written.workflow.history_complete, true)
  assert.deepEqual(written.workflow.invalid_outcomes, [])
  assert.equal(written.delivery.final_validator.outcome, 'skipped')
})

test('--skip-validator hides Agent Validator from every Runner-launched agent', async () => {
  const context = await environment()
  const skippedHistory = [
    { step: 'run-validator', outcome: 'skipped' },
    ...history.slice(1),
  ]

  const result = await evaluate(context, ['--skip-validator', ...profiles], {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'implement-change',
          workflow_completed: true,
          history: skippedHistory,
        },
    verifyDelivery: async () => ({
      ...delivery(context),
      final_validator: skippedHistory[0],
      workflow_history: skippedHistory,
    }),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const shimDir = join(context.runDir, '.runtime/validator-unavailable/bin')
  for (const invocation of [...runnerInvocations(context), ...auditReplayInvocations(context)]) {
    assert.ok(
      invocation.options.env.PATH.startsWith(`${shimDir}:`),
      `${invocation.args.join(' ')} must resolve agent-validator to the refusing shim`,
    )
  }
  assert.ok(auditReplayInvocations(context).length > 0)
  const shim = await readFile(join(shimDir, 'agent-validator'), 'utf8')
  assert.match(shim, /exit 127/)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.deepEqual(
    written.workflow.events.filter(({ event }) => event === 'validator-unavailable'),
    [{
      event: 'validator-unavailable',
      reason: 'skip-validator',
      mechanism: 'path-shim',
      commands: ['agent-validator', 'agent-validate'],
      blocked_invocations_log: 'logs/blocked-validator-invocations.log',
    }],
  )
})

test('fixture planning preflight validates the selected change directory', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--skip-validator', ...profiles], {
    controllerChangeName: 'custom-scene-change',
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const inspectedPaths = context.invocations
    .filter(({ command, args }) => command === 'git' && args.includes('show'))
    .flatMap(({ args }) => args)
  assert.ok(
    inspectedPaths.some((argument) => argument.includes(
      ':openspec/changes/custom-scene-change/test-plan.md',
    )),
    JSON.stringify(inspectedPaths),
  )
})

test('an incompatible fixture is a typed harness preflight failure and launches no Runner', async () => {
  const context = await environment({ planningReady: false })

  const result = await evaluate(context, ['--skip-validator', ...profiles])

  assert.equal(result.exitCode, 2)
  assert.equal(result.errors[0].code, 'fixture-planning-contract')
  assert.match(result.errors[0].message, /test-plan\.md/)
  assert.equal(runnerInvocations(context).length, 0)
})

test('logical workflow resolution must match the verified pinned workflow before Runner starts', async () => {
  const context = await environment({
    resolvedWorkflow: `${workflowYaml}\n# unexpected newer workflow`,
  })

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context), [])
  assert.match(JSON.stringify(result.errors), /workflow-resolution/)
})

test('a workflow delegating to verify-change is verified and resolved through that sub-workflow', async () => {
  const context = await environment({
    workflow: delegatingWorkflowYaml,
    verificationWorkflow: verificationWorkflowYaml,
  })

  const result = await evaluate(context, profiles, {
    readRunnerState: () => (runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'implement-change',
          workflow_completed: true,
          history: delegatedHistory,
        }),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const inspected = context.invocations
    .filter(({ command, args }) => command === 'agent-runner' && args[0] === 'debug')
    .map(({ args }) => args.at(-1))
  assert.deepEqual(inspected, ['core:implement-change', 'core:verify-change'])
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.history_complete, true)
  assert.deepEqual(written.workflow.missing_steps, [])
})

test('a delegating workflow without its verify-change sub-workflow is rejected before Runner starts', async () => {
  const context = await environment({ workflow: delegatingWorkflowYaml })

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context), [])
  assert.match(JSON.stringify(result.errors), /workflow-contract.*verify-change-v1\.0\.yaml/)
})

test('the resolved verify-change workflow must match the verified checkout before Runner starts', async () => {
  const context = await environment({
    workflow: delegatingWorkflowYaml,
    verificationWorkflow: verificationWorkflowYaml,
    resolvedVerificationWorkflow: `${verificationWorkflowYaml}# unexpected newer workflow\n`,
  })

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context), [])
  assert.match(JSON.stringify(result.errors), /workflow-resolution/)
})

test('task-level and final validation are included by default', async () => {
  const context = await environment()

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.ok(runnerInvocations(context)[0].args.includes('skip_validator=false'))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.final_validator, 'required')
  assert.equal(written.workflow.full_workflow, true)
  assert.equal(written.workflow.configured_stop_step, null)
  assert.equal(runnerInvocations(context)[0].options.env.PATH, process.env.PATH)
  assert.equal(
    written.workflow.events.some(({ event }) => event === 'validator-unavailable'),
    false,
  )
  await assert.rejects(readFile(join(context.runDir, '.runtime/validator-unavailable/bin/agent-validator')))
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
  assert.equal(state.agent_skills_provenance.commit, context.commit)
  assert.match(state.agent_skills_provenance.manifest_sha256, /^[a-f0-9]{64}$/)
  assert.match(state.identity.agent_skills_provenance, /^[a-f0-9]{64}$/)
  assert.equal(state.role_profiles.tester.agent, 'tester')
})

test('an explicit host run identity survives the fixed container artifact mount', async () => {
  const context = await environment({
    runnerResult: { status: 1, stderr: 'runner stopped' },
  })

  await evaluate(context, ['--run-id', 'candidate-cutover-42', ...profiles], {
    readRunnerState: () => null,
  })

  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.equal(state.run_id, 'candidate-cutover-42')
  assert.equal(state.delivery.branch, 'eval/and-scene/candidate-cutover-42')
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

test('a fresh Runner execution waits for its linked audit before delivery verification', async () => {
  const context = await environment()
  let auditFinished = false
  const waited = []

  const result = await evaluate(context, profiles, {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: '/sessions/runner-7',
          workflow_name: 'implement-change',
          workflow_completed: true,
          history,
          audit: {
            links: [{ auditRunId: 'audit-child', state: auditFinished ? 'completed' : 'started' }],
          },
        },
    waitForRun: async (runId) => {
      waited.push(runId)
      auditFinished = true
      return {
        run_id: runId,
        session_dir: '/sessions/runner-7',
        workflow_name: 'implement-change',
        workflow_completed: true,
        history,
        audit: { links: [{ auditRunId: 'audit-child', state: 'completed' }] },
      }
    },
    verifyDelivery: async () => {
      assert.equal(auditFinished, true)
      return delivery(context)
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(waited, ['runner-7'])
  const execution = await readJson(join(context.runDir, 'phases/workflow-execution.json'))
  assert.deepEqual(execution.linked_audits, [{
    run_id: 'audit-child',
    execution_session_id: null,
    trigger: null,
    state: 'completed',
    warning: null,
    outcome: 'failed',
    reason: 'audit finished without a local report',
  }])
  assert.ok(execution.events.some(({ event }) => event === 'linked-audit-failed'))
  const report = await readJson(join(context.runDir, 'result.json'))
  assert.deepEqual(report.workflow.linked_audits, execution.linked_audits)
})

test('a completed core implement-change run without a linked audit starts replay and waits', async () => {
  const context = await environment()
  const waited = []
  // The sandbox has no reporting connection, so the replayed audit's report
  // waits for the host to deliver it.
  await mkdir(join(dirname(context.sessionDir), 'audit-replay'), { recursive: true })
  await writeFile(
    join(dirname(context.sessionDir), 'audit-replay', 'local-report.json'),
    JSON.stringify({ delivery_state: 'pending' }),
  )

  const result = await evaluate(context, profiles, {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'implement-change',
          workflow_completed: true,
          history,
          audit: auditReplayInvocations(context).length === 0
            ? { links: [] }
            : {
                links: [{
                  auditRunId: 'audit-replay',
                  executionSessionId: 'execution-1',
                  trigger: 'replay',
                  state: waited.length > 0 ? 'completed' : 'started',
                }],
              },
        },
    waitForRun: async (runId) => {
      waited.push(runId)
      return {
        run_id: runId,
        session_dir: context.sessionDir,
        workflow_name: 'implement-change',
        workflow_completed: true,
        history,
        audit: {
          links: [{
            auditRunId: 'audit-replay',
            executionSessionId: 'execution-1',
            trigger: 'replay',
            state: 'completed',
          }],
        },
      }
    },
    verifyDelivery: async () => delivery(context),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const replays = auditReplayInvocations(context)
  assert.equal(replays.length, 1)
  assert.deepEqual(replays[0].args, ['audit', 'replay', 'runner-7', '--session', 'execution-1'])
  const source = runnerInvocations(context)[0]
  assert.equal(replays[0].options.cwd, source.options.cwd)
  assert.equal(replays[0].options.env.HOME, source.options.env.HOME)
  assert.equal(replays[0].options.env.AGENT_RUNNER_NO_TUI, '1')
  assert.deepEqual(waited, ['runner-7'])
  const execution = await readJson(join(context.runDir, 'phases/workflow-execution.json'))
  assert.deepEqual(
    execution.events.map(({ event }) => event).filter((event) => (
      event === 'wait-linked-audits' || event === 'linked-audits-terminal'
    )),
    ['wait-linked-audits', 'linked-audits-terminal'],
  )
  assert.deepEqual(execution.linked_audits, [{
    run_id: 'audit-replay',
    execution_session_id: 'execution-1',
    trigger: 'replay',
    state: 'completed',
    warning: null,
    outcome: 'pending-delivery',
    reason: 'Sheets delivery pending',
  }])
  assert.ok(!execution.events.some(({ event }) => event === 'linked-audit-failed'))
  const report = await readJson(join(context.runDir, 'result.json'))
  assert.deepEqual(report.workflow.linked_audits, execution.linked_audits)
})

test('an unreadable linked audit report is recorded as a failed audit with its error', async () => {
  const context = await environment()
  const waited = []
  // The sandbox has no reporting connection, so the replayed audit's report
  // waits for the host to deliver it.
  await mkdir(join(dirname(context.sessionDir), 'audit-replay'), { recursive: true })
  await writeFile(
    join(dirname(context.sessionDir), 'audit-replay', 'local-report.json'),
    '{',
  )

  const result = await evaluate(context, profiles, {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'implement-change',
          workflow_completed: true,
          history,
          audit: auditReplayInvocations(context).length === 0
            ? { links: [] }
            : {
                links: [{
                  auditRunId: 'audit-replay',
                  executionSessionId: 'execution-1',
                  trigger: 'replay',
                  state: waited.length > 0 ? 'completed' : 'started',
                }],
              },
        },
    waitForRun: async (runId) => {
      waited.push(runId)
      return {
        run_id: runId,
        session_dir: context.sessionDir,
        workflow_name: 'implement-change',
        workflow_completed: true,
        history,
        audit: {
          links: [{
            auditRunId: 'audit-replay',
            executionSessionId: 'execution-1',
            trigger: 'replay',
            state: 'completed',
          }],
        },
      }
    },
    verifyDelivery: async () => delivery(context),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const execution = await readJson(join(context.runDir, 'phases/workflow-execution.json'))
  assert.equal(execution.linked_audits[0].outcome, 'failed')
  assert.match(execution.linked_audits[0].reason, /^unreadable local report .*local-report\.json: /)
  assert.ok(execution.events.some(({ event }) => event === 'linked-audit-failed'))
})

test('a completed run with multiple execution sessions replays the last closed session', async () => {
  const context = await environment()
  await writeFile(join(context.sessionDir, 'run-metrics.json'), JSON.stringify({
    sessions: [
      { execution_session_id: 'execution-1', status: 'closed' },
      { execution_session_id: 'execution-2', status: 'closed' },
    ],
  }))

  const result = await evaluate(context, profiles, {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'implement-change',
          workflow_completed: true,
          history,
          audit: {
            links: auditReplayInvocations(context).length === 0
              ? []
              : [{
                  auditRunId: 'audit-replay',
                  executionSessionId: 'execution-2',
                  trigger: 'replay',
                  state: 'completed',
                }],
          },
        },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(auditReplayInvocations(context).map(({ args }) => args), [
    ['audit', 'replay', 'runner-7', '--session', 'execution-2'],
  ])
})

test('a completed Runner run with an existing audit link does not start a second replay', async () => {
  const context = await environment()
  const waited = []

  const result = await evaluate(context, profiles, {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'implement-change',
          workflow_completed: true,
          history,
          audit: {
            links: [{ auditRunId: 'audit-child', state: 'completed' }],
          },
        },
    waitForRun: async (runId) => {
      waited.push(runId)
      return {
        run_id: runId,
        session_dir: context.sessionDir,
        workflow_name: 'implement-change',
        workflow_completed: true,
        history,
        audit: { links: [{ auditRunId: 'audit-child', state: 'completed' }] },
      }
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(auditReplayInvocations(context), [])
  assert.deepEqual(waited, [])
  const execution = await readJson(join(context.runDir, 'phases/workflow-execution.json'))
  assert.equal(execution.linked_audits[0].run_id, 'audit-child')
})

test('a failed explicit audit replay is a harness error', async () => {
  const context = await environment()
  const inner = context.exec
  context.exec = (command, args, options = {}) => {
    const result = inner(command, args, options)
    if (command === 'agent-runner' && args[0] === 'audit') {
      return { status: 1, stdout: '', stderr: 'replay failed' }
    }
    return result
  }

  const result = await evaluate(context, profiles, {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'implement-change',
          workflow_completed: true,
          history,
        },
  })

  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.outcome.product_verdict, 'unavailable')
  assert.equal(auditReplayInvocations(context).length, 1)
})

test('an already-terminal linked audit warning is recorded without changing source success', async () => {
  const context = await environment()

  const result = await evaluate(context, profiles, {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: '/sessions/runner-7',
          workflow_name: 'implement-change',
          workflow_completed: true,
          history,
          audit: {
            links: [{
              auditRunId: 'audit-child',
              executionSessionId: 'execution-1',
              trigger: 'automatic',
              state: 'failed',
              warning: 'crosscheck profile unavailable',
            }],
          },
        },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.equal(result.outcome.evaluation_status, 'pending-human-review')
  const report = await readJson(join(context.runDir, 'result.json'))
  assert.deepEqual(report.workflow.linked_audits, [{
    run_id: 'audit-child',
    execution_session_id: 'execution-1',
    trigger: 'automatic',
    state: 'failed',
    warning: 'crosscheck profile unavailable',
    outcome: 'failed',
    reason: 'crosscheck profile unavailable',
  }])
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

test('a Claude quota exit waits for reset and resumes the exact Runner run', async () => {
  const context = await environment({
    runnerResults: [
      { status: 1, stdout: '' },
      { status: 0, stdout: '' },
    ],
  })
  const waits = []
  const result = await evaluate(context, profiles, {
    readRunnerState: () => {
      const runnerCalls = runnerInvocations(context).length
      if (runnerCalls === 0) return null
      return {
        run_id: 'runner-7',
        session_dir: '/sessions/runner-7',
        workflow_name: 'implement-change',
        workflow_completed: runnerCalls >= 2,
        history: runnerCalls >= 2 ? history : [],
      }
    },
    waitForClaudeQuotaReset: async ({ sessionDir }) => {
      waits.push(sessionDir)
      return { waited: true, reset_at: '2026-08-30T22:00:00.000Z' }
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(waits, [context.sessionDir])
  assert.deepEqual(runnerInvocations(context).map(({ args }) => args[0]), ['run', '--resume'])
})

test('a Claude tester quota during an outer resume waits and retries that same run', async () => {
  const context = await environment({
    runnerResults: [
      { status: 0, stdout: '' },
      { status: 1, stdout: '' },
      { status: 0, stdout: '' },
    ],
  })
  await evaluate(context, profiles)
  const before = runnerInvocations(context).length
  const waits = []

  const result = await evaluate(context, ['--resume', ...profiles], {
    readRunnerState: () => {
      const calls = runnerInvocations(context).length
      return {
        run_id: 'runner-7',
        session_dir: '/sessions/runner-7',
        workflow_name: 'implement-change',
        workflow_completed: calls >= 3,
        history: calls >= 3 ? history : [],
      }
    },
    waitForClaudeQuotaReset: async ({ sessionDir }) => {
      waits.push(sessionDir)
      return {
        waited: true,
        role: 'tester',
        reset_at: '2026-08-30T04:30:00.000Z',
      }
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(waits, [context.sessionDir])
  assert.deepEqual(runnerInvocations(context).slice(before).map(({ args }) => args), [
    ['--resume', 'runner-7'],
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
    'assumption-handling', 'demo-integration', 'engineering-quality', 'presentation-skill',
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
  // The scene-kit job owns every scene-kit criterion, so its surviving
  // checkpoint keeps a complete component score while another job fails.
  const sceneKit = score.components.find(({ id }) => id === 'scene-kit-correctness')
  assert.equal(sceneKit.points_awarded, 20)
  assert.equal(sceneKit.points_observed, 20)
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

test('an evaluator-only rescore imports a completed candidate and never starts Agent Runner', async () => {
  const context = await environment()
  const before = runnerInvocations(context).length
  let identityReverified = false
  let neutralChange = null

  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: null,
    verifyDelivery: async () => {
      throw new Error('rescore must not rediscover historical artifact paths')
    },
    verifyResumeDelivery: async ({ recorded }) => {
      identityReverified = recorded.final_sha === context.commit
      return { verified: true }
    },
    loadRescoreSource: async () => importedRescore(context, {
      changeName: 'custom-scene-change',
    }),
    materializeNeutral: async ({ changeName, identities }) => {
      neutralChange = { changeName, identities: identities.change }
      return null
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.equal(identityReverified, true)
  assert.deepEqual(neutralChange, {
    changeName: 'custom-scene-change',
    identities: ['custom-scene-change'],
  })
  assert.equal(runnerInvocations(context).length, before)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.mode, 'agent-runner')
  assert.equal(written.score_denominator, 100)
  assert.equal(written.delivery.final_sha, context.commit)
  assert.equal(written.workflow.run_id, 'runner-complete')
  assert.equal(written.workflow.events[0].event, 'imported-completed-run')
})

test('a rescore restores a missing Runner session under the run directory and records it', async () => {
  const context = await environment()
  let staging = null
  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: null,
    verifyDelivery: async () => {
      throw new Error('rescore must not rediscover historical artifact paths')
    },
    loadRescoreSource: async ({ stagingDir }) => {
      staging = stagingDir
      return { ...importedRescore(context), session_reconstruction: { source: 'evidence/candidate/artifacts', files: 3 } }
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.equal(staging, join(context.runDir, '.runtime/rescore-session'))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.deepEqual(written.workflow.events[0].session_reconstruction,
    { source: 'evidence/candidate/artifacts', files: 3 })
})

// A source scored under an older rubric has no engineering-quality verdicts and
// no input-hygiene browser evidence. A rescore re-runs the browser probes and
// every judge job under the current rubric, so its result carries both.
test('a rescore of an older run scores the engineering-quality component afresh', async () => {
  const context = await environment()
  const judged = new Map()
  let servedIdentity = null
  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: null,
    verifyDelivery: async () => {
      throw new Error('rescore must not rediscover historical artifact paths')
    },
    loadRescoreSource: async () => importedRescore(context),
    browserDriver: browserDemo(),
    isProcessAlive: () => true,
    candidateServer: {
      probe: async () => ({ ok: true, candidate_identity: servedIdentity }),
      start: async ({ candidate }) => { servedIdentity = candidate; return { pid: 9876, url: 'http://127.0.0.1:4319/' } },
      stop: async () => {},
    },
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') return JSON.stringify({ decision: 'uphold', rationale: 'the recorded failure stands',
        mismeasured_step: null, measurement_fault: null, citations: [], log_citations: [], replay: null })
      if (request.job === 'ambiguity-diagnostics') return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      judged.set(request.job, request.criteria)
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass',
        rationale: 'fixture evidence', evidence: ['src/index.ts:1'] })) })
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome))
  assert.equal(judged.get('engineering-quality')?.length, 14)
  assert.ok(!judged.get('engineering-quality').some((id) => id.startsWith('input-')))
  const written = await readJson(join(context.runDir, 'result.json'))
  const component = written.score.components.find(({ id }) => id === 'engineering-quality')
  assert.equal(component.points_possible, 8)
  const criteria = component.subcomponents.flatMap(({ criteria: rows }) => rows)
  assert.equal(criteria.length, 16)
  assert.ok(criteria.every(({ verdict }) => verdict === 'pass'), JSON.stringify(criteria))
  const browser = await readJson(join(context.runDir, 'phases/browser-evaluation.json'))
  for (const id of ['input-modifier-keys-pass-through', 'input-swipe-from-control-ignored']) {
    assert.equal(browser.criteria.find((row) => row.id === id)?.verdict, 'pass', id)
  }
})

test('a host rescore leaves an existing Agent Runner projects store in the home untouched', async () => {
  const context = await environment()
  await mkdir(join(context.home, '.agent-runner/projects/someone-else'), { recursive: true })
  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: null,
    verifyDelivery: async () => {
      throw new Error('rescore must not rediscover historical artifact paths')
    },
    loadRescoreSource: async () => importedRescore(context),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const projects = await lstat(join(context.home, '.agent-runner/projects'))
  assert.equal(projects.isSymbolicLink(), false)
  assert.ok(projects.isDirectory())
})

test('the controller releases the browser after browser evaluation and after replays', async () => {
  const context = await environment()
  const events = []
  const result = await evaluate(context, profiles, {
    isProcessAlive: () => true,
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    browserDriverFactory: async () => { events.push('driver'); return browserDemo() },
    releaseBrowser: async () => { events.push('release') },
    candidateServer: (() => {
      let servedIdentity = null
      return {
        probe: async () => ({ ok: true, candidate_identity: servedIdentity }),
        start: async ({ candidate }) => {
          servedIdentity = candidate
          return { pid: 9876, url: 'http://127.0.0.1:4319/' }
        },
        stop: async () => {},
      }
    })(),
  })
  assert.ok(events.indexOf('release') > events.indexOf('driver'), JSON.stringify(events))
  assert.equal(events.at(-1), 'release')
  assert.ok(result.exitCode === 0 || result.exitCode === 1)
})

// Agent-evals #78 rep 2 failed in product judging, before metrics were
// recorded, so its result carries no implementation metrics to import.
test('a rescore of a source without recorded metrics reads them from the Runner session', async () => {
  const context = await environment()
  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: null,
    verifyDelivery: async () => {
      throw new Error('rescore must not rediscover historical artifact paths')
    },
    loadRescoreSource: async () => ({ ...importedRescore(context), implementation_metrics: null, cost: null, pricing: null }),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome?.failure ?? result.errors))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.notEqual(written.failed_phase, 'metrics-pricing')
  assert.ok(written.implementation_metrics)
})

test('rescore checks browser failures while a reference baseline does not', async () => {
  const rescoreContext = await environment()
  const broken = () => {
    const driver = browserDemo()
    driver.activate = async () => {}
    return driver
  }
  let rescoreChecks = 0
  const rescore = await evaluate(rescoreContext, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: null,
    loadRescoreSource: async () => importedRescore(rescoreContext),
    browserDriver: broken(),
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') {
        rescoreChecks += 1
        return JSON.stringify({ decision: 'uphold', rationale: 'failure stands',
          mismeasured_step: null, measurement_fault: null, citations: [], log_citations: [], replay: null })
      }
      if (request.job === 'ambiguity-diagnostics') return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass',
        rationale: 'fixture source supports this criterion', evidence: ['src/index.ts'] })) })
    },
  })
  assert.equal(rescore.exitCode, 0, JSON.stringify(rescore.outcome))
  assert.ok(rescoreChecks > 0)
  const referenceContext = await environment()
  let referenceChecks = 0
  const reference = await evaluate(referenceContext, ['--reference-baseline'], {
    browserDriver: broken(),
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') referenceChecks += 1
      if (request.job === 'ambiguity-diagnostics') return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass',
        rationale: 'fixture source supports this criterion', evidence: ['src/index.ts'] })) })
    },
  })
  assert.equal(reference.exitCode, 0, JSON.stringify(reference.outcome))
  assert.equal(referenceChecks, 0)
  const written = await readJson(join(referenceContext.runDir, 'result.json'))
  assert.equal('second_opinions' in written, false)
})

// browserDemo with an inert activate fails only the direct jump, so the
// harness allowlist admits only a control click that moves the step.
const DIRECT_JUMP_REPLAY = { actions: [{ type: 'navigate', path: '/how-to-make-a-presentation' },
  { type: 'click', selector: '[data-step="5"]' }], expect: { type: 'step-index-equals', value: 4 } }
const directJumpObserved = () => ({ passed: true, errors: [], trace: DIRECT_JUMP_REPLAY.actions,
  observations: [{ stepIndex: null }, { stepIndex: 0 }, { stepIndex: 4 }] })

test('rescore starts the candidate server and confirms a browser overturn by replay', async () => {
  const context = await environment()
  const driver = browserDemo()
  driver.activate = async () => {}
  let started = 0
  let replayed = 0
  let servedIdentity = null
  const lifecycle = []
  driver.replay = async () => { replayed += 1; lifecycle.push('replay'); return directJumpObserved() }
  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: null,
    loadRescoreSource: async () => importedRescore(context),
    browserDriver: driver,
    releaseBrowser: async () => { lifecycle.push('release') },
    isProcessAlive: () => true,
    candidateServer: {
      probe: async () => ({ ok: true, candidate_identity: servedIdentity }),
      start: async ({ candidate }) => { started += 1; servedIdentity = candidate;
        return { pid: 9876, url: 'http://127.0.0.1:4319/' } },
      stop: async () => {},
    },
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') return JSON.stringify(request.audit_stage
        ? { results: [{ id: request.criteria[0], classification: 'confirmed',
          rationale: 'source proves navigation', evidence: ['src/index.ts:1'] }] }
        : { decision: 'overturn', rationale: 'probe missed navigation',
          mismeasured_step: 'next', measurement_fault: 'input mismatch',
          citations: [{ path: 'src/index.ts', start_line: 1, end_line: 1 }], log_citations: [],
          replay: DIRECT_JUMP_REPLAY })
      if (request.job === 'ambiguity-diagnostics') return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass',
        rationale: 'fixture evidence', evidence: ['src/index.ts'] })) })
    },
  })
  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome))
  assert.equal(started, 1)
  assert.ok(replayed > 0)
  // The overturn is recorded end to end: verdict, replay plan, and observation.
  const written = await readJson(join(context.runDir, 'result.json'))
  const criterion = written.score.components.flatMap(({ subcomponents }) => subcomponents)
    .flatMap(({ criteria }) => criteria).find(({ id }) => id === 'demo-supported-navigation')
  assert.equal(criterion.verdict, 'pass')
  assert.equal(criterion.second_opinion.decision, 'overturn')
  assert.deepEqual(criterion.second_opinion.replay.actions, DIRECT_JUMP_REPLAY.actions)
  assert.equal(criterion.second_opinion.replay.observations.at(-1).stepIndex, 4)
  const opinions = await readJson(join(context.runDir, 'phases/second-opinions.json'))
  assert.equal(opinions.outcomes['demo-supported-navigation'].replay.passed, true)
  // The host browser is released after the replay rather than held through scoring.
  assert.ok(lifecycle.lastIndexOf('release') > lifecycle.lastIndexOf('replay'), lifecycle.join(' '))
})

test('an evaluator-only rescore accepts a historical reviewer profile as tester', async () => {
  const context = await environment()

  const result = await evaluate(context, [
    '--rescore-from', '/rescore-source',
    '--tester-cli', 'cursor',
    '--tester-model', 'composer',
    '--tester-effort', 'high',
  ], {
    controllerChangeName: null,
    verifyDelivery: async () => {
      throw new Error('rescore must not rediscover historical artifact paths')
    },
    verifyResumeDelivery: async ({ recorded }) => ({
      verified: recorded.final_sha === context.commit,
    }),
    loadRescoreSource: async () => {
      const imported = importedRescore(context, { changeName: 'custom-scene-change' })
      const { tester: _tester, ...profiles } = imported.role_profiles
      return {
        ...imported,
        role_profiles: {
          ...profiles,
          reviewer: { cli: 'claude', model: 'opus', effort: 'high', agent: 'reviewer' },
        },
      }
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.deepEqual(state.role_profiles.tester, {
    cli: 'claude',
    model: 'opus',
    effort: 'high',
    agent: 'tester',
  })
})

test('an evaluator-only rescore rejects an explicit change name that conflicts with its source', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: 'different-change',
    loadRescoreSource: async () => importedRescore(context, {
      changeName: 'source-change',
    }),
  })

  assert.equal(result.exitCode, 2)
  assert.ok(result.errors.some(({ code }) => code === 'rescore-change-name-conflict'))
  assert.deepEqual(runnerInvocations(context), [])
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
  assert.equal(Object.keys(units).length, 16)
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

test('a browser failure receives a checkpointed audited second opinion before scoring', async () => {
  const context = await environment()
  const driver = browserDemo()
  driver.activate = async () => {}
  driver.replay = async () => directJumpObserved()
  const requests = []
  const dependencies = {
    browserDriver: driver,
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') {
        requests.push(request)
        if (request.audit_stage) return JSON.stringify({ results: [{ id: request.criteria[0],
          classification: 'confirmed', rationale: 'the source and observed fault agree',
          evidence: ['src/index.ts:1'] }] })
        return JSON.stringify({ decision: 'overturn', rationale: 'the swipe probe misread input',
          mismeasured_step: 'swipe', measurement_fault: 'input dispatch mismatch',
          citations: [{ path: 'src/index.ts', start_line: 1, end_line: 1 }], log_citations: [],
          replay: DIRECT_JUMP_REPLAY })
      }
      if (request.job === 'ambiguity-diagnostics') {
        return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      }
      if (request.audit_stage) return JSON.stringify({ results: request.criteria.map((id) => ({
        id, classification: 'confirmed', rationale: 'source confirms the behavior', evidence: ['src/index.ts'],
      })) })
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass',
        rationale: 'controller fixture evidence supports this criterion', evidence: ['src/index.ts'],
        citations: request.line_citations === 'evidence-view' ? [] : ['src/index.ts'] })) })
    },
  }
  const result = await evaluate(context, profiles, dependencies)
  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.ok(requests.some((request) => !request.audit_stage))
  // Two verifier samples; the admitted real-browser replay decides without a model audit.
  const verifierSamples = requests.filter((request) => !request.audit_stage).map(({ verifier_sample: sample }) => sample)
  assert.deepEqual([...new Set(verifierSamples)].sort(), [1, 2])
  assert.equal(verifierSamples.filter((sample) => sample === 1).length, verifierSamples.filter((sample) => sample === 2).length)
  // Other failures in this fixture reuse the same replay outside their
  // allowlists, so they reach the audit; the admitted one never does.
  assert.equal(requests.some((request) => request.audit_stage
    && request.criteria.includes('demo-supported-navigation')), false)
  const entry = written.second_opinions.entries.find(({ id }) => id === 'demo-supported-navigation')
  assert.equal(entry?.raw_verdict, 'fail')
  assert.equal(entry?.verdict, 'pass')
  assert.match(await readFile(join(context.runDir, 'report.html'), 'utf8'), /Overturned failures/)
  const calls = requests.length
  const resumed = await evaluate(context, ['--resume', ...profiles], dependencies)
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.outcome))
  assert.equal(requests.length, calls, 'completed verifier units are reused on resume')
})

test('a browser fault during replay leaves the second opinion pending and resumable', async () => {
  const context = await environment()
  const driver = browserDemo()
  driver.activate = async () => {}
  driver.replay = async () => {
    throw Object.assign(new Error('browser adapter failed: Chrome exited'),
      { owner: 'evaluation-harness', code: 'browser-driver-failed', resumable: true })
  }
  const result = await evaluate(context, profiles, {
    browserDriver: driver,
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') {
        if (request.audit_stage) return JSON.stringify({ results: [{ id: request.criteria[0],
          classification: 'confirmed', rationale: 'source and fault agree', evidence: ['src/index.ts:1'] }] })
        return JSON.stringify(request.target.id === 'demo-supported-navigation'
          ? { decision: 'overturn', rationale: 'the direct jump probe misread input',
            mismeasured_step: 'direct jump', measurement_fault: 'input dispatch mismatch',
            citations: [{ path: 'src/index.ts', start_line: 1, end_line: 1 }], log_citations: [],
            replay: DIRECT_JUMP_REPLAY }
          : { decision: 'uphold', rationale: 'failure stands', mismeasured_step: null,
            measurement_fault: null, citations: [], log_citations: [], replay: null })
      }
      if (request.job === 'ambiguity-diagnostics') return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass',
        rationale: 'fixture source supports this criterion', evidence: ['src/index.ts'] })) })
    },
  })
  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.outcome.failure.code, 'judge-output')
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  const unit = state.phases['product-judging'].units['second-opinion:criterion:demo-supported-navigation']
  assert.notEqual(unit.state, 'complete')
  assert.match(JSON.stringify(unit), /Chrome exited/)
  const opinions = await readJson(join(context.runDir, 'phases/second-opinions.json'))
  assert.equal('demo-supported-navigation' in opinions.outcomes, false)
  assert.ok(opinions.pending.some(({ id }) => id === 'demo-supported-navigation'))
})

test('exhausted second-opinion output leaves the failed criterion unresolved', async () => {
  const context = await environment()
  const driver = browserDemo()
  driver.activate = async () => {}
  const result = await evaluate(context, profiles, {
    browserDriver: driver,
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') return '{broken'
      if (request.job === 'ambiguity-diagnostics') return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass',
        rationale: 'fixture source supports this criterion', evidence: ['src/index.ts'] })) })
    },
  })
  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.outcome.failure.code, 'judge-output')
  assert.equal(result.outcome.product_verdict, 'unavailable')
  const scored = await readJson(join(context.runDir, 'phases/score.json'))
  const row = scored.components.flatMap(({ subcomponents }) => subcomponents.flatMap(({ criteria }) => criteria))
    .find(({ id }) => id === 'demo-supported-navigation')
  assert.equal(row.verdict, null)
  assert.equal(row.points_awarded, null)
})

test('an inferred mode mismatch reaches fallback judging and the derived outline gate', async () => {
  const context = await environment()
  const driver = browserDemo()
  const originalState = driver.state.bind(driver)
  let focused = null
  driver.focus = async (name) => { focused = name }
  driver.state = async () => ({ ...await originalState(), mode: 'browse', modeBasis: 'heuristic', focused })
  const judgeCriteria = []
  let secondOpinionCalls = 0
  const result = await evaluate(context, profiles, {
    browserDriver: driver,
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    materializeNeutral: async ({ runDir }) => {
      await mkdir(join(runDir, 'neutral/source/src'), { recursive: true })
      await mkdir(join(runDir, 'neutral/judge'), { recursive: true })
      await mkdir(join(runDir, 'neutral/requirements'), { recursive: true })
      await writeFile(join(runDir, 'neutral/source/src/index.ts'), 'export const fixture = true\n')
      return { source: { root: 'neutral/source' }, judge: { root: 'neutral/judge' },
        requirements: { root: 'neutral/requirements' }, manifest_sha256: 'n'.repeat(64),
        manifest: { entries: [{ namespace: 'neutral-source', path: 'source/src/index.ts' }] } }
    },
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') { secondOpinionCalls += 1; throw new Error('unexpected verifier call') }
      if (request.job === 'ambiguity-diagnostics') {
        return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      }
      if (request.audit_stage) return JSON.stringify({ results: request.criteria.map((id) => ({
        id, classification: 'confirmed', rationale: 'source supports this criterion', evidence: ['src/index.ts'],
      })) })
      if (request.job === 'demo-integration') judgeCriteria.push(...request.criteria)
      return JSON.stringify({ results: request.criteria.map((id) => ({ id, verdict: 'pass',
        rationale: 'source supports this criterion', evidence: ['src/index.ts'],
        citations: request.line_citations === 'evidence-view' ? [] : ['src/index.ts'] })) })
    },
  })
  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome))
  const written = await readJson(join(context.runDir, 'result.json'))
  const outline = written.score.gates.find(({ id }) => id === 'verification-sample-outline')
  assert.equal(outline.raw_browser_gate.verdict, null)
  assert.equal(outline.verdict, 'pass')
  assert.equal(secondOpinionCalls, 0)
  assert.ok(judgeCriteria.includes('demo-nine-step-content-and-order'))
  assert.equal(written.second_opinions.checked, 0)
})

test('a failed outline fallback receives a follow-up opinion after the failed renders gate', async () => {
  const context = await environment()
  const driver = browserDemo()
  let replayCalls = 0
  driver.replay = async () => { replayCalls += 1; return { passed: true } }
  const originalState = driver.state.bind(driver)
  let focused = null
  let failureReads = 0
  driver.focus = async (name) => { focused = name }
  driver.state = async () => ({ ...await originalState(), mode: 'browse', modeBasis: 'heuristic', focused })
  driver.failures = async () => (++failureReads === 1 ? ['console error'] : [])
  const calls = []
  let fallbackRequest = null
  const result = await evaluate(context, profiles, {
    browserDriver: driver,
    verifyCandidate: async () => ({ build: { ok: true, log: 'built' },
      verification: { machine_readable: true, passed: true }, timings: [] }),
    materializeNeutral: async ({ runDir }) => {
      await mkdir(join(runDir, 'neutral/source/src'), { recursive: true })
      await mkdir(join(runDir, 'neutral/judge'), { recursive: true })
      await mkdir(join(runDir, 'neutral/requirements'), { recursive: true })
      await writeFile(join(runDir, 'neutral/source/src/index.ts'), 'export const fixture = true\n')
      return { source: { root: 'neutral/source' }, judge: { root: 'neutral/judge' },
        requirements: { root: 'neutral/requirements' }, manifest_sha256: 'n'.repeat(64),
        manifest: { entries: [{ namespace: 'neutral-source', path: 'source/src/index.ts' }] } }
    },
    judgeInvoke: async (request) => {
      if (request.job === 'second-opinion') {
        if (request.audit_stage) return JSON.stringify({ results: [{ id: request.criteria[0],
          classification: 'confirmed', rationale: 'source and fault agree', evidence: ['src/index.ts'] }] })
        calls.push(request.target)
        if (request.target.kind === 'criterion') fallbackRequest = request
        return JSON.stringify(request.target.kind === 'gate'
          ? { decision: 'uphold', rationale: 'console failure remains', mismeasured_step: null,
            measurement_fault: null, citations: [], log_citations: [], replay: null }
          : { decision: 'overturn', rationale: 'outline title is in source',
            mismeasured_step: 'title reading', measurement_fault: 'mode was inferred',
            citations: [{ path: 'src/index.ts', start_line: 1, end_line: 1 }], log_citations: [],
            replay: null })
      }
      if (request.job === 'ambiguity-diagnostics') return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      if (request.audit_stage) return JSON.stringify({ results: request.criteria.map((id) => ({
        id, classification: 'confirmed', rationale: 'source supports the result', evidence: ['src/index.ts'],
      })) })
      return JSON.stringify({ results: request.criteria.map((id) => ({ id,
        verdict: id === 'demo-nine-step-content-and-order' ? 'fail' : 'pass',
        rationale: 'fixture source result', evidence: ['src/index.ts'], citations: request.line_citations === 'evidence-view' ? [] : ['src/index.ts'] })) })
    },
  })
  assert.equal(result.exitCode, 0, JSON.stringify(result.outcome))
  // Each target gets two verifier samples, in target order.
  assert.deepEqual([...new Set(calls.map(({ id }) => id))],
    ['verification-every-produced-step-renders', 'demo-nine-step-content-and-order'])
  assert.equal(calls.find(({ id }) => id === 'demo-nine-step-content-and-order').on_behalf_of, 'verification-sample-outline')
  assert.equal(fallbackRequest.browser_derived, false)
  assert.equal(fallbackRequest.failing_record.verdict, 'fail')
  assert.equal(replayCalls, 0)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.score.gates.find(({ id }) => id === 'verification-sample-outline').verdict, 'pass')
  assert.equal(written.score.gates.find(({ id }) => id === 'verification-every-produced-step-renders').verdict, 'fail')
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

test('a terminal build failure is checked before becoming a product failure', async () => {
  const context = await environment()
  const output = `${'build output '.repeat(400)}\nharness invoked wrong command\n`
  const result = await evaluate(context, profiles, {
    verifyCandidate: async () => ({ build: { ok: false, log: output.slice(0, 4000) },
      verification: { machine_readable: false, passed: null }, timings: [{ label: 'build', stdout: output, stderr: '' }],
      product_failure: { stage: 'build', gate: 'verification-build-whole-app', reason: 'build failed' } }),
    judgeInvoke: async (request) => {
      assert.equal(request.job, 'second-opinion')
      assert.match(request.prompt, /harness invoked wrong command/)
      return JSON.stringify({ decision: 'uphold', rationale: 'the build failure stands',
        mismeasured_step: null, measurement_fault: null, citations: [], log_citations: [], replay: null })
    },
  })
  assert.equal(result.outcome.product_verdict, 'fail')
  assert.equal(result.outcome.product_failure.second_opinion.decision, 'uphold')
  const evidence = await readFile(join(context.runDir,
    'phases/terminal-evidence/verification-build-whole-app.log'), 'utf8')
  assert.match(evidence, /harness invoked wrong command/)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.second_opinions.checked, 1)
})

test('an audited terminal overturn leaves a resumable harness failure and no product verdict', async () => {
  const context = await environment()
  const result = await evaluate(context, profiles, {
    verifyCandidate: async () => ({ build: { ok: false, log: 'wrong command' },
      verification: { machine_readable: false, passed: null },
      timings: [{ label: 'build', stdout: 'wrong command', stderr: '' }],
      product_failure: { stage: 'build', gate: 'verification-build-whole-app', reason: 'build failed' } }),
    judgeInvoke: async (request) => {
      if (request.audit_stage) return JSON.stringify({ results: [{ id: 'verification-build-whole-app',
        classification: 'confirmed', rationale: 'the command was wrong', evidence: ['log and source'] }] })
      return JSON.stringify({ decision: 'overturn', rationale: 'the harness ran the wrong command',
        mismeasured_step: 'build invocation', measurement_fault: 'wrong command',
        citations: [{ path: 'src/index.ts', start_line: 1, end_line: 1 }],
        log_citations: [{ artifact: request.log_artifact, start_line: 5, end_line: 5 }], replay: null })
    },
  })
  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.outcome.failure.code, 'terminal-failure-overturned')
  assert.equal(result.outcome.product_verdict, 'unavailable')
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.second_opinions.overturned, 1)
  assert.equal(written.terminal_failure.reason, 'build failed')
  assert.equal(written.terminal_failure.second_opinion.decision, 'overturn')
})

test('a terminal build failure without a verifier invoker is a judge-output harness failure', async () => {
  const context = await environment()
  const result = await evaluate(context, profiles, {
    verifyCandidate: async () => ({ build: { ok: false, log: 'build failed' },
      verification: { machine_readable: false, passed: null }, timings: [],
      product_failure: { stage: 'build', gate: 'verification-build-whole-app', reason: 'build failed' } }),
    judgeInvoke: null,
  })
  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.outcome.failure.code, 'judge-output')
  assert.equal(result.outcome.product_verdict, 'unavailable')
})

test('evaluator-only rescore refreshes retained Codex usage and pricing', async () => {
  const context = await environment()
  const fixture = JSON.parse(await readFile(new URL('./fixtures/feature-43-retained-attempts.json', import.meta.url)))
  const entries = JSON.parse(await readFile(new URL('./fixtures/feature-43-catalog.json', import.meta.url)))
  const imported = importedRescore(context)
  imported.implementation_metrics = { state: 'ingested', complete: true, attempts: fixture.attempts }
  imported.pricing = { complete: false, costs: [] }
  imported.cost = { total: { state: 'unavailable' } }
  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    loadRescoreSource: async () => imported,
    pricingFetch: async () => ({ ok: true, text: async () => JSON.stringify(entries) }),
  })
  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const phase = await readJson(join(context.runDir, 'phases/metrics-pricing.json'))
  assert.equal(phase.repriced, true)
  assert.equal(phase.pricing.repriced_from.run_id, imported.source_run_id)
  assert.equal(phase.cost.steps.length, fixture.attempts.length)
  const codex = phase.pricing.costs.filter((cost) => cost.source === 'models.dev' && cost.verification === 'estimated')
  assert.equal(codex.length, 11)
  assert.ok(codex.every((cost) => cost.provenance.assumptions.includes('cache_write_not_reported_priced_as_input')))
  assert.ok(Math.abs(codex.reduce((sum, cost) => sum + cost.amount_usd, 0) - 0.8257) < 1e-4)
  assert.equal(phase.pricing.costs.filter((cost) => cost.source === 'agent-runner-reported').length, 6)
  const validatorIds = new Set(fixture.attempts.filter((attempt) => attempt.usage_source === 'agent-validator:metrics').map((attempt) => attempt.attempt_id))
  const validators = phase.pricing.costs.filter((cost) => validatorIds.has(cost.attempt_id))
  assert.equal(validators.length, 16)
  assert.ok(validators.every((cost) => cost.state === 'unavailable' && cost.reason === 'exact provider and model identity are required for pricing'))
})

test('published result reports the leaf of the last nested workflow step', async () => {
  const context = await environment({
    workflow: delegatingWorkflowYaml,
    verificationWorkflow: verificationWorkflowYaml,
  })
  const nestedHistory = delegatedHistory
  const result = await evaluate(context, profiles, {
    verifyDelivery: async () => ({
      ...delivery(context),
      final_validator: { ...nestedHistory[1], step: 'run-validator' },
      workflow_history: nestedHistory,
    }),
    readRunnerState: () => (runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'implement-change',
          workflow_completed: true,
          history: nestedHistory,
        }),
  })
  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.last_observed_step, 'verify-acceptance-handoff')
  assert.equal(written.delivery.final_validator.step, 'run-validator')
  assert.deepEqual(written.delivery.final_validator.step_path, [
    'verify-change', 'sub:verify-change', 'run-validator',
  ])
  assert.deepEqual(written.workflow.observed_steps.at(-1).step_path, ['verify-change'])
})

for (const [code, resumable] of [['claude-quota', true], ['judge-schema-invalid', false]]) test(`judge ${code} survives into the durable harness outcome`, async () => {
  const context = await environment()
  const result = await evaluate(context, profiles, {
    judgeInvoke: async request => {
      if (request.job === 'testing-evidence') throw Object.assign(new Error(`original ${code} diagnostic`), {
        code, resumable, retryable: false, owner: 'evaluation-harness',
      })
      if (!Array.isArray(request.criteria)) return JSON.stringify({ findings: [], coverage: 'complete', proposals: [] })
      return JSON.stringify({ results: request.criteria.map(id => ({ id, verdict: 'pass', rationale: 'fixture proof', evidence: ['fixture'] })) })
    },
  })
  assert.equal(result.outcome.evaluation_status, 'evaluation-harness-failed')
  assert.equal(result.outcome.failure.code, code)
  assert.equal(result.outcome.resumable, resumable)
  assert.match(result.outcome.failure.reason, new RegExp(`original ${code} diagnostic`))
  const judging = await readJson(join(context.runDir, 'phases/product-judging.json'))
  assert.equal(judging.failures['testing-evidence'].code, code)
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.match(state.phases['product-judging'].units['testing-evidence'].error, new RegExp(`original ${code} diagnostic`))
})
