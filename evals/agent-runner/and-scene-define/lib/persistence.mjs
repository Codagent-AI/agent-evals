// Durable artifact persistence for the and-scene evaluation controller.
//
// Every score-affecting artifact is written to a same-directory temporary file
// and atomically renamed, so an interrupted run never leaves a half-written
// checkpoint that resume would treat as complete.
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hashString } from '../../../lib/panel-judging/hash.mjs'
export { hashString, hashJson } from '../../../lib/panel-judging/hash.mjs'

let counter = 0

function stagingPath(target) {
  counter += 1
  return join(dirname(target), `.${process.pid}-${counter}.tmp`)
}

export async function hashFile(path) {
  try {
    return hashString(await readFile(path))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function writeJsonAtomic(target, value, options = {}) {
  // Serialize first: a serialization failure must not touch the existing file.
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  return writeTextAtomic(target, serialized, options)
}

export async function writeTextAtomic(target, value, options = {}) {
  const staged = stagingPath(target)
  options.onStage?.(staged)
  const handle = await open(staged, 'w')
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(staged, target)
  } catch (error) {
    await unlink(staged).catch(() => {})
    throw error
  }
  return target
}

export async function readJson(path, ...fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && fallback.length > 0) return fallback[0]
    throw error
  }
}
