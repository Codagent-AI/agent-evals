// Pins the suite freezes in run.sh, read by the tools that must agree with it.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUITE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

// run.sh declares each pin as NAME="${NAME:-default}"; the default is the pin.
export async function runShPin(name, { suiteRoot = SUITE_DIR } = {}) {
  const text = await readFile(join(suiteRoot, 'run.sh'), 'utf8')
  const pin = text.match(new RegExp(`^${name}="\\$\\{${name}:-([^}]+)\\}"$`, 'm'))?.[1]
  if (!pin) throw new Error(`could not parse ${name} from run.sh`)
  return pin
}
