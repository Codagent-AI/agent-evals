// Preflight: every check runs before any model call or repository creation, and a failure names its check.
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoGit } from '../../../lib/define-run/starting-repo.mjs'
import { inspectEvaluatorInputs, selectedCredentials } from '../../../lib/define-run/preflight.mjs'
import { runTimed, requireCommand } from '../../../lib/define-run/subprocess.mjs'
import { JUDGE_PROFILE } from '../../../lib/define-run/profiles.mjs'
import { PANEL_PROTOCOL } from '../../../lib/panel-judging/panel.mjs'
import { PRODUCT_JUDGE_PROFILE } from '../../and-scene/lib/judge-profile.mjs'
import { DEFINE_ROOT, SUITE_ROOT, readJson, sha256 } from './files.mjs'
import { checkProductInputs, loadProductInputs } from './product-rubric.mjs'
import { checkVersions, loadVersions } from './versions.mjs'
import { checkWorkflow } from './workflow.mjs'
import { validateProfiles } from './options.mjs'
import { readValidatorReviewerClis } from './sandbox.mjs'
import { GitHubApp, checkInstallationPermissions, checkReach, loadAppCredentials } from './provisioning.mjs'
export class PreflightError extends Error {
  constructor(check, message) { super(`preflight ${check}: ${message}`); this.check = check; this.owner = 'evaluation-harness' }
}
const guard = async (check, run) => { try { return await run() } catch (error) { throw error instanceof PreflightError ? error : new PreflightError(check, error.message) } }
function cleanCommit(path, name) {
  if (repoGit(path, ['status', '--porcelain', '--untracked-files=all'])) throw new Error(`${name} checkout is not clean: ${path}`)
  return repoGit(path, ['rev-parse', 'HEAD'])
}
export function verifyCapabilities(runnerHelp, sandboxHelp) {
  for (const option of ['--external-user', '--until']) if (!runnerHelp.includes(option)) throw new Error(`Agent Runner capability: missing ${option}`)
  for (const option of ['--auth-only', '--hide-source', '--no-default-secrets', '--input-dir', '--artifact-dir', '--docker-run-arg']) if (!sandboxHelp.includes(option)) throw new Error(`sandbox capability: missing ${option}`)
}
async function runnerHelp({ runnerDir, command, env }) {
  const prebuilt = join(runnerDir, 'bin/agent-runner')
  if (existsSync(prebuilt)) { const help = requireCommand(command(prebuilt, ['--help'], { env }), 'Runner help'); return help.stdout + help.stderr }
  const probe = await mkdtemp(join(tmpdir(), 'e2e-runner-probe-'))
  try {
    const binary = join(probe, 'agent-runner')
    requireCommand(command('go', ['build', '-o', binary, './cmd/agent-runner'], { cwd: runnerDir, env, maxBuffer: 16 * 1024 * 1024 }), 'Runner host build')
    const help = requireCommand(command(binary, ['--help'], { env }), 'Runner help')
    return help.stdout + help.stderr
  } finally { await rm(probe, { recursive: true, force: true }) }
}
const regularAuth = async path => { const stat = await lstat(path).catch(() => null); if (!stat?.isFile() || stat.size === 0) throw new Error(`missing regular credential file ${path}`) }
export async function productSeriesParts({ suiteRoot = SUITE_ROOT } = {}) {
  const inputs = await loadVersions(suiteRoot)
  const { rubric } = await loadProductInputs({ suiteRoot })
  const humanRubricPath = join(suiteRoot, '../and-scene/human-rubric.json')
  const human = await readJson(humanRubricPath)
  return { versions: inputs, product_rubric: { id: rubric.rubric_id, version: rubric.version, sha256: inputs['product-rubric'].hashes[inputs['product-rubric'].version] },
    human_rubric: { version: human.version ?? human.rubric_version ?? null, sha256: sha256(await readFile(humanRubricPath)) } }
}
// All probes are read-only and finish before sandbox dispatch, repository creation or any model call.
export async function inspectInputs({ profiles, workflow, runnerDir, skillsDir, suiteRoot = SUITE_ROOT, defineRoot = DEFINE_ROOT, dryRun = false, home = homedir(), env = process.env, command = runTimed, app = null, appFactory = null }) {
  const checked = await guard('workflow', () => checkWorkflow({ runnerDir, reference: workflow }))
  await guard('profiles', async () => validateProfiles(profiles, checked.roles))
  const runnerCommit = await guard('Agent Runner checkout', async () => cleanCommit(runnerDir, 'Agent Runner'))
  const skillsCommit = await guard('Agent Skills checkout', async () => cleanCommit(skillsDir, 'Agent Skills'))
  await guard('Agent Skills', async () => { for (const skill of checked.skills) { const path = join(skillsDir, 'skills', skill, 'SKILL.md'); if (!(await lstat(path).catch(() => null))?.isFile() || !(await readFile(path, 'utf8')).trim()) throw new Error(`missing required codagent:${skill}`) } })
  await guard('pinned inputs', async () => { const errors = await checkVersions({ suiteRoot }); if (errors.length) throw new Error(errors.join('; ')) })
  await guard('product rubric', async () => { const errors = await checkProductInputs({ suiteRoot, defineRoot }); if (errors.length) throw new Error(errors.join('; ')) })
  const reviewerClis = await guard('Validator configuration', () => readValidatorReviewerClis(defineRoot))
  const sandboxHelp = await guard('sandbox capability', async () => requireCommand(command('bash', [join(runnerDir, 'scripts/sandbox-run.sh'), '--help'], { env }), 'sandbox help').stdout)
  const help = await guard('Agent Runner capability', () => runnerHelp({ runnerDir, command, env }))
  await guard('Agent Runner capability', async () => verifyCapabilities(help, sandboxHelp))
  if (!dryRun) await guard('Docker', async () => requireCommand(command('docker', ['info'], { env }), 'Docker availability'))
  const all = { ...profiles, validator: { cli: reviewerClis[0] } }
  const claudeFile = join(home, '.claude/.credentials.json')
  const needsClaude = selectedCredentials(all, home).includes(claudeFile)
  const claudeToken = needsClaude && !(await lstat(claudeFile).catch(() => null))?.isFile() && Boolean(env.CLAUDE_CODE_OAUTH_TOKEN)
  await guard('Validator reviewer authentication', async () => {
    if (needsClaude && !claudeToken && !(await lstat(claudeFile).catch(() => null))?.isFile()) throw new Error(`missing Claude authentication for the CLI ${reviewerClis[0] === 'claude' && !Object.values(profiles).some(p => p.cli === 'claude') ? 'the Validator reviews with' : 'the roles use'}: add ${claudeFile} or set CLAUDE_CODE_OAUTH_TOKEN from claude setup-token`)
    if (claudeToken && !sandboxHelp.includes('CLAUDE_CODE_OAUTH_TOKEN')) throw new Error('the Runner sandbox does not forward CLAUDE_CODE_OAUTH_TOKEN')
  })
  const credentials = selectedCredentials(all, home).filter(path => !(claudeToken && path === claudeFile))
  for (const path of credentials) await guard('authentication', () => regularAuth(path))
  if (!dryRun) await guard('judge and simulated-user authentication', async () => {
    await regularAuth(join(home, '.codex/auth.json'))
    for (const cli of ['claude', 'codex']) requireCommand(command(cli, ['--version'], { env }), `host ${cli} availability`)
    requireCommand(command('claude', ['auth', 'status'], { env }), 'host claude login')
  })
  // Provisioning credentials and their reach: the installation may reach delivery repositories only.
  const provisioning = await guard('provisioning credentials', async () => {
    const github = app ?? (appFactory ?? (options => new GitHubApp(options)))({ ...await loadAppCredentials(env), apiUrl: env.AND_SCENE_E2E_GITHUB_API ?? 'https://api.github.com' })
    const { token } = await github.provisioningToken()
    return { app: github, token }
  })
  await guard('provisioning credentials', () => checkInstallationPermissions(provisioning.app))
  await checkReach(provisioning.app, provisioning.token).catch(error => { throw error.check ? new PreflightError(error.check, error.message.replace(/^[^:]+: /, '')) : error })
  const { seriesIdentity: defineIdentity } = await guard('hidden inputs', () => inspectEvaluatorInputs({ suiteRoot: defineRoot, dryRun }))
  const parts = await productSeriesParts({ suiteRoot })
  const { contamination_patterns: _define, ...rest } = defineIdentity
  const seriesIdentity = { ...rest, starting_tree_hash: defineIdentity.starting_tree_hash, definition_rubric: defineIdentity.rubric, contamination_patterns: parts.versions['contamination-patterns'].version, product_rubric: parts.product_rubric, human_rubric: parts.human_rubric,
    judge_profiles: { definition: JUDGE_PROFILE, product: PRODUCT_JUDGE_PROFILE }, panel_protocol: PANEL_PROTOCOL, e2e_input_versions: Object.fromEntries(Object.entries(parts.versions).map(([name, record]) => [name, { version: record.version, sha256: record.hashes[record.version] }])) }
  const reviewerConfig = await readFile(join(defineRoot, 'starting-repo/tree/.validator/config.yml'))
  const candidate = { profiles, agent_runner_commit: runnerCommit, workflow: { reference: workflow, name: checked.name, hash: checked.hash, define_hash: checked.define_hash }, agent_skills_commit: skillsCommit, validator_reviewer: { clis: reviewerClis, config_sha256: sha256(reviewerConfig) } }
  return { seriesIdentity, candidate, credentials, forwardedEnv: claudeToken ? ['CLAUDE_CODE_OAUTH_TOKEN'] : [], reviewerClis, workflow: checked, provisioning, requiredSkills: checked.skills }
}
