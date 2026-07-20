// Result assembly and the durable artifact set.
//
// `result.json` is the authoritative machine-readable outcome, and it is
// assembled only from validated phase artifacts — this module computes no score
// of its own. Its job is to say exactly what is known, and to keep everything
// that is *not* known from looking like a zero:
//
//   * `official_score` exists only for a durable product verdict.
//   * `automated_subtotal` exists only when every automated component scored.
//   * Components that did score are preserved as `available_component_scores`
//     and are never summed into an unofficial total.
//   * A reference baseline marks Agent Runner roles, cost, and timing
//     `not-applicable`; they are not zero, and no delta may treat them as zero.
//   * Completeness is reported per dimension, so an unavailable usage figure
//     never silently downgrades cost, pricing, or evidence completeness.
//
// `report.html` and `artifact-manifest.json` are written from the same result in
// one step, so the three artifacts always describe the same run.
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { outcomeLabel } from './outcomes.mjs'
import { hashFile, writeJsonAtomic } from './persistence.mjs'
import { renderReport } from './report.mjs'

export const RESULT_SCHEMA_VERSION = 2
export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1

// Runtime scratch: candidate worktrees, linked run stores, and anything else a
// disposable container needs. It is never a deliberate artifact and never enters
// the manifest or the published snapshot.
export const EXCLUDED_ARTIFACT_DIRS = ['.runtime']

const NOT_APPLICABLE = 'not-applicable'

function notApplicable(baselineRun, value) {
  if (!baselineRun) return value ?? null
  return value === null || value === undefined ? NOT_APPLICABLE : value
}

function completenessOf({ mode, score, humanReview, cost, pricing, metrics, timing, evidence }) {
  const automatedComplete = (score?.components ?? []).every(({ complete }) => complete)
  return {
    score: score?.official_score === null || score?.official_score === undefined
      ? (automatedComplete ? 'automated-complete' : 'incomplete')
      : 'complete',
    evidence: automatedComplete ? 'complete' : 'incomplete',
    human_review: humanReview?.complete ? 'complete' : 'pending',
    implementation_usage: mode === 'reference-baseline'
      ? NOT_APPLICABLE
      : (cost?.implementation?.usage_complete === false ? 'unavailable' : (cost ? 'complete' : 'unavailable')),
    // Cost can be complete while usage is unavailable: Agent Runner may report an
    // attempt cost without the token breakdown behind it.
    implementation_cost: mode === 'reference-baseline'
      ? NOT_APPLICABLE
      : (cost?.implementation?.complete ? 'complete' : 'incomplete'),
    pricing: pricing ? (pricing.verified ? 'verified' : 'unverified') : 'unavailable',
    timing: timing ? 'complete' : 'unavailable',
    // Agent Runner's own report that it lost metric records is preserved as
    // itself rather than folded into the coverage computed from what survived.
    metric_history: mode === 'reference-baseline'
      ? NOT_APPLICABLE
      : (metrics ? (metrics.history_complete === false ? 'incomplete' : 'complete') : 'unavailable'),
    workflow_provenance: evidence?.workflow_provenance ?? (mode === 'reference-baseline' ? NOT_APPLICABLE : 'complete'),
  }
}

export function assembleResult({
  runId,
  mode = 'agent-runner',
  outcome,
  rubrics,
  score = null,
  humanReview = null,
  browser = null,
  sourceEvidence = null,
  judging = null,
  workflow = null,
  metrics = null,
  cost = null,
  pricing = null,
  timing = null,
  ambiguity = null,
  roleConfiguration = null,
  artifacts = [],
  baseline = null,
  timings = [],
  evidence = null,
}) {
  const baselineRun = mode === 'reference-baseline'
  const components = score?.components ?? []
  const automatedComplete = components.length > 0 && components.every(({ complete }) => complete)

  return {
    schema_version: RESULT_SCHEMA_VERSION,
    run_id: runId,
    mode,
    evaluation_status: outcome.evaluation_status,
    product_verdict: outcome.product_verdict,
    label: outcomeLabel(outcome),
    // Only a durable verdict carries an official score.
    official_score: outcome.verdict_durable ? (outcome.official_score ?? score?.official_score ?? null) : null,
    // The subtotal is a statement about the whole automated rubric, so a partial
    // automated phase reports none at all rather than a smaller number that
    // reads like a worse product.
    automated_subtotal: automatedComplete ? (score?.automated_subtotal ?? null) : null,
    // Preserved as evidence, deliberately never summed.
    available_component_scores: automatedComplete
      ? []
      : components
        .filter(({ complete }) => complete)
        .map(({ id, title, points_awarded, points_possible }) => ({
          id, title, points_awarded, points_possible,
        })),
    incomplete_components: components.filter(({ complete }) => !complete).map(({ id }) => id),
    failed_phase: outcome.failed_phase,
    failure: outcome.failure,
    resumable: outcome.resumable,
    cleanup: outcome.cleanup,
    history: outcome.history,
    rubrics,
    score,
    human_review: humanReview,
    browser_evaluation: browser,
    source_evidence: sourceEvidence,
    judging,
    workflow,
    ambiguity,
    // A reference baseline ran no Agent Runner, so an absent value here is
    // "not applicable", never zero and never empty. A caller that has a richer
    // not-applicable record of its own — per-role configuration, say — keeps it.
    role_configuration: notApplicable(baselineRun, roleConfiguration),
    implementation_metrics: notApplicable(baselineRun, metrics),
    cost: notApplicable(baselineRun, cost),
    implementation_timing: notApplicable(baselineRun, metrics?.active_duration_ms ?? null),
    pricing,
    timing,
    timings,
    completeness: completenessOf({ mode, score, humanReview, cost, pricing, metrics, timing, evidence }),
    baseline,
    artifacts,
    report: { written: true, error: null },
  }
}

async function walk(root, directory, collected) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const path = relative(root, absolute).split(sep).join('/')
    if (EXCLUDED_ARTIFACT_DIRS.includes(path.split('/')[0])) continue
    // Staging files from an interrupted atomic write are not artifacts.
    if (entry.name.endsWith('.tmp')) continue
    if (entry.isDirectory()) {
      await walk(root, absolute, collected)
      continue
    }
    if (!entry.isFile()) continue
    collected.push({ path, bytes: (await stat(absolute)).size, sha256: await hashFile(absolute) })
  }
  return collected
}

// The durable inventory of deliberate run artifacts. It is rebuilt from the
// directory on every write rather than accumulated, so a manifest never claims
// an artifact a later run replaced or removed. It excludes itself: it is the
// index, not one of the things indexed.
export async function buildArtifactManifest(runDir, { runId = null } = {}) {
  const collected = (await walk(runDir, runDir, []))
    .filter(({ path }) => path !== 'artifact-manifest.json')
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    excluded: [...EXCLUDED_ARTIFACT_DIRS],
    artifacts: collected,
  }
}

export async function writeResult({ runDir, result }) {
  return writeJsonAtomic(join(runDir, 'result.json'), result)
}

// The report is a required artifact. If it cannot be rendered, the durable
// verdict already on disk survives: the result is rewritten to record the
// missing report and is never downgraded, and the failure is raised so the
// lifecycle records it as a harness failure.
export async function writeReport({ runDir, result, renderReportImpl = renderReport }) {
  let html
  try {
    html = renderReportImpl(result, { current: result })
  } catch (error) {
    await writeJsonAtomic(join(runDir, 'result.json'), {
      ...result,
      report: { written: false, error: error.message },
    })
    throw error
  }
  await writeFile(join(runDir, 'report.html'), html)
  return join(runDir, 'report.html')
}

export async function writeManifest({ runDir, runId }) {
  const manifest = await buildArtifactManifest(runDir, { runId })
  await writeJsonAtomic(join(runDir, 'artifact-manifest.json'), manifest)
  return manifest
}

// Write the three durable artifacts in dependency order: the result first, so it
// is the authority; then the report rendered from it; then the manifest, which
// inventories both.
export async function writeResultArtifacts({ runDir, result, renderReportImpl = renderReport }) {
  const resultPath = await writeResult({ runDir, result })
  const reportPath = await writeReport({ runDir, result, renderReportImpl })
  const manifest = await writeManifest({ runDir, runId: result.run_id })
  return { resultPath, reportPath, manifestPath: join(runDir, 'artifact-manifest.json'), manifest, errors: [] }
}
