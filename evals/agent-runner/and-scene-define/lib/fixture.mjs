import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export const FIXTURE = Object.freeze({ repository: 'https://github.com/Codagent-AI/and-scene.git', commit: 'ad667a965a0e1ea0b028c36c04d57bf0411d30d9', change: 'create-and-scene' })
export function git(checkout, args, options = {}) {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
}
export async function withFixture({ checkout, ref = FIXTURE.commit } = {}, callback) {
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('fixture ref must be a full commit SHA')
  let temporary
  try {
    if (!checkout) {
      temporary = await mkdtemp(join(tmpdir(), 'define-fixture-'))
      checkout = temporary
      git(checkout, ['init', '--bare'])
      git(checkout, ['fetch', '--depth=1', FIXTURE.repository, ref])
    }
    if (git(checkout, ['rev-parse', `${ref}^{commit}`]).trim() !== ref) throw new Error(`fixture commit unavailable: ${ref}`)
    return await callback(checkout, ref)
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}
export function fixtureFile(checkout, ref, path) {
  const entry = git(checkout, ['ls-tree', ref, '--', path]).trim()
  if (!entry.startsWith('100644 blob ')) throw new Error(`fixture file must be a regular file: ${path}`)
  return git(checkout, ['show', `${ref}:${path}`], { encoding: null })
}
export function cliOptions(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--check' || flag === '--help') options[flag.slice(2)] = true
    else if (['--checkout', '--ref', '--output'].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[flag.slice(2)] = argv[++index]
    else throw new Error(`unknown or incomplete argument: ${flag}`)
  }
  return options
}
