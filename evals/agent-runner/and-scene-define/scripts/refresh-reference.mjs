#!/usr/bin/env node
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { FIXTURE, withFixture, git, fixtureFile, cliOptions } from '../lib/fixture.mjs'
import { SUITE_ROOT, sha256, writeJson, readJson } from '../lib/files.mjs'
import { checkInventory } from '../lib/inventory.mjs'

export async function refreshReference({ checkout, ref = FIXTURE.commit, output = join(SUITE_ROOT, 'hidden') } = {}) {
  return withFixture({ checkout, ref }, async (clone, commit) => {
    const prefix = `openspec/changes/${FIXTURE.change}/`
    const paths = git(clone, ['ls-tree', '-r', '--name-only', commit, '--', prefix]).trim().split('\n').filter(path =>
      ['proposal.md', 'design.md', 'test-plan.md'].some(name => path === prefix + name) || /^specs\/.+\/spec\.md$/.test(path.slice(prefix.length)))
    for (const name of ['proposal.md', 'design.md', 'test-plan.md']) if (!paths.includes(prefix + name)) throw new Error(`missing reference ${name}`)
    if (!paths.some(path => path.includes('/specs/'))) throw new Error('missing reference specs')
    await mkdir(output, { recursive: true })
    const temporary = await mkdtemp(join(output, '.reference-'))
    try {
      const files = [], citation_files = []
      for (const path of paths.sort()) {
        const content = fixtureFile(clone, commit, path)
        await mkdir(dirname(join(temporary, path)), { recursive: true })
        await writeFile(join(temporary, path), content)
        files.push({ path, sha256: sha256(content) })
      }
      const inventory = await readJson(join(SUITE_ROOT, 'hidden/inventory.json'))
      const citations = [...new Set(inventory.items.flatMap(item => item.sources.map(source => source.document)))].filter(path => !paths.includes(path)).sort()
      const citationRoot = join(output, 'citation-supplements')
      await rm(citationRoot, { recursive: true, force: true })
      await mkdir(citationRoot, { recursive: true })
      for (const path of citations) {
        if (!path.startsWith(prefix + 'tasks/')) throw new Error(`unexpected supplementary citation: ${path}`)
        if (!git(clone, ['ls-tree', commit, '--', path]).trim()) continue
        const content = fixtureFile(clone, commit, path)
        await mkdir(dirname(join(citationRoot, path)), { recursive: true })
        await writeFile(join(citationRoot, path), content)
        citation_files.push({ path, sha256: sha256(content) })
      }
      await rm(join(output, 'reference'), { recursive: true, force: true })
      await rename(temporary, join(output, 'reference'))
      const reference = { ...FIXTURE, commit, files, citation_files }
      await writeJson(join(output, 'reference.json'), reference)
      return reference
    } finally { await rm(temporary, { recursive: true, force: true }) }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = cliOptions(process.argv.slice(2))
  if (options.help) console.log('usage: refresh-reference.mjs [--checkout PATH] [--ref FULL_SHA] [--output HOST_DIR] [--check]\n--check compares the committed inventory against a fresh snapshot without replacing it.')
  else if (options.check) {
    const temporary = await mkdtemp(join(tmpdir(), 'define-refresh-'))
    try {
      await refreshReference({ ...options, output: temporary })
      const errors = await checkInventory({ referenceDir: join(temporary, 'reference'), citationDir: join(temporary, 'citation-supplements'), refresh: true })
      console.log(errors.length ? errors.join('\n') : 'Inventory quotes and coverage are current.')
      if (errors.length) process.exitCode = 1
    } finally { await rm(temporary, { recursive: true, force: true }) }
  } else await refreshReference({ ...options, output: options.output && resolve(options.output) })
}
