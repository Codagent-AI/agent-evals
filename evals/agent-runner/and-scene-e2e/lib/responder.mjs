// After `define` completed nothing may ask the user anything: any external-user request is refused and ends the run.
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicJson, sleep } from '../../../lib/define-run/responder-files.mjs'
export async function watchForRequests({ exchangeDir, signal, intervalMs = 100, seen = new Set() }) {
  while (!signal?.aborted) {
    for (const name of (await readdir(exchangeDir).catch(() => [])).filter(file => file.endsWith('.request.json')).sort()) {
      if (seen.has(name)) continue
      seen.add(name)
      const path = join(exchangeDir, name)
      let request = {}
      try { if ((await lstat(path)).isFile()) request = JSON.parse(await readFile(path, 'utf8')) } catch { /* an unreadable request is still refused */ }
      const step = typeof request.step === 'string' ? request.step : 'unknown'
      await atomicJson(join(exchangeDir, name.replace(/\.request\.json$/, '.reply.json')), { schema_version: 1, action: 'abort', reason: `external-user requests are not answered after define (requested by ${step})` })
      return { status: 'evaluation-harness-failed', reason: `an external-user request arrived from the ${step} step after define completed`, last_active_step: step }
    }
    await sleep(intervalMs)
  }
  return { status: 'stopped' }
}
