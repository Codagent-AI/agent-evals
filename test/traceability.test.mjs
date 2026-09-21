import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeTraceabilityText, validateTraceability } from '../evals/agent-runner/and-scene/lib/traceability.mjs'
import { refreshSnapshot } from '../evals/agent-runner/and-scene/fixture-snapshot.mjs'
import { loadFixtureSnapshot } from '../evals/agent-runner/and-scene/lib/traceability.mjs'
import { readFile as read } from 'node:fs/promises'

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
  const committed = JSON.parse(await read('evals/agent-runner/and-scene/automated-rubric.json', 'utf8'))
  const snapshot = await loadFixtureSnapshot()
  assert.deepEqual(validateTraceability({ rubric: committed, fixture: snapshot, fixtureRef: '892dfbcf3762bc95cdbae6f05b18cc2b168a5fab' }), [])
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
  const directory = await mkdtemp(join(tmpdir(), 'fixture-snapshot-'))
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
