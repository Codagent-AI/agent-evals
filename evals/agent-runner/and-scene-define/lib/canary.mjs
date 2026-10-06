import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SUITE_ROOT, readJson, filesUnder } from './files.mjs'
import { repoGit } from './starting-repo.mjs'

export function compilePatterns(data) {
  if (!Number.isInteger(data.version) || data.version < 1) throw new Error('pattern list requires a positive version')
  const ids = new Set()
  return data.patterns.map(pattern => {
    if (!pattern.id || ids.has(pattern.id) || !['locator', 'canary'].includes(pattern.kind)) throw new Error(`invalid pattern: ${pattern.id}`)
    ids.add(pattern.id)
    if (pattern.type === 'literal' && typeof pattern.value === 'string' && pattern.value.length) {
      const value = pattern.value.toLowerCase()
      return { ...pattern, matches: text => text.toLowerCase().includes(value) }
    }
    if (pattern.type === 'regex' && pattern.value?.startsWith('^') && pattern.value.endsWith('$')) {
      const regex = new RegExp(pattern.value, 'im')
      if (regex.test('')) throw new Error(`empty regex pattern: ${pattern.id}`)
      return { ...pattern, matches: text => regex.test(text) }
    }
    throw new Error(`pattern must be literal or anchored regex: ${pattern.id}`)
  })
}

export async function scanCanaries({ stagedDir, skillsDir, credentialFiles = [], patternsPath = join(SUITE_ROOT, 'contamination-patterns.json') } = {}) {
  const patterns = compilePatterns(await readJson(patternsPath))
  const matches = new Map()
  const scan = (file, content) => {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : content
    for (const pattern of patterns) if (pattern.matches(text)) matches.set(`${file}\0${pattern.id}`, { file, pattern: pattern.id, kind: pattern.kind })
  }
  const scanGitObjects = (repo, label) => {
    const objects = repoGit(repo, ['rev-list', '--objects', '--all']).split('\n')
    for (const object of objects) {
      const [oid, ...name] = object.split(' ')
      if (!oid) continue
      const type = repoGit(repo, ['cat-file', '-t', oid])
      if (['blob', 'commit', 'tag'].includes(type)) scan(`${label}::${name.join(' ') || oid}`, repoGit(repo, ['cat-file', type, oid]))
    }
  }
  if (stagedDir) {
    const files = await filesUnder(stagedDir)
    for (const file of files) {
      const content = await readFile(file)
      scan(file, content)
      if (content.subarray(0, 32).toString().match(/^# v[23] git bundle\n/)) {
        const temporary = await mkdtemp(join(tmpdir(), 'define-canary-bundle-'))
        try {
          execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--mirror', '--template=', file, temporary], { stdio: 'pipe' })
          scanGitObjects(temporary, file)
        } finally { await rm(temporary, { recursive: true, force: true }) }
      }
      if (basename(file) === 'HEAD' && basename(join(file, '..')) === '.git') scanGitObjects(join(file, '../..'), join(file, '../..'))
    }
  }
  if (skillsDir) {
    // Scan committed blobs, not just mutable working-tree copies. Only HEAD's
    // tracked files are installed; historical and untracked files aren't inputs.
    const entries = repoGit(skillsDir, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean)
    for (const entry of entries) {
      const [metadata, path] = entry.split('\t')
      const [mode, , oid] = metadata.split(' ')
      if (!['100644', '100755'].includes(mode)) throw new Error(`unsupported tracked skill input: ${path}`)
      const file = join(skillsDir, path)
      scan(file, repoGit(skillsDir, ['cat-file', 'blob', oid]))
      if ((await lstat(file)).isSymbolicLink()) throw new Error(`refusing forwarded symlink: ${file}`)
      scan(file, await readFile(file))
    }
  }
  for (const file of credentialFiles) {
    if (!(await lstat(file)).isFile()) throw new Error(`forwarded credential must be a regular file: ${file}`)
    scan(file, await readFile(file))
  }
  return [...matches.values()].sort((a, b) => a.file.localeCompare(b.file) || a.pattern.localeCompare(b.pattern))
}
