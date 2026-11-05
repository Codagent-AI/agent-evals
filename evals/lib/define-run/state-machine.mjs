export const RUN_STATE_SCHEMA_VERSION = 1
export function createRunState({ runId, kind = 'candidate', immutableInputs, delivery = {} }) {
  return { schema_version: RUN_STATE_SCHEMA_VERSION, run_id: runId, kind, identity: immutableInputs, series_identity: immutableInputs.series_identity, candidate: immutableInputs.candidate, delivery, phases: {}, created_at: new Date().toISOString() }
}
export function validateRunState(state) {
  if (state.schema_version !== RUN_STATE_SCHEMA_VERSION || !state.run_id || !state.identity || !state.phases) throw new Error('invalid define evaluation run-state.json')
  return state
}
