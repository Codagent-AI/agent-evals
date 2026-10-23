import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
export { sha256, readJson, writeJson, contained, filesUnder } from '../../and-scene-define/lib/files.mjs'
export const SUITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const DEFINE_ROOT = join(SUITE_ROOT, '../and-scene-define')
export const SCENE_ROOT = join(SUITE_ROOT, '../and-scene')
export const REPO_ROOT = join(SUITE_ROOT, '../../..')
export const CHANGE_NAME = 'add-presentation-skill'
export const ORGANIZATION = 'Codagent-AI'
export const REPOSITORY_PREFIX = 'e2e-run-'
