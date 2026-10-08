import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readJson } from './lib/persistence.mjs'
import { compareResults } from './lib/comparison.mjs'
export async function compareRuns(dirs) {
  if (dirs.length < 2) throw new Error('usage: node evals/agent-runner/and-scene-define/compare.mjs <run-dir> <run-dir>...')
  return compareResults(await Promise.all(dirs.map(dir => readJson(join(resolve(dir), 'result.json')))))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await compareRuns(process.argv.slice(2)), null, 2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
