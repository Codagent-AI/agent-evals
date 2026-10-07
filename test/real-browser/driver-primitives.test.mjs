// Real Chrome over chrome-devtools-axi, against a page that only logs what
// reaches it, proving the browser driver's own primitives on the installed
// adapter build. Outside the `test/*.test.mjs` glob on purpose: CI has no
// browser. Run with:
//
//   node --test test/real-browser/driver-primitives.test.mjs
//
// One at a time, and never while another real-browser test is running: they
// share Chrome.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEMO_CONTRACT } from '../../evals/agent-runner/and-scene/lib/demo-contract.mjs'
import { createAxiBrowserDriver } from '../../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'

function serve() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve-page.mjs', import.meta.url)), 'driver-primitives'],
    { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.once('data', (chunk) => resolve({ baseUrl: String(chunk).trim(), close: () => child.kill() }))
  })
}

// What the page logged, read straight from the adapter.
function pageValue(expression) {
  const result = spawnSync('chrome-devtools-axi', ['run'], { encoding: 'utf8',
    input: `console.log(JSON.stringify(await page.eval(() => ${expression})));` })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim().split('\n').at(-1))
}

async function withPage(body) {
  const { baseUrl, close } = await serve()
  try {
    const driver = createAxiBrowserDriver({ baseUrl })
    await driver.open(DEMO_CONTRACT.route)
    await body(driver)
  } finally { await close() }
}

test('modified arrow presses arrive with the held modifier', { timeout: 300_000 }, async () => {
  await withPage(async (driver) => {
    for (const modifier of ['Alt', 'Control', 'Meta']) {
      await driver.press('ArrowRight', { modifiers: [modifier] })
    }
    await driver.press('ArrowDown', { modifiers: ['Control', 'Alt'] })
    const arrows = pageValue('window.keyLog.filter((entry) => entry.key.startsWith("Arrow"))')
    // Meta+ArrowRight never reaches the page's logging listener: its capture
    // listener stops it, which the instrumentation test relies on.
    assert.deepEqual(arrows, [
      { key: 'ArrowRight', altKey: true, ctrlKey: false, metaKey: false },
      { key: 'ArrowRight', altKey: false, ctrlKey: true, metaKey: false },
      { key: 'ArrowDown', altKey: true, ctrlKey: true, metaKey: false },
    ])
    await driver.installKeyInstrumentation()
    await driver.press('ArrowRight', { modifiers: ['Meta'] })
    const [meta] = (await driver.readKeyInstrumentation()).keydowns.filter(({ key }) => key === 'ArrowRight')
    assert.equal(meta.metaKey, true)
    assert.equal(meta.altKey || meta.ctrlKey, false)
  })
})

test('a swipe that starts on a button targets that button on both input paths', { timeout: 300_000 }, async () => {
  await withPage(async (driver) => {
    for (const input of ['touch', 'pointer']) {
      pageValue('(window.inputLog = [], true)')
      assert.equal(await driver.swipe('left', { input, selector: '#mode' }), true)
      const log = pageValue('window.inputLog')
      const names = input === 'touch' ? ['touchstart', 'touchmove', 'touchend'] : ['pointerdown', 'pointermove', 'pointerup']
      assert.deepEqual(log.map(({ type }) => type),
        [names[0], names[1], names[1], names[1], names[1], names[2]], input)
      assert.ok(log.every(({ target }) => target === 'mode'), JSON.stringify(log))
      // The button is 120 wide from x=100: the finger lands at its centre.
      assert.deepEqual(log.map(({ x }) => x), [160, 120, 80, 40, 0, -40], input)
    }
    assert.equal(await driver.swipe('left', { selector: '#missing' }), false)
  })
})

test('a prevented default is counted though the page stops propagation, and an unload is detected',
  { timeout: 300_000 }, async () => {
    await withPage(async (driver) => {
      await driver.installKeyInstrumentation()
      await driver.press('ArrowRight', { modifiers: ['Meta'] })
      await driver.press('ArrowLeft', { modifiers: ['Control'] })
      await driver.press('ArrowRight', { modifiers: ['Alt'] })
      const read = await driver.readKeyInstrumentation({ reset: true })
      assert.equal(read.installed, true)
      assert.equal(read.unloaded, false)
      const arrows = read.keydowns.filter(({ key }) => key.startsWith('Arrow'))
      assert.deepEqual(arrows.map(({ key, metaKey, ctrlKey, altKey, prevented }) => ({ key, metaKey, ctrlKey, altKey, prevented })), [
        { key: 'ArrowRight', metaKey: true, ctrlKey: false, altKey: false, prevented: true },
        { key: 'ArrowLeft', metaKey: false, ctrlKey: true, altKey: false, prevented: true },
        { key: 'ArrowRight', metaKey: false, ctrlKey: false, altKey: true, prevented: false },
      ])
      assert.equal(arrows[0].preventDefaultCalls, 1)
      assert.deepEqual((await driver.readKeyInstrumentation()).keydowns, [])

      // Alt+ArrowLeft makes this page leave itself.
      await driver.press('ArrowLeft', { modifiers: ['Alt'] })
      const left = await driver.readKeyInstrumentation()
      assert.equal(left.unloaded, true)
      assert.equal(left.installed, false)
      assert.equal(new URL(left.url).pathname, '/')

      // Reloading and reinstalling starts a fresh, instrumented document.
      await driver.open(DEMO_CONTRACT.route)
      await driver.installKeyInstrumentation()
      await driver.press('ArrowLeft', { modifiers: ['Control'] })
      const again = await driver.readKeyInstrumentation()
      assert.equal(again.installed, true)
      assert.equal(again.unloaded, false)
      assert.deepEqual(again.keydowns.filter(({ key }) => key === 'ArrowLeft').map(({ prevented }) => prevented), [true])
    })
  })

test('a verifier replay presses modified keys and starts a swipe on its selector', { timeout: 300_000 }, async () => {
  await withPage(async (driver) => {
    const route = `/${DEMO_CONTRACT.route}`
    const outcome = await driver.replay([{ type: 'navigate', path: route },
      { type: 'press', key: 'ArrowRight', modifiers: ['Alt'] },
      { type: 'press', key: 'ArrowDown', modifiers: ['Control', 'Alt'] },
      { type: 'press', key: 'ArrowRight', modifiers: null },
      { type: 'swipe', direction: 'left', input: 'pointer', selector: '#mode' }],
    { type: 'step-index-equals', value: 1 })
    assert.equal(outcome.passed, true, JSON.stringify(outcome))
    assert.deepEqual(pageValue('window.keyLog.filter((entry) => entry.key.startsWith("Arrow"))'), [
      { key: 'ArrowRight', altKey: true, ctrlKey: false, metaKey: false },
      { key: 'ArrowDown', altKey: true, ctrlKey: true, metaKey: false },
      { key: 'ArrowRight', altKey: false, ctrlKey: false, metaKey: false },
    ])
    const log = pageValue('window.inputLog')
    assert.deepEqual(log.map(({ type }) => type), ['pointerdown', 'pointermove', 'pointermove', 'pointermove',
      'pointermove', 'pointerup'])
    assert.ok(log.every(({ target }) => target === 'mode'), JSON.stringify(log))
    assert.equal(log[0].x, 160)

    const missing = await driver.replay([{ type: 'navigate', path: route },
      { type: 'swipe', direction: 'left', input: 'touch', selector: '#missing' }],
    { type: 'step-index-equals', value: 1 })
    assert.equal(missing.passed, false)
    assert.equal(missing.product_failure, 'replay swipe start target was not found')
    assert.deepEqual(pageValue('window.inputLog'), [])
  })
})
