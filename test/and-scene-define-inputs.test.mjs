import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkInventory, assertPinnedInventory } from '../evals/agent-runner/and-scene-define/lib/inventory.mjs'
import { checkVersions, validateVersionRecords } from '../evals/agent-runner/and-scene-define/lib/versions.mjs'
import { sha256 } from '../evals/agent-runner/and-scene-define/lib/files.mjs'

const suite = resolve('evals/agent-runner/and-scene-define')
const document = 'openspec/changes/create-and-scene/specs/example/spec.md'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'define-inventory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'reference', document, '..'), { recursive: true })
  const content = '# Specs\n## Requirement: Useful\nThe tool SHALL work.\n### Scenario: Success\nIt works.\n## Other\nA quote elsewhere.\n'
  await writeFile(join(root, 'reference', document), content)
  await writeFile(join(root, 'prompt.md'), 'Build a useful tool.\n')
  const source = { repository: 'https://github.com/Codagent-AI/and-scene.git', commit: 'ad667a965a0e1ea0b028c36c04d57bf0411d30d9', change: 'create-and-scene' }
  const labels = { opus: { class: 'mandatory', confidence: 'high' }, codex: { class: 'mandatory', confidence: 'high' } }
  const item = { id: 'INV-001', area: 'example', kind: 'behavior', title: 'Useful', statement: 'The tool works.', sources: [{ document, heading: 'Requirement: Useful', quote: 'The tool SHALL work.' }], class: 'mandatory', intent: null, intent_source: null, labels, resolution: 'agreed', anchors: { met: 'Commits to working.', partial: 'Works with an unresolved detail.', missing: 'Does not commit to working.' } }
  const inventory = { inventory_version: 1, source, inputs: { starting_prompt: { path: 'prompt.md', sha256: sha256('Build a useful tool.\n') } }, counts: { mandatory: 1, 'acceptable-alternative': 0, preference: 0 }, items: [item], coverage: [{ document, requirement: 'Requirement: Useful', scenario: null, items: [item.id] }, { document, requirement: 'Requirement: Useful', scenario: 'Scenario: Success', items: [item.id] }], excluded: [] }
  inventory.reconciliation = { by: 'maintainer', rules: {} }
  const original = Object.fromEntries(Object.entries(item).filter(([key]) => !['class', 'intent', 'intent_source', 'labels', 'resolution', 'anchors'].includes(key)))
  const itemData = JSON.stringify({ source, items: [original] })
  const brief = 'Classify independently.\n'
  await writeFile(join(root, 'items.json'), itemData)
  await writeFile(join(root, 'brief.md'), brief)
  inventory.inputs.items = { path: 'items.json', sha256: sha256(itemData) }
  inventory.inputs.brief = { path: 'brief.md', version: 1, sha256: sha256(brief) }
  inventory.inputs.labels = []
  for (const [labeller, model] of [['opus', 'claude-opus'], ['codex', 'gpt-6']]) {
    const text = JSON.stringify({ labeller, model, brief_version: 1, labels: [{ id: item.id, ...labels[labeller], intent: null }] })
    await writeFile(join(root, `${labeller}.json`), text)
    inventory.inputs.labels.push({ labeller, model, path: `${labeller}.json`, sha256: sha256(text) })
  }
  const reference = { ...source, files: [{ path: document, sha256: sha256(content) }] }
  return { root, inventory, reference }
}

test('committed inventory is pinned, traceable, complete, and versioned', async () => {
  await assertPinnedInventory({ suiteRoot: suite })
  assert.deepEqual(await checkVersions({ suiteRoot: suite }), [])
  const inventory = JSON.parse(await readFile(join(suite, 'hidden/inventory.json')))
  const reference = JSON.parse(await readFile(join(suite, 'hidden/reference.json')))
  assert(reference.files.every(file => !file.path.includes('/tasks/') && !file.path.endsWith('/tasks.md')))
  assert.equal(reference.citation_files.length, 2)
  assert.deepEqual(inventory.counts, { mandatory: 24, 'acceptable-alternative': 48, preference: 48 })
})

test('synthetic inventory passes', async t => {
  const f = await fixture(t)
  assert.deepEqual(await checkInventory({ hiddenDir: f.root, inventory: f.inventory, reference: f.reference }), [])
})

for (const [name, mutate, expected] of [
  ['missing pinned input', f => { delete f.inventory.inputs.items }, /missing.*items/],
  ['input hash', f => { f.inventory.inputs.starting_prompt.sha256 = '0'.repeat(64) }, /prompt.md/],
  ['snapshot hash', f => { f.reference.files[0].sha256 = '0'.repeat(64) }, /snapshot.*example/],
  ['stale quote', f => { f.inventory.items[0].sources[0].quote = 'Missing quote' }, /INV-001.*quote.*example/],
  ['quote outside cited heading', f => { f.inventory.items[0].sources[0].quote = 'A quote elsewhere.' }, /INV-001.*quote/],
  ['missing scenario', f => { f.inventory.coverage.pop() }, /unmapped.*Scenario: Success/],
  ['missing requirement', f => { f.inventory.coverage.shift() }, /unmapped.*Requirement: Useful/],
  ['dangling mapping', f => { f.inventory.coverage[1].items = ['INV-999'] }, /INV-999/],
  ['exclusion without reason', f => { f.inventory.coverage.pop(); f.inventory.excluded.push({ document, heading: 'Scenario: Success', reason: '' }) }, /exclusion.*Scenario: Success/],
  ['multiple classes', f => { f.inventory.items[0].class = ['mandatory', 'preference'] }, /INV-001.*class/],
  ['alternative without intent', f => { f.inventory.items[0].class = 'acceptable-alternative' }, /INV-001.*intent/],
  ['preference with intent', f => { f.inventory.items[0].class = 'preference'; f.inventory.items[0].intent = 'Useful' }, /INV-001.*intent/],
  ['unresolved disagreement', f => { f.inventory.items[0].labels.codex.class = 'preference'; f.inventory.items[0].resolution = 'reconciled' }, /INV-001.*disagreement/],
  ['unpinned commit', f => { f.reference.commit = 'f'.repeat(40) }, /pin/],
]) {
  test(`inventory rejects ${name}`, async t => {
    const f = await fixture(t)
    mutate(f)
    assert.match((await checkInventory({ hiddenDir: f.root, inventory: f.inventory, reference: f.reference })).join('\n'), expected)
  })
}

async function alternative(f, intent) {
  const item = f.inventory.items[0]
  const label = { class: 'acceptable-alternative', confidence: 'high' }
  Object.assign(item, { class: 'acceptable-alternative', intent, intent_source: 'maintainer', labels: { opus: label, codex: label } })
  f.inventory.counts = { mandatory: 0, 'acceptable-alternative': 1, preference: 0 }
  for (const input of f.inventory.inputs.labels) {
    const text = JSON.stringify({ labeller: input.labeller, model: input.model, brief_version: 1, labels: [{ id: item.id, ...label, intent: 'The tool works.' }] })
    await writeFile(join(f.root, input.path), text)
    input.sha256 = sha256(text)
  }
  return item
}

test('a maintainer intent with a recorded reason replaces the labellers\' intent', async t => {
  const f = await fixture(t)
  const item = await alternative(f, 'The tool works without wrapping.')
  item.intent_reason = 'The maintainer requires the boundary behavior.'
  assert.deepEqual(await checkInventory({ hiddenDir: f.root, inventory: f.inventory, reference: f.reference }), [])
})

test('a maintainer intent without a reason is rejected', async t => {
  const f = await fixture(t)
  await alternative(f, 'The tool works without wrapping.')
  assert.match((await checkInventory({ hiddenDir: f.root, inventory: f.inventory, reference: f.reference })).join('\n'), /INV-001.*maintainer intent.*reason/)
})

test('an intent reason belongs only to a maintainer intent', async t => {
  const f = await fixture(t)
  f.inventory.items[0].intent_reason = 'Stray.'
  assert.match((await checkInventory({ hiddenDir: f.root, inventory: f.inventory, reference: f.reference })).join('\n'), /INV-001.*intent_reason/)
})

test('refresh reports stale quotes and new requirements and scenarios', async t => {
  const f = await fixture(t)
  const updated = join(f.root, 'new-reference')
  await mkdir(join(updated, document, '..'), { recursive: true })
  await writeFile(join(updated, document), '# Specs\n## Requirement: Useful\nChanged text.\n### Scenario: Success\nIt works.\n## Requirement: New\nNew need.\n### Scenario: New behavior\nNew scenario.\n')
  const errors = await checkInventory({ hiddenDir: f.root, inventory: f.inventory, reference: f.reference, referenceDir: updated, refresh: true })
  assert.match(errors.join('\n'), /INV-001.*quote/)
  assert.match(errors.join('\n'), /unmapped.*Requirement: New/)
  assert.match(errors.join('\n'), /unmapped.*Scenario: New behavior/)
})

test('reasoned exclusions satisfy coverage', async t => {
  const f = await fixture(t)
  f.inventory.coverage.pop()
  f.inventory.excluded.push({ document, requirement: 'Requirement: Useful', heading: 'Scenario: Success', reason: 'Not a product obligation.' })
  assert.deepEqual(await checkInventory({ hiddenDir: f.root, inventory: f.inventory, reference: f.reference }), [])
})

test('version ledger rejects changed content without a version bump and preserves history', () => {
  const old = { inventory: { path: 'hidden/inventory.json', version: 1, hashes: { 1: 'a'.repeat(64) } } }
  const changed = structuredClone(old)
  changed.inventory.hashes[1] = 'b'.repeat(64)
  assert.match(validateVersionRecords(changed, old).join('\n'), /inventory.*version 1/)
  const bumped = structuredClone(old)
  bumped.inventory.version = 2
  bumped.inventory.hashes[2] = 'b'.repeat(64)
  assert.deepEqual(validateVersionRecords(bumped, old), [])
  delete bumped.inventory.hashes[1]
  assert.match(validateVersionRecords(bumped, old).join('\n'), /version 1/)
})

test('version checker rejects changed file content and self-consistent hash rewrites', async t => {
  const root = await mkdtemp(join(tmpdir(), 'define-versions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'hidden'))
  const inputs = {}
  for (const [name, path, text] of [
    ['rubric', 'rubric.json', '{"rubric_version":1}'],
    ['inventory', 'hidden/inventory.json', '{"inventory_version":1}'],
    ['starting-prompt', 'hidden/starting-prompt.md', 'Prompt'],
    ['simulated-user-policy', 'hidden/simulated-user-policy.md', 'Policy'],
    ['contamination-patterns', 'contamination-patterns.json', '{"version":1}'],
  ]) {
    await writeFile(join(root, path), text)
    inputs[name] = { path, version: 1, hashes: { 1: sha256(text) } }
  }
  const previous = { inputs: structuredClone(inputs) }
  await writeFile(join(root, 'versions.json'), JSON.stringify({ inputs }))
  assert.deepEqual(await checkVersions({ suiteRoot: root, previous }), [])
  await writeFile(join(root, 'hidden/starting-prompt.md'), 'Changed prompt')
  assert.match((await checkVersions({ suiteRoot: root, previous })).join('\n'), /starting-prompt.*content hash/)
  inputs['starting-prompt'].hashes[1] = sha256('Changed prompt')
  await writeFile(join(root, 'versions.json'), JSON.stringify({ inputs }))
  assert.match((await checkVersions({ suiteRoot: root, previous })).join('\n'), /starting-prompt.*version 1/)
  inputs['starting-prompt'].version = 2
  inputs['starting-prompt'].hashes[2] = sha256('Changed prompt')
  inputs['starting-prompt'].hashes[1] = previous.inputs['starting-prompt'].hashes[1]
  await writeFile(join(root, 'versions.json'), JSON.stringify({ inputs }))
  assert.deepEqual(await checkVersions({ suiteRoot: root, previous }), [])
})

async function versionRepository(t) {
  const { cp } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'define-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'hidden'))
  for (const path of ['versions.json', 'rubric.json', 'contamination-patterns.json', 'hidden/inventory.json', 'hidden/starting-prompt.md', 'hidden/simulated-user-policy.md']) await cp(join(suite, path), join(root, path))
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init')
  return { root, git }
}

test('version history allows a genuinely uncommitted ledger and its first introduction', async t => {
  const { root, git } = await versionRepository(t)
  assert.deepEqual(await checkVersions({ suiteRoot: root }), [])
  await writeFile(join(root, 'scaffold.txt'), 'Scaffold')
  git('add', 'scaffold.txt')
  git('commit', '-m', 'scaffold')
  assert.deepEqual(await checkVersions({ suiteRoot: root }), [])
  git('add', '.')
  git('commit', '-m', 'introduce ledger')
  assert.deepEqual(await checkVersions({ suiteRoot: root }), [])
})

test('version history catches a committed hash rewrite without a bump', async t => {
  const { root, git } = await versionRepository(t)
  git('add', '.')
  git('commit', '-m', 'introduce ledger')
  const ledger = JSON.parse(await readFile(join(root, 'versions.json')))
  await writeFile(join(root, 'hidden/starting-prompt.md'), 'Changed prompt')
  ledger.inputs['starting-prompt'].hashes[1] = sha256('Changed prompt')
  await writeFile(join(root, 'versions.json'), JSON.stringify(ledger))
  git('add', '.')
  git('commit', '-m', 'rewrite hash')
  assert.match((await checkVersions({ suiteRoot: root })).join('\n'), /starting-prompt.*version 1/)
})

test('version history fails closed outside Git, without Git, and with incomplete shallow history', async t => {
  const { root, git } = await versionRepository(t)
  const { execFileSync } = await import('node:child_process')
  git('add', '.')
  git('commit', '-m', 'introduce ledger')
  await writeFile(join(root, 'scaffold.txt'), 'Scaffold')
  git('add', '.')
  git('commit', '-m', 'next commit')
  const shallow = join(root, 'shallow')
  execFileSync('git', ['clone', '--depth=1', `file://${root}`, shallow], { stdio: 'pipe' })
  assert.match((await checkVersions({ suiteRoot: shallow })).join('\n'), /baseline unavailable/)
  const module = new URL('../evals/agent-runner/and-scene-define/lib/versions.mjs', import.meta.url).href
  const script = `import { checkVersions } from ${JSON.stringify(module)}; console.log(JSON.stringify(await checkVersions({suiteRoot:process.argv[1]})))`
  const noGit = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, root], { encoding: 'utf8', env: { ...process.env, PATH: join(root, 'no-bin') } }))
  assert.match(noGit.join('\n'), /baseline unavailable.*git.*unavailable/)
  await rm(join(root, '.git'), { recursive: true })
  assert.match((await checkVersions({ suiteRoot: root })).join('\n'), /baseline unavailable/)
})

test('version history surfaces git log and git show failures instead of omitting baselines', async t => {
  const { root, git } = await versionRepository(t)
  const { execFileSync } = await import('node:child_process')
  git('add', '.')
  git('commit', '-m', 'introduce ledger')
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'git'), '#!/bin/sh\nfor argument do\n  if [ "$argument" = "$DEFINE_TEST_FAIL" ]; then exit 2; fi\ndone\nexec "$DEFINE_TEST_GIT" "$@"\n', { mode: 0o755 })
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const module = new URL('../evals/agent-runner/and-scene-define/lib/versions.mjs', import.meta.url).href
  const script = `import { checkVersions } from ${JSON.stringify(module)}; console.log(JSON.stringify(await checkVersions({suiteRoot:process.argv[1]})))`
  for (const command of ['log', 'show']) {
    const errors = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, root], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEFINE_TEST_GIT: realGit, DEFINE_TEST_FAIL: command } }))
    assert.match(errors.join('\n'), /baseline unavailable/)
    assert.match(errors.join('\n'), new RegExp(` ${command} `))
  }
})
