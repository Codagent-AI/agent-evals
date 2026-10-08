// All host-only input locations and the reference allowlist live here.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SUITE_ROOT, sha256 } from './files.mjs'
import { checkVersions } from './versions.mjs'
const REFERENCE_ROOT = 'hidden/reference/openspec/changes/create-and-scene'
const REFERENCE_FILES = [
  'proposal.md',
  'specs/evolving-scene-presentations/spec.md',
  'specs/presentation-skill/spec.md',
  'specs/presentation-verification/spec.md',
  'design.md', 'test-plan.md',
]
export async function loadSimulatedUserInputs({ suiteRoot = SUITE_ROOT } = {}) {
  const errors = await checkVersions({ suiteRoot })
  if (errors.length) throw new Error(`unpinned simulated-user inputs: ${errors.join('; ')}`)
  const ledger = JSON.parse(await readFile(join(suiteRoot, 'versions.json'), 'utf8'))
  const policyRecord = ledger.inputs['simulated-user-policy']
  const policy = await readFile(join(suiteRoot, policyRecord.path), 'utf8')
  if (!policy.startsWith(`# Simulated user policy — version ${policyRecord.version}\n`)) throw new Error('policy version differs from ledger')
  const startingPrompt = await readFile(join(suiteRoot, ledger.inputs['starting-prompt'].path), 'utf8')
  const manifest = JSON.parse(await readFile(join(suiteRoot, 'hidden/reference.json'), 'utf8'))
  const referenceDocuments = await Promise.all(REFERENCE_FILES.map(async path => {
    const text = await readFile(join(suiteRoot, REFERENCE_ROOT, path), 'utf8')
    const pin = manifest.files.find(file => file.path === `openspec/changes/create-and-scene/${path}`)
    if (sha256(text) !== pin?.sha256) throw new Error(`reference hash mismatch: ${path}`)
    return { path, text }
  }))
  const systemPrompt = `${policy}\n## Opening request\n${startingPrompt}\n## Private requirements\n${referenceDocuments.map(doc => `### ${doc.path}\n${doc.text}`).join('\n')}\n`
  return { startingPrompt, policyVersion: policyRecord.version, policySha256: sha256(policy), referenceDocuments, systemPrompt, systemPromptSha256: sha256(systemPrompt) }
}
