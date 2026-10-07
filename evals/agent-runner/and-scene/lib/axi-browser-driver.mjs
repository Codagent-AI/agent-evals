// Production browser adapter for deterministic evaluation.
//
// chrome-devtools-axi owns Chromium and exposes a small script API. This
// adapter translates that API into the deliberately tiny driver consumed by
// browser-eval.mjs, keeping browser mechanics out of scoring logic.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { isBrowserInfrastructureDiagnostic } from './browser-diagnostics.mjs'
import { validReplay } from './second-opinion.mjs'

const MAX_OUTPUT_BYTES = 1024 * 1024
const PRESENTATION_SELECTOR = '[data-presentation], [data-presentation-root]'
const MODE_SELECTOR = '[data-presentation-mode]'
const STAGE_SELECTOR = [
  '[data-presentation-stage]',
  '[data-presentation-chrome="stage"]',
].join(', ')
const CANVAS_SELECTOR = [
  '[data-presentation-canvas]',
  '[data-presentation-node="canvas"]',
  '[data-testid="presentation-canvas"]',
].join(', ')
const TITLE_SELECTORS = [
  '[data-presentation-present-title]',
  '[data-presentation-step-title]',
  '[data-presentation-header-title]',
  '[data-presentation-footer-title]',
  '[data-presentation-node="step-title"]',
  '[data-presentation-footer] h1, [data-presentation-footer] h2, [data-presentation-footer] h3',
  '[data-presentation-stage] h1, [data-presentation-stage] h2, [data-presentation-stage] h3',
  '[data-presentation-header] h1, [data-presentation-header] h2, [data-presentation-header] h3',
  '[data-presentation-title]',
]
const TITLE_SELECTOR = TITLE_SELECTORS.join(', ')
// Asking *which* element is the title requires a ranked list. Asking whether
// the active step's title is exposed at all does not, so that question is
// answered from every text-bearing element of the presentation's own chrome.
const TITLE_TEXT_SELECTORS = [
  ...TITLE_SELECTORS,
  '[data-presentation-presenter-title]',
  '[data-presentation-active-title]',
  ...['header', 'footer', 'stage'].flatMap((region) => (
    ['h1', 'h2', 'h3', 'h4', 'p', 'span', 'strong'].map((tag) => `[data-presentation-${region}] ${tag}`)
  )),
]
// Hooks that declare an element a title or a step marker. The footer-paragraph
// caption fallback excludes them: a present-mode title paragraph or a marker
// paragraph such as "01 / 09 · the ask" is not a caption, and reading either as
// one makes a deck without an explicit mode attribute look like it is always
// browsing. The marker stays title-bearing text, since a step title nested in a
// marker element is still visible to a reader.
const NON_CAPTION_HOOK_ATTRIBUTES = [
  'data-presentation-present-title',
  'data-presentation-step-title',
  'data-presentation-header-title',
  'data-presentation-footer-title',
  'data-presentation-presenter-title',
  'data-presentation-active-title',
  'data-presentation-title',
  'data-presentation-marker',
]
const CAPTION_SELECTORS = [
  '[data-presentation-caption]',
  '[data-presentation-node="caption"]',
  // The heuristic selectors never read a step marker as a caption; an element
  // a deck explicitly hooks as its caption above stays one.
  'figcaption:not([data-presentation-marker])',
  "[aria-label*='caption' i]:not([data-presentation-marker])",
  `[data-presentation-footer] p${NON_CAPTION_HOOK_ATTRIBUTES.map((hook) => `:not([${hook}])`).join('')}`
    + ':not([data-presentation-node="step-title"])',
]
const CAPTION_SELECTOR = CAPTION_SELECTORS.join(', ')
const DECLARED_TITLE_SELECTORS = TITLE_SELECTORS.filter((selector) => !selector.includes(' h'))
const DECLARED_CAPTION_SELECTORS = CAPTION_SELECTORS.slice(0, 2)

function modeReadingSource() {
  return `const modeReading = () => {
    const declaredModeSource = () => {
      for (const element of document.querySelectorAll('[data-presentation-mode]')) {
        const value = element.getAttribute('data-presentation-mode');
        if (value === 'present' || value === 'browse') return value;
      }
      for (const element of document.querySelectorAll('[data-mode]')) {
        if (!element.matches('[data-step-count]') && !element.querySelector('[data-step-count]')) continue;
        const value = element.getAttribute('data-mode');
        if (value === 'present' || value === 'browse') return value;
      }
      return null;
    };
    const declared = declaredModeSource();
    if (declared) return { mode: declared, basis: 'declared' };
    const visible = (element) => Boolean(element && element.getClientRects().length > 0
      && getComputedStyle(element).display !== 'none'
      && getComputedStyle(element).visibility !== 'hidden');
    const browsing = [...document.querySelectorAll(${JSON.stringify(`${CAPTION_SELECTOR}, ${TOC_SELECTOR}`)})]
      .some(visible);
    return { mode: browsing ? 'browse' : 'present', basis: 'heuristic' };
  };`
}
const TOC_SELECTORS = [
  '[data-presentation-toc]',
  '[data-presentation-chrome="toc"]',
  "nav[aria-label*='contents' i]",
  "nav[aria-label*='sections' i]",
  "[role='navigation'][aria-label*='contents' i]",
  "[role='navigation'][aria-label*='sections' i]",
]
const TOC_SELECTOR = TOC_SELECTORS.join(', ')
const EXPLICIT_CONTROL_SELECTOR = [
  '[data-presentation-progress-dot]',
  '[data-presentation-progress-item]',
  '[data-presentation-node="progress-dot"]',
].join(', ')
const PROGRESS_SELECTORS = [
  '[data-presentation-progress]',
  '[data-presentation-chrome="progress"]',
  "nav[aria-label*='progress' i]",
  "[role='navigation'][aria-label*='progress' i]",
]
const PROGRESS_SELECTOR = PROGRESS_SELECTORS.join(', ')
const STEP_CONTROL_REGION_SELECTORS = [
  '[data-presentation-step-controls]',
  '[data-presentation-controls]',
  '[data-presentation-chrome="controls"]',
  "nav[aria-label*='navigation' i]",
  "[role='navigation'][aria-label*='navigation' i]",
]
const INTERACTIVE_SELECTOR = 'button, [role="button"], a[href]'
const PREVIOUS_SELECTORS = [
  '[data-presentation-prev]',
  '[data-presentation-previous]',
  '[data-presentation-button="previous"]',
  '[data-presentation-node="previous"]',
]
const NEXT_SELECTORS = [
  '[data-presentation-next]',
  '[data-presentation-button="next"]',
  '[data-presentation-node="next"]',
]
const MODE_TOGGLE_SELECTORS = [
  '[data-presentation-mode-toggle]',
  '[data-presentation-button="mode"]',
  '[data-presentation-node="mode-toggle"]',
]
// A scene identity has to identify something. A bare boolean marker names no
// scene, so it is not a declared identity.
const SCENE_ID_SELECTORS = [
  '[data-presentation-scene-id]',
  '[data-scene-id]',
  '[data-presentation-scene]',
]

// Where focus rests once a control lets go of it. No fixture requirement names
// a root hook, so a presentation marked only by its mode is still its own
// root, and a page with neither falls back to the document body.
function focusRootSource() {
  return `(document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)})
    || document.querySelector(${JSON.stringify(MODE_SELECTOR)})
    || document.body)`
}

function navigationDiscoverySource() {
  return `
  const visible = (element) => Boolean(element && element.getClientRects().length > 0
    && getComputedStyle(element).display !== 'none'
    && getComputedStyle(element).visibility !== 'hidden');
  const accessibleName = (element) => {
    if (!element) return '';
    const labelledBy = (element.getAttribute('aria-labelledby') || '')
      .split(/\\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean)
      .join(' ');
    return element.getAttribute('aria-label')?.trim()
      || labelledBy
      || element.getAttribute('title')?.trim()
      || element.textContent?.trim()
      || '';
  };
  const scope = presentation || document;
  const matchedSelectors = {};
  const firstVisibleMatch = (selectors, role = null) => {
    for (const selector of selectors) {
      const match = [...scope.querySelectorAll(selector)].find(visible);
      if (match) {
        if (role) matchedSelectors[role] = selector;
        return match;
      }
    }
    if (role) matchedSelectors[role] = null;
    return null;
  };
  const allInteractive = [...scope.querySelectorAll('${INTERACTIVE_SELECTOR}')];
  const inDomOrder = (elements) => [...new Set(elements)]
    .filter(visible)
    .sort((left, right) => (
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    ));
  // Previous, next, and mode controls sit beside step controls in many
  // progress rows; they navigate relatively, so they are never step controls.
  const directionalSelector = ${JSON.stringify([...PREVIOUS_SELECTORS, ...NEXT_SELECTORS, ...MODE_TOGGLE_SELECTORS].join(', '))};
  const isDirectional = (element) => element.matches(directionalSelector)
    || /^(?:previous|prev|back|next)\\b/i.test(accessibleName(element));
  const stepControlsOnly = (elements) => elements.filter((element) => !isDirectional(element));
  const explicitControls = stepControlsOnly(inDomOrder([
    ...scope.querySelectorAll(${JSON.stringify(EXPLICIT_CONTROL_SELECTOR)}),
  ]));
  const progressRegion = firstVisibleMatch(${JSON.stringify(PROGRESS_SELECTORS)}, 'progress');
  const semanticControls = progressRegion
    ? stepControlsOnly(inDomOrder([...progressRegion.querySelectorAll('${INTERACTIVE_SELECTOR}')]))
    : [];
  const namedStepControls = inDomOrder(allInteractive.filter((element) => (
    /^(?:(?:go to|jump to)\\s+)?step\\s+\\d+(?::|$)/i.test(accessibleName(element))
  )));
  const controls = semanticControls.length > 0
    ? semanticControls
    : (explicitControls.length > 0 ? explicitControls : namedStepControls);
  matchedSelectors.controls = semanticControls.length > 0
    ? 'semantic-progress-region'
    : (explicitControls.length > 0 ? 'presentation-owned-control-hook' : (
      namedStepControls.length > 0 ? 'accessible-step-name' : null
    ));
  const directionalRegion = firstVisibleMatch(${JSON.stringify(STEP_CONTROL_REGION_SELECTORS)}, 'directional_region');
  const directionalCandidates = directionalRegion
    ? [...directionalRegion.querySelectorAll('${INTERACTIVE_SELECTOR}')]
    : allInteractive;
  const findDirectionalControls = (selectors, namePattern, role = null) => {
    for (const selector of selectors) {
      const explicit = [...scope.querySelectorAll(selector)].filter(visible);
      if (explicit.length > 0) {
        if (role) matchedSelectors[role] = selector;
        return inDomOrder(explicit);
      }
    }
    const named = inDomOrder(directionalCandidates.filter(
      (element) => namePattern.test(accessibleName(element)),
    ));
    if (role) matchedSelectors[role] = named.length > 0 ? 'accessible-directional-name' : null;
    return named;
  };
  ${modeReadingSource()}
  const readMode = () => modeReading().mode;
  // A presentation may expose one control that flips the mode, or a separate
  // control per mode. Picking the first visible match would click "Present
  // mode" when browse mode was required, so the mode being asked for takes
  // part in discovery. When it still cannot pick one control, it says so and
  // the caller raises a harness failure rather than judging the candidate on
  // an observation the harness never made.
  const modeToggle = (requiredMode) => {
    let candidates = [];
    for (const selector of ${JSON.stringify(MODE_TOGGLE_SELECTORS)}) {
      const matches = [...scope.querySelectorAll(selector)].filter(visible);
      if (matches.length > 0) {
        matchedSelectors.mode_toggle = selector;
        candidates = matches;
        break;
      }
    }
    if (candidates.length === 0) {
      candidates = allInteractive.filter(visible).filter(
        (element) => /\\b(present|presenter|browse|reading)\\b.*\\bmode\\b|\\bmode\\b.*\\b(present|presenter|browse|reading)\\b/i
          .test(accessibleName(element)),
      );
      matchedSelectors.mode_toggle = candidates.length > 0 ? 'accessible-mode-name' : null;
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const wanted = requiredMode === 'browse'
      ? /\\b(browse|browsing|reading|read)\\b/i
      : (requiredMode === 'present' ? /\\b(present|presenter|presenting|slideshow)\\b/i : null);
    const selected = wanted
      ? candidates.filter((element) => wanted.test(accessibleName(element)))
      : [];
    if (selected.length === 1) return selected[0];
    return 'ambiguous';
  };
`
}

export class BrowserDriverError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrowserDriverError'
    this.owner = 'evaluation-harness'
    this.code = 'browser-driver-failed'
    this.resumable = true
  }
}

function defaultCommand(args, input = '') {
  return spawnSync('chrome-devtools-axi', args, {
    encoding: 'utf8',
    input,
    maxBuffer: MAX_OUTPUT_BYTES,
  })
}

function failureMessage(result) {
  return result?.error?.message
    || result?.stderr?.trim()
    || result?.stdout?.trim()
    || `chrome-devtools-axi exited with status ${result?.status ?? 'unknown'}`
}

// chrome-devtools-axi builds do not agree on `page.wait`: in some of them every
// form of it fails and takes the rest of the script with it. Waiting through
// primitives every build provides keeps the driver independent of the adapter
// version, which the suite does not pin.
function sleepSource(ms) {
  return `await new Promise((resolve) => setTimeout(resolve, ${ms}));`
}

// A swipe travels this far across the presentation, in this many intermediate
// moves, with the page rendering at least one frame between consecutive touch
// events. A page that renders no frame within the timeout cannot be swiped the
// way a finger does, which is a limitation of the harness, not the candidate.
const SWIPE_DISTANCE = 200
const SWIPE_MOVES = 4
const SWIPE_FRAME_TIMEOUT_MS = 2000

function swipeTargetSource(sign) {
  return `const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)}) || document.body;
  const surface = presentation.querySelector(${JSON.stringify(STAGE_SELECTOR)}) || presentation;
  const rect = surface.getBoundingClientRect();
  // The finger lands inside the visible part of the surface even when the
  // surface is narrower than the swipe; the swipe then travels past its edge.
  const clamp = (value, low, high) => {
    const min = Math.max(low, 1);
    const max = Math.max(high - 1, min);
    return Math.min(Math.max(value, min), max);
  };
  const y = clamp(rect.top + rect.height / 2, rect.top, Math.min(rect.bottom, window.innerHeight));
  const startX = clamp(
    rect.left + rect.width / 2 - ${sign} * ${SWIPE_DISTANCE / 2},
    rect.left,
    Math.min(rect.right, window.innerWidth),
  );
  const hit = document.elementFromPoint(startX, y);
  const target = hit && presentation.contains(hit) ? hit : presentation;
  window.__andSceneSwipe = { target, startX, y };`
}

// A swipe that starts on a given element: the finger lands at the element's
// centre, so the element (or the part of it under the finger, such as a
// button's label) is the target, and the swipe travels its full distance from
// there. A probe asks this to see whether a gesture that starts on one of the
// presentation's own controls is mistaken for a navigation swipe. When the
// element is missing, nothing is dispatched and the event reports false.
function elementSwipeTargetSource(selector) {
  return `const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(startX, y);
  const target = hit && element.contains(hit) ? hit : element;
  window.__andSceneSwipe = { target, startX, y };`
}

function swipeStartSource(sign, selector) {
  return selector === null ? swipeTargetSource(sign) : elementSwipeTargetSource(selector)
}

// One touch event of a single-finger horizontal swipe, as a page callback.
// The finger lands on whatever element is under it at the vertical middle of
// the stage (or the presentation when it has no stage), just as a real touch
// targets the element it lands on, and every later event of the gesture keeps
// that target. Every event but the last asks the page for its next animation
// frame, which the driving script waits on before the next event. Every value
// is embedded at its use site: the callback must not read the driving script's
// scope.
function swipeEventSource(type, sign, progress, selector = null) {
  const begin = type === 'touchstart'
  const end = type === 'touchend'
  return `() => {
  ${begin ? swipeStartSource(sign, selector) : `const swipe = window.__andSceneSwipe;
  if (!swipe) return false;
  const { target, startX, y } = swipe;`}
  const touch = new Touch({
    identifier: 1,
    target,
    clientX: startX + ${sign * SWIPE_DISTANCE * progress},
    clientY: y,
    radiusX: 10,
    radiusY: 10,
    force: 1,
  });
  ${end ? 'delete window.__andSceneSwipe;' : ''}
  target.dispatchEvent(new TouchEvent(${JSON.stringify(type)}, {
    touches: ${end ? '[]' : '[touch]'},
    targetTouches: ${end ? '[]' : '[touch]'},
    changedTouches: [touch],
    bubbles: true,
    cancelable: true,
    composed: true,
  }));
  ${end ? '' : `const frame = { rendered: false };
  window.__andSceneSwipe.frame = frame;
  requestAnimationFrame(() => { frame.rendered = true; });`}
  return true;
}`
}

function pointerSwipeEventSource(type, sign, progress, selector = null) {
  const begin = type === 'pointerdown'
  const end = type === 'pointerup'
  return `() => {
  ${begin ? swipeStartSource(sign, selector) : `const swipe = window.__andSceneSwipe;
  if (!swipe) return false;
  const { target, startX, y } = swipe;`}
  target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: startX + ${sign * SWIPE_DISTANCE * progress},
    clientY: y,
    buttons: ${end ? 0 : 1},
    bubbles: true,
    cancelable: true,
    composed: true,
  }));
  ${end ? 'delete window.__andSceneSwipe;' : `const frame = { rendered: false };
  window.__andSceneSwipe.frame = frame;
  requestAnimationFrame(() => { frame.rendered = true; });`}
  return true;
}`
}

// Waits, from the driving script, until the page has rendered the frame the
// last touch event asked for. Polling a synchronous evaluation keeps the
// driver independent of whether an adapter build awaits a page promise.
function swipeFrameWaitSource() {
  return `{
  const deadline = Date.now() + ${SWIPE_FRAME_TIMEOUT_MS};
  while (!(await page.eval(() => Boolean(window.__andSceneSwipe?.frame?.rendered)))) {
    if (Date.now() >= deadline) {
      throw new Error('the page rendered no animation frame between swipe touch events');
    }
    ${sleepSource(5)}
  }
}`
}

// Modifiers a probe may hold while pressing a key, in the order a chord names
// them. chrome-devtools-axi presses "Alt+ArrowRight" as an Alt keydown, then
// an ArrowRight keydown with altKey set, then both keyups.
const PRESS_MODIFIERS = ['Alt', 'Control', 'Meta']
// Keydowns retained per document between reads; a probe reads after each press.
const MAX_KEYDOWN_RECORDS = 200
const KEY_INSTRUMENTATION_READ_TIMEOUT_MS = 2000

// Instruments the page's keydowns so a probe can tell whether the page
// prevented a key's default. The wrapper sits on KeyboardEvent.prototype, so a
// handler that stops propagation before any listener of ours runs still calls
// through it, and a capture listener on the window adds what the event itself
// reports once dispatch is over, which covers a page that cached Event's own
// preventDefault. Every keydown is recorded with its key, modifier flags,
// whether its default was prevented, and how many times the wrapper was
// called; the modifier's own keydown of a chord is recorded too.
//
// chrome-devtools-axi has no portable primitive that runs a script before a
// document's own scripts (no init script, and no navigation hook in every
// build), so this is installed into the loaded document, before the probe's
// first key press. A page whose scripts already replaced or wrapped
// preventDefault, or that registered a window capture listener calling
// stopImmediatePropagation and then a cached preventDefault, is out of reach.
//
// A pagehide marks the document as unloaded. A document that replaced it
// carries none of this state, which the driver reads as an unload too.
// Installing again, for example after a reload, starts a fresh record without
// wrapping the method twice.
function keyInstrumentationInstallSource(token) {
  return `() => {
  window.__andSceneKeys = { token: ${JSON.stringify(token)}, unloaded: false, keydowns: [] };
  if (!window.__andSceneKeysWired) {
    window.__andSceneKeysWired = true;
    const records = new WeakMap();
    const recordFor = (event) => {
      let record = records.get(event);
      if (!record) {
        record = {
          key: String(event.key),
          altKey: Boolean(event.altKey),
          ctrlKey: Boolean(event.ctrlKey),
          metaKey: Boolean(event.metaKey),
          shiftKey: Boolean(event.shiftKey),
          prevented: false,
          preventDefaultCalls: 0,
        };
        records.set(event, record);
        const state = window.__andSceneKeys;
        if (state && state.keydowns.length < ${MAX_KEYDOWN_RECORDS}) state.keydowns.push(record);
      }
      return record;
    };
    const original = KeyboardEvent.prototype.preventDefault;
    Object.defineProperty(KeyboardEvent.prototype, 'preventDefault', {
      configurable: true,
      writable: true,
      value: function preventDefault() {
        if (this && this.type === 'keydown') {
          const record = recordFor(this);
          record.prevented = true;
          record.preventDefaultCalls += 1;
        }
        return original.apply(this, arguments);
      },
    });
    window.addEventListener('keydown', (event) => {
      const record = recordFor(event);
      setTimeout(() => { if (event.defaultPrevented) record.prevented = true; });
    }, true);
    window.addEventListener('pagehide', () => {
      if (window.__andSceneKeys) window.__andSceneKeys.unloaded = true;
    });
  }
  return true;
}`
}

function keyInstrumentationReadSource(reset) {
  return `() => {
  const state = window.__andSceneKeys;
  const keydowns = state ? state.keydowns.map((record) => ({ ...record })) : [];
  if (state && ${reset}) state.keydowns = [];
  return { token: state ? state.token : null, unloaded: Boolean(state && state.unloaded),
    url: String(location.href), keydowns };
}`
}

function waitForSelectorSource(selector, timeout) {
  const probe = JSON.stringify(`!!document.querySelector(${JSON.stringify(selector)})`)
  return `{
  const deadline = Date.now() + ${timeout};
  for (;;) {
    if (await page.eval(${probe})) break;
    if (Date.now() >= deadline) throw new Error(${JSON.stringify(`timed out waiting for ${selector}`)});
    ${sleepSource(50)}
  }
}`
}

export function createAxiBrowserDriver({ baseUrl, command = defaultCommand } = {}) {
  const base = new URL(baseUrl)
  // The token of the keydown instrumentation last installed, which tells a
  // document that replaced the instrumented one from the instrumented one.
  let keyInstrumentationToken = null

  async function invoke(args, input = '') {
    const result = await command(args, input)
    if (result?.error || result?.status !== 0) {
      throw new BrowserDriverError(`browser adapter failed: ${failureMessage(result)}`)
    }
    return result.stdout ?? ''
  }

  async function run(script) {
    const output = (await invoke(['run'], script)).trim()
    if (!output) throw new BrowserDriverError('browser adapter returned no structured output')
    try {
      return JSON.parse(output.split('\n').at(-1))
    } catch (error) {
      throw new BrowserDriverError(`browser adapter returned invalid JSON: ${error.message}`)
    }
  }

  async function readFailures() {
    const output = await invoke(['console', '--type', 'error'])
    if (isBrowserInfrastructureDiagnostic(output)) {
      throw new BrowserDriverError(`browser adapter failed: ${output.trim()}`)
    }
    if (output.includes('<no console messages found>')) return []
    return output.split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('console:') && !line.startsWith('help['))
  }

  function routeUrl(route) {
    const relative = String(route ?? '').replace(/^\/+/, '')
    return new URL(relative, base).href
  }

  return {
    async replay(actions, expect) {
      if (!validReplay({ actions, expect })) throw new BrowserDriverError('invalid replay contract')
      // validReplay checks the path's shape; URL parsing can still turn a
      // shaped path into another host (it drops tabs and newlines). An escape
      // is a property of the proposed plan, not a harness fault.
      for (const action of actions) {
        if (action.type === 'navigate' && new URL(routeUrl(action.path)).origin !== base.origin) {
          throw new Error('replay navigation leaves the candidate origin')
        }
      }
      const observe = `page.eval(() => {
        ${modeReadingSource()}
        const progress = document.querySelector('[data-step-count]');
        const selected = ${JSON.stringify(expect.selector ?? null)};
        const node = selected ? document.querySelector(selected) : null;
        const visible = Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        const mode = modeReading();
        // What a reviewer needs to judge control and focus failures from the
        // replay itself: every visible interactive control and where focus is.
        const shown = (element) => element.getClientRects().length > 0
          && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
        const nameOf = (element) => (element?.getAttribute('aria-label')
          || element?.getAttribute('title') || element?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
        const controls = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})].filter(shown).slice(0, 32)
          .map((element) => ({ name: nameOf(element),
            current: element.getAttribute('aria-current') || null,
            disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
            focusable: !element.disabled && element.tabIndex >= 0 }));
        const active = document.activeElement;
        const focused = active && active !== document.body ? nameOf(active) || active.tagName.toLowerCase() : null;
        return { stepIndex: Number(progress?.getAttribute('data-step-index')),
          stepCount: Number(progress?.getAttribute('data-step-count')),
          mode: mode.mode, modeBasis: mode.basis, visible, text: (node?.textContent ?? '').slice(0, 1000),
          controls, focused, origin: location.origin };
      })`
      const actionSource = (action) => {
        switch (action.type) {
          case 'navigate': return `await page.open(${JSON.stringify(routeUrl(action.path))});`
          // A missing click target is what the candidate page did, so it ends
          // the replay as product evidence instead of failing the adapter.
          case 'click': return `if (!(await page.eval(() => {
            const node = document.querySelector(${JSON.stringify(action.selector)});
            if (!node) return false;
            node.click(); return true;
          }))) { productFailure = 'replay click target was not found'; break replay; }`
          case 'press': return `await page.press(${JSON.stringify(action.key)});`
          case 'keys': return `await page.type(${JSON.stringify(action.text)});`
          case 'wait': return sleepSource(action.ms)
          case 'swipe': {
            const sign = action.direction === 'left' ? -1 : 1
            const source = action.input === 'pointer' ? pointerSwipeEventSource : swipeEventSource
            const names = action.input === 'pointer'
              ? ['pointerdown', 'pointermove', 'pointerup'] : ['touchstart', 'touchmove', 'touchend']
            const phases = [source(names[0], sign, 0),
              ...Array.from({ length: SWIPE_MOVES }, (_, index) =>
                source(names[1], sign, (index + 1) / (SWIPE_MOVES + 1))), source(names[2], sign, 1)]
            return phases.map((phase) => `await page.eval(${phase});`).join(`\n${swipeFrameWaitSource()}\n`)
          }
        }
      }
      const script = `await page.open(${JSON.stringify(base.href)});
const observations = [await ${observe}];
const trace = [];
let productFailure = null;
replay: {
${actions.map((action) => `${actionSource(action)}\n${sleepSource(50)}\ntrace.push(${JSON.stringify(action)}); observations.push(await ${observe});`).join('\n')}
}
console.log(JSON.stringify({ observations, trace, product_failure: productFailure }));`
      const result = await run(script)
      const productFailure = typeof result?.product_failure === 'string' && result.product_failure
        ? result.product_failure : null
      if (!Array.isArray(result?.observations) || (productFailure
        ? result.observations.length < 1 || result.observations.length > actions.length
        : result.observations.length !== actions.length + 1)) {
        throw new BrowserDriverError('browser replay returned invalid observations')
      }
      // Runtime and console failures are read exactly as probes read them, so a
      // replay cannot confirm clean rendering that the console contradicts.
      const errors = await readFailures()
      const left = result.observations.some((entry) => entry?.origin && entry.origin !== base.origin)
      if (productFailure || left) {
        return { passed: false, product_failure: productFailure ?? 'replay left the candidate origin',
          observations: result.observations, trace: result.trace ?? [], errors }
      }
      // The root landing page may have no presentation. Compare changes with
      // the first observation after navigating to the proposed demo route.
      const first = result.observations[1]
      const last = result.observations.at(-1)
      const passed = {
        'step-index-equals': () => last.stepIndex === expect.value,
        'step-index-changes': () => Number.isInteger(first.stepIndex)
          && Number.isInteger(last.stepIndex) && last.stepIndex !== first.stepIndex,
        'step-count-changes': () => Number.isInteger(first.stepCount)
          && Number.isInteger(last.stepCount) && last.stepCount !== first.stepCount,
        'mode-equals': () => last.modeBasis === 'declared' && last.mode === expect.value,
        'selector-visible': () => last.visible === true,
        'selector-hidden': () => first.visible === true && last.visible === false,
        'text-present': () => last.visible === true && last.text.includes(expect.text),
      }[expect.type]()
      return { passed, observations: result.observations, trace: result.trace, errors }
    },
    async resize(width, height) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new BrowserDriverError(`invalid viewport size: ${width}×${height}`)
      }
      await invoke(['resize', String(width), String(height)])
      return { width, height }
    },

    async routes() {
      const routes = await run(`
await page.open(${JSON.stringify(base.href)});
${sleepSource(50)}
const routes = await page.eval(() => [...document.querySelectorAll('a[href]')]
  .map((link) => new URL(link.href, location.href))
  .filter((url) => url.origin === location.origin)
  .map((url) => url.pathname.replace(/^\\//, ''))
  .filter(Boolean));
console.log(JSON.stringify([...new Set(routes)]));
`)
      if (!Array.isArray(routes) || routes.some((route) => typeof route !== 'string')) {
        throw new BrowserDriverError('browser adapter returned an invalid route list')
      }
      return routes
    },

    async open(route) {
      await invoke(['resize', '1280', '720'])
      return run(`
const opened = await page.open(${JSON.stringify(routeUrl(route))});
${waitForSelectorSource('[data-step-count]', 30000)}
const initialMode = await page.eval(() => {
  ${modeReadingSource()}
  return modeReading().mode;
});
const progress = await page.eval(() => document.querySelector('[data-step-count]')?.getAttribute('data-step-index'));
console.log(JSON.stringify({
  ...opened,
  initialMode,
  initialPosition: Number(progress),
}));
`)
    },

    async setMode(requiredMode) {
      if (!['present', 'browse'].includes(requiredMode)) {
        throw new BrowserDriverError(`unsupported presentation mode: ${requiredMode}`)
      }
      return run(`
const requiredMode = ${JSON.stringify(requiredMode)};
const mode = await page.eval(() => {
  ${modeReadingSource()}
  return modeReading().mode;
});
if (mode !== requiredMode) {
  const outcome = await page.eval(() => {
    const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
    const toggle = modeToggle(${JSON.stringify(requiredMode)});
    if (toggle === 'ambiguous') return 'ambiguous';
    if (!toggle) return 'none';
    toggle.click();
    return 'control';
  });
  if (outcome === 'ambiguous') {
    throw new Error(
      'ambiguous presentation mode control: no single visible control selects '
        + ${JSON.stringify(requiredMode)} + ' mode',
    );
  }
  const usedControl = outcome === 'control';
  if (!usedControl) await page.press('p');
  ${sleepSource(100)}
}
console.log(JSON.stringify(true));
`)
    },

    async setPosition(requiredPosition) {
      if (!Number.isInteger(requiredPosition) || requiredPosition < 0) {
        throw new BrowserDriverError(`invalid presentation position: ${requiredPosition}`)
      }
      return run(`
const readPosition = () => page.eval(() => Number(
  document.querySelector('[data-step-count]')?.getAttribute('data-step-index'),
));
const positionedByControl = await page.eval(() => {
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
  const target = controls[${requiredPosition}];
  if (!target) return false;
  target.click();
  return true;
});
if (positionedByControl) ${sleepSource(100)}
let observedPosition = await readPosition();
if (observedPosition !== ${requiredPosition}) {
  const stepCount = await page.eval(() => Number(
    document.querySelector('[data-step-count]')?.getAttribute('data-step-count'),
  ));
  if (!Number.isInteger(stepCount) || stepCount < 1) {
    throw new Error('presentation step count was not found');
  }
  for (let index = 0; index < stepCount; index += 1) {
    await page.press('ArrowLeft');
    ${sleepSource(100)}
  }
  for (let index = 0; index < ${requiredPosition}; index += 1) {
    await page.press('ArrowRight');
    ${sleepSource(100)}
  }
  observedPosition = await readPosition();
}
if (observedPosition !== ${requiredPosition}) {
  throw new Error(
    'required navigation position was not established: expected '
      + ${requiredPosition} + ', observed ' + observedPosition,
  );
}
console.log(JSON.stringify(true));
`)
    },

    async settle() {
      return run(`
const readSettledState = () => page.eval(() => {
  const nodes = [...document.querySelectorAll(
    ${JSON.stringify(
      '[data-step-count], [data-presentation-stage], [data-presentation-node], '
      + '[data-presentation-chrome], [data-layout-id], [data-scene-entity], [data-node]',
    )},
  )];
  const animations = [...new Set(nodes.flatMap(
    (node) => node.getAnimations({ subtree: true }),
  ))].filter((animation) => (
    animation.playState === 'running'
      && animation.effect?.getComputedTiming().iterations !== Infinity
  )).length;
  const signature = JSON.stringify(nodes.map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [
      element.getAttribute('data-step-index'),
      element.getAttribute('data-layout-id'),
      element.getAttribute('data-scene-entity'),
      element.getAttribute('data-node'),
      Math.round(rect.x * 10) / 10,
      Math.round(rect.y * 10) / 10,
      Math.round(rect.width * 10) / 10,
      Math.round(rect.height * 10) / 10,
      style.opacity,
      style.transform,
      element.textContent?.trim(),
    ];
  }));
  return { animations, signature };
});
let previous = null;
let stableReads = 0;
for (let attempt = 0; attempt < 50; attempt += 1) {
  const state = await readSettledState();
  stableReads = state.animations === 0 && state.signature === previous
    ? stableReads + 1
    : 0;
  if (stableReads >= 2) {
    console.log(JSON.stringify({
      settled: true,
      strategy: 'animation-idle-and-three-stable-state-reads',
      observations: attempt + 1,
    }));
    break;
  }
  previous = state.signature;
  ${sleepSource(100)}
  if (attempt === 49) throw new Error('timed out waiting for a settled browser state');
}
`)
    },

    async canvasGeometry() {
      return run(`
const geometry = await page.eval(() => {
  const canvas = document.querySelector(${JSON.stringify(CANVAS_SELECTOR)})
    || document.querySelector(${JSON.stringify(STAGE_SELECTOR)});
  if (!canvas) throw new Error('presentation canvas or stage was not found');
  const rendered = canvas.getBoundingClientRect();
  const authored = { width: canvas.offsetWidth, height: canvas.offsetHeight };
  let available = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  for (let ancestor = canvas.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    const rect = ancestor.getBoundingClientRect();
    if (/^(?:auto|scroll|hidden|clip)$/.test(style.overflowX)) {
      available.left = Math.max(available.left, rect.left);
      available.right = Math.min(available.right, rect.right);
    }
    if (/^(?:auto|scroll|hidden|clip)$/.test(style.overflowY)) {
      available.top = Math.max(available.top, rect.top);
      available.bottom = Math.min(available.bottom, rect.bottom);
    }
  }
  const value = (number) => Math.round(number * 1000) / 1000;
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    authored,
    rendered: {
      left: value(rendered.left),
      top: value(rendered.top),
      right: value(rendered.right),
      bottom: value(rendered.bottom),
      width: value(rendered.width),
      height: value(rendered.height),
    },
    available: {
      left: value(available.left),
      top: value(available.top),
      right: value(available.right),
      bottom: value(available.bottom),
      width: value(Math.max(0, available.right - available.left)),
      height: value(Math.max(0, available.bottom - available.top)),
    },
    // Raw ratios: rounding here to 0.001 lets a pair whose raw difference
    // exceeds the absolute SCALE_TOLERANCE round into agreement.
    scale: {
      x: authored.width > 0 ? rendered.width / authored.width : null,
      y: authored.height > 0 ? rendered.height / authored.height : null,
    },
  };
});
console.log(JSON.stringify(geometry));
`)
    },

    async state({ presenceOf = [] } = {}) {
      const captured = await run(`
const captured = await page.eval(() => {
  const progress = document.querySelector('[data-step-count]');
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
  const currentMode = modeReading();
  const title = firstVisibleMatch(${JSON.stringify(TITLE_SELECTORS)}, 'title');
  const titleBasis = !title ? 'none'
    : (${JSON.stringify(DECLARED_TITLE_SELECTORS)}.includes(matchedSelectors.title) ? 'declared' : 'heuristic');
  // Which element a presentation uses for the deck title and which for the
  // active step title is its own choice, so report every visible title-bearing
  // text and let the probe ask whether the step title is exposed at all.
  // A title element may also carry the step's marker in a nested element, as in
  // "<p>01 <span>…</span></p>" or "<p><span>01</span> You have a topic</p>".
  // The fixture treats the marker and the title as separate things, so the
  // element's own text, apart from its nested elements, is reported as well.
  const ownText = (element) => [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join('')
    .replace(/\\s+/g, ' ')
    .trim();
  // Each distinct visible element is counted once per text it exposes, so a
  // persistent list of every title or caption, which exposes each text equally
  // at every step, can be told apart from the active step's own element.
  // Every text is counted, so a verbose deck cannot push the active title out
  // of view. What is returned stays bounded: the shortest texts are kept, since
  // a normative title or caption is short, and implausibly long ones are skipped.
  const MAX_EXPOSED_TEXTS = 1000;
  const MAX_EXPOSED_TEXT_CHARS = 2000;
  const exposedTexts = (selectors, textsOf) => {
    const occurrences = new Map();
    const elements = [...new Set(selectors.flatMap((selector) => [...scope.querySelectorAll(selector)]))]
      .filter(visible);
    for (const element of elements) {
      for (const text of new Set(textsOf(element).filter(Boolean))) {
        if (text.length > MAX_EXPOSED_TEXT_CHARS) continue;
        occurrences.set(text, (occurrences.get(text) || 0) + 1);
      }
    }
    const kept = [...occurrences.entries()]
      .sort((left, right) => left[0].length - right[0].length)
      .slice(0, MAX_EXPOSED_TEXTS);
    return { texts: [...occurrences.keys()].slice(0, 24), occurrences: Object.fromEntries(kept) };
  };
  const titleExposure = exposedTexts(
    ${JSON.stringify(TITLE_TEXT_SELECTORS)},
    (element) => [element.textContent?.trim() || '', ownText(element)],
  );
  const titleTexts = titleExposure.texts;
  const titleOccurrences = titleExposure.occurrences;
  const caption = firstVisibleMatch(${JSON.stringify(CAPTION_SELECTORS)}, 'caption');
  const captionBasis = !caption ? 'none'
    : (${JSON.stringify(DECLARED_CAPTION_SELECTORS)}.includes(matchedSelectors.caption) ? 'declared' : 'heuristic');
  // The same holds for captions: which caption-bearing element comes first is
  // the presentation's choice, so every visible one is reported.
  const captionExposure = exposedTexts(
    ${JSON.stringify(CAPTION_SELECTORS)},
    (element) => [element.textContent?.trim() || ''],
  );
  const captionTexts = captionExposure.texts;
  const captionOccurrences = captionExposure.occurrences;
  const toc = firstVisibleMatch(${JSON.stringify(TOC_SELECTORS)}, 'toc');
  const progressChrome = firstVisibleMatch(${JSON.stringify(PROGRESS_SELECTORS)}, 'progress_chrome');
  const previousMatches = findDirectionalControls(${JSON.stringify(PREVIOUS_SELECTORS)}, /^(previous|prev|back)\\b/i, 'previous');
  const nextMatches = findDirectionalControls(${JSON.stringify(NEXT_SELECTORS)}, /^next\\b/i, 'next');
  modeToggle(null);
  const previous = previousMatches[0] || null;
  const next = nextMatches[0] || null;
  const navigationAmbiguities = [
    ...(previousMatches.length > 1 ? ['multiple visible previous controls'] : []),
    ...(nextMatches.length > 1 ? ['multiple visible next controls'] : []),
  ];
  const textPresence = {};
  const normalize = (value) => String(value || '').normalize('NFKC')
    .replace(/[\\u2018-\\u201b\\u2032]/g, "'")
    .replace(/[\\u201c-\\u201f\\u2033]/g, '"')
    .replace(/[\\u2010-\\u2015\\u2212]/g, '-')
    .replace(/\\u2026/g, '...').replace(/\\s+/g, ' ').trim();
  try {
    const elements = [...scope.querySelectorAll('*')];
    const complete = elements.length <= 20000;
    const walked = elements.slice(0, 20000);
    for (const expected of ${JSON.stringify(presenceOf)}) {
      const needle = normalize(expected);
      let visibleElements = 0;
      let accessibleNames = 0;
      for (const element of walked) {
        if (visible(element) && normalize(element.innerText).includes(needle)
          && ![...element.children].some((child) => visible(child) && normalize(child.innerText).includes(needle))) {
          visibleElements += 1;
        }
        if (!visible(element)) continue;
        const ids = (element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
        const name = ids.length ? ids.map((id) => document.getElementById(id)?.textContent || '').join(' ')
          : (element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || '');
        if (normalize(name).includes(needle)) accessibleNames += 1;
      }
      textPresence[expected] = { visibleElements, accessibleNames, complete };
    }
  } catch {
    for (const expected of ${JSON.stringify(presenceOf)}) {
      textPresence[expected] = { visibleElements: 0, accessibleNames: 0, complete: false };
    }
  }
  const controlStates = controls.map((control) => ({
    name: accessibleName(control),
    role: control.getAttribute('role') || control.tagName.toLowerCase(),
    ariaCurrent: ['step', 'true'].includes(control.getAttribute('aria-current')),
    disabled: control.disabled === true || control.getAttribute('aria-disabled') === 'true',
    focusable: !control.disabled && control.tabIndex >= 0,
  }));
  const entityOccurrences = new Map();
  const entitySelectors = [
    '[data-layout-id]',
    '[data-scene-entity]',
    '[data-node]',
    '[data-entity-id]',
    '[data-scene-node]',
    '[data-presentation-node]',
    '[data-presentation-box]',
    '[data-presentation-label]',
    '[data-presentation-arrow]',
    '[data-presentation-frame]',
    '[data-presentation-emphasis]',
    '[data-presentation-symbol-chip]',
  ];
  const entityIds = [...document.querySelectorAll(
    ${JSON.stringify(STAGE_SELECTOR)}
      .split(', ')
      .flatMap((stage) => entitySelectors.map((entity) => stage + ' ' + entity))
      .join(', '),
  )]
    .map((element) => {
      const explicit = element.getAttribute('data-layout-id')
        || element.getAttribute('data-scene-entity')
        || element.getAttribute('data-node')
        || element.getAttribute('data-entity-id')
        || element.getAttribute('data-scene-node');
      if (explicit) return explicit;
      const hook = element.getAttributeNames()
        .find((name) => name.startsWith('data-presentation-'));
      const className = typeof element.className === 'string'
        ? element.className
        : element.getAttribute('class');
      const base = [
        hook || element.tagName.toLowerCase(),
        hook ? element.getAttribute(hook) : '',
        className || '',
      ].join(':');
      const occurrence = entityOccurrences.get(base) || 0;
      entityOccurrences.set(base, occurrence + 1);
      return base + ':' + occurrence;
    })
    .filter(Boolean);
  const declaredSceneId = () => {
    for (const selector of ${JSON.stringify(SCENE_ID_SELECTORS)}) {
      const attribute = selector.slice(1, -1);
      for (const element of [presentation, ...scope.querySelectorAll(selector)]) {
        const value = element?.getAttribute(attribute)?.trim();
        if (value && !['true', 'false'].includes(value.toLowerCase())) return value;
      }
    }
    return null;
  };
  const focused = accessibleName(document.activeElement) || null;
  return {
    stepIndex: Number(progress?.getAttribute('data-step-index')),
    stepCount: Number(progress?.getAttribute('data-step-count')),
    title: title?.textContent?.trim() || '',
    titleTexts,
    titleOccurrences,
    caption: caption?.textContent?.trim() || '',
    captionTexts,
    captionOccurrences,
    sceneId: declaredSceneId(),
    entityIds,
    entityConventions: entitySelectors,
    titleProminent: visible(title),
    mode: currentMode.mode,
    modeBasis: currentMode.basis,
    titleBasis,
    captionBasis,
    textPresence,
    captionVisible: visible(caption) && Boolean(caption?.textContent?.trim()),
    tocVisible: visible(toc),
    progressVisible: visible(progressChrome),
    previousVisible: visible(previous),
    nextVisible: visible(next),
    controls: controlStates,
    focused,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    matchedSelectors,
    navigationAmbiguities,
  };
});
console.log(JSON.stringify(captured));
`)
      if (captured?.navigationAmbiguities?.length > 0) {
        throw new BrowserDriverError(
          `ambiguous semantic navigation: ${captured.navigationAmbiguities.join('; ')}`,
        )
      }
      return captured
    },

    // Presses a key, optionally while holding any of Alt, Control, and Meta.
    async press(key, { modifiers = [] } = {}) {
      if (!Array.isArray(modifiers) || new Set(modifiers).size !== modifiers.length
        || modifiers.some((modifier) => !PRESS_MODIFIERS.includes(modifier))) {
        throw new BrowserDriverError(`unsupported key modifiers: ${JSON.stringify(modifiers)}`)
      }
      const chord = [...PRESS_MODIFIERS.filter((modifier) => modifiers.includes(modifier)), key].join('+')
      await run(`await page.press(${JSON.stringify(chord)}); console.log(JSON.stringify(true));`)
    },

    async installKeyInstrumentation() {
      const token = randomUUID()
      const installed = await run(`
const installed = await page.eval(${keyInstrumentationInstallSource(token)});
console.log(JSON.stringify(installed));
`)
      if (installed !== true) throw new BrowserDriverError('keydown instrumentation was not installed')
      keyInstrumentationToken = token
      return { installed: true }
    },

    // Reads the keydowns recorded since the last reset, and whether the
    // instrumented document unloaded. A press that navigates may still be
    // replacing the document, so a read that the navigation interrupts retries.
    async readKeyInstrumentation({ reset = false } = {}) {
      const read = await run(`
const deadline = Date.now() + ${KEY_INSTRUMENTATION_READ_TIMEOUT_MS};
let read = null;
for (;;) {
  try {
    read = await page.eval(${keyInstrumentationReadSource(reset === true)});
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw error;
    ${sleepSource(50)}
  }
}
console.log(JSON.stringify(read));
`)
      if (!read || !Array.isArray(read.keydowns)) {
        throw new BrowserDriverError('keydown instrumentation returned an invalid reading')
      }
      const installed = keyInstrumentationToken !== null && read.token === keyInstrumentationToken
      return {
        installed,
        unloaded: keyInstrumentationToken !== null && (!installed || read.unloaded === true),
        url: read.url,
        keydowns: read.keydowns,
      }
    },

    async releaseFocus() {
      return run(`
const released = await page.eval(() => {
  const root = ${focusRootSource()};
  if (root.tabIndex < 0 && !root.hasAttribute('tabindex')) {
    root.setAttribute('tabindex', '-1');
    root.__andSceneTemporaryTabindex = true;
  }
  root.focus();
  const active = document.activeElement;
  const interactiveTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
  const interactiveRoles = new Set([
    'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox', 'slider',
    'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
  ]);
  return active === root
    && !interactiveTags.has(active.tagName.toLowerCase())
    && !interactiveRoles.has(active.getAttribute('role'));
});
console.log(JSON.stringify(released));
`)
    },

    async restoreFocusTarget() {
      await run(`
await page.eval(() => {
  const root = ${focusRootSource()};
  if (root.__andSceneTemporaryTabindex) {
    root.removeAttribute('tabindex');
    delete root.__andSceneTemporaryTabindex;
  }
});
console.log(JSON.stringify(true));
`)
    },

    async activate(name) {
      await run(`
const activated = await page.eval(() => {
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
  const target = controls.find((element) => accessibleName(element) === ${JSON.stringify(name)});
  if (!target) return false;
  // A pointer activation focuses the control before it fires. Reproducing that
  // is what lets a probe observe a presentation that suppresses deck keys
  // while one of its own controls holds focus.
  target.focus();
  target.click();
  return true;
});
if (!activated) throw new Error('navigation control was not found');
${sleepSource(100)}
console.log(JSON.stringify(true));
`)
    },

    // Activating the discovered Previous or Next control, so a probe can
    // traverse a presentation the way a reader does instead of inferring
    // reachability from a control merely being visible. Returns false when no
    // control for that direction is discoverable, which a boundary design may
    // legitimately produce.
    async activateDirection(direction) {
      if (!['previous', 'next'].includes(direction)) {
        throw new BrowserDriverError(`unsupported navigation direction: ${direction}`)
      }
      const selectors = direction === 'next' ? NEXT_SELECTORS : PREVIOUS_SELECTORS
      const pattern = direction === 'next' ? '/^next\\b/i' : '/^(previous|prev|back)\\b/i'
      const outcome = await run(`
const outcome = await page.eval(() => {
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
  const matches = findDirectionalControls(${JSON.stringify(selectors)}, ${pattern});
  if (matches.length > 1) return 'ambiguous';
  const target = matches[0];
  if (!target) return 'none';
  // A pointer activation focuses the control before it fires.
  target.focus();
  target.click();
  return 'activated';
});
if (outcome === 'ambiguous') {
  throw new Error(
    'ambiguous semantic navigation: multiple visible ' + ${JSON.stringify(direction)} + ' controls',
  );
}
${sleepSource(100)}
console.log(JSON.stringify(outcome === 'activated'));
`)
      return outcome === true
    },

    async focus(name) {
      await run(`
const focused = await page.eval(() => {
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
  const target = controls.find((element) => accessibleName(element) === ${JSON.stringify(name)});
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
});
if (!focused) throw new Error('navigation control could not be focused');
console.log(JSON.stringify(true));
`)
    },

    // A finger's swipe spans many frames, so a page sees its touchstart, then
    // its touchmoves, then its touchend, each in its own task. A presentation
    // that records the touch start in state committed after a render, as
    // React's setState does, only sees it when the probe yields between them.
    //
    // With a selector, the swipe starts at the centre of the matched element
    // instead of the stage, over the same distance, path, and pacing. It
    // returns false, having dispatched nothing, when no element matches.
    async swipe(direction, { input = 'touch', selector = null } = {}) {
      if (!['left', 'right'].includes(direction)) {
        throw new BrowserDriverError(`unsupported swipe direction: ${direction}`)
      }
      if (!['touch', 'pointer'].includes(input)) {
        throw new BrowserDriverError(`unsupported swipe input: ${input}`)
      }
      if (selector !== null && (typeof selector !== 'string' || !selector.trim())) {
        throw new BrowserDriverError(`invalid swipe start selector: ${selector}`)
      }
      const sign = direction === 'left' ? -1 : 1
      const eventSource = input === 'pointer' ? pointerSwipeEventSource : swipeEventSource
      const names = input === 'pointer'
        ? ['pointerdown', 'pointermove', 'pointerup']
        : ['touchstart', 'touchmove', 'touchend']
      const phases = [
        eventSource(names[0], sign, 0, selector),
        ...Array.from({ length: SWIPE_MOVES }, (_, move) => (
          eventSource(names[1], sign, (move + 1) / (SWIPE_MOVES + 1))
        )),
        eventSource(names[2], sign, 1),
      ]
      // A gesture that never started asked for no frame, so the script stops
      // rather than waiting on one.
      const dispatched = await run(`
let dispatched = true;
swipe: {
${phases.map((phase) => `dispatched = (await page.eval(${phase})) && dispatched;
if (!dispatched) break swipe;`).join(`\n${swipeFrameWaitSource()}\n`)}
}
${sleepSource(100)}
console.log(JSON.stringify(dispatched));
`)
      return dispatched === true
    },

    // A presentation owns its own mode affordance. Reach for the key only when
    // no mode control is discoverable, rather than requiring one keybinding.
    async toggleMode() {
      await run(`
const outcome = await page.eval(() => {
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
  const toggle = modeToggle(readMode() === 'present' ? 'browse' : 'present');
  if (toggle === 'ambiguous') return 'ambiguous';
  if (!toggle) return 'none';
  toggle.click();
  return 'control';
});
if (outcome === 'ambiguous') {
  throw new Error('ambiguous presentation mode control: no single visible control selects the opposite mode');
}
const usedControl = outcome === 'control';
if (!usedControl) await page.press('p');
${sleepSource(50)}
console.log(JSON.stringify(usedControl));
`)
    },

    failures: readFailures,
  }
}
