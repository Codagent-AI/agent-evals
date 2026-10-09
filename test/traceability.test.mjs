import { makeTempDir } from './temp-dir.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadFixtureSnapshot,
  normalizeTraceabilityText,
  validateTraceability,
} from '../evals/agent-runner/and-scene/lib/traceability.mjs'
import { fixtureRef, refreshSnapshot } from '../evals/agent-runner/and-scene/fixture-snapshot.mjs'

const fixture = {
  fixture_ref: 'fixture-pin',
  files: [{
    path: 'openspec/changes/create-and-scene/specs/example.md',
    blob: null,
    content: '## Scenario: Controls keep their keys\n\nNavigation keys drive that control rather than also advancing the deck. The fixture uses 880 × 380.\n',
  }],
}

const rubric = {
  components: [{ subcomponents: [{
    id: 'navigation', criteria: ['controls'], review_guidance: ['The viewport is 880×380.'],
  }] }],
  gates: [{ id: 'gate', requirement: 'The fixture requirement applies.' }],
  criterion_sources: {
    controls: {
      owner: 'fixture', document: fixture.files[0].path,
      heading: 'Scenario: Controls keep their keys',
      quote: 'Navigation keys drive that control rather than also advancing the deck.',
    },
    gate: { owner: 'eval', reason: 'Suite-owned gate.' },
  },
  eval_owned_values: [{ value: '880×380', reason: 'Suite inspection viewport.' }],
}

test('traceability accepts normalized citations and declared eval-owned values', () => {
  assert.equal(normalizeTraceabilityText('it’s  880 × 380'), "it's 880 x 380")
  assert.deepEqual(validateTraceability({ rubric, fixture, fixtureRef: 'fixture-pin' }), [])
})

test('committed rubric citations verify against the pinned offline snapshot', async () => {
  const committed = JSON.parse(await readFile('evals/agent-runner/and-scene/automated-rubric.json', 'utf8'))
  const snapshot = await loadFixtureSnapshot()
  // The pin comes from run.sh, not from this file: moving FIXTURE_REF without
  // refreshing the snapshot has to fail here.
  assert.deepEqual(validateTraceability({ rubric: committed, fixture: snapshot, fixtureRef: await fixtureRef() }), [])
  assert.match(
    validateTraceability({ rubric: committed, fixture: snapshot, fixtureRef: 'a'.repeat(40) }).join('\n'),
    /refresh the snapshot/,
  )
})

// Eval-owned is for requirements the fixture does not describe. It must stay a
// short, named list: a criterion the fixture specifies has to cite it, or its
// guidance escapes the check this file exists to run.
test('only criteria the fixture does not describe are eval-owned', async () => {
  const rubric = JSON.parse(await readFile(new URL('../evals/agent-runner/and-scene/automated-rubric.json', import.meta.url), 'utf8'))
  const evalOwned = Object.entries(rubric.criterion_sources)
    .filter(([, source]) => source.owner === 'eval')
    .map(([id]) => id)
    .sort()
  assert.deepEqual(evalOwned, [
    'assumption-consequential-ambiguities-surfaced',
    'assumption-decisions-and-escalations-proportionate',
    'assumption-final-handoff-preserves-decisions',
    'assumption-repository-facts-distinguished',
    'demo-clear-code-boundaries',
    'demo-scene-kit-api-use',
    'demo-scope-discipline',
    'engineering-bootstrap-scripts-generic',
    'engineering-checks-read-rendered-page',
    'engineering-diagnostics-cover-presentation',
    'engineering-inspect-fails-loudly',
    'engineering-presentation-css-scoped',
    'engineering-preview-readiness-bounded',
    'engineering-preview-terminated-on-every-exit',
    'engineering-skill-completion-report',
    'engineering-skill-description-triggers',
    'engineering-skill-out-of-scope-redirects',
    'engineering-templates-build-at-destination',
    'engineering-tests-isolate-resources',
    'engineering-tests-wait-on-state',
    'engineering-typed-kit-primitives',
    'input-modifier-keys-pass-through',
    'input-swipe-from-control-ignored',
    'testing-evidence-complete-honest-record',
    'testing-evidence-final-revision-applicability',
    'testing-evidence-traceable-coverage',
    'testing-evidence-usable-proof',
    'verification-preview-process-ownership',
  ])
  // A value the fixture states must be cited, never exempted as eval-owned.
  const fixture = await loadFixtureSnapshot()
  const fixtureText = normalizeTraceabilityText(fixture.files.map(({ content }) => content).join('\n')).replace(/\s+/g, '')
  for (const { value } of rubric.eval_owned_values) {
    if (/\d\s*[×x]\s*\d/.test(value)) {
      assert.equal(fixtureText.includes(normalizeTraceabilityText(value).replace(/\s+/g, '')), false, `${value} is a fixture dimension and must be cited, not exempted`)
    }
  }
})

test('traceability names missing source, missing quote, and uncited guidance values', () => {
  const mutated = structuredClone(rubric)
  delete mutated.criterion_sources.controls
  mutated.eval_owned_values = []
  mutated.components[0].subcomponents[0].review_guidance = ['The viewport is 880×495 and uses data-test-id.']
  const errors = validateTraceability({ rubric: mutated, fixture, fixtureRef: 'fixture-pin' })
  assert.match(errors.join('\n'), /controls.*source/i)
  assert.match(errors.join('\n'), /navigation.*880×495/)
  assert.match(errors.join('\n'), /navigation.*data-test-id/)
})

test('traceability accepts values backed by a multi-citation source on guidance, fallbacks, and gates', () => {
  const multi = structuredClone(rubric)
  multi.components[0].subcomponents[0].review_guidance = ['The fixture uses 880×380.']
  multi.eval_owned_values = []
  multi.criterion_sources.controls = {
    owner: 'fixture',
    sources: [{ ...rubric.criterion_sources.controls, quote: 'Navigation keys drive that control rather than also advancing the deck.' }],
  }
  multi.fallbacks = { controls: { requirement: 'The fixture uses 880×380.', guidance: [] } }
  multi.gates = [{ id: 'controls', requirement: 'The fixture uses 880×380.' }]
  assert.deepEqual(validateTraceability({ rubric: multi, fixture, fixtureRef: 'fixture-pin' }), [])
})

test('snapshot refresh copies fixture files with their git blob ids only at the fixture pin', async () => {
  const directory = await makeTempDir(join(tmpdir(), 'fixture-snapshot-'))
  const checkout = join(directory, 'checkout')
  const snapshot = join(directory, 'snapshot')
  await mkdir(join(checkout, 'openspec/changes/create-and-scene/specs'), { recursive: true })
  await writeFile(join(checkout, 'README.md'), 'fixture root\n')
  for (const name of ['evolving-scene-presentations', 'presentation-skill', 'presentation-verification']) {
    await writeFile(join(checkout, `openspec/changes/create-and-scene/specs/${name}/spec.md`), 'spec\n').catch(async () => {
      await mkdir(join(checkout, `openspec/changes/create-and-scene/specs/${name}`), { recursive: true })
      await writeFile(join(checkout, `openspec/changes/create-and-scene/specs/${name}/spec.md`), 'spec\n')
    })
  }
  execFileSync('git', ['-C', checkout, 'init', '-q'])
  execFileSync('git', ['-C', checkout, 'add', '.'])
  execFileSync('git', ['-C', checkout, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'])
  // The implementation accepts a supplied expected ref so this test never depends on this repository's pin.
  const ref = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  await writeFile(join(checkout, 'README.md'), 'uncommitted local edit\n')
  await refreshSnapshot(checkout, snapshot, ref)
  const written = JSON.parse(await readFile(join(snapshot, 'snapshot.json'), 'utf8'))
  assert.equal(written.fixture_ref, ref)
  assert.equal(written.files.find(({ path }) => path === 'fixture-root-README.md').blob,
    execFileSync('git', ['-C', checkout, 'ls-tree', 'HEAD', '--', 'README.md'], { encoding: 'utf8' }).trim().split(/\s+/)[2])
  assert.equal(await readFile(join(snapshot, 'fixture-root-README.md'), 'utf8'), 'fixture root\n')
})

test('criterion definitions are held to the same concrete-value check as review guidance', () => {
  const mutated = structuredClone(rubric)
  mutated.eval_owned_values = []
  mutated.components[0].subcomponents[0].criterion_definitions = { controls: 'Pass when data-step-label is shown.' }
  assert.match(
    validateTraceability({ rubric: mutated, fixture, fixtureRef: 'fixture-pin' }).join('\n'),
    /navigation.*data-step-label/,
  )
})

test('a criterion definition is checked against its own criterion sources only', () => {
  const twoCriteria = structuredClone(rubric)
  twoCriteria.eval_owned_values = []
  twoCriteria.components[0].subcomponents[0].review_guidance = ['Transitions take 300ms.']
  twoCriteria.components[0].subcomponents[0].criteria = ['controls', 'timing']
  const twoFixture = structuredClone(fixture)
  twoFixture.files[0].content += '\n## Scenario: Transitions are quick\n\nEach transition takes 300ms.\n'
  twoCriteria.criterion_sources.timing = {
    owner: 'fixture', document: fixture.files[0].path,
    heading: 'Scenario: Transitions are quick',
    quote: 'Each transition takes 300ms.',
  }

  // Review guidance spans the subcomponent, and timing's own definition is
  // backed by timing's citation.
  twoCriteria.components[0].subcomponents[0].criterion_definitions = {
    timing: 'Pass when each transition takes 300ms.',
  }
  assert.deepEqual(validateTraceability({ rubric: twoCriteria, fixture: twoFixture, fixtureRef: 'fixture-pin' }), [])

  // A citation approved for timing cannot justify the same value in the
  // controls definition.
  twoCriteria.components[0].subcomponents[0].criterion_definitions = {
    controls: 'Pass when control focus settles within 300ms.',
    timing: 'Pass when each transition takes 300ms.',
  }
  const errors = validateTraceability({ rubric: twoCriteria, fixture: twoFixture, fixtureRef: 'fixture-pin' })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /navigation.*controls.*300ms/)
})
