import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  freezeCandidate,
  prepareCandidateWorktree,
} from '../evals/agent-runner/and-scene/lib/candidate.mjs'

function exec(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

function git(cwd, ...args) {
  const result = exec('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', ...args], { cwd })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'and-scene-candidate-'))
  const source = join(root, 'source')
  await mkdir(source)
  git(source, 'init', '-q')
  await writeFile(join(source, 'README.md'), 'fixture\n')
  git(source, 'add', 'README.md')
  git(source, 'commit', '-qm', 'fixture')
  const fixture = git(source, 'rev-parse', 'HEAD')
  await writeFile(join(source, 'README.md'), 'reference\n')
  git(source, 'add', 'README.md')
  git(source, 'commit', '-qm', 'reference')
  const reference = git(source, 'rev-parse', 'HEAD')
  return { root, source, fixture, reference }
}

test('fresh scored candidates clone and check out the fixture while baselines select their candidate', async () => {
  const repo = await repository()
  const scored = join(repo.root, 'scored')
  const baseline = join(repo.root, 'baseline')

  const scoredState = await prepareCandidateWorktree({
    repo: repo.source, worktree: scored, ref: repo.fixture, resume: false, exec,
  })
  const baselineState = await prepareCandidateWorktree({
    repo: repo.source, worktree: baseline, ref: repo.reference, resume: false, exec,
  })

  assert.equal(scoredState.commit, repo.fixture)
  assert.equal(scoredState.fixture_commit, repo.fixture)
  assert.equal(scoredState.repository, repo.source)
  assert.equal(baselineState.commit, repo.reference)
  assert.equal(git(scored, 'rev-parse', 'HEAD'), repo.fixture)
  assert.equal(git(baseline, 'rev-parse', 'HEAD'), repo.reference)
})

test('resume rejects repository or fixture provenance that differs from the recorded source', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const prepared = await prepareCandidateWorktree({
    repo: repo.source, worktree, ref: repo.fixture, resume: false, exec,
  })
  const expectedSource = {
    repository: prepared.repository,
    fixture_commit: prepared.fixture_commit,
  }

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree,
      ref: repo.reference,
      resume: true,
      expectedSource,
      exec,
    }),
    /fixture.*recorded|recorded.*fixture/i,
  )

  const other = await repository()
  await assert.rejects(
    prepareCandidateWorktree({
      repo: other.source,
      worktree,
      ref: repo.fixture,
      resume: true,
      expectedSource,
      exec,
    }),
    /repository.*recorded|recorded.*repository/i,
  )
})

test('resume rejects a candidate checkout whose origin no longer matches the recorded repository', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const prepared = await prepareCandidateWorktree({
    repo: repo.source, worktree, ref: repo.fixture, resume: false, exec,
  })
  git(worktree, 'remote', 'set-url', 'origin', join(repo.root, 'elsewhere'))

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree,
      ref: repo.fixture,
      resume: true,
      expectedSource: {
        repository: prepared.repository,
        fixture_commit: prepared.fixture_commit,
      },
      exec,
    }),
    /origin.*repository|repository.*origin/i,
  )
})

test('resume requires the already-cloned candidate worktree', async () => {
  const repo = await repository()

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'missing'),
      ref: repo.fixture,
      resume: true,
      expectedSource: { repository: repo.source, fixture_commit: repo.fixture },
      exec,
    }),
    /resume.*candidate worktree/i,
  )
})

test('resume rejects a clean HEAD unrelated to the recorded fixture', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const prepared = await prepareCandidateWorktree({
    repo: repo.source, worktree, ref: repo.fixture, resume: false, exec,
  })
  git(worktree, 'checkout', '--orphan', 'unrelated')
  git(worktree, 'rm', '-qf', 'README.md')
  await writeFile(join(worktree, 'OTHER.md'), 'not descended from the fixture\n')
  git(worktree, 'add', 'OTHER.md')
  git(worktree, 'commit', '-qm', 'unrelated clean commit')

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree,
      ref: repo.fixture,
      resume: true,
      expectedSource: {
        repository: prepared.repository,
        fixture_commit: prepared.fixture_commit,
      },
      exec,
    }),
    /does not descend from recorded fixture/i,
  )
})

test('freezing a clean implementation writes its normalized diff and tracked source manifest', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const runDir = join(repo.root, 'run')
  await mkdir(runDir)
  await prepareCandidateWorktree({ repo: repo.source, worktree, ref: repo.fixture, resume: false, exec })
  await mkdir(join(worktree, '.agent-runner'), { recursive: true })
  await writeFile(join(worktree, '.agent-runner/config.yaml'), 'eval-owned\n')
  await writeFile(join(worktree, 'README.md'), 'implemented\n')
  git(worktree, 'add', 'README.md')
  git(worktree, 'commit', '-qm', 'implementation')

  const frozen = await freezeCandidate({
    repo: repo.source,
    worktree,
    runDir,
    fixtureRevision: repo.fixture,
    exec,
  })

  assert.equal(frozen.fixture_commit, repo.fixture)
  assert.equal(frozen.produced_commit, git(worktree, 'rev-parse', 'HEAD'))
  assert.match(await readFile(join(runDir, 'implementation.diff'), 'utf8'), /implemented/)
  const manifest = JSON.parse(await readFile(join(runDir, 'candidate-source-manifest.json'), 'utf8'))
  assert.equal(manifest.candidate_identity, frozen.candidate_identity)
  assert.ok(manifest.tracked_files.some(({ path }) => path === 'README.md'))
  assert.ok(!manifest.tracked_files.some(({ path }) => path.includes('.agent-runner/config.yaml')))
})

test('freezing rejects uncommitted candidate changes', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const runDir = join(repo.root, 'run')
  await mkdir(runDir)
  await prepareCandidateWorktree({ repo: repo.source, worktree, ref: repo.fixture, resume: false, exec })
  await writeFile(join(worktree, 'dirty.txt'), 'not committed\n')

  await assert.rejects(
    freezeCandidate({ repo: repo.source, worktree, runDir, fixtureRevision: repo.fixture, exec }),
    /uncommitted changes/i,
  )
})

test('freezing preserves tracked filenames containing newlines', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const runDir = join(repo.root, 'run')
  const unusualPath = 'line\nbreak.txt'
  await mkdir(runDir)
  await prepareCandidateWorktree({ repo: repo.source, worktree, ref: repo.fixture, resume: false, exec })
  await writeFile(join(worktree, unusualPath), 'tracked despite the newline\n')
  git(worktree, 'add', '--', unusualPath)
  git(worktree, 'commit', '-qm', 'add unusual filename')

  await freezeCandidate({ repo: repo.source, worktree, runDir, fixtureRevision: repo.fixture, exec })

  const manifest = JSON.parse(await readFile(join(runDir, 'candidate-source-manifest.json'), 'utf8'))
  assert.ok(manifest.tracked_files.some(({ path }) => path === unusualPath))
})
