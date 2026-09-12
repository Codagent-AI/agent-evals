import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
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
const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

function container(artifacts, command) {
  return spawnSync('docker', [
    'run', '--rm',
    '-e', 'HOME=/workspace/home',
    '--mount', `type=bind,source=${artifacts},target=/artifacts`,
    '--mount', `type=bind,source=${suiteDir},target=/eval-input,readonly`,
    image, 'bash', '-lc', command,
  ], { encoding: 'utf8' })
}

test('replacement containers reuse only their own mounted agent sessions', {
  skip: !dockerAvailable,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-evals-session-docker-'))
  const firstArtifacts = join(dir, 'evaluation-a')
  const secondArtifacts = join(dir, 'evaluation-b')
  await mkdir(firstArtifacts)
  await mkdir(secondArtifacts)

  const first = container(firstArtifacts, [
    '/eval-input/prepare-agent-session-state.sh /artifacts/.runtime/agent-session-state',
    'mkdir -p "$HOME/.codex/sessions/2026/09/10" "$HOME/.claude/projects/-workspace-candidate"',
    'printf codex > "$HOME/.codex/sessions/2026/09/10/rollout.jsonl"',
    'printf claude > "$HOME/.claude/projects/-workspace-candidate/session.jsonl"',
  ].join(' && '))
  assert.equal(first.status, 0, first.stdout + first.stderr)

  const replacement = container(firstArtifacts, [
    '/eval-input/prepare-agent-session-state.sh /artifacts/.runtime/agent-session-state',
    'test "$(cat "$HOME/.codex/sessions/2026/09/10/rollout.jsonl")" = codex',
    'test "$(cat "$HOME/.claude/projects/-workspace-candidate/session.jsonl")" = claude',
  ].join(' && '))
  assert.equal(replacement.status, 0, replacement.stdout + replacement.stderr)

  const isolated = container(secondArtifacts, [
    '/eval-input/prepare-agent-session-state.sh /artifacts/.runtime/agent-session-state',
    'test ! -e "$HOME/.codex/sessions/2026/09/10/rollout.jsonl"',
    'test ! -e "$HOME/.claude/projects/-workspace-candidate/session.jsonl"',
  ].join(' && '))
  assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr)

  assert.equal(
    await readFile(join(firstArtifacts, '.runtime/agent-session-state/codex/sessions/2026/09/10/rollout.jsonl'), 'utf8'),
    'codex',
  )
})
