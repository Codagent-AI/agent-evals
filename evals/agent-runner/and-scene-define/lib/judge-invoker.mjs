import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCodexJudgeInvoker } from '../../../lib/panel-judging/codex-invoker.mjs'
import { createClaudeJudgeInvoker } from '../../../lib/panel-judging/claude-invoker.mjs'
import { JUDGE_PROFILE } from './profiles.mjs'
export function createDefinitionJudges({ runDir, env = process.env, codexCommand = 'codex', claudeCommand = 'claude' }) {
  const runtimeDir = join(runDir, '.runtime/definition-job-inputs')
  const claude = createClaudeJudgeInvoker({ runDir, mode: 'host', command: claudeCommand, env })
  const codex = createCodexJudgeInvoker({ runDir, defaultCwd: runtimeDir, allowedRoots: [runtimeDir], privateCodexHome: true, command: codexCommand, env })
  const invokeCodex = async request => {
    await mkdir(runtimeDir, { recursive: true })
    const scratch = await mkdtemp(join(runtimeDir, 'job-'))
    try {
      // Only this job's already-inlined packet is exposed in the working tree.
      await writeFile(join(scratch, 'inputs.json'), JSON.stringify({ prompt: request.prompt, schema: request.schema }), { mode: 0o600 })
      return await codex({ ...request, cwd: scratch })
    } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  return { panel: JUDGE_PROFILE.panel.map(profile => ({ ...profile, family: profile.cli, invoke: profile.cli === 'claude' ? claude : invokeCodex })), decider: { ...JUDGE_PROFILE.decider, family: 'claude', invoke: claude } }
}
