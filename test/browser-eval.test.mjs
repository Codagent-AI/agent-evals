import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEMO_CONTRACT } from '../evals/agent-runner/and-scene/lib/demo-contract.mjs'
import {
  DETERMINISTIC_BROWSER_CRITERIA,
  MAX_EVIDENCE_CHARS,
  runBrowserEvaluation,
} from '../evals/agent-runner/and-scene/lib/browser-eval.mjs'
import { deterministicCriteria, loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'
import { hashJson } from '../evals/agent-runner/and-scene/lib/persistence.mjs'

const TITLES = DEMO_CONTRACT.step_titles

// An in-memory stand-in for the built demo. Every knob corresponds to one
// behaviour the deterministic browser checks are supposed to catch, so a check
// that cannot be broken here is not actually exercising the demo.
function createDemo(knobs = {}) {
  const {
    route = DEMO_CONTRACT.route,
    titles = TITLES,
    stepCount = titles.length,
    captions = DEMO_CONTRACT.step_captions,
    perStepSceneId = false,
    replaceEntities = false,
    clampStart = true,
    clampEnd = true,
    preservePositionAcrossModes = true,
    swipeWorks = true,
    directJumpWorks = true,
    keyboardWorks = true,
    ariaCurrent = true,
    focusable = true,
    controlsKeepKeys = true,
    focusedControlConsumesArrows = false,
    titleProminentInPresent = true,
    captionVisibleInBrowse = true,
    initialMode = 'present',
    captionHiddenInPresent = false,
    actions = [],
    stallAt = null,
    failures = [],
    controlCount = stepCount,
    controlsOnlyInBrowse = false,
    throwOn = null,
  } = knobs

  let index = 0
  let mode = initialMode
  let focused = null
  let keysLive = true
  const observed = []

  const clamp = (next) => {
    if (next < 0) return clampStart ? 0 : stepCount - 1
    if (next >= stepCount) return clampEnd ? stepCount - 1 : 0
    return next
  }
  const step = (offset) => {
    if (!keysLive || !keyboardWorks) return
    if (stallAt !== null && index === stallAt && offset > 0) return
    index = clamp(index + offset)
  }
  const guard = (name) => {
    if (throwOn === name) throw new Error(`driver blew up in ${name}`)
  }

  return {
    async routes() {
      guard('routes')
      return [route, 'some-other-presentation']
    },
    async open(target) {
      guard('open')
      if (target !== route) throw new Error(`no such route: ${target}`)
      index = 0
      mode = initialMode
      focused = null
      keysLive = true
      observed.length = 0
      observed.push(...failures)
      actions.push({ action: 'open', mode, position: index })
    },
    async state() {
      guard('state')
      return {
        stepIndex: index,
        stepCount,
        mode,
        title: titles[index % titles.length],
        caption: captionHiddenInPresent && mode === 'present'
          ? ''
          : captions[index % captions.length] ?? '',
        sceneId: perStepSceneId ? `scene-${index}` : 'how-to-make-a-presentation-scene',
        entityIds: replaceEntities
          ? [`only-${index}`]
          : ['stage', `beat-${index}`, `beat-${index + 1}`],
        titleProminent: mode === 'present' ? titleProminentInPresent : false,
        captionVisible: mode === 'browse' ? captionVisibleInBrowse : false,
        controls: controlsOnlyInBrowse && mode !== 'browse'
          ? []
          : Array.from({ length: controlCount }, (_, position) => ({
              name: `Step ${position + 1}`,
              role: 'button',
              ariaCurrent: ariaCurrent && position === index,
              focusable,
            })),
        focused,
      }
    },
    async press(key) {
      guard('press')
      if (key === 'ArrowRight') step(1)
      else if (key === 'ArrowLeft') step(-1)
    },
    async activate(name) {
      guard('activate')
      focused = name
      if (!controlsKeepKeys) keysLive = false
      if (!directJumpWorks) return
      const target = Number(name.replace('Step ', '')) - 1
      if (Number.isInteger(target)) index = clamp(target)
    },
    async focus(name) {
      guard('focus')
      if (!focusable) return
      focused = name
      if (focusedControlConsumesArrows) keysLive = false
    },
    async swipe(direction) {
      guard('swipe')
      if (!swipeWorks) return
      step(direction === 'left' ? 1 : -1)
    },
    async toggleMode() {
      guard('toggleMode')
      mode = mode === 'present' ? 'browse' : 'present'
      if (!preservePositionAcrossModes) index = 0
      actions.push({ action: 'toggle-mode', mode, position: index })
    },
    async setMode(required) {
      guard('setMode')
      if (mode !== required) await this.toggleMode()
      actions.push({ action: 'set-mode', mode, position: index })
    },
    async setPosition(required) {
      guard('setPosition')
      index = clamp(required)
      actions.push({ action: 'set-position', mode, position: index })
    },
    async settle() {
      guard('settle')
      actions.push({ action: 'settle', mode, position: index })
      return { settled: true, strategy: 'mock-idle' }
    },
    async failures() {
      guard('failures')
      return [...observed]
    },
  }
}

const passingBuild = { ok: true, log: 'build succeeded' }
const passingVerification = { machine_readable: true, passed: true, artifact: 'verify-result.json' }
const fixtureEvidenceArtifacts = {
  probe: (id) => `evidence/evaluator/browser-probes/${id}.json`,
  verification: 'phases/verification.json',
}

async function evaluate(knobs = {}, extra = {}) {
  return runBrowserEvaluation({
    driver: createDemo(knobs),
    build: passingBuild,
    verification: passingVerification,
    evidenceArtifacts: fixtureEvidenceArtifacts,
    ...extra,
  })
}

function verdictOf(result, id) {
  return [...result.criteria, ...result.gates].find((entry) => entry.id === id)?.verdict
}

test('the deterministic browser evaluator owns exactly the rubric-assigned demo criteria', async () => {
  const { automated } = await loadRubrics()
  assert.deepEqual(
    [...DETERMINISTIC_BROWSER_CRITERIA].sort(),
    [...deterministicCriteria(automated.rubric)].sort(),
  )
  assert.equal(DETERMINISTIC_BROWSER_CRITERIA.length, 14)
})

test('a conforming built demo passes every deterministic criterion and hard gate', async () => {
  const result = await evaluate()

  assert.deepEqual(result.criteria.map(({ id }) => id), DETERMINISTIC_BROWSER_CRITERIA)
  assert.deepEqual([...new Set(result.criteria.map(({ verdict }) => verdict))], ['pass'])
  assert.deepEqual([...new Set(result.gates.map(({ verdict }) => verdict))], ['pass'])
  assert.equal(result.gates.length, 4)
})

test('opening records and preserves the presentation initial mode', async () => {
  for (const initialMode of ['present', 'browse']) {
    const result = await evaluate({ initialMode })

    assert.equal(result.initial_state.mode, initialMode)
    assert.equal(result.initial_state.position, 0)
    assert.ok(result.probes.every(({ initial_state }) => initial_state.mode === initialMode))
  }
})

test('caption and canonical-content probes enter browse mode before traversal', async () => {
  const actions = []
  const result = await evaluate({
    initialMode: 'present',
    captionHiddenInPresent: true,
    actions,
  })

  for (const id of [
    'demo-nine-step-content-and-order',
    'demo-required-scene-content',
    'demo-evolving-scene-structure',
    'quality-captions-and-navigation',
  ]) {
    assert.equal(verdictOf(result, id), 'pass', id)
    const probe = result.probes.find((entry) => entry.id === id)
    assert.equal(probe.required_mode, 'browse')
    assert.equal(probe.start_position, 0)
    assert.equal(probe.settled_state.settled, true)
    assert.equal(probe.ownership, 'evaluator-produced')
    assert.match(probe.input_sha256, /^[a-f0-9]{64}$/)
    assert.match(probe.output_sha256, /^[a-f0-9]{64}$/)
    assert.equal(probe.output_sha256, hashJson(probe.outputs))
  }
  assert.ok(actions.some((entry) => entry.action === 'set-mode' && entry.mode === 'browse'))
})

test('mode-specific and navigation probes establish their declared state from either initial mode', async () => {
  const actions = []
  const result = await evaluate({ initialMode: 'browse', actions })

  assert.equal(verdictOf(result, 'demo-present-mode-behavior'), 'pass')
  assert.equal(verdictOf(result, 'demo-browse-mode-behavior'), 'pass')
  assert.equal(
    result.probes.find(({ id }) => id === 'demo-present-mode-behavior').required_mode,
    'present',
  )
  assert.equal(
    result.probes.find(({ id }) => id === 'demo-supported-navigation').start_position,
    0,
  )
  assert.ok(actions.some((entry) => entry.action === 'set-mode' && entry.mode === 'present'))
})

test('direct-jump navigation enters browse mode when present mode intentionally hides its controls', async () => {
  const result = await evaluate({ controlsOnlyInBrowse: true })

  assert.equal(verdictOf(result, 'demo-supported-navigation'), 'pass')
  const probe = result.probes.find(({ id }) => id === 'demo-supported-navigation')
  assert.deepEqual(
    probe.sessions.map(({ established_state: state }) => state.mode),
    ['present', 'browse'],
  )
})

test('matching pass and fail probe records can be reused without operating the browser again', async () => {
  const stored = new Map()
  const first = await runBrowserEvaluation({
    driver: createDemo({ titles: [...TITLES].reverse() }),
    build: passingBuild,
    verification: passingVerification,
    evidenceArtifacts: fixtureEvidenceArtifacts,
    revision: 'reference-revision',
    loadProbe: async ({ id }) => stored.get(id) ?? null,
    saveProbe: async ({ id, result }) => { stored.set(id, result) },
  })
  const actions = []
  const second = await runBrowserEvaluation({
    driver: createDemo({ actions }),
    build: passingBuild,
    verification: passingVerification,
    evidenceArtifacts: fixtureEvidenceArtifacts,
    revision: 'reference-revision',
    loadProbe: async ({ id }) => stored.get(id) ?? null,
    saveProbe: async () => { throw new Error('reused probes must not be rewritten') },
  })

  assert.equal(verdictOf(first, 'demo-nine-step-content-and-order'), 'fail')
  assert.equal(verdictOf(second, 'demo-nine-step-content-and-order'), 'fail')
  assert.ok(second.probes.every(({ reused }) => reused === true))
  assert.deepEqual(actions, [])
})

test('probe checkpoint inputs include the evaluator implementation fingerprint', async () => {
  const observed = []
  await runBrowserEvaluation({
    driver: createDemo(),
    build: passingBuild,
    verification: passingVerification,
    evidenceArtifacts: fixtureEvidenceArtifacts,
    revision: 'reference-revision',
    evaluatorFingerprint: 'browser-evaluator-sha256',
    loadProbe: async ({ inputs }) => {
      observed.push(inputs.evaluator_fingerprint)
      return null
    },
  })

  assert.ok(observed.length > 0)
  assert.ok(observed.every((value) => value === 'browser-evaluator-sha256'))
})

test('browser adapter failures remain harness failures instead of product criterion failures', async () => {
  const driver = createDemo()
  driver.routes = async () => {
    throw Object.assign(new Error('Chrome process is unavailable'), {
      owner: 'evaluation-harness',
      code: 'browser-driver-failed',
    })
  }

  await assert.rejects(
    runBrowserEvaluation({
      driver,
      build: passingBuild,
      verification: passingVerification,
      evidenceArtifacts: fixtureEvidenceArtifacts,
    }),
    (error) => error.owner === 'evaluation-harness' && error.code === 'browser-driver-failed',
  )
})

test('candidate-controlled non-string observations cannot invalidate durable browser evidence', async () => {
  const driver = createDemo()
  driver.routes = async () => [null]

  const result = await runBrowserEvaluation({
    driver,
    build: passingBuild,
    verification: passingVerification,
    evidenceArtifacts: fixtureEvidenceArtifacts,
  })

  const route = result.criteria.find(({ id }) => id === 'demo-route-and-registration')
  assert.equal(route.verdict, 'fail')
  assert.match(route.rationale, /not registered/)
  assert.deepEqual(route.evidence, ['evidence/evaluator/browser-probes/demo-route-and-registration.json'])
})

test('deterministic verdicts refuse to fabricate citations when no durable artifacts are identified', async () => {
  await assert.rejects(
    runBrowserEvaluation({
      driver: createDemo(),
      build: passingBuild,
      verification: passingVerification,
    }),
    (error) => (
      error.owner === 'evaluation-harness'
      && error.code === 'browser-evidence-missing'
      && /durable.*evidence/i.test(error.message)
    ),
  )
})

test('every emitted result carries a verdict, rationale, and cited evidence', async () => {
  const result = await evaluate()

  for (const entry of [...result.criteria, ...result.gates]) {
    assert.ok(['pass', 'fail'].includes(entry.verdict), entry.id)
    assert.ok(entry.rationale.length > 0, entry.id)
    assert.ok(Array.isArray(entry.evidence), entry.id)
  }
})

test('each broken demo behaviour fails its own criterion', async () => {
  const mutations = [
    ['demo-route-and-registration', { route: 'somewhere-else' }],
    ['demo-nine-step-content-and-order', { titles: [...TITLES].reverse() }],
    ['demo-nine-step-content-and-order', { titles: TITLES.slice(0, 5), stepCount: 5 }],
    ['demo-required-scene-content', { captions: TITLES.map(() => '') }],
    ['demo-required-scene-content', {
      captions: DEMO_CONTRACT.step_captions.map((caption, index) => (
        index === 4 ? 'A plausible but non-normative caption.' : caption
      )),
    }],
    ['demo-evolving-scene-structure', { perStepSceneId: true }],
    ['demo-evolving-scene-structure', { replaceEntities: true }],
    ['quality-captions-and-navigation', { controlCount: 0 }],
    ['demo-present-mode-behavior', { titleProminentInPresent: false }],
    ['demo-browse-mode-behavior', { captionVisibleInBrowse: false }],
    ['demo-mode-position-preservation', { preservePositionAcrossModes: false }],
    ['demo-supported-navigation', { swipeWorks: false }],
    ['demo-supported-navigation', { directJumpWorks: false }],
    ['demo-navigation-boundaries-and-control-keys', { clampStart: false }],
    ['demo-navigation-boundaries-and-control-keys', { clampEnd: false }],
    ['demo-navigation-boundaries-and-control-keys', { controlsKeepKeys: false }],
    ['demo-step-and-transition-reliability', { stallAt: 3 }],
    ['demo-mode-interaction-reliability', { failures: ['TypeError: cannot read mode of undefined'] }],
    ['demo-control-semantics', { ariaCurrent: false }],
    ['demo-focus-and-keyboard-accessibility', { focusable: false }],
  ]

  for (const [criterion, knobs] of mutations) {
    const result = await evaluate(knobs)
    assert.equal(verdictOf(result, criterion), 'fail', `${criterion} ${JSON.stringify(knobs)}`)
  }
})

test('runtime failures fail the every-step-renders gate', async () => {
  const result = await evaluate({ failures: ['Uncaught ReferenceError: scene is not defined'] })

  assert.equal(verdictOf(result, 'verification-every-produced-step-renders'), 'fail')
  assert.ok(result.failures.length > 0)
})

test('focusability and global keyboard navigation are observed independently', async () => {
  const result = await evaluate({ focusedControlConsumesArrows: true })

  assert.equal(verdictOf(result, 'demo-focus-and-keyboard-accessibility'), 'pass')
})

test('the sample-outline gate follows route registration and the nine-step outline', async () => {
  assert.equal(verdictOf(await evaluate({ titles: TITLES.slice(0, 4), stepCount: 4 }), 'verification-sample-outline'), 'fail')
  assert.equal(verdictOf(await evaluate({ route: 'elsewhere' }), 'verification-sample-outline'), 'fail')
  assert.equal(verdictOf(await evaluate(), 'verification-sample-outline'), 'pass')
})

test('build and verification gates come from their own phase results', async () => {
  const failedBuild = await evaluate({}, { build: { ok: false, log: 'tsc exited 2' } })
  assert.equal(verdictOf(failedBuild, 'verification-build-whole-app'), 'fail')
  // A failing gate never silently drags down the scored criteria.
  assert.deepEqual([...new Set(failedBuild.criteria.map(({ verdict }) => verdict))], ['pass'])

  const unclearOutcome = await evaluate({}, {
    verification: { machine_readable: false, passed: null },
  })
  assert.equal(verdictOf(unclearOutcome, 'verification-clear-outcome'), 'fail')

  const clearFailure = await evaluate({}, {
    verification: { machine_readable: true, passed: false, artifact: 'verify-result.json' },
  })
  // An unambiguous machine-readable *failure* still satisfies the clarity gate.
  assert.equal(verdictOf(clearFailure, 'verification-clear-outcome'), 'pass')
})

test('candidate-controlled text is bounded and escaped before it reaches evidence', async () => {
  const hostile = '"><script>alert(1)</script>' + 'A'.repeat(50_000)
  const result = await evaluate({ titles: TITLES.map(() => hostile) })

  for (const entry of [...result.criteria, ...result.gates]) {
    assert.ok(entry.rationale.length <= MAX_EVIDENCE_CHARS, entry.id)
    for (const cited of entry.evidence) {
      assert.ok(typeof cited === 'string' && cited.length <= MAX_EVIDENCE_CHARS, entry.id)
      assert.ok(!cited.includes('<script>'), entry.id)
    }
  }
  assert.equal(verdictOf(result, 'demo-nine-step-content-and-order'), 'fail')
})

test('an implausible step count is capped instead of driving an unbounded traversal', async () => {
  const result = await evaluate({ stepCount: 100_000, titles: TITLES })

  assert.equal(verdictOf(result, 'demo-nine-step-content-and-order'), 'fail')
  assert.ok(result.bounds_exceeded.some((reason) => reason.includes('step')))
})

test('a driver error fails only the affected criterion rather than aborting the evaluation', async () => {
  const result = await evaluate({ throwOn: 'swipe' })

  assert.equal(verdictOf(result, 'demo-supported-navigation'), 'fail')
  assert.equal(verdictOf(result, 'demo-control-semantics'), 'pass')
  assert.equal(result.criteria.length, DETERMINISTIC_BROWSER_CRITERIA.length)
})

test('an absent build result leaves its gate unobserved rather than failed', async () => {
  const result = await evaluate({}, { build: null })
  const gate = result.gates.find(({ id }) => id === 'verification-build-whole-app')

  // Never observing a build is missing evidence, not a build that failed.
  assert.equal(gate.verdict, null)
  assert.equal(gate.observed, false)
  assert.equal(verdictOf(await evaluate({}, { build: { ok: false, log: 'tsc exited 2' } }), 'verification-build-whole-app'), 'fail')
})

test('an absent verification result leaves its gate unobserved rather than failed', async () => {
  const result = await evaluate({}, { verification: null })
  const gate = result.gates.find(({ id }) => id === 'verification-clear-outcome')

  assert.equal(gate.verdict, null)
  assert.equal(gate.observed, false)
})

test('unavailable failure reporting leaves the renders gate unobserved rather than passing', async () => {
  const result = await evaluate({ throwOn: 'failures' })
  const gate = result.gates.find(({ id }) => id === 'verification-every-produced-step-renders')

  // An empty failure set only proves clean rendering when the evaluator could
  // actually read the failure list.
  assert.equal(gate.verdict, null)
  assert.equal(gate.observed, false)
  assert.match(gate.rationale, /could not be observed|unavailable/i)
  assert.equal(result.failure_reporting_available, false)
})
