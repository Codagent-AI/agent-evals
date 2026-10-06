#!/usr/bin/env node
import { join } from 'node:path'
import { buildRubric, checkRubric } from '../lib/rubric.mjs'
import { SUITE_ROOT, readJson, writeJson } from '../lib/files.mjs'
const inventory = await readJson(join(SUITE_ROOT, 'hidden/inventory.json'))
const path = join(SUITE_ROOT, 'rubric.json')
const existing = await readJson(path).catch(error => { if (error.code !== 'ENOENT') throw error; return {} })
if (process.argv.includes('--check')) {
  const errors = checkRubric(existing, inventory)
  if (errors.length) throw new Error(errors.join('\n'))
} else await writeJson(path, buildRubric(inventory, existing))
