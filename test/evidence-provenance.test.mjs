import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  EVIDENCE_ROLE_REGISTRY,
  EvidenceReadinessError,
  buildCandidateEvidenceManifest,
  buildEvaluatorEvidenceManifest,
  detectEvidenceContradictions,
  recordEvidenceContradictions,
  materializeEvidenceJudgeViews,
  validateCandidateEvidenceLineage,
  validateEvidenceLineage,
} from '../evals/agent-runner/and-scene/lib/evidence.mjs'

const FINAL_SHA = 'f'.repeat(40)
const BASELINE_SHA = 'b'.repeat(40)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'and-scene-evidence-'))
  const worktree = join(root, 'candidate')
  const sessionDir = join(root, 'session')
  const runDir = join(root, 'run')
  await mkdir(worktree, { recursive: true })
  await mkdir(join(sessionDir, 'output', 'captures'), { recursive: true })
  return { root, worktree, sessionDir, runDir }
}

async function writeRequiredArtifacts(context, overrides = {}) {
  const files = {
    'final-acceptance-handoff.md': [
      '# Final handoff',
      `Final revision: ${FINAL_SHA}`,
      '- [flow](acceptance-test-results.md)',
      '- [captures](capture-metadata.json)',
      '- [findings](retest-history.md)',
      '- [assumptions](assumptions-ledger.md)',
      '- [screen](captures/final.png)',
    ].join('\n'),
    'acceptance-test-results.md': `Full flow: passed\nRevision: ${FINAL_SHA}\nCoverage: demo-flow\n`,
    'capture-metadata.json': JSON.stringify({
      revision: FINAL_SHA,
      captures: [{ path: 'captures/final.png', flow: 'demo-flow', state: 'final' }],
    }),
    'retest-history.md': `No open findings\nRevision: ${FINAL_SHA}\n`,
    'assumptions-ledger.md': `No unresolved assumptions\nRevision: ${FINAL_SHA}\n`,
    'captures/final.png': Buffer.from([0, 1, 2, 3, 255]),
    ...overrides,
  }
  for (const [relative, content] of Object.entries(files)) {
    const path = join(context.sessionDir, 'output', relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
}

test('the suite documents aliases for every required candidate evidence role', () => {
  const required = EVIDENCE_ROLE_REGISTRY.filter(({ required }) => required)
  assert.deepEqual(required.map(({ role }) => role), [
    'acceptance-flow-record',
    'screenshot',
    'screenshot-metadata',
    'findings-history',
    'final-handoff',
    'assumptions-ledger',
  ])
  assert.ok(required.every(({ aliases }) => aliases.length > 0))
})

test('candidate evidence is discovered from handoff aliases and copied byte-for-byte', async () => {
  const context = await fixture()
  await writeRequiredArtifacts(context)

  const manifest = await buildCandidateEvidenceManifest({
    worktree: context.worktree,
    sessionDir: context.sessionDir,
    runDir: context.runDir,
    delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
  })

  assert.equal(manifest.ownership, 'candidate-produced')
  assert.equal(manifest.delivery.final_sha, FINAL_SHA)
  assert.deepEqual(
    new Set(manifest.artifacts.map(({ role }) => role)),
    new Set(EVIDENCE_ROLE_REGISTRY.filter(({ required }) => required).map(({ role }) => role)),
  )
  const screenshot = manifest.artifacts.find(({ role }) => role === 'screenshot')
  assert.deepEqual(
    await readFile(join(context.runDir, screenshot.path)),
    Buffer.from([0, 1, 2, 3, 255]),
  )
  assert.equal(screenshot.bytes, 5)
  assert.match(screenshot.sha256, /^[a-f0-9]{64}$/)
  assert.equal(screenshot.ownership, 'candidate-produced')
  assert.ok(manifest.artifacts.every(({ id }) => /^candidate-[a-f0-9]{16}$/.test(id)))
  assert.deepEqual(
    manifest.artifacts.find(({ role }) => role === 'acceptance-flow-record').lineage_claims,
    [{
      kind: 'full-flow',
      revision: FINAL_SHA,
      trustworthy: true,
      bounded_impact: false,
      affected_flows: [],
      dependent_flows: [],
      covered_flows: ['demo-flow'],
      intervening_changes: [],
      tracked_product_changed: null,
    }],
  )
})

test('the current acceptance workflow markdown is accepted as screenshot metadata evidence', async () => {
  const context = await fixture()
  await writeRequiredArtifacts(context, {
    'capture-metadata.json': '',
    'acceptance-test.md': [
      '# Acceptance test',
      `Head SHA: ${FINAL_SHA}`,
      'Coverage: demo-flow',
      '- Screenshot: [final state](captures/final.png)',
      '- Expected: the final state is visible',
      '- Observed: the final state is visible',
    ].join('\n'),
  })

  const manifest = await buildCandidateEvidenceManifest({
    worktree: context.worktree,
    sessionDir: context.sessionDir,
    runDir: context.runDir,
    delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
  })

  const metadata = manifest.artifacts.find(({ role }) => role === 'screenshot-metadata')
  assert.equal(metadata.origin.relative_path, 'output/acceptance-test.md')
  assert.equal(metadata.verification_state, 'verified')
  assert.ok(!manifest.findings.some(({ code }) => code === 'malformed-metadata'))
})

test('candidate references cannot traverse outside the worktree or recorded session', async () => {
  const context = await fixture()
  await writeFile(join(context.root, 'secret.md'), 'must not be copied')
  await writeRequiredArtifacts(context, {
    'final-acceptance-handoff.md': '# Final handoff\n[steal](../../secret.md)\n',
  })

  const manifest = await buildCandidateEvidenceManifest({
    worktree: context.worktree,
    sessionDir: context.sessionDir,
    runDir: context.runDir,
    delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
  })

  assert.ok(manifest.findings.some(({ code }) => code === 'unsafe-reference'))
  assert.ok(!manifest.artifacts.some(({ origin }) => origin.relative_path.includes('secret.md')))
})

test('missing structural roles produce a typed implementation-workflow failure', async () => {
  const context = await fixture()
  await writeRequiredArtifacts(context)
  await writeFile(join(context.sessionDir, 'output', 'capture-metadata.json'), '')

  await assert.rejects(
    buildCandidateEvidenceManifest({
      worktree: context.worktree,
      sessionDir: context.sessionDir,
      runDir: context.runDir,
      delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
    }),
    (error) => {
      assert.ok(error instanceof EvidenceReadinessError)
      assert.equal(error.owner, 'implementation-workflow')
      assert.equal(error.code, 'missing-evidence-role')
      assert.ok(error.missing_roles.includes('screenshot-metadata'))
      return true
    },
  )
})

test('an oversized required artifact remains a structural readiness failure', async () => {
  const context = await fixture()
  await writeRequiredArtifacts(context, {
    'acceptance-test-results.md': Buffer.alloc((16 * 1024 * 1024) + 1, 0x61),
  })

  await assert.rejects(
    buildCandidateEvidenceManifest({
      worktree: context.worktree,
      sessionDir: context.sessionDir,
      runDir: context.runDir,
      delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
    }),
    (error) => {
      assert.ok(error instanceof EvidenceReadinessError)
      assert.ok(error.missing_roles.includes('acceptance-flow-record'))
      return true
    },
  )
})

test('evidence discovery preserves non-ENOENT directory failures as harness errors', async () => {
  const context = await fixture()
  const output = join(context.sessionDir, 'output')
  await rm(output, { recursive: true })
  await writeFile(output, 'not a directory')

  await assert.rejects(
    buildCandidateEvidenceManifest({
      worktree: context.worktree,
      sessionDir: context.sessionDir,
      runDir: context.runDir,
      delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
    }),
    (error) => {
      assert.ok(!(error instanceof EvidenceReadinessError))
      assert.match(error.message, /failed to read evidence directory/)
      assert.equal(error.cause?.code, 'ENOTDIR')
      return true
    },
  )
})

test('present but stale or malformed candidate evidence remains judgeable with findings', async () => {
  const context = await fixture()
  await writeRequiredArtifacts(context, {
    'acceptance-test-results.md': 'Full flow: passed\nRevision: not-a-sha\n',
    'capture-metadata.json': '{"revision":',
  })

  const manifest = await buildCandidateEvidenceManifest({
    worktree: context.worktree,
    sessionDir: context.sessionDir,
    runDir: context.runDir,
    delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
  })

  assert.equal(manifest.readiness, 'ready')
  assert.ok(manifest.findings.some(({ code }) => code === 'malformed-metadata'))
  assert.ok(manifest.artifacts.some(({ verification_state }) => verification_state !== 'verified'))
})

test('candidate CI claims remain verbatim and revision-scoped without external validation', async () => {
  const context = await fixture()
  await writeRequiredArtifacts(context, {
    'acceptance-test-results.md': [
      'Full flow: passed',
      `Revision: ${FINAL_SHA}`,
      `CI pending for revision: ${FINAL_SHA}`,
    ].join('\n'),
  })

  const manifest = await buildCandidateEvidenceManifest({
    worktree: context.worktree,
    sessionDir: context.sessionDir,
    runDir: context.runDir,
    delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
  })

  assert.deepEqual(manifest.ci_claims.map(({ verbatim, claimed_revision }) => ({
    verbatim, claimed_revision,
  })), [{
    verbatim: `CI pending for revision: ${FINAL_SHA}`,
    claimed_revision: FINAL_SHA,
  }])
})

test('lineage accepts final full flow and bounded ancestor targeted verification', () => {
  const finalFlow = validateEvidenceLineage({
    finalSha: FINAL_SHA,
    revisions: [{ sha: FINAL_SHA, ancestor_of_final: true }],
    evidence: [{ id: 'flow', kind: 'full-flow', revision: FINAL_SHA, trustworthy: true }],
  })
  assert.equal(finalFlow.accepted, true)
  assert.equal(finalFlow.mode, 'final-full-flow')

  const targeted = validateEvidenceLineage({
    finalSha: FINAL_SHA,
    revisions: [
      { sha: BASELINE_SHA, ancestor_of_final: true },
      { sha: FINAL_SHA, ancestor_of_final: true },
    ],
    evidence: [
      { id: 'baseline', kind: 'full-flow', revision: BASELINE_SHA, trustworthy: true },
      {
        id: 'retest',
        kind: 'targeted',
        revision: FINAL_SHA,
        bounded_impact: true,
        affected_flows: ['editing'],
        dependent_flows: ['presentation'],
        covered_flows: ['editing', 'presentation'],
        intervening_changes: ['src/editor.ts'],
      },
    ],
  })
  assert.equal(targeted.accepted, true)
  assert.equal(targeted.mode, 'ancestor-plus-targeted')
})

test('lineage allows evidence-only alignment only without tracked product changes', () => {
  const accepted = validateEvidenceLineage({
    finalSha: FINAL_SHA,
    revisions: [{ sha: BASELINE_SHA, ancestor_of_final: true }, { sha: FINAL_SHA, ancestor_of_final: true }],
    evidence: [
      { id: 'baseline', kind: 'full-flow', revision: BASELINE_SHA, trustworthy: true },
      { id: 'alignment', kind: 'external-alignment', revision: FINAL_SHA, tracked_product_changed: false },
    ],
  })
  assert.equal(accepted.mode, 'evidence-only-alignment')
  assert.equal(accepted.accepted, true)

  const rejected = validateEvidenceLineage({
    finalSha: FINAL_SHA,
    revisions: [{ sha: BASELINE_SHA, ancestor_of_final: true }, { sha: FINAL_SHA, ancestor_of_final: true }],
    evidence: [
      { id: 'baseline', kind: 'full-flow', revision: BASELINE_SHA, trustworthy: true },
      { id: 'alignment', kind: 'external-alignment', revision: FINAL_SHA, tracked_product_changed: true },
    ],
  })
  assert.equal(rejected.accepted, false)
  assert.ok(rejected.findings.some(({ code }) => code === 'new-final-full-flow-required'))
})

test('manifest lineage verifies revision ancestry without treating broad retests as bounded', async () => {
  const commands = []
  const lineage = await validateCandidateEvidenceLineage({
    finalSha: FINAL_SHA,
    worktree: '/candidate',
    manifest: {
      artifacts: [{
        id: 'baseline',
        lineage_claims: [{
          kind: 'full-flow',
          revision: BASELINE_SHA,
          trustworthy: true,
        }],
      }, {
        id: 'retest',
        lineage_claims: [{
          kind: 'targeted',
          revision: FINAL_SHA,
          bounded_impact: true,
          affected_flows: ['editing'],
          dependent_flows: ['presentation'],
          covered_flows: ['editing', 'presentation'],
          intervening_changes: ['src/editor.ts'],
        }],
      }],
    },
    exec: (command, args) => {
      commands.push([command, ...args])
      if (args.includes('diff')) {
        return { status: 0, stdout: 'src/editor.ts\u0000' }
      }
      return { status: 0, stdout: '' }
    },
  })

  assert.equal(lineage.accepted, true)
  assert.equal(lineage.mode, 'ancestor-plus-targeted')
  assert.ok(commands.some(([, ...args]) => args.includes('merge-base')))

  const broad = await validateCandidateEvidenceLineage({
    finalSha: FINAL_SHA,
    worktree: '/candidate',
    manifest: {
      artifacts: [{
        id: 'baseline',
        lineage_claims: [{ kind: 'full-flow', revision: BASELINE_SHA, trustworthy: true }],
      }, {
        id: 'retest',
        lineage_claims: [{
          kind: 'targeted',
          revision: FINAL_SHA,
          bounded_impact: false,
          covered_flows: ['editing'],
        }],
      }],
    },
    exec: () => ({ status: 0, stdout: '' }),
  })
  assert.equal(broad.accepted, false)
})

test('manifest lineage independently rejects evidence-only alignment after product changes', async () => {
  const lineage = await validateCandidateEvidenceLineage({
    finalSha: FINAL_SHA,
    worktree: '/candidate',
    manifest: {
      artifacts: [{
        id: 'baseline',
        lineage_claims: [{ kind: 'full-flow', revision: BASELINE_SHA, trustworthy: true }],
      }, {
        id: 'alignment',
        lineage_claims: [{
          kind: 'external-alignment',
          revision: FINAL_SHA,
          tracked_product_changed: false,
        }],
      }],
    },
    exec: (command, args) => args.includes('diff')
      ? { status: 0, stdout: 'src/product.ts\u0000' }
      : { status: 0, stdout: '' },
  })

  assert.equal(lineage.accepted, false)
  assert.ok(lineage.findings.some(({ code }) => code === 'new-final-full-flow-required'))
})

test('lineage treats product source under evidence-named directories as product changes', async () => {
  const lineage = await validateCandidateEvidenceLineage({
    finalSha: FINAL_SHA,
    worktree: '/candidate',
    manifest: {
      artifacts: [{
        id: 'baseline',
        lineage_claims: [{ kind: 'full-flow', revision: BASELINE_SHA, trustworthy: true }],
      }, {
        id: 'alignment',
        lineage_claims: [{
          kind: 'external-alignment',
          revision: FINAL_SHA,
          tracked_product_changed: false,
        }],
      }],
    },
    exec: (command, args) => args.includes('diff')
      ? { status: 0, stdout: 'src/evidence/parser.ts\u0000src/delivery/queue.ts\u0000' }
      : { status: 0, stdout: '' },
  })

  assert.equal(lineage.accepted, false)
  assert.deepEqual(
    lineage.evidence.find(({ id }) => id === 'alignment').observed_product_changes,
    ['src/evidence/parser.ts', 'src/delivery/queue.ts'],
  )
})

test('evaluator evidence and contradictions retain separate ownership', async () => {
  const context = await fixture()
  const evaluator = await buildEvaluatorEvidenceManifest({
    runDir: context.runDir,
    finalSha: FINAL_SHA,
    artifacts: [{
      id: 'route-probe',
      kind: 'deterministic-probe',
      content: JSON.stringify({ pass: false }),
      media_type: 'application/json',
      coverage: ['demo-route'],
    }],
  })
  const candidate = {
    ownership: 'candidate-produced',
    artifacts: [{ id: 'candidate-flow', ownership: 'candidate-produced', sha256: 'a'.repeat(64) }],
  }

  const contradictions = await recordEvidenceContradictions({
    runDir: context.runDir,
    candidate,
    evaluator,
    contradictions: [{
      candidate_id: 'candidate-flow',
      evaluator_id: 'route-probe',
      claim: 'the route is reachable',
      consequence: 'demo-route is disproved',
      coverage: ['demo-route'],
    }],
  })

  assert.equal(evaluator.ownership, 'evaluator-produced')
  assert.equal(evaluator.artifacts[0].ownership, 'evaluator-produced')
  assert.equal(evaluator.candidate_credit, 'prohibited')
  assert.equal(contradictions.items[0].candidate.ownership, 'candidate-produced')
  assert.equal(contradictions.items[0].evaluator.ownership, 'evaluator-produced')
  assert.equal(contradictions.items[0].scoring_effect, 'disproof-only')
})

test('verified evaluator failures deterministically contradict matching candidate pass claims', () => {
  const contradictions = detectEvidenceContradictions({
    candidate: {
      artifacts: [{
        id: 'candidate-flow',
        claims: [{
          id: 'demo-route',
          verdict: 'pass',
          claim: 'the demo route is reachable',
        }],
      }],
    },
    evaluator: {
      artifacts: [{
        id: 'route-probe',
        verification_state: 'verified',
        claims: [{
          id: 'demo-route',
          verdict: 'fail',
          note: 'route returned 404',
        }],
      }],
    },
  })

  assert.deepEqual(contradictions, [{
    candidate_id: 'candidate-flow',
    evaluator_id: 'route-probe',
    claim: 'the demo route is reachable',
    consequence: 'route returned 404',
    coverage: ['demo-route'],
  }])
})

test('testing and assumption judges receive bounded, distinct evidence views', async () => {
  const context = await fixture()
  await writeRequiredArtifacts(context)
  const candidate = await buildCandidateEvidenceManifest({
    worktree: context.worktree,
    sessionDir: context.sessionDir,
    runDir: context.runDir,
    delivery: { final_sha: FINAL_SHA, pull_request: { head_sha: FINAL_SHA } },
  })
  const evaluator = await buildEvaluatorEvidenceManifest({
    runDir: context.runDir,
    finalSha: FINAL_SHA,
    artifacts: [{
      id: 'probe',
      kind: 'deterministic-probe',
      content: 'failed',
      coverage: ['demo-route'],
    }],
  })
  const contradictions = await recordEvidenceContradictions({
    runDir: context.runDir,
    candidate,
    evaluator,
    contradictions: [],
  })

  const views = await materializeEvidenceJudgeViews({
    runDir: context.runDir,
    candidate,
    evaluator,
    contradictions,
    lineage: { final_sha: FINAL_SHA, accepted: true },
  })

  assert.deepEqual(views['testing-evidence'].permissions, {
    candidate_evidence: true,
    evaluator_evidence: 'contradictions-only',
    revision_provenance: true,
  })
  assert.deepEqual(views['assumption-handling'].roles, [
    'assumptions-ledger', 'final-handoff', 'findings-history', 'session-audit',
  ])
  const testingIndex = JSON.parse(await readFile(
    join(context.runDir, views['testing-evidence'].index),
    'utf8',
  ))
  assert.ok(testingIndex.candidate.artifacts.length >= 6)
  assert.equal(testingIndex.evaluator, undefined)
  assert.deepEqual(testingIndex.contradictions, [])
  const assumptionIndex = JSON.parse(await readFile(
    join(context.runDir, views['assumption-handling'].index),
    'utf8',
  ))
  assert.ok(assumptionIndex.candidate.artifacts.every(({ role }) => (
    views['assumption-handling'].roles.includes(role)
  )))
})
