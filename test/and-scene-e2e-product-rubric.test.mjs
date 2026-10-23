import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { git, temp } from './and-scene-e2e-helpers.mjs'
import { AND_SCENE_REQUIREMENT_LIMIT, SCOPE_ITEMS, checkPreferenceValues, checkProductInputs, graded, loadProductInputs, requirementDocument, validateProductRubric, criterionRequirement, rubricRows } from '../evals/agent-runner/and-scene-e2e/lib/product-rubric.mjs'
import { buildJudgeRequest, judgeJobs } from '../evals/agent-runner/and-scene-e2e/lib/judge-requests.mjs'
import { materializeNeutral } from '../evals/agent-runner/and-scene-e2e/lib/neutral.mjs'
import { EVIDENCE_JOBS } from '../evals/agent-runner/and-scene-e2e/lib/product-rubric.mjs'

const inputs = await loadProductInputs()
const clone = value => structuredClone(value)
const errorsOf = rubric => validateProductRubric(rubric, inputs.inventory, { preferenceValues: inputs.preferenceValues })
const component = (rubric, id) => rubric.components.find(entry => entry.id === id)
const subOf = (rubric, criterion) => rubric.components.flatMap(entry => entry.subcomponents).find(subcomponent => subcomponent.criteria.includes(criterion))

test('INT-008 the real rubric validates with 70 automated points and every graded item cited or excluded', async () => {
  assert.deepEqual(errorsOf(inputs.rubric), [])
  assert.equal(inputs.rubric.components.reduce((sum, entry) => sum + entry.points, 0), 70)
  assert.equal(inputs.rubric.provisional, true)
  const cited = new Set([...Object.values(inputs.rubric.criterion_sources).flatMap(source => source.inventory ?? []), ...inputs.rubric.gates.flatMap(gate => gate.inventory), ...inputs.rubric.exclusions.map(entry => entry.id)])
  for (const item of inputs.inventory.items.filter(graded)) assert.ok(cited.has(item.id), item.id)
  for (const entry of inputs.rubric.exclusions) { assert.ok(entry.reason.trim()); assert.ok(entry.approved_by.trim()) }
  for (const key of ['pass_threshold', 'automated_pass_threshold']) assert.ok(!(key in inputs.rubric))
  assert.ok(inputs.rubric.components.every(entry => !('floor' in entry)))
  assert.deepEqual(await checkProductInputs(), [])
})

test('INT-008 each mutation is rejected naming the criterion and the item or value', () => {
  const expectError = (mutate, pattern) => { const rubric = clone(inputs.rubric); mutate(rubric); assert.ok(errorsOf(rubric).some(error => pattern.test(error)), `expected ${pattern}; got ${errorsOf(rubric).join(' | ')}`) }
  const preference = inputs.inventory.items.find(item => item.id === 'INV-033')
  assert.equal(preference.class, 'preference')
  expectError(r => { r.criterion_sources['canvas-uniform-scaling'].inventory.push('INV-033') }, /canvas-uniform-scaling cites preference item INV-033/)
  expectError(r => { subOf(r, 'canvas-uniform-scaling').review_guidance.push('Require the default 880 × 380 canvas.') }, /preference value 880/)
  expectError(r => { delete r.criterion_sources['navigation-keyboard'].inventory }, /fixture-owned criterion navigation-keyboard cites no inventory item/)
  expectError(r => { r.criterion_sources['navigation-keyboard'].inventory = [] }, /fixture-owned criterion navigation-keyboard cites no inventory item/)
  expectError(r => { r.criterion_sources['testing-evidence-usable-proof'].reason = ' ' }, /eval-owned criterion testing-evidence-usable-proof requires a reason/)
  expectError(r => { delete r.criterion_sources['testing-evidence-usable-proof'].presumes }, /testing-evidence-usable-proof must list the inventory items it presumes/)
  expectError(r => { r.criterion_sources['engineering-bootstrap-scripts-generic'].presumes = ['INV-113'] }, /engineering-bootstrap-scripts-generic presumes preference item INV-113/)
  expectError(r => { r.exclusions = r.exclusions.filter(entry => entry.id !== 'INV-112'); }, /INV-112 is cited by no criterion or gate/)
  expectError(r => { for (const [id, source] of Object.entries(r.criterion_sources)) if (source.inventory) source.inventory = source.inventory.filter(item => item !== 'INV-001') ; r.exclusions = r.exclusions.filter(entry => entry.id !== 'INV-001') }, /mandatory item INV-001 is cited by no criterion/)
  expectError(r => { delete subOf(r, 'navigation-keyboard').tiers['navigation-keyboard'] }, /criterion navigation-keyboard has no tier/)
  expectError(r => { component(r, 'scene-kit-correctness').tier_weights.critical = 3 }, /tier weight critical 3 exceeds 2/)
  expectError(r => { r.limits.max_requirement_chars = 200 }, /requirement text is \d+ characters, over the 200 limit/)
  expectError(r => { r.limits.max_requirement_chars = AND_SCENE_REQUIREMENT_LIMIT }, /max_requirement_chars must be below 40000/)
  expectError(r => { r.pass_threshold = 70 }, /must not declare pass_threshold/)
  expectError(r => { r.automated_pass_threshold = 40 }, /must not declare automated_pass_threshold/)
  expectError(r => { component(r, 'scene-kit-correctness').floor = 12.5 }, /component scene-kit-correctness must not declare a floor/)
  expectError(r => { r.criterion_sources['demo-scope-discipline'].inventory = ['INV-105'] }, /scope-discipline criterion must cite INV-105, INV-106, INV-107, INV-108/)
  expectError(r => { delete r.fallbacks['demo-sample-explains-skill'] }, /browser-judge criterion demo-sample-explains-skill requires a fallback/)
  expectError(r => { r.fallbacks['demo-sample-explains-skill'].job = 'testing-evidence' }, /fallback demo-sample-explains-skill must name a source-review job/)
  expectError(r => { r.exclusions[0].approved_by = '' }, /exclusion INV-112 requires approved_by/)
  expectError(r => { r.exclusions.push({ id: 'INV-033', reason: 'x', approved_by: 'y' }) }, /exclusion INV-033 is a preference item/)
  expectError(r => { r.gates.pop() }, /exactly the gates/)
})

test('INT-008 a value also quoted by a cited graded item is allowed; an uncited concrete value is not', () => {
  const rubric = clone(inputs.rubric)
  const sub = subOf(rubric, 'canvas-uniform-scaling')
  sub.review_guidance.push('A step lasting 4242 ms is fine.')
  assert.ok(errorsOf(rubric).some(error => /uncited concrete value 4242 ms/.test(error)))
  sub.review_guidance.pop()
  // aria-current is declared eval-owned with a reason, so it is accounted for.
  sub.review_guidance.push('Expose the active step with aria-current.')
  assert.deepEqual(errorsOf(rubric), [])
})

test('INT-008 preference values all occur in a preference item quote; an invented value is reported', () => {
  assert.deepEqual(checkPreferenceValues({ values: inputs.preferenceValues, inventory: inputs.inventory }), [])
  assert.deepEqual(checkPreferenceValues({ values: [...inputs.preferenceValues, 'invented-value'], inventory: inputs.inventory }), ["preference value invented-value occurs in no preference item's quote"])
})

test('INT-008 requirement documents hold statements, intents and quotes only, for graded items only', () => {
  const alt = inputs.inventory.items.find(item => item.id === 'INV-032')
  const doc = requirementDocument(alt)
  assert.match(doc, /\(acceptable-alternative\)/); assert.match(doc, /Intent: /); assert.match(doc, /takes precedence over any mechanism/)
  for (const source of alt.sources) assert.ok(doc.includes(source.quote))
  const mandatory = requirementDocument(inputs.inventory.items.find(item => item.id === 'INV-001'))
  assert.doesNotMatch(mandatory, /Intent:|takes precedence/)
  const text = criterionRequirement(inputs.rubric, inputs.inventory, 'canvas-uniform-scaling')
  assert.ok(text.includes('INV-032') && text.includes('INV-034')); assert.ok(!/INV-033/.test(text)); assert.ok(!/880|380/.test(text))
  assert.match(criterionRequirement(inputs.rubric, inputs.inventory, 'testing-evidence-usable-proof'), /^Requirement \(eval-owned\): /)
  assert.deepEqual(inputs.rubric.criterion_sources['demo-scope-discipline'].inventory, SCOPE_ITEMS)
  assert.equal(inputs.inventory.items.filter(graded).length, 72)
})

test('INT-008 no judge packet carries preference text or the candidate definition; evidence jobs list the collected definition', async t => {
  const root = await temp(t, 'e2e-neutral-')
  const repo = join(root, 'repo'); await mkdir(join(repo, 'openspec/changes/add-presentation-skill/specs'), { recursive: true }); await mkdir(join(repo, 'src'), { recursive: true })
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo])
  await writeFile(join(repo, 'openspec/changes/add-presentation-skill/specs/spec.md'), 'WEAKENED-CANDIDATE-SPEC: nothing is required'); await writeFile(join(repo, 'src/app.ts'), 'export const x = 1\n')
  git(repo, ['add', '-A']); git(repo, ['commit', '--quiet', '-m', 'work'])
  const commit = git(repo, ['rev-parse', 'HEAD'])
  const neutral = await materializeNeutral({ runDir: root, repo, commit, inventory: inputs.inventory })
  assert.deepEqual(neutral.source_paths, ['src/app.ts'])
  assert.equal((await readFile(join(neutral.requirements_root, 'INV-032.md'), 'utf8')).includes('880'), false)
  assert.equal(await readFile(join(neutral.requirements_root, 'INV-033.md'), 'utf8').catch(() => null), null)
  const evidence = { root: join(root, 'neutral/evidence'), paths: ['definition/proposal.md', 'acceptance/readiness.json'], chars: 100 }
  const preferenceText = inputs.inventory.items.filter(item => item.class === 'preference').flatMap(item => [item.title, item.statement])
  for (const job of judgeJobs(inputs.rubric)) {
    const request = buildJudgeRequest({ rubric: inputs.rubric, inventory: inputs.inventory, job: job.id, neutral, sourcePaths: neutral.source_paths, evidence })
    // A preference value may appear only inside a cited graded item's own quote.
    const quoted = job.criteria.flatMap(id => inputs.rubric.criterion_sources[id]?.inventory ?? []).flatMap(id => inputs.inventory.items.find(item => item.id === id).sources.map(source => source.quote)).join('\n')
    for (const value of inputs.preferenceValues) assert.ok(!request.prompt.includes(value) || quoted.includes(value), `${job.id} packet contains ${value}`)
    for (const text of preferenceText) assert.ok(!request.prompt.includes(text), `${job.id} packet contains preference text`)
    assert.ok(!request.prompt.includes('WEAKENED-CANDIDATE-SPEC'))
    assert.equal(request.prompt.includes('definition/proposal.md'), EVIDENCE_JOBS.includes(job.id))
    assert.equal(request.input_roots.source, EVIDENCE_JOBS.includes(job.id) ? evidence.root : neutral.source_root)
  }
  const sceneKit = buildJudgeRequest({ rubric: inputs.rubric, inventory: inputs.inventory, job: 'scene-kit', neutral, sourcePaths: neutral.source_paths, evidence })
  assert.ok(sceneKit.prompt.includes('INV-032') && !/880|380/.test(sceneKit.prompt))
  // A weakened candidate specification changes nothing about what a criterion requires.
  assert.equal(criterionRequirement(inputs.rubric, inputs.inventory, 'navigation-keyboard'), criterionRequirement(inputs.rubric, inputs.inventory, 'navigation-keyboard'))
})

import { requirementDocument as docOf } from '../evals/agent-runner/and-scene-e2e/lib/product-rubric.mjs'
test('I-75 the requirement bound is exact: the text at the bound passes, one character over is rejected naming the criterion', () => {
  const rubric = clone(inputs.rubric)
  const lengths = Object.fromEntries(Object.entries(rubric.criterion_sources).filter(([, source]) => source.owner === 'fixture').map(([id, source]) => [id, source.inventory.map(item => docOf(inputs.inventory.items.find(candidate => candidate.id === item))).join('\n\n').length]))
  const [longest, length] = Object.entries(lengths).sort((a, b) => b[1] - a[1])[0]
  rubric.limits.max_requirement_chars = length; assert.deepEqual(errorsOf(rubric), [])
  rubric.limits.max_requirement_chars = length - 1
  assert.ok(errorsOf(rubric).some(error => error.includes(`criterion ${longest} requirement text is ${length} characters, over the ${length - 1} limit`)))
  assert.ok(rubric.limits.max_requirement_chars < AND_SCENE_REQUIREMENT_LIMIT); assert.ok(inputs.rubric.limits.max_requirement_chars < AND_SCENE_REQUIREMENT_LIMIT)
})
test('I-77 a browser criterion whose fallback names a missing job, no requirement, or a stray criterion is rejected', () => {
  const expectError = (mutate, pattern) => { const rubric = clone(inputs.rubric); mutate(rubric); assert.ok(errorsOf(rubric).some(error => pattern.test(error)), errorsOf(rubric).join('|')) }
  expectError(r => { r.fallbacks['demo-sample-explains-skill'].job = 'no-such-job' }, /fallback demo-sample-explains-skill must name a source-review job/)
  expectError(r => { r.fallbacks['demo-sample-explains-skill'].requirement = ' ' }, /fallback demo-sample-explains-skill requires a requirement/)
  expectError(r => { r.fallbacks['navigation-keyboard'] = { job: 'scene-kit', requirement: 'x' } }, /fallback navigation-keyboard must name a browser-judge criterion/)
})
