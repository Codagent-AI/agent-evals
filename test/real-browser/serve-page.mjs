// Serves one adversarial variant and prints its base URL. It runs as its own
// process because the browser driver blocks the caller's event loop while it
// waits on Chrome, so a server inside the test process could never answer.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

import { DEMO_CONTRACT } from '../../evals/agent-runner/and-scene/lib/demo-contract.mjs'

const variant = process.argv[2]
const steps = DEMO_CONTRACT.step_titles.map((title, index) => ({ title, caption: DEMO_CONTRACT.step_captions[index] }))
const page = (await readFile(new URL('./pages/presentation.html', import.meta.url), 'utf8'))
  .replace('<script>', `<script>window.VARIANT=${JSON.stringify(variant)};window.STEPS=${JSON.stringify(steps)};</script>\n<script>`)

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname
  response.setHeader('content-type', 'text/html; charset=utf-8')
  if (path === '/') return response.end(`<!doctype html><a href="/${DEMO_CONTRACT.route}">demo</a>`)
  if (path === `/${DEMO_CONTRACT.route}`) return response.end(page)
  response.statusCode = 404
  return response.end('not found')
})
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`))
