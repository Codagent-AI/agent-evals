// Suite-owned definitions and citations; settlement belongs to the shared panel.
import { runPanelJob, rerunDecider, PANEL_PROTOCOL } from '../../../lib/panel-judging/panel.mjs'
import { JudgeOutputError } from '../../../lib/panel-judging/protocol.mjs'
import { JUDGE_PROFILE } from './profiles.mjs'
export { PANEL_PROTOCOL, JUDGE_PROFILE }
// The definition counterpart of the shared scope and requirement-question rules.
// The implementation scope rule (deleted files, rendering) does not apply here.
export const DEFINITION_SCOPE_RULE = [
  'Judge only what the cited artifacts establish. Add no requirement the item and its anchors do not state. Give undefined terms their plain meaning in the reference.',
  'Every verdict answers one question: does the criterion\'s requirement hold? For a coverage item the requirement is its statement or intent and its anchors; for any other criterion it is the rule written for it. An accurate observation or citation decides nothing by itself. A verdict that withholds coverage or quality credit must name the part of the item the artifacts do not commit to and the evidence that they do not; a deduction or flag must name the exchange and artifact text that make it. A fact the requirement does not depend on (wording, organization, a scenario its anchors do not state) never decides a verdict.',
].join('\n')
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) })
const string = { type: 'string' }
const strings = { type: 'array', items: string }
export const CITATION_SCHEMA = object({ path: { type: ['string', 'null'] }, start_line: { type: ['integer', 'null'] }, end_line: { type: ['integer', 'null'] }, gate: { type: ['string', 'null'] }, exchange: { type: ['string', 'null'] } })
const citations = { type: 'array', items: CITATION_SCHEMA }
const addedScope = { type: 'array', items: object({ description: string, citations }) }
export function judgeSchema(ids) {
  return object({ results: { type: 'array', items: object({ id: { type: 'string', enum: ids }, verdict: { type: 'string', enum: ['met', 'partial', 'missing'] }, rationale: string, evidence: strings, citations, subject_id: { type: ['string', 'null'] }, added_scope: addedScope }) } })
}
export function discoverySchema(ids) {
  return object({ results: { type: 'array', items: object({ id: { type: 'string', enum: ids }, asked: { type: 'boolean' }, rationale: string, citations }) } })
}
// Exchange identities appear in criterion ids, which strict judge schemas list as
// enum values; Codex rejects quotes and backslashes there, so each part is encoded.
export const exchangeIdentity = x => [x.step, x.step_id, x.attempt, x.turn].map(part => encodeURIComponent(String(part))).join('/')
export function makeJobs({ inventory, rubric, artifacts, conversation, gates, reference = [], policy = '' }) {
  const graded = inventory.items.filter(x => x.class !== 'preference')
  const jobs = [...new Set(graded.map(x => x.area))].map(area => {
    const items = graded.filter(x => x.area === area)
    return { name: `coverage:${area}`, kind: 'coverage', criteria: items.map(x => x.id), inputs: { artifacts, gates, items } }
  })
  jobs.push({ name: 'artifact-quality', kind: 'quality', criteria: rubric.quality.map(x => x.id), inputs: { artifacts, gates, quality: rubric.quality, guidance: rubric.guidance.slice(0, 2) } })
  if (conversation.length) jobs.push({ name: 'fidelity', kind: 'fidelity', criteria: conversation.map(x => `fidelity:${exchangeIdentity(x)}`), inputs: { artifacts, gates, conversation, items: inventory.items.filter(x => x.class === 'preference'), guidance: rubric.fidelity, coverage_owned_matters: graded.map(x => ({ id: x.id, statement: x.statement, intent: x.intent })) } })
  jobs.push({ name: 'disclosure-audit', kind: 'disclosure', criteria: [
    ...graded.map(x => `leak:${x.id}`),
    ...conversation.flatMap(x => ['inconsistent-withholding', 'contradiction'].map(type => `${type}:${exchangeIdentity(x)}`)),
  ], inputs: { conversation, items: graded, reference, policy } })
  jobs.push({ name: 'discovery', kind: 'discovery', criteria: graded.map(x => x.id), inputs: { conversation, items: graded } })
  return jobs
}
const rules = {
  coverage: 'Judge each mandatory item against its statement and anchors, each acceptable-alternative against intent and anchors only. Capture requires commitment in a specification requirement or scenario, design decision, or proposal scope statement. A passing mention or test-plan-only mention does not capture it. Scope-exclusion items are met when excluded scope is absent, with no explicit exclusion required.',
  quality: 'Judge only observable and testable scenarios, cross-artifact consistency, design rationale, and test-plan coverage. Different organization is never a fault. An explicit open question never scores below silent omission. The hidden reference and inventory are not inputs.',
  fidelity: 'For each exchange, met means an artifact contradicts a simulated-user answer about a preference item or a matter outside the graded inventory; missing means no such contradiction. Partial is invalid. Cite both artifact line spans and exactly that exchange. subject_id must be the preference id or null for an outside-inventory matter. Never deduct a contradiction of coverage_owned_matters: these are an exclusion list, not fidelity criteria. Coverage owns them. If an answer is not clearly outside that list and is not a preference, make no deduction. Added scope alone is not a deduction; list added_scope with artifact citations as a diagnostic.',
  disclosure: 'Audit every reply against the agent turn it answered and the preceding conversation, reference, and policy. For leak:ID, met means a reply disclosed that graded item without being asked; missing means no leak; partial is invalid. Cite the exchange for a leak. For inconsistent-withholding and contradiction criteria, met means that flag applies at that exchange, missing means it does not. These flags are report-only. A single valid flag is a backed dissent. subject_id is the item id for leaks and null otherwise.',
  discovery: 'Decide only whether any agent_message asked about each item. asked=true requires a cited exchange. Capturing the item is not your judgment; coverage supplies that separately.',
}
export function jobPrompt(job) {
  const lineNumbered = Object.fromEntries(Object.entries(job.inputs.artifacts ?? {}).map(([path, text]) => [path, text.split('\n').map((line, n) => `${n + 1}: ${line}`).join('\n')]))
  return [DEFINITION_SCOPE_RULE, rules[job.kind],
    'met/partial findings cite {path,start_line,end_line,gate:null,exchange:null}. Missing coverage/quality findings cite inspected collected file names (null line numbers), or a failed required-artifact gate. Every other field is null unless it is the citation target. Fidelity needs both a line span and its exchange. Discovery and disclosure flags need exchange identities. No citations may refer to hidden inputs. Supply every criterion exactly once. Use empty added_scope unless this is fidelity.',
    '# BEGIN UNTRUSTED JOB INPUTS', JSON.stringify({ ...job.inputs, ...(job.inputs.artifacts ? { artifacts: lineNumbered } : {}), conversation: job.inputs.conversation?.map(x => ({ ...x, exchange_identity: exchangeIdentity(x) })) }), '# END UNTRUSTED JOB INPUTS',
    `Criteria: ${JSON.stringify(job.criteria)}`].join('\n')
}
function bad(message) { throw new JudgeOutputError(message) }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) bad('malformed strict judge object')
}
export function validateCitation(c, inputs) {
  exact(c, ['path', 'start_line', 'end_line', 'gate', 'exchange'])
  if ([c.path, c.gate, c.exchange].filter(x => x !== null).length !== 1) bad('citation must name exactly one target')
  if (c.path !== null) {
    if (typeof c.path !== 'string' || !Object.hasOwn(inputs.artifacts ?? {}, c.path)) bad('citation does not resolve to a collected file')
    if (c.start_line === null && c.end_line === null) return 'file'
    const lines = inputs.artifacts[c.path].split('\n').length
    if (!Number.isInteger(c.start_line) || !Number.isInteger(c.end_line) || c.start_line < 1 || c.end_line < c.start_line || c.end_line > lines) bad('citation line range is outside collected file')
    return 'span'
  }
  if (c.start_line !== null || c.end_line !== null) bad('non-file citation has line numbers')
  if (c.gate !== null) {
    if (!inputs.gates?.some(x => x.id === c.gate && x.passed === false && x.id.startsWith('gate:required-artifact:'))) bad('citation is not an artifact absence gate')
    return 'gate'
  }
  if (!inputs.conversation?.some(x => exchangeIdentity(x) === c.exchange)) bad('citation does not resolve to an exchange')
  return 'exchange'
}
export function validateFinding(r, job) {
  if (!Array.isArray(r.citations)) bad('missing citations')
  const kinds = r.citations.map(c => validateCitation(c, job.inputs))
  if (['coverage', 'quality'].includes(job.kind)) {
    if (r.verdict !== 'missing' && !kinds.includes('span')) bad('met/partial must cite an artifact line range')
    if (r.verdict === 'missing' && !kinds.some(x => ['file', 'span', 'gate'].includes(x))) bad('missing must cite inspected files or an absence gate')
  }
  if (job.kind === 'fidelity') {
    if (r.verdict === 'partial') bad('fidelity verdict is binary')
    // A graded (coverage-owned) subject is valid output that normalizeFidelity
    // turns into no deduction; only ids outside the inventory are invalid.
    if (r.subject_id !== null && !job.inputs.items.some(x => x.id === r.subject_id) && !gradedSubject(r, job)) bad('unknown item cannot receive a fidelity deduction')
    if (gradedSubject(r, job)) return true
    if (r.verdict === 'met' && (!kinds.includes('span') || !r.citations.some(c => c.exchange === r.id.slice('fidelity:'.length)))) bad('fidelity deduction must cite artifact and the matching exchange')
  }
  if (job.kind === 'disclosure') {
    if (r.verdict === 'partial') bad('disclosure verdict is binary')
    if (r.verdict === 'met' && !kinds.includes('exchange')) bad('disclosure flag must cite an exchange')
    if (!r.id.startsWith('leak:') && r.verdict === 'met' && !r.citations.some(c => c.exchange === r.id.slice(r.id.indexOf(':') + 1))) bad('disclosure flag cites a different exchange')
  }
  if (job.kind === 'discovery' && r.asked && !kinds.includes('exchange')) bad('asked decision needs an exchange citation')
  return true
}
const gradedSubject = (r, job) => r.subject_id !== null && (job.inputs.coverage_owned_matters ?? []).some(x => x.id === r.subject_id)
// Contradictions of graded items are scored only under coverage. A fidelity
// finding naming one is recorded for the report and normalized to no deduction.
export function normalizeFidelity(results, job) {
  if (job.kind !== 'fidelity') return results
  return results.map(r => gradedSubject(r, job) ? { ...r, verdict: 'missing', excluded_graded_contradiction: { subject_id: r.subject_id, judged_verdict: r.verdict } } : r)
}
export function excludedGradedContradictions(record) {
  return (record.votes ?? []).filter(v => v.excluded_graded_contradiction).map(v => ({ criterion: v.id, subject_id: v.excluded_graded_contradiction.subject_id, judged_verdict: v.excluded_graded_contradiction.judged_verdict, panel_index: v.panel_index, family: v.family, rationale: v.rationale, citations: v.citations }))
}
// Drop-and-keep: each citation is validated on its own; invalid ones are
// removed and recorded, and the verdict's requirements apply to those kept.
function keepValidCitations(citations, inputs) {
  if (!Array.isArray(citations)) bad('missing citations')
  const kept = []; const dropped = []
  for (const citation of citations) {
    try { validateCitation(citation, inputs); kept.push(citation) }
    catch (error) { if (!(error instanceof JudgeOutputError)) throw error; dropped.push({ citation, reason: error.message }) }
  }
  return { kept, dropped }
}
export function parseJobOutput(text, job, criteria = job.criteria) {
  let payload
  try { payload = JSON.parse(text) } catch { bad('judge output is not JSON') }
  exact(payload, ['results'])
  if (!Array.isArray(payload.results) || payload.results.length !== criteria.length || new Set(payload.results.map(x => x.id)).size !== criteria.length) bad('missing or duplicate criterion')
  for (const r of payload.results) {
    exact(r, job.kind === 'discovery' ? ['id', 'asked', 'rationale', 'citations'] : ['id', 'verdict', 'rationale', 'evidence', 'citations', 'subject_id', 'added_scope'])
    if (!criteria.includes(r.id) || typeof r.rationale !== 'string' || !r.rationale.trim()) bad('unknown criterion or empty rationale')
    if (job.kind === 'discovery') { if (typeof r.asked !== 'boolean') bad('invalid asked decision') }
    else {
      if (!['met', 'partial', 'missing'].includes(r.verdict) || !Array.isArray(r.evidence) || !r.evidence.length || r.evidence.some(x => typeof x !== 'string' || !x.trim())) bad('invalid verdict or evidence')
      if (r.subject_id !== null && typeof r.subject_id !== 'string') bad('invalid subject_id')
      if (!Array.isArray(r.added_scope) || job.kind !== 'fidelity' && r.added_scope.length) bad('invalid added scope')
      for (const scope of r.added_scope) {
        exact(scope, ['description', 'citations'])
        if (typeof scope.description !== 'string' || !scope.description.trim()) bad('added scope needs a description')
        const { kept, dropped } = keepValidCitations(scope.citations, job.inputs)
        if (!kept.some(c => validateCitation(c, job.inputs) === 'span')) bad('added scope needs artifact citations')
        scope.citations = kept
        if (dropped.length) scope.dropped_citations = dropped
      }
    }
    const { kept, dropped } = keepValidCitations(r.citations, job.inputs)
    r.citations = kept
    if (dropped.length) r.dropped_citations = dropped
    validateFinding(r, job)
  }
  return payload.results
}
// Validation runs inside the invocation boundary so the shared bounded retry
// loop never accepts an invalid panel vote. This is not a per-judge audit.
function guarded(member, job) {
  return { ...member, invoke: async req => {
    const text = await member.invoke(req)
    if (req.audit_stage) return text
    // Votes reach the panel with invalid citations dropped and recorded.
    return JSON.stringify({ results: normalizeFidelity(parseJobOutput(text, job, req.criteria), job) })
  } }
}
const definitionPrompt = job => { const prompt = jobPrompt(job); return () => ({ prompt, prompt_body: prompt, scope_rule: DEFINITION_SCOPE_RULE }) }
export async function runDefinitionPanel({ job, panel, decider }) {
  return runPanelJob({ job: job.name, criteria: job.criteria, verdicts: ['met', 'partial', 'missing'], order: ['met', 'partial', 'missing'],
    panel: panel.map(member => guarded(member, job)), decider: guarded(decider, job), schema: judgeSchema(job.criteria),
    buildPrompt: definitionPrompt(job),
    validateCitations: r => validateFinding(r, job), validateCitation: c => validateCitation(c, job.inputs) })
}
// Calibration: the decider alone, re-run on a recorded panel record of this job.
export async function rerunDefinitionDecider({ job, decider, record }) {
  return rerunDecider({ record, decider: guarded(decider, job), schema: judgeSchema(job.criteria), buildPrompt: definitionPrompt(job), validateCitations: r => validateFinding(r, job) })
}
export async function runDiscovery({ job, invoke }) {
  const schema = discoverySchema(job.criteria)
  const attempts = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const text = await invoke({ job: job.name, criteria: job.criteria, schema, prompt: `${jobPrompt(job)}\nReply with JSON matching: ${JSON.stringify(schema)}`, authority: JUDGE_PROFILE.decider, usage_phase: 'discovery' })
      const results = parseJobOutput(text, job)
      attempts.push({ attempt, ok: true })
      return { results, attempts, authority: JUDGE_PROFILE.decider, protocol: PANEL_PROTOCOL }
    } catch (error) {
      attempts.push({ attempt, ok: false, error: error.message })
      if (error.retryable === false || attempt === 3) throw Object.assign(error, { attempts })
    }
  }
}
