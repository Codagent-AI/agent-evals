import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { LocalSandbox } from '../../and-scene-define/lib/sandbox.mjs'
import { writeTextAtomic } from '../../and-scene-define/lib/persistence.mjs'
import { DEFINE_ROOT, SUITE_ROOT, CHANGE_NAME } from './files.mjs'
import { DEFAULT_ROLES } from './options.mjs'
export const STAGED_FILES = ['starting-repo.bundle', 'sandbox-driver.sh', 'bootstrap-agent-skills.sh', 'prepare-agent-session-state.sh', 'runner-config.yaml', 'runner-settings.yaml']
export const TOKEN_MOUNT_TARGET = '/github-auth'
const INTERACTIVE_ROLES = new Set(['lead'])
export const RUNNER_SETTINGS = 'autonomous_permission_mode: yolo\n'
// Only the lead answers the simulated user; every other role runs autonomously.
export function runnerConfig(profiles, roles = Object.keys(profiles)) {
  return `profiles:\n  default:\n    agents:\n${roles.map(role => `      ${role}:\n        default_mode: ${INTERACTIVE_ROLES.has(role) ? 'interactive' : 'autonomous'}\n${['cli', 'model', 'effort'].map(key => `        ${key}: ${JSON.stringify(profiles[role][key])}\n`).join('')}`).join('')}`
}
// The CLI the starting tree's Agent Validator reviews with, from its configuration.
export function validatorReviewerClis(configText) {
  const preference = configText.match(/default_preference:\s*\n((?:\s+-\s*\S+\s*\n)+)/)
  const clis = preference ? [...preference[1].matchAll(/-\s*(\S+)/g)].map(match => match[1]) : []
  if (!clis.length) throw new Error('Validator configuration names no reviewer CLI (cli.default_preference)')
  return [clis[0]]
}
export async function readValidatorReviewerClis(suiteRoot = DEFINE_ROOT) {
  return validatorReviewerClis(await readFile(join(suiteRoot, 'starting-repo/tree/.validator/config.yml'), 'utf8'))
}
export class E2ESandbox extends LocalSandbox {
  constructor(options) {
    super(options)
    Object.assign(this, { tokenDir: resolve(options.tokenDir ?? join(options.runDir, '.github-auth')), reviewerClis: options.reviewerClis ?? ['claude'], workflow: options.workflow, deliveryUrl: options.deliveryUrl })
  }
  async stage(inputDir) {
    this.inputDir = resolve(inputDir)
    const { filesUnder } = await import('./files.mjs')
    const files = (await filesUnder(this.inputDir)).map(path => path.slice(this.inputDir.length + 1)).sort()
    if (JSON.stringify(files) !== JSON.stringify([...STAGED_FILES].sort())) throw new Error(`sandbox input allowlist mismatch: ${files.join(', ')}`)
    await mkdir(this.exchangeDir, { recursive: true })
  }
  clis(profiles) { return [...new Set([...Object.values(profiles).map(profile => profile.cli), ...this.reviewerClis])] }
  // The Validator reviewer's authentication is mounted whatever the role profiles are.
  args(profiles, mode = { kind: 'fresh' }, dryRun = false) {
    const selected = this.clis(profiles)
    const until = mode.kind === 'fresh' ? 'define' : mode.until
    return [join(this.runnerDir, 'scripts/sandbox-run.sh'), ...(dryRun ? ['--dry-run'] : []), '--no-default-secrets', '--auth-only', '--hide-source', '--input-dir', this.inputDir, '--artifact-dir', this.artifactDir,
      '--docker-run-arg', '-v', '--docker-run-arg', `${this.skillsDir}:/agent-skills:ro`,
      '--docker-run-arg', '-v', '--docker-run-arg', `${this.tokenDir}:${TOKEN_MOUNT_TARGET}:ro`,
      ...selected.map(cli => `--mount-${cli}-auth`), '--', 'bash', '/eval-input/sandbox-driver.sh', '/artifacts', '/agent-skills', mode.kind, mode.runId ?? '', until, this.workflow, this.deliveryUrl, ...selected]
  }
  extraMounts() { return [{ source: this.tokenDir, target: TOKEN_MOUNT_TARGET, ro: true }] }
}
export async function stageRuntime({ inputDir, bundlePath, profiles, roles = DEFAULT_ROLES }) {
  await mkdir(inputDir, { recursive: false })
  await copyFile(bundlePath, join(inputDir, 'starting-repo.bundle'))
  await copyFile(join(SUITE_ROOT, 'sandbox-driver.sh'), join(inputDir, 'sandbox-driver.sh'))
  for (const file of ['bootstrap-agent-skills.sh', 'prepare-agent-session-state.sh']) await copyFile(join(DEFINE_ROOT, file), join(inputDir, file))
  await writeTextAtomic(join(inputDir, 'runner-config.yaml'), runnerConfig(profiles, roles))
  await writeTextAtomic(join(inputDir, 'runner-settings.yaml'), RUNNER_SETTINGS)
}
export { CHANGE_NAME }
