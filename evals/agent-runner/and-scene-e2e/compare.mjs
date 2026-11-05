#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareResults } from './lib/comparison.mjs'
export async function loadResults(dirs) {
  return Promise.all(dirs.map(async dir => ({ ...JSON.parse(await readFile(join(resolve(dir), 'result.json'), 'utf8')), run_directory: resolve(dir) })))
}
async function main() {
  const dirs = process.argv.slice(2)
  if (dirs.length < 1) { console.error('usage: compare.mjs RUN_DIR [RUN_DIR ...]'); process.exitCode = 1; return }
  try { console.log(JSON.stringify(compareResults(await loadResults(dirs)), null, 2)) } catch (error) { console.error(`and-scene-e2e compare: ${error.message}`); process.exitCode = 1 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
