import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import {
  AGENT_SKILLS_MANIFEST_PATH,
  WORKFLOW_RELATIVE_PATH,
  compareAgentSkillsProvenance,
  compareProvenance,
  readAgentSkillsProvenance,
  readWorkflowProvenance,
} from '../evals/agent-runner/and-scene/lib/provenance.mjs'

const workflowYaml = 'name: implement-change\nsteps:\n  - id: verify-acceptance-handoff\n'

// A scripted `git`/`agent-runner` stub keeps provenance reading testable without
// building a real Agent Runner checkout for every case.
function execStub(overrides = {}) {
  const calls = []
  const responses = {
    'git rev-parse --is-inside-work-tree': { status: 0, stdout: 'true\n' },
    'git status --porcelain': { status: 0, stdout: '' },
    'git rev-parse HEAD': { status: 0, stdout: 'a'.repeat(40) + '\n' },
    'agent-runner --version': { status: 0, stdout: 'agent-runner 2.4.0\n' },
    ...overrides,
  }
  const exec = (command, args) => {
    const key = [command, ...args.filter((arg) => arg !== '-C' && !arg.startsWith('/'))].join(' ')
    calls.push(key)
    return responses[key] ?? { status: 1, stdout: '', stderr: `unexpected: ${key}` }
  }
  exec.calls = calls
  return exec
}

async function checkout({ workflow = workflowYaml } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-provenance-'))
  if (workflow !== null) {
    await mkdir(join(dir, 'workflows/core'), { recursive: true })
    await writeFile(join(dir, WORKFLOW_RELATIVE_PATH), workflow)
  }
  return dir
}

test('the pinned workflow path is the versioned implement-change contract', () => {
  assert.equal(WORKFLOW_RELATIVE_PATH, 'workflows/core/implement-change-v1.0.yaml')
})

test('a clean Agent Skills checkout records its commit and plugin manifest hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-skills-provenance-'))
  const manifest = '{"name":"codagent"}\n'
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(join(dir, AGENT_SKILLS_MANIFEST_PATH), manifest)

  const provenance = await readAgentSkillsProvenance({
    agentSkillsDir: dir,
    exec: execStub(),
  })

  assert.equal(provenance.commit, 'a'.repeat(40))
  assert.equal(provenance.clean, true)
  assert.equal(provenance.manifest_sha256, hashString(manifest))
  assert.equal(provenance.complete, true)
  assert.equal(provenance.reproducible, true)
})

test('Agent Skills provenance rejects a dirty or incomplete checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-skills-provenance-'))
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(join(dir, AGENT_SKILLS_MANIFEST_PATH), '{}\n')

  await assert.rejects(
    () => readAgentSkillsProvenance({
      agentSkillsDir: dir,
      exec: execStub({ 'git status --porcelain': { status: 0, stdout: '?? scratch.txt\n' } }),
    }),
    (error) => error.code === 'dirty-agent-skills-checkout',
  )

  const missing = await mkdtemp(join(tmpdir(), 'agent-evals-skills-provenance-'))
  await assert.rejects(
    () => readAgentSkillsProvenance({ agentSkillsDir: missing, exec: execStub() }),
    (error) => error.code === 'missing-agent-skills-manifest',
  )
})

test('Agent Skills resume comparison reports commit or manifest drift', () => {
  const recorded = { commit: 'a', manifest_sha256: 'b' }

  assert.deepEqual(compareAgentSkillsProvenance(recorded, { commit: 'z', manifest_sha256: 'c' }), [
    { field: 'commit', recorded: 'a', current: 'z' },
    { field: 'manifest_sha256', recorded: 'b', current: 'c' },
  ])
})

test('a clean checkout records commit, workflow hash, and CLI version', async () => {
  const dir = await checkout()

  const provenance = await readWorkflowProvenance({ agentRunnerDir: dir, exec: execStub() })

  assert.equal(provenance.commit, 'a'.repeat(40))
  assert.equal(provenance.clean, true)
  assert.equal(provenance.workflow_sha256, hashString(workflowYaml))
  assert.equal(provenance.cli_version, 'agent-runner 2.4.0')
  assert.equal(provenance.workflow_path, join(dir, WORKFLOW_RELATIVE_PATH))
  assert.equal(provenance.complete, true)
})

test('the recorded commit is not compared against a predetermined value', async () => {
  const dir = await checkout()
  const other = 'b'.repeat(40)

  const provenance = await readWorkflowProvenance({
    agentRunnerDir: dir,
    exec: execStub({ 'git rev-parse HEAD': { status: 0, stdout: `${other}\n` } }),
  })

  assert.equal(provenance.commit, other)
  assert.equal(provenance.clean, true)
})

test('an unstaged change stops the evaluation before Agent Runner', async () => {
  const dir = await checkout()

  await assert.rejects(
    () => readWorkflowProvenance({
      agentRunnerDir: dir,
      exec: execStub({ 'git status --porcelain': { status: 0, stdout: ' M workflows/core/implement-change-v1.0.yaml\n' } }),
    }),
    (error) => {
      assert.equal(error.code, 'dirty-agent-runner-checkout')
      assert.match(error.message, /implement-change-v1\.0\.yaml/)
      return true
    },
  )
})

test('an untracked file stops the evaluation before Agent Runner', async () => {
  const dir = await checkout()

  await assert.rejects(
    () => readWorkflowProvenance({
      agentRunnerDir: dir,
      exec: execStub({ 'git status --porcelain': { status: 0, stdout: '?? scratch.txt\n' } }),
    }),
    (error) => assert.equal(error.code, 'dirty-agent-runner-checkout') ?? true,
  )
})

test('a failing git status is an error rather than an assumed clean checkout', async () => {
  const dir = await checkout()

  await assert.rejects(
    () => readWorkflowProvenance({
      agentRunnerDir: dir,
      exec: execStub({
        'git status --porcelain': { status: 128, stdout: '', stderr: 'fatal: not a git repository\n' },
      }),
    }),
    (error) => {
      assert.equal(error.code, 'git-status-failed')
      assert.match(error.message, /not a git repository/)
      return true
    },
  )
})

test('a non-worktree checkout is rejected', async () => {
  const dir = await checkout()

  await assert.rejects(
    () => readWorkflowProvenance({
      agentRunnerDir: dir,
      exec: execStub({ 'git rev-parse --is-inside-work-tree': { status: 128, stdout: '' } }),
    }),
    (error) => assert.equal(error.code, 'not-a-git-worktree') ?? true,
  )
})

test('a missing workflow stops the evaluation before Agent Runner', async () => {
  const dir = await checkout({ workflow: null })

  await assert.rejects(
    () => readWorkflowProvenance({ agentRunnerDir: dir, exec: execStub() }),
    (error) => assert.equal(error.code, 'missing-workflow') ?? true,
  )
})

test('an unavailable CLI version marks provenance incomplete rather than failing', async () => {
  const dir = await checkout()

  const provenance = await readWorkflowProvenance({
    agentRunnerDir: dir,
    exec: execStub({ 'agent-runner --version': { status: 127, stdout: '' } }),
  })

  assert.equal(provenance.cli_version, null)
  assert.equal(provenance.complete, false)
  assert.equal(provenance.reproducible, false)
})

test('compareProvenance accepts an identical checkout on resume', () => {
  const recorded = { commit: 'a', workflow_sha256: 'b', cli_version: 'c' }

  assert.deepEqual(compareProvenance(recorded, { ...recorded }), [])
})

test('compareProvenance reports a changed commit, workflow hash, and CLI version', () => {
  const recorded = { commit: 'a', workflow_sha256: 'b', cli_version: 'c' }

  const mismatches = compareProvenance(recorded, { commit: 'z', workflow_sha256: 'b', cli_version: 'c2' })

  assert.deepEqual(mismatches, [
    { field: 'commit', recorded: 'a', current: 'z' },
    { field: 'cli_version', recorded: 'c', current: 'c2' },
  ])
})
