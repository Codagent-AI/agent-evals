// Agent Runner complete `implement-change-v2.0` integration.
//
// Agent Runner owns workflow execution and its internal resume point. The eval
// owns the immutable workflow contract and never supplies an early stop.

export const IMPLEMENTATION_WORKFLOW = 'implement-change'
export const IMPLEMENTATION_WORKFLOW_PATH = 'workflows/openspec/implement-change-v2.0.yaml'

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
  const skip = String(Boolean(skipValidator))
  return {
    workflow: IMPLEMENTATION_WORKFLOW,
    workflow_path: IMPLEMENTATION_WORKFLOW_PATH,
    skip_validator: skip,
    task_level_compliance: skip === 'true' ? 'skipped' : 'required',
    final_validator: 'required',
    stop_step: null,
    workflow_arguments: [`change_name=${changeName}`, `skip_validator=${skip}`],
  }
}

// A deliberately small reader: the contract this suite depends on is the
// presence of a parameter name and a top-level step id, not full YAML support.
export function parseWorkflowContract(text) {
  const parameters = []
  const steps = []
  let section = null

  for (const rawLine of text.split('\n')) {
    if (/^\S/.test(rawLine)) {
      section = /^(?:params|parameters):/.test(rawLine) ? 'parameters'
        : rawLine.startsWith('steps:') ? 'steps'
          : null
      continue
    }
    if (section === 'parameters') {
      const listed = rawLine.match(/^\s+-\s+name:\s*(\S+)/)
      if (listed) { parameters.push(listed[1]); continue }
      const mapped = rawLine.match(/^ {2}([A-Za-z_][\w-]*):/)
      if (mapped) parameters.push(mapped[1])
    } else if (section === 'steps') {
      const step = rawLine.match(/^\s+-\s+id:\s*(\S+)/)
      if (step) steps.push(step[1])
    }
  }
  return { parameters, steps }
}

export function verifyWorkflowContract(text) {
  const contract = parseWorkflowContract(text)
  const errors = []
  if (!contract.parameters.includes('skip_validator')) {
    errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} lacks the skip_validator parameter`)
  }
  if (!contract.parameters.includes('change_name')) {
    errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} lacks the change_name parameter`)
  }
  for (const step of REQUIRED_FINAL_WORKFLOW_STEPS) {
    if (!contract.steps.includes(step)) {
      errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} lacks required final-workflow step ${step}`)
    }
  }
  const prohibitedSteps = contract.steps.filter(isProhibitedWorkflowStep)
  for (const step of prohibitedSteps) {
    errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} declares prohibited publication step ${step}`)
  }
  return { ok: errors.length === 0, errors, prohibited_steps: prohibitedSteps }
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

export function checkWorkflowHistory(history = []) {
  const normalized = history.map(normalizeHistoryEntry).filter(({ step }) => step)
  const completed = new Set(
    normalized.filter(({ outcome }) => outcome === 'success').map(({ step }) => step),
  )
  const missingSteps = REQUIRED_FINAL_WORKFLOW_STEPS.filter((step) => !completed.has(step))
  const prohibitedEffects = normalized.flatMap((entry) => (
    historyStepPath(entry)
      .filter(isProhibitedWorkflowStep)
      .map((step) => ({ ...entry, step }))
  ))
  return {
    ok: missingSteps.length === 0 && prohibitedEffects.length === 0,
    missing_steps: missingSteps,
    prohibited_effects: prohibitedEffects,
    observed_steps: normalized.map(({ step }) => step),
  }
}

// Compatibility for result consumers while the reported concept changes from
// an early boundary to complete workflow history.
export function checkBoundary({ observedSteps }) {
  const checked = checkWorkflowHistory(observedSteps)
  return {
    ok: checked.ok,
    unexpected_step: checked.prohibited_effects[0]?.step ?? null,
    last_observed_step: checked.observed_steps.at(-1) ?? null,
    ...checked,
  }
}
