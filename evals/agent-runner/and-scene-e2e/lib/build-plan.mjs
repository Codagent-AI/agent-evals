// How to build and serve the delivered application, determined from the delivered tree's own manifests.
// Nothing here assumes npm, `npm ci`, `npm run build` or a `dist/` directory.
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { runContainer } from './container.mjs'
export class NotEvaluableError extends Error {
  constructor(message) { super(`product not evaluable: ${message}`); this.code = 'product-not-evaluable'; this.owner = 'evaluation-harness'; this.resumable = true }
}
const exists = async path => Boolean(await lstat(path).catch(() => null))
const readManifest = async dir => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8').catch(() => 'null'))
const dependsOnVite = manifest => Boolean(manifest && ['dependencies', 'devDependencies', 'peerDependencies'].some(key => manifest[key]?.vite))
const hasBuild = manifest => typeof manifest?.scripts?.build === 'string' && manifest.scripts.build.trim().length > 0
async function workspaceDirs(root, manifest) {
  const patterns = Array.isArray(manifest?.workspaces) ? manifest.workspaces : manifest?.workspaces?.packages ?? []
  const dirs = []
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/$/, '')
    if (clean.endsWith('/*')) {
      const parent = clean.slice(0, -2)
      for (const entry of await readdir(join(root, parent), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) dirs.push(join(parent, entry.name))
    } else if (!clean.includes('*')) dirs.push(clean)
  }
  return dirs
}
async function packageManager(roots) {
  for (const root of roots) {
    if (await exists(join(root, 'pnpm-lock.yaml'))) return { name: 'pnpm', install: ['pnpm', 'install', '--frozen-lockfile'], run: script => ['pnpm', 'run', script] }
    if (await exists(join(root, 'yarn.lock'))) return { name: 'yarn', install: ['yarn', 'install', '--frozen-lockfile'], run: script => ['yarn', 'run', script] }
    if (await exists(join(root, 'bun.lockb')) || await exists(join(root, 'bun.lock'))) return { name: 'bun', install: ['bun', 'install', '--frozen-lockfile'], run: script => ['bun', 'run', script] }
    if (await exists(join(root, 'package-lock.json'))) return { name: 'npm', install: ['npm', 'ci'], run: script => ['npm', 'run', script] }
  }
  return { name: 'npm', install: ['npm', 'install'], run: script => ['npm', 'run', script] }
}
export async function resolveBuildPlan({ worktree }) {
  const rootManifest = await readManifest(worktree)
  const candidates = []
  for (const dir of ['.', ...await workspaceDirs(worktree, rootManifest)]) {
    const manifest = dir === '.' ? rootManifest : await readManifest(join(worktree, dir))
    if (dependsOnVite(manifest) && hasBuild(manifest)) candidates.push(dir)
  }
  if (!candidates.length) throw new NotEvaluableError('no package that depends on vite and has a build script was found at the root or in a declared workspace')
  if (candidates.length > 1) throw new NotEvaluableError(`more than one application could be built: ${candidates.join(', ')}`)
  const [app] = candidates
  const manager = await packageManager([join(worktree, app), worktree])
  return { schema_version: 1, application_root: app, workspace_root: '.', package_manager: manager.name, install: manager.install, build: manager.run('build'), output: null }
}
async function indexFiles(root) {
  const found = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(path); else if (entry.name === 'index.html') found.push(relative(root, path).split(sep).join('/'))
    }
  }
  await walk(root)
  return found
}
// Install (with network) and build (without) inside a throwaway container over a copy of the worktree.
export async function buildProduct({ worktree, copyDir, plan, run = runContainer, uid = process.getuid?.(), gid = process.getgid?.() }) {
  await rm(copyDir, { recursive: true, force: true })
  await mkdir(copyDir, { recursive: true })
  await cp(worktree, copyDir, { recursive: true, verbatimSymlinks: true, filter: source => !source.split(sep).includes('.git') })
  const before = new Set(await indexFiles(copyDir))
  const user = uid !== undefined ? `${uid}:${gid}` : null
  const workdir = plan.application_root === '.' ? '/work' : `/work/${plan.application_root}`
  const mounts = [{ source: copyDir, target: '/work', readonly: false }]
  const log = []
  const step = (label, command, network, dir) => {
    try { run({ mounts, workdir: dir, network, user, command }, { label }); log.push({ step: label, ok: true }); return true }
    catch (error) { log.push({ step: label, ok: false, error: String(error.message).slice(0, 2000) }); return false }
  }
  if (!step('install', plan.install, 'bridge', '/work')) return { ok: false, reason: 'dependency installation failed', log }
  if (!step('build', plan.build, 'none', workdir)) return { ok: false, reason: 'the build command failed', log }
  const created = (await indexFiles(copyDir)).filter(path => !before.has(path))
  const outputs = [...new Set(created.map(path => path.split('/').slice(0, -1).join('/') || '.'))]
  if (outputs.length === 0) throw new NotEvaluableError('the build wrote no index.html')
  if (outputs.length > 1) throw new NotEvaluableError(`the build wrote index.html in more than one directory: ${outputs.join(', ')}`)
  return { ok: true, output: outputs[0], output_dir: join(copyDir, outputs[0]), log }
}
