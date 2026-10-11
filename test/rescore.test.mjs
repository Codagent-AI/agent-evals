import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { hashJson, hashString } from '../evals/agent-runner/and-scene/lib/persistence.mjs'
import { loadCandidateRescoreSource, verifyRescoreDelivery } from '../evals/agent-runner/and-scene/lib/rescore.mjs'

const fixtureSha = '1'.repeat(40)
const finalSha = '2'.repeat(40)
const workflowHistory = [
  { step: 'run-validator', outcome: 'skipped' },
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
  const sourceDir = await makeTempDir(join(tmpdir(), 'and-scene-rescore-source-'))
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
      lead: { cli: 'claude', model: 'opus', effort: 'high', agent: 'lead' },
      implementor: { cli: 'claude', model: 'sonnet', effort: 'medium', agent: 'implementor' },
      tester: { cli: 'claude', model: 'opus', effort: 'high', agent: 'tester' },
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
  return { sourceDir, sessionDir, state, delivery, evidence }
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
  // The verified hashes behind that identity, recorded by a judge diagnostic.
  assert.equal(hashJson(imported.manifest_hashes), imported.provenance_sha256)
  assert.equal(imported.manifest_hashes.final_sha, finalSha)
  assert.equal(imported.manifest_hashes.acceptance.length, imported.delivery.acceptance.artifacts.length)
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

test('candidate rescore trusts the recorded Validator mode rather than verifying it from step outcomes', async () => {
  const context = await sourceRun()
  const deliveryPath = join(context.sourceDir, 'phases/delivery-verification.json')
  const resultPath = join(context.sourceDir, 'result.json')
  const runStatePath = join(context.sourceDir, 'run-state.json')
  const successfulValidator = { step: 'run-validator', outcome: 'success' }
  const replaceValidator = (history) => [successfulValidator, ...history.slice(1)]

  context.delivery.final_validator = successfulValidator
  context.delivery.workflow_history = replaceValidator(context.delivery.workflow_history)
  context.state.delivery.final_validator = successfulValidator
  context.state.delivery.acceptance.workflow_history = context.delivery.workflow_history
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  result.workflow.observed_steps = context.delivery.workflow_history
  result.delivery = context.state.delivery
  await writeFile(deliveryPath, `${JSON.stringify(context.delivery)}\n`)
  await writeFile(runStatePath, `${JSON.stringify(context.state)}\n`)
  await writeFile(resultPath, `${JSON.stringify(result)}\n`)

  const imported = await loadCandidateRescoreSource({ sourceDir: context.sourceDir })
  assert.equal(imported.source_run_id, context.state.run_id)
})

test('candidate rescore reads the retained Runner completion status when the source recorded one', async () => {
  for (const [completed, accepted] of [[true, true], [false, false]]) {
    const context = await sourceRun({ historyComplete: false })
    const resultPath = join(context.sourceDir, 'result.json')
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    result.workflow.run_completed = completed
    await writeFile(resultPath, `${JSON.stringify(result)}\n`)
    if (accepted) {
      await loadCandidateRescoreSource({ sourceDir: context.sourceDir })
    } else {
      await assert.rejects(
        () => loadCandidateRescoreSource({ sourceDir: context.sourceDir }),
        /full implementation workflow/i,
      )
    }
  }
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

// Factory runs keep the acceptance evidence under evidence/candidate/artifacts
// but drop .runtime/agent-runner-projects, where the recorded session lived.
async function retainEvidenceOnly(context, { corruptRetained = false, staleManifest = false, worktreeFile = null } = {}) {
  const artifacts = []
  if (worktreeFile) {
    const retained = 'evidence/candidate/artifacts/candidate-w-SKILL.md'
    await mkdir(join(context.sourceDir, 'evidence/candidate/artifacts'), { recursive: true })
    await writeFile(join(context.sourceDir, retained), worktreeFile.retained ?? worktreeFile.bytes)
    artifacts.push({ id: 'candidate-w', role: 'referenced-material',
      origin: { namespace: 'candidate-worktree', relative_path: 'skills/presentation/SKILL.md' },
      path: retained, sha256: hashString(worktreeFile.retained ?? worktreeFile.bytes) })
    context.delivery.acceptance_artifacts.push({ role: 'session-audit',
      path: '/artifacts/.runtime/candidate-worktree/skills/presentation/SKILL.md',
      sha256: hashString(worktreeFile.bytes) })
    await writeFile(join(context.sourceDir, 'phases/delivery-verification.json'), `${JSON.stringify(context.delivery)}\n`)
  }
  await mkdir(join(context.sourceDir, 'evidence/candidate/artifacts'), { recursive: true })
  for (const [role, relativePath, bytes] of context.evidence) {
    const retained = `evidence/candidate/artifacts/candidate-${artifacts.length}-${relativePath.split('/').at(-1)}`
    await writeFile(join(context.sourceDir, retained), corruptRetained && artifacts.length === 0 ? 'tampered' : bytes)
    artifacts.push({
      id: `candidate-${artifacts.length}`,
      role,
      origin: { namespace: 'runner-session', relative_path: `output/${relativePath}` },
      path: retained,
      sha256: hashString(bytes),
    })
  }
  const referenced = 'Referenced session report.\n'
  await writeFile(join(context.sourceDir, 'evidence/candidate/artifacts/candidate-x-session-report.md'), referenced)
  artifacts.push({
    id: 'candidate-x',
    role: 'session-audit',
    origin: { namespace: 'runner-session', relative_path: 'output/reports/session-report.md' },
    path: 'evidence/candidate/artifacts/candidate-x-session-report.md',
    sha256: hashString(referenced),
  })
  const manifest = { schema_version: 1, ownership: 'candidate-produced', artifacts }
  manifest.manifest_sha256 = hashJson(manifest)
  await writeFile(join(context.sourceDir, 'evidence/candidate/manifest.json'), `${JSON.stringify(manifest)}\n`)
  context.state.delivery.acceptance.manifest_sha256 = staleManifest ? '8'.repeat(64) : manifest.manifest_sha256
  await writeFile(join(context.sourceDir, 'run-state.json'), `${JSON.stringify(context.state)}\n`)
  await rm(context.sessionDir, { recursive: true, force: true })
}

test('a source whose runner session is gone is rescored from hash-matching retained evidence', async () => {
  const context = await sourceRun()
  await retainEvidenceOnly(context)
  const stagingDir = join(await makeTempDir(join(tmpdir(), 'and-scene-rescore-staging-')), 'session')

  const imported = await loadCandidateRescoreSource({ sourceDir: context.sourceDir, stagingDir })

  assert.equal(imported.runner.session_dir, stagingDir)
  assert.equal(imported.session_reconstruction.source, 'evidence/candidate/artifacts')
  assert.equal(imported.session_reconstruction.files, context.evidence.length + 1)
  for (const [, relativePath, bytes] of context.evidence) {
    assert.equal(await readFile(join(stagingDir, 'output', relativePath), 'utf8'), bytes)
  }
  assert.equal(await readFile(join(stagingDir, 'output/reports/session-report.md'), 'utf8'), 'Referenced session report.\n')
  assert.ok(imported.delivery.acceptance.artifacts.every(({ path }) => path.startsWith(stagingDir)))
  // Provenance names the evidence, not where its bytes were read from.
  const original = await loadCandidateRescoreSource({ sourceDir: (await sourceRun()).sourceDir })
  assert.equal(
    hashJson(imported.delivery.acceptance.artifacts.map(({ role, sha256 }) => ({ role, sha256 }))),
    hashJson(original.delivery.acceptance.artifacts.map(({ role, sha256 }) => ({ role, sha256 }))),
  )
})

test('retained evidence whose bytes do not match the recorded hash is refused', async () => {
  const context = await sourceRun()
  await retainEvidenceOnly(context, { corruptRetained: true })
  const stagingDir = join(await makeTempDir(join(tmpdir(), 'and-scene-rescore-staging-')), 'session')

  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: context.sourceDir, stagingDir }),
    /acceptance evidence hash/i,
  )
})

test('a retained evidence manifest that differs from the recorded manifest hash is refused', async () => {
  const context = await sourceRun()
  await retainEvidenceOnly(context, { staleManifest: true })
  const stagingDir = join(await makeTempDir(join(tmpdir(), 'and-scene-rescore-staging-')), 'session')

  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: context.sourceDir, stagingDir }),
    /manifest/i,
  )
})

test('a missing runner session without a staging directory is refused', async () => {
  const context = await sourceRun()
  await retainEvidenceOnly(context)

  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: context.sourceDir }),
    /staging/i,
  )
})

test('a referenced worktree file that was not retained in place is verified against its retained copy', async () => {
  const context = await sourceRun()
  await retainEvidenceOnly(context, { worktreeFile: { bytes: '# Skill\n' } })
  const stagingDir = join(await makeTempDir(join(tmpdir(), 'and-scene-rescore-staging-')), 'session')

  const imported = await loadCandidateRescoreSource({ sourceDir: context.sourceDir, stagingDir })

  const skill = imported.delivery.acceptance.artifacts.find(({ path }) => path.endsWith('SKILL.md'))
  assert.equal(skill.path, join(imported.source_dir, 'evidence/candidate/artifacts/candidate-w-SKILL.md'))
})

test('a referenced worktree file whose retained copy differs is refused', async () => {
  const context = await sourceRun()
  await retainEvidenceOnly(context, { worktreeFile: { bytes: '# Skill\n', retained: '# Other\n' } })
  const stagingDir = join(await makeTempDir(join(tmpdir(), 'and-scene-rescore-staging-')), 'session')

  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: context.sourceDir, stagingDir }),
    /missing and not retained/,
  )
})

// A source recorded before the crosscheck role, or before run-state kept its
// role profiles, still names the roles it ran with in its result.
test('a source without recorded run-state profiles imports the roles its result configured', async () => {
  const context = await sourceRun()
  const { role_profiles: profiles, ...state } = context.state
  await writeFile(join(context.sourceDir, 'run-state.json'), `${JSON.stringify(state)}\n`)
  const resultPath = join(context.sourceDir, 'result.json')
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  result.role_configuration = {
    applicable: true,
    roles: {
      lead: { configured: profiles.lead, attempts: [] },
      implementor: { configured: profiles.implementor, attempts: [] },
      reviewer: { configured: profiles.tester, attempts: [] },
    },
  }
  await writeFile(resultPath, `${JSON.stringify(result)}\n`)

  const imported = await loadCandidateRescoreSource({ sourceDir: context.sourceDir })

  assert.deepEqual(imported.role_profiles, profiles)
})

test('a source that recorded no role profiles anywhere is refused rather than given invented ones', async () => {
  const context = await sourceRun()
  const { role_profiles: _profiles, ...state } = context.state
  await writeFile(join(context.sourceDir, 'run-state.json'), `${JSON.stringify(state)}\n`)

  await assert.rejects(
    () => loadCandidateRescoreSource({ sourceDir: context.sourceDir }),
    /records no role profiles/i,
  )
})

test('an imported source carries its retained completion status, whichever form it was recorded in', async () => {
  const legacy = await sourceRun()
  assert.equal((await loadCandidateRescoreSource({ sourceDir: legacy.sourceDir })).run_completed, true)

  const recorded = await sourceRun({ historyComplete: false })
  const resultPath = join(recorded.sourceDir, 'result.json')
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  result.workflow.run_completed = true
  await writeFile(resultPath, `${JSON.stringify(result)}\n`)
  assert.equal((await loadCandidateRescoreSource({ sourceDir: recorded.sourceDir })).run_completed, true)
})

function observedDelivery(imported, overrides = {}) {
  return {
    verified: true,
    run_status: 'completed',
    branch: imported.delivery.branch,
    base_branch: imported.delivery.base_branch,
    fixture_commit: imported.candidate_source.fixture_commit,
    final_sha: imported.delivery.final_sha,
    remote_sha: imported.delivery.final_sha,
    pull_request: { ...imported.delivery.pull_request },
    publication_boundary: { verified: true, scope: 'final-state-only' },
    acceptance_artifacts: [{ role: 'final-handoff', path: '/rediscovered/acceptance-handoff.md', sha256: 'c'.repeat(64) }],
    ...overrides,
  }
}

test('rescore delivery runs the outcome checks against the retained completion status and session', async () => {
  const context = await sourceRun()
  const imported = await loadCandidateRescoreSource({ sourceDir: context.sourceDir })
  let received = null

  const delivery = await verifyRescoreDelivery({
    imported,
    worktree: '/candidate',
    exec: () => ({ status: 0 }),
    verify: async (options) => {
      received = options
      return observedDelivery(imported)
    },
  })

  assert.equal(received.runCompleted, true)
  assert.equal(received.sessionDir, imported.runner.session_dir)
  assert.equal(received.fixtureCommit, fixtureSha)
  assert.equal(received.branch, imported.delivery.branch)
  assert.equal(received.expectedBase, 'main')
  assert.equal(received.changeName, 'create-and-scene')
  assert.equal(received.worktree, '/candidate')
  // The hash-verified recorded evidence is kept, never the rediscovered paths.
  assert.deepEqual(delivery.acceptance_artifacts, imported.delivery.acceptance_artifacts)
  assert.equal(delivery.run_status, 'completed')
  assert.deepEqual(delivery.publication_boundary, { verified: true, scope: 'final-state-only' })
})

test('rescore delivery refuses an outcome that no longer matches the recorded delivery identity', async () => {
  const context = await sourceRun()
  const imported = await loadCandidateRescoreSource({ sourceDir: context.sourceDir })

  await assert.rejects(
    () => verifyRescoreDelivery({
      imported,
      worktree: '/candidate',
      verify: async () => observedDelivery(imported, {
        pull_request: { ...imported.delivery.pull_request, number: 10 },
      }),
    }),
    /pull request number/,
  )
  await assert.rejects(
    () => verifyRescoreDelivery({
      imported,
      worktree: '/candidate',
      verify: async () => observedDelivery(imported, { final_sha: '3'.repeat(40) }),
    }),
    /final_sha/,
  )
})

// A real candidate repository on disk, so the rescore runs the real outcome
// checks; only the remote branch lookup and the GitHub CLI are answered here.
async function liveRescoreCandidate() {
  const root = await makeTempDir(join(tmpdir(), 'and-scene-rescore-live-'))
  const worktree = join(root, 'candidate')
  const sessionDir = join(root, 'session')
  const branch = 'eval/and-scene/run-123'
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', ...args], { cwd: worktree, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  await mkdir(join(worktree, 'openspec/changes/create-and-scene'), { recursive: true })
  await writeFile(join(worktree, 'openspec/changes/create-and-scene/proposal.md'), '# Proposal\n')
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const fixture = git('rev-parse', 'HEAD')
  git('checkout', '-qb', branch)
  await writeFile(join(worktree, 'demo.js'), 'export const demo = true\n')
  git('add', '.')
  git('commit', '-qm', 'implementation')
  const head = git('rev-parse', 'HEAD')
  await mkdir(join(sessionDir, 'output'), { recursive: true })
  await writeFile(join(sessionDir, 'output', 'acceptance-handoff.md'), '# Handoff\n')

  const pullRequest = {
    number: 53,
    url: 'https://github.com/Codagent-AI/and-scene/pull/53',
    state: 'OPEN',
    draft: true,
    base: 'main',
    head_branch: branch,
    head_sha: head,
  }
  const imported = {
    change_name: 'create-and-scene',
    run_completed: true,
    runner: { session_dir: sessionDir },
    candidate_source: { fixture_commit: fixture, branch, base_branch: 'main' },
    delivery: {
      verified: true,
      branch,
      final_sha: head,
      pull_request: pullRequest,
      acceptance_artifacts: [{ role: 'final-handoff', path: '/artifacts/handoff.md', sha256: 'a'.repeat(64) }],
    },
  }
  const verify = ({ remote = `${head}\trefs/heads/${branch}\n`, pull = {} } = {}) => verifyRescoreDelivery({
    imported,
    worktree,
    exec: (command, args, options) => {
      if (command === 'git' && args.includes('ls-remote')) return { status: 0, stdout: remote }
      if (command === 'gh') {
        const live = { ...pullRequest, ...pull }
        return {
          status: 0,
          stdout: JSON.stringify([{
            number: live.number,
            url: live.url,
            state: live.state,
            isDraft: live.draft,
            baseRefName: live.base,
            headRefName: live.head_branch,
            headRefOid: live.head_sha,
          }]),
        }
      }
      return spawnSync(command, args, { encoding: 'utf8', ...options })
    },
  })
  return { imported, head, verify }
}

test('a rescore whose live branch and pull request still match the record verifies through the real checks', async () => {
  const context = await liveRescoreCandidate()
  const delivery = await context.verify()
  assert.equal(delivery.verified, true)
  assert.equal(delivery.final_sha, context.head)
  assert.equal(delivery.remote_sha, context.head)
  assert.equal(delivery.publication_boundary.verified, true)
  assert.deepEqual(delivery.acceptance_artifacts, context.imported.delivery.acceptance_artifacts)
})

async function rescoreRejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected rescore delivery verification to reject')
}

test('a candidate branch deleted after the source run makes the rescore source unavailable, not a workflow violation', async () => {
  const context = await liveRescoreCandidate()
  const error = await rescoreRejection(context.verify({ remote: '' }))
  assert.equal(error.code, 'rescore-source-unavailable')
  assert.equal(error.owner, 'evaluation-harness')
  assert.equal(error.unexpected_action, undefined)
  assert.equal(error.post_run_change, 'delete-candidate-branch')
  assert.match(error.message, /no longer matches the retained record/)
  assert.doesNotMatch(error.message, /workflow-side-effect-violation/)
  assert.equal(error.cause.code, 'workflow-side-effect-violation')
})

test('a pull request closed, merged, or marked ready after the source run makes the rescore source unavailable', async () => {
  const context = await liveRescoreCandidate()
  for (const [pull, change] of [
    [{ state: 'CLOSED' }, 'close-pull-request'],
    [{ state: 'MERGED', draft: false }, 'merge-pull-request'],
    [{ draft: false }, 'mark-ready-for-review'],
  ]) {
    const error = await rescoreRejection(context.verify({ pull }))
    assert.equal(error.code, 'rescore-source-unavailable')
    assert.equal(error.owner, 'evaluation-harness')
    assert.equal(error.post_run_change, change)
    assert.match(error.message, /no longer matches the retained record/)
  }
})

test('a rescore still fails a genuine delivery identity mismatch as before', async () => {
  const context = await liveRescoreCandidate()
  const error = await rescoreRejection(context.verify({ pull: { head_sha: 'f'.repeat(40) } }))
  assert.equal(error.code, 'pull-request-identity-mismatch')
  assert.equal(error.owner, 'implementation-workflow')
})
