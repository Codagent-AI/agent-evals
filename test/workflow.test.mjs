import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checkWorkflowHistory,
  classifyRunnerRun,
  parseWorkflowContract,
  resolveBoundary,
  verifyWorkflowContract,
} from '../evals/agent-runner/and-scene/lib/workflow.mjs'

const workflowYaml = `name: implement-change
params:
  - name: change_name
    required: true
  - name: skip_validator
    default: false
steps:
  - id: plan
  - id: implement-tasks
  - id: simplify
  - id: run-validator
  - id: open-draft-pr
  - id: verify-draft-pr
  - id: prepare-acceptance
  - id: verify-acceptance-handoff
`

const requiredHistory = [
  { step: 'run-validator', outcome: 'success' },
  { step: 'open-draft-pr', outcome: 'success' },
  { step: 'verify-draft-pr', outcome: 'success' },
  { step: 'prepare-acceptance', outcome: 'success' },
  { step: 'verify-acceptance-handoff', outcome: 'success' },
]

test('the exact full workflow has no early stop boundary', () => {
  const workflow = resolveBoundary({ skipValidator: true, changeName: 'create-and-scene' })

  assert.equal(workflow.workflow, 'implement-change')
  assert.equal(workflow.workflow_path, 'workflows/openspec/implement-change-v2.0.yaml')
  assert.equal(workflow.stop_step, null)
  assert.deepEqual(workflow.workflow_arguments, ['change_name=create-and-scene', 'skip_validator=true'])
})

test('skip-validator only changes the task-level compliance workflow argument', () => {
  const skipped = resolveBoundary({ skipValidator: true, changeName: 'create-and-scene' })
  const included = resolveBoundary({ skipValidator: false, changeName: 'create-and-scene' })

  assert.equal(skipped.skip_validator, 'true')
  assert.equal(included.skip_validator, 'false')
  assert.equal(skipped.final_validator, 'required')
  assert.equal(included.final_validator, 'required')
  assert.equal(skipped.stop_step, null)
  assert.equal(included.stop_step, null)
})

test('the validator option defaults to false', () => {
  assert.equal(resolveBoundary({ changeName: 'create-and-scene' }).skip_validator, 'false')
})

test('the workflow contract exposes list and mapping parameters plus ordered steps', () => {
  assert.deepEqual(parseWorkflowContract(workflowYaml).parameters, ['change_name', 'skip_validator'])
  assert.deepEqual(
    parseWorkflowContract('parameters:\n  change_name:\n  skip_validator:\nsteps:\n  - id: run-validator\n').parameters,
    ['change_name', 'skip_validator'],
  )
  assert.equal(parseWorkflowContract(workflowYaml).steps.at(-1), 'verify-acceptance-handoff')
})

test('full-workflow preflight requires the parameter and every final delivery step', () => {
  assert.deepEqual(
    verifyWorkflowContract(workflowYaml),
    { ok: true, errors: [], prohibited_steps: [] },
  )

  for (const missing of [
    'run-validator',
    'open-draft-pr',
    'verify-draft-pr',
    'prepare-acceptance',
    'verify-acceptance-handoff',
  ]) {
    const result = verifyWorkflowContract(workflowYaml.replace(`  - id: ${missing}\n`, ''))
    assert.equal(result.ok, false, missing)
    assert.match(result.errors.join(' '), new RegExp(missing), missing)
  }

  const noParameter = verifyWorkflowContract(workflowYaml.replace('  - name: skip_validator\n', ''))
  assert.match(noParameter.errors.join(' '), /skip_validator/)
})

test('full-workflow preflight rejects declared prohibited publication steps', () => {
  for (const prohibited of [
    'merge-pr',
    'mark-ready-for-review',
    'close-pr',
    'archive-change',
    'release-product',
    'delete-candidate-branch',
  ]) {
    const result = verifyWorkflowContract(`${workflowYaml}  - id: ${prohibited}\n`)
    assert.equal(result.ok, false, prohibited)
    assert.ok(result.prohibited_steps.includes(prohibited), prohibited)
  }
})

test('completed workflow history requires every final delivery step and rejects prohibited effects', () => {
  assert.deepEqual(checkWorkflowHistory(requiredHistory), {
    ok: true,
    missing_steps: [],
    prohibited_effects: [],
    observed_steps: requiredHistory.map(({ step }) => step),
  })

  assert.deepEqual(
    checkWorkflowHistory(requiredHistory.slice(0, -1)).missing_steps,
    ['verify-acceptance-handoff'],
  )
  const violated = checkWorkflowHistory([...requiredHistory, { step: 'merge-pr', outcome: 'success' }])
  assert.equal(violated.ok, false)
  assert.equal(violated.prohibited_effects[0].step, 'merge-pr')
})

test('no persisted run starts a fresh complete workflow', () => {
  assert.equal(classifyRunnerRun({
    recorded: null,
    state: null,
    discovered: null,
    isProcessAlive: () => false,
  }).action, 'start')
})

test('an unrecorded persisted run is adopted instead of duplicated', () => {
  const decision = classifyRunnerRun({
    recorded: null,
    discovered: { run_id: 'run-7', workflow_name: 'implement-change', workflow_completed: false },
    isProcessAlive: () => false,
  })

  assert.equal(decision.action, 'resume')
  assert.equal(decision.adopted, true)
  assert.deepEqual(decision.command, ['agent-runner', '--resume', 'run-7'])
})

test('a recorded run owned by a live Agent Runner process is waited for', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: {
      run_id: 'run-7',
      workflow_name: 'implement-change',
      lock: { pid: 4242, run_id: 'run-7' },
    },
    isProcessAlive: (pid) => pid === 4242,
  })

  assert.equal(decision.action, 'wait')
})

test('only a fully completed workflow continues to delivery verification', () => {
  assert.equal(classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: {
      run_id: 'run-7',
      workflow_name: 'implement-change',
      workflow_completed: true,
    },
    isProcessAlive: () => false,
  }).action, 'continue')

  assert.equal(classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: {
      run_id: 'run-7',
      workflow_name: 'implement-change',
      last_step: 'verify-acceptance-handoff',
      step_completed: true,
      workflow_completed: false,
    },
    isProcessAlive: () => false,
  }).action, 'resume')
})

test('unverifiable run, process, and workflow identity never starts another run', () => {
  const cases = [
    { recorded: { run_id: 'run-7' }, state: null },
    {
      recorded: { run_id: 'run-7' },
      state: { run_id: 'run-8', workflow_name: 'implement-change' },
    },
    {
      recorded: { run_id: 'run-7' },
      state: { run_id: 'run-7', workflow_name: 'accept-change' },
    },
    {
      recorded: { run_id: 'run-7' },
      state: {
        run_id: 'run-7',
        workflow_name: 'implement-change',
        lock: { pid: 4242, run_id: 'run-9' },
      },
      isProcessAlive: () => true,
    },
  ]

  for (const input of cases) {
    const decision = classifyRunnerRun({
      ...input,
      isProcessAlive: input.isProcessAlive ?? (() => false),
    })
    assert.equal(decision.action, 'error')
    assert.notEqual(decision.action, 'start')
  }
})
