// Static server for the recorded build output, with single-page-app fallback. Bound to loopback only.
import http from 'node:http'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain' }
export async function serveOutput({ root, port = 0 }) {
  const base = await realpath(resolve(root))
  const server = http.createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      let target = resolve(join(base, normalize(path)))
      if (target !== base && !target.startsWith(base + sep)) { res.writeHead(403); return res.end() }
      let info = await lstat(target).catch(() => null)
      if (info?.isDirectory()) { const index = join(target, 'index.html'); target = await lstat(index).catch(() => null) ? index : join(base, 'index.html') }
      else if (!info) target = join(base, 'index.html')
      // A symlink inside the candidate's build output must never lead outside it.
      const real = await realpath(target).catch(() => null)
      if (!real || (real !== base && !real.startsWith(base + sep))) { res.writeHead(403); return res.end() }
      target = real
      const bytes = await readFile(target)
      res.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      res.end(bytes)
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolveListen => server.listen(port, '127.0.0.1', resolveListen))
  return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, close: () => new Promise(resolveClose => server.close(resolveClose)) }
}
