import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runScript = join(root, 'evals/agent-runner/and-scene/run.sh')
const shotsScript = join(root, 'evals/agent-runner/and-scene/scene-shots.mjs')
const fixtureSha = 'c11595651dfb3941e39c703c483ed1a92d152a37'
const referenceSha = '171c7def1e12aca2a5f605a5e5feafb20d4e4d19'

const profileArgs = [
  '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
  '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
]

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval', ...args], {
    cwd, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
}

// The scored path now requires a clean Agent Runner worktree containing
// implement-change2, so the fixture runner directory is a real Git checkout.
async function setup({ workflow = 'name: implement-change2\n', dirty = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-'))
  const runner = join(dir, 'agent-runner')
  const sandbox = join(runner, 'scripts/sandbox-run.sh')
  const home = join(dir, 'home')
  await mkdir(dirname(sandbox), { recursive: true })
  await mkdir(join(home, '.codex'), { recursive: true })
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(join(home, '.codex/auth.json'), '{}\n')
  await writeFile(join(home, '.claude/.credentials.json'), '{}\n')
  await writeFile(sandbox, '#!/usr/bin/env bash\nprintf \'%q \' "$@"\nprintf \'\\n\'\n')
  await chmod(sandbox, 0o755)
  if (workflow !== null) {
    await mkdir(join(runner, 'workflows/openspec'), { recursive: true })
    await writeFile(join(runner, 'workflows/openspec/implement-change2.yaml'), workflow)
  }
  git(runner, 'init', '-q')
  git(runner, 'add', '-A')
  git(runner, 'commit', '-qm', 'runner')
  if (dirty) await writeFile(join(runner, 'scratch.txt'), 'uncommitted\n')
  return { dir, runner, home }
}

async function run(args, options = {}) {
  const env = { ...process.env, HOME: options.home, SANDBOX_SECRETS_FILE: join(options.dir, 'missing.env') }
  const result = spawnSync('bash', [runScript, ...args], { cwd: root, env, encoding: 'utf8' })
  return { ...result, output: result.stdout + result.stderr }
}

async function scored(context, extra = []) {
  return run([
    '--dry-run', '--run-agent', '--artifact-dir', join(context.dir, 'run'),
    '--agent-runner-dir', context.runner, ...extra,
  ], context)
}

test('proof mode wires the pinned fixture, browser proof, suite input, and provenance', async () => {
  const context = await setup()
  const artifacts = join(context.dir, 'proof')
  const result = await run([
    '--dry-run', '--proof-browser', '--artifact-dir', artifacts,
    '--agent-runner-dir', context.runner, '--mount-codex-auth', '--mount-claude-auth',
  ], context)
  assert.equal(result.status, 0, result.output)
  for (const expected of [
    fixtureSha, referenceSha, 'npm ci', 'npm run build', 'npm run verify',
    'chrome-devtools-axi open', 'chrome-devtools-axi snapshot', 'axi-browser-proof.log',
    'proof-metadata.json', '--input-dir',
    'AGENT_EVALS_SOURCE_COMMIT', 'AGENT_EVALS_SOURCE_DIRTY', artifacts,
    '--mount-codex-auth', '--mount-claude-auth',
  ]) assert.match(result.output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('scored mode delegates the lifecycle to the suite controller', async () => {
  const context = await setup()

  const result = await scored(context, ['--skip-validator', ...profileArgs])

  assert.equal(result.status, 0, result.output)
  for (const expected of [
    '/eval-input/controller.mjs', '--run-dir', '/artifacts',
    '--skip-validator', '--change-name', 'create-and-scene',
    '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
    '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
  ]) assert.ok(result.output.includes(expected), `missing ${expected}\n${result.output}`)
})

test('scored mode hard-codes implement-change2 and no longer accepts workflow overrides', async () => {
  const context = await setup()

  const result = await scored(context, ['--skip-validator', ...profileArgs])
  const overridden = await scored(context, ['--workflow', '/tmp/custom.yaml', ...profileArgs])

  assert.ok(result.output.includes('implement-change2'), result.output)
  assert.ok(!result.output.includes('implement-change.yaml'), result.output)
  assert.notEqual(overridden.status, 0)
  assert.match(overridden.output, /Unknown option: --workflow/)
})

test('scored mode no longer carries the legacy reward and tier scoring lifecycle', async () => {
  const text = await readFile(runScript, 'utf8')

  for (const legacy of [
    'reward.json', 'tier2-judge-prompt.md', 'hard_pass', 'soft_score',
    'write_reward', 'run_tier2_judge', 'scenario_compliance',
  ]) assert.ok(!text.includes(legacy), `run.sh still contains legacy lifecycle: ${legacy}`)
})

test('both role profiles are required before the sandbox is invoked', async () => {
  const context = await setup()

  const noLead = await scored(context, [
    '--skip-validator',
    '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
  ])
  const noImplementor = await scored(context, [
    '--skip-validator', '--lead-cli', 'claude', '--lead-model', 'opus', '--lead-effort', 'high',
  ])

  assert.notEqual(noLead.status, 0)
  assert.match(noLead.output, /lead-agent profile/)
  assert.notEqual(noImplementor.status, 0)
  assert.match(noImplementor.output, /task-implementor profile/)
})

test('a partially specified role profile is rejected', async () => {
  const context = await setup()

  const result = await scored(context, [
    '--skip-validator', '--lead-cli', 'claude', '--lead-model', 'opus',
    '--implementor-cli', 'claude', '--implementor-model', 'sonnet', '--implementor-effort', 'medium',
  ])

  assert.notEqual(result.status, 0)
  assert.match(result.output, /lead-agent profile/)
})

test('a reference baseline requires no role profiles', async () => {
  const context = await setup()

  const result = await scored(context, ['--skip-validator', '--reference-baseline', '--candidate-ref', 'origin/reference'])

  assert.equal(result.status, 0, result.output)
  assert.ok(result.output.includes('--reference-baseline'), result.output)
  assert.ok(result.output.includes('--candidate-ref'), result.output)
})

test('a reference baseline does not require a clean Agent Runner checkout', async () => {
  // Reference baselines never invoke Agent Runner, so its workflow contract and
  // worktree cleanliness are irrelevant to them.
  const dirty = await setup({ dirty: true })
  const missingWorkflow = await setup({ workflow: null })

  const dirtyResult = await scored(dirty, ['--skip-validator', '--reference-baseline', '--candidate-ref', 'origin/reference'])
  const missingResult = await scored(missingWorkflow, [
    '--skip-validator', '--reference-baseline', '--candidate-ref', 'origin/reference',
  ])

  assert.equal(dirtyResult.status, 0, dirtyResult.output)
  assert.equal(missingResult.status, 0, missingResult.output)
})

test('a dirty Agent Runner checkout is rejected on the host before the sandbox runs', async () => {
  const context = await setup({ dirty: true })

  const result = await scored(context, ['--skip-validator', ...profileArgs])

  assert.notEqual(result.status, 0)
  assert.match(result.output, /uncommitted changes/i)
  assert.ok(!result.output.includes('/eval-input/controller.mjs'), result.output)
})

test('an Agent Runner checkout without implement-change2 is rejected on the host', async () => {
  const context = await setup({ workflow: null })

  const result = await scored(context, ['--skip-validator', ...profileArgs])

  assert.notEqual(result.status, 0)
  assert.match(result.output, /implement-change2\.yaml/)
})

test('the run receives a stable container identity that resume reuses', async () => {
  const context = await setup()

  const first = await scored(context, ['--skip-validator', ...profileArgs])
  const resumed = await scored(context, ['--skip-validator', '--resume', ...profileArgs])

  assert.equal(first.status, 0, first.output)
  assert.equal(resumed.status, 0, resumed.output)
  const identity = /AND_SCENE_RUN_ID/
  assert.match(first.output, identity)
  assert.match(resumed.output, identity)
  assert.ok(resumed.output.includes('--resume'), resumed.output)
})

test('repository and refs remain shell quoted', async () => {
  const context = await setup()
  const repo = 'https://example.invalid/repo.git"; echo pwned; #'
  const ref = 'origin/eval"; echo ref-pwned; #'
  const result = await run([
    '--dry-run', '--proof-browser', '--artifact-dir', join(context.dir, 'proof'),
    '--agent-runner-dir', context.runner, '--repo', repo, '--fixture-ref', ref, '--reference-ref', ref,
  ], context)
  assert.equal(result.status, 0, result.output)
  assert.ok(!result.output.includes(`git clone "${repo}`))
  assert.ok(!result.output.includes(`git checkout "${ref}`))
  assert.ok(result.output.includes('repo.git'))
  assert.ok(result.output.includes('ref-pwned'))
})

test('agent runner directory must contain an executable sandbox adapter', async () => {
  const context = await setup()
  const missing = await run(['--dry-run', '--proof-browser', '--agent-runner-dir', join(context.dir, 'missing')], context)
  assert.notEqual(missing.status, 0)
  assert.match(missing.output, /Agent Runner directory does not exist/)
  await chmod(join(context.runner, 'scripts/sandbox-run.sh'), 0o644)
  const nonExecutable = await run(['--dry-run', '--proof-browser', '--agent-runner-dir', context.runner], context)
  assert.notEqual(nonExecutable.status, 0)
  assert.match(nonExecutable.output, /sandbox-run\.sh is not executable/)
})

test('default artifact directories live under the agent-evals checkout', async () => {
  const context = await setup()
  const proof = await run(['--dry-run', '--proof-browser', '--agent-runner-dir', context.runner], context)
  const run_ = await run([
    '--dry-run', '--run-agent', '--skip-validator', '--agent-runner-dir', context.runner, ...profileArgs,
  ], context)
  assert.equal(proof.status, 0, proof.output)
  assert.equal(run_.status, 0, run_.output)
  assert.match(proof.output, new RegExp(`${root}/artifacts/evals/and-scene-proof/\\d{8}T\\d{6}Z`))
  assert.match(run_.output, new RegExp(`${root}/artifacts/evals/and-scene/\\d{8}T\\d{6}Z`))
})

test('generated proof and scored container scripts are valid bash', async () => {
  const context = await setup()
  const sandbox = join(context.runner, 'scripts/sandbox-run.sh')
  await writeFile(sandbox, `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
[ "$#" -gt 0 ] && shift
bash -n -c "$1"
`)
  await chmod(sandbox, 0o755)
  // Re-commit so the scored path still sees a clean Agent Runner worktree.
  git(context.runner, 'add', '-A')
  git(context.runner, 'commit', '-qm', 'syntax-checking sandbox stub')
  const proof = await run(['--dry-run', '--proof-browser', '--agent-runner-dir', context.runner], context)
  const scoredRun = await scored(context, ['--skip-validator', ...profileArgs])
  assert.equal(proof.status, 0, proof.output)
  assert.equal(scoredRun.status, 0, scoredRun.output)
})

test('repair policy retries incomplete evidence once and always charges the penalty', async () => {
  const policy = join(root, 'evals/agent-runner/and-scene/evidence-repair.sh')
  const dir = await mkdtemp(join(tmpdir(), 'evidence-repair-'))
  const manifest = join(dir, 'manifest.json')
  const script = `
set -euo pipefail
source ${JSON.stringify(policy)}
captures=0
repairs=0
capture() {
  captures=$((captures + 1))
  if [ "$captures" -eq 1 ]; then
    printf '%s\\n' '{"complete":false}' > ${JSON.stringify(manifest)}
    return 1
  fi
  printf '%s\\n' '{"complete":true}' > ${JSON.stringify(manifest)}
}
repair() { repairs=$((repairs + 1)); }
ensure_complete_evidence capture repair ${JSON.stringify(manifest)}
printf '%s %s %s %s\\n' "$captures" "$repairs" "$EVIDENCE_REPAIR_ATTEMPTED" "$EVIDENCE_REPAIR_PENALTY"
`
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '2 1 true 5')
})

test('screenshot helper uses the spec contract and reports complete coverage', async () => {
  const text = await readFile(shotsScript, 'utf8')
  for (const expected of [
    "locator('[data-step-count]')", "document.querySelector('[data-step-count]')",
    'SHOTS_MANIFEST', 'expectedScreenshots', 'capturedScreenshots', 'complete', 'count > MAX_STEPS',
    'SHOT_SETTLE_MS', 'stepTexts', 'sha256', 'duplicate screenshot content',
  ]) assert.ok(text.includes(expected), `missing ${expected}`)
  assert.ok(!text.includes('data-testid="step-progress"'))
  assert.ok(!text.includes('Math.min(count, MAX_STEPS)'))
  assert.ok(text.includes("throw new Error('failed to load presentation registry'"))
  assert.ok(!text.includes("return [{ slug: '' }]"))
  assert.ok(!text.includes('localhost'))
  assert.ok(text.includes('127.0.0.1'))
})

test('help documents the exact fixture pin, role profiles, and validator option', async () => {
  const result = spawnSync('bash', [runScript, '--help'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('Usage: evals/agent-runner/and-scene/run.sh'))
  assert.ok(result.stdout.includes(fixtureSha))
  assert.ok(result.stdout.includes(referenceSha))
  assert.ok(result.stdout.includes('--agent-runner-dir PATH'))
  assert.ok(result.stdout.includes('--skip-validator'))
  assert.ok(result.stdout.includes('--lead-cli'))
  assert.ok(result.stdout.includes('--implementor-cli'))
})
