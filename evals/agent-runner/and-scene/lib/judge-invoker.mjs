// Production Codex adapter for all evaluation-owned model jobs.
//
// The caller supplies a schema and an explicit web-search policy for each job.
// Codex receives the candidate checkout read-only, writes only its final answer
// and schema under the run's excluded `.runtime` directory, and runs without
// project instructions or user configuration influencing the evaluator.
import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const JUDGE_ENV_ALLOWLIST = [
  'HOME',
  'CODEX_HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
]

function judgeEnvironment(source) {
  return Object.fromEntries(JUDGE_ENV_ALLOWLIST.flatMap((name) => (
    typeof source?.[name] === 'string' ? [[name, source[name]]] : []
  )))
}

function safeJobName(value) {
  return String(value ?? 'judge').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'judge'
}

function detail(result) {
  return (result.stderr || result.stdout || result.error?.message || 'no diagnostic output').trim()
}

function extractCodexUsage(stdout, { request, invocationId }) {
  let usage = null
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
        usage = event.usage
      }
    } catch {
      // Non-JSON diagnostics are not usage evidence.
    }
  }

  const categoryMap = {
    input_tokens: 'input',
    cached_input_tokens: 'cached_input',
    cache_write_input_tokens: 'cache_write',
    output_tokens: 'output',
    reasoning_output_tokens: 'reasoning',
  }
  const tokens = usage
    ? Object.fromEntries(Object.entries(categoryMap).flatMap(([source, target]) => (
        Number.isFinite(usage[source]) ? [[target, usage[source]]] : []
      )))
    : null
  const input = usage?.input_tokens
  const output = usage?.output_tokens
  const tokenTotals = Number.isFinite(input) && Number.isFinite(output)
    ? { input, output, total: input + output }
    : null

  return {
    invocation_id: invocationId,
    phase: request.job ?? null,
    provider: 'openai',
    model: request.authority?.model ?? null,
    usage: usage
      ? { state: 'available', reason: null, source: 'codex:turn.completed' }
      : { state: 'unavailable', reason: 'Codex emitted no turn.completed usage', source: 'codex:turn.completed' },
    tokens,
    token_totals: tokenTotals,
  }
}

export function createCodexJudgeInvoker({
  runDir,
  candidateWorktree,
  defaultCwd = candidateWorktree,
  allowedRoots = null,
  // The sandbox installs `codex` as a yolo wrapper for implementation agents.
  // Judges must bypass that wrapper and invoke the real, sandboxed CLI.
  command = '/usr/bin/codex',
  spawnImpl = spawnSync,
  env = process.env,
} = {}) {
  const runtimeDir = join(resolve(runDir), '.runtime', 'judge')
  const usagePath = join(resolve(runDir), 'phases', 'eval-owned-usage.jsonl')
  const fallbackCwd = resolve(defaultCwd)
  const approvedRoots = (allowedRoots ?? [fallbackCwd]).map((root) => resolve(root))
  let sequence = 0

  const inMemoryUsage = []

  const invoke = async function invoke(request) {
    const cwd = resolve(request.cwd ?? fallbackCwd)
    const approved = approvedRoots.some((root) => {
      const offset = relative(root, cwd)
      return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
    })
    if (!approved) {
      throw new Error(`Codex judge ${request.job ?? 'job'} cwd is not an approved read-only root: ${cwd}`)
    }
    await mkdir(cwd, { recursive: true })
    sequence += 1
    const stem = `${String(sequence).padStart(2, '0')}-${safeJobName(request.job)}`
    const schemaPath = join(runtimeDir, `${stem}.schema.json`)
    const outputPath = join(runtimeDir, `${stem}.output.json`)
    await mkdir(runtimeDir, { recursive: true })
    await rm(outputPath, { force: true })
    await writeFile(schemaPath, `${JSON.stringify(request.schema, null, 2)}\n`)

    const args = [
      'exec',
      '--json',
      '--cd', cwd,
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      // Codex itself receives the isolated home so it can authenticate, but
      // model-generated shell commands inherit none of the parent environment.
      // Candidate prompt injection therefore cannot print evaluator or harness
      // credentials with `env`.
      '--config', 'shell_environment_policy.inherit="none"',
      '--config', `web_search="${request.web_search === true || request.web_search === 'authorized' ? 'live' : 'disabled'}"`,
      '--output-schema', schemaPath,
      '--output-last-message', outputPath,
      '--color', 'never',
    ]
    const model = request.authority?.model
    if (model && model !== 'codex-default') args.push('--model', model)
    args.push('-')

    const result = spawnImpl(command, args, {
      cwd,
      env: judgeEnvironment(env),
      encoding: 'utf8',
      input: request.prompt,
      maxBuffer: 16 * 1024 * 1024,
    })
    const usageEntry = extractCodexUsage(result.stdout, {
      request,
      invocationId: `${stem}-${Date.now()}`,
    })
    inMemoryUsage.push(usageEntry)
    try {
      await mkdir(dirname(usagePath), { recursive: true })
      await appendFile(usagePath, `${JSON.stringify(usageEntry)}\n`)
    } catch {
      // Usage diagnostics must not replace an otherwise valid judge result.
    }
    if (result.error || result.status !== 0) {
      throw new Error(
        `Codex judge ${request.job ?? 'job'} exited ${result.status ?? -1}: ${detail(result)}`,
      )
    }
    try {
      return await readFile(outputPath, 'utf8')
    } catch (error) {
      throw new Error(`Codex judge ${request.job ?? 'job'} produced no final response: ${error.message}`)
    }
  }

  invoke.readUsageEntries = async () => {
    let text
    try {
      text = await readFile(usagePath, 'utf8')
    } catch {
      return [...inMemoryUsage]
    }
    return text.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line)]
      } catch {
        return [{
          phase: 'usage-ledger', provider: null, model: null, tokens: null,
          usage: { state: 'unavailable', reason: 'eval-owned usage ledger contains malformed JSON' },
        }]
      }
    })
  }

  return invoke
}
