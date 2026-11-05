// The host Chrome browser judging starts, found the way and-scene's run.sh finds it, so a service launch
// with only PATH and HOME needs no exports: AND_SCENE_HOST_CHROME, then CHROME_PATH, then the usual installs.
import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'

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
// The chrome-devtools-mcp installed beside chrome-devtools-axi, so a judge's AXI bridge starts it directly instead of
// through npx, which a sandboxed judge cannot run (it writes ~/.npm and downloads).
export function findAxiMcp(env = process.env) {
  if (env.CHROME_DEVTOOLS_AXI_MCP_PATH) return env.CHROME_DEVTOOLS_AXI_MCP_PATH
  const axi = onPath('chrome-devtools-axi', env)
  if (!axi) return null
  let dir = dirname(realpathSync(axi))
  while (dir !== dirname(dir) && !dir.endsWith(`${sep}node_modules`)) dir = dirname(dir)
  const mcp = join(dir, 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js')
  try { accessSync(mcp, constants.R_OK); return mcp } catch { return null }
}
