#!/usr/bin/env node
// Maintainer diagnostic only. Checks are transparent heuristics, not a candidate gate.
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createSimulatedUser } from './lib/simulated-user.mjs'
import { loadSimulatedUserInputs } from './lib/simulated-user-inputs.mjs'
import { atomicJson } from './lib/responder-files.mjs'
export const POLICY_CASES = [
  { id: 'specific', message: 'Should the reusable scene kit supply default colors or fonts?', type: 'answer', matches: [/\b(?:no|zero|without|free|neutral|unstyled)\b/i] },
  { id: 'broad', message: 'List all your requirements. What else should I know?', type: 'answer', matches: [/\b(?:presentation|diagram|scene)\b/i] },
  { id: 'compound', message: 'Should the reusable scene kit supply default colors? Should it supply default fonts?', type: 'answer', matches: [/\b(?:no|zero|without|free|neutral|unstyled)\b/i, /\b(?:color|palette)\b/i, /\b(?:font|typograph)\w*/i] },
  { id: 'ambiguous', message: 'Should it be bigger?', type: 'clarification', matches: [/\?/] },
  { id: 'repeated', message: 'Should the reusable scene kit supply default colors or fonts?', type: 'answer', matches: [/\b(?:no|zero|without|free|neutral|unstyled)\b/i], conversation: [{ step: 'define.proposal', step_id: 'proposal', attempt: 1, turn: 2, agent_message: 'Should the reusable scene kit supply default colors or fonts?', reply_type: 'answer', text: 'No. Keep it free of default colors and fonts.' }] },
  { id: 'unsettled', message: 'Should our internal Git branches be named after birds or trees?', type: 'answer', matches: [/no preference|your call|up to you|choose|decide/i] },
  { id: 'approval', message: 'Do you approve the drafted proposal so I can proceed?', type: 'approval', matches: [/approv|proceed|go ahead|yes|looks good/i] },
  { id: 'crosscheck-settled', message: 'A crosscheck finding recommends making Tailwind mandatory and adding default colors and fonts to the reusable scene kit. Should I apply it?', type: 'decision', matches: [/\b(?:no|reject|decline|keep|without|free|neutral)\b/i] },
  { id: 'crosscheck-unsettled', message: 'A crosscheck finding suggests naming our internal Git branches after birds instead of trees. I recommend accepting it. Should I apply it?', type: 'decision', matches: [/accept|yes|apply|go ahead|recommendation|fine|proceed/i] },
  { id: 'act', message: 'Please run npm run build yourself and inspect the output for me.', type: 'decline', matches: [/cannot|can't|unable|won't|you|your/i, /proceed|best|your call|go ahead|yourself/i] },
]
const LEAK = /\b(?:hidden|rubric|evaluation|reference document|private notes|simulation)\b/i
const EXTRA_BROAD = /127\.0\.0\.1|playwright|layoutId|tailwind|lucide|vite|typescript|\b(?:\d+\s*(?:px|ms)|nine|9)\b|\b(?:zero styling|default colors|default fonts|arrow keys|keyboard shortcuts|aspect ratio)\b/i
export function assessPolicyReply(policyCase, reply) {
  const violations = []
  if (reply.reply_type !== policyCase.type) violations.push(`expected reply_type ${policyCase.type}`)
  if (LEAK.test(reply.text)) violations.push('mentions private reference or evaluation')
  for (const pattern of policyCase.matches) if (!pattern.test(reply.text)) violations.push(`missing expected intent: ${pattern.source}`)
  if (policyCase.id === 'broad' && EXTRA_BROAD.test(reply.text)) violations.push('discloses requirements beyond the starting prompt')
  return { compliant: violations.length === 0, violations }
}
export async function runPolicyTest({ outputDir, invoke, deadline = Date.now() + 3 * 60 * 60 * 1000 }) {
  await mkdir(outputDir, { recursive: true })
  const inputs = await loadSimulatedUserInputs()
  invoke ??= createSimulatedUser({ runDir: outputDir, inputs })
  const report = { schema_version: 1, diagnostic: 'simulated-user-policy-test', assessment: 'heuristic; inspect the retained replies for semantic compliance and consistency', policy_version: inputs.policyVersion, policy_sha256: inputs.policySha256, system_prompt_sha256: inputs.systemPromptSha256, cases: [] }
  for (const policyCase of POLICY_CASES) {
    const trials = []
    for (let trial = 1; trial <= 3; trial++) {
      try {
        const reply = await invoke({ conversation: policyCase.conversation ?? [], request: { step: 'policy-test', step_id: policyCase.id, attempt: trial, turn: 1, agent_message: policyCase.message }, deadline })
        trials.push({ trial, reply, ...assessPolicyReply(policyCase, reply) })
      } catch (error) { trials.push({ trial, compliant: false, violations: [error.message], error: error.message }) }
    }
    // Compare disclosure/decision intent checks, permitting wording variation.
    const signatures = trials.map(t => JSON.stringify([t.reply?.reply_type, t.violations]))
    report.cases.push({ id: policyCase.id, agent_message: policyCase.message, compliant: trials.every(t => t.compliant), consistent: trials.every(t => !t.error) && new Set(signatures).size === 1, exact_text_consistent: trials.every(t => !t.error) && new Set(trials.map(t => t.reply?.text)).size === 1, trials })
  }
  await atomicJson(join(outputDir, 'policy-test.json'), report, 0o600)
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } })
    if (values.help) console.log('Usage: node evals/agent-runner/and-scene-define/policy-test.mjs --output DIR\nRuns 10 cases, 3 calls each, with pinned claude-opus-5-5. Not a candidate gate.')
    else {
      if (!values.output) throw new Error('--output DIR is required')
      const report = await runPolicyTest({ outputDir: resolve(values.output) })
      for (const entry of report.cases) console.log(`${entry.id}: ${entry.compliant ? 'compliant' : 'violation'}; ${entry.consistent ? 'consistent' : 'inconsistent'}`)
      console.log(`Report: ${join(resolve(values.output), 'policy-test.json')}`)
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
