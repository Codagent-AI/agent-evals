import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  VERIFICATION_WORKFLOW_RELATIVE_PATH,
  WORKFLOW_RELATIVE_PATH,
  resolveAgentRunnerDir,
} from '../evals/agent-runner/and-scene/lib/provenance.mjs'
import {
  checkWorkflowHistory,
  checkBoundary,
  classifyRunnerRun,
  finalWorkflowStepEntry,
  parseWorkflowContract,
  resolveBoundary,
  verifyWorkflowContract,
} from '../evals/agent-runner/and-scene/lib/workflow.mjs'

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

// Current Agent Runner delegates validation, the draft PR, and acceptance to a
// `core:verify-change` sub-workflow invoked by a top-level `verify-change` step.
const delegatingWorkflowYaml = `name: implement-change
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
    default: false
steps:
  - id: implement-tasks
    loop:
      over: "{{change_dir}}/tasks/*.md"
    steps:
      - id: implement-single-task
        workflow: ../core/implement-task-v1.0.yaml
  - id: verify-task-index
  - id: verify-change
    workflow: verify-change-v1.0.yaml
    params:
      skip_validator: "{{skip_validator}}"
`

const verificationWorkflowYaml = `name: verify-change
params:
  - name: change_name
    required: true
  - name: skip_validator
    required: false
    default: "false"
steps:
  - id: review-assumptions
  - id: run-validator
    workflow: run-validator-v1.0.yaml
  - id: verify-validator-result
  - id: open-draft-pr
  - id: verify-draft-pr
  - id: prepare-acceptance
    loop:
      max_param: acceptance_rounds
    steps:
      - id: acceptance-test
      - id: acceptance-gate
  - id: write-acceptance-status
  - id: verify-acceptance-handoff
`

const VERIFY = ['verify-change', 'sub:verify-change']

function delegatedHistory({ validatorOutcome = 'success' } = {}) {
  return [
    { step: 'implement-tasks', step_path: ['implement-tasks'], outcome: 'success' },
    { step: 'verify-change', step_path: ['verify-change'], outcome: null },
    { step: 'verify-change', step_path: [...VERIFY, 'run-validator'], outcome: validatorOutcome },
    { step: 'verify-change', step_path: [...VERIFY, 'open-draft-pr'], outcome: 'success' },
    { step: 'verify-change', step_path: [...VERIFY, 'verify-draft-pr'], outcome: 'success' },
    {
      step: 'verify-change',
      step_path: [...VERIFY, 'prepare-acceptance', 'acceptance-gate'],
      outcome: 'failed',
    },
    { step: 'verify-change', step_path: [...VERIFY, 'prepare-acceptance'], outcome: 'success' },
    { step: 'verify-change', step_path: [...VERIFY, 'verify-acceptance-handoff'], outcome: 'success' },
    { step: 'verify-change', step_path: ['verify-change'], outcome: 'success' },
  ]
}

const REQUIRED_STEPS = [
  'run-validator',
  'open-draft-pr',
  'verify-draft-pr',
  'prepare-acceptance',
  'verify-acceptance-handoff',
]

const requiredHistory = [
  { step: 'run-validator', outcome: 'success' },
  { step: 'open-draft-pr', outcome: 'success' },
  { step: 'verify-draft-pr', outcome: 'success' },
  { step: 'prepare-acceptance', outcome: 'success' },
  { step: 'verify-acceptance-handoff', outcome: 'success' },
]

test('the exact full workflow has no early stop boundary and supplies resolved OpenSpec parameters', () => {
  const workflow = resolveBoundary({ skipValidator: true, changeName: 'create-and-scene' })

  assert.equal(workflow.workflow, 'implement-change')
  assert.equal(workflow.workflow_path, 'workflows/core/implement-change-v1.0.yaml')
  assert.equal(workflow.stop_step, null)
  assert.deepEqual(workflow.workflow_arguments, [
    'change_name=create-and-scene',
    'change_dir=openspec/changes/create-and-scene',
    'change_label=OpenSpec change',
    'change_kind=openspec',
    'artifact_validation_instruction=When an approved artifact changed, run `openspec validate --type change "create-and-scene"`.',
    'skip_validator=true',
  ])
  assert.ok(workflow.workflow_arguments.every((argument) => !argument.includes('{{')))
})

test('workflow arguments reject an unresolved change-name placeholder', () => {
  assert.throws(
    () => resolveBoundary({ changeName: '{{change_name}}' }),
    /unresolved placeholder/i,
  )
})

test('skip-validator marks task-level and final Validator execution as skipped', () => {
  const skipped = resolveBoundary({ skipValidator: true, changeName: 'create-and-scene' })
  const included = resolveBoundary({ skipValidator: false, changeName: 'create-and-scene' })

  assert.equal(skipped.skip_validator, 'true')
  assert.equal(included.skip_validator, 'false')
  assert.equal(skipped.task_level_compliance, 'skipped')
  assert.equal(skipped.final_validator, 'skipped')
  assert.equal(included.task_level_compliance, 'required')
  assert.equal(included.final_validator, 'required')
  assert.equal(skipped.stop_step, null)
  assert.equal(included.stop_step, null)
})

test('the validator option defaults to false', () => {
  assert.equal(resolveBoundary({ changeName: 'create-and-scene' }).skip_validator, 'false')
})

test('the workflow contract exposes direct top-level list and mapping parameters plus ordered steps', () => {
  assert.deepEqual(parseWorkflowContract(workflowYaml).parameters, [
    'change_name', 'change_dir', 'change_label', 'change_kind', 'artifact_validation_instruction', 'skip_validator',
  ])
  assert.deepEqual(
    parseWorkflowContract('parameters:\n  change_name:\n  skip_validator:\nsteps:\n  - id: run-validator\n').parameters,
    ['change_name', 'skip_validator'],
  )
  assert.equal(parseWorkflowContract(workflowYaml).steps.at(-1), 'verify-acceptance-handoff')
  assert.deepEqual(
    parseWorkflowContract(`${workflowYaml}  - id: nested-group\n    steps:\n      - id: release-product\n`).steps,
    [...parseWorkflowContract(workflowYaml).steps, 'nested-group'],
  )
})

test('full-workflow preflight requires the parameter and every final delivery step', () => {
  assert.deepEqual(
    verifyWorkflowContract(workflowYaml),
    { ok: true, errors: [], prohibited_steps: [], layout: 'inline' },
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

  for (const parameter of ['change_name', 'change_dir', 'change_label', 'change_kind', 'artifact_validation_instruction', 'skip_validator']) {
    const noParameter = verifyWorkflowContract(workflowYaml.replace(`  - name: ${parameter}\n`, ''))
    assert.match(noParameter.errors.join(' '), new RegExp(parameter))
  }
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
    invalid_outcomes: [],
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

  const nested = checkWorkflowHistory([
    ...requiredHistory,
    { step: 'prepare-acceptance', step_path: ['prepare-acceptance', 'release-product'], outcome: 'success' },
  ])
  assert.equal(nested.ok, false)
  assert.equal(nested.prohibited_effects[0].step, 'release-product')

  const subworkflow = checkWorkflowHistory([
    ...requiredHistory,
    { step: 'run-validator', step_path: ['run-validator', 'sub:archive-change-v1.0'], outcome: 'success' },
  ])
  assert.equal(subworkflow.ok, false)
  assert.equal(subworkflow.prohibited_effects[0].step, 'archive-change-v1.0')
})

test('skipped validation requires an explicit skipped final Validator outcome', () => {
  const skippedHistory = [
    { step: 'run-validator', outcome: 'skipped' },
    ...requiredHistory.slice(1),
  ]

  assert.deepEqual(checkWorkflowHistory(skippedHistory, { skipValidator: true }), {
    ok: true,
    missing_steps: [],
    invalid_outcomes: [],
    prohibited_effects: [],
    observed_steps: skippedHistory.map(({ step }) => step),
  })

  const absent = checkWorkflowHistory(skippedHistory.slice(1), { skipValidator: true })
  assert.equal(absent.ok, false)
  assert.deepEqual(absent.missing_steps, ['run-validator'])

  const unexpectedlyRan = checkWorkflowHistory(requiredHistory, { skipValidator: true })
  assert.equal(unexpectedlyRan.ok, false)
  assert.deepEqual(unexpectedlyRan.invalid_outcomes, [{
    step: 'run-validator',
    expected: 'skipped',
    observed: 'success',
  }])
})

test('enabled validation requires a successful final Validator outcome', () => {
  const skippedHistory = [
    { step: 'run-validator', outcome: 'skipped' },
    ...requiredHistory.slice(1),
  ]

  const checked = checkWorkflowHistory(skippedHistory, { skipValidator: false })
  assert.equal(checked.ok, false)
  assert.deepEqual(checked.invalid_outcomes, [{
    step: 'run-validator',
    expected: 'success',
    observed: 'skipped',
  }])
})

test('the workflow contract records the sub-workflow each top-level step invokes', () => {
  assert.deepEqual(parseWorkflowContract(delegatingWorkflowYaml).step_workflows, {
    'verify-change': 'verify-change-v1.0.yaml',
  })
})

test('a workflow delegating to verify-change satisfies the contract through that sub-workflow', () => {
  assert.deepEqual(
    verifyWorkflowContract(delegatingWorkflowYaml, { verificationText: verificationWorkflowYaml }),
    { ok: true, errors: [], prohibited_steps: [], layout: 'verify-change' },
  )
  assert.equal(verifyWorkflowContract(workflowYaml).layout, 'inline')

  const unavailable = verifyWorkflowContract(delegatingWorkflowYaml)
  assert.equal(unavailable.ok, false)
  assert.match(unavailable.errors.join(' '), /verify-change-v1\.0\.yaml/)

  for (const missing of REQUIRED_STEPS) {
    const result = verifyWorkflowContract(delegatingWorkflowYaml, {
      verificationText: verificationWorkflowYaml.replace(`  - id: ${missing}\n`, ''),
    })
    assert.equal(result.ok, false, missing)
    assert.match(result.errors.join(' '), new RegExp(`verify-change lacks required final-workflow step ${missing}`))
  }

  const noSkip = verifyWorkflowContract(delegatingWorkflowYaml, {
    verificationText: verificationWorkflowYaml.replace('  - name: skip_validator\n', ''),
  })
  assert.match(noSkip.errors.join(' '), /verify-change lacks the skip_validator parameter/)

  const prohibited = verifyWorkflowContract(delegatingWorkflowYaml, {
    verificationText: `${verificationWorkflowYaml}  - id: merge-pr\n`,
  })
  assert.equal(prohibited.ok, false)
  assert.deepEqual(prohibited.prohibited_steps, ['merge-pr'])
})

test('delegated history finds final delivery steps inside the verify-change sub-workflow', () => {
  const history = delegatedHistory()
  const checked = checkWorkflowHistory(history)
  assert.deepEqual(checked, {
    ok: true,
    missing_steps: [],
    invalid_outcomes: [],
    prohibited_effects: [],
    observed_steps: history.map(({ step_path }) => step_path.at(-1)),
  })

  const skipped = checkWorkflowHistory(delegatedHistory({ validatorOutcome: 'skipped' }), {
    skipValidator: true,
  })
  assert.equal(skipped.ok, true)
  const unexpectedlyRan = checkWorkflowHistory(history, { skipValidator: true })
  assert.deepEqual(unexpectedlyRan.invalid_outcomes, [{
    step: 'run-validator',
    expected: 'skipped',
    observed: 'success',
  }])

  const missing = checkWorkflowHistory(history.filter(({ step_path: path }) => path.at(-1) !== 'open-draft-pr'))
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.missing_steps, ['open-draft-pr'])
})

test('delegated history ignores same-named steps outside the final verify-change position', () => {
  // A task-level Validator, or a step of the same id nested deeper inside
  // verify-change, never stands in for the final delivery step.
  const history = [
    ...delegatedHistory().filter(({ step_path: path }) => path.at(-1) !== 'run-validator'),
    { step: 'implement-tasks', step_path: ['implement-tasks', 'implement-single-task', 'sub:implement-task', 'run-validator'], outcome: 'success' },
    { step: 'verify-change', step_path: [...VERIFY, 'prepare-acceptance', 'run-validator'], outcome: 'success' },
  ]
  const checked = checkWorkflowHistory(history)
  assert.equal(checked.ok, false)
  assert.deepEqual(checked.missing_steps, ['run-validator'])

  // Once a run delegates, inline top-level steps from another layout do not count.
  const mixed = checkWorkflowHistory([
    { step: 'verify-change', step_path: ['verify-change'], outcome: 'success' },
    ...requiredHistory,
  ])
  assert.equal(mixed.ok, false)
  assert.deepEqual(mixed.missing_steps, REQUIRED_STEPS)
})

test('delegated history still rejects prohibited effects inside verify-change', () => {
  const violated = checkWorkflowHistory([
    ...delegatedHistory(),
    { step: 'verify-change', step_path: [...VERIFY, 'prepare-acceptance', 'merge-pr'], outcome: 'success' },
  ])
  assert.equal(violated.ok, false)
  assert.equal(violated.prohibited_effects[0].step, 'merge-pr')
})

test('the final workflow step entry is found in either layout', () => {
  assert.deepEqual(finalWorkflowStepEntry(requiredHistory, 'run-validator'), { ...requiredHistory[0], step_path: ['run-validator'] })
  const delegated = delegatedHistory({ validatorOutcome: 'skipped' })
  assert.deepEqual(finalWorkflowStepEntry(delegated, 'run-validator'), { ...delegated[2], step: 'run-validator' })
  assert.equal(finalWorkflowStepEntry(delegated.slice(3), 'run-validator'), null)
})

test('available Agent Runner checkout satisfies the pinned core workflow contract', async (t) => {
  const evalsRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const agentRunnerDir = resolveAgentRunnerDir({ env: process.env, evalsRoot })
  const workflowPath = join(agentRunnerDir, WORKFLOW_RELATIVE_PATH)
  try {
    await access(workflowPath, constants.R_OK)
  } catch {
    t.skip(`Agent Runner checkout is unavailable at ${workflowPath}; skipping live contract check`)
    return
  }
  const verificationText = await readFile(
    join(agentRunnerDir, VERIFICATION_WORKFLOW_RELATIVE_PATH),
    'utf8',
  ).catch(() => null)
  const contract = verifyWorkflowContract(await readFile(workflowPath, 'utf8'), { verificationText })
  assert.equal(contract.ok, true, contract.errors.join('\n'))
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


test('boundary reports the leaf of a nested observed step and retains its path', () => {
  const path = [...VERIFY, 'run-validator']
  const boundary = checkBoundary({ observedSteps: [{ step: 'verify-change', step_path: path, outcome: 'success' }] })
  assert.equal(boundary.last_observed_step, 'run-validator')
  assert.deepEqual(boundary.step_path, path)
})

test('nested observed steps use path leaves in workflow history', () => {
  const checked = checkWorkflowHistory([{ step: 'verify-change', step_path: [...VERIFY, 'run-validator'], outcome: 'success' }])
  assert.deepEqual(checked.observed_steps, ['run-validator'])
})

test('final workflow step normalizes string and id-only history entries', () => {
  assert.deepEqual(finalWorkflowStepEntry(['run-validator'], 'run-validator'), {
    step: 'run-validator', outcome: 'success', step_path: ['run-validator'],
  })
  assert.deepEqual(finalWorkflowStepEntry([{ id: 'run-validator', outcome: 'success' }], 'run-validator'), {
    id: 'run-validator', step: 'run-validator', outcome: 'success', step_path: ['run-validator'],
  })
})
