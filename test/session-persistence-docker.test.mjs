import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const suiteDir = join(root, 'evals/agent-runner/and-scene')
const image = process.env.AGENT_EVALS_DOCKER_TEST_IMAGE
  ?? 'mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm'
// Gate on the daemon only. Requiring a cached image silently skipped this
// regression on any machine that had not already pulled it; docker run pulls.
const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }).status === 0

function container(artifacts, command, env, timeout = 30_000) {
  return spawnSync('docker', [
    'run', '--rm',
    '-e', 'HOME=/workspace/home',
    '--mount', `type=bind,source=${artifacts},target=/artifacts`,
    '--mount', `type=bind,source=${suiteDir},target=/eval-input,readonly`,
    image, 'bash', '-lc', command,
  ], { encoding: 'utf8', env, timeout })
}

test('replacement containers reuse only their own mounted agent sessions', {
  skip: !dockerAvailable,
}, async t => {
  const dir = await makeTempDir(join(tmpdir(), 'agent-evals-session-docker-'))
  const env = { ...process.env }
  if (!process.env.AGENT_EVALS_DOCKER_TEST_IMAGE) {
    // The default public image needs no registry credentials. Isolate Docker's
    // config so a desktop keychain helper cannot block an unattended pull. Keep
    // the active daemon endpoint rather than reverting to another context.
    const endpoint = process.env.DOCKER_HOST ?? spawnSync('docker', [
      'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}',
    ], { encoding: 'utf8', timeout: 10_000 }).stdout?.trim()
    assert.ok(endpoint, 'Could not resolve the active Docker daemon endpoint')
    const config = join(dir, 'docker-config')
    await mkdir(config)
    await writeFile(join(config, 'config.json'), '{}')
    Object.assign(env, { DOCKER_CONFIG: config, DOCKER_HOST: endpoint })
    delete env.DOCKER_CONTEXT
  }
  const firstArtifacts = join(dir, 'evaluation-a')
  const secondArtifacts = join(dir, 'evaluation-b')
  await mkdir(firstArtifacts)
  await mkdir(secondArtifacts)
  // The containers create owner-only state the host user cannot remove, so
  // delete it from inside a container before the host-side cleanup runs.
  t.after(() => {
    for (const artifacts of [firstArtifacts, secondArtifacts]) container(artifacts, 'rm -rf /artifacts/.runtime', env, 15_000)
  })

  const first = container(firstArtifacts, [
    '/eval-input/prepare-agent-session-state.sh /artifacts/.runtime/agent-session-state',
    'mkdir -p "$HOME/.codex/sessions/2026/09/10" "$HOME/.claude/projects/-workspace-candidate"',
    'printf codex > "$HOME/.codex/sessions/2026/09/10/rollout.jsonl"',
    'printf claude > "$HOME/.claude/projects/-workspace-candidate/session.jsonl"',
  ].join(' && '), env, 120_000)
  assert.equal(first.status, 0, first.error?.message ?? first.stdout + first.stderr)

  const replacement = container(firstArtifacts, [
    '/eval-input/prepare-agent-session-state.sh /artifacts/.runtime/agent-session-state',
    'test "$(cat "$HOME/.codex/sessions/2026/09/10/rollout.jsonl")" = codex',
    'test "$(cat "$HOME/.claude/projects/-workspace-candidate/session.jsonl")" = claude',
  ].join(' && '), env)
  assert.equal(replacement.status, 0, replacement.stdout + replacement.stderr)

  const isolated = container(secondArtifacts, [
    '/eval-input/prepare-agent-session-state.sh /artifacts/.runtime/agent-session-state',
    'test ! -e "$HOME/.codex/sessions/2026/09/10/rollout.jsonl"',
    'test ! -e "$HOME/.claude/projects/-workspace-candidate/session.jsonl"',
  ].join(' && '), env)
  assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr)

  // Verify from inside a container: the persisted state is deliberately
  // owner-only, and the host test user does not share the container's uid.
  const persisted = container(firstArtifacts,
    'test "$(cat /artifacts/.runtime/agent-session-state/codex/sessions/2026/09/10/rollout.jsonl)" = codex', env)
  assert.equal(persisted.status, 0, persisted.stdout + persisted.stderr)
})
