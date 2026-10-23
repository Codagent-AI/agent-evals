// Remote-only delivery verification and retention. Host Git never runs against the agent-written workspace:
// the delivered commit is whatever the delivery repository holds, fetched into a repository the harness made.
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'
import { CHANGE_NAME } from './files.mjs'
import { authenticatedGit, gitCommand } from './provisioning.mjs'
import { writeJsonAtomic } from '../../../lib/define-run/persistence.mjs'
import { guardPath } from '../../../lib/define-run/evidence.mjs'
import { inspectCandidateEvidenceReadiness } from '../../and-scene/lib/evidence.mjs'
import { filesUnder } from '../../../lib/define-run/files.mjs'
import { readHeadInContainer } from './container.mjs'
const BASE = 'main'
const HARNESS_GIT = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
export class DeliveryError extends Error {
  constructor(outcome, { prohibited = [], detail = null } = {}) {
    super(`delivery outcome missing: ${outcome}${detail ? ` (${detail})` : ''}`)
    Object.assign(this, { outcome, prohibited, detail, resumable: false })
  }
}
export class HarnessEvidenceError extends Error {}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// Definition collection: plain files under symlink guards plus the workspace HEAD read in a container over a copy.
export async function collectDefinition({ workspaceRepo, runDir, name = CHANGE_NAME, readHead = readHeadInContainer }) {
  const source = join(workspaceRepo, 'openspec/changes', name)
  await guardPath(runDir, join(runDir, 'sandbox')); await guardPath(runDir, source)
  const staged = join(runDir, '.collected-staging')
  await rm(staged, { recursive: true, force: true }); await mkdir(staged, { recursive: true })
  const files = []
  try {
    // An absent directory is evidence for later gates, not a workflow failure.
    const paths = await filesUnder(source).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const file of paths) {
      const relativePath = relative(source, file).split('\\').join('/')
      const bytes = await readFile(file)
      const target = join(staged, relativePath)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
      files.push({ path: relativePath, sha256: sha256(bytes) })
    }
    // Copy the repository metadata out and read it in a container: its configuration is controlled by the evaluated agents.
    const copy = join(runDir, '.head-copy')
    await rm(copy, { recursive: true, force: true }); await mkdir(copy, { recursive: true })
    try {
      await cp(join(workspaceRepo, '.git'), join(copy, '.git'), { recursive: true, verbatimSymlinks: true })
      var head = await readHead({ copyDir: copy })
    } finally { await rm(copy, { recursive: true, force: true }) }
    await rm(join(runDir, 'collected'), { recursive: true, force: true })
    await cp(staged, join(runDir, 'collected'), { recursive: true })
    const manifest = { head, files }
    await mkdir(join(runDir, 'phases'), { recursive: true })
    await writeJsonAtomic(join(runDir, 'phases/collection.json'), manifest)
    return manifest
  } finally { await rm(staged, { recursive: true, force: true }) }
}
async function fetchBranch({ bare, url, token, ref, git }) {
  try { await git(token, ['-C', bare, 'fetch', '--quiet', '--no-tags', url, `+refs/heads/${ref}:refs/heads/${ref}`]); return true }
  catch (error) { if (/couldn't find remote ref|not found/i.test(`${error.stderr} ${error.message}`)) return false; throw error }
}
// Verify delivery from the delivery repository only. Returns the retained evidence; throws DeliveryError for a missing outcome.
export async function verifyDelivery({ runDir, fullName, url = `https://github.com/${fullName}.git`, token, branch = CHANGE_NAME, name = CHANGE_NAME, api, git = authenticatedGit, sessionDir = null }) {
  const bare = join(runDir, '.delivery.git')
  await rm(bare, { recursive: true, force: true })
  await gitCommand(['init', '--quiet', '--bare', '--template=', bare], { env: HARNESS_GIT })
  const [pulls, refs] = [await api.pulls(), await api.refs()]
  const candidates = pulls.filter(pull => pull.head?.ref === branch)
  await fetchBranch({ bare, url, token, ref: BASE, git })
  const present = await fetchBranch({ bare, url, token, ref: branch, git })
  if (!present) throw new DeliveryError('the candidate branch pushed to the delivery repository', { prohibited: candidates.length ? ['branch deleted'] : [], detail: candidates.length ? 'a pull request exists but its branch is gone' : null })
  const head = (await gitCommand(['-C', bare, 'rev-parse', `refs/heads/${branch}`], { env: HARNESS_GIT })).trim()
  if (!candidates.length) throw new DeliveryError('an open draft pull request for the candidate branch')
  if (candidates.length > 1) throw new DeliveryError('exactly one pull request for the candidate branch', { detail: `${candidates.length} found` })
  const [pull] = candidates
  if (pull.merged_at || pull.merged) throw new DeliveryError('an open draft pull request (it was merged)', { prohibited: ['pull request merged'] })
  if (pull.state !== 'open') throw new DeliveryError('an open draft pull request (it was closed)', { prohibited: ['pull request closed'] })
  if (!pull.draft) throw new DeliveryError('a draft pull request (it was marked ready)', { prohibited: ['pull request marked ready'] })
  if (pull.base?.ref !== BASE) throw new DeliveryError(`a pull request whose base is ${BASE}`, { detail: pull.base?.ref })
  if (pull.head?.sha !== head) throw new DeliveryError('a pull request head equal to the delivered commit', { detail: `${pull.head?.sha} != ${head}` })
  const tree = path => gitCommand(['-C', bare, 'ls-tree', '-r', '--name-only', head, '--', path], { env: HARNESS_GIT }).then(out => out.split('\n').filter(Boolean))
  const present_ = await tree(`openspec/changes/${name}/`)
  if (!present_.length) {
    const archived = (await tree('openspec/changes/archive/')).some(entry => entry.includes(name))
    throw new DeliveryError('the change left unarchived at the delivered commit', { prohibited: archived ? ['change archived'] : [] })
  }
  const heads = refs.filter(ref => ref.ref?.startsWith('refs/heads/')).map(ref => ref.ref.slice('refs/heads/'.length)).filter(ref => ![BASE, branch].includes(ref))
  const extras = { branches: heads, pull_requests: pulls.filter(pull_ => pull_ !== pull).map(pull_ => pull_.number) }
  await mkdir(join(runDir, 'source'), { recursive: true })
  const bundle = join(runDir, 'source/candidate.bundle')
  await rm(bundle, { force: true })
  await gitCommand(['-C', bare, 'bundle', 'create', bundle, BASE, branch], { env: HARNESS_GIT })
  const bundleHash = sha256(await readFile(bundle))
  const acceptance = await retainAcceptance({ runDir, bare, head, sessionDir })
  return { repository: fullName, branch, delivered_commit: head, pull_request: { number: pull.number, draft: true, base: BASE, head }, extras, bundle: { path: 'source/candidate.bundle', sha256: bundleHash }, acceptance }
}
// Acceptance artifacts become guarded plain files recorded against the delivered commit. Missing roles are a
// candidate outcome; an unsafe or unreadable artifact is a harness failure.
export async function retainAcceptance({ runDir, bare, head, sessionDir }) {
  const worktree = join(runDir, '.acceptance-worktree')
  await rm(worktree, { recursive: true, force: true })
  await gitCommand(['clone', '--quiet', '--template=', '--no-checkout', bare, worktree], { env: HARNESS_GIT })
  await gitCommand(['-C', worktree, 'checkout', '--quiet', head], { env: HARNESS_GIT })
  try {
    if (sessionDir) {
      // and-scene's discovery silently skips symlinks; here a redirected artifact or parent is a harness failure.
      try { await guardPath(runDir, sessionDir); await filesUnder(join(sessionDir, 'output')) }
      catch (error) { if (error.code !== 'ENOENT') throw new HarnessEvidenceError(`acceptance evidence is unsafe: ${error.message}`) }
    }
    let readiness
    try { readiness = await inspectCandidateEvidenceReadiness({ worktree, sessionDir }) }
    catch (error) { throw new HarnessEvidenceError(`acceptance evidence is unreadable: ${error.message}`) }
    if (readiness.findings.some(finding => finding.code === 'unsafe-artifact' || finding.kind === 'unsafe-artifact' || /unsafe-artifact/.test(JSON.stringify(finding)))) throw new HarnessEvidenceError('an acceptance artifact is outside an approved root')
    const root = join(runDir, 'evidence/final/acceptance')
    await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true })
    const artifacts = []
    for (const [index, artifact] of readiness.artifacts.entries()) {
      let bytes
      try { await guardPath(await realpath(runDir), artifact.path); bytes = await readFile(artifact.path) }
      catch (error) { throw new HarnessEvidenceError(`acceptance artifact is unreadable: ${error.message}`) }
      const file = `${String(index).padStart(3, '0')}-${artifact.role}-${basename(artifact.path)}`
      await writeFile(join(root, file), bytes)
      artifacts.push({ role: artifact.role, file: `evidence/final/acceptance/${file}`, sha256: sha256(bytes) })
    }
    const record = { delivered_commit: head, artifacts, missing_roles: readiness.missing_roles, findings: readiness.findings }
    await writeJsonAtomic(join(root, 'readiness.json'), record)
    return record
  } finally { await rm(worktree, { recursive: true, force: true }) }
}
// Later phases clone from the retained bundle; neither GitHub nor the sandbox is read again.
export async function cloneFromBundle({ runDir, target, bundlePath = join(runDir, 'source/candidate.bundle'), branch = CHANGE_NAME }) {
  await rm(target, { recursive: true, force: true })
  await gitCommand(['clone', '--quiet', '--template=', '--branch', branch, bundlePath, target], { env: HARNESS_GIT })
  return target
}
