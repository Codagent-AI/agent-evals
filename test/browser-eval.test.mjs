import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEMO_CONTRACT } from '../evals/agent-runner/and-scene/lib/demo-contract.mjs'
import {
  DETERMINISTIC_BROWSER_CRITERIA,
  MAX_EVIDENCE_CHARS,
  runBrowserEvaluation,
} from '../evals/agent-runner/and-scene/lib/browser-eval.mjs'
import { deterministicCriteria, loadRubrics } from '../evals/agent-runner/and-scene/lib/rubric.mjs'

const TITLES = DEMO_CONTRACT.step_titles

// An in-memory stand-in for the built demo. Every knob corresponds to one
// behaviour the deterministic browser checks are supposed to catch, so a check
// that cannot be broken here is not actually exercising the demo.
function createDemo(knobs = {}) {
  const {
    route = DEMO_CONTRACT.route,
    titles = TITLES,
    stepCount = titles.length,
    captions = titles.map((title) => `Caption for ${title}`),
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
    titleProminentInPresent = true,
    captionVisibleInBrowse = true,
    stallAt = null,
    failures = [],
    controlCount = stepCount,
    throwOn = null,
  } = knobs

  let index = 0
  let mode = 'present'
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
      mode = 'present'
      focused = null
      keysLive = true
      observed.length = 0
      observed.push(...failures)
    },
    async state() {
      guard('state')
      return {
        stepIndex: index,
        stepCount,
        mode,
        title: titles[index % titles.length],
        caption: captions[index % captions.length] ?? '',
        sceneId: perStepSceneId ? `scene-${index}` : 'how-to-make-a-presentation-scene',
        entityIds: replaceEntities
          ? [`only-${index}`]
          : ['stage', `beat-${index}`, `beat-${index + 1}`],
        titleProminent: mode === 'present' ? titleProminentInPresent : false,
        captionVisible: mode === 'browse' ? captionVisibleInBrowse : false,
        controls: Array.from({ length: controlCount }, (_, position) => ({
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
    },
    async failures() {
      guard('failures')
      return [...observed]
    },
  }
}

const passingBuild = { ok: true, log: 'build succeeded' }
const passingVerification = { machine_readable: true, passed: true, artifact: 'verify-result.json' }

async function evaluate(knobs = {}, extra = {}) {
  return runBrowserEvaluation({
    driver: createDemo(knobs),
    build: passingBuild,
    verification: passingVerification,
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
