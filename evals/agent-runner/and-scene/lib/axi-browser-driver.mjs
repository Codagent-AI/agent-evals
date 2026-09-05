// Production browser adapter for deterministic evaluation.
//
// chrome-devtools-axi owns Chromium and exposes a small script API. This
// adapter translates that API into the deliberately tiny driver consumed by
// browser-eval.mjs, keeping browser mechanics out of scoring logic.
import { spawnSync } from 'node:child_process'

import { isBrowserInfrastructureDiagnostic } from './browser-diagnostics.mjs'

const MAX_OUTPUT_BYTES = 1024 * 1024
const PRESENTATION_SELECTOR = '[data-presentation], [data-presentation-root]'
const MODE_SELECTOR = '[data-presentation-mode]'
const STAGE_SELECTOR = [
  '[data-presentation-stage]',
  '[data-presentation-chrome="stage"]',
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
const CAPTION_SELECTORS = [
  '[data-presentation-caption]',
  '[data-presentation-node="caption"]',
  'figcaption',
  "[aria-label*='caption' i]",
  '[data-presentation-footer] p',
]
const CAPTION_SELECTOR = CAPTION_SELECTORS.join(', ')
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
  '[data-presentation-button="previous"]',
  '[data-presentation-node="previous"]',
]
const NEXT_SELECTORS = [
  '[data-presentation-next]',
  '[data-presentation-button="next"]',
  '[data-presentation-node="next"]',
]

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
  const firstVisibleMatch = (selectors) => {
    for (const selector of selectors) {
      const match = [...scope.querySelectorAll(selector)].find(visible);
      if (match) return match;
    }
    return null;
  };
  const allInteractive = [...scope.querySelectorAll('${INTERACTIVE_SELECTOR}')];
  const inDomOrder = (elements) => [...new Set(elements)]
    .filter(visible)
    .sort((left, right) => (
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    ));
  const explicitControls = inDomOrder([
    ...scope.querySelectorAll(${JSON.stringify(EXPLICIT_CONTROL_SELECTOR)}),
  ]);
  const progressRegion = firstVisibleMatch(${JSON.stringify(PROGRESS_SELECTORS)});
  const semanticControls = progressRegion
    ? inDomOrder([...progressRegion.querySelectorAll('${INTERACTIVE_SELECTOR}')])
    : [];
  const namedStepControls = inDomOrder(allInteractive.filter((element) => (
    /^(?:(?:go to|jump to)\\s+)?step\\s+\\d+(?::|$)/i.test(accessibleName(element))
  )));
  const controls = semanticControls.length > 0
    ? semanticControls
    : (explicitControls.length > 0 ? explicitControls : namedStepControls);
  const directionalRegion = firstVisibleMatch(${JSON.stringify(STEP_CONTROL_REGION_SELECTORS)});
  const directionalCandidates = directionalRegion
    ? [...directionalRegion.querySelectorAll('${INTERACTIVE_SELECTOR}')]
    : allInteractive;
  const findDirectionalControls = (selectors, namePattern) => {
    for (const selector of selectors) {
      const explicit = [...scope.querySelectorAll(selector)].filter(visible);
      if (explicit.length > 0) return inDomOrder(explicit);
    }
    return inDomOrder(directionalCandidates.filter(
      (element) => namePattern.test(accessibleName(element)),
    ));
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

export function createAxiBrowserDriver({ baseUrl, command = defaultCommand } = {}) {
  const base = new URL(baseUrl)

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

  function routeUrl(route) {
    const relative = String(route ?? '').replace(/^\/+/, '')
    return new URL(relative, base).href
  }

  return {
    async routes() {
      const routes = await run(`
await page.open(${JSON.stringify(base.href)});
await page.wait(50);
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
await page.wait('[data-step-count]', 30000);
const initialMode = await page.eval(() => {
  const explicit = document.querySelector(${JSON.stringify(MODE_SELECTOR)})
    ?.getAttribute('data-presentation-mode');
  if (explicit === 'present' || explicit === 'browse') return explicit;
  const browsing = [...document.querySelectorAll(${JSON.stringify(`${CAPTION_SELECTOR}, ${TOC_SELECTOR}`)})]
    .some((element) => element.getClientRects().length > 0
      && getComputedStyle(element).display !== 'none'
      && getComputedStyle(element).visibility !== 'hidden');
  return browsing ? 'browse' : 'present';
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
  const explicit = document.querySelector(${JSON.stringify(MODE_SELECTOR)})
    ?.getAttribute('data-presentation-mode');
  if (explicit === 'present' || explicit === 'browse') return explicit;
  const visible = (element) => Boolean(element && element.getClientRects().length > 0
    && getComputedStyle(element).display !== 'none'
    && getComputedStyle(element).visibility !== 'hidden');
  const browsing = [...document.querySelectorAll(${JSON.stringify(`${CAPTION_SELECTOR}, ${TOC_SELECTOR}`)})]
    .some(visible);
  return browsing ? 'browse' : 'present';
});
if (mode !== requiredMode) {
  await page.press('p');
  await page.wait(100);
}
console.log(JSON.stringify(true));
`)
    },

    async setPosition(requiredPosition) {
      if (!Number.isInteger(requiredPosition) || requiredPosition < 0) {
        throw new BrowserDriverError(`invalid presentation position: ${requiredPosition}`)
      }
      return run(`
const requiredPosition = ${requiredPosition};
const readPosition = () => page.eval(() => Number(
  document.querySelector('[data-step-count]')?.getAttribute('data-step-index'),
));
const positionedByControl = await page.eval(() => {
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
  const target = controls[requiredPosition];
  if (!target) return false;
  target.click();
  return true;
});
if (positionedByControl) await page.wait(100);
let observedPosition = await readPosition();
if (observedPosition !== requiredPosition) {
  const stepCount = await page.eval(() => Number(
    document.querySelector('[data-step-count]')?.getAttribute('data-step-count'),
  ));
  if (!Number.isInteger(stepCount) || stepCount < 1) {
    throw new Error('presentation step count was not found');
  }
  for (let index = 0; index < stepCount; index += 1) {
    await page.press('ArrowLeft');
    await page.wait(100);
  }
  for (let index = 0; index < requiredPosition; index += 1) {
    await page.press('ArrowRight');
    await page.wait(100);
  }
  observedPosition = await readPosition();
}
if (observedPosition !== requiredPosition) {
  throw new Error(
    'required navigation position was not established: expected '
      + requiredPosition + ', observed ' + observedPosition,
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
  await page.wait(100);
  if (attempt === 49) throw new Error('timed out waiting for a settled browser state');
}
`)
    },

    async state() {
      const captured = await run(`
const captured = await page.eval(() => {
  const progress = document.querySelector('[data-step-count]');
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
  const explicitMode = document.querySelector(${JSON.stringify(MODE_SELECTOR)})
    ?.getAttribute('data-presentation-mode');
${navigationDiscoverySource()}
  const title = firstVisibleMatch(${JSON.stringify(TITLE_SELECTORS)});
  const caption = firstVisibleMatch(${JSON.stringify(CAPTION_SELECTORS)});
  const toc = firstVisibleMatch(${JSON.stringify(TOC_SELECTORS)});
  const progressChrome = firstVisibleMatch(${JSON.stringify(PROGRESS_SELECTORS)});
  const previousMatches = findDirectionalControls(${JSON.stringify(PREVIOUS_SELECTORS)}, /^(previous|prev|back)\\b/i);
  const nextMatches = findDirectionalControls(${JSON.stringify(NEXT_SELECTORS)}, /^next\\b/i);
  const previous = previousMatches[0] || null;
  const next = nextMatches[0] || null;
  const navigationAmbiguities = [
    ...(previousMatches.length > 1 ? ['multiple visible previous controls'] : []),
    ...(nextMatches.length > 1 ? ['multiple visible next controls'] : []),
  ];
  const browsing = visible(caption) || visible(toc);
  const controlStates = controls.map((control) => ({
    name: accessibleName(control),
    role: control.getAttribute('role') || control.tagName.toLowerCase(),
    ariaCurrent: control.getAttribute('aria-current') === 'step',
    focusable: !control.disabled && control.tabIndex >= 0,
  }));
  const entityOccurrences = new Map();
  const entitySelectors = [
    '[data-layout-id]',
    '[data-scene-entity]',
    '[data-node]',
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
        || element.getAttribute('data-node');
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
  const focused = accessibleName(document.activeElement) || null;
  return {
    stepIndex: Number(progress?.getAttribute('data-step-index')),
    stepCount: Number(progress?.getAttribute('data-step-count')),
    title: title?.textContent?.trim() || '',
    caption: caption?.textContent?.trim() || '',
    sceneId: presentation?.getAttribute('data-presentation') || location.pathname,
    entityIds,
    titleProminent: visible(title),
    mode: explicitMode === 'present' || explicitMode === 'browse'
      ? explicitMode
      : (browsing ? 'browse' : 'present'),
    captionVisible: visible(caption) && Boolean(caption?.textContent?.trim()),
    tocVisible: visible(toc),
    progressVisible: visible(progressChrome),
    previousVisible: visible(previous),
    nextVisible: visible(next),
    controls: controlStates,
    focused,
    viewport: { width: window.innerWidth, height: window.innerHeight },
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

    async press(key) {
      await run(`await page.press(${JSON.stringify(key)}); console.log(JSON.stringify(true));`)
    },

    async activate(name) {
      await run(`
const activated = await page.eval(() => {
  const presentation = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)});
${navigationDiscoverySource()}
  const target = controls.find((element) => accessibleName(element) === ${JSON.stringify(name)});
  if (!target) return false;
  target.click();
  return true;
});
if (!activated) throw new Error('navigation control was not found');
await page.wait(100);
console.log(JSON.stringify(true));
`)
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

    async swipe(direction) {
      const left = direction === 'left'
      await run(`
const dispatched = await page.eval(() => {
  const target = document.querySelector(${JSON.stringify(PRESENTATION_SELECTOR)}) || document.body;
  const startX = ${left ? 200 : 20};
  const endX = ${left ? 20 : 200};
  const touch = (x) => new Touch({ identifier: 1, target, clientX: x, clientY: 100 });
  target.dispatchEvent(new TouchEvent('touchstart', {
    touches: [touch(startX)],
    changedTouches: [touch(startX)],
    bubbles: true,
  }));
  target.dispatchEvent(new TouchEvent('touchend', { changedTouches: [touch(endX)], bubbles: true }));
  return true;
});
await page.wait(100);
console.log(JSON.stringify(dispatched));
`)
    },

    async toggleMode() {
      await run("await page.press('p'); await page.wait(50); console.log(JSON.stringify(true));")
    },

    async failures() {
      const output = await invoke(['console', '--type', 'error'])
      if (isBrowserInfrastructureDiagnostic(output)) {
        throw new BrowserDriverError(`browser adapter failed: ${output.trim()}`)
      }
      if (output.includes('<no console messages found>')) return []
      return output.split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('console:') && !line.startsWith('help['))
    },
  }
}
