import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import {
  AGENT_SKILLS_MANIFEST_PATH,
  compareAgentSkillsProvenance,
  compareProvenance,
  readAgentSkillsProvenance,
  readWorkflowProvenance,
  resolveAgentRunnerDir,
} from '../evals/agent-runner/and-scene/lib/provenance.mjs'

const WORKFLOW_RELATIVE_PATH = 'workflows/core/plan-and-implement-change-v1.0.yaml'
const workflowYaml = 'name: plan-and-implement-change\nsteps:\n  - id: anything\n'

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
  const dir = await makeTempDir(join(tmpdir(), 'agent-evals-provenance-'))
  if (workflow !== null) {
    await mkdir(join(dir, 'workflows/core'), { recursive: true })
    await writeFile(join(dir, WORKFLOW_RELATIVE_PATH), workflow)
  }
  return dir
}

test('the evaluated workflow defaults to the core plan-and-implement composite', async () => {
  const provenance = await readWorkflowProvenance({ agentRunnerDir: await checkout(), exec: execStub() })
  assert.equal(provenance.workflow, 'core:plan-and-implement-change')
  assert.equal(provenance.workflow_relative_path, WORKFLOW_RELATIVE_PATH)
})

test('a selected workflow is located and hashed under its own logical reference', async () => {
  const dir = await checkout()
  const other = 'name: orchestrated-implement-change\n'
  await writeFile(join(dir, 'workflows/core/orchestrated-implement-change-v1.0.yaml'), other)
  const provenance = await readWorkflowProvenance({
    agentRunnerDir: dir,
    workflow: 'core:orchestrated-implement-change',
    exec: execStub(),
  })
  assert.equal(provenance.workflow, 'core:orchestrated-implement-change')
  assert.equal(provenance.workflow_sha256, hashString(other))
  assert.equal(provenance.runner_workflow_name, 'orchestrated-implement-change')
})

test('a clean Agent Skills checkout records its commit and plugin manifest hash', async () => {
  const dir = await makeTempDir(join(tmpdir(), 'agent-evals-skills-provenance-'))
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
  const dir = await makeTempDir(join(tmpdir(), 'agent-evals-skills-provenance-'))
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(join(dir, AGENT_SKILLS_MANIFEST_PATH), '{}\n')

  await assert.rejects(
    () => readAgentSkillsProvenance({
      agentSkillsDir: dir,
      exec: execStub({ 'git status --porcelain': { status: 0, stdout: '?? scratch.txt\n' } }),
    }),
    (error) => error.code === 'dirty-agent-skills-checkout',
  )

  const missing = await makeTempDir(join(tmpdir(), 'agent-evals-skills-provenance-'))
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
  assert.equal(provenance.runner_workflow_name, 'plan-and-implement-change')
  assert.equal(provenance.complete, true)
  assert.equal(Object.hasOwn(provenance, 'verification_workflow_sha256'), false)
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
      exec: execStub({ 'git status --porcelain': { status: 0, stdout: ' M workflows/core/plan-and-implement-change-v1.0.yaml\n' } }),
    }),
    (error) => {
      assert.equal(error.code, 'dirty-agent-runner-checkout')
      assert.match(error.message, /plan-and-implement-change-v1\.0\.yaml/)
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

test('a workflow that does not resolve stops the evaluation before Agent Runner', async () => {
  const dir = await checkout({ workflow: null })

  await assert.rejects(
    () => readWorkflowProvenance({ agentRunnerDir: dir, exec: execStub() }),
    (error) => {
      assert.equal(error.code, 'workflow-resolution')
      assert.match(error.message, /core:plan-and-implement-change/)
      return true
    },
  )
  const present = await checkout()
  await assert.rejects(
    () => readWorkflowProvenance({ agentRunnerDir: present, workflow: 'not a ref', exec: execStub() }),
    (error) => error.code === 'workflow-resolution',
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
  const recorded = { commit: 'a', workflow: 'core:x', workflow_sha256: 'b', runner_workflow_name: 'x', cli_version: 'c' }

  const mismatches = compareProvenance(recorded, { ...recorded, commit: 'z', cli_version: 'c2' })

  assert.deepEqual(mismatches, [
    { field: 'commit', recorded: 'a', current: 'z' },
    { field: 'cli_version', recorded: 'c', current: 'c2' },
  ])
})

test('compareProvenance reports a changed workflow reference, definition hash, or reported name', () => {
  const recorded = { commit: 'a', workflow: 'core:x', workflow_sha256: 'b', runner_workflow_name: 'x', cli_version: 'c' }

  assert.deepEqual(compareProvenance(recorded, {
    ...recorded, workflow: 'core:y', workflow_sha256: 'b2', runner_workflow_name: 'y',
  }), [
    { field: 'workflow', recorded: 'core:x', current: 'core:y' },
    { field: 'workflow_sha256', recorded: 'b', current: 'b2' },
    { field: 'runner_workflow_name', recorded: 'x', current: 'y' },
  ])
})

// run.sh resolves the Agent Runner checkout as AGENT_RUNNER_DIR, falling back to
// the sibling `../agent-runner`. The suite's own checks resolve it the same way,
// so a workstation with the conventional layout exercises the live contract
// check without extra configuration.
test('an explicit AGENT_RUNNER_DIR selects the Agent Runner checkout', () => {
  assert.equal(
    resolveAgentRunnerDir({ env: { AGENT_RUNNER_DIR: '/somewhere/agent-runner' }, evalsRoot: '/repos/agent-evals' }),
    '/somewhere/agent-runner',
  )
})

test('an unset AGENT_RUNNER_DIR falls back to the sibling checkout run.sh defaults to', () => {
  assert.equal(
    resolveAgentRunnerDir({ env: {}, evalsRoot: '/repos/agent-evals' }),
    '/repos/agent-runner',
  )
})

test('a blank AGENT_RUNNER_DIR falls back rather than selecting an empty path', () => {
  assert.equal(
    resolveAgentRunnerDir({ env: { AGENT_RUNNER_DIR: '   ' }, evalsRoot: '/repos/agent-evals' }),
    '/repos/agent-runner',
  )
})
