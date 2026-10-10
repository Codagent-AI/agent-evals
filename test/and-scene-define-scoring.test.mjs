import { makeTempDir } from './temp-dir.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRubric, checkRubric, verifyJudgingInputs, rubricSettings, RUBRIC_SETTINGS_DEFAULTS } from '../evals/agent-runner/and-scene-define/lib/rubric.mjs'
import { checkVersions } from '../evals/agent-runner/and-scene-define/lib/versions.mjs'
import { checkInventory } from '../evals/agent-runner/and-scene-define/lib/inventory.mjs'
import { scoreDefinition, discoveryLedger } from '../evals/agent-runner/and-scene-define/lib/scoring.mjs'
import { runDefinitionPanel, judgeSchema, discoverySchema, exchangeIdentity, makeJobs, jobPrompt } from '../evals/agent-runner/and-scene-define/lib/judge-jobs.mjs'
import { assertStrictSchema } from './and-scene-define-helpers.mjs'
import { verifyCachedPanelJob } from '../evals/lib/panel-judging/panel.mjs'
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
test('anchors and generated rubric are pinned; preflight refuses review gaps and needs no pass threshold', async () => {
  assert.deepEqual(inventory.anchors_review, { reviewer: 'Paul Caplan', date: '2026-10-09', inventory_version: 6 })
  assert.equal(inventory.inventory_version, 6)
  // Inventory 6: a command that is only said to fail does not commit to a non-zero exit.
  const outcome = inventory.items.find(x => x.id === 'INV-093').anchors
  assert.match(outcome.met, /The exit status must be stated[^\n]*only said to fail, or a contrast with another command that exits with status 0, does not commit to it\./)
  assert.match(outcome.partial, /checks that are said to fail and name what failed but no stated exit status/)
  assert.deepEqual(await checkInventory(), [])
  const broken = structuredClone(inventory); delete broken.items.find(x => x.class === 'mandatory').anchors
  assert.ok((await checkInventory({ inventory: broken })).some(x => /anchors/.test(x)))
  const pref = structuredClone(inventory); pref.items.find(x => x.class === 'preference').anchors = item.anchors
  assert.ok((await checkInventory({ inventory: pref })).some(x => /preference.*anchors/.test(x)))
  const rubric = JSON.parse(await readFile(join(root, 'rubric.json'), 'utf8'))
  assert.deepEqual(checkRubric(rubric, inventory), [])
  const stale = structuredClone(rubric); stale.coverage[0].anchors.met = 'changed'
  assert.ok(checkRubric(stale, inventory).length)
  assert.throws(() => verifyJudgingInputs({ inventory: { ...inventory, anchors_review: null }, rubric }), /anchors need review/)
  assert.throws(() => verifyJudgingInputs({ inventory: { ...inventory, anchors_review: { ...inventory.anchors_review, inventory_version: 4 } }, rubric }), /anchors need review/)
  assert.doesNotThrow(() => verifyJudgingInputs({ inventory, rubric }))
  assert.throws(() => verifyJudgingInputs({ inventory, rubric: { ...rubric, pass_threshold: 70 } }), /must not set a pass threshold/)
  assert.throws(() => verifyJudgingInputs({ inventory, rubric: { ...rubric, inventory_version: 1 } }), /inventory version/)
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
  for (const call of calls) { assertStrictSchema(call.schema); assert.match(call.prompt, /Judge only/); assert.ok(call.prompt.includes(JSON.stringify(item.anchors.met).slice(1, -1))); assert.ok(call.prompt.includes(JSON.stringify(item.sources[0].quote).slice(1, -1))) }
  if (basis === 'decider') {
    const prompt = calls.at(-1).prompt.split('# Untrusted panel votes')[1]
    assert.match(prompt, /"label":"A"/); assert.ok(!prompt.includes('stub'))
  }
})
// INT-003: a batched decider ruling that overrules a verdict two effective
// votes gave stands only when the overrule check confirms its stated reason.
// The INV-093 shape: Claude `met`, both Codex seats `partial`.
for (const [name, votes, ruling, classification, expected, basis, outcome] of [
  ['a ruling agreeing with the two-vote verdict runs no check', ['met', 'partial', 'partial'], 'partial', 'contradicted', 'partial', 'decider-partial', null],
  ['an overrule the check confirms stands', ['met', 'partial', 'partial'], 'met', 'confirmed', 'met', 'decider-met', 'upheld'],
  ['an overrule the check does not confirm restores the two-vote verdict', ['met', 'partial', 'partial'], 'met', 'contradicted', 'partial', 'majority-partial', 'rejected'],
  ['an overrule check that cannot decide restores the two-vote verdict', ['met', 'partial', 'partial'], 'met', 'insufficient', 'partial', 'majority-partial', 'rejected'],
  ['a three-way split keeps its ruling without a check', ['met', 'partial', 'missing'], 'met', 'contradicted', 'met', 'decider-met', null],
  ['a three-way split keeps a middle ruling without a check', ['met', 'partial', 'missing'], 'missing', 'contradicted', 'missing', 'decider-missing', null],
]) test(`INT-003 overrule check: ${name}`, async () => {
  const calls = []
  const ruled = members(votes, ruling, classification, calls)
  // The decider states its reason, so the check can judge it.
  ruled.decider.invoke = async req => {
    calls.push(req)
    return JSON.stringify({ results: req.criteria.map(id => req.audit_stage
      ? { id, classification, rationale: 'Checked the decider\'s cited line.', evidence: ['proposal.md:1'] }
      : { ...result(id, ruling, ruling === 'missing' ? [{ ...citation, start_line: null, end_line: null }] : [citation]), rationale: 'Line 1 commits to the whole item.' }) })
  }
  const run = await runDefinitionPanel({ job, ...ruled })
  assert.equal(run.ok, true, JSON.stringify(run.failure))
  const [settled] = run.results
  assert.equal(settled.verdict, expected); assert.equal(settled.basis, basis)
  const checks = calls.filter(req => req.audit_stage === 'overrule-check')
  const overrules = run.record.checks.filter(c => c.stage === 'overrule-check')
  assert.equal(calls.length, 3 + 1 + (outcome ? 1 : 0))
  assert.equal(checks.length, outcome ? 1 : 0); assert.equal(overrules.length, outcome ? 1 : 0)
  if (outcome) {
    const [check] = checks
    // The decider's pinned model checks the ruling's stated reason and citations.
    assert.deepEqual(check.authority, { cli: 'claude', model: 'stub-decider', effort: 'high' })
    assert.deepEqual(check.criteria, [item.id]); assertStrictSchema(check.schema)
    const packet = JSON.parse(check.prompt.split('# BEGIN UNTRUSTED RULING\n')[1].split('\n# END UNTRUSTED RULING')[0])
    assert.equal(packet.verdict, 'met'); assert.equal(packet.overruled_verdict, 'partial')
    assert.equal(packet.rationale, 'Line 1 commits to the whole item.'); assert.deepEqual(packet.citations, [citation])
    assert.match(check.prompt, /Check only the decider's stated reason/)
    assert.ok(check.prompt.includes(JSON.stringify(item.anchors.met).slice(1, -1)), 'the check sees the job inputs')
    assert.deepEqual(overrules.map(c => [c.id, c.classification]), [[item.id, classification]])
    assert.deepEqual(settled.overrule_check, { classification, outcome })
    assert.ok(settled.checks.some(c => c.stage === 'overrule-check'))
    if (outcome === 'rejected') assert.ok(settled.votes.some(v => v.verdict === 'partial' && settled.rationale === v.rationale))
  } else assert.equal(settled.overrule_check, undefined)
  assert.equal(run.record.rulings[0].verdict, ruling, 'the record keeps the ruling itself')
  // A cached record reproduces from its recorded checks.
  assert.deepEqual(verifyCachedPanelJob(run.record).results, run.results)
})
test('INT-003 an overrule record reproduces only from its recorded check', async () => {
  const run = await runDefinitionPanel({ job, ...members(['met', 'partial', 'partial'], 'met', 'contradicted') })
  assert.equal(run.results[0].basis, 'majority-partial')
  const flipped = structuredClone(run.record)
  flipped.checks.find(c => c.stage === 'overrule-check').classification = 'confirmed'
  assert.throws(() => verifyCachedPanelJob(flipped), /do not reproduce/)
  const unchecked = structuredClone(run.record)
  unchecked.checks = unchecked.checks.filter(c => c.stage !== 'overrule-check')
  assert.throws(() => verifyCachedPanelJob(unchecked), /no overrule check/)
  // A check recorded for a ruling that overrules nothing is not a reproducible record.
  const agreeing = await runDefinitionPanel({ job, ...members(['met', 'partial', 'partial'], 'partial', 'confirmed') })
  const stray = structuredClone(agreeing.record)
  stray.checks.push({ id: item.id, classification: 'confirmed', rationale: 'r', evidence: ['e'], citations: [], marker: '', stage: 'overrule-check' })
  assert.throws(() => verifyCachedPanelJob(stray), /overrule check/)
})
test('INT-003 an overrule check needing missing material fails the job as a harness failure', async () => {
  const marker = '[omitted: design.md could not be read]'
  const withMarker = { ...job, inputs: { ...inputs, artifacts: { 'proposal.md': `A single evolving scene.\n${marker}\n` } } }
  const judges = members(['met', 'partial', 'partial'], 'met')
  judges.decider.invoke = async req => JSON.stringify({ results: req.criteria.map(id => req.audit_stage
    ? { id, classification: 'missing-material', rationale: 'The ruling depends on the omitted design.', evidence: ['marker'], citations: [], marker }
    : result(id, 'met')) })
  const run = await runDefinitionPanel({ job: withMarker, ...judges })
  assert.equal(run.ok, false)
  assert.equal(run.failure.code, 'missing-material'); assert.equal(run.failure.resumable, false); assert.deepEqual(run.failure.criteria, [item.id])
  assert.equal(run.results, null)
})
test('INT-003 an overrule check whose packet cannot fit fails the job without a check call', async () => {
  const calls = []
  const judges = members(['met', 'partial', 'partial'], 'met', 'confirmed', calls)
  judges.decider.invoke = async req => {
    calls.push(req)
    return JSON.stringify({ results: req.criteria.map(id => ({ ...result(id, 'met'), rationale: 'x'.repeat(300_001) })) })
  }
  const run = await runDefinitionPanel({ job, ...judges })
  assert.equal(run.ok, false)
  assert.equal(run.failure.code, 'packet-overflow'); assert.equal(run.failure.resumable, false); assert.deepEqual(run.failure.criteria, [item.id])
  assert.equal(calls.filter(req => req.audit_stage === 'overrule-check').length, 0)
})
test('invalid citations are dropped and recorded while the kept citations still support the verdict', async () => {
  const strays = [{ ...citation, path: 'hidden/reference/design.md' }, { ...citation, start_line: 40, end_line: 41 }, { path: 'proposal.md', start_line: 1 }]
  let attempts = 0
  const judges = members(['met', 'met', 'met'])
  for (const judge of judges.panel) judge.invoke = async req => { attempts++; return JSON.stringify({ results: req.criteria.map(id => result(id, 'met', [citation, ...strays])) }) }
  const kept = await runDefinitionPanel({ job, ...judges })
  assert.equal(kept.ok, true, JSON.stringify(kept.failure)); assert.equal(attempts, 3)
  assert.equal(kept.results[0].verdict, 'met'); assert.deepEqual(kept.results[0].citations, [citation])
  for (const vote of kept.record.votes) {
    assert.deepEqual(vote.citations, [citation])
    assert.deepEqual(vote.dropped_citations.map(x => x.citation), strays)
    assert.ok(vote.dropped_citations.every(x => typeof x.reason === 'string' && x.reason))
  }
  // A verdict whose remaining citations cannot support it still fails and retries.
  attempts = 0
  for (const judge of judges.panel) judge.invoke = async req => { attempts++; return JSON.stringify({ results: req.criteria.map(id => result(id, 'met', [{ ...citation, start_line: null, end_line: null }, ...strays])) }) }
  const unsupported = await runDefinitionPanel({ job, ...judges })
  assert.equal(unsupported.ok, false); assert.equal(attempts, 9)
  assert.match(JSON.stringify(unsupported.record.attempts), /met\/partial must cite an artifact line range/)
  // Clean votes carry no dropped list.
  const clean = await runDefinitionPanel({ job, ...members(['met', 'met', 'met']) })
  assert.ok(clean.record.votes.every(v => v.dropped_citations === undefined))
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
test('deterministic score excludes leaks, charges fidelity once, reports gates and discovery without changing scores', () => {
  const rubric = buildRubric(inventory)
  const coverage = rubric.coverage.map(x => result(x.id, 'met'))
  const leaked = [coverage[0].id]
  const quality = rubric.quality.map(x => result(x.id, 'met'))
  const fidelity = [result('fidelity:exchange', 'met')]
  const scored = scoreDefinition({ rubric, coverage, quality, fidelity, leaked, gates: [{ passed: false }] })
  // The score is the result: no pass/fail verdict, and a failed gate is reported without changing points.
  assert.equal(scored.evaluation_status, 'complete'); assert.equal(scored.definition_verdict, undefined)
  assert.deepEqual(scored.gates, [{ passed: false }])
  assert.equal(scored.components.coverage.score, 70); assert.equal(scored.components.coverage.possible, 94)
  assert.equal(scored.components.fidelity.score, 12); assert.equal(scored.total, 97)
  // Identical verdicts with opposite discovery decisions: the ledgers differ,
  // but neither ledger alters the score or the scored coverage it reads.
  const snapshot = structuredClone(scored)
  const asked = coverage.map(x => ({ id: x.id, asked: true, citations: [] }))
  const ledger = discoveryLedger({ coverage: scored.coverage, asked })
  const other = discoveryLedger({ coverage: scored.coverage, asked: asked.map(x => ({ ...x, asked: false })) })
  assert.equal(ledger.items[0].outcome, 'leaked'); assert.equal(ledger.counts.discovered, 71); assert.equal(other.counts.inferred, 71)
  assert.notDeepEqual(ledger.counts, other.counts); assert.equal(ledger.scoring, false); assert.equal(other.scoring, false)
  assert.deepEqual(scored, snapshot)
  const rescored = scoreDefinition({ rubric, coverage, quality, fidelity, leaked, gates: [{ passed: false }] })
  assert.deepEqual(rescored, scored)
  assert.equal(rescored.total, snapshot.total); assert.deepEqual(rescored.components, snapshot.components)
  assert.equal(scoreDefinition({ rubric, coverage, quality, fidelity, leaked, gates: [{ passed: true }] }).total, scored.total)
})
test('a run where every graded item leaked has no coverage score and no total, with the reason', () => {
  const rubric = buildRubric(inventory)
  const coverage = rubric.coverage.map(x => result(x.id, 'met'))
  const quality = rubric.quality.map(x => result(x.id, 'met'))
  const leaked = coverage.map(x => x.id)
  const scored = scoreDefinition({ rubric, coverage, quality, fidelity: [], leaked, gates: [{ passed: true }] })
  assert.equal(scored.evaluation_status, 'complete')
  assert.equal(scored.definition_verdict, undefined)
  assert.match(scored.score_unavailable, /every graded item leaked/)
  assert.equal(scored.components.coverage.score, null); assert.equal(scored.components.coverage.possible, 0)
  assert.equal(scored.total, null)
  assert.equal(scored.components.artifact_quality.score, 15)
  assert.equal(scoreDefinition({ rubric, coverage, quality, fidelity: [], leaked, gates: [{ passed: false }] }).total, null)
})
test('quality inputs contain no hidden material; fidelity excludes graded subjects without failing and requires matching exchange', async () => {
  const exchange = { step: 'define.specs', step_id: 'specs', attempt: 1, turn: 1, agent_message: 'Style?', reply: 'Blue', reply_type: 'answer' }
  const jobs = makeJobs({ inventory, rubric: buildRubric(inventory), artifacts: inputs.artifacts, conversation: [exchange], gates: [] })
  const quality = jobs.find(x => x.kind === 'quality')
  assert.ok(!JSON.stringify(quality.inputs).includes('INV-'))
  const fidelity = jobs.find(x => x.kind === 'fidelity')
  const judges = members(['met','met','met'])
  const deduction = subject_id => async req => JSON.stringify({ results: req.criteria.map(id => ({ ...result(id, 'met', [citation, { ...citation, path: null, start_line: null, end_line: null, exchange: exchangeIdentity(exchange) }]), subject_id })) })
  // A graded subject is coverage-owned: a valid output, normalized to no deduction.
  for (const judge of judges.panel) judge.invoke = deduction(item.id)
  const graded = await runDefinitionPanel({ job: fidelity, ...judges })
  assert.equal(graded.ok, true, JSON.stringify(graded.failure))
  assert.equal(graded.results[0].verdict, 'missing')
  assert.ok(graded.record.votes.every(v => v.verdict === 'missing' && v.excluded_graded_contradiction?.subject_id === item.id && v.excluded_graded_contradiction.judged_verdict === 'met'))
  assert.equal(graded.record.attempts.filter(x => !x.ok).length, 0)
  // An id outside the inventory remains invalid and is never scored.
  for (const judge of judges.panel) judge.invoke = deduction('INV-999')
  assert.equal((await runDefinitionPanel({ job: fidelity, ...judges })).ok, false)
  const preference = inventory.items.find(x => x.class === 'preference')
  for (const judge of judges.panel) judge.invoke = deduction(preference.id)
  const deducted = await runDefinitionPanel({ job: fidelity, ...judges })
  assert.equal(deducted.results[0].verdict, 'met')
  assert.ok(deducted.record.votes.every(v => v.excluded_graded_contradiction === undefined))
  for (const judge of judges.panel) judge.invoke = async req => JSON.stringify({ results: req.criteria.map(id => result(id, 'met', [citation, { ...citation, path: null, start_line: null, end_line: null, exchange: 'wrong' }])) })
  assert.equal((await runDefinitionPanel({ job: fidelity, ...judges })).ok, false)
  assertStrictSchema(judgeSchema([item.id]))
})

import { runGates } from '../evals/agent-runner/and-scene-define/lib/gates.mjs'
import { createJudgingPhases, DEFINITION_JUDGE_CONCURRENCY } from '../evals/agent-runner/and-scene-define/lib/judging.mjs'
import { createCheckpoint } from '../evals/agent-runner/and-scene-define/lib/checkpoint.mjs'
import { runDiscovery } from '../evals/agent-runner/and-scene-define/lib/judge-jobs.mjs'
const exchange = { step: 'define.specs', step_id: 'specs', attempt: 1, turn: 1, agent_message: 'Requirements?', reply: 'Here is an answer.', reply_type: 'answer' }
const exchangeCitation = { path: null, start_line: null, end_line: null, gate: null, exchange: exchangeIdentity(exchange) }
async function phaseFixture(t) {
  const runDir = await makeTempDir(join(tmpdir(), 'define-score-')); t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, 'collected'))
  await writeFile(join(runDir, 'collected/proposal.md'), inputs.artifacts['proposal.md'])
  const subset = { ...inventory, items: inventory.items.filter(x => x.class !== 'preference').slice(0, 5) }
  const rubric = buildRubric(subset)
  let checkpoint = createCheckpoint({ run_id: 'test', identity: { series_identity: { fixture: 'test' } } })
  const calls = []; let failure = false
  let override = null
  const invoke = index => async req => {
    if (override) return override(req, base(index))
    return base(index)(req)
  }
  const base = index => async req => {
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
  let ruling = null
  const judges = { panel: [0,1,2].map(n => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high', invoke: invoke(n) })), decider: { family: 'claude', model: 'stub', effort: 'high', invoke: async req => {
    if (req.audit_stage) return invoke(3)(req)
    calls.push({ index: 3, job: req.job })
    const ruled = ruling?.(req)
    if (ruled) return ruled
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
  return { runDir, phases, calls, setFailure: value => { failure = value }, override: value => { override = value }, rule: value => { ruling = value }, checkpoint: () => checkpoint, subset, rubric }
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
  // The decider confirms the Codex-only leak, so no overrule check runs.
  assert.equal(audit.panel.results.find(x => x.id === `leak:${f.subset.items[1].id}`).basis, 'decider-met')
  assert.ok(!audit.panel.checks.some(x => x.stage === 'overrule-check'))
  assert.equal(scored.definition_verdict, undefined); assert.equal(scored.evaluation_status, 'complete')
  assert.equal(scored.components.fidelity.score, 15)
  assert.equal(scored.components.coverage.possible, 3)
  assert.equal(scored.coverage.filter(x => x.verdict === 'leaked').length, 3)
  const ledger = JSON.parse(await readFile(join(f.runDir, 'discovery/ledger.json'), 'utf8'))
  assert.equal(ledger.counts.leaked, 3); assert.equal(ledger.counts['asked-not-captured'], 2)
  assert.equal(f.checkpoint().phases['gates-and-judging'].units['coverage:evolving-scene-presentations'].state, 'complete')
})
// INT-003: both Codex judges name item 1 as leaked and the Claude judge does
// not. A decider ruling that it was not leaked overrules both, so it stands only
// when the overrule check confirms it; a leaked item leaves the coverage denominator.
for (const [classification, leaked] of [['confirmed', false], ['contradicted', true], ['insufficient', true]]) test(`INT-003 disclosure audit: a not-leaked overrule with a ${classification} check ${leaked ? 'leaves the item leaked' : 'is upheld'}`, async t => {
  const f = await phaseFixture(t)
  const target = f.subset.items[1].id
  const checked = []
  f.rule(req => req.job === 'disclosure-audit' ? JSON.stringify({ results: req.criteria.map(id => ({ ...result(id, 'missing', []), rationale: 'The reply answered only what the agent asked.' })) }) : null)
  f.override((req, fallback) => {
    if (req.audit_stage !== 'overrule-check') return fallback(req)
    checked.push(req)
    return JSON.stringify({ results: req.criteria.map(id => ({ id, classification, rationale: 'Checked the exchange.', evidence: ['exchange'] })) })
  })
  await f.phases['disclosure-audit'](); await f.phases['gates-and-judging']()
  const audit = JSON.parse(await readFile(join(f.runDir, 'audits/disclosure.json'), 'utf8'))
  const scored = JSON.parse(await readFile(join(f.runDir, 'judges/score.json'), 'utf8'))
  assert.deepEqual(checked.map(req => [req.job, req.criteria]), [['disclosure-audit', [`leak:${target}`]]])
  const settled = audit.panel.results.find(x => x.id === `leak:${target}`)
  assert.equal(settled.verdict, leaked ? 'met' : 'missing'); assert.equal(settled.basis, leaked ? 'majority-met' : 'decider-missing')
  assert.deepEqual(settled.overrule_check, { classification, outcome: leaked ? 'rejected' : 'upheld' })
  assert.equal(audit.leaked_items.includes(target), leaked)
  // Items 0 (cross-family majority) and 2 (confirmed single dissent) are leaked either way.
  const expectedLeaks = f.subset.items.filter((x, n) => n === 0 || n === 2 || (n === 1 && leaked)).map(x => x.id)
  assert.deepEqual(audit.leaked_items, expectedLeaks)
  const weight = id => f.rubric.coverage.find(x => x.id === id).weight
  assert.equal(scored.components.coverage.possible, f.rubric.coverage.filter(x => !expectedLeaks.includes(x.id)).reduce((sum, x) => sum + weight(x.id), 0))
  assert.equal(scored.coverage.find(x => x.id === target).verdict, leaked ? 'leaked' : 'missing')
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

test('a failed gate is reported beside the full score and never replaces it with a verdict', () => {
  const rubric = buildRubric(inventory)
  const data = { rubric, coverage: rubric.coverage.map(x => result(x.id, 'met')), quality: rubric.quality.map(x => result(x.id, 'met')), fidelity: [] }
  for (const id of ['gate:required-artifact:design', 'gate:openspec-validate']) {
    const scored = scoreDefinition({ ...data, gates: [{ id, passed: false }] })
    assert.equal(scored.evaluation_status, 'complete')
    assert.equal(scored.definition_verdict, undefined); assert.equal(scored.verdict_unavailable, undefined)
    assert.deepEqual(scored.gates, [{ id, passed: false }])
    assert.equal(scored.total, 100); assert.equal(scored.components.coverage.score, 70)
  }
  // A rubric has no pass threshold to set.
  assert.equal('pass_threshold' in rubric, false)
})
test('rubric pins concrete quality, fidelity and reference-shape examples', () => {
  const rubric = buildRubric(inventory)
  for (const criterion of rubric.quality) {
    assert.ok(criterion.examples.pass.trim())
    assert.ok(criterion.examples.fail.trim())
  }
  assert.ok(rubric.fidelity.examples.deduction.length >= 2)
  assert.ok(rubric.fidelity.examples.no_deduction.length >= 2)
  assert.ok(rubric.guidance[0].includes('Example:'))
  assert.ok(rubric.guidance[1].includes('Example:'))
})
test('committed rubric records the approved settings and calibration limits', async () => {
  const rubric = JSON.parse(await readFile(join(root, 'rubric.json'), 'utf8'))
  assert.deepEqual(rubric.components, { coverage: 70, artifact_quality: 15, fidelity: 15 })
  assert.deepEqual(rubric.weights, { mandatory: 2, 'acceptable-alternative': 1 })
  assert.ok(rubric.quality.every(x => x.points === 3))
  assert.equal(rubric.fidelity.deduction_per_exchange, 3)
  assert.equal('pass_threshold' in rubric, false)
  assert.equal(rubric.calibration.restructured_tolerance_items, 3)
  assert.equal(rubric.calibration.max_spread, 5)
  // Approved by the maintainer (HT-002) after the E2E-003 calibration; otherwise the defaults.
  assert.equal(rubric.provisional, false); assert.equal(rubric.calibration.provisional, false)
  assert.match(rubric.calibration.note, /HT-002/); assert.match(rubric.calibration.note, /score only/)
  assert.equal(rubric.calibration_evidence.calibration_run, '2026-10-07-e2e-003-r7')
  assert.deepEqual(rubricSettings(rubric), { ...RUBRIC_SETTINGS_DEFAULTS, rubric_version: rubric.rubric_version, provisional: false, quality_points: rubricSettings(rubric).quality_points,
    calibration: rubric.calibration, calibration_evidence: rubric.calibration_evidence })
  assert.deepEqual(checkRubric(rubric, inventory), [])
  assert.deepEqual(await checkVersions(), [])
})
test('recorded settings round-trip while coverage criteria stay generated from the inventory', () => {
  const quality_points = Object.fromEntries(buildRubric(inventory).quality.map((x, n) => [x.id, [10, 8, 6, 3, 3][n]]))
  const settings = { rubric_version: 4, provisional: true, components: { coverage: 50, artifact_quality: 30, fidelity: 20 }, weights: { mandatory: 3, 'acceptable-alternative': 1.5 }, quality_points,
    fidelity: { deduction_per_exchange: 4, floor: 2 }, calibration: { restructured_tolerance_items: 4, max_spread: 6, provisional: false, note: 'Calibrated by E2E-003.', expected_fail: ['variant-a'], approval: 'awaiting HT-002' },
    calibration_evidence: { report: 'calibration/run/report.html', input_hashes: { reference: 'abc' } } }
  const rubric = buildRubric(inventory, settings)
  assert.deepEqual(checkRubric(rubric, inventory), [])
  assert.deepEqual(rubricSettings(rubric), settings)
  assert.equal(rubric.coverage.find(x => x.class === 'mandatory').weight, 3)
  assert.equal(rubric.coverage.find(x => x.class === 'acceptable-alternative').weight, 1.5)
  assert.deepEqual(rubric.quality.map(x => x.points), [10, 8, 6, 3, 3])
  assert.equal(rubric.fidelity.deduction_per_exchange, 4); assert.equal(rubric.fidelity.floor, 2)
  assert.equal(rubric.calibration.approval, 'awaiting HT-002')
  // Scoring follows the recorded settings.
  const scored = scoreDefinition({ rubric, coverage: rubric.coverage.map(x => result(x.id, 'met')), quality: rubric.quality.map(x => result(x.id, 'met')), fidelity: [result('fidelity:a', 'met')], gates: [] })
  assert.equal(scored.components.coverage.score, 50); assert.equal(scored.components.artifact_quality.score, 30); assert.equal(scored.components.fidelity.score, 16)
  // Divergence from the inventory or inconsistent settings is still refused.
  const stale = structuredClone(rubric); stale.coverage[0].anchors.met = 'changed'
  assert.ok(checkRubric(stale, inventory).length)
  const reweighted = structuredClone(rubric); reweighted.coverage[0].weight = 9
  assert.ok(checkRubric(reweighted, inventory).length)
  const dropped = structuredClone(rubric); dropped.coverage.pop()
  assert.ok(checkRubric(dropped, inventory).length)
  for (const [change, pattern] of [
    [r => { r.components.coverage = 55 }, /sum to 100/],
    [r => { r.quality[0].points = 1 }, /quality points/],
    [r => { r.weights.mandatory = 0 }, /weight/],
    [r => { r.fidelity.deduction_per_exchange = -1 }, /deduction/],
    [r => { r.calibration.max_spread = -1 }, /max_spread/],
    [r => { r.calibration.restructured_tolerance_items = 'many' }, /restructured_tolerance_items/],
    [r => { r.pass_threshold = 70 }, /pass threshold/],
  ]) {
    const bad = structuredClone(rubric); change(bad)
    assert.ok(checkRubric(bad, inventory).some(x => pattern.test(x)), String(pattern))
  }
})

test('a definition contradicting a stated mandatory item is scored only under coverage and the run completes', async t => {
  const f = await phaseFixture(t)
  const mandatory = f.subset.items.find(x => x.class === 'mandatory')
  const contradiction = [citation, exchangeCitation]
  const fidelityVote = id => ({ ...result(id, 'met', contradiction), rationale: 'The proposal contradicts the answer the user gave about this requirement.', subject_id: mandatory.id })
  f.override((req, fallback) => {
    if (req.audit_stage) return fallback(req)
    if (req.job === 'fidelity') return JSON.stringify({ results: req.criteria.map(fidelityVote) })
    if (req.job === 'disclosure-audit') return JSON.stringify({ results: req.criteria.map(id => result(id, 'missing', [])) })
    if (req.job.startsWith('coverage:')) return JSON.stringify({ results: req.criteria.map(id => result(id, 'missing', [{ ...citation, start_line: null, end_line: null }])) })
    return fallback(req)
  })
  await f.phases['disclosure-audit'](); await f.phases['gates-and-judging'](); await f.phases.discovery()
  const scored = JSON.parse(await readFile(join(f.runDir, 'judges/score.json'), 'utf8'))
  assert.equal(scored.evaluation_status, 'complete')
  assert.equal(scored.coverage.find(x => x.id === mandatory.id).verdict, 'missing')
  assert.equal(scored.components.fidelity.score, 15)
  assert.ok(scored.fidelity.every(x => x.verdict === 'missing'))
  assert.ok(scored.excluded_graded_contradictions.length >= 1)
  assert.ok(scored.excluded_graded_contradictions.every(x => x.subject_id === mandatory.id && x.criterion === `fidelity:${exchangeIdentity(exchange)}` && x.judged_verdict === 'met'))
  assert.equal(f.checkpoint().phases['gates-and-judging'].units.fidelity.state, 'complete')
  assert.ok(JSON.parse(await readFile(join(f.runDir, 'discovery/ledger.json'), 'utf8')).counts)
})
test('a coverage job with one disputed item sends the decider only that item, in a schema scoped to it', async () => {
  const [first, second] = inventory.items.filter(x => x.class === 'mandatory')
  const pair = { name: 'coverage:pair', kind: 'coverage', criteria: [first.id, second.id], inputs: { ...inputs, items: [first, second] } }
  const seen = []
  const panel = ['partial', 'met', 'met'].map((verdict, n) => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high',
    invoke: async req => JSON.stringify({ results: req.criteria.map(id => result(id, id === first.id ? verdict : 'met')) }) }))
  // Like a real model, the decider answers every criterion its schema allows.
  const decider = { family: 'claude', model: 'stub-decider', effort: 'high', invoke: async req => {
    seen.push(req)
    return JSON.stringify({ results: req.schema.properties.results.items.properties.id.enum.map(id => result(id, 'met')) })
  } }
  const outcome = await runDefinitionPanel({ job: pair, panel, decider })
  assert.equal(outcome.ok, true, outcome.record.error)
  assert.deepEqual(seen.map(req => req.schema.properties.results.items.properties.id.enum), [[first.id]])
  assert.deepEqual(outcome.results.map(r => [r.id, r.basis]), [[first.id, 'decider-met'], [second.id, 'consensus-met']])
})
test('every judging job with a conversation has a strict schema Codex accepts', () => {
  const jobs = makeJobs({ inventory, rubric: buildRubric(inventory), artifacts: inputs.artifacts, conversation: [exchange], gates: [] })
  assert.ok(jobs.some(job => job.kind === 'fidelity') && jobs.some(job => job.kind === 'disclosure'))
  for (const job of jobs) assertStrictSchema(job.kind === 'discovery' ? discoverySchema(job.criteria) : judgeSchema(job.criteria))
  assert.equal(exchangeIdentity(exchange), 'define.specs/specs/1/1')
})
test('every verdict, including a fidelity finding of no contradiction, must carry evidence', () => {
  const jobs = makeJobs({ inventory, rubric: buildRubric(inventory), artifacts: inputs.artifacts, conversation: [exchange], gates: [] })
  const fidelity = jobs.find(job => job.kind === 'fidelity')
  assert.deepEqual(judgeSchema(fidelity.criteria).properties.results.items.properties.evidence, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } })
  assert.match(jobPrompt(fidelity), /including missing fidelity findings, gives at least one evidence sentence/)
})
test('a fidelity deduction citing its line span and exchange in one citation is split into both and scored', async () => {
  const jobs = makeJobs({ inventory, rubric: buildRubric(inventory), artifacts: inputs.artifacts, conversation: [exchange], gates: [] })
  const fidelity = jobs.find(x => x.kind === 'fidelity')
  assert.match(jobPrompt(fidelity), /Fidelity deductions cite the line span and the exchange as two separate citations/)
  const preference = inventory.items.find(x => x.class === 'preference')
  const judges = members(['met', 'met', 'met'])
  // Judges often put the span and its exchange in one object; it names two targets.
  for (const judge of judges.panel) judge.invoke = async req => JSON.stringify({ results: req.criteria.map(id => ({ ...result(id, 'met', [{ ...citation, exchange: exchangeIdentity(exchange) }]), subject_id: preference.id })) })
  const outcome = await runDefinitionPanel({ job: fidelity, ...judges })
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failure))
  assert.equal(outcome.results[0].verdict, 'met')
  assert.ok(outcome.record.votes.every(v => JSON.stringify(v.citations) === JSON.stringify([citation, exchangeCitation]) && v.dropped_citations === undefined))
  // Each half is still validated on its own: a wrong exchange is dropped, leaving no matching exchange.
  for (const judge of judges.panel) judge.invoke = async req => JSON.stringify({ results: req.criteria.map(id => ({ ...result(id, 'met', [{ ...citation, exchange: 'wrong' }]), subject_id: preference.id })) })
  assert.equal((await runDefinitionPanel({ job: fidelity, ...judges })).ok, false)
})
test('a citation path carrying the reference change directory resolves to the collected file it names', async () => {
  assert.match(jobPrompt(job), /A citation path is exactly a key of artifacts/)
  const judges = members(['met', 'met', 'met'])
  // Item source quotes name reference documents under openspec/changes/<change>/; judges sometimes copy that prefix.
  const prefixed = { ...citation, path: `openspec/changes/create-and-scene/${citation.path}` }
  for (const judge of judges.panel) judge.invoke = async req => JSON.stringify({ results: req.criteria.map(id => result(id, 'met', [prefixed])) })
  const outcome = await runDefinitionPanel({ job, ...judges })
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failure))
  assert.ok(outcome.record.votes.every(v => JSON.stringify(v.citations) === JSON.stringify([citation])))
  // Only that prefix is removed, and only when what remains is a collected file.
  for (const path of ['openspec/changes/create-and-scene/missing.md', `other/${citation.path}`, `openspec/${citation.path}`]) {
    for (const judge of judges.panel) judge.invoke = async req => JSON.stringify({ results: req.criteria.map(id => result(id, 'met', [{ ...citation, path }])) })
    assert.equal((await runDefinitionPanel({ job, ...judges })).ok, false, path)
  }
})

// INT-007: define judging runs its coverage, quality and fidelity units through
// the shared pool, three at a time, after the disclosure audit.
async function poolFixture(t, { failQuality = false } = {}) {
  const runDir = await makeTempDir(join(tmpdir(), 'define-pool-')); t.after(() => rm(runDir, { recursive: true, force: true }))
  await mkdir(join(runDir, 'collected'))
  await writeFile(join(runDir, 'collected/proposal.md'), inputs.artifacts['proposal.md'])
  // One graded item per area: five coverage jobs, then quality and fidelity.
  const graded = inventory.items.filter(x => x.class !== 'preference')
  const spread = { ...inventory, items: [...new Set(graded.map(x => x.area))].map(area => graded.find(x => x.area === area)) }
  const rubric = buildRubric(spread)
  let checkpoint = createCheckpoint({ run_id: 'pool', identity: { series_identity: { fixture: 'pool' } } })
  const log = []; const active = new Map(); let peak = 0
  let persisting = 0; let persistOverlap = 0; let persists = 0; let failPersistAt = null
  const wait = ms => new Promise(done => setTimeout(done, ms))
  const answer = async req => {
    log.push({ job: req.job, stage: req.audit_stage ?? 'vote' })
    active.set(req.job, (active.get(req.job) ?? 0) + 1)
    peak = Math.max(peak, [...active.entries()].filter(([job, n]) => n > 0 && job !== 'disclosure-audit').length)
    try {
      // The first coverage job frees its slot early, so job 3 starts while 1 and
      // 2 run; quality then starts beside the long jobs 3 and 4, so completion
      // order differs from job order and a quality failure lands while every
      // other slot is busy.
      await wait(req.job.startsWith('coverage:') ? [5, 50, 50, 200, 200][spread.items.findIndex(x => req.job === `coverage:${x.area}`)] : 3)
      if (failQuality && req.job === 'artifact-quality') throw Object.assign(new Error('quality judge down'), { retryable: false })
      if (req.audit_stage) return JSON.stringify({ results: req.criteria.map(id => ({ id, classification: 'confirmed', rationale: 'Checked.', evidence: ['e'] })) })
      return JSON.stringify({ results: req.criteria.map(id => result(id, 'missing', req.job === 'fidelity' || req.job === 'disclosure-audit' ? [exchangeCitation] : [{ ...citation, start_line: null, end_line: null }])) })
    } finally { active.set(req.job, active.get(req.job) - 1) }
  }
  const judges = { panel: [0, 1, 2].map(n => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high', invoke: answer })), decider: { family: 'claude', model: 'stub', effort: 'high', invoke: answer } }
  const phases = createJudgingPhases({ runDir, judges, getCheckpoint: () => checkpoint, setCheckpoint: x => { checkpoint = x },
    persist: async () => {
      persists++; persisting++; persistOverlap = Math.max(persistOverlap, persisting); await wait(1); persisting--
      if (failPersistAt !== null && persists >= failPersistAt) throw new Error('checkpoint disk full')
    },
    loadInputs: async () => ({ inventory: spread, rubric, artifacts: inputs.artifacts, conversation: [exchange], reference: [], policy: 'Answer only what was asked.' }),
    gateCommand: async () => ({ status: 0, stdout: '', stderr: '' }) })
  const expectedJobs = makeJobs({ inventory: spread, rubric, artifacts: inputs.artifacts, conversation: [exchange], gates: [] }).filter(x => ['coverage', 'quality', 'fidelity'].includes(x.kind)).map(x => x.name)
  return { runDir, phases, log, expectedJobs, stats: { get peak() { return peak }, get persistOverlap() { return persistOverlap }, get persists() { return persists }, get inFlight() { return [...active.values()].reduce((a, b) => a + b, 0) } }, checkpoint: () => checkpoint,
    failPersistAfter: n => { failPersistAt = persists + n } }
}
test('INT-007 define judging runs at most three jobs at once, checkpoints one at a time, and records results in job order', async t => {
  const f = await poolFixture(t)
  assert.equal(DEFINITION_JUDGE_CONCURRENCY, 3)
  assert.equal(f.expectedJobs.length, 7)
  await f.phases['disclosure-audit'](); await f.phases['gates-and-judging']()
  assert.equal(f.stats.peak, DEFINITION_JUDGE_CONCURRENCY)
  assert.equal(f.stats.persistOverlap, 1); assert.ok(f.stats.persists >= 2 * f.expectedJobs.length)
  const scored = JSON.parse(await readFile(join(f.runDir, 'judges/score.json'), 'utf8'))
  assert.deepEqual(scored.panel_records.map(x => x.record.job), f.expectedJobs)
  // Completion order differed from job order, so the order above is the pool's.
  const finished = Object.entries(f.checkpoint().phases['gates-and-judging'].units).filter(([unit]) => unit !== 'gates').sort((a, b) => a[1].completed_at.localeCompare(b[1].completed_at))
  assert.equal(finished.length, 7)
  assert.ok(finished.every(([, unit]) => unit.state === 'complete'))
  // The disclosure audit finished before any coverage job started.
  const lastAudit = f.log.findLastIndex(x => x.job === 'disclosure-audit')
  const firstCoverage = f.log.findIndex(x => x.job.startsWith('coverage:'))
  assert.ok(lastAudit >= 0 && lastAudit < firstCoverage)
})
test('INT-007 define judging starts no coverage job before the disclosure audit is recorded', async t => {
  const f = await poolFixture(t)
  await assert.rejects(f.phases['gates-and-judging'](), { code: 'ENOENT' })
  assert.equal(f.log.length, 0)
})
test('INT-007 a throwing define checkpoint stops new jobs and lets in-flight jobs settle before the phase fails', async t => {
  const f = await poolFixture(t)
  await f.phases['disclosure-audit']()
  // The gates unit persists first; a later checkpoint, during the jobs, fails.
  f.failPersistAfter(4)
  await assert.rejects(f.phases['gates-and-judging'](), /checkpoint disk full/)
  assert.equal(f.stats.inFlight, 0)
  const started = new Set(f.log.map(x => x.job).filter(job => job !== 'disclosure-audit'))
  assert.ok(started.size > 0 && started.size < f.expectedJobs.length, [...started].join(', '))
  assert.ok(!f.log.some(x => x.job === 'fidelity'), 'the last job never starts')
})
test('INT-007 a failed define job stops new jobs and lets in-flight jobs settle before the phase fails', async t => {
  const f = await poolFixture(t, { failQuality: true })
  await f.phases['disclosure-audit']()
  await assert.rejects(f.phases['gates-and-judging'](), /quality judge down/)
  assert.equal(f.stats.inFlight, 0)
  const units = f.checkpoint().phases['gates-and-judging'].units
  assert.equal(units['artifact-quality'].state, 'failed')
  // Fidelity is queued behind the failed quality job and never starts.
  assert.equal(units.fidelity, undefined)
  assert.ok(!f.log.some(x => x.job === 'fidelity'))
})
