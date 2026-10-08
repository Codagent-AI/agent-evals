import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, chmod, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, relative, resolve } from 'node:path'
import { SUITE_ROOT, readJson, filesUnder, contained, sha256 } from './files.mjs'
import { FIXTURE } from './fixture.mjs'
export const CHANGE_NAME = 'add-presentation-skill'
const environment = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Scaffold', GIT_AUTHOR_EMAIL: 'scaffold@example.invalid',
  GIT_COMMITTER_NAME: 'Scaffold', GIT_COMMITTER_EMAIL: 'scaffold@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
}
// Inherited Git variables must not redirect the repository or inject config.
for (const name of Object.keys(environment)) if (name.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'].includes(name)) delete environment[name]
// Auto maintenance is off: since Git 2.47 a commit can leave a detached
// `git maintenance` process writing under .git/objects after it returns.
export function repoGit(cwd, args, options = {}) {
  const output = execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'core.excludesFile=/dev/null', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  return typeof output === 'string' ? output.trim() : output
}
export async function initializeTree(repoDir, expectedFileCount) {
  if (!Number.isInteger(expectedFileCount) || expectedFileCount < 1) throw new Error('expected snapshot file count is required')
  repoGit(repoDir, ['init', '--template=', '--object-format=sha1', '--initial-branch=main'])
  repoGit(repoDir, ['add', '--all', '--force'])
  const count = repoGit(repoDir, ['ls-files', '-z']).split('\0').filter(Boolean).length
  if (count !== expectedFileCount) throw new Error(`staged file count mismatch: expected ${expectedFileCount}, found ${count}`)
  return repoGit(repoDir, ['write-tree'])
}
export async function snapshotFiles({ suiteRoot = SUITE_ROOT } = {}) {
  const root = join(suiteRoot, 'starting-repo/tree')
  const manifest = await readJson(join(suiteRoot, 'starting-repo/manifest.json'))
  if (JSON.stringify(manifest.source) !== JSON.stringify(FIXTURE)) throw new Error('starting snapshot fixture pin differs')
  if (manifest.change_name !== CHANGE_NAME) throw new Error('starting snapshot change name differs')
  const paths = (await filesUnder(root)).map(file => relative(root, file).split('\\').join('/')).sort()
  if (JSON.stringify(paths) !== JSON.stringify([...manifest.allowlist].sort()) || JSON.stringify(paths) !== JSON.stringify(manifest.files.map(file => file.path).sort())) throw new Error('snapshot file set differs from allowlist')
  const files = []
  for (const entry of manifest.files) {
    if (/(^|\/)(hidden|calibration|\.git)(\/|$)|contamination-patterns\.json|manifest\.json/.test(entry.path)) throw new Error(`forbidden snapshot path: ${entry.path}`)
    if (!['100644', '100755'].includes(entry.mode)) throw new Error(`invalid snapshot file mode: ${entry.path}`)
    const content = await readFile(contained(root, entry.path))
    if (sha256(content) !== entry.sha256) throw new Error(`snapshot content hash mismatch: ${entry.path}`)
    files.push({ ...entry, content })
  }
  return { manifest, files }
}
async function copyTree(repoDir, files) {
  await mkdir(repoDir, { recursive: true })
  for (const file of files) {
    const target = contained(repoDir, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content)
    await chmod(target, file.mode === '100755' ? 0o755 : 0o644)
  }
}
export async function verifySnapshot(options = {}) {
  const { manifest, files } = await snapshotFiles(options)
  const temporary = await mkdtemp(join(tmpdir(), 'define-tree-'))
  try {
    await copyTree(temporary, files)
    const hash = await initializeTree(temporary, manifest.files.length)
    if (hash !== manifest.tree_hash) throw new Error(`snapshot tree hash mismatch: ${hash}`)
    return hash
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
export async function materialize(outDir, options = {}) {
  const { manifest, files } = await snapshotFiles(options)
  // Reserve a fresh staging directory; never merge with existing staged files.
  outDir = resolve(outDir)
  await mkdir(outDir, { recursive: false })
  if ((await lstat(outDir)).isSymbolicLink()) throw new Error('staging directory cannot be a symlink')
  const repoDir = join(outDir, 'repository')
  try {
    await copyTree(repoDir, files)
    const treeHash = await initializeTree(repoDir, manifest.files.length)
    if (treeHash !== manifest.tree_hash) throw new Error('materialized tree differs from pinned tree hash')
    repoGit(repoDir, ['commit', '-m', 'chore: initialize project scaffold'])
    const commit = repoGit(repoDir, ['rev-parse', 'HEAD'])
    repoGit(repoDir, ['checkout', '-b', CHANGE_NAME])
    const bundlePath = join(outDir, 'starting.bundle')
    repoGit(repoDir, ['bundle', 'create', bundlePath, '--all'])
    return { repoDir, bundlePath, commit, treeHash }
  } catch (error) {
    await rm(outDir, { recursive: true, force: true })
    throw error
  }
}
