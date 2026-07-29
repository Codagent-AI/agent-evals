import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { loadCandidateRescoreSource } from '../evals/agent-runner/and-scene/lib/rescore.mjs'

const fixtureSha = '1'.repeat(40)
const finalSha = '2'.repeat(40)
const workflowHistory = [
  { step: 'run-validator', outcome: 'success' },
  { step: 'open-draft-pr', outcome: 'success' },
  { step: 'verify-draft-pr', outcome: 'success' },
  { step: 'prepare-acceptance', outcome: 'success' },
  { step: 'verify-acceptance-handoff', outcome: 'success' },
]

async function sourceRun({
  historyComplete = true,
  corruptEvidence = false,
  changeName = 'create-and-scene',
} = {}) {
  const sourceDir = await mkdtemp(join(tmpdir(), 'and-scene-rescore-source-'))
  const sessionDir = join(sourceDir, '.runtime/runner-session')
  const outputDir = join(sessionDir, 'output')
  await mkdir(join(outputDir, 'acceptance-screenshots'), { recursive: true })

  const evidence = [
    ['assumptions-ledger', 'acceptance-assumptions.md', 'No unresolved assumptions.\n'],
    ['findings-history', 'acceptance-findings.md', 'No remaining findings.\n'],
    ['acceptance-flow-record', 'acceptance-flow-evidence.md', `Final revision: ${finalSha}\n`],
    ['final-handoff', 'acceptance-handoff.md', `Ready SHA: ${finalSha}\n`],
    ['acceptance-screenshot', 'acceptance-screenshots/step-1.png', 'png bytes'],
    ['screenshot-metadata', 'acceptance-test.md', 'Screenshot: acceptance-screenshots/step-1.png\n'],
  ]
  const artifacts = []
  for (const [role, relativePath, bytes] of evidence) {
    const path = join(outputDir, relativePath)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, bytes)
    artifacts.push({
      role,
      path: `/artifacts/.runtime/runner-session/output/${relativePath}`,
      sha256: hashString(bytes),
    })
  }
  if (corruptEvidence) artifacts[0].sha256 = 'f'.repeat(64)

  const delivery = {
    verified: true,
    branch: 'eval/and-scene/completed',
    base_branch: 'main',
    fixture_commit: fixtureSha,
    final_sha: finalSha,
    remote_sha: finalSha,
    pull_request: {
      number: 9,
      url: 'https://github.com/Codagent-AI/and-scene/pull/9',
      state: 'OPEN',
      draft: true,
      base: 'main',
      head_branch: 'eval/and-scene/completed',
      head_sha: finalSha,
    },
    final_validator: workflowHistory[0],
    workflow_history: workflowHistory,
    acceptance_artifacts: artifacts,
  }
  const state = {
    schema_version: 2,
    state_kind: 'and-scene-run-state',
    run_id: 'completed-run',
    run_kind: 'candidate',
    identity: { candidate_repository: 'github.com/Codagent-AI/and-scene' },
    candidate_source: {
      repository: 'github.com/Codagent-AI/and-scene',
      fixture_commit: fixtureSha,
      branch: delivery.branch,
      base_branch: delivery.base_branch,
    },
    delivery: {
      applicable: true,
      repository: 'github.com/Codagent-AI/and-scene',
      origin: 'github.com/Codagent-AI/and-scene',
      fixture_commit: fixtureSha,
      branch: delivery.branch,
      base_branch: delivery.base_branch,
      runner: {
        run_id: 'runner-complete',
        session_dir: '/artifacts/.runtime/runner-session',
      },
      pull_request: delivery.pull_request,
      final_sha: finalSha,
      final_validator: delivery.final_validator,
      acceptance: {
        artifacts,
        workflow_history: workflowHistory,
        manifest_sha256: '7'.repeat(64),
        lineage: { accepted: false, mode: 'stale-evaluator-output' },
      },
      retained_for_manual_cleanup: true,
    },
    agent_runner: {
      run_id: 'runner-complete',
      session_dir: '/artifacts/.runtime/runner-session',
    },
    role_profiles: {
      lead: { cli: 'claude', model: 'opus', effort: 'high', agent: 'planner' },
      implementor: { cli: 'claude', model: 'sonnet', effort: 'medium', agent: 'implementor' },
      reviewer: { cli: 'claude', model: 'opus', effort: 'high', agent: 'reviewer' },
    },
    agent_runner_provenance: {
      commit: '3'.repeat(40),
      workflow_sha256: '4'.repeat(64),
      complete: true,
      reproducible: true,
    },
    agent_skills_provenance: {
      commit: '5'.repeat(40),
      manifest_sha256: '6'.repeat(64),
      complete: true,
      reproducible: true,
    },
  }
  const result = {
    schema_version: 4,
    run_id: state.run_id,
    run_kind: 'candidate',
    mode: 'agent-runner',
    evaluation_status: 'pending-human-review',
    workflow: {
      full_workflow: true,
      history_complete: historyComplete,
      missing_steps: historyComplete ? [] : ['verify-acceptance-handoff'],
      prohibited_effects: [],
      arguments: [`change_name=${changeName}`, 'skip_validator=true'],
      run_id: state.agent_runner.run_id,
      session_dir: state.agent_runner.session_dir,
      observed_steps: workflowHistory,
    },
    delivery: state.delivery,
    implementation_metrics: { active_duration_ms: 1234, attempts: [] },
    cost: { implementation: { complete: true } },
    pricing: { verified: true },
  }
  await mkdir(join(sourceDir, 'phases'), { recursive: true })
  await writeFile(join(sourceDir, 'run-state.json'), `${JSON.stringify(state)}\n`)
  await writeFile(join(sourceDir, 'result.json'), `${JSON.stringify(result)}\n`)
  await writeFile(
    join(sourceDir, 'phases/delivery-verification.json'),
    `${JSON.stringify(delivery)}\n`,
  )
  return { sourceDir, sessionDir, state, delivery }
}

test('a completed candidate run imports its immutable change name for evaluator-only rescoring', async () => {
  const context = await sourceRun({ changeName: 'custom-scene-change' })

  const imported = await loadCandidateRescoreSource({ sourceDir: context.sourceDir })

  assert.equal(imported.source_run_id, 'completed-run')
  assert.equal(imported.candidate_source.fixture_commit, fixtureSha)
  assert.equal(imported.delivery.final_sha, finalSha)
  assert.equal(imported.delivery.pull_request.number, 9)
  assert.equal(imported.change_name, 'custom-scene-change')
  assert.equal(imported.runner.session_dir, await realpath(context.sessionDir))
  assert.ok(imported.delivery.acceptance.artifacts.every(({ path }) => (
    path.startsWith(imported.source_dir)
  )))
  assert.equal(imported.delivery.acceptance.manifest_sha256, undefined)
  assert.equal(imported.delivery.acceptance.lineage, undefined)
  assert.match(imported.provenance_sha256, /^[a-f0-9]{64}$/)
})

test('candidate rescore rejects acceptance evidence whose recorded hash changed', async () => {
  const context = await sourceRun({ corruptEvidence: true })

  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: context.sourceDir }),
    /acceptance evidence hash/i,
  )
})

test('candidate rescore rejects a source that did not complete the full workflow', async () => {
  const context = await sourceRun({ historyComplete: false })

  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: context.sourceDir }),
    /full implementation workflow/i,
  )
})

test('candidate rescore rejects a missing or malformed workflow change name', async () => {
  const missing = await sourceRun({ changeName: '' })
  const malformed = await sourceRun({ changeName: '../other-change' })

  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: missing.sourceDir }),
    /exactly one valid change_name/i,
  )
  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: malformed.sourceDir }),
    /exactly one valid change_name/i,
  )
})
