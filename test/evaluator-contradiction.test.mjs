import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { detectEvaluatorContradictions } from '../evals/agent-runner/and-scene/lib/evidence.mjs'
import { validateAutomatedRubric } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { resolveReviewHold, synchronizeReviewHold } from '../evals/agent-runner/and-scene/lib/review-hold.mjs'

const rubric = {
  rubric_id: 'test', version: '5.0.0', automated_points: 70, human_points: 30,
  total_points: 100, pass_threshold: 70, automated_pass_threshold: 40,
  components: [
    { id: 'demo-technical-quality', points: 24, floor: 15, reference_applicable: true, subcomponents: [
      { id: 'browser', points: 12, evaluator: 'deterministic-browser', criteria: ['browser-criterion'] },
      { id: 'judge', points: 12, evaluator: 'llm-source-review', job: 'demo-integration', criteria: ['judge-criterion'] },
    ] },
    { id: 'scene-kit-correctness', points: 24, floor: 15, reference_applicable: true, subcomponents: [{ id: 'kit', points: 24, evaluator: 'llm-source-review', job: 'scene-kit', criteria: ['kit'] }] },
    { id: 'presentation-skill-correctness', points: 7, reference_applicable: true, subcomponents: [{ id: 'presentation', points: 7, evaluator: 'llm-source-review', job: 'presentation-skill', criteria: ['presentation'] }] },
    { id: 'verification-tool-correctness', points: 7, reference_applicable: true, subcomponents: [{ id: 'verification', points: 7, evaluator: 'llm-source-review', job: 'verification-tooling', criteria: ['verification'] }] },
    { id: 'testing-evidence-quality', points: 4, reference_applicable: false, subcomponents: [{ id: 'testing', points: 4, evaluator: 'llm-evidence-review', job: 'testing-evidence', criteria: ['testing-evidence-traceable-coverage', 'testing-evidence-usable-proof', 'testing-evidence-final-revision-applicability', 'testing-evidence-complete-honest-record'] }] },
    { id: 'assumption-handling-quality', points: 4, reference_applicable: false, subcomponents: [{ id: 'assumption', points: 4, evaluator: 'llm-evidence-review', job: 'assumption-handling', criteria: ['assumption-consequential-ambiguities-surfaced', 'assumption-repository-facts-distinguished', 'assumption-decisions-and-escalations-proportionate', 'assumption-final-handoff-preserves-decisions'] }] },
  ],
  gates: [{ id: 'quality-builds-clean' }, { id: 'quality-renders-without-errors' }, { id: 'verification-sample-outline' }, { id: 'verification-build-whole-app' }],
  replaced: [{ id: 'x', reason: 'x' }, { id: 'y', reason: 'y' }], removed: [{ id: 'z', reason: 'z' }, { id: 'q', reason: 'q' }, { id: 'r', reason: 'r' }],
  contradiction_pairs: [{ deterministic: 'browser-criterion', judge: 'judge-criterion', proposition: 'same thing' }],
}

test('records only opposite owner verdicts for declared evaluator pairs', () => {
  const contradictions = detectEvaluatorContradictions({
    components: [{ subcomponents: [{ criteria: [
      { id: 'browser-criterion', verdict: 'fail', verdict_source: 'owner', rationale: 'nothing found', source_citations: ['browser.png'] },
      { id: 'judge-criterion', verdict: 'pass', verdict_source: 'owner', rationale: 'source confirms it', source_citations: ['App.tsx'] },
    ] }] }],
  }, rubric)
  assert.deepEqual(contradictions, [{
    deterministic: { id: 'browser-criterion', verdict: 'fail', rationale: 'nothing found', source_citations: ['browser.png'] },
    judge: { id: 'judge-criterion', verdict: 'pass', rationale: 'source confirms it', source_citations: ['App.tsx'] },
    proposition: 'same thing',
  }])
})

test('does not compare fallback-resolved deterministic criteria', () => {
  const contradictions = detectEvaluatorContradictions({
    components: [{ subcomponents: [{ criteria: [
      { id: 'browser-criterion', verdict: 'fail', verdict_source: 'fallback' },
      { id: 'judge-criterion', verdict: 'pass', verdict_source: 'owner' },
    ] }] }],
  }, rubric)
  assert.deepEqual(contradictions, [])
})

test('rubric validation rejects contradiction pairs across reference applicability boundaries', () => {
  const invalid = structuredClone(rubric)
  invalid.contradiction_pairs = [{ deterministic: 'browser-criterion', judge: 'testing-evidence-traceable-coverage', proposition: 'bad boundary' }]
  assert.ok(validateAutomatedRubric(invalid).some((error) => /reference_applicable/.test(error)))
})

test('a review hold is stable for the same contradiction and verdict-wrong is terminal', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'agent-evals-review-hold-'))
  const contradictions = [{ deterministic: { id: 'browser-criterion', verdict: 'fail' }, judge: { id: 'judge-criterion', verdict: 'pass' } }]
  const first = await synchronizeReviewHold({ runDir, contradictions, now: () => '2026-01-01T00:00:00.000Z' })
  const bytes = await readFile(join(runDir, 'review-hold.json'), 'utf8')
  const second = await synchronizeReviewHold({ runDir, contradictions, now: () => '2026-01-02T00:00:00.000Z' })
  assert.deepEqual(second, first)
  assert.equal(await readFile(join(runDir, 'review-hold.json'), 'utf8'), bytes)
  const resolved = await resolveReviewHold({ runDir, reviewer: 'maintainer', decision: 'verdict-wrong', rationale: 'browser rule is flawed', now: () => '2026-01-03T00:00:00.000Z' })
  assert.equal(resolved.release, null)
  assert.deepEqual(
    await resolveReviewHold({ runDir, reviewer: 'maintainer', decision: 'verdict-wrong', rationale: 'browser rule is flawed' }),
    resolved,
    'retrying the recorded decision permits artifact recovery',
  )
  assert.deepEqual(
    await synchronizeReviewHold({ runDir, contradictions: [{ ...contradictions[0], proposition: 'new evidence wording' }] }),
    resolved,
    'a terminal decision is never replaced by changed evaluator evidence',
  )
  await assert.rejects(
    resolveReviewHold({ runDir, reviewer: 'maintainer', decision: 'stand', rationale: 'too late' }),
    /terminal/,
  )
})
