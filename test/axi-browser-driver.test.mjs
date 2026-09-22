import assert from 'node:assert/strict'
import { test } from 'node:test'

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
    /TouchEvent\('touchstart',[\s\S]*touches: \[touch\(startX\)\],[\s\S]*changedTouches: \[touch\(startX\)\]/,
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
