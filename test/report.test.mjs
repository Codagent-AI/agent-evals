import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ReportConsistencyError, escapeHtml, renderReport } from '../evals/agent-runner/and-scene/lib/report.mjs'

function result(overrides = {}) {
  return {
    schema_version: 2,
    run_id: 'run-1',
    mode: 'agent-runner',
    evaluation_status: 'complete',
    product_verdict: 'pass',
    label: 'PASS',
    official_score: 84,
    score_denominator: 100,
    automated_subtotal: { points: 60, possible: 70, observed_possible: 70, complete: true },
    available_component_scores: [],
    failed_phase: null,
    failure: null,
    cleanup: { completed: true, phase: 'cleanup', error: null },
    rubrics: {
      automated: { rubric_id: 'and-scene-product', version: '2.0.0', sha256: 'a'.repeat(64) },
      human: { rubric_id: 'and-scene-human-review', version: '1.0.0', sha256: 'b'.repeat(64) },
    },
    score: {
      components: [{
        id: 'demo-technical-quality',
        title: 'Demo technical quality',
        points_awarded: 20,
        points_possible: 25,
        floor: 15,
        complete: true,
        subcomponents: [{
          id: 'demo-contract',
          title: 'Demo contract',
          points_awarded: 10,
          points_possible: 12,
          complete: true,
          criteria: [{
            id: 'demo-route-and-registration',
            verdict: 'pass',
            rationale: 'the route resolves',
            evidence: ['/how-to-make-a-presentation'],
            points_awarded: 1,
            points_possible: 1,
          }],
        }],
      }],
      gates: [{ id: 'quality-builds-clean', requirement: 'the build succeeds', verdict: 'pass', rationale: 'clean', evidence: [] }],
      gates_passed: true,
      human_review: { points: 24, possible: 30, floor: 15, lowest_rating: 3 },
      pass_failures: [],
      incomplete: [],
      harness: { judge_retries: {}, failed_judge_jobs: [] },
    },
    human_review: {
      complete: true,
      responses: [{ number: 1, question_text: 'Rate step 1', rating: 4, rationale: 'clear' }],
      score: { total: 24, possible: 30, gate_passed: true, subtotals: [{ id: 'per-step', title: 'Per step', points: 8, points_possible: 10 }] },
    },
    workflow: {
      workflow: 'implement-change',
      workflow_path: 'workflows/openspec/implement-change-v2.0.yaml',
      configured_stop_step: null,
      observed_steps: ['plan'],
      events: [],
    },
    role_configuration: { lead: { cli: 'claude', model: 'opus' } },
    implementation_metrics: { attempts: [], complete: true },
    cost: { implementation: { total_usd: 4.5, complete: true } },
    pricing: { verified: false, sources: [] },
    timing: { total_active_ms: 1000, phases: [] },
    completeness: {
      score: 'complete', usage: 'unavailable', cost: 'complete', pricing: 'unverified',
      timing: 'complete', evidence: 'complete', workflow_provenance: 'complete', metric_history: 'complete',
    },
    artifacts: [{ path: 'phases/score.json', bytes: 10 }],
    baseline: null,
    ambiguity: null,
    history: [],
    ...overrides,
  }
}

test('a passing verdict leads with PASS and the official score', () => {
  const html = renderReport(result())
  assert.match(html, /<h1[^>]*>\s*PASS\s*<\/h1>/)
  assert.match(html, /84/)
  assert.match(html, /Score denominator:<\/strong>\s*100/)
})

test('a failing verdict leads with FAIL and the official score', () => {
  const html = renderReport(result({ product_verdict: 'fail', label: 'FAIL', official_score: 51 }))
  assert.match(html, /<h1[^>]*>\s*FAIL\s*<\/h1>/)
  assert.match(html, /51/)
})

test('a complete reference renders its unscaled score out of 92 and N/A components', () => {
  const reference = result({
    mode: 'reference-baseline',
    product_verdict: 'not-applicable',
    label: 'REFERENCE — COMPLETE',
    official_score: 92,
    score_denominator: 92,
  })
  reference.score.components.push({
    id: 'testing-evidence-quality',
    title: 'Testing-evidence quality',
    applicable: false,
    points_awarded: null,
    points_possible: 0,
    floor: null,
    complete: true,
    subcomponents: [],
  })

  const html = renderReport(reference)

  assert.match(html, /<h1[^>]*>\s*REFERENCE — COMPLETE\s*<\/h1>/)
  assert.match(html, /92\s*\/\s*92/)
  assert.match(html, /Testing-evidence quality/)
  assert.match(html, /not applicable/i)
  assert.doesNotMatch(html, /92\s*\/\s*100/)
})

test('a pending review leads with PENDING HUMAN REVIEW and the automated subtotal', () => {
  const pending = result({
    evaluation_status: 'pending-human-review',
    product_verdict: 'unavailable',
    label: 'PENDING HUMAN REVIEW',
  })
  delete pending.official_score
  const html = renderReport(pending)
  assert.match(html, /<h1[^>]*>\s*PENDING HUMAN REVIEW\s*<\/h1>/)
  assert.match(html, /60\s*\/\s*70/)
  assert.doesNotMatch(html, /Official score:\s*\d/)
})

test('a harness failure without a verdict leads with EVALUATION FAILED and names the phase', () => {
  const failed = result({
    evaluation_status: 'evaluation-harness-failed',
    product_verdict: 'unavailable',
    label: 'EVALUATION FAILED',
    failed_phase: 'browser-evaluation',
    failure: { owner: 'evaluation-harness', phase: 'browser-evaluation', reason: 'driver crashed' },
  })
  delete failed.official_score
  const html = renderReport(failed)
  assert.match(html, /<h1[^>]*>\s*EVALUATION FAILED\s*<\/h1>/)
  assert.match(html, /browser-evaluation/)
  assert.match(html, /driver crashed/)
  assert.match(html, /product verdict is unavailable/i)
})

test('a conclusive unscored product failure explains build or serve failure without inventing a score or review', () => {
  const failed = result({
    evaluation_status: 'complete',
    product_verdict: 'fail',
    label: 'FAIL',
    human_review: undefined,
    automated_subtotal: null,
    product_failure: {
      phase: 'verification',
      reason: 'the delivered product could not build',
      gate: 'verification-build-whole-app',
    },
    available_component_scores: [{
      id: 'demo-technical-quality',
      title: 'Demo',
      points_awarded: 12,
      points_possible: 24,
    }],
  })
  delete failed.official_score

  const html = renderReport(failed)

  assert.match(html, /<h1[^>]*>\s*FAIL\s*<\/h1>/)
  assert.match(html, /could not build/i)
  assert.match(html, /official score and human review are unavailable/i)
  assert.match(html, /verification-build-whole-app/)
  assert.doesNotMatch(html, /Official score:\s*\d/)
  assert.doesNotMatch(html, /product verdict is unavailable/i)
})

test('a harness failure after a durable verdict displays both facts', () => {
  const html = renderReport(result({
    evaluation_status: 'evaluation-harness-failed',
    label: 'PASS — HARNESS FAILURE',
    failed_phase: 'cleanup',
    failure: { owner: 'evaluation-harness', phase: 'cleanup', reason: 'could not stop the candidate server' },
  }))
  assert.match(html, /<h1[^>]*>\s*PASS — HARNESS FAILURE\s*<\/h1>/)
  assert.match(html, /84/)
  assert.match(html, /could not stop the candidate server/)
})

test('the report is offline and executes nothing', () => {
  const html = renderReport(result())
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/)
  assert.doesNotMatch(html, /<link[^>]+href/i)
  assert.doesNotMatch(html, /<[a-z]+[^>]*\son[a-z]+\s*=/i)
})

test('candidate-controlled markup renders as inert text', () => {
  const hostile = result()
  hostile.score.components[0].subcomponents[0].criteria[0].rationale =
    '<script>alert(1)</script><img src=x onerror="alert(2)">'
  hostile.score.components[0].subcomponents[0].criteria[0].evidence = ['" onmouseover="alert(3)']
  hostile.human_review.responses[0].rationale = '</td></tr><script>alert(4)</script>'

  const html = renderReport(hostile)

  // The hostile text survives as characters but never as a tag or an attribute.
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /<[a-z]+[^>]*\son[a-z]+\s*=/i)
  assert.doesNotMatch(html, /<img/i)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;\/td&gt;&lt;\/tr&gt;/)
})

test('artifact links are relative to the run directory', () => {
  const html = renderReport(result({
    artifacts: [{ path: 'phases/score.json', bytes: 10 }, { path: 'ambiguity-ledger.json', bytes: 20 }],
  }))
  assert.match(html, /href="phases\/score\.json"/)
  assert.match(html, /href="ambiguity-ledger\.json"/)
  assert.doesNotMatch(html, /href="\//)
})

test('artifact paths outside the retained run directory render as inert text rather than links', () => {
  const html = renderReport(result({
    artifacts: [
      { path: '../outside.txt', bytes: 1 },
      { path: '/absolute.txt', bytes: 2 },
      { path: 'https://evil.example/payload', bytes: 3 },
      { path: 'phases/score.json', bytes: 10 },
    ],
  }))

  assert.match(html, /href="phases\/score\.json"/)
  assert.doesNotMatch(html, /href="\.\.\/outside\.txt"/)
  assert.doesNotMatch(html, /href="\/absolute\.txt"/)
  assert.doesNotMatch(html, /href="https:\/\//)
  assert.match(html, /\.\.\/outside\.txt/)
})

test('delivery identity and evidence ownership render in separate auditable sections', () => {
  const sha = 'f'.repeat(40)
  const html = renderReport(result({
    delivery: {
      repository: 'https://example.test/and-scene.git',
      branch: 'eval/and-scene/run-1',
      base_branch: 'main',
      pull_request: {
        url: 'https://example.test/pull/7',
        draft: true,
        base: 'main',
        head_sha: sha,
      },
      final_sha: sha,
      final_validator: { status: 'passed' },
      candidate_reported_ci: { status: 'pending', revision: sha },
      acceptance: { manifest_sha256: 'a'.repeat(64) },
    },
    evidence: {
      candidate: {
        ownership: 'candidate-produced',
        final_sha: sha,
        manifest_sha256: 'b'.repeat(64),
        artifacts: [{
          id: 'candidate-flow',
          kind: 'acceptance-flow-record',
          ownership: 'candidate-produced',
          sha256: 'c'.repeat(64),
          revision: sha,
          verification_state: 'verified',
          coverage: ['demo-flow'],
          limitations: ['narrow viewport not claimed'],
        }],
      },
      evaluator: {
        ownership: 'evaluator-produced',
        final_sha: sha,
        manifest_sha256: 'd'.repeat(64),
        artifacts: [{
          id: 'route-probe',
          kind: 'deterministic-probe',
          ownership: 'evaluator-produced',
          sha256: 'e'.repeat(64),
          revision: sha,
          verification_state: 'verified',
          coverage: ['demo-route'],
          limitations: [],
        }],
      },
      lineage: { accepted: true, final_sha: sha },
      contradictions: [{
        id: 'contradiction-1',
        claim: 'all routes passed',
        consequence: 'the evaluator observed a missing route',
      }],
    },
  }))

  assert.match(html, /<summary>Candidate delivery identity<\/summary>/)
  assert.match(html, /eval\/and-scene\/run-1/)
  assert.match(html, /pending/)
  assert.match(html, /<summary>Candidate-produced evidence<\/summary>/)
  assert.match(html, /<summary>Evaluator-produced evidence<\/summary>/)
  assert.match(html, /candidate-flow/)
  assert.match(html, /route-probe/)
  assert.match(html, /contradiction-1/)
  assert.match(html, /narrow viewport not claimed/)
})

test('details for every reported dimension are expandable', () => {
  const html = renderReport(result())
  for (const heading of [
    'Component and subcomponent scores',
    'Hard gates',
    'Automated criteria',
    'Human review',
    'Candidate delivery identity',
    'Candidate-produced evidence',
    'Evaluator-produced evidence',
    'Evidence lineage and contradictions',
    'Workflow and harness outcomes',
    'Agent roles and models',
    'Implementation usage and cost',
    'Pricing sources',
    'Machine timing',
    'Completeness',
    'Source and version details',
    'Artifacts',
  ]) {
    assert.match(html, new RegExp(`<summary>${heading}</summary>`), heading)
  }
  // Plain language, never the word "provenance", in human-facing output.
  assert.doesNotMatch(html, /provenance/i)
})

test('a comparable baseline renders totals, components, gates, and deltas', () => {
  const html = renderReport(result({
    baseline: {
      comparable: true,
      reason: null,
      baseline_run_id: 'baseline-1',
      totals: { baseline: 92, candidate: 84, delta: -8 },
      components: [{ id: 'demo-technical-quality', title: 'Demo', points_possible: 25, baseline: 25, candidate: 20, delta: -5 }],
      subcomponents: [{ id: 'demo-contract', title: 'Contract', points_possible: 12, baseline: 12, candidate: 10, delta: -2 }],
      gates: [{ id: 'quality-builds-clean', baseline: 'pass', candidate: 'pass', changed: false }],
      human_review: { baseline: 27, candidate: 24, delta: -3 },
      implementation_cost: { baseline: null, candidate: 4.5, delta: null },
      not_applicable: ['agent_roles', 'implementation_cost', 'implementation_timing'],
    },
  }))

  assert.match(html, /<summary>Reference baseline comparison<\/summary>/)
  assert.match(html, /baseline-1/)
  assert.match(html, /-8/)
  assert.match(html, /-5/)
  // A not-applicable baseline metric is labelled, never rendered as zero.
  assert.match(html, /not applicable/i)
  assert.doesNotMatch(html, />0<\/td>\s*<td>4\.5</)
})

test('an incomparable baseline is refused rather than rendered as a delta', () => {
  const html = renderReport(result({
    baseline: {
      comparable: false,
      reason: 'automated rubric version differs: candidate 2.0.0, baseline 1.9.0',
      baseline_run_id: null,
      totals: null,
      components: [],
      subcomponents: [],
      gates: [],
      human_review: null,
      implementation_cost: null,
      not_applicable: [],
    },
  }))

  assert.match(html, /automated rubric version differs/)
  assert.match(html, /cannot be compared directly/i)
  assert.doesNotMatch(html, /<summary>Reference baseline comparison<\/summary>[\s\S]*?<th>Delta<\/th>/)
})

test('available component scores are shown without an unofficial total', () => {
  const failed = result({
    evaluation_status: 'evaluation-harness-failed',
    product_verdict: 'unavailable',
    label: 'EVALUATION FAILED',
    automated_subtotal: null,
    available_component_scores: [
      { id: 'demo-technical-quality', title: 'Demo', points_awarded: 20, points_possible: 25 },
    ],
  })
  delete failed.official_score
  const html = renderReport(failed)

  assert.match(html, /<summary>Available component scores<\/summary>/)
  assert.match(html, /20/)
  assert.doesNotMatch(html, /unofficial total/i)
})

test('rendering fails rather than publishing an outcome that contradicts result.json', () => {
  assert.throws(
    () => renderReport(result(), { current: result({ product_verdict: 'fail', label: 'FAIL', official_score: 51 }) }),
    (error) => {
      assert.ok(error instanceof ReportConsistencyError)
      assert.match(error.message, /product_verdict/)
      return true
    },
  )
})

test('rendering succeeds when the report matches the current result', () => {
  assert.doesNotThrow(() => renderReport(result(), { current: result() }))
})

test('escapeHtml neutralizes every markup-significant character', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;')
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(4.5), '4.5')
})
