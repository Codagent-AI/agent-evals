import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CHECKPOINT_SCHEMA_VERSION,
  IDENTITY_FIELDS,
  beginUnit,
  completeUnit,
  createCheckpoint,
  loadCheckpoint,
  planPhaseResume,
  saveCheckpoint,
  validateCheckpointIdentity,
  verifyUnit,
} from '../evals/agent-runner/and-scene/lib/checkpoint.mjs'

const identity = {
  candidate_identity: 'candidate-a',
  fixture_revision: 'fixture-a',
  agent_runner_provenance: 'runner-a',
  workflow_arguments: 'args-a',
  agent_configuration: 'agents-a',
  evaluator_configuration: 'judges-a',
  rubric_provenance: 'rubric-a',
}

async function evidence(contents = 'verdict\n') {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-checkpoint-'))
  const path = join(dir, 'unit-output.json')
  await writeFile(path, contents)
  return { dir, path }
}

async function completed({ inputs = { rubric: 'v1' }, contents } = {}) {
  const { dir, path } = await evidence(contents)
  let checkpoint = createCheckpoint({ run_id: 'run-1', identity })
  checkpoint = beginUnit(checkpoint, { phase: 'product-judging', unit: 'scene-kit', inputs })
  checkpoint = await completeUnit(checkpoint, {
    phase: 'product-judging',
    unit: 'scene-kit',
    inputs,
    outputs: [path],
  })
  return { checkpoint, dir, path }
}

test('a new checkpoint is schema versioned and records its identity', () => {
  const checkpoint = createCheckpoint({ run_id: 'run-1', identity })

  assert.equal(checkpoint.schema_version, CHECKPOINT_SCHEMA_VERSION)
  assert.equal(checkpoint.run_id, 'run-1')
  assert.deepEqual(Object.keys(checkpoint.identity).sort(), [...IDENTITY_FIELDS].sort())
})

test('the score-affecting identity fields are the approved set', () => {
  assert.deepEqual(IDENTITY_FIELDS, [
    'candidate_identity',
    'fixture_revision',
    'agent_runner_provenance',
    'workflow_arguments',
    'agent_configuration',
    'evaluator_configuration',
    'rubric_provenance',
  ])
})

test('a begun unit records its start event and stays incomplete', () => {
  const checkpoint = beginUnit(createCheckpoint({ run_id: 'r', identity }), {
    phase: 'browser-evaluation',
    unit: 'check-1',
    inputs: { url: 'http://localhost:4173' },
  })

  const unit = checkpoint.phases['browser-evaluation'].units['check-1']
  assert.equal(unit.state, 'in-progress')
  assert.equal(typeof unit.started_at, 'string')
  assert.equal(unit.completed_at, null)
})

test('a completed unit records input fingerprint, output paths, and hashes', async () => {
  const { checkpoint, path } = await completed()

  const unit = checkpoint.phases['product-judging'].units['scene-kit']
  assert.equal(unit.state, 'complete')
  assert.match(unit.input_fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(unit.outputs.length, 1)
  assert.equal(unit.outputs[0].path, path)
  assert.match(unit.outputs[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(typeof unit.completed_at, 'string')
})

test('a proven unit is reused on resume', async () => {
  const { checkpoint } = await completed()

  const result = await verifyUnit(checkpoint, {
    phase: 'product-judging', unit: 'scene-kit', inputs: { rubric: 'v1' },
  })

  assert.deepEqual(result, { reusable: true, reason: null })
})

test('a completed product-fail verdict is reused rather than rerun', async () => {
  const { checkpoint } = await completed({ contents: '{"verdict":"fail"}\n' })

  const result = await verifyUnit(checkpoint, {
    phase: 'product-judging', unit: 'scene-kit', inputs: { rubric: 'v1' },
  })

  assert.equal(result.reusable, true)
})

test('a unit whose inputs changed is not reused', async () => {
  const { checkpoint } = await completed()

  const result = await verifyUnit(checkpoint, {
    phase: 'product-judging', unit: 'scene-kit', inputs: { rubric: 'v2' },
  })

  assert.equal(result.reusable, false)
  assert.match(result.reason, /input/i)
})

test('a unit whose output changed on disk is not reused', async () => {
  const { checkpoint, path } = await completed()
  await writeFile(path, 'tampered\n')

  const result = await verifyUnit(checkpoint, {
    phase: 'product-judging', unit: 'scene-kit', inputs: { rubric: 'v1' },
  })

  assert.equal(result.reusable, false)
  assert.match(result.reason, /output/i)
})

test('a unit whose output disappeared is not reused', async () => {
  const { checkpoint } = await completed()
  const missing = { ...checkpoint }
  missing.phases['product-judging'].units['scene-kit'].outputs[0].path = '/nonexistent/unit.json'

  const result = await verifyUnit(missing, {
    phase: 'product-judging', unit: 'scene-kit', inputs: { rubric: 'v1' },
  })

  assert.equal(result.reusable, false)
})

test('an interrupted unit is not reused', async () => {
  const checkpoint = beginUnit(createCheckpoint({ run_id: 'r', identity }), {
    phase: 'product-judging', unit: 'scene-kit', inputs: { rubric: 'v1' },
  })

  const result = await verifyUnit(checkpoint, {
    phase: 'product-judging', unit: 'scene-kit', inputs: { rubric: 'v1' },
  })

  assert.equal(result.reusable, false)
  assert.match(result.reason, /not complete/i)
})

test('an unknown unit is not reused', async () => {
  const checkpoint = createCheckpoint({ run_id: 'r', identity })

  const result = await verifyUnit(checkpoint, { phase: 'product-judging', unit: 'nope', inputs: {} })

  assert.equal(result.reusable, false)
})

test('a matching identity is accepted on resume', () => {
  const checkpoint = createCheckpoint({ run_id: 'r', identity })

  assert.deepEqual(validateCheckpointIdentity(checkpoint, { ...identity }), [])
})

test('a changed score-affecting input identifies which provenance changed', () => {
  const checkpoint = createCheckpoint({ run_id: 'r', identity })

  const mismatches = validateCheckpointIdentity(checkpoint, { ...identity, rubric_provenance: 'rubric-b' })

  assert.deepEqual(mismatches, [
    { field: 'rubric_provenance', recorded: 'rubric-a', current: 'rubric-b' },
  ])
})

test('every score-affecting field is compared on resume', () => {
  const checkpoint = createCheckpoint({ run_id: 'r', identity })
  const changed = Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, 'changed']))

  assert.equal(validateCheckpointIdentity(checkpoint, changed).length, IDENTITY_FIELDS.length)
})

test('resume reuses proven units and runs only the remaining ones', async () => {
  const { checkpoint } = await completed()

  const plan = await planPhaseResume(checkpoint, {
    phase: 'product-judging',
    units: ['demo-integration', 'scene-kit', 'presentation-skill'],
    inputsFor: () => ({ rubric: 'v1' }),
  })

  assert.equal(plan.restart, false)
  assert.deepEqual(plan.reuse, ['scene-kit'])
  assert.deepEqual(plan.run, ['demo-integration', 'presentation-skill'])
})

test('resume restarts the enclosing phase when finer completion is uncertain', async () => {
  const { checkpoint } = await completed()
  const interrupted = beginUnit(checkpoint, {
    phase: 'product-judging', unit: 'demo-integration', inputs: { rubric: 'v1' },
  })

  const plan = await planPhaseResume(interrupted, {
    phase: 'product-judging',
    units: ['demo-integration', 'scene-kit'],
    inputsFor: () => ({ rubric: 'v1' }),
    provable: false,
  })

  assert.equal(plan.restart, true)
  assert.deepEqual(plan.reuse, [])
  assert.deepEqual(plan.run, ['demo-integration', 'scene-kit'])
})

test('a checkpoint survives a save and load round trip', async () => {
  const { checkpoint, dir } = await completed()
  const path = join(dir, 'checkpoint.json')

  await saveCheckpoint(path, checkpoint)

  assert.deepEqual(await loadCheckpoint(path), checkpoint)
})

test('loadCheckpoint returns null for a fresh run directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-checkpoint-'))

  assert.equal(await loadCheckpoint(join(dir, 'checkpoint.json')), null)
})

test('a checkpoint written by a different schema version is rejected', async () => {
  const { checkpoint, dir } = await completed()
  const path = join(dir, 'checkpoint.json')
  await saveCheckpoint(path, { ...checkpoint, schema_version: CHECKPOINT_SCHEMA_VERSION + 1 })

  await assert.rejects(() => loadCheckpoint(path), /schema version/i)
})

test('checkpoint updates never mutate the previous checkpoint', () => {
  const before = createCheckpoint({ run_id: 'r', identity })

  beginUnit(before, { phase: 'browser-evaluation', unit: 'check-1', inputs: {} })

  assert.deepEqual(before.phases, {})
})
