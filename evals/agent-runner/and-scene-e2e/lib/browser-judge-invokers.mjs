// Judge CLIs that operate the served product through chrome-devtools-axi. The shared source judges are
// deliberately tool-less; these seats are allowed one tool, the AXI command line, on the evaluator's browser.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CHROME_DEVTOOLS_AXI_BROWSER_URL', 'CHROME_DEVTOOLS_AXI_SESSION', 'CHROME_DEVTOOLS_AXI_PORT']
const allowedEnvironment = (env, extra = {}) => ({ ...Object.fromEntries(ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]])), ...extra })
function run(command, args, { input, env, cwd, timeoutMs, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { retryable: true })) }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(input ?? '')
  })
}
// Usage and cost from the final result record of Claude's stream, when it reported them.
export function claudeUsage(stdout) {
  let final = null
  for (const line of stdout.split('\n')) { try { const event = JSON.parse(line); if (event.type === 'result') final = event } catch { /* not a record */ } }
  return final ? { ...(final.usage ? { tokens: final.usage } : {}), ...(final.total_cost_usd !== undefined ? { cost_usd: final.total_cost_usd } : {}) } : null
}
export function structuredOutput(stdout) {
  let final = null
  for (const line of stdout.split('\n')) { try { const event = JSON.parse(line); if (event.type === 'result') final = event } catch { /* not a record */ } }
  const output = final?.structured_output
  if (output === undefined || output === null) throw Object.assign(new Error('the browser judge returned no structured output'), { retryable: true })
  return JSON.stringify(output)
}
export function createBrowserJudgeInvoker({ runDir, env = process.env, claudeCommand = 'claude', codexCommand = 'codex', timeoutMs = 20 * 60 * 1000, spawnImpl = spawn }) {
  const ledger = join(runDir, 'phases/eval-owned-usage.jsonl')
  return async request => {
    const started = Date.now()
    const { cli, model, effort } = request.authority
    // A failed call still spent quota, so it is recorded like a successful one.
    let usage = null
    const record = async (ok, error = null) => {
      await mkdir(join(runDir, 'phases'), { recursive: true })
      await appendFile(ledger, `${JSON.stringify({ kind: 'browser-judge', job: request.job, cli, model, effort, ok, duration_ms: Date.now() - started, usage, ...(error ? { error: String(error.message).slice(0, 300) } : {}) })}\n`)
    }
    const scratch = await mkdtemp(join(tmpdir(), 'e2e-browser-judge-'))
    try {
      const environment = allowedEnvironment(env, { CHROME_DEVTOOLS_AXI_SESSION: request.browser_session ?? env.CHROME_DEVTOOLS_AXI_SESSION })
      let text
      if (cli === 'claude') {
        const args = ['-p', '--model', model, '--effort', effort, '--tools', 'Bash', '--allowedTools', 'Bash(chrome-devtools-axi:*)', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--json-schema', JSON.stringify(request.schema), '--output-format', 'stream-json', '--verbose']
        const result = await run(claudeCommand, args, { input: request.prompt, env: environment, cwd: scratch, timeoutMs, spawnImpl })
        usage = claudeUsage(result.stdout)
        if (result.code !== 0) throw Object.assign(new Error(`claude exited ${result.code}: ${result.stderr.slice(-300)}`), { retryable: true })
        text = structuredOutput(result.stdout)
      } else {
        const schemaPath = join(scratch, 'schema.json'); const outPath = join(scratch, 'last-message.json')
        await writeFile(schemaPath, JSON.stringify(request.schema))
        const args = ['exec', '--model', model, '-c', `model_reasoning_effort="${effort}"`, '--sandbox', 'workspace-write', '--skip-git-repo-check', '--output-schema', schemaPath, '--output-last-message', outPath, '-']
        const result = await run(codexCommand, args, { input: request.prompt, env: allowedEnvironment(env, { ...environment, CODEX_HOME: env.CODEX_HOME ?? join(env.HOME ?? '', '.codex') }), cwd: scratch, timeoutMs, spawnImpl })
        if (result.code !== 0) throw Object.assign(new Error(`codex exited ${result.code}: ${result.stderr.slice(-300)}`), { retryable: true })
        text = await readFile(outPath, 'utf8')
      }
      await record(true)
      return text
    } catch (error) { await record(false, error); throw error } finally { await rm(scratch, { recursive: true, force: true }) }
  }
}
