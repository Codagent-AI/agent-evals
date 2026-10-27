import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { temp, E2E } from './and-scene-e2e-helpers.mjs'
import { DEFAULT_REPEATS, prepareInput, referenceRubric, runCalibration, scopedRubric, summarizeCalibration } from '../evals/agent-runner/and-scene-e2e/lib/calibration.mjs'
import { calibrate, parseCalibrationArguments } from '../evals/agent-runner/and-scene-e2e/calibrate.mjs'
import { loadProductInputs } from '../evals/agent-runner/and-scene-e2e/lib/product-rubric.mjs'

const product = await loadProductInputs()
const dir = join(E2E, 'calibration')
const expected = JSON.parse(await readFile(join(dir, 'expected-verdicts.json'), 'utf8'))
const rubric = referenceRubric(product.rubric)
const ids = rubric.components.flatMap(c => c.subcomponents.flatMap(s => s.criteria))
const pass = (overrides = {}) => Object.fromEntries(ids.map(id => [id, { verdict: overrides[id] ?? 'pass' }]))
const run = (score, verdicts, records = {}) => ({ score: { automated_score: score }, verdicts, judge_records: records })
// The criteria the pinned reference is expected to fail, so a faithful judge of the reference fails exactly these.
const shortfalls = Object.fromEntries(expected.inputs.reference.expect.fail.map(id => [id, 'fail']))

test('INT-011 every real patch applies cleanly to the pinned reference bundle; preference shifts keep the verifier\'s hooks and mandatory behavior', async t => {
  const work = await temp(t, 'e2e-cal-')
  const trees = {}
  for (const [inputId, spec] of Object.entries(expected.inputs)) {
    const input = await prepareInput({ calibrationDir: dir, inputId, spec, workDir: work })
    assert.match(input.commit, /^[0-9a-f]{40}$/)
    const checkout = join(work, `${inputId}-check`); execFileSync('git', ['clone', '--quiet', '--branch', 'add-presentation-skill', input.bundlePath, checkout])
    trees[inputId] = checkout
  }
  const read = (id, path) => readFile(join(trees[id], path), 'utf8')
  const hooks = async id => (await Promise.all(['src/presentation-kit/chrome/Footer.tsx'].map(path => read(id, path)))).join('\n')
  // The reference's own verifier reads these hooks, so a preference shift that removed them would break verification.
  for (const id of ['reference', 'preference-shifted', 'preference-shifted-chrome']) assert.match(await hooks(id), /data-step-count=\{steps\.length\}[\s\S]*data-step-index=\{step\}/, id)
  assert.match(await read('preference-shifted', 'src/presentation-kit/constants.ts'), /DESIGN_W = 960/); assert.match(await read('preference-shifted', 'src/presentations/index.ts'), /slug: 'tour'/)
  const steps = text => (text.match(/\bid: '/g) ?? []).length
  assert.equal(steps(await read('reference', 'src/presentations/how-to-make-a-presentation/outline.ts')) - steps(await read('preference-shifted', 'src/presentations/how-to-make-a-presentation/outline.ts')), 1, 'the step count changed')
  assert.match(await read('preference-shifted', 'src/presentations/how-to-make-a-presentation/outline.ts'), /title: 'Part: /)
  // Mandatory and alternative behavior is kept: the navigation hook is intact in the shifted copy.
  assert.equal(await read('preference-shifted', 'src/presentation-kit/usePresentationNav.ts'), await read('reference', 'src/presentation-kit/usePresentationNav.ts'))
  const chrome = await read('preference-shifted-chrome', 'src/presentation-kit/Presentation.tsx')
  assert.match(chrome, /attribution = 'built with and-scene'/); assert.match(chrome, /left: 16,\n\s*bottom: 8/)
  assert.match(await read('preference-shifted-chrome', 'src/presentation-kit/usePresentationNav.ts'), /e\.key === 'm' \|\| e\.key === 'M'/)
  assert.match(await read('preference-shifted-chrome', 'src/presentations/how-to-make-a-presentation/Talk.tsx'), /initialMode="present"/)
  assert.doesNotMatch(await read('degraded-captions-missing', 'src/presentation-kit/chrome/Footer.tsx'), /\{current\.caption\}/)
  // Left behind, the caption's step lookup is an unused local and the reference's type check fails the build.
  assert.doesNotMatch(await read('degraded-captions-missing', 'src/presentation-kit/chrome/Footer.tsx'), /const current = /)
  assert.match(await read('degraded-mode-toggle-loses-position', 'src/presentation-kit/usePresentationNav.ts'), /setStep\(0\); setMode/)
  assert.doesNotMatch(await read('degraded-focused-controls-lose-keys', 'src/presentation-kit/usePresentationNav.ts'), /closest\('button, a, input/)
  // The skill vendors a byte-identical snapshot of the kit, so every variant changes both copies alike.
  for (const id of Object.keys(trees)) {
    const kit = execFileSync('git', ['-C', trees[id], 'ls-files', 'src/presentation-kit'], { encoding: 'utf8' }).split('\n').filter(path => path && !/\.test\./.test(path))
    for (const path of kit) assert.equal(await read(id, path.replace('src/', 'skills/presentation/templates/bootstrap/src/')), await read(id, path), `${id}: ${path} matches its skill snapshot`)
  }
  // The reference's verifier requires its sample's slug, so a slug shift renames it there too.
  assert.match(await read('preference-shifted', 'scripts/verify-lib.mjs'), /REFERENCE_SLUG = 'tour'/)
  assert.match(await read('preference-shifted', 'src/presentation-kit/constants.test.ts'), /toBe\(960\)/); assert.match(await read('preference-shifted', 'src/presentations/how-to-make-a-presentation/outline.test.ts'), /toHaveLength\(8\)/)
  assert.match(await read('preference-shifted-chrome', 'src/presentation-kit/usePresentationNav.test.ts'), /key: 'm'/)
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'reference.json'), 'utf8')).reference_ref, '171c7def1e12aca2a5f605a5e5feafb20d4e4d19')
  for (const entry of Object.values(expected.inputs)) for (const id of [...(entry.expect.fail ?? []), ...(Array.isArray(entry.expect.pass) ? entry.expect.pass : [])]) assert.ok(ids.includes(id), id)
  assert.ok(expected.approved_by?.trim(), 'the maintainer approved the expected verdicts')
})

test('INT-011 zero repeats are refused; one is accepted; three by default; a dry run makes no model call', async t => {
  assert.throws(() => parseCalibrationArguments(['--calibrate', '--repeats', '0']), /at least 1 repeat/)
  assert.equal(parseCalibrationArguments(['--calibrate', '--repeats', '1']).repeats, 1); assert.equal(parseCalibrationArguments(['--calibrate']).repeats, DEFAULT_REPEATS); assert.equal(DEFAULT_REPEATS, 3)
  await assert.rejects(runCalibration({ calibrationDir: dir, rubric: product.rubric, repeats: 0, evaluate: async () => { throw new Error('no') } }), /at least 1 repeat/)
  const dry = await calibrate({ ...parseCalibrationArguments(['--calibrate', '--dry-run']) }, { evaluate: async () => { throw new Error('a dry run must not judge') } })
  assert.equal(dry.dry_run, true); assert.equal(dry.model_calls, 0); assert.equal(dry.published, false); assert.deepEqual(dry.inputs, Object.keys(expected.inputs))
  const cli = spawnSync('bash', [join(E2E, 'run.sh'), '--calibrate', '--repeats', '0'], { encoding: 'utf8' })
  assert.notEqual(cli.status, 0); assert.match(cli.stderr, /at least 1 repeat/)
})

test('INT-011 --inputs judges only the named inputs, in set order, and refuses an unknown one', async t => {
  const options = parseCalibrationArguments(['--calibrate', '--inputs', 'degraded-captions-missing, preference-shifted', '--repeats', '1'])
  assert.deepEqual(options.inputs, ['degraded-captions-missing', 'preference-shifted'])
  assert.deepEqual((await calibrate({ ...options, dryRun: true })).inputs, ['preference-shifted', 'degraded-captions-missing'])
  const judged = []
  const report = await runCalibration({ calibrationDir: dir, rubric: product.rubric, repeats: 1, inputs: options.inputs, evaluate: async ({ inputId }) => { judged.push(inputId); return run(62, pass(inputId === 'preference-shifted' ? shortfalls : { 'quality-captions-and-navigation': 'fail' })) } })
  assert.deepEqual(judged, ['preference-shifted', 'degraded-captions-missing']); assert.deepEqual(Object.keys(report.inputs), judged)
  await assert.rejects(calibrate({ ...parseCalibrationArguments(['--calibrate', '--inputs', 'nope', '--dry-run']) }), /unknown calibration input: nope/)
  await assert.rejects(runCalibration({ calibrationDir: dir, rubric: product.rubric, repeats: 1, inputs: ['nope'], evaluate: async () => { throw new Error('no') } }), /unknown calibration input: nope/)
})

test('INT-011 a degraded input is judged only on the subcomponents holding its expected failures and their fallback job', async () => {
  const subcomponentsOf = scoped => scoped.components.flatMap(component => component.subcomponents.map(subcomponent => subcomponent.id))
  const captions = scopedRubric(rubric, expected.inputs['degraded-captions-missing'])
  // The browser criterion falls back to the demo-integration source job, so that job's subcomponents come along.
  assert.deepEqual(subcomponentsOf(captions).sort(), ['demo-canonical-content', 'demo-code-boundaries', 'demo-identity-and-grouping', 'demo-scene-kit-integration'])
  const toggle = scopedRubric(rubric, expected.inputs['degraded-mode-toggle-loses-position'])
  assert.ok(subcomponentsOf(toggle).includes('scene-modes-and-navigation') && subcomponentsOf(toggle).includes('demo-navigation-and-modes'))
  assert.ok(!subcomponentsOf(toggle).includes('scene-step-model'), 'other scene-kit subcomponents are not judged')
  for (const scoped of [captions, toggle]) {
    for (const component of scoped.components) assert.equal(component.points, component.subcomponents.reduce((sum, subcomponent) => sum + subcomponent.points, 0))
    assert.equal(scoped.automated_points, scoped.components.reduce((sum, component) => sum + component.points, 0))
  }
  assert.equal(scopedRubric(rubric, expected.inputs['preference-shifted']), rubric, 'a preference shift is judged on the whole rubric')
  const given = {}
  const report = await runCalibration({ calibrationDir: dir, rubric: product.rubric, repeats: 1, inputs: ['reference', 'degraded-captions-missing'], evaluate: async ({ inputId, rubric: judged }) => { given[inputId] = judged; return run(62, inputId === 'reference' ? pass(shortfalls) : { 'quality-captions-and-navigation': { verdict: 'fail' } }) } })
  assert.deepEqual(subcomponentsOf(given['degraded-captions-missing']), subcomponentsOf(captions)); assert.deepEqual(subcomponentsOf(given.reference), subcomponentsOf(rubric))
  assert.equal(report.inputs['degraded-captions-missing'].scoped, true); assert.equal(report.inputs.reference.scoped, false); assert.equal(report.inputs['degraded-captions-missing'].accuracy.rate, 1)
})

test('INT-011 the report shows per-input scores, spread, accuracy, flip rates and decider reversals computed from the repeats', () => {
  const flip = id => (n) => ({ verdict: n === 1 ? 'fail' : 'pass' })
  const reversed = { 'scene-kit': [{ id: 'x', verdict: 'pass', basis: 'decider-pass', votes: [{ verdict: 'fail' }, { verdict: 'fail' }, { verdict: 'pass' }] }, { id: 'y', verdict: 'pass', basis: 'consensus-pass', votes: [{ verdict: 'pass' }] }] }
  const runs = {
    reference: [0, 1, 2].map(n => run(62, pass(n === 1 ? { ...shortfalls, 'navigation-keyboard': 'fail' } : shortfalls), n === 0 ? reversed : {})),
    'preference-shifted': [0, 1, 2].map(() => run(60, pass(shortfalls))),
    'degraded-mode-toggle-loses-position': [0, 1, 2].map(() => run(58, pass({ 'mode-toggle-preserves-position': 'fail', 'demo-mode-position-preservation': 'fail' }))),
    'degraded-focused-controls-lose-keys': [0, 1, 2].map(() => run(58, pass({ 'navigation-controls-keep-keys': 'fail', 'demo-navigation-boundaries-and-control-keys': 'fail' }))),
  }
  const report = summarizeCalibration({ rubric, expected, runs })
  assert.deepEqual(report.inputs.reference.scores, [62, 62, 62]); assert.equal(report.inputs.reference.spread, 0); assert.equal(report.inputs['preference-shifted'].mean, 60)
  assert.equal(report.inputs.reference.accuracy.total, ids.length); assert.equal(report.inputs.reference.accuracy.correct, ids.length, 'the majority verdict corrects one flip')
  assert.equal(report.inputs.reference.criterion_flip_rates['navigation-keyboard'], 1 / 3); assert.deepEqual(report.inputs.reference.flipping_criteria, [{ id: 'navigation-keyboard', rate: 1 / 3 }])
  assert.equal(report.inputs.reference.decider_reversals, 1)
  assert.equal(report.inputs['degraded-mode-toggle-loses-position'].accuracy.rate, 1); assert.deepEqual(report.failures, [])
  assert.equal(report.provisional, true); assert.match(report.provisional_note, /does not approve the rubric/); assert.equal(report.published, false)
})

test('INT-011 tolerance loss, a removed mandatory behavior judged met, and excess spread are reported naming criteria', () => {
  const runs = {
    reference: [0, 1, 2].map(() => run(62, pass())),
    'preference-shifted': [0, 1, 2].map(() => run(48, pass({ 'canvas-uniform-scaling': 'fail', 'demo-sample-step-content': 'fail' }))),
    'degraded-mode-toggle-loses-position': [0, 1, 2].map(() => run(62, pass())),
    'degraded-focused-controls-lose-keys': [62, 50, 62].map(score => run(score, pass({ 'navigation-controls-keep-keys': 'fail', 'demo-navigation-boundaries-and-control-keys': 'fail' }))),
  }
  const { failures } = summarizeCalibration({ rubric, expected, runs })
  const by = type => failures.filter(failure => failure.type === type)
  assert.deepEqual(by('preference-shift-penalized').map(failure => [failure.input, failure.criteria.sort()]), [['preference-shifted', ['canvas-uniform-scaling', 'demo-sample-step-content']]]); assert.equal(by('preference-shift-penalized')[0].tolerance, 6)
  assert.deepEqual(by('removed-mandatory-judged-met').map(failure => [failure.input, failure.criteria.sort()]), [['degraded-mode-toggle-loses-position', ['demo-mode-position-preservation', 'mode-toggle-preserves-position']]])
  assert.deepEqual(by('spread-exceeded').map(failure => [failure.input, failure.spread, failure.limit]), [['degraded-focused-controls-lose-keys', 12, 6]])
})

test('INT-011 a run produces no publication; the diagnostic never imports publication or the controller', async t => {
  const out = await temp(t, 'e2e-cal-out-')
  const real = await runCalibration({ calibrationDir: dir, rubric: product.rubric, repeats: 3, outDir: out, evaluate: async ({ inputId }) => run(62, pass(inputId.startsWith('degraded') ? { 'mode-toggle-preserves-position': 'fail', 'demo-mode-position-preservation': 'fail', 'navigation-controls-keep-keys': 'fail', 'demo-navigation-boundaries-and-control-keys': 'fail' } : {})) })
  assert.equal(real.published, false); assert.deepEqual((await readdir(out)).sort(), ['calibration.json'])
  for (const file of ['calibrate.mjs', 'lib/calibration.mjs']) assert.doesNotMatch(await readFile(join(E2E, file), 'utf8'), /publication|controller\.mjs/, file)
  assert.equal(JSON.parse(await readFile(join(E2E, 'versions.json'), 'utf8')).inputs['product-rubric'].version >= 1, true)
})

test('INT-011 each pass prints its score and misses; a pass whose input did not build stops calibration without a report', async t => {
  const lines = []
  await runCalibration({ calibrationDir: dir, rubric: product.rubric, repeats: 3, log: line => lines.push(line), evaluate: async ({ inputId }) => run(62, pass(inputId === 'degraded-captions-missing' ? { 'quality-captions-and-navigation': 'fail' } : inputId.startsWith('degraded') ? {} : shortfalls)) })
  assert.equal(lines.length, Object.keys(expected.inputs).length * 3)
  assert.ok(lines.includes('calibration reference repeat 1: score 62; no misses'))
  assert.ok(lines.includes('calibration degraded-captions-missing repeat 2: score 62; no misses'))
  assert.match(lines.find(line => line.startsWith('calibration degraded-mode-toggle-loses-position repeat 1')), /missed mode-toggle-preserves-position \(expected fail\)/)
  const out = await temp(t, 'e2e-cal-stop-')
  let passes = 0
  await assert.rejects(runCalibration({ calibrationDir: dir, rubric: product.rubric, repeats: 3, outDir: out, evaluate: async () => { passes++; return { ...run(0, pass()), build: { ok: false, reason: 'dependency installation failed', record: '/runs/reference-1/phases/product/build.json' } } } }),
    /calibration stopped: reference repeat 1 did not build \(dependency installation failed\); see \/runs\/reference-1/)
  assert.equal(passes, 1); assert.deepEqual(await readdir(out), [])
})
