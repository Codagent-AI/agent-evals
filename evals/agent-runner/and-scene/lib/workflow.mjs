// Agent Runner `implement-change2` integration.
//
// The suite owns the stop boundary and the decision to start, wait for, or
// resume a run. Agent Runner owns workflow execution, run locks, sessions, and
// its own internal resume point.

export const IMPLEMENTATION_WORKFLOW = 'implement-change2'

// The eval option maps to exactly one workflow argument and one final step.
export const VALIDATOR_BOUNDARIES = {
  true: { skip_validator: 'true', stop_step: 'simplify' },
  false: { skip_validator: 'false', stop_step: 'verify-validator' },
}

export function resolveBoundary({ skipValidator = false, changeName }) {
  const boundary = VALIDATOR_BOUNDARIES[String(Boolean(skipValidator))]
  return {
    workflow: IMPLEMENTATION_WORKFLOW,
    skip_validator: boundary.skip_validator,
    stop_step: boundary.stop_step,
    workflow_arguments: [`change_name=${changeName}`, `skip_validator=${boundary.skip_validator}`],
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
      section = rawLine.startsWith('parameters:') ? 'parameters'
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

export function verifyWorkflowContract(text, boundary) {
  const contract = parseWorkflowContract(text)
  const errors = []
  if (!contract.parameters.includes('skip_validator')) {
    errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} lacks the skip_validator parameter`)
  }
  if (!contract.steps.includes(boundary.stop_step)) {
    errors.push(`workflow ${IMPLEMENTATION_WORKFLOW} lacks the selected stop step ${boundary.stop_step}`)
  }
  return { ok: errors.length === 0, errors }
}

// The outer eval process restarting must never launch a second implementation
// run, so every recorded run resolves to wait, continue, resume, or error.
export function classifyRunnerRun({ recorded, state, boundaryStep, isProcessAlive }) {
  if (!recorded?.run_id) return { status: 'none', action: 'start', reason: null }

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

  const lock = state.lock
  if (lock && isProcessAlive(lock.pid)) {
    if (lock.run_id !== recorded.run_id) {
      return {
        status: 'unverifiable',
        action: 'error',
        reason: `active Agent Runner process owns run ${lock.run_id}, not recorded run ${recorded.run_id}`,
      }
    }
    return { status: 'active', action: 'wait', reason: null, run_id: recorded.run_id }
  }

  if (state.status === 'completed' && state.last_step === boundaryStep) {
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

// The harness must never enter an acceptance, PR, CI, archive, or publishing
// step, so anything after the configured boundary is a boundary failure.
export function checkBoundary({ boundaryStep, workflowSteps, observedSteps }) {
  const limit = workflowSteps.indexOf(boundaryStep)
  let lastObserved = null

  for (const step of observedSteps) {
    const index = workflowSteps.indexOf(step)
    if (index === -1 || index > limit) {
      return { ok: false, unexpected_step: step, last_observed_step: lastObserved }
    }
    lastObserved = step
  }
  return { ok: true, unexpected_step: null, last_observed_step: lastObserved }
}
