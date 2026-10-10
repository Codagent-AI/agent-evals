// A partial settlement counterfactual for recorded cross-family-panel-v1 judging.
//
// The recorded v1 judging records keep only the decider's re-cited verdicts.
// The decider's first verdicts, before any re-cite, survive only in the raw
// `judge-claude` event logs. Because a v2 re-cite can never change a verdict,
// the shipped settlement can be applied to those first verdicts with no model
// call: the v2 `effective()` route and the immutable re-cite rule, through the
// pure settlement functions. It cannot model what v2 would newly ask a model —
// confirmed-contradiction routes the record never sent to the decider, audits of
// decider fails, auditor citations in check material, or the re-cite cycle's
// own audit — so its output is labelled a partial counterfactual.
//
// Raw-log parser contract (`<run>/.runtime/judge-claude/<NN>-<job>.events.jsonl`):
// - each file is one Claude invocation, NN its sequence within the run; every
//   line is one JSON event; the `system`/`init` event names the model, and the
//   `result` event carries the parsed `structured_output`;
// - a decider verdict call is a file of the job whose model is the record's
//   decider model and whose `structured_output.results` all carry a `verdict`
//   (span audits and contradiction checks carry a `classification` instead);
// - those calls, in sequence order, are the record's decider `tiebreak` and
//   `tiebreak-recite` attempts in their recorded order, so their counts must
//   agree; the first successful `tiebreak` attempt of each batch holds the
//   first verdicts and spans;
// - the first verdicts must name exactly the record's decider criteria, every
//   audited ruling must have been a pass, and a ruling the record never
//   re-cited must equal its recorded verdict and spans;
// - a logged span path is the model's raw citation: a judge working from the
//   neutral root may prefix it with `source/` or `./`, which the harness strips
//   before recording it (`inventoryPath`), so spans are compared, and replayed,
//   without that prefix.
// A job with no log file at all falls back to reconstruction. Any other
// departure — an unparseable line, a missing event, a criterion, model, or
// attempt count that does not match — is an error and never a fallback.
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { resolvePanel } from '../../../lib/panel-judging/panel.mjs'
import { auditState, tiebreakDecisions } from '../../../lib/panel-judging/protocol.mjs'
import { rubricCriteria } from './rubric.mjs'

export const REPLAY_HEADER = 'partial settlement counterfactual'
export const REPLAY_EXCLUSIONS = 'excludes confirmed-contradiction routing, fail audits, auditor citations and any new model response'
const SOURCE_PROTOCOL = 'cross-family-panel-v1'
const DECIDER_STAGES = new Set(['tiebreak', 'tiebreak-recite'])

export class ReplayInputError extends Error {}

const fail = (message) => { throw new ReplayInputError(message) }
// A cited path as the harness records it: without the neutral root's prefix.
const recordedPath = (path) => String(path).replace(/^\.\//, '').replace(/^source\//, '')
const spanKey = (citations) => JSON.stringify((citations ?? []).map((span) => (typeof span === 'object' && span !== null
  ? [recordedPath(span.path), span.start_line, span.end_line] : span)))

async function isDirectory(path) {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false
}

// Every recorded run: a directory holding `phases/judges/`.
export async function findRecordedRuns(root) {
  const runs = []
  const visit = async (directory) => {
    if (await isDirectory(join(directory, 'phases/judges'))) {
      runs.push(relative(root, directory).split(sep).join('/') || '.')
      return
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(join(directory, entry.name))
    }
  }
  await visit(root)
  return runs.sort()
}

// The run's raw Claude logs by job, each parsed or rejected as malformed.
export async function readRawLogs(directory) {
  const logs = new Map()
  if (!directory || !await isDirectory(directory)) return logs
  for (const name of (await readdir(directory)).sort()) {
    const match = /^(\d+)-(.+)\.events\.jsonl$/.exec(name)
    if (!match) continue
    const events = []
    const lines = (await readFile(join(directory, name), 'utf8')).split('\n').filter((line) => line.trim())
    for (const [index, line] of lines.entries()) {
      try {
        events.push(JSON.parse(line))
      } catch {
        fail(`malformed raw judge log ${name}: line ${index + 1} is not JSON`)
      }
    }
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
    const result = events.find((event) => event.type === 'result')
    if (!init || !result) fail(`malformed raw judge log ${name}: it has no ${init ? 'result' : 'init'} event`)
    const job = match[2]
    if (!logs.has(job)) logs.set(job, [])
    logs.get(job).push({ name, sequence: Number(match[1]), model: init.model ?? null, output: result.structured_output ?? null })
  }
  for (const list of logs.values()) list.sort((left, right) => left.sequence - right.sequence)
  return logs
}

// Criteria the v1 decider re-cited: an undecided span audit of a pass.
function recitedCriteria(decider) {
  const recited = (decider.attempts ?? []).some(({ stage, ok }) => stage === 'tiebreak-recite' && ok)
  return new Set(recited ? (decider.audit_results ?? [])
    .filter(({ classification }) => classification === 'insufficient').map(({ id }) => id) : [])
}

function auditedCriteria(decider) {
  return new Set((decider.audit_results ?? []).map(({ id }) => id))
}

// The decider's first verdicts and spans, from the job's raw logs.
export function firstDeciderVotes({ record, logs, run }) {
  const decider = record.decider
  const where = `${run} ${record.job}`
  const model = record.authority?.decider?.model
  if (!model) fail(`${where}: the judging record does not name its decider model`)
  const calls = logs.filter(({ model: used, output }) => used === model && Array.isArray(output?.results)
    && output.results.length > 0 && output.results.every((result) => typeof result?.verdict === 'string'))
  const attempts = (decider.attempts ?? []).filter(({ stage }) => DECIDER_STAGES.has(stage))
  if (calls.length !== attempts.length) {
    fail(`${where}: ${calls.length} decider verdict logs do not match the ${attempts.length} recorded decider attempts`)
  }
  const firsts = new Map()
  attempts.forEach((attempt, index) => {
    const batch = attempt.batch ?? null
    if (attempt.stage === 'tiebreak' && attempt.ok && !firsts.has(batch)) firsts.set(batch, calls[index])
  })
  if (firsts.size === 0) fail(`${where}: the record has no successful decider attempt`)
  const results = [...firsts.values()].flatMap(({ output }) => output.results)
  const ids = results.map(({ id }) => id)
  const expected = decider.criteria ?? []
  if (new Set(ids).size !== ids.length || ids.length !== expected.length || ids.some((id) => !expected.includes(id))) {
    fail(`${where}: the first decider log names ${ids.join(', ')}, not the recorded decider criteria ${expected.join(', ')}`)
  }
  const recorded = new Map((decider.results ?? []).map((result) => [result.id, result]))
  const recited = recitedCriteria(decider)
  const audited = auditedCriteria(decider)
  for (const result of results) {
    if (!record.verdicts?.includes(result.verdict)) fail(`${where}: the first decider verdict for ${result.id} is not on the job's scale`)
    if (!Array.isArray(result.citations) || result.citations.some((span) => typeof span?.path !== 'string'
      || !Number.isInteger(span.start_line) || !Number.isInteger(span.end_line))) {
      fail(`${where}: the first decider ruling on ${result.id} does not cite line spans`)
    }
    if (audited.has(result.id) && result.verdict !== 'pass') {
      fail(`${where}: the record audited ${result.id} as a pass, but its first decider log rules ${result.verdict}`)
    }
    const kept = recorded.get(result.id)
    if (!recited.has(result.id) && (kept?.verdict !== result.verdict || spanKey(kept?.citations) !== spanKey(result.citations))) {
      fail(`${where}: the first decider log for ${result.id} does not match its recorded, never re-cited ruling`)
    }
  }
  return {
    source: 'replay',
    logs: [...firsts.values()].map(({ name }) => name),
    results: expected.map((id) => results.find((result) => result.id === id))
      .map((result) => ({ ...result, rationale: result.rationale ?? '', evidence: result.evidence ?? [],
        citations: result.citations.map((span) => ({ ...span, path: recordedPath(span.path) })) })),
  }
}

// Without raw logs the first verdicts are inferred: v1 audited and re-cited
// only passes, so an audited ruling was first a pass, and any other ruling
// was never re-cited. Re-cited spans stand in for the lost first spans.
export function inferFirstDeciderVotes(record) {
  const audited = auditedCriteria(record.decider)
  return {
    source: 'reconstruction',
    logs: [],
    results: (record.decider.results ?? []).map((result) => (audited.has(result.id) ? { ...result, verdict: 'pass' } : result)),
  }
}

// The v2 ruling on each first verdict. The v1 span audit of a first pass is
// that ruling's initial audit cycle; a fail was never audited, and the re-cite
// cycle an undecided audit leads to is not modelled, so both stand.
function settleDecider(record, first) {
  const decider = record.decider
  const audited = auditedCriteria(decider)
  const passes = first.results.filter(({ id, verdict }) => verdict === 'pass' && audited.has(id)).map(({ id }) => id)
  const replayed = {
    results: first.results,
    settlement: Object.fromEntries(passes.map((id) => [id, { cycles: [{ cycle: 'initial', expected_parts: [0] }], settled_cycle: 'initial' }])),
    audit_results: (decider.audit_results ?? []).filter(({ id }) => passes.includes(id))
      .map((audit) => ({ ...audit, criterion: audit.id, cycle: 'initial', part: 0 })),
    contradiction_checks: (decider.contradiction_checks ?? []).filter(({ id }) => passes.includes(id))
      .map((check) => ({ ...check, criterion: check.id, cycle: 'initial', part: 0 })),
  }
  const outcomes = new Map()
  const notes = new Map()
  for (const { id, verdict } of first.results) {
    if (!passes.includes(id)) {
      outcomes.set(id, { state: 'unconfirmed', parts: [] })
      notes.set(id, verdict === 'pass' ? 'no recorded span audit; the first pass stands' : 'fail audit not modelled; the first fail stands')
      continue
    }
    let state
    try {
      state = auditState(replayed, id, { cycle: 'initial' })
    } catch (error) {
      fail(`${record.job} ${id}: the recorded span audit cannot settle: ${error.message}`)
    }
    outcomes.set(id, state)
    notes.set(id, state.state === 'undecided'
      ? 'undecided span audit; the immutable re-cite keeps the first pass (its audit is not modelled)'
      : `span audit ${state.state}`)
  }
  const spans = new Map(first.results.map(({ id, citations }) => [id, citations ?? []]))
  const decisions = tiebreakDecisions({ results: first.results, spans, outcomes, fallbackIds: record.fallback_ids ?? [] })
  return {
    rulings: decisions.map((result, index) => ({ id: result.id, vote: first.results[index].verdict, result })),
    notes,
  }
}

const isRulingMissing = (error) => /missing or invalid decider ruling/.test(error?.message ?? '')

// One job's criteria, settled under v2 from the recorded votes and checks.
export function replayJob({ record, first = null, weights, run = '.' }) {
  if (record.protocol !== SOURCE_PROTOCOL) fail(`${run} ${record.job}: the replay reads ${SOURCE_PROTOCOL} records, not ${record.protocol}`)
  const { rulings, notes } = record.decider && first ? settleDecider(record, first) : { rulings: [], notes: new Map() }
  const firstVotes = new Map((first?.results ?? []).map((result) => [result.id, result]))
  return record.criteria.map((id) => {
    const recorded = (record.results ?? []).find((result) => result.id === id)
    const settle = (withRulings) => resolvePanel({
      criteria: [id], order: record.order, votes: record.votes, checks: record.checks ?? [],
      rulings: withRulings, fallback_ids: record.fallback_ids ?? [], line_cited: true,
    }).results[0]
    let settled = null
    let note = null
    try {
      settled = settle([])
    } catch (error) {
      if (!isRulingMissing(error)) fail(`${run} ${record.job} ${id}: ${error.message}`)
      const ruling = rulings.filter((entry) => entry.id === id)
      if (ruling.length === 0) {
        note = 'v2 routes this criterion to a decider the recorded run never asked; the recorded verdict is kept'
      } else {
        try {
          settled = settle(ruling)
        } catch (inner) {
          fail(`${run} ${record.job} ${id}: ${inner.message}`)
        }
        note = notes.get(id) ?? null
      }
    }
    const weight = weights.get(id) ?? null
    const points = (verdict) => (weight === null ? null : verdict === 'pass' ? weight : 0)
    const verdict = settled?.verdict ?? recorded?.verdict ?? null
    const basis = settled ? settled.basis : 'not-modelled'
    return {
      run,
      job: record.job,
      criterion: id,
      old: { verdict: recorded?.verdict ?? null, basis: recorded?.basis ?? null, points: points(recorded?.verdict) },
      new: { verdict, basis, points: points(verdict) },
      weight,
      ...(firstVotes.has(id) ? {
        first_vote: { verdict: firstVotes.get(id).verdict, citations: firstVotes.get(id).citations, source: first.source },
      } : {}),
      changed: verdict !== (recorded?.verdict ?? null),
      note: weight === null ? [note, 'not in the current rubric; no points'].filter(Boolean).join('; ') : note,
    }
  })
}

const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0)

export function replayTotals(rows) {
  const changed = rows.filter(({ changed }) => changed)
  return {
    old_points: sum(rows.map(({ old }) => old.points)),
    new_points: sum(rows.map((row) => row.new.points)),
    delta: sum(rows.map((row) => row.new.points)) - sum(rows.map(({ old }) => old.points)),
    changed_criteria: changed.length,
    changed_points: sum(changed.map(({ weight }) => weight)),
  }
}

// Replays every recorded run under `recordsDir`. `rawLogsDir` is the extracted
// raw-log archive, or null when the archive is absent.
export async function replaySettlement({ recordsDir, rawLogsDir = null, rubric }) {
  const weights = new Map(rubricCriteria(rubric.rubric).map(({ id, criterion_points: points }) => [id, points]))
  const runs = []
  for (const run of await findRecordedRuns(recordsDir)) {
    const judgesDir = join(recordsDir, run, 'phases/judges')
    const logs = rawLogsDir ? await readRawLogs(join(rawLogsDir, run, '.runtime/judge-claude')) : new Map()
    const rows = []
    const reconstructed = []
    for (const name of (await readdir(judgesDir)).filter((file) => file.endsWith('.json')).sort()) {
      let record
      try {
        record = JSON.parse(await readFile(join(judgesDir, name), 'utf8'))
      } catch (error) {
        fail(`${run} ${name}: the judging record is not valid JSON: ${error.message}`)
      }
      if (!Array.isArray(record.votes) || !Array.isArray(record.criteria)) continue
      let first = null
      if (record.decider) {
        const jobLogs = logs.get(record.job) ?? []
        if (jobLogs.length === 0) {
          first = inferFirstDeciderVotes(record)
          reconstructed.push(record.job)
        } else {
          first = firstDeciderVotes({ record, logs: jobLogs, run })
        }
      }
      rows.push(...replayJob({ record, first, weights, run }))
    }
    runs.push({ run, label: reconstructed.length > 0 ? 'reconstruction' : 'replay', reconstructed, rows, totals: replayTotals(rows) })
  }
  if (runs.length === 0) fail('the judging-records archive holds no phases/judges directory')
  return {
    header: REPLAY_HEADER,
    label: runs.some(({ label }) => label === 'reconstruction') ? 'reconstruction' : 'replay',
    raw_logs: rawLogsDir ? 'present' : 'absent',
    exclusions: REPLAY_EXCLUSIONS,
    rubric: { version: rubric.version, sha256: rubric.sha256 },
    runs,
  }
}

const formatPoints = (value) => (value === null || value === undefined ? '-' : String(Number(value.toFixed(6))))

export function renderReplay(report) {
  const lines = [
    `${report.header}: ${report.label}`,
    report.exclusions,
    `first decider votes: ${report.raw_logs === 'present' ? 'raw judge-claude logs' : 'inferred (raw-log archive absent)'}`,
    `points: automated rubric ${report.rubric.version} weights`,
  ]
  for (const run of report.runs) {
    lines.push('', `run ${run.run}: ${run.label}${run.reconstructed.length ? ` (first votes inferred for ${run.reconstructed.join(', ')})` : ''}`)
    lines.push(['job', 'criterion', 'old', 'old basis', 'new', 'new basis', 'points', 'note'].join('\t'))
    for (const row of run.rows) {
      lines.push([row.job, row.criterion, row.old.verdict ?? '-', row.old.basis ?? '-', row.new.verdict ?? '-', row.new.basis ?? '-',
        `${formatPoints(row.old.points)} -> ${formatPoints(row.new.points)}`, row.note ?? ''].join('\t'))
    }
    const totals = run.totals
    lines.push(`total: old ${formatPoints(totals.old_points)}, new ${formatPoints(totals.new_points)}, delta ${totals.delta >= 0 ? '+' : ''}${formatPoints(totals.delta)}; changed ${totals.changed_criteria} criteria (${formatPoints(totals.changed_points)} points)`)
  }
  return `${lines.join('\n')}\n`
}
