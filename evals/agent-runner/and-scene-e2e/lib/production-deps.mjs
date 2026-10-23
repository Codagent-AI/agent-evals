// The real dependencies of product evaluation: host judges, browser judges and fresh browser contexts.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAxiBrowserDriver } from '../../and-scene/lib/axi-browser-driver.mjs'
import { createHostBrowser, EVALUATOR_AXI_SESSION } from '../../and-scene/lib/host-browser.mjs'
import { createProductJudges } from './product-judges.mjs'
import { createBrowserJudgeInvoker } from './browser-judge-invokers.mjs'
import { normalizeReplay } from './judge-requests.mjs'
const SECOND_OPINION_SCHEMA = { type: 'object', additionalProperties: false, required: ['decision', 'rationale', 'replay'], properties: { decision: { type: 'string', enum: ['uphold', 'overturn'] }, rationale: { type: 'string', minLength: 1 }, replay: { anyOf: [{ type: 'null' }, { type: 'object' }] } } }
const VERIFIER_SCHEMA = { type: 'object', additionalProperties: false, required: ['found', 'command', 'rationale'], properties: { found: { type: 'boolean' }, command: { type: ['array', 'null'], items: { type: 'string' } }, rationale: { type: 'string', minLength: 1 } } }
export function createProductionDeps({ runDir, env = process.env, chromePath = env.AND_SCENE_HOST_CHROME, port = 9333, judges = createProductJudges({ runDir, allowedRoots: [join(runDir, 'neutral')], env }) } = {}) {
  const rawBrowserInvoke = createBrowserJudgeInvoker({ runDir, env })
  const decider = judges.profile.decider
  const deciderAuthority = { cli: decider.family, model: decider.model, effort: decider.effort }
  // Each driver is a fresh Chrome on the evaluator's own port and AXI session, released when its use ends.
  const startBrowser = async () => {
    if (!chromePath) throw Object.assign(new Error('set AND_SCENE_HOST_CHROME to the Chrome executable browser judging uses'), { owner: 'evaluation-harness', resumable: true })
    const browser = createHostBrowser({ chromePath, port, runDir, env })
    await browser.ensure()
    return browser
  }
  const createDriver = async (label, { url }) => {
    const browser = await startBrowser()
    return Object.assign(createAxiBrowserDriver({ baseUrl: url }), { close: () => browser.release() })
  }
  // A judge CLI drives the same evaluator browser the replays use, so it gets it for the length of the call.
  const browserInvoke = async request => {
    const browser = await startBrowser()
    try { return await rawBrowserInvoke({ ...request, browser_session: EVALUATOR_AXI_SESSION }) } finally { await browser.release() }
  }
  const secondOpinion = async ({ id, entry, url, requirement }) => {
    const prompt = [`A judge panel failed the criterion ${id} for a delivered web product: ${entry.rationale}`, `The product is served at ${url}. Open it with the chrome-devtools-axi command-line browser (always set CHROME_DEVTOOLS_AXI_SESSION=${EVALUATOR_AXI_SESSION}).`, requirement ? `Requirement the criterion judges:\n${requirement}` : '', 'Operate the product again as a person would and decide whether the failure stands. Overturn only if you can reproduce the behavior and give a replay: browser actions and the result you expect.', `Reply with JSON matching: ${JSON.stringify(SECOND_OPINION_SCHEMA)}`].join('\n')
    const text = await browserInvoke({ job: `second-opinion:${id}`, authority: deciderAuthority, schema: SECOND_OPINION_SCHEMA, prompt })
    const answer = JSON.parse(text)
    return { decision: answer.decision, rationale: answer.rationale, replay: normalizeReplay(answer.replay) }
  }
  const verifierJudge = async ({ worktree, plan, neutral }) => {
    const relevant = neutral.source_paths.filter(path => /(^|\/)package\.json$|SKILL\.md$|scripts\//.test(path))
    // The judge is tool-less, so the contents it needs travel in the prompt, bounded per file and in total.
    let budget = 60_000
    const contents = []
    for (const path of relevant) {
      if (budget <= 0) break
      const text = (await readFile(join(worktree, path), 'utf8').catch(() => null))?.slice(0, Math.min(12_000, budget))
      if (text === null || text === undefined) continue
      budget -= text.length
      contents.push(`--- ${path}\n${text}`)
    }
    const prompt = ['Name the command that runs the delivered project\'s verification tool, from its package scripts and the delivered skill. If the delivered tree has no verification tool, say found=false.', `Application root: ${plan.application_root}`, `Files: ${relevant.join(', ')}`, ...contents, `Reply with JSON matching: ${JSON.stringify(VERIFIER_SCHEMA)}`].join('\n')
    const text = await judges.invoke({ job: 'verifier-discovery', criteria: ['verifier'], schema: VERIFIER_SCHEMA, prompt, authority: deciderAuthority })
    return JSON.parse(text)
  }
  const seat = profile => ({ ...profile, invoke: browserInvoke })
  return { panel: judges.panel, decider: judges.decider, invoke: judges.invoke, browserPanel: judges.profile.panel.map(seat), browserDecider: seat(judges.profile.decider), browserInvoke, browserSessionName: EVALUATOR_AXI_SESSION, createDriver, secondOpinion, verifierJudge }
}
