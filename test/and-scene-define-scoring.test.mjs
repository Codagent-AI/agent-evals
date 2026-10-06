import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRubric, checkRubric, verifyJudgingInputs } from '../evals/agent-runner/and-scene-define/lib/rubric.mjs'
import { checkInventory } from '../evals/agent-runner/and-scene-define/lib/inventory.mjs'
import { scoreDefinition, discoveryLedger } from '../evals/agent-runner/and-scene-define/lib/scoring.mjs'
import { runDefinitionPanel, judgeSchema, exchangeIdentity, makeJobs } from '../evals/agent-runner/and-scene-define/lib/judge-jobs.mjs'
import { assertStrictSchema } from './and-scene-define-helpers.mjs'
const root = 'evals/agent-runner/and-scene-define'
const inventory = JSON.parse(await readFile(join(root, 'hidden/inventory.json'), 'utf8'))
const item = inventory.items.find(x => x.class === 'mandatory')
const citation = { path: 'proposal.md', start_line: 1, end_line: 1, gate: null, exchange: null }
const result = (id, verdict, citations = [citation]) => ({ id, verdict, rationale: 'The cited commitment establishes the requirement.', evidence: ['inspected'], citations, subject_id: null, added_scope: [] })
const inputs = { artifacts: { 'proposal.md': 'A single evolving scene.\n' }, gates: [], conversation: [], items: [item] }
const job = { name: 'coverage:test', kind: 'coverage', criteria: [item.id], inputs }
function members(votes, deciderVote = null, check = 'confirmed', calls = []) {
  return { panel: votes.map((verdict, n) => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high', invoke: async req => {
    calls.push(req)
    return JSON.stringify({ results: req.criteria.map(id => result(id, verdict)) })
  } })), decider: { family: 'claude', model: 'stub-decider', effort: 'high', invoke: async req => {
    calls.push(req)
    return JSON.stringify({ results: req.criteria.map(id => req.audit_stage ? { id, classification: check, rationale: 'Checked the commitment.', evidence: ['source'] } : result(id, deciderVote)) })
  } } }
}
test('anchors and generated rubric are pinned; preflight refuses review and calibration gaps', async () => {
  assert.equal(inventory.anchors_review, null)
  assert.equal(inventory.inventory_version, 2)
  assert.deepEqual(await checkInventory(), [])
  const broken = structuredClone(inventory); delete broken.items.find(x => x.class === 'mandatory').anchors
  assert.ok((await checkInventory({ inventory: broken })).some(x => /anchors/.test(x)))
  const pref = structuredClone(inventory); pref.items.find(x => x.class === 'preference').anchors = item.anchors
  assert.ok((await checkInventory({ inventory: pref })).some(x => /preference.*anchors/.test(x)))
  const rubric = JSON.parse(await readFile(join(root, 'rubric.json'), 'utf8'))
  assert.deepEqual(checkRubric(rubric, inventory), [])
  const stale = structuredClone(rubric); stale.coverage[0].anchors.met = 'changed'
  assert.ok(checkRubric(stale, inventory).length)
  assert.throws(() => verifyJudgingInputs({ inventory, rubric }), /anchors need review/)
  const reviewed = { ...inventory, anchors_review: { reviewer: 'maintainer', date: '2026-10-06', inventory_version: 2 } }
  assert.throws(() => verifyJudgingInputs({ inventory: reviewed, rubric }), /calibration must set/)
  assert.throws(() => verifyJudgingInputs({ inventory: reviewed, rubric: { ...rubric, inventory_version: 1 } }), /inventory version/)
})
for (const [votes, ruling, classification, expected, basis, extra] of [
  [['met','met','met'],null,'confirmed','met','consensus',0],
  [['met','met','missing'],null,'confirmed','met','majority',0],
  [['missing','missing','met'],null,'confirmed','met','checked-dissent',1],
  [['missing','missing','met'],null,'contradicted','missing','majority',1],
  [['met','missing','missing'],'missing','confirmed','missing','decider',1],
  [['met','partial','missing'],'partial','confirmed','partial','decider',1],
]) test(`INT-003 shared panel settles ${votes} with ${classification}`, async () => {
  const calls = []
  const outcome = await runDefinitionPanel({ job, ...members(votes, ruling, classification, calls) })
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failure))
  assert.equal(outcome.results[0].verdict, expected)
  assert.ok(outcome.results[0].basis.startsWith(basis))
  assert.equal(calls.length, 3 + extra)
  for (const call of calls) { assertStrictSchema(call.schema); assert.match(call.prompt, /Judge only/); assert.ok(call.prompt.includes(item.anchors.met)); assert.ok(call.prompt.includes(item.sources[0].quote)) }
  if (basis === 'decider') {
    const prompt = calls.at(-1).prompt.split('# Untrusted panel votes')[1]
    assert.match(prompt, /"label":"A"/); assert.ok(!prompt.includes('stub'))
  }
})
test('invalid decider verdict and uncited met are retried and never scored', async () => {
  const calls = []
  const outcome = await runDefinitionPanel({ job, ...members(['met','missing','missing'], 'partial', 'confirmed', calls) })
  assert.equal(outcome.ok, false); assert.equal(calls.length, 6)
  const judges = members(['met','met','met'])
  let attempts = 0
  judges.panel[0].invoke = async () => { attempts++; return JSON.stringify({ results: [result(item.id, 'met', [])] }) }
  assert.equal((await runDefinitionPanel({ job, ...judges })).ok, false)
  assert.equal(attempts, 3)
})
test('missing design cites absence gate without retry', async () => {
  const calls = []; const judges = members(['missing','missing','missing'], null, 'confirmed', calls)
  for (const judge of judges.panel) judge.invoke = async req => { calls.push(req); return JSON.stringify({ results: [result(item.id, 'missing', [{ ...citation, path: null, start_line: null, end_line: null, gate: 'gate:required-artifact:design' }])] }) }
  const outcome = await runDefinitionPanel({ job: { ...job, inputs: { ...inputs, gates: [{ id: 'gate:required-artifact:design', passed: false }] } }, ...judges })
  assert.equal(outcome.ok, true); assert.equal(calls.length, 3)
})
test('deterministic score excludes leaks, charges fidelity once, gates fail and discovery cannot change scores', () => {
  const rubric = { ...buildRubric(inventory), pass_threshold: 70 }
  const coverage = rubric.coverage.map(x => result(x.id, 'met'))
  const leaked = [coverage[0].id]
  const quality = rubric.quality.map(x => result(x.id, 'met'))
  const fidelity = [result('fidelity:exchange', 'met')]
  const scored = scoreDefinition({ rubric, coverage, quality, fidelity, leaked, gates: [{ passed: false }] })
  assert.equal(scored.evaluation_status, 'complete'); assert.equal(scored.definition_verdict, 'fail')
  assert.equal(scored.components.coverage.score, 60); assert.equal(scored.components.coverage.possible, 94)
  assert.equal(scored.components.fidelity.score, 12); assert.equal(scored.total, 97)
  const asked = coverage.map(x => ({ id: x.id, asked: true, citations: [] }))
  const ledger = discoveryLedger({ coverage: scored.coverage, asked })
  assert.equal(ledger.items[0].outcome, 'leaked'); assert.equal(ledger.counts.discovered, 71)
  assert.equal(discoveryLedger({ coverage: scored.coverage, asked: asked.map(x => ({ ...x, asked: false })) }).counts.inferred, 71)
  assert.deepEqual(scoreDefinition({ rubric, coverage, quality, fidelity, leaked, gates: [{ passed: false }], discovery: ledger }), scored)
  assert.equal(scoreDefinition({ rubric, coverage, quality, fidelity: [], leaked: [], gates: [] }).definition_verdict, 'pass')
})
test('quality inputs contain no hidden material; fidelity excludes graded subjects and requires matching exchange', async () => {
  const exchange = { step: 'define.specs', step_id: 'specs', attempt: 1, turn: 1, agent_message: 'Style?', reply: 'Blue', reply_type: 'answer' }
  const jobs = makeJobs({ inventory, rubric: buildRubric(inventory), artifacts: inputs.artifacts, conversation: [exchange], gates: [] })
  const quality = jobs.find(x => x.kind === 'quality')
  assert.ok(!JSON.stringify(quality.inputs).includes('INV-'))
  const fidelity = jobs.find(x => x.kind === 'fidelity')
  const judges = members(['met','met','met'])
  for (const judge of judges.panel) judge.invoke = async req => JSON.stringify({ results: req.criteria.map(id => ({ ...result(id, 'met', [citation, { ...citation, path: null, start_line: null, end_line: null, exchange: exchangeIdentity(exchange) }]), subject_id: item.id })) })
  assert.equal((await runDefinitionPanel({ job: fidelity, ...judges })).ok, false)
  for (const judge of judges.panel) judge.invoke = async req => JSON.stringify({ results: req.criteria.map(id => result(id, 'met', [citation, { ...citation, path: null, start_line: null, end_line: null, exchange: 'wrong' }])) })
  assert.equal((await runDefinitionPanel({ job: fidelity, ...judges })).ok, false)
  assertStrictSchema(judgeSchema([item.id]))
})

import { runGates } from '../evals/agent-runner/and-scene-define/lib/gates.mjs'
import { createJudgingPhases } from '../evals/agent-runner/and-scene-define/lib/judging.mjs'
import { createCheckpoint } from '../evals/agent-runner/and-scene-define/lib/checkpoint.mjs'
import { runDiscovery } from '../evals/agent-runner/and-scene-define/lib/judge-jobs.mjs'
const exchange = { step: 'define.specs', step_id: 'specs', attempt: 1, turn: 1, agent_message: 'Requirements?', reply: 'Here is an answer.', reply_type: 'answer' }
const exchangeCitation = { path: null, start_line: null, end_line: null, gate: null, exchange: exchangeIdentity(exchange) }
async function phaseFixture(t) {
  const runDir = await mkdtemp(join(tmpdir(), 'define-score-')); t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, 'collected'))
  await writeFile(join(runDir, 'collected/proposal.md'), inputs.artifacts['proposal.md'])
  const subset = { ...inventory, items: inventory.items.filter(x => x.class !== 'preference').slice(0, 5) }
  const rubric = { ...buildRubric(subset), pass_threshold: 70 }
  let checkpoint = createCheckpoint({ run_id: 'test', identity: { series_identity: { fixture: 'test' } } })
  const calls = []; let failure = false
  const invoke = index => async req => {
    calls.push({ index, job: req.job, stage: req.audit_stage })
    if (failure && req.job === 'artifact-quality') throw new Error('rejected stub call')
    if (req.audit_stage) return JSON.stringify({ results: req.criteria.map(id => ({ id, classification: 'confirmed', rationale: 'Flag matches the exchange.', evidence: ['exchange'] })) })
    if (req.job === 'discovery') return JSON.stringify({ results: req.criteria.map((id, n) => ({ id, asked: n % 2 === 0, rationale: 'Asked in the exchange.', citations: n % 2 === 0 ? [exchangeCitation] : [] })) })
    const results = req.criteria.map(id => {
      if (req.job === 'disclosure-audit') {
        const n = subset.items.findIndex(x => id === `leak:${x.id}`)
        // First: cross-family majority; second: Codex-only; third: single backed dissent.
        const flagged = n === 0 ? index !== 2 : n === 1 ? index !== 0 : n === 2 ? index === 2 : id.startsWith('inconsistent-withholding:')
        return result(id, flagged ? 'met' : 'missing', flagged ? [exchangeCitation] : [])
      }
      if (req.job === 'fidelity') return result(id, 'missing', [exchangeCitation])
      return result(id, 'missing', [{ ...citation, start_line: null, end_line: null }])
    })
    return JSON.stringify({ results })
  }
  const judges = { panel: [0,1,2].map(n => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high', invoke: invoke(n) })), decider: { family: 'claude', model: 'stub', effort: 'high', invoke: async req => {
    if (req.audit_stage) return invoke(3)(req)
    calls.push({ index: 3, job: req.job })
    return JSON.stringify({ results: req.criteria.map(id => req.job === 'discovery' ? { id, asked: true, rationale: 'Question in exchange', citations: [exchangeCitation] } : result(id, 'met', [exchangeCitation])) })
  } } }
  const phases = createJudgingPhases({ runDir, judges, getCheckpoint: () => checkpoint, setCheckpoint: x => { checkpoint = x }, persist: async () => {},
    loadInputs: async () => ({ inventory: subset, rubric, artifacts: inputs.artifacts, conversation: [exchange], reference: [], policy: 'Answer only what was asked.' }),
    gateCommand: async (command, args, options) => {
      assert.equal(command, 'openspec'); assert.deepEqual(args, ['validate', 'add-presentation-skill', '--strict'])
      assert.equal(await readFile(join(options.cwd, 'openspec/changes/add-presentation-skill/proposal.md'), 'utf8'), inputs.artifacts['proposal.md'])
      return { status: 1, stdout: '', stderr: 'missing design' }
    },
  })
  return { runDir, phases, calls, setFailure: value => { failure = value }, checkpoint: () => checkpoint, subset }
}
test('INT-003 lifecycle neutralizes settled leaks, records flags and scores absent artifacts as complete/fail', async t => {
  const f = await phaseFixture(t)
  await f.phases['disclosure-audit'](); await f.phases['gates-and-judging'](); await f.phases.discovery()
  const scored = JSON.parse(await readFile(join(f.runDir, 'judges/score.json'), 'utf8'))
  const audit = JSON.parse(await readFile(join(f.runDir, 'audits/disclosure.json'), 'utf8'))
  assert.deepEqual(audit.leaked_items, f.subset.items.slice(0, 3).map(x => x.id))
  assert.ok(audit.flags.some(x => x.type === 'inconsistent-withholding'))
  assert.ok(audit.panel.checks.some(x => x.stage === 'dissent-check'))
  assert.ok(audit.panel.rulings.length)
  assert.equal(scored.definition_verdict, 'fail'); assert.equal(scored.evaluation_status, 'complete')
  assert.equal(scored.components.fidelity.score, 15)
  assert.equal(scored.components.coverage.possible, 3)
  assert.equal(scored.coverage.filter(x => x.verdict === 'leaked').length, 3)
  const ledger = JSON.parse(await readFile(join(f.runDir, 'discovery/ledger.json'), 'utf8'))
  assert.equal(ledger.counts.leaked, 3); assert.equal(ledger.counts['asked-not-captured'], 2)
  assert.equal(f.checkpoint().phases['gates-and-judging'].units['coverage:evolving-scene-presentations'].state, 'complete')
})
test('judge-failure resume reuses independently proven completed jobs and reruns only unfinished ones', async t => {
  const f = await phaseFixture(t)
  await f.phases['disclosure-audit'](); f.setFailure(true)
  await assert.rejects(f.phases['gates-and-judging'](), /rejected stub/)
  const coverageCalls = f.calls.filter(x => x.job.startsWith('coverage:')).length
  const auditCalls = f.calls.filter(x => x.job === 'disclosure-audit').length
  f.setFailure(false)
  await f.phases['disclosure-audit'](); await f.phases['gates-and-judging']()
  assert.equal(f.calls.filter(x => x.job.startsWith('coverage:')).length, coverageCalls)
  assert.equal(f.calls.filter(x => x.job === 'disclosure-audit').length, auditCalls)
  assert.equal(f.calls.filter(x => x.job === 'artifact-quality').length, 12)
})
test('discovery retries asked without exchange and computes all five non-scoring outcomes', async () => {
  const discoveryJob = { name: 'discovery', kind: 'discovery', criteria: [item.id], inputs: { items: [item], conversation: [exchange] } }
  let calls = 0
  const output = await runDiscovery({ job: discoveryJob, invoke: async req => {
    assertStrictSchema(req.schema); calls++
    return JSON.stringify({ results: [{ id: item.id, asked: true, rationale: 'Asked', citations: calls === 1 ? [] : [exchangeCitation] }] })
  } })
  assert.equal(calls, 2); assert.equal(output.results[0].asked, true)
  const ledger = discoveryLedger({ coverage: ['met','partial','missing','missing','leaked'].map((verdict,n) => ({ id: String(n), verdict })), asked: [true,false,false,true,false].map((asked,n) => ({ id: String(n), asked, citations: [] })) })
  assert.deepEqual(ledger.counts, { discovered: 1, inferred: 1, missed: 1, 'asked-not-captured': 1, leaked: 1 })
})
test('gate execution failures are harness failures; invalid definitions remain diagnostic product gates', async t => {
  const f = await phaseFixture(t)
  await assert.rejects(runGates({ runDir: f.runDir, artifacts: inputs.artifacts, command: () => ({ error: 'CLI missing', status: null }) }), /could not run/)
  const gates = await runGates({ runDir: f.runDir, artifacts: inputs.artifacts, command: () => ({ status: 0 }) })
  assert.equal(gates.find(x => x.id === 'gate:required-artifact:design').passed, false)
  assert.equal(gates.at(-1).passed, true)
})
