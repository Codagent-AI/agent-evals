import { readFile, readdir, lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { repoGit, verifySnapshot } from './starting-repo.mjs'
import { assertPinnedInventory } from './inventory.mjs'
import { readJson, sha256, SUITE_ROOT } from './files.mjs'
import { SIMULATED_USER_PROFILE } from './simulated-user.mjs'
import { JUDGE_PROFILE, validateProfiles } from './profiles.mjs'
import { runTimed, requireCommand } from './subprocess.mjs'
export { verifyMountPlan } from './mount-plan.mjs'
export function verifyCapabilities(runnerHelp, sandboxHelp) {
  if (!runnerHelp.includes('--external-user')) throw new Error('Runner capability: missing --external-user')
  for (const option of ['--auth-only', '--hide-source', '--no-default-secrets', '--input-dir', '--artifact-dir']) if (!sandboxHelp.includes(option)) throw new Error(`sandbox capability: missing ${option}`)
}
export function verifyWorkflow(text, steps, name) {
  const section = text.match(/^steps:\s*\n([\s\S]*)/m)?.[1]
  if (!section) throw new Error(`workflow ${name}: missing steps`)
  const ids = [...section.matchAll(/^  - id:\s*([a-z0-9-]+)\s*$/gm)].map(match => match[1])
  for (const step of steps) if (!ids.includes(step)) throw new Error(`workflow ${name}: missing step ${step}`)
}
function cleanCommit(path, name) {
  if (repoGit(path, ['status', '--porcelain', '--untracked-files=all'])) throw new Error(`${name} checkout is not clean: ${path}`)
  return repoGit(path, ['rev-parse', 'HEAD'])
}
async function workflowFile(runnerDir, group, name) {
  const directory = join(runnerDir, 'workflows', group)
  const files = (await readdir(directory)).filter(file => new RegExp(`^${name}-v[0-9.]+\\.yaml$`).test(file)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (!files.length) throw new Error(`workflow ${group}:${name}: missing workflow file`)
  return join(directory, files.at(-1))
}
async function requiredSkills(path, root, visited = new Set()) {
  if (visited.has(path)) return []
  if (!resolve(path).startsWith(`${resolve(root)}/`)) throw new Error(`workflow reference outside Runner workflows: ${path}`)
  visited.add(path)
  const text = await readFile(path, 'utf8')
  const skills = [...text.matchAll(/codagent:([a-z0-9-]+)/g)].map(match => match[1])
  for (const match of text.matchAll(/^\s{4}workflow:\s*["']?([^\s"'#]+)/gm)) {
    const ref = match[1]
    if (ref.includes('{{') || ref.includes('$')) throw new Error(`unresolved workflow reference: ${ref}`)
    const next = ref.startsWith('builtin:') ? resolve(root, ref.slice(8)) : resolve(dirname(path), ref)
    skills.push(...await requiredSkills(next, root, visited))
  }
  return [...new Set(skills)].sort()
}
export function selectedCredentials(profiles, home = homedir()) {
  return [...new Set(Object.values(profiles).map(profile => profile.cli))].map(cli => join(home, { claude: '.claude/.credentials.json', codex: '.codex/auth.json', cursor: '.cursor/auth.json' }[cli]))
}
async function regularAuth(path) {
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.size === 0) throw new Error(`authentication: missing regular credential file ${path}`)
}
// All paid-run probes are read-only and finish before sandbox/model dispatch.
export async function inspectInputs({ profiles, runnerDir, skillsDir, suiteRoot = SUITE_ROOT, dryRun = false, home = homedir(), env = process.env, command = runTimed, rubricChecks = async () => {} }) {
  validateProfiles(profiles)
  const runnerCommit = cleanCommit(runnerDir, 'Agent Runner')
  const skillsCommit = cleanCommit(skillsDir, 'Agent Skills')
  const changePath = await workflowFile(runnerDir, 'openspec', 'change')
  const definePath = await workflowFile(runnerDir, 'core', 'define-change')
  const change = await readFile(changePath, 'utf8'); const define = await readFile(definePath, 'utf8')
  verifyWorkflow(change, ['create', 'define'], 'openspec:change')
  verifyWorkflow(define, ['proposal', 'specs', 'design', 'test-plan', 'approach-review'], 'core:define-change')
  if (!change.includes(`workflow: ../core/${definePath.split('/').at(-1)}`)) throw new Error('workflow openspec:change does not invoke the checked core:define-change')
  const skills = await requiredSkills(definePath, join(runnerDir, 'workflows'))
  for (const skill of skills) {
    const path = join(skillsDir, 'skills', skill, 'SKILL.md')
    if (!(await lstat(path).catch(() => null))?.isFile() || !(await readFile(path, 'utf8')).trim()) throw new Error(`Agent Skills: missing required codagent:${skill}`)
  }
  // Validate the manifests used by each selected CLI before its installer runs.
  const marketplace = await readJson(join(skillsDir, '.claude-plugin/marketplace.json'))
  const plugin = marketplace.plugins?.find(entry => entry.name === 'codagent')
  if (!plugin || typeof plugin.source !== 'string' || resolve(skillsDir, plugin.source) !== resolve(skillsDir)) throw new Error('Agent Skills: codagent marketplace must export the checkout root')
  for (const cli of new Set(Object.values(profiles).map(profile => profile.cli))) {
    if (cli === 'claude') continue
    const manifest = await readJson(join(skillsDir, `.${cli}-plugin/plugin.json`))
    if (manifest.name !== 'codagent' || (cli === 'codex' && resolve(skillsDir, manifest.skills ?? '') !== join(skillsDir, 'skills'))) throw new Error(`Agent Skills: invalid ${cli} plugin manifest`)
  }
  const sandboxHelp = requireCommand(command('bash', [join(runnerDir, 'scripts/sandbox-run.sh'), '--help'], { env }), 'sandbox help').stdout
  // Probe the actual checkout, rather than an unrelated installed Runner build.
  const probeDir = await mkdtemp(join(tmpdir(), 'define-runner-probe-'))
  let runnerHelp
  try {
    const binary = join(probeDir, 'agent-runner')
    requireCommand(command('go', ['build', '-o', binary, './cmd/agent-runner'], { cwd: runnerDir, env, maxBuffer: 16 * 1024 * 1024 }), 'Runner host build')
    const help = requireCommand(command(binary, ['--help'], { env }), 'Runner help')
    runnerHelp = help.stdout + help.stderr
  } finally { await rm(probeDir, { recursive: true, force: true }) }
  verifyCapabilities(runnerHelp, sandboxHelp)
  if (!dryRun) requireCommand(command('docker', ['info'], { env }), 'Docker availability')
  const credentials = selectedCredentials(profiles, home)
  for (const path of credentials) await regularAuth(path)
  if (!dryRun) {
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.CLAUDE_CODE_API_KEY && !env.ANTHROPIC_API_KEY) await regularAuth(join(home, '.claude/.credentials.json'))
    await regularAuth(join(home, '.codex/auth.json'))
    for (const cli of ['claude', 'codex']) requireCommand(command(cli, ['--version'], { env }), `host ${cli} availability`)
  }
  const inventory = await assertPinnedInventory({ suiteRoot })
  const tree = await verifySnapshot({ suiteRoot })
  await rubricChecks({ suiteRoot, inventory }) // Future inventory-version and calibrated-threshold checks.
  const versions = await readJson(join(suiteRoot, 'versions.json'))
  const reference = await readJson(join(suiteRoot, 'hidden/reference.json'))
  const seriesIdentity = { starting_prompt: versions.inputs['starting-prompt'], starting_tree_hash: tree, reference: { version: reference.commit, commit: reference.commit, files: reference.files, citation_files: reference.citation_files ?? [] }, inventory: versions.inputs.inventory,
    rubric: versions.inputs.rubric ?? null, evaluator_input_versions: versions.inputs, contamination_patterns: versions.inputs['contamination-patterns'], simulated_user_profile: { version: 1, ...SIMULATED_USER_PROFILE }, simulated_user_policy: versions.inputs['simulated-user-policy'], judge_profile: JUDGE_PROFILE }
  const candidate = { profiles, agent_runner_commit: runnerCommit, workflow_hashes: { 'openspec:change': sha256(change), 'core:define-change': sha256(define) }, agent_skills_commit: skillsCommit }
  return { seriesIdentity, candidate, credentials, requiredSkills: skills }
}
