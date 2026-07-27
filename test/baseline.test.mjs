import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareToBaseline } from '../evals/agent-runner/and-scene/lib/baseline.mjs'

const RUBRICS = {
  automated: { rubric_id: 'and-scene-product', version: '2.0.0', sha256: 'a'.repeat(64) },
  human: { rubric_id: 'and-scene-human-review', version: '1.0.0', sha256: 'b'.repeat(64) },
}

function result({
  runId = 'run-1',
  mode = 'agent-runner',
  official = 80,
  rubrics = RUBRICS,
  components = [
    { id: 'demo-technical-quality', title: 'Demo', applicable: true, points_awarded: 20, points_possible: 24, subcomponents: [
      { id: 'demo-contract', title: 'Contract', points_awarded: 10, points_possible: 12 },
    ] },
    { id: 'scene-kit-correctness', title: 'Scene kit', applicable: true, points_awarded: 20, points_possible: 24, subcomponents: [] },
    { id: 'presentation-skill-correctness', title: 'Skill', applicable: true, points_awarded: 6, points_possible: 7, subcomponents: [] },
    { id: 'verification-tool-correctness', title: 'Verification', applicable: true, points_awarded: 6, points_possible: 7, subcomponents: [] },
    { id: 'testing-evidence-quality', title: 'Evidence', applicable: mode !== 'reference-baseline', points_awarded: mode === 'reference-baseline' ? null : 2, points_possible: mode === 'reference-baseline' ? 0 : 4, subcomponents: [] },
    { id: 'assumption-handling-quality', title: 'Assumptions', applicable: mode !== 'reference-baseline', points_awarded: mode === 'reference-baseline' ? null : 2, points_possible: mode === 'reference-baseline' ? 0 : 4, subcomponents: [] },
  ],
  gates = [{ id: 'quality-builds-clean', verdict: 'pass' }],
  cost = { implementation: { total_usd: 4.5 } },
  human = 24,
} = {}) {
  return {
    run_id: runId,
    mode,
    evaluation_status: 'complete',
    product_verdict: official >= 70 ? 'pass' : 'fail',
    official_score: official,
    rubrics,
    cost,
    score: {
      components,
      gates,
      official_score: official,
      human_review: { applicable: true, points_awarded: human, points_possible: 30, points: human, possible: 30 },
    },
  }
}

test('a candidate and baseline scored by the same rubrics compare on shared 92 points', () => {
  const fullShared = [
    { id: 'demo-technical-quality', title: 'Demo', applicable: true, points_awarded: 24, points_possible: 24, subcomponents: [] },
    { id: 'scene-kit-correctness', title: 'Scene kit', applicable: true, points_awarded: 24, points_possible: 24, subcomponents: [] },
    { id: 'presentation-skill-correctness', title: 'Skill', applicable: true, points_awarded: 7, points_possible: 7, subcomponents: [] },
    { id: 'verification-tool-correctness', title: 'Verification', applicable: true, points_awarded: 7, points_possible: 7, subcomponents: [] },
  ]
  const comparison = compareToBaseline({
    candidate: result({ official: 80 }),
    baseline: result({
      runId: 'baseline-1', mode: 'reference-baseline', official: 92,
      components: fullShared, human: 30,
    }),
  })

  assert.equal(comparison.comparable, true)
  assert.equal(comparison.baseline_run_id, 'baseline-1')
  assert.equal(comparison.denominator, 92)
  assert.deepEqual(comparison.totals, { baseline: 92, candidate: 76, delta: -16 })
})

test('component and subcomponent deltas are reported per identifier', () => {
  const baseline = result({
    runId: 'baseline-1',
    mode: 'reference-baseline',
    official: 92,
    components: [
      { id: 'demo-technical-quality', title: 'Demo', applicable: true, points_awarded: 24, points_possible: 24, subcomponents: [
        { id: 'demo-contract', title: 'Contract', points_awarded: 12, points_possible: 12 },
      ] },
      { id: 'scene-kit-correctness', title: 'Scene kit', applicable: true, points_awarded: 24, points_possible: 24, subcomponents: [] },
      { id: 'presentation-skill-correctness', title: 'Skill', applicable: true, points_awarded: 7, points_possible: 7, subcomponents: [] },
      { id: 'verification-tool-correctness', title: 'Verification', applicable: true, points_awarded: 7, points_possible: 7, subcomponents: [] },
    ],
    human: 30,
  })

  const comparison = compareToBaseline({ candidate: result(), baseline })

  assert.deepEqual(comparison.components, [
    { id: 'demo-technical-quality', title: 'Demo', points_possible: 24, baseline: 24, candidate: 20, delta: -4 },
    { id: 'scene-kit-correctness', title: 'Scene kit', points_possible: 24, baseline: 24, candidate: 20, delta: -4 },
    { id: 'presentation-skill-correctness', title: 'Skill', points_possible: 7, baseline: 7, candidate: 6, delta: -1 },
    { id: 'verification-tool-correctness', title: 'Verification', points_possible: 7, baseline: 7, candidate: 6, delta: -1 },
  ])
  assert.deepEqual(comparison.subcomponents, [
    { id: 'demo-contract', title: 'Contract', points_possible: 12, baseline: 12, candidate: 10, delta: -2 },
  ])
})

test('workflow-quality components are excluded from the shared comparison', () => {
  const comparison = compareToBaseline({
    candidate: result(),
    baseline: result({ mode: 'reference-baseline', official: 76 }),
  })

  assert.equal(comparison.components.some(({ id }) => id === 'testing-evidence-quality'), false)
  assert.equal(comparison.components.some(({ id }) => id === 'assumption-handling-quality'), false)
})

test('gate results are compared by verdict rather than by points', () => {
  const baseline = result({
    runId: 'baseline-1',
    mode: 'reference-baseline',
    gates: [{ id: 'quality-builds-clean', verdict: 'pass' }, { id: 'demo-renders', verdict: 'pass' }],
  })
  const candidate = result({
    gates: [{ id: 'quality-builds-clean', verdict: 'fail' }, { id: 'demo-renders', verdict: 'pass' }],
  })

  const comparison = compareToBaseline({ candidate, baseline })

  assert.deepEqual(comparison.gates, [
    { id: 'quality-builds-clean', baseline: 'pass', candidate: 'fail', changed: true },
    { id: 'demo-renders', baseline: 'pass', candidate: 'pass', changed: false },
  ])
})

test('a baseline scored by a different rubric version is refused as a comparison', () => {
  const baseline = result({
    runId: 'baseline-1',
    mode: 'reference-baseline',
    rubrics: { ...RUBRICS, automated: { ...RUBRICS.automated, version: '1.9.0' } },
  })

  const comparison = compareToBaseline({ candidate: result(), baseline })

  assert.equal(comparison.comparable, false)
  assert.match(comparison.reason, /automated rubric version/)
  assert.equal(comparison.totals, null)
  assert.deepEqual(comparison.components, [])
})

test('a baseline scored by a different rubric hash is refused as a comparison', () => {
  const baseline = result({
    runId: 'baseline-1',
    mode: 'reference-baseline',
    rubrics: { ...RUBRICS, human: { ...RUBRICS.human, sha256: 'c'.repeat(64) } },
  })

  const comparison = compareToBaseline({ candidate: result(), baseline })

  assert.equal(comparison.comparable, false)
  assert.match(comparison.reason, /human rubric hash/)
})

test('a baseline with a different rubric identifier is refused even when versions and hashes match', () => {
  const baseline = result({
    mode: 'reference-baseline',
    rubrics: {
      ...RUBRICS,
      automated: { ...RUBRICS.automated, rubric_id: 'different-automated-rubric' },
    },
  })

  const comparison = compareToBaseline({ candidate: result(), baseline })

  assert.equal(comparison.comparable, false)
  assert.match(comparison.reason, /automated rubric identifier/)
})

test('an unscored baseline is not presented as a comparison', () => {
  const baseline = result({ runId: 'baseline-1', mode: 'reference-baseline' })
  baseline.official_score = null
  baseline.evaluation_status = 'pending-human-review'

  const comparison = compareToBaseline({ candidate: result(), baseline })

  assert.equal(comparison.comparable, false)
  assert.match(comparison.reason, /official score/)
})

test('baseline implementation metrics stay not applicable rather than zero', () => {
  const baseline = result({ runId: 'baseline-1', mode: 'reference-baseline', cost: null })

  const comparison = compareToBaseline({ candidate: result(), baseline })

  assert.equal(comparison.comparable, true)
  assert.deepEqual(comparison.not_applicable, ['agent_roles', 'implementation_cost', 'implementation_timing'])
  assert.equal(comparison.implementation_cost.baseline, null)
  assert.equal(comparison.implementation_cost.candidate, 4.5)
  assert.equal(comparison.implementation_cost.delta, null)
})
