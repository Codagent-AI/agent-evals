// The gate a full Agent Runner evaluation is blocked on: a calibration record
// only unblocks the harness it was actually produced by.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  checkCalibrationRecord,
  runCalibrationCommand,
} from '../evals/agent-runner/and-scene/calibrate.mjs'
import { calibrationIdentity } from '../evals/agent-runner/and-scene/lib/calibration.mjs'
import { readJson, writeJsonAtomic } from '../evals/agent-runner/and-scene/lib/persistence.mjs'

async function root() {
  return mkdtemp(join(tmpdir(), 'agent-evals-gate-'))
}

test('a passing record written by this harness unblocks a full evaluation', async () => {
  const dir = await root()
  const record = join(dir, 'latest.json')

  const outcome = await runCalibrationCommand({
    argv: ['--out', join(dir, 'run'), '--record', record],
  })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.errors))
  assert.equal((await checkCalibrationRecord(record)).passed, true)
})

test('a missing or failed record blocks a full evaluation', async () => {
  const dir = await root()
  const missing = await checkCalibrationRecord(join(dir, 'absent.json'))
  assert.equal(missing.passed, false)
  assert.match(missing.reason, /no calibration record/)

  const record = join(dir, 'failed.json')
  await writeJsonAtomic(record, {
    ...await calibrationIdentity(),
    passed: false,
    failures: [{ case: 'reference', problem: 'the reference did not reach an official pass' }],
  })
  const failed = await checkCalibrationRecord(record)
  assert.equal(failed.passed, false)
  assert.match(failed.reason, /the reference did not reach an official pass/)
})

test('a record that predates the current rubrics or harness no longer unblocks a run', async () => {
  const dir = await root()
  const identity = await calibrationIdentity()

  for (const [name, stale] of [
    ['unversioned', { passed: true, failures: [] }],
    ['old-schema', { ...identity, schema_version: identity.schema_version + 1, passed: true, failures: [] }],
    ['edited-rubric', {
      ...identity,
      rubrics: { ...identity.rubrics, automated: { ...identity.rubrics.automated, sha256: 'stale' } },
      passed: true,
      failures: [],
    }],
    ['edited-harness', { ...identity, harness_fingerprint: 'stale', passed: true, failures: [] }],
  ]) {
    const record = join(dir, `${name}.json`)
    await writeJsonAtomic(record, stale)
    const outcome = await checkCalibrationRecord(record)
    assert.equal(outcome.passed, false, name)
    assert.match(outcome.reason, /calibrat/i, name)
  }
})

test('the written record carries the identity of the harness that produced it', async () => {
  const dir = await root()
  const record = join(dir, 'latest.json')
  await runCalibrationCommand({ argv: ['--out', join(dir, 'run'), '--record', record] })

  const written = await readJson(record)
  const identity = await calibrationIdentity()
  assert.equal(written.schema_version, identity.schema_version)
  assert.deepEqual(written.rubrics, identity.rubrics)
  assert.equal(written.harness_fingerprint, identity.harness_fingerprint)
  assert.match(written.harness_fingerprint, /^[0-9a-f]{64}$/)
})
