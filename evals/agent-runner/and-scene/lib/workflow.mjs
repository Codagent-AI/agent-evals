// Agent Runner complete core `implement-change-v1.0` integration.
//
// Agent Runner owns workflow execution and its internal resume point. The eval
// owns the immutable workflow contract and never supplies an early stop.
//
// The final delivery steps have lived in two places. Earlier Agent Runner
// revisions declared them inline at the top level of implement-change. Current
// revisions delegate them to the `core:verify-change` sub-workflow through a
// top-level `verify-change` step. Both layouts are accepted so that runs of
// either revision stay verifiable and rescorable.

export const IMPLEMENTATION_WORKFLOW = 'implement-change'
export const IMPLEMENTATION_WORKFLOW_LOGICAL_NAME = 'core:implement-change'
export const IMPLEMENTATION_WORKFLOW_INSPECTION_REF = 'core:implement-change'
export const IMPLEMENTATION_WORKFLOW_PATH = 'workflows/core/implement-change-v1.0.yaml'

export const REQUIRED_WORKFLOW_PARAMETERS = [
  'change_name',
  'change_dir',
  'change_label',
  'change_kind',
  'artifact_validation_instruction',
  'skip_validator',
]

export const VERIFICATION_WORKFLOW_STEP = 'verify-change'
export const VERIFICATION_WORKFLOW_FILE = 'verify-change-v1.0.yaml'
export const VERIFICATION_WORKFLOW_INSPECTION_REF = 'core:verify-change'
const VERIFICATION_STEP_PREFIX = [VERIFICATION_WORKFLOW_STEP, `sub:${VERIFICATION_WORKFLOW_STEP}`]

export const REQUIRED_FINAL_WORKFLOW_STEPS = [
  'run-validator',
  'open-draft-pr',
  'verify-draft-pr',
  'prepare-acceptance',
  'verify-acceptance-handoff',
]

const PROHIBITED_STEP_PATTERNS = [
  /(?:^|-)merge(?:-|$)/i,
  /ready-for-review/i,
  /(?:^|-)close(?:-pr)?(?:-|$)/i,
  /(?:^|-)archive(?:-|$)/i,
  /(?:^|-)release(?:-|$)/i,
  /(?:delete|remove).*(?:branch)/i,
  /branch.*(?:delete|remove)/i,
]

export function isProhibitedWorkflowStep(step) {
  return PROHIBITED_STEP_PATTERNS.some((pattern) => pattern.test(step))
}

export function resolveBoundary({ skipValidator = false, changeName }) {
  if (String(changeName).includes('{{')) {
    throw new Error('workflow arguments cannot contain an unresolved placeholder')
  }
  const skip = String(Boolean(skipValidator))
  return {
    workflow: IMPLEMENTATION_WORKFLOW,
    workflow_path: IMPLEMENTATION_WORKFLOW_PATH,
    skip_validator: skip,
    task_level_compliance: skip === 'true' ? 'skipped' : 'required',
    final_validator: skip === 'true' ? 'skipped' : 'required',
    stop_step: null,
    workflow_arguments: [
      `change_name=${changeName}`,
      `change_dir=openspec/changes/${changeName}`,
      'change_label=OpenSpec change',
      'change_kind=openspec',
      `artifact_validation_instruction=When an approved artifact changed, run \`openspec validate --type change "${changeName}"\`.`,
      `skip_validator=${skip}`,
    ],
  }
}

// A deliberately small reader: the contract this suite depends on is the
// presence of a parameter name, a top-level step id, and the sub-workflow a
// top-level step invokes, not full YAML support.
export function parseWorkflowContract(text) {
  const parameters = []
  const steps = []
  const stepWorkflows = {}
  let section = null

  for (const rawLine of text.split('\n')) {
    if (/^\S/.test(rawLine)) {
      section = /^(?:params|parameters):/.test(rawLine) ? 'parameters'
        : rawLine.startsWith('steps:') ? 'steps'
          : null
      continue
    }
    if (section === 'parameters') {
      const listed = rawLine.match(/^ {2}-\s+name:\s*(\S+)/)
      if (listed) { parameters.push(listed[1]); continue }
      const mapped = rawLine.match(/^ {2}([A-Za-z_][\w-]*):/)
      if (mapped) parameters.push(mapped[1])
    } else if (section === 'steps') {
      const step = rawLine.match(/^ {2}-\s+id:\s*(\S+)/)
      if (step) { steps.push(step[1]); continue }
      const workflow = rawLine.match(/^ {4}workflow:\s*["']?([^"'\s#]+)/)
      if (workflow && steps.length > 0) stepWorkflows[steps.at(-1)] = workflow[1]
    }
  }
  return { parameters, steps, step_workflows: stepWorkflows }
}

function delegatesVerification(contract) {
  const workflow = contract.step_workflows[VERIFICATION_WORKFLOW_STEP]
  return typeof workflow === 'string' && workflow.split('/').at(-1) === VERIFICATION_WORKFLOW_FILE
}

// `verificationText` is the checkout's verify-change workflow, or null when the
// checkout has none. It is required only when implement-change delegates to it.
export function verifyWorkflowContract(text, { verificationText = null } = {}) {
  const contract = parseWorkflowContract(text)
  const errors = []
  for (const parameter of REQUIRED_WORKFLOW_PARAMETERS) {
    if (!contract.parameters.includes(parameter)) {
      errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} lacks the ${parameter} parameter`)
    }
  }

  const layout = delegatesVerification(contract) ? 'verify-change' : 'inline'
  let finalContract = contract
  let finalWorkflow = IMPLEMENTATION_WORKFLOW
  const declaredSteps = [...contract.steps]
  if (layout === 'verify-change') {
    finalWorkflow = VERIFICATION_WORKFLOW_STEP
    if (typeof verificationText !== 'string') {
      errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} delegates to ${VERIFICATION_WORKFLOW_FILE}, which is unavailable`)
      finalContract = null
    } else {
      finalContract = parseWorkflowContract(verificationText)
      declaredSteps.push(...finalContract.steps)
      if (!finalContract.parameters.includes('skip_validator')) {
        errors.push(`workflow ${VERIFICATION_WORKFLOW_STEP} lacks the skip_validator parameter`)
      }
    }
  }
  if (finalContract) {
    for (const step of REQUIRED_FINAL_WORKFLOW_STEPS) {
      if (!finalContract.steps.includes(step)) {
        errors.push(`workflow ${finalWorkflow} lacks required final-workflow step ${step}`)
      }
    }
  }
  const prohibitedSteps = declaredSteps.filter(isProhibitedWorkflowStep)
  for (const step of prohibitedSteps) {
    errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} declares prohibited publication step ${step}`)
  }
  return { ok: errors.length === 0, errors, prohibited_steps: prohibitedSteps, layout }
}

// The outer eval process restarting must never launch a second implementation
// run, so every recorded run resolves to wait, continue, resume, or error.
export function classifyRunnerRun({
  recorded,
  state,
  discovered,
  isProcessAlive,
  workflowName = IMPLEMENTATION_WORKFLOW,
}) {
  // The controller can be interrupted after Agent Runner persisted a run but
  // before that identity reached the checkpoint. Adopt the persisted run rather
  // than starting a duplicate implementation workflow.
  if (!recorded?.run_id) {
    if (!discovered?.run_id) return { status: 'none', action: 'start', reason: null }
    return {
      ...classifyRunnerRun({
        recorded: { run_id: discovered.run_id },
        state: discovered,
        isProcessAlive,
        workflowName,
      }),
      adopted: true,
    }
  }

  if (!state) {
    return {
      status: 'unverifiable',
      action: 'error',
      reason: `cannot verify the status of recorded Agent Runner run ${recorded.run_id}`,
    }
  }
  if (state.run_id !== recorded.run_id) {
    return {
      status: 'unverifiable',
      action: 'error',
      reason: `Agent Runner state describes run ${state.run_id}, not recorded run ${recorded.run_id}`,
    }
  }
  if (state.workflow_name && state.workflow_name !== workflowName) {
    return {
      status: 'unverifiable',
      action: 'error',
      reason: `Agent Runner run ${recorded.run_id} is ${state.workflow_name}, not ${workflowName}`,
    }
  }

  const lock = state.lock
  if (Number.isInteger(lock?.pid) && lock.pid > 0 && isProcessAlive(lock.pid)) {
    if (lock.run_id !== recorded.run_id) {
      return {
        status: 'unverifiable',
        action: 'error',
        reason: `active Agent Runner process owns run ${lock.run_id}, not recorded run ${recorded.run_id}`,
      }
    }
    return { status: 'active', action: 'wait', reason: null, run_id: recorded.run_id }
  }

  if (state.workflow_completed === true || state.completed === true) {
    return { status: 'completed', action: 'continue', reason: null, run_id: recorded.run_id }
  }

  return {
    status: 'inactive-unfinished',
    action: 'resume',
    reason: null,
    run_id: recorded.run_id,
    command: ['agent-runner', '--resume', recorded.run_id],
  }
}

function normalizeHistoryEntry(entry) {
  if (typeof entry === 'string') return { step: entry, outcome: 'success' }
  return {
    step: entry?.step ?? entry?.id ?? null,
    outcome: entry?.outcome ?? null,
    ...entry,
  }
}

function historyStepPath(entry) {
  return Array.isArray(entry.step_path) && entry.step_path.length > 0
    ? entry.step_path
    : [entry.step]
}

function lastLeafStep(normalized) {
  const leaves = normalized.filter((entry, index) => {
    const path = historyStepPath(entry)
    const childPrefix = [...path, `sub:${path.at(-1)}`]
    return !normalized.slice(0, index).some((earlier) => {
      const earlierPath = historyStepPath(earlier)
      return childPrefix.every((segment, position) => earlierPath[position] === segment)
    })
  })
  const path = leaves.length > 0 ? historyStepPath(leaves.at(-1)) : null
  return { step: path?.at(-1) ?? null, path }
}

// A run delegates when Agent Runner recorded a top-level verify-change step;
// its final delivery steps then sit directly inside that sub-workflow.
function finalStepPrefix(normalized) {
  return normalized.some((entry) => historyStepPath(entry)[0] === VERIFICATION_WORKFLOW_STEP)
    ? VERIFICATION_STEP_PREFIX
    : []
}

function isFinalStepEntry(entry, prefix, step) {
  const path = historyStepPath(entry)
  return path.length === prefix.length + 1
    && prefix.every((segment, index) => path[index] === segment)
    && path.at(-1) === step
}

// The last recorded entry of a final delivery step, such as the final
// `run-validator`, in whichever layout the history uses.
export function finalWorkflowStepEntry(history = [], step) {
  const entries = history.map(normalizeHistoryEntry).filter(({ step }) => step)
  const prefix = finalStepPrefix(entries)
  const entry = entries.findLast((candidate) => isFinalStepEntry(candidate, prefix, step))
  return entry ? { ...entry, step, step_path: historyStepPath(entry) } : null
}

export function checkWorkflowHistory(history = [], { skipValidator = false } = {}) {
  const normalized = history.map(normalizeHistoryEntry).filter(({ step }) => step)
  const lastLeaf = lastLeafStep(normalized)
  const expectedOutcomes = Object.fromEntries(REQUIRED_FINAL_WORKFLOW_STEPS.map((step) => [
    step,
    step === 'run-validator' && skipValidator ? 'skipped' : 'success',
  ]))
  const prefix = finalStepPrefix(normalized)
  const terminalOutcomes = new Map()
  for (const entry of normalized) {
    if (!entry.outcome) continue
    const step = historyStepPath(entry).at(-1)
    if (isFinalStepEntry(entry, prefix, step)) terminalOutcomes.set(step, entry.outcome)
  }
  const missingSteps = REQUIRED_FINAL_WORKFLOW_STEPS.filter((step) => !terminalOutcomes.has(step))
  const invalidOutcomes = REQUIRED_FINAL_WORKFLOW_STEPS.flatMap((step) => {
    const observed = terminalOutcomes.get(step)
    const expected = expectedOutcomes[step]
    return observed && observed !== expected ? [{ step, expected, observed }] : []
  })
  const prohibitedEffects = normalized.flatMap((entry) => (
    historyStepPath(entry)
      .map((step) => String(step).replace(/^sub:/, ''))
      .filter(isProhibitedWorkflowStep)
      .map((step) => ({ ...entry, step }))
  ))
  return {
    ok: missingSteps.length === 0 && invalidOutcomes.length === 0 && prohibitedEffects.length === 0,
    missing_steps: missingSteps,
    invalid_outcomes: invalidOutcomes,
    prohibited_effects: prohibitedEffects,
    observed_steps: normalized.map((entry) => historyStepPath(entry).at(-1)),
    last_observed_step: lastLeaf.step,
    last_observed_step_path: lastLeaf.path,
  }
}

// Compatibility for result consumers while the reported concept changes from
// an early boundary to complete workflow history.
export function checkBoundary({ observedSteps, skipValidator = false }) {
  const checked = checkWorkflowHistory(observedSteps, { skipValidator })
  return {
    ...checked,
    ok: checked.ok,
    unexpected_step: checked.prohibited_effects[0]?.step ?? null,
    step_path: checked.last_observed_step_path,
  }
}
