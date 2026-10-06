import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { open, mkdir, copyFile, lstat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { SUITE_ROOT, contained, filesUnder } from './files.mjs'
import { runnerConfig, RUNNER_SETTINGS } from './profiles.mjs'
import { writeTextAtomic } from './persistence.mjs'
import { runTimed, requireCommand } from './subprocess.mjs'
export const STAGED_FILES = ['starting-repo.bundle', 'sandbox-driver.sh', 'bootstrap-agent-skills.sh', 'prepare-agent-session-state.sh', 'runner-config.yaml', 'runner-settings.yaml']
// No inherited host behaviour/configuration or GitHub secrets reach Docker.
export function sandboxEnvironment(env = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'].filter(key => env[key] !== undefined).map(key => [key, env[key]]))
}
export class LocalSandbox {
  constructor({ runDir, runnerDir, skillsDir, env = process.env, command = runTimed }) {
    this.command = command
    this.runDir = resolve(runDir); this.runnerDir = resolve(runnerDir); this.skillsDir = resolve(skillsDir)
    this.artifactDir = join(this.runDir, 'sandbox'); this.exchangeDir = join(this.artifactDir, 'exchange'); this.env = sandboxEnvironment(env)
  }
  async stage(inputDir) {
    this.inputDir = resolve(inputDir)
    const files = (await filesUnder(this.inputDir)).map(path => path.slice(this.inputDir.length + 1)).sort()
    if (JSON.stringify(files) !== JSON.stringify([...STAGED_FILES].sort())) throw new Error(`sandbox input allowlist mismatch: ${files.join(', ')}`)
    await mkdir(this.exchangeDir, { recursive: true })
  }
  args(profiles, mode = { kind: 'fresh' }, dryRun = false) {
    const selected = [...new Set(Object.values(profiles).map(profile => profile.cli))]
    return [join(this.runnerDir, 'scripts/sandbox-run.sh'), ...(dryRun ? ['--dry-run'] : []), '--no-default-secrets', '--auth-only', '--hide-source', '--input-dir', this.inputDir, '--artifact-dir', this.artifactDir,
      '--docker-run-arg', '-v', '--docker-run-arg', `${this.skillsDir}:/agent-skills:ro`, ...selected.map(cli => `--mount-${cli}-auth`), '--', 'bash', '/eval-input/sandbox-driver.sh', '/artifacts', '/agent-skills', mode.kind, mode.runId ?? '', ...selected]
  }
  plan(profiles, mode) {
    const args = this.args(profiles, mode, true)
    const output = requireCommand(this.command('bash', args, { env: this.env, maxBuffer: 16 * 1024 * 1024 }), 'sandbox dry-run').stdout
    return { command: ['bash', ...args], output }
  }
  async isActive() {
    const ids = requireCommand(this.command('docker', ['ps', '--quiet'], { env: this.env }), 'Docker active-run probe').stdout.trim().split('\n').filter(Boolean)
    if (!ids.length) return false
    const containers = JSON.parse(requireCommand(this.command('docker', ['inspect', ...ids], { env: this.env }), 'Docker active-run inspection').stdout)
    let artifactPath
    try { artifactPath = realpathSync(this.artifactDir) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // A container can still retain its bind mount after the host directory
      // disappears. Resolve the parent to keep matching that mount on macOS.
      try { artifactPath = join(realpathSync(this.runDir), 'sandbox') } catch (parentError) {
        if (parentError.code !== 'ENOENT') throw parentError
        artifactPath = this.artifactDir
      }
    }
    return containers.some(container => container.Mounts?.some(mount => mount.Source === artifactPath || mount.Source === this.artifactDir))
  }
  async start(profiles, mode) {
    const log = await open(join(this.runDir, 'logs/sandbox.log'), 'a')
    try {
      this.child = spawn('bash', this.args(profiles, mode), { env: this.env, detached: true, stdio: ['ignore', log.fd, log.fd] })
      this.completion = new Promise((resolve, reject) => {
        this.child.once('error', reject)
        this.child.once('exit', (code, signal) => resolve({ code, signal }))
      })
    } finally { await log.close() }
  }
  wait() { return this.completion }
  async stop() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return
    try { process.kill(-this.child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    const timer = setTimeout(() => { try { process.kill(-this.child.pid, 'SIGKILL') } catch {} }, 5000)
    try { await this.completion } finally { clearTimeout(timer) }
  }
  async retrieve(paths) {
    const output = []
    for (const path of paths) {
      const source = contained(this.artifactDir, path)
      // Reject redirected files and their ancestors in the untrusted sandbox.
      let probe = source
      while (probe !== this.artifactDir) {
        if ((await lstat(probe)).isSymbolicLink()) throw new Error(`sandbox retrieve refuses symlink: ${probe}`)
        probe = dirname(probe)
      }
      const target = contained(join(this.runDir, 'evidence'), path)
      await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); output.push(target)
    }
    return output
  }
}
export async function stageRuntime({ inputDir, bundlePath, profiles, suiteRoot = SUITE_ROOT }) {
  await mkdir(inputDir, { recursive: false })
  await copyFile(bundlePath, join(inputDir, 'starting-repo.bundle'))
  for (const file of ['sandbox-driver.sh', 'bootstrap-agent-skills.sh', 'prepare-agent-session-state.sh']) await copyFile(join(suiteRoot, file), join(inputDir, file))
  await writeTextAtomic(join(inputDir, 'runner-config.yaml'), runnerConfig(profiles))
  await writeTextAtomic(join(inputDir, 'runner-settings.yaml'), RUNNER_SETTINGS)
}
