import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { runEvaluation } from '../evals/agent-runner/and-scene/controller.mjs'
import { loadCheckpoint } from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'
import { hashJson, hashString, readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { verifyCandidateDelivery } from '../evals/agent-runner/and-scene/lib/candidate.mjs'
import { DEMO_CONTRACT } from '../evals/agent-runner/and-scene/lib/demo-contract.mjs'

const WORKFLOW_RELATIVE_PATH = 'workflows/core/plan-and-implement-change-v1.0.yaml'

const workflowYaml = `name: plan-and-implement-change
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
  '--crosscheck-cli', 'codex', '--crosscheck-model', 'gpt-5', '--crosscheck-effort', 'medium',
  '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
  '--tester-cli', 'claude', '--tester-model', 'opus', '--tester-effort', 'high',
]

async function environment({
  workflow = workflowYaml,
  resolvedWorkflow = workflow,
  // Further workflows in the checkout, by logical reference: { file, text }.
  extraWorkflows = {},
  dirty = '',
  commit = 'a'.repeat(40),
  ghAuthenticated = true,
  ghPermission = 'WRITE',
  planningReady = true,
  // The pinned fixture starts from definition artifacts only; true plants a
  // task index and task file the starting-line preflight must reject.
  fixtureHasTasks = false,
  runnerResult = { status: 0, stdout: '' },
  runnerResults = null,
} = {}) {
  const root = await makeTempDir(join(tmpdir(), 'agent-evals-controller-'))
  const agentRunnerDir = join(root, 'agent-runner')
  const agentSkillsDir = join(root, 'agent-skills')
  await mkdir(join(agentRunnerDir, 'workflows/core'), { recursive: true })
  if (workflow !== null) await writeFile(join(agentRunnerDir, WORKFLOW_RELATIVE_PATH), workflow)
  for (const { file, text } of Object.values(extraWorkflows)) {
    await writeFile(join(agentRunnerDir, file), text)
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
      if (joined.includes('show') && /\/(?:proposal|design)\.md/.test(joined)) {
        return { status: 0, stdout: '# Planning artifact\n' }
      }
      if (joined.includes('show') && /\/specs\/[^/]+\/spec\.md/.test(joined)) {
        return { status: 0, stdout: '# Specification\n' }
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
        if (fixtureHasTasks && planningPath.endsWith('/tasks')) {
          return { status: 0, stdout: `${planningPath}/01-demo.md\n` }
        }
        if (fixtureHasTasks && planningPath.endsWith('/tasks.md')) {
          return { status: 0, stdout: `${planningPath}\n` }
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
      const extra = extraWorkflows[args.at(-1)]
      if (extra) return { status: 0, stdout: extra.text }
      if (args.at(-1) !== 'core:plan-and-implement-change') {
        return { status: 1, stderr: `workflow ref ${args.at(-1)} not found` }
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
        workflow_name: 'plan-and-implement-change',
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
    run_status: 'completed',
    publication_boundary: { verified: true, scope: 'final-state-only' },
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
    run_completed: true,
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
    { step: 'run-validator', outcome: 'success' },
    ...history.slice(1),
  ]

  const result = await evaluate(context, ['--skip-validator', ...profiles], {
    readRunnerState: () => runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: '/sessions/runner-7',
          workflow_name: 'plan-and-implement-change',
          workflow_completed: true,
          history: skippedHistory,
        },
    observedSteps: (state) => state.history,
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const [invocation] = runnerInvocations(context)
  assert.deepEqual(invocation.args, [
    'run',
    'core:plan-and-implement-change',
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
  assert.equal(written.workflow.validator_mode, 'skipped')
  // The requested mode is recorded, not verified: a run-validator step that
  // reported success here does not contradict it.
  assert.deepEqual(written.workflow.observed_steps, skippedHistory)
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
          workflow_name: 'plan-and-implement-change',
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

test('a fixture that still carries tasks is a starting-line preflight failure and launches no Runner', async () => {
  const context = await environment({ fixtureHasTasks: true })

  const result = await evaluate(context, ['--skip-validator', ...profiles])

  assert.equal(result.exitCode, 2)
  assert.equal(result.errors[0].code, 'fixture-planning-contract')
  assert.match(result.errors[0].message, /openspec\/changes\/create-and-scene\/tasks\.md/)
  assert.match(result.errors[0].message, /openspec\/changes\/create-and-scene\/tasks\/01-demo\.md/)
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

const orchestratedYaml = workflowYaml
  .replace('name: plan-and-implement-change', 'name: orchestrated-implement-change')
  .replace(/steps:\n[\s\S]*$/, 'steps:\n  - id: orchestrate\n  - id: merge-pr\n')

test('a selected workflow is resolved, launched, and recorded without workflow-specific code', async () => {
  const context = await environment({
    extraWorkflows: {
      'core:orchestrated-implement-change': {
        file: 'workflows/core/orchestrated-implement-change-v1.0.yaml',
        text: orchestratedYaml,
      },
    },
  })
  const foreignHistory = [
    { step: 'orchestrate', step_path: ['orchestrate'], outcome: 'success' },
    { step: 'merge-pr', step_path: ['merge-pr'], outcome: 'success' },
  ]

  const result = await evaluate(context, ['--workflow', 'core:orchestrated-implement-change', ...profiles], {
    readRunnerState: () => (runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'orchestrated-implement-change',
          workflow_completed: true,
          history: foreignHistory,
        }),
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const inspected = context.invocations
    .filter(({ command, args }) => command === 'agent-runner' && args[0] === 'debug')
    .map(({ args }) => args.at(-1))
  assert.deepEqual(inspected, ['core:orchestrated-implement-change'])
  assert.equal(runnerInvocations(context)[0].args[1], 'core:orchestrated-implement-change')
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.workflow, 'core:orchestrated-implement-change')
  assert.equal(written.workflow.runner_workflow_name, 'orchestrated-implement-change')
  assert.equal(written.workflow.workflow_sha256, hashString(orchestratedYaml))
  assert.equal(written.workflow.workflow_path, hashString(orchestratedYaml))
  assert.equal(written.workflow.provenance.workflow, 'core:orchestrated-implement-change')
  // Step names are data: a step named like a prohibited effect is not one.
  assert.deepEqual(written.workflow.observed_steps, foreignHistory)
  assert.equal(written.evaluation_status, 'pending-human-review')
})

test('a selected workflow that does not resolve stops before Runner starts', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--workflow', 'core:not-a-workflow', ...profiles])

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context), [])
  assert.equal(result.errors[0].code, 'workflow-resolution')
  assert.match(result.errors[0].message, /core:not-a-workflow/)
})

test('a malformed workflow reference is rejected as an invalid argument', async () => {
  const context = await environment()

  const result = await evaluate(context, ['--workflow', 'plan-and-implement-change', ...profiles])

  assert.equal(result.exitCode, 2)
  assert.equal(result.errors[0].code, 'invalid-arguments')
  assert.deepEqual(runnerInvocations(context), [])
})

test('a workflow lacking a required parameter is rejected before Runner starts and names it', async () => {
  const context = await environment({
    workflow: workflowYaml.replace('  - name: artifact_validation_instruction\n    required: true\n', ''),
  })

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 2)
  assert.deepEqual(runnerInvocations(context), [])
  assert.equal(result.errors[0].code, 'workflow-parameters')
  assert.match(result.errors[0].message, /artifact_validation_instruction/)
})

test('a discovered run reporting another workflow is not adopted', async () => {
  const context = await environment()

  const result = await evaluate(context, profiles, {
    readRunnerState: () => ({
      run_id: 'runner-old',
      session_dir: context.sessionDir,
      workflow_name: 'implement-change',
      workflow_completed: true,
      history,
    }),
  })

  assert.equal(result.exitCode, 1)
  assert.deepEqual(runnerInvocations(context), [])
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.failure.code, 'workflow-identity')
  assert.match(written.failure.message ?? written.failure.error ?? JSON.stringify(written.failure), /plan-and-implement-change/)
})

test('a resume that selects a different workflow is a resume-provenance error', async () => {
  const context = await environment({
    extraWorkflows: {
      'core:orchestrated-implement-change': {
        file: 'workflows/core/orchestrated-implement-change-v1.0.yaml',
        text: orchestratedYaml,
      },
    },
  })
  await evaluate(context, profiles)
  const before = runnerInvocations(context).length

  const result = await evaluate(context, ['--resume', '--workflow', 'core:orchestrated-implement-change', ...profiles])

  assert.equal(result.exitCode, 2)
  assert.ok(result.errors.some(({ code, field }) => code === 'resume-provenance' && field === 'workflow'), JSON.stringify(result.errors))
  assert.equal(runnerInvocations(context).length, before)
})

test('task-level and final validation are included by default', async () => {
  const context = await environment()

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.ok(runnerInvocations(context)[0].args.includes('skip_validator=false'))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.final_validator, 'required')
  assert.equal(written.workflow.validator_mode, 'required')
  assert.equal(written.workflow.full_workflow, true)
  assert.equal(written.workflow.workflow, 'core:plan-and-implement-change')
  assert.equal(written.workflow.runner_workflow_name, 'plan-and-implement-change')
  assert.equal(written.workflow.workflow_sha256, hashString(workflowYaml))
  assert.equal(written.workflow.run_completed, true)
  assert.equal(written.workflow.provenance.commit, context.commit)
  assert.equal(written.workflow.provenance.cli_version, 'agent-runner 2.4.0')
  assert.equal(runnerInvocations(context)[0].options.env.PATH, process.env.PATH)
  assert.equal(
    written.workflow.events.some(({ event }) => event === 'validator-unavailable'),
    false,
  )
  await assert.rejects(readFile(join(context.runDir, '.runtime/validator-unavailable/bin/agent-validator')))
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

test('the crosscheck profile is configured and recorded wherever role profiles are', async () => {
  const context = await environment()

  const result = await evaluate(context, profiles)

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const crosscheck = { cli: 'codex', model: 'gpt-5', effort: 'medium', agent: 'crosscheck' }
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.deepEqual(state.role_profiles.crosscheck, crosscheck)
  assert.deepEqual(Object.keys(state.role_profiles), ['lead', 'crosscheck', 'implementor', 'tester'])
  const preflight = await readJson(join(context.runDir, 'phases/preflight.json'))
  assert.deepEqual(preflight.role_profiles.crosscheck, crosscheck)
  const execution = await readJson(join(context.runDir, 'phases/workflow-execution.json'))
  assert.deepEqual(execution.role_profiles.crosscheck, crosscheck)
  const config = await readFile(
    join(context.runDir, '.runtime/candidate-worktree/.agent-runner/config.yaml'),
    'utf8',
  )
  assert.match(config, /crosscheck:\n {8}default_mode: autonomous\n {8}cli: codex\n {8}model: gpt-5\n {8}effort: medium/)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.deepEqual(written.role_configuration.roles.crosscheck.configured, crosscheck)
  assert.equal(written.role_configuration.roles.crosscheck.invocation, 'not-invoked')
  const report = await readFile(join(context.runDir, 'report.html'), 'utf8')
  assert.match(report, /crosscheck/)
})

test('a new run without a crosscheck profile is rejected before Runner starts', async () => {
  const context = await environment()
  const withoutCrosscheck = profiles.filter((value, index) => (
    !profiles[index - (index % 2)].startsWith('--crosscheck-')
  ))

  const result = await evaluate(context, withoutCrosscheck)

  assert.equal(result.exitCode, 2)
  assert.deepEqual(
    result.errors.map(({ code, role, field }) => [code, role, field]),
    [['invalid-role-profile', 'crosscheck', 'profile']],
  )
  assert.deepEqual(runnerInvocations(context), [])
})

test('a Cursor lead is rejected before any model execution', async () => {
  const context = await environment()
  const cursorLead = profiles.map((value, index) => (
    profiles[index - 1] === '--lead-cli' ? 'cursor' : value
  ))

  const result = await evaluate(context, cursorLead)

  assert.equal(result.exitCode, 2)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].role, 'lead')
  assert.match(result.errors[0].message, /Cursor agent calls are not yet verified/)
  assert.deepEqual(runnerInvocations(context), [])
})

test('a resume that changes only the crosscheck profile is rejected', async () => {
  const context = await environment()
  await evaluate(context, profiles)
  const before = runnerInvocations(context).length
  const changed = profiles.map((value, index) => (
    profiles[index - 1] === '--crosscheck-model' ? 'gpt-6' : value
  ))

  const result = await evaluate(context, ['--resume', ...changed])

  assert.equal(result.exitCode, 2)
  assert.deepEqual(
    result.errors.map(({ code, role, field, recorded, requested }) => [code, role, field, recorded, requested]),
    [['role-profile-mismatch', 'crosscheck', 'model', 'gpt-5', 'gpt-6']],
  )
  assert.equal(runnerInvocations(context).length, before)
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
    materializeNeutral: async ({ finalSha, fixtureCommit }) => {
      order.push(`neutral:${finalSha}`)
      order.push(`requirements:${fixtureCommit}`)
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
    `requirements:${context.commit}`,
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
      workflow_name: 'plan-and-implement-change',
      lock: { pid: 99, run_id: 'runner-7' },
    }),
    waitForRun: async (runId) => {
      waited.push(runId)
      return {
        run_id: runId,
        session_dir: '/sessions/runner-7',
        workflow_name: 'plan-and-implement-change',
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
          workflow_name: 'plan-and-implement-change',
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
        workflow_name: 'plan-and-implement-change',
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

test('a completed evaluated-workflow run without a linked audit starts replay and waits', async () => {
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
          workflow_name: 'plan-and-implement-change',
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
        workflow_name: 'plan-and-implement-change',
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
          workflow_name: 'plan-and-implement-change',
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
        workflow_name: 'plan-and-implement-change',
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
          workflow_name: 'plan-and-implement-change',
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
          workflow_name: 'plan-and-implement-change',
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
        workflow_name: 'plan-and-implement-change',
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
          workflow_name: 'plan-and-implement-change',
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
          workflow_name: 'plan-and-implement-change',
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
            workflow_name: 'plan-and-implement-change',
            workflow_completed: false,
          }
        : {
            run_id: 'runner-7',
            session_dir: '/sessions/runner-7',
            workflow_name: 'plan-and-implement-change',
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
        workflow_name: 'plan-and-implement-change',
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
        workflow_name: 'plan-and-implement-change',
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
      workflow_name: 'plan-and-implement-change',
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
    // Delivery goes through the outcome checks; whatever artifact paths they
    // rediscover, the hash-verified recorded evidence is what is kept.
    verifyDelivery: async ({ runCompleted, sessionDir }) => {
      identityReverified = runCompleted === true && sessionDir === context.root
      return {
        ...delivery(context),
        acceptance_artifacts: [{ role: 'acceptance-handoff', path: '/rediscovered/handoff.md', sha256: 'c'.repeat(64) }],
      }
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
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.deepEqual(state.delivery.acceptance.artifacts, delivery(context).acceptance_artifacts)
  assert.equal(written.workflow.run_id, 'runner-complete')
  assert.equal(written.workflow.events[0].event, 'imported-completed-run')
})

test('a rescore pins judged requirements to the imported run\'s recorded fixture commit', async () => {
  const context = await environment()
  const olderFixture = 'e'.repeat(40)
  const exec = (command, args, options) => (
    command === 'git' && args.includes(`${olderFixture}^{commit}`)
      ? { status: 0, stdout: `${olderFixture}\n` }
      : context.exec(command, args, options)
  )
  let pinned = null

  const result = await evaluate({ ...context, exec }, ['--rescore-from', '/rescore-source'], {
    loadRescoreSource: async () => {
      const imported = importedRescore(context)
      return { ...imported, candidate_source: { ...imported.candidate_source, fixture_commit: olderFixture } }
    },
    materializeNeutral: async ({ finalSha, fixtureCommit }) => {
      pinned = { finalSha, fixtureCommit }
      return null
    },
  })

  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  assert.deepEqual(pinned, { finalSha: context.commit, fixtureCommit: olderFixture })
})

test('a rescore restores a missing Runner session under the run directory and records it', async () => {
  const context = await environment()
  let staging = null
  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    controllerChangeName: null,
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

// A source recorded by the implement-only workflow: `core:implement-change`
// against the hand-written-tasks fixture f0695b9, with lead, implementor, and
// tester profiles only and the history-verdict completion record of its time.
const LEGACY_FIXTURE = 'f0695b96c0c23b2d17ecc6cfbaf8be1fcdedd6f8'
const LEGACY_SESSION = '.runtime/agent-runner-projects/-artifacts--runtime-candidate-worktree/runs/implement-change-2026-08-28T20-15-27Z'
const LEGACY_PROFILES = {
  lead: { cli: 'codex', model: 'gpt-5', effort: 'high', agent: 'lead' },
  implementor: { cli: 'claude', model: 'sonnet', effort: 'medium', agent: 'implementor' },
  tester: { cli: 'claude', model: 'opus', effort: 'high', agent: 'tester' },
}

async function legacyImplementOnlySource(context, { retainSession = true } = {}) {
  const sourceDir = await makeTempDir(join(tmpdir(), 'and-scene-legacy-source-'))
  const sessionDir = join(sourceDir, LEGACY_SESSION)
  const evidence = [
    ['final-handoff', 'acceptance-handoff.md', `Ready SHA: ${context.commit}\n`],
    ['findings-history', 'acceptance-findings.md', 'No remaining findings.\n'],
  ]
  const artifacts = []
  for (const [role, relativePath, bytes] of evidence) {
    await mkdir(join(sessionDir, 'output'), { recursive: true })
    await writeFile(join(sessionDir, 'output', relativePath), bytes)
    artifacts.push({ role, path: `/artifacts/${LEGACY_SESSION}/output/${relativePath}`, sha256: hashString(bytes) })
  }
  const recordedDelivery = {
    ...delivery(context),
    base_branch: 'main',
    fixture_commit: LEGACY_FIXTURE,
    acceptance_artifacts: artifacts,
  }
  const arguments_ = [
    'change_name=create-and-scene',
    'change_dir=openspec/changes/create-and-scene',
    'skip_validator=false',
  ]
  const candidateSource = {
    repository: 'github.com/Codagent-AI/and-scene',
    fixture_commit: LEGACY_FIXTURE,
    branch: recordedDelivery.branch,
    base_branch: 'main',
  }
  const state = {
    schema_version: 2,
    state_kind: 'and-scene-run-state',
    run_id: 'legacy-implement-only',
    run_kind: 'candidate',
    identity: { candidate_repository: candidateSource.repository },
    candidate_source: candidateSource,
    delivery: {
      applicable: true,
      ...candidateSource,
      origin: candidateSource.repository,
      pull_request: recordedDelivery.pull_request,
      final_sha: recordedDelivery.final_sha,
      acceptance: { artifacts },
    },
    agent_runner: { run_id: 'implement-change-2026-08-28', session_dir: `/artifacts/${LEGACY_SESSION}` },
    role_profiles: LEGACY_PROFILES,
    agent_runner_provenance: { commit: '3'.repeat(40), workflow_sha256: '4'.repeat(64), complete: true },
    agent_skills_provenance: { commit: '5'.repeat(40), manifest_sha256: '6'.repeat(64), complete: true },
  }
  const result = {
    schema_version: 4,
    run_id: state.run_id,
    run_kind: 'candidate',
    mode: 'agent-runner',
    candidate_source: candidateSource,
    workflow: {
      workflow: 'implement-change',
      workflow_path: 'workflows/core/implement-change-v1.0.yaml',
      arguments: arguments_,
      full_workflow: true,
      history_complete: true,
      missing_steps: [],
      prohibited_effects: [],
    },
    role_configuration: {
      applicable: true,
      roles: {
        lead: { configured: LEGACY_PROFILES.lead, attempts: [] },
        implementor: { configured: LEGACY_PROFILES.implementor, attempts: [] },
        reviewer: { configured: LEGACY_PROFILES.tester, attempts: [] },
      },
    },
  }
  if (!retainSession) {
    // A factory run keeps hash-verified copies but drops its Runner session.
    const retained = []
    for (const [index, [role, relativePath, bytes]] of evidence.entries()) {
      const path = `evidence/candidate/artifacts/candidate-${index}-${relativePath}`
      await mkdir(join(sourceDir, 'evidence/candidate/artifacts'), { recursive: true })
      await writeFile(join(sourceDir, path), bytes)
      retained.push({ id: `candidate-${index}`, role,
        origin: { namespace: 'runner-session', relative_path: `output/${relativePath}` },
        path, sha256: hashString(bytes) })
    }
    const manifest = { schema_version: 1, ownership: 'candidate-produced', artifacts: retained }
    manifest.manifest_sha256 = hashJson(manifest)
    await writeFile(join(sourceDir, 'evidence/candidate/manifest.json'), `${JSON.stringify(manifest)}\n`)
    state.delivery.acceptance.manifest_sha256 = manifest.manifest_sha256
    // Its run state predates recorded role profiles; its result names them.
    delete state.role_profiles
    await rm(join(sourceDir, '.runtime'), { recursive: true, force: true })
  }
  await mkdir(join(sourceDir, 'phases'), { recursive: true })
  await writeFile(join(sourceDir, 'run-state.json'), `${JSON.stringify(state)}\n`)
  await writeFile(join(sourceDir, 'result.json'), `${JSON.stringify(result)}\n`)
  await writeFile(join(sourceDir, 'phases/delivery-verification.json'), `${JSON.stringify(recordedDelivery)}\n`)
  return { sourceDir, sessionDir, artifacts }
}

// The outcome-based checks a new run's delivery goes through, observing a
// remote branch and draft pull request that still match the recorded delivery.
function observedLegacyDelivery(context, calls) {
  const exec = (command, args, options) => (
    command === 'git' && args.includes('ls-remote') && args.includes('--heads')
      ? { status: 0, stdout: `${context.commit}\trefs/heads/eval/and-scene/run-1\n` }
      : context.exec(command, args, options)
  )
  return async (options) => {
    const handoff = await readFile(join(options.sessionDir, 'output/acceptance-handoff.md'), 'utf8')
    calls.push({ ...options, handoff })
    return verifyCandidateDelivery({
      ...options,
      exec,
      inspectPullRequest: async () => delivery(context).pull_request,
    })
  }
}

async function rescoreLegacySource({ retainSession }) {
  const context = await environment({ commit: LEGACY_FIXTURE, planningReady: false })
  await mkdir(join(context.runDir, '.runtime/candidate-worktree/openspec/changes/create-and-scene'), { recursive: true })
  const source = await legacyImplementOnlySource(context, { retainSession })
  const calls = []
  const result = await evaluate(context, ['--rescore-from', source.sourceDir], {
    controllerChangeName: null,
    verifyDelivery: observedLegacyDelivery(context, calls),
    verifyResumeDelivery: async () => {
      throw new Error('a rescore verifies delivery through the outcome checks, not the step-era identity check')
    },
  })
  return { context, source, calls, result }
}

function assertLegacyRescore({ context, calls, result }) {
  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  // Agent Runner is never invoked in any form, and no planning preflight reads
  // the fixture's definition files.
  assert.deepEqual(context.invocations.filter(({ command }) => command === 'agent-runner'), [])
  assert.deepEqual(context.invocations.filter(({ command, args }) => (
    command === 'git' && args.includes('show') && args.some((arg) => /\/(?:test-plan|tasks)\.md$/.test(arg))
  )), [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].runCompleted, true)
  assert.equal(calls[0].fixtureCommit, LEGACY_FIXTURE)
  assert.equal(calls[0].handoff, `Ready SHA: ${context.commit}\n`)
}

async function assertLegacyRecord(context, source) {
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.workflow, 'implement-change')
  assert.equal(written.workflow.runner_workflow_name, 'implement-change')
  assert.equal(written.workflow.workflow_path, 'workflows/core/implement-change-v1.0.yaml')
  assert.deepEqual(written.workflow.arguments, [
    'change_name=create-and-scene',
    'change_dir=openspec/changes/create-and-scene',
    'skip_validator=false',
  ])
  assert.equal(written.candidate_source.fixture_commit, LEGACY_FIXTURE)
  assert.deepEqual(Object.keys(written.role_configuration.roles).sort(), ['implementor', 'lead', 'tester'])
  assert.equal(written.delivery.publication_boundary.verified, true)
  const state = await loadCheckpoint(join(context.runDir, 'run-state.json'))
  assert.deepEqual(state.role_profiles, LEGACY_PROFILES)
  assert.deepEqual(
    state.delivery.acceptance.artifacts.map(({ role, sha256 }) => ({ role, sha256 })),
    source.artifacts.map(({ role, sha256 }) => ({ role, sha256 })),
  )
}

test('a three-role implement-only source with a retained Runner session is rescored from its completion record', async () => {
  const run = await rescoreLegacySource({ retainSession: true })

  assertLegacyRescore(run)
  assert.equal(run.calls[0].sessionDir, await realpath(run.source.sessionDir))
  await assertLegacyRecord(run.context, run.source)
})

test('a three-role implement-only source with reconstructed evidence is rescored without live Runner state', async () => {
  const run = await rescoreLegacySource({ retainSession: false })

  assertLegacyRescore(run)
  assert.equal(run.calls[0].sessionDir, join(run.context.runDir, '.runtime/rescore-session'))
  await assertLegacyRecord(run.context, run.source)
  const written = await readJson(join(run.context.runDir, 'result.json'))
  assert.equal(written.workflow.events[0].session_reconstruction.source, 'evidence/candidate/artifacts')
})

test('a rescore whose source recorded no role profiles is refused rather than validated as a new run', async () => {
  const context = await environment()
  const result = await evaluate(context, ['--rescore-from', '/rescore-source', ...profiles], {
    loadRescoreSource: async () => ({ ...importedRescore(context), role_profiles: null }),
  })

  assert.equal(result.exitCode, 2)
  assert.ok(result.errors.some(({ code }) => code === 'invalid-rescore-source'), JSON.stringify(result.errors))
})

test('a rescore refuses a source whose observed delivery no longer matches its recorded pull request', async () => {
  const context = await environment()
  const result = await evaluate(context, ['--rescore-from', '/rescore-source'], {
    loadRescoreSource: async () => importedRescore(context),
    verifyDelivery: async () => ({ ...delivery(context), pull_request: { ...delivery(context).pull_request, number: 54 } }),
  })

  assert.notEqual(result.exitCode, 0)
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.failed_phase, 'delivery-verification')
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

test('published result records the last observed leaf as Runner reports it', async () => {
  const context = await environment()
  const nestedHistory = [
    { step: 'plan', step_path: ['plan'], outcome: null },
    { step: 'plan', step_path: ['plan', 'sub:plan', 'write-tasks'], outcome: 'success' },
    { step: 'plan', step_path: ['plan'], outcome: 'success' },
  ]
  const result = await evaluate(context, profiles, {
    readRunnerState: () => (runnerInvocations(context).length === 0
      ? null
      : {
          run_id: 'runner-7',
          session_dir: context.sessionDir,
          workflow_name: 'plan-and-implement-change',
          workflow_completed: true,
          history: nestedHistory,
        }),
  })
  assert.equal(result.exitCode, 0, JSON.stringify(result.errors))
  const written = await readJson(join(context.runDir, 'result.json'))
  assert.equal(written.workflow.last_observed_step, 'write-tasks')
  assert.deepEqual(written.workflow.observed_steps.at(-1).step_path, ['plan'])
  assert.equal(Object.hasOwn(written.workflow, 'missing_steps'), false)
  assert.equal(Object.hasOwn(written.workflow, 'prohibited_effects'), false)
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
