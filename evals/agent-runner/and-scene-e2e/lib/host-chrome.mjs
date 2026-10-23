// The host Chrome browser judging starts, found the way and-scene's run.sh finds it, so a service launch
// with only PATH and HOME needs no exports: AND_SCENE_HOST_CHROME, then CHROME_PATH, then the usual installs.
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const executable = path => { try { accessSync(path, constants.X_OK); return true } catch { return false } }
export function onPath(name, env = process.env) {
  return (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, name)).find(executable) ?? null
}
export function findHostChrome(env = process.env) {
  const named = env.AND_SCENE_HOST_CHROME || env.CHROME_PATH
  if (named) return named
  return [MAC_CHROME, onPath('chromium', env), onPath('google-chrome', env)].find(path => path && executable(path)) ?? null
}
export const hostDevtoolsPort = (env = process.env) => Number(env.AND_SCENE_HOST_DEVTOOLS_PORT ?? 9333)
