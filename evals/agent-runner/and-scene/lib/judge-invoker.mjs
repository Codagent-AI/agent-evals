export * from '../../../lib/panel-judging/codex-invoker.mjs'
export * from '../../../lib/panel-judging/claude-invoker.mjs'
import { createCodexJudgeInvoker } from '../../../lib/panel-judging/codex-invoker.mjs'
import { createClaudeJudgeInvoker } from '../../../lib/panel-judging/claude-invoker.mjs'
import { detectClaudeQuotaReset, waitForClaudeQuotaReset } from './claude-quota.mjs'

// Scored requests select their pinned family; single-purpose jobs retain Codex.
export function createSuiteJudgeInvoker(options) {
  const codex = createCodexJudgeInvoker(options)
  const claude = createClaudeJudgeInvoker({ ...options, mode: 'in-sandbox',
    command: process.env.AND_SCENE_CLAUDE_COMMAND ?? 'claude',
    detectQuotaReset: detectClaudeQuotaReset, waitForQuotaReset: waitForClaudeQuotaReset })
  const invoke = request => (request.authority?.cli === 'claude' ? claude : codex)(request)
  // Both invokers write the same durable ledger. Read it once.
  invoke.readUsageEntries = codex.readUsageEntries
  return invoke
}
