import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { sha256 } from './files.mjs'
import { DEFAULT_ROLES } from './options.mjs'
const REQUIRED_TOP = ['create', 'define', 'implement']
const REQUIRED_DEFINE = ['proposal', 'specs', 'design', 'test-plan', 'approach-review']
function topLevelSteps(text) {
  const section = text.match(/^steps:\s*\n([\s\S]*)/m)?.[1] ?? ''
  const blocks = []
  for (const line of section.split('\n')) {
    const id = line.match(/^  - id:\s*([A-Za-z0-9_-]+)\s*$/)
    if (id) blocks.push({ id: id[1], lines: [] }); else blocks.at(-1)?.lines.push(line)
  }
  return blocks.map(block => ({ id: block.id, workflow: block.lines.join('\n').match(/^    workflow:\s*["']?([^\s"'#]+)/m)?.[1] ?? null }))
}
// Resolve `group:name` to the highest versioned definition in the Runner checkout.
export async function resolveWorkflowFile(runnerDir, reference) {
  const match = String(reference).match(/^([a-z0-9-]+):([a-z0-9-]+)$/)
  if (!match) throw new Error(`workflow reference must look like group:name, got ${reference}`)
  const directory = join(runnerDir, 'workflows', match[1])
  const files = (await readdir(directory).catch(() => [])).filter(file => new RegExp(`^${match[2]}-v[0-9.]+\\.yaml$`).test(file)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (!files.length) throw new Error(`workflow ${reference}: no definition found in ${directory}`)
  return join(directory, files.at(-1))
}
// Check only the declarations the harness depends on: no other id, order, nesting or session name.
export async function checkWorkflow({ runnerDir, reference }) {
  const path = await resolveWorkflowFile(runnerDir, reference)
  const text = await readFile(path, 'utf8')
  const steps = topLevelSteps(text)
  for (const id of REQUIRED_TOP) if (!steps.some(step => step.id === id)) throw new Error(`workflow ${reference}: missing top-level ${id} step`)
  const workflowsRoot = resolve(runnerDir, 'workflows')
  const load = async (from, ref) => {
    const target = ref.startsWith('builtin:') ? resolve(workflowsRoot, ref.slice(8)) : resolve(dirname(from), ref)
    if (!target.startsWith(`${workflowsRoot}/`)) throw new Error(`workflow reference outside Runner workflows: ${ref}`)
    return { path: target, text: await readFile(target, 'utf8') }
  }
  const defineRef = steps.find(step => step.id === 'define').workflow
  if (!defineRef) throw new Error(`workflow ${reference}: the define step declares no sub-workflow`)
  const define = await load(path, defineRef)
  const defineIds = topLevelSteps(define.text).map(step => step.id)
  for (const id of REQUIRED_DEFINE) if (!defineIds.includes(id)) throw new Error(`workflow ${reference}: define sub-workflow is missing step ${id}`)
  // Roles used through implement: the agent roles named by create, define and implement and what they invoke.
  const roles = new Set(); const files = [{ path, text }, define]; const visited = new Set([path, define.path])
  for (const step of steps.filter(step => REQUIRED_TOP.includes(step.id) && step.workflow && step.id !== 'define')) {
    const child = await load(path, step.workflow)
    files.push(child); visited.add(child.path)
    for (const nested of topLevelSteps(child.text).filter(item => item.workflow)) {
      const next = await load(child.path, nested.workflow).catch(() => null)
      if (next && !visited.has(next.path)) { visited.add(next.path); files.push(next) }
    }
  }
  for (const file of files) for (const m of file.text.matchAll(/(?:^\s*agent:|`agent:)\s*([a-z][a-z0-9-]*)/gm)) roles.add(m[1])
  const skills = [...new Set(files.flatMap(file => [...file.text.matchAll(/codagent:([a-z0-9-]+)/g)].map(m => m[1])))].sort()
  const name = text.match(/^name:\s*(\S+)/m)?.[1] ?? null
  return { reference, name, path, top_steps: steps.map(step => step.id), hash: sha256(text), define_hash: sha256(define.text), roles: [...new Set([...DEFAULT_ROLES.filter(role => roles.has(role)), ...roles])], skills }
}
