import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import {
  WORKFLOW_RELATIVE_PATH,
  compareProvenance,
  readWorkflowProvenance,
} from '../evals/agent-runner/and-scene/lib/provenance.mjs'

const workflowYaml = 'name: implement-change2\nsteps:\n  - id: simplify\n'

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
    await mkdir(join(dir, 'workflows/openspec'), { recursive: true })
    await writeFile(join(dir, WORKFLOW_RELATIVE_PATH), workflow)
  }
  return dir
}

test('the pinned workflow path is the implement-change2 contract', () => {
  assert.equal(WORKFLOW_RELATIVE_PATH, 'workflows/openspec/implement-change2.yaml')
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
      exec: execStub({ 'git status --porcelain': { status: 0, stdout: ' M workflows/openspec/implement-change2.yaml\n' } }),
    }),
    (error) => {
      assert.equal(error.code, 'dirty-agent-runner-checkout')
      assert.match(error.message, /implement-change2\.yaml/)
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
