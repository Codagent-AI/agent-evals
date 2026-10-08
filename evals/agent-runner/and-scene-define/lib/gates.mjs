import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CHANGE_NAME } from './starting-repo.mjs'
import { runTimed } from './subprocess.mjs'
export async function runGates({ runDir, artifacts, command = runTimed }) {
  const gates = [
    ['proposal', paths => paths.includes('proposal.md')],
    ['specs', paths => paths.some(x => /^specs\/.+\/spec\.md$/.test(x))],
    ['design', paths => paths.includes('design.md')],
    ['test-plan', paths => paths.includes('test-plan.md')],
  ].map(([name, present]) => ({ id: `gate:required-artifact:${name}`, passed: present(Object.keys(artifacts)), reason: present(Object.keys(artifacts)) ? 'present' : `${name} artifact is absent` }))
  const runtime = join(runDir, '.runtime'); await mkdir(runtime, { recursive: true })
  const scratch = await mkdtemp(join(runtime, 'openspec-gates-'))
  try {
    const target = join(scratch, 'openspec/changes', CHANGE_NAME)
    await mkdir(target, { recursive: true })
    await cp(join(runDir, 'collected'), target, { recursive: true })
    const validation = await command('openspec', ['validate', CHANGE_NAME, '--strict'], { cwd: scratch, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    // A missing CLI or terminated probe is infrastructure failure, not a
    // definition error. A normal validation error remains a hard product gate.
    if (validation.error || validation.signal || validation.status === null) throw new Error(`OpenSpec gate could not run: ${validation.error ?? validation.signal ?? 'no exit status'}`)
    gates.push({ id: 'gate:openspec-validate', passed: validation.status === 0, status: validation.status, stdout: validation.stdout, stderr: validation.stderr })
  } finally { await rm(scratch, { recursive: true, force: true }) }
  return gates
}
