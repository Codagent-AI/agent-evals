import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checkBoundary,
  classifyRunnerRun,
  parseWorkflowContract,
  resolveBoundary,
  verifyWorkflowContract,
} from '../evals/agent-runner/and-scene/lib/workflow.mjs'

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
  - id: open-pr
`

test('skip-validator stops after simplify', () => {
  const boundary = resolveBoundary({ skipValidator: true, changeName: 'create-and-scene' })

  assert.equal(boundary.stop_step, 'simplify')
  assert.deepEqual(boundary.workflow_arguments, ['change_name=create-and-scene', 'skip_validator=true'])
})

test('the default validator path stops after verify-validator', () => {
  const boundary = resolveBoundary({ skipValidator: false, changeName: 'create-and-scene' })

  assert.equal(boundary.stop_step, 'verify-validator')
  assert.deepEqual(boundary.workflow_arguments, ['change_name=create-and-scene', 'skip_validator=false'])
})

test('the validator option defaults to false', () => {
  assert.equal(resolveBoundary({ changeName: 'create-and-scene' }).stop_step, 'verify-validator')
})

test('the workflow contract exposes its parameters and ordered steps', () => {
  const contract = parseWorkflowContract(workflowYaml)

  assert.ok(contract.parameters.includes('skip_validator'))
  assert.ok(contract.parameters.includes('change_name'))
  assert.equal(contract.steps[0], 'plan')
  assert.ok(contract.steps.includes('verify-validator'))
})

test('a list-style parameter block is also understood', () => {
  const contract = parseWorkflowContract('parameters:\n  - name: change_name\n  - name: skip_validator\nsteps:\n  - id: simplify\n')

  assert.deepEqual(contract.parameters, ['change_name', 'skip_validator'])
})

test('a workflow providing the parameter and stop step is accepted', () => {
  const result = verifyWorkflowContract(workflowYaml, resolveBoundary({ skipValidator: true, changeName: 'c' }))

  assert.deepEqual(result, { ok: true, errors: [] })
})

test('a workflow missing skip_validator fails before Agent Runner starts', () => {
  const result = verifyWorkflowContract(
    'parameters:\n  change_name:\n    required: true\nsteps:\n  - id: simplify\n',
    resolveBoundary({ skipValidator: true, changeName: 'c' }),
  )

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /skip_validator/)
})

test('a workflow missing the selected stop step fails before Agent Runner starts', () => {
  const result = verifyWorkflowContract(
    'parameters:\n  skip_validator:\n    default: false\nsteps:\n  - id: plan\n',
    resolveBoundary({ skipValidator: false, changeName: 'c' }),
  )

  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /verify-validator/)
})

test('no recorded run starts a fresh Agent Runner run', () => {
  const decision = classifyRunnerRun({ recorded: null, state: null, isProcessAlive: () => false })

  assert.equal(decision.status, 'none')
  assert.equal(decision.action, 'start')
})

test('an unrecorded but persisted run is adopted rather than duplicated', () => {
  // The controller can be interrupted after Agent Runner persisted its run but
  // before the identity reached the checkpoint.
  const decision = classifyRunnerRun({
    recorded: null,
    discovered: { run_id: 'run-7', status: 'running', last_step: 'implement-tasks' },
    boundaryStep: 'simplify',
    isProcessAlive: () => false,
  })

  assert.equal(decision.status, 'inactive-unfinished')
  assert.equal(decision.action, 'resume')
  assert.deepEqual(decision.command, ['agent-runner', '--resume', 'run-7'])
  assert.equal(decision.adopted, true)
})

test('an unrecorded but persisted active run is waited for, not duplicated', () => {
  const decision = classifyRunnerRun({
    recorded: null,
    discovered: { run_id: 'run-7', status: 'running', lock: { pid: 4242, run_id: 'run-7' } },
    boundaryStep: 'simplify',
    isProcessAlive: (pid) => pid === 4242,
  })

  assert.equal(decision.action, 'wait')
  assert.equal(decision.adopted, true)
})

test('an unrecorded persisted run that already reached the boundary is continued', () => {
  const decision = classifyRunnerRun({
    recorded: null,
    discovered: { run_id: 'run-7', status: 'completed', last_step: 'simplify' },
    boundaryStep: 'simplify',
    isProcessAlive: () => false,
  })

  assert.equal(decision.action, 'continue')
  assert.equal(decision.adopted, true)
})

test('no recorded and no discovered run starts a fresh run', () => {
  const decision = classifyRunnerRun({
    recorded: null, discovered: null, isProcessAlive: () => false,
  })

  assert.equal(decision.action, 'start')
})

test('a recorded run owned by a live process is waited for, not relaunched', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: { run_id: 'run-7', status: 'running', lock: { pid: 4242, run_id: 'run-7' } },
    isProcessAlive: (pid) => pid === 4242,
  })

  assert.equal(decision.status, 'active')
  assert.equal(decision.action, 'wait')
})

test('a completed run through its boundary continues to the next eval phase', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: { run_id: 'run-7', status: 'completed', last_step: 'simplify' },
    boundaryStep: 'simplify',
    isProcessAlive: () => false,
  })

  assert.equal(decision.status, 'completed')
  assert.equal(decision.action, 'continue')
})

test('an inactive unfinished run is resumed by its exact run identifier', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: { run_id: 'run-7', status: 'running', last_step: 'implement-tasks', lock: { pid: 4242, run_id: 'run-7' } },
    boundaryStep: 'simplify',
    isProcessAlive: () => false,
  })

  assert.equal(decision.status, 'inactive-unfinished')
  assert.equal(decision.action, 'resume')
  assert.deepEqual(decision.command, ['agent-runner', '--resume', 'run-7'])
})

test('a run that stopped short of its boundary is resumed rather than accepted', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: { run_id: 'run-7', status: 'completed', last_step: 'review-assumptions' },
    boundaryStep: 'simplify',
    isProcessAlive: () => false,
  })

  assert.equal(decision.action, 'resume')
})

test('unreadable Agent Runner state stops with a workflow error', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: null,
    isProcessAlive: () => false,
  })

  assert.equal(decision.status, 'unverifiable')
  assert.equal(decision.action, 'error')
})

test('a lock owned by a different run stops with a workflow error', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: { run_id: 'run-7', status: 'running', lock: { pid: 4242, run_id: 'run-9' } },
    isProcessAlive: () => true,
  })

  assert.equal(decision.status, 'unverifiable')
  assert.equal(decision.action, 'error')
  assert.match(decision.reason, /run-9/)
})

test('state describing a different run stops with a workflow error', () => {
  const decision = classifyRunnerRun({
    recorded: { run_id: 'run-7' },
    state: { run_id: 'run-8', status: 'completed', last_step: 'simplify' },
    boundaryStep: 'simplify',
    isProcessAlive: () => false,
  })

  assert.equal(decision.action, 'error')
})

test('the outer process restarting never starts a duplicate implementation run', () => {
  for (const state of [
    { run_id: 'run-7', status: 'running', lock: { pid: 1, run_id: 'run-7' } },
    { run_id: 'run-7', status: 'failed', last_step: 'implement-tasks' },
    { run_id: 'run-7', status: 'completed', last_step: 'simplify' },
  ]) {
    const decision = classifyRunnerRun({
      recorded: { run_id: 'run-7' }, state, boundaryStep: 'simplify', isProcessAlive: () => true,
    })
    assert.notEqual(decision.action, 'start', JSON.stringify(state))
  }
})

test('stopping exactly at the skip-validator boundary is accepted', () => {
  const result = checkBoundary({
    boundaryStep: 'simplify',
    workflowSteps: parseWorkflowContract(workflowYaml).steps,
    observedSteps: ['plan', 'implement-tasks', 'review-assumptions', 'simplify'],
  })

  assert.deepEqual(result, { ok: true, unexpected_step: null, last_observed_step: 'simplify' })
})

test('stopping exactly at the validator boundary is accepted', () => {
  const result = checkBoundary({
    boundaryStep: 'verify-validator',
    workflowSteps: parseWorkflowContract(workflowYaml).steps,
    observedSteps: ['plan', 'simplify', 'run-validator', 'verify-validator'],
  })

  assert.equal(result.ok, true)
})

test('a step past the skip-validator boundary is a boundary failure', () => {
  const result = checkBoundary({
    boundaryStep: 'simplify',
    workflowSteps: parseWorkflowContract(workflowYaml).steps,
    observedSteps: ['plan', 'simplify', 'run-validator'],
  })

  assert.equal(result.ok, false)
  assert.equal(result.unexpected_step, 'run-validator')
})

test('a publishing step past the validator boundary is a boundary failure', () => {
  const result = checkBoundary({
    boundaryStep: 'verify-validator',
    workflowSteps: parseWorkflowContract(workflowYaml).steps,
    observedSteps: ['verify-validator', 'acceptance-test', 'open-pr'],
  })

  assert.equal(result.ok, false)
  assert.equal(result.unexpected_step, 'acceptance-test')
})

test('an unknown observed step is a boundary failure rather than silently allowed', () => {
  const result = checkBoundary({
    boundaryStep: 'simplify',
    workflowSteps: parseWorkflowContract(workflowYaml).steps,
    observedSteps: ['plan', 'publish-everything'],
  })

  assert.equal(result.ok, false)
  assert.equal(result.unexpected_step, 'publish-everything')
})
