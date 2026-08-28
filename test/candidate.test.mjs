import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  freezeCandidate,
  prepareCandidateRescoreWorktree,
  prepareCandidateWorktree,
  verifyCandidateDelivery,
  verifyRecordedDeliveryIdentity,
} from '../evals/agent-runner/and-scene/lib/candidate.mjs'

function exec(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

function git(cwd, ...args) {
  const result = exec('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', ...args], { cwd })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

const validPlanningTestPlan = `# Test plan

## Coverage Strategy

Exercise the implementation through its public browser surface.

## Integration Tests

None.

## End-to-End Tests

None.

## Agent Acceptance Tests

### AT-001: Exercise the demo

- Classification: Required
- Covers: Demo behavior
- Actor and surface: User in a browser
- Setup: Start the built application
- Steps: Open the demo
- Expected: The demo renders
- Evidence: Browser snapshot
- Effects and cleanup: Stop the application
- Permitted substitutes: None

## Human-Only Testing

None.

## Coverage Map

| Requirement | Acceptance |
| --- | --- |
| Demo behavior | AT-001 |
`

async function writePlanningArtifacts(source, {
  omit = [],
  taskIndex = '- [Demo task](tasks/01-demo.md)\n',
  testPlan = null,
} = {}) {
  const changeDir = join(source, 'openspec/changes/create-and-scene')
  const omitted = new Set(omit)
  await mkdir(join(changeDir, 'specs/demo'), { recursive: true })
  await mkdir(join(changeDir, 'tasks'), { recursive: true })
  if (!omitted.has('proposal.md')) await writeFile(join(changeDir, 'proposal.md'), '# Proposal\n')
  if (!omitted.has('design.md')) await writeFile(join(changeDir, 'design.md'), '# Design\n')
  if (!omitted.has('specs/demo/spec.md')) {
    await writeFile(join(changeDir, 'specs/demo/spec.md'), '# Demo specification\n')
  }
  if (!omitted.has('tasks.md')) await writeFile(join(changeDir, 'tasks.md'), taskIndex)
  if (!omitted.has('tasks/01-demo.md')) {
    await writeFile(join(changeDir, 'tasks/01-demo.md'), '# Demo task\n')
  }
  if (!omitted.has('test-plan.md')) {
    await writeFile(join(changeDir, 'test-plan.md'), testPlan ?? validPlanningTestPlan)
  }
}

async function repository({
  validatorConfig = true,
  planningArtifacts = true,
  omitPlanning = [],
  taskIndex = '- [Demo task](tasks/01-demo.md)\n',
  testPlan = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'and-scene-candidate-'))
  const source = join(root, 'source')
  await mkdir(source)
  git(source, 'init', '-q')
  await writeFile(join(source, 'README.md'), 'fixture\n')
  if (validatorConfig) {
    await mkdir(join(source, '.validator'))
    await writeFile(join(source, '.validator/config.yml'), 'entry_points: []\n')
  }
  if (planningArtifacts) await writePlanningArtifacts(source, {
    omit: omitPlanning,
    taskIndex,
    testPlan,
  })
  git(source, 'add', '.')
  git(source, 'commit', '-qm', 'fixture')
  const fixture = git(source, 'rev-parse', 'HEAD')
  await writeFile(join(source, 'README.md'), 'reference\n')
  git(source, 'add', 'README.md')
  git(source, 'commit', '-qm', 'reference')
  const reference = git(source, 'rev-parse', 'HEAD')
  return { root, source, fixture, reference }
}

test('a scored candidate rejects a fixture without a complete acceptance plan before creating its branch', async () => {
  const repo = await repository({ planningArtifacts: false })
  const worktree = join(repo.root, 'candidate')

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree,
      ref: repo.fixture,
      resume: false,
      runId: 'run-without-test-plan',
      kind: 'candidate',
      exec,
    }),
    /planning.*test-plan|test-plan.*planning/i,
  )
  assert.equal(git(worktree, 'branch', '--show-current'), git(repo.source, 'branch', '--show-current'))
})

test('a scored candidate rejects a test plan without an acceptance obligation inventory', async () => {
  const repo = await repository({
    testPlan: `# Test plan

## Coverage Strategy

Browser coverage.

## Integration Tests

None.

## End-to-End Tests

None.

## Agent Acceptance Tests

None.

## Human-Only Testing

None.

## Coverage Map

No acceptance obligations.
`,
  })

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-without-acceptance-inventory',
      kind: 'candidate',
      exec,
    }),
    /acceptance obligation.*AT-|AT-.*acceptance obligation/i,
  )
})

test('a scored candidate rejects a test plan without the structured planning sections', async () => {
  const repo = await repository({
    testPlan: `# Test plan

### AT-001: Exercise the demo

This heading alone is not a reviewed structured test plan.
`,
  })

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-with-unstructured-test-plan',
      kind: 'candidate',
      exec,
    }),
    /test-plan\.md.*missing.*Coverage Strategy/i,
  )
})

test('a scored candidate rejects test-plan sections in the wrong order', async () => {
  const repo = await repository({
    testPlan: validPlanningTestPlan.replace(
      '## Coverage Strategy\n\nExercise the implementation through its public browser surface.\n\n## Integration Tests',
      '## Integration Tests\n\nNone.\n\n## Coverage Strategy',
    ),
  })

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-with-misordered-test-plan',
      kind: 'candidate',
      exec,
    }),
    /test-plan sections are out of order/i,
  )
})

for (const field of [
  'Classification',
  'Covers',
  'Actor and surface',
  'Setup',
  'Steps',
  'Expected',
  'Evidence',
  'Effects and cleanup',
  'Permitted substitutes',
]) {
  test(`a scored candidate rejects an AT obligation without ${field}`, async () => {
    const repo = await repository({
      testPlan: validPlanningTestPlan.replace(new RegExp(`^- ${field}:.*\\n`, 'm'), ''),
    })

    await assert.rejects(
      prepareCandidateWorktree({
        repo: repo.source,
        worktree: join(repo.root, 'candidate'),
        ref: repo.fixture,
        resume: false,
        runId: `run-with-incomplete-${field.toLowerCase().replaceAll(' ', '-')}`,
        kind: 'candidate',
        exec,
      }),
      new RegExp(`AT-001.*${field}`, 'i'),
    )
  })
}

test('a scored candidate rejects an unsupported AT classification', async () => {
  const repo = await repository({
    testPlan: validPlanningTestPlan.replace(
      '- Classification: Required',
      '- Classification: Optional',
    ),
  })

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-with-optional-at',
      kind: 'candidate',
      exec,
    }),
    /AT-001.*classification.*Required.*Conditional/i,
  )
})

test('a scored candidate rejects an acceptance obligation absent from the coverage map', async () => {
  const repo = await repository({
    testPlan: validPlanningTestPlan.replace('| Demo behavior | AT-001 |', '| Demo behavior | — |'),
  })

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-with-unmapped-at',
      kind: 'candidate',
      exec,
    }),
    /coverage map.*AT-001/i,
  )
})

test('coverage-map matching does not treat acceptance identifier punctuation as regex syntax', async () => {
  const repo = await repository({
    testPlan: validPlanningTestPlan
      .replace('### AT-001:', '### AT-a.b:')
      .replace('| Demo behavior | AT-001 |', '| Demo behavior | AT-aXb |'),
  })

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-with-regex-like-acceptance-id',
      kind: 'candidate',
      exec,
    }),
    /coverage map.*AT-a\.b/i,
  )
})

test('coverage-map matching accepts an exact acceptance identifier ending in punctuation', async () => {
  const repo = await repository({
    testPlan: validPlanningTestPlan.replaceAll('AT-001', 'AT-a-'),
  })

  const prepared = await prepareCandidateWorktree({
    repo: repo.source,
    worktree: join(repo.root, 'candidate'),
    ref: repo.fixture,
    resume: false,
    runId: 'run-with-trailing-punctuation-acceptance-id',
    kind: 'candidate',
    exec,
  })

  assert.equal(prepared.fixture_commit, repo.fixture)
})

test('a fixture file read failure remains an operational error', async () => {
  const repo = await repository()
  const failingExec = (command, args, options = {}) => {
    if (command === 'git' && args.includes('show') && args.some((arg) => arg.endsWith('/proposal.md'))) {
      return { status: 128, stderr: 'fatal: object database unavailable' }
    }
    return exec(command, args, options)
  }

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-with-fixture-read-failure',
      kind: 'candidate',
      exec: failingExec,
    }),
    (error) => {
      assert.notEqual(error.code, 'fixture-planning-contract')
      assert.match(error.message, /object database unavailable/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

test('a fixture tree listing failure remains an operational error', async () => {
  const repo = await repository()
  const failingExec = (command, args, options = {}) => {
    if (command === 'git' && args.includes('ls-tree') && args.at(-1).endsWith('/specs')) {
      return { status: 128, stderr: 'fatal: corrupt tree object' }
    }
    return exec(command, args, options)
  }

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-with-fixture-tree-failure',
      kind: 'candidate',
      exec: failingExec,
    }),
    (error) => {
      assert.notEqual(error.code, 'fixture-planning-contract')
      assert.match(error.message, /corrupt tree object/i)
      assert.ok(error.cause instanceof Error)
      return true
    },
  )
})

for (const [requiredArtifact, expected] of [
  ['proposal.md', /planning contract.*proposal\.md/i],
  ['design.md', /planning contract.*design\.md/i],
  ['specs/demo/spec.md', /planning contract.*specs\//i],
  ['tasks.md', /planning contract.*tasks\.md/i],
  ['tasks/01-demo.md', /planning contract.*tasks\//i],
]) {
  test(`a scored candidate rejects a planning contract without ${requiredArtifact}`, async () => {
    const repo = await repository({ omitPlanning: [requiredArtifact] })

    await assert.rejects(
      prepareCandidateWorktree({
        repo: repo.source,
        worktree: join(repo.root, 'candidate'),
        ref: repo.fixture,
        resume: false,
        runId: `run-without-${requiredArtifact.replaceAll('/', '-')}`,
        kind: 'candidate',
        exec,
      }),
      expected,
    )
  })
}

test('a scored candidate rejects a task index that does not inventory every task file', async () => {
  const repo = await repository({ taskIndex: '# Tasks\n\nNo linked task files.\n' })

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-with-unlinked-task',
      kind: 'candidate',
      exec,
    }),
    /tasks\.md.*tasks\/01-demo\.md|tasks\/01-demo\.md.*tasks\.md/i,
  )
})

test('a scored candidate rejects a fixture without final Validator configuration before creating its branch', async () => {
  const repo = await repository({ validatorConfig: false })
  const worktree = join(repo.root, 'candidate')

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree,
      ref: repo.fixture,
      resume: false,
      runId: 'run-without-validator',
      kind: 'candidate',
      exec,
    }),
    /fixture.*validator.*config/i,
  )
  assert.equal(git(worktree, 'branch', '--show-current'), git(repo.source, 'branch', '--show-current'))
})

test('a scored candidate rejects a Validator base with no shared fixture history', async () => {
  const repo = await repository()
  const defaultBranch = git(repo.source, 'branch', '--show-current')
  git(repo.source, 'checkout', '--orphan', 'unrelated-fixture')
  git(repo.source, 'rm', '-qrf', '.')
  await writeFile(join(repo.source, 'README.md'), 'unrelated fixture\n')
  await mkdir(join(repo.source, '.validator'))
  await writeFile(join(repo.source, '.validator/config.yml'), 'entry_points: []\n')
  git(repo.source, 'add', '.')
  git(repo.source, 'commit', '-qm', 'unrelated fixture')
  const unrelatedFixture = git(repo.source, 'rev-parse', 'HEAD')
  git(repo.source, 'checkout', '-q', defaultBranch)

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: unrelatedFixture,
      resume: false,
      runId: 'run-with-unrelated-validator-base',
      kind: 'candidate',
      exec,
    }),
    /validator.*base.*share history|share history.*validator.*base/i,
  )
})

test('a scored candidate rejects a draft PR base with no shared fixture history', async () => {
  const repo = await repository()
  const defaultBranch = git(repo.source, 'branch', '--show-current')
  git(repo.source, 'checkout', '--orphan', 'unrelated-fixture')
  git(repo.source, 'rm', '-qrf', '.')
  await writeFile(join(repo.source, 'README.md'), 'unrelated fixture\n')
  await mkdir(join(repo.source, '.validator'))
  await writeFile(
    join(repo.source, '.validator/config.yml'),
    'base_branch: origin/unrelated-fixture\nentry_points: []\n',
  )
  git(repo.source, 'add', '.')
  git(repo.source, 'commit', '-qm', 'unrelated fixture')
  const unrelatedFixture = git(repo.source, 'rev-parse', 'HEAD')
  git(repo.source, 'checkout', '-q', defaultBranch)

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: unrelatedFixture,
      resume: false,
      runId: 'run-with-unrelated-pr-base',
      kind: 'candidate',
      exec,
    }),
    /draft PR base.*share history|share history.*draft PR base/i,
  )
})

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

test('freezing preserves implementation diffs larger than the subprocess default buffer', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const runDir = join(repo.root, 'run')
  const largeSource = `${'export const content = "large change"\n'.repeat(70_000)}// complete\n`
  await mkdir(runDir)
  await prepareCandidateWorktree({ repo: repo.source, worktree, ref: repo.fixture, resume: false, exec })
  await writeFile(join(worktree, 'large-source.ts'), largeSource)
  git(worktree, 'add', 'large-source.ts')
  git(worktree, 'commit', '-qm', 'large implementation')

  await freezeCandidate({ repo: repo.source, worktree, runDir, fixtureRevision: repo.fixture, exec })

  const diff = await readFile(join(runDir, 'implementation.diff'), 'utf8')
  assert.ok(diff.length > 1024 * 1024)
  assert.match(diff, /\/\/ complete\n$/)
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

test('a fresh candidate creates its unique delivery branch exactly at the fixture commit', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')

  const prepared = await prepareCandidateWorktree({
    repo: repo.source,
    worktree,
    ref: repo.fixture,
    resume: false,
    runId: 'run-123',
    kind: 'candidate',
    exec,
  })

  assert.equal(prepared.branch, 'eval/and-scene/run-123')
  assert.equal(prepared.base_branch, git(repo.source, 'branch', '--show-current'))
  assert.equal(git(worktree, 'branch', '--show-current'), 'eval/and-scene/run-123')
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), repo.fixture)
})

test('a fresh candidate refuses a pre-existing local or remote branch collision', async () => {
  const repo = await repository()
  git(repo.source, 'branch', 'eval/and-scene/run-123', repo.fixture)

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'candidate'),
      ref: repo.fixture,
      resume: false,
      runId: 'run-123',
      kind: 'candidate',
      exec,
    }),
    /branch.*already exists|collision/i,
  )
})

test('an evaluator-only rescore checks out the existing candidate branch without creating a new one', async () => {
  const repo = await repository()
  const branch = 'eval/and-scene/completed'
  git(repo.source, 'branch', branch, repo.reference)
  const worktree = join(repo.root, 'rescore')

  const prepared = await prepareCandidateRescoreWorktree({
    repo: repo.source,
    worktree,
    source: {
      repository: repo.source,
      fixture_commit: repo.fixture,
      final_sha: repo.reference,
      branch,
      base_branch: git(repo.source, 'branch', '--show-current'),
    },
    exec,
  })

  assert.equal(prepared.fixture_commit, repo.fixture)
  assert.equal(prepared.head_commit, repo.reference)
  assert.equal(prepared.branch, branch)
  assert.equal(git(worktree, 'branch', '--show-current'), branch)
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), repo.reference)
  assert.equal(git(worktree, 'status', '--porcelain'), '')
})

test('an evaluator-only rescore rejects a source branch that moved from the recorded final SHA', async () => {
  const repo = await repository()
  const branch = 'eval/and-scene/completed'
  git(repo.source, 'branch', branch, repo.reference)

  await assert.rejects(
    prepareCandidateRescoreWorktree({
      repo: repo.source,
      worktree: join(repo.root, 'rescore'),
      source: {
        repository: repo.source,
        fixture_commit: repo.fixture,
        final_sha: 'f'.repeat(40),
        branch,
        base_branch: git(repo.source, 'branch', '--show-current'),
      },
      exec,
    }),
    /final SHA|branch.*recorded/i,
  )
})

test('resume rejects a repository default base branch that changed after delivery began', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const prepared = await prepareCandidateWorktree({
    repo: repo.source,
    worktree,
    ref: repo.fixture,
    resume: false,
    runId: 'run-123',
    kind: 'candidate',
    exec,
  })
  git(repo.source, 'branch', 'different-base', repo.reference)
  git(repo.source, 'symbolic-ref', 'HEAD', 'refs/heads/different-base')

  await assert.rejects(
    prepareCandidateWorktree({
      repo: repo.source,
      worktree,
      ref: repo.fixture,
      resume: true,
      expectedSource: {
        repository: prepared.repository,
        fixture_commit: prepared.fixture_commit,
        branch: prepared.branch,
        base_branch: prepared.base_branch,
      },
      runId: 'run-123',
      kind: 'candidate',
      exec,
    }),
    /default base branch.*does not match recorded/i,
  )
})

test('delivery verification proves branch, remote head, draft PR identity, and final handoff without CI', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  const sessionDir = join(repo.root, 'session')
  await prepareCandidateWorktree({
    repo: repo.source,
    worktree,
    ref: repo.fixture,
    resume: false,
    runId: 'run-123',
    kind: 'candidate',
    exec,
  })
  await mkdir(join(worktree, 'openspec/changes/create-and-scene'), { recursive: true })
  await mkdir(join(sessionDir, 'output'), { recursive: true })
  for (const file of [
    'acceptance-assumptions.md',
    'acceptance-flow-evidence.md',
    'acceptance-handoff.md',
    'findings-history.md',
  ]) {
    await writeFile(join(sessionDir, 'output', file), `${file}\n`)
  }
  await writeFile(
    join(sessionDir, 'output', 'screenshot-metadata.json'),
    JSON.stringify({ captures: [{ path: 'acceptance-flow.png' }] }),
  )
  await writeFile(join(sessionDir, 'output', 'acceptance-flow.png'), 'image bytes\n')

  const head = git(worktree, 'rev-parse', 'HEAD')
  const calls = []
  const delivery = await verifyCandidateDelivery({
    worktree,
    fixtureCommit: repo.fixture,
    branch: 'eval/and-scene/run-123',
    expectedBase: 'main',
    changeName: 'create-and-scene',
    sessionDir,
    workflowHistory: [
      { step: 'run-validator', outcome: 'success' },
      { step: 'open-draft-pr', outcome: 'success' },
      { step: 'verify-draft-pr', outcome: 'success' },
      { step: 'prepare-acceptance', outcome: 'success' },
      { step: 'verify-acceptance-handoff', outcome: 'success' },
    ],
    exec: (command, args, options) => {
      calls.push([command, ...args])
      if (command === 'git' && args.includes('ls-remote')) {
        return { status: 0, stdout: `${head}\trefs/heads/eval/and-scene/run-123\n` }
      }
      return exec(command, args, options)
    },
    inspectPullRequest: async () => ({
      number: 53,
      url: 'https://github.com/Codagent-AI/and-scene/pull/53',
      state: 'OPEN',
      draft: true,
      base: 'main',
      head_branch: 'eval/and-scene/run-123',
      head_sha: head,
    }),
  })

  assert.equal(delivery.final_sha, head)
  assert.equal(delivery.pull_request.base, 'main')
  assert.ok(delivery.acceptance_artifacts.length >= 6)
  assert.ok(delivery.acceptance_artifacts.some(({ role }) => role === 'acceptance-screenshot'))
  assert.ok(!calls.some(([command, ...args]) => (
    command === 'gh' && /check|status|ci/i.test(args.join(' '))
  )), JSON.stringify(calls))

  await assert.rejects(
    verifyCandidateDelivery({
      worktree,
      fixtureCommit: repo.fixture,
      branch: 'eval/and-scene/run-123',
      expectedBase: 'main',
      changeName: 'create-and-scene',
      sessionDir,
      workflowHistory: delivery.workflow_history,
      exec: (command, args, options) => {
        if (command === 'git' && args.includes('ls-remote')) {
          return { status: 0, stdout: `${head}\trefs/heads/eval/and-scene/run-123\n` }
        }
        return exec(command, args, options)
      },
      inspectPullRequest: async () => ({
        ...delivery.pull_request,
        base: 'evaluation-fixture',
      }),
    }),
    /base.*evaluation-fixture.*expected.*main|expected.*base.*main/i,
  )
})

test('an observed prohibited delivery effect has typed workflow-side-effect ownership', async () => {
  let error
  try {
    await verifyCandidateDelivery({
      worktree: '/unused',
      fixtureCommit: 'fixture',
      branch: 'eval/and-scene/run-123',
      expectedBase: 'main',
      changeName: 'create-and-scene',
      sessionDir: '/unused',
      workflowHistory: [{ step: 'merge-pr', outcome: 'success' }],
      exec,
      inspectPullRequest: async () => null,
    })
    assert.fail('expected delivery verification to reject the prohibited effect')
  } catch (caught) {
    error = caught
  }

  assert.equal(error.code, 'workflow-side-effect-violation')
  assert.equal(error.owner, 'implementation-workflow')
})

test('resume revalidates the recorded branch, PR, and final SHA before Runner action', async () => {
  const repo = await repository()
  const worktree = join(repo.root, 'candidate')
  await prepareCandidateWorktree({
    repo: repo.source,
    worktree,
    ref: repo.fixture,
    resume: false,
    runId: 'run-123',
    kind: 'candidate',
    exec,
  })
  const head = git(worktree, 'rev-parse', 'HEAD')
  const recorded = {
    branch: 'eval/and-scene/run-123',
    base_branch: 'main',
    final_sha: head,
    pull_request: {
      number: 53,
      url: 'https://example.test/pull/53',
      state: 'OPEN',
      draft: true,
      base: 'main',
      head_branch: 'eval/and-scene/run-123',
      head_sha: head,
    },
  }

  await assert.rejects(
    verifyRecordedDeliveryIdentity({
      worktree,
      recorded,
      exec,
      inspectPullRequest: async () => ({
        ...recorded.pull_request,
        head_sha: 'different',
      }),
    }),
    /pull request.*head_sha|head_sha.*recorded/i,
  )
})
