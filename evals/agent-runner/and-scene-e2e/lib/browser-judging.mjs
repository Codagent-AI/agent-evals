// Browser criteria are judged by LLM judges that operate the served product; code replays every claimed pass.
import { runPanelJob } from '../../../lib/panel-judging/panel.mjs'
import { serial } from '../../../lib/panel-judging/job-pool.mjs'
import { buildBrowserRequest, normalizeReplay } from './judge-requests.mjs'
import { browserCriteria, criterionRequirement, rubricRows } from './product-rubric.mjs'
import { executeReplay, validReplay } from './replay.mjs'
import { BrowserDriverError } from '../../and-scene/lib/axi-browser-driver.mjs'
export const BROWSER_VERDICTS = ['pass', 'not-located', 'fail']
export function browserJobs(rubric) {
  const browser = new Set(browserCriteria(rubric))
  return rubric.components.flatMap(component => component.subcomponents).filter(subcomponent => subcomponent.evaluator === 'browser-judge')
    .map(subcomponent => ({ id: subcomponent.id, criteria: subcomponent.criteria.filter(id => browser.has(id)) })).filter(job => job.criteria.length)
}
// Serialize every browser use: judge CLIs, replays and second opinions share one Chrome, one at a time.
export function createBrowserSession(createDriver) {
  const queue = serial()
  const intervals = []
  let active = 0
  const withDriver = (label, run) => queue(async () => {
    active++
    const record = { label, start: intervals.length, overlapped: active > 1 }
    intervals.push(record)
    const driver = await createDriver(label)
    try { return await run(driver) } finally { await driver.close?.(); record.end = intervals.length; active-- }
  })
  return { exclusive: fn => queue(fn), withDriver, intervals }
}
// A browser-adapter fault is retried once in a fresh browser. A repeat is the harness's own fault, not the product's:
// it is reported with the replay that hit it, for diagnosis, and ends browser judging.
export async function replayInFreshBrowser({ session, label, replay, onAdapterFailure = async () => {} }) {
  for (let attempt = 1; ; attempt++) {
    try { return await session.withDriver(label, driver => executeReplay({ driver, replay })) }
    catch (error) {
      if (!(error instanceof BrowserDriverError)) throw error
      if (attempt >= 2) { await onAdapterFailure({ label, replay, error: error.message }); throw error }
    }
  }
}
const votesFor = (record, id) => (record.votes ?? []).filter(vote => vote.id === id)
// The judges' own observations, kept as the verdict's citations.
const evidenceOf = (votes, verdict) => [...new Set(votes.filter(vote => vote.verdict === verdict).flatMap(vote => vote.evidence ?? []))]
// Settled verdicts become scored verdicts only after replay (passes), second opinion (fails) or fallback review (not located).
export async function runBrowserJudging({ rubric, inventory, url, panel, decider, invoke, session, browserSession = 'e2e-browser-judge', secondOpinion, jobs = browserJobs(rubric), onJob = async (job, run) => run(), notLocatedLeads = {}, onAdapterFailure }) {
  const verdicts = {}
  const records = {}
  const failures = {}
  const judged = {}
  for (const job of jobs) {
    await onJob(job, async () => {
      const request = buildBrowserRequest({ rubric, inventory, job, url, browserSession })
      // Judge CLIs touch the browser, so seats run one after another even though the panel starts them together.
      const guarded = member => ({ ...member, invoke: req => session.exclusive(() => invoke({ ...req, browser_session: browserSession })) })
      const outcome = await runPanelJob({ job: request.job, criteria: request.criteria, verdicts: BROWSER_VERDICTS, order: BROWSER_VERDICTS, panel: panel.map(guarded), decider: guarded(decider),
        buildPrompt: () => ({ ...request, authority: undefined }), schema: request.schema,
        // Browser evidence is what the judge observed, not file citations; a pass still has to replay before it counts.
        validateCitations: async result => Array.isArray(result.evidence) && result.evidence.some(item => typeof item === 'string' && item.trim()) })
      records[job.id] = outcome.record
      judged[`browser:${job.id}`] = outcome.results ?? []
      if (!outcome.ok) { failures[job.id] = outcome.failure ?? { message: outcome.record?.error ?? 'browser judge job failed', code: 'judge-output' }; return }
      for (const result of outcome.results) {
        const votes = votesFor(outcome.record, result.id)
        if (result.verdict === 'pass') {
          const candidates = votes.filter(vote => vote.verdict === 'pass').sort((a, b) => a.panel_index - b.panel_index).map(vote => ({ replay: normalizeReplay(vote.replay), evidence: vote.evidence ?? [] })).filter(candidate => validReplay(candidate.replay))
          const tried = []
          let confirmed = null
          let confirmedEvidence = []
          for (const { replay, evidence } of candidates) {
            // A fresh browser context per replay, never the judge's own.
            const replayed = await replayInFreshBrowser({ session, label: `replay:${result.id}`, replay, onAdapterFailure })
            tried.push({ replay, confirmed: replayed.confirmed, mismatch: replayed.mismatch })
            if (replayed.confirmed) { confirmed = replay; confirmedEvidence = evidence; break }
          }
          verdicts[result.id] = confirmed
            ? { id: result.id, verdict: 'pass', basis: 'replay-confirmed', replay: confirmed, attempts: tried, rationale: result.rationale, citations: confirmedEvidence }
            : { id: result.id, verdict: 'fail', basis: 'replay-mismatch', mismatch: tried.map(entry => entry.mismatch).filter(Boolean).join('; ') || 'no passing judge supplied a valid replay', attempts: tried, rationale: result.rationale, citations: evidenceOf(votes, 'pass') }
        } else if (result.verdict === 'not-located') {
          verdicts[result.id] = { id: result.id, verdict: 'fallback', basis: 'fallback-judged', rationale: result.rationale, lead: result.rationale, citations: evidenceOf(votes, 'not-located') }
        } else {
          verdicts[result.id] = { id: result.id, verdict: 'fail', basis: 'settled-fail', rationale: result.rationale, citations: evidenceOf(votes, 'fail'), votes: votes.map(vote => ({ panel_index: vote.panel_index, verdict: vote.verdict })) }
        }
      }
    })
  }
  // Settled fails get a replay-based second opinion; an overturn counts only when its replay reproduces.
  for (const [id, entry] of Object.entries(verdicts)) {
    if (entry.basis !== 'settled-fail' || !secondOpinion) continue
    const answer = await secondOpinion({ id, entry, url, requirement: criterionRequirement(rubric, inventory, id) })
    entry.second_opinion = { decision: answer.decision, rationale: answer.rationale }
    if (answer.decision === 'overturn') {
      const replay = normalizeReplay(answer.replay)
      const replayed = validReplay(replay) ? await replayInFreshBrowser({ session, label: `second-opinion:${id}`, replay, onAdapterFailure }) : { confirmed: false, mismatch: 'the second opinion supplied no valid replay' }
      entry.second_opinion.replay = { confirmed: replayed.confirmed, mismatch: replayed.mismatch }
      if (replayed.confirmed) { entry.verdict = 'pass'; entry.basis = 'second-opinion-overturned'; entry.replay = replay }
    }
  }
  return { verdicts, records, judged, failures, failed_jobs: Object.keys(failures), driver_sessions: session.intervals }
}
// The fallback review answers for criteria no browser judge could locate; an unconfirmed pass fails.
export function applyFallbacks({ verdicts, fallbackResults }) {
  const merged = { ...verdicts }
  for (const [id, entry] of Object.entries(verdicts)) {
    if (entry.verdict !== 'fallback') continue
    const decided = fallbackResults[id]
    merged[id] = { ...entry, verdict: decided?.verdict === 'pass' && decided.confirmed !== false ? 'pass' : 'fail', basis: 'fallback-judged', fallback: decided ?? null }
  }
  return merged
}
export const rowsByEvaluator = rubric => rubricRows(rubric).reduce((map, row) => ({ ...map, [row.evaluator]: [...(map[row.evaluator] ?? []), row.id] }), {})
