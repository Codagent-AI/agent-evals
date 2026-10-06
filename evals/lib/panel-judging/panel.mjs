// Cross-family settlement. Suites own prompts, scales, citations and optional audits.
import { hashJson } from './hash.mjs'
import { JUDGE_ATTEMPTS, JudgeOutputError, SOURCE_AUDIT_RESULT_SCHEMA, judgeResultSchemaFor,
  parseSourceAuditOutput, buildContradictionCheckRequest, sourceMaterial, runTiebreak, resolveLineCitedRecord, JUDGE_SCOPE_RULE, REQUIREMENT_QUESTION_RULE } from './protocol.mjs'

export const PANEL_PROTOCOL = 'cross-family-panel-v1'

export function judgeFailure(error) {
  return { message: error?.message ?? String(error),
    ...Object.fromEntries(['code', 'resumable', 'retryable', 'owner'].filter(key => error?.[key] !== undefined).map(key => [key, error[key]])) }
}

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

function effective(vote, checks, order) {
  if (!vote.disputed) return { verdict: vote.verdict, disputed: false }
  const check = checks.find(c => c.stage === 'contradiction-check' && c.id === vote.id && c.panel_index === vote.panel_index)
  if (!check || check.classification === 'insufficient') return { verdict: vote.verdict, disputed: true }
  return { verdict: check.classification === 'confirmed' ? turned(vote.verdict, order) : vote.verdict, disputed: false }
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

function dissentCheckPrompt({ request, scopeRule, id, original, material }) {
  const schema = judgeResultSchemaFor(SOURCE_AUDIT_RESULT_SCHEMA, [id])
  return [request.prompt_body ?? request.prompt, scopeRule,
    ['Check only the dissent\'s stated reason. Confirm only when both hold: the cited material shows what the dissent',
      'says, and that fact decides the criterion\'s quoted requirement the way the dissent claims. For a lower verdict,',
      'it must show a clause of the requirement unmet; for a higher verdict, every clause the verdict credits met.',
      'Contradicted when the material does not show it, or when the fact is accurate but the requirement does not',
      'depend on it (an assumption, scenario, or element the requirement and its review guidance do not name).',
      'Insufficient when the material cannot settle it.'].join(' '),
    'Return confirmed if it holds, contradicted if refuted, insufficient if undecided.',
    '# BEGIN UNTRUSTED DISSENT', JSON.stringify({ id, rationale: original.rationale, citations: original.citations, material, evidence: request.input_roots?.evidence ? request.prompt_body ?? request.prompt : null }), '# END UNTRUSTED DISSENT', '# Response', `Reply with JSON matching this schema: ${JSON.stringify(schema)}`].join('\n')
}

function route(votes, checks, order) {
  const effectiveVotes = votes.map(v => ({ ...v, ...effective(v, checks, order) }))
  if (effectiveVotes.some(v => v.disputed)) return { kind: 'decider' }
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

// Pure reproduction from the recorded votes, targeted checks, and rulings.
export function resolvePanel({ criteria, order, votes, checks = [], rulings = [], decider = null, fallback_ids = [] }) {
  if (decider) {
    const reproduced = resolveLineCitedRecord(decider, fallback_ids)
    if (hashJson(reproduced) !== hashJson(rulings)) throw new JudgeOutputError('cached decider ruling does not reproduce from its audits and checks')
    rulings = reproduced
  }
  const results = criteria.map(id => {
    const own = votes.filter(v => v.id === id)
    if (own.length !== 3 || own.filter(v => v.family === 'claude').length !== 1 || own.filter(v => v.family === 'codex').length !== 2) throw new JudgeOutputError('panel record lacks three cross-family votes')
    const decision = route(own, checks, order)
    let verdict = decision.verdict
    let basis = `${decision.kind}-${verdict}`
    let chosen = own.find(v => effective(v, checks, order).verdict === verdict)
    const ownChecks = checks.filter(c => c.id === id)
    let ruling = null
    if (decision.kind === 'decider') {
      ruling = rulings.find(r => r.id === id)
      if (!ruling || !own.some(v => effective(v, checks, order).verdict === (ruling.vote ?? ruling.verdict))) throw new JudgeOutputError('missing or invalid decider ruling')
      chosen = ruling.result ?? ruling
      verdict = chosen.verdict
      basis = `decider-${verdict}`
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
    return { id, verdict, basis, votes: own, checks: ownChecks, ruling,
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
      record.failure ??= outcomes.find(o => !o.ok)?.failure ?? null
      return done()
    }
    record.votes = outcomes.flatMap((o, index) => o.results.map(r => ({ ...r, family: panel[index].family, model: panel[index].model, effort: panel[index].effort, panel_index: index })))
    for (const vote of record.votes) {
      if (!vote.disputed) continue
      const material = await sourceMaterial(request, [vote])
      const next = buildContradictionCheckRequest({ request, claims: [{ ...vote, material }] })
      const [check] = await call(next, decider, 'contradiction-check', text => parseSourceAuditOutput(text, [vote.id], job))
      record.checks.push({ ...check, stage: 'contradiction-check', panel_index: vote.panel_index })
    }
    const pending = []
    for (const id of criteria) {
      const votes = record.votes.filter(v => v.id === id)
      const decision = route(votes, record.checks, order)
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
      const material = await sourceMaterial(request, [original])
      const next = { ...request, criteria: [id], schema: judgeResultSchemaFor(SOURCE_AUDIT_RESULT_SCHEMA, [id]),
        input_roots: null, audit_stage: 'dissent-check',
        prompt: dissentCheckPrompt({ request, scopeRule, id, original, material }) }
      const [check] = await call(next, decider, 'dissent-check', text => parseSourceAuditOutput(text, [id], job))
      record.checks.push({ ...check, stage: 'dissent-check', panel_index: original.panel_index })
    }
    if (pending.length) {
      // Stable seeded order, with no provider, family, or model in the prompt.
      const shuffled = [...panel.keys()].sort((a, b) => hashJson({ job, criteria, index: a }).localeCompare(hashJson({ job, criteria, index: b })))
      const blind = shuffled.map((index, n) => ({ label: String.fromCharCode(65 + n), results: record.votes.filter(v => v.panel_index === index).map(vote => ({ id: vote.id, verdict: effective(vote, record.checks, order).verdict,
        rationale: effective(vote, record.checks, order).verdict !== vote.verdict ? `The source contradiction was independently confirmed: ${vote.contradiction.rationale}` : vote.rationale,
        citations: vote.citations, evidence: vote.evidence })) }))
      const deciderRequest = { ...request, authority: { cli: 'claude', model: decider.model, effort: decider.effort },
        prompt_body: [request.prompt_body ?? request.prompt, '# Untrusted panel votes', JSON.stringify(blind), 'Rule only a verdict one of these panel judges gave.', scopeRule].join('\n') }
      deciderRequest.prompt = deciderRequest.prompt_body
      const validVerdicts = results => {
        for (const r of results) if (!record.votes.some(v => v.id === r.id && effective(v, record.checks, order).verdict === r.verdict)) throw new JudgeOutputError('decider verdict was not a panel vote')
      }
      if (request.panel_line_citations) {
        const ruling = await runTiebreak({ request: deciderRequest, criteria: pending, invoke: wrap(decider, 'decider'), validateVerdicts: validVerdicts })
        record.decider = ruling
        record.attempts.push(...ruling.attempts)
        record.audit_attempts.push(...ruling.audit_attempts)
        if (!ruling.ok) return done()
        record.rulings = ruling.decisions
      } else {
        record.rulings = await call({ ...deciderRequest, criteria: pending }, decider, 'decider', async text => {
          const results = parse(text, pending, verdicts)
          validVerdicts(results)
          for (const r of results) if (!(await validateCitations(r, request))) throw new JudgeOutputError('invalid decider citations')
          return results
        })
      }
    }
    record.results = resolvePanel(record).results
    record.consensus = record.results.map(({ id, basis, votes }) => ({ id, basis, votes }))
    record.dispute_checks = record.checks.filter(check => check.stage === 'contradiction-check').map(check => ({ ...check, sample: check.panel_index + 1 }))
    record.ok = true
  } catch (error) { record.error = error.message; record.failure = judgeFailure(error) }
  return done()
}
