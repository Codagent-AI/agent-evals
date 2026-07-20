import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  RESULT_SCHEMA_VERSION,
  assembleResult,
  buildArtifactManifest,
  writeResultArtifacts,
} from '../evals/agent-runner/and-scene/lib/result.mjs'
import { createOutcome, applyOutcomeEvent } from '../evals/agent-runner/and-scene/lib/outcomes.mjs'
import { readJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'

const RUBRICS = {
  automated: { rubric_id: 'and-scene-product', version: '2.0.0', sha256: 'a'.repeat(64) },
  human: { rubric_id: 'and-scene-human-review', version: '1.0.0', sha256: 'b'.repeat(64) },
}

function component(id, awarded, complete = true) {
  return {
    id,
    title: id,
    points_awarded: complete ? awarded : null,
    points_observed: awarded,
    points_possible: 25,
    complete,
    subcomponents: [],
  }
}

function score({ complete = true, official = 84, components = [component('demo-technical-quality', 20)] } = {}) {
  return {
    components,
    gates: [{ id: 'quality-builds-clean', verdict: 'pass' }],
    gates_passed: true,
    automated_subtotal: { points: 60, possible: 70, observed_possible: 70, complete },
    human_review: complete ? { points: 24, possible: 30, floor: 15, lowest_rating: 3 } : null,
    official_score: complete ? official : null,
    official_pass: complete ? official >= 70 : null,
    pass_failures: [],
    incomplete: complete ? [] : ['human-review'],
    harness: {},
  }
}

function assemble(overrides = {}) {
  return assembleResult({
    runId: 'run-1',
    mode: 'agent-runner',
    outcome: applyOutcomeEvent(createOutcome(), { type: 'product-verdict', verdict: 'pass', official_score: 84 }),
    rubrics: RUBRICS,
    score: score(),
    ...overrides,
  })
}

test('a complete result carries the official score, breakdown, and source details', () => {
  const result = assemble()

  assert.equal(result.schema_version, RESULT_SCHEMA_VERSION)
  assert.equal(result.official_score, 84)
  assert.equal(result.product_verdict, 'pass')
  assert.equal(result.label, 'PASS')
  assert.deepEqual(result.rubrics, RUBRICS)
  assert.equal(result.automated_subtotal.points, 60)
  assert.deepEqual(result.available_component_scores, [])
})

test('a pending review carries the automated subtotal out of 70 and no official score', () => {
  const result = assemble({
    outcome: applyOutcomeEvent(createOutcome(), { type: 'automated-scoring-complete', automated_subtotal: 60 }),
    score: score({ complete: false, official: null }),
  })

  assert.equal(result.evaluation_status, 'pending-human-review')
  assert.equal(result.product_verdict, 'unavailable')
  assert.equal(result.official_score, null)
  assert.equal(result.automated_subtotal.points, 60)
  assert.equal(result.automated_subtotal.possible, 70)
})

test('completed components of an incomplete evaluation are preserved without a total', () => {
  const result = assemble({
    outcome: applyOutcomeEvent(createOutcome(), {
      type: 'harness-failure', phase: 'product-judging', reason: 'judge unavailable',
    }),
    score: score({
      complete: false,
      components: [component('demo-technical-quality', 20), component('scene-kit-correctness', 0, false)],
    }),
  })

  assert.equal(result.official_score, null)
  assert.equal(result.automated_subtotal, null, 'an incomplete automated phase reports no subtotal')
  assert.deepEqual(
    result.available_component_scores.map(({ id, points_awarded }) => [id, points_awarded]),
    [['demo-technical-quality', 20]],
  )
  assert.equal(result.unofficial_total, undefined)
})

test('a reference baseline marks Runner roles, cost, and timing not applicable rather than zero', () => {
  const result = assemble({
    mode: 'reference-baseline',
    roleConfiguration: null,
    cost: null,
    metrics: null,
  })

  assert.equal(result.mode, 'reference-baseline')
  assert.equal(result.role_configuration, 'not-applicable')
  assert.equal(result.cost, 'not-applicable')
  assert.equal(result.implementation_metrics, 'not-applicable')
  assert.equal(result.implementation_timing, 'not-applicable')
  assert.notEqual(result.cost, 0)
})

test('completeness dimensions are reported independently of each other', () => {
  const result = assemble({
    cost: { implementation: { total_usd: 4.5, complete: true, usage_complete: false } },
    pricing: { verified: false },
    metrics: { complete: true, history_complete: false, attempts: [] },
  })

  assert.equal(result.completeness.implementation_cost, 'complete')
  assert.equal(result.completeness.implementation_usage, 'unavailable')
  assert.equal(result.completeness.pricing, 'unverified')
  assert.equal(result.completeness.metric_history, 'incomplete')
  assert.equal(result.completeness.score, 'complete')
})

test('missing product evidence marks score completeness without failing the product', () => {
  const result = assemble({
    outcome: applyOutcomeEvent(createOutcome(), { type: 'automated-scoring-complete', automated_subtotal: 40 }),
    score: score({
      complete: false,
      components: [component('demo-technical-quality', 20), component('scene-kit-correctness', 0, false)],
    }),
  })

  assert.equal(result.completeness.score, 'incomplete')
  assert.equal(result.completeness.evidence, 'incomplete')
  assert.equal(result.product_verdict, 'unavailable')
  assert.deepEqual(result.incomplete_components, ['scene-kit-correctness'])
})

test('a finalized human review is carried with its responses and rationales', () => {
  const humanReview = {
    complete: true,
    candidate: { candidate_identity: 'candidate-abc' },
    rubric: RUBRICS.human,
    responses: [{ id: 'step-1', number: 1, question_text: 'Rate step 1', rating: 4, rationale: 'clear' }],
    score: { total: 24, possible: 30, gate_passed: true, subtotals: [] },
  }

  const result = assemble({ humanReview })

  assert.equal(result.human_review.responses[0].rationale, 'clear')
  assert.equal(result.human_review.score.total, 24)
  assert.equal(result.completeness.human_review, 'complete')
})

// --- Artifact manifest -----------------------------------------------------

async function runDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-result-'))
  await mkdir(join(dir, 'phases'), { recursive: true })
  await mkdir(join(dir, '.runtime/candidate-worktree'), { recursive: true })
  await writeFile(join(dir, 'phases/score.json'), '{}\n')
  await writeFile(join(dir, 'checkpoint.json'), '{}\n')
  await writeFile(join(dir, '.runtime/candidate-worktree/App.tsx'), 'secret\n')
  return dir
}

test('the artifact manifest inventories deliberate artifacts and excludes .runtime', async () => {
  const dir = await runDirectory()

  const manifest = await buildArtifactManifest(dir, { runId: 'run-1' })

  const paths = manifest.artifacts.map(({ path }) => path)
  assert.ok(paths.includes('phases/score.json'), paths.join(','))
  assert.ok(paths.includes('checkpoint.json'))
  assert.ok(!paths.some((path) => path.startsWith('.runtime')), paths.join(','))
  assert.deepEqual(manifest.excluded, ['.runtime'])
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
    assert.ok(artifact.bytes > 0)
  }
})

test('writing the result artifacts produces result.json, report.html, and the manifest', async () => {
  const dir = await runDirectory()

  const written = await writeResultArtifacts({ runDir: dir, result: assemble() })

  const result = await readJson(join(dir, 'result.json'))
  assert.equal(result.official_score, 84)
  const report = await readFile(join(dir, 'report.html'), 'utf8')
  assert.match(report, /PASS/)
  const manifest = await readJson(join(dir, 'artifact-manifest.json'))
  const paths = manifest.artifacts.map(({ path }) => path)
  assert.ok(paths.includes('result.json'))
  assert.ok(paths.includes('report.html'))
  assert.deepEqual(written.errors, [])
})

test('the manifest is refreshed rather than appended on a later write', async () => {
  const dir = await runDirectory()

  await writeResultArtifacts({ runDir: dir, result: assemble() })
  await writeFile(join(dir, 'phases/browser-evaluation.json'), '{"ok":true}\n')
  await writeResultArtifacts({ runDir: dir, result: assemble() })

  const manifest = await readJson(join(dir, 'artifact-manifest.json'))
  const paths = manifest.artifacts.map(({ path }) => path)
  assert.equal(new Set(paths).size, paths.length, 'no duplicate entries')
  assert.ok(paths.includes('phases/browser-evaluation.json'))
})

test('a failed report leaves the durable verdict intact and records the missing report', async () => {
  const dir = await runDirectory()

  await assert.rejects(
    writeResultArtifacts({
      runDir: dir,
      result: assemble(),
      renderReportImpl: () => { throw new Error('template exploded') },
    }),
    /template exploded/,
  )

  const result = await readJson(join(dir, 'result.json'))
  assert.equal(result.product_verdict, 'pass')
  assert.equal(result.official_score, 84)
  assert.equal(result.report.written, false)
  assert.match(result.report.error, /template exploded/)
})
