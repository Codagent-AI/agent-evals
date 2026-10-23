import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { makeTempDir } from './temp-dir.mjs'
import { resolveAgentRunnerDir } from '../evals/agent-runner/and-scene/lib/provenance.mjs'
import {
  DEFAULT_WORKFLOW,
  REQUIRED_WORKFLOW_PARAMETERS,
  classifyRunnerRun,
  parseLogicalWorkflowRef,
  parseWorkflowDefinition,
  resolveBoundary,
  resolveWorkflowFile,
  summarizeObservedSteps,
  verifyWorkflowInputs,
} from '../evals/agent-runner/and-scene/lib/workflow.mjs'

const params = REQUIRED_WORKFLOW_PARAMETERS
  .map((name) => `  - name: ${name}\n    required: true\n`)
  .join('')

// Step names here are deliberately foreign to the harness: nothing about them
// may affect whether the workflow is accepted.
const compositeYaml = `name: example-workflow
description: "Plan and implement."
hidden: true

params:
${params}
steps:
  - id: plan
    workflow: plan-change-v1.0.yaml
    params:
      change_name: "{{change_name}}"
  - id: merge-pr
  - id: release-product
`

const resolved = {
  workflow: 'core:example-workflow',
  definitionSha256: 'a'.repeat(64),
  reportedName: 'example-workflow',
}

test('resolveBoundary evaluates the default workflow when none is selected', () => {
  const boundary = resolveBoundary({
    changeName: 'create-and-scene',
    definitionSha256: 'a'.repeat(64),
    reportedName: parseLogicalWorkflowRef(DEFAULT_WORKFLOW).name,
  })
  assert.equal(boundary.workflow, DEFAULT_WORKFLOW)
  assert.equal(boundary.runner_workflow_name, parseLogicalWorkflowRef(DEFAULT_WORKFLOW).name)
  assert.equal(boundary.workflow_sha256, 'a'.repeat(64))
})

test('the resolved-definition hash fills workflow_path so baseline identity tells versions apart', () => {
  const boundary = resolveBoundary({ changeName: 'create-and-scene', ...resolved })
  assert.equal(boundary.workflow_path, 'a'.repeat(64))
  const other = resolveBoundary({ changeName: 'create-and-scene', ...resolved, definitionSha256: 'b'.repeat(64) })
  assert.notEqual(other.workflow_path, boundary.workflow_path)
})

test('another selected workflow is recorded under its own logical reference and reported name', () => {
  const boundary = resolveBoundary({
    changeName: 'create-and-scene',
    workflow: 'core:orchestrated-example-workflow',
    definitionSha256: 'c'.repeat(64),
    reportedName: 'orchestrated-example-workflow',
  })
  assert.equal(boundary.workflow, 'core:orchestrated-example-workflow')
  assert.equal(boundary.runner_workflow_name, 'orchestrated-example-workflow')
})

test('workflow arguments are fully resolved OpenSpec parameters with an explicit skip_validator', () => {
  const boundary = resolveBoundary({ skipValidator: true, changeName: 'create-and-scene', ...resolved })
  assert.deepEqual(boundary.workflow_arguments, [
    'change_name=create-and-scene',
    'change_dir=openspec/changes/create-and-scene',
    'change_label=OpenSpec change',
    'change_kind=openspec',
    'artifact_validation_instruction=When an approved artifact changed, run `openspec validate --type change "create-and-scene"`.',
    'skip_validator=true',
  ])
  assert.ok(boundary.workflow_arguments.every((argument) => !argument.includes('{{')))
  assert.equal(Object.hasOwn(boundary, 'stop_step'), false)
})

test('workflow arguments reject an unresolved placeholder in any supplied value', () => {
  assert.throws(
    () => resolveBoundary({ changeName: '{{change_name}}', ...resolved }),
    /unresolved placeholder/i,
  )
})

test('the requested Validator mode is recorded and derives the baseline identity fields', () => {
  const skipped = resolveBoundary({ skipValidator: true, changeName: 'create-and-scene', ...resolved })
  const included = resolveBoundary({ changeName: 'create-and-scene', ...resolved })

  assert.equal(skipped.skip_validator, 'true')
  assert.equal(skipped.validator_mode, 'skipped')
  assert.equal(skipped.task_level_compliance, 'skipped')
  assert.equal(skipped.final_validator, 'skipped')
  assert.equal(included.skip_validator, 'false')
  assert.equal(included.validator_mode, 'required')
  assert.equal(included.task_level_compliance, 'required')
  assert.equal(included.final_validator, 'required')
})

test('logical workflow references name a namespace and workflow', () => {
  assert.deepEqual(parseLogicalWorkflowRef('core:example-workflow'), {
    namespace: 'core',
    name: 'example-workflow',
  })
  for (const invalid of ['example-workflow', 'core:', ':x', 'core:../x', 'core:x/y', '', null]) {
    assert.throws(() => parseLogicalWorkflowRef(invalid), /logical workflow reference/i, String(invalid))
  }
})

test('a workflow definition exposes its declared name and top-level parameters only', () => {
  const definition = parseWorkflowDefinition(compositeYaml)
  assert.equal(definition.name, 'example-workflow')
  assert.deepEqual(definition.parameters, REQUIRED_WORKFLOW_PARAMETERS)
  assert.deepEqual(
    parseWorkflowDefinition('name: "x"\nparameters:\n  change_name:\n  skip_validator:\nsteps:\n  - id: a\n').parameters,
    ['change_name', 'skip_validator'],
  )
  assert.equal(parseWorkflowDefinition("name: 'quoted' # comment\n").name, 'quoted')
  assert.equal(parseWorkflowDefinition('name: "a #b" # comment\n').name, 'a #b')
  assert.equal(parseWorkflowDefinition('name: plain # comment\n').name, 'plain')
})

test('workflow input verification checks parameters and nothing about steps', () => {
  const verified = verifyWorkflowInputs(compositeYaml)
  assert.equal(verified.ok, true, verified.errors.join('\n'))
  assert.equal(verified.name, 'example-workflow')

  for (const parameter of REQUIRED_WORKFLOW_PARAMETERS) {
    const missing = verifyWorkflowInputs(compositeYaml.replace(`  - name: ${parameter}\n    required: true\n`, ''))
    assert.equal(missing.ok, false)
    assert.match(missing.errors.join('\n'), new RegExp(`lacks the ${parameter} parameter`))
  }
})

test('a workflow definition without a declared name cannot establish its reported identity', () => {
  const unnamed = verifyWorkflowInputs(compositeYaml.replace('name: example-workflow\n', ''))
  assert.equal(unnamed.ok, false)
  assert.match(unnamed.errors.join('\n'), /declares no name/)
})

test('a logical reference resolves to its latest versioned definition in a checkout', async () => {
  const root = await makeTempDir(join(tmpdir(), 'agent-evals-workflow-'))
  await mkdir(join(root, 'workflows/core'), { recursive: true })
  for (const file of [
    'example-workflow-v1.0.yaml',
    'example-workflow-v1.10.yaml',
    'example-workflow-v1.2.yaml',
    'plan-change-v9.0.yaml',
  ]) {
    await writeFile(join(root, 'workflows/core', file), `name: ${file}\n`)
  }
  assert.equal(
    await resolveWorkflowFile({ agentRunnerDir: root, workflow: 'core:example-workflow' }),
    'workflows/core/example-workflow-v1.10.yaml',
  )
  assert.equal(await resolveWorkflowFile({ agentRunnerDir: root, workflow: 'core:missing' }), null)
  assert.equal(await resolveWorkflowFile({ agentRunnerDir: root, workflow: 'other:plan-change' }), null)
})

test('observed steps are recorded as Runner reports them without interpretation', () => {
  const history = [
    { step: 'plan', step_path: ['plan'], outcome: null },
    { step: 'plan', step_path: ['plan', 'sub:plan', 'merge-pr'], outcome: 'success' },
    { step: 'plan', step_path: ['plan'], outcome: 'success' },
  ]
  const summary = summarizeObservedSteps(history)
  assert.deepEqual(summary.observed_steps, history)
  assert.equal(summary.last_observed_step, 'merge-pr')
  assert.deepEqual(summary.last_observed_step_path, ['plan', 'sub:plan', 'merge-pr'])
  assert.equal(Object.hasOwn(summary, 'prohibited_effects'), false)
  assert.equal(Object.hasOwn(summary, 'missing_steps'), false)
  assert.deepEqual(summarizeObservedSteps(['a', { id: 'b' }]).last_observed_step, 'b')
  assert.equal(summarizeObservedSteps([]).last_observed_step, null)
})

test('available Agent Runner checkout provides the default workflow and its parameters', async (t) => {
  const evalsRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const agentRunnerDir = resolveAgentRunnerDir({ env: process.env, evalsRoot })
  try {
    await access(agentRunnerDir, constants.R_OK)
  } catch {
    t.skip(`Agent Runner checkout is unavailable at ${agentRunnerDir}; skipping the default workflow input check`)
    return
  }
  const relativePath = await resolveWorkflowFile({ agentRunnerDir, workflow: DEFAULT_WORKFLOW })
  assert.ok(relativePath, `Agent Runner checkout ${agentRunnerDir} has no ${DEFAULT_WORKFLOW} workflow`)
  const verified = verifyWorkflowInputs(await readFile(join(agentRunnerDir, relativePath), 'utf8'))
  assert.equal(verified.ok, true, verified.errors.join('\n'))
})

const NAME = 'example-workflow'

test('no persisted run starts a fresh complete workflow', () => {
  assert.equal(classifyRunnerRun({
    recorded: null,
    state: null,
    discovered: null,
    isProcessAlive: () => false,
    workflowName: NAME,
  }).action, 'start')
})

test('the expected Runner-reported name is required to classify a run', () => {
  assert.throws(() => classifyRunnerRun({
    recorded: null,
    discovered: null,
    isProcessAlive: () => false,
  }), /expected Runner-reported workflow name/)
})

test('an unrecorded persisted run of the expected workflow is adopted instead of duplicated', () => {
  const decision = classifyRunnerRun({
    recorded: null,
    discovered: { run_id: 'run-7', workflow_name: NAME, workflow_completed: false },
    isProcessAlive: () => false,
    workflowName: NAME,
  })

  assert.equal(decision.action, 'resume')
  assert.equal(decision.adopted, true)
  assert.deepEqual(decision.command, ['agent-runner', '--resume', 'run-7'])
})

test('a discovered run reporting another workflow is rejected, however self-consistent', () => {
  for (const discovered of [
    { run_id: 'run-7', workflow_name: 'plan-change', workflow_completed: true },
    { run_id: 'run-7', workflow_name: null, workflow_completed: true },
  ]) {
    const decision = classifyRunnerRun({
      recorded: null,
      discovered,
      isProcessAlive: () => false,
      workflowName: NAME,
    })
    assert.equal(decision.action, 'error')
    assert.equal(decision.code, 'workflow-identity')
    assert.match(decision.reason, /example-workflow/)
  }
})

test('a recorded run owned by a live Agent Runner process is waited for', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: {
      run_id: 'run-7',
      workflow_name: NAME,
      lock: { pid: 4242, run_id: 'run-7' },
    },
    isProcessAlive: (pid) => pid === 4242,
    workflowName: NAME,
  })

  assert.equal(decision.action, 'wait')
})

test('only a fully completed workflow continues to delivery verification', () => {
  assert.equal(classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: { run_id: 'run-7', workflow_name: NAME, workflow_completed: true },
    isProcessAlive: () => false,
    workflowName: NAME,
  }).action, 'continue')

  assert.equal(classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: { run_id: 'run-7', workflow_name: NAME, step_completed: true, workflow_completed: false },
    isProcessAlive: () => false,
    workflowName: NAME,
  }).action, 'resume')
})

test('unverifiable run, process, and workflow identity never starts another run', () => {
  const cases = [
    { recorded: { run_id: 'run-7' }, state: null },
    { recorded: { run_id: 'run-7' }, state: { run_id: 'run-8', workflow_name: NAME } },
    { recorded: { run_id: 'run-7' }, state: { run_id: 'run-7', workflow_name: 'accept-change' } },
    { recorded: { run_id: 'run-7' }, state: { run_id: 'run-7' } },
    {
      recorded: { run_id: 'run-7' },
      state: { run_id: 'run-7', workflow_name: NAME, lock: { pid: 4242, run_id: 'run-9' } },
      isProcessAlive: () => true,
    },
  ]

  for (const input of cases) {
    const decision = classifyRunnerRun({
      ...input,
      isProcessAlive: input.isProcessAlive ?? (() => false),
      workflowName: NAME,
    })
    assert.equal(decision.action, 'error')
  }
})
