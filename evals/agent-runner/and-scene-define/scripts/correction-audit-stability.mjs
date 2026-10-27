#!/usr/bin/env node
// Private maintainer diagnostic. No candidate lifecycle, checkpoints or publication.
import { chmod, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { POLICY_CASES, assessPolicyReply } from '../policy-test.mjs'
import { filesUnder, SUITE_ROOT } from '../../../lib/define-run/files.mjs'
import { makeJobs, runDefinitionPanel, JUDGE_PROFILE, PANEL_PROTOCOL } from '../../../lib/define-run/judge-jobs.mjs'
import { createDefinitionJudges } from '../../../lib/define-run/judge-invoker.mjs'
import { disclosureReport } from '../../../lib/define-run/judging.mjs'
import { scoreDefinition } from '../../../lib/define-run/scoring.mjs'
import { verifyJudgingInputs } from '../../../lib/define-run/rubric.mjs'
import { checkVersions } from '../../../lib/define-run/versions.mjs'
import { atomicJson } from '../../../lib/define-run/responder-files.mjs'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
// Resolve existing ancestors too, so a symlink cannot redirect private output into the repo.
async function canonical(path) {
  try { return await realpath(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(await canonical(dirname(path)), relative(dirname(path), path))
  }
}
export async function validateOutput(output) {
  const path = await canonical(resolve(output)); const repo = await realpath(REPO_ROOT)
  const inside = relative(repo, path)
  if (!inside || (inside !== '..' && !inside.startsWith('..' + sep) && !inside.startsWith(sep))) throw new Error('--output must be outside the repository')
  // A diagnostic must not be placed in an existing candidate run or results tree.
  for (let parent = path;; parent = dirname(parent)) {
    if (parent.split(sep).includes('results')) throw new Error('--output must not be a results directory')
    if (await stat(join(parent, 'run-state.json')).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; return null })) throw new Error('--output must not be in a run directory')
    if (parent === dirname(parent)) break
  }
  return path
}
export function assembleSyntheticConversation(report) {
  if (!Array.isArray(report.cases)) throw new Error('policy-test input lacks cases')
  const selected = []
  const take = (id, shape, predicate = () => true) => {
    const entry = report.cases.find(x => x.id === id)
    const trial = entry?.trials?.find(t => t.reply?.text?.trim() && predicate(t.reply))
    if (!entry?.agent_message || (id === 'ambiguous' && !/styl|theme|look/i.test(entry.agent_message)) || !trial) throw new Error(`policy-test input lacks required shape: ${shape}`)
    selected.push({ synthetic: true, shape, source: { case: id, trial: trial.trial }, step: 'synthetic', step_id: shape, attempt: 1, turn: selected.length + 1, agent_message: entry.agent_message, reply_type: trial.reply.reply_type, text: trial.reply.text })
  }
  const compliant = id => reply => assessPolicyReply(POLICY_CASES.find(x => x.id === id), reply).compliant
  take('ambiguous', 'unanswered-question', reply => reply.reply_type === 'clarification' && /\?/.test(reply.text))
  take('exclusion', 'corrected-after-clarification', compliant('exclusion'))
  selected.at(-1).shapes = ['corrected-exclusion', 'corrected-after-clarification']
  take('exclusion', 'previously-established-correction', compliant('exclusion'))
  take('different-canvas', 'over-correction', reply => /canvas|size|dimension|1280|720|880|380/i.test(reply.text) && POLICY_CASES.find(x => x.id === 'different-canvas').forbidden.test(reply.text))
  take('offered-canvas', 'rejected-offered-default', compliant('offered-canvas'))
  take('exclusion-bait', 'mixed-correction-and-answer', compliant('exclusion-bait'))
  return { synthetic: true, conversation: selected }
}
export function summarizeSettlements(records) {
  const ids = records[0].results.map(x => x.id).filter(id => /^(corrected|leak|over-correction):/.test(id))
  return ids.map(id => {
    const vector = records.map(record => record.results.find(x => x.id === id)?.verdict === 'met')
    // Count repetitions departing from the first settlement; also retain transitions.
    return { id, vector, flip_count: vector.filter(value => value !== vector[0]).length, transitions: vector.slice(1).filter((value, n) => value !== vector[n]).length }
  })
}
export async function runCorrectionAuditStability({ policyTest, output, repetitions = 3 }, dependencies = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('--repetitions must be a positive integer')
  const outputDir = await validateOutput(output)
  const retained = await json(resolve(policyTest))
  const synthetic = assembleSyntheticConversation(retained) // Refuse missing shapes before calls or writes.
  const inventory = await json(join(SUITE_ROOT, 'hidden/inventory.json'))
  const rubric = await json(join(SUITE_ROOT, 'rubric.json'))
  const versions = await json(join(SUITE_ROOT, 'versions.json'))
  const versionErrors = await checkVersions()
  if (versionErrors.length) throw new Error(`unpinned diagnostic inputs: ${versionErrors.join('; ')}`)
  verifyJudgingInputs({ inventory, rubric })
  const reference = []
  for (const path of await filesUnder(join(SUITE_ROOT, 'hidden/reference'))) reference.push({ path: relative(join(SUITE_ROOT, 'hidden/reference'), path), text: await readFile(path, 'utf8') })
  const policy = await readFile(join(SUITE_ROOT, 'hidden/simulated-user-policy.md'), 'utf8')
  const job = makeJobs({ inventory, rubric, artifacts: {}, gates: [], conversation: synthetic.conversation, reference, policy }).find(x => x.kind === 'disclosure')
  const coverage = rubric.coverage.map(x => ({ id: x.id, verdict: 'met' }))
  const quality = rubric.quality.map(x => ({ id: x.id, verdict: 'met' }))
  const records = []; const scores = []
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  await chmod(outputDir, 0o700)
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const judges = dependencies.judgesForRepetition?.(repetition) ?? createDefinitionJudges({ runDir: outputDir })
    const outcome = await runDefinitionPanel({ job, ...judges })
    if (!outcome.ok) throw new Error(outcome.failure?.message ?? 'disclosure panel failed')
    records.push(outcome.record)
    const audit = disclosureReport(outcome.record)
    const scored = scoreDefinition({ rubric, coverage, quality, fidelity: [], leaked: audit.leaked_items, corrected: audit.corrections, gates: [] })
    scores.push({ repetition, coverage_score: scored.components.coverage.score, corrected_items: scored.corrected_items, leaked_items: scored.leaked_items })
  }
  const values = scores.map(x => x.coverage_score).filter(Number.isFinite)
  const min = values.length ? Math.min(...values) : null; const max = values.length ? Math.max(...values) : null
  const result = { schema_version: 1, diagnostic: 'correction-audit-stability', ...synthetic, repetitions, settlements: summarizeSettlements(records), scores,
    coverage_scores: { min, max, spread: min === null ? null : max - min },
    versions: { policy: versions.inputs['simulated-user-policy'], retained_policy: { version: retained.policy_version, sha256: retained.policy_sha256 }, rubric: versions.inputs.rubric, judge_profile: JUDGE_PROFILE, panel_protocol: PANEL_PROTOCOL }, records }
  await atomicJson(join(outputDir, 'stability.json'), result, 0o600)
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'policy-test': { type: 'string' }, output: { type: 'string' }, repetitions: { type: 'string', default: '3' }, help: { type: 'boolean' } } })
    if (values.help) console.log('Usage: node evals/agent-runner/and-scene-define/scripts/correction-audit-stability.mjs --policy-test FILE --output DIR [--repetitions 3]\nPaid private diagnostic, outside the repo only. Never publishes or starts a candidate run.')
    else {
      if (!values['policy-test'] || !values.output) throw new Error('--policy-test and --output are required')
      await runCorrectionAuditStability({ policyTest: values['policy-test'], output: values.output, repetitions: Number(values.repetitions) })
      console.log(`Report: ${join(resolve(values.output), 'stability.json')}`)
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
