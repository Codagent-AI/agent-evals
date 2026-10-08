import { randomUUID } from 'node:crypto'
import { open, rename, rm, mkdir, readFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function appendDurable(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const file = await open(path, 'a', 0o600)
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() }
  finally { await file.close() }
}
export async function atomicJson(path, value, mode = 0o644) {
  const temporary = join(dirname(path), `.responder-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', mode)
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.chmod(mode); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
export async function optionalText(path) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`expected regular file: ${path}`)
    return await readFile(path, 'utf8')
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function readConversation(path) {
  const text = await optionalText(path)
  if (text === null) return []
  const lines = text.split('\n')
  const last = lines.findLastIndex(line => line.trim())
  const records = []
  for (let index = 0; index <= last; index++) {
    if (!lines[index].trim()) continue
    try { records.push(JSON.parse(lines[index])) }
    catch (error) {
      if (index !== last) throw error
      // A crash during append can tear only the final record. Recover the
      // complete prefix before any new append or reply publication.
      const prefix = lines.slice(0, index).join('\n') + (index ? '\n' : '')
      const file = await open(path, 'r+')
      try { await file.truncate(Buffer.byteLength(prefix)); await file.sync() }
      finally { await file.close() }
      return records
    }
  }
  // A write may also finish the JSON but stop before its newline. Preserve the
  // record and finish the delimiter so a subsequent append cannot join records.
  if (text && !text.endsWith('\n')) {
    const file = await open(path, 'a')
    try { await file.writeFile('\n'); await file.sync() }
    finally { await file.close() }
  }
  return records
}
export function deadlineMs(deadline) {
  const value = deadline instanceof Date ? deadline.getTime() : deadline
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('a finite absolute deadline is required')
  return value
}
export class ElapsedTimeLimit extends Error {
  constructor() { super('elapsed-time limit'); this.name = 'ElapsedTimeLimit' }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
