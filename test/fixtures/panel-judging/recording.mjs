// Stub-only recording of the pre-extraction dual-sample-majority-v4 contract.
import * as jobs from '../../../evals/agent-runner/and-scene/lib/judge-jobs.mjs'
import * as browser from '../../../evals/agent-runner/and-scene/lib/browser-eval.mjs'
import * as persistence from '../../../evals/agent-runner/and-scene/lib/persistence.mjs'
import * as invoker from '../../../evals/agent-runner/and-scene/lib/judge-invoker.mjs'
import { loadRubrics, rubricCriteria } from '../../../evals/agent-runner/and-scene/lib/rubric.mjs'
import { scoreProduct } from '../../../evals/agent-runner/and-scene/lib/scorer.mjs'

export const rubrics = await loadRubrics()
const root = 'test/fixtures/panel-judging/input'
export const inputs = {
  rubrics,
  authority: { cli: 'codex', model: 'gpt-5-codex', effort: 'high' },
  sources: ['candidate.txt'],
  neutral: { root, source_root: root, audit_root: root, requirements_root: root },
  evidenceViews: Object.fromEntries(['testing-evidence', 'assumption-handling'].map((id) => [id, {
    root, index: 'candidate.txt', packet: 'Recorded verified acceptance evidence.',
  }])),
}
export const modules = { jobs, browser, persistence, invoker }
export function score(outcome) {
  const deterministic = rubricCriteria(rubrics.automated.rubric)
    .filter(({ evaluator }) => evaluator === 'deterministic-browser')
    .map(({ id }) => ({ id, verdict: 'pass', rationale: 'observed', evidence: ['candidate.txt'] }))
  return scoreProduct({ rubrics, judges: outcome.judges, deterministic })
}

export async function capture() {
  const records = []
  const prompts = []
  const firstIds = new Map(jobs.productJudgeJobs(rubrics).map(({ id, criteria }) => [id, criteria[0]]))
  const outcome = await jobs.runProductJudging({
    ...inputs,
    saveJob: async (record) => records.push(record),
    invoke: async (request) => {
      prompts.push({ job: request.job, phase: request.usage_phase,
        prompt: persistence.hashString(request.prompt), schema: persistence.hashJson(request.schema) })
      if (request.audit_stage) {
        return JSON.stringify({ results: request.criteria.map((id) => ({ id,
          classification: 'confirmed', rationale: 'the cited packet resolves the claim',
          evidence: ['candidate.txt:1-2'] })) })
      }
      return JSON.stringify({ results: request.criteria.map((id, index) => ({ id,
        verdict: ((request.judge_sample === 2 && id === firstIds.get(request.job)) || index === 2) ? 'fail' : 'pass',
        rationale: 'the delivered source implements this contract', evidence: ['candidate.txt:1-2'],
        citations: request.judge_stage === 'tiebreak'
          ? [{ path: 'candidate.txt', start_line: 1, end_line: 2 }]
          : request.line_citations === 'evidence-view' ? [] : ['candidate.txt'],
      })) })
    },
  })
  const replay = await jobs.runProductJudging({ ...inputs,
    loadJob: async ({ id }) => records.find((record) => record.id === id),
    invoke: async () => { throw new Error('a valid recorded job must be reused') },
  })
  return { replay, replay_score: score(replay), protocol: jobs.JUDGING_PROTOCOL,
    exports: Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, Object.keys(module)])),
    // Jobs run concurrently and are saved as each finishes; each record is
    // stored under its job id, so compare them in job order.
    records: records.sort((a, b) => outcome.expected_jobs.indexOf(a.id) - outcome.expected_jobs.indexOf(b.id)),
    outcome, score: score(outcome),
    prompts: prompts.sort((a, b) => {
      const left = JSON.stringify(a)
      const right = JSON.stringify(b)
      return left < right ? -1 : left > right ? 1 : 0
    }),
  }
}
