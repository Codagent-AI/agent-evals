import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { git, script, startingRepo, temp } from './and-scene-e2e-helpers.mjs'
import { DeliveryError, HarnessEvidenceError, cloneFromBundle, collectDefinition, verifyDelivery } from '../evals/agent-runner/and-scene-e2e/lib/delivery.mjs'
import { readHeadInContainer } from '../evals/agent-runner/and-scene-e2e/lib/container.mjs'

const BRANCH = 'add-presentation-skill'
// Real git: the bare delivery remote holds main and the candidate branch with the unarchived change.
async function world(t, { archive = false, pushed = true } = {}) {
  const root = await temp(t, 'e2e-delivery-')
  const { repo, commit } = await startingRepo(root)
  const remote = join(root, 'remote.git')
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote])
  git(repo, ['push', '--quiet', remote, 'main'])
  git(repo, ['checkout', '--quiet', '-b', BRANCH])
  await mkdir(join(repo, archive ? 'openspec/changes/archive/2026-01-01-add-presentation-skill' : 'openspec/changes/add-presentation-skill'), { recursive: true })
  await writeFile(join(repo, archive ? 'openspec/changes/archive/2026-01-01-add-presentation-skill/proposal.md' : 'openspec/changes/add-presentation-skill/proposal.md'), '# proposal\n')
  await writeFile(join(repo, 'impl.txt'), 'work\n'); git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'work'])
  if (pushed) git(repo, ['push', '--quiet', remote, BRANCH])
  const head = git(repo, ['rev-parse', 'HEAD'])
  const runDir = join(root, 'run'); await mkdir(runDir, { recursive: true })
  const session = join(runDir, 'sandbox/.runtime/agent-runner-projects/p/runs/r1'); await mkdir(join(session, 'output'), { recursive: true })
  const pull = { number: 1, state: 'open', draft: true, merged_at: null, base: { ref: 'main' }, head: { ref: BRANCH, sha: head } }
  const refs = [{ ref: 'refs/heads/main' }, { ref: `refs/heads/${BRANCH}` }]
  return { root, repo, remote, runDir, session, head, pull, refs, commit }
}
const verify = (w, { pulls = [w.pull], refs = w.refs, sessionDir = w.session, branch } = {}) => verifyDelivery({ runDir: w.runDir, fullName: 'Codagent-AI/e2e-run-x', url: w.remote, token: 'unused', api: { pulls: async () => pulls, refs: async () => refs }, sessionDir })
const acceptance = async w => { for (const [name, text] of [['acceptance-handoff.md', 'handoff'], ['findings-history.md', 'history'], ['acceptance-flow-evidence.md', 'flow']]) await writeFile(join(w.session, 'output', name), text) }

test('INT-006 happy path records identity, commit, bundle hash and acceptance evidence against the delivered commit', async t => {
  const w = await world(t); await acceptance(w)
  const result = await verify(w)
  assert.equal(result.delivered_commit, w.head); assert.equal(result.pull_request.head, w.head); assert.equal(result.repository, 'Codagent-AI/e2e-run-x')
  const bundle = join(w.runDir, 'source/candidate.bundle')
  assert.match(git(w.runDir, ['bundle', 'list-heads', bundle]).replace(/\n/g, ' '), new RegExp(`${w.head} refs/heads/${BRANCH}`))
  assert.equal(result.bundle.sha256.length, 64)
  assert.equal(result.acceptance.delivered_commit, w.head)
  assert.ok(result.acceptance.artifacts.length >= 3); for (const a of result.acceptance.artifacts) assert.equal(a.sha256.length, 64)
  // After the remote and workspace are gone, the bundle and acceptance evidence still read.
  await rm(w.remote, { recursive: true, force: true }); await rm(join(w.runDir, 'sandbox'), { recursive: true, force: true })
  const clone = await cloneFromBundle({ runDir: w.runDir, target: join(w.root, 'clone') })
  assert.equal(git(clone, ['rev-parse', 'HEAD']), w.head)
  assert.match(await readFile(join(w.runDir, result.acceptance.artifacts[0].file), 'utf8'), /./)
})

test('INT-006 each missing outcome ends the delivery naming it', async t => {
  const cases = {
    'the candidate branch pushed': [{ pushed: false }, w => ({ pulls: [] })],
    'an open draft pull request': [{}, () => ({ pulls: [] })],
    'a pull request whose base is main': [{}, w => ({ pulls: [{ ...w.pull, base: { ref: 'dev' } }] })],
    'a pull request head equal to the delivered commit': [{}, w => ({ pulls: [{ ...w.pull, head: { ref: BRANCH, sha: 'a'.repeat(40) } }] })],
    'exactly one pull request': [{}, w => ({ pulls: [w.pull, { ...w.pull, number: 2 }] })],
    'the change left unarchived': [{ archive: true }, w => ({ pulls: [w.pull] })],
  }
  for (const [expected, [opts, build]] of Object.entries(cases)) {
    const w = await world(t, opts); await acceptance(w)
    await assert.rejects(verify(w, build(w)), error => error instanceof DeliveryError && error.message.includes(expected), expected)
  }
})

test('INT-006 ready, merged, closed, deleted and archived are missing outcomes that record the prohibited effect', async t => {
  const prohibited = {
    'pull request marked ready': w => ({ pulls: [{ ...w.pull, draft: false }] }),
    'pull request merged': w => ({ pulls: [{ ...w.pull, state: 'closed', merged_at: '2026-01-01' }] }),
    'pull request closed': w => ({ pulls: [{ ...w.pull, state: 'closed' }] }),
  }
  for (const [effect, build] of Object.entries(prohibited)) {
    const w = await world(t); await acceptance(w)
    await assert.rejects(verify(w, build(w)), error => error instanceof DeliveryError && error.prohibited.includes(effect), effect)
  }
  const deleted = await world(t, { pushed: false })
  await assert.rejects(verify(deleted, { pulls: [deleted.pull] }), error => error.prohibited.includes('branch deleted'))
  const archived = await world(t, { archive: true })
  await assert.rejects(verify(archived), error => error.prohibited.includes('change archived') && /unarchived/.test(error.message))
})

test('INT-006 an extra branch and an extra pull request are reported without changing the outcome', async t => {
  const w = await world(t); await acceptance(w)
  const result = await verify(w, { pulls: [w.pull, { ...w.pull, number: 9, head: { ref: 'other', sha: w.commit } }], refs: [...w.refs, { ref: 'refs/heads/other' }] })
  assert.deepEqual(result.extras, { branches: ['other'], pull_requests: [9] })
})

test('INT-006 missing acceptance artifacts are recorded as missing roles; unsafe or unreadable ones are harness failures', async t => {
  const missing = await world(t)
  const result = await verify(missing)
  assert.ok(result.acceptance.missing_roles.includes('final-handoff') || result.acceptance.missing_roles.length > 0)
  assert.equal(result.delivered_commit, missing.head)
  const outside = await world(t); await acceptance(outside)
  await writeFile(join(outside.root, 'secret.md'), 'x'); await symlink(join(outside.root, 'secret.md'), join(outside.session, 'output/acceptance-flow.md'))
  await assert.rejects(verify(outside), error => error instanceof HarnessEvidenceError)
  const linkedParent = await world(t); await acceptance(linkedParent)
  await rm(join(linkedParent.session, 'output'), { recursive: true }); await mkdir(join(linkedParent.root, 'elsewhere')); await writeFile(join(linkedParent.root, 'elsewhere/acceptance-handoff.md'), 'h')
  await symlink(join(linkedParent.root, 'elsewhere'), join(linkedParent.session, 'output'))
  await assert.rejects(verify(linkedParent), error => error instanceof HarnessEvidenceError || /symlink|refus/i.test(error.message))
})

test('INT-006 definition collection never runs the workspace repository configuration on the host', async t => {
  const w = await world(t)
  const workspace = join(w.runDir, 'sandbox/workspace/repo'); await mkdir(join(workspace, '..'), { recursive: true }); await cp(w.repo, workspace, { recursive: true })
  const marker = join(w.root, 'marker'); const hooks = join(w.root, 'hooks')
  await script(join(w.root, 'fsmonitor.sh'), `touch "${marker}.fsmonitor"`); await script(join(hooks, 'post-checkout'), `touch "${marker}.hook"`); await script(join(w.root, 'alias.sh'), `touch "${marker}.alias"`)
  git(workspace, ['config', 'core.fsmonitor', join(w.root, 'fsmonitor.sh')]); git(workspace, ['config', 'core.hooksPath', hooks]); git(workspace, ['config', 'alias.rev-parse', `!${join(w.root, 'alias.sh')}`])
  // Host Git is observed through a PATH wrapper: no invocation may name the workspace.
  const bin = join(w.root, 'bin'); const log = join(w.root, 'git.log'); const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  await script(join(bin, 'git'), `echo "$PWD|$GIT_DIR|$GIT_WORK_TREE|$*" >> "${log}"\nexec ${realGit} "$@"`)
  const heads = []
  const readHead = async ({ copyDir }) => { heads.push(copyDir); return 'c'.repeat(40) }
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`
  try {
    const manifest = await collectDefinition({ workspaceRepo: workspace, runDir: w.runDir, readHead })
    assert.equal(manifest.head, 'c'.repeat(40)); assert.deepEqual(manifest.files.map(file => file.path), ['proposal.md'])
    assert.equal(await readFile(join(w.runDir, 'collected/proposal.md'), 'utf8'), '# proposal\n')
  } finally { process.env.PATH = oldPath }
  for (const suffix of ['fsmonitor', 'hook', 'alias']) await assert.rejects(access(`${marker}.${suffix}`))
  const logged = await readFile(log, 'utf8').catch(() => '')
  assert.ok(!logged.includes(workspace), 'host Git ran against the workspace')
  assert.equal(heads.length, 1); assert.notEqual(heads[0], workspace)
  // Symlinked change files are refused.
  await rm(join(workspace, 'openspec/changes/add-presentation-skill/proposal.md')); await symlink(join(w.root, 'marker.hook'), join(workspace, 'openspec/changes/add-presentation-skill/proposal.md'))
  await assert.rejects(collectDefinition({ workspaceRepo: workspace, runDir: w.runDir, readHead }), /symlink/)
})

test('INT-006 the real HEAD reader is delegated to a throwaway container over a copy, with no credentials', () => {
  const calls = []
  const head = readHeadInContainer({ copyDir: '/tmp/copy', run: (spec, meta) => { calls.push(spec); return { stdout: `${'d'.repeat(40)}\n` } } })
  assert.equal(head, 'd'.repeat(40))
  assert.deepEqual(calls[0].mounts, [{ source: '/tmp/copy', target: '/repo', readonly: true }]); assert.ok(calls[0].command.includes('rev-parse'))
  assert.throws(() => readHeadInContainer({ copyDir: '/x', run: () => ({ stdout: 'nope' }) }), /no commit/)
})
