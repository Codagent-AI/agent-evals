// Production Codex adapter for all evaluation-owned model jobs.
//
// The caller supplies a schema and an explicit web-search policy for each job.
// Codex receives the candidate checkout read-only, writes only its final answer
// and schema under the run's excluded `.runtime` directory, and runs without
// project instructions or user configuration influencing the evaluator.
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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

export function createCodexJudgeInvoker({
  runDir,
  candidateWorktree,
  // The sandbox installs `codex` as a yolo wrapper for implementation agents.
  // Judges must bypass that wrapper and invoke the real, sandboxed CLI.
  command = '/usr/bin/codex',
  spawnImpl = spawnSync,
  env = process.env,
} = {}) {
  const runtimeDir = join(resolve(runDir), '.runtime', 'judge')
  const cwd = resolve(candidateWorktree)
  let sequence = 0

  return async function invoke(request) {
    sequence += 1
    const stem = `${String(sequence).padStart(2, '0')}-${safeJobName(request.job)}`
    const schemaPath = join(runtimeDir, `${stem}.schema.json`)
    const outputPath = join(runtimeDir, `${stem}.output.json`)
    await mkdir(runtimeDir, { recursive: true })
    await rm(outputPath, { force: true })
    await writeFile(schemaPath, `${JSON.stringify(request.schema, null, 2)}\n`)

    const args = [
      'exec',
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
}
