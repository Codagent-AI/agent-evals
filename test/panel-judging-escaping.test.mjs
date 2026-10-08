import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  SOURCE_JUDGE_RESULT_SCHEMA, buildReciteRequest, parseSourceAuditOutput, resolveJudgeSamples,
  resolveLineCitedRecord, runJudgeJob,
} from '../evals/lib/panel-judging/protocol.mjs'

// Judge text is HTML-escaped once, when it is parsed. Framing it again for a
// prompt, a rationale, or evidence must not escape it a second time.
const RAW = 'a & b <c>'
const ONCE = 'a &amp; b &lt;c&gt;'
const assertSinglyEscaped = (text) => {
  assert.ok(text.includes(ONCE), text)
  assert.doesNotMatch(text, /&amp;(?:amp|lt|gt|quot|#39);/)
}
const audit = (classification) => JSON.stringify({ results: [{ id: 'x', classification, rationale: RAW, evidence: [RAW] }] })
const parsedAudit = (classification) => parseSourceAuditOutput(audit(classification), ['x'], 'job')[0]

async function sourceRequest(t, extra = {}) {
  const root = await makeTempDir(join(tmpdir(), 'panel-escaping-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'source'))
  await writeFile(join(root, 'source/a'), 'mechanism\n')
  return { schema: SOURCE_JUDGE_RESULT_SCHEMA, job: 'job', criteria: ['x'], prompt: 'context', prompt_body: 'context',
    cwd: root, input_roots: { source: join(root, 'source') }, verified_source_paths: ['a'], source_audit: true, ...extra }
}
const vote = JSON.stringify({ results: [{ id: 'x', verdict: 'pass', rationale: 'reason', evidence: ['a'], citations: ['a'] }] })

test('a contradicting source audit is quoted into the vote evidence escaped once', async (t) => {
  const outcome = await runJudgeJob({ request: await sourceRequest(t),
    invoke: async (next) => (next.audit_stage ? audit('contradicted') : vote) })
  const quoted = outcome.results[0].evidence.filter((item) => item.startsWith('source audit contradicted this vote'))
  assert.equal(quoted.length, 2)
  for (const item of quoted) assertSinglyEscaped(item)
})

test('an insufficient source audit reaches the re-cite prompt and fallback fail escaped once', async (t) => {
  const prompts = []
  const outcome = await runJudgeJob({ request: await sourceRequest(t, { requireSourceCitationsFor: ['x'] }),
    invoke: async (next) => {
      if (next.audit_stage) return audit('insufficient')
      prompts.push(next.prompt)
      return vote
    } })
  assert.equal(prompts.length, 2)
  assertSinglyEscaped(prompts[1].split('# Previous source audit')[1])
  const [result] = outcome.results
  assert.equal(result.verdict, 'fail')
  assertSinglyEscaped(result.rationale)
  for (const item of result.evidence) assertSinglyEscaped(item)
})

test('the decider re-cite prompt quotes the span audit escaped once', () => {
  const recite = buildReciteRequest({ tiebreakRequest: { job: 'job', prompt_body: 'context' },
    claims: [{ id: 'x', audit: parsedAudit('insufficient') }] })
  assertSinglyEscaped(recite.prompt)
})

test('a confirmed contradiction turned into a consensus vote is quoted escaped once', () => {
  const contradiction = parsedAudit('contradicted')
  const turned = { id: 'x', verdict: 'pass', rationale: 'reason', evidence: ['a'], citations: ['a'], disputed: true,
    contradiction: { rationale: contradiction.rationale, evidence: contradiction.evidence }, contradiction_confirmed: true }
  const { results } = resolveJudgeSamples({ criteria: ['x'], samples: [{ results: [turned] }, { results: [turned] }] })
  assert.equal(results[0].verdict, 'fail')
  assertSinglyEscaped(results[0].rationale)
  // The last item is the harness's judging-basis note.
  for (const item of results[0].evidence.slice(0, -1)) assertSinglyEscaped(item)
})

test('decider span-audit rulings quote audits and line references escaped once', () => {
  const spans = { x: [{ path: 'a&b', start_line: 1, end_line: 1, lines: [{ line: 1, text: 'mechanism' }] }] }
  const result = { id: 'x', verdict: 'pass', rationale: 'reason', evidence: ['a'], citations: [{ path: 'a&b', start_line: 1, end_line: 1 }] }
  const contradicted = resolveLineCitedRecord({ results: [result], spans,
    audit_results: [parsedAudit('contradicted')], contradiction_checks: [parsedAudit('confirmed')] })[0].result
  assert.equal(contradicted.verdict, 'fail')
  assertSinglyEscaped(contradicted.rationale)
  for (const item of contradicted.evidence.filter((entry) => entry.startsWith('span audit'))) assertSinglyEscaped(item)
  assert.ok(contradicted.evidence.includes('quoted lines: a&amp;b:1-1'))
  const fallback = resolveLineCitedRecord({ results: [result], spans,
    audit_results: [parsedAudit('insufficient')] }, ['x'])[0].result
  assert.equal(fallback.verdict, 'fail')
  assertSinglyEscaped(fallback.rationale)
})
