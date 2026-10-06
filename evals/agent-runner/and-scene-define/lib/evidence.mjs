import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { contained, filesUnder, readJson, sha256 } from './files.mjs'
import { writeJsonAtomic, writeTextAtomic } from './persistence.mjs'
import { effectiveDefineInvocations } from './runner-metrics.mjs'
import { cursorRecords, jsonl, parseTranscript } from './transcripts.mjs'
// Reject symlinks in every component, including parents of files to create.
export async function guardPath(runDir, path) {
  const root = resolve(runDir); const target = resolve(path)
  if (target !== root) contained(root, relative(root, target))
  let current = '/'
  for (const part of target.split('/').filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    // macOS /var and /tmp aliases are outside the run boundary; resolve those
    // before entering the run, but never follow any link within it.
    if (info?.isSymbolicLink() && (current === root || current.startsWith(root + '/'))) throw new Error(`refusing symlink: ${current}`)
  }
  return target
}
async function tree(runDir, root) {
  await guardPath(runDir, root)
  if (!await lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; return null })) return []
  return filesUnder(root)
}
export async function collectEvidence({ runDir, runnerDir, identity = null, runtime = join(runDir, 'sandbox/.runtime') }) {
  await guardPath(runDir, runtime); await guardPath(runDir, runnerDir)
  const metricsPath = join(runnerDir, 'run-metrics.json'); await guardPath(runDir, metricsPath)
  const invocations = effectiveDefineInvocations(await readJson(metricsPath))
  if (!invocations.length) throw new Error('run-metrics.json has no evaluated invocations')
  const retained = []
  async function copy(source, targetPath) {
    await guardPath(runDir, source)
    const target = contained(runDir, targetPath); await guardPath(runDir, target)
    const content = await readFile(source)
    await mkdir(dirname(target), { recursive: true }); await writeTextAtomic(target, content)
    retained.push(targetPath); return targetPath
  }
  for (const path of ['run-metrics.json', 'state.json', 'audit.log', 'external-user/exchanges.jsonl']) await copy(join(runnerDir, path), `evidence/runner/${path}`)
  const nativeFiles = {
    claude: await tree(runDir, join(runtime, 'claude/projects')),
    codex: await tree(runDir, join(runtime, 'codex/sessions')),
    cursor: await tree(runDir, join(runtime, 'cursor/chats')),
  }
  const sessions = new Map()
  for (const invocation of invocations) {
    const { cli, session_id: session } = invocation
    if (!session || !nativeFiles[cli] || (cli === 'cursor' && invocation.role !== 'crosscheck')) throw new Error(`missing or unsupported transcript ${cli}:${session}`)
    const key = `${cli}:${session}`
    if (!sessions.has(key)) {
      const candidates = nativeFiles[cli].filter(path => cli === 'claude' ? basename(path) === `${session}.jsonl` : cli === 'codex' ? basename(path).startsWith('rollout-') && basename(path).endsWith(`-${session}.jsonl`) : basename(path) === 'store.db' && basename(dirname(path)) === session)
      if (candidates.length !== 1) throw new Error(`missing or ambiguous transcript ${key}`)
      const source = candidates[0]
      // Use a host-generated filename: session IDs are untrusted, never paths.
      const targetPath = `evidence/transcripts/${sha256(key)}.${cli === 'cursor' ? 'db' : 'jsonl'}`
      if (cli === 'cursor') {
        for (const suffix of ['', '-wal', '-shm']) await guardPath(runDir, source + suffix)
        const target = contained(runDir, targetPath); await guardPath(runDir, target); await mkdir(dirname(target), { recursive: true })
        // VACUUM INTO reads committed WAL pages and uses SQL string quoting,
        // so filenames are never interpreted as sqlite3 dot-command arguments.
        // Build a fresh snapshot privately, then atomically replace the old one;
        // SQLite never opens a pre-existing destination file or symlink.
        const staging = await mkdtemp(join(dirname(target), '.cursor-snapshot-'))
        try {
          const snapshot = join(staging, 'store.db')
          const quoted = "'" + snapshot.replaceAll("'", "''") + "'"
          execFileSync('sqlite3', [source, `VACUUM INTO ${quoted}`], { stdio: 'pipe' })
          await guardPath(runDir, snapshot)
          await guardPath(runDir, target)
          await rename(snapshot, target)
        } catch (error) {
          throw new Error(`cannot retain Cursor transcript ${session}: sqlite3 snapshot failed: ${error.message}`)
        } finally { await rm(staging, { recursive: true, force: true }) }
        retained.push(targetPath)
      } else await copy(source, targetPath)
      const records = cli === 'cursor' ? cursorRecords(join(runDir, targetPath)) : jsonl(await readFile(join(runDir, targetPath), 'utf8'))
      parseTranscript(records, { cli, session })
      sessions.set(key, targetPath)
    }
    invocation.transcript = sessions.get(key)
  }
  const outputs = []
  for (const source of await tree(runDir, join(runnerDir, 'output'))) {
    if (!/\.attempt-\d+\.turn-\d+\.(out|err)$/.test(source)) continue
    outputs.push(await copy(source, `evidence/runner/output/${basename(source)}`))
  }
  if (!outputs.some(path => path.endsWith('.out'))) throw new Error('missing per-turn output copies')
  // Collected content and the host write-ahead record are part of the same
  // rescore manifest. No runtime-only file is required after this point.
  const paths = [...new Set([...retained, 'conversation.jsonl', 'phases/collection.json', ...await tree(runDir, join(runDir, 'collected')).then(files => files.map(path => relative(runDir, path)))])].sort()
  const files = []
  for (const path of paths) {
    await guardPath(runDir, join(runDir, path))
    if (path === 'phases/collection.json' && !await lstat(join(runDir, path)).catch(() => null)) continue
    files.push({ path, sha256: sha256(await readFile(join(runDir, path))) })
  }
  const manifest = { schema_version: 1, identity, files, invocations, outputs }
  await guardPath(runDir, join(runDir, 'evidence-manifest.json'))
  await writeJsonAtomic(join(runDir, 'evidence-manifest.json'), manifest)
  return manifest
}
export async function loadEvidence(runDir) {
  await guardPath(runDir, join(runDir, 'evidence-manifest.json'))
  const manifest = await readJson(join(runDir, 'evidence-manifest.json'))
  const retained = new Map()
  const bytesByPath = new Map()
  for (const file of manifest.files) {
    const path = contained(runDir, file.path); await guardPath(runDir, path)
    const bytes = await readFile(path)
    if (sha256(bytes) !== file.sha256) throw new Error(`evidence hash mismatch: ${file.path}`)
    if (retained.has(file.path)) throw new Error(`duplicate manifest path: ${file.path}`)
    retained.set(file.path, bytes.toString('utf8')); bytesByPath.set(file.path, bytes)
  }
  const text = path => { if (!retained.has(path)) throw new Error(`missing retained evidence ${path}`); return retained.get(path) }
  const transcripts = []
  const seen = new Set()
  for (const invocation of manifest.invocations) {
    const path = invocation.transcript; text(path)
    if (seen.has(path)) continue
    seen.add(path)
    const records = invocation.cli === 'cursor' ? cursorRecords(join(runDir, path), { immutable: true }) : jsonl(text(path))
    transcripts.push({ ...invocation, source: path, ...parseTranscript(records, { cli: invocation.cli, session: invocation.session_id }) })
  }
  const outputs = manifest.outputs.filter(path => path.endsWith('.out')).map(path => {
    const prefix = basename(path).split('.attempt-')[0]
    const records = jsonl(text(path))
    const nativeSession = records.find(r => r.session_id || r.thread_id)?.session_id ?? records.find(r => r.thread_id)?.thread_id
    const invocation = manifest.invocations.find(i => i.session_id === nativeSession) ?? manifest.invocations.find(i => {
      const parts = (i.prefix ?? '').split('/').filter(Boolean)
      const full = parts.at(-1) === i.step ? parts : [...parts, i.step]
      const auditPrefix = '[' + full.join(', ') + ']'
      const sanitize = value => value?.replace(/[^A-Za-z0-9._-]/g, '_')
      return [i.prefix, i.step, sanitize(i.prefix), full.join('-'), sanitize(full.join('/')), sanitize(auditPrefix)].includes(prefix)
    })
    if (!invocation) throw new Error(`per-turn output has no evaluated session: ${path}`)
    return { source: path, session_id: invocation?.session_id ?? null, cli: invocation?.cli, records }
  })
  return { manifest, bytesByPath, transcripts, outputs, conversation: jsonl(text('conversation.jsonl')), exchanges: jsonl(text('evidence/runner/external-user/exchanges.jsonl')), audit: text('evidence/runner/audit.log') }
}
