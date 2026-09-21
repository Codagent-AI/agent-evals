#!/usr/bin/env node
// Refresh the offline fixture corpus from a checkout at the reviewed pin.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUITE_DIR = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_DIR = join(SUITE_DIR, 'fixture-snapshot')
const DOCUMENTS = [
  'README.md',
  'openspec/changes/create-and-scene/specs/evolving-scene-presentations/spec.md',
  'openspec/changes/create-and-scene/specs/presentation-skill/spec.md',
  'openspec/changes/create-and-scene/specs/presentation-verification/spec.md',
  'openspec/changes/create-and-scene/proposal.md',
  'openspec/changes/create-and-scene/design.md',
  'openspec/changes/create-and-scene/tasks.md',
  'openspec/changes/create-and-scene/test-plan.md',
]

export async function fixtureRef() {
  const text = await readFile(join(SUITE_DIR, 'run.sh'), 'utf8')
  const ref = text.match(/^FIXTURE_REF="\$\{FIXTURE_REF:-([^}]+)\}"$/m)?.[1]
  if (!ref) throw new Error('could not parse FIXTURE_REF from run.sh')
  return ref
}

function git(checkout, args) {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim()
}

export async function refreshSnapshot(checkout, outputDir = SNAPSHOT_DIR, expectedRef = undefined) {
  const ref = expectedRef ?? await fixtureRef()
  if (git(checkout, ['rev-parse', 'HEAD']) !== ref) throw new Error(`checkout HEAD must equal FIXTURE_REF ${ref}`)
  const files = []
  for (const path of DOCUMENTS) {
    const entry = git(checkout, ['ls-tree', 'HEAD', '--', path])
    if (!entry) continue
    files.push({ path: path === 'README.md' ? 'fixture-root-README.md' : path, source_path: path, blob: entry.split(/\s+/)[2] })
  }
  const temporary = `${outputDir}.tmp-${process.pid}`
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })
  for (const { path, blob } of files) {
    await mkdir(dirname(join(temporary, path)), { recursive: true })
    await writeFile(join(temporary, path), execFileSync('git', ['-C', checkout, 'cat-file', 'blob', blob]))
  }
  await writeFile(join(temporary, 'snapshot.json'), `${JSON.stringify({ repository: 'Codagent-AI/and-scene', fixture_ref: ref, files }, null, 2)}\n`)
  await writeFile(join(temporary, 'README.md'), 'These documents are copied verbatim from Codagent-AI/and-scene at the pinned fixture revision for offline verification. Refresh with `node fixture-snapshot.mjs --checkout PATH` from the suite directory.\n')
  await rm(outputDir, { recursive: true, force: true })
  await rename(temporary, outputDir)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--checkout')
  if (index < 0 || !process.argv[index + 1]) throw new Error('usage: fixture-snapshot.mjs --checkout PATH')
  await refreshSnapshot(resolve(process.argv[index + 1]))
}
