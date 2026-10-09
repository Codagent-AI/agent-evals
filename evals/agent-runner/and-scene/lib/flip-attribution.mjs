// Mechanical attribution of verdict flips between rescores of the same code.
//
// For every criterion whose verdict differs between two rescores, four
// recorded layers are compared separately: the original seat verdicts, the
// audits and checks, the effective votes, and the decider ruling. A check or
// ruling present in only one rescore is a difference. Each flip is then
//   - settlement: identical seat verdicts, but a check, effective vote or
//     ruling differs;
//   - seat-noise: the seat verdicts differ and every check and ruling is the same;
//   - mixed: both differ.
// The labels say where the recorded outputs differ, not which difference
// caused the flip. Flipped points sum every changed verdict's points, so
// opposing flips never cancel; engineering quality is reported separately.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { hashJson, readJson } from './persistence.mjs'

export const FLIP_CLASSES = ['settlement', 'seat-noise', 'mixed', 'deterministic', 'unattributed']
export const ENGINEERING_COMPONENT = 'engineering-quality'
export const FLIP_TARGET_POINTS = 1.0
export const BLOCKER_POINTS = 1.0

// Mirrors the v2 effective() rule in evals/lib/panel-judging/panel.mjs, which
// does not export it: a disputed vote turns only on a confirmed contradiction
// check, and an undecided check leaves it standing except a browser-fallback
// pass, which stays disputed.
function effectiveVote(vote, checks, order, fallbackIds) {
  if (!vote.disputed) return { verdict: vote.verdict, disputed: false, turned: false }
  const check = checks.find((entry) => entry.stage === 'contradiction-check' && entry.id === vote.id && entry.panel_index === vote.panel_index)
  if (!check) return { verdict: vote.verdict, disputed: true, turned: false }
  if (check.classification === 'confirmed') {
    const verdict = vote.verdict === order[0] ? order.at(-1) : vote.verdict === order.at(-1) ? order[0] : vote.verdict
    return { verdict, disputed: false, turned: true }
  }
  if (check.classification === 'insufficient' && vote.verdict === order[0] && fallbackIds.includes(vote.id)) {
    return { verdict: vote.verdict, disputed: true, turned: false }
  }
  return { verdict: vote.verdict, disputed: false, turned: false }
}

const byKey = (left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)

// The four recorded layers of one criterion in one judging record. Free text
// is excluded: only who voted what, which audit or check ran with which
// outcome, and what the decider ruled.
export function criterionLayers(record, id) {
  const order = record.order ?? ['pass', 'fail']
  const fallbackIds = record.fallback_ids ?? []
  const votes = (record.votes ?? []).filter((vote) => vote.id === id).sort((left, right) => left.panel_index - right.panel_index)
  const checks = record.checks ?? []
  const audits = [
    ...votes.map((vote) => ({ key: `seat-audit:${vote.panel_index}`, disputed: Boolean(vote.disputed) })),
    ...(record.samples ?? []).flatMap((sample, index) => (sample?.audit_results ?? [])
      .filter((audit) => audit.id === id)
      .map((audit) => ({ key: `seat-audit-result:${index}`, classification: audit.classification ?? null }))),
    ...checks.filter((check) => check.id === id)
      .map((check) => ({ key: `${check.stage}:${check.panel_index}`, classification: check.classification })),
    ...(record.decider?.audit_results ?? []).filter((audit) => (audit.criterion ?? audit.id) === id)
      .map((audit) => ({ key: `span-audit:${audit.cycle ?? 'initial'}:${audit.part ?? 0}`, classification: audit.classification })),
    ...(record.decider?.contradiction_checks ?? []).filter((check) => (check.criterion ?? check.id) === id)
      .map((check) => ({ key: `ruling-check:${check.cycle ?? 'initial'}:${check.part ?? 0}`, classification: check.classification })),
  ].sort(byKey)
  const ruling = (record.rulings ?? []).find((entry) => entry.id === id) ?? null
  return {
    seats: votes.map((vote) => ({ panel_index: vote.panel_index, family: vote.family, verdict: vote.verdict })),
    checks: audits,
    effective: votes.map((vote) => ({ panel_index: vote.panel_index, ...effectiveVote(vote, checks, order, fallbackIds) })),
    ruling: ruling ? { vote: ruling.vote ?? ruling.verdict, verdict: ruling.result?.verdict ?? ruling.verdict } : null,
  }
}

export function classifyFlip(differs) {
  const settlementSide = differs.checks || differs.effective || differs.ruling
  if (!differs.seats && settlementSide) return 'settlement'
  if (differs.seats && !differs.checks && !differs.ruling) return 'seat-noise'
  if (differs.seats) return 'mixed'
  return 'unattributed'
}

// A rescore's scored criteria, gates, floors and eligibility, with the
// judging record of each judged criterion.
export async function loadRescore(runDir, label = runDir) {
  const score = await readJson(join(runDir, 'phases/score.json'), null)
  if (!score) throw new Error(`${runDir} has no phases/score.json`)
  const judges = {}
  const judgesDir = join(runDir, 'phases/judges')
  for (const name of (await readdir(judgesDir).catch(() => [])).filter((file) => file.endsWith('.json'))) {
    const record = JSON.parse(await readFile(join(judgesDir, name), 'utf8'))
    judges[record.job ?? name.slice(0, -'.json'.length)] = record
  }
  return { label, runDir, score, judges }
}

function scoredCriteria(score) {
  const criteria = new Map()
  for (const component of score.components ?? []) {
    for (const subcomponent of component.subcomponents ?? []) {
      for (const criterion of subcomponent.criteria ?? []) {
        criteria.set(criterion.id, {
          id: criterion.id,
          component: component.id,
          job: subcomponent.job ?? criterion.fallback_job ?? null,
          verdict: criterion.verdict ?? null,
          points: criterion.points_possible ?? 0,
        })
      }
    }
  }
  return criteria
}

function judgingRecord(rescore, id) {
  return Object.values(rescore.judges).find((record) => (record.criteria ?? []).includes(id)) ?? null
}

const same = (left, right) => hashJson(left ?? null) === hashJson(right ?? null)
const sum = (values) => values.reduce((total, value) => total + value, 0)

function belowFloor(score) {
  return Object.fromEntries((score.components ?? []).filter(({ floor }) => floor !== null && floor !== undefined)
    .map(({ id, floor, points_awarded: awarded }) => [id, awarded < floor]))
}

export function comparePair(a, b) {
  if (a.score.rubrics?.automated?.sha256 !== b.score.rubrics?.automated?.sha256) {
    throw new Error(`${a.label} and ${b.label} were scored under different automated rubrics`)
  }
  const left = scoredCriteria(a.score)
  const right = scoredCriteria(b.score)
  const flips = []
  const agreement = []
  const unavailable = []
  for (const [id, first] of left) {
    const second = right.get(id)
    if (!second || first.verdict === null || second.verdict === null) {
      unavailable.push(id)
      continue
    }
    const engineering = first.component === ENGINEERING_COMPONENT
    agreement.push({ criterion: id, component: first.component, engineering, agree: first.verdict === second.verdict })
    if (first.verdict === second.verdict) continue
    const records = [judgingRecord(a, id), judgingRecord(b, id)]
    let differs = null
    let flipClass = 'deterministic'
    if (records[0] && records[1]) {
      const layers = records.map((record) => criterionLayers(record, id))
      differs = {
        seats: !same(layers[0].seats, layers[1].seats),
        checks: !same(layers[0].checks, layers[1].checks),
        effective: !same(layers[0].effective, layers[1].effective),
        ruling: !same(layers[0].ruling, layers[1].ruling),
      }
      flipClass = classifyFlip(differs)
    }
    flips.push({
      criterion: id, component: first.component, job: first.job, engineering,
      points: Math.max(first.points, second.points), verdicts: [first.verdict, second.verdict],
      differs, class: flipClass,
    })
  }
  const byClass = (list) => Object.fromEntries(FLIP_CLASSES.map((name) => [name, sum(list.filter((flip) => flip.class === name).map(({ points }) => points))]))
  const scored = flips.filter(({ engineering }) => !engineering)
  const engineeringFlips = flips.filter(({ engineering }) => engineering)
  const flipped = sum(scored.map(({ points }) => points))
  const gatesA = new Map((a.score.gates ?? []).map((gate) => [gate.id, gate.verdict ?? null]))
  const gatesB = new Map((b.score.gates ?? []).map((gate) => [gate.id, gate.verdict ?? null]))
  const floorsA = belowFloor(a.score)
  const floorsB = belowFloor(b.score)
  return {
    pair: [a.label, b.label],
    flips,
    flipped_points: flipped,
    engineering_flipped_points: sum(engineeringFlips.map(({ points }) => points)),
    by_class: byClass(scored),
    engineering_by_class: byClass(engineeringFlips),
    target_met: flipped <= FLIP_TARGET_POINTS,
    changes: {
      gates: [...new Set([...gatesA.keys(), ...gatesB.keys()])].filter((id) => gatesA.get(id) !== gatesB.get(id))
        .map((id) => ({ id, verdicts: [gatesA.get(id) ?? null, gatesB.get(id) ?? null] })),
      floors: [...new Set([...Object.keys(floorsA), ...Object.keys(floorsB)])].filter((id) => floorsA[id] !== floorsB[id])
        .map((id) => ({ component: id, below_floor: [floorsA[id] ?? null, floorsB[id] ?? null] })),
      eligibility: { automated_pass: [a.score.automated_pass ?? null, b.score.automated_pass ?? null],
        changed: (a.score.automated_pass ?? null) !== (b.score.automated_pass ?? null) },
      automated_subtotal: [a.score.automated_subtotal?.points ?? null, b.score.automated_subtotal?.points ?? null],
    },
    agreement,
    unavailable,
  }
}

// Every pair of one rep's rescores, with per-criterion disagreement counts
// over the pairs where both verdicts exist.
export function compareRep(rep, rescores) {
  const pairs = []
  for (let i = 0; i < rescores.length; i += 1) {
    for (let j = i + 1; j < rescores.length; j += 1) pairs.push(comparePair(rescores[i], rescores[j]))
  }
  const counts = new Map()
  for (const pair of pairs) {
    for (const { criterion, component, engineering, agree } of pair.agreement) {
      const entry = counts.get(criterion) ?? { criterion, component, engineering, disagreements: 0, pairs: 0 }
      entry.pairs += 1
      if (!agree) entry.disagreements += 1
      counts.set(criterion, entry)
    }
  }
  return { rep, rescores: rescores.map(({ label }) => label), pairs, disagreements: [...counts.values()] }
}

// The merge blocker: in the named rep, a pair whose settlement and mixed
// points, excluding engineering quality, exceed the limit blocks merge.
export function blockerCheck(repReport, { limit = BLOCKER_POINTS } = {}) {
  const pairs = repReport.pairs.map(({ pair, by_class: classes }) => ({
    pair, settlement_and_mixed_points: classes.settlement + classes.mixed,
  }))
  return { rep: repReport.rep, limit, pairs, blocked: pairs.some(({ settlement_and_mixed_points: points }) => points > limit) }
}

const formatPoints = (value) => String(Number(Number(value).toFixed(6)))

export function renderComparison({ reps, blocker }) {
  const lines = []
  for (const rep of reps) {
    lines.push(`rep ${rep.rep}: ${rep.rescores.join(', ')}`)
    for (const pair of rep.pairs) {
      lines.push(`  pair ${pair.pair.join(' vs ')}: flipped ${formatPoints(pair.flipped_points)} points (target ${FLIP_TARGET_POINTS}: ${pair.target_met ? 'met' : 'missed'}); engineering quality ${formatPoints(pair.engineering_flipped_points)} points`)
      lines.push(`    by class: ${FLIP_CLASSES.map((name) => `${name} ${formatPoints(pair.by_class[name])}`).join(', ')}`)
      lines.push(`    engineering by class: ${FLIP_CLASSES.map((name) => `${name} ${formatPoints(pair.engineering_by_class[name])}`).join(', ')}`)
      for (const flip of pair.flips) {
        const layers = flip.differs
          ? Object.entries(flip.differs).filter(([, value]) => value).map(([name]) => name).join('+') || 'none'
          : 'not judged'
        lines.push(`    ${flip.criterion}${flip.engineering ? ' [engineering]' : ''}: ${flip.verdicts.join(' -> ')} (${formatPoints(flip.points)}) ${flip.class}; differs: ${layers}`)
      }
      const { gates, floors, eligibility } = pair.changes
      lines.push(`    gates changed: ${gates.map(({ id, verdicts }) => `${id} ${verdicts.join('->')}`).join(', ') || 'none'}; floors changed: ${floors.map(({ component }) => component).join(', ') || 'none'}; eligibility ${eligibility.changed ? `changed ${eligibility.automated_pass.join('->')}` : 'unchanged'}`)
      if (pair.unavailable.length) lines.push(`    unavailable: ${pair.unavailable.join(', ')}`)
    }
    lines.push('  per-criterion disagreements (all engineering-quality criteria, and every other criterion that disagreed):')
    for (const entry of rep.disagreements.filter(({ engineering, disagreements }) => engineering || disagreements > 0)) {
      lines.push(`    ${entry.criterion}${entry.engineering ? ' [engineering]' : ''}: ${entry.disagreements}/${entry.pairs}`)
    }
  }
  if (blocker) {
    lines.push(`blocker (${blocker.rep}): ${blocker.pairs.map(({ pair, settlement_and_mixed_points: points }) => `${pair.join(' vs ')} settlement+mixed ${formatPoints(points)}`).join('; ')}`)
    lines.push(blocker.blocked ? `MERGE BLOCKED: settlement and mixed points exceed ${blocker.limit}` : `not blocked: settlement and mixed points within ${blocker.limit}`)
  }
  return `${lines.join('\n')}\n`
}
