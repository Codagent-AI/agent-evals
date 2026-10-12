import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { killWorktreeOrphans, latestActivityMs } from '../evals/agent-runner/and-scene/lib/runner-activity.mjs'
import { mergeClaudeFirstRunState, seedClaudeFirstRunState } from '../evals/agent-runner/and-scene/lib/claude-first-run.mjs'
import { detectClaudeQuotaReset, readTranscriptQuotaAudit } from '../evals/agent-runner/and-scene/lib/claude-quota.mjs'
import { workflowRequestsInteractiveBackend } from '../evals/agent-runner/and-scene/lib/workflow.mjs'

async function at(path, seconds) {
  await utimes(path, seconds, seconds)
}

test('activity is the newest change across the run store, transcripts, and worktree commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'activity-'))
  const store = join(root, 'store')
  const worktree = join(root, 'worktree')
  await mkdir(join(store, 'runs/r1'), { recursive: true })
  await mkdir(join(worktree, 'node_modules/pkg'), { recursive: true })
  await mkdir(join(worktree, '.git/refs/heads'), { recursive: true })
  await writeFile(join(store, 'runs/r1/audit.log'), 'x')
  await writeFile(join(worktree, 'node_modules/pkg/index.js'), 'x')
  await writeFile(join(worktree, '.git/HEAD'), 'ref: refs/heads/main\n')
  for (const path of [join(store, 'runs/r1'), join(store, 'runs'), store, worktree, join(worktree, 'node_modules'), join(worktree, '.git/refs/heads')]) {
    await at(path, 1000)
  }
  await at(join(store, 'runs/r1/audit.log'), 2000)
  await at(join(worktree, '.git/HEAD'), 1500)
  // Skipped trees never count, however recent.
  await at(join(worktree, 'node_modules/pkg/index.js'), 9000)
  await at(join(worktree, 'node_modules/pkg'), 9000)

  assert.equal(latestActivityMs({ roots: [store, worktree, join(root, 'missing')] }), 2000 * 1000)
  await at(join(worktree, '.git/HEAD'), 3000)
  assert.equal(latestActivityMs({ roots: [store, worktree], gitWorktrees: [worktree] }), 3000 * 1000)
})

async function fakeProc(root, processes) {
  for (const [pid, { ppid, cwd, cmdline = 'node', environ = [] }] of Object.entries(processes)) {
    const dir = join(root, pid)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'stat'), `${pid} (some name) S ${ppid} 0 0`)
    await writeFile(join(dir, 'cmdline'), `${cmdline}\0`)
    await writeFile(join(dir, 'environ'), environ.map((entry) => `${entry}\0`).join(''))
    await symlink(cwd, join(dir, 'cwd'))
  }
}

test('orphan cleanup ends only this run\'s processes inside the worktree, never the controller or its ancestors', async () => {
  const procDir = await mkdtemp(join(tmpdir(), 'proc-'))
  const worktree = '/runs/r1/.runtime/candidate-worktree'
  const run = ['HOME=/h', 'AGENT_RUNNER_RUN_ID=runner-7']
  await fakeProc(procDir, {
    10: { ppid: 1, cwd: worktree, cmdline: 'bash', environ: run }, // the controller's parent shell
    20: { ppid: 10, cwd: worktree, cmdline: 'node controller.mjs', environ: run },
    30: { ppid: 1, cwd: `${worktree}/src`, cmdline: 'npm test', environ: run },
    35: { ppid: 1, cwd: `${worktree}/src`, cmdline: 'stubborn', environ: run },
    40: { ppid: 1, cwd: '/runs/r1/.runtime/candidate-worktree-other', cmdline: 'other', environ: run },
    45: { ppid: 1, cwd: worktree, cmdline: 'editor', environ: ['HOME=/h'] },
    46: { ppid: 1, cwd: worktree, cmdline: 'other run', environ: ['AGENT_RUNNER_RUN_ID=runner-8'] },
    50: { ppid: 1, cwd: '/tmp', cmdline: 'unrelated', environ: run },
  })
  const signals = []
  const killed = await killWorktreeOrphans({
    worktree,
    runId: 'runner-7',
    procDir,
    selfPid: 20,
    platform: 'linux',
    graceMs: 0,
    // Process 30 exits on SIGTERM; 35 survives it.
    sleep: async () => { await rm(join(procDir, '30'), { recursive: true }) },
    kill: (pid, signal) => signals.push([pid, signal]),
  })
  assert.deepEqual(signals, [[30, 'SIGTERM'], [35, 'SIGTERM'], [35, 'SIGKILL']])
  assert.deepEqual(killed.map(({ pid, command, killed: forced }) => [pid, command, forced ?? false]), [
    [30, 'npm test', false],
    [35, 'stubborn', true],
  ])
  assert.deepEqual(await killWorktreeOrphans({ worktree, runId: 'runner-7', procDir, platform: 'darwin', kill: () => assert.fail() }), [])
  assert.deepEqual(await killWorktreeOrphans({ worktree, runId: null, procDir, platform: 'linux', kill: () => assert.fail() }), [])
})

test('Claude first-run state is added without losing anything already recorded', () => {
  const merged = mergeClaudeFirstRunState({
    oauthAccount: { emailAddress: 'kept' },
    theme: 'light',
    projects: { '/w': { allowedTools: ['x'] }, '/other': { keep: true } },
  }, ['/w'])
  assert.deepEqual(merged, {
    oauthAccount: { emailAddress: 'kept' },
    theme: 'light',
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      '/w': { allowedTools: ['x'], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      '/other': { keep: true },
    },
  })
})

test('seeding writes the sandbox home state and refuses a symbolic link', async () => {
  const home = await mkdtemp(join(tmpdir(), 'home-'))
  const worktree = join(home, 'wt')
  await mkdir(worktree)
  await seedClaudeFirstRunState({ home, worktree })
  const state = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))
  assert.equal(state.hasCompletedOnboarding, true)
  assert.equal(state.projects[worktree].hasTrustDialogAccepted, true)

  const linked = await mkdtemp(join(tmpdir(), 'home-'))
  await symlink(join(home, '.claude.json'), join(linked, '.claude.json'))
  await assert.rejects(seedClaudeFirstRunState({ home: linked, worktree }), /symbolic link/)
})

test('a usage limit recorded in a Claude transcript becomes a quota line', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'claude-projects-'))
  await mkdir(join(projects, '-work'), { recursive: true })
  const entries = [
    { type: 'user', timestamp: '2026-10-12T10:00:00.000Z', message: { content: 'go' } },
    {
      type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: '2026-10-12T10:05:00.000Z',
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 1pm (UTC)" }] },
    },
  ]
  await writeFile(join(projects, '-work/s.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n'))
  const audit = await readTranscriptQuotaAudit({ projectsDir: projects })
  assert.match(audit, /^2026-10-12T10:05:00.000Z transcript_api_error \{"cli":"claude"\} You've hit/)
  const detected = detectClaudeQuotaReset({ audit, now: new Date('2026-10-12T10:06:00.000Z') })
  assert.equal(detected.reset_at, '2026-10-12T13:00:00.000Z')

  // An error recorded before the stalled run started is not current.
  assert.equal(await readTranscriptQuotaAudit({ projectsDir: projects, sinceMs: Date.parse('2026-10-12T10:06:00.000Z') }), '')
  assert.match(await readTranscriptQuotaAudit({ projectsDir: projects, sinceMs: Date.parse('2026-10-12T10:00:00.000Z') }), /hit your/)
  assert.equal(await readTranscriptQuotaAudit({ projectsDir: join(projects, 'missing') }), '')
})

test('a workflow requests the interactive backend only through an explicit interactive step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflows-'))
  await mkdir(join(root, 'workflows/core'), { recursive: true })
  await mkdir(join(root, 'workflows/openspec'), { recursive: true })
  await writeFile(join(root, 'workflows/core/inner.yaml'), 'steps:\n  - id: lead\n    autonomous_backend: interactive\n')
  await writeFile(join(root, 'workflows/core/claude-only.yaml'), 'steps:\n  - id: lead\n    autonomous_backend: interactive-claude\n')
  await writeFile(join(root, 'workflows/openspec/outer.yaml'), 'steps:\n  - id: nest\n    workflow: ../core/inner.yaml\n')
  await writeFile(join(root, 'workflows/openspec/builtin.yaml'), 'steps:\n  - id: nest\n    workflow: builtin:core/inner.yaml\n')
  await writeFile(join(root, 'workflows/openspec/plain.yaml'), 'steps:\n  - id: nest\n    workflow: ../core/claude-only.yaml\n')
  assert.equal(await workflowRequestsInteractiveBackend(join(root, 'workflows/openspec/outer.yaml')), true)
  assert.equal(await workflowRequestsInteractiveBackend(join(root, 'workflows/openspec/builtin.yaml')), true)
  assert.equal(await workflowRequestsInteractiveBackend(join(root, 'workflows/openspec/plain.yaml')), false)
})
