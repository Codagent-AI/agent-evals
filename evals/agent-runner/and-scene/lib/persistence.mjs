// Durable artifact persistence for the and-scene evaluation controller.
//
// Every score-affecting artifact is written to a same-directory temporary file
// and atomically renamed, so an interrupted run never leaves a half-written
// checkpoint that resume would treat as complete.
import { createHash } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

let counter = 0

function stagingPath(target) {
  counter += 1
  return join(dirname(target), `.${process.pid}-${counter}.tmp`)
}

export function hashString(value) {
  return createHash('sha256').update(value).digest('hex')
}

// Canonicalize before hashing so a checkpoint fingerprint depends on values,
// not on the key order a caller happened to build the object with.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export function hashJson(value) {
  return hashString(JSON.stringify(canonicalize(value)))
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
  const staged = stagingPath(target)
  options.onStage?.(staged)
  const handle = await open(staged, 'w')
  try {
    await handle.writeFile(serialized)
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
