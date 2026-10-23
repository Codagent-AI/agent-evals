// The real dependencies of product evaluation: host judges, browser judges and fresh browser contexts.
import { join } from 'node:path'
import { createAxiBrowserDriver } from '../../and-scene/lib/axi-browser-driver.mjs'
import { createHostBrowser } from '../../and-scene/lib/host-browser.mjs'
import { createProductJudges } from './product-judges.mjs'
import { createBrowserJudgeInvoker } from './browser-judge-invokers.mjs'
import { normalizeReplay } from './judge-requests.mjs'
const SECOND_OPINION_SCHEMA = { type: 'object', additionalProperties: false, required: ['decision', 'rationale', 'replay'], properties: { decision: { type: 'string', enum: ['uphold', 'overturn'] }, rationale: { type: 'string', minLength: 1 }, replay: { anyOf: [{ type: 'null' }, { type: 'object' }] } } }
const VERIFIER_SCHEMA = { type: 'object', additionalProperties: false, required: ['found', 'command', 'rationale'], properties: { found: { type: 'boolean' }, command: { type: ['array', 'null'], items: { type: 'string' } }, rationale: { type: 'string', minLength: 1 } } }
export function createProductionDeps({ runDir, env = process.env, chromePath = env.AND_SCENE_HOST_CHROME, port = 9333 } = {}) {
  const judges = createProductJudges({ runDir, allowedRoots: [join(runDir, 'neutral')], env })
  const browserInvoke = createBrowserJudgeInvoker({ runDir, env })
  const decider = judges.profile.decider
  const deciderAuthority = { cli: decider.family, model: decider.model, effort: decider.effort }
  // Each driver is a fresh Chrome on the evaluator's own port and AXI session, released when its use ends.
  const createDriver = async (label, { url }) => {
    if (!chromePath) throw Object.assign(new Error('set AND_SCENE_HOST_CHROME to the Chrome executable browser judging uses'), { owner: 'evaluation-harness', resumable: true })
    const browser = createHostBrowser({ chromePath, port, runDir, env })
    await browser.ensure()
    return Object.assign(createAxiBrowserDriver({ baseUrl: url }), { close: () => browser.release() })
  }
  const secondOpinion = async ({ id, entry }) => {
    const prompt = [`A judge panel failed the criterion ${id} for a delivered web product: ${entry.rationale}`, 'Operate the product again as a person would and decide whether the failure stands. Overturn only if you can reproduce the behavior and give a replay: browser actions and the result you expect.', `Reply with JSON matching: ${JSON.stringify(SECOND_OPINION_SCHEMA)}`].join('\n')
    const text = await browserInvoke({ job: `second-opinion:${id}`, authority: deciderAuthority, schema: SECOND_OPINION_SCHEMA, prompt })
    const answer = JSON.parse(text)
    return { decision: answer.decision, rationale: answer.rationale, replay: normalizeReplay(answer.replay) }
  }
  const verifierJudge = async ({ worktree, plan, neutral }) => {
    const prompt = ['Name the command that runs the delivered project\'s verification tool, from its package scripts and the delivered skill. If the delivered tree has no verification tool, say found=false.', `Application root: ${plan.application_root}`, `Files: ${neutral.source_paths.filter(path => /package\.json$|SKILL\.md$|scripts\//.test(path)).join(', ')}`, `Reply with JSON matching: ${JSON.stringify(VERIFIER_SCHEMA)}`].join('\n')
    const text = await judges.invoke({ job: 'verifier-discovery', criteria: ['verifier'], schema: VERIFIER_SCHEMA, prompt, authority: deciderAuthority })
    return JSON.parse(text)
  }
  const seat = profile => ({ ...profile, invoke: browserInvoke })
  return { panel: judges.panel, decider: judges.decider, invoke: judges.invoke, browserPanel: judges.profile.panel.map(seat), browserDecider: seat(judges.profile.decider), browserInvoke, createDriver, secondOpinion, verifierJudge }
}
