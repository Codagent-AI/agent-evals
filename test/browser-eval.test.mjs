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
    declaresSceneId = true,
    replaceEntities = false,
    clampStart = true,
    clampEnd = true,
    preservePositionAcrossModes = true,
    swipeWorks = true,
    directJumpWorks = true,
    directionalControlsWork = true,
    nextStopsAfterFirstStep = false,
    keyboardWorks = true,
    ariaCurrent = true,
    focusable = true,
    controlsKeepKeys = true,
    focusedControlConsumesArrows = false,
    focusCannotBeReleased = false,
    titleProminentInPresent = true,
    activeTitleVisibleInBrowse = true,
    presentShowsDeckTitle = false,
    presentAlsoShowsStepTitle = false,
    captionVisibleInBrowse = true,
    tocVisibleInBrowse = true,
    previousVisibleInBrowse = true,
    nextVisibleInBrowse = true,
    progressVisibleInBrowse = true,
    initialMode = 'present',
    captionHiddenInPresent = false,
    actions = [],
    stallAt = null,
    failures = [],
    controlCount = stepCount,
    controlsOnlyInBrowse = false,
    stateUnreadable = false,
    controlsReversed = false,
    viewport = { width: 1280, height: 720 },
    canvasFitsNarrow = true,
    canvasUniform = true,
    throwOn = null,
  } = knobs

  let index = 0
  let mode = initialMode
  let focused = null
  let keysLive = true
  let currentViewport = { ...viewport }
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
      currentViewport = { ...viewport }
      observed.length = 0
      observed.push(...failures)
      actions.push({ action: 'open', mode, position: index })
    },
    async state() {
      guard('state')
      return {
        stepIndex: stateUnreadable ? null : index,
        stepCount,
        mode,
        title: (mode === 'browse' && !activeTitleVisibleInBrowse) || (mode === 'present' && presentShowsDeckTitle)
          ? 'Overall presentation title'
          : titles[index % titles.length],
        titleTexts: mode === 'present' && presentShowsDeckTitle
          ? ['Overall presentation title', ...(presentAlsoShowsStepTitle ? [titles[index % titles.length]] : [])]
          : [titles[index % titles.length], 'Overall presentation title'],
        caption: captionHiddenInPresent && mode === 'present'
          ? ''
          : captions[index % captions.length] ?? '',
        sceneId: declaresSceneId
          ? (perStepSceneId ? `scene-${index}` : 'how-to-make-a-presentation-scene')
          : null,
        entityIds: replaceEntities
          ? [`only-${index}`]
          : ['stage', `beat-${index}`, `beat-${index + 1}`],
        titleProminent: mode === 'present'
          ? titleProminentInPresent
          : activeTitleVisibleInBrowse,
        captionVisible: mode === 'browse' ? captionVisibleInBrowse : false,
        tocVisible: mode === 'browse' ? tocVisibleInBrowse : false,
        previousVisible: mode === 'browse' ? previousVisibleInBrowse : false,
        nextVisible: mode === 'browse' ? nextVisibleInBrowse : false,
        progressVisible: mode === 'browse' ? progressVisibleInBrowse : false,
        controls: controlsOnlyInBrowse && mode !== 'browse'
          ? []
          : (() => {
              const list = Array.from({ length: controlCount }, (_, position) => ({
                name: `Step ${position + 1}`,
                role: 'button',
                ariaCurrent: ariaCurrent && position === index,
                focusable,
              }))
              return controlsReversed ? list.reverse() : list
            })(),
        focused,
        viewport: currentViewport,
        matchedSelectors: {
          title: '[data-presentation-step-title]',
          caption: '[data-presentation-caption]',
          controls: 'semantic-progress-region',
        },
      }
    },
    async resize(width, height) {
      guard('resize')
      currentViewport = { width, height }
      actions.push({ action: 'resize', width, height })
    },
    async canvasGeometry() {
      guard('canvasGeometry')
      const scaleX = currentViewport.width < 100 ? (canvasFitsNarrow ? 0.05 : 0.1) : 1
      const scaleY = canvasUniform ? scaleX : scaleX * 0.8
      const width = 880 * scaleX
      const height = 495 * scaleY
      return {
        viewport: { ...currentViewport },
        authored: { width: 880, height: 495 },
        rendered: { left: 0, top: 0, right: width, bottom: height, width, height },
        available: {
          left: 0,
          top: 0,
          right: currentViewport.width,
          bottom: currentViewport.height,
          width: currentViewport.width,
          height: currentViewport.height,
        },
        scale: { x: scaleX, y: scaleY },
      }
    },
    async press(key) {
      guard('press')
      if (focusedControlConsumesArrows && focused?.startsWith('Step ')) return
      if (key === 'ArrowRight') step(1)
      else if (key === 'ArrowLeft') step(-1)
    },
    async activate(name) {
      guard('activate')
      focused = name
      if (!controlsKeepKeys) keysLive = false
      if (!directJumpWorks) return
      // A pointer activation focuses the control it fires, so a demo that
      // suppresses deck keys while a control holds focus stops responding.
      focused = name
      const target = Number(name.replace('Step ', '')) - 1
      if (Number.isInteger(target)) index = clamp(target)
    },
    async activateDirection(direction) {
      guard('activateDirection')
      const available = mode === 'browse'
        ? (direction === 'next' ? nextVisibleInBrowse : previousVisibleInBrowse)
        : true
      if (!available) return false
      if (!directionalControlsWork) return true
      if (direction === 'next' && nextStopsAfterFirstStep && index >= 1) return true
      index = clamp(index + (direction === 'next' ? 1 : -1))
      return true
    },
    async focus(name) {
      guard('focus')
      if (!focusable) return
      focused = name
    },
    async releaseFocus() {
      guard('releaseFocus')
      if (focusCannotBeReleased) return false
      focused = 'presentation root'
      return true
    },
    async restoreFocusTarget() {
      guard('restoreFocusTarget')
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

test('caption and scene-content probes enter browse mode before traversal', async () => {
  const actions = []
  const result = await evaluate({
    initialMode: 'present',
    captionHiddenInPresent: true,
    actions,
  })

  for (const id of [
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

test('the canonical outline is read from active step titles without confusing the deck title', async () => {
  const actions = []
  const result = await evaluate({
    initialMode: 'browse',
    activeTitleVisibleInBrowse: false,
    actions,
  })

  assert.equal(verdictOf(result, 'demo-nine-step-content-and-order'), 'pass')
  assert.equal(verdictOf(result, 'verification-sample-outline'), 'pass')
  // Showing the deck title in browse mode is a design choice the fixture does
  // not rule out, so it is judged by `mode-browse-reading-focused`, not here.
  assert.equal(verdictOf(result, 'demo-browse-mode-behavior'), 'pass')
  assert.ok(actions.some((entry) => entry.action === 'set-mode' && entry.mode === 'present'))
})

test('the canonical outline accepts step titles in browse mode when present mode shows only the deck title', async () => {
  const result = await evaluate({
    initialMode: 'present',
    presentShowsDeckTitle: true,
    activeTitleVisibleInBrowse: true,
  })

  assert.equal(verdictOf(result, 'demo-nine-step-content-and-order'), 'pass')
  assert.equal(verdictOf(result, 'verification-sample-outline'), 'pass')
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

test('browse-mode evidence records the viewport used for responsive chrome assertions', async () => {
  const result = await evaluate({ viewport: { width: 1280, height: 720 } })
  const probe = result.probes.find(({ id }) => id === 'demo-browse-mode-behavior')

  assert.match(probe.result.rationale, /viewport 1280×720/)
})

test('fixed-canvas fitting is no longer measured deterministically at an extreme viewport', async () => {
  const result = await evaluate({ canvasFitsNarrow: false, canvasUniform: false })

  assert.ok(!DETERMINISTIC_BROWSER_CRITERIA.includes('canvas-uniform-scaling'))
  assert.equal(verdictOf(result, 'canvas-uniform-scaling'), undefined)
  assert.deepEqual([...new Set(result.criteria.map(({ verdict }) => verdict))], ['pass'])
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

test('a cached probe containing a browser infrastructure failure is rerun instead of failing the candidate', async () => {
  const staleRouteProbe = {
    id: 'demo-route-and-registration',
    initial_state: { mode: null, position: null },
    established_state: { mode: 'browse', position: 0 },
    settled_state: { settled: false, strategy: 'probe-failed-before-settle' },
    sessions: [],
    result: {
      id: 'demo-route-and-registration',
      verdict: 'fail',
      rationale: `the demo route ${DEMO_CONTRACT.route} is not registered`,
      evidence: ['evidence/evaluator/browser-probes/demo-route-and-registration.json'],
      observed: true,
    },
    failures: [
      'Could not find Google Chrome executable for channel &#39;stable&#39; at:',
      '- /opt/google/chrome/chrome.',
      'Run `chrome-devtools-axi console-get &lt;id&gt;` to see a specific message',
      'Run `chrome-devtools-axi console --type error` to filter by type',
    ],
    failure_reporting_available: true,
  }
  const actions = []
  const saved = []

  const result = await runBrowserEvaluation({
    driver: createDemo({ actions }),
    build: passingBuild,
    verification: passingVerification,
    evidenceArtifacts: fixtureEvidenceArtifacts,
    loadProbe: async ({ id }) => id === staleRouteProbe.id ? staleRouteProbe : null,
    saveProbe: async ({ id }) => { saved.push(id) },
  })

  assert.equal(verdictOf(result, 'demo-route-and-registration'), 'pass')
  assert.equal(verdictOf(result, 'verification-sample-outline'), 'pass')
  assert.equal(verdictOf(result, 'verification-every-produced-step-renders'), 'pass')
  assert.deepEqual(result.failures, [])
  assert.equal(result.probes.find(({ id }) => id === staleRouteProbe.id).reused, false)
  assert.ok(saved.includes(staleRouteProbe.id))
  assert.ok(actions.some(({ action }) => action === 'open'))
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
  assert.equal(route.verdict, 'pass')
  assert.ok(route.evidence.includes('evidence/evaluator/browser-probes/demo-route-and-registration.json'))
  assert.ok(route.evidence.every((cited) => typeof cited === 'string' && cited.length > 1))
})

test('a reachable route that the landing page never links is registered, not missing', async () => {
  const driver = createDemo()
  driver.routes = async () => ['some-other-presentation']

  const result = await runBrowserEvaluation({
    driver,
    build: passingBuild,
    verification: passingVerification,
    evidenceArtifacts: fixtureEvidenceArtifacts,
  })

  assert.equal(verdictOf(result, 'demo-route-and-registration'), 'pass')
  assert.equal(verdictOf(result, 'verification-sample-outline'), 'pass')
  const probe = result.probes.find(({ id }) => id === 'demo-route-and-registration')
  assert.equal(probe.outputs.route_linked_from_landing_page, false)
  assert.deepEqual(probe.outputs.discovered_routes, ['some-other-presentation'])
})

test('an adapter diagnostic in the route list is a harness failure, never a product deduction', async () => {
  const driver = createDemo()
  driver.routes = async () => "Could not find Google Chrome executable for channel 'stable' at:"

  await assert.rejects(
    runBrowserEvaluation({
      driver,
      build: passingBuild,
      verification: passingVerification,
      evidenceArtifacts: fixtureEvidenceArtifacts,
    }),
    (error) => error.owner === 'evaluation-harness'
      && error.code === 'browser-driver-failed'
      && error.resumable === true,
  )
})

test('a probe that cites one string cites one artifact rather than its characters', async () => {
  const driver = createDemo()
  driver.routes = async () => ['some-other-presentation']

  const result = await runBrowserEvaluation({
    driver,
    build: passingBuild,
    verification: passingVerification,
    evidenceArtifacts: fixtureEvidenceArtifacts,
  })

  for (const entry of [...result.criteria, ...result.gates]) {
    assert.ok(entry.evidence.every((cited) => cited.length > 1), entry.id)
  }
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
    ['demo-present-mode-behavior', { presentShowsDeckTitle: true }],
    ['demo-browse-mode-behavior', { captionVisibleInBrowse: false }],
    ['demo-browse-mode-behavior', {
      controlCount: 0,
      previousVisibleInBrowse: false,
      nextVisibleInBrowse: false,
    }],
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

test('browse mode tolerates design choices the fixture never states', async () => {
  for (const knobs of [
    { activeTitleVisibleInBrowse: false },
    { tocVisibleInBrowse: false },
    { previousVisibleInBrowse: false, nextVisibleInBrowse: false },
    { progressVisibleInBrowse: false },
  ]) {
    const result = await evaluate(knobs)
    assert.equal(verdictOf(result, 'demo-browse-mode-behavior'), 'pass', JSON.stringify(knobs))
  }
})

test('browse mode accepts directional navigation that hides a boundary control', async () => {
  // The probe stands at step 0, where hiding Previous rather than disabling it
  // is a legitimate design. Next still has to be there, because every later
  // step is reached through it.
  const hidesPrevious = await evaluate({
    controlCount: 0,
    previousVisibleInBrowse: false,
    nextVisibleInBrowse: true,
  })

  assert.equal(verdictOf(hidesPrevious, 'demo-browse-mode-behavior'), 'pass')
})

test('browse mode reachability is exercised rather than counted', async () => {
  // Counting controls proves nothing about navigation: an inert control and a
  // Next control that stops after one step both expose the right chrome.
  const inertDirectControls = await evaluate({ directJumpWorks: false, directionalControlsWork: false })
  const inertDirectionalControls = await evaluate({ controlCount: 0, directionalControlsWork: false })
  const nextStops = await evaluate({
    controlCount: 0,
    nextStopsAfterFirstStep: true,
  })

  assert.equal(verdictOf(inertDirectControls, 'demo-browse-mode-behavior'), 'fail')
  assert.equal(verdictOf(inertDirectionalControls, 'demo-browse-mode-behavior'), 'fail')
  assert.equal(verdictOf(nextStops, 'demo-browse-mode-behavior'), 'fail')
})

test('browse mode accepts a deck whose direct controls are inert but whose next control works', async () => {
  const result = await evaluate({ directJumpWorks: false })

  assert.equal(verdictOf(result, 'demo-browse-mode-behavior'), 'pass')
})

test('browse mode still fails when a step is unreadable or unreachable', async () => {
  const unreadable = await evaluate({ captionVisibleInBrowse: false })
  const unreachable = await evaluate({
    controlCount: 0,
    previousVisibleInBrowse: false,
    nextVisibleInBrowse: false,
  })

  assert.equal(verdictOf(unreadable, 'demo-browse-mode-behavior'), 'fail')
  assert.equal(verdictOf(unreachable, 'demo-browse-mode-behavior'), 'fail')
})

test('present mode requires the active step title without judging its prominence', async () => {
  const prominenceUnreported = await evaluate({ titleProminentInPresent: false })
  const deckTitle = await evaluate({ presentShowsDeckTitle: true })

  assert.equal(verdictOf(prominenceUnreported, 'demo-present-mode-behavior'), 'pass')
  assert.equal(verdictOf(deckTitle, 'demo-present-mode-behavior'), 'fail')
})

test('normative titles and captions are compared without typographic noise', async () => {
  const result = await evaluate({
    titles: TITLES.map((title) => title.replace("'", '\u2019')),
    captions: DEMO_CONTRACT.step_captions.map((caption) => `${caption.replace(/ /g, '\u00a0')}\n`),
  })

  assert.equal(verdictOf(result, 'demo-nine-step-content-and-order'), 'pass')
  assert.equal(verdictOf(result, 'demo-required-scene-content'), 'pass')
})

test('an undeclared scene identity is recorded rather than compared with itself', async () => {
  const persisting = await evaluate({ declaresSceneId: false })
  const replacing = await evaluate({ declaresSceneId: false, replaceEntities: true })

  assert.equal(verdictOf(persisting, 'demo-evolving-scene-structure'), 'pass')
  assert.equal(verdictOf(replacing, 'demo-evolving-scene-structure'), 'fail')
  const probe = persisting.probes.find(({ id }) => id === 'demo-evolving-scene-structure')
  assert.equal(probe.outputs.scene_identity_declared, false)
  assert.deepEqual(probe.outputs.scene_ids, [])
})

test('every probe retains the observation its verdict was derived from', async () => {
  const result = await evaluate()

  for (const probe of result.probes) {
    assert.ok(Array.isArray(probe.probe_observations), probe.id)
    const states = probe.probe_observations.filter(({ kind }) => kind === 'state')
    assert.ok(states.length > 0, probe.id)
    const [first] = states
    assert.deepEqual(first.viewport, { width: 1280, height: 720 })
    assert.ok(['present', 'browse'].includes(first.mode), probe.id)
    assert.equal(typeof first.step_index, 'number')
    assert.equal(typeof first.step_count, 'number')
    assert.equal(first.matched_selectors.controls, 'semantic-progress-region')
    assert.equal(probe.outputs.probe_observations, probe.probe_observations)
  }
  const browse = result.probes.find(({ id }) => id === 'demo-browse-mode-behavior')
  // The first read is the as-opened state; the judged state is the last one.
  const observed = browse.probe_observations.filter(({ kind }) => kind === 'state').at(-1)
  assert.equal(observed.mode, 'browse')
  assert.equal(observed.controls.length, 9)
  assert.ok(observed.controls.some(({ aria_current }) => aria_current === true))
  assert.equal(observed.caption_visible, true)
})

test('an observation is bounded so one candidate string cannot flood an artifact', async () => {
  const result = await evaluate({ titles: TITLES.map(() => 'B'.repeat(50_000)) })

  for (const probe of result.probes) {
    for (const observation of probe.probe_observations) {
      assert.ok(JSON.stringify(observation).length < 20_000, probe.id)
    }
  }
})

test('retained failure evidence is escaped once rather than on every hop', async () => {
  const result = await evaluate({ failures: ["TypeError: cannot read 'mode' of <undefined>"] })
  const gate = result.gates.find(({ id }) => id === 'verification-every-produced-step-renders')

  assert.equal(verdictOf(result, 'verification-every-produced-step-renders'), 'fail')
  assert.ok(result.failures.every((failure) => !failure.includes('&')), JSON.stringify(result.failures))
  assert.ok(gate.evidence.some((cited) => cited.includes('&#39;mode&#39;')), JSON.stringify(gate.evidence))
  assert.ok(gate.evidence.every((cited) => !cited.includes('&amp;#')), JSON.stringify(gate.evidence))
})

test('an adapter diagnostic observed while stepping never reaches candidate failure evidence', async () => {
  await assert.rejects(
    evaluate({ failures: ['Run `chrome-devtools-axi console --type error` to filter by type'] }),
    (error) => error.owner === 'evaluation-harness' && error.code === 'browser-driver-failed',
  )
})

test('present mode accepts the active step title wherever the presentation exposes it', async () => {
  // The deck title is what the evaluator's first-ranked title hook happens to
  // match; the step title is exposed through another element.
  const result = await evaluate({ presentShowsDeckTitle: true, presentAlsoShowsStepTitle: true })

  assert.equal(verdictOf(result, 'demo-present-mode-behavior'), 'pass')
  const probe = result.probes.find(({ id }) => id === 'demo-present-mode-behavior')
  const observed = probe.probe_observations.filter(({ kind }) => kind === 'state').at(-1)
  assert.ok(observed.title_texts.includes(TITLES[0]))
})

test('present mode fails when no element exposes the active step title', async () => {
  const result = await evaluate({ presentShowsDeckTitle: true })

  assert.equal(verdictOf(result, 'demo-present-mode-behavior'), 'fail')
})

test('a probe retains an observation for every state its verdict rests on', async () => {
  // The nine-step probe walks all nine steps in both modes, so the retention
  // bound has to cover both traversals rather than truncating the later one.
  const result = await evaluate()
  const probe = result.probes.find(({ id }) => id === 'demo-nine-step-content-and-order')
  const states = probe.probe_observations.filter(({ kind }) => kind === 'state')

  assert.ok(states.length >= 18, `retained only ${states.length} states`)
  assert.equal(probe.probe_observations_dropped, 0)
  for (const record of result.probes) {
    assert.equal(record.probe_observations_dropped, 0, record.id)
    assert.equal(
      record.outputs.probe_observations_dropped,
      record.probe_observations_dropped,
      record.id,
    )
  }
})

test('the control-key check follows controls into browse mode without deducting focused-key suppression', async () => {
  const result = await evaluate({
    controlsOnlyInBrowse: true,
    focusedControlConsumesArrows: true,
  })
  const criterion = result.criteria.find(({ id }) => id === 'demo-navigation-boundaries-and-control-keys')

  assert.equal(verdictOf(result, 'demo-navigation-boundaries-and-control-keys'), 'pass')
  assert.match(criterion.rationale, /keys while control focused \d+→\d+/i)
  assert.match(criterion.rationale, /keys after focus released \d+→\d+/i)
})

test('a deck key that remains dead after focus is released fails the control-key check', async () => {
  const result = await evaluate({ controlsKeepKeys: false })

  assert.equal(verdictOf(result, 'demo-navigation-boundaries-and-control-keys'), 'fail')
})

test('a control that cannot release focus is a resumable harness failure', async () => {
  await assert.rejects(
    () => evaluate({ focusCannotBeReleased: true }),
    (error) => {
      assert.equal(error.owner, 'evaluation-harness')
      assert.equal(error.code, 'browser-driver-failed')
      assert.equal(error.resumable, true)
      assert.match(error.message, /release.*focus/i)
      return true
    },
  )
})

test('an unreadable browser state is a harness failure, not a product deduction', async () => {
  // The page reporting no step index at all says nothing about the demo. It is
  // the adapter or the page failing to answer, so it must stop the evaluation
  // for a resumable retry instead of deducting a point from the candidate.
  await assert.rejects(
    () => evaluate({ stateUnreadable: true }),
    (error) => {
      assert.equal(error.owner, 'evaluation-harness')
      assert.equal(error.code, 'browser-driver-failed')
      assert.equal(error.resumable, true)
      assert.match(error.message, /could not be read/i)
      return true
    },
  )
})

test('browse reachability counts the steps reached, not the order controls were found in', async () => {
  // Every step is reachable when each one is arrived at. The order in which the
  // controls were discovered says nothing about reachability, and control
  // order is judged separately by demo-control-semantics.
  const result = await evaluate({ controlsReversed: true, nextVisibleInBrowse: false })

  assert.equal(verdictOf(result, 'demo-browse-mode-behavior'), 'pass')
})
