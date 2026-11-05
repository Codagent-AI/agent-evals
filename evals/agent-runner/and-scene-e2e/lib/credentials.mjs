// Host credential discovery, so a run needs no shell exports. The environment always wins.
// - CLAUDE_CODE_OAUTH_TOKEN: from Agent Runner's sandbox secrets file, that one entry only. The sandbox still
//   runs with --no-default-secrets, so the file's GITHUB_TOKEN never reaches the evaluated environment.
// - AND_SCENE_E2E_APP_ID and AND_SCENE_E2E_APP_KEY_FILE: from the App setup record ~/.config/and-scene-e2e/app.json.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_RECORD = join('.config', 'and-scene-e2e', 'app.json')
const unquote = value => /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value
export async function readRunnerSecret(file, name) {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match?.[1] === name) { const value = unquote(match[2].trim()); return value || null }
  }
  return null
}
export async function resolveCredentialEnv(env = process.env, { runnerDir, home = homedir() } = {}) {
  const resolved = { ...env }
  if (!resolved.CLAUDE_CODE_OAUTH_TOKEN && runnerDir) {
    const token = await readRunnerSecret(env.SANDBOX_SECRETS_FILE ?? join(runnerDir, '.sandbox-secrets.env'), 'CLAUDE_CODE_OAUTH_TOKEN')
    if (token) resolved.CLAUDE_CODE_OAUTH_TOKEN = token
  }
  if (!resolved.AND_SCENE_E2E_APP_ID || !resolved.AND_SCENE_E2E_APP_KEY_FILE) {
    const record = JSON.parse(await readFile(join(home, APP_RECORD), 'utf8').catch(() => 'null'))
    if (record?.id && record?.key_file) {
      resolved.AND_SCENE_E2E_APP_ID ??= String(record.id)
      resolved.AND_SCENE_E2E_APP_KEY_FILE ??= record.key_file
    }
  }
  return resolved
}
