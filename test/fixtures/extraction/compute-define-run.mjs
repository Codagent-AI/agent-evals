// Records golden outputs of the define-run modules through whichever import root is given (old layout or new).
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const SUITE_OWNED = new Set(['publication', 'result', 'report', 'comparison', 'rescore', 'calibration', 'outcomes', 'phases', 'collection'])
export async function compute(root, suiteLib = fileURLToPath(new URL('../../../evals/agent-runner/and-scene-define/lib', import.meta.url))) {
  const lib = name => import(`${SUITE_OWNED.has(name) ? suiteLib : root}/${name}.mjs`)
  const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
  const out = {}
  const define = fileURLToPath(new URL('../../../evals/agent-runner/and-scene-define', import.meta.url))
  const inventory = JSON.parse(await readFile(join(define, 'hidden/inventory.json'), 'utf8'))
  const rubricFile = JSON.parse(await readFile(join(define, 'rubric.json'), 'utf8'))
  const rubricLib = await lib('rubric')
  out.rubric_build = sha(rubricLib.buildRubric(inventory)); out.rubric_check = sha(rubricLib.checkRubric(rubricFile, inventory))
  const scoring = await lib('scoring')
  const subset = { ...inventory, items: inventory.items.filter(i => i.class !== 'preference').slice(0, 6) }
  const rubric = rubricLib.buildRubric(subset)
  const coverage = rubric.coverage.map((c, n) => ({ id: c.id, verdict: ['met', 'partial', 'missing'][n % 3], rationale: 'r', evidence: ['e'], citations: [] }))
  const quality = rubric.quality.map((c, n) => ({ id: c.id, verdict: ['met', 'partial', 'missing'][(n + 1) % 3], rationale: 'r', evidence: ['e'], citations: [] }))
  out.scoring = sha(scoring.scoreDefinition({ rubric, coverage, quality, fidelity: [{ id: 'f1', verdict: 'met' }, { id: 'f2', verdict: 'missing' }], leaked: [rubric.coverage[0].id], gates: [{ id: 'g', passed: true }] }))
  out.discovery = sha(scoring.discoveryLedger({ coverage: coverage.map((c, n) => n === 0 ? { ...c, verdict: 'leaked' } : c), asked: coverage.map((c, n) => ({ id: c.id, asked: n % 2 === 0, citations: [] })) }))
  const contamination = await lib('contamination')
  const patterns = JSON.parse(await readFile(join(define, 'contamination-patterns.json'), 'utf8'))
  const call = (id, name, input, output = '') => ({ id, name, input, output })
  out.contamination = sha(contamination.auditContamination({ transcripts: [{ source: 's', session_id: 'x', calls: [call('1', 'Bash', 'cat ../../exchange/a.reply.json'), call('2', 'WebFetch', 'https://github.com/Codagent-AI/and-scene'), call('3', 'Read', 'f', 'How to Use This Skill to Make a Presentation'), call('4', 'Write', 'f', 'DESIGN_W=880')] }], conversation: [{ reply: 'x', reply_type: 'answer' }], patterns }))
  const reconciliation = await lib('reconciliation')
  const exchange = { step: 'define.specs', step_id: 'specs', attempt: 1, turn: 1, session_id: 's' }
  const records = [{ type: 'request_written', identity: { step_key: 'define.specs', attempt: 1, turn: 1 }, request: exchange }, { type: 'reply_acted', identity: { step_key: 'define.specs', attempt: 1, turn: 1 }, reply: { text: 'hello' } }]
  const reconcile = mutate => { try { return reconciliation.reconcileConversation({ conversation: mutate.conversation, exchanges: records, transcripts: [], manifest: { invocations: [] }, audit: '' }) } catch (error) { return { error: error.message } } }
  out.reconcile = sha([reconcile({ conversation: [{ ...exchange, text: 'hello', reply: 'hello' }] }), reconcile({ conversation: [{ ...exchange, text: 'other', reply: 'other' }] }), reconcile({ conversation: [] })])
  const metrics = await lib('runner-metrics')
  const text = await readFile(new URL('../run-metrics-two-invocations.json', import.meta.url), 'utf8')
  const runId = JSON.parse(text).run_id
  out.metrics_ingest = sha(metrics.ingestRunnerMetrics({ text, runId, workflow: 'change' })); out.metrics_define = sha(metrics.ingestDefineMetrics({ text, runId })); out.metrics_invocations = sha(metrics.effectiveDefineInvocations(JSON.parse(text)))
  const report = await lib('report'); const comparison = await lib('comparison')
  const results = []
  for (const id of (await readdir(join(define, 'results'))).sort().slice(0, 4)) {
    const result = JSON.parse(await readFile(join(define, 'results', id, 'result.json'), 'utf8')); results.push(result)
    out[`report_${id}`] = sha(report.renderReport(result))
  }
  out.comparison = sha(comparison.compareResults(results))
  const jobs = await lib('judge-jobs')
  const all = jobs.makeJobs({ inventory: subset, rubric, artifacts: { 'proposal.md': 'A single scene.\n' }, conversation: [{ ...exchange, agent_message: 'q?', reply: 'a', text: 'a', reply_type: 'answer' }], gates: [] })
  out.jobs = sha(all.map(job => ({ name: job.name, kind: job.kind, criteria: job.criteria, prompt: jobs.jobPrompt(job) })))
  const starting = await lib('starting-repo'); out.starting_tree = await starting.verifySnapshot({ suiteRoot: define })
  const inventoryLib = await lib('inventory'); out.inventory_check = sha(await inventoryLib.checkInventory({ suiteRoot: define }))
  const canary = await lib('canary'); out.canary_compile = sha(canary.compilePatterns(patterns).map(p => [p.id, p.matches('Codagent-AI/and-scene'), p.matches('hidden/inventory.json')]))
  const versions = await lib('versions'); out.versions = sha(await versions.checkVersions({ suiteRoot: define }))
  const files = await lib('files'); out.suite_root_ends_with_define = files.SUITE_ROOT.endsWith('evals/agent-runner/and-scene-define')
  const transcripts = await lib('transcripts')
  out.transcript = sha(transcripts.parseTranscript(transcripts.jsonl('{"type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}\n{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}\n{"type":"response_item","payload":{"type":"function_call","call_id":"c","name":"shell","arguments":"ls"}}\n{"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"ok"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n'), { cli: 'codex', session: 's' }))
  const publication = await lib('publication'); out.publication = sha([publication.publicationEligibility({ mode: 'candidate', evaluation_status: 'complete', total: 80 }), publication.publicationEligibility({ mode: 'candidate', evaluation_status: 'complete' }), publication.RESULTS_RELATIVE_DIR])
  const outcomes = await lib('outcomes'); out.outcomes = sha([outcomes.failureOutcome({ phase: 'p', reason: 'r', workflow: true, step: 's', timeLimitMs: 5 }), outcomes.EVALUATION_STATUSES])
  const mount = await lib('mount-plan'); out.mount = sha(mount.shellWords("docker run -v '/a b':/x:ro --mount type=bind\\,source=/s\\,target=/t img"))
  return out
}
if (process.argv[2]) console.log(JSON.stringify(await compute(fileURLToPath(new URL(process.argv[2], `file://${process.cwd()}/`))), null, 2))
