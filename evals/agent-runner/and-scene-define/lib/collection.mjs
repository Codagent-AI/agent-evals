import { mkdir, readFile, rm, rename } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { filesUnder, contained } from './files.mjs'
import { repoGit, CHANGE_NAME } from './starting-repo.mjs'
import { hashString, writeJsonAtomic, writeTextAtomic } from './persistence.mjs'
export async function collectArtifacts({ repoDir, runDir }) {
  const source = join(repoDir, 'openspec/changes', CHANGE_NAME)
  const staged = join(runDir, '.collected-staging')
  await rm(staged, { recursive: true, force: true }); await mkdir(staged)
  const files = []
  try {
    // An absent directory is evidence for later hard gates, not a workflow failure.
    let paths
    try { paths = await filesUnder(source) } catch (error) { if (error.code !== 'ENOENT') throw error; paths = [] }
    for (const file of paths) {
      const path = relative(source, file)
      const content = await readFile(file)
      const target = contained(staged, path)
      await mkdir(join(target, '..'), { recursive: true }); await writeTextAtomic(target, content)
      files.push({ path: path.split('\\').join('/'), sha256: hashString(content) })
    }
    const manifest = { head: repoGit(repoDir, ['rev-parse', 'HEAD']), files }
    await rm(join(runDir, 'collected'), { recursive: true, force: true }); await rename(staged, join(runDir, 'collected'))
    await mkdir(join(runDir, 'phases'), { recursive: true })
    await writeJsonAtomic(join(runDir, 'phases/collection.json'), manifest)
    return manifest
  } finally { await rm(staged, { recursive: true, force: true }) }
}
