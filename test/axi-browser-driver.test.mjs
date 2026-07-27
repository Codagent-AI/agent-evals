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
      titleProminent: true,
      captionVisible: false,
      controls: [],
      focused: null,
    }),
  ]
  const command = async (args, input) => {
    calls.push({ args, input })
    return { status: 0, stdout: `${responses.shift()}\n`, stderr: '' }
  }
  const driver = module.createAxiBrowserDriver({
    baseUrl: 'http://127.0.0.1:4319/',
    command,
  })

  assert.deepEqual(await driver.routes(), ['/how-to-make-a-presentation'])
  await driver.open('how-to-make-a-presentation')
  assert.equal((await driver.state()).stepCount, 9)
  assert.ok(calls.every(({ args }) => args[0] === 'run'))
  assert.match(calls[1].input, /http:\/\/127\.0\.0\.1:4319\/how-to-make-a-presentation/)
  assert.match(calls[1].input, /initialMode/)
  assert.doesNotMatch(calls[1].input, /page\.press\(/)
  assert.match(calls[2].input, /data-step-count/)
  assert.doesNotMatch(calls[2].input, /page\.press\(/)
  assert.doesNotMatch(
    calls[2].input,
    /const wasBrowsing = await page\.eval\(\(\) => Boolean\(document\.querySelector/,
  )
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
  assert.match(calls[1].input, /requiredPosition/)
  assert.match(calls[1].input, /page\.press\('ArrowRight'\)/)
  assert.match(calls[1].input, /observedPosition/)
  assert.match(calls[2].input, /stableReads/)
  assert.match(calls[2].input, /node\.getAnimations\(\{ subtree: true \}\)/)
  assert.match(calls[2].input, /iterations !== Infinity/)
  assert.doesNotMatch(calls[2].input, /document\.getAnimations/)
  assert.match(calls[2].input, /timed out waiting for a settled browser state/)
  assert.doesNotMatch(calls[2].input, /^await page\.wait\(100\);/m)
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
