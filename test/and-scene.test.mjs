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
const fixtureSha = '26d2866e5003f34786fffa528891e6092c87cf8b'

async function setup() {
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
  return { dir, runner, home }
}

async function run(args, options = {}) {
  const env = { ...process.env, HOME: options.home, SANDBOX_SECRETS_FILE: join(options.dir, 'missing.env') }
  const result = spawnSync('bash', [runScript, ...args], { cwd: root, env, encoding: 'utf8' })
  return { ...result, output: result.stdout + result.stderr }
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
    fixtureSha, 'origin/change/create-and-scene', 'npm ci', 'npm run build', 'npm run verify',
    'chrome-devtools-axi open', 'chrome-devtools-axi snapshot', 'axi-browser-proof.log',
    'proof-metadata.json', '--input-dir',
    'AGENT_EVALS_SOURCE_COMMIT', 'AGENT_EVALS_SOURCE_DIRTY', artifacts,
    '--mount-codex-auth', '--mount-claude-auth',
  ]) assert.match(result.output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('scored mode preserves workflow, evidence, judging, scoring, and artifacts', async () => {
  const context = await setup()
  const result = await run([
    '--dry-run', '--run-agent', '--artifact-dir', join(context.dir, 'run'),
    '--agent-runner-dir', context.runner, '--agent', 'claude', '--model', 'sonnet', '--judge-model', 'gpt-5',
  ], context)
  assert.equal(result.status, 0, result.output)
  for (const expected of [
    fixtureSha, 'workflows/openspec/implement-change.yaml', 'RUN_ARGS=(run', '--until', 'run-validator',
    'planner:', 'autonomous_permission_mode: yolo', 'change_name=create-and-scene',
    'implementation.diff', 'diff-hash.txt', 'metadata.json', 'reward.json', 'manifest.json',
    'tier1-result.json', 'tier2-judge-prompt.md', 'tier2-result.json',
    '/eval-input/scene-shots.mjs', 'SHOTS_MANIFEST=/artifacts/screenshot-manifest.json',
    'repair_screenshot_capture', 'evidence_repair_penalty', '--output-schema', '--image',
    'AGENT_EVALS_SOURCE_COMMIT', 'AGENT_EVALS_SOURCE_DIRTY',
    'evals/agent-runner/and-scene', '--input-dir', '--mount-claude-auth', '--mount-codex-auth',
  ]) assert.ok(result.output.includes(expected), `missing ${expected}\n${result.output}`)
})

test('custom workflow receives only caller supplied arguments', async () => {
  const context = await setup()
  const result = await run([
    '--dry-run', '--run-agent', '--artifact-dir', join(context.dir, 'run'),
    '--agent-runner-dir', context.runner, '--agent', 'codex', '--workflow', '/tmp/custom.yaml',
    '--workflow-arg', 'feature=demo',
  ], context)
  assert.equal(result.status, 0, result.output)
  assert.ok(result.output.includes('feature=demo'))
  assert.ok(result.output.includes('--mount-codex-auth'))
  assert.ok(!result.output.includes('--mount-claude-auth'))
  assert.ok(!result.output.includes('change_name=create-and-scene'))
  assert.ok(!result.output.includes('run-validator'))
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
  const scored = await run(['--dry-run', '--run-agent', '--agent', 'codex', '--agent-runner-dir', context.runner], context)
  assert.equal(proof.status, 0, proof.output)
  assert.equal(scored.status, 0, scored.output)
  assert.match(proof.output, new RegExp(`${root}/artifacts/evals/and-scene-proof/\\d{8}T\\d{6}Z`))
  assert.match(scored.output, new RegExp(`${root}/artifacts/evals/and-scene/\\d{8}T\\d{6}Z`))
})

test('static harness contract covers complete evidence and bounded sanitized repair', async () => {
  const text = await readFile(runScript, 'utf8')
  for (const expected of [
    'pass: (\\$build_exit_code == 0 and \\$verify_exit_code == 0)', 'cat -- "\\$file"',
    '--image "\\$screenshot"', "jq -e '.pass == true' /artifacts/tier2-result.json",
    'hard_pass', 'soft_score', 'scenario_compliance', 'screenshot-manifest.json',
    'EVIDENCE_REPAIR_PENALTY=5', 'sanitized-screenshot-manifest.json',
    'expectedPresentations', 'capturedPresentations', 'expectedScreenshots', 'capturedScreenshots', 'errorCount',
    'generated_by: "evals/agent-runner/and-scene/run.sh"',
    "jq -e '.complete == true' /artifacts/screenshot-manifest.json",
    'hard_pass: (\\$wf and \\$correct and \\$evidence and \\$scenario_pass)',
  ]) assert.ok(text.includes(expected), `missing ${expected}`)
  assert.ok(!text.includes('cp /artifacts/logs/screenshots.log "$repair_dir/screenshots.log"'))
  assert.ok(!text.includes('cp /artifacts/screenshot-manifest.json "$repair_dir/screenshot-manifest.json"'))
})

test('screenshot helper uses the spec contract and reports complete coverage', async () => {
  const text = await readFile(shotsScript, 'utf8')
  for (const expected of [
    "locator('[data-step-count]')", "document.querySelector('[data-step-count]')",
    'SHOTS_MANIFEST', 'expectedScreenshots', 'capturedScreenshots', 'complete', 'count > MAX_STEPS',
  ]) assert.ok(text.includes(expected), `missing ${expected}`)
  assert.ok(!text.includes('data-testid="step-progress"'))
  assert.ok(!text.includes('Math.min(count, MAX_STEPS)'))
  assert.ok(text.includes("throw new Error('failed to load presentation registry'"))
  assert.ok(!text.includes("return [{ slug: '' }]"))
})

test('help documents the exact fixture pin and agent runner checkout option', async () => {
  const result = spawnSync('bash', [runScript, '--help'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('Usage: evals/agent-runner/and-scene/run.sh'))
  assert.ok(result.stdout.includes(fixtureSha))
  assert.ok(result.stdout.includes('--agent-runner-dir PATH'))
})
