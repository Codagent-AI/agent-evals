import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CALIBRATION_MODE,
  calibrationCases,
  runCalibration,
} from '../evals/agent-runner/and-scene/lib/calibration.mjs'
import { readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { publicationEligibility } from '../evals/agent-runner/and-scene/lib/publication.mjs'
import { loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'

const rubrics = await loadRubrics()

async function out() {
  return mkdtemp(join(tmpdir(), 'agent-evals-calibration-'))
}

test('the known-good reference scores the full automated range and reaches an official pass', async () => {
  const ledger = await runCalibration({ rubrics, outDir: await out() })

  assert.equal(ledger.passed, true, JSON.stringify(ledger.failures, null, 2))
  const reference = ledger.cases.find(({ id }) => id === 'reference')
  assert.equal(reference.ok, true)
  assert.equal(reference.automated_subtotal, rubrics.automated.rubric.automated_points)
  assert.equal(reference.gates_passed, true)
  assert.equal(reference.official_pass, true)
  assert.equal(reference.official_score, rubrics.automated.rubric.total_points)
  assert.equal(reference.evaluation_status, 'complete')
})

test('all four product judge jobs run and none fails', async () => {
  const ledger = await runCalibration({ rubrics, outDir: await out() })

  const reference = ledger.cases.find(({ id }) => id === 'reference')
  assert.deepEqual(
    Object.keys(reference.judging.judges).sort(),
    ['demo-integration', 'presentation-skill', 'scene-kit', 'verification-tooling'],
  )
  assert.deepEqual(reference.judging.failed_jobs, [])
})

test('every approved degradation degrades exactly its intended component or gate', async () => {
  const ledger = await runCalibration({ rubrics, outDir: await out() })

  const approved = calibrationCases(rubrics.automated.rubric).filter(({ id }) => id !== 'reference')
  assert.ok(approved.length >= 8, 'the approved mutation set covers each component and each gate')

  for (const approvedCase of approved) {
    const observed = ledger.cases.find(({ id }) => id === approvedCase.id)
    assert.ok(observed, `${approvedCase.id} was not exercised`)
    assert.equal(observed.ok, true, `${approvedCase.id}: ${JSON.stringify(observed.problems)}`)
    // A degradation is a product regression, never a harness failure.
    assert.equal(observed.evaluation_status, 'complete', approvedCase.id)
    assert.deepEqual(observed.unintended_regressions, [], approvedCase.id)
    assert.equal(observed.official_pass, approvedCase.expected_official_pass, approvedCase.id)
  }

  // Each component and each hard gate is somebody's target.
  const targeted = new Set(approved.map(({ target }) => target.id))
  for (const { id } of rubrics.automated.rubric.components) assert.ok(targeted.has(id), id)
  for (const { id } of rubrics.automated.rubric.gates) assert.ok(targeted.has(id), id)
})

test('a mutation that does not degrade its intended target fails calibration', async () => {
  const cases = [
    ...calibrationCases(rubrics.automated.rubric).filter(({ id }) => id === 'reference'),
    {
      id: 'mislabelled-mutation',
      description: 'fails scene-kit criteria but claims the demo component',
      target: { kind: 'component', id: 'demo-technical-quality' },
      fail_criteria: ['scene-step-narration-and-identity'],
      fail_gates: [],
      human: null,
      expected_official_pass: false,
    },
  ]

  const ledger = await runCalibration({ rubrics, outDir: await out(), cases })

  assert.equal(ledger.passed, false)
  const observed = ledger.cases.find(({ id }) => id === 'mislabelled-mutation')
  assert.equal(observed.ok, false)
  assert.ok(observed.problems.length > 0)
  assert.ok(ledger.failures.some((failure) => failure.case === 'mislabelled-mutation'))
})

test('a mutation with collateral damage fails calibration even though its target degraded', async () => {
  const cases = [
    ...calibrationCases(rubrics.automated.rubric).filter(({ id }) => id === 'reference'),
    {
      id: 'leaky-mutation',
      description: 'degrades the demo component but also takes a scene-kit criterion with it',
      target: { kind: 'component', id: 'demo-technical-quality' },
      fail_criteria: ['demo-supported-navigation', 'scene-step-narration-and-identity'],
      fail_gates: [],
      human: null,
      expected_official_pass: true,
    },
  ]

  const ledger = await runCalibration({ rubrics, outDir: await out(), cases })

  const observed = ledger.cases.find(({ id }) => id === 'leaky-mutation')
  assert.ok(observed.unintended_regressions.some(({ id }) => id === 'scene-kit-correctness'))
  assert.equal(observed.ok, false, 'collateral damage must fail the case')
  assert.equal(ledger.passed, false)
  assert.ok(ledger.failures.some((failure) => failure.case === 'leaky-mutation'))
})

test('synthetic human answers exercise validation, scoring, gates, resume, and rendering', async () => {
  const ledger = await runCalibration({ rubrics, outDir: await out() })

  const checks = ledger.human_review_checks
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]))
  for (const id of [
    'rejects-out-of-range-rating',
    'requires-rationale-at-or-below-threshold',
    'scores-a-complete-review',
    'resumes-at-the-first-unanswered-question',
    'rejects-a-corrupted-saved-review',
    'renders-the-finalized-report',
  ]) {
    assert.ok(byId[id], `${id} was not exercised`)
    assert.equal(byId[id].ok, true, `${id}: ${byId[id].detail}`)
  }
})

test('calibration results are diagnostic and are never publishable', async () => {
  const outDir = await out()
  const ledger = await runCalibration({ rubrics, outDir })

  const result = await readJson(join(outDir, 'cases/reference/result.json'))
  assert.equal(result.mode, CALIBRATION_MODE)
  const eligibility = publicationEligibility(result)
  assert.equal(eligibility.publishable, false)
  assert.match(eligibility.reason, /calibration/)

  // Every case leaves a readable diagnostic result and report behind.
  for (const { id } of ledger.cases) {
    assert.ok((await readFile(join(outDir, `cases/${id}/report.html`), 'utf8')).includes('<!doctype html>'))
  }
  const written = await readJson(join(outDir, 'calibration.json'))
  assert.equal(written.passed, ledger.passed)
  assert.equal(written.schema_version, ledger.schema_version)
})

test('calibration invokes no subprocess, so it can never start Agent Runner', async () => {
  const source = await readFile(
    new URL('../evals/agent-runner/and-scene/lib/calibration.mjs', import.meta.url),
    'utf8',
  )
  for (const forbidden of ['node:child_process', 'subprocess.mjs', 'spawn']) {
    assert.ok(!source.includes(forbidden), `calibration must not reach for ${forbidden}`)
  }
  // And it completes with no Agent Runner checkout, sandbox, or home configured.
  const ledger = await runCalibration({ rubrics, outDir: await out() })
  assert.equal(ledger.passed, true)
})
