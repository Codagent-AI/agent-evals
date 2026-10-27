// The real dependencies of product evaluation: host judges, browser judges and fresh browser contexts.
import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAxiBrowserDriver } from '../../and-scene/lib/axi-browser-driver.mjs'
import { createHostBrowser, EVALUATOR_AXI_SESSION } from '../../and-scene/lib/host-browser.mjs'
import { createProductJudges } from './product-judges.mjs'
import { createBrowserJudgeInvoker } from './browser-judge-invokers.mjs'
import { BROWSER_RESULT_SCHEMA, normalizeReplay } from './judge-requests.mjs'
import { findAxiMcp, findHostChrome, hostDevtoolsPort } from './host-chrome.mjs'
// The second opinion's replay takes the same shape as a browser judge's, so the decider is told what the harness can replay.
const SECOND_OPINION_SCHEMA = { type: 'object', additionalProperties: false, required: ['decision', 'rationale', 'replay'], properties: { decision: { type: 'string', enum: ['uphold', 'overturn'] }, rationale: { type: 'string', minLength: 1 }, replay: BROWSER_RESULT_SCHEMA.properties.results.items.properties.replay } }
const VERIFIER_SCHEMA = { type: 'object', additionalProperties: false, required: ['found', 'command', 'rationale'], properties: { found: { type: 'boolean' }, command: { type: ['array', 'null'], items: { type: 'string' } }, rationale: { type: 'string', minLength: 1 } } }
// A sandboxed judge's commands end the background processes they start, so the AXI bridge starts here, outside the
// judge, and lives across its commands until the browser is released.
export function startAxiBridge(env = process.env, run = spawnSync) {
  const mcp = findAxiMcp(env)
  const result = run('chrome-devtools-axi', ['start'], { encoding: 'utf8', timeout: 60_000, env: { ...env, CHROME_DEVTOOLS_AXI_SESSION: EVALUATOR_AXI_SESSION, ...(mcp ? { CHROME_DEVTOOLS_AXI_MCP_PATH: mcp } : {}) } })
  if (result.error || result.status !== 0) throw Object.assign(new Error(`could not start the evaluator AXI bridge: ${result.error?.message || String(result.stderr || result.stdout || '').trim().slice(-300)}`), { owner: 'evaluation-harness', resumable: true })
}
// The replay driver's AXI commands run without blocking this process, which also serves the product: the shared driver's
// synchronous default would stall the server until every navigation timed out.
export function axiCommand(env = process.env) {
  return (args, input = '') => new Promise(resolve => {
    const child = spawn('chrome-devtools-axi', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', error => resolve({ error, status: null, stdout, stderr }))
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
    child.stdin.end(input)
  })
}
// AXI keeps a page selected only once one is chosen. Opening a URL with none chosen makes a new tab that stays
// selected only if it ends on the requested URL, so a product that rewrites its URL (adding query parameters,
// say) left no page selected. Selecting the fresh browser's own blank tab first makes navigation reuse it.
export async function selectStartingPage(command) {
  const fault = message => Object.assign(new Error(`could not select the evaluator browser's starting tab: ${message}`), { owner: 'evaluation-harness', resumable: true })
  const listed = await command(['pages'])
  if (listed.error || listed.status !== 0) throw fault(String(listed.error?.message ?? listed.stderr ?? listed.stdout ?? '').trim().slice(-300))
  const id = String(listed.stdout ?? '').split('\n').map(line => line.trim().match(/^(\d+),about:blank,/)?.[1]).find(Boolean)
  if (!id) throw fault('the fresh browser has no blank tab')
  const selected = await command(['selectpage', id])
  if (selected.error || selected.status !== 0) throw fault(String(selected.error?.message ?? selected.stderr ?? selected.stdout ?? '').trim().slice(-300))
}
export function createProductionDeps({ runDir, env = process.env, chromePath = findHostChrome(env), port = hostDevtoolsPort(env), startBridge = startAxiBridge, selectPage = selectStartingPage, judges = createProductJudges({ runDir, allowedRoots: [join(runDir, 'neutral')], env }) } = {}) {
  const rawBrowserInvoke = createBrowserJudgeInvoker({ runDir, env })
  const decider = judges.profile.decider
  const deciderAuthority = { cli: decider.family, model: decider.model, effort: decider.effort }
  // Each driver is a fresh Chrome on the evaluator's own port and AXI session, released when its use ends.
  const startBrowser = async () => {
    if (!chromePath) throw Object.assign(new Error('no Chrome found for browser judging: set AND_SCENE_HOST_CHROME or CHROME_PATH'), { owner: 'evaluation-harness', resumable: true })
    const browser = createHostBrowser({ chromePath, port, runDir, env })
    await browser.ensure()
    return browser
  }
  const createDriver = async (label, { url }) => {
    const browser = await startBrowser()
    const command = axiCommand(env)
    try { startBridge(env); await selectPage(command) } catch (error) { await browser.release(); throw error }
    return Object.assign(createAxiBrowserDriver({ baseUrl: url, command }), { close: () => browser.release() })
  }
  // A judge CLI drives the same evaluator browser the replays use, so it gets it for the length of the call.
  const browserInvoke = async request => {
    const browser = await startBrowser()
    try { startBridge(env); return await rawBrowserInvoke({ ...request, browser_session: EVALUATOR_AXI_SESSION }) } finally { await browser.release() }
  }
  const secondOpinion = async ({ id, entry, url, requirement }) => {
    const prompt = [`A judge panel failed the criterion ${id} for a delivered web product: ${entry.rationale}`, `The product is served at ${url}. Open it with the chrome-devtools-axi command-line browser (your browser session is already selected in your environment, so run chrome-devtools-axi commands as they are, with no environment-variable prefix).`, requirement ? `Requirement the criterion judges:\n${requirement}` : '', 'Operate the product again as a person would and decide whether the failure stands. Overturn only if you can reproduce the behavior and give a replay: browser actions and the result you expect.', `Reply with JSON matching: ${JSON.stringify(SECOND_OPINION_SCHEMA)}`].join('\n')
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
