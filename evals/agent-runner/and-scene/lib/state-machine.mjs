// Authoritative and-scene run state.
//
// Every durable lifecycle fact is reduced into one versioned manifest. Result
// and report artifacts are projections of this state; old boundary-era
// checkpoint files are intentionally not accepted as resumable input.

export const RUN_STATE_SCHEMA_VERSION = 2
export const RUN_STATE_KIND = 'and-scene-run-state'

function timestamp() {
  return new Date().toISOString()
}

function appendEvent(state, event) {
  const at = event.at ?? timestamp()
  return {
    ...state,
    updated_at: at,
    events: [...state.events, { ...event, at }],
  }
}

function mergeStableIdentity(current, update, path) {
  if (update === undefined) return current
  if (current === null || current === undefined) return update
  if (Array.isArray(current) || Array.isArray(update)) {
    if (!Array.isArray(current) || !Array.isArray(update) || current.length !== update.length) {
      throw new Error(`conflicting delivery identity at ${path}`)
    }
    return current.map((value, index) => (
      mergeStableIdentity(value, update[index], `${path}[${index}]`)
    ))
  }
  if (typeof current === 'object' && typeof update === 'object') {
    const merged = { ...current }
    for (const [key, value] of Object.entries(update)) {
      merged[key] = mergeStableIdentity(current[key], value, `${path}.${key}`)
    }
    return merged
  }
  if (current !== update) {
    throw new Error(`conflicting delivery identity at ${path}: recorded ${current}, received ${update}`)
  }
  return current
}

export function createRunState({
  runId,
  kind = 'candidate',
  immutableInputs = {},
  delivery = {},
}) {
  if (kind !== 'candidate' && kind !== 'reference') {
    throw new Error(`run kind must be candidate or reference, received ${kind}`)
  }
  const at = timestamp()
  const applicable = kind === 'candidate'
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    state_kind: RUN_STATE_KIND,
    run_id: runId,
    run_kind: kind,
    created_at: at,
    updated_at: at,
    immutable_inputs: { ...immutableInputs },
    // Kept as a named view for existing suite consumers while run-state.json
    // remains the only durable state file.
    identity: { ...immutableInputs },
    delivery: {
      applicable,
      repository: applicable ? (delivery.repository ?? null) : null,
      origin: applicable ? (delivery.origin ?? delivery.repository ?? null) : null,
      fixture_commit: applicable ? (delivery.fixture_commit ?? null) : null,
      branch: applicable ? (delivery.branch ?? null) : null,
      base_branch: applicable ? (delivery.base_branch ?? null) : null,
      runner: applicable ? (delivery.runner ?? null) : null,
      pull_request: applicable ? (delivery.pull_request ?? null) : null,
      final_sha: applicable ? (delivery.final_sha ?? null) : null,
      final_validator: applicable ? (delivery.final_validator ?? null) : null,
      acceptance: applicable ? (delivery.acceptance ?? null) : null,
      retained_for_manual_cleanup: applicable,
    },
    phases: {},
    outcome: null,
    resume: { eligible: true, reason: null },
    events: [{
      type: 'run-created',
      owner: 'evaluation-harness',
      run_kind: kind,
      at,
    }],
  }
}

export function applyRunStateEvent(state, event) {
  switch (event?.type) {
    case 'immutable-inputs-validated':
    case 'runner-started':
    case 'runner-waited':
    case 'runner-resumed':
    case 'runner-completed':
    case 'retry-recorded':
      return appendEvent(state, event)

    case 'delivery-identity-recorded': {
      if (!state.delivery.applicable) {
        throw new Error('delivery identity is not applicable to a reference run')
      }
      const update = {
        repository: event.repository,
        origin: event.origin,
        fixture_commit: event.fixture_commit,
        branch: event.branch,
        base_branch: event.base_branch,
        runner: event.runner,
        pull_request: event.pull_request,
        final_sha: event.final_sha,
        final_validator: event.final_validator,
        acceptance: event.acceptance,
      }
      const delivery = { ...state.delivery }
      for (const [field, value] of Object.entries(update)) {
        delivery[field] = mergeStableIdentity(delivery[field], value, `delivery.${field}`)
      }
      return appendEvent({ ...state, delivery }, event)
    }

    case 'phase-started': {
      const existing = state.phases[event.phase] ?? { units: {} }
      return appendEvent({
        ...state,
        phases: {
          ...state.phases,
          [event.phase]: {
            ...existing,
            state: 'in-progress',
            input_fingerprint: event.input_fingerprint ?? null,
            dependency_fingerprint: event.dependency_fingerprint ?? null,
            started_at: existing.started_at ?? event.at ?? timestamp(),
            completed_at: null,
          },
        },
      }, event)
    }

    case 'phase-completed':
    case 'phase-failed': {
      const existing = state.phases[event.phase] ?? { units: {} }
      return appendEvent({
        ...state,
        phases: {
          ...state.phases,
          [event.phase]: {
            ...existing,
            state: event.type === 'phase-completed' ? 'complete' : 'failed',
            error: event.error ?? null,
            outputs: event.outputs ?? existing.outputs ?? [],
            completed_at: event.at ?? timestamp(),
          },
        },
      }, event)
    }

    case 'outcome-updated':
      return appendEvent({ ...state, outcome: event.outcome }, event)

    case 'resume-refused':
      return appendEvent({
        ...state,
        resume: { eligible: false, reason: event.reason ?? 'resume provenance could not be verified' },
      }, event)

    default:
      throw new Error(`unknown run-state event: ${event?.type}`)
  }
}

export function validateRunState(state) {
  if (state?.state_kind !== RUN_STATE_KIND || state?.schema_version !== RUN_STATE_SCHEMA_VERSION) {
    throw new Error(
      `legacy or unsupported boundary-era checkpoint schema version ${state?.schema_version ?? 'unknown'} `
      + `is not resumable; expected run-state schema version ${RUN_STATE_SCHEMA_VERSION}`,
    )
  }
  return state
}
