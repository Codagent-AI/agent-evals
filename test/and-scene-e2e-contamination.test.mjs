import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { temp } from './and-scene-e2e-helpers.mjs'
import { collectEvidence, loadEvidence } from '../evals/lib/define-run/evidence.mjs'
import { auditContamination } from '../evals/lib/define-run/contamination.mjs'
import { compilePatterns, scanCanaries } from '../evals/lib/define-run/canary.mjs'
import { filesUnder } from '../evals/lib/define-run/files.mjs'
import { effectiveInvocations, invocationsThrough } from '../evals/agent-runner/and-scene-e2e/lib/metrics.mjs'
import { validateProfiles, parseArguments } from '../evals/agent-runner/and-scene-e2e/lib/options.mjs'
import { materialize } from '../evals/lib/define-run/starting-repo.mjs'

const patterns = JSON.parse(await readFile(new URL('../evals/agent-runner/and-scene-e2e/contamination-patterns.json', import.meta.url), 'utf8'))
const STEPS = ['create', 'define', 'implement']
const SNAP = { define: { evidenceRoot: 'evidence/define', manifestPath: 'evidence/define-manifest.json' }, final: { evidenceRoot: 'evidence/final', manifestPath: 'evidence/final-manifest.json' } }
const done = { codex: '{"type":"event_msg","payload":{"type":"task_complete"}}\n', claude: '{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}\n' }
const codexCall = (input, output = 'ok') => `{"type":"response_item","payload":{"type":"function_call","call_id":"c1","name":"shell","arguments":${JSON.stringify(input)}}}\n{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":${JSON.stringify(output)}}}\n${done.codex}`
const claudeCall = (input, output = 'ok') => `{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Bash","input":${JSON.stringify({ command: input })}}]}}\n{"type":"user","sourceToolUseID":"t1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":${JSON.stringify(output)}}]}}\n${done.claude}`
const STEP = (id, prefix, role, cli, session) => ({ id, prefix, role, cli, agent_invoked: true, session_id: session })
async function world(t, { transcripts = {}, invocations, omit = [], validator = true } = {}) {
  const root = await temp(t, 'e2e-evidence-')
  const session = join(root, 'sandbox/.runtime/agent-runner-projects/p/runs/r1')
  await mkdir(join(session, 'output'), { recursive: true }); await mkdir(join(session, 'external-user'), { recursive: true })
  const steps = invocations ?? [
    STEP('proposal', 'define/sub:define-change', 'lead', 'codex', 'lead-s'), STEP('call-1', 'define/sub:define-change/approach-review', 'crosscheck', 'cursor', 'cursor-s'),
    STEP('implementor-checklist', 'implement/sub:implement-change', 'implementor', 'claude', 'impl-s'), STEP('acceptance', 'implement/sub:implement-change/acceptance', 'tester', 'codex', 'test-s'), STEP('review-2', 'implement/sub:implement-change/review', 'reviewer', 'codex', 'extra-s'),
  ]
  await writeFile(join(session, 'run-metrics.json'), JSON.stringify({ schema_version: 3, run_id: 'r1', workflow: 'change', steps }))
  for (const file of ['state.json', 'audit.log']) await writeFile(join(session, file), file === 'state.json' ? '{}' : '')
  await writeFile(join(session, 'external-user/exchanges.jsonl'), ''); await writeFile(join(root, 'conversation.jsonl'), '')
  await writeFile(join(session, 'output/define_sub_define-change.attempt-1.turn-1.out'), '{"type":"turn.completed"}\n')
  for (const step of steps) {
    if (omit.includes(step.session_id)) continue
    if (step.cli === 'cursor') {
      const dir = join(root, 'sandbox/.runtime/cursor/chats/x', step.session_id); await mkdir(dir, { recursive: true })
      const blobs = [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'k1', toolName: 'shell', args: { command: transcripts[step.session_id] ?? 'ls' } }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'k1', toolName: 'shell', result: 'ok' }] }, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }]
      const sql = ['CREATE TABLE blobs(id TEXT, data BLOB);', ...blobs.map((blob, n) => `INSERT INTO blobs VALUES('${n}', '${JSON.stringify(blob).replaceAll("'", "''")}');`)].join('\n')
      execFileSync('sqlite3', [join(dir, 'store.db'), sql])
      continue
    }
    const text = transcripts[step.session_id] ?? done[step.cli]
    const native = step.cli === 'claude' ? join(root, 'sandbox/.runtime/claude/projects/p') : join(root, 'sandbox/.runtime/codex/sessions')
    await mkdir(native, { recursive: true }); await writeFile(join(native, step.cli === 'claude' ? `${step.session_id}.jsonl` : `rollout-x-${step.session_id}.jsonl`), text)
  }
  // A Validator reviewer session exists on disk but is not an evaluated invocation.
  if (validator) { await mkdir(join(root, 'sandbox/.runtime/claude/projects/p'), { recursive: true }); await writeFile(join(root, 'sandbox/.runtime/claude/projects/p/validator-s.jsonl'), claudeCall('echo and-scene-e2e hidden', 'Codagent-AI/and-scene')) }
  const metrics = JSON.parse(await readFile(join(session, 'run-metrics.json'), 'utf8'))
  const all = effectiveInvocations(metrics)
  // Implement-phase turn output exists only once implementation has run.
  const pass = async (which, selected) => { if (which === 'final') await writeFile(join(session, 'output/implement_sub_implement-change.attempt-1.turn-1.out'), '{"type":"turn.completed"}\n'); await collectEvidence({ runDir: root, runnerDir: session, invocations: selected, identity: { run_id: 'x' }, ...SNAP[which] }); return loadEvidence(root, SNAP[which]) }
  return { root, session, all, pass, audit: evidence => auditContamination({ ...evidence, patterns }) }
}
const hashes = async (root, prefix) => Object.fromEntries(await Promise.all((await filesUnder(join(root, prefix))).map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))

test('INT-007 pass 1 audits only the define invocations and pass 2 all of them, leaving the define snapshot untouched', async t => {
  const w = await world(t)
  const one = await w.pass('define', invocationsThrough(w.all, STEPS, 'define'))
  assert.deepEqual(one.manifest.invocations.map(invocation => invocation.role).sort(), ['crosscheck', 'lead'])
  assert.equal(w.audit(one).status, 'clean')
  const before = { files: await hashes(w.root, 'evidence/define'), manifest: await readFile(join(w.root, SNAP.define.manifestPath), 'utf8') }
  const two = await w.pass('final', w.all)
  assert.deepEqual(two.manifest.invocations.map(invocation => invocation.role).sort(), ['crosscheck', 'implementor', 'lead', 'reviewer', 'tester'])
  assert.equal(w.audit(two).status, 'clean')
  assert.deepEqual(await hashes(w.root, 'evidence/define'), before.files); assert.equal(await readFile(join(w.root, SNAP.define.manifestPath), 'utf8'), before.manifest)
  assert.ok(two.manifest.files.some(file => file.path.startsWith('evidence/final/transcripts/'))); assert.ok(!one.manifest.files.some(file => file.path.startsWith('evidence/final/')))
  // The Validator reviewer session is neither required nor audited (it names the fixture, and the run stays clean).
  assert.ok(!two.transcripts.some(transcript => transcript.session_id === 'validator-s'))
})

test('pass 2 skips the Validator reviewer attempts the Runner reports as invoked steps', async t => {
  const validatorStep = { ...STEP('run-validator', 'implement/sub:implement-change/verify-change/run-validator', 'implementation-validator', 'agent-validator', 'validator-run-s'), kind: 'nested-agent', tool: 'agent-validator' }
  const w = await world(t, { invocations: [STEP('proposal', 'define/sub:define-change', 'lead', 'codex', 'lead-s'), STEP('implementor-checklist', 'implement/sub:implement-change', 'implementor', 'claude', 'impl-s'), validatorStep], omit: ['validator-run-s'] })
  assert.deepEqual(w.all.map(invocation => invocation.role), ['lead', 'implementor'])
  const two = await w.pass('final', w.all)
  assert.equal(w.audit(two).status, 'clean')
})

test('INT-007 a missing or truncated transcript for any evaluated role fails collection, including a workflow-added role', async t => {
  for (const session of ['lead-s', 'cursor-s', 'impl-s', 'test-s', 'extra-s']) {
    const w = await world(t, { omit: [session] })
    await assert.rejects(w.pass('final', w.all), /missing or ambiguous transcript|missing or unsupported/, session)
  }
  const truncated = await world(t, { transcripts: { 'impl-s': '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}\n' } })
  await assert.rejects(truncated.pass('final', truncated.all), /truncated or incomplete transcript claude:impl-s/)
})

test('INT-007 a fixture fetch by the implementor or the tester makes the run contaminated naming the call, session and pattern', async t => {
  for (const [session, cli, build] of [['test-s', 'codex', codexCall], ['impl-s', 'claude', claudeCall]]) {
    for (const where of ['input', 'output']) {
      const w = await world(t, { transcripts: { [session]: where === 'input' ? build('git clone https://github.com/Codagent-AI/and-scene') : build('cat notes', 'see Codagent-AI/and-scene for details') } })
      const audit = w.audit(await w.pass('final', w.all))
      assert.equal(audit.status, 'contaminated', `${session} ${where}`); assert.equal(audit.evaluation_status, 'contaminated')
      const match = audit.matches.find(entry => entry.session === session)
      assert.ok(match && match.pattern === 'fixture-repository' && match.field === where && match.tool_call, JSON.stringify(audit.matches))
    }
  }
})

test('INT-007 calls to the run\'s own delivery repository are not matches; a call naming the fixture too still is', async t => {
  const own = await world(t, { transcripts: { 'lead-s': codexCall('git push https://github.com/Codagent-AI/e2e-run-0123abcd.git add-presentation-skill && gh pr create --draft --repo Codagent-AI/e2e-run-0123abcd', 'https://github.com/Codagent-AI/e2e-run-0123abcd/pull/1') } })
  assert.equal(own.audit(await own.pass('final', own.all)).status, 'clean')
  const both = await world(t, { transcripts: { 'lead-s': codexCall('git push https://github.com/Codagent-AI/e2e-run-0123abcd.git && git fetch https://github.com/Codagent-AI/and-scene') } })
  assert.equal(both.audit(await both.pass('final', both.all)).status, 'contaminated')
})

test('INT-007 Validator findings reach the audit through the invoking agent\'s tool output', async t => {
  const w = await world(t, { transcripts: { 'impl-s': claudeCall('agent-validator run', 'review: compare with Codagent-AI/and-scene/skills/presentation') } })
  const audit = w.audit(await w.pass('final', w.all))
  assert.equal(audit.status, 'contaminated'); assert.ok(audit.matches.every(match => match.session === 'impl-s'))
})

test('INT-007 evaluated roles: cursor is accepted only for crosscheck, in preflight and in collection', async t => {
  assert.throws(() => validateProfiles({ lead: { cli: 'codex', model: 'm', effort: 'e' }, crosscheck: { cli: 'cursor', model: 'm', effort: 'e' }, implementor: { cli: 'cursor', model: 'm', effort: 'e' }, tester: { cli: 'codex', model: 'm', effort: 'e' } }), /implementor must use claude or codex: cursor is accepted only for crosscheck/)
  assert.doesNotThrow(() => validateProfiles({ lead: { cli: 'codex', model: 'm', effort: 'e' }, crosscheck: { cli: 'cursor', model: 'm', effort: 'e' }, implementor: { cli: 'claude', model: 'm', effort: 'e' }, tester: { cli: 'codex', model: 'm', effort: 'e' } }))
  const cursorImplementor = await world(t, { invocations: [STEP('proposal', 'define/sub:define-change', 'lead', 'codex', 'lead-s'), STEP('impl', 'implement/sub:implement-change', 'implementor', 'cursor', 'cursor-i')] })
  await assert.rejects(cursorImplementor.pass('final', cursorImplementor.all), /missing or unsupported transcript cursor:cursor-i/)
})

test('INT-007 the engine keeps its matrix: inputs and outputs of every tool, disclosed canaries excluded run-wide, undisclosed ones only when read', () => {
  const canary = patterns.patterns.find(pattern => pattern.kind === 'canary')
  const call = (id, name, input, output = '') => ({ id, name, input, output })
  const calls = [call('1', 'Bash', 'cat ../../exchange/abc.reply.json'), call('2', 'WebSearch', 'q', 'about Codagent-AI/and-scene'), call('3', 'WebFetch', 'https://github.com/Codagent-AI/agent-evals'), call('4', 'Read', 'file', `text ${canary.value}`), call('5', 'Write', 'file', 'ok'), call('6', 'Edit', { new: canary.value })]
  const audit = auditContamination({ transcripts: [{ source: 's', session_id: 'x', calls }], conversation: [], patterns })
  const by = id => audit.matches.filter(match => match.tool_call === id).map(match => match.pattern)
  assert.ok(by('1').includes('exchange-file')); assert.ok(by('2').includes('fixture-repository')); assert.ok(by('3').includes('eval-repository'))
  assert.ok(by('4').includes(canary.id), 'an undisclosed canary arrives through a read'); assert.deepEqual(by('6'), [], 'written content is not scanned for canaries')
  const disclosed = auditContamination({ transcripts: [{ source: 's', session_id: 'x', calls: [calls[3]] }], conversation: [{ reply: `the user said ${canary.value}`, reply_type: 'answer' }], patterns })
  assert.equal(disclosed.status, 'clean'); assert.ok(disclosed.excluded_canaries.includes(canary.id))
  assert.equal(JSON.stringify(auditContamination({ transcripts: [{ source: 's', session_id: 'x', calls }], conversation: [], patterns })), JSON.stringify(audit), 'the audit is deterministic')
})

test('INT-007 the pinned list is qualified, versioned, covers define and e2e locations, and has no override option', () => {
  const ids = patterns.patterns.map(pattern => pattern.id)
  for (const id of ['fixture-repository', 'fixture-url', 'eval-repository', 'hidden-reference-path', 'exchange-file', 'staged-input', 'e2e-suite-name', 'e2e-hidden-product-rubric', 'e2e-hidden-preference-values', 'e2e-hidden-calibration']) assert.ok(ids.includes(id), id)
  assert.equal(patterns.version, 2)
  const compiled = compilePatterns(patterns)
  const matches = text => compiled.filter(pattern => pattern.matches(text)).map(pattern => pattern.id)
  for (const spelling of ['cat ../../exchange/abc.reply.json', 'cat /artifacts/exchange/abc.request.json', 'ls ../exchange/z.request.json']) assert.ok(matches(spelling).includes('exchange-file'), spelling)
  for (const ordinary of ['the exchange of ideas', 'an inventory of items', 'rubric tuning is hard']) assert.deepEqual(matches(ordinary), [], ordinary)
  assert.ok(matches('open evals/agent-runner/and-scene-e2e/product-rubric.json').includes('e2e-hidden-product-rubric'))
  // The workflow's own run scratch and the delivery app's bot login are ordinary; session stores and the suite path are not.
  for (const ordinary of ['ls /artifacts/.runtime/agent-runner-projects/-artifacts-workspace-repo/runs/change-1/scratch/acceptance-test', '"login":"codagent-and-scene-e2e[bot]"']) assert.deepEqual(matches(ordinary), [], ordinary)
  assert.ok(matches('cat /artifacts/.runtime/codex/sessions/rollout-x.jsonl').includes('artifacts-runtime'))
  assert.ok(matches('ls evals/agent-runner/and-scene-e2e').includes('e2e-suite-name'))
  assert.throws(() => parseArguments(['--run-agent', '--ignore-contamination', 'yes'], {}), /unknown option/)
})

test('INT-007 the exact staged starting environment produces no pattern match', async t => {
  const root = await temp(t, 'e2e-stage-')
  const staged = await materialize(join(root, 'stage'), { suiteRoot: new URL('../evals/agent-runner/and-scene-define', import.meta.url).pathname })
  await mkdir(join(root, 'input')); await writeFile(join(root, 'input/starting-repo.bundle'), await readFile(staged.bundlePath))
  const matches = await scanCanaries({ stagedDir: join(root, 'input'), patternsPath: new URL('../evals/agent-runner/and-scene-e2e/contamination-patterns.json', import.meta.url).pathname })
  assert.deepEqual(matches, [])
})
