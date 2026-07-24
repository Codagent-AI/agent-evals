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
  assert.match(calls[2].input, /data-step-count/)
  assert.doesNotMatch(calls[2].input, /page\.press\(/)
  assert.doesNotMatch(
    calls[2].input,
    /const wasBrowsing = await page\.eval\(\(\) => Boolean\(document\.querySelector/,
  )
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
})
