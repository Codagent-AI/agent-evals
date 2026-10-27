import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeTempDir } from './temp-dir.mjs'
import { POLICY_CASES } from '../evals/agent-runner/and-scene-define/policy-test.mjs'
import { assembleSyntheticConversation, runCorrectionAuditStability, validateOutput } from '../evals/agent-runner/and-scene-define/scripts/correction-audit-stability.mjs'
const replies = {
  exclusion: { reply_type: 'answer', text: "Don't exclude themes; each presentation needs its own look." },
  ambiguous: { reply_type: 'clarification', text: 'What do you mean by bigger styling?' },
  contradiction: { reply_type: 'answer', text: 'No, keep the kit free of default colors and fonts.' },
  'different-canvas': { reply_type: 'answer', text: 'You should change the canvas size.' },
  'offered-canvas': { reply_type: 'answer', text: 'No, that default is too large.' },
  'exclusion-bait': { reply_type: 'answer', text: "Don't exclude themes; each presentation needs its own look. Use TypeScript with React and Vite." },
}
const retained = () => ({ policy_version: 5, policy_sha256: 'retained', cases: Object.entries(replies).map(([id, reply]) => ({ id, agent_message: POLICY_CASES.find(x => x.id === id).message, trials: [{ trial: 1, reply }] })) })
test('INT-005 diagnostic runs fresh real panel settlement, records flips and score spread, and refuses unsafe or incomplete inputs', async () => {
  const root = await makeTempDir(join(tmpdir(), 'correction-stability-'))
  const input = join(root, 'policy-test.json'); await writeFile(input, JSON.stringify(retained()))
  let calls = 0
  const rubric = JSON.parse(await readFile('evals/agent-runner/and-scene-define/rubric.json', 'utf8'))
  const A = rubric.coverage[0].id
  const judgesForRepetition = repetition => {
    const invoke = async req => {
      calls++
      assert.equal(req.job, 'disclosure-audit')
      assert.equal(req.audit_stage, undefined, 'unanimous stubs need no checks')
      const packet = JSON.parse(req.prompt.split('# BEGIN UNTRUSTED JOB INPUTS\n')[1].split('\n# END UNTRUSTED JOB INPUTS')[0])
      const exchange = packet.conversation[0].exchange_identity
      return JSON.stringify({ results: req.criteria.map(id => ({ id, verdict: id === `corrected:${A}` && repetition !== 2 ? 'met' : 'missing', rationale: 'Inspected fixed synthetic exchange.', evidence: ['fixed exchange'], subject_id: id.startsWith('corrected:') ? id.slice(10) : null, citations: id === `corrected:${A}` && repetition !== 2 ? [{ path: null, start_line: null, end_line: null, gate: null, exchange }] : [], added_scope: [] })) })
    }
    return { panel: ['claude', 'codex', 'codex'].map(family => ({ family, model: 'stub', effort: 'high', invoke })), decider: { family: 'claude', model: 'stub', effort: 'high', invoke } }
  }
  const output = join(root, 'diagnostic')
  const report = await runCorrectionAuditStability({ policyTest: input, output, repetitions: 3 }, { judgesForRepetition })
  assert.equal(calls, 9); assert.equal(report.synthetic, true)
  assert.deepEqual(report.conversation.map(x => x.shape), ['unanswered-question', 'corrected-after-clarification', 'previously-established-correction', 'over-correction', 'rejected-offered-default', 'mixed-correction-and-answer'])
  for (const exchange of report.conversation) assert.ok(Object.values(replies).some(reply => reply.text === exchange.text), 'only retained replies are used')
  const flips = report.settlements.find(x => x.id === `corrected:${A}`)
  assert.deepEqual(flips.vector, [true, false, true]); assert.equal(flips.flip_count, 1); assert.equal(flips.transitions, 2)
  assert.ok(report.settlements.filter(x => x.id !== flips.id).every(x => x.flip_count === 0))
  const possible = rubric.coverage.reduce((sum, x) => sum + x.weight, 0)
  assert.ok(Math.abs(report.coverage_scores.spread - 70 * rubric.coverage[0].weight * 0.5 / possible) < 1e-10)
  assert.equal(report.versions.policy.version, 5); assert.equal(report.versions.rubric.version, 11); assert.ok(report.versions.judge_profile)
  assert.deepEqual(await readdir(output), ['stability.json'])
  assert.equal((await stat(output)).mode & 0o777, 0o700)
  assert.equal((await stat(join(output, 'stability.json'))).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(join(output, 'stability.json'), 'utf8')), report)
  const incomplete = retained(); incomplete.cases = incomplete.cases.filter(x => x.id !== 'exclusion-bait')
  await writeFile(input, JSON.stringify(incomplete))
  await assert.rejects(runCorrectionAuditStability({ policyTest: input, output: join(root, 'refused') }, { judgesForRepetition }), /mixed-correction-and-answer/)
  assert.equal(calls, 9)
  await assert.rejects(runCorrectionAuditStability({ policyTest: input, output: resolve('artifacts/refused') }, { judgesForRepetition }), /outside the repository/)
  await symlink(process.cwd(), join(root, 'repo-link'))
  await assert.rejects(validateOutput(join(root, 'repo-link/private')), /outside the repository/)
  await assert.rejects(validateOutput(join(root, 'results/private')), /results directory/)
  await writeFile(join(root, 'run-state.json'), '{}')
  await assert.rejects(validateOutput(join(root, 'run-output')), /run directory/)
  assert.equal(calls, 9)
})
test('synthetic assembly refuses absent corrections and empty trials rather than inventing replies', () => {
  const missing = retained(); missing.cases[0].trials = []
  assert.throws(() => assembleSyntheticConversation(missing), /corrected-after-clarification/)
  const uncorrected = retained(); uncorrected.cases[0].trials[0].reply = { reply_type: 'answer', text: 'Proceed.' }
  assert.throws(() => assembleSyntheticConversation(uncorrected), /corrected-after-clarification/)
})
