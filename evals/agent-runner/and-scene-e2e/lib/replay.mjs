// The closed replay schema for browser judges and the judgement of its expectations. Expectations are
// generic: nothing here names a route, step count, title, era, hook or canvas size.
export const PRESS_MODIFIERS = ['Alt', 'Control', 'Meta']
export const EXPECTATION_TYPES = ['selector-visible', 'selector-hidden', 'text-present', 'rendered-state-changes', 'rendered-state-matches']
export const SHAPES = { navigate: ['path'], press: ['key'], keys: ['text'], swipe: ['direction', 'input'], wait: ['ms'], mark: ['label'] }
export const OPTIONAL = { press: ['modifiers'], swipe: ['selector'] }
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0
export const REPLAY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['actions', 'expect'],
  properties: {
    actions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: true, required: ['type'], properties: { type: { type: 'string', enum: ['navigate', 'click', 'press', 'keys', 'swipe', 'wait', 'mark'] } } } },
    expect: { type: 'object', additionalProperties: true, required: ['type'], properties: { type: { type: 'string', enum: EXPECTATION_TYPES } } },
  },
}
export function validReplay(replay) {
  if (!replay || typeof replay !== 'object' || Array.isArray(replay) || Object.keys(replay).sort().join(',') !== 'actions,expect') return false
  const { actions, expect } = replay
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 20 || actions[0]?.type !== 'navigate' || actions.slice(1).some(action => action?.type === 'navigate')) return false
  const marks = new Set()
  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return false
    if (action.type === 'click') {
      const keys = Object.keys(action).filter(key => key !== 'type').sort().join(',')
      if (!(keys === 'selector' && nonEmpty(action.selector)) && !(keys === 'text' && nonEmpty(action.text))) return false
      continue
    }
    const fields = SHAPES[action.type]
    if (!fields) return false
    const keys = Object.keys(action).filter(key => key !== 'type' && !OPTIONAL[action.type]?.includes(key)).sort().join(',')
    if (keys !== [...fields].sort().join(',')) return false
    if (action.type === 'wait' && !(Number.isInteger(action.ms) && action.ms >= 0 && action.ms <= 2000)) return false
    if (action.type === 'swipe' && (!['left', 'right'].includes(action.direction) || !['touch', 'pointer'].includes(action.input) || (action.selector != null && !nonEmpty(action.selector)))) return false
    if (action.type === 'press' && action.modifiers != null && (!Array.isArray(action.modifiers) || new Set(action.modifiers).size !== action.modifiers.length || action.modifiers.some(modifier => !PRESS_MODIFIERS.includes(modifier)))) return false
    if (action.type === 'navigate' && (!nonEmpty(action.path) || !action.path.startsWith('/') || action.path.startsWith('//') || action.path.includes('..') || action.path.includes('\\'))) return false
    if (action.type === 'mark') { if (!nonEmpty(action.label) || marks.has(action.label)) return false; marks.add(action.label) }
    if (['keys', 'press'].includes(action.type) && !nonEmpty(action[fields[0]])) return false
  }
  if (!expect || typeof expect !== 'object' || Array.isArray(expect) || !EXPECTATION_TYPES.includes(expect.type)) return false
  const fields = { 'selector-visible': 'selector', 'selector-hidden': 'selector', 'text-present': 'text', 'rendered-state-changes': '', 'rendered-state-matches': 'label' }[expect.type]
  const allowed = new Set(['type', ...(fields ? [fields] : []), ...(expect.type === 'text-present' ? ['selector'] : [])])
  if (Object.keys(expect).some(key => !allowed.has(key))) return false
  if (fields && !nonEmpty(expect[fields])) return false
  if (expect.type === 'rendered-state-matches' && !marks.has(expect.label)) return false
  return true
}
export const probeSelectors = replay => [replay.expect.selector].filter(Boolean)
// Judge the expectation against the observations a generic replay returned.
export function expectationMet(expect, result) {
  const states = result.states ?? []
  const first = states[0]
  const last = result.final ?? states.at(-1)
  if (!first || !last) return { met: false, reason: 'the replay observed no rendered state' }
  const probe = (state, selector) => state?.probes?.find(entry => entry.selector === selector)
  switch (expect.type) {
    case 'selector-visible': return probe(last, expect.selector)?.visible === true ? { met: true } : { met: false, reason: `${expect.selector} was not visible after the replay` }
    case 'selector-hidden': return probe(first, expect.selector)?.visible === true && probe(last, expect.selector)?.visible === false ? { met: true } : { met: false, reason: `${expect.selector} was not visible and then hidden` }
    case 'text-present': {
      const haystack = expect.selector ? probe(last, expect.selector)?.text ?? '' : last.text ?? ''
      return haystack.toLowerCase().includes(expect.text.toLowerCase()) ? { met: true } : { met: false, reason: `the text ${JSON.stringify(expect.text)} was not present` }
    }
    case 'rendered-state-changes': return first.dom !== last.dom || first.screenshot !== last.screenshot ? { met: true } : { met: false, reason: 'the rendered state did not change' }
    case 'rendered-state-matches': {
      const saved = result.marks?.[expect.label]
      if (!saved) return { met: false, reason: `no state was saved under ${expect.label}` }
      return saved.dom === last.dom && saved.screenshot === last.screenshot ? { met: true } : { met: false, reason: `the rendered state does not match the one saved as ${expect.label}` }
    }
    default: return { met: false, reason: 'unknown expectation' }
  }
}
// Replay in a fresh browser context and decide: a failure to reproduce, a runtime failure or a product failure is a mismatch.
export async function executeReplay({ driver, replay }) {
  if (!validReplay(replay)) return { confirmed: false, mismatch: 'the replay is outside the closed replay schema' }
  const result = await driver.replayGeneric(replay.actions, probeSelectors(replay))
  if (result.product_failure) return { confirmed: false, mismatch: result.product_failure, result }
  const judged = expectationMet(replay.expect, result)
  return { confirmed: judged.met, mismatch: judged.met ? null : judged.reason, result }
}
