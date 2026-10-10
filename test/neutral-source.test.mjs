import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { materializeEvidenceJudgeViews } from '../evals/agent-runner/and-scene/lib/evidence.mjs'
import {
  JUDGE_INPUT_POLICIES,
  materializeNeutralInputs,
} from '../evals/agent-runner/and-scene/lib/neutral-source.mjs'

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

async function repository({ extraFiles = {} } = {}) {
  const root = await makeTempDir(join(tmpdir(), 'and-scene-neutral-'))
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

test('neutral source removes exact identity signals from paths and textual source', async () => {
  const repo = await repository()
  const runDir = join(repo.root, '.run-output')
  const neutral = await materializeNeutralInputs({
    worktree: repo.root,
    runDir,
    finalSha: repo.sha,
    fixtureCommit: repo.sha,
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
    'export const branch = "__BRANCH_ID__"\n'
      + 'export const pr = "__PULL_REQUEST_ID__"\n'
      + 'export const ordinary = "candidate experience"\n',
  )
  assert.ok(neutral.manifest.entries.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)))
  assert.ok(neutral.manifest.entries
    .filter(({ namespace }) => namespace === 'neutral-source')
    .some(({ original_sha256, sha256 }) => original_sha256 !== sha256))
  assert.ok(neutral.manifest.entries.some(({ transformations }) => (
    transformations.some(({ type }) => type === 'exact-identity-path-token-replacement')
  )))
  assert.ok(neutral.manifest.entries.some(({ transformations }) => (
    transformations.some(({ type }) => type === 'exact-identity-content-token-replacement')
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
    fixtureCommit: repo.sha,
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
    fixtureCommit: repo.sha,
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
    fixtureCommit: repo.sha,
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
    'demo-integration', 'scene-kit', 'presentation-skill', 'verification-tooling', 'engineering-quality',
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
    neutral_requirements: 'inventory-only',
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

const FIXTURE_SPEC = '## ADDED Requirements\n\n'
  + '### Requirement: Demo\nThe demo SHALL advance on every Right key press.\n\n'
  + '#### Scenario: Right advances\n- **WHEN** the user presses Right\n- **THEN** the next step shows\n\n'
  + '#### Scenario: Left goes back\n- **WHEN** the user presses Left\n- **THEN** the previous step shows\n'
const SPEC_PATH = 'openspec/changes/create-and-scene/specs/demo/spec.md'

// The fixture commit carries the approved definition; the candidate's branch
// then changes product source and edits that definition.
async function candidateBranch({ spec, extraSpecs = {} }) {
  const repo = await repository({ extraFiles: { [SPEC_PATH]: FIXTURE_SPEC } })
  await writeFile(join(repo.root, 'src/index.ts'), 'export const implemented = true\n')
  if (spec !== undefined) await writeFile(join(repo.root, SPEC_PATH), spec)
  for (const [relativePath, content] of Object.entries(extraSpecs)) {
    await mkdir(join(repo.root, relativePath, '..'), { recursive: true })
    await writeFile(join(repo.root, relativePath), content)
  }
  git(repo.root, 'add', '.')
  git(repo.root, 'commit', '-qm', 'candidate')
  return { root: repo.root, fixtureSha: repo.sha, finalSha: git(repo.root, 'rev-parse', 'HEAD') }
}

async function pinnedInputs(branch) {
  const runDir = join(branch.root, '.run-output')
  const neutral = await materializeNeutralInputs({
    worktree: branch.root,
    runDir,
    finalSha: branch.finalSha,
    fixtureCommit: branch.fixtureSha,
    changeName: 'create-and-scene',
    identities: { change: ['create-and-scene'] },
  })
  const requirementsRoot = join(runDir, neutral.requirements.root)
  const texts = []
  for (const name of await filesBelow(requirementsRoot)) {
    texts.push(await readFile(join(requirementsRoot, name), 'utf8'))
  }
  const views = await materializeEvidenceJudgeViews({
    runDir,
    candidate: { artifacts: [], findings: [], ci_claims: [] },
    evaluator: null,
    contradictions: { items: [] },
    lineage: { final_sha: branch.finalSha, accepted: true },
    requirementsRoot,
  })
  const testingIndex = JSON.parse(await readFile(join(runDir, views['testing-evidence'].index), 'utf8'))
  return { runDir, neutral, bundle: texts.join('\n'), views, testingIndex }
}

const PINNED_INVENTORY = [{
  document: 'requirement-001.md',
  requirements: [{ requirement: 'Demo', scenarios: ['Right advances', 'Left goes back'] }],
}]

test('a candidate that deletes a scenario is judged against the fixture-commit requirements', async () => {
  const branch = await candidateBranch({
    spec: FIXTURE_SPEC.replace(/\n#### Scenario: Left goes back[\s\S]*$/, ''),
  })

  const { runDir, neutral, bundle, views, testingIndex } = await pinnedInputs(branch)

  assert.match(bundle, /#### Scenario: Left goes back/)
  assert.deepEqual(testingIndex.approved_requirements.documents, PINNED_INVENTORY)
  assert.match(views['assumption-handling'].packet, /Scenario: Left goes back/)
  // Product source still comes from the candidate's final commit.
  assert.equal(
    await readFile(join(runDir, neutral.source.root, 'src/index.ts'), 'utf8'),
    'export const implemented = true\n',
  )
})

test('a candidate that weakens requirement wording is judged against the fixture-commit wording', async () => {
  const branch = await candidateBranch({
    spec: FIXTURE_SPEC.replace('SHALL advance on every Right key press', 'MAY advance on Right'),
  })

  const { bundle, views } = await pinnedInputs(branch)

  assert.match(bundle, /The demo SHALL advance on every Right key press\./)
  assert.doesNotMatch(bundle, /MAY advance/)
  assert.match(views['assumption-handling'].packet, /SHALL advance on every Right key press/)
  assert.doesNotMatch(views['assumption-handling'].packet, /MAY advance/)
})

test('a requirement the candidate adds on its branch is absent from the pinned bundle', async () => {
  const added = '\n### Requirement: Confetti\nThe demo SHALL throw confetti.\n\n'
    + '#### Scenario: Confetti falls\n- **WHEN** the deck ends\n- **THEN** confetti falls\n'
  const branch = await candidateBranch({
    spec: FIXTURE_SPEC + added,
    extraSpecs: {
      'openspec/changes/create-and-scene/specs/extra/spec.md': `## ADDED Requirements\n${added}`,
    },
  })

  const { neutral, bundle, views, testingIndex } = await pinnedInputs(branch)

  assert.doesNotMatch(bundle, /Confetti/)
  assert.deepEqual(testingIndex.approved_requirements.documents, PINNED_INVENTORY)
  assert.doesNotMatch(views['testing-evidence'].packet, /Confetti/)
  assert.doesNotMatch(views['assumption-handling'].packet, /Confetti/)
  assert.equal(
    neutral.manifest.entries.filter(({ namespace }) => namespace === 'neutral-requirements').length,
    1,
  )
})

test('the bundle records the fixture commit as its source and the final SHA as the product source', async () => {
  const branch = await candidateBranch({ spec: FIXTURE_SPEC.replace('every ', '') })

  const { neutral } = await pinnedInputs(branch)

  assert.equal(neutral.manifest.source_revision, branch.finalSha)
  assert.equal(neutral.requirements.source_revision, branch.fixtureSha)
  assert.equal(neutral.manifest.requirements.source_revision, branch.fixtureSha)
  for (const entry of neutral.manifest.entries) {
    assert.equal(
      entry.origin.revision,
      entry.namespace === 'neutral-requirements' ? branch.fixtureSha : branch.finalSha,
    )
  }
})

test('a rescore of an older run reads requirements at that run\'s recorded fixture commit', async () => {
  // The older run started from the first fixture; a later fixture revision
  // tightened the definition. The candidate branch descends from the older one.
  const branch = await candidateBranch({ spec: FIXTURE_SPEC.replace('every ', '') })
  git(branch.root, 'checkout', '-q', '-b', 'later-fixture', branch.fixtureSha)
  await writeFile(join(branch.root, SPEC_PATH), FIXTURE_SPEC.replace('Right key press', 'Right or Space key press'))
  git(branch.root, 'commit', '-qam', 'later fixture')

  const { bundle } = await pinnedInputs(branch)

  assert.match(bundle, /SHALL advance on every Right key press\./)
  assert.doesNotMatch(bundle, /Space/)
})

test('neutral inputs refuse to judge without the recorded fixture commit', async () => {
  const branch = await candidateBranch({})
  const runDir = join(branch.root, '.run-output')
  const base = { worktree: branch.root, runDir, finalSha: branch.finalSha, changeName: 'create-and-scene' }

  await assert.rejects(materializeNeutralInputs(base), /recorded fixture commit/)
  await assert.rejects(
    materializeNeutralInputs({ ...base, fixtureCommit: 'e'.repeat(40) }),
    /recorded fixture commit e{40} is not available/,
  )
})

test('neutral inputs refuse a fixture commit with no approved requirements', async () => {
  const repo = await repository()
  git(repo.root, 'rm', '-qr', 'openspec')
  git(repo.root, 'commit', '-qm', 'no definition')
  const bare = git(repo.root, 'rev-parse', 'HEAD')

  await assert.rejects(materializeNeutralInputs({
    worktree: repo.root,
    runDir: join(repo.root, '.run-output'),
    finalSha: repo.sha,
    fixtureCommit: bare,
    changeName: 'create-and-scene',
  }), /no approved requirements/)
})
