// Product-rubric calibration: judge a pinned set of inputs several times and report accuracy, spread, flip rates and
// decider reversals. A maintainer diagnostic: nothing here publishes anything or gates a candidate run.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJson } from './files.mjs'
export const MIN_REPEATS = 3
const GIT = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Calibration', GIT_AUTHOR_EMAIL: 'calibration@example.invalid', GIT_COMMITTER_NAME: 'Calibration', GIT_COMMITTER_EMAIL: 'calibration@example.invalid' }
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...GIT } })
// The reference has no workflow record, so the components that judge one do not apply to it.
export function referenceRubric(rubric) {
  const components = rubric.components.filter(component => component.reference_applicable !== false)
  return { ...rubric, components, automated_points: components.reduce((sum, component) => sum + component.points, 0) }
}
const majority = verdicts => { const pass = verdicts.filter(verdict => verdict === 'pass').length; return pass * 2 > verdicts.length ? 'pass' : 'fail' }
const criteriaOf = rubric => rubric.components.flatMap(component => component.subcomponents.flatMap(subcomponent => subcomponent.criteria))
const checksOf = (ids, spec = {}) => [...(spec.pass === 'all' ? ids.map(id => ({ id, expect: 'pass' })) : (spec.pass ?? []).map(id => ({ id, expect: 'pass' }))), ...(spec.fail ?? []).map(id => ({ id, expect: 'fail' }))]
// One pass's line for watching a long calibration: its score and the criteria that missed their expected verdict.
export function passLine({ rubric, inputId, repeat, spec, run }) {
  const misses = checksOf(criteriaOf(rubric), spec?.expect).filter(check => (run.verdicts[check.id]?.verdict ?? 'fail') !== check.expect)
  return `calibration ${inputId} repeat ${repeat}: score ${run.score.automated_score}; ${misses.length ? `missed ${misses.map(miss => `${miss.id} (expected ${miss.expect})`).join(', ')}` : 'no misses'}`
}
// Pure summary of repeated runs: runs[inputId] = [{ score: { automated_score }, verdicts: { id: { verdict } }, judge_records }]
export function summarizeCalibration({ rubric, expected, runs }) {
  const limits = rubric.limits
  const ids = criteriaOf(rubric)
  const inputs = {}
  for (const [inputId, repeats] of Object.entries(runs)) {
    const scores = repeats.map(run => run.score.automated_score)
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length
    const perCriterion = Object.fromEntries(ids.map(id => [id, repeats.map(run => run.verdicts[id]?.verdict ?? 'fail')]))
    const verdict = Object.fromEntries(ids.map(id => [id, majority(perCriterion[id])]))
    const flips = Object.fromEntries(ids.map(id => { const pass = perCriterion[id].filter(v => v === 'pass').length; return [id, Math.min(pass, repeats.length - pass) / repeats.length] }))
    const checks = checksOf(ids, expected.inputs[inputId]?.expect)
    const misses = checks.filter(check => verdict[check.id] !== check.expect)
    let reversals = 0
    for (const run of repeats) for (const results of Object.values(run.judge_records ?? {})) for (const result of results) {
      if (!String(result.basis ?? '').startsWith('decider')) continue
      const votes = (result.votes ?? []).map(vote => vote.verdict)
      if (votes.length && majority(votes) !== result.verdict) reversals++
    }
    inputs[inputId] = { kind: expected.inputs[inputId]?.kind ?? null, repeats: repeats.length, scores, mean, spread: Math.max(...scores) - Math.min(...scores), accuracy: { correct: checks.length - misses.length, total: checks.length, rate: checks.length ? (checks.length - misses.length) / checks.length : null, misses: misses.map(check => ({ criterion: check.id, expected: check.expect, observed: verdict[check.id] })) },
      criterion_flip_rates: flips, flipping_criteria: Object.entries(flips).filter(([, rate]) => rate > 0).map(([id, rate]) => ({ id, rate })), decider_reversals: reversals, verdicts: verdict }
  }
  const failures = []
  const reference = inputs.reference
  for (const [inputId, input] of Object.entries(inputs)) {
    if (input.spread > limits.spread_limit) failures.push({ type: 'spread-exceeded', input: inputId, spread: input.spread, limit: limits.spread_limit })
    if (input.kind === 'preference-shifted' && reference) {
      const loss = reference.mean - input.mean
      if (loss > limits.calibration_tolerance) failures.push({ type: 'preference-shift-penalized', input: inputId, loss, tolerance: limits.calibration_tolerance, criteria: ids.filter(id => reference.verdicts[id] === 'pass' && input.verdicts[id] === 'fail') })
    }
    if (input.kind === 'degraded') {
      const wrongly = input.accuracy.misses.filter(miss => miss.expected === 'fail' && miss.observed === 'pass').map(miss => miss.criterion)
      if (wrongly.length) failures.push({ type: 'removed-mandatory-judged-met', input: inputId, criteria: wrongly })
    }
  }
  return { rubric_id: rubric.rubric_id, rubric_version: rubric.version, provisional: rubric.provisional, provisional_note: rubric.provisional ? 'provisional: calibration alone does not approve the rubric; approval needs a maintainer and an identical-input rescore of the first live run' : null,
    expected_verdicts_approved_by: expected.approved_by ?? null, limits, inputs, failures, published: false }
}
// Reference inputs as bundles: the pinned reference, and the reference with each variant patch applied on the candidate branch.
export async function prepareInput({ calibrationDir, inputId, spec, workDir }) {
  const reference = join(calibrationDir, 'reference.bundle')
  if (!spec.patch) return { bundlePath: reference, commit: git(await clone(reference, workDir, inputId), ['rev-parse', 'HEAD']).trim() }
  const checkout = await clone(reference, workDir, inputId)
  git(checkout, ['apply', join(calibrationDir, spec.patch)])
  git(checkout, ['add', '-A']); git(checkout, ['commit', '--quiet', '-m', `calibration variant ${inputId}`])
  const bundlePath = join(workDir, `${inputId}.bundle`)
  git(checkout, ['bundle', 'create', bundlePath, 'main', 'add-presentation-skill'])
  return { bundlePath, commit: git(checkout, ['rev-parse', 'HEAD']).trim() }
}
async function clone(bundle, workDir, name) {
  const checkout = join(workDir, `${name}-checkout`)
  await rm(checkout, { recursive: true, force: true })
  execFileSync('git', ['clone', '--quiet', '--no-checkout', bundle, checkout], { env: { PATH: process.env.PATH, ...GIT } })
  git(checkout, ['branch', '-f', 'main', 'origin/main'])
  git(checkout, ['checkout', '--quiet', '-B', 'add-presentation-skill', 'origin/add-presentation-skill'])
  return checkout
}
export async function runCalibration({ calibrationDir, rubric, repeats = MIN_REPEATS, evaluate, outDir = null, log = () => {} }) {
  if (!Number.isInteger(repeats) || repeats < MIN_REPEATS) throw Object.assign(new Error(`calibration needs at least ${MIN_REPEATS} repeats per input, got ${repeats}`), { usage: true })
  const expected = await readJson(join(calibrationDir, 'expected-verdicts.json'))
  const work = await mkdtemp(join(tmpdir(), 'e2e-calibrate-'))
  const runs = {}
  try {
    for (const [inputId, spec] of Object.entries(expected.inputs)) {
      const input = await prepareInput({ calibrationDir, inputId, spec, workDir: work })
      runs[inputId] = []
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const run = await evaluate({ inputId, repeat, input, spec })
        // Every calibration input builds, so a failed build is a harness problem; judging on would score nothing real.
        if (run.build?.ok === false) throw new Error(`calibration stopped: ${inputId} repeat ${repeat} did not build (${run.build.reason})${run.build.record ? `; see ${run.build.record}` : ''}`)
        runs[inputId].push(run)
        log(passLine({ rubric: referenceRubric(rubric), inputId, repeat, spec, run }))
      }
    }
  } finally { await rm(work, { recursive: true, force: true }) }
  const summary = summarizeCalibration({ rubric: referenceRubric(rubric), expected, runs })
  if (outDir) { await mkdir(outDir, { recursive: true }); const { writeJsonAtomic } = await import('../../../lib/define-run/persistence.mjs'); await writeJsonAtomic(join(outDir, 'calibration.json'), summary) }
  return summary
}
