// INT-005: the testing-evidence claim map through the evidence view, the panel
// seats, the line-cited decider, its row and completeness audits, and the
// contradiction check. Canned seat, decider, audit and check invokers drive
// runProductJudging over evidence views materialized from fixture records, so
// the tests prove what material each stage receives, not what a model would do
// with it (E2E-004 is the model-level check).
import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  JUDGE_PACKET_MAX_CHARS, TESTING_PRIMARY_ROLES, ASSUMPTION_PRIMARY_ROLES, buildEvidenceJudgePacket,
  materializeEvidenceJudgeViews,
} from '../evals/agent-runner/and-scene/lib/evidence.mjs'
import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { buildJudgeRequest, runProductJudging } from '../evals/agent-runner/and-scene/lib/judge-jobs.mjs'
import { criteriaForJob, loadRubrics, validateAutomatedRubric } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { verifyCachedPanelJob } from '../evals/lib/panel-judging/panel.mjs'
import { matchCutMarker, packetCuts, packetLayout, spanLabel } from '../evals/lib/panel-judging/evidence-packet.mjs'
import { LINE_CITED_CLAIM_MAP_RESULT_SCHEMA, parseLineCitedOutput, parseSourceAuditOutput, CHECK_OUTCOMES } from '../evals/lib/panel-judging/protocol.mjs'

const rubrics = await loadRubrics()
const automated = rubrics.automated.rubric
const authority = { cli: 'codex', model: 'gpt-test', effort: 'high' }
const PROOF = 'testing-evidence-usable-proof'
const HONEST = 'testing-evidence-complete-honest-record'
const COVERAGE = 'testing-evidence-traceable-coverage'
const MAPPED = [PROOF, HONEST]
const SPECS = join(import.meta.dirname, '../evals/agent-runner/and-scene/fixture-snapshot/openspec/changes/create-and-scene/specs')
const SPEC_NAMES = ['evolving-scene-presentations', 'presentation-skill', 'presentation-verification']

// The 68 basis scenarios, read from the pinned fixture specs as the harness does.
const BASIS = []
for (const name of SPEC_NAMES) {
  for (const line of (await readFile(join(SPECS, name, 'spec.md'), 'utf8')).split('\n')) {
    const match = line.match(/^#{3,5}\s+Scenario:\s*(.+?)\s*$/)
    if (match) BASIS.push(match[1])
  }
}
const DEEP_SCENARIO = BASIS[5]
const DEEP_CLAIM = `DEEP CLAIM: scenario "${DEEP_SCENARIO}" was exercised and passed.`
const FALSE_CLAIM = 'FALSE CLAIM: the offline export check passed on every browser.'
const OLD_EXCERPT = 50_000

const filler = (label, chars) => {
  const line = `${label} filler line recording an ordinary observation.`
  return Array.from({ length: Math.ceil(chars / (line.length + 1)) }, () => line).join('\n').slice(0, chars)
}

let sequence = 0
// Writes candidate artifacts as the manifest would, then materializes both
// judge views. `artifacts` is a list of { role, name, text }.
async function evidenceViews({ artifacts, requirements = true, findings = [], extraViewFiles = 0, requirementDocs = null }) {
  const runDir = await makeTempDir(join(tmpdir(), 'claim-map-'))
  const candidate = { artifacts: [], findings, ci_claims: [] }
  for (const { role, name, text } of artifacts) {
    const id = `candidate-${hashString(`${role}:${name}:${sequence += 1}`).slice(0, 16)}`
    const path = `evidence/candidate/artifacts/${id}-${name}`
    await mkdir(join(runDir, 'evidence/candidate/artifacts'), { recursive: true })
    await writeFile(join(runDir, path), text)
    candidate.artifacts.push({ id, role, path, sha256: hashString(Buffer.from(text)), media_type: 'text/markdown' })
  }
  let requirementsRoot = null
  if (requirements) {
    requirementsRoot = join(runDir, 'requirements')
    await mkdir(requirementsRoot, { recursive: true })
    for (const name of SPEC_NAMES) await writeFile(join(requirementsRoot, `${name}.md`), await readFile(join(SPECS, name, 'spec.md')))
    for (const [name, text] of Object.entries(requirementDocs ?? {})) await writeFile(join(requirementsRoot, name), text)
  }
  const views = await materializeEvidenceJudgeViews({ runDir, candidate, evaluator: null, contradictions: { items: [] },
    lineage: { final_sha: 'f'.repeat(40), accepted: true }, requirementsRoot })
  const absolute = Object.fromEntries(Object.entries(views).map(([job, view]) => [job,
    { ...view, root: join(runDir, view.root), index: join(runDir, view.index) }]))
  for (let index = 0; index < extraViewFiles; index += 1) {
    await mkdir(join(absolute['testing-evidence'].root, 'candidate'), { recursive: true })
    await writeFile(join(absolute['testing-evidence'].root, 'candidate', `extra-${String(index).padStart(4, '0')}.md`), 'x\n')
  }
  return { runDir, views: absolute, candidate, idOf: (name) => candidate.artifacts.find((artifact) => artifact.path.endsWith(`-${name}`)).id }
}

// Fixture 1: a deep claim past the old 50,000-character excerpt, a false claim
// outside the basis, and supporting material the budget cuts and drops.
const deepRecord = () => [
  { role: 'final-handoff', name: 'acceptance-handoff.md', text: `# Handoff\nAll scenarios passed.\n${FALSE_CLAIM}\n` },
  { role: 'exploration-log', name: 'exploration-log.md',
    text: `# Exploration log\n${filler('log', 60_000)}\n${DEEP_CLAIM}\nend of log\n` },
  { role: 'findings-history', name: 'findings-history.md', text: '# Findings\nF1 resolved.\n' },
  { role: 'acceptance-flow-record', name: 'acceptance-flow.md', text: '# Flow record\nStep 1: opened the deck; saw step 1.\n' },
  { role: 'session-audit', name: 'session-report.md', text: `# Session report\n${filler('session', 70_000)}\nSESSION TAIL\n` },
  ...[1, 2, 3, 4].map((n) => ({ role: 'referenced-material', name: `ref-${n}.md`, text: `# Ref ${n}\n${filler(`ref${n}`, 45_000)}\n` })),
]

const lineOf = (packet, needle) => packet.split('\n').findIndex((line) => line.includes(needle)) + 1

test('the testing packet holds the four claim-bearing records first and in full, and marks every cut and drop', async () => {
  const { views, idOf } = await evidenceViews({ artifacts: deepRecord() })
  const view = views['testing-evidence']
  const packet = view.packet
  assert.equal(await readFile(join(view.root, 'packet.txt'), 'utf8'), packet)
  assert.ok(packet.length <= JUDGE_PACKET_MAX_CHARS)
  assert.deepEqual(TESTING_PRIMARY_ROLES, ['acceptance-flow-record', 'exploration-log', 'final-handoff', 'findings-history'])
  // The deep claim lies past the old excerpt, and the whole log is present.
  const log = deepRecord().find(({ role }) => role === 'exploration-log').text
  assert.ok(log.indexOf(DEEP_CLAIM) > OLD_EXCERPT)
  assert.ok(packet.includes(log))
  // Primary records lead, in role order, before any supporting artifact.
  const order = ['acceptance-flow.md', 'exploration-log.md', 'acceptance-handoff.md', 'findings-history.md', 'session-report.md']
    .map((name) => packet.indexOf(`UNTRUSTED CANDIDATE ARTIFACT ${idOf(name)}`))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  // The session report is cut at the per-artifact cap and marked after the cut.
  const truncated = `[truncated: ${idOf('session-report.md')} kept 50000 of `
  assert.ok(packet.includes(truncated))
  assert.ok(!packet.includes('SESSION TAIL'))
  const cutLine = lineOf(packet.slice(packet.indexOf('# BEGIN VERIFIED INDEX')), truncated)
  assert.ok(cutLine > 0)
  // The budget runs out among the references: one is cut and one dropped.
  const omitted = `[omitted: ${idOf('ref-4.md')} (referenced-material), `
  assert.ok(packet.includes(`${omitted}`))
  const cuts = packetCuts(packet, { atStart: true })
  assert.deepEqual(cuts.map(({ id, kind }) => [kind, id]), [
    ['truncated', idOf('session-report.md')], ['truncated', idOf('ref-3.md')], ['omitted', idOf('ref-4.md')]])
  for (const { marker } of cuts) assert.equal(packet.split(marker).length, 4, `${marker} is in the index, layout and in place`)
  // The layout labels lines with the artifact they lie in and its marker.
  const layout = packetLayout(packet)
  const deep = lineOf(packet, DEEP_CLAIM)
  assert.equal(spanLabel(layout, deep, deep), `[artifact ${idOf('exploration-log.md')} (exploration-log)]`)
  const sessionLine = lineOf(packet, 'session filler')
  assert.match(spanLabel(layout, sessionLine, sessionLine), new RegExp(`cut \\[truncated: ${idOf('session-report.md')} kept 50000`))
})

test('a supporting artifact under the budget is kept whole and the cut index says none', async () => {
  const { views } = await evidenceViews({ artifacts: deepRecord().slice(0, 4) })
  assert.match(views['testing-evidence'].packet, /^# BEGIN PACKET CUT INDEX\n- none\n# END PACKET CUT INDEX\n/)
  assert.deepEqual(packetCuts(views['testing-evidence'].packet, { atStart: true }), [])
})

test('the packet builder never exceeds its budget and records every artifact it cannot fit', () => {
  const index = { a: 1 }
  const primary = [{ id: 'candidate-p', role: 'exploration-log', text: 'p'.repeat(900) }]
  const supporting = Array.from({ length: 6 }, (_, n) => ({ id: `candidate-s${n}`, role: 'session-audit', text: 's'.repeat(400) }))
  for (const maxChars of [3_000, 3_400, 4_000, 5_000, 8_000]) {
    const { packet, cuts, entries } = buildEvidenceJudgePacket({ index, primary, supporting, maxChars, artifactMaxChars: 300 })
    assert.ok(packet.length <= maxChars, `${packet.length} <= ${maxChars}`)
    assert.ok(packet.includes('p'.repeat(900)))
    assert.equal(entries.length, 7)
    assert.equal(cuts.length, 6, 'every supporting artifact is over the cap, so each is cut or dropped')
    assert.deepEqual(packetLayout(packet).artifacts.map(({ id }) => id), entries.map(({ id }) => id))
  }
  assert.throws(() => buildEvidenceJudgePacket({ index, primary, supporting, maxChars: 1_000 }),
    (error) => error.code === 'packet-overflow' && /primary claim-bearing records/.test(error.message))
  assert.throws(() => buildEvidenceJudgePacket({ index, primary, supporting, maxChars: 2_000 }),
    (error) => error.code === 'packet-overflow' && /omission markers/.test(error.message))
})

test('a cut marker matches in full or by its bare prefix, never by paraphrase or an unknown id', () => {
  const cuts = [{ marker: '[truncated: candidate-abc kept 5 of 9 characters]', kind: 'truncated', id: 'candidate-abc' },
    { marker: '[omitted: candidate-def (session-audit), 9 characters, packet budget]', kind: 'omitted', id: 'candidate-def' }]
  assert.equal(matchCutMarker('[truncated: candidate-abc kept 5 of 9 characters]', cuts), cuts[0].marker)
  assert.equal(matchCutMarker('depends on [truncated: candidate-abc', cuts), cuts[0].marker)
  assert.equal(matchCutMarker('[truncated: candidate-abc kept about half]', cuts), cuts[0].marker)
  assert.equal(matchCutMarker('[omitted: candidate-def]', cuts), cuts[1].marker)
  assert.equal(matchCutMarker('the session audit was truncated', cuts), null)
  assert.equal(matchCutMarker('[truncated: candidate-abcd kept 5 of 9 characters]', cuts), null)
  assert.equal(matchCutMarker('[omitted: candidate-abc', cuts), null)
})

test('claim-bearing records over the packet budget fail the testing-evidence job with packet-overflow naming its criteria', async () => {
  const { views } = await evidenceViews({ artifacts: [
    { role: 'acceptance-flow-record', name: 'acceptance-flow.md', text: filler('huge', JUDGE_PACKET_MAX_CHARS - 20_000) },
    { role: 'exploration-log', name: 'exploration-log.md', text: filler('log', 30_000) },
    { role: 'final-handoff', name: 'acceptance-handoff.md', text: '# Handoff\n' },
  ] })
  const view = views['testing-evidence']
  assert.equal(view.packet, undefined)
  assert.equal(view.failure.code, 'packet-overflow')
  await assert.rejects(stat(join(view.root, 'packet.txt')), { code: 'ENOENT' })
  // The other view is unaffected.
  assert.equal(typeof views['assumption-handling'].packet, 'string')
  const outcome = await judgeTestingOnly(views)
  assert.deepEqual(outcome.failed_jobs, ['testing-evidence'])
  const failure = outcome.failures['testing-evidence']
  assert.equal(failure.code, 'packet-overflow')
  assert.equal(failure.owner, 'evaluation-harness')
  assert.equal(failure.resumable, false)
  assert.deepEqual(failure.criteria, criteriaForJob(automated, 'testing-evidence'))
  for (const id of MAPPED) assert.ok(failure.criteria.includes(id))
  assert.equal(outcome.seen.filter((next) => next.job === 'testing-evidence').length, 0, 'no truncated view is judged')
})

test('a primary record skipped at collection fails its job with packet-overflow', async () => {
  const { views } = await evidenceViews({ artifacts: deepRecord().slice(0, 3), findings: [
    { code: 'artifact-bounds-exceeded', message: 'candidate evidence exceeds the byte budget: output/acceptance-flow.md',
      role: 'acceptance-flow-record', path: 'output/acceptance-flow.md' }] })
  assert.equal(views['testing-evidence'].failure.code, 'packet-overflow')
  assert.match(views['testing-evidence'].failure.message, /skipped primary records/)
  // The flow record is not an assumption-handling primary record.
  assert.equal(typeof views['assumption-handling'].packet, 'string')
  const skippedLedger = await evidenceViews({ artifacts: deepRecord().slice(0, 3), findings: [
    { code: 'artifact-bounds-exceeded', message: 'candidate evidence exceeds the byte budget: output/assumptions.md' }] })
  assert.equal(skippedLedger.views['assumption-handling'].failure.code, 'packet-overflow')
  // A skipped screenshot is not a primary record.
  const screenshot = await evidenceViews({ artifacts: deepRecord().slice(0, 3), findings: [
    { code: 'artifact-bounds-exceeded', message: 'x', role: 'screenshot', path: 'output/shot.png' }] })
  assert.equal(typeof screenshot.views['testing-evidence'].packet, 'string')
})

test('the assumption packet holds its four primary records in full, and a long requirement document fails its job', async () => {
  const ledger = `# Assumptions\n${filler('ledger', 60_000)}\nLAST LEDGER ENTRY: U9 needs a decision.\n`
  const { views, idOf } = await evidenceViews({ artifacts: [...deepRecord(),
    { role: 'assumptions-ledger', name: 'assumptions.md', text: ledger }] })
  const packet = views['assumption-handling'].packet
  assert.deepEqual(ASSUMPTION_PRIMARY_ROLES, ['assumptions-ledger', 'final-handoff', 'findings-history', 'exploration-log'])
  assert.ok(packet.includes(ledger))
  assert.ok(packet.includes(deepRecord().find(({ role }) => role === 'exploration-log').text))
  const order = ['assumptions.md', 'acceptance-handoff.md', 'findings-history.md', 'exploration-log.md', 'session-report.md']
    .map((name) => packet.indexOf(`UNTRUSTED CANDIDATE ARTIFACT ${idOf(name)}`))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.ok(packet.length <= JUDGE_PACKET_MAX_CHARS)

  const long = await evidenceViews({ artifacts: deepRecord().slice(0, 4),
    requirementDocs: { 'zz-long.md': `### Requirement: Long\n${filler('req', 40_001)}` } })
  assert.equal(long.views['assumption-handling'].failure.code, 'packet-overflow')
  assert.match(long.views['assumption-handling'].failure.message, /zz-long\.md has 40\d{3} characters/)
  assert.equal(typeof long.views['testing-evidence'].packet, 'string')
  const outcome = await judgeTestingOnly(long.views, { job: 'assumption-handling' })
  assert.equal(outcome.failures['assumption-handling'].code, 'packet-overflow')
  assert.deepEqual(outcome.failures['assumption-handling'].criteria, criteriaForJob(automated, 'assumption-handling'))
})

// --- Canned judging ------------------------------------------------------------

const out = (...results) => JSON.stringify({ results })
const vote = (id, verdict, extra = {}) => ({ id, verdict, rationale: `seat ${verdict}`, evidence: ['packet.txt'],
  citations: [], search_scope: [], missing_obligation: '', missing_material: '', ...extra })
const auditOf = (id, classification, extra = {}) => ({ id, classification, rationale: `audit ${classification}`,
  evidence: ['audit evidence'], citations: [], marker: '', scope_repair: [], ...extra })
const span = (start, end = start) => ({ path: 'packet.txt', start_line: start, end_line: end })
const emptyMap = { scenarios: [], other_claims: [] }
const ruling = (id, verdict, extra = {}) => ({ id, verdict, rationale: `decider ${verdict}`, evidence: ['decider evidence'],
  citations: [], search_scope: [], missing_obligation: '', missing_material: '', claim_map: emptyMap, ...extra })
const stageOf = (next) => next.judge_stage ?? next.audit_stage ?? 'seat'
// The packet section a request carries between its BEGIN and END markers.
const section = (prompt, name) => prompt.split(`# BEGIN ${name}\n`)[1].split(`\n# END ${name}`)[0]
const auditClaims = (next) => JSON.parse(section(next.prompt, 'LINE-CITED CLAIMS'))
const checkClaims = (next) => JSON.parse(section(next.prompt, 'STATED CONTRADICTIONS'))
// Claude (sample 1) passes and both Codex samples fail: the Codex pair against
// the Claude judge goes to the decider.
const toDecider = (id, sample) => (MAPPED.includes(id) ? (sample === 1 ? 'pass' : 'fail') : 'pass')

// Runs product judging with every job but `job` passing unanimously, and the
// canned stages of `job`. `seat(id, sample, next)` returns a verdict or a vote;
// each other stage handler returns the raw output for a request.
async function judgeTestingOnly(views, { job = 'testing-evidence', seat = () => 'pass', stages = {}, seen = [] } = {}) {
  const saved = []
  const outcome = await runProductJudging({ rubrics, authority, evidenceViews: views,
    saveJob: async (record) => saved.push(record),
    invoke: async (next) => {
      seen.push(next)
      if (next.job !== job) return out(...next.criteria.map((id) => vote(id, 'pass')))
      const stage = stageOf(next)
      if (stage === 'seat') {
        return out(...next.criteria.map((id) => {
          const answer = seat(id, next.judge_sample, next)
          return typeof answer === 'string' ? vote(id, answer) : answer
        }))
      }
      if (!stages[stage]) throw new Error(`unexpected ${stage}`)
      return stages[stage](next)
    } })
  return { ...outcome, seen, saved }
}
const ofStage = (seen, stage, job = 'testing-evidence') => seen.filter((next) => next.job === job && stageOf(next) === stage)

// Answers each audit claim by its criterion and part.
const audits = (answer) => (next) => out(...auditClaims(next).map((claim) => answer(claim, next)))
const confirmAll = audits((claim) => auditOf(claim.id, 'confirmed'))

// The decider rulings on fixture 1: usable proof passes on the flow record with
// a map that omits the deep claim; complete and honest record fails on the
// false claim outside the basis, mapping the deep claim as missing evidence.
function fixtureOneRulings(packet, { proofMap = null } = {}) {
  const flow = lineOf(packet, 'Step 1: opened the deck')
  const falseClaim = lineOf(packet, FALSE_CLAIM)
  const deep = lineOf(packet, DEEP_CLAIM)
  const proof = ruling(PROOF, 'pass', { citations: [span(flow)], claim_map: proofMap ?? { scenarios: [
    { scenario: BASIS[0], claims: [{ claim_span: span(flow), evidence_spans: [span(flow)], status: 'supported' }] }], other_claims: [] } })
  const honest = ruling(HONEST, 'fail', { citations: [span(falseClaim)], claim_map: {
    scenarios: [{ scenario: DEEP_SCENARIO, claims: [{ claim_span: span(deep), evidence_spans: [], status: 'missing' }] }],
    other_claims: [{ kind: 'other', claim_span: span(falseClaim), evidence_spans: [span(lineOf(packet, 'All scenarios passed'))], status: 'defective' }] } })
  return { proof, honest, flow, falseClaim, deep }
}

test('the decider maps claims, a completeness audit finds the omitted deep claim, and the pass is withdrawn only on a confirmed check', async () => {
  for (const check of ['confirmed', 'contradicted']) {
    const { views } = await evidenceViews({ artifacts: deepRecord() })
    const packet = views['testing-evidence'].packet
    const { proof, honest, deep, falseClaim } = fixtureOneRulings(packet)
    let decided = 0
    const outcome = await judgeTestingOnly(views, { seat: toDecider, stages: {
      // The first ruling maps the false claim as a basis scenario, which the
      // basis does not hold; the retry maps it outside the basis.
      tiebreak: () => (decided++ === 0
        ? out({ ...proof, claim_map: { ...proof.claim_map, scenarios: [...proof.claim_map.scenarios,
          { scenario: 'Offline export check', claims: [{ claim_span: span(falseClaim), evidence_spans: [], status: 'missing' }] }] } }, honest)
        : out(proof, honest)),
      'tiebreak-span-audit': audits((claim) => (claim.id === PROOF && claim.audit_part === 'completeness'
        ? auditOf(PROOF, 'contradicted', { rationale: 'the log claims the deep scenario with no evidence and the map omits it',
          citations: [`packet.txt:${deep}`], evidence: [`packet.txt:${deep}: ${DEEP_CLAIM}`] })
        : auditOf(claim.id, 'confirmed'))),
      'contradiction-check': (next) => out(...checkClaims(next).map(({ id }) => auditOf(id, check))),
    } })
    assert.deepEqual(outcome.failed_jobs, [], JSON.stringify(outcome.failures))
    const seats = ofStage(outcome.seen, 'seat')
    const [decider] = ofStage(outcome.seen, 'tiebreak')
    const spanAudits = ofStage(outcome.seen, 'tiebreak-span-audit')
    const [contradiction] = ofStage(outcome.seen, 'contradiction-check')
    // Every seat, the decider and the completeness audit hold the deep claim.
    assert.equal(seats.length, 3)
    for (const next of [...seats, decider]) assert.ok(next.prompt.includes(DEEP_CLAIM))
    const completeness = spanAudits.flatMap(auditClaims).filter(({ audit_part: part }) => part === 'completeness')
    assert.deepEqual(completeness.map(({ id }) => id), MAPPED)
    for (const claim of completeness) {
      assert.ok(claim.claim_bearing_records.join('\n').includes(`${deep}|${DEEP_CLAIM}`))
      assert.equal(claim.quoted_spans, undefined)
      assert.equal(claim.claim_map_rows, undefined)
      for (const location of claim.mapped_claim_locations) assert.match(location, /^(scenario: |outside the basis).*claim packet\.txt:\d+-\d+; evidence /)
    }
    // The four claim-bearing records arrive whole; the supporting ones do not.
    const records = completeness[0].claim_bearing_records.join('\n')
    for (const line of deepRecord().find(({ role }) => role === 'exploration-log').text.split('\n')) assert.ok(records.includes(`|${line}\n`) || records.endsWith(`|${line}`))
    assert.ok(!records.includes('session filler'))
    // The map with an out-of-basis scenario row was invalid output and retried.
    assert.match(outcome.attempts['testing-evidence'].find(({ ok, stage }) => stage === 'tiebreak' && !ok).error,
      /Offline export check.*not a basis scenario heading/)
    // The honest-record row audit receives the false claim's labelled lines.
    const honestRows = spanAudits.flatMap(auditClaims).find(({ id, audit_part: part }) => id === HONEST && part === 'claim map rows')
    assert.deepEqual(honestRows.claim_map_rows.map(({ row }) => row), [`scenario: ${DEEP_SCENARIO}`, 'outside the basis (other)'])
    assert.match(honestRows.claim_map_rows[1].claims[0].claim_lines, new RegExp(`^packet\\.txt:${falseClaim}-${falseClaim} \\[artifact candidate-\\w+ \\(final-handoff\\)\\]\\n${falseClaim}\\|FALSE CLAIM`))
    assert.match(honestRows.claim_map_rows[0].claims[0].claim_lines, new RegExp(`${deep}\\|DEEP CLAIM`))
    // The contradiction check receives the omitted line in its material.
    const [stated] = checkClaims(contradiction)
    assert.equal(stated.id, PROOF)
    assert.ok(stated.material.some((item) => typeof item === 'string' && item.startsWith(`packet.txt:${deep}-${deep} [artifact`)
      && item.endsWith(`${deep}|${DEEP_CLAIM}`)))
    const results = Object.fromEntries(outcome.judges['testing-evidence'].map((result) => [result.id, result]))
    assert.equal(results[PROOF].basis, check === 'confirmed' ? 'decider-fail' : 'decider-pass')
    assert.equal(results[HONEST].basis, 'decider-fail')
    // Row and completeness audits are parts of one cycle, and the record replays.
    const record = outcome.saved.find(({ id }) => id === 'testing-evidence')
    for (const id of MAPPED) {
      assert.deepEqual(record.decider.settlement[id], { settled_cycle: 'initial', cycles: [{ cycle: 'initial', expected_parts: ['rows-1', 'completeness'] }] })
      assert.deepEqual(record.decider.audit_results.filter(({ criterion }) => criterion === id).map(({ cycle, part }) => [cycle, part]),
        [['initial', 'rows-1'], ['initial', 'completeness']])
    }
    assert.deepEqual(verifyCachedPanelJob(record).results, outcome.judges['testing-evidence'])
  }
})

// Fixture 2: a record that claims every basis scenario, each claim and its
// evidence in separate places, plus CI and limitation claims.
const EVIDENCE_LINE = 'observed as the scenario states'
function everyScenarioRecord() {
  const lines = ['# Exploration log']
  for (const [index, scenario] of BASIS.entries()) {
    lines.push(`CLAIM ${index}: scenario "${scenario}" was exercised and passed at both viewports.`)
    for (let n = 0; n < 40; n += 1) lines.push(`evidence ${index}.${n} ${EVIDENCE_LINE}`)
  }
  for (let n = 0; n < 24; n += 1) lines.push(n % 2 ? `LIMITATION ${n}: could not exercise case ${n}.` : `CI ${n}: CI passed at the final revision.`)
  return [
    { role: 'exploration-log', name: 'exploration-log.md', text: `${lines.join('\n')}\n` },
    { role: 'final-handoff', name: 'acceptance-handoff.md', text: '# Handoff\nEvery scenario passed.\n' },
    { role: 'findings-history', name: 'findings-history.md', text: '# Findings\nnone\n' },
  ]
}
function everyScenarioMap(packet) {
  const evidenceAt = (index) => lineOf(packet, `evidence ${index}.0 `)
  return {
    scenarios: BASIS.map((scenario, index) => ({ scenario, claims: [0, 1].map(() => ({
      claim_span: span(lineOf(packet, `CLAIM ${index}: `)),
      evidence_spans: [0, 1, 2, 3].map(() => span(evidenceAt(index), evidenceAt(index) + 39)),
      status: 'supported' })) })),
    other_claims: Array.from({ length: 24 }, (_, n) => ({ kind: n % 2 ? 'limitation' : 'ci',
      claim_span: span(lineOf(packet, n % 2 ? `LIMITATION ${n}:` : `CI ${n}:`)), evidence_spans: [], status: 'missing' })),
  }
}

test('a map of all 68 basis scenarios validates, is audited in whole-row batches, and settles without overflow', async () => {
  assert.equal(BASIS.length, 68)
  const { views } = await evidenceViews({ artifacts: everyScenarioRecord() })
  const packet = views['testing-evidence'].packet
  const map = everyScenarioMap(packet)
  const outcome = await judgeTestingOnly(views, { seat: toDecider, stages: {
    tiebreak: () => out(ruling(PROOF, 'pass', { citations: [span(lineOf(packet, 'CLAIM 0: '))], claim_map: map }),
      ruling(HONEST, 'pass', { citations: [span(lineOf(packet, 'CI 0:'))], claim_map: map })),
    'tiebreak-span-audit': confirmAll,
  } })
  assert.deepEqual(outcome.failed_jobs, [], JSON.stringify(outcome.failures))
  const [decider] = ofStage(outcome.seen, 'tiebreak')
  assert.equal(decider.schema.properties.results.items.properties.claim_map.properties.scenarios.maxItems, 68)
  assert.match(decider.prompt, /# Claim map/)
  const parts = ofStage(outcome.seen, 'tiebreak-span-audit').flatMap(auditClaims).filter(({ id }) => id === PROOF)
  const rowParts = parts.filter(({ audit_part: part }) => part === 'claim map rows')
  assert.ok(rowParts.length > 1, 'the rows need more than one batch')
  // Every row arrives once, whole, with its referenced lines.
  const rows = rowParts.flatMap(({ claim_map_rows: batch }) => batch)
  assert.deepEqual(rows.map(({ row }) => row), [...BASIS.map((scenario) => `scenario: ${scenario}`),
    ...Array.from({ length: 24 }, (_, n) => `outside the basis (${n % 2 ? 'limitation' : 'ci'})`)])
  for (const row of rows.slice(0, 68)) {
    assert.equal(row.claims.length, 2)
    for (const claim of row.claims) assert.equal(claim.evidence_lines.length, 4)
    assert.equal(row.claims[0].evidence_lines[0].split('\n').length, 41)
  }
  // Only the first row part carries the ruling's own quoted lines.
  assert.deepEqual(rowParts.map(({ quoted_spans: quoted }) => Boolean(quoted)), rowParts.map((_, index) => index === 0))
  const record = outcome.saved.find(({ id }) => id === 'testing-evidence')
  assert.deepEqual(record.decider.settlement[PROOF].cycles[0].expected_parts,
    [...rowParts.map((_, index) => `rows-${index + 1}`), 'completeness'])
  assert.ok(outcome.judges['testing-evidence'].every(({ verdict }) => verdict === 'pass'))
  assert.deepEqual(verifyCachedPanelJob(record).results, outcome.judges['testing-evidence'])
})

test('every claim-map bound is enforced as invalid decider output', () => {
  const claimMap = { criteria: MAPPED, scenarios: BASIS }
  const parse = (map, id = PROOF) => parseLineCitedOutput(out(ruling(id, 'pass', { citations: [span(1)], claim_map: map })), [id], 'testing-evidence', { claimMap })
  const claim = (extra = {}) => ({ claim_span: span(1), evidence_spans: [span(2)], status: 'supported', ...extra })
  const row = (scenario, count = 1) => ({ scenario, claims: Array.from({ length: count }, () => claim()) })
  const other = (count) => Array.from({ length: count }, () => ({ kind: 'ci', ...claim() }))
  assert.equal(parse({ scenarios: BASIS.map((scenario) => row(scenario, 6)), other_claims: other(24) })[0].claim_map.scenarios.length, 68)
  for (const [map, pattern] of [
    [{ scenarios: [row(BASIS[0]), row(BASIS[0])], other_claims: [] }, /more than one row/],
    [{ scenarios: [row('A scenario the specs do not hold')], other_claims: [] }, /not a basis scenario heading/],
    [{ scenarios: [row(BASIS[0], 7)], other_claims: [] }, /needs 1-6 claims/],
    [{ scenarios: [row(BASIS[0], 0)], other_claims: [] }, /needs 1-6 claims/],
    [{ scenarios: [], other_claims: other(25) }, /more than 24 rows outside the basis/],
    [{ scenarios: [{ scenario: BASIS[0], claims: [claim({ evidence_spans: [1, 2, 3, 4, 5].map((n) => span(n)) })] }], other_claims: [] }, /at most 4 evidence spans/],
    [{ scenarios: [{ scenario: BASIS[0], claims: [claim({ claim_span: span(1, 41) })] }], other_claims: [] }, /is not 1-40 lines/],
    [{ scenarios: [{ scenario: BASIS[0], claims: [claim({ evidence_spans: [span(10, 50)] })] }], other_claims: [] }, /is not 1-40 lines/],
    [{ scenarios: [{ scenario: BASIS[0], claims: [claim({ evidence_spans: [] })] }], other_claims: [] }, /supported but cites no evidence/],
    [{ scenarios: [], other_claims: [{ ...claim(), kind: 'rumour' }] }, /kind "rumour"/],
    [{ scenarios: [{ scenario: BASIS[0], claims: [claim({ status: 'plausible' })] }], other_claims: [] }, /status "plausible"/],
    [undefined, /needs scenarios and other_claims/],
  ]) assert.throws(() => parse(map), pattern)
  // A criterion that takes no claim map returns its empty form, or none.
  assert.equal(parse(emptyMap, COVERAGE)[0].claim_map, undefined)
  assert.equal(parse(null, COVERAGE)[0].claim_map, undefined)
  assert.throws(() => parse({ scenarios: [row(BASIS[0])], other_claims: [] }, COVERAGE), /takes none; return its empty form/)
  // A source job's decider has no claim map and no cut index.
  assert.throws(() => parseLineCitedOutput(out(ruling('x', 'pass', { citations: [span(1)], missing_material: '[truncated: a' })), ['x'], 'job'),
    /names no marker in the packet's cut index/)
})

// --- Missing material ----------------------------------------------------------

test('unanimous evidence seats where one reports missing material fail the criterion before settlement; an unknown marker is retried', async () => {
  const { views, idOf } = await evidenceViews({ artifacts: deepRecord() })
  const session = idOf('session-report.md')
  const seat = (id, sample) => (id === PROOF && sample === 2
    ? vote(id, 'pass', { missing_material: seatsAsked++ === 0 ? '[truncated: candidate-ffffffffffffffff' : `my proof is in [truncated: ${session}` })
    : 'pass')
  let seatsAsked = 0
  const outcome = await judgeTestingOnly(views, { seat })
  assert.deepEqual(outcome.failed_jobs, ['testing-evidence'])
  const failure = outcome.failures['testing-evidence']
  assert.equal(failure.code, 'missing-material')
  assert.equal(failure.owner, 'evaluation-harness')
  assert.equal(failure.resumable, false)
  assert.deepEqual(failure.criteria, [PROOF])
  assert.match(failure.message, new RegExp(`\\[truncated: ${session} kept 50000 of \\d+ characters\\]`))
  assert.ok(outcome.attempts['testing-evidence'].some(({ ok, error }) => !ok && /names no marker in the packet's cut index/.test(error)))
  for (const stage of ['tiebreak', 'contradiction-check', 'dissent-check']) assert.equal(ofStage(outcome.seen, stage).length, 0)
})

test('a decider reporting missing material fails the criterion before its audits', async () => {
  const { views, idOf } = await evidenceViews({ artifacts: deepRecord() })
  const { proof, honest } = fixtureOneRulings(views['testing-evidence'].packet)
  const outcome = await judgeTestingOnly(views, { seat: toDecider, stages: {
    tiebreak: () => out(proof, { ...honest, missing_material: `[omitted: ${idOf('ref-4.md')} (referenced-material)]` }) } })
  assert.equal(outcome.failures['testing-evidence'].code, 'missing-material')
  assert.deepEqual(outcome.failures['testing-evidence'].criteria, [HONEST])
  assert.equal(ofStage(outcome.seen, 'tiebreak-span-audit').length, 0)
})

test('a row audit of lines in a cut log sees them labelled with the marker and the cut index, and a check that depends on it returns missing-material', async () => {
  const { views, idOf } = await evidenceViews({ artifacts: deepRecord() })
  const packet = views['testing-evidence'].packet
  const session = idOf('session-report.md')
  const retained = lineOf(packet, 'session filler')
  const marker = packetCuts(packet, { atStart: true }).find(({ id }) => id === session).marker
  assert.ok(!packet.split('\n').slice(retained - 1, retained + 2).join('\n').includes('[truncated:'), 'the marker is not in range')
  const { proof, honest } = fixtureOneRulings(packet, { proofMap: { scenarios: [{ scenario: BASIS[1], claims: [{
    claim_span: span(lineOf(packet, 'Step 1: opened the deck')), evidence_spans: [span(retained, retained + 2)], status: 'supported' }] }],
  other_claims: [] } })
  for (const stage of ['row audit', 'check']) {
    const outcome = await judgeTestingOnly(views, { seat: toDecider, stages: {
      tiebreak: () => out(proof, honest),
      'tiebreak-span-audit': audits((claim) => (claim.id === PROOF && claim.audit_part === 'claim map rows'
        ? auditOf(PROOF, stage === 'row audit' ? 'missing-material' : 'contradicted',
          stage === 'row audit' ? { marker: `[truncated: ${session} kept half]` } : { citations: [`packet.txt:${retained}-${retained + 2}`] })
        : auditOf(claim.id, 'confirmed'))),
      'contradiction-check': (next) => out(...checkClaims(next).map(({ id }) => auditOf(id, 'missing-material', { marker }))),
    } })
    const rows = ofStage(outcome.seen, 'tiebreak-span-audit').find((next) => auditClaims(next)
      .some(({ id, audit_part: part }) => id === PROOF && part === 'claim map rows'))
    const evidenceLines = auditClaims(rows).find(({ id }) => id === PROOF).claim_map_rows[0].claims[0].evidence_lines[0]
    assert.ok(evidenceLines.startsWith(`packet.txt:${retained}-${retained + 2} [artifact ${session} (session-audit), cut ${marker}]\n`), evidenceLines)
    assert.ok(rows.prompt.includes(`# BEGIN PACKET CUT INDEX\n- ${marker}`))
    if (stage === 'check') {
      const [check] = ofStage(outcome.seen, 'contradiction-check')
      assert.ok(check.prompt.includes('# BEGIN PACKET CUT INDEX'))
      assert.ok(checkClaims(check)[0].material.some((item) => typeof item === 'string' && item.includes(`cut ${marker}`)))
    }
    assert.equal(outcome.failures['testing-evidence'].code, 'missing-material', stage)
    assert.deepEqual(outcome.failures['testing-evidence'].criteria, [PROOF])
    assert.match(outcome.failures['testing-evidence'].message, new RegExp(marker.replace(/[[\]()]/g, '\\$&')))
  }
})

test('an audit or check names a cut by its bare prefix, never by a paraphrase', () => {
  const marker = '[truncated: candidate-0123456789abcdef kept 50000 of 70000 characters]'
  const packet = `# BEGIN PACKET CUT INDEX\n- ${marker}\n# END PACKET CUT INDEX\nquoted lines`
  const parse = (reported) => parseSourceAuditOutput(out(auditOf('x', 'missing-material', { marker: reported })), ['x'], 'job',
    { outcomes: CHECK_OUTCOMES, inventory: null, packet })
  assert.equal(parse('[truncated: candidate-0123456789abcdef')[0].marker, marker)
  assert.equal(parse('[truncated: candidate-0123456789abcdef kept most of it]')[0].marker, marker)
  assert.throws(() => parse('the session report was truncated'), /without a marker its packet holds/)
})

// --- Seats on every path -------------------------------------------------------

test('unanimous and majority seats receive the deep claim in their packet, and settle without the decider', async () => {
  for (const [name, seat] of [['unanimous', () => 'pass'], ['majority', (id, sample) => (MAPPED.includes(id) && sample === 3 ? 'fail' : 'pass')]]) {
    const { views } = await evidenceViews({ artifacts: deepRecord() })
    const outcome = await judgeTestingOnly(views, { seat })
    assert.deepEqual(outcome.failed_jobs, [], name)
    const seats = ofStage(outcome.seen, 'seat')
    assert.equal(seats.length, 3)
    for (const next of seats) {
      assert.ok(next.prompt.includes(DEEP_CLAIM), name)
      assert.match(next.prompt, /claim-bearing records \(acceptance flow record, exploration log, final handoff, findings history\) are in the\npacket in full/)
      assert.match(next.prompt, /set missing_material to the marker copied exactly from the cut index/)
      assert.ok(next.schema.properties.results.items.required.includes('missing_material'))
    }
    const bases = Object.fromEntries(outcome.judges['testing-evidence'].map(({ id, basis }) => [id, basis]))
    for (const id of MAPPED) assert.equal(bases[id], name === 'unanimous' ? 'consensus-pass' : 'majority-pass')
  }
})

test('an evidence view with more than 500 files still gives the seats and the decider packet.txt', async () => {
  const { views } = await evidenceViews({ artifacts: deepRecord(), extraViewFiles: 600 })
  const { proof, honest } = fixtureOneRulings(views['testing-evidence'].packet)
  const outcome = await judgeTestingOnly(views, { seat: toDecider, stages: {
    tiebreak: () => out(proof, honest), 'tiebreak-span-audit': confirmAll } })
  assert.deepEqual(outcome.failed_jobs, [], JSON.stringify(outcome.failures))
  for (const next of ofStage(outcome.seen, 'seat')) assert.ok(next.prompt.includes(DEEP_CLAIM))
  const [decider] = ofStage(outcome.seen, 'tiebreak')
  assert.match(decider.prompt, /# evidence view files\n- packet\.txt\n/)
  assert.ok(decider.prompt.includes(DEEP_CLAIM))
})

// --- Scored once ---------------------------------------------------------------

test('traceable coverage scores a plan-commitment omission once, and complete and honest record does not fail for it', async () => {
  const request = buildJudgeRequest({ rubrics, job: 'testing-evidence', authority })
  assert.match(request.prompt, /Complete and honest record does not compare the exploration plan with the log and does not fail for an omitted\s+behavior/)
  assert.match(request.prompt, /Traceable coverage alone scores an omitted behavior, including one the exploration plan committed to/)
  assert.doesNotMatch(request.prompt, /concealed gap/)
  assert.match(buildJudgeRequest({ rubrics, job: 'assumption-handling', authority }).prompt,
    /Plan commitments the log did not cover are scored under\s+testing-evidence, not here/)
  const plan = { role: 'acceptance-pass-record', name: 'exploration-plan.md', text: `# Plan\nWill exercise "${BASIS[9]}".\n` }
  const { views } = await evidenceViews({ artifacts: [...deepRecord().slice(0, 4), plan] })
  const outcome = await judgeTestingOnly(views, { seat: (id) => (id === COVERAGE ? 'fail' : 'pass') })
  const verdicts = Object.fromEntries(outcome.judges['testing-evidence'].map(({ id, verdict }) => [id, verdict]))
  assert.deepEqual(Object.entries(verdicts).filter(([, verdict]) => verdict === 'fail').map(([id]) => id), [COVERAGE])
  assert.equal(verdicts[HONEST], 'pass')
})

// --- Schemas -------------------------------------------------------------------

test('the claim-map decider schema is strict: every object closed and every property required', () => {
  const objects = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'object') objects.push(node)
    for (const child of [...Object.values(node.properties ?? {}), node.items].filter(Boolean)) walk(child)
  }
  walk(LINE_CITED_CLAIM_MAP_RESULT_SCHEMA)
  assert.ok(objects.length >= 6)
  for (const node of objects) {
    assert.equal(node.additionalProperties, false)
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort())
  }
})

// S2 reads "the confirming check cites delivered source" as a non-empty check
// citation list; an evidence job cites only its packet, so no browser-fallback
// criterion may be answered by one.
test('a browser fallback never names an evidence job', () => {
  for (const job of ['testing-evidence', 'assumption-handling']) {
    const copy = structuredClone(automated)
    const [id] = Object.keys(copy.fallbacks)
    copy.fallbacks[id].job = job
    assert.match(validateAutomatedRubric(copy).join('\n'), new RegExp(`fallback ${id} names evidence job ${job}, which cannot cite delivered source`))
  }
  assert.deepEqual(validateAutomatedRubric(automated), [])
})

test('an insufficient completeness part leaves the pass undecided; the re-cite re-runs every part as a new cycle and replays', async () => {
  const { views } = await evidenceViews({ artifacts: deepRecord() })
  const packet = views['testing-evidence'].packet
  const { proof, honest, deep } = fixtureOneRulings(packet)
  const recitedMap = { scenarios: [...proof.claim_map.scenarios, { scenario: DEEP_SCENARIO, claims: [
    { claim_span: span(deep), evidence_spans: [], status: 'missing' }] }], other_claims: [] }
  let audited = 0
  const outcome = await judgeTestingOnly(views, { seat: toDecider, stages: {
    tiebreak: () => out(proof, honest),
    'tiebreak-recite': (next) => out(...next.criteria.map(() => ({ ...proof, claim_map: recitedMap }))),
    'tiebreak-span-audit': audits((claim) => auditOf(claim.id,
      claim.id === PROOF && claim.audit_part === 'completeness' && audited++ === 0 ? 'insufficient' : 'confirmed')),
  } })
  assert.deepEqual(outcome.failed_jobs, [], JSON.stringify(outcome.failures))
  const [recite] = ofStage(outcome.seen, 'tiebreak-recite')
  assert.deepEqual(recite.criteria, [PROOF])
  assert.ok(recite.schema.properties.results.items.required.includes('claim_map'))
  const record = outcome.saved.find(({ id }) => id === 'testing-evidence')
  assert.deepEqual(record.decider.settlement[PROOF], { settled_cycle: 'recite', cycles: [
    { cycle: 'initial', expected_parts: ['rows-1', 'completeness'] }, { cycle: 'recite', expected_parts: ['rows-1', 'completeness'] }] })
  // The recite cycle's row audit sees the re-cited map's new row.
  const recitedRows = ofStage(outcome.seen, 'tiebreak-span-audit').flatMap(auditClaims)
    .filter(({ id, audit_part: part }) => id === PROOF && part === 'claim map rows').at(-1)
  assert.deepEqual(recitedRows.claim_map_rows.map(({ row }) => row), [`scenario: ${BASIS[0]}`, `scenario: ${DEEP_SCENARIO}`])
  assert.equal(outcome.judges['testing-evidence'].find(({ id }) => id === PROOF).basis, 'decider-pass')
  assert.deepEqual(verifyCachedPanelJob(record).results, outcome.judges['testing-evidence'])
  // A record whose claim-map cycle lost its completeness part does not replay.
  const tampered = structuredClone(record)
  tampered.decider.settlement[PROOF].cycles[1].expected_parts = ['rows-1']
  tampered.decider.audit_results = tampered.decider.audit_results
    .filter(({ criterion, cycle, part }) => !(criterion === PROOF && cycle === 'recite' && part === 'completeness'))
  assert.throws(() => verifyCachedPanelJob(tampered), /lacks its claim-map row or completeness audit part/)
})
