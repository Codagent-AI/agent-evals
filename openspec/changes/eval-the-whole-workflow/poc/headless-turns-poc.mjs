#!/usr/bin/env node
// Proof of concept: drive an interactive Agent Runner define step without a TTY.
//
// The lead agent runs the define workflow's `proposal` step as a loop of
// headless turns. Whenever the lead ends a turn without signalling completion,
// its last message goes to a "simulated user" (a tool-less Claude call that
// role-plays the user from a hidden reference) and the reply is sent back as
// the next user turn on the SAME lead session via headless resume:
//
//   claude -p --resume <session-id> "<reply>"
//   codex exec resume <thread-id> "<reply>"
//
// The loop stops when the lead creates the step-complete marker file, after
// the lead-turn cap, or when a lead turn times out or fails.
//
// See README.md next to this file for the flags, findings, and the gaps versus
// a real Agent Runner integration.
//
// Node 22 ESM, no third-party dependencies.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const POC_DIR = dirname(fileURLToPath(import.meta.url))
const CHANGE_DIR = resolve(POC_DIR, '..')
const WORKTREE_ROOT = resolve(POC_DIR, '../../../..')
const DEFAULT_SCRATCH = '/private/tmp/claude-501/-Users-paul-codagent-agent-evals-eval-the-whole-workflow/'
  + '4e09bf5b-5dc6-4bfb-9ba0-9667049154cc/scratchpad'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const { values: opts } = parseArgs({
  options: {
    cli: { type: 'string' },
    'max-turns': { type: 'string', default: '30' },
    'turn-timeout-minutes': { type: 'string', default: '15' },
    'simuser-timeout-minutes': { type: 'string', default: '5' },
    'claude-model': { type: 'string', default: 'claude-opus-5-5' },
    'codex-model': { type: 'string', default: 'gpt-6.1-sol' },
    'codex-effort': { type: 'string', default: 'high' },
    'simuser-model': { type: 'string', default: 'claude-opus-5-5' },
    'scratch-dir': { type: 'string', default: process.env.POC_SCRATCH_DIR ?? DEFAULT_SCRATCH },
    'reference-dir': { type: 'string' },
    'starting-prompt': { type: 'string', default: join(CHANGE_DIR, 'inventory/starting-prompt.md') },
    'agent-runner-dir': { type: 'string', default: '/Users/paul/codagent/agent-runner' },
    'agent-skills-dir': { type: 'string', default: '/Users/paul/codagent/agent-skills' },
    'claude-lead-setup': { type: 'string', default: 'clean' },
    'responder-input': { type: 'string', default: 'turn' },
    'print-prompt': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (opts.help || !['claude', 'codex'].includes(opts.cli) || !['clean', 'host'].includes(opts['claude-lead-setup'])
  || !['turn', 'last'].includes(opts['responder-input'])) {
  console.log(`Usage: node headless-turns-poc.mjs --cli claude|codex [options]

Options:
  --max-turns N                 lead-turn cap (default 30)
  --turn-timeout-minutes N      per lead turn timeout (default 15)
  --simuser-timeout-minutes N   per simulated-user call timeout (default 5)
  --claude-model M              lead model for --cli claude (default claude-opus-5-5)
  --codex-model M               lead model for --cli codex (default gpt-6.1-sol)
  --codex-effort E              Codex model_reasoning_effort (default high)
  --simuser-model M             simulated-user model (default claude-opus-5-5)
  --scratch-dir DIR             where target repos and private homes are created
  --reference-dir DIR           hidden reference change directory
  --starting-prompt FILE        pinned starting prompt (first simulated-user reply)
  --agent-runner-dir DIR        Agent Runner checkout (step prompt source)
  --agent-skills-dir DIR        Agent Skills checkout (codagent skill source)
  --claude-lead-setup clean|host
                                clean (default): no user settings/plugins/MCP, only the
                                codagent plugin from --agent-skills-dir, and Read denied
                                for the hidden reference and user/agent config dirs.
                                host: the user's own Claude setup (as run 1 used)
  --responder-input turn|last   what the simulated user sees of each lead turn:
                                turn (default): every agent message of the turn;
                                last: only the final message (codex run 1 used this)
  --print-prompt                print the assembled lead step prompt and exit (no model calls)`)
  process.exit(opts.help ? 0 : 2)
}

const CHANGE_NAME = 'add-presentation-skill'
const STEP_ID = 'proposal'
const MARKER_NAME = '.step-complete'
const MAX_TURNS = Number(opts['max-turns'])
const TURN_TIMEOUT_MS = Number(opts['turn-timeout-minutes']) * 60_000
const SIMUSER_TIMEOUT_MS = Number(opts['simuser-timeout-minutes']) * 60_000
const SCRATCH = resolve(opts['scratch-dir'])
const REFERENCE_DIR = resolve(opts['reference-dir']
  ?? join(SCRATCH, 'fixture-scrub/openspec/changes/create-and-scene'))
const DEFINE_WORKFLOW = join(opts['agent-runner-dir'], 'workflows/core/define-change-v1.0.yaml')
const CHANGE_WORKFLOW = join(opts['agent-runner-dir'], 'workflows/openspec/change-v2.0.yaml')

// The lead's tool allowlist for the Claude adapter. acceptEdits covers file
// edits inside the working directory; Bash is limited to what the proposal
// step plausibly needs. Anything else is denied (never prompted) under -p.
const CLAUDE_LEAD_ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill',
  'Bash(openspec:*)', 'Bash(git:*)', 'Bash(touch:*)', 'Bash(ls:*)', 'Bash(cat:*)',
  'Bash(mkdir:*)', 'Bash(find:*)', 'Bash(head:*)', 'Bash(wc:*)', 'Bash(pwd)',
]

// Phrases that suggest the lead decided it is headless / unattended, or chose
// to report an unresolved decision instead of asking. Heuristic only: every
// lead message is also kept verbatim for human reading.
const HEADLESS_SIGNAL_PATTERNS = [
  /\bheadless\b(?!\s+(?:chromium|chrome|browser|playwright|check|render|test))/i, /\bno (?:human|user)\b/i, /unattended/i, /unresolved/i,
  /\bcan(?:'|’|no)?t ask\b/i, /\bcannot ask\b/i, /\bassum(?:e|ed|es|ing|ption|ptions)\b/i,
  /non-?interactive/i, /autonomous(?:ly)?/i, /without (?:user|your|human) (?:input|confirmation)/i,
  /no one to (?:ask|confirm)/i,
]

// Words the simulated user must never say (policy: never mention a reference
// document, a hidden specification, or the evaluation). Heuristic flag only.
const SIMUSER_LEAK_PATTERNS = [
  /\breference\b/i, /\bhidden\b/i, /\bevaluat/i, /\bmy notes\b/i, /\bnotes say\b/i,
  /\bspec(?:ification)? (?:says|document)\b/i, /\brole-?play/i, /\bsimulat/i, /\brubric\b/i,
]

// Children must behave as if launched from a plain shell, not as a nested
// Claude Code session. Drop the parent's CLAUDE_* / CLAUDECODE variables
// (for example CLAUDE_CODE_SESSION_ATTENDED, CLAUDE_EFFORT).
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^CLAUDE/.test(key)),
)

/**
 * Extra Claude lead flags for --claude-lead-setup clean. Run 1 used the host
 * setup and the lead found the user's installed `and-scene` plugin (the hidden
 * reference's own product) and read it as prior art. Clean mode loads no
 * user/project settings, hooks, plugins, or MCP servers, adds only the
 * codagent plugin, and denies Read/Glob/Grep on the hidden reference and on
 * directories that would reveal it.
 */
function claudeCleanLeadFlags() {
  const deny = [
    `Read(/${join(SCRATCH, 'fixture-scrub')}/**)`,
    `Read(/${REFERENCE_DIR}/**)`,
    // The workspace holding the product repos (and-scene, agent-skills, this eval).
    `Read(/${dirname(resolve(opts['agent-runner-dir']))}/**)`,
    'Read(~/.claude/**)', 'Read(~/.agents/**)', 'Read(~/.codex/**)',
  ]
  return [
    '--setting-sources', '',
    '--strict-mcp-config',
    '--plugin-dir', opts['agent-skills-dir'],
    '--settings', JSON.stringify({ permissions: { deny } }),
  ]
}

// ---------------------------------------------------------------------------
// Step prompt: the define workflow's proposal prompt, built like Agent Runner
// ---------------------------------------------------------------------------

/** Extract the literal block scalar `prompt: |` of one step from workflow YAML. */
function extractStepPrompt(yamlText, stepId) {
  const lines = yamlText.split('\n')
  const stepLine = lines.findIndex((line) => line.trim() === `- id: ${stepId}`)
  if (stepLine < 0) throw new Error(`step ${stepId} not found in workflow`)
  let keyLine = -1
  for (let i = stepLine + 1; i < lines.length && !/^\s*- id:/.test(lines[i]); i++) {
    if (/^\s*prompt:\s*\|\s*$/.test(lines[i])) { keyLine = i; break }
  }
  if (keyLine < 0) throw new Error(`step ${stepId} has no literal prompt block`)
  const keyIndent = lines[keyLine].search(/\S/)
  const body = []
  let blockIndent = null
  for (let i = keyLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') { body.push(''); continue }
    const indent = line.search(/\S/)
    if (indent <= keyIndent) break
    blockIndent ??= indent
    body.push(line.slice(blockIndent))
  }
  while (body.at(-1) === '') body.pop()
  return `${body.join('\n')}\n` // YAML "clip" chomping keeps one final newline
}

function interpolate(template, params) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in params)) throw new Error(`unknown template parameter {{${name}}}`)
    return params[name]
  })
}

// Substitution (b): the crosscheck review needs Agent Runner's call_agent MCP
// tool, which this PoC does not provide. Only this paragraph is replaced.
const CROSSCHECK_PARAGRAPH_START = 'Once the proposal draft is complete, use the codagent:call-agent skill'
const CROSSCHECK_SKIPPED_NOTE = 'The crosscheck review is skipped in this run: do not use the codagent:call-agent '
  + 'skill or request an adversarial review. Treat the proposal review as having produced no findings.'

// Substitution (a): replaces Agent Runner's completionInstruction(), which
// tells the agent to run `<agent-runner> step complete`.
function markerCompletionInstruction(markerPath) {
  return '\n\nWhen you or the user determine this step is complete, run '
    + `\`touch ${markerPath}\` with your shell tool as your final action when the step is done. `
    + 'Run that exact command with no extra arguments as the final action before finishing the current '
    + 'response. Do not merely say that the step is complete.'
}

/**
 * Mirror internal/exec/agent.go buildAdapterInput() for a fresh, interactive,
 * non-intake step: step prefix + interpolated step prompt + completion
 * instruction. No engine enrichment applies (change-v2.0 and define-change
 * declare no `engine:`) and the default lead profile has no system prompt.
 */
function buildStepPrompt(markerPath) {
  const changeWorkflow = readFileSync(CHANGE_WORKFLOW, 'utf8')
  const workflowName = changeWorkflow.match(/^name:\s*(\S+)\s*$/m)?.[1]
  const workflowDescription = changeWorkflow.match(/^description:\s*"(.*)"\s*$/m)?.[1]
  if (!workflowName || !workflowDescription) throw new Error('cannot read change workflow name/description')

  // Parameter values exactly as change-v2.0.yaml passes them to define-change.
  const params = {
    change_name: CHANGE_NAME,
    change_dir: `openspec/changes/${CHANGE_NAME}`,
    change_label: 'OpenSpec change',
    artifact_location_instruction: 'Keep every OpenSpec definition and planning artifact under the '
      + `repository-local \`openspec/changes/${CHANGE_NAME}/\` directory.`,
  }

  const verbatim = interpolate(extractStepPrompt(readFileSync(DEFINE_WORKFLOW, 'utf8'), STEP_ID), params)
  const paragraphs = verbatim.split('\n\n')
  const crosscheck = paragraphs.filter((p) => p.startsWith(CROSSCHECK_PARAGRAPH_START))
  if (crosscheck.length !== 1) throw new Error('expected exactly one crosscheck paragraph in the step prompt')
  const stepPrompt = paragraphs.map((p) => (p === crosscheck[0] ? CROSSCHECK_SKIPPED_NOTE : p)).join('\n\n')

  // buildStepPrefix(): ctx.WorkflowName is inherited from the top-level
  // `change` workflow by the define-change sub-workflow context.
  const prefix = `You are running in the "${workflowName}" workflow: ${workflowDescription}\n\n`
    + `The current step is "${STEP_ID}".\n\n`
    + 'Before doing anything else, announce that you are starting this step.\n\n'

  return {
    fullPrompt: prefix + stepPrompt + markerCompletionInstruction(markerPath),
    verbatimStepPrompt: verbatim,
    params,
    substitutions: {
      completion: markerCompletionInstruction(markerPath).trim(),
      crosscheck: { replaced: crosscheck[0], with: CROSSCHECK_SKIPPED_NOTE },
    },
  }
}

// ---------------------------------------------------------------------------
// Process and file helpers
// ---------------------------------------------------------------------------

/** Spawn a process with no stdin, tee stdout/stderr to files, enforce a timeout. */
function runProcess({ command, args, cwd, env, timeoutMs, stdoutPath, stderrPath }) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const stdoutFile = createWriteStream(stdoutPath)
    const stderrFile = createWriteStream(stderrPath)
    const out = []
    const err = []
    let timedOut = false
    let spawnError = null

    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => { out.push(chunk); stdoutFile.write(chunk) })
    child.stderr.on('data', (chunk) => { err.push(chunk); stderrFile.write(chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
    }, timeoutMs)
    child.on('error', (error) => { spawnError = error })
    child.on('close', async (code, signal) => {
      clearTimeout(timer)
      await Promise.all([stdoutFile, stderrFile].map((s) => new Promise((r) => s.end(r))))
      resolvePromise({
        code, signal, timedOut, spawnError: spawnError?.message ?? null,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}

/** Run a short setup command synchronously; throw with its output on failure. */
function mustRun(command, args, { cwd, env = BASE_ENV } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function parseJsonLines(text) {
  return text.split('\n').flatMap((line) => {
    if (!line.trim().startsWith('{')) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
}

function pad(turn) {
  return String(turn).padStart(2, '0')
}

// ---------------------------------------------------------------------------
// Throwaway target repository
// ---------------------------------------------------------------------------

/** Mirror the change workflow up to its define step: feature branch + `openspec new change`. */
function setupTargetRepo(targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const git = (...args) => mustRun('git', ['-c', 'user.name=Headless PoC', '-c', 'user.email=poc@example.invalid',
    ...args], { cwd: targetDir })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(targetDir, 'README.md'), '# Presentation tools\n\nPresentation tools repository.\n')
  // `--tools none` initialises the OpenSpec tree without installing OpenSpec's
  // own agent skills/commands, so only the codagent skills are in play.
  mustRun('openspec', ['init', '--tools', 'none', '.'], { cwd: targetDir })
  git('add', '-A')
  git('commit', '-q', '-m', 'chore: initial commit')
  git('checkout', '-q', '-b', CHANGE_NAME)
  // The workflow's create step (create-change.sh) runs this on the branch and
  // leaves the scaffold uncommitted.
  mustRun('openspec', ['new', 'change', CHANGE_NAME], { cwd: targetDir })
}

// ---------------------------------------------------------------------------
// Lead adapters
// ---------------------------------------------------------------------------

/**
 * Claude lead. The step prompt is the appended system prompt of the first
 * request only; Claude Code records it (system prompt snapshot) and replays it
 * on --resume, so continuation turns send just the reply.
 */
function createClaudeLead({ targetDir, stepPrompt, model, setup }) {
  const sessionId = randomUUID()
  // Every flag except the session selector and the system prompt is
  // per-process, so it is repeated on each resume.
  const common = [
    ...(setup === 'clean' ? claudeCleanLeadFlags() : []),
    '--model', model,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ...CLAUDE_LEAD_ALLOWED_TOOLS,
    '--disallowedTools', 'AskUserQuestion',
    '--output-format', 'stream-json', '--verbose',
  ]
  return {
    cli: 'claude',
    model,
    env: BASE_ENV,
    sessionId: () => sessionId,
    startArgs: (message) => ['-p', '--session-id', sessionId, ...common,
      '--append-system-prompt', stepPrompt, '--', message],
    resumeArgs: (message) => ['-p', '--resume', sessionId, ...common, '--', message],
    command: 'claude',
    cwd: targetDir,
    parse: parseClaudeLeadOutput,
    describeArgs: (args) => args.map((a) => (a === stepPrompt ? '<step prompt>' : a)),
  }
}

function parseClaudeLeadOutput(stdout) {
  const events = parseJsonLines(stdout)
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  const result = events.findLast((e) => e.type === 'result')
  const assistantBlocks = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content ?? [])
  const toolUses = assistantBlocks.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, input: b.input }))
  return {
    sessionId: result?.session_id ?? init?.session_id ?? null,
    finalMessage: result?.result ?? '',
    allMessages: assistantBlocks.filter((b) => b.type === 'text').map((b) => b.text),
    isError: result ? Boolean(result.is_error) : true,
    error: result?.is_error ? (result.result ?? result.subtype) : (result ? null : 'no result event'),
    toolUses: toolUses.map(summarizeToolUse),
    skillsInvoked: toolUses.filter((t) => t.name === 'Skill').map((t) => t.input?.skill),
    permissionDenials: (result?.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: d.tool_input })),
    usage: result ? { costUsd: result.total_cost_usd, numTurns: result.num_turns, durationMs: result.duration_ms } : null,
    init: init ? {
      model: init.model,
      permissionMode: init.permissionMode,
      tools: init.tools,
      codagentSkills: (init.skills ?? []).filter((s) => String(s).startsWith('codagent:')),
      plugins: (init.plugins ?? []).map((p) => p.name),
    } : null,
  }
}

/**
 * Codex lead. Codex has no system-prompt flag, so the step prompt is wrapped
 * in <system>…</system> in the first user message, the way Agent Runner's
 * codex path wraps a system prompt. A private CODEX_HOME + HOME carry the
 * auth copy and the codagent plugin; the user's ~/.codex is never touched.
 */
function createCodexLead({ targetDir, stepPrompt, model, effort, codexHome, home }) {
  let threadId = null
  const modelFlags = ['-m', model, '-c', `model_reasoning_effort="${effort}"`]
  const wrapped = `<system>\n${stepPrompt}\n</system>\n\nLet's start the ${STEP_ID} step`
  return {
    cli: 'codex',
    model,
    env: { ...BASE_ENV, CODEX_HOME: codexHome, HOME: home },
    sessionId: () => threadId,
    // `exec resume` has no -C/--sandbox, so the sandbox goes on the top-level
    // `codex` command (as Agent Runner does) and cwd is the target repo.
    startArgs: () => ['exec', '--json', '--skip-git-repo-check', '-C', targetDir,
      '--sandbox', 'workspace-write', ...modelFlags, wrapped],
    resumeArgs: (message) => ['--sandbox', 'workspace-write', 'exec', 'resume', '--json', '--skip-git-repo-check',
      ...modelFlags, threadId, message],
    command: 'codex',
    cwd: targetDir,
    parse: (stdout) => {
      const parsed = parseCodexLeadOutput(stdout)
      threadId ??= parsed.sessionId
      return parsed
    },
    describeArgs: (args) => args.map((a) => (a === wrapped ? '<system>step prompt</system> + start line' : a)),
  }
}

function parseCodexLeadOutput(stdout) {
  const events = parseJsonLines(stdout)
  const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item ?? {})
  const messages = items.filter((i) => i.type === 'agent_message').map((i) => i.text ?? '')
  const commands = items.filter((i) => i.type === 'command_execution')
  const failure = events.find((e) => e.type === 'turn.failed' || e.type === 'error')
  const completed = events.findLast((e) => e.type === 'turn.completed')
  return {
    sessionId: events.find((e) => e.type === 'thread.started')?.thread_id ?? null,
    finalMessage: messages.at(-1) ?? '',
    allMessages: messages,
    isError: Boolean(failure) || !completed,
    error: failure ? (failure.error?.message ?? failure.message ?? JSON.stringify(failure)) : (completed ? null : 'no turn.completed'),
    toolUses: [
      ...commands.map((c) => ({ name: 'command', input: truncate(c.command, 300), exitCode: c.exit_code })),
      ...items.filter((i) => !['agent_message', 'command_execution', 'reasoning'].includes(i.type))
        .map((i) => ({ name: i.type, input: truncate(JSON.stringify(i), 300) })),
    ],
    // Codex reads skills as files; any SKILL.md it opens is the skill evidence.
    skillsInvoked: [...new Set(commands.flatMap((c) => [...String(c.command).matchAll(/skills\/([\w-]+)\/SKILL\.md/g)]
      .map((m) => m[1])))],
    permissionDenials: commands.filter((c) => c.exit_code !== 0 && /denied|not permitted|sandbox/i
      .test(String(c.aggregated_output ?? ''))).map((c) => ({ tool: 'command', input: truncate(c.command, 200) })),
    usage: completed?.usage ?? null,
    init: null,
  }
}

function summarizeToolUse({ name, input }) {
  if (name === 'Bash') return { name, input: truncate(input?.command, 300) }
  if (['Read', 'Write', 'Edit'].includes(name)) return { name, input: input?.file_path }
  if (name === 'Skill') return { name, input: input?.skill }
  return { name, input: truncate(JSON.stringify(input), 300) }
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Private CODEX_HOME with auth and the codagent plugin from the local Agent Skills checkout. */
function setupCodexHome(runScratch, runDir) {
  const codexHome = join(runScratch, 'codex-home')
  const home = join(runScratch, 'home')
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(home, { recursive: true })
  const authCopy = join(codexHome, 'auth.json')
  copyFileSync(join(process.env.HOME, '.codex/auth.json'), authCopy)
  // Never leave a credential copy behind, however the run ends. The Codex
  // session rollouts stay in the private home for inspection.
  process.on('exit', () => rmSync(authCopy, { force: true }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))
  const env = { ...BASE_ENV, CODEX_HOME: codexHome, HOME: home }
  mustRun('codex', ['plugin', 'marketplace', 'add', opts['agent-skills-dir'], '--json'], { env })
  mustRun('codex', ['plugin', 'add', 'codagent@codagent', '--json'], { env })
  const list = mustRun('codex', ['plugin', 'list'], { env })
  const codagentLine = list.split('\n').find((line) => line.startsWith('codagent@codagent')) ?? ''
  writeFileSync(join(runDir, 'codex-plugin-list.txt'), list)
  if (!/installed, enabled/.test(codagentLine)) throw new Error(`codagent plugin not enabled: ${codagentLine}`)
  return { codexHome, home, codagentPlugin: codagentLine.trim().replace(/\s+/g, ' ') }
}

// ---------------------------------------------------------------------------
// Simulated user
// ---------------------------------------------------------------------------

const SIMUSER_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply_type: { type: 'string', enum: ['answer', 'approval', 'decision', 'decline', 'clarification'] },
    text: { type: 'string' },
  },
  required: ['reply_type', 'text'],
  additionalProperties: false,
}

// Pinned policy text, following specs/simulated-user/spec.md.
// poc-1 (run claude-20261004T022704Z) let option answers carry extra detail
// (commands, paths, gate semantics); poc-2 tightens rule 7 and adds the
// "no unasked specifics" rule.
const SIMUSER_POLICY_VERSION = 'poc-2'
function simulatedUserPolicy(startingPrompt) {
  return `You are role-playing the user of a coding agent. The agent is helping you define a software change in your own repository, and you are the person who asked for it. Each time you are invoked you see the whole conversation so far and write your next chat message to the agent.

## What you know
- Your opening request, which you already sent as your first message:
"""
${startingPrompt}
"""
- Your private requirements notes, below. They are your own thoughts about what you want; they are not a document you can share or refer to.
- The conversation so far.
You know nothing else. You have no tools: you cannot run commands, open files, browse, or look at anything the agent produced.

## Disclosure policy
1. Specific question: answer only that question, narrowly, from your notes. Add no other requirement, detail, or context it did not ask for.
2. Broad question (for example "what else should I know?", "list all your requirements", "tell me everything about what you want", "any other constraints?"): restate the goal only at the level of your opening request. Do not enumerate requirements beyond it.
3. Compound question: answer each part under these rules.
4. Ambiguous question (more than one plausible reading): ask a brief clarifying question instead of choosing a reading.
5. Repeated question: answer consistently with your earlier answer in the conversation.
6. Question your notes do not settle: say you have no preference and leave it to the agent, e.g. "No preference, your call."
7. Offered options: name the option that matches your notes and stop. If the matching option is only partly right, add one short sentence correcting just that point. If none matches, state in a sentence or two what you actually want for that decision.
8. Never add specifics the question did not ask for: no command names, file paths, numbers, tool choices, or pass/fail rules unless the question asked about exactly that.

## Decision policy
- A request to approve a draft or to proceed (for example "shall I write it?", "does this look right?", "OK to go ahead?"): approve.
- A decision about a review finding: decide according to your notes where they apply; otherwise accept the agent's recommendation.
- A request for you to run, test, inspect, open, look at, or otherwise act on something: decline and tell the agent to proceed as it thinks best.
- A message that asks nothing (a status update): tell the agent to continue as it thinks best.

## Never
- Volunteer information that was not asked for.
- Critique, review, or suggest edits to the agent's drafts beyond answering what was asked.
- Mention notes, a reference, a specification you hold, a hidden document, a role-play, a simulation, a test, or an evaluation.
- Write code or artifacts for the agent.

## Style
Write like a busy, cooperative product owner: plain, first person, brief. Usually one to four sentences; answer a multi-part question with one short line per part.

## Output
Return a JSON object with:
- reply_type: "answer" (you answered questions, including "no preference"), "approval" (you approved a draft or told the agent to proceed), "decision" (you decided a review finding), "decline" (you declined a request to act), or "clarification" (you asked a clarifying question). If the message mixes kinds, use the one for its main request.
- text: your message to the agent, exactly as you would type it.`
}

/** Policy + hidden reference (proposal, specs, design, test plan — never tasks), read from the reference dir. */
function buildSimulatedUserSystemPrompt(startingPrompt) {
  const specFiles = listFiles(join(REFERENCE_DIR, 'specs')).filter((f) => f.endsWith('spec.md'))
  const sections = [
    ['Why and scope', 'proposal.md'],
    ...specFiles.map((f) => [`Behaviour: ${dirname(f)}`, join('specs', f)]),
    ['How it should be built', 'design.md'],
    ['How it should be tested', 'test-plan.md'],
  ]
  const notes = sections.map(([title, file]) => `### ${title}\n\n${readFileSync(join(REFERENCE_DIR, file), 'utf8').trim()}`)
  return {
    text: `${simulatedUserPolicy(startingPrompt)}\n\n## Your private requirements notes\n\n${notes.join('\n\n')}\n`,
    referenceFiles: sections.map(([, file]) => file),
  }
}

function formatConversationForSimulatedUser(exchanges, latestAgentMessage) {
  const lines = [`The conversation so far (define step: ${STEP_ID}).`, '']
  for (const exchange of exchanges) {
    lines.push(`[Agent, turn ${exchange.turn}]`, exchange.agentMessage, '', `[You, turn ${exchange.turn}]`, exchange.reply, '')
  }
  lines.push(`[Agent, turn ${exchanges.length + 1}] (latest)`, latestAgentMessage, '',
    'Write your reply to the agent\'s latest message, following your policies.')
  return lines.join('\n')
}

/** One stateless, tool-less Claude call. Returns the reply plus evidence that no tool was used. */
async function askSimulatedUser({ systemPrompt, conversationText, turn, runDir, simuserCwd }) {
  const args = [
    '-p', '--model', opts['simuser-model'],
    '--tools', '', // no built-in tools
    '--setting-sources', '', // no user/project/local settings: no hooks, plugins, permissions
    '--strict-mcp-config', // no MCP servers
    '--disable-slash-commands', // no skills
    '--no-session-persistence', // stateless: the whole conversation is passed every time
    '--system-prompt', systemPrompt,
    '--json-schema', JSON.stringify(SIMUSER_REPLY_SCHEMA),
    '--output-format', 'stream-json', '--verbose',
    '--', conversationText,
  ]
  let last
  for (let attempt = 1; attempt <= 2; attempt++) {
    const base = join(runDir, 'turns', `${pad(turn)}-simuser${attempt > 1 ? `-retry${attempt}` : ''}`)
    const proc = await runProcess({
      command: 'claude', args, cwd: simuserCwd, env: BASE_ENV, timeoutMs: SIMUSER_TIMEOUT_MS,
      stdoutPath: `${base}.stdout.jsonl`, stderrPath: `${base}.stderr.txt`,
    })
    const events = parseJsonLines(proc.stdout)
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
    const result = events.findLast((e) => e.type === 'result')
    const toolUses = events.filter((e) => e.type === 'assistant')
      .flatMap((e) => e.message?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name)
    // --json-schema is delivered through a synthetic StructuredOutput tool;
    // that is the output channel, not a capability. Anything else is a violation.
    const toolCheck = {
      availableTools: init?.tools ?? null,
      toolUses,
      ok: (init?.tools ?? []).every((t) => t === 'StructuredOutput') && toolUses.every((t) => t === 'StructuredOutput'),
    }
    const reply = result?.structured_output ?? parseJsonFromText(result?.result)
    last = { proc, toolCheck, reply, costUsd: result?.total_cost_usd ?? null }
    if (reply && SIMUSER_REPLY_SCHEMA.properties.reply_type.enum.includes(reply.reply_type) && reply.text) {
      return { ...last, ok: true, attempts: attempt }
    }
  }
  return { ...last, ok: false, attempts: 2 }
}

/** Fallback when structured output is missing: first parseable {...} containing reply_type. */
function parseJsonFromText(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { /* fall through */ }
  for (const match of String(text).matchAll(/\{[\s\S]*?\}/g)) {
    try {
      const value = JSON.parse(match[0])
      if (value.reply_type) return value
    } catch { /* keep looking */ }
  }
  return null
}

// ---------------------------------------------------------------------------
// Turn analysis
// ---------------------------------------------------------------------------

function analyzeLeadMessage(text) {
  const trimmed = String(text ?? '').trim()
  const paragraphs = trimmed.split(/\n\s*\n/)
  // A long draft often carries its "approve this?" ask at the top, so look at
  // both the first and the last paragraph for an invitation to reply.
  const framing = `${paragraphs[0] ?? ''}\n\n${paragraphs.at(-1) ?? ''}`
  const endsWithQuestion = /\?[\s*_`)"'”»]*$/.test(trimmed)
  const questionCount = (trimmed.match(/\?(?=[\s*_`)"'”»]|$)/g) ?? []).length
  const invitesReply = new RegExp([
    'let me know', 'please (?:confirm|choose|pick|reply|answer)', '\\bapprov(?:e|al)\\b', 'do you want',
    'should I', 'shall I', 'would you (?:like|prefer)', 'which (?:option|one|would|do)', 'sounds? (?:good|right)',
    'looks? (?:good|right)', 'ok(?:ay)? to', 'go ahead', '\\bconfirm', 'tell me what to change', 'once you answer',
  ].join('|'), 'i').test(framing)
  const headlessSignals = HEADLESS_SIGNAL_PATTERNS.flatMap((pattern) => {
    const match = trimmed.match(pattern)
    if (!match) return []
    const at = match.index
    return [{ pattern: String(pattern), context: trimmed.slice(Math.max(0, at - 80), at + 80).replace(/\s+/g, ' ') }]
  })
  return {
    endsWithQuestion,
    questionCount,
    invitesReply,
    waitsForInput: endsWithQuestion || invitesReply || questionCount > 0,
    headlessSignals,
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  const stamp = utcStamp()
  const runName = `${opts.cli}-${stamp}`
  const runDir = join(POC_DIR, 'runs', runName)
  const runScratch = join(SCRATCH, `poc-${runName}`)
  const targetDir = join(SCRATCH, `poc-target-${opts.cli}-${stamp}`)
  const markerPath = join(targetDir, MARKER_NAME)
  const changeDir = join(targetDir, 'openspec/changes', CHANGE_NAME)

  const prompt = buildStepPrompt(markerPath)
  if (opts['print-prompt']) {
    console.log(prompt.fullPrompt)
    return
  }

  for (const required of ['proposal.md', 'design.md', 'test-plan.md', 'specs']) {
    if (!existsSync(join(REFERENCE_DIR, required))) throw new Error(`hidden reference is missing ${required}`)
  }
  if (!relative(WORKTREE_ROOT, targetDir).startsWith('..')) {
    throw new Error('target repo must live outside the agent-evals worktree')
  }

  mkdirSync(join(runDir, 'turns'), { recursive: true })
  mkdirSync(runScratch, { recursive: true })
  const simuserCwd = join(runScratch, 'simuser-cwd') // empty dir: nothing to discover
  mkdirSync(simuserCwd, { recursive: true })
  writeFileSync(join(runDir, 'step-prompt.txt'), prompt.fullPrompt)

  const startingPrompt = readFileSync(opts['starting-prompt'], 'utf8').trim()
  const simuserSystem = buildSimulatedUserSystemPrompt(startingPrompt)

  setupTargetRepo(targetDir)
  const codexSetup = opts.cli === 'codex' ? setupCodexHome(runScratch, runDir) : null
  const lead = opts.cli === 'claude'
    ? createClaudeLead({ targetDir, stepPrompt: prompt.fullPrompt, model: opts['claude-model'], setup: opts['claude-lead-setup'] })
    : createCodexLead({
      targetDir, stepPrompt: prompt.fullPrompt, model: opts['codex-model'], effort: opts['codex-effort'],
      codexHome: codexSetup.codexHome, home: codexSetup.home,
    })

  const meta = {
    cli: opts.cli,
    runName,
    startedAt: new Date().toISOString(),
    targetDir,
    markerPath,
    leadModel: lead.model,
    claudeLeadSetup: opts.cli === 'claude' ? opts['claude-lead-setup'] : undefined,
    responderInput: opts['responder-input'],
    codexEffort: opts.cli === 'codex' ? opts['codex-effort'] : undefined,
    codagentPlugin: codexSetup?.codagentPlugin,
    simulatedUser: {
      model: opts['simuser-model'],
      policyVersion: SIMUSER_POLICY_VERSION,
      referenceDir: REFERENCE_DIR,
      referenceFiles: simuserSystem.referenceFiles,
      systemPromptSha256: sha256(simuserSystem.text),
    },
    stepPrompt: {
      file: 'step-prompt.txt',
      sha256: sha256(prompt.fullPrompt),
      params: prompt.params,
      substitutions: prompt.substitutions,
    },
    limits: { maxTurns: MAX_TURNS, turnTimeoutMs: TURN_TIMEOUT_MS, simuserTimeoutMs: SIMUSER_TIMEOUT_MS },
  }

  const exchanges = [] // spec-shaped conversation evidence
  const turns = [] // detailed per-turn records
  const persist = () => {
    writeJson(join(runDir, 'conversation.json'), { ...meta, exchanges })
    writeJson(join(runDir, 'turns.json'), turns)
  }
  persist()

  const wallStart = Date.now()
  let stopReason = 'turn-cap'
  let nextMessage = `Let's start the ${STEP_ID} step`

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const args = turn === 1 ? lead.startArgs(nextMessage) : lead.resumeArgs(nextMessage)
    const base = join(runDir, 'turns', `${pad(turn)}-lead`)
    log(`turn ${turn}: lead (${lead.cli}) running…`)
    const proc = await runProcess({
      command: lead.command, args, cwd: lead.cwd, env: lead.env, timeoutMs: TURN_TIMEOUT_MS,
      stdoutPath: `${base}.stdout.jsonl`, stderrPath: `${base}.stderr.txt`,
    })
    const parsed = lead.parse(proc.stdout)
    // Codex emits several agent messages per turn and often puts the question
    // in a middle message, ending on a status line ("Approval is pending…").
    // The responder therefore sees the whole turn unless --responder-input last.
    const turnText = parsed.allMessages.map((m) => m.trim()).filter(Boolean).join('\n\n') || parsed.finalMessage
    const agentMessage = opts['responder-input'] === 'last' ? parsed.finalMessage : turnText
    const analysis = analyzeLeadMessage(agentMessage)
    const markerExists = existsSync(markerPath)
    const record = {
      turn,
      step: STEP_ID,
      attempt: 1,
      lead: {
        invocation: [lead.command, ...lead.describeArgs(args)],
        userMessage: nextMessage,
        sessionId: lead.sessionId() ?? parsed.sessionId,
        durationMs: proc.durationMs,
        exitCode: proc.code,
        timedOut: proc.timedOut,
        spawnError: proc.spawnError,
        isError: parsed.isError,
        error: parsed.error,
        finalMessage: parsed.finalMessage,
        allMessages: parsed.allMessages,
        agentMessage,
        finalMessageAnalysis: analyzeLeadMessage(parsed.finalMessage),
        analysis,
        toolUses: parsed.toolUses,
        skillsInvoked: parsed.skillsInvoked,
        permissionDenials: parsed.permissionDenials,
        usage: parsed.usage,
        init: parsed.init,
        changeDirFiles: listFiles(changeDir),
        markerExists,
        stdout: relative(runDir, `${base}.stdout.jsonl`),
        stderr: relative(runDir, `${base}.stderr.txt`),
      },
      simulatedUser: null,
    }
    turns.push(record)
    log(`turn ${turn}: lead done in ${Math.round(proc.durationMs / 1000)}s, exit=${proc.code}, `
      + `waits=${analysis.waitsForInput}, question=${analysis.endsWithQuestion}, marker=${markerExists}, `
      + `headlessSignals=${analysis.headlessSignals.length}`)
    persist()

    if (markerExists) { stopReason = 'marker-created'; break }
    if (proc.timedOut) { stopReason = 'lead-turn-timeout'; break }
    if (proc.code !== 0 || parsed.isError) { stopReason = 'lead-turn-failed'; break }
    if (turn === MAX_TURNS) break

    // The simulated user's first reply is the pinned starting prompt, verbatim.
    let reply
    if (exchanges.length === 0) {
      reply = { reply_type: 'answer', text: startingPrompt, source: 'pinned-starting-prompt', durationMs: 0 }
    } else {
      log(`turn ${turn}: simulated user running…`)
      const answer = await askSimulatedUser({
        systemPrompt: simuserSystem.text,
        conversationText: formatConversationForSimulatedUser(exchanges, agentMessage),
        turn, runDir, simuserCwd,
      })
      if (!answer.ok) {
        record.simulatedUser = { ok: false, error: 'no valid reply', toolCheck: answer.toolCheck }
        stopReason = 'simulated-user-failed'
        persist()
        break
      }
      reply = {
        ...answer.reply,
        source: 'model',
        durationMs: answer.proc.durationMs,
        attempts: answer.attempts,
        toolCheck: answer.toolCheck,
        costUsd: answer.costUsd,
      }
    }
    reply.leakSignals = SIMUSER_LEAK_PATTERNS.filter((p) => p.test(reply.text)).map(String)
    record.simulatedUser = reply
    exchanges.push({
      step: STEP_ID, attempt: 1, turn,
      agentMessage,
      reply: reply.text,
      replyType: reply.reply_type,
      replySource: reply.source,
      simulatedApproval: reply.reply_type === 'approval',
    })
    log(`turn ${turn}: simulated user -> ${reply.reply_type}: ${truncate(reply.text.replace(/\s+/g, ' '), 140)}`)
    persist()
    nextMessage = reply.text
  }

  // Final, informational checks.
  const proposalPath = join(changeDir, 'proposal.md')
  const proposalExists = existsSync(proposalPath)
  if (proposalExists) {
    mkdirSync(join(runDir, 'artifacts'), { recursive: true })
    copyFileSync(proposalPath, join(runDir, 'artifacts/proposal.md'))
  }
  const validate = spawnSync('openspec', ['validate', CHANGE_NAME], { cwd: targetDir, env: BASE_ENV, encoding: 'utf8' })
  const gitStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: targetDir, encoding: 'utf8' })

  const leadTurns = turns.map((t) => t.lead)
  const summary = {
    ...meta,
    finishedAt: new Date().toISOString(),
    wallTimeMs: Date.now() - wallStart,
    stopReason,
    leadTurns: turns.length,
    simulatedUserReplies: exchanges.length,
    replyTypes: countBy(exchanges.map((e) => e.replyType)),
    leadTurnsWaitingForInput: leadTurns.filter((l) => l.analysis.waitsForInput && !l.markerExists).length,
    leadTurnsEndingInQuestion: leadTurns.filter((l) => l.analysis.endsWithQuestion).length,
    leadTurnsWithHeadlessSignals: turns.filter((t) => t.lead.analysis.headlessSignals.length > 0)
      .map((t) => ({ turn: t.turn, signals: t.lead.analysis.headlessSignals })),
    nonWaitingTurnsWithoutMarker: turns.filter((t) => !t.lead.analysis.waitsForInput && !t.lead.markerExists)
      .map((t) => t.turn),
    skillsInvoked: [...new Set(leadTurns.flatMap((l) => l.skillsInvoked))],
    codagentSkillsAvailable: leadTurns[0]?.init?.codagentSkills ?? null,
    permissionDenials: leadTurns.flatMap((l, i) => l.permissionDenials.map((d) => ({ turn: i + 1, ...d }))),
    simulatedUserToolCheckOk: turns.every((t) => !t.simulatedUser?.toolCheck || t.simulatedUser.toolCheck.ok),
    simulatedUserLeakSignals: turns.filter((t) => t.simulatedUser?.leakSignals?.length)
      .map((t) => ({ turn: t.turn, signals: t.simulatedUser.leakSignals })),
    leadDurationMs: sum(leadTurns.map((l) => l.durationMs)),
    simulatedUserDurationMs: sum(turns.map((t) => t.simulatedUser?.durationMs ?? 0)),
    leadCostUsd: opts.cli === 'claude' ? sum(leadTurns.map((l) => l.usage?.costUsd ?? 0)) : undefined,
    simulatedUserCostUsd: sum(turns.map((t) => t.simulatedUser?.costUsd ?? 0)),
    proposalExists,
    markerCreated: existsSync(markerPath),
    markerTurn: turns.find((t) => t.lead.markerExists)?.turn ?? null,
    openspecValidate: { exitCode: validate.status, output: `${validate.stdout}${validate.stderr}`.trim() },
    targetGitStatus: gitStatus.stdout.trim().split('\n').filter(Boolean),
  }
  writeJson(join(runDir, 'summary.json'), summary)
  persist()
  log(`done: stop=${stopReason}, turns=${turns.length}, proposal=${proposalExists}, marker=${summary.markerCreated}, `
    + `wall=${Math.round(summary.wallTimeMs / 1000)}s -> ${runDir}`)
}

function countBy(values) {
  return values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {})
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0)
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
