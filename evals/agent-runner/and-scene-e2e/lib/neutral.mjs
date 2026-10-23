// The identity-neutral judge inputs: the delivered source (from the retained bundle, never the candidate's
// own change directory) and one requirement document per graded inventory item.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gitCommand } from './provisioning.mjs'
import { hashJson, writeJsonAtomic } from '../../and-scene-define/lib/persistence.mjs'
import { sha256 } from './files.mjs'
import { graded, requirementDocument } from './product-rubric.mjs'
const HARNESS_GIT = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const MAX_SOURCE_BYTES = 1024 * 1024
const excluded = path => /(^|\/)(node_modules|\.git)(\/|$)/.test(path) || path.startsWith('.agent-runner/') || path.startsWith('openspec/changes/')
export async function materializeNeutral({ runDir, repo, commit, inventory }) {
  const root = join(runDir, 'neutral/judge')
  await rm(join(runDir, 'neutral'), { recursive: true, force: true })
  const sourceRoot = join(root, 'source'); const requirementsRoot = join(root, 'requirements')
  await mkdir(sourceRoot, { recursive: true }); await mkdir(requirementsRoot, { recursive: true }); await mkdir(join(root, 'audit'), { recursive: true }); await mkdir(join(runDir, 'neutral/provenance'), { recursive: true })
  const listing = (await gitCommand(['-C', repo, 'ls-tree', '-r', '-z', commit], { env: HARNESS_GIT })).split('\0').filter(Boolean)
  const entries = []
  for (const line of listing) {
    const [meta, path] = line.split('\t')
    const [mode, type] = meta.split(' ')
    if (type !== 'blob' || !/^100[0-7]{3}$/.test(mode) || excluded(path)) continue
    const bytes = await gitCommand(['-C', repo, 'cat-file', 'blob', `${commit}:${path}`], { env: HARNESS_GIT, encoding: 'buffer' })
    if (bytes.length > MAX_SOURCE_BYTES || bytes.includes(0)) continue
    const target = join(sourceRoot, path)
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
    entries.push({ namespace: 'neutral-source', path: `source/${path}`, sha256: sha256(bytes) })
  }
  for (const item of inventory.items.filter(graded)) {
    const text = requirementDocument(item)
    await writeFile(join(requirementsRoot, `${item.id}.md`), text)
    entries.push({ namespace: 'neutral-requirements', path: `requirements/${item.id}.md`, sha256: sha256(Buffer.from(text)) })
  }
  const manifest = { schema_version: 1, source_revision: commit, entries, exclusions: { git_metadata: true, candidate_change_directory: true, preference_items: true } }
  manifest.manifest_sha256 = hashJson(manifest)
  await writeJsonAtomic(join(runDir, 'neutral/provenance/manifest.json'), manifest)
  return { root, source_root: sourceRoot, requirements_root: requirementsRoot, audit_root: join(root, 'audit'), manifest, source_paths: entries.filter(entry => entry.namespace === 'neutral-source').map(entry => entry.path.slice('source/'.length)).sort() }
}
