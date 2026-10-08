import { mkdtemp, rm } from 'node:fs/promises'
import { after } from 'node:test'

const directories = new Set()

// Keep fixtures alive until every test and its awaited child processes finish.
// The file-level hook also runs when a test or fixture setup fails.
after(async () => {
  await Promise.all([...directories].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 3 })))
})

export async function makeTempDir(prefix) {
  const dir = await mkdtemp(prefix)
  directories.add(dir)
  return dir
}
