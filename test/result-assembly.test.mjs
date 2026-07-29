import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  RESULT_SCHEMA_VERSION,
  assembleResult,
  buildArtifactManifest,
  readEvidenceProjectionInputs,
  writeResultArtifacts,
} from '../evals/agent-runner/and-scene/lib/result.mjs'
import { createOutcome, applyOutcomeEvent } from '../evals/agent-runner/and-scene/lib/outcomes.mjs'
import { readJson, writeJsonAtomic } from '../evals/agent-runner/and-scene/lib/persistence.mjs'

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

function completeJudging() {
  return {
    expected_jobs: [
      'demo-integration',
      'scene-kit',
      'presentation-skill',
      'verification-tooling',
      'testing-evidence',
      'assumption-handling',
    ],
    judges: Object.fromEntries([
      'demo-integration',
      'scene-kit',
      'presentation-skill',
      'verification-tooling',
      'testing-evidence',
      'assumption-handling',
    ].map((id) => [id, [{ id: `${id}-criterion`, verdict: 'pass' }]])),
    failed_jobs: [],
  }
}

test('a complete result carries the official score, breakdown, and source details', () => {
  const result = assemble()

  assert.equal(result.schema_version, RESULT_SCHEMA_VERSION)
  assert.equal(result.run_kind, 'candidate')
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
  assert.equal('official_score' in result, false)
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

  assert.equal('official_score' in result, false)
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

test('a complete reference result records the 92-point denominator and N/A components', () => {
  const referenceScore = score({
    official: 92,
    components: [
      { ...component('demo-technical-quality', 24), applicable: true, points_possible: 24 },
      { ...component('scene-kit-correctness', 24), applicable: true, points_possible: 24 },
      { ...component('presentation-skill-correctness', 7), applicable: true, points_possible: 7 },
      { ...component('verification-tool-correctness', 7), applicable: true, points_possible: 7 },
      {
        ...component('testing-evidence-quality', 0),
        applicable: false,
        points_awarded: null,
        points_possible: 0,
      },
      {
        ...component('assumption-handling-quality', 0),
        applicable: false,
        points_awarded: null,
        points_possible: 0,
      },
    ],
  })
  referenceScore.score_denominator = 92
  referenceScore.automated_subtotal = { points: 62, possible: 62, observed_possible: 62, complete: true }
  referenceScore.official_pass = null
  const outcome = applyOutcomeEvent(
    applyOutcomeEvent(createOutcome({ kind: 'reference' }), {
      type: 'automated-scoring-complete',
      automated_subtotal: 62,
    }),
    { type: 'reference-finalized', official_score: 92 },
  )

  const result = assembleResult({
    runId: 'reference-1',
    mode: 'reference-baseline',
    outcome,
    rubrics: RUBRICS,
    score: referenceScore,
  })

  assert.equal(result.score_denominator, 92)
  assert.equal(result.run_kind, 'reference')
  assert.equal(result.official_score, 92)
  assert.equal(result.product_verdict, 'not-applicable')
  assert.equal(result.score.components.filter(({ applicable }) => applicable === false).length, 2)
})

test('completeness dimensions are reported independently of each other', () => {
  const result = assemble({
    cost: { implementation: { total_usd: 4.5, complete: true, usage_complete: false } },
    pricing: { verified: false },
    metrics: { complete: true, history_complete: false, attempts: [] },
    judging: completeJudging(),
    delivery: { candidate_reported_ci: { status: 'pending', revision: 'f'.repeat(40) } },
  })

  assert.equal(result.completeness.implementation_cost, 'complete')
  assert.equal(result.completeness.implementation_usage, 'unavailable')
  assert.equal(result.completeness.pricing, 'unverified')
  assert.equal(result.completeness.metric_history, 'incomplete')
  assert.equal(result.completeness.judge_coverage, 'complete')
  assert.equal(result.completeness.candidate_reported_ci, 'complete')
  assert.equal(result.completeness.score, 'complete')
})

test('judge coverage is incomplete when a required judge is absent without a recorded failure', () => {
  const judging = completeJudging()
  delete judging.judges['assumption-handling']

  const result = assemble({ judging })

  assert.equal(result.completeness.judge_coverage, 'incomplete')
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

test('candidate and evaluator evidence summaries remain ownership-separated', () => {
  const candidate = {
    ownership: 'candidate-produced',
    readiness: 'ready',
    manifest_sha256: 'c'.repeat(64),
    ci_claims: [{ artifact_id: 'candidate-flow', status: 'pending', revision: 'f'.repeat(40) }],
    artifacts: [{
      id: 'candidate-flow',
      kind: 'acceptance-flow-record',
      ownership: 'candidate-produced',
      sha256: 'a'.repeat(64),
      claimed_revision: 'f'.repeat(40),
      verification_state: 'verified',
      coverage: ['demo-flow'],
      limitations: [],
    }],
  }
  const evaluator = {
    ownership: 'evaluator-produced',
    final_sha: 'f'.repeat(40),
    manifest_sha256: 'e'.repeat(64),
    artifacts: [{
      id: 'route-probe',
      kind: 'deterministic-probe',
      ownership: 'evaluator-produced',
      sha256: 'b'.repeat(64),
      revision: 'f'.repeat(40),
      verification_state: 'verified',
      coverage: ['demo-route'],
      limitations: [],
    }],
  }
  const result = assemble({
    evidence: {
      candidate,
      evaluator,
      contradictions: { items: [{ id: 'contradiction-1', scoring_effect: 'disproof-only' }] },
      lineage: { accepted: true, final_sha: 'f'.repeat(40) },
    },
  })

  assert.equal(result.evidence.candidate.ownership, 'candidate-produced')
  assert.equal(result.evidence.evaluator.ownership, 'evaluator-produced')
  assert.equal(result.evidence.contradictions[0].scoring_effect, 'disproof-only')
  assert.equal(result.candidate_reported_ci[0].status, 'pending')
  assert.equal(result.completeness.candidate_reported_ci, 'complete')
  assert.equal(result.completeness.candidate_evidence, 'complete')
  assert.equal(result.completeness.evaluator_evidence, 'complete')
  assert.equal(result.completeness.final_revision_alignment, 'complete')
})

test('candidate and evaluator evidence defects remain independently incomplete', () => {
  const result = assemble({
    judging: { judges: {}, failed_jobs: ['testing-evidence'] },
    evidence: {
      candidate: {
        ownership: 'candidate-produced',
        readiness: 'incomplete',
        artifacts: [{ id: 'candidate-flow', ownership: 'candidate-produced' }],
      },
      evaluator: {
        ownership: 'evaluator-produced',
        artifacts: [],
      },
      lineage: { accepted: false, final_sha: 'f'.repeat(40) },
      contradictions: { items: [] },
      workflow_provenance: 'incomplete',
    },
  })

  assert.equal(result.completeness.candidate_evidence, 'incomplete')
  assert.equal(result.completeness.evaluator_evidence, 'incomplete')
  assert.equal(result.completeness.final_revision_alignment, 'defective')
  assert.equal(result.completeness.judge_coverage, 'incomplete')
  assert.equal(result.completeness.candidate_reported_ci, 'unavailable')
  assert.equal(result.completeness.workflow_provenance, 'incomplete')
})

test('a conclusive product failure omits score and human-review fields while preserving its failed gate', () => {
  const outcome = applyOutcomeEvent(createOutcome(), {
    type: 'conclusive-product-failure',
    phase: 'verification',
    reason: 'the delivered product could not build',
    gate: 'verification-build-whole-app',
  })
  const result = assemble({
    outcome,
    score: score({
      complete: false,
      official: null,
      components: [component('demo-technical-quality', 12)],
    }),
    humanReview: null,
  })

  assert.equal(result.evaluation_status, 'complete')
  assert.equal(result.product_verdict, 'fail')
  assert.equal('official_score' in result, false)
  assert.equal('human_review' in result, false)
  assert.equal(result.product_failure.gate, 'verification-build-whole-app')
})

test('result projection carries authoritative run-state, delivery, and retained artifact identity', () => {
  const runState = {
    schema_version: 2,
    state_kind: 'and-scene-run-state',
    run_id: 'run-1',
    run_kind: 'candidate',
    updated_at: '2026-07-26T12:00:00.000Z',
    resume: { eligible: true, reason: null },
    events: [{ type: 'runner-resumed', at: '2026-07-26T11:59:00.000Z' }],
  }
  const delivery = {
    repository: 'https://example.test/and-scene.git',
    branch: 'eval/and-scene/run-1',
    base_branch: 'main',
    pull_request: {
      url: 'https://example.test/pull/7',
      draft: true,
      base: 'main',
      head_sha: 'f'.repeat(40),
    },
    final_sha: 'f'.repeat(40),
    final_validator: { status: 'passed' },
    candidate_reported_ci: { status: 'pending', revision: 'f'.repeat(40) },
  }

  const result = assemble({
    runState,
    delivery,
    candidate: { candidate_identity: 'candidate-abc', produced_commit: 'f'.repeat(40) },
    candidateServer: { pid: 42, url: 'http://127.0.0.1:4173/' },
    artifacts: [{ path: 'ambiguity-ledger.json', bytes: 10 }],
  })

  assert.equal(result.run_state.schema_version, 2)
  assert.equal(result.run_state.events[0].type, 'runner-resumed')
  assert.equal(result.delivery.pull_request.head_sha, result.delivery.final_sha)
  assert.equal(result.delivery.candidate_reported_ci.status, 'pending')
  assert.equal(result.candidate_source.candidate_identity, 'candidate-abc')
  assert.equal(result.candidate_server.pid, 42)
  assert.equal(result.artifacts[0].path, 'ambiguity-ledger.json')
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
  await writeFile(join(dir, 'run-state.json'), '{}\n')
  await writeFile(join(dir, '.runtime/candidate-worktree/App.tsx'), 'secret\n')
  return dir
}

test('the artifact manifest inventories deliberate artifacts and excludes .runtime', async () => {
  const dir = await runDirectory()

  const manifest = await buildArtifactManifest(dir, { runId: 'run-1' })

  const paths = manifest.artifacts.map(({ path }) => path)
  assert.ok(paths.includes('phases/score.json'), paths.join(','))
  assert.ok(paths.includes('run-state.json'))
  assert.ok(!paths.some((path) => path.startsWith('.runtime')), paths.join(','))
  assert.deepEqual(manifest.excluded, ['.runtime'])
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
    assert.ok(artifact.bytes > 0)
  }
})

test('evidence projection inputs are restored from durable manifests on resume', async () => {
  const dir = await runDirectory()
  await mkdir(join(dir, 'evidence/candidate'), { recursive: true })
  await mkdir(join(dir, 'evidence/evaluator'), { recursive: true })
  await writeJsonAtomic(join(dir, 'evidence/candidate/manifest.json'), {
    ownership: 'candidate-produced',
    readiness: 'ready',
    artifacts: [{ id: 'candidate-flow' }],
  })
  await writeJsonAtomic(join(dir, 'evidence/evaluator/manifest.json'), {
    ownership: 'evaluator-produced',
    artifacts: [{ id: 'route-probe' }],
  })
  await writeJsonAtomic(join(dir, 'evidence/evaluator/contradictions.json'), {
    items: [{ id: 'contradiction-1' }],
  })
  await writeJsonAtomic(join(dir, 'phases/evidence-provenance.json'), {
    lineage: { accepted: true, final_sha: 'f'.repeat(40) },
  })

  const evidence = await readEvidenceProjectionInputs(dir)

  assert.equal(evidence.candidate.artifacts[0].id, 'candidate-flow')
  assert.equal(evidence.evaluator.artifacts[0].id, 'route-probe')
  assert.equal(evidence.contradictions.items[0].id, 'contradiction-1')
  assert.equal(evidence.lineage.accepted, true)
})

test('writing the result artifacts produces result.json, report.html, and the manifest', async () => {
  const dir = await runDirectory()

  const written = await writeResultArtifacts({ runDir: dir, result: assemble() })

  const result = await readJson(join(dir, 'result.json'))
  assert.equal(result.official_score, 84)
  assert.ok(result.artifacts.some(({ path }) => path === 'phases/score.json'))
  assert.ok(result.artifacts.some(({ path }) => path === 'run-state.json'))
  assert.ok(!result.artifacts.some(({ path }) => path === 'result.json'))
  const report = await readFile(join(dir, 'report.html'), 'utf8')
  assert.match(report, /PASS/)
  const manifest = await readJson(join(dir, 'artifact-manifest.json'))
  const paths = manifest.artifacts.map(({ path }) => path)
  assert.ok(paths.includes('result.json'))
  assert.ok(paths.includes('report.html'))
  assert.equal(manifest.projection.evaluation_status, 'complete')
  assert.equal(manifest.projection.product_verdict, 'pass')
  assert.equal(manifest.projection.official_score, 84)
  assert.equal(manifest.projection.score_denominator, 100)
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

test('a failure with no scored components is incomplete rather than vacuously complete', () => {
  const result = assemble({
    outcome: applyOutcomeEvent(createOutcome(), {
      type: 'harness-failure', phase: 'browser-evaluation', reason: 'driver crashed',
    }),
    score: null,
  })

  assert.equal(result.completeness.score, 'incomplete')
  assert.equal(result.completeness.evidence, 'incomplete')
  assert.equal(result.automated_subtotal, null)
  assert.equal('official_score' in result, false)
  assert.deepEqual(result.available_component_scores, [])
})
