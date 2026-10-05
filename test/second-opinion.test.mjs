import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import {
  buildSecondOpinionRequest, outlineFollowUpTargets, runSecondOpinion, secondOpinionTargets,
} from '../evals/agent-runner/and-scene/lib/second-opinion.mjs'

const uphold = { decision: 'uphold', rationale: 'the recorded failure stands', mismeasured_step: null,
  measurement_fault: null, citations: [], log_citations: [] }

test('second opinions target owner failures and failed gates once, excluding reference baselines', () => {
  const args = { deterministic: [{ id: 'demo-supported-navigation', verdict: 'fail' },
    { id: 'demo-present-mode-behavior', verdict: null }],
  gates: [{ id: 'verification-sample-outline', verdict: 'fail' },
    { id: 'verification-every-produced-step-renders', verdict: 'fail' }] }
  assert.deepEqual(secondOpinionTargets(args), [
    { kind: 'criterion', id: 'demo-supported-navigation' },
    { kind: 'gate', id: 'verification-every-produced-step-renders' },
  ])
  assert.deepEqual(secondOpinionTargets({ ...args, mode: 'reference-baseline' }), [])
  assert.deepEqual(outlineFollowUpTargets({ resolutions: new Map([
    ['demo-nine-step-content-and-order', { result: { verdict: 'fail' } }],
  ]), checked: [] }), [{ kind: 'criterion', id: 'demo-nine-step-content-and-order',
    on_behalf_of: 'verification-sample-outline' }])
})

test('an overturn without source spans is rejected while uphold remains fail', async () => {
  const request = { target: { kind: 'criterion', id: 'demo-supported-navigation' } }
  const accepted = await runSecondOpinion({ request, invoke: async () => JSON.stringify(uphold) })
  assert.equal(accepted.verdict, 'fail')
  const rejected = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...uphold, decision: 'overturn', mismeasured_step: 'swipe', measurement_fault: 'input mismatch',
  }) })
  assert.equal(rejected.decision, 'overturn-rejected')
  assert.equal(rejected.verdict, 'fail')
  const tooMany = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...uphold, decision: 'overturn', mismeasured_step: 'swipe', measurement_fault: 'input mismatch',
    citations: Array.from({ length: 13 }, () => ({ path: 'src/demo.js', start_line: 1, end_line: 1 })),
  }) })
  assert.equal(tooMany.decision, 'overturn-rejected')
})

test('malformed verifier output exhausts retries without silently upholding', async () => {
  let calls = 0
  const outcome = await runSecondOpinion({ request: { target: { kind: 'criterion', id: 'demo-supported-navigation' } },
    attempts: 2, invoke: async () => { calls += 1; return '{broken' } })
  assert.equal(calls, 2)
  assert.equal(outcome.ok, false)
})

test('an audited exact source span can overturn and invalid line ranges cannot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'second-opinion-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/demo.js'), 'pointer handler\n')
  const rubrics = await loadRubrics()
  const neutral = { root, source_root: root, audit_root: root, sources: ['src/demo.js'] }
  const request = buildSecondOpinionRequest({ target: { kind: 'criterion', id: 'demo-supported-navigation' },
    rubrics, browser: { probes: [{ id: 'demo-supported-navigation', result: { verdict: 'fail' },
      reading_basis: [{ mode: 'declared' }], failures: [] }] }, neutral, authority: { model: 'test' } })
  const answer = { ...uphold, decision: 'overturn', mismeasured_step: 'swipe',
    measurement_fault: 'touch dispatched but source handles pointer',
    citations: [{ path: 'src/demo.js', start_line: 1, end_line: 1 }] }
  let calls = 0
  const result = await runSecondOpinion({ request, invoke: async (r) => {
    calls += 1
    if (r.audit_stage) {
      assert.match(r.prompt, /pointer handler/)
      assert.match(r.prompt, /reading_basis/)
      return JSON.stringify({ results: [{ id: 'demo-supported-navigation', classification: 'confirmed',
        rationale: 'source proves the behavior and fault', evidence: ['src/demo.js:1'] }] })
    }
    return JSON.stringify(answer)
  } })
  assert.equal(calls, 2)
  assert.equal(result.verdict, 'pass')
  const invalid = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...answer, citations: [{ path: 'src/demo.js', start_line: 9, end_line: 9 }],
  }) })
  assert.equal(invalid.decision, 'overturn-rejected')
})

test('a terminal overturn without recorded log lines is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-opinion-'))
  await writeFile(join(root, 'package.json'), '{"scripts":{"build":"vite build"}}\n')
  const request = { target: { kind: 'terminal', id: 'verification-build-whole-app' },
    verified_source_paths: ['package.json'], input_roots: { source: root },
    log_root: root, log_artifact: 'build.log' }
  const outcome = await runSecondOpinion({ request, invoke: async () => JSON.stringify({
    ...uphold, decision: 'overturn', mismeasured_step: 'build invocation',
    measurement_fault: 'the wrong script ran',
    citations: [{ path: 'package.json', start_line: 1, end_line: 1 }],
  }) })
  assert.equal(outcome.decision, 'overturn-rejected')
  assert.match(outcome.rejection_reason, /log citation/)
})

test('a contrary runtime error remains in the audit packet and a nonconfirmation rejects overturn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-opinion-'))
  await writeFile(join(root, 'handler.js'), 'pointer handler\n')
  const request = { target: { kind: 'criterion', id: 'demo-supported-navigation' },
    verified_source_paths: ['handler.js'], input_roots: { source: root }, audit_cwd: root,
    failing_record: { result: { verdict: 'fail' }, runtime_failures: ['TypeError during swipe'] } }
  const answer = { ...uphold, decision: 'overturn', mismeasured_step: 'swipe',
    measurement_fault: 'touch input mismatch',
    citations: [{ path: 'handler.js', start_line: 1, end_line: 1 }] }
  const outcome = await runSecondOpinion({ request, invoke: async (call) => {
    if (!call.audit_stage) return JSON.stringify(answer)
    assert.match(call.prompt, /TypeError during swipe/)
    return JSON.stringify({ results: [{ id: request.target.id, classification: 'contradicted',
      rationale: 'the runtime error was not explained', evidence: ['recorded page error'] }] })
  } })
  assert.equal(outcome.decision, 'overturn-rejected')
  assert.equal(outcome.verdict, 'fail')
})
