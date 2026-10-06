import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
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
  const git = (cwd, args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('git executable unavailable', { cause: error })
      throw error
    }
  }
  suiteRoot = realpathSync(suiteRoot)
  const root = git(suiteRoot, ['rev-parse', '--show-toplevel'])
  const path = relative(root, join(suiteRoot, 'versions.json')).split('\\').join('/')
  let head
  try { head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) }
  catch (error) {
    if (error.status !== 1) throw error
    // An unborn branch with no refs is the only legitimate no-HEAD case.
    git(root, ['symbolic-ref', 'HEAD'])
    if (git(root, ['for-each-ref', '--format=%(refname)'])) throw new Error('HEAD unavailable in an existing repository')
    return []
  }
  const ledgerAt = revision => {
    // A successful tree lookup returning no entry proves the path is absent.
    // Missing commits, corrupt objects, and command errors must propagate.
    if (!git(root, ['ls-tree', revision, '--', path])) return undefined
    return JSON.parse(git(root, ['show', `${revision}:${path}`]))
  }
  const current = ledgerAt(head)
  if (!current) {
    if (git(root, ['log', '--all', '-1', '--format=%H', '--', path])) throw new Error('previously committed ledger is absent from HEAD')
    if (git(root, ['rev-parse', '--is-shallow-repository']) === 'true') throw new Error('cannot prove the ledger is new with shallow history')
    return []
  }
  const baselines = [current]
  const lastChange = git(root, ['log', '-1', '--format=%H', head, '--', path])
  if (!lastChange) throw new Error('committed ledger history unavailable')
  // Read actual parent headers: rev-list hides parents at shallow boundaries.
  const commitHeaders = git(root, ['cat-file', '-p', lastChange]).split('\n\n')[0]
  const parent = commitHeaders.match(/^parent ([a-f0-9]+)$/m)?.[1]
  if (parent) {
    const previous = ledgerAt(parent)
    if (previous) baselines.push(previous)
  }
  return baselines
}
export async function checkVersions({ suiteRoot = SUITE_ROOT, previous } = {}) {
  const ledger = await readJson(join(suiteRoot, 'versions.json'))
  const errors = validateVersionRecords(ledger.inputs)
  try {
    for (const baseline of previous ? [previous] : committedBaselines(suiteRoot)) errors.push(...validateVersionRecords(ledger.inputs, baseline.inputs))
  } catch (error) { errors.push(`version history baseline unavailable: ${error.message}`) }
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
