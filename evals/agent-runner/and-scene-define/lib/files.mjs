import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
export const SUITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const sha256 = content => createHash('sha256').update(content).digest('hex')
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`)
}
export function contained(root, path) {
  const target = resolve(root, path)
  const rel = relative(resolve(root), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`unsafe relative path: ${path}`)
  return target
}
export async function filesUnder(root) {
  const result = []
  async function walk(path) {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink: ${path}`)
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name))
    } else if (stat.isFile()) result.push(path)
    else throw new Error(`unsupported file: ${path}`)
  }
  await walk(root)
  return result
}
