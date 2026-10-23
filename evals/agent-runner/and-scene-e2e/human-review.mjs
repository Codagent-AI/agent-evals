#!/usr/bin/env node
// Completes a pending-human-review run: serves the retained build, runs and-scene's unchanged interview with
// its pinned questions and scale, then rewrites the result as complete and publishes it.
import { createInterface } from 'node:readline/promises'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SCENE_ROOT, REPO_ROOT, readJson } from './lib/files.mjs'
import { checkReviewProvenance, createReviewState, runInterview, scoreHumanReview } from '../and-scene/lib/human-review.mjs'
import { loadCheckpoint } from '../../lib/define-run/checkpoint.mjs'
import { writeJsonAtomic } from '../../lib/define-run/persistence.mjs'
import { cloneFromBundle } from './lib/delivery.mjs'
import { buildProduct } from './lib/build-plan.mjs'
import { serveOutput } from './lib/serve.mjs'
import { runContainer } from './lib/container.mjs'
import { assembleResult, writeResultArtifacts } from './lib/result.mjs'
import { publishRun, publicationEligibility } from './lib/publication.mjs'
import { loadProductInputs } from './lib/product-rubric.mjs'
export const HUMAN_RUBRIC_PATH = join(SCENE_ROOT, 'human-rubric.json')
export async function loadHumanRubric(path = HUMAN_RUBRIC_PATH) {
  const text = await readFile(path)
  const rubric = JSON.parse(text)
  return { ...rubric, sha256: createHash('sha256').update(text).digest('hex') }
}
// The retained build output is served again; on another machine it is rebuilt from the bundle with the recorded plan.
export async function ensureBuild({ runDir, product, run = runContainer }) {
  const output = join(runDir, '.product/build', product.build.output)
  if (await access(join(output, 'index.html')).then(() => true, () => false)) return output
  const worktree = await cloneFromBundle({ runDir, target: join(runDir, '.product/worktree') })
  const built = await buildProduct({ worktree, copyDir: join(runDir, '.product/build'), plan: product.build_plan, run })
  if (!built.ok) throw new Error(`the retained product no longer builds: ${built.reason}`)
  return built.output_dir
}
export async function runHumanReview({ runDir, io, serve = serveOutput, build = ensureBuild, noPublish = false, publish = publishRun, repoDir = REPO_ROOT, humanRubricPath = HUMAN_RUBRIC_PATH }) {
  runDir = resolve(runDir)
  const saved = await readJson(join(runDir, 'result.json'), null)
  if (!saved) throw new Error(`${runDir} holds no result.json`)
  if (saved.evaluation_status === 'complete') return { status: 'already-complete', result: saved }
  if (saved.evaluation_status !== 'pending-human-review') throw new Error(`human review applies only to a pending run, not ${saved.evaluation_status}`)
  const rubric = await loadHumanRubric(humanRubricPath)
  const product = await readJson(join(runDir, 'phases/product-result.json'))
  const delivery = await readJson(join(runDir, 'phases/delivery.json'))
  const candidate = { candidate_identity: `${saved.run_id}@${delivery.delivered_commit}` }
  const statePath = join(runDir, 'human-review/state.json')
  await mkdir(join(runDir, 'human-review'), { recursive: true })
  let state = await readJson(statePath, null)
  if (state) {
    const mismatch = checkReviewProvenance(state, { candidate, rubric })
    if (mismatch.length) throw new Error(`the saved review belongs to a different candidate or rubric: ${mismatch.map(item => item.field).join(', ')}`)
  } else state = createReviewState({ candidate, rubric })
  const output = await build({ runDir, product })
  const server = await serve({ root: output })
  let outcome
  try { outcome = await runInterview({ rubric, state, candidateUrl: server.url, io, persist: async next => { state = next; await writeJsonAtomic(statePath, next) } }) }
  finally { await server.close?.() }
  if (!outcome.confirmed) return { status: outcome.interrupted ? 'interrupted' : 'unfinished', score: outcome.score }
  const score = scoreHumanReview(rubric, outcome.state)
  // The floor and the minimum individual rating are reported and never applied.
  const review = { complete: true, points: score.total, possible: score.possible, floor: score.floor, floor_reached: score.total >= score.floor, lowest_rating: score.lowest_rating, min_individual_rating: rubric.min_individual_rating,
    min_individual_rating_met: score.lowest_rating >= rubric.min_individual_rating, subtotals: score.subtotals, responses: outcome.state.responses, rubric: { id: rubric.rubric_id, version: rubric.version, sha256: rubric.sha256 }, completed_at: outcome.state.completed_at }
  await writeJsonAtomic(join(runDir, 'human-review/review.json'), review)
  const checkpoint = await loadCheckpoint(join(runDir, 'run-state.json'))
  const inputs = await loadProductInputs()
  const result = await assembleResult({ runDir, outcome: { evaluation_status: 'complete', resumable: false }, checkpoint, rubric: inputs.rubric })
  await writeResultArtifacts({ runDir, result })
  let published = null
  if (!noPublish && publicationEligibility(result)) published = await publish({ runDir, repoDir, result })
  return { status: 'complete', result, published }
}
function terminal() {
  const lines = createInterface({ input: process.stdin, output: process.stdout })
  let closed = false; lines.on('close', () => { closed = true })
  return { write: text => console.log(text), ask: async prompt => { if (closed) return null; try { return await lines.question(prompt) } catch { return null } }, close: () => lines.close() }
}
async function main() {
  const args = process.argv.slice(2)
  const runDirIndex = args.indexOf('--run-dir')
  if (runDirIndex < 0 || !args[runDirIndex + 1]) { console.error('usage: human-review.sh [--no-publish] --run-dir RUN_DIR'); process.exitCode = 1; return }
  const io = terminal()
  try {
    const outcome = await runHumanReview({ runDir: args[runDirIndex + 1], io, noPublish: args.includes('--no-publish') })
    console.log(JSON.stringify({ status: outcome.status, evaluation_status: outcome.result?.evaluation_status ?? null, product_score: outcome.result?.product_score ?? null }, null, 2))
    process.exitCode = ['complete', 'already-complete'].includes(outcome.status) ? 0 : 1
  } catch (error) { console.error(`and-scene-e2e human review: ${error.message}`); process.exitCode = 1 } finally { io.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
