// Product evaluation on the host: build plan, build in a throwaway container, serving, browser judging with
// replay confirmation, source and evidence judging on the shared panel, gates and the automated score.
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { collectAmbiguityArtifacts, runAmbiguityDiagnostics } from '../../and-scene/lib/ambiguity.mjs'
import { join } from 'node:path'
import { runPanelJob } from '../../../lib/panel-judging/panel.mjs'
import { runJobPool } from '../../../lib/panel-judging/job-pool.mjs'
import { PacketOverflowError, citationTarget, judgeFailure, runJudgeJob } from '../../../lib/panel-judging/protocol.mjs'
import { hashJson, readJson, writeJsonAtomic } from '../../../lib/define-run/persistence.mjs'
import { buildProduct, resolveBuildPlan } from './build-plan.mjs'
import { cloneFromBundle } from './delivery.mjs'
import { materializeNeutral, verifyNeutral } from './neutral.mjs'
import { buildJudgeRequest, judgeJobs } from './judge-requests.mjs'
import { applyFallbacks, createBrowserSession, runBrowserJudging } from './browser-judging.mjs'
import { browserCriteria } from './product-rubric.mjs'
import { browserDependentCriteria, evaluateGates, scoreProduct } from './scoring.mjs'
import { serveOutput } from './serve.mjs'
import { runContainer } from './container.mjs'
export const PRODUCT_JUDGE_CONCURRENCY = 3
// Bumped when a harness fix changes what product evaluation records, so a retained result from before the fix is
// recomputed on resume (cached judge jobs whose inputs are unchanged are still reused). 2: verifier exit status kept,
// and evidence images copied as bytes and left out of the text budget. 3: a cited binary file is named by a marker
// in judge packets instead of decoded into them.
export const PRODUCT_EVALUATION_VERSION = 3
const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i
export class ProductHarnessError extends Error {
  constructor(message, { failures = {}, resumable = true } = {}) { super(message); Object.assign(this, { failures, resumable, owner: 'evaluation-harness', code: 'product-judging-failed' }) }
}
const sha = value => hashJson(value)
// Persisted, input-hashed work units: completed ones are reused on resume, unfinished ones rerun alone.
export function fileUnits(runDir, { onComplete = async () => {}, onReuse = () => {} } = {}) {
  return async function unit(name, inputs, produce, { cache = () => true, verify = null } = {}) {
    const target = join(runDir, 'phases/product', `${name.replace(/[^a-zA-Z0-9_.-]/g, '-')}.json`)
    const recorded = await readJson(target, null).catch(() => null)
    // Reuse needs the inputs, the recorded output's own hash and, where the output points at files, those files to still match.
    if (recorded?.input_hash === sha(inputs) && recorded.output_hash === sha(recorded.value ?? null) && (!verify || await verify(recorded.value))) { onReuse(name); return recorded.value }
    const value = await produce()
    // An unfinished unit (a judge job that returned nothing usable) is never recorded as complete.
    if (!cache(value)) return value
    await mkdir(join(target, '..'), { recursive: true })
    await writeJsonAtomic(target, { input_hash: sha(inputs), output_hash: sha(value ?? null), value })
    await onComplete(name, target)
    return value
  }
}
export async function evidenceView({ runDir, collectedDir, acceptance }) {
  const root = join(runDir, 'neutral/evidence')
  await mkdir(root, { recursive: true })
  const paths = []; let chars = 0
  // Images are copied byte for byte for judges that can view them; only text counts toward the packet budget.
  const add = async (path, content) => { const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content); paths.push(path); if (typeof content === 'string') chars += content.length }
  const read = path => readFile(path).then(bytes => IMAGE.test(path) ? bytes : bytes.toString('utf8'))
  for (const file of await readdir(collectedDir, { recursive: true }).catch(() => [])) {
    const content = await read(join(collectedDir, file)).catch(() => null)
    if (content !== null) await add(`definition/${file}`, content)
  }
  for (const artifact of acceptance?.artifacts ?? []) await add(`acceptance/${artifact.file.split('/').at(-1)}`, await read(join(runDir, artifact.file)).catch(() => ''))
  await add('acceptance/readiness.json', JSON.stringify({ delivered_commit: acceptance?.delivered_commit ?? null, missing_roles: acceptance?.missing_roles ?? [], findings: acceptance?.findings ?? [] }, null, 2))
  return { root, paths: paths.sort(), chars }
}
async function validateSourceCitations(result, request) {
  if (!result.citations?.length) return false
  for (const path of result.citations) {
    if (typeof path !== 'string' || !request.verified_source_paths.includes(path)) throw new Error(`source citation is outside the verified inventory: ${path}`)
    await citationTarget(request.input_roots.source, path)
  }
  return true
}
export async function evaluateProduct({ runDir, rubric, inventory, bundlePath, commit, collectedDir, acceptance, plan: recordedPlan = null, deps = {}, unit = fileUnits(runDir) }) {
  const run = deps.containerRun ?? runContainer
  const worktree = await cloneFromBundle({ runDir, target: join(runDir, '.product/worktree'), bundlePath })
  const plan = recordedPlan ?? await unit('build-plan', { commit }, () => resolveBuildPlan({ worktree }))
  const build = await unit('build', { commit, plan }, () => buildProduct({ worktree, copyDir: join(runDir, '.product/build'), plan, run }).then(({ output_dir, ...rest }) => ({ ...rest, output_dir: output_dir ?? null })),
    { verify: value => value.ok === false || access(join(runDir, '.product/build', value.output, 'index.html')).then(() => true, () => false) })
  // The plan carries the output the build resolved, so a rebuild must produce it again.
  const resolvedPlan = build.ok ? { ...plan, output: build.output } : plan
  const neutral = await unit('neutral', { commit }, () => materializeNeutral({ runDir, repo: worktree, commit, inventory }), { verify: value => verifyNeutral({ runDir, value }) })
  const verdicts = {}
  const browserIds = browserCriteria(rubric)
  const notes = { browser: null }
  let notObserved = []
  if (build.ok) {
    const output = join(runDir, '.product/build', build.output)
    const server = await (deps.serve ?? serveOutput)({ root: output })
    try {
      const session = deps.browserSession ?? createBrowserSession(label => deps.createDriver(label, { url: server.url }))
      const browser = await unit('browser-judging', { commit, plan, build: build.output, rubric: rubric.version }, async () => {
        const result = await runBrowserJudging({ rubric, inventory, url: server.url, panel: deps.browserPanel ?? deps.panel, decider: deps.browserDecider ?? deps.decider, invoke: deps.browserInvoke ?? deps.invoke, session, browserSession: deps.browserSessionName, secondOpinion: deps.secondOpinion,
          onAdapterFailure: failure => writeJsonAtomic(join(runDir, 'phases/product/browser-replay-failures.json'), failure) })
        return { verdicts: result.verdicts, failed_jobs: result.failed_jobs, failures: result.failures, driver_sessions: result.driver_sessions, records: result.records, judged: result.judged }
      }, { cache: value => value.failed_jobs.length === 0 })
      // A failed job is not cached, so its panel records are kept here for diagnosis.
      if (browser.failed_jobs.length) await writeJsonAtomic(join(runDir, 'phases/product/browser-judging-failed.json'), { failed_jobs: browser.failed_jobs, failures: browser.failures, records: browser.records })
      if (browser.failed_jobs.length) throw new ProductHarnessError(`browser judge jobs never returned usable output: ${browser.failed_jobs.join(', ')}`, { failures: browser.failures })
      notes.browser = browser
      Object.assign(verdicts, browser.verdicts)
      notObserved = Object.values(browser.verdicts).filter(entry => entry.verdict === 'fallback').map(entry => ({ id: entry.id, rationale: entry.rationale }))
    } finally { await server.close?.() }
  } else {
    // A failed build zeroes every browser-dependent criterion; no fallback judge decides them.
    for (const id of browserDependentCriteria(rubric)) verdicts[id] = { id, verdict: 'fail', basis: 'build-failed', reason: build.reason ?? 'the build failed', rationale: `the product did not build: ${build.reason ?? 'build failure'}` }
  }
  // Source and evidence judging on the shared panel.
  const evidence = await evidenceView({ runDir, collectedDir, acceptance })
  const jobs = judgeJobs(rubric, { notObserved })
  const incomplete = {}
  const failures = {}
  const records = {}
  const panelRecords = {}
  const judged = await runJobPool({ jobs, concurrency: deps.concurrency ?? PRODUCT_JUDGE_CONCURRENCY, run: async job => {
    const facts = [`build: ${build.ok ? `succeeded (output ${build.output})` : `failed (${build.reason})`}`]
    let request
    try { request = buildJudgeRequest({ rubric, inventory, job: job.id, neutral, sourcePaths: neutral.source_paths, evidence, notObserved, facts }) }
    catch (error) {
      if (error instanceof PacketOverflowError) return { id: job.id, overflow: error.message }
      throw error
    }
    const fallbackIds = notObserved.filter(entry => rubric.fallbacks[entry.id]?.job === job.id).map(entry => entry.id)
    const value = await unit(`judge-${job.id}`, { job: job.id, commit, prompt: request.prompt, rubric: rubric.version }, async () => {
      const outcome = await runPanelJob({ job: job.id, criteria: request.criteria, verdicts: ['pass', 'fail'], order: ['pass', 'fail'], panel: deps.panel, decider: deps.decider,
        buildPrompt: () => ({ ...request, panel_line_citations: true, requireSourceCitationsFor: fallbackIds }), schema: request.schema,
        audit: ({ request: next, invoke }) => runJudgeJob({ request: next, invoke }), validateCitations: result => validateSourceCitations(result, request) }).catch(error => ({ ok: false, failure: judgeFailure(error), record: { failure: judgeFailure(error) } }))
      if (outcome.ok) return { ok: true, results: outcome.results.map(({ id, verdict, rationale, citations, basis, votes }) => ({ id, verdict, rationale, citations: citations ?? [], basis, votes })), panel: outcome.record }
      // An overflow raised by an audit or check inside the shared engine leaves only this job's component incomplete.
      if (outcome.failure?.code === 'packet-overflow') return { ok: false, overflow: outcome.failure.message, panel: outcome.record, evaluator: PRODUCT_EVALUATION_VERSION }
      return { ok: false, failure: outcome.failure ?? { message: 'judge output exhausted' } }
    // An overflow recorded before a harness fix may not recur, so only one from this evaluator version is reused.
    }, { cache: value => value.ok !== false || Boolean(value.overflow), verify: value => !value.overflow || value.evaluator === PRODUCT_EVALUATION_VERSION })
    return { id: job.id, value }
  } })
  for (const entry of judged) {
    const overflow = entry.overflow ?? entry.value?.overflow
    if (overflow) { for (const component of rubric.components) if (component.subcomponents.some(subcomponent => subcomponent.job === entry.id)) incomplete[component.id] = `the ${entry.id} judge packet overflowed: ${overflow}`; continue }
    if (!entry.value.ok) { failures[entry.id] = entry.value.failure; continue }
    records[entry.id] = entry.value.results
    panelRecords[entry.id] = entry.value.panel
  }
  // An exhausted job is unobserved evidence: the run is a resumable harness failure, never a lower score.
  if (Object.keys(failures).length) throw new ProductHarnessError(`judge jobs never returned usable output: ${Object.keys(failures).join(', ')}`, { failures })
  const fallbackResults = {}
  for (const [job, results] of Object.entries(records)) for (const result of results) {
    if (browserIds.includes(result.id)) fallbackResults[result.id] = { verdict: result.verdict, confirmed: (result.citations ?? []).length > 0, citations: result.citations }
    else verdicts[result.id] = { id: result.id, verdict: result.verdict, basis: result.basis, rationale: result.rationale, citations: result.citations }
  }
  Object.assign(verdicts, applyFallbacks({ verdicts: Object.fromEntries(Object.entries(verdicts).filter(([id]) => browserIds.includes(id))), fallbackResults }))
  // Verifier gate: a source judge names the command from the delivered tree; it runs in the same container.
  let verifier = { found: false, clear: false, reason: 'the product did not build' }
  if (build.ok && deps.verifierJudge) {
    const named = await unit('verifier-discovery', { commit }, async () => {
      const found = await deps.verifierJudge({ worktree, plan, neutral })
      if (!found || typeof found.found !== 'boolean' || (found.found && !(Array.isArray(found.command) && found.command.length && found.command.every(part => typeof part === 'string' && part)))) throw new ProductHarnessError('the verifier judge returned no usable output')
      return found
    })
    if (!named.found) verifier = { found: false, clear: false, reason: named.rationale ?? 'no verifier exists in the delivered tree' }
    else verifier = await unit('verifier-run', { commit, command: named.command, plan: resolvedPlan, rubric: rubric.version, evaluator: PRODUCT_EVALUATION_VERSION }, async () => {
      try { const out = run({ mounts: [{ source: join(runDir, '.product/build'), target: '/work', readonly: false }], workdir: plan.application_root === '.' ? '/work' : `/work/${plan.application_root}`, network: 'none', command: named.command }, { label: 'verifier' }); return { found: true, command: named.command, clear: true, exit_code: 0, stdout_tail: String(out.stdout ?? '').slice(-2000) } }
      catch (error) { return { found: true, command: named.command, clear: Number.isInteger(error.status) && error.status > 0, exit_code: error.status ?? null, reason: Number.isInteger(error.status) ? null : 'the verifier did not finish with an exit status', stderr_tail: String(error.stderr ?? error.message).slice(-2000) } }
    })
  }
  // Ambiguity diagnostics: non-scoring, from the retained acceptance records and the verdicts just reached.
  const ambiguity = await unit('ambiguity', { commit, rubric: rubric.version, artifacts: (acceptance?.artifacts ?? []).map(artifact => artifact.sha256) }, async () => {
    const artifacts = await collectAmbiguityArtifacts({ sessionDir: join(runDir, 'evidence/final/acceptance') })
    const productEvidence = Object.values(verdicts).map(entry => ({ id: entry.id, verdict: entry.verdict, note: entry.rationale ?? entry.reason ?? '' }))
    return (await runAmbiguityDiagnostics({ runId: deps.runId ?? 'unknown', artifacts, productEvidence, authority: deps.ambiguityAuthority, invoke: deps.ambiguityInvoke })).ledger
  })
  const gates = evaluateGates({ rubric, verdicts, build, verifier })
  const score = scoreProduct({ rubric, verdicts, incomplete })
  const judgeRecords = { ...records, ...(notes.browser?.judged ?? {}) }
  // unit_plan is the plan this evaluation keyed its cached units by; a resume passes it back so those units are reused.
  return { build_plan: resolvedPlan, unit_plan: plan, ambiguity_ledger: ambiguity, judge_records: judgeRecords, panel_records: { ...panelRecords, ...Object.fromEntries(Object.entries(notes.browser?.records ?? {}).map(([id, record]) => [`browser:${id}`, record])) }, build: { ok: build.ok, output: build.output ?? null, reason: build.reason ?? null, log: build.log }, serve: { output: build.output ?? null }, gates, verifier, score, verdicts, browser: notes.browser, not_located: notObserved.map(entry => entry.id), 
    human_review: build.ok ? { eligible: true } : { eligible: false, reason: `the product could not be built: ${build.reason}` }, neutral_manifest_sha256: neutral.manifest.manifest_sha256 }
}
