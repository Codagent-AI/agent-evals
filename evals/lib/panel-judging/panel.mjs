// Cross-family settlement. Suites own prompts, scales, citations and optional audits.
import { hashJson } from './hash.mjs'
import { JUDGE_ATTEMPTS, JudgeOutputError, PANEL_CHECK_RESULT_SCHEMA, CHECK_OUTCOMES, judgeResultSchemaFor, judgeFailure,
  parseSourceAuditOutput, buildContradictionCheckRequest, sourceMaterial, runTiebreak, resolveLineCitedRecord, JUDGE_SCOPE_RULE, REQUIREMENT_QUESTION_RULE, MISSING_MATERIAL_RULE,
  MAX_AUDIT_PACKET_CHARS, PacketOverflowError, HarnessMaterialError, compactMaterial, lineCitationInventory, evidenceLineCounts,
  EVIDENCE_CITATION_RULE } from './protocol.mjs'
export { judgeFailure, HarnessMaterialError } from './protocol.mjs'

export const PANEL_PROTOCOL = 'cross-family-panel-v2'

function parse(output, criteria, verdicts) {
  let results
  try { results = JSON.parse(output).results } catch { throw new JudgeOutputError('panel output is not valid JSON') }
  if (!Array.isArray(results) || results.length !== criteria.length || new Set(results.map(r => r.id)).size !== criteria.length) throw new JudgeOutputError('panel output has missing or duplicate criteria')
  for (const r of results) if (!criteria.includes(r.id) || !verdicts.includes(r.verdict) || !r.rationale?.trim() || !Array.isArray(r.evidence) || !r.evidence.length) throw new JudgeOutputError('invalid panel criterion output')
  return criteria.map(id => results.find(r => r.id === id))
}

// A confirmed contradiction proves the opposite of the vote, which names a
// verdict only at either end of the job's scale. A middle verdict's opposite is
// ambiguous, so the panel refuses to guess one.
function turned(verdict, order) {
  if (verdict === order[0]) return order.at(-1)
  if (verdict === order.at(-1)) return order[0]
  throw new JudgeOutputError(`a confirmed contradiction of the middle verdict ${verdict} names no corrected verdict`)
}

const contradictionCheckOf = (vote, checks) => checks.find(c => c.stage === 'contradiction-check' && c.id === vote.id && c.panel_index === vote.panel_index)

// A disputed vote turns only on a confirmed check. A check that refutes the
// contradiction or cannot decide it leaves the vote standing as cast, except a
// browser-fallback pass, which must be proven from source and so stays
// disputed for the decider when its check cannot decide. Exported for the
// and-scene flip attribution, which compares effective votes across rescores.
export function effective(vote, checks, order, fallbackIds = []) {
  if (!vote.disputed) return { verdict: vote.verdict, disputed: false, turned: false }
  const check = contradictionCheckOf(vote, checks)
  if (!check) return { verdict: vote.verdict, disputed: true, turned: false }
  if (check.classification === 'confirmed') return { verdict: turned(vote.verdict, order), disputed: false, turned: true }
  if (check.classification === 'insufficient' && vote.verdict === order[0] && fallbackIds.includes(vote.id)) {
    return { verdict: vote.verdict, disputed: true, turned: false }
  }
  return { verdict: vote.verdict, disputed: false, turned: false }
}

// Each dissent citation is validated alone so one bad citation cannot discard
// the valid ones. Suites may validate a single citation directly; otherwise the
// result is validated with that citation alone. The kept set must still satisfy
// the suite's whole-result rule, such as the citation kind a verdict requires.
async function backDissent(vote, request, validateCitations, validateCitation) {
  const kept = []
  const dropped = []
  for (const citation of vote.citations ?? []) {
    try {
      const ok = validateCitation ? await validateCitation(citation, vote, request)
        : await validateCitations({ ...vote, citations: [citation] }, request)
      if (ok) kept.push(citation)
      else dropped.push({ citation, reason: 'citation did not validate' })
    } catch (error) {
      dropped.push({ citation, reason: error?.message ?? String(error) })
    }
  }
  if (!kept.length) return { kept, dropped, valid: false, error: dropped.length ? 'no valid citation remains' : null }
  try {
    return { kept, dropped, valid: Boolean(await validateCitations({ ...vote, citations: kept }, request)), error: null }
  } catch (error) {
    return { kept, dropped, valid: false, error: error?.message ?? String(error) }
  }
}

function dissentCheckPrompt({ request, scopeRule, id, original, material, lineCited = false }) {
  const schema = judgeResultSchemaFor(PANEL_CHECK_RESULT_SCHEMA, [id])
  material = compactMaterial(material)
  // The dissent and its complete material are measured; the job's own context is not.
  const packet = JSON.stringify({ id, rationale: original.rationale, citations: original.citations, material })
  if (packet.length > MAX_AUDIT_PACKET_CHARS) throw new PacketOverflowError(`${request.job} dissent check exceeds the ${MAX_AUDIT_PACKET_CHARS}-character packet limit: ${id}`, [id])
  return [request.prompt_body ?? request.prompt, scopeRule,
    ['Check only the dissent\'s stated reason. Confirm only when both hold: the cited material shows what the dissent',
      'says, and that fact decides the criterion\'s quoted requirement the way the dissent claims. For a lower verdict,',
      'it must show a clause of the requirement unmet; for a higher verdict, every clause the verdict credits met.',
      'Contradicted when the material does not show it, or when the fact is accurate but the requirement does not',
      'depend on it (an assumption, scenario, or element the requirement and its review guidance do not name).',
      'Insufficient when the complete, in-scope material cannot settle it.', MISSING_MATERIAL_RULE,
      ...(lineCited ? [EVIDENCE_CITATION_RULE] : [])].join(' '),
    'Return confirmed if it holds, contradicted if refuted, insufficient if undecided, missing-material if it depends on marked material.',
    '# BEGIN UNTRUSTED DISSENT', JSON.stringify({ id, rationale: original.rationale, citations: original.citations, material, evidence: request.input_roots?.evidence ? request.prompt_body ?? request.prompt : null }), '# END UNTRUSTED DISSENT', '# Response', `Reply with JSON matching this schema: ${JSON.stringify(schema)}`].join('\n')
}

function route(votes, checks, order, fallbackIds = []) {
  const effectiveVotes = votes.map(v => ({ ...v, ...effective(v, checks, order, fallbackIds) }))
  if (effectiveVotes.some(v => v.disputed)) return { kind: 'decider' }
  // Confirmed negative evidence is adjudicated: a turned vote in a split
  // goes to the decider before any majority can outvote it.
  if (effectiveVotes.some(v => v.turned) && new Set(effectiveVotes.map(v => v.verdict)).size > 1) return { kind: 'decider', routed_by: 'confirmed-contradiction' }
  const counts = new Map()
  for (const v of effectiveVotes) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1)
  const majority = [...counts].find(([, n]) => n >= 2)?.[0]
  if (!majority) return { kind: 'decider' }
  if (counts.get(majority) === 3) return { kind: 'consensus', verdict: majority }
  if (!effectiveVotes.some(v => v.family === 'claude' && v.verdict === majority)) return { kind: 'decider' }
  const dissent = effectiveVotes.find(v => v.verdict !== majority)
  return { kind: 'majority', verdict: majority,
    dissent: order.indexOf(dissent.verdict) < order.indexOf(majority) ? dissent : null }
}

// The decider sees the votes blind: a stable seeded order, with no provider,
// family, or model in the prompt. Shared by runPanelJob and rerunDecider so a
// re-run sends exactly the request the recorded panel outputs produced.
// `ids` narrows the votes to some criteria, as a batched line-cited decider needs.
// A turned vote carries the audit's stated contradiction and the check's confirmation.
function deciderVotes({ job, criteria, record, order, scopeRule, ids = criteria }) {
  const shuffled = [0, 1, 2].sort((a, b) => hashJson({ job, criteria, index: a }).localeCompare(hashJson({ job, criteria, index: b })))
  const fallbackIds = record.fallback_ids ?? []
  const blind = shuffled.map((index, n) => ({ label: String.fromCharCode(65 + n), results: record.votes.filter(v => v.panel_index === index && ids.includes(v.id)).map(vote => ({ id: vote.id, verdict: effective(vote, record.checks, order, fallbackIds).verdict,
    rationale: effective(vote, record.checks, order, fallbackIds).turned
      ? `The source contradiction was independently confirmed: ${vote.contradiction.rationale} The contradiction check confirmed it: ${contradictionCheckOf(vote, record.checks).rationale}`
      : vote.rationale,
    citations: vote.citations, evidence: vote.evidence })) }))
  return ['# Untrusted panel votes', JSON.stringify(blind), 'Rule only a verdict one of these panel judges gave.', scopeRule].join('\n')
}

const deciderAuthority = decider => ({ cli: 'claude', model: decider.model, effort: decider.effort })

function deciderRequestFor({ job, criteria, request, record, order, decider, scopeRule }) {
  const deciderRequest = { ...request, authority: deciderAuthority(decider),
    prompt_body: [request.prompt_body ?? request.prompt, deciderVotes({ job, criteria, record, order, scopeRule })].join('\n') }
  deciderRequest.prompt = deciderRequest.prompt_body
  return deciderRequest
}

// The batched decider answers only the disputed criteria: its schema and an
// explicit instruction are narrowed to them, as the line-cited tiebreak does.
function batchedDeciderRequest(deciderRequest, pending) {
  const prompt = [deciderRequest.prompt_body, `Return results for exactly these criterion IDs and no others: ${pending.join(', ')}`].join('\n')
  return { ...deciderRequest, criteria: pending, prompt_body: prompt, prompt,
    ...(deciderRequest.schema?.properties?.results?.items?.properties ? { schema: judgeResultSchemaFor(deciderRequest.schema, pending) } : {}) }
}

function validDeciderVerdicts(record, order, results) {
  for (const r of results) if (!record.votes.some(v => v.id === r.id && effective(v, record.checks, order, record.fallback_ids ?? []).verdict === r.verdict)) throw new JudgeOutputError('decider verdict was not a panel vote')
}

async function parseDeciderOutput(text, criteria, record, request, validateCitations) {
  const results = parse(text, criteria, record.verdicts)
  validDeciderVerdicts(record, record.order, results)
  for (const r of results) if (!(await validateCitations(r, request))) throw new JudgeOutputError('invalid decider citations')
  return results
}

// Checks follow the panel audit contract: their citations lie in the job's
// verified inventory, and missing material names a marker the packet holds.
async function parseCheck(request, next, id, text) {
  const inventory = (request.input_roots?.source || request.input_roots?.evidence) ? (await lineCitationInventory(request)).paths : null
  return parseSourceAuditOutput(text, [id], request.job, { outcomes: CHECK_OUTCOMES, inventory, packet: next.prompt,
    lineCounts: await evidenceLineCounts(request) })
}

// A check that needed withheld material leaves no vote standing.
function settledCheck(check, stage) {
  if (check.classification === 'missing-material') {
    throw new HarnessMaterialError(`${check.id}: the ${stage} needs missing material ${check.marker}`, 'missing-material', [check.id])
  }
  return check
}

async function dissentCheckRequest({ request, scopeRule, id, original }) {
  const material = await sourceMaterial(request, [original])
  // An evidence packet's check cites it by line range, as its parser requires.
  const lineCited = Boolean(await evidenceLineCounts(request))
  return { ...request, criteria: [id], schema: judgeResultSchemaFor(PANEL_CHECK_RESULT_SCHEMA, [id]),
    input_roots: null, audit_stage: 'dissent-check',
    prompt: dissentCheckPrompt({ request, scopeRule, id, original, material, lineCited }) }
}

// The verdict exactly two effective votes gave, or null for a consensus or a
// three-way split.
function twoVoteVerdict(votes, checks, order, fallbackIds = []) {
  const counts = new Map()
  for (const v of votes) {
    const { verdict } = effective(v, checks, order, fallbackIds)
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1)
  }
  return [...counts].find(([, n]) => n === 2)?.[0] ?? null
}

// A batched decider ruling overrules the panel when it differs from a verdict
// exactly two effective votes gave; a three-way split has none to restore.
function overruledVerdict(record, ruling, order) {
  const votes = record.votes.filter(v => v.id === ruling.id)
  const two = twoVoteVerdict(votes, record.checks ?? [], order, record.fallback_ids ?? [])
  return two !== null && two !== ruling.verdict ? two : null
}

function overruleCheckPrompt({ request, scopeRule, id, ruling, overruled, order, material }) {
  const schema = judgeResultSchemaFor(PANEL_CHECK_RESULT_SCHEMA, [id])
  material = compactMaterial(material)
  const claim = { id, verdict: ruling.verdict, overruled_verdict: overruled, rationale: ruling.rationale, evidence: ruling.evidence, citations: ruling.citations, material }
  // The ruling and its complete material are measured; the job's own context is not.
  const packet = JSON.stringify(claim)
  if (packet.length > MAX_AUDIT_PACKET_CHARS) throw new PacketOverflowError(`${request.job} overrule check exceeds the ${MAX_AUDIT_PACKET_CHARS}-character packet limit: ${id}`, [id])
  const higher = order.indexOf(ruling.verdict) < order.indexOf(overruled)
  return [request.prompt_body ?? request.prompt, scopeRule,
    [`The decider ruled ${ruling.verdict}, overruling the ${overruled} verdict two panel judges gave.`,
      'Check only the decider\'s stated reason against its citations. Confirm only when both hold: the cited material shows what',
      'the ruling says, and that fact decides the criterion\'s quoted requirement the way the ruling claims.',
      higher ? 'The ruling credits more than the two judges did, so every clause it credits must be shown met.'
        : 'The ruling credits less than the two judges did, so it must show a clause of the requirement unmet.',
      'Contradicted when the citations do not show it, or when the fact is accurate but the requirement does not',
      'depend on it (an assumption, scenario, or element the requirement and its review guidance do not name).',
      'Insufficient when the complete, in-scope material cannot settle it. Your classification never names a verdict:',
      `an unconfirmed ruling leaves the two judges' ${overruled} standing.`, MISSING_MATERIAL_RULE].join(' '),
    'Return confirmed if it holds, contradicted if refuted, insufficient if undecided, missing-material if it depends on marked material.',
    '# BEGIN UNTRUSTED RULING', packet, '# END UNTRUSTED RULING', '# Response', `Reply with JSON matching this schema: ${JSON.stringify(schema)}`].join('\n')
}

// The targeted check of a decider ruling that overrules a two-vote verdict.
// It mirrors the dissent check: the decider's pinned model judges the ruling's
// stated reason and citations against their closed-world material.
export async function overruleCheckRequest({ request, scopeRule = null, id, ruling, overruled, order }) {
  const material = await sourceMaterial(request, [ruling])
  return { ...request, criteria: [id], schema: judgeResultSchemaFor(PANEL_CHECK_RESULT_SCHEMA, [id]),
    input_roots: null, audit_stage: 'overrule-check',
    prompt: overruleCheckPrompt({ request, scopeRule: scopeRule ?? [JUDGE_SCOPE_RULE, REQUIREMENT_QUESTION_RULE].join('\n'), id, ruling, overruled, order, material }) }
}

// An evidence seat that reports its verdict depends on material the packet
// withheld makes its criterion a harness failure before any vote settles it,
// whether the votes are unanimous, a majority, or bound for the decider.
function rejectMarkedVotes(votes) {
  const marked = votes.filter(v => v.missing_material)
  if (!marked.length) return
  throw new HarnessMaterialError(`panel judges' verdicts depend on missing material: ${marked
    .map(v => `${v.id} (${v.missing_material})`).join(', ')}`, 'missing-material', marked.map(v => v.id))
}

// Pure reproduction from the recorded votes, targeted checks, and rulings.
// `line_cited` marks rulings of a line-cited decider supplied directly rather
// than reproduced from its record (the and-scene settlement replay): like a
// reproduced line-cited ruling, it takes no overrule check.
export function resolvePanel({ criteria, order, votes, checks = [], rulings = [], decider = null, fallback_ids = [], line_cited = false }) {
  // Known missing material fails the job; no settled record can hold it.
  rejectMarkedVotes(votes)
  if (checks.some(c => !['confirmed', 'contradicted', 'insufficient'].includes(c.classification))) throw new JudgeOutputError('panel record settles a check on missing material')
  if (decider) {
    const reproduced = resolveLineCitedRecord(decider, fallback_ids)
    if (hashJson(reproduced) !== hashJson(rulings)) throw new JudgeOutputError('cached decider ruling does not reproduce from its audits and checks')
    rulings = reproduced
  }
  const results = criteria.map(id => {
    const own = votes.filter(v => v.id === id)
    if (own.length !== 3 || own.filter(v => v.family === 'claude').length !== 1 || own.filter(v => v.family === 'codex').length !== 2) throw new JudgeOutputError('panel record lacks three cross-family votes')
    const decision = route(own, checks, order, fallback_ids)
    let verdict = decision.verdict
    let basis = `${decision.kind}-${verdict}`
    let chosen = own.find(v => effective(v, checks, order, fallback_ids).verdict === verdict)
    const ownChecks = checks.filter(c => c.id === id)
    let ruling = null
    let overrule = null
    const overruleCheck = ownChecks.find(c => c.stage === 'overrule-check')
    if (decision.kind === 'decider') {
      ruling = rulings.find(r => r.id === id)
      if (!ruling || !own.some(v => effective(v, checks, order, fallback_ids).verdict === (ruling.vote ?? ruling.verdict))) throw new JudgeOutputError('missing or invalid decider ruling')
      chosen = ruling.result ?? ruling
      verdict = chosen.verdict
      basis = `decider-${verdict}`
      // A batched ruling that overrules two votes stands only when its check
      // confirms it; otherwise the two votes' verdict stands.
      const overruled = decider || line_cited ? null : overruledVerdict({ votes: own, checks, fallback_ids }, ruling, order)
      if (overruled === null && overruleCheck) throw new JudgeOutputError('overrule check recorded for a ruling that overrules no two-vote verdict')
      if (overruled !== null) {
        if (!overruleCheck) throw new JudgeOutputError('overruling decider ruling has no overrule check')
        const upheld = overruleCheck.classification === 'confirmed'
        overrule = { classification: overruleCheck.classification, outcome: upheld ? 'upheld' : 'rejected' }
        if (!upheld) {
          verdict = overruled
          chosen = own.find(v => effective(v, checks, order, fallback_ids).verdict === verdict)
          basis = `majority-${verdict}`
        }
      }
    } else if (overruleCheck) {
      throw new JudgeOutputError('overrule check recorded for a criterion the decider did not rule')
    } else if (decision.dissent?.citations_valid) {
      const check = ownChecks.find(c => c.stage === 'dissent-check' && c.panel_index === decision.dissent.panel_index)
      if (!check) throw new JudgeOutputError('backed dissent has no targeted check')
      if (check.classification === 'confirmed') {
        chosen = decision.dissent
        verdict = chosen.verdict
        basis = `checked-dissent-${verdict}`
      }
    }
    const turned = chosen.verdict !== verdict
    return { id, verdict, basis, ...(decision.routed_by ? { routed_by: decision.routed_by } : {}), votes: own, checks: ownChecks, ruling,
      ...(overrule ? { overrule_check: overrule } : {}),
      rationale: turned ? `The source contradiction was independently confirmed: ${chosen.contradiction?.rationale}` : chosen.rationale,
      citations: chosen.citations ?? [], evidence: [...(chosen.evidence ?? []), `judging basis: ${basis}`] }
  })
  return { results }
}

export function verifyCachedPanelJob(record) {
  if (record?.protocol !== PANEL_PROTOCOL || record.ok !== true) throw new JudgeOutputError('cached job predates panel protocol or is incomplete')
  const reproduced = resolvePanel(record)
  if (hashJson(reproduced.results) !== hashJson(record.results)) throw new JudgeOutputError('cached panel results do not reproduce')
  return reproduced
}

// audit({request, invoke}) may return the suite's audited runJudgeJob outcome.
// buildPrompt returns the identical base request, without model authority; its
// optional scope_rule replaces the shared scope and requirement-question rules
// in the panel-owned dissent-check and decider prompts.
// validateCitation(citation, result, request), when supplied, validates one
// dissent citation; validateCitations(result, request) validates a whole result.
export async function runPanelJob({ job, criteria, verdicts, order, panel, decider, buildPrompt, schema,
  validateCitations = async () => false, validateCitation = null, audit = null, cache = null }) {
  if (panel.length !== 3 || panel.filter(p => p.family === 'claude').length !== 1 || panel.filter(p => p.family === 'codex').length !== 2) throw new Error('panel requires one Claude and two Codex judges')
  if (order.length !== verdicts.length || new Set(order).size !== verdicts.length || order.some(v => !verdicts.includes(v))) throw new Error('order must rank every verdict')
  const request = { job, criteria, schema, ...(await buildPrompt({ job, criteria, schema })) }
  const scopeRule = request.scope_rule ?? [JUDGE_SCOPE_RULE, REQUIREMENT_QUESTION_RULE].join('\n')
  if (cache) { try { return { ok: true, ...verifyCachedPanelJob(cache), record: cache, usage_by_stage: {} } } catch { /* stale record */ } }
  const record = { protocol: PANEL_PROTOCOL, job, criteria, verdicts, order, ok: false, fallback_ids: request.requireSourceCitationsFor ?? [], votes: [], checks: [], rulings: [], attempts: [], audit_attempts: [], samples: [] }
  const usage = {}
  const wrap = (member, stage) => async next => {
    const callStage = next.audit_stage === 'source-pass-audit' || next.source_access === 'closed-world-packet' && !next.audit_stage ? 'source-audit'
      : next.audit_stage === 'contradiction-check' ? 'contradiction-check'
      : next.audit_stage === 'tiebreak-span-audit' ? 'span-audit'
      : next.judge_stage === 'tiebreak-recite' ? 'decider-recite' : stage
    usage[callStage] = (usage[callStage] ?? 0) + 1
    try {
      return await member.invoke({ ...next, authority: { cli: member.family === 'codex' ? 'codex' : 'claude', model: member.model, effort: member.effort }, usage_phase: callStage })
    } catch (error) {
      if (error.retryable === false || error.resumable === true) record.failure = judgeFailure(error)
      throw error
    }
  }
  const call = async (next, member, stage, parser) => {
    let lastError
    for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
      try {
        const value = await parser(await wrap(member, stage)(next))
        record.attempts.push({ stage, attempt, ok: true })
        return value
      } catch (error) {
        lastError = error
        record.attempts.push({ stage, attempt, ok: false, error: error.message, failure: judgeFailure(error) })
        if (error.retryable === false) break
      }
    }
    const { message, ...metadata } = judgeFailure(lastError)
    throw Object.assign(new JudgeOutputError(`exhausted ${stage}: ${message}`), { ...metadata, cause: lastError })
  }
  const done = () => {
    if (!record.ok) {
      const last = [...record.attempts, ...record.audit_attempts].findLast(attempt => attempt.ok === false && attempt.error)
      record.failure ??= last?.failure ?? (last ? { message: last.error, code: 'judge-output', owner: 'evaluation-harness' } : null)
      if (record.failure) record.error = record.failure.message
    }
    return { ok: record.ok, failure: record.ok ? null : record.failure ?? null, results: record.results ?? null, record, usage_by_stage: usage }
  }
  try {
    const settled = await Promise.allSettled(panel.map(async (member, index) => {
      const stage = index === panel.findIndex(p => p.family === 'claude') ? 'panel-claude' : `panel-codex-${panel.slice(0, index + 1).filter(p => p.family === 'codex').length}`
      if (audit) return audit({ request: { ...request, judge_sample: index + 1 }, invoke: wrap(member, stage) })
      return { ok: true, results: await call(request, member, stage, text => parse(text, criteria, verdicts)), attempts: [], audit_attempts: [] }
    }))
    const outcomes = settled.map(entry => entry.status === 'fulfilled' ? entry.value : ({ ok: false, results: null, failure: judgeFailure(entry.reason), attempts: [{ ok: false, error: entry.reason.message, failure: judgeFailure(entry.reason) }], audit_attempts: [] }))
    record.samples = outcomes
    record.attempts.push(...outcomes.flatMap((o, index) => (o.attempts ?? []).map(a => ({ ...a, panel_index: index }))))
    record.audit_attempts = outcomes.flatMap((o, index) => (o.audit_attempts ?? []).map(a => ({ ...a, panel_index: index })))
    if (outcomes.some(o => !o.ok)) {
      // Name the failed seat's own last error: another seat may have recorded,
      // and recovered from, a later one.
      const failed = outcomes.find(o => !o.ok)
      const last = [...(failed.attempts ?? []), ...(failed.audit_attempts ?? [])].findLast(attempt => attempt.ok === false && attempt.error)
      record.failure ??= failed.failure ?? last?.failure ?? (last ? { message: last.error, code: 'judge-output', owner: 'evaluation-harness' } : null)
      return done()
    }
    record.votes = outcomes.flatMap((o, index) => o.results.map(r => ({ ...r, family: panel[index].family, model: panel[index].model, effort: panel[index].effort, panel_index: index })))
    rejectMarkedVotes(record.votes)
    for (const vote of record.votes) {
      if (!vote.disputed) continue
      // The vote's own citations and the files its audit cited.
      const material = await sourceMaterial(request, [vote], vote.contradiction?.citations ?? [])
      const next = buildContradictionCheckRequest({ request, claims: [{ ...vote, material }] })
      const [check] = await call(next, decider, 'contradiction-check', text => parseCheck(request, next, vote.id, text))
      record.checks.push({ ...check, stage: 'contradiction-check', panel_index: vote.panel_index })
      settledCheck(check, 'contradiction check')
    }
    const pending = []
    for (const id of criteria) {
      const votes = record.votes.filter(v => v.id === id)
      const decision = route(votes, record.checks, order, record.fallback_ids)
      if (decision.kind === 'decider') { pending.push(id); continue }
      if (!decision.dissent) continue
      const original = record.votes.find(v => v.id === id && v.panel_index === decision.dissent.panel_index)
      const backing = await backDissent(original, request, validateCitations, validateCitation)
      original.citations_valid = backing.valid
      if (backing.dropped.length) {
        original.dropped_citations = backing.dropped
        original.citations = backing.kept
      }
      if (backing.error || backing.dropped.length) {
        record.citation_checks ??= []
        record.citation_checks.push({ id, panel_index: original.panel_index, valid: backing.valid, dropped: backing.dropped.length,
          ...(backing.error ? { error: backing.error } : {}) })
      }
      if (!original.citations_valid) continue
      const next = await dissentCheckRequest({ request, scopeRule, id, original })
      const [check] = await call(next, decider, 'dissent-check', text => parseCheck(request, next, id, text))
      record.checks.push({ ...check, stage: 'dissent-check', panel_index: original.panel_index })
      settledCheck(check, 'dissent check')
    }
    if (pending.length) {
      const validVerdicts = results => validDeciderVerdicts(record, order, results)
      if (request.panel_line_citations) {
        // The votes are the per-criterion part a too-large request batches.
        const ruling = await runTiebreak({ request: { ...request, authority: deciderAuthority(decider) }, criteria: pending,
          invoke: wrap(decider, 'decider'), validateVerdicts: validVerdicts,
          criterionMaterial: ids => deciderVotes({ job, criteria, record, order, scopeRule, ids }) })
        record.decider = ruling
        record.attempts.push(...ruling.attempts)
        record.audit_attempts.push(...ruling.audit_attempts)
        if (!ruling.ok) {
          if (ruling.failure) record.failure = ruling.failure
          return done()
        }
        record.rulings = ruling.decisions
      } else {
        const deciderRequest = deciderRequestFor({ job, criteria, request, record, order, decider, scopeRule })
        record.rulings = await call(batchedDeciderRequest(deciderRequest, pending), decider, 'decider', text => parseDeciderOutput(text, pending, record, request, validateCitations))
        for (const ruling of record.rulings) {
          const overruled = overruledVerdict(record, ruling, order)
          if (overruled === null) continue
          const next = await overruleCheckRequest({ request, scopeRule, id: ruling.id, ruling, overruled, order })
          const [check] = await call(next, decider, 'overrule-check', text => parseCheck(request, next, ruling.id, text))
          record.checks.push({ ...check, stage: 'overrule-check' })
          settledCheck(check, 'overrule check')
        }
      }
    }
    record.results = resolvePanel(record).results
    record.consensus = record.results.map(({ id, basis, votes }) => ({ id, basis, votes }))
    record.dispute_checks = record.checks.filter(check => check.stage === 'contradiction-check').map(check => ({ ...check, sample: check.panel_index + 1 }))
    record.ok = true
  } catch (error) { record.error = error.message; record.failure = judgeFailure(error) }
  return done()
}

// Re-runs only the decider stages of a completed record on its recorded panel
// outputs: the batched decider ruling, the overrule check of each re-run ruling
// that overrules a two-vote verdict, and each targeted dissent check, built
// exactly as runPanelJob built them. The record is not changed; callers compare
// the fresh outcomes with the recorded ones (calibration's ruling-flip rate).
// A ruling flips when the verdict it settles, after its overrule check,
// differs from the recorded settled verdict. A confirmed dissent check changes
// the verdict; any other classification keeps the majority's, so a check flips
// when confirmation changes.
export async function rerunDecider({ record, decider, buildPrompt, schema, validateCitations }) {
  if (typeof validateCitations !== 'function') throw new Error('decider re-run needs a citation validator')
  if (record?.protocol !== PANEL_PROTOCOL || record.ok !== true) throw new Error('decider re-run needs a complete panel record')
  const { job, criteria, order } = record
  const request = { job, criteria, schema, ...(await buildPrompt({ job, criteria, schema })) }
  if (request.panel_line_citations) throw new Error('decider re-run does not support line-cited tiebreaks')
  const scopeRule = request.scope_rule ?? [JUDGE_SCOPE_RULE, REQUIREMENT_QUESTION_RULE].join('\n')
  const usage = {}
  const call = deciderCall(decider, usage)
  const settledVerdicts = new Map(resolvePanel(record).results.map(r => [r.id, r.verdict]))
  const rulings = []
  const pending = (record.rulings ?? []).map(r => r.id)
  if (pending.length) {
    const deciderRequest = deciderRequestFor({ job, criteria, request, record, order, decider, scopeRule })
    const results = await call(batchedDeciderRequest(deciderRequest, pending), 'decider-rerun', text => parseDeciderOutput(text, pending, record, request, validateCitations))
    for (const recorded of record.rulings) {
      const fresh = results.find(r => r.id === recorded.id)
      const overruled = overruledVerdict(record, fresh, order)
      let check = null
      if (overruled !== null) {
        const next = await overruleCheckRequest({ request, scopeRule, id: fresh.id, ruling: fresh, overruled, order })
        ;[check] = await call(next, 'overrule-check-rerun', text => parseCheck(request, next, fresh.id, text))
        settledCheck(check, 'overrule check')
      }
      const before = settledVerdicts.get(recorded.id)
      const rerun = overruled !== null && check.classification !== 'confirmed' ? overruled : fresh.verdict
      rulings.push({ id: recorded.id, recorded: before, rerun, flipped: rerun !== before,
        recorded_ruling: recorded.vote ?? recorded.verdict, rerun_ruling: fresh.verdict, overrule_check: check?.classification ?? null })
    }
  }
  const checks = []
  for (const check of record.checks.filter(c => c.stage === 'dissent-check')) {
    const original = record.votes.find(v => v.id === check.id && v.panel_index === check.panel_index)
    const next = await dissentCheckRequest({ request, scopeRule, id: check.id, original })
    const [fresh] = await call(next, 'dissent-check-rerun', text => parseCheck(request, next, check.id, text))
    settledCheck(fresh, 'dissent check')
    checks.push({ id: check.id, panel_index: check.panel_index, recorded: check.classification, rerun: fresh.classification,
      flipped: (check.classification === 'confirmed') !== (fresh.classification === 'confirmed') })
  }
  return { job, rulings, checks, usage_by_stage: usage }
}

// A decider-only call with the panel's bounded retries, outside any record.
function deciderCall(decider, usage) {
  return async (next, stage, parser) => {
    let lastError
    for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
      usage[stage] = (usage[stage] ?? 0) + 1
      try {
        return await parser(await decider.invoke({ ...next, authority: deciderAuthority(decider), usage_phase: stage }))
      } catch (error) {
        lastError = error
        if (error.retryable === false) break
      }
    }
    throw lastError
  }
}

// Runs the overrule check against one retained batched decider ruling, of any
// protocol, and reports the verdict v2 settlement would give it with the
// recorded votes. It reads the record only: nothing is written, cached, or
// returned as a judging record, so a retained record is never reused as v2
// judging. A ruling that overrules no two-vote verdict needs no check.
export async function checkRecordedRuling({ record, id, decider, buildPrompt, schema }) {
  if (record?.decider) throw new Error('the retained-ruling check applies only to batched decider rulings')
  const { job, criteria, order } = record ?? {}
  if (!Array.isArray(order) || !Array.isArray(criteria)) throw new Error('retained record names no verdict order or criteria')
  const ruling = (record.rulings ?? []).find(r => r.id === id)
  if (!ruling) throw new Error(`retained record ${job} holds no decider ruling for ${id}`)
  const votes = (record.votes ?? []).filter(v => v.id === id)
  const priorChecks = (record.checks ?? []).filter(c => c.id === id && c.stage !== 'overrule-check')
  const fallback_ids = record.fallback_ids ?? []
  const overruled = overruledVerdict({ votes, checks: priorChecks, fallback_ids }, ruling, order)
  let check = null
  const usage = {}
  if (overruled !== null) {
    const request = { job, criteria, schema, ...(await buildPrompt({ job, criteria, schema })) }
    const scopeRule = request.scope_rule ?? [JUDGE_SCOPE_RULE, REQUIREMENT_QUESTION_RULE].join('\n')
    const next = await overruleCheckRequest({ request, scopeRule, id, ruling, overruled, order })
    ;[check] = await deciderCall(decider, usage)(next, 'retained-overrule-check', text => parseCheck(request, next, id, text))
    settledCheck(check, 'overrule check')
  }
  const [settled] = resolvePanel({ criteria: [id], order, votes, rulings: [ruling], fallback_ids,
    checks: [...priorChecks, ...(check ? [{ ...check, stage: 'overrule-check' }] : [])] }).results
  const recorded = (record.results ?? []).find(r => r.id === id) ?? null
  return { job, id, recorded_protocol: record.protocol ?? null,
    votes: votes.map(({ family, panel_index, verdict }) => ({ family, panel_index, verdict })),
    ruling: { verdict: ruling.vote ?? ruling.verdict, rationale: ruling.rationale, citations: ruling.citations ?? [] },
    recorded_verdict: recorded?.verdict ?? null, recorded_basis: recorded?.basis ?? null,
    overruled_verdict: overruled, check, verdict: settled.verdict, basis: settled.basis, usage_by_stage: usage }
}
