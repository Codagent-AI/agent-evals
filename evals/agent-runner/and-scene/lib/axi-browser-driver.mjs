// Production browser adapter for deterministic evaluation.
//
// chrome-devtools-axi owns Chromium and exposes a small script API. This
// adapter translates that API into the deliberately tiny driver consumed by
// browser-eval.mjs, keeping browser mechanics out of scoring logic.
import { spawnSync } from 'node:child_process'

const MAX_OUTPUT_BYTES = 1024 * 1024

function defaultCommand(args, input = '') {
  return spawnSync('chrome-devtools-axi', args, {
    encoding: 'utf8',
    input,
    maxBuffer: MAX_OUTPUT_BYTES,
  })
}

function failureMessage(result) {
  return result?.error?.message
    ?? result?.stderr?.trim()
    ?? result?.stdout?.trim()
    ?? `chrome-devtools-axi exited with status ${result?.status ?? 'unknown'}`
}

export function createAxiBrowserDriver({ baseUrl, command = defaultCommand } = {}) {
  const base = new URL(baseUrl)

  async function invoke(args, input = '') {
    const result = await command(args, input)
    if (result?.error || result?.status !== 0) {
      throw new Error(`browser adapter failed: ${failureMessage(result)}`)
    }
    return result.stdout ?? ''
  }

  async function run(script) {
    const output = (await invoke(['run'], script)).trim()
    if (!output) throw new Error('browser adapter returned no structured output')
    try {
      return JSON.parse(output.split('\n').at(-1))
    } catch (error) {
      throw new Error(`browser adapter returned invalid JSON: ${error.message}`)
    }
  }

  function routeUrl(route) {
    const relative = String(route ?? '').replace(/^\/+/, '')
    return new URL(relative, base).href
  }

  return {
    async routes() {
      return run(`
await page.open(${JSON.stringify(base.href)});
await page.wait(50);
const routes = await page.eval(() => [...document.querySelectorAll('a[href]')]
  .map((link) => new URL(link.href, location.href))
  .filter((url) => url.origin === location.origin)
  .map((url) => url.pathname.replace(/^\\//, ''))
  .filter(Boolean));
console.log(JSON.stringify([...new Set(routes)]));
`)
    },

    async open(route) {
      return run(`
const opened = await page.open(${JSON.stringify(routeUrl(route))});
await page.wait('[data-step-count]', 30000);
const browsing = await page.eval(() => [...document.querySelectorAll('[data-presentation-caption], [data-presentation-toc]')]
  .some((element) => element.getClientRects().length > 0
    && getComputedStyle(element).display !== 'none'
    && getComputedStyle(element).visibility !== 'hidden'));
if (browsing) {
  await page.press('p');
  await page.wait(50);
}
console.log(JSON.stringify(opened));
`)
    },

    async state() {
      return run(`
const captured = await page.eval(() => {
  const progress = document.querySelector('[data-step-count]');
  const presentation = document.querySelector('[data-presentation]');
  const title = document.querySelector('[data-presentation-title]');
  const caption = document.querySelector('[data-presentation-caption]');
  const toc = document.querySelector('[data-presentation-toc]');
  const visible = (element) => Boolean(element && element.getClientRects().length > 0
    && getComputedStyle(element).display !== 'none'
    && getComputedStyle(element).visibility !== 'hidden');
  const browsing = visible(caption) || visible(toc);
  const controls = [...document.querySelectorAll('[data-presentation-progress-dot]')].map((control, index) => ({
    name: control.getAttribute('aria-label') || ('Step ' + (index + 1)),
    role: control.getAttribute('role') || control.tagName.toLowerCase(),
    ariaCurrent: control.getAttribute('aria-current') === 'step',
    focusable: !control.disabled && control.tabIndex >= 0,
  }));
  const entityIds = [...document.querySelectorAll('[data-presentation-stage] [data-layout-id], [data-presentation-stage] [data-scene-entity], [data-presentation-stage] [data-node]')]
    .map((element) => element.getAttribute('data-layout-id')
      || element.getAttribute('data-scene-entity')
      || [element.getAttribute('data-node'), element.className, element.textContent?.trim().slice(0, 80)].join(':'))
    .filter(Boolean);
  const focused = document.activeElement?.getAttribute?.('aria-label')
    || document.activeElement?.textContent?.trim()
    || null;
  return {
    stepIndex: Number(progress?.getAttribute('data-step-index')),
    stepCount: Number(progress?.getAttribute('data-step-count')),
    title: title?.textContent?.trim() || '',
    caption: caption?.textContent?.trim() || '',
    sceneId: presentation?.getAttribute('data-presentation') || location.pathname,
    entityIds,
    titleProminent: visible(title),
    mode: browsing ? 'browse' : 'present',
    captionVisible: visible(caption) && Boolean(caption?.textContent?.trim()),
    controls,
    focused,
  };
});
console.log(JSON.stringify(captured));
`)
    },

    async press(key) {
      await run(`await page.press(${JSON.stringify(key)}); console.log(JSON.stringify(true));`)
    },

    async activate(name) {
      await run(`
const activated = await page.eval(() => {
  const target = [...document.querySelectorAll('[data-presentation-progress-dot]')]
    .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)});
  if (!target) return false;
  target.click();
  return true;
});
if (!activated) throw new Error('navigation control was not found');
console.log(JSON.stringify(true));
`)
    },

    async focus(name) {
      await run(`
const focused = await page.eval(() => {
  const target = [...document.querySelectorAll('[data-presentation-progress-dot]')]
    .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)});
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
  const target = document.querySelector('[data-presentation]') || document.body;
  const startX = ${left ? 200 : 20};
  const endX = ${left ? 20 : 200};
  const touch = (x) => new Touch({ identifier: 1, target, clientX: x, clientY: 100 });
  window.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(startX)], bubbles: true }));
  window.dispatchEvent(new TouchEvent('touchend', { changedTouches: [touch(endX)], bubbles: true }));
  return true;
});
console.log(JSON.stringify(dispatched));
`)
    },

    async toggleMode() {
      await run("await page.press('p'); await page.wait(50); console.log(JSON.stringify(true));")
    },

    async failures() {
      const output = await invoke(['console', '--type', 'error'])
      if (output.includes('<no console messages found>')) return []
      return output.split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('console:') && !line.startsWith('help['))
    },
  }
}
