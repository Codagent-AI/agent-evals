import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCodexJudgeInvoker } from '../../../lib/panel-judging/codex-invoker.mjs'
import { createClaudeJudgeInvoker } from '../../../lib/panel-judging/claude-invoker.mjs'
import { PRODUCT_JUDGE_PROFILE } from '../../and-scene/lib/judge-profile.mjs'
export { PRODUCT_JUDGE_PROFILE }
// Host judges over the neutral inputs: read-only tools confined to the approved roots.
export function createProductJudges({ runDir, allowedRoots, env = process.env, codexCommand = 'codex', claudeCommand = 'claude' }) {
  const runtimeDir = join(runDir, '.runtime/product-job-inputs')
  const claude = createClaudeJudgeInvoker({ runDir, mode: 'in-sandbox', allowedRoots, command: claudeCommand, env })
  const codex = createCodexJudgeInvoker({ runDir, defaultCwd: runtimeDir, allowedRoots: [runtimeDir, ...allowedRoots], privateCodexHome: true, command: codexCommand, env })
  const invoke = async request => {
    if (request.authority?.cli === 'claude') return claude(request)
    await mkdir(runtimeDir, { recursive: true })
    if (request.cwd) return codex(request)
    const scratch = await mkdtemp(join(runtimeDir, 'job-'))
    try { await writeFile(join(scratch, 'inputs.json'), JSON.stringify({ prompt: request.prompt, schema: request.schema }), { mode: 0o600 }); return await codex({ ...request, cwd: scratch }) } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  const seat = profile => ({ ...profile, invoke })
  return { panel: PRODUCT_JUDGE_PROFILE.panel.map(seat), decider: seat(PRODUCT_JUDGE_PROFILE.decider), invoke, profile: PRODUCT_JUDGE_PROFILE }
}
