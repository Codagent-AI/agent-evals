import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SUITE_ROOT, readJson, sha256 } from './files.mjs'
import { validateVersionRecords } from '../../and-scene-define/lib/versions.mjs'
// Every evaluator input the series identity depends on is pinned by content hash under a version.
// Changing a pinned file without bumping its version, or rewriting history, is an error.
export async function checkVersions({ suiteRoot = SUITE_ROOT, previous = null } = {}) {
  const ledger = await readJson(join(suiteRoot, 'versions.json'))
  const errors = validateVersionRecords(ledger.inputs, previous?.inputs)
  for (const [name, record] of Object.entries(ledger.inputs)) {
    try {
      const content = await readFile(resolve(suiteRoot, record.path))
      if (sha256(content) !== record.hashes[record.version]) errors.push(`${name}: content hash differs at version ${record.version}; bump its version`)
    } catch (error) { errors.push(`${name}: ${error.message}`) }
  }
  return errors
}
export async function loadVersions(suiteRoot = SUITE_ROOT) { return (await readJson(join(suiteRoot, 'versions.json'))).inputs }
