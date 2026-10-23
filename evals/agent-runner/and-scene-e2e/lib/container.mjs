// Throwaway containers from Agent Runner's sandbox image: the only place candidate or workspace-derived
// commands run on this machine. No credentials, auth mounts or host environment variables are ever passed.
import { runTimed, requireCommand } from '../../../lib/define-run/subprocess.mjs'
export const SANDBOX_IMAGE = 'agent-runner-dev:local'
// The image points npm's cache at its own user's home, which the host user the container runs as cannot write.
const CLEAN_ENV = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/tmp/container-home', npm_config_cache: '/tmp/container-home/.npm' })
// mounts: [{ source, target, readonly }]; network: 'none' | 'bridge'
export function containerArgs({ image = SANDBOX_IMAGE, mounts = [], network = 'none', workdir = '/work', command, user = null }) {
  if (!Array.isArray(command) || !command.length) throw new Error('container command is required')
  return ['run', '--rm', '--init', '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...(user ? ['--user', user] : []), '-w', workdir,
    ...Object.entries(CLEAN_ENV).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...mounts.flatMap(mount => ['-v', `${mount.source}:${mount.target}${mount.readonly ? ':ro' : ''}`]), image, ...command]
}
export function runContainer(spec, { command = runTimed, label = 'container command', timeoutMs = 20 * 60 * 1000 } = {}) {
  const result = command('docker', containerArgs(spec), { env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST }, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
  return requireCommand(result, label)
}
// Read HEAD of an untrusted workspace repository over a copy, inside a container, never with host Git.
export function readHeadInContainer({ copyDir, run = runContainer }) {
  const result = run({ mounts: [{ source: copyDir, target: '/repo', readonly: true }], workdir: '/repo', command: ['git', '-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', '/repo', 'rev-parse', 'HEAD'] }, { label: 'workspace HEAD lookup' })
  const head = String(result.stdout ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('workspace HEAD lookup returned no commit')
  return head
}
