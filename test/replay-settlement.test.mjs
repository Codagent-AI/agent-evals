// INT-008: the settlement replay over archives, and rescore flip attribution.
import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { loadRubrics, rubricCriteria } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import {
  blockerCheck, classifyFlip, comparePair, compareRep, criterionLayers, loadRescore,
} from '../evals/agent-runner/and-scene/lib/flip-attribution.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'evals/agent-runner/and-scene/scripts/replay-settlement.mjs')
const { automated } = await loadRubrics()
const weight = new Map(rubricCriteria(automated.rubric).map(({ id, criterion_points: points }) => [id, points]))

const USABLE = 'testing-evidence-usable-proof'
const HONEST = 'testing-evidence-complete-honest-record'
const TRACEABLE = 'testing-evidence-traceable-coverage'
const FINAL = 'testing-evidence-final-revision-applicability'
const ACTIVE = 'visual-helper-active-state-warning'
const OVERLAP = 'visual-helper-overlap-warning'
const BROWSE = 'mode-browse-reading-focused'
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

const span = (path, start, end) => ({ path, start_line: start, end_line: end })
const FIRST_USABLE = [span('packet.txt', 886, 898)]
const RECITED_USABLE = [span('packet.txt', 889, 897), span('packet.txt', 465, 486)]
const FIRST_HONEST = [span('packet.txt', 1006, 1012)]
const FIRST_ACTIVE = [span('scripts/inspect-presentation.mjs', 44, 50)]

const vote = (id, index, verdict, extra = {}) => ({
  id, verdict, rationale: `seat ${index} on ${id}`, evidence: ['seat evidence'], citations: ['src/a.ts'],
  family: index === 0 ? 'claude' : 'codex', model: index === 0 ? SONNET : 'gpt-6-sol', effort: 'medium', panel_index: index, ...extra,
})
const votes = (id, verdicts, extra = {}) => verdicts.map((verdict, index) => vote(id, index, verdict, extra[index]))
const ruling = (id, verdict, citations) => ({ id, verdict, rationale: `decider on ${id}`, evidence: ['decider evidence'], citations })
const audit = (id, classification) => ({ id, classification, rationale: `audit of ${id}`, evidence: ['audit evidence'] })

function v1Record({ job, criteria, votes: recordedVotes, checks = [], results, decider = null }) {
  return {
    id: job, protocol: 'cross-family-panel-v1', job, criteria, verdicts: ['pass', 'fail'], order: ['pass', 'fail'], ok: true,
    fallback_ids: [], votes: recordedVotes, checks, rulings: [], decider,
    results: results.map(([id, verdict, basis]) => ({ id, verdict, basis })),
    authority: { decider: { family: 'claude', model: OPUS, effort: 'medium' } },
  }
}

// #78 rep 2's shapes: a decider pass re-cited to fail, a confirmed span-audit
// contradiction, an insufficient seat check that v1 sent to the decider, and
// a confirmed seat contradiction v1 never sent to it.
const records = {
  'testing-evidence': v1Record({
    job: 'testing-evidence',
    criteria: [TRACEABLE, USABLE, FINAL, HONEST],
    votes: [
      ...votes(TRACEABLE, ['fail', 'fail', 'fail']), ...votes(USABLE, ['pass', 'fail', 'fail']),
      ...votes(FINAL, ['pass', 'pass', 'pass']), ...votes(HONEST, ['pass', 'fail', 'fail']),
    ],
    results: [[TRACEABLE, 'fail', 'consensus-fail'], [USABLE, 'fail', 'decider-fail'], [FINAL, 'pass', 'consensus-pass'], [HONEST, 'fail', 'decider-fail']],
    decider: {
      ok: true, criteria: [USABLE, HONEST], inventory_kind: 'evidence view',
      attempts: [{ stage: 'tiebreak', attempt: 1, ok: true, error: null }, { stage: 'tiebreak-recite', attempt: 1, ok: true, error: null }],
      results: [ruling(USABLE, 'fail', RECITED_USABLE), ruling(HONEST, 'pass', FIRST_HONEST)],
      audit_results: [audit(USABLE, 'insufficient'), audit(HONEST, 'contradicted')],
      contradiction_checks: [audit(HONEST, 'confirmed')],
    },
  }),
  'verification-tooling': v1Record({
    job: 'verification-tooling',
    criteria: [ACTIVE, OVERLAP],
    votes: [
      ...votes(ACTIVE, ['pass', 'pass', 'pass'], { 1: { disputed: true, contradiction: { rationale: 'compares the active step with Previous', evidence: [] } } }),
      ...votes(OVERLAP, ['fail', 'fail', 'fail']),
    ],
    checks: [{ ...audit(ACTIVE, 'insufficient'), stage: 'contradiction-check', panel_index: 1 }],
    results: [[ACTIVE, 'fail', 'decider-fail'], [OVERLAP, 'fail', 'consensus-fail']],
    decider: {
      ok: true, criteria: [ACTIVE], inventory_kind: 'source',
      attempts: [{ stage: 'tiebreak', attempt: 1, ok: true, error: null }],
      results: [ruling(ACTIVE, 'pass', FIRST_ACTIVE)],
      audit_results: [audit(ACTIVE, 'contradicted')],
      contradiction_checks: [audit(ACTIVE, 'confirmed')],
    },
  }),
  'scene-kit': v1Record({
    job: 'scene-kit',
    criteria: [BROWSE],
    votes: votes(BROWSE, ['pass', 'pass', 'pass'], { 2: { disputed: true, contradiction: { rationale: 'controls hidden at 390px', evidence: [] } } }),
    checks: [{ ...audit(BROWSE, 'confirmed'), stage: 'contradiction-check', panel_index: 2 }],
    results: [[BROWSE, 'pass', 'majority-pass']],
  }),
}

const events = (model, output) => [
  { type: 'system', subtype: 'init', model, tools: ['StructuredOutput'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
  { type: 'result', subtype: 'success', structured_output: output },
].map((event) => JSON.stringify(event)).join('\n')

const verdicts = (...entries) => ({ results: entries.map(([id, verdict, citations]) => ({ ...ruling(id, verdict, citations) })) })
const classifications = (...entries) => ({ results: entries.map(([id, classification]) => audit(id, classification)) })

function rawLogs() {
  return {
    '01-testing-evidence': events(SONNET, verdicts([TRACEABLE, 'fail', []], [USABLE, 'pass', []], [FINAL, 'pass', []], [HONEST, 'pass', []])),
    '02-testing-evidence': events(OPUS, verdicts([USABLE, 'pass', FIRST_USABLE], [HONEST, 'pass', FIRST_HONEST])),
    '03-testing-evidence': events(OPUS, classifications([USABLE, 'insufficient'], [HONEST, 'contradicted'])),
    '04-testing-evidence': events(OPUS, classifications([HONEST, 'confirmed'])),
    '05-testing-evidence': events(OPUS, verdicts([USABLE, 'fail', RECITED_USABLE])),
    '06-verification-tooling': events(OPUS, classifications([ACTIVE, 'insufficient'])),
    '07-verification-tooling': events(OPUS, verdicts([ACTIVE, 'pass', FIRST_ACTIVE])),
    '08-verification-tooling': events(OPUS, classifications([ACTIVE, 'contradicted'])),
    '09-verification-tooling': events(OPUS, classifications([ACTIVE, 'confirmed'])),
  }
}

async function archives({ raw = rawLogs(), withRaw = true } = {}) {
  const base = await makeTempDir(join(tmpdir(), 'and-scene-replay-test-'))
  const recordsRoot = join(base, 'records')
  await mkdir(join(recordsRoot, 'out-seq-e78-2/phases/judges'), { recursive: true })
  for (const [job, record] of Object.entries(records)) {
    await writeFile(join(recordsRoot, 'out-seq-e78-2/phases/judges', `${job}.json`), JSON.stringify(record))
  }
  const rawRoot = join(base, 'raw')
  await mkdir(join(rawRoot, 'out-seq-e78-2/.runtime/judge-claude'), { recursive: true })
  for (const [stem, content] of Object.entries(raw)) {
    await writeFile(join(rawRoot, 'out-seq-e78-2/.runtime/judge-claude', `${stem}.events.jsonl`), `${content}\n`)
  }
  const recordsArchive = join(base, 'e78-rep2-judging-records.tar.gz')
  const rawArchive = join(base, 'e78-rep2-judge-raw-logs.tar.gz')
  for (const [archive, directory] of [[recordsArchive, recordsRoot], [rawArchive, rawRoot]]) {
    const result = spawnSync('tar', ['-czf', archive, '-C', directory, '.'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  if (!withRaw) await rm(rawArchive)
  return { recordsArchive, rawArchive }
}

function replay(inputs, extra = ['--json']) {
  const result = spawnSync(process.execPath, [script, inputs.recordsArchive, inputs.rawArchive, ...extra], { encoding: 'utf8' })
  return { ...result, report: result.status === 0 && extra.includes('--json') ? JSON.parse(result.stdout) : null }
}

const row = (report, criterion) => report.runs[0].rows.find((entry) => entry.criterion === criterion)

test('the replay settles the first decider votes from raw logs under the v2 rules', async () => {
  const result = replay(await archives())
  assert.equal(result.status, 0, result.stderr)
  const { report } = result
  assert.equal(report.header, 'partial settlement counterfactual')
  assert.equal(report.label, 'replay')
  assert.deepEqual(report.runs.map(({ run, label }) => [run, label]), [['out-seq-e78-2', 'replay']])
  const outcomes = report.runs[0].rows.map(({ criterion, old, new: now }) => [criterion, old.verdict, old.basis, now.verdict, now.basis])
  assert.deepEqual(outcomes, [
    [BROWSE, 'pass', 'majority-pass', 'pass', 'not-modelled'],
    [TRACEABLE, 'fail', 'consensus-fail', 'fail', 'consensus-fail'],
    [USABLE, 'fail', 'decider-fail', 'pass', 'decider-pass'],
    [FINAL, 'pass', 'consensus-pass', 'pass', 'consensus-pass'],
    [HONEST, 'fail', 'decider-fail', 'fail', 'decider-fail'],
    [ACTIVE, 'fail', 'decider-fail', 'pass', 'consensus-pass'],
    [OVERLAP, 'fail', 'consensus-fail', 'fail', 'consensus-fail'],
  ])
  // The immutable re-cite keeps the first pass and its first spans.
  assert.deepEqual(row(report, USABLE).first_vote, { verdict: 'pass', citations: FIRST_USABLE, source: 'replay' })
  assert.match(row(report, USABLE).note, /immutable re-cite keeps the first pass/)
  assert.match(row(report, BROWSE).note, /never asked; the recorded verdict is kept/)
  const old = weight.get(FINAL) + weight.get(BROWSE)
  const now = weight.get(USABLE) + weight.get(FINAL) + weight.get(ACTIVE) + weight.get(BROWSE)
  assert.equal(row(report, USABLE).new.points, weight.get(USABLE))
  assert.deepEqual(report.runs[0].totals, {
    old_points: old, new_points: now, delta: now - old, changed_criteria: 2, changed_points: weight.get(USABLE) + weight.get(ACTIVE),
  })

  const text = replay(await archives(), [])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /^partial settlement counterfactual: replay\n/)
  assert.match(text.stdout, /excludes confirmed-contradiction routing, fail audits, auditor citations and any new model response/)
  assert.match(text.stdout, new RegExp(`testing-evidence\\t${USABLE}\\tfail\\tdecider-fail\\tpass\\tdecider-pass\\t0 -> ${weight.get(USABLE)}`))
  assert.match(text.stdout, /changed 2 criteria/)
})

test('an absent raw-log archive or job log falls back to a labelled reconstruction', async () => {
  const absent = replay(await archives({ withRaw: false }))
  assert.equal(absent.status, 0, absent.stderr)
  assert.equal(absent.report.label, 'reconstruction')
  assert.equal(absent.report.raw_logs, 'absent')
  assert.deepEqual(absent.report.runs[0].reconstructed, ['testing-evidence', 'verification-tooling'])
  assert.deepEqual(row(absent.report, USABLE).first_vote, { verdict: 'pass', citations: RECITED_USABLE, source: 'reconstruction' })
  assert.equal(row(absent.report, USABLE).new.basis, 'decider-pass')
  assert.equal(row(absent.report, ACTIVE).new.basis, 'consensus-pass')
  const text = replay(await archives({ withRaw: false }), [])
  assert.match(text.stdout, /^partial settlement counterfactual: reconstruction\n/)

  const raw = rawLogs()
  for (const stem of Object.keys(raw)) if (stem.endsWith('testing-evidence')) delete raw[stem]
  const partial = replay(await archives({ raw }))
  assert.equal(partial.status, 0, partial.stderr)
  assert.equal(partial.report.label, 'reconstruction')
  assert.deepEqual(partial.report.runs[0].reconstructed, ['testing-evidence'])
  assert.equal(row(partial.report, USABLE).first_vote.source, 'reconstruction')
  assert.equal(row(partial.report, ACTIVE).first_vote.source, 'replay')
})

test('a first decider log citing through the neutral root prefix matches its recorded ruling', async () => {
  // The harness strips a `source/` or `./` prefix from a model's citation before
  // recording it, so the raw log can name the same span with the prefix.
  const raw = rawLogs()
  const prefixed = FIRST_ACTIVE.map((span, index) => ({ ...span, path: `${index % 2 ? './' : 'source/'}${span.path}` }))
  raw['07-verification-tooling'] = events(OPUS, verdicts([ACTIVE, 'pass', prefixed]))
  const result = replay(await archives({ raw }))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.report.label, 'replay')
  assert.deepEqual(row(result.report, ACTIVE).first_vote, { verdict: 'pass', citations: FIRST_ACTIVE, source: 'replay' })
  assert.equal(row(result.report, ACTIVE).new.basis, 'consensus-pass')
  // A prefix never hides a different span.
  raw['07-verification-tooling'] = events(OPUS, verdicts([ACTIVE, 'pass', [{ ...prefixed[0], end_line: 51 }]]))
  const differing = replay(await archives({ raw }), [])
  assert.equal(differing.status, 2)
  assert.match(differing.stderr, /does not match its recorded, never re-cited ruling/)
})

test('a malformed or mismatched raw log fails the replay instead of falling back', async () => {
  const cases = [
    ['an unparseable line', (raw) => { raw['02-testing-evidence'] += '\n{not json' }, /malformed raw judge log 02-testing-evidence/],
    ['a missing result event', (raw) => { raw['07-verification-tooling'] = raw['07-verification-tooling'].split('\n').slice(0, 2).join('\n') },
      /malformed raw judge log 07-verification-tooling.*no result event/],
    ['a different criterion', (raw) => { raw['02-testing-evidence'] = events(OPUS, verdicts([USABLE, 'pass', FIRST_USABLE], [TRACEABLE, 'pass', FIRST_HONEST])) },
      /not the recorded decider criteria/],
    ['a different decider model', (raw) => { raw['07-verification-tooling'] = events(SONNET, verdicts([ACTIVE, 'pass', FIRST_ACTIVE])) },
      /0 decider verdict logs do not match the 1 recorded decider attempts/],
    ['a log from another job', (raw) => { raw['07-verification-tooling'] = events(OPUS, verdicts([USABLE, 'pass', FIRST_USABLE])) },
      /not the recorded decider criteria/],
    ['spans that differ from a never re-cited ruling', (raw) => { raw['07-verification-tooling'] = events(OPUS, verdicts([ACTIVE, 'pass', FIRST_USABLE])) },
      /does not match its recorded, never re-cited ruling/],
    ['an audited ruling that was not first a pass', (raw) => { raw['02-testing-evidence'] = events(OPUS, verdicts([USABLE, 'fail', FIRST_USABLE], [HONEST, 'pass', FIRST_HONEST])) },
      /audited testing-evidence-usable-proof as a pass/],
  ]
  for (const [label, mutate, message] of cases) {
    const raw = rawLogs()
    mutate(raw)
    const result = replay(await archives({ raw }), [])
    assert.equal(result.status, 2, `${label}: ${result.stdout}`)
    assert.equal(result.stdout, '', label)
    assert.match(result.stderr, message, label)
    assert.doesNotMatch(result.stderr, /reconstruction/, label)
  }
})

// Flip attribution over canned rescore pairs.
const flipScript = join(root, 'evals/agent-runner/and-scene/scripts/compare-rescores.mjs')

const CRITERIA = {
  A: { job: 'scene-kit', component: 'scene-kit-correctness', points: 1 },
  B: { job: 'scene-kit', component: 'scene-kit-correctness', points: 0.5 },
  C: { job: 'testing-evidence', component: 'testing-evidence-quality', points: 1 },
  D: { job: 'testing-evidence', component: 'testing-evidence-quality', points: 1 },
  E: { job: 'engineering-quality', component: 'engineering-quality', points: 0.5 },
  F: { job: null, component: 'engineering-quality', points: 1 },
}

// spec: { <criterion>: { verdict, seats?, disputed?, checks?, ruling? } }
async function rescoreDir(base, name, spec, { gate = 'pass', belowFloor = false, pass = true } = {}) {
  const runDir = join(base, name)
  await mkdir(join(runDir, 'phases/judges'), { recursive: true })
  const components = [...new Set(Object.values(CRITERIA).map(({ component }) => component))].map((component) => ({
    id: component,
    floor: component === 'scene-kit-correctness' ? 12.5 : null,
    points_awarded: component === 'scene-kit-correctness' && belowFloor ? 10 : 15,
    subcomponents: [{
      id: `${component}-all`,
      job: null,
      criteria: Object.entries(CRITERIA).filter(([, value]) => value.component === component)
        .map(([id, value]) => ({ id, verdict: spec[id].verdict, points_possible: value.points, fallback_job: value.job })),
    }],
  }))
  await writeFile(join(runDir, 'phases/score.json'), JSON.stringify({
    rubrics: { automated: { version: '15.0.0', sha256: 'f'.repeat(64) } },
    components, gates: [{ id: 'verification-sample-outline', verdict: gate }],
    automated_pass: pass, automated_subtotal: { points: 50 },
  }))
  for (const job of new Set(Object.values(CRITERIA).map(({ job }) => job).filter(Boolean))) {
    const ids = Object.keys(CRITERIA).filter((id) => CRITERIA[id].job === job)
    const record = { protocol: 'cross-family-panel-v2', job, criteria: ids, order: ['pass', 'fail'], fallback_ids: [],
      votes: [], checks: [], rulings: [], samples: [] }
    for (const id of ids) {
      const { seats = ['pass', 'pass', 'pass'], disputed = [], checks = [], ruling = null } = spec[id]
      record.votes.push(...seats.map((verdict, index) => ({ id, verdict, panel_index: index, family: index === 0 ? 'claude' : 'codex',
        rationale: `free text ${name}`, ...(disputed.includes(index) ? { disputed: true, contradiction: { rationale: `audit ${name}` } } : {}) })))
      record.checks.push(...checks.map(([index, classification]) => ({ id, stage: 'contradiction-check', panel_index: index, classification, rationale: `check ${name}` })))
      if (ruling) record.rulings.push({ id, vote: ruling, result: { id, verdict: ruling } })
    }
    await writeFile(join(runDir, `phases/judges/${job}.json`), JSON.stringify(record))
  }
  return runDir
}

const stable = {
  A: { verdict: 'pass', disputed: [1], checks: [[1, 'insufficient']] },
  B: { verdict: 'pass', seats: ['pass', 'pass', 'fail'] },
  C: { verdict: 'pass', seats: ['pass', 'fail', 'fail'], ruling: 'pass' },
  D: { verdict: 'pass' },
  E: { verdict: 'pass', seats: ['pass', 'pass', 'fail'] },
  F: { verdict: 'pass' },
}
const flipped = {
  // The regression: identical seats whose effective votes differ through a check.
  A: { verdict: 'fail', disputed: [1], checks: [[1, 'confirmed']], ruling: 'fail' },
  B: { verdict: 'fail', seats: ['fail', 'fail', 'pass'] },
  C: { verdict: 'fail', seats: ['fail', 'fail', 'fail'] },
  // A check, and so a decider, present in only this rescore.
  D: { verdict: 'fail', disputed: [2], checks: [[2, 'confirmed']], ruling: 'fail' },
  E: { verdict: 'fail', seats: ['fail', 'fail', 'pass'] },
  F: { verdict: 'fail' },
}

test('a decider ruling or decider audit present in only one record is a settlement-side difference', () => {
  const seats = votes(USABLE, ['pass', 'fail', 'fail'])
  const plain = { order: ['pass', 'fail'], votes: seats, checks: [], rulings: [] }
  const ruled = { ...plain, rulings: [{ id: USABLE, vote: 'fail', result: { verdict: 'fail' } }],
    decider: { audit_results: [{ id: USABLE, criterion: USABLE, cycle: 'initial', part: 'rows-1', classification: 'confirmed' }],
      contradiction_checks: [{ id: USABLE, criterion: USABLE, cycle: 'initial', part: 'completeness', classification: 'insufficient' }] } }
  const [left, right] = [plain, ruled].map((record) => criterionLayers(record, USABLE))
  assert.deepEqual(left.seats, right.seats)
  assert.deepEqual(left.effective, right.effective)
  assert.equal(left.ruling, null)
  assert.deepEqual(right.ruling, { vote: 'fail', verdict: 'fail' })
  assert.deepEqual(right.checks.filter(({ key }) => /^(span-audit|ruling-check):/.test(key)),
    [{ key: 'ruling-check:initial:completeness', classification: 'insufficient' }, { key: 'span-audit:initial:rows-1', classification: 'confirmed' }])
  assert.equal(classifyFlip({ seats: false, checks: true, effective: false, ruling: true }), 'settlement')
})

test('flip attribution separates settlement, seat noise and mixed flips from the four recorded layers', async () => {
  const base = await makeTempDir(join(tmpdir(), 'and-scene-flips-'))
  const one = await loadRescore(await rescoreDir(base, 'r1', stable), 'r1')
  const two = await loadRescore(await rescoreDir(base, 'r2', flipped, { gate: 'fail', belowFloor: true, pass: false }), 'r2')

  const layersA = [one, two].map(({ judges }) => criterionLayers(judges['scene-kit'], 'A'))
  assert.deepEqual(layersA[0].seats, layersA[1].seats)
  assert.notDeepEqual(layersA[0].effective, layersA[1].effective)

  const pair = comparePair(one, two)
  const flips = Object.fromEntries(pair.flips.map((flip) => [flip.criterion, flip]))
  assert.equal(flips.A.class, 'settlement')
  assert.deepEqual(flips.A.differs, { seats: false, checks: true, effective: true, ruling: true })
  assert.equal(flips.B.class, 'seat-noise')
  assert.deepEqual(flips.B.differs, { seats: true, checks: false, effective: true, ruling: false })
  assert.equal(flips.C.class, 'mixed')
  assert.deepEqual(flips.C.differs, { seats: true, checks: false, effective: true, ruling: true })
  assert.equal(flips.D.class, 'settlement')
  assert.equal(flips.D.differs.checks, true)
  assert.equal(flips.E.class, 'seat-noise')
  assert.equal(flips.F.class, 'deterministic')
  assert.equal(pair.flipped_points, 3.5)
  assert.equal(pair.target_met, false)
  assert.deepEqual(pair.by_class, { settlement: 2, 'seat-noise': 0.5, mixed: 1, deterministic: 0, unattributed: 0 })
  assert.equal(pair.engineering_flipped_points, 1.5)
  assert.deepEqual(pair.engineering_by_class, { settlement: 0, 'seat-noise': 0.5, mixed: 0, deterministic: 1, unattributed: 0 })
  assert.deepEqual(pair.changes.gates, [{ id: 'verification-sample-outline', verdicts: ['pass', 'fail'] }])
  assert.deepEqual(pair.changes.floors, [{ component: 'scene-kit-correctness', below_floor: [false, true] }])
  assert.deepEqual(pair.changes.eligibility.automated_pass, [true, false])

  assert.equal(classifyFlip({ seats: false, checks: false, effective: false, ruling: false }), 'unattributed')
})

test('opposing flips never cancel, and disagreement counts carry their denominators', async () => {
  const base = await makeTempDir(join(tmpdir(), 'and-scene-flips-rep-'))
  const r1 = await loadRescore(await rescoreDir(base, 'r1', stable), 'r1')
  const r2 = await loadRescore(await rescoreDir(base, 'r2', { ...stable, B: { verdict: 'fail', seats: ['fail', 'fail', 'pass'] } }), 'r2')
  const r3 = await loadRescore(await rescoreDir(base, 'r3', { ...stable, A: flipped.A }), 'r3')
  const rep = compareRep('baseline-1', [r1, r2, r3])
  // r2 -> r3 turns A pass -> fail and B fail -> pass: 1.5 flipped points, not a net 0.5.
  assert.deepEqual(rep.pairs.map(({ pair, flipped_points: points }) => [pair.join('/'), points]), [['r1/r2', 0.5], ['r1/r3', 1], ['r2/r3', 1.5]])
  const counts = Object.fromEntries(rep.disagreements.map(({ criterion, disagreements, pairs }) => [criterion, `${disagreements}/${pairs}`]))
  assert.deepEqual(counts, { A: '2/3', B: '2/3', C: '0/3', D: '0/3', E: '0/3', F: '0/3' })
  assert.ok(rep.disagreements.filter(({ engineering }) => engineering).every(({ pairs }) => pairs === 3))
})

test('the blocker sums settlement and mixed points for the named rep, excluding engineering quality', async () => {
  const base = await makeTempDir(join(tmpdir(), 'and-scene-flips-blocker-'))
  const e78 = [await rescoreDir(base, 'e78-a', stable), await rescoreDir(base, 'e78-b', flipped)]
  const noisy = [await rescoreDir(base, 'base-a', stable),
    await rescoreDir(base, 'base-b', { ...stable, B: { verdict: 'fail', seats: ['fail', 'fail', 'pass'] }, E: flipped.E, F: flipped.F })]
  const load = (dirs) => Promise.all(dirs.map((dir) => loadRescore(dir, dir)))
  const blocked = blockerCheck(compareRep('e78-rep-2', await load(e78)))
  assert.equal(blocked.pairs[0].settlement_and_mixed_points, 3)
  assert.equal(blocked.blocked, true)
  // Seat noise and engineering-quality flips never block.
  const quiet = blockerCheck(compareRep('baseline-1', await load(noisy)))
  assert.equal(quiet.pairs[0].settlement_and_mixed_points, 0)
  assert.equal(quiet.blocked, false)
  const engineering = [await rescoreDir(base, 'eq-a', { ...stable, E: { verdict: 'pass', disputed: [1], checks: [[1, 'insufficient']] } }),
    await rescoreDir(base, 'eq-b', { ...stable, E: { verdict: 'fail', disputed: [1], checks: [[1, 'confirmed']], ruling: 'fail' } })]
  const eqOnly = blockerCheck(compareRep('e78-rep-2', await load(engineering)))
  assert.equal(eqOnly.pairs[0].settlement_and_mixed_points, 0)
  assert.equal(eqOnly.blocked, false)

  // The rep that counts is an input to the command, never a hard-coded run.
  const cli = (args) => spawnSync(process.execPath, [flipScript, ...args], { encoding: 'utf8' })
  const named = cli(['--rep', 'e78-rep-2', ...e78, '--rep', 'baseline-1', ...noisy, '--blocker-rep', 'e78-rep-2'])
  assert.equal(named.status, 1, named.stderr)
  assert.match(named.stdout, /MERGE BLOCKED/)
  assert.match(named.stdout, /A: pass -> fail \(1\) settlement; differs: checks\+effective\+ruling/)
  assert.match(named.stdout, /E \[engineering\]: 1\/1/)
  const other = cli(['--rep', 'e78-rep-2', ...e78, '--rep', 'baseline-1', ...noisy, '--blocker-rep', 'baseline-1'])
  assert.equal(other.status, 0, other.stderr)
  assert.match(other.stdout, /not blocked/)
  const unnamed = cli(['--rep', 'e78-rep-2', ...e78, '--blocker-rep', 'missing'])
  assert.equal(unnamed.status, 2)
  assert.match(unnamed.stderr, /names no --rep/)
})
