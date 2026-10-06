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
export function deadlineMs(deadline) {
  const value = deadline instanceof Date ? deadline.getTime() : deadline
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('a finite absolute deadline is required')
  return value
}
export class ElapsedTimeLimit extends Error {
  constructor() { super('elapsed-time limit'); this.name = 'ElapsedTimeLimit' }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
