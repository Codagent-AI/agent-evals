// Deterministic browser evaluation of the built, running demo.
//
// These checks exercise the live demo rather than reading its source: they walk
// every step, switch modes, drive each supported navigation input, probe the
// end boundaries, and inspect control semantics, focus, and keyboard
// operability. They answer only mechanically provable questions. Visual
// composition, perceived motion, and polish belong to human review and are not
// judged here or by the product judges.
//
// The evaluator talks to a small injected driver rather than to Playwright
// directly, so the whole demo contract is exercisable against an in-memory
// stand-in and the browser adapter stays a thin, replaceable edge.
import { DEMO_CONTRACT } from './demo-contract.mjs'

// The candidate controls every string and number that crosses this boundary, so
// both are bounded before they reach a rationale, an artifact, or a report.
export const MAX_EVIDENCE_CHARS = 200
export const MAX_STEP_COUNT = 50

export const DETERMINISTIC_BROWSER_CRITERIA = [
  'demo-route-and-registration',
  'demo-nine-step-content-and-order',
  'demo-required-scene-content',
  'demo-evolving-scene-structure',
  'quality-captions-and-navigation',
  'demo-present-mode-behavior',
  'demo-browse-mode-behavior',
  'demo-mode-position-preservation',
  'demo-supported-navigation',
  'demo-navigation-boundaries-and-control-keys',
  'demo-step-and-transition-reliability',
  'demo-mode-interaction-reliability',
  'demo-control-semantics',
  'demo-focus-and-keyboard-accessibility',
]

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// Control characters and whitespace runs collapse to a single space, so one
// candidate string cannot reflow a log line, an artifact, or a report cell.
const NOISE = new RegExp('[\\u0000-\\u001f\\u007f\\s]+', 'g')

// Candidate text is evidence, never markup and never a prompt instruction.
export function bounded(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  const escaped = text
    .replace(NOISE, ' ')
    .replace(/[&<>"']/g, (character) => ESCAPES[character])
    .trim()
  return escaped.length > MAX_EVIDENCE_CHARS ? `${escaped.slice(0, MAX_EVIDENCE_CHARS - 1)}…` : escaped
}

function verdict(id, pass, rationale, evidence = []) {
  return {
    id,
    verdict: pass ? 'pass' : 'fail',
    rationale: bounded(rationale),
    evidence: evidence.map(bounded),
    observed: true,
  }
}

// Evidence that was never collected. A null verdict is not a failure: it makes
// the hard gates incomplete so the official verdict becomes unavailable, rather
// than blaming the candidate for something the harness could not observe.
function unobserved(id, rationale, evidence = []) {
  return {
    id,
    verdict: null,
    rationale: bounded(rationale),
    evidence: evidence.map(bounded),
    observed: false,
  }
}

function overlaps(a, b) {
  return a.some((entry) => b.includes(entry))
}

export async function runBrowserEvaluation({
  driver,
  contract = DEMO_CONTRACT,
  build = null,
  verification = null,
}) {
  const boundsExceeded = []
  const failures = new Set()
  let failureReportingAvailable = true

  // One session per probe, so a probe that leaves the demo mid-navigation
  // cannot make the next probe's result depend on execution order.
  async function session() {
    await driver.open(contract.route)
    return driver
  }

  async function stepCountOf(state) {
    if (!Number.isInteger(state.stepCount) || state.stepCount < 1) {
      boundsExceeded.push(`reported step count ${bounded(state.stepCount)} is not a positive integer`)
      return 1
    }
    if (state.stepCount > MAX_STEP_COUNT) {
      boundsExceeded.push(`reported step count ${state.stepCount} exceeds the ${MAX_STEP_COUNT}-step capture limit`)
      return MAX_STEP_COUNT
    }
    return state.stepCount
  }

  // Walk from the first step to the last, recording the state at each one.
  async function walk() {
    const states = []
    let state = await driver.state()
    const count = await stepCountOf(state)
    states.push(state)
    for (let position = 1; position < count; position += 1) {
      await driver.press('ArrowRight')
      state = await driver.state()
      states.push(state)
    }
    return states
  }

  const probes = {
    'demo-route-and-registration': async () => {
      const routes = await driver.routes()
      if (!Array.isArray(routes) || !routes.includes(contract.route)) {
        return [false, `the demo route ${contract.route} is not registered`, (routes ?? []).slice(0, 10)]
      }
      const page = await session()
      const state = await page.state()
      return [
        Number.isInteger(state.stepIndex),
        `the demo route ${contract.route} is registered and reachable`,
        [contract.route],
      ]
    },

    'demo-nine-step-content-and-order': async () => {
      const page = await session()
      const first = await page.state()
      if (first.stepCount !== contract.step_count) {
        return [false, `the demo reports ${bounded(first.stepCount)} steps, expected ${contract.step_count}`, []]
      }
      const states = await walk()
      const mismatch = contract.step_titles.findIndex((title, position) => states[position]?.title !== title)
      if (mismatch !== -1) {
        return [
          false,
          `step ${mismatch + 1} title does not match the required outline`,
          [`expected: ${contract.step_titles[mismatch]}`, `observed: ${states[mismatch]?.title ?? '(none)'}`],
        ]
      }
      return [true, 'all nine required step titles appear in the specified order', contract.step_titles]
    },

    'demo-required-scene-content': async () => {
      await session()
      const states = await walk()
      const empty = states.findIndex(
        (state) => !state.caption?.trim() || !(state.entityIds ?? []).length,
      )
      if (empty !== -1) {
        return [false, `step ${empty + 1} has no caption or no scene content`, [states[empty]?.title ?? '']]
      }
      return [true, 'every step renders a caption and scene content', []]
    },

    'demo-evolving-scene-structure': async () => {
      await session()
      const states = await walk()
      const sceneIds = new Set(states.map(({ sceneId }) => sceneId))
      if (sceneIds.size !== 1) {
        return [false, `the demo uses ${sceneIds.size} scenes instead of one evolving scene`, [...sceneIds].slice(0, 5)]
      }
      const replaced = states.findIndex(
        (state, position) => position > 0 && !overlaps(state.entityIds ?? [], states[position - 1].entityIds ?? []),
      )
      if (replaced !== -1) {
        return [false, `step ${replaced + 1} replaces every entity instead of evolving the scene`, []]
      }
      return [true, 'the demo is implemented as one scene whose entities persist across steps', [...sceneIds]]
    },

    'quality-captions-and-navigation': async () => {
      await session()
      const states = await walk()
      const missingCaption = states.findIndex((state) => !state.caption?.trim())
      if (missingCaption !== -1) return [false, `step ${missingCaption + 1} exposes no caption`, []]
      const controls = states[0]?.controls ?? []
      if (controls.length !== states.length) {
        return [false, `navigation exposes ${controls.length} controls for ${states.length} steps`, []]
      }
      return [true, 'every step exposes a caption and a navigation control', []]
    },

    'demo-present-mode-behavior': async () => {
      const page = await session()
      const state = await page.state()
      return [
        state.mode === 'present' && state.titleProminent === true,
        `present mode reports mode ${bounded(state.mode)} with title prominence ${state.titleProminent}`,
        [],
      ]
    },

    'demo-browse-mode-behavior': async () => {
      const page = await session()
      await page.toggleMode()
      const state = await page.state()
      return [
        state.mode === 'browse' && state.captionVisible === true,
        `browse mode reports mode ${bounded(state.mode)} with reading content visible ${state.captionVisible}`,
        [],
      ]
    },

    'demo-mode-position-preservation': async () => {
      const page = await session()
      for (let position = 0; position < 4; position += 1) await page.press('ArrowRight')
      const before = (await page.state()).stepIndex
      await page.toggleMode()
      const during = (await page.state()).stepIndex
      await page.toggleMode()
      const after = (await page.state()).stepIndex
      return [
        before === 4 && during === before && after === before,
        `step index across a mode round trip: ${before} → ${during} → ${after}`,
        [],
      ]
    },

    'demo-supported-navigation': async () => {
      const page = await session()
      await page.press('ArrowRight')
      const forward = (await page.state()).stepIndex
      await page.press('ArrowLeft')
      const back = (await page.state()).stepIndex
      await page.swipe('left')
      const swiped = (await page.state()).stepIndex
      await page.swipe('right')
      const swipedBack = (await page.state()).stepIndex
      const controls = (await page.state()).controls ?? []
      const target = controls[4]
      if (target) await page.activate(target.name)
      const jumped = (await page.state()).stepIndex
      const ok = forward === 1 && back === 0 && swiped === 1 && swipedBack === 0 && jumped === 4
      return [
        ok,
        `keyboard ${forward}/${back}, swipe ${swiped}/${swipedBack}, direct jump ${jumped}`,
        [],
      ]
    },

    'demo-navigation-boundaries-and-control-keys': async () => {
      const page = await session()
      await page.press('ArrowLeft')
      const atStart = (await page.state()).stepIndex
      const first = await page.state()
      const count = await stepCountOf(first)
      for (let position = 1; position < count; position += 1) await page.press('ArrowRight')
      const last = (await page.state()).stepIndex
      await page.press('ArrowRight')
      const pastEnd = (await page.state()).stepIndex

      const restarted = await session()
      const controls = (await restarted.state()).controls ?? []
      if (controls[0]) await restarted.activate(controls[0].name)
      const beforeKey = (await restarted.state()).stepIndex
      await restarted.press('ArrowRight')
      const afterKey = (await restarted.state()).stepIndex

      const ok = atStart === 0 && last === count - 1 && pastEnd === count - 1 && afterKey === beforeKey + 1
      return [
        ok,
        `start clamp ${atStart}, end clamp ${last}→${pastEnd}, keys after control use ${beforeKey}→${afterKey}`,
        [],
      ]
    },

    'demo-step-and-transition-reliability': async () => {
      const page = await session()
      const first = await page.state()
      const count = await stepCountOf(first)
      for (let position = 1; position < count; position += 1) {
        await page.press('ArrowRight')
        const state = await page.state()
        if (state.stepIndex !== position) {
          return [false, `forward transition stalled at step ${position} (index ${bounded(state.stepIndex)})`, []]
        }
      }
      for (let position = count - 2; position >= 0; position -= 1) {
        await page.press('ArrowLeft')
        const state = await page.state()
        if (state.stepIndex !== position) {
          return [false, `backward transition stalled at step ${position} (index ${bounded(state.stepIndex)})`, []]
        }
      }
      const observed = await page.failures()
      if (observed.length > 0) return [false, 'the browser reported failures during step traversal', observed]
      return [true, `all ${count} steps advanced and reversed cleanly`, []]
    },

    'demo-mode-interaction-reliability': async () => {
      const page = await session()
      for (let round = 0; round < 4; round += 1) {
        await page.toggleMode()
        const state = await page.state()
        if (!Number.isInteger(state.stepIndex) || !['present', 'browse'].includes(state.mode)) {
          return [false, `mode toggle ${round + 1} left an unreadable state`, [bounded(state.mode)]]
        }
      }
      const observed = await page.failures()
      if (observed.length > 0) return [false, 'the browser reported failures during mode interaction', observed]
      return [true, 'repeated mode changes left the demo readable and error free', []]
    },

    'demo-control-semantics': async () => {
      await session()
      const states = await walk()
      for (const [position, state] of states.entries()) {
        const controls = state.controls ?? []
        if (controls.length === 0) return [false, `step ${position + 1} exposes no navigation controls`, []]
        const unnamed = controls.find(({ name, role }) => !name?.trim() || !role?.trim())
        if (unnamed) return [false, `a navigation control at step ${position + 1} has no role or accessible name`, []]
        const current = controls.filter(({ ariaCurrent }) => ariaCurrent)
        if (current.length !== 1) {
          return [false, `step ${position + 1} marks ${current.length} controls as current, expected 1`, []]
        }
        if (controls.indexOf(current[0]) !== state.stepIndex) {
          return [false, `step ${position + 1} marks the wrong control as current`, []]
        }
      }
      return [true, 'controls expose a role, an accessible name, and the current step', []]
    },

    'demo-focus-and-keyboard-accessibility': async () => {
      const page = await session()
      const controls = (await page.state()).controls ?? []
      if (controls.length === 0) return [false, 'there are no controls to focus', []]
      const unfocusable = controls.find(({ focusable }) => focusable !== true)
      if (unfocusable) return [false, `control ${bounded(unfocusable.name)} is not keyboard focusable`, []]
      await page.focus(controls[0].name)
      const focused = (await page.state()).focused
      if (focused !== controls[0].name) {
        return [false, `focusing a control left focus on ${bounded(focused)}`, []]
      }
      const before = (await page.state()).stepIndex
      await page.press('ArrowRight')
      const after = (await page.state()).stepIndex
      return [after === before + 1, `keyboard navigation after focus moved ${before} → ${after}`, []]
    },
  }

  const criteria = []
  for (const id of DETERMINISTIC_BROWSER_CRITERIA) {
    try {
      const [pass, rationale, evidence] = await probes[id]()
      criteria.push(verdict(id, pass, rationale, evidence))
    } catch (error) {
      // A driver or page error is a real observation about the demo, so it
      // fails its own criterion instead of aborting the whole evaluation and
      // discarding every other criterion's evidence.
      criteria.push(verdict(id, false, `browser evaluation failed: ${error.message}`, []))
    }
    try {
      for (const failure of await driver.failures()) failures.add(bounded(failure))
    } catch {
      // An empty failure set only proves clean rendering when the failure list
      // could actually be read. Losing the page or the console log means the
      // evidence is missing, so the renders gate goes unobserved rather than
      // passing on the strength of what was never collected.
      failureReportingAvailable = false
    }
  }

  const passed = (id) => criteria.find((entry) => entry.id === id)?.verdict === 'pass'
  const clearOutcome = verification?.machine_readable === true && typeof verification?.passed === 'boolean'

  const gates = [
    // A build result that was never produced is missing evidence, not a failed
    // build, so it leaves the gate unobserved and the verdict unavailable.
    build === null || build === undefined
      ? unobserved('verification-build-whole-app', 'no build result was recorded for this run')
      : verdict(
        'verification-build-whole-app',
        build.ok === true,
        build.ok === true
          ? 'the complete application built successfully'
          : `the build did not succeed: ${bounded(build.log ?? 'no build log')}`,
        build.log ? [build.log] : [],
      ),
    verdict(
      'verification-sample-outline',
      passed('demo-route-and-registration') && passed('demo-nine-step-content-and-order'),
      'the canonical nine-step sample must be registered, reachable, and match its outline',
      [contract.route],
    ),
    failureReportingAvailable
      ? verdict(
        'verification-every-produced-step-renders',
        failures.size === 0,
        failures.size === 0
          ? 'every produced step rendered without runtime or console errors'
          : `${failures.size} runtime or console failure(s) occurred while stepping the demo`,
        [...failures].slice(0, 10),
      )
      : unobserved(
        'verification-every-produced-step-renders',
        'runtime and console failures could not be observed, so clean rendering is unproven',
        [...failures].slice(0, 10),
      ),
    verification === null || verification === undefined
      ? unobserved('verification-clear-outcome', 'no verification result was recorded for this run')
      : verdict(
        'verification-clear-outcome',
        clearOutcome,
        clearOutcome
          ? `verification produced a machine-readable ${verification.passed ? 'pass' : 'fail'} result`
          : 'verification did not produce an unambiguous machine-readable result',
        verification.artifact ? [verification.artifact] : [],
      ),
  ]

  return {
    criteria,
    gates,
    failures: [...failures],
    failure_reporting_available: failureReportingAvailable,
    bounds_exceeded: [...new Set(boundsExceeded)],
  }
}
