// Suite-owned curated publication, adapted from and-scene. Only named snapshot
// files enter the commit; failed pushes retain the commit for an ordinary retry.
import { mkdir, copyFile, lstat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { filesUnder } from './files.mjs'
import { guardPath } from './evidence.mjs'
import { readJson, writeJsonAtomic, hashFile } from './persistence.mjs'
import { runTimed } from './subprocess.mjs'
export const RESULTS_RELATIVE_DIR = 'evals/agent-runner/and-scene-define/results'
// A complete candidate run is published with its score. A run without a total
// (every graded item leaked) has nothing to publish.
export function publicationEligibility(result) {
  return result?.mode === 'candidate' && result.evaluation_status === 'complete' && Number.isFinite(result.total)
}
export async function publishRun({ runDir, repoDir, result, git = (args, options) => runTimed('git', args, options) }) {
  if (!publicationEligibility(result)) return { skipped: true, published: false, commit: null }
  const runId = result.run_id
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId ?? '') || ['.', '..'].includes(runId)) throw new Error('invalid publication run id')
  const target = join(repoDir, RESULTS_RELATIVE_DIR, runId)
  const prefix = `${RESULTS_RELATIVE_DIR}/${runId}`
  const message = `chore: record and-scene-define eval ${runId}`
  const checkpointPath = join(runDir, 'publication.json')
  await guardPath(runDir, checkpointPath)
  let checkpoint = await readJson(checkpointPath, null) ?? { run_id: runId, stage: 'snapshot', commit: null }
  if (checkpoint.run_id !== runId) throw new Error('publication checkpoint run identity mismatch')
  const save = async update => { checkpoint = { ...checkpoint, ...update }; await writeJsonAtomic(checkpointPath, checkpoint) }
  const command = async args => {
    const out = await git(args, { cwd: repoDir })
    if (!out.ok) throw new Error(`git ${args[0]} failed: ${(out.stderr || out.stdout || `exit ${out.status}`).trim()}`)
    return out.stdout.trim()
  }
  try {
    if (checkpoint.stage === 'published') return { published: true, commit: checkpoint.commit }
    if (!checkpoint.commit) {
      await guardPath(runDir, join(runDir, 'collected'))
      const collected = (await filesUnder(join(runDir, 'collected'))).map(path => relative(runDir, path))
      const files = ['result.json', 'report.html', 'conversation.jsonl', 'discovery/ledger.json', ...collected]
      const manifest = []
      for (const file of files) {
        const path = join(runDir, file); await guardPath(runDir, path)
        if (!(await lstat(path)).isFile()) throw new Error(`publication requires regular file ${file}`)
        manifest.push({ path: file, sha256: await hashFile(path) })
      }
      await guardPath(resolve(repoDir), target)
      const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (existing) {
        const allowed = new Set([...files, 'artifact-manifest.json'])
        for (const path of await filesUnder(target)) if (!allowed.has(relative(target, path))) throw new Error(`uncurated publication file: ${path}`)
      }
      await mkdir(target, { recursive: true })
      for (const file of files) {
        await guardPath(resolve(repoDir), join(target, file))
        await mkdir(join(target, file, '..'), { recursive: true }); await copyFile(join(runDir, file), join(target, file))
      }
      await writeJsonAtomic(join(target, 'artifact-manifest.json'), { schema_version: 1, run_id: runId, files: manifest })
      files.push('artifact-manifest.json')
      await save({ stage: 'commit', files, error: null })
      // Recover a successful commit even if its checkpoint write was interrupted.
      const history = await command(['log', '--format=%H %s', '--', prefix])
      const previous = history.split('\n').find(line => line.slice(line.indexOf(' ') + 1) === message)?.split(' ')[0]
      if (previous) {
        const clean = await command(['status', '--porcelain', '--', prefix])
        const changed = await command(['diff', '--name-only', previous, 'HEAD', '--', prefix])
        if (clean || changed) throw new Error('existing result commit differs from requested snapshot; refusing duplicate publication')
        await save({ stage: 'push', commit: previous, error: null })
      } else {
        const names = files.map(file => `${prefix}/${file}`)
        await command(['add', '--', ...names])
        await command(['commit', '-m', message, '--', ...names])
        await save({ stage: 'push', commit: await command(['rev-parse', 'HEAD']), error: null })
      }
    }
    // A recorded commit must still belong to the current branch before retry.
    await command(['merge-base', '--is-ancestor', checkpoint.commit, 'HEAD'])
    await command(['push'])
    await save({ stage: 'published', error: null, completed_at: new Date().toISOString() })
    return { published: true, commit: checkpoint.commit }
  } catch (error) {
    await save({ error: error.message, resumable: true })
    throw Object.assign(error, { publication: true, resumable: true })
  }
}
