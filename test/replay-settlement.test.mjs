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
