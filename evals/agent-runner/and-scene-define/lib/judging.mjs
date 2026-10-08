// Lifecycle adapters. Every independent model job has a durable unit checkpoint.
import { mkdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { filesUnder, SUITE_ROOT, sha256 } from './files.mjs'
import { readJson, writeJsonAtomic, hashJson } from './persistence.mjs'
import { verifyUnit, beginUnit, completeUnit, failUnit } from './checkpoint.mjs'
import { makeJobs, runDefinitionPanel, runDiscovery, excludedGradedContradictions, PANEL_PROTOCOL, JUDGE_PROFILE } from './judge-jobs.mjs'
import { createDefinitionJudges } from './judge-invoker.mjs'
import { runGates } from './gates.mjs'
import { scoreDefinition, discoveryLedger } from './scoring.mjs'
export async function loadJudgingInputs({ runDir, suiteRoot = SUITE_ROOT }) {
  const artifacts = {}
  const manifest = await readJson(join(runDir, 'phases/collection.json'))
  for (const path of await filesUnder(join(runDir, 'collected'))) {
    const name = relative(join(runDir, 'collected'), path).split('\\').join('/')
    const bytes = await readFile(path)
    if (manifest.files.find(x => x.path === name)?.sha256 !== sha256(bytes)) throw new Error(`collected artifact hash mismatch: ${name}`)
    artifacts[name] = bytes.toString('utf8')
  }
  if (manifest.files.length !== Object.keys(artifacts).length) throw new Error('collected artifact manifest is incomplete')
  const conversation = (await readFile(join(runDir, 'conversation.jsonl'), 'utf8')).split('\n').filter(x => x.trim()).map(JSON.parse)
  const inventory = await readJson(join(suiteRoot, 'hidden/inventory.json'))
  const rubric = await readJson(join(suiteRoot, 'rubric.json'))
  const reference = []
  for (const path of await filesUnder(join(suiteRoot, 'hidden/reference'))) reference.push({ path: relative(join(suiteRoot, 'hidden/reference'), path), text: await readFile(path, 'utf8') })
  const policy = await readFile(join(suiteRoot, 'hidden/simulated-user-policy.md'), 'utf8')
  return { artifacts, conversation, inventory, rubric, reference, policy }
}
export function disclosureReport(record) {
  const leaked_items = record.results.filter(x => x.id.startsWith('leak:') && x.verdict === 'met').map(x => x.id.slice(5))
  const flags = record.results.filter(x => x.verdict === 'met').map(x => ({ type: x.id.startsWith('leak:') ? 'over-disclosure' : x.id.slice(0, x.id.indexOf(':')), inventory_items: x.id.startsWith('leak:') ? [x.id.slice(5)] : [], citations: x.citations, rationale: x.rationale, basis: x.basis }))
  // Retain dissenting flags too, even if settlement rules out a leak.
  const panel_flags = record.votes.filter(x => x.verdict === 'met').map(x => ({ criterion: x.id, type: x.id.startsWith('leak:') ? 'over-disclosure' : x.id.slice(0, x.id.indexOf(':')), inventory_items: x.id.startsWith('leak:') ? [x.id.slice(5)] : [], panel_index: x.panel_index, citations: x.citations, rationale: x.rationale }))
  return { status: flags.length || panel_flags.length ? 'flagged' : 'clean', flags, panel_flags, leaked_items, panel: record }
}
export function createJudgingPhases({ runDir, suiteRoot = SUITE_ROOT, getCheckpoint, setCheckpoint, persist, judges, gateCommand, loadInputs = loadJudgingInputs }) {
  let loaded; let authority
  const inputs = async () => loaded ??= await loadInputs({ runDir, suiteRoot })
  const members = () => authority ??= judges ?? createDefinitionJudges({ runDir })
  async function unit({ phase, job, target, execute }) {
    const provenance = { job, judge_profile: JUDGE_PROFILE, panel_protocol: PANEL_PROTOCOL }
    const deps = { series_identity: getCheckpoint().identity.series_identity }
    if ((await verifyUnit(getCheckpoint(), { phase, unit: job.name, inputs: provenance, dependencies: deps })).reusable) return readJson(target)
    setCheckpoint(beginUnit(getCheckpoint(), { phase, unit: job.name, inputs: provenance, dependencies: deps })); await persist()
    await mkdir(join(target, '..'), { recursive: true })
    try {
      const record = await execute()
      await writeJsonAtomic(target, record)
      if (record.ok === false) throw Object.assign(new Error(record.failure?.message ?? record.error ?? 'judge job failed'), { ...record.failure, resumable: record.failure?.resumable ?? true })
      setCheckpoint(await completeUnit(getCheckpoint(), { phase, unit: job.name, inputs: provenance, dependencies: deps, outputs: [target] })); await persist()
      return record
    } catch (error) {
      setCheckpoint(failUnit(getCheckpoint(), { phase, unit: job.name, error: error.message })); await persist()
      if (error.attempts) await writeJsonAtomic(target, { ok: false, attempts: error.attempts, error: error.message })
      if (error.retryable !== false && error.resumable === undefined) error.resumable = true
      throw error
    }
  }
  const jobs = async gates => makeJobs({ ...await inputs(), gates })
  const filename = job => job.name.replace(/[^a-zA-Z0-9_-]/g, '-') + '.json'
  async function panelJob(phase, job, directory = 'judges') {
    const target = join(runDir, directory, filename(job))
    const record = await unit({ phase, job, target, execute: async () => (await runDefinitionPanel({ job, ...members() })).record })
    return { record, target }
  }
  return {
    'disclosure-audit': async () => {
      const job = (await jobs([])).find(x => x.kind === 'disclosure')
      const { record, target } = await panelJob('disclosure-audit', job, 'audits')
      const path = join(runDir, 'audits/disclosure.json'); await writeJsonAtomic(path, disclosureReport(record))
      return [target, path]
    },
    'gates-and-judging': async () => {
      const data = await inputs()
      const gatePath = join(runDir, 'judges/gates.json')
      const gateRecord = await unit({ phase: 'gates-and-judging', job: { name: 'gates', artifacts: data.artifacts }, target: gatePath, execute: async () => ({ gates: await runGates({ runDir, artifacts: data.artifacts, command: gateCommand }) }) })
      const records = []; const outputs = [gatePath]
      for (const job of (await jobs(gateRecord.gates)).filter(x => ['coverage', 'quality', 'fidelity'].includes(x.kind))) {
        const { record, target } = await panelJob('gates-and-judging', job)
        records.push({ kind: job.kind, record }); outputs.push(target)
      }
      const audit = await readJson(join(runDir, 'audits/disclosure.json'))
      const coverage = records.filter(x => x.kind === 'coverage').flatMap(x => x.record.results)
      const quality = records.find(x => x.kind === 'quality').record.results
      const fidelity = records.find(x => x.kind === 'fidelity')?.record.results ?? []
      const scopeFindings = records.filter(x => x.kind === 'fidelity').flatMap(x => x.record.votes.flatMap(v => v.added_scope ?? []))
      const added_scope = [...new Map(scopeFindings.map(x => [hashJson(x), x])).values()]
      const excluded_graded_contradictions = records.filter(x => x.kind === 'fidelity').flatMap(x => excludedGradedContradictions(x.record))
      const scored = { ...scoreDefinition({ rubric: data.rubric, coverage, quality, fidelity, leaked: audit.leaked_items, gates: gateRecord.gates }), judge_authority: JUDGE_PROFILE, panel_protocol: PANEL_PROTOCOL, panel_records: records, disclosure_audit: audit, added_scope, excluded_graded_contradictions }
      const target = join(runDir, 'judges/score.json'); await writeJsonAtomic(target, scored)
      return [...outputs, target]
    },
    discovery: async () => {
      const job = (await jobs([])).find(x => x.kind === 'discovery')
      const target = join(runDir, 'discovery/asked.json')
      const asked = await unit({ phase: 'discovery', job, target, execute: () => runDiscovery({ job, invoke: members().decider.invoke }) })
      const scored = await readJson(join(runDir, 'judges/score.json'))
      const ledger = discoveryLedger({ coverage: scored.coverage, asked: asked.results })
      const path = join(runDir, 'discovery/ledger.json'); await writeJsonAtomic(path, ledger)
      return [target, path]
    },
  }
}
