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
import {
  isBrowserInfrastructureDiagnostic,
  probeContainsBrowserInfrastructureDiagnostic,
} from './browser-diagnostics.mjs'
import { hashJson } from './persistence.mjs'

// The candidate controls every string and number that crosses this boundary, so
// both are bounded before they reach a rationale, an artifact, or a report.
export const MAX_EVIDENCE_CHARS = 200
export const MAX_STEP_COUNT = 50
// One bounded observation per driver read, so a deduction stays adjudicable
// from the retained artifact without replaying the run.
// A probe may walk every step in both modes, so the bound has to cover two
// full traversals plus the observations that establish each session. Reaching
// it drops evidence rather than changing a verdict, so the overflow is counted
// and published instead of passing silently.
const MAX_PROBE_OBSERVATIONS = 2 * MAX_STEP_COUNT + 16

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
  'input-modifier-keys-pass-through',
  'input-swipe-from-control-ignored',
]

const PROBE_REQUIREMENTS = {
  'demo-route-and-registration': { mode: 'browse', position: 0 },
  'demo-nine-step-content-and-order': { mode: 'browse', position: 0 },
  'demo-required-scene-content': { mode: 'browse', position: 0 },
  'demo-evolving-scene-structure': { mode: 'browse', position: 0 },
  'quality-captions-and-navigation': { mode: 'browse', position: 0 },
  'demo-present-mode-behavior': { mode: 'present', position: 0 },
  'demo-browse-mode-behavior': { mode: 'browse', position: 0 },
  'demo-mode-position-preservation': { mode: 'present', position: 4 },
  'demo-supported-navigation': { mode: 'present', position: 0 },
  'demo-navigation-boundaries-and-control-keys': { mode: 'present', position: 0 },
  'demo-step-and-transition-reliability': { mode: 'present', position: 0 },
  'demo-mode-interaction-reliability': { mode: 'present', position: 0 },
  'demo-control-semantics': { mode: 'browse', position: 0 },
  'demo-focus-and-keyboard-accessibility': { mode: 'browse', position: 0 },
  // The input-hygiene probes start from a step that is neither the first nor
  // the last: this one on the nine-step deck, or the nearest middle step on a
  // shorter one. Present mode is where deck keys and swipes navigate; the
  // swipe probe moves to browse mode only when present mode exposes no control.
  'input-modifier-keys-pass-through': { mode: 'present', position: 4 },
  'input-swipe-from-control-ignored': { mode: 'present', position: 4 },
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// Control characters and whitespace runs collapse to a single space, so one
// candidate string cannot reflow a log line, an artifact, or a report cell.
const NOISE = new RegExp('[\\u0000-\\u001f\\u007f\\s]+', 'g')

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

// Collapsing and truncating candidate text is idempotent, so it is safe to
// apply wherever text is collected or retained. Escaping is not, so it lives
// in `bounded` and is applied exactly once, at the edge that emits a rationale
// or a report cell.
export function normalizeEvidence(value, maxChars = MAX_EVIDENCE_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return truncate(text.replace(NOISE, ' ').trim(), maxChars)
}

// Candidate text is evidence, never markup and never a prompt instruction.
export function bounded(value, maxChars = MAX_EVIDENCE_CHARS) {
  const escaped = normalizeEvidence(value, maxChars)
    .replace(/[&<>"']/g, (character) => ESCAPES[character])
  return truncate(escaped, maxChars)
}

// Normative titles and captions are compared for sameness of text, not of
// typography. A curly apostrophe or a collapsed line break is not a defect.
const PUNCTUATION = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201a', "'"], ['\u201b', "'"], ['\u2032', "'"],
  ['\u201c', '"'], ['\u201d', '"'], ['\u201e', '"'], ['\u201f', '"'], ['\u2033', '"'],
  ['\u2010', '-'], ['\u2011', '-'], ['\u2012', '-'], ['\u2013', '-'], ['\u2014', '-'],
  ['\u2015', '-'], ['\u2212', '-'], ['\u00a0', ' '], ['\u2026', '...'],
])

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2018-\u201f\u2026\u2032\u2033\u00a0\u2212]/g, (c) => PUNCTUATION.get(c) ?? c)
    .replace(NOISE, ' ')
    .trim()
}

function sameText(left, right) {
  return normalizeText(left) === normalizeText(right)
}

// Which element carries the deck title and which carries the active step title
// is the presentation's choice. The question a deterministic check can answer
// is whether the active step's title is exposed at all.
function exposesTitle(state, expected) {
  const candidates = Array.isArray(state?.titleTexts) && state.titleTexts.length > 0
    ? state.titleTexts
    : [state?.title]
  return candidates.some((candidate) => sameText(candidate, expected))
}

function observedTitles(state) {
  const texts = Array.isArray(state?.titleTexts) && state.titleTexts.length > 0
    ? state.titleTexts
    : [state?.title].filter(Boolean)
  return texts.length > 0 ? bounded(texts.join(' | ')) : '(none)'
}

// How many visible elements expose `expected`. The driver counts each element
// once per text; without counts, every listed text counts once.
function exposureCount(occurrences, texts, fallback, expected) {
  if (occurrences && typeof occurrences === 'object' && !Array.isArray(occurrences)) {
    return Object.entries(occurrences)
      .filter(([text]) => sameText(text, expected))
      .reduce((sum, [, count]) => sum + (Number.isFinite(count) ? count : 0), 0)
  }
  const candidates = Array.isArray(texts) && texts.length > 0 ? texts : [fallback]
  return candidates.filter((candidate) => sameText(candidate, expected)).length
}

const titleExposure = (state, expected) => exposureCount(
  state?.titleOccurrences, state?.titleTexts, state?.title, expected,
)
// Which element carries the active caption is the presentation's choice too;
// an unhooked step-title paragraph may precede the caption paragraph.
const captionExposure = (state, expected) => exposureCount(
  state?.captionOccurrences, state?.captionTexts, state?.caption, expected,
)

// A text belongs to the active step only when a walk over every step shows it
// more often at that step than at some other step. The active step's own element
// exposes it there and nowhere else; a persistent list of every title or
// caption exposes it equally everywhere and so never stands in for it.
function activeAt(states, position, expected, exposure) {
  const here = exposure(states[position], expected)
  if (here === 0) return false
  return states.some((state, other) => other !== position && exposure(state, expected) < here)
}

function missingEvidence(message) {
  return Object.assign(new Error(message), {
    owner: 'evaluation-harness',
    code: 'browser-evidence-missing',
  })
}

function browserInfrastructureFailure(message) {
  return Object.assign(new Error(message), {
    owner: 'evaluation-harness',
    code: 'browser-driver-failed',
    resumable: true,
  })
}

function durableCitation(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw missingEvidence(`${label} has no durable evidence artifact`)
  }
  return value
}

function verdict(id, pass, rationale, evidence) {
  const citations = Array.isArray(evidence)
    ? evidence.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : []
  if (citations.length === 0) {
    throw missingEvidence(`deterministic verdict ${id} has no durable evidence citation`)
  }
  return {
    id,
    verdict: pass ? 'pass' : 'fail',
    rationale: bounded(rationale),
    evidence: [...new Set(citations)].map((item) => bounded(item)),
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
    evidence: evidence.map((item) => bounded(item)),
    observed: false,
  }
}

const ENTITY_CONVENTIONS = ['data-layout-id', 'data-scene-entity', 'data-node', 'data-entity-id', 'data-scene-node']

// What the driver reports it searched for is the truthful record; the constant
// only covers a driver that predates the report.
function conventionsSought(states) {
  const reported = states.find((state) => (state?.entityConventions ?? []).length > 0)?.entityConventions
  return reported ? [...reported] : ENTITY_CONVENTIONS
}

function notObserved(rationale, evidence = [], lookedFor = ENTITY_CONVENTIONS) {
  return { not_observed: true, rationale, evidence, looked_for: lookedFor }
}

// Held one at a time while pressing each arrow key, with the keydown flag that
// shows each was held.
const MODIFIERS = ['Alt', 'Control', 'Meta']
const MODIFIER_FLAGS = { Alt: 'altKey', Control: 'ctrlKey', Meta: 'metaKey' }

// What the swipe-from-control probe looks for when the driver does not report
// its own conventions.
const SWIPE_CONTROL_CONVENTIONS = [
  'presentation mode control', 'previous and next controls', 'step controls',
]

function noMiddleStep(count, consequence) {
  return notObserved(
    `the deck has ${count} step${count === 1 ? '' : 's'} and no step that is neither the first nor the last, so ${consequence}`,
    [],
    ['a step that is neither the first nor the last'],
  )
}

// Which control a swipe starts on. A control whose activation leaves the step
// where it is comes first: the mode control, then the active step's own step
// control. Otherwise Previous or Next, then another step control, whose own
// activation target is recorded so that landing there is not mistaken for a
// swipe. Only a control with a selector can be swiped from.
function chooseSwipeControl(controls, start, titles = DEMO_CONTRACT.step_titles) {
  const usable = (Array.isArray(controls) ? controls : [])
    .filter((control) => typeof control?.selector === 'string' && control.selector.trim().length > 0)
  const mode = usable.find(({ kind }) => kind === 'mode')
  if (mode) return { control: mode, target: null }
  const steps = usable.filter(({ kind }) => kind === 'step')
  const named = steps.some((control) => namesAnyStep(control, titles))
  const targetOf = (control) => {
    const target = named
      ? titles.findIndex((_, index) => namesStep(control, index, titles))
      : (Number.isInteger(control.position) ? control.position : steps.indexOf(control))
    return target >= 0 ? target : null
  }
  const own = steps.find((control) => targetOf(control) === start)
  if (own) return { control: own, target: start }
  const directional = usable.find(({ kind }) => kind === 'previous' || kind === 'next')
  if (directional) return { control: directional, target: start + (directional.kind === 'next' ? 1 : -1) }
  if (steps[0]) return { control: steps[0], target: targetOf(steps[0]) }
  return null
}

class UnobservedPrecondition extends Error {
  constructor(message) {
    super(message)
    this.not_observed = true
    this.rationale = message
    this.looked_for = ['data-presentation-mode', 'data-mode']
    this.evidence = []
  }
}

function decide({ pass, rationale, evidence = [], observations = {}, restsOn = [] }) {
  if (!pass && restsOn.some(({ basis }) => basis === 'heuristic' || basis === 'unknown')) {
    return { ...notObserved(rationale, evidence, restsOn.map(({ reading }) => reading)), observations }
  }
  return [pass, rationale, evidence, observations]
}

function textActiveAt(states, position, expected, legacyExposure) {
  const readings = states.map((state) => state?.textPresence?.[expected])
  if (readings.every((reading) => reading === undefined) && legacyExposure) {
    return activeAt(states, position, expected, legacyExposure) ? 'active' : 'absent'
  }
  if (readings.some((reading) => !reading || reading.complete !== true)) return 'unknown'
  const counts = readings.map(({ visibleElements = 0, accessibleNames = 0 }) => visibleElements + accessibleNames)
  if (counts[position] === 0) return 'absent'
  return counts.some((count, index) => index !== position && count < counts[position])
    ? 'active' : 'persistent-only'
}

// A convention seen on some steps is not proof that another step lacks content,
// so any step without a recognised scene object leaves the fact unobserved.
function entitiesUnobserved(states) {
  if (states.every((state) => (state.entityIds ?? []).length > 0)) return null
  return notObserved(
    'one or more steps exposed no recognised scene entity ids',
    [],
    conventionsSought(states),
  )
}

// The scored record of a not-observed probe: no verdict, and what was sought.
function notObservedCriterion(id, outcome, citation) {
  return {
    id,
    verdict: null,
    outcome: 'not-observed',
    looked_for: outcome.looked_for,
    rationale: bounded(outcome.rationale),
    evidence: [...outcome.evidence, citation],
    observed: false,
    ...(outcome.observations ? { observations: outcome.observations } : {}),
  }
}

// A page that reports no mode or no step index has not answered. That says
// nothing about the demo, so it stops the evaluation for a resumable retry
// rather than deducting a point from the candidate.
function assertReadableState(state) {
  if (typeof state?.mode === 'string' && Number.isInteger(state?.stepIndex)) return
  throw browserInfrastructureFailure(
    `probe state could not be read: observed ${bounded(state?.mode)} at ${bounded(state?.stepIndex)}`,
  )
}

const controlText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

// Whether a control's accessible name names one step, by its title or number.
function namesStep(control, index, titles) {
  const name = controlText(control?.name)
  const title = controlText(titles[index])
  return name !== '' && ((title !== '' && name.includes(title))
    || new RegExp(`^(?:(?:go to|jump to)\\s+)?(?:step\\s+)?${index + 1}(?!\\d)`).test(name))
}

const namesAnyStep = (control, titles) => titles.some((_, index) => namesStep(control, index, titles))

// Which control belongs to the active step is read from what the controls say
// (a step number or title), so extra controls in the same row cannot shift
// it. Position decides only when no control names a step.
export function marksActiveStep(controls, current, stepIndex, titles = DEMO_CONTRACT.step_titles) {
  return controls.some((control) => namesAnyStep(control, titles))
    ? namesStep(current, stepIndex, titles)
    : controls.indexOf(current) === stepIndex
}

// The controls that name a step, when any do; otherwise every control.
export function stepControls(controls, titles = DEMO_CONTRACT.step_titles) {
  const named = controls.filter((control) => namesAnyStep(control, titles))
  return named.length > 0 ? named : controls
}

function overlaps(a, b) {
  return a.some((entry) => b.includes(entry))
}

function summarizeControls(controls) {
  return (controls ?? []).slice(0, MAX_STEP_COUNT).map((control) => ({
    name: normalizeEvidence(control?.name ?? ''),
    role: normalizeEvidence(control?.role ?? ''),
    aria_current: control?.ariaCurrent === true,
    disabled: control?.disabled === true,
    focusable: control?.focusable === true,
  }))
}

function summarizeOccurrences(occurrences) {
  if (!occurrences || typeof occurrences !== 'object' || Array.isArray(occurrences)) return null
  return Object.entries(occurrences)
    .slice(0, 24)
    .map(([text, count]) => ({ text: normalizeEvidence(text), count: Number.isFinite(count) ? count : null }))
}

// What the evaluator actually saw. A reviewer auditing a deduction needs the
// viewport it was measured at, the chrome it found, and which selector or
// discovery strategy produced each navigation role.
function summarizeState(state) {
  return {
    viewport: state?.viewport ?? null,
    mode: state?.mode ?? null,
    mode_basis: state?.modeBasis ?? null,
    title_basis: state?.titleBasis ?? null,
    caption_basis: state?.captionBasis ?? null,
    text_presence: state?.textPresence ?? null,
    step_index: state?.stepIndex ?? null,
    step_count: state?.stepCount ?? null,
    title: normalizeEvidence(state?.title ?? ''),
    title_texts: (state?.titleTexts ?? []).slice(0, 24).map((text) => normalizeEvidence(text)),
    caption: normalizeEvidence(state?.caption ?? ''),
    caption_texts: (state?.captionTexts ?? []).slice(0, 24).map((text) => normalizeEvidence(text)),
    title_occurrences: summarizeOccurrences(state?.titleOccurrences),
    caption_occurrences: summarizeOccurrences(state?.captionOccurrences),
    scene_id: typeof state?.sceneId === 'string' ? normalizeEvidence(state.sceneId) : null,
    entity_ids: (state?.entityIds ?? []).slice(0, MAX_STEP_COUNT).map((id) => normalizeEvidence(id)),
    entity_conventions: (state?.entityConventions ?? []).slice(0, MAX_STEP_COUNT)
      .map((selector) => normalizeEvidence(selector)),
    title_prominent: state?.titleProminent ?? null,
    caption_visible: state?.captionVisible ?? null,
    toc_visible: state?.tocVisible ?? null,
    progress_visible: state?.progressVisible ?? null,
    previous_visible: state?.previousVisible ?? null,
    next_visible: state?.nextVisible ?? null,
    focused: state?.focused == null ? null : normalizeEvidence(state.focused),
    controls: summarizeControls(state?.controls),
    matched_selectors: state?.matchedSelectors ?? null,
  }
}

export async function runBrowserEvaluation({
  driver: baseDriver,
  contract = DEMO_CONTRACT,
  build = null,
  verification = null,
  revision = null,
  evaluatorFingerprint = 'browser-evaluator-unversioned',
  loadProbe = null,
  saveProbe = null,
  evidenceArtifacts = null,
}) {
  if (typeof evidenceArtifacts?.probe !== 'function') {
    throw missingEvidence('deterministic browser evaluation has no durable probe evidence locator')
  }
  const probeCitation = (id) => durableCitation(
    evidenceArtifacts.probe(id),
    `deterministic probe ${id}`,
  )
  const verificationCitation = durableCitation(
    evidenceArtifacts.verification,
    'candidate verification',
  )
  let currentProbeObservations = []
  let currentProbeObservationsDropped = 0
  const record = (kind, value) => {
    if (currentProbeObservations.length >= MAX_PROBE_OBSERVATIONS) {
      currentProbeObservationsDropped += 1
      return value
    }
    currentProbeObservations.push({ kind, ...(kind === 'state' ? summarizeState(value) : { value }) })
    return value
  }
  // The evaluator reads the page through this wrapper so that every probe's
  // artifact carries the observations its verdict was derived from.
  const driver = {
    ...baseDriver,
    async state(options) {
      return record('state', await baseDriver.state(options ?? {
        presenceOf: [...contract.step_titles, ...contract.step_captions],
      }))
    },
    async routes() {
      const routes = await baseDriver.routes()
      record('routes', Array.isArray(routes) ? routes.slice(0, 20).map((route) => normalizeEvidence(route)) : normalizeEvidence(routes))
      return routes
    },
  }

  const boundsExceeded = []
  const failures = new Set()
  let failureReportingAvailable = true
  const probeRecords = []
  let currentProbeSessions = []

  // One session per probe, so a probe that leaves the demo mid-navigation
  // cannot make the next probe's result depend on execution order. Opening is
  // observational: only after recording the initial state do we establish the
  // mode and position declared by the probe.
  async function session({ mode, position }) {
    await driver.open(contract.route)
    const opened = await driver.state()
    const initialState = {
      mode: opened.mode,
      position: opened.stepIndex,
    }
    if (typeof driver.setMode === 'function') {
      await driver.setMode(mode)
    } else if (opened.mode !== mode) {
      await driver.toggleMode()
    }
    if (typeof driver.setPosition === 'function') {
      await driver.setPosition(position)
    } else {
      let state = await driver.state()
      while (state.stepIndex > position) {
        await driver.press('ArrowLeft')
        state = await driver.state()
      }
      while (state.stepIndex < position) {
        await driver.press('ArrowRight')
        state = await driver.state()
      }
    }
    const settled = typeof driver.settle === 'function'
      ? await driver.settle()
      : { settled: true, strategy: 'driver-state-read' }
    const established = await driver.state()
    assertReadableState(established)
    currentProbeSessions.push({
      initial_state: initialState,
      established_state: { mode: established.mode, position: established.stepIndex,
        mode_basis: established.modeBasis ?? null },
      settled_state: settled,
    })
    if (established.mode !== mode && established.modeBasis === 'heuristic') {
      throw new UnobservedPrecondition(`mode ${mode} could not be established from a declaration`)
    }
    if (established.mode !== mode || established.stepIndex !== position) {
      throw new Error(
        `probe state could not be established: required ${mode} at ${position}, `
        + `observed ${bounded(established.mode)} at ${bounded(established.stepIndex)}`,
      )
    }
    // The same rule holds for every later read in the probe, not only the one
    // that establishes it: a read that returns no mode or no step index did not
    // answer, so it can never be compared with an expected step and deducted.
    return new Proxy(driver, {
      get(target, property, receiver) {
        if (property !== 'state') return Reflect.get(target, property, receiver)
        return async (...args) => {
          const state = await target.state(...args)
          assertReadableState(state)
          return state
        }
      },
    })
  }

  // The probe's middle step: its declared start position on a deck long
  // enough, else the nearest step that is neither the first nor the last.
  // Null when the deck has no such step.
  async function middleStep(id) {
    const { mode, position } = PROBE_REQUIREMENTS[id]
    const page = await session({ mode, position: 0 })
    const count = await stepCountOf(await page.state())
    return { count, middle: count >= 3 ? Math.min(position, count - 2) : null }
  }

  // A driver without a probe's primitives cannot observe it. That is the
  // harness's shortcoming, never the candidate's.
  function requireDriver(page, methods) {
    const missing = methods.filter((method) => typeof page[method] !== 'function')
    if (missing.length > 0) {
      throw browserInfrastructureFailure(`the browser driver does not provide ${missing.join(', ')}`)
    }
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
    let state = await driver.state({ presenceOf: [...contract.step_titles, ...contract.step_captions] })
    const count = await stepCountOf(state)
    states.push(state)
    for (let position = 1; position < count; position += 1) {
      await driver.press('ArrowRight')
      state = await driver.state({ presenceOf: [...contract.step_titles, ...contract.step_captions] })
      states.push(state)
    }
    return states
  }

  const probes = {
    // Registration is judged by whether the declared route is reachable and
    // operable. Landing-page links are recorded, not required: a route can be
    // registered in a router without the index linking to it, and an adapter
    // that answers with its own diagnostic is a harness failure, not a missing
    // route.
    'demo-route-and-registration': async () => {
      const routes = await driver.routes()
      const diagnostic = typeof routes === 'string'
        ? routes
        : (Array.isArray(routes) ? routes : []).find(isBrowserInfrastructureDiagnostic)
      if (typeof diagnostic === 'string') {
        throw browserInfrastructureFailure(
          `browser adapter returned adapter output in place of a route list: ${bounded(diagnostic)}`,
        )
      }
      const discovered = Array.isArray(routes)
        ? routes.filter((route) => typeof route === 'string')
        : []
      const linked = discovered.includes(contract.route)
      const page = await session(PROBE_REQUIREMENTS['demo-route-and-registration'])
      const state = await page.state()
      const reachable = Number.isInteger(state.stepIndex) && state.stepCount > 0
      return [
        reachable,
        reachable
          ? `the demo route ${contract.route} is registered and reachable${linked ? ' and linked from the landing page' : ' without a landing-page link'}`
          : `the demo route ${contract.route} did not expose an operable step position`,
        [contract.route],
        { discovered_routes: discovered.slice(0, 20), route_linked_from_landing_page: linked },
      ]
    },

    'demo-nine-step-content-and-order': async () => {
      const page = await session(PROBE_REQUIREMENTS['demo-nine-step-content-and-order'])
      const first = await page.state()
      if (first.stepCount !== contract.step_count) {
        return [false, `the demo reports ${bounded(first.stepCount)} steps, expected ${contract.step_count}`, []]
      }
      // A presentation may expose its active step title in either mode, through
      // any visible title-bearing element, while its first-ranked title hook
      // carries the overall deck title. Observe both modes and accept a step
      // when either exposes the canonical title as that step's own, not only in
      // a persistent list of every title; browse-mode title visibility is still
      // checked independently below.
      const browseStates = await walk()
      await session({ mode: 'present', position: 0 })
      const presentStates = await walk()
      const mismatch = contract.step_titles.findIndex((title, position) => (
        !activeAt(browseStates, position, title, titleExposure)
          && !activeAt(presentStates, position, title, titleExposure)
      ))
      if (mismatch !== -1) {
        const title = contract.step_titles[mismatch]
        const basis = [browseStates, presentStates]
          .map((states) => textActiveAt(states, mismatch, title, titleExposure))
        if (basis.includes('active') || basis.includes('unknown')) {
          return notObserved('the active title was not established by a declared title selector', [],
            ['declared step title selector', 'visible and accessible title text'])
        }
        return [
          false,
          `step ${mismatch + 1} title does not match the required outline`,
          [
            `expected: ${contract.step_titles[mismatch]}`,
            `observed in browse: ${observedTitles(browseStates[mismatch])}`,
            `observed in present: ${observedTitles(presentStates[mismatch])}`,
          ],
        ]
      }
      return [true, 'all nine required step titles appear in the specified order', contract.step_titles]
    },

    'demo-required-scene-content': async () => {
      await session(PROBE_REQUIREMENTS['demo-required-scene-content'])
      const states = await walk()
      const mismatch = states.findIndex(
        (_state, position) => !activeAt(states, position, contract.step_captions[position], captionExposure),
      )
      if (mismatch !== -1) {
        const textBasis = textActiveAt(states, mismatch, contract.step_captions[mismatch], captionExposure)
        if (states[mismatch]?.modeBasis === 'heuristic' || ['active', 'unknown'].includes(textBasis)) {
          return notObserved('the caption or browse mode was not established by a declaration', [],
            ['declared browse mode', 'declared caption selector', 'visible and accessible caption text'])
        }
        return [
          false,
          `step ${mismatch + 1} does not expose its normative caption or scene content`,
          [
            `expected caption: ${contract.step_captions[mismatch]}`,
            `observed caption: ${states[mismatch]?.caption ?? '(none)'}`,
            states[mismatch]?.title ?? '',
          ],
        ]
      }
      const unobservedEntities = entitiesUnobserved(states)
      if (unobservedEntities) return unobservedEntities
      return [true, 'every step renders its normative caption and scene content', contract.step_captions]
    },

    'demo-evolving-scene-structure': async () => {
      await session(PROBE_REQUIREMENTS['demo-evolving-scene-structure'])
      const states = await walk()
      // Only a scene identity the presentation actually declares can be
      // compared. Substituting the document path made every candidate agree
      // with itself, so the criterion rested on nothing.
      const declared = states
        .map(({ sceneId }) => sceneId)
        .filter((sceneId) => typeof sceneId === 'string' && sceneId.trim().length > 0)
      const sceneIds = new Set(declared)
      const identityDeclared = declared.length === states.length && states.length > 0
      const observations = {
        scene_identity_declared: identityDeclared,
        scene_ids: [...sceneIds].slice(0, 5).map((sceneId) => normalizeEvidence(sceneId)),
      }
      if (identityDeclared && sceneIds.size !== 1) {
        return [
          false,
          `the demo uses ${sceneIds.size} scenes instead of one evolving scene`,
          [...sceneIds].slice(0, 5),
          observations,
        ]
      }
      const replaced = states.findIndex(
        (state, position) => position > 0
          && (state.entityIds ?? []).length > 0
          && (states[position - 1].entityIds ?? []).length > 0
          && !overlaps(state.entityIds ?? [], states[position - 1].entityIds ?? []),
      )
      if (replaced !== -1) {
        return [false, `step ${replaced + 1} replaces every entity instead of evolving the scene`, [], observations]
      }
      const unobservedEntities = entitiesUnobserved(states)
      if (unobservedEntities) return unobservedEntities
      return [
        true,
        identityDeclared
          ? 'the demo is implemented as one scene whose entities persist across steps'
          : 'the demo declares no scene identity and its entities persist across every step',
        identityDeclared ? [...sceneIds] : [contract.route],
        observations,
      ]
    },

    'quality-captions-and-navigation': async () => {
      await session(PROBE_REQUIREMENTS['quality-captions-and-navigation'])
      const states = await walk()
      const missingCaption = states.findIndex((state) => !state.caption?.trim())
      if (missingCaption !== -1) {
        const status = textActiveAt(states, missingCaption, contract.step_captions[missingCaption], captionExposure)
        if (status !== 'absent' || states[missingCaption].modeBasis === 'heuristic') return notObserved(`step ${missingCaption + 1} has no declared caption`, [],
          ['declared caption selector', 'visible and accessible caption text'])
        return [false, `step ${missingCaption + 1} exposes no caption`, []]
      }
      const heuristicCaption = states.findIndex((state, index) => state.captionBasis === 'heuristic'
        && state.caption?.trim() !== contract.step_captions[index]
        && textActiveAt(states, index, contract.step_captions[index], captionExposure) !== 'absent')
      if (heuristicCaption !== -1) return notObserved(`step ${heuristicCaption + 1} caption was chosen by layout`, [],
        ['declared caption selector', 'visible and accessible caption text'])
      const controls = stepControls(states[0]?.controls ?? [], contract.step_titles)
      if (controls.length !== states.length) {
        return [false, `navigation exposes ${controls.length} controls for ${states.length} steps`, []]
      }
      return [true, 'every step exposes a caption and a navigation control', []]
    },

    // Mechanical facts only: present mode is entered and it exposes the active
    // step's title. Whether that title is visually prominent is a design
    // judgment owned by `mode-present-title-focused` and human review.
    'demo-present-mode-behavior': async () => {
      const page = await session(PROBE_REQUIREMENTS['demo-present-mode-behavior'])
      const state = await page.state()
      const activeTitle = exposesTitle(state, contract.step_titles[state.stepIndex])
      const textStatus = activeTitle ? 'active'
        : textActiveAt(await walk(), state.stepIndex, contract.step_titles[state.stepIndex], titleExposure)
      const titleBasis = !activeTitle && ['active', 'unknown'].includes(textStatus)
        ? 'heuristic' : 'declared'
      return decide({
        pass: state.mode === 'present' && activeTitle,
        rationale: `present mode reports mode ${bounded(state.mode)} with the active step title ${activeTitle}`,
        restsOn: [
          { reading: 'declared presentation mode', basis: state.modeBasis },
          { reading: 'declared active title', basis: activeTitle ? 'declared' : titleBasis },
        ],
      })
    },

    // Mechanical facts only: browse mode is entered, the active step's caption
    // is readable, and every step is actually reached by operating the
    // navigation the demo exposes. Showing the deck title rather than the step
    // title, making the table of contents responsive, and hiding rather than
    // disabling a boundary control are all legitimate designs the fixture does
    // not rule out, so they are judged by `mode-browse-reading-focused` and
    // human review instead.
    'demo-browse-mode-behavior': async () => {
      // Reachability is coverage: every step is arrived at. The order steps are
      // reached in is judged by demo-control-semantics, not here.
      const coversEveryStep = (visited, count) => {
        const reached = new Set(visited)
        return Array.from({ length: count }, (_, index) => index).every((index) => reached.has(index))
      }
      const page = await session(PROBE_REQUIREMENTS['demo-browse-mode-behavior'])
      const state = await page.state()
      const controls = state.controls ?? []
      const count = await stepCountOf(state)
      const attempts = []
      // Counting controls proves nothing about navigation: an inert control is
      // indistinguishable from a working one until it is used. Every step has
      // to be arrived at, either by activating its own control or by walking
      // forward through the directional control a reader would click.
      let reachable = false
      if (controls.length === count) {
        const visited = []
        for (const control of controls) {
          await page.activate(control.name)
          visited.push((await page.state()).stepIndex)
        }
        reachable = coversEveryStep(visited, count)
        if (!reachable) attempts.push(`direct controls reached ${visited.join(',') || '(none)'}`)
      }
      // Reaching every step needs Next alone, so a demo that hides Previous at
      // the first step, or Next at the last, is not penalised here.
      if (!reachable && typeof page.activateDirection === 'function') {
        const walker = await session(PROBE_REQUIREMENTS['demo-browse-mode-behavior'])
        const visited = []
        let advanced = true
        for (let position = 1; position < count && advanced; position += 1) {
          advanced = (await walker.activateDirection('next')) === true
          if (!advanced) break
          visited.push((await walker.state()).stepIndex)
        }
        reachable = advanced && coversEveryStep([0, ...visited], count)
        if (!reachable) attempts.push(`forward traversal reached ${visited.join(',') || '(none)'}`)
      }
      const captionStatus = state.textPresence
        ? ((state.textPresence[contract.step_captions[state.stepIndex]]?.visibleElements ?? 0)
          + (state.textPresence[contract.step_captions[state.stepIndex]]?.accessibleNames ?? 0) > 0
            ? 'active' : (state.textPresence[contract.step_captions[state.stepIndex]]?.complete ? 'absent' : 'unknown'))
        : (state.captionVisible ? 'active' : 'absent')
      const captionMatches = sameText(state.caption, contract.step_captions[state.stepIndex])
      const complete = state.mode === 'browse'
        && state.captionVisible === true
        && captionMatches
        && reachable
      return decide({
        pass: complete,
        rationale: `browse mode ${bounded(state.mode)} at viewport ${bounded(state.viewport?.width)}×${bounded(state.viewport?.height)}; caption ${state.captionVisible}; controls ${controls.length}/${count}; every step reached ${reachable}${attempts.length > 0 ? ` (${bounded(attempts.join('; '))})` : ''}; previous/next ${state.previousVisible}/${state.nextVisible}; toc ${state.tocVisible}; progress ${state.progressVisible}`,
        restsOn: reachable ? [
          { reading: 'declared browse mode', basis: state.modeBasis },
          { reading: 'declared caption selector', basis:
            (!state.captionVisible || !captionMatches) && captionStatus !== 'absent'
              ? 'heuristic' : (captionStatus === 'unknown' ? 'unknown' : 'declared') },
        ] : [],
      })
    },

    'demo-mode-position-preservation': async () => {
      const page = await session(PROBE_REQUIREMENTS['demo-mode-position-preservation'])
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
      const page = await session(PROBE_REQUIREMENTS['demo-supported-navigation'])
      await page.press('ArrowRight')
      const forward = (await page.state()).stepIndex
      await page.press('ArrowLeft')
      const back = (await page.state()).stepIndex
      await page.swipe('left', { input: 'touch' })
      let swiped = (await page.state()).stepIndex
      const touchLeft = swiped
      let pointerLeft = null
      if (swiped === 0) {
        await page.swipe('left', { input: 'pointer' })
        swiped = (await page.state()).stepIndex
        pointerLeft = swiped
      }
      await page.swipe('right', { input: 'touch' })
      let swipedBack = (await page.state()).stepIndex
      const touchRight = swipedBack
      let pointerRight = null
      if (swipedBack === swiped) {
        await page.swipe('right', { input: 'pointer' })
        swipedBack = (await page.state()).stepIndex
        pointerRight = swipedBack
      }
      const browsePage = await session({ mode: 'browse', position: 0 })
      const controls = (await browsePage.state()).controls ?? []
      const target = controls[4]
      if (target) await browsePage.activate(target.name)
      const jumped = (await browsePage.state()).stepIndex
      const ok = forward === 1 && back === 0 && swiped === 1 && swipedBack === 0 && jumped === 4
      return decide({
        pass: ok,
        rationale: `keyboard ${forward}/${back}, swipe ${swiped}/${swipedBack}, direct jump ${jumped}`,
        observations: { swipe: { touch: { left: touchLeft, right: touchRight },
          pointer: pointerLeft === null && pointerRight === null ? null : { left: pointerLeft, right: pointerRight } } },
        restsOn: [{ reading: 'touch and pointer swipe', basis:
          forward === 1 && back === 0 && jumped === 4 && (swiped !== 1 || swipedBack !== 0)
            && ((touchLeft === 0 && pointerLeft === 0) || (touchRight === swiped && pointerRight === swiped))
            ? 'heuristic' : 'declared' }],
      })
    },

    'demo-navigation-boundaries-and-control-keys': async () => {
      const page = await session(PROBE_REQUIREMENTS['demo-navigation-boundaries-and-control-keys'])
      await page.press('ArrowLeft')
      const atStart = (await page.state()).stepIndex
      const first = await page.state()
      const count = await stepCountOf(first)
      for (let position = 1; position < count; position += 1) await page.press('ArrowRight')
      const last = (await page.state()).stepIndex
      await page.press('ArrowRight')
      const pastEnd = (await page.state()).stepIndex

      // Controls a demo exposes only in browse mode are still controls a reader
      // clicks, so the key half of this check follows them there rather than
      // skipping itself when present mode has none.
      let host = await session(PROBE_REQUIREMENTS['demo-navigation-boundaries-and-control-keys'])
      let controls = (await host.state()).controls ?? []
      if (controls.length === 0) {
        host = await session({ mode: 'browse', position: 0 })
        controls = (await host.state()).controls ?? []
      }
      if (controls[0]) await host.activate(controls[0].name)
      const beforeFocusedKey = (await host.state()).stepIndex
      await host.press('ArrowRight')
      const afterFocusedKey = (await host.state()).stepIndex
      const released = await host.releaseFocus()
      if (!released) {
        await host.restoreFocusTarget()
        throw browserInfrastructureFailure('could not release focus from the navigation control')
      }
      const beforeReleasedKey = (await host.state()).stepIndex
      const deckKey = beforeReleasedKey === count - 1 ? 'ArrowLeft' : 'ArrowRight'
      let afterReleasedKey
      try {
        await host.press(deckKey)
        afterReleasedKey = (await host.state()).stepIndex
      } finally {
        await host.restoreFocusTarget()
      }
      const keysAfterFocusReleased = deckKey === 'ArrowRight'
        ? afterReleasedKey === beforeReleasedKey + 1
        : afterReleasedKey === beforeReleasedKey - 1
      const clampsHold = atStart === 0 && last === count - 1 && pastEnd === count - 1
      const ok = clampsHold && keysAfterFocusReleased
      return [
        ok,
        `start clamp ${atStart}, end clamp ${last}→${pastEnd}, `
          + `keys while control focused ${beforeFocusedKey}→${afterFocusedKey}, `
          + `keys after focus released ${beforeReleasedKey}→${afterReleasedKey}`,
        [],
        {
          // Observed, never scored: whether a focused control lets deck keys
          // through is judged from source by `navigation-controls-keep-keys`.
          keys_while_control_focused: { before: beforeFocusedKey, after: afterFocusedKey },
          keys_after_focus_released: { key: deckKey, before: beforeReleasedKey, after: afterReleasedKey },
        },
      ]
    },

    'demo-step-and-transition-reliability': async () => {
      const page = await session(PROBE_REQUIREMENTS['demo-step-and-transition-reliability'])
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
      const page = await session(PROBE_REQUIREMENTS['demo-mode-interaction-reliability'])
      for (let round = 0; round < 4; round += 1) {
        await page.toggleMode()
        const state = await page.state()
        // A missing mode or step index never reaches here: that read is a
        // harness failure. What remains is a mode the demo does not define.
        if (!['present', 'browse'].includes(state.mode)) {
          return [false, `mode toggle ${round + 1} left an unreadable state`, [bounded(state.mode)]]
        }
      }
      const observed = await page.failures()
      if (observed.length > 0) return [false, 'the browser reported failures during mode interaction', observed]
      return [true, 'repeated mode changes left the demo readable and error free', []]
    },

    'demo-control-semantics': async () => {
      await session(PROBE_REQUIREMENTS['demo-control-semantics'])
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
        if (!marksActiveStep(controls, current[0], state.stepIndex, contract.step_titles)) {
          return [false, `step ${position + 1} marks the wrong control as current`, []]
        }
      }
      return [true, 'controls expose a role, an accessible name, and the current step', []]
    },

    'demo-focus-and-keyboard-accessibility': async () => {
      const page = await session(PROBE_REQUIREMENTS['demo-focus-and-keyboard-accessibility'])
      const controls = (await page.state()).controls ?? []
      if (controls.length === 0) return [false, 'there are no controls to focus', []]
      // A control disabled at a boundary (Previous on the first step) is
      // correctly out of the tab order; only an enabled control must focus.
      const enabled = controls.filter(({ disabled }) => disabled !== true)
      if (enabled.length === 0) return [false, 'there are no enabled controls to focus', []]
      const unfocusable = enabled.find(({ focusable }) => focusable !== true)
      if (unfocusable) return [false, `control ${bounded(unfocusable.name)} is not keyboard focusable`, []]
      await page.focus(enabled[0].name)
      const focused = (await page.state()).focused
      if (focused !== enabled[0].name) {
        return [false, `focusing a control left focus on ${bounded(focused)}`, []]
      }
      // A focused button owns its own key handling. Observe global deck
      // navigation in a fresh page state rather than requiring the app to
      // hijack arrow keys from an interactive control.
      const keyboardPage = await session(PROBE_REQUIREMENTS['demo-focus-and-keyboard-accessibility'])
      const before = (await keyboardPage.state()).stepIndex
      await keyboardPage.press('ArrowRight')
      const after = (await keyboardPage.state()).stepIndex
      return [after === before + 1, `focus succeeded and keyboard navigation moved ${before} → ${after}`, []]
    },

    // Modified arrows belong to the browser and the operating system: Alt+Left
    // is history back, Control and Meta arrows move between words, tabs, and
    // spaces. Six presses from a middle step, each with one modifier held. The
    // keydown instrumentation wraps KeyboardEvent.prototype.preventDefault, so
    // a page that stops propagation still shows its preventDefault call.
    // chrome-devtools-axi offers no init-script primitive, so the
    // instrumentation is installed into the loaded document before the first
    // press rather than before the page's own scripts run; a page that wraps
    // preventDefault itself is out of its reach.
    'input-modifier-keys-pass-through': async () => {
      const { mode } = PROBE_REQUIREMENTS['input-modifier-keys-pass-through']
      const { count, middle } = await middleStep('input-modifier-keys-pass-through')
      if (middle === null) return noMiddleStep(count, 'modified arrow keys were not pressed')
      const start = async () => {
        const page = await session({ mode, position: middle })
        requireDriver(page, ['installKeyInstrumentation', 'readKeyInstrumentation'])
        await page.installKeyInstrumentation()
        return page
      }
      // The press already counted; only re-establishing the starting step
      // remains, and failing to is the harness's fault, never the page's.
      const reestablish = async (reason) => {
        try {
          return await start()
        } catch (error) {
          throw browserInfrastructureFailure(
            `the presentation could not be reloaded at step index ${middle} after ${reason}: ${bounded(error?.message)}`,
          )
        }
      }
      let page = await start()
      const presses = []
      for (const modifier of MODIFIERS) {
        for (const key of ['ArrowRight', 'ArrowLeft']) {
          const chord = `${modifier}+${key}`
          // A document that left only after the previous press was read
          // belongs to that press.
          if ((await page.readKeyInstrumentation({ reset: true })).unloaded) {
            const previous = presses.at(-1)
            if (previous) Object.assign(previous, { unloaded: true, step_after: null, reestablished: true })
            page = await reestablish(previous
              ? `${previous.modifier}+${previous.key} left the document` : 'the document left before the first press')
            await page.readKeyInstrumentation({ reset: true })
          }
          const before = (await page.state()).stepIndex
          await page.press(key, { modifiers: [modifier] })
          let reading = await page.readKeyInstrumentation()
          let after = null
          if (!reading.unloaded) {
            try {
              after = (await page.state()).stepIndex
            } catch (error) {
              // A read that lands on the document replacing this one is the
              // press leaving the document, not an unreadable presentation.
              const again = await page.readKeyInstrumentation()
              if (!again.unloaded) throw error
              reading = { ...again, keydowns: reading.keydowns }
            }
          }
          if (!reading.unloaded) {
            // A second read also catches a document that left after the state
            // read, and a default the page prevented once dispatch was over.
            const confirmed = await page.readKeyInstrumentation()
            reading = confirmed.unloaded ? { ...confirmed, keydowns: reading.keydowns } : confirmed
          }
          const keydowns = (reading.keydowns ?? []).filter((entry) => (
            entry?.key === key && entry?.[MODIFIER_FLAGS[modifier]] === true
          ))
          const press = {
            key,
            modifier,
            step_before: before,
            step_after: reading.unloaded ? null : after,
            prevented: keydowns.some(({ prevented }) => prevented === true),
            prevent_default_calls: keydowns.reduce((sum, { preventDefaultCalls }) => (
              sum + (Number.isInteger(preventDefaultCalls) ? preventDefaultCalls : 0)), 0),
            keydown_observed: keydowns.length > 0,
            unloaded: reading.unloaded === true,
            reestablished: false,
          }
          presses.push(press)
          // Leaving the document is the shortcut reaching the browser, so the
          // press passes through; a step change is a failure already recorded.
          // Either way the next press starts from the same middle step.
          if (press.unloaded || press.step_after !== press.step_before) {
            press.reestablished = true
            page = await reestablish(press.unloaded ? `${chord} left the document` : `${chord} changed the step`)
          }
        }
      }
      const failing = presses.find((press) => (
        press.prevented || (!press.unloaded && press.step_after !== press.step_before)))
      const failure = failing ? {
        key: failing.key,
        modifier: failing.modifier,
        reason: !failing.unloaded && failing.step_after !== failing.step_before ? 'step-changed' : 'prevented-default',
        // A press that changed the step may also have had its default
        // prevented; the summary keeps both facts.
        prevented: failing.prevented === true,
        step_before: failing.step_before,
        step_after: failing.step_after,
      } : null
      const describe = (press) => `${press.modifier}+${press.key} ${press.step_before}→${press.unloaded ? 'unloaded' : press.step_after}${press.prevented ? ' (default prevented)' : ''}`
      return [
        failure === null,
        failure === null
          ? `modified arrow presses from step index ${middle} passed through: ${presses.map(describe).join(', ')}`
          : (failure.reason === 'step-changed'
            ? `${failure.modifier}+${failure.key} moved the deck from step index ${failure.step_before} to ${failure.step_after}${failure.prevented ? ' and the page prevented its default' : ''}`
            : `the page prevented the default of ${failure.modifier}+${failure.key} at step index ${failure.step_before}`),
        [],
        { modifier_keys: { mode, start_step: middle, instrumentation: 'installed-before-first-press', presses, failure } },
      ]
    },

    // A swipe that starts on one of the presentation's own controls belongs to
    // that control, so it must not navigate the deck. The swipe starts at the
    // control's centre and travels the existing swipe's distance and pacing,
    // as touch events and then, when the step stays put, as pointer events.
    'input-swipe-from-control-ignored': async () => {
      const id = 'input-swipe-from-control-ignored'
      const { mode: preferredMode } = PROBE_REQUIREMENTS[id]
      const { count, middle } = await middleStep(id)
      if (middle === null) return noMiddleStep(count, 'no swipe was started on a control')
      const lookedFor = []
      let chosen = null
      for (const mode of [preferredMode, preferredMode === 'present' ? 'browse' : 'present']) {
        const page = await session({ mode, position: middle })
        requireDriver(page, ['controlTargets'])
        const discovered = await page.controlTargets()
        for (const convention of discovered?.looked_for ?? []) {
          if (!lookedFor.includes(convention)) lookedFor.push(convention)
        }
        const choice = chooseSwipeControl(discovered?.controls ?? [], middle, contract.step_titles)
        if (choice) {
          chosen = { mode, page, ...choice, discovered: (discovered.controls ?? []).length }
          break
        }
      }
      if (!chosen) {
        return notObserved('no interactive control was discovered inside the presentation in either mode', [],
          lookedFor.length > 0 ? lookedFor : SWIPE_CONTROL_CONVENTIONS)
      }
      const { mode, control, target } = chosen
      // A swipe travels away from the control's own target, so a step the
      // swipe reaches is never mistaken for the control's activation.
      const direction = target !== null && target > middle ? 'right' : 'left'
      const attempts = []
      let page = chosen.page
      for (const input of ['touch', 'pointer']) {
        const last = attempts.at(-1)
        if (last?.changed && !last.exempt) break
        if (last?.changed) page = await session({ mode, position: middle })
        const before = (await page.state()).stepIndex
        const dispatched = await page.swipe(direction, { input, selector: control.selector })
        if (dispatched === false) {
          throw browserInfrastructureFailure(
            `the discovered ${control.kind} control ${bounded(control.selector)} could not be found to start a swipe on`,
          )
        }
        const after = (await page.state()).stepIndex
        const changed = after !== before
        attempts.push({ input, step_before: before, step_after: after, changed,
          exempt: changed && target !== null && after === target })
      }
      const failing = attempts.find(({ changed, exempt }) => changed && !exempt)
      const observation = {
        mode,
        start_step: middle,
        direction,
        control: {
          kind: control.kind,
          name: normalizeEvidence(control.name ?? ''),
          selector: normalizeEvidence(control.selector),
          hook: control.hook == null ? null : normalizeEvidence(control.hook),
          activation_target: target,
        },
        controls_discovered: chosen.discovered,
        inputs_tried: attempts.map(({ input }) => input),
        attempts,
        failure: failing
          ? { input: failing.input, step_before: failing.step_before, step_after: failing.step_after }
          : null,
      }
      const swiped = attempts.map(({ input, step_before: before, step_after: after }) => `${input} ${before}→${after}`).join(', ')
      return [
        !failing,
        failing
          ? `a ${failing.input} swipe ${direction} starting on the ${control.kind} control ${bounded(control.selector)} in ${mode} mode moved the deck from step index ${failing.step_before} to ${failing.step_after}`
          : `swipes ${direction} starting on the ${control.kind} control ${bounded(control.selector)} in ${mode} mode left the deck on its step (${swiped})`,
        [],
        { swipe_from_control: observation },
      ]
    },
  }

  const criteria = []
  for (const id of DETERMINISTIC_BROWSER_CRITERIA) {
    const requirement = PROBE_REQUIREMENTS[id]
    const inputs = {
      schema_version: 1,
      criterion: id,
      revision,
      route: contract.route,
      contract_sha256: hashJson(contract),
      evaluator_fingerprint: evaluatorFingerprint,
      required_mode: requirement.mode,
      start_position: requirement.position,
    }
    const dependencies = { revision, route: contract.route }
    const inputSha256 = hashJson(inputs)
    const loaded = await loadProbe?.({ id, inputs, dependencies })
    // Old checkpoints may have mistaken an AXI/Chrome startup diagnostic for
    // page-console output. Never preserve that candidate verdict: rerun the
    // probe under the current browser preflight and replace its artifact.
    const reused = probeContainsBrowserInfrastructureDiagnostic(loaded) ? null : loaded
    if (reused) {
      const record = { ...reused, reused: true }
      probeRecords.push(record)
      criteria.push(record.result)
      for (const failure of record.failures ?? []) failures.add(normalizeEvidence(failure))
      if (record.failure_reporting_available === false) failureReportingAvailable = false
      continue
    }

    currentProbeSessions = []
    currentProbeObservations = []
    currentProbeObservationsDropped = 0
    let criterion
    try {
      const outcome = await probes[id]()
      if (outcome?.not_observed) {
        criterion = notObservedCriterion(id, outcome, probeCitation(id))
      } else {
        const [pass, rationale, evidence, observations = {}] = outcome
        // A probe that cites a single string is citing one artifact, not a list
        // of characters.
        const citations = Array.isArray(evidence) ? evidence : [evidence]
        criterion = verdict(id, pass, rationale, [...citations, probeCitation(id)])
        criterion.observations = observations
      }
    } catch (error) {
      if (error?.owner === 'evaluation-harness') throw error
      if (error?.not_observed) {
        criterion = notObservedCriterion(id, error, probeCitation(id))
      } else {
      // A driver or page error is a real observation about the demo, so it
      // fails its own criterion instead of aborting the whole evaluation and
      // discarding every other criterion's evidence.
      criterion = verdict(
        id,
        false,
        `browser evaluation failed: ${error.message}`,
        [probeCitation(id)],
      )
      }
    }
    const probeFailures = []
    let probeFailureReportingAvailable = true
    try {
      for (const failure of await driver.failures()) {
        if (isBrowserInfrastructureDiagnostic(failure)) {
          throw browserInfrastructureFailure(failure)
        }
        const safe = normalizeEvidence(failure)
        failures.add(safe)
        probeFailures.push(safe)
      }
    } catch (error) {
      if (error?.owner === 'evaluation-harness') throw error
      // An empty failure set only proves clean rendering when the failure list
      // could actually be read. Losing the page or the console log means the
      // evidence is missing, so the renders gate goes unobserved rather than
      // passing on the strength of what was never collected.
      failureReportingAvailable = false
      probeFailureReportingAvailable = false
    }
    criteria.push(criterion)
    const firstSession = currentProbeSessions[0] ?? {
      initial_state: { mode: null, position: null },
      established_state: { mode: requirement.mode, position: requirement.position },
      settled_state: { settled: false, strategy: 'probe-failed-before-settle' },
    }
    const readingBasis = currentProbeObservations.filter(({ kind }) => kind === 'state')
      .map(({ mode_basis, title_basis, caption_basis }) => ({ mode: mode_basis, title: title_basis, caption: caption_basis }))
    const outputs = {
      initial_state: firstSession.initial_state,
      established_state: firstSession.established_state,
      settled_state: firstSession.settled_state,
      sessions: currentProbeSessions,
      probe_observations: currentProbeObservations,
      reading_basis: readingBasis,
      probe_observations_dropped: currentProbeObservationsDropped,
      result: criterion,
      failures: probeFailures,
      failure_reporting_available: probeFailureReportingAvailable,
      ...(criterion.observations ?? {}),
    }
    const record = {
      id,
      ownership: 'evaluator-produced',
      evaluator: 'deterministic-browser',
      revision,
      required_mode: requirement.mode,
      start_position: requirement.position,
      initial_state: firstSession.initial_state,
      established_state: firstSession.established_state,
      settled_state: firstSession.settled_state,
      sessions: currentProbeSessions,
      probe_observations: currentProbeObservations,
      reading_basis: readingBasis,
      probe_observations_dropped: currentProbeObservationsDropped,
      input_sha256: inputSha256,
      result: criterion,
      failures: probeFailures,
      failure_reporting_available: probeFailureReportingAvailable,
      outputs,
      output_sha256: hashJson(outputs),
      reused: false,
    }
    probeRecords.push(record)
    await saveProbe?.({ id, inputs, dependencies, result: record })
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
        [verificationCitation, ...(build.log ? [build.log] : [])],
      ),
    (() => {
      const inputs = ['demo-route-and-registration', 'demo-nine-step-content-and-order']
      const citations = inputs.map(probeCitation)
      const rationale = 'the canonical nine-step sample must be registered, reachable, and match its outline'
      if (inputs.some((id) => criteria.find((entry) => entry.id === id)?.verdict === 'fail')) {
        return verdict('verification-sample-outline', false, rationale, citations)
      }
      if (inputs.every(passed)) return verdict('verification-sample-outline', true, rationale, citations)
      return unobserved('verification-sample-outline', rationale, citations)
    })(),
    failureReportingAvailable
      ? verdict(
        'verification-every-produced-step-renders',
        failures.size === 0,
        failures.size === 0
          ? 'every produced step rendered without runtime or console errors'
          : `${failures.size} runtime or console failure(s) occurred while stepping the demo`,
        [
          ...DETERMINISTIC_BROWSER_CRITERIA.map((id) => probeCitation(id)),
          ...[...failures].slice(0, 10),
        ],
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
        [verificationCitation, ...(verification.artifact ? [verification.artifact] : [])],
      ),
  ]

  return {
    criteria,
    gates,
    ownership: 'evaluator-produced',
    evaluator: 'deterministic-browser',
    revision,
    initial_state: probeRecords[0]?.initial_state ?? null,
    probes: probeRecords,
    failures: [...failures],
    failure_reporting_available: failureReportingAvailable,
    bounds_exceeded: [...new Set(boundsExceeded)],
  }
}
