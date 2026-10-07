import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('browser replay validates actions and checks a fresh-page observation', async () => {
  const { createAxiBrowserDriver } = await import('../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs')
  const scripts = []
  const driver = createAxiBrowserDriver({ baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      scripts.push(input)
      if (args[0] === 'resize') return { status: 0, stdout: '' }
      if (args[0] === 'console') return { status: 0, stdout: '<no console messages found>\n' }
      return { status: 0, stdout: `${JSON.stringify({ observations: [null, 0, 0].map((stepIndex) => ({
        stepIndex, stepCount: 9, mode: 'present', visible: true, text: '',
      })), trace: ['navigate', 'press'] })}\n` }
    } })
  await assert.rejects(driver.replay([{ type: 'script', code: 'alert(1)' }],
    { type: 'step-index-equals', value: 1 }), /invalid replay/i)
  await assert.rejects(driver.replay([{ type: 'press', key: 'ArrowRight' }],
    { type: 'step-index-changes' }), /invalid replay/i)
  await assert.rejects(driver.replay([{ type: 'navigate', path: '/' },
    { type: 'navigate', path: '/other' }], { type: 'step-index-changes' }), /invalid replay/i)
  const outcome = await driver.replay([{ type: 'navigate', path: '/' },
    { type: 'press', key: 'ArrowRight' }], { type: 'step-index-equals', value: 1 })
  assert.equal(outcome.passed, false)
  assert.equal(outcome.observations.at(-1).stepIndex, 0)
  const unchanged = await driver.replay([{ type: 'navigate', path: '/' },
    { type: 'press', key: 'ArrowRight' }], { type: 'step-index-changes' })
  assert.equal(unchanged.passed, false)
  const missingHook = createAxiBrowserDriver({ baseUrl: 'http://127.0.0.1:4319/',
    command: async (args) => (args[0] === 'console' ? { status: 0, stdout: '<no console messages found>\n' }
      : { status: 0, stdout: `${JSON.stringify({ observations: [
        { stepIndex: null }, { stepIndex: null }, { stepIndex: 0 },
      ], trace: [] })}\n` }) })
  assert.equal((await missingHook.replay([{ type: 'navigate', path: '/' },
    { type: 'press', key: 'ArrowRight' }], { type: 'step-index-changes' })).passed, false)
  assert.ok(scripts.some((script) => script?.includes('page.open(')))
  assert.ok(scripts.some((script) => script?.includes('page.press("ArrowRight")')))
})

test('browser replay records runtime failures and separates product evidence from harness faults', async () => {
  const { createAxiBrowserDriver, BrowserDriverError } = await import('../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs')
  const origin = 'http://127.0.0.1:4319'
  const driverWith = ({ observations, product_failure = null, consoleOut = '<no console messages found>\n', consoleStatus = 0 }) => {
    const calls = []
    return { calls, driver: createAxiBrowserDriver({ baseUrl: `${origin}/`, command: async (args, input) => {
      calls.push({ args, input })
      if (args[0] === 'console') return { status: consoleStatus, stdout: consoleOut, stderr: 'axi console unavailable' }
      return { status: 0, stdout: `${JSON.stringify({ observations, trace: [], product_failure })}\n` }
    } }) }
  }
  const step = (stepIndex, extra = {}) => ({ stepIndex, stepCount: 9, mode: 'present', visible: false, text: '', origin, ...extra })
  const plan = [{ type: 'navigate', path: '/how-to-make-a-presentation' }, { type: 'press', key: 'ArrowRight' }]

  const erroring = driverWith({ observations: [step(null), step(0), step(1)],
    consoleOut: 'Uncaught TypeError: boom at step 2\n' })
  const withErrors = await erroring.driver.replay(plan, { type: 'step-index-changes' })
  assert.deepEqual(withErrors.errors, ['Uncaught TypeError: boom at step 2'])
  assert.ok(erroring.calls.some(({ args }) => args.join(' ') === 'console --type error'))

  const consoleDown = driverWith({ observations: [step(null), step(0), step(1)], consoleStatus: 1 })
  await assert.rejects(consoleDown.driver.replay(plan, { type: 'step-index-changes' }),
    (error) => error instanceof BrowserDriverError && error.resumable === true)

  const clickPlan = [{ type: 'navigate', path: '/how-to-make-a-presentation' }, { type: 'click', selector: '#missing' }]
  const missing = driverWith({ observations: [step(null), step(0)], product_failure: 'replay click target was not found' })
  const absent = await missing.driver.replay(clickPlan, { type: 'step-index-changes' })
  assert.equal(absent.passed, false)
  assert.equal(absent.product_failure, 'replay click target was not found')
  assert.match(missing.calls.find(({ args }) => args[0] === 'run').input, /break replay/)

  const escaped = driverWith({ observations: [step(null), step(0), step(1, { origin: 'http://example.com' })] })
  const left = await escaped.driver.replay(plan, { type: 'step-index-changes' })
  assert.equal(left.passed, false)
  assert.match(left.product_failure, /origin/)

  // These paths pass the shape check but resolve to another host once the
  // route is made relative. The driver refuses them before opening anything.
  for (const path of ['/https://example.com/x', '/\t/\t/example.com/x']) {
    const escaping = driverWith({ observations: [] })
    await assert.rejects(escaping.driver.replay([{ type: 'navigate', path }],
      { type: 'step-index-changes' }), (error) => /origin/.test(error.message) && error.resumable !== true, path)
    assert.equal(escaping.calls.length, 0, path)
  }
})

test('the AXI driver reads eligible declared modes before inferring them', async () => {
  const { createAxiBrowserDriver } = await import('../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs')
  let script = ''
  const driver = createAxiBrowserDriver({ baseUrl: 'http://127.0.0.1:4319/',
    command: async (_args, input) => { script = input; return { status: 0, stdout: 'true\n' } } })
  await driver.setMode('browse')
  const source = script.slice(script.indexOf('const modeReading = () => {'), script.indexOf('\n  };', script.indexOf('const modeReading = () => {')) + 5)
  const read = (presentationModes, dataModes) => runInNewContext(`${source}\nmodeReading()`, {
    document: { querySelector: () => null, querySelectorAll: (selector) => selector === '[data-presentation-mode]'
      ? presentationModes.map((value) => ({ getAttribute: () => value }))
      : selector === '[data-mode]' ? dataModes.map(({ value, ownsProgress }) => ({
        getAttribute: () => value, matches: () => ownsProgress === 'self',
        querySelector: () => ownsProgress === 'ancestor' ? {} : null,
      })) : [],
    },
  })
  assert.equal(read([], [{ value: 'present', ownsProgress: 'descendant' }]).basis, 'heuristic')
  assert.equal(read([], [{ value: 'dark', ownsProgress: 'ancestor' },
    { value: 'browse', ownsProgress: 'ancestor' }]).mode, 'browse')
  assert.equal(read(['dark', 'present'], []).mode, 'present')
})

test('the AXI driver opens the candidate route and returns structured browser state', async () => {
  let module = null
  try {
    module = await import('../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs')
  } catch {
    // The first red run intentionally reaches this assertion before the
    // production adapter exists.
  }
  assert.equal(typeof module?.createAxiBrowserDriver, 'function')

  const calls = []
  const responses = [
    JSON.stringify(['/how-to-make-a-presentation']),
    JSON.stringify({ url: 'http://127.0.0.1:4319/how-to-make-a-presentation', status: 200 }),
    JSON.stringify({
      stepIndex: 0,
      stepCount: 9,
      mode: 'present',
      title: 'You have a topic',
      caption: 'caption',
      sceneId: 'How to make a presentation',
      entityIds: ['box:person'],
      entityConventions: [
        '[data-layout-id]', '[data-scene-entity]', '[data-node]', '[data-entity-id]', '[data-scene-node]',
        '[data-presentation-node]', '[data-presentation-box]', '[data-presentation-label]',
        '[data-presentation-arrow]', '[data-presentation-frame]', '[data-presentation-emphasis]',
        '[data-presentation-symbol-chip]',
      ],
      titleProminent: true,
      captionVisible: false,
      controls: [],
      focused: null,
    }),
  ]
  const command = async (args, input) => {
    calls.push({ args, input })
    if (args[0] === 'resize') return { status: 0, stdout: '', stderr: '' }
    return { status: 0, stdout: `${responses.shift()}\n`, stderr: '' }
  }
  const driver = module.createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command,
  })

  assert.deepEqual(await driver.routes(), ['/how-to-make-a-presentation'])
  await driver.open('how-to-make-a-presentation')
  const state = await driver.state()
  assert.equal(state.stepCount, 9)
  assert.deepEqual(state.entityConventions, [
    '[data-layout-id]', '[data-scene-entity]', '[data-node]', '[data-entity-id]', '[data-scene-node]',
    '[data-presentation-node]', '[data-presentation-box]', '[data-presentation-label]',
    '[data-presentation-arrow]', '[data-presentation-frame]', '[data-presentation-emphasis]',
    '[data-presentation-symbol-chip]',
  ])
  assert.deepEqual(calls[1].args, ['resize', '1280', '720'])
  assert.match(calls[2].input, /http:\/\/127\.0\.0\.1:4319\/how-to-make-a-presentation/)
  assert.match(calls[2].input, /initialMode/)
  assert.doesNotMatch(calls[2].input, /page\.press\(/)
  assert.match(calls[3].input, /data-step-count/)
  assert.match(calls[3].input, /data-entity-id/)
  assert.match(calls[3].input, /data-scene-node/)
  assert.doesNotMatch(calls[3].input, /page\.press\(/)
  assert.doesNotMatch(
    calls[3].input,
    /const wasBrowsing = await page\.eval\(\(\) => Boolean\(document\.querySelector/,
  )
})

test('the AXI driver releases focus to the presentation root without leaving a tabindex behind', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const calls = []
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      return { status: 0, stdout: `${JSON.stringify(true)}\n`, stderr: '' }
    },
  })

  assert.equal(await driver.releaseFocus(), true)
  await driver.restoreFocusTarget()

  assert.match(calls[0].input, /tabindex/, 'releaseFocus adds a temporary tabindex when needed')
  assert.match(calls[0].input, /data-presentation.*data-presentation-root/, 'focus stays in the presentation')
  assert.match(calls[0].input, /data-presentation-mode[\s\S]*document\.body/, 'a presentation without a root hook still gets focus')
  assert.doesNotMatch(calls[0].input, /if \(!root\) return false/, 'a missing root hook is not a failure to release focus')
  assert.match(calls[1].input, /data-presentation-mode/, 'the tabindex is removed from the same root')
  assert.match(calls[0].input, /interactive/i)
  assert.match(calls[1].input, /removeAttribute\('tabindex'\)/)
})

test('the AXI driver establishes mode and position explicitly and waits for settled state', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const calls = []
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      return {
        status: 0,
        stdout: `${JSON.stringify(
          input.includes('settled: true')
            ? { settled: true, strategy: 'bounded-wait-and-state-read' }
            : true,
        )}\n`,
        stderr: '',
      }
    },
  })

  await driver.setMode('browse')
  await driver.setPosition(4)
  assert.deepEqual(await driver.settle(), {
    settled: true,
    strategy: 'bounded-wait-and-state-read',
  })

  assert.match(calls[0].input, /requiredMode/)
  assert.match(calls[0].input, /page\.press\('p'\)/)
  assert.match(calls[1].input, /data-presentation-progress-dot/)
  assert.match(calls[1].input, /controls\[4\]/)
  assert.match(calls[1].input, /page\.press\('ArrowRight'\)/)
  assert.match(calls[1].input, /observedPosition/)
  assert.match(calls[2].input, /stableReads/)
  assert.match(calls[2].input, /node\.getAnimations\(\{ subtree: true \}\)/)
  assert.match(calls[2].input, /iterations !== Infinity/)
  assert.doesNotMatch(calls[2].input, /document\.getAnimations/)
  assert.match(calls[2].input, /timed out waiting for a settled browser state/)
  assert.doesNotMatch(calls[2].input, /^await new Promise\(\(resolve\) => setTimeout\(resolve, 100\)\);/m)
})

test('the AXI driver records durable canvas geometry after an explicit viewport resize', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const calls = []
  const geometry = {
    viewport: { width: 64, height: 64 },
    authored: { width: 880, height: 495 },
    rendered: { left: 0, top: 0, right: 44, bottom: 24.75, width: 44, height: 24.75 },
    available: { left: 0, top: 0, right: 64, bottom: 64, width: 64, height: 64 },
    scale: { x: 0.05, y: 0.05 },
  }
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      if (args[0] === 'resize') return { status: 0, stdout: '', stderr: '' }
      return { status: 0, stdout: `${JSON.stringify(geometry)}\n`, stderr: '' }
    },
  })

  await driver.resize(64, 64)
  assert.deepEqual(await driver.canvasGeometry(), geometry)
  assert.deepEqual(calls[0].args, ['resize', '64', '64'])
  assert.match(calls[1].input, /getBoundingClientRect/)
  assert.match(calls[1].input, /data-presentation-canvas/)
  assert.match(calls[1].input, /offsetWidth/)
  assert.match(calls[1].input, /overflowX/)
})

test('the AXI driver observes compatible stable presentation hooks without requiring one DOM vocabulary', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const calls = []
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      return { status: 0, stdout: `${JSON.stringify(true)}\n`, stderr: '' }
    },
  })

  await driver.state()
  await driver.swipe('left')
  await driver.activate('Step 1')

  assert.match(calls[0].input, /data-presentation-header-title/)
  assert.match(calls[0].input, /data-presentation-footer-title/)
  assert.match(calls[0].input, /data-presentation-box/)
  assert.match(calls[0].input, /data-presentation-label/)
  assert.match(calls[0].input, /data-presentation-root/)
  assert.match(calls[0].input, /const entityOccurrences = new Map/)
  assert.match(calls[0].input, /entityOccurrences\.set/)
  assert.match(calls[1].input, /data-presentation-root/)
  assert.match(calls[1].input, /target\.dispatchEvent/)
  assert.match(
    calls[1].input,
    /TouchEvent\("touchstart", \{\s*touches: \[touch\],\s*targetTouches: \[touch\],\s*changedTouches: \[touch\]/,
  )
  assert.match(calls[1].input, /setTimeout\(resolve, 100\)/)
  assert.match(calls[2].input, /setTimeout\(resolve, 100\)/)
})

test('the AXI driver recognizes the delivered candidate hook vocabulary for modes and controls', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const calls = []
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      return { status: 0, stdout: `${JSON.stringify(true)}\n`, stderr: '' }
    },
  })

  await driver.setMode('browse')
  await driver.setPosition(4)
  await driver.state()
  await driver.activate('Go to step 5')
  await driver.focus('Go to step 5')

  assert.match(calls[0].input, /data-presentation-mode/)
  assert.match(calls[0].input, /data-presentation-node=\\?"caption\\?"/)
  assert.match(calls[0].input, /data-presentation-chrome=\\?"toc\\?"/)
  assert.match(calls[1].input, /data-presentation-node=\\?"progress-dot\\?"/)
  assert.match(calls[1].input, /data-presentation-progress-item/)
  assert.match(calls[2].input, /data-presentation-node=\\?"step-title\\?"/)
  assert.match(calls[2].input, /data-presentation-present-title/)
  assert.match(calls[2].input, /data-presentation-node=\\?"caption\\?"/)
  assert.match(calls[2].input, /data-presentation-chrome=\\?"toc\\?"/)
  assert.match(calls[2].input, /data-presentation-node=\\?"progress-dot\\?"/)
  assert.match(calls[2].input, /data-presentation-progress-item/)
  assert.match(calls[2].input, /data-presentation-chrome=\\?"stage\\?"/)
  assert.match(calls[3].input, /data-presentation-node=\\?"progress-dot\\?"/)
  assert.match(calls[3].input, /data-presentation-progress-item/)
  assert.match(calls[4].input, /data-presentation-node=\\?"progress-dot\\?"/)
  assert.match(calls[4].input, /data-presentation-progress-item/)
})

test('the AXI driver discovers semantic navigation without requiring per-control hooks', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const calls = []
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      return { status: 0, stdout: `${JSON.stringify(true)}\n`, stderr: '' }
    },
  })

  await driver.setPosition(4)
  await driver.state()
  await driver.activate('Step 5: Build the scene')
  await driver.focus('Step 5: Build the scene')

  for (const call of calls) {
    assert.doesNotThrow(() => new Function(
      'page',
      'console',
      `return (async () => {${call.input}})()`,
    ))
    assert.match(call.input, /data-presentation-progress/)
    assert.match(call.input, /querySelectorAll\(['"]button, \[role="button"\], a\[href\]['"]\)/)
  }
  assert.match(calls[1].input, /data-presentation-step-controls/)
  assert.match(calls[1].input, /aria-label\*=["']contents["'] i/)
  assert.match(calls[1].input, /aria-label\*=["']sections["'] i/)
  assert.match(calls[1].input, /accessibleName/)
  assert.match(calls[1].input, /const progressRegion = firstVisibleMatch/)
  assert.match(calls[1].input, /const controls = semanticControls\.length > 0/)
  assert.match(calls[1].input, /const explicit = \[\.\.\.scope\.querySelectorAll\(selector\)\]\.filter\(visible\)/)
  assert.match(calls[1].input, /previous\|prev\|back.*\\b/i)
  assert.match(calls[1].input, /next.*\\b/i)
  assert.match(calls[1].input, /go to.*step/i)
  assert.match(calls[1].input, /compareDocumentPosition/)
  assert.match(calls[1].input, /navigationAmbiguities/)
  assert.match(calls[1].input, /accessibleName\(document\.activeElement\)/)
  assert.match(calls[1].input, /footer.*h1.*h2.*h3/i)
  assert.match(calls[1].input, /figcaption/)
  assert.match(calls[1].input, /innerWidth/)
  assert.match(calls[1].input, /innerHeight/)
  assert.match(calls[2].input, /accessibleName/)
  assert.match(calls[3].input, /accessibleName/)
})

test('the AXI driver reports ambiguous semantic navigation as a harness error', async () => {
  const { BrowserDriverError, createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async () => ({
      status: 0,
      stdout: `${JSON.stringify({ navigationAmbiguities: ['multiple visible next controls'] })}\n`,
      stderr: '',
    }),
  })

  await assert.rejects(
    () => driver.state(),
    (error) => error instanceof BrowserDriverError
      && error.owner === 'evaluation-harness'
      && /ambiguous semantic navigation/.test(error.message),
  )
})

test('the AXI driver rejects a successful CLI invocation that returns a diagnostic instead of routes', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async () => ({
      status: 0,
      stdout: `${JSON.stringify('Could not find Google Chrome executable')}\n`,
      stderr: '',
    }),
  })

  await assert.rejects(driver.routes(), (error) => (
    error.owner === 'evaluation-harness'
      && error.code === 'browser-driver-failed'
      && /route list/.test(error.message)
  ))
})

test('the AXI driver rejects Chrome launch diagnostics instead of reporting them as page console failures', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async () => ({
      status: 0,
      stdout: [
        'Could not find Google Chrome executable for channel \'stable\' at:',
        '- /opt/google/chrome/chrome.',
        'Run `chrome-devtools-axi console-get <id>` to see a specific message',
        'Run `chrome-devtools-axi console --type error` to filter by type',
      ].join('\n'),
      stderr: '',
    }),
  })

  await assert.rejects(driver.failures(), (error) => (
    error.owner === 'evaluation-harness'
      && error.code === 'browser-driver-failed'
      && /Chrome executable/.test(error.message)
  ))
})

test('the AXI driver turns CLI failures into harness errors', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async () => ({ status: 1, stdout: '', stderr: 'browser unavailable' }),
  })

  await assert.rejects(driver.routes(), /browser unavailable/)
  await assert.rejects(driver.routes(), (error) => (
    error.owner === 'evaluation-harness' && error.code === 'browser-driver-failed'
  ))
})

test('the AXI driver reports a nonzero status when stderr and stdout are empty', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async () => ({ status: 7, stdout: '', stderr: '' }),
  })

  await assert.rejects(driver.routes(), /exited with status 7/)
})

// The adapter's page scripts run in Chromium, so the suite inspects the source
// it emits. These assertions pin the discovery contract the evaluator depends
// on rather than one candidate's markup.
async function emitted(call) {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const calls = []
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      return { status: 0, stdout: `${JSON.stringify(true)}\n`, stderr: '' }
    },
  })
  await call(driver)
  return calls.filter(({ args }) => args[0] === 'run').map(({ input }) => input).join('\n')
}

test('the AXI driver accepts every ARIA-valid current-step value', async () => {
  const source = await emitted((driver) => driver.state())

  assert.match(source, /\['step', 'true'\]\.includes\(control\.getAttribute\('aria-current'\)\)/)
})

test('the AXI driver derives a scene identity only from a declared, non-boolean value', async () => {
  const source = await emitted((driver) => driver.state())

  assert.match(source, /sceneId: declaredSceneId\(\)/)
  assert.doesNotMatch(source, /sceneId:[^\n]*location\.pathname/)
  assert.match(source, /\['true', 'false'\]\.includes\(value\.toLowerCase\(\)\)/)
  assert.match(source, /data-presentation-scene-id/)
})

test('the AXI driver reports which selector or strategy matched each navigation role', async () => {
  const source = await emitted((driver) => driver.state())

  assert.match(source, /matchedSelectors,/)
  for (const role of ['title', 'caption', 'toc', 'progress_chrome', 'previous', 'next']) {
    assert.ok(source.includes(`'${role}'`), role)
  }
  assert.match(source, /semantic-progress-region/)
  assert.match(source, /titleTexts,/)
  assert.match(source, /presentation-owned-control-hook/)
  assert.match(source, /accessible-step-name/)
})

test('the AXI driver changes modes through the presentation control before any keybinding', async () => {
  for (const call of [(driver) => driver.toggleMode(), (driver) => driver.setMode('browse')]) {
    const source = await emitted(call)

    assert.match(source, /const toggle = modeToggle\(/)
    assert.match(source, /toggle\.click\(\);/)
    assert.match(source, /if \(!usedControl\) await page\.press\('p'\);/)
    assert.ok(
      source.indexOf('modeToggle(') < source.indexOf("page.press('p')"),
      'the mode control is tried before the keyboard fallback',
    )
  }
})

test('the AXI driver selects the mode control for the mode it is establishing', async () => {
  // "Present mode" and "Browse mode" can be separate controls. Clicking the
  // first visible one would leave the mode unchanged and turn a harness
  // ambiguity into a candidate deduction.
  const setMode = await emitted((driver) => driver.setMode('browse'))
  assert.match(setMode, /const toggle = modeToggle\("browse"\);/)

  const toggle = await emitted((driver) => driver.toggleMode())
  assert.match(toggle, /const toggle = modeToggle\(readMode\(\) === 'present' \? 'browse' : 'present'\);/)

  for (const source of [setMode, toggle]) {
    assert.match(source, /if \(toggle === 'ambiguous'\) return 'ambiguous';/)
    assert.match(source, /ambiguous presentation mode control/)
  }
})

test('the AXI driver disambiguates mode controls by the required mode before giving up', async () => {
  const source = await emitted((driver) => driver.setMode('present'))

  assert.match(source, /const modeToggle = \(requiredMode\) => \{/)
  assert.match(source, /requiredMode === 'browse'/)
  assert.match(source, /selected\.length === 1/)
  assert.match(source, /return 'ambiguous';/)
})

test('the AXI driver activates the discovered directional control', async () => {
  const next = await emitted((driver) => driver.activateDirection('next'))

  assert.match(next, /findDirectionalControls\(\[/)
  assert.match(next, /\/\^next\\b\/i/)
  assert.match(next, /target\.focus\(\);\s*\n?\s*target\.click\(\);/)
  assert.match(next, /if \(matches\.length > 1\) return 'ambiguous';/)
  assert.match(next, /ambiguous semantic navigation/)

  const previous = await emitted((driver) => driver.activateDirection('previous'))
  assert.match(previous, /\/\^\(previous\|prev\|back\)\\b\/i/)
})

test('the AXI driver reports whether a directional control was available', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const driver = (stdout) => createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async () => ({ status: 0, stdout, stderr: '' }),
  })

  assert.equal(await driver('true\n').activateDirection('next'), true)
  assert.equal(await driver('false\n').activateDirection('next'), false)
  await assert.rejects(
    driver('true\n').activateDirection('sideways'),
    (error) => error.name === 'BrowserDriverError',
  )
})

test('the AXI driver rejects an adapter diagnostic in place of a route list', async () => {
  const { createAxiBrowserDriver } = await import(
    '../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs'
  )
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args) => (args[0] === 'resize'
      ? { status: 0, stdout: '', stderr: '' }
      : {
        status: 0,
        stdout: `${JSON.stringify("Could not find Google Chrome executable for channel 'stable' at:")}\n`,
        stderr: '',
      }),
  })

  await assert.rejects(driver.routes(), (error) => error.code === 'browser-driver-failed')
})

test('the AXI driver activates a control the way a pointer does', async () => {
  // A real pointer activation focuses the control first. A presentation that
  // suppresses deck keys while a control holds focus is a product defect the
  // probe can only observe if the driver reproduces that focus.
  const source = await emitted((driver) => driver.activate('Next step'))

  assert.match(source, /target\.focus\(\);\s*\n?\s*target\.click\(\);/)
})

// The touch-event evaluations of one swipe, in order, from the script it emits,
// each with the frame wait that follows it.
function evaluations(source) {
  return source.split('dispatched = (await page.eval(').slice(1)
}

test('the AXI driver delivers a swipe the way a finger does, one touch event per task', async () => {
  // A presentation that keeps its touch start in state committed after a
  // render, as React's setState does, ignores a touchend delivered in the
  // same task as its touchstart. A finger's swipe spans many frames.
  const source = await emitted((driver) => driver.swipe('left'))
  const phases = evaluations(source)
  const types = phases.map((phase) => phase.match(/new TouchEvent\("(touch\w+)"/)?.[1])

  assert.deepEqual(types, ['touchstart', 'touchmove', 'touchmove', 'touchmove', 'touchmove', 'touchend'])
  for (const phase of phases.slice(0, -1)) {
    // Each event asks for the page's next frame, and the next event waits on it.
    assert.match(phase, /requestAnimationFrame\(\(\) => \{ frame\.rendered = true; \}\);\s*return true;/)
  }
  const waits = source.match(/while \(!\(await page\.eval\(\(\) => Boolean\(window\.__andSceneSwipe\?\.frame\?\.rendered\)\)\)\)/g)
  assert.equal(waits.length, phases.length - 1)
  assert.match(source, /throw new Error\('the page rendered no animation frame between swipe touch events'\)/)
  assert.doesNotMatch(phases.at(-1), /requestAnimationFrame|while \(!/)
  assert.match(phases.at(-1), /touches: \[\],\s*targetTouches: \[\],\s*changedTouches: \[touch\]/)
})

test('the AXI driver lands a swipe on the element under the finger and keeps that target', async () => {
  const [start, ...rest] = evaluations(await emitted((driver) => driver.swipe('left')))

  assert.match(start, /data-presentation-stage/)
  assert.match(start, /getBoundingClientRect\(\)/)
  // A surface narrower than the swipe still receives the finger.
  assert.match(start, /rect\.left,\s*Math\.min\(rect\.right, window\.innerWidth\),/)
  assert.match(start, /document\.elementFromPoint\(startX, y\)/)
  assert.match(start, /presentation\.contains\(hit\) \? hit : presentation/)
  for (const phase of rest) {
    assert.match(phase, /const \{ target, startX, y \} = swipe;/)
    assert.doesNotMatch(phase, /elementFromPoint/)
  }
})

test('the AXI driver moves a swipe horizontally in its direction and nowhere else', async () => {
  const offsets = (source) => evaluations(source)
    .map((phase) => Number(phase.match(/clientX: startX \+ (-?[\d.]+)/)[1]))
  const left = offsets(await emitted((driver) => driver.swipe('left')))
  const right = offsets(await emitted((driver) => driver.swipe('right')))

  assert.deepEqual(left, [0, -40, -80, -120, -160, -200])
  assert.deepEqual(right, [0, 40, 80, 120, 160, 200])
  const source = await emitted((driver) => driver.swipe('left'))
  assert.equal(source.match(/clientY: y,/g).length, 6)
  await assert.rejects(
    emitted((driver) => driver.swipe('up')),
    (error) => error.code === 'browser-driver-failed',
  )
})

test('the AXI driver can dispatch a pointer swipe with touch pointer type', async () => {
  const source = await emitted((driver) => driver.swipe('left', { input: 'pointer' }))
  assert.match(source, /new PointerEvent\("pointerdown"/)
  assert.match(source, /new PointerEvent\("pointermove"/)
  assert.match(source, /new PointerEvent\("pointerup"/)
  assert.match(source, /pointerType: 'touch'/)
})

test('the AXI driver waits without the adapter-specific wait helper', async () => {
  // `page.wait` is not implemented the same way across chrome-devtools-axi
  // builds, and a script that calls it can fail wholesale. Waiting through
  // primitives every build provides keeps the driver independent of the
  // adapter's version.
  const source = await emitted(async (driver) => {
    await driver.open('how-to-make-a-presentation').catch(() => {})
    await driver.activate('Next step').catch(() => {})
    await driver.swipe('left').catch(() => {})
    await driver.setMode('browse').catch(() => {})
    await driver.press('ArrowRight').catch(() => {})
  })

  assert.doesNotMatch(source, /page\.wait\(/)
  assert.match(source, /setTimeout\(/)
})

test('the AXI driver never reads a script constant inside a page callback', async () => {
  // The script runs in the adapter and the callback runs in the page. Builds
  // differ on whether the callback closes over the script's scope, so an
  // interpolated value is embedded at its use site instead.
  const source = await emitted((driver) => driver.setPosition(4).catch(() => {}))

  assert.doesNotMatch(source, /const requiredPosition = /)
  assert.match(source, /controls\[4\]/)
})

test('the AXI driver never reads a step-title hook as a caption when inferring the mode', async () => {
  // A deck without a mode attribute is read as browsing while a caption is
  // visible. A present-mode title paragraph in the footer is not a caption, so
  // the footer-paragraph fallback must exclude every title hook, or present mode
  // can never be established.
  const inference = [
    await emitted((driver) => driver.open('how-to-make-a-presentation').catch(() => {})),
    await emitted((driver) => driver.setMode('present')),
    await emitted((driver) => driver.toggleMode()),
  ]
  for (const source of inference) {
    assert.match(source, /\[data-presentation-footer\] p:not\(\[data-presentation-present-title\]\)/)
    assert.doesNotMatch(source, /\[data-presentation-footer\] p["',]/)
  }
  const state = await emitted((driver) => driver.state())
  for (const hook of [
    'data-presentation-present-title',
    'data-presentation-step-title',
    'data-presentation-footer-title',
    'data-presentation-title',
  ]) {
    assert.ok(state.includes(`:not([${hook}])`), hook)
  }
})

test('the AXI driver never reads a step-marker paragraph as a caption when inferring the mode', async () => {
  // A deck may show its step marker, such as "01 / 09 · the ask", as a footer
  // paragraph in both modes. It is not a caption: reading it as one makes a
  // deck without a mode attribute look like it is always browsing, so present
  // mode can never be established.
  const inference = [
    await emitted((driver) => driver.open('how-to-make-a-presentation').catch(() => {})),
    await emitted((driver) => driver.setMode('present')),
    await emitted((driver) => driver.toggleMode()),
    await emitted((driver) => driver.state()),
  ]
  for (const source of inference) {
    assert.match(source, /\[data-presentation-footer\] p(?::not\(\[[^\]]+\]\))*:not\(\[data-presentation-marker\]\)/)
    // The other heuristic caption selectors exclude a marker too. An element a
    // deck explicitly hooks as its caption stays a caption.
    assert.match(source, /figcaption:not\(\[data-presentation-marker\]\)/)
    assert.ok(source.includes(`[aria-label*='caption' i]:not([data-presentation-marker])`), 'aria-label caption excludes the marker')
    assert.doesNotMatch(source, /\[data-presentation-caption\]:not/)
  }
})

test('the AXI driver reports every visible caption and title text a presentation exposes', async () => {
  const source = await emitted((driver) => driver.state())

  // Any caption-bearing element, not only the first ranked one.
  assert.match(source, /captionTexts,/)
  // How many distinct visible elements expose each text, so a persistent list
  // of every title or caption can be told apart from the active one.
  assert.match(source, /titleOccurrences,/)
  assert.match(source, /captionOccurrences,/)
  // A step title set in <strong> is as visible as one set in <span>.
  assert.match(source, /\[data-presentation-header\] strong/)
  assert.match(source, /\[data-presentation-footer\] strong/)
  // A title element's own text, apart from a nested step marker such as "01".
  assert.match(source, /nodeType === 3/)
  // The page script is emitted from a template literal, so the whitespace class
  // must survive as \s rather than collapse to a literal "s".
  assert.ok(source.includes(".replace(/\\s+/g, ' ')"), 'own-text whitespace collapse is emitted intact')
})

test('the AXI driver counts every exposed text rather than dropping texts past a cap', async () => {
  // A verbose deck can show many texts before the active title. Dropping texts
  // once a cap is reached would hide the active title and fail the outline.
  const source = await emitted((driver) => driver.state())

  assert.doesNotMatch(source, /occurrences\.size >= \d+/)
  // What is returned stays bounded, keeping the shortest texts, which is where
  // a normative title or caption sits, and skipping implausibly long ones.
  assert.match(source, /MAX_EXPOSED_TEXTS/)
  assert.match(source, /left\[0\]\.length - right\[0\]\.length/)
})

// Round-3 audit: a progress region that also held Previous and Next counted 11
// step controls for 9 steps and shifted which control was "current".
test('the AXI driver keeps previous, next, and mode controls out of the step controls', async () => {
  const { createAxiBrowserDriver } = await import('../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs')
  const calls = []
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      return { status: 0, stdout: `${JSON.stringify(true)}\n`, stderr: '' }
    },
  })
  await driver.state()
  const source = calls.at(-1).input
  assert.match(source, /const stepControlsOnly = \(elements\) => elements\.filter\(\(element\) => !isDirectional\(element\)\)/)
  assert.match(source, /stepControlsOnly\(inDomOrder\(\[\.\.\.progressRegion\.querySelectorAll/)
  assert.match(source, /data-presentation-prev/)
  assert.match(source, /data-presentation-mode-toggle/)
})

// agent-evals #78 rep 2: `\b` inside a page-script template literal became a
// backspace, so "Previous step" never matched as directional and shifted the
// step controls. Every generated script is checked for that class of escape.
test('generated page scripts carry no control characters from lost regex escapes', async () => {
  const { createAxiBrowserDriver } = await import('../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs')
  const calls = []
  const driver = createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command: async (args, input) => {
      calls.push({ args, input })
      return { status: 0, stdout: `${JSON.stringify(true)}\n`, stderr: '' }
    },
  })
  await driver.setPosition(2)
  await driver.state()
  await driver.activate('Step 2')
  await driver.focus('Step 2')
  await driver.setMode('browse').catch(() => {})
  await driver.toggleMode().catch(() => {})
  await driver.replay([{ type: 'navigate', path: '/how-to-make-a-presentation' }, { type: 'press', key: 'Tab' }],
    { type: 'step-index-changes' }).catch(() => {})
  assert.ok(calls.some(({ input }) => input?.includes('const focused')), 'replay script was generated')
  for (const { input } of calls) {
    assert.doesNotMatch(input ?? '', /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
  }
  const source = calls.find(({ input }) => input?.includes('const isDirectional'))?.input
  const pattern = /\|\| (\/\^\(\?:previous\|prev\|back\|next\)[^/]*\/i)\.test/.exec(source)?.[1]
  assert.ok(pattern, 'directional name pattern is present')
  const directional = new Function(`return ${pattern}`)()
  for (const name of ['Previous step', 'Next step', 'Back', 'prev']) assert.ok(directional.test(name), name)
  for (const name of ['1: You have a topic', 'Step 3', 'Preview']) assert.ok(!directional.test(name), name)
})

test('the AXI driver presses a key while holding the requested modifiers', async () => {
  // chrome-devtools-axi delivers "Alt+ArrowRight" as one keydown with altKey
  // set, so a chord is the key named after its modifiers.
  assert.match(await emitted((driver) => driver.press('ArrowRight', { modifiers: ['Alt'] })),
    /page\.press\("Alt\+ArrowRight"\)/)
  assert.match(await emitted((driver) => driver.press('ArrowLeft', { modifiers: ['Meta', 'Control'] })),
    /page\.press\("Control\+Meta\+ArrowLeft"\)/)
  assert.match(await emitted((driver) => driver.press('ArrowLeft', { modifiers: [] })),
    /page\.press\("ArrowLeft"\)/)
  assert.match(await emitted((driver) => driver.press('ArrowLeft')), /page\.press\("ArrowLeft"\)/)
  for (const modifiers of [['Shift'], ['Ctrl'], ['alt'], ['Alt', 'Alt'], 'Alt', [null]]) {
    await assert.rejects(emitted((driver) => driver.press('ArrowRight', { modifiers })),
      (error) => error.code === 'browser-driver-failed', JSON.stringify(modifiers))
  }
})

// The page callback of one emitted evaluation, as source.
const callbackOf = (phase) => phase.slice(0, phase.indexOf(')) && dispatched;'))

// Runs a swipe's first event against a fake page in which the element matched
// by the selector is a 100×40 button centred at (150, 220).
function runSwipeStart(source, { hitInside = true, found = true } = {}) {
  const dispatched = []
  const child = { id: 'label', dispatchEvent: (event) => dispatched.push(['label', event]) }
  const button = {
    id: 'mode',
    getBoundingClientRect: () => ({ left: 100, top: 200, right: 200, bottom: 240, width: 100, height: 40 }),
    contains: (node) => node === button || node === child,
    dispatchEvent: (event) => dispatched.push(['mode', event]),
  }
  const window = { innerWidth: 1280, innerHeight: 720 }
  const selectors = []
  const context = {
    window,
    document: {
      querySelector: (selector) => { selectors.push(selector); return found ? button : null },
      elementFromPoint: () => (hitInside ? child : { id: 'overlay' }),
    },
    Touch: class { constructor(init) { Object.assign(this, init) } },
    TouchEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init) } },
    PointerEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init) } },
    requestAnimationFrame: () => {},
  }
  const returned = runInNewContext(`(${source})()`, context)
  return { returned, dispatched, selectors, swipe: window.__andSceneSwipe }
}

test('the AXI driver can start a swipe at the centre of an element and keep that element as its target', async () => {
  for (const input of ['touch', 'pointer']) {
    const phases = evaluations(await emitted((driver) => driver.swipe('left', { input, selector: '#mode' })))
    assert.equal(phases.length, 6, input)
    const started = runSwipeStart(callbackOf(phases[0]), { hitInside: false })
    assert.equal(started.returned, true, input)
    assert.deepEqual(started.selectors, ['#mode'], input)
    // The finger lands at the element's centre and the element is the target.
    assert.equal(started.swipe.startX, 150, input)
    assert.equal(started.swipe.y, 220, input)
    assert.equal(started.swipe.target.id, 'mode', input)
    assert.equal(started.dispatched[0][0], 'mode', input)
    assert.equal(started.dispatched[0][1].type, input === 'touch' ? 'touchstart' : 'pointerdown', input)
    assert.equal((input === 'touch' ? started.dispatched[0][1].changedTouches[0] : started.dispatched[0][1]).clientX, 150)
    // A finger on the element's label is still on the element.
    assert.equal(runSwipeStart(callbackOf(phases[0])).swipe.target.id, 'label', input)
    for (const phase of phases.slice(1)) {
      assert.match(phase, /const \{ target, startX, y \} = swipe;/)
      assert.doesNotMatch(phase, /querySelector|elementFromPoint/)
    }
  }
  // Same distance, path, and pacing as the stage swipe.
  const source = await emitted((driver) => driver.swipe('right', { selector: '#mode' }))
  assert.deepEqual(evaluations(source).map((phase) => Number(phase.match(/clientX: startX \+ (-?[\d.]+)/)[1])),
    [0, 40, 80, 120, 160, 200])
  assert.equal(source.match(/while \(!\(await page\.eval\(\(\) => Boolean\(window\.__andSceneSwipe\?\.frame\?\.rendered\)\)\)\)/g).length, 5)
})

test('the AXI driver reports a swipe whose start element is missing without waiting on a frame', async () => {
  const source = await emitted((driver) => driver.swipe('left', { selector: '#gone' }))
  const started = runSwipeStart(callbackOf(evaluations(source)[0]), { found: false })
  assert.equal(started.returned, false)
  assert.equal(started.dispatched.length, 0)
  // The script stops dispatching rather than waiting on a frame nobody asked for.
  assert.match(source, /if \(!dispatched\) break swipe;/)
  for (const selector of ['', 7]) {
    await assert.rejects(emitted((driver) => driver.swipe('left', { selector })),
      (error) => error.code === 'browser-driver-failed', String(selector))
  }
})

// A fake page for the keydown instrumentation: an event target with capture
// and bubble listeners, a KeyboardEvent whose preventDefault is inherited, and
// task queues for timers and page lifecycle events.
function fakeKeyboardPage() {
  const listeners = []
  const timers = []
  class Event {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); this.defaultPrevented = false }
    preventDefault() { this.defaultPrevented = true }
    stopPropagation() { this.stopped = true }
    stopImmediatePropagation() { this.stopped = true; this.immediate = true }
  }
  class KeyboardEvent extends Event {}
  const window = {
    location: { href: 'http://127.0.0.1:4319/how-to-make-a-presentation' },
    addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture: capture === true }),
  }
  const context = { window, KeyboardEvent, Event, location: window.location, setTimeout: (callback) => timers.push(callback) }
  return {
    context,
    listen: (listener, capture) => listeners.push({ type: 'keydown', listener, capture }),
    dispatch(type, init) {
      const event = type === 'pagehide' ? new Event(type) : new KeyboardEvent(type, init)
      for (const phase of [true, false]) {
        for (const entry of listeners.filter((candidate) => candidate.type === type && candidate.capture === phase)) {
          if (event.immediate) break
          entry.listener(event)
        }
        if (event.stopped) break
      }
      while (timers.length) timers.shift()()
      return event
    },
  }
}

// Runs an emitted script against a fake page. Page callbacks share the fake
// page's globals, so they run as the browser would run them.
async function runAgainst(page, script) {
  let stdout = ''
  const context = { ...page.context,
    page: { eval: async (callback) => callback() },
    console: { log: (line) => { stdout += `${line}\n` } } }
  await runInNewContext(`(async () => {\n${script}\n})()`, context)
  return { status: 0, stdout }
}

test('the AXI driver counts a prevented keydown default even when the page stops propagation', async () => {
  const { createAxiBrowserDriver } = await import('../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs')
  const page = fakeKeyboardPage()
  const scripts = []
  // The fake adapter runs each emitted page callback against the fake page.
  const driver = createAxiBrowserDriver({ baseUrl: 'http://127.0.0.1:4319/', command: async (args, input) => {
    scripts.push(input)
    return runAgainst(page, input)
  } })
  // A page listener that ran before the instrumentation, in the capture phase,
  // and hides the keydown from every later listener.
  page.listen((event) => {
    if (event.metaKey && event.key === 'ArrowRight') { event.stopImmediatePropagation(); event.preventDefault() }
  }, true)
  page.listen((event) => { if (event.ctrlKey) event.preventDefault() }, false)

  const installed = await driver.installKeyInstrumentation()
  assert.equal(installed.installed, true)
  assert.match(scripts[0], /KeyboardEvent\.prototype/)
  assert.match(scripts[0], /'pagehide'/)
  page.dispatch('keydown', { key: 'ArrowRight', metaKey: true, altKey: false, ctrlKey: false, shiftKey: false })
  page.dispatch('keydown', { key: 'ArrowLeft', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false })
  page.dispatch('keydown', { key: 'ArrowRight', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })
  page.dispatch('keyup', { key: 'ArrowRight', ctrlKey: true })

  const read = await driver.readKeyInstrumentation({ reset: true })
  assert.equal(read.installed, true)
  assert.equal(read.unloaded, false)
  assert.equal(read.url, 'http://127.0.0.1:4319/how-to-make-a-presentation')
  assert.deepEqual(read.keydowns.map(({ key, altKey, ctrlKey, metaKey, prevented }) => (
    { key, altKey, ctrlKey, metaKey, prevented })), [
    { key: 'ArrowRight', altKey: false, ctrlKey: false, metaKey: true, prevented: true },
    { key: 'ArrowLeft', altKey: false, ctrlKey: true, metaKey: false, prevented: true },
    { key: 'ArrowRight', altKey: true, ctrlKey: false, metaKey: false, prevented: false },
  ])
  assert.deepEqual(read.keydowns.map(({ preventDefaultCalls }) => preventDefaultCalls), [1, 1, 0])
  assert.deepEqual((await driver.readKeyInstrumentation()).keydowns, [])

  // A page lifecycle unload is reported, and a reinstall starts clean without
  // wrapping preventDefault twice.
  page.dispatch('pagehide')
  assert.equal((await driver.readKeyInstrumentation()).unloaded, true)
  await driver.installKeyInstrumentation()
  page.dispatch('keydown', { key: 'ArrowLeft', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false })
  const again = await driver.readKeyInstrumentation()
  assert.equal(again.unloaded, false)
  assert.deepEqual(again.keydowns.map(({ preventDefaultCalls }) => preventDefaultCalls), [1])
})

test('the AXI driver reports an unload when the instrumented document has been replaced', async () => {
  const { createAxiBrowserDriver } = await import('../evals/agent-runner/and-scene/lib/axi-browser-driver.mjs')
  let page = fakeKeyboardPage()
  const driver = createAxiBrowserDriver({ baseUrl: 'http://127.0.0.1:4319/', command: async (_args, input) => runAgainst(page, input) })
  // Never installed: nothing to report as unloaded.
  assert.deepEqual(await driver.readKeyInstrumentation(),
    { installed: false, unloaded: false, url: 'http://127.0.0.1:4319/how-to-make-a-presentation', keydowns: [] })
  await driver.installKeyInstrumentation()
  // A press navigated away: the new document carries no instrumentation.
  page = fakeKeyboardPage()
  page.context.location.href = 'http://127.0.0.1:4319/'
  const replaced = await driver.readKeyInstrumentation()
  assert.equal(replaced.installed, false)
  assert.equal(replaced.unloaded, true)
  assert.equal(replaced.url, 'http://127.0.0.1:4319/')
  await driver.installKeyInstrumentation()
  assert.deepEqual(await driver.readKeyInstrumentation(),
    { installed: true, unloaded: false, url: 'http://127.0.0.1:4319/', keydowns: [] })
})
