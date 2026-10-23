import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { E2ESandbox } from '../evals/agent-runner/and-scene-e2e/lib/sandbox.mjs'
import { buildRubric } from '../evals/agent-runner/and-scene-define/lib/rubric.mjs'
import { git, startingRepo, temp } from './and-scene-e2e-helpers.mjs'
import { loadProductInputs, criteriaForJob } from '../evals/agent-runner/and-scene-e2e/lib/product-rubric.mjs'
import { scoreProduct } from '../evals/agent-runner/and-scene-e2e/lib/scoring.mjs'
import { exchangeIdentity } from '../evals/agent-runner/and-scene-define/lib/judge-jobs.mjs'

const inventory = JSON.parse(await readFile(new URL('../evals/agent-runner/and-scene-define/hidden/inventory.json', import.meta.url), 'utf8'))
export const subset = { ...inventory, items: inventory.items.filter(item => item.class !== 'preference').slice(0, 5) }
const citation = { path: 'proposal.md', start_line: 1, end_line: 1, gate: null, exchange: null }
export const result = (id, verdict, citations = [citation]) => ({ id, verdict, rationale: 'The cited commitment establishes the requirement.', evidence: ['inspected'], citations, subject_id: null, added_scope: [] })
export const profiles = Object.fromEntries(['lead', 'crosscheck', 'implementor', 'tester'].map(role => [role, { cli: 'codex', model: 'm', effort: 'high' }]))
export const STEPS = ['validate-feature-branch', 'create', 'define', 'implement', 'accept']
const codexDone = '{"type":"event_msg","payload":{"type":"task_complete"}}\n'
const claudeDone = '{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}\n'
const call = text => `{"type":"response_item","payload":{"type":"function_call","call_id":"c1","name":"shell","arguments":${JSON.stringify(text)}}}\n{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}\n${codexDone}`
const DEFINE_INVOCATIONS = [
  { id: 'proposal', prefix: 'define/sub:define-change', cli: 'codex', agent_invoked: true, session_id: 'lead-s', role: 'lead' },
  { id: 'call-1', prefix: 'define/sub:define-change/approach-review', kind: 'agent-call', role: 'crosscheck', target_name: 'crosscheck', cli: 'claude', agent_invoked: true, session_id: 'cross-s' },
]
const IMPLEMENT_INVOCATIONS = [
  { id: 'implementor-checklist', prefix: 'implement/sub:implement-change', cli: 'codex', agent_invoked: true, session_id: 'impl-s', role: 'implementor' },
  { id: 'acceptance', prefix: 'implement/sub:implement-change/acceptance', cli: 'claude', agent_invoked: true, session_id: 'test-s', role: 'tester' },
]
// A scripted sandbox over the real run-directory layout: it writes Runner state, metrics, transcripts and a workspace.
export class FakeSandbox extends E2ESandbox {
  constructor(options, harness) { super(options); this.harness = harness; this.starts = [] }
  plan() { return { command: ['fake-sandbox'], output: 'fake-plan' } }
  async isActive() { return false }
  wait() { return this.completion }
  async start(profiles_, mode) {
    const h = this.harness
    const until = mode.kind === 'fresh' ? 'define' : mode.until
    this.starts.push({ mode, until, at: h.clock.t })
    const plan = h.plans[until].shift() ?? { type: 'capped' }
    await h.writeToken?.()
    if (mode.kind === 'fresh') await h.makeWorkspace(this)
    await plan.before?.({ sandbox: this, harness: h })
    await h.writeRunner(this, until, plan.type === 'capped' ? 'capped' : plan.type === 'failed' ? 'failed' : 'running', plan)
    this.release = undefined
    if (plan.type === 'hang') { this.completion = new Promise(resolve => { this.release = resolve }); plan.during?.({ sandbox: this, harness: h }); return }
    this.completion = Promise.resolve({ code: plan.type === 'capped' ? 0 : 1, signal: null })
  }
  async stop() { this.stops = (this.stops ?? 0) + 1; this.release?.({ code: null, signal: 'SIGTERM' }) }
}
export async function lifecycle(t, { limitMs, stallMs, transcripts = {}, inspectOverrides = {}, depsOverride = {} } = {}) {
  const root = await temp(t, 'e2e-life-')
  const { bundle, commit } = await startingRepo(root)
  const runDir = join(root, 'run')
  const clock = { t: 1_800_000_000_000 }
  const harness = {
    clock, plans: { define: [], implement: [] }, activityAt: clock.t, tokens: [], published: [], quotaWaits: [],
    async makeWorkspace(sandbox) {
      const repo = join(sandbox.artifactDir, 'workspace/repo'); await mkdir(join(repo, '..'), { recursive: true })
      execFileSync('git', ['clone', '--quiet', '--no-checkout', join(sandbox.inputDir, 'starting-repo.bundle'), repo])
      git(repo, ['checkout', '--quiet', '-B', 'add-presentation-skill', 'main'])
      const change = join(repo, 'openspec/changes/add-presentation-skill'); await mkdir(change, { recursive: true }); await writeFile(join(change, 'proposal.md'), 'a single evolving scene\n')
    },
    async writeRunner(sandbox, until, kind, plan) {
      const session = join(sandbox.artifactDir, '.runtime/agent-runner-projects/p/runs/runner-one')
      await mkdir(join(session, 'output'), { recursive: true }); await mkdir(join(session, 'external-user'), { recursive: true })
      const capped = kind === 'capped'
      await writeFile(join(session, 'state.json'), JSON.stringify({ workflowName: 'change', workflowFile: 'builtin:openspec/change-v3.0.yaml', currentStep: { stepId: until, completed: capped }, completed: false }))
      const end = kind === 'failed' ? `2026-10-23T00:00:00Z [${until}] step_end {"outcome":"failed","error":"${plan.error ?? 'CLI failed'}"}\n${plan.audit ?? ''}` : capped ? `2026-10-23T00:00:00Z [${until}] step_end {"outcome":"success"}\n2026-10-23T00:00:00Z run_end {"outcome":"success","completed":false}\n` : `2026-10-23T00:00:00Z [${until}, sub:x, y] step_start {}\n`
      await writeFile(join(session, 'audit.log'), `2026-10-23T00:00:00Z run_start {}\n${end}`)
      const invoked = until === 'define' ? DEFINE_INVOCATIONS : [...DEFINE_INVOCATIONS, ...IMPLEMENT_INVOCATIONS]
      await writeFile(join(session, 'run-metrics.json'), JSON.stringify({ schema_version: 3, run_id: 'runner-one', workflow: 'change', history_complete: false, steps: invoked }))
      await writeFile(join(session, 'external-user/exchanges.jsonl'), harness.exchanges ?? '')
      await writeFile(join(sandbox.runDir, 'conversation.jsonl'), harness.conversation ?? '')
      for (const invocation of invoked) {
        const text = transcripts[invocation.session_id] ?? (invocation.cli === 'claude' ? claudeDone : codexDone)
        const native = invocation.cli === 'claude' ? join(sandbox.artifactDir, '.runtime/claude/projects/p') : join(sandbox.artifactDir, '.runtime/codex/sessions')
        await mkdir(native, { recursive: true })
        await writeFile(join(native, invocation.cli === 'claude' ? `${invocation.session_id}.jsonl` : `rollout-x-${invocation.session_id}.jsonl`), text)
      }
      await writeFile(join(session, 'output/define_sub_define-change.attempt-1.turn-1.out'), '{"type":"turn.completed"}\n')
      if (until === 'implement') await writeFile(join(session, 'output/implement_sub_implement-change.attempt-1.turn-1.out'), '{"type":"turn.completed"}\n')
    },
  }
  const options = { runDir, profiles, timeLimitMs: limitMs ?? 12 * 3600e3, stallWindowMs: stallMs ?? 45 * 60e3, tokenRefreshMinutes: 30, runnerDir: root, skillsDir: root, workflow: 'openspec:change', repoDir: root }
  const rubric = buildRubric(subset)
  const productInputs = await loadProductInputs()
  const judgeCalls = []
  const asked = n => ({ id: null, asked: n % 2 === 0 })
  const base = index => async req => {
    judgeCalls.push({ job: req.job, stage: req.audit_stage, index })
    if (req.audit_stage) return JSON.stringify({ results: req.criteria.map(id => ({ id, classification: harness.classification?.(req) ?? 'confirmed', rationale: 'matches', evidence: ['x'] })) })
    if (req.job === 'discovery') return JSON.stringify({ results: req.criteria.map((id, n) => ({ id, asked: false, rationale: 'not asked', citations: [] })) })
    return JSON.stringify({ results: req.criteria.map(id => {
      if (req.job === 'disclosure-audit') {
        const flagged = harness.leak?.(id, index)
        return result(id, flagged ? 'met' : 'missing', flagged ? [{ path: null, start_line: null, end_line: null, gate: null, exchange: harness.exchangeId }] : [])
      }
      if (req.job === 'fidelity') return result(id, 'missing', [{ path: null, start_line: null, end_line: null, gate: null, exchange: harness.exchangeId }])
      return result(id, 'met')
    }) })
  }
  // One simulated-user exchange, recorded consistently by the host, the Runner and the lead transcript.
  harness.withExchange = ({ reply = 'No preference, your call.' } = {}) => {
    const exchange = { schema_version: 1, run_id: 'runner-one', step: 'define.specs', step_id: 'specs', attempt: 1, turn: 1, cli: 'codex', session_id: 'lead-s', empty_turn: false, agent_message: 'What are the requirements?', text: reply, reply, reply_type: 'answer', simulated_approval: false, usage: null }
    harness.exchange = exchange; harness.exchangeId = exchangeIdentity(exchange)
    harness.conversation = JSON.stringify(exchange) + '\n'
    const request = { step: exchange.step, step_id: exchange.step_id, attempt: exchange.attempt, turn: exchange.turn, session_id: exchange.session_id }
    const identity = { step_key: exchange.step, attempt: 1, turn: 1 }
    harness.exchanges = [{ type: 'request_written', identity, request }, { type: 'reply_acted', identity, reply: { text: reply } }].map(record => JSON.stringify(record)).join('\n') + '\n'
    transcripts['lead-s'] = `{"type":"message","role":"user","content":[{"type":"input_text","text":${JSON.stringify(reply)}}]}\n` + codexDone
    conversationInputs.splice(0, conversationInputs.length, exchange)
  }
  const conversationInputs = []
  const judges = { panel: [0, 1, 2].map(n => ({ family: n ? 'codex' : 'claude', model: 'stub', effort: 'high', invoke: base(n) })), decider: { family: 'claude', model: 'stub-d', effort: 'high', invoke: base(3) } }
  const identity = { seriesIdentity: { version: 1 }, candidate: { profiles, agent_skills_commit: 'skills-one', workflow: { reference: 'openspec:change', name: 'change', hash: 'h1' } }, credentials: [], forwardedEnv: [], reviewerClis: ['claude'],
    workflow: { name: 'change', roles: Object.keys(profiles), top_steps: STEPS }, provisioning: { app: { runToken: async () => ({ token: 'run-token' }), paged: async () => [] }, token: 'prov-token' }, ...inspectOverrides }
  const sandbox = new FakeSandbox({ runDir, runnerDir: root, skillsDir: root, workflow: 'openspec:change', deliveryUrl: 'https://github.com/Codagent-AI/e2e-run-test.git', reviewerClis: ['claude'] }, harness)
  const deliveryCalls = []
  const full = scoreProduct({ rubric: productInputs.rubric, verdicts: Object.fromEntries(productInputs.rubric.components.flatMap(c => c.subcomponents.flatMap(s => s.criteria)).map(id => [id, { verdict: 'pass', basis: 'x', rationale: 'ok', citations: [] }])) })
  const deps = {
    sandbox, inspect: async () => identity, safetyCheck: async () => {}, now: () => clock.t, monitorMs: 5, activity: () => harness.activityAt,
    materialize: async dir => { await mkdir(dir, { recursive: false }); return { bundlePath: bundle, commit, treeHash: 'tree' } },
    provisionDelivery: async ({ runId }) => ({ full_name: `Codagent-AI/e2e-run-${runId}`, id: 9001, created_at: '2026-10-23T00:00:00Z', private: true, clone_url: 'x', starting_commit: commit }),
    reuseDelivery: async ({ recorded }) => { harness.reused = recorded; return recorded },
    tokens: { mint: async () => { harness.tokens.push(1); return { token: `run-token-${harness.tokens.length}` } } },
    simulatedUser: async () => ({ reply_type: 'answer', text: 'no preference', usage: null }),
    readHead: async () => 'b'.repeat(40), judges, gateCommand: async () => ({ status: 0, stdout: '', stderr: '' }),
    loadInputs: async () => ({ inventory: subset, rubric, artifacts: { 'proposal.md': 'a single evolving scene\n' }, conversation: conversationInputs, reference: [], policy: 'Answer only what was asked.' }),
    startDefineResponder: ({ signal }) => new Promise(resolve => { const done = () => resolve({ status: 'stopped' }); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done() }),
    handlers: {
      'delivery-verification': async () => {
        deliveryCalls.push(1)
        const target = join(runDir, 'phases/delivery.json'); await mkdir(join(runDir, 'source'), { recursive: true }); await writeFile(join(runDir, 'source/candidate.bundle'), 'bundle')
        await writeFile(target, JSON.stringify({ ok: true, repository: 'Codagent-AI/e2e-run-test', delivered_commit: 'c'.repeat(40), bundle: { path: 'source/candidate.bundle', sha256: 'h' }, acceptance: { delivered_commit: 'c'.repeat(40), artifacts: [], missing_roles: [], findings: [] }, extras: { branches: [], pull_requests: [] }, prohibited_effects: [] }))
        return [target, join(runDir, 'source/candidate.bundle')]
      },
      'product-evaluation': async () => {
        const target = join(runDir, 'phases/product-result.json')
        await writeFile(target, JSON.stringify({ build_plan: {}, build: { ok: true }, gates: [], score: full, verdicts: {}, human_review: { eligible: true } }))
        return [target]
      },
    },
    publish: async ({ result: published }) => { harness.published.push(published.run_id); await writeFile(join(runDir, 'publication.json'), '{}') },
    ...depsOverride,
  }
  return { root, runDir, options, deps, harness, sandbox, judgeCalls, clock, deliveryCalls, rubric, subset, read: async path => JSON.parse(await readFile(join(runDir, path), 'utf8')), exchangeIdentity }
}
export { criteriaForJob }
