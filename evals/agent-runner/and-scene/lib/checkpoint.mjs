// Durable evaluation checkpoints.
//
// Resume reuses the finest work unit it can deterministically prove complete:
// matching score-affecting inputs plus output artifacts whose hashes still
// validate. Anything less restarts the enclosing phase.
import { hashFile, hashJson, readJson, writeJsonAtomic } from './persistence.mjs'

export const CHECKPOINT_SCHEMA_VERSION = 1

// The score-affecting provenance a checkpoint is only valid against.
export const IDENTITY_FIELDS = [
  'candidate_identity',
  'fixture_revision',
  'agent_runner_provenance',
  'workflow_arguments',
  'agent_configuration',
  'evaluator_configuration',
  'rubric_provenance',
]

function now() {
  return new Date().toISOString()
}

function withUnit(checkpoint, phase, unit, value) {
  const phases = { ...checkpoint.phases }
  const existing = phases[phase] ?? { units: {} }
  phases[phase] = { ...existing, units: { ...existing.units, [unit]: value } }
  return { ...checkpoint, phases }
}

export function createCheckpoint({ run_id, identity }) {
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    run_id,
    identity: Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity?.[field] ?? null])),
    phases: {},
  }
}

export function beginUnit(checkpoint, { phase, unit, inputs }) {
  return withUnit(checkpoint, phase, unit, {
    state: 'in-progress',
    input_fingerprint: hashJson(inputs ?? {}),
    outputs: [],
    started_at: now(),
    completed_at: null,
  })
}

export async function completeUnit(checkpoint, { phase, unit, inputs, outputs = [] }) {
  const existing = checkpoint.phases[phase]?.units?.[unit]
  const recorded = []
  for (const path of outputs) {
    recorded.push({ path, sha256: await hashFile(path) })
  }
  return withUnit(checkpoint, phase, unit, {
    state: 'complete',
    input_fingerprint: hashJson(inputs ?? {}),
    outputs: recorded,
    started_at: existing?.started_at ?? now(),
    completed_at: now(),
  })
}

export function failUnit(checkpoint, { phase, unit, error }) {
  const existing = checkpoint.phases[phase]?.units?.[unit]
  return withUnit(checkpoint, phase, unit, {
    ...(existing ?? { input_fingerprint: null, outputs: [], started_at: now() }),
    state: 'failed',
    error: error ?? null,
    completed_at: now(),
  })
}

// A completed unit is reusable regardless of its product verdict: a recorded
// product failure is a finished result, not work to redo.
export async function verifyUnit(checkpoint, { phase, unit, inputs }) {
  const recorded = checkpoint.phases?.[phase]?.units?.[unit]
  if (!recorded) return { reusable: false, reason: 'no checkpoint for this unit' }
  if (recorded.state !== 'complete') return { reusable: false, reason: `unit is not complete (${recorded.state})` }
  if (recorded.input_fingerprint !== hashJson(inputs ?? {})) {
    return { reusable: false, reason: 'score-affecting input provenance changed' }
  }
  for (const output of recorded.outputs) {
    if (await hashFile(output.path) !== output.sha256) {
      return { reusable: false, reason: `output artifact no longer matches: ${output.path}` }
    }
  }
  return { reusable: true, reason: null }
}

export async function planPhaseResume(checkpoint, { phase, units, inputsFor, provable = true }) {
  // Without durable per-unit proof the whole phase restarts from its beginning.
  if (!provable) return { restart: true, reuse: [], run: [...units] }

  const reuse = []
  const run = []
  for (const unit of units) {
    const { reusable } = await verifyUnit(checkpoint, { phase, unit, inputs: inputsFor(unit) })
    ;(reusable ? reuse : run).push(unit)
  }
  return { restart: false, reuse, run }
}

export function validateCheckpointIdentity(checkpoint, identity) {
  return IDENTITY_FIELDS.flatMap((field) => (
    checkpoint.identity[field] === identity?.[field]
      ? []
      : [{ field, recorded: checkpoint.identity[field], current: identity?.[field] ?? null }]
  ))
}

export async function saveCheckpoint(path, checkpoint) {
  return writeJsonAtomic(path, checkpoint)
}

export async function loadCheckpoint(path) {
  const checkpoint = await readJson(path, null)
  if (checkpoint === null) return null
  if (checkpoint.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported checkpoint schema version ${checkpoint.schema_version}; expected ${CHECKPOINT_SCHEMA_VERSION}`,
    )
  }
  return checkpoint
}
