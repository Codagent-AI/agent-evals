import { spawnSync } from 'node:child_process'

export const PROJECTIONS = {
  issue: '{body: .body}',
  main: '{sha: .sha}',
  compare: '{status, ahead_by, behind_by, merge_base: .merge_base_commit.sha, commits: [.commits[:20][] | {sha, subject: (.commit.message | split("\\n")[0])}]}',
}
const validRepo = repo => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && repo.split('/').every(x => x !== '.' && x !== '..')
const validSha = sha => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)
function read(path, projection, exec) {
  try {
    const result = exec('gh', ['api', path, '--jq', projection], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
    if (result.error || result.status !== 0) return { ok: false, message: result.stderr?.trim() || result.error?.message || `gh exited ${result.status}` }
    try { return { ok: true, data: JSON.parse(result.stdout) } }
    catch (cause) { return { ok: false, message: [result.stderr?.trim(), cause.message].filter(Boolean).join(': ') } }
  } catch (cause) { return { ok: false, message: cause.message } }
}
export function issueBody({ owner, repo, number }, { exec = spawnSync } = {}) {
  if (!validRepo(`${owner}/${repo}`) || !/^[1-9][0-9]*$/.test(String(number))) return { ok: false, message: 'Invalid issue reference' }
  const result = read(`repos/${owner}/${repo}/issues/${number}`, PROJECTIONS.issue, exec)
  if (!result.ok) return result
  return typeof result.data?.body === 'string' ? { ok: true, body: result.data.body } : { ok: false, message: 'Invalid issue body response' }
}
export function resolveMain(repo, { exec = spawnSync, now = () => new Date() } = {}) {
  if (!validRepo(repo)) return { ok: false, message: 'Invalid repository' }
  const result = read(`repos/${repo}/commits/main`, PROJECTIONS.main, exec)
  if (!result.ok) return result
  return validSha(result.data?.sha) ? { ok: true, sha: result.data.sha, resolved_at: now().toISOString() } : { ok: false, message: 'Invalid main SHA response' }
}
export function compare(repo, base, head, { exec = spawnSync } = {}) {
  if (!validRepo(repo) || !validSha(base) || !validSha(head)) return { ok: false, message: 'Invalid repository or commit SHA' }
  const result = read(`repos/${repo}/compare/${base}...${head}`, PROJECTIONS.compare, exec)
  if (!result.ok) return result
  const data = result.data
  if (!['ahead', 'behind', 'diverged', 'identical'].includes(data?.status) || ![data.ahead_by, data.behind_by].every(x => Number.isSafeInteger(x) && x >= 0) || !validSha(data.merge_base) || !Array.isArray(data.commits) || data.commits.some(x => !validSha(x.sha) || typeof x.subject !== 'string')) return { ok: false, message: 'Invalid compare response' }
  return { ok: true, ...data, commits: data.commits.slice(0, 20) }
}
