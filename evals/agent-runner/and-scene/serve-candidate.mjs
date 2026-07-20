#!/usr/bin/env node
// A minimal static server for the evaluated candidate build.
//
// The human reviewer needs the candidate in their own browser, on the host,
// possibly hours after the container that produced it is gone. Serving the
// built output with the standard library rather than the candidate's own
// toolchain keeps that independent of the candidate's `node_modules`, of the
// platform the build ran on, and of any runtime dependency at all.
//
// The server exposes one endpoint of its own: `/.candidate-identity`, which
// returns the candidate revision it was started for. That is what ties an
// endpoint to a candidate — a recycled port answered by an unrelated process
// cannot produce this token, so the harness can verify what it is about to show
// a reviewer rather than trusting a port number.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

export const CANDIDATE_IDENTITY_PATH = '.candidate-identity'

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

// Resolve a request path inside the served root, or refuse it. The candidate
// controls neither the root nor the request, but a traversal must never reach a
// file outside the build being reviewed.
function resolveWithin(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const candidate = resolve(join(root, normalize(decoded)))
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null
}

async function fileAt(path) {
  try {
    const stats = await stat(path)
    if (stats.isDirectory()) return fileAt(join(path, 'index.html'))
    return stats.isFile() ? path : null
  } catch {
    return null
  }
}

export function createCandidateServer({ root, identity }) {
  const base = resolve(root)
  return createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://127.0.0.1')

    if (pathname === `/${CANDIDATE_IDENTITY_PATH}`) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(identity)
      return
    }

    const within = resolveWithin(base, pathname)
    if (!within) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Forbidden')
      return
    }

    // A presentation is a single-page app: an unknown route falls back to the
    // shell so the reviewer can navigate it, but only ever to a file inside the
    // build.
    const file = (await fileAt(within)) ?? (await fileAt(join(base, 'index.html')))
    if (!file) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not Found')
      return
    }

    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // The reviewer must see the revision that was scored, not a cached one.
      'cache-control': 'no-store',
    })
    createReadStream(file).pipe(response)
  })
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const root = valueAfter(argv, '--root')
  const identity = valueAfter(argv, '--identity', '')
  const urlFile = valueAfter(argv, '--url-file')
  const port = Number(valueAfter(argv, '--port', '0'))

  if (!root) {
    console.error('--root is required')
    process.exit(2)
  }

  const server = createCandidateServer({ root, identity })
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${server.address().port}/`
    // The parent waits on this file rather than on a pipe, so it can detach the
    // server and still learn which port it bound.
    if (urlFile) await writeFile(urlFile, `${url}\n`)
    console.log(`listening ${url}`)
  })
}
