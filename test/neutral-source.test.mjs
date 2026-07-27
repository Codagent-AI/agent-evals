import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  JUDGE_INPUT_POLICIES,
  materializeNeutralInputs,
} from '../evals/agent-runner/and-scene/lib/neutral-source.mjs'

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

async function repository({ extraFiles = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'and-scene-neutral-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'eval@example.test')
  git(root, 'config', 'user.name', 'Eval Test')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'openspec/changes/create-and-scene/specs/demo'), { recursive: true })
  await mkdir(join(root, '.agent-runner'), { recursive: true })
  await writeFile(
    join(root, 'src/index.ts'),
    'export const branch = "eval/and-scene/run-77"\n'
      + 'export const pr = "https://github.com/acme/example/pull/53"\n'
      + 'export const ordinary = "candidate experience"\n',
  )
  await writeFile(join(root, 'src/run-77-notes.ts'), 'export const note = true\n')
  await writeFile(join(root, '.agent-runner/config.yaml'), 'secret evaluator config')
  await writeFile(
    join(root, 'openspec/changes/create-and-scene/specs/demo/spec.md'),
    '## Requirement: Demo\nThe demo SHALL work.\n\n'
      + '#### Scenario: Works\n- **WHEN** it runs\n- **THEN** it works\n',
  )
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    await mkdir(join(root, relativePath, '..'), { recursive: true })
    await writeFile(join(root, relativePath), content)
  }
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'fixture')
  return { root, sha: git(root, 'rev-parse', 'HEAD') }
}

async function filesBelow(root) {
  const output = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else output.push(path.slice(root.length + 1))
    }
  }
  await walk(root)
  return output.sort()
}

test('neutral source preserves committed source bytes while neutralizing path metadata', async () => {
  const repo = await repository()
  const runDir = join(repo.root, '.run-output')
  const neutral = await materializeNeutralInputs({
    worktree: repo.root,
    runDir,
    finalSha: repo.sha,
    changeName: 'create-and-scene',
    identities: {
      run: ['run-77'],
      branch: ['eval/and-scene/run-77'],
      pull_request: ['https://github.com/acme/example/pull/53', '53'],
      change: ['create-and-scene'],
      candidate: ['candidate-identity-77'],
      baseline: ['baseline-12'],
      evaluation: ['and-scene'],
    },
  })

  const sourceFiles = await filesBelow(join(runDir, neutral.source.root))
  assert.deepEqual(sourceFiles, ['src/__RUN_ID__-notes.ts', 'src/index.ts'])
  const text = await readFile(join(runDir, neutral.source.root, 'src/index.ts'), 'utf8')
  assert.equal(
    text,
    'export const branch = "eval/and-scene/run-77"\n'
      + 'export const pr = "https://github.com/acme/example/pull/53"\n'
      + 'export const ordinary = "candidate experience"\n',
  )
  assert.ok(neutral.manifest.entries.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)))
  assert.ok(neutral.manifest.entries
    .filter(({ namespace }) => namespace === 'neutral-source')
    .every(({ original_sha256, sha256 }) => original_sha256 === sha256))
  assert.ok(neutral.manifest.entries.some(({ transformations }) => (
    transformations.some(({ type }) => type === 'exact-identity-path-token-replacement')
  )))
  assert.ok(!neutral.manifest_path.startsWith(neutral.judge.root))
})

test('neutral source retains legitimate product paths named like evidence concepts', async () => {
  const repo = await repository({
    extraFiles: {
      'src/evidence/reader.ts': 'export const evidence = true\n',
      'src/benchmark/score.ts': 'export const benchmark = true\n',
      'src/acceptance/check.ts': 'export const acceptance = true\n',
      'src/delivery/queue.ts': 'export const delivery = true\n',
      'src/eval/runtime.ts': 'export const runtime = true\n',
      'src/run-state/store.ts': 'export const state = true\n',
    },
  })
  const runDir = join(repo.root, '.run-output')

  const neutral = await materializeNeutralInputs({
    worktree: repo.root,
    runDir,
    finalSha: repo.sha,
    changeName: 'create-and-scene',
  })

  const sourceFiles = await filesBelow(join(runDir, neutral.source.root))
  for (const path of [
    'src/evidence/reader.ts',
    'src/benchmark/score.ts',
    'src/acceptance/check.ts',
    'src/delivery/queue.ts',
    'src/eval/runtime.ts',
    'src/run-state/store.ts',
  ]) {
    assert.ok(sourceFiles.includes(path), `${path} should remain in the product snapshot`)
  }
})

test('neutral source copies non-UTF-8 blobs byte-for-byte', async () => {
  const invalidUtf8 = Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0xc3, 0x28, 0x0a])
  const repo = await repository({
    extraFiles: { 'src/non-utf8.ts': invalidUtf8 },
  })
  const runDir = join(repo.root, '.run-output')

  const neutral = await materializeNeutralInputs({
    worktree: repo.root,
    runDir,
    finalSha: repo.sha,
    changeName: 'create-and-scene',
    identities: { run: ['export'] },
  })

  assert.deepEqual(
    await readFile(join(runDir, neutral.source.root, 'src/non-utf8.ts')),
    invalidUtf8,
  )
})

test('neutral requirements preserve normative text in identity-free paths', async () => {
  const repo = await repository()
  const runDir = join(repo.root, '.run-output')
  const neutral = await materializeNeutralInputs({
    worktree: repo.root,
    runDir,
    finalSha: repo.sha,
    changeName: 'create-and-scene',
    identities: { change: ['create-and-scene'] },
  })

  const requirementFiles = await filesBelow(join(runDir, neutral.requirements.root))
  assert.deepEqual(requirementFiles, ['requirement-001.md'])
  const text = await readFile(
    join(runDir, neutral.requirements.root, 'requirement-001.md'),
    'utf8',
  )
  assert.equal(
    text,
    '## Requirement: Demo\nThe demo SHALL work.\n\n'
      + '#### Scenario: Works\n- **WHEN** it runs\n- **THEN** it works\n',
  )
  assert.ok(!requirementFiles.join('/').includes('create-and-scene'))
})

test('judge input policies expose only the source and provenance each rubric permits', () => {
  for (const job of [
    'demo-integration', 'scene-kit', 'presentation-skill', 'verification-tooling',
  ]) {
    assert.deepEqual(JUDGE_INPUT_POLICIES[job], {
      neutral_source: true,
      neutral_requirements: true,
      deterministic_facts: true,
      candidate_evidence: false,
      evaluator_evidence: false,
      revision_provenance: false,
      ambiguity_sources: false,
    })
  }
  assert.deepEqual(JUDGE_INPUT_POLICIES['testing-evidence'], {
    neutral_source: false,
    neutral_requirements: false,
    deterministic_facts: false,
    candidate_evidence: true,
    evaluator_evidence: 'contradictions-only',
    revision_provenance: true,
    ambiguity_sources: false,
  })
  assert.deepEqual(JUDGE_INPUT_POLICIES['assumption-handling'], {
    neutral_source: false,
    neutral_requirements: true,
    deterministic_facts: 'consequences-only',
    candidate_evidence: 'assumption-sources-only',
    evaluator_evidence: false,
    revision_provenance: true,
    ambiguity_sources: true,
  })
})
