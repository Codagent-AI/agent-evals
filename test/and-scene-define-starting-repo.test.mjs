import { makeTempDir } from './temp-dir.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { materialize, verifySnapshot } from '../evals/agent-runner/and-scene-define/lib/starting-repo.mjs'
import { scanCanaries } from '../evals/agent-runner/and-scene-define/lib/canary.mjs'
const suiteRoot = resolve('evals/agent-runner/and-scene-define')
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
async function temporary(t) {
  const root = await makeTempDir(join(tmpdir(), 'define-start-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('INT-005: deterministic starting repository and bundle contain one commit and no hidden inputs', async t => {
  const root = await temporary(t)
  const first = await materialize(join(root, 'first'))
  const second = await materialize(join(root, 'second'))
  assert.equal(first.commit, second.commit)
  assert.equal(first.treeHash, second.treeHash)
  assert.deepEqual(await readFile(first.bundlePath), await readFile(second.bundlePath))
  assert.equal(git(first.repoDir, 'rev-list', '--all', '--count'), '1')
  assert.equal(git(first.repoDir, 'rev-parse', 'main'), first.commit)
  assert.equal(git(first.repoDir, 'rev-parse', 'add-presentation-skill'), first.commit)
  assert.equal(git(first.repoDir, 'branch', '--show-current'), 'add-presentation-skill')
  assert.equal(git(first.repoDir, 'remote'), '')
  assert.match(await readFile(join(first.repoDir, '.validator/config.yml'), 'utf8'), /^base_branch: main$/m)
  assert.equal(await verifySnapshot(), first.treeHash)
  const files = git(first.repoDir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')
  assert(files.every(path => !/(^|\/)(hidden|calibration)\/|contamination-patterns.json|manifest.json/.test(path)))
  assert.deepEqual((await readdir(join(root, 'first'))).sort(), ['repository', 'starting.bundle'])
  assert.deepEqual(await scanCanaries({ stagedDir: join(root, 'first') }), [])
  const clone = join(root, 'clone')
  execFileSync('git', ['clone', first.bundlePath, clone], { stdio: 'pipe' })
  assert.equal(git(clone, 'rev-parse', 'HEAD^{tree}'), first.treeHash)
})

test('canary check reports every planted pattern in staging, tracked skills, and credentials', async t => {
  const root = await temporary(t)
  const stagedDir = join(root, 'stage')
  const skillsDir = join(root, 'skills')
  await mkdir(stagedDir)
  await mkdir(skillsDir)
  git(skillsDir, 'init')
  await writeFile(join(skillsDir, 'SKILL.md'), 'Clean skill\n')
  git(skillsDir, 'add', '.')
  git(skillsDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial')
  const credential = join(root, 'settings.json')
  await writeFile(credential, '{"repository":"CODAGENT-AI/AND-SCENE"}')
  for (const [index, text] of [
    'https://github.com/Codagent-AI/agent-evals.git', 'and-scene:presentation',
    '/tmp/and-scene/skills/presentation/SKILL.md', '~/.claude/plugins/marketplaces/and-scene/skills/presentation/SKILL.md', '~/.claude/plugins/cache/and-scene/plugin.json', 'and-scene-define/hidden/inventory.json',
    'cat exchange/turn-1.request.json', '../exchange/turn-1.request.json', '/tmp/exchange/turn-1.reply.json',
    './external-user/exchanges.jsonl', '/artifacts/.runtime/sessions', '../.runtime/foo',
    '/tmp/eval-input/input.json', 'How to Use This Skill to Make a Presentation',
  ].entries()) {
    const file = join(stagedDir, `planted-${index}.txt`)
    await writeFile(file, text)
    const matches = await scanCanaries({ stagedDir })
    assert(matches.some(match => match.file === file && match.pattern), text)
  }
  let matches = await scanCanaries({ stagedDir, skillsDir, credentialFiles: [credential] })
  assert(matches.some(match => match.file === credential && match.pattern === 'fixture-repository'))
  await writeFile(join(skillsDir, 'SKILL.md'), 'and-scene:presentation\n')
  git(skillsDir, 'add', '.')
  git(skillsDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'changed')
  await writeFile(join(skillsDir, 'SKILL.md'), 'Clean worktree\n')
  matches = await scanCanaries({ stagedDir, skillsDir })
  assert(matches.some(match => match.file.includes('SKILL.md') && match.pattern === 'reference-skill'))
})

test('tracked skill symlinks to tracked files inside the checkout are accepted; others are refused', async t => {
  const root = await temporary(t)
  const skillsDir = join(root, 'skills')
  await mkdir(join(skillsDir, 'docs'), { recursive: true })
  git(skillsDir, 'init')
  await writeFile(join(skillsDir, 'AGENTS.md'), 'Clean instructions\n')
  await symlink('../AGENTS.md', join(skillsDir, 'docs/CLAUDE.md'))
  const commit = () => { git(skillsDir, 'add', '-A'); git(skillsDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'c') }
  commit()
  assert.deepEqual(await scanCanaries({ skillsDir }), [])
  await writeFile(join(skillsDir, 'AGENTS.md'), 'and-scene:presentation\n'); commit()
  assert((await scanCanaries({ skillsDir })).some(match => match.file.endsWith('AGENTS.md') && match.pattern === 'reference-skill'))
  await writeFile(join(skillsDir, 'large.png'), Buffer.alloc(3 * 1024 * 1024, 7)); commit()
  assert((await scanCanaries({ skillsDir })).some(match => match.file.endsWith('AGENTS.md')))
  await rm(join(skillsDir, 'docs/CLAUDE.md')); await symlink('/etc/hosts', join(skillsDir, 'docs/CLAUDE.md')); commit()
  await assert.rejects(scanCanaries({ skillsDir }), /symlink/)
  await rm(join(skillsDir, 'docs/CLAUDE.md')); await symlink('../../outside.md', join(skillsDir, 'docs/CLAUDE.md')); commit()
  await assert.rejects(scanCanaries({ skillsDir }), /symlink/)
})

test('bundle blobs are scanned even when compressed', async t => {
  const root = await temporary(t)
  const repo = join(root, 'source')
  const stage = join(root, 'stage')
  await mkdir(repo)
  await mkdir(stage)
  git(repo, 'init')
  await writeFile(join(repo, 'leak.txt'), 'Codagent-AI/and-scene\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial')
  const bundle = join(stage, 'repo.bundle')
  git(repo, 'bundle', 'create', bundle, '--all')
  assert((await scanCanaries({ stagedDir: stage })).some(match => match.file.includes('repo.bundle') && match.pattern === 'fixture-repository'))
})

test('materialization rejects forbidden paths and altered snapshot content before staging', async t => {
  const root = await temporary(t)
  const { cp } = await import('node:fs/promises')
  const customSuite = join(root, 'suite')
  await cp(join(suiteRoot, 'starting-repo'), join(customSuite, 'starting-repo'), { recursive: true })
  const manifestPath = join(customSuite, 'starting-repo/manifest.json')
  const original = JSON.parse(await readFile(manifestPath))
  for (const path of ['hidden/leak.md', 'calibration/reference.json', 'contamination-patterns.json']) {
    const manifest = structuredClone(original)
    const content = 'Private input'
    const { sha256 } = await import('../evals/agent-runner/and-scene-define/lib/files.mjs')
    await mkdir(join(customSuite, 'starting-repo/tree', path, '..'), { recursive: true })
    await writeFile(join(customSuite, 'starting-repo/tree', path), content)
    manifest.allowlist.push(path)
    manifest.files.push({ path, mode: '100644', sha256: sha256(content) })
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(materialize(join(root, 'stage'), { suiteRoot: customSuite }), /forbidden snapshot path/)
    await rm(join(customSuite, 'starting-repo/tree', path))
  }
  await writeFile(manifestPath, JSON.stringify(original))
  await writeFile(join(customSuite, 'starting-repo/tree/README.md'), 'Changed content')
  await assert.rejects(materialize(join(root, 'stage'), { suiteRoot: customSuite }), /content hash mismatch/)
  assert(!(await readdir(root)).includes('stage'))
})

test('starting tree ignores host excludes and forcibly stages every allowlisted file', async t => {
  const root = await temporary(t)
  const xdg = join(root, 'xdg')
  await mkdir(join(xdg, 'git'), { recursive: true })
  await writeFile(join(xdg, 'git/ignore'), '.npmrc\n.validator/\n')
  const module = new URL('../evals/agent-runner/and-scene-define/lib/starting-repo.mjs', import.meta.url).href
  const script = `import { materialize } from ${JSON.stringify(module)}; console.log(JSON.stringify(await materialize(process.argv[1])))`
  const first = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, join(root, 'stage')], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: xdg } }))
  const manifest = JSON.parse(await readFile(join(suiteRoot, 'starting-repo/manifest.json')))
  assert.deepEqual(git(first.repoDir, 'ls-files').split('\n'), manifest.allowlist)
  assert.equal(first.treeHash, manifest.tree_hash)
  const repo = join(root, 'force')
  await mkdir(repo)
  await writeFile(join(repo, '.gitignore'), 'required.txt\n')
  await writeFile(join(repo, 'required.txt'), 'Required scaffold file\n')
  const { initializeTree } = await import('../evals/agent-runner/and-scene-define/lib/starting-repo.mjs')
  await initializeTree(repo, 2)
  assert.deepEqual(git(repo, 'ls-files').split('\n'), ['.gitignore', 'required.txt'])
  await assert.rejects(initializeTree(repo, 3), /file count.*expected 3.*found 2/)
})

for (const packed of [false, true]) {
  test(`canary scan detects unreachable ${packed ? 'packed' : 'loose'} Git blobs`, async t => {
    const root = await temporary(t)
    const stage = await materialize(join(root, 'stage'))
    const oid = execFileSync('git', ['-C', stage.repoDir, 'hash-object', '-w', '--stdin'], { input: 'Codagent-AI/and-scene\n', encoding: 'utf8' }).trim()
    assert(!git(stage.repoDir, 'rev-list', '--objects', '--all').includes(oid))
    if (packed) {
      execFileSync('git', ['-C', stage.repoDir, 'pack-objects', join(stage.repoDir, '.git/objects/pack/pack')], { input: `${oid}\n`, stdio: ['pipe', 'pipe', 'pipe'] })
      await rm(join(stage.repoDir, '.git/objects', oid.slice(0, 2), oid.slice(2)))
    }
    const matches = await scanCanaries({ stagedDir: join(root, 'stage') })
    assert(matches.some(match => match.file.includes(oid) && match.pattern === 'fixture-repository'))
  })
}
test('the starting tree carries a Validator config that agent-validator accepts', async () => {
  // agent-validator detect (run by the create step) requires a cli object and at least one entry point.
  const config = await readFile(resolve('evals/agent-runner/and-scene-define/starting-repo/tree/.validator/config.yml'), 'utf8')
  assert.match(config, /^base_branch: main$/m)
  assert.match(config, /^cli:\n {2}default_preference:\n {4}- claude$/m)
  assert.match(config, /^entry_points:\n {2}- path: \.$/m)
  assert.doesNotMatch(config, /entry_points: \[\]/)
})
