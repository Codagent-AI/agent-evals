// Calibration: loading the committed calibration set and the pure aggregation
// of judged repeats into the maintainer report. No model calls happen here;
// calibrate.mjs judges each input through the candidate-run judging phases and
// hands the scored repeats to aggregateCalibration.
//
// Calibration is a maintainer diagnostic. It is never a prerequisite or runtime
// gate for a candidate run, and its report carries `mode: 'calibration'`, which
// publication refuses (publicationEligibility requires mode 'candidate').
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { filesUnder, sha256 } from './files.mjs'
import { rubricSettings } from './rubric.mjs'

export const CALIBRATION_MODE = 'calibration'
export const CALIBRATION_SCHEMA_VERSION = 1
export const MIN_REPEATS = 3
export const DECIDER_RERUNS = 3
const VERDICTS = ['met', 'partial', 'missing']
const VALUE = { met: 1, partial: 0.5, missing: 0 }
const NON_ARTIFACTS = new Set(['expectations.json', 'conversation.jsonl'])
const LISTS = ['removed_items', 'contradicted_items', 'added_scope', 'quality_defects', 'planted_fidelity_contradictions', 'weakened_items', 'collateral_items']

// ---------------------------------------------------------------- loading

async function exists(path) { return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }) }

export function validateExpectations(expectations, { rubric, dirName }) {
  const errors = []
  const where = `calibration input ${dirName}`
  if (!expectations || typeof expectations !== 'object') return [`${where}: expectations.json is not an object`]
  if (typeof expectations.input_id !== 'string' || !expectations.input_id.trim()) errors.push(`${where}: input_id is required`)
  if (!['reference', 'degraded'].includes(expectations.variant)) errors.push(`${where}: variant must be reference or degraded`)
  // Plans receive a score only; an input never predicts a pass or a fail.
  for (const key of ['expected_outcome', 'expected_fail_mark']) if (key in expectations) errors.push(`${where}: ${key} is not allowed: plans receive a score only, with no pass/fail outcome`)
  const graded = new Set([...(rubric?.coverage ?? []).map(x => x.id), ...(rubric?.quality ?? []).map(x => x.id)])
  if (!expectations.expected || typeof expectations.expected !== 'object' || Array.isArray(expectations.expected)) errors.push(`${where}: expected must map graded item ids to verdicts`)
  else for (const [id, verdict] of Object.entries(expectations.expected)) {
    if (rubric && !graded.has(id)) errors.push(`${where}: expected names unknown graded item ${id}`)
    if (!VERDICTS.includes(verdict)) errors.push(`${where}: expected verdict for ${id} must be met, partial, or missing`)
  }
  for (const key of LISTS) if (expectations[key] !== undefined && !Array.isArray(expectations[key])) errors.push(`${where}: ${key} must be a list`)
  const quality = new Set((rubric?.quality ?? []).map(x => x.id))
  for (const [key, allowed, ids] of [['expected_quality', VERDICTS, quality], ['expected_fidelity', ['met', 'missing'], null]]) {
    const map = expectations[key]
    if (map === undefined || map === null) continue
    if (typeof map !== 'object' || Array.isArray(map)) { errors.push(`${where}: ${key} must map criterion ids to verdicts`); continue }
    for (const [id, verdict] of Object.entries(map)) {
      if (ids ? rubric && !ids.has(id) : !id.startsWith('fidelity:')) errors.push(`${where}: ${key} names unknown criterion ${id}`)
      if (!allowed.includes(verdict)) errors.push(`${where}: ${key} verdict for ${id} must be ${allowed.join(', ')}`)
    }
  }
  const coverage = new Set((rubric?.coverage ?? []).map(x => x.id))
  for (const id of expectations.removed_items ?? []) if (rubric && !coverage.has(id)) errors.push(`${where}: removed item ${id} is not a graded coverage item`)
  return errors
}

// One input is a directory holding expectations.json, an optional
// conversation.jsonl, and the collected-layout artifacts. The artifacts may sit
// under `collected/` or directly in the input directory; every other file is an
// artifact, keyed by its path relative to that root.
export async function loadCalibrationInput(dir, { rubric, dirName = dir } = {}) {
  const expectationsPath = join(dir, 'expectations.json')
  if (!await exists(expectationsPath)) throw new Error(`calibration input ${dirName}: missing expectations.json`)
  const expectations = JSON.parse(await readFile(expectationsPath, 'utf8'))
  const errors = validateExpectations(expectations, { rubric, dirName })
  if (errors.length) throw new Error(errors.join('\n'))
  const root = await exists(join(dir, 'collected')) ? join(dir, 'collected') : dir
  const artifacts = {}
  const files = []
  for (const path of await filesUnder(root)) {
    const name = relative(root, path).split('\\').join('/')
    if (root === dir && NON_ARTIFACTS.has(name)) continue
    const bytes = await readFile(path)
    artifacts[name] = bytes.toString('utf8')
    files.push({ path: name, sha256: sha256(bytes) })
  }
  if (!files.length) throw new Error(`calibration input ${dirName}: no artifacts`)
  // Parsed exactly as the judging phases parse a run's conversation.jsonl.
  let conversationText = ''
  const conversationPath = join(dir, 'conversation.jsonl')
  if (await exists(conversationPath)) conversationText = await readFile(conversationPath, 'utf8')
  const conversation = conversationText.split('\n').filter(x => x.trim()).map(JSON.parse)
  const sourceFiles = []
  for (const path of await filesUnder(dir)) sourceFiles.push({ path: relative(dir, path).split('\\').join('/'), sha256: sha256(await readFile(path)) })
  return { input_id: expectations.input_id, dir, expectations: { ...Object.fromEntries(LISTS.map(key => [key, []])), ...expectations },
    artifacts, files, conversation, conversation_text: conversationText, input_hash: sha256(JSON.stringify(sourceFiles)), source_files: sourceFiles }
}

// Manifest entries name inputs as strings or objects ({input_id|id|dir, files}).
// Recorded file hashes are checked against the input directory.
function manifestEntries(manifest) {
  const list = Array.isArray(manifest) ? manifest : Array.isArray(manifest?.inputs) ? manifest.inputs : null
  if (!list) throw new Error('calibration manifest must list inputs')
  return list.map(entry => typeof entry === 'string' ? { dir: entry } : { dir: entry.dir ?? entry.path ?? entry.input_id ?? entry.id, input_id: entry.input_id ?? entry.id ?? null, files: entry.files ?? entry.sha256 ?? null })
}
function recordedHashes(files) {
  if (!files) return []
  if (Array.isArray(files)) return files.map(x => ({ path: x.path, sha256: x.sha256 }))
  return Object.entries(files).map(([path, value]) => ({ path, sha256: typeof value === 'string' ? value : value?.sha256 }))
}

export async function loadCalibrationSet(calibrationDir, { rubric } = {}) {
  if (!await exists(calibrationDir)) throw new Error(`calibration set not found: ${calibrationDir}`)
  const manifestPath = join(calibrationDir, 'manifest.json')
  const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null
  let entries
  if (manifest) entries = manifestEntries(manifest)
  else {
    entries = []
    for (const name of (await readdir(calibrationDir)).sort()) if (name !== 'real-candidates' && (await lstat(join(calibrationDir, name))).isDirectory()) entries.push({ dir: name })
  }
  // Real candidate definitions with maintainer-reviewed verdicts join the set
  // when present; the slot may be empty or hold only documentation.
  const realRoot = join(calibrationDir, 'real-candidates')
  if (await exists(realRoot)) {
    for (const name of (await readdir(realRoot)).sort()) {
      const dir = `real-candidates/${name}`
      if ((await lstat(join(calibrationDir, dir))).isDirectory() && await exists(join(calibrationDir, dir, 'expectations.json')) && !entries.some(x => x.dir === dir)) entries.push({ dir })
    }
  }
  const inputs = []
  for (const entry of entries) {
    if (!entry.dir || entry.dir.includes('..')) throw new Error(`calibration manifest names an invalid input: ${JSON.stringify(entry)}`)
    const input = await loadCalibrationInput(join(calibrationDir, entry.dir), { rubric, dirName: entry.dir })
    if (entry.input_id && entry.input_id !== input.input_id) throw new Error(`calibration input ${entry.dir}: manifest input_id ${entry.input_id} differs from expectations ${input.input_id}`)
    // Manifest paths may be relative to the set (`<dir>/collected/...`) or to the input.
    const recorded = recordedHashes(entry.files).map(x => ({ ...x, path: x.path.startsWith(`${entry.dir}/`) ? x.path.slice(entry.dir.length + 1) : x.path }))
    for (const { path, sha256: hash } of recorded) {
      const actual = input.source_files.find(x => x.path === path)
      if (!actual) throw new Error(`calibration input ${entry.dir}: manifest lists missing file ${path}`)
      if (actual.sha256 !== hash) throw new Error(`calibration input ${entry.dir}: manifest hash mismatch for ${path}`)
    }
    if (recorded.length) for (const file of input.source_files) if (!recorded.some(x => x.path === file.path)) throw new Error(`calibration input ${entry.dir}: file ${file.path} is not in the manifest`)
    inputs.push(input)
  }
  if (!inputs.length) throw new Error('calibration set has no inputs')
  const ids = inputs.map(x => x.input_id)
  if (new Set(ids).size !== ids.length) throw new Error('calibration input ids must be unique')
  return { inputs, manifest_present: Boolean(manifest) }
}

// ---------------------------------------------------------------- aggregation

const stripBasis = basis => String(basis ?? 'unknown').replace(/-(met|partial|missing)$/, '')
const round = (value, places = 4) => Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : value
const rate = (n, d) => d ? round(n / d) : null
const emptyCounts = () => ({ met: 0, partial: 0, missing: 0 })
const withRates = counts => { const total = VERDICTS.reduce((s, v) => s + counts[v], 0); return { counts, total, rates: Object.fromEntries(VERDICTS.map(v => [v, rate(counts[v], total)])) } }
const scoringRecords = scored => (scored.panel_records ?? []).filter(x => x.kind === 'coverage' || x.kind === 'quality')

// Item verdicts of one scored repeat: coverage (a leaked item keeps its judged
// verdict), quality criteria, and fidelity exchanges.
export function itemVerdicts(scored) {
  const map = new Map()
  for (const x of scored.coverage ?? []) map.set(x.id, x.verdict === 'leaked' ? x.coverage_verdict : x.verdict)
  for (const x of scored.quality ?? []) map.set(x.id, x.verdict)
  for (const x of scored.fidelity ?? []) map.set(x.id, x.verdict)
  return map
}

// Every expected verdict of an input: coverage, then quality and fidelity when present.
export function allExpected(expectations) {
  return { ...expectations.expected, ...(expectations.expected_quality ?? {}), ...(expectations.expected_fidelity ?? {}) }
}
const kindOf = id => id.startsWith('quality:') ? 'quality' : id.startsWith('fidelity:') ? 'fidelity' : 'coverage'

export function accuracy(expected, repeats) {
  const confusion = Object.fromEntries(VERDICTS.map(e => [e, emptyCounts()]))
  let compared = 0; let agreed = 0
  const items = Object.entries(expected).map(([id, want]) => {
    const judged = repeats.map(scored => itemVerdicts(scored).get(id) ?? null)
    let agree = 0
    for (const got of judged) {
      if (!got) continue
      compared++; confusion[want][got]++
      if (got === want) { agreed++; agree++ }
    }
    return { id, expected: want, judged, agreement_rate: rate(agree, judged.filter(Boolean).length) }
  })
  const by_kind = {}
  for (const item of items) for (const got of item.judged) {
    if (!got) continue
    const k = by_kind[kindOf(item.id)] ??= { compared: 0, agreed: 0 }
    k.compared++; if (got === item.expected) k.agreed++
  }
  for (const k of Object.values(by_kind)) k.agreement_rate = rate(k.agreed, k.compared)
  return { compared, agreed, agreement_rate: rate(agreed, compared), by_kind, confusion, disagreeing_items: items.filter(x => x.agreement_rate !== 1).map(x => x.id), items }
}

export function stability(repeats) {
  const totals = repeats.map(x => x.total)
  const spread = totals.length ? round(Math.max(...totals) - Math.min(...totals)) : 0
  const maps = repeats.map(itemVerdicts)
  const ids = [...new Set(maps.flatMap(m => [...m.keys()]))]
  const differing = ids.filter(id => new Set(maps.map(m => m.get(id))).size > 1).map(id => ({ id, verdicts: maps.map(m => m.get(id) ?? null) }))
  return { totals, spread, items_judged: ids.length, items_differing: differing.length, disagreement_rate: rate(differing.length, ids.length), differing_items: differing }
}

export function basisShares(repeatsList) {
  const counts = {}
  let total = 0
  for (const scored of repeatsList) for (const { record } of scoringRecords(scored)) for (const result of record.results ?? []) {
    const basis = stripBasis(result.basis); counts[basis] = (counts[basis] ?? 0) + 1; total++
  }
  return { total, counts, shares: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, rate(n, total)])) }
}

// Every panel vote by model family, beside the expected distribution. Votes on
// items with an expectation also give a signed leniency: the mean of (judged
// value - expected value), positive when a family credits more than expected.
export function familyDistribution(entries) {
  const families = {}
  const expectedCounts = emptyCounts()
  for (const { expected = {}, repeats } of entries) {
    for (const want of Object.values(expected)) expectedCounts[want] += repeats.length
    for (const scored of repeats) for (const { record } of scoringRecords(scored)) for (const vote of record.votes ?? []) {
      if (!VERDICTS.includes(vote.verdict)) continue
      const family = families[vote.family] ??= { models: new Set(), all: emptyCounts(), on_expected: emptyCounts(), delta: 0, compared: 0, agreed: 0 }
      family.models.add(vote.model); family.all[vote.verdict]++
      const want = expected[vote.id]
      if (!want) continue
      family.on_expected[vote.verdict]++; family.compared++; family.delta += VALUE[vote.verdict] - VALUE[want]
      if (vote.verdict === want) family.agreed++
    }
  }
  return {
    expected: withRates(expectedCounts),
    families: Object.fromEntries(Object.entries(families).sort().map(([name, f]) => [name, { models: [...f.models].sort(), all_votes: withRates(f.all), votes_on_expected_items: withRates(f.on_expected),
      agreement_rate: rate(f.agreed, f.compared), leniency: f.compared ? round(f.delta / f.compared) : null }])),
  }
}

export function inputScores(repeats) {
  const totals = repeats.map(x => x.total)
  return { per_repeat: repeats.map((x, n) => ({ repeat: n + 1, total: round(x.total), components: Object.fromEntries(Object.entries(x.components ?? {}).map(([k, c]) => [k, round(c.score)])), gates_passed: (x.gates ?? []).every(g => g.passed) })),
    mean: round(totals.reduce((s, x) => s + x, 0) / (totals.length || 1)), min: round(Math.min(...totals)), max: round(Math.max(...totals)) }
}

export function rescoreDiff(inputId, first, second) {
  if (!first || !second) return { input_id: inputId, available: false, reason: 'the designated input needs two judged repeats' }
  const a = itemVerdicts(first); const b = itemVerdicts(second)
  const differing = [...new Set([...a.keys(), ...b.keys()])].filter(id => a.get(id) !== b.get(id)).map(id => ({ id, first: a.get(id) ?? null, second: b.get(id) ?? null }))
  return { input_id: inputId, available: true, totals: [round(first.total), round(second.total)], items_differing: differing.length, differing_items: differing }
}

// reruns: [{ input_id, repeat, job, runs: [{ rulings, checks }] }]; each run is
// one decider re-run on the same recorded panel outputs.
export function deciderFlips(reruns) {
  let pairs = 0; let flips = 0
  const items = []
  for (const entry of reruns) {
    const keyed = new Map()
    entry.runs.forEach((run, n) => {
      for (const [kind, list] of [['decider', run.rulings ?? []], ['dissent-check', run.checks ?? []]]) for (const outcome of list) {
        const key = `${kind}:${outcome.id}:${outcome.panel_index ?? ''}`
        const item = keyed.get(key) ?? { input_id: entry.input_id, repeat: entry.repeat, job: entry.job, id: outcome.id, kind, ...(kind === 'dissent-check' ? { panel_index: outcome.panel_index } : {}), recorded: outcome.recorded, reruns: [], flips: 0 }
        item.reruns[n] = outcome.rerun; pairs++
        if (outcome.flipped) { item.flips++; flips++ }
        keyed.set(key, item)
      }
    })
    items.push(...keyed.values())
  }
  const flipped = items.filter(x => x.flips)
  return { reruns_per_record: Math.max(0, ...reruns.map(x => x.runs.length)), criteria_rerun: items.length, comparisons: pairs, flips, flip_rate: rate(flips, pairs),
    flipped_items: flipped.map(x => ({ input_id: x.input_id, id: x.id, job: x.job, kind: x.kind, recorded: x.recorded, reruns: x.reruns, flips: x.flips })),
    note: 'Decider ruling flips are measured on fixed recorded panel outputs, separately from panel spread across repeats. Flipped items name anchors to sharpen.', items }
}

export function isRestructuredReference(input) {
  return input.input_id.startsWith('restructured') && input.expectations.variant === 'reference'
}

// Weighted coverage the input lost against its own expectations in one repeat.
export function coverageLoss(expected, scored, rubric) {
  const verdicts = itemVerdicts(scored)
  const items = []
  let lost = 0
  for (const criterion of rubric.coverage) {
    const want = expected[criterion.id]
    const got = verdicts.get(criterion.id)
    if (!want || !got) continue
    const loss = criterion.weight * Math.max(0, VALUE[want] - VALUE[got])
    if (loss > 0) { lost += loss; items.push({ id: criterion.id, expected: want, judged: got, weight_lost: loss }) }
  }
  return { lost_weight: round(lost), items }
}

// inputs: [{ input_id, description, expectations, input_hash, repeats: [scored] }]
export function aggregateCalibration({ inputs, rubric, reruns = [], rescoreInput = null, generatedAt = new Date().toISOString(), judgeProfile = null, panelProtocol = null, usage = null, outDir = null }) {
  const settings = rubricSettings(rubric)
  const limits = settings.calibration
  const mandatory = new Set(rubric.coverage.filter(x => x.class === 'mandatory').map(x => x.id))
  const failures = []
  const reference = inputs.find(x => x.input_id === 'reference')
  const perInput = inputs.map(input => {
    const { expectations, repeats } = input
    const scores = inputScores(repeats)
    const stable = stability(repeats)
    const own = []
    for (const id of expectations.removed_items.filter(x => mandatory.has(x))) {
      const metIn = repeats.map((scored, n) => itemVerdicts(scored).get(id) === 'met' ? n + 1 : null).filter(Boolean)
      if (metIn.length) own.push({ code: 'removed-mandatory-undetected', input_id: input.input_id, items: [id], repeats: metIn, message: `${input.input_id}: removed mandatory item ${id} was judged met in repeat ${metIn.join(', ')}` })
    }
    let restructured = null
    if (isRestructuredReference(input)) {
      const losses = repeats.map((scored, n) => ({ repeat: n + 1, ...coverageLoss(expectations.expected, scored, rubric) }))
      const worst = losses.reduce((a, b) => b.lost_weight > a.lost_weight ? b : a)
      restructured = { tolerance_items: limits.restructured_tolerance_items, losses, worst_lost_weight: worst.lost_weight,
        versus_reference: reference ? { reference_mean: inputScores(reference.repeats).mean, restructured_mean: scores.mean, difference: round(inputScores(reference.repeats).mean - scores.mean) } : null }
      if (worst.lost_weight > limits.restructured_tolerance_items) {
        const items = [...new Set(losses.flatMap(x => x.items.map(i => i.id)))]
        own.push({ code: 'restructured-loss-beyond-tolerance', input_id: input.input_id, items, lost_weight: worst.lost_weight, tolerance: limits.restructured_tolerance_items, message: `${input.input_id}: lost ${worst.lost_weight} weighted coverage (tolerance ${limits.restructured_tolerance_items}) in repeat ${worst.repeat}; lost items: ${items.join(', ')}` })
      }
    }
    if (stable.spread > limits.max_spread) {
      const items = stable.differing_items.map(x => x.id)
      own.push({ code: 'spread-beyond-limit', input_id: input.input_id, items, spread: stable.spread, max_spread: limits.max_spread, message: `${input.input_id}: repeated totals differ by ${stable.spread} points (limit ${limits.max_spread}); differing items: ${items.join(', ') || 'none'}` })
    }
    failures.push(...own)
    return { input_id: input.input_id, description: input.description ?? input.expectations.description ?? null, variant: expectations.variant,
      input_hash: input.input_hash, repeats: repeats.length, scores, accuracy: accuracy(allExpected(expectations), repeats), stability: stable,
      basis_shares: basisShares(repeats), family_distribution: familyDistribution([{ expected: { ...expectations.expected, ...(expectations.expected_quality ?? {}) }, repeats }]),
      removed_items: expectations.removed_items, contradicted_items: expectations.contradicted_items, restructured, failures: own }
  })
  const overallAccuracy = perInput.reduce((acc, x) => ({ compared: acc.compared + x.accuracy.compared, agreed: acc.agreed + x.accuracy.agreed }), { compared: 0, agreed: 0 })
  const byKind = {}
  for (const x of perInput) for (const [kind, k] of Object.entries(x.accuracy.by_kind)) { const t = byKind[kind] ??= { compared: 0, agreed: 0 }; t.compared += k.compared; t.agreed += k.agreed }
  for (const k of Object.values(byKind)) k.agreement_rate = rate(k.agreed, k.compared)
  const confusion = Object.fromEntries(VERDICTS.map(e => [e, Object.fromEntries(VERDICTS.map(g => [g, perInput.reduce((s, x) => s + x.accuracy.confusion[e][g], 0)]))]))
  const designated = rescoreInput ?? (reference ? 'reference' : inputs.find(x => x.expectations.variant === 'reference')?.input_id ?? inputs[0]?.input_id)
  const rescoreSource = inputs.find(x => x.input_id === designated)
  return {
    mode: CALIBRATION_MODE, schema_version: CALIBRATION_SCHEMA_VERSION, generated_at: generatedAt, published: false,
    note: 'Maintainer diagnostic only: never published and never a prerequisite or runtime gate for a candidate run.',
    output_directory: outDir, rubric_version: rubric.rubric_version, inventory_version: rubric.inventory_version, judge_profile: judgeProfile, panel_protocol: panelProtocol,
    calibration_limits: { restructured_tolerance_items: limits.restructured_tolerance_items, max_spread: limits.max_spread, provisional: limits.provisional },
    repeats: Math.min(...inputs.map(x => x.repeats.length)),
    inputs: perInput,
    overall: { accuracy: { ...overallAccuracy, agreement_rate: rate(overallAccuracy.agreed, overallAccuracy.compared), by_kind: byKind, confusion },
      basis_shares: basisShares(inputs.flatMap(x => x.repeats)),
      family_distribution: familyDistribution(inputs.map(x => ({ expected: { ...x.expectations.expected, ...(x.expectations.expected_quality ?? {}) }, repeats: x.repeats }))) },
    decider_flips: deciderFlips(reruns),
    identical_rescore: { ...rescoreDiff(designated, rescoreSource?.repeats[0], rescoreSource?.repeats[1]), method: 'repeats 1 and 2 of the designated input: two independent judgings under identical inputs, judges, and rubric' },
    proposed_weights: { components: settings.components, weights: settings.weights, quality_points: settings.quality_points, fidelity: settings.fidelity,
      note: 'Current rubric settings are retained as the proposal; calibration evaluates them and does not fit new weights.' },
    usage,
    failures, passed: failures.length === 0,
  }
}

// ---------------------------------------------------------------- readable report

const pct = value => value === null || value === undefined ? 'n/a' : `${round(value * 100, 1)}%`
export function renderCalibrationMarkdown(report) {
  const lines = [`# and-scene-define calibration`, '', `Generated ${report.generated_at}. Rubric v${report.rubric_version}, inventory v${report.inventory_version}, ${report.repeats} repeats per input. ${report.note}`, '']
  lines.push(`## Outcome: ${report.passed ? 'no failures' : `${report.failures.length} failure(s)`}`, '')
  for (const f of report.failures) lines.push(`- **${f.code}**: ${f.message}`)
  lines.push('', `Weights: ${report.proposed_weights.note}`, '')
  lines.push('## Inputs', '', '| Input | Variant | Mean | Min | Max | Per repeat | Accuracy | Spread | Items differing |', '|---|---|---|---|---|---|---|---|---|')
  for (const x of report.inputs) lines.push(`| ${x.input_id} | ${x.variant} | ${x.scores.mean} | ${x.scores.min} | ${x.scores.max} | ${x.scores.per_repeat.map(r => r.total).join(', ')} | ${pct(x.accuracy.agreement_rate)} | ${x.stability.spread} | ${x.stability.items_differing} |`)
  const o = report.overall
  lines.push('', `## Accuracy`, '', `Overall agreement ${pct(o.accuracy.agreement_rate)} over ${o.accuracy.compared} item verdicts.`, '', '| Expected \\ judged | met | partial | missing |', '|---|---|---|---|')
  for (const e of VERDICTS) lines.push(`| ${e} | ${VERDICTS.map(g => o.accuracy.confusion[e][g]).join(' | ')} |`)
  lines.push('', '## Settlement basis shares', '', '| Basis | Count | Share |', '|---|---|---|')
  for (const [basis, n] of Object.entries(o.basis_shares.counts)) lines.push(`| ${basis} | ${n} | ${pct(o.basis_shares.shares[basis])} |`)
  lines.push('', '## Verdict distribution by model family', '', '| Source | met | partial | missing | Agreement | Leniency |', '|---|---|---|---|---|---|')
  lines.push(`| expected | ${VERDICTS.map(v => pct(o.family_distribution.expected.rates[v])).join(' | ')} | | |`)
  for (const [family, f] of Object.entries(o.family_distribution.families)) lines.push(`| ${family} (${f.models.join(', ')}) | ${VERDICTS.map(v => pct(f.votes_on_expected_items.rates[v])).join(' | ')} | ${pct(f.agreement_rate)} | ${f.leniency} |`)
  const d = report.decider_flips
  lines.push('', '## Decider ruling flips', '', `${d.flips} of ${d.comparisons} re-run rulings flipped (${pct(d.flip_rate)}) across ${d.criteria_rerun} criteria, ${d.reruns_per_record} re-runs each. ${d.note}`, '')
  for (const x of d.flipped_items) lines.push(`- ${x.input_id} ${x.id} (${x.kind}, ${x.job}): recorded ${x.recorded}, re-runs ${x.reruns.join(', ')}`)
  const r = report.identical_rescore
  lines.push('', '## Identical rescore', '', r.available ? `${r.input_id}: totals ${r.totals.join(' and ')}; ${r.items_differing} item(s) differ.` : `${r.input_id}: ${r.reason}.`, '')
  for (const x of r.differing_items ?? []) lines.push(`- ${x.id}: ${x.first} then ${x.second}`)
  if (report.usage) lines.push('', '## Eval-owned usage', '', `${report.usage.invocations} invocation record(s) in \`${report.usage.ledger}\`.`)
  return `${lines.join('\n')}\n`
}
