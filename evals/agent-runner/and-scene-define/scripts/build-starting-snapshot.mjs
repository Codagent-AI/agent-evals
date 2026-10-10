#!/usr/bin/env node
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { SUITE_ROOT, sha256, writeJson } from '../lib/files.mjs'
import { FIXTURE, withFixture, fixtureFile, cliOptions } from '../lib/fixture.mjs'
import { CHANGE_NAME, initializeTree } from '../lib/starting-repo.mjs'

export const ALLOWLIST = [
  '.gitignore', '.npmrc', '.validator/config.yml', 'AGENTS.md', 'CLAUDE.md', 'README.md',
  'eslint.config.js', 'index.html', 'package.json', 'package-lock.json',
  'src/App.tsx', 'src/App.css', 'src/index.css', 'src/main.tsx',
  'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts',
].sort()
const neutral = {
  'AGENTS.md': '# Project\n\nThis repository contains a Vite, React, and TypeScript scaffold.\n\nUse test-driven development for behavior changes. Run the applicable tests, lint, and build before reporting completion. Use chrome-devtools-axi for browser inspection. Keep changes within the repository and do not commit generated output or dependencies.\n\nUse commit messages of the form `type: lowercase description`.\n',
  'CLAUDE.md': 'See AGENTS.md for repository guidance.\n',
  'README.md': '# Project\n\nA minimal Vite, React, and TypeScript application scaffold.\n\nRun `npm ci`, then `npm run dev` for development. Use `npm run lint` and `npm run build` to check changes.\n',
  // agent-validator detect requires a cli object and at least one entry point. Product-specific
  // reviews and networked checks are omitted.
  '.validator/config.yml': 'base_branch: main\ncli:\n  default_preference:\n    - claude\n  adapters:\n    claude:\n      allow_tool_use: false\n      thinking_budget: low\n      model: claude-sonnet-5-5\nentry_points:\n  - path: .\n    checks:\n      - build:\n          command: npm run build\n      - lint:\n          command: npm run lint\n      - typecheck:\n          command: npx tsc -b --noEmit\n    reviews:\n      - all-reviewers:\n          builtin: all-reviewers\n',
  'src/App.tsx': "import './App.css'\n\nexport default function App() {\n  return <main><h1>Project</h1><p>Application scaffold.</p></main>\n}\n",
  'src/App.css': 'main { max-width: 60rem; margin: 0 auto; padding: 2rem; }\n',
  'src/index.css': 'body { margin: 0; font-family: system-ui, sans-serif; }\n',
  'index.html': '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Project</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
}
function rewrite(path, original) {
  if (neutral[path]) return { content: Buffer.from(neutral[path]), reason: 'Replace product identity, target guidance, or product-specific page with neutral scaffold content.' }
  if (path === 'package.json' || path === 'package-lock.json') {
    const data = JSON.parse(original)
    data.name = 'project-scaffold'
    if (data.packages?.['']) data.packages[''].name = 'project-scaffold'
    return { content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`), reason: 'Neutralize the package identity; retain pinned scaffold dependencies.' }
  }
  return { content: original }
}
export async function buildStartingSnapshot({ checkout, output = join(SUITE_ROOT, 'starting-repo') } = {}) {
  return withFixture({ checkout }, async clone => {
    await mkdir(dirname(output), { recursive: true })
    const temporary = await mkdtemp(join(dirname(output), '.starting-'))
    const hashDir = await mkdtemp(join(tmpdir(), 'define-tree-build-'))
    try {
      const files = [], rewrites = []
      for (const path of ALLOWLIST) {
        // CLAUDE.md in the fixture is a symlink to AGENTS.md; replace it with a neutral regular file.
        const original = fixtureFile(clone, FIXTURE.commit, path === 'CLAUDE.md' ? 'AGENTS.md' : path)
        const { content, reason } = rewrite(path, original)
        for (const root of [join(temporary, 'tree'), hashDir]) {
          await mkdir(dirname(join(root, path)), { recursive: true })
          await writeFile(join(root, path), content)
        }
        files.push({ path, mode: '100644', sha256: sha256(content), source_sha256: sha256(original), source_path: path === 'CLAUDE.md' ? 'AGENTS.md' : path })
        if (reason) rewrites.push({ path, reason, sha256: sha256(content) })
      }
      const manifest = { snapshot_version: 1, source: FIXTURE, change_name: CHANGE_NAME, allowlist: ALLOWLIST, rewrites, files, tree_hash: await initializeTree(hashDir, files.length) }
      await writeJson(join(temporary, 'manifest.json'), manifest)
      await rm(output, { recursive: true, force: true })
      await rename(temporary, output)
      return manifest
    } finally {
      await rm(temporary, { recursive: true, force: true })
      await rm(hashDir, { recursive: true, force: true })
    }
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = cliOptions(process.argv.slice(2))
  if (options.help) console.log('usage: build-starting-snapshot.mjs [--checkout PATH] [--output HOST_DIR]\nBuilds the neutral allowlisted scaffold at the suite fixture pin.')
  else {
    if (options.ref || options.check) throw new Error('starting snapshot only accepts the suite fixture pin')
    await buildStartingSnapshot({ ...options, output: options.output && resolve(options.output) })
  }
}
