import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { SUITE_ROOT, readJson, sha256, contained } from './files.mjs'

// Add future inputs here once they exist; no checker changes are needed.
export const VERSIONED_INPUTS = {
  inventory: { path: 'hidden/inventory.json', versionField: 'inventory_version' },
  'starting-prompt': { path: 'hidden/starting-prompt.md' },
  'contamination-patterns': { path: 'contamination-patterns.json', versionField: 'version' },
}

export function validateVersionRecords(records, previous = {}) {
  const errors = []
  for (const [name, record] of Object.entries(records)) {
    if (!Number.isInteger(record.version) || record.version < 1 || !/^[a-f0-9]{64}$/.test(record.hashes?.[record.version] ?? '')) errors.push(`${name}: missing content hash under a positive version`)
    const old = previous[name]
    if (old) {
      if (record.version < old.version) errors.push(`${name}: version cannot go backwards`)
      if (record.path !== old.path) errors.push(`${name}: versioned input path changed`)
      for (const [version, hash] of Object.entries(old.hashes)) {
        if (record.hashes?.[version] !== hash) errors.push(`${name}: content changed or removed under version ${version}; bump the version and retain historical hashes`)
      }
    }
  }
  for (const name of Object.keys(previous)) if (!records[name]) errors.push(`${name}: versioned input removed`)
  return errors
}

// Check both working changes and the last committed ledger change. This also
// catches editing the recorded hash along with the content without a bump.
function committedBaselines(suiteRoot) {
  try {
    const root = execFileSync('git', ['-C', suiteRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const path = relative(root, join(suiteRoot, 'versions.json')).split('\\').join('/')
    const show = revision => JSON.parse(execFileSync('git', ['-C', root, 'show', `${revision}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const baselines = []
    try { baselines.push(show('HEAD')) } catch { /* First implementation has no committed ledger. */ }
    const lastChange = execFileSync('git', ['-C', root, 'log', '-1', '--format=%H', '--', path], { encoding: 'utf8' }).trim()
    if (lastChange) try { baselines.push(show(`${lastChange}^`)) } catch { /* First ledger commit. */ }
    return baselines
  } catch { return [] }
}
export async function checkVersions({ suiteRoot = SUITE_ROOT, previous } = {}) {
  const ledger = await readJson(join(suiteRoot, 'versions.json'))
  const errors = validateVersionRecords(ledger.inputs)
  for (const baseline of previous ? [previous] : committedBaselines(suiteRoot)) errors.push(...validateVersionRecords(ledger.inputs, baseline.inputs))
  for (const [name, expected] of Object.entries(VERSIONED_INPUTS)) {
    if (ledger.inputs[name]?.path !== expected.path) errors.push(`${name}: missing versioned input ${expected.path}`)
  }
  for (const [name, record] of Object.entries(ledger.inputs)) {
    const expected = VERSIONED_INPUTS[name]
    try {
      const content = await readFile(contained(suiteRoot, record.path))
      if (sha256(content) !== record.hashes[record.version]) errors.push(`${name}: content hash differs at version ${record.version}; bump its version`)
      if (expected?.versionField && JSON.parse(content)[expected.versionField] !== record.version) errors.push(`${name}: input version differs from ledger`)
    } catch (error) { errors.push(`${name}: ${error.message}`) }
  }
  return errors
}
